// SSD1306 OLED screen — rotates through one page at a time.
//
// 128x32 layout: a size-1 label on the top row, the value in size 2 below it
// (up to 10 characters, e.g. "0.001 kWh"):
//   BALANCE       rupees — drawn inverted when below the warning threshold
//   VOLTAGE / CURRENT / POWER / ENERGY / FREQUENCY / POWER FACTOR
//                 latest PZEM reading, or "--" if the PZEM isn't responding
//   WEB           the dashboard address — only while Wi-Fi/hotspot is up
//   NFC           "NFC ERROR" — only part of the rotation while the reader is down
//
// The page is derived from millis(), so there is no page state to keep in sync.

constexpr unsigned long DISPLAY_PAGE_MS = 2000;    // time each page stays up
constexpr unsigned long DISPLAY_REFRESH_MS = 1000; // redraw rate from displayTick()

constexpr uint8_t PAGE_COUNT_PZEM = 7;             // balance + 6 PZEM readings
constexpr uint8_t PAGE_WEB = 100;                  // extra pages, after the PZEM ones
constexpr uint8_t PAGE_NFC = 101;

// Formats a PZEM reading, or "--" when the read failed.
void formatReading(char *out, size_t size, float value, uint8_t decimals, const char *unit) {
  if (isnan(value)) {
    snprintf(out, size, "--");
  } else {
    snprintf(out, size, "%.*f%s", decimals, value, unit);
  }
}

void drawPage(const char *label, const char *value, bool inverted) {
  display.clearDisplay();

  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, 0);
  display.print(label);

  display.setTextSize(2);
  if (inverted) {
    display.setTextColor(SSD1306_BLACK, SSD1306_WHITE);
  } else {
    display.setTextColor(SSD1306_WHITE);
  }
  display.setCursor(0, 12);
  display.print(value);

  display.display();
}

// One-shot message overlay (card events). While it's active, updateDisplay()
// leaves the screen alone, so PZEM polls and balance updates can't overwrite it.
bool messageActive = false;
unsigned long messageUntil = 0;

// Draws the message right away and holds it for durationMs, then the normal
// page rotation resumes. Keep `value` to 10 characters (size-2 text).
void showMessage(const char *label, const char *value, unsigned long durationMs) {
  messageActive = true;
  messageUntil = millis() + durationMs;
  if (displayAvailable) drawPage(label, value, false);
}

void updateDisplay() {
  if (!displayAvailable) return;

  if (messageActive) {
    if ((long)(millis() - messageUntil) < 0) return;
    messageActive = false;
  }

  bool webUp = wifiStaConnected || wifiApActive;
  uint8_t pageCount = PAGE_COUNT_PZEM + (webUp ? 1 : 0) + (nfcAvailable ? 0 : 1);
  uint8_t page = (millis() / DISPLAY_PAGE_MS) % pageCount;
  if (page >= PAGE_COUNT_PZEM) {
    // Extra pages after the PZEM ones: WEB (when online), then NFC (when down).
    page = (webUp && page == PAGE_COUNT_PZEM) ? PAGE_WEB : PAGE_NFC;
  }

  char value[16];
  switch (page) {
    case 0:
      snprintf(value, sizeof(value), "Rs%.2f", balancePaise / 100.0);
      drawPage("BALANCE", value, balancePaise < LOW_BALANCE_WARNING_PAISE);
      break;
    case 1:
      formatReading(value, sizeof(value), latest.voltage, 1, " V");
      drawPage("VOLTAGE", value, false);
      break;
    case 2:
      formatReading(value, sizeof(value), latest.current, 3, " A");
      drawPage("CURRENT", value, false);
      break;
    case 3:
      formatReading(value, sizeof(value), latest.power, 1, " W");
      drawPage("POWER", value, false);
      break;
    case 4:
      formatReading(value, sizeof(value), latest.energy, 3, " kWh");
      drawPage("ENERGY", value, false);
      break;
    case 5:
      formatReading(value, sizeof(value), latest.frequency, 1, " Hz");
      drawPage("FREQUENCY", value, false);
      break;
    case 6:
      formatReading(value, sizeof(value), latest.pf, 2, "");
      drawPage("POWER FACTOR", value, false);
      break;
    case PAGE_WEB: {
      char label[32];
      snprintf(label, sizeof(label), "WEB %s", wifiIp().c_str());
      drawPage(label, wifiApActive ? "AP MODE" : "WIFI OK", false);
      break;
    }
    default: // PAGE_NFC
      drawPage("NFC", "NFC ERROR", false);
      break;
  }
}

// Called from loop() so the pages rotate even when nothing else refreshes the
// screen (updateDisplay() is also called on every PZEM poll and balance change).
void displayTick() {
  static unsigned long lastRefresh = 0;
  unsigned long now = millis();
  if (now - lastRefresh < DISPLAY_REFRESH_MS) return;
  lastRefresh = now;
  updateDisplay();
}
