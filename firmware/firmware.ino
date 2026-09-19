// ESP32 prepaid energy meter.
//
// - Reads the prepaid card (PN532, SPI) written by the Flutter app: credits
//   its recharge amount to a balance held in NVS, and syncs the tariff
//   table from the card into NVS (card is always the source of truth).
// - Reads cumulative energy (kWh) from a PZEM-004T v3.0 module on a
//   dedicated UART (Serial2) and bills each new delta against the tariff
//   using staircase (marginal) pricing, deducting from the stored balance.
// - Warns (Serial + GPIO + OLED) when balance drops below ₹50, and cuts
//   power via a relay when balance reaches zero; reconnects automatically
//   once a recharge brings it positive again.
// - Serves a web dashboard over Wi-Fi: live readings, balance and tariff, plus
//   password-protected "reset balance", "reset billing cycle" and manual relay
//   OFF/ON operations (the relay can be held off, but ON never overrides a
//   zero balance or a PZEM fault).
//   Joins your router, or starts its own hotspot if it can't (see the Wi-Fi
//   config below).
//
// Libraries required (Arduino Library Manager):
//   - Adafruit PN532
//   - ArduinoJson (v6+)
//   - PZEM004Tv30 (by Jakub Mandula)
//   - Adafruit GFX Library
//   - Adafruit SSD1306
//   Preferences (NVS) ships with the ESP32 core — no separate install.
//
// Sketch layout (Arduino concatenates the main tab first, then the other
// tabs alphabetically — so everything the tabs share is declared here):
//
//   firmware.ino         config (pins, constants), types, devices, global
//                        state, setup() and loop()
//   nfc_card.ino         PN532 bring-up/health, card read, recharge credit,
//                        tariff sync (holds the card memory layout doc)
//   energy_meter.ino     PZEM-004T polling and fault handling
//   billing.ino          staircase tariff billing
//   nvs_storage.ino      persistent state load
//   balance_control.ino  relay + warning GPIO driven by the balance
//   display.ino          SSD1306 OLED, rotating pages (balance + PZEM readings)
//   status_log.ino       Serial output (pin config, readings, JSON status)
//   wifi_manager.ino     Wi-Fi: join the router, fall back to own hotspot
//   web_server.ino       HTTP routes, admin password check, JSON API
//   web_page.ino         the dashboard page (HTML/JS held in flash; must sort before web_server.ino)
//
// The ESP32 core already includes WiFi, WebServer and ESPmDNS — no extra
// library install for the web interface.

#include <Wire.h>
#include <SPI.h>
#include <Adafruit_PN532.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include <PZEM004Tv30.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <WiFi.h>
#include <WebServer.h>
#include <ESPmDNS.h>
#include <math.h>
#include <string.h>

// ---------------------------------------------------------------------------
// Pin configuration — adjust to match your wiring.
//
// The OLED uses the default I2C pins (21/22) and the PZEM uses the default
// UART2 pins (16/17). The other pins are on the left header of the board
// (IO36 IO39 IO34 IO35 IO32 IO33 IO26 IO27 IO12 IO14 IO13 IO15 IO5 IO16 IO4);
// the ESP32 routes SPI through its GPIO matrix, so it can sit on any of them.
// IO12 is deliberately unused: it's a boot-strapping pin and can stop the
// board booting if something pulls it high. IO34/35/36/39 are input-only.
//
// Wiring summary:
//
//   Device            Device pin      ESP32 pin        Notes
//   ----------------  --------------  ---------------  ------------------------------
//   PN532 (SPI)       SCK             IO27             Hardware SPI, LSB-first (handled
//                     MISO            IO34             by the Adafruit library);
//                     MOSI            IO26             IO34 is input-only, fine for MISO
//                     SS / NSS / CS   IO32
//                     VCC / GND       3V3 / GND        Set the PN532 mode switches to
//                                                      SPI (check your board's
//                                                      silkscreen; on the common red
//                                                      Elechouse V3 board: SEL0=0,
//                                                      SEL1=1)
//   SSD1306 OLED      SDA             GPIO21 (default) I2C address 0x3C
//   (I2C)             SCL             GPIO22 (default)
//                     VCC / GND       3V3 / GND
//   PZEM-004T v3.0    TX              GPIO16 (ESP RX)  Modbus over UART2, 9600 baud
//   (UART2)           RX              GPIO17 (ESP TX)  TTL side powered from 5V
//                     5V / GND        5V (VIN) / GND   Mains side wired per PZEM manual
//   Warning LED/buzz  signal          IO13             Active HIGH (use a transistor
//                                                      for buzzers > ~12 mA)
//   Relay module     IN               GPIO23           Active LOW on this board (relay
//                                                      energises on LOW), see
//                                                      RELAY_ACTIVE_HIGH
//   USB Serial        (debug/logs)    GPIO1 / GPIO3    115200 baud, via USB-UART
// ---------------------------------------------------------------------------
// I2C bus — used by the OLED only, on the ESP32's default I2C pins.
constexpr int I2C_SDA_PIN = 21;
constexpr int I2C_SCL_PIN = 22;

// PN532 on hardware SPI, remapped onto header pins.
constexpr int PN532_SCK_PIN = 27;
constexpr int PN532_MISO_PIN = 34;
constexpr int PN532_MOSI_PIN = 26; // not IO14: it toggles at boot and caused resets
constexpr int PN532_SS_PIN = 32; // not IO5: that's a boot-strapping pin

constexpr int PZEM_RX_PIN = 16; // ESP32 RX2 <- PZEM TX
constexpr int PZEM_TX_PIN = 17; // ESP32 TX2 -> PZEM RX

constexpr int WARNING_PIN = 13; // buzzer/LED, active HIGH
constexpr int RELAY_PIN = 23;   // load contactor/relay control
constexpr bool RELAY_ACTIVE_HIGH = false; // true: relay energises on HIGH. false: on LOW (this board's module is active-low)

constexpr uint8_t OLED_ADDRESS = 0x3C;
constexpr int OLED_WIDTH = 128;
constexpr int OLED_HEIGHT = 32; // 0.91" module; use 64 for a 0.96" module

constexpr uint32_t LOW_BALANCE_WARNING_PAISE = 5000; // ₹50

// If the PZEM fails to answer continuously for this long, cut the relay —
// otherwise the load could run unmetered and unbilled.
constexpr unsigned long PZEM_FAULT_CUTOFF_MS = 60000;

// ---------------------------------------------------------------------------
// Web interface / Wi-Fi — CHANGE THESE before flashing.
//
// The meter first tries to join WIFI_SSID. If that fails (or WIFI_SSID is
// empty) within WIFI_CONNECT_TIMEOUT_MS, it starts its own hotspot AP_SSID and
// the dashboard is at http://192.168.4.1/. On your router the address is
// printed on Serial and shown on the OLED, and http://prepaid-meter.local/
// usually works too.
//
// The dashboard can be viewed by anyone on the network; the reset operations
// need ADMIN_PASSWORD (user name is always "admin"). The password is sent over
// plain HTTP, so keep the meter on a trusted LAN — don't expose it to the
// internet.
// ---------------------------------------------------------------------------
constexpr const char *WIFI_SSID = "Sahasra";
constexpr const char *WIFI_PASSWORD = "wintek@143";
constexpr unsigned long WIFI_CONNECT_TIMEOUT_MS = 15000;

constexpr const char *AP_SSID = "PrepaidMeter";
constexpr const char *AP_PASSWORD = "prepaid1234"; // 8+ characters, or "" for an open hotspot

constexpr const char *ADMIN_PASSWORD = "Sesi@143";
constexpr const char *MDNS_HOSTNAME = "prepaid-meter";
constexpr uint16_t WEB_PORT = 80;

// ---------------------------------------------------------------------------
// Card block layout (documented in nfc_card.ino)
// ---------------------------------------------------------------------------
constexpr uint8_t AMOUNT_BLOCK = 4;
constexpr uint8_t META_BLOCK = 5;
constexpr uint8_t TARIFF_HEADER_BLOCK = 8;
constexpr uint8_t TARIFF_SLAB_BLOCK_1 = 9;
constexpr uint8_t TARIFF_SLAB_BLOCK_2 = 10;

constexpr uint16_t UNBOUNDED_SENTINEL = 0xFFFF;

// Factory-default MIFARE Classic key — swap this once real cards are
// provisioned with a custom key (must match the app's NfcService.defaultKey).
uint8_t defaultKey[6] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------
Adafruit_PN532 nfc(PN532_SS_PIN, &SPI); // hardware SPI, chip-select on PN532_SS_PIN
PZEM004Tv30 pzem(Serial2, PZEM_RX_PIN, PZEM_TX_PIN);
Adafruit_SSD1306 display(OLED_WIDTH, OLED_HEIGHT, &Wire, -1);
Preferences prefs;
WebServer server(WEB_PORT);

bool displayAvailable = false;

// ---------------------------------------------------------------------------
// Meter state — persisted in NVS, source of truth for balance/tariff.
// ---------------------------------------------------------------------------
struct Slab {
  bool unbounded = false;
  uint16_t upperLimitUnits = 0;
  uint16_t ratePaisePerUnit = 0;
};

struct Tariff {
  uint8_t version = 0;
  uint8_t slabCount = 0;
  Slab slabs[8];
};

uint32_t balancePaise = 0;
uint32_t lastAppliedRechargeCounter = 0;
double cycleUnitsConsumed = 0; // fractional units billed so far this cycle
float lastMeterKwh = -1;       // -1 = not yet established (avoid billing on first boot)
Tariff tariff;
bool relayEngaged = true;
bool relayManualOff = false;   // "Relay OFF" hold from the web interface (persisted in NVS)

struct MeterReadings {
  float voltage = NAN;
  float current = NAN;
  float power = NAN;
  float energy = NAN;
  float frequency = NAN;
  float pf = NAN;
};
MeterReadings latest;

bool nfcAvailable = false;        // false if the PN532 didn't answer

bool pzemFailing = false;         // true while consecutive reads are failing
unsigned long pzemFailingSince = 0;
bool pzemFaultCutoff = false;     // true once the outage exceeded PZEM_FAULT_CUTOFF_MS

bool wifiConnecting = false;      // joining the router, hotspot fallback pending
bool wifiStaConnected = false;    // connected to the router
bool wifiApActive = false;        // running the fallback hotspot
unsigned long wifiStartedAt = 0;
bool webStarted = false;          // HTTP server is listening

// ---------------------------------------------------------------------------
// Setup / main loop
// ---------------------------------------------------------------------------
void setup() {
  // First thing: put the relay pin at its "off" level *before* making it an
  // output. Otherwise the pin defaults LOW, which on an active-low module
  // briefly energises the relay (load connected) at every boot.
  digitalWrite(RELAY_PIN, RELAY_ACTIVE_HIGH ? LOW : HIGH);
  pinMode(RELAY_PIN, OUTPUT);

  Serial.begin(115200);
  while (!Serial) delay(10);

  printPinConfig();

  pinMode(WARNING_PIN, OUTPUT);

  Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN); // OLED
  SPI.begin(PN532_SCK_PIN, PN532_MISO_PIN, PN532_MOSI_PIN, PN532_SS_PIN); // PN532
  initNfc(); // non-fatal: metering keeps running even if the reader is missing

  if (!display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDRESS)) {
    Serial.println("OLED not found — continuing without display.");
    displayAvailable = false;
  } else {
    displayAvailable = true;
    display.clearDisplay();
    display.display();
  }

  prefs.begin("meter", false);
  loadStateFromNvs();

  setRelay(balancePaise > 0 && !relayManualOff);
  applyBalanceState();

  delay(1000); // give the PZEM time to stabilize before the first read

  // Startup check: if the PZEM doesn't answer, say so on Serial and the OLED
  // right away instead of waiting for the first poll.
  latest.energy = pzem.energy();
  if (isnan(latest.energy)) {
    Serial.println("PZEM not responding — check wiring (RX/TX swapped?), 5V supply and mains side.");
  } else {
    Serial.println("PZEM OK.");
  }
  updateDisplay();

  wifiBegin(); // non-blocking: metering starts now, the web UI comes up when Wi-Fi does

  Serial.println("Meter ready. Waiting for card taps and energy readings...");
}

void loop() {
  pollCard();
  pollEnergyMeter();
  wifiTick();    // join / fallback / reconnect handling
  webTick();     // serve pending HTTP requests
  displayTick(); // rotates the OLED pages
  delay(20);
}
