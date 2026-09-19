// Serial (USB) output: startup pin table, PZEM readings, JSON status line.

void printPinConfig() {
  Serial.println();
  Serial.println("=== Pin configuration ===");
  Serial.printf("PN532 SPI    : SCK=GPIO%d  MISO=GPIO%d  MOSI=GPIO%d  SS=GPIO%d\n", PN532_SCK_PIN, PN532_MISO_PIN, PN532_MOSI_PIN, PN532_SS_PIN);
  Serial.printf("OLED SSD1306 : SDA=GPIO%d  SCL=GPIO%d  addr=0x%02X  %dx%d\n", I2C_SDA_PIN, I2C_SCL_PIN, OLED_ADDRESS, OLED_WIDTH, OLED_HEIGHT);
  Serial.printf("PZEM UART2   : RX2=GPIO%d (<- PZEM TX)  TX2=GPIO%d (-> PZEM RX)  9600 baud\n", PZEM_RX_PIN, PZEM_TX_PIN);
  Serial.printf("Warning out  : GPIO%d (active HIGH)\n", WARNING_PIN);
  Serial.printf("Relay out    : GPIO%d (%s)\n", RELAY_PIN, RELAY_ACTIVE_HIGH ? "active HIGH" : "active LOW");
  Serial.println("USB Serial   : GPIO1/GPIO3, 115200 baud");
  Serial.printf("Low-balance threshold: Rs %.2f\n", LOW_BALANCE_WARNING_PAISE / 100.0);
  Serial.println("=========================");
  Serial.println();
}

void printReading(const char *label, float value, const char *unit, uint8_t decimals) {
  Serial.print(label);
  if (isnan(value)) {
    Serial.println("Error reading");
    return;
  }
  Serial.print(value, decimals);
  if (unit[0] != '\0') {
    Serial.print(" ");
    Serial.print(unit);
  }
  Serial.println();
}

void printMeterReadings() {
  Serial.println("\n--- PZEM-004T Readings ---");
  printReading("Voltage: ", latest.voltage, "V", 1);
  printReading("Current: ", latest.current, "A", 3);
  printReading("Power: ", latest.power, "W", 1);
  printReading("Energy: ", latest.energy, "kWh", 3);
  printReading("Frequency: ", latest.frequency, "Hz", 1);
  printReading("Power Factor: ", latest.pf, "", 2);
  Serial.println("==========================");
}

// Core status fields — shared by the Serial status line and the web API.
void fillStatusJson(JsonDocument &doc, bool lowBalance) {
  doc["balancePaise"] = balancePaise;
  doc["balanceRupees"] = balancePaise / 100.0;
  doc["lowBalance"] = lowBalance;
  doc["relayEngaged"] = relayEngaged;
  doc["relayManualOff"] = relayManualOff;
  doc["pzemFaultCutoff"] = pzemFaultCutoff;
  doc["nfcAvailable"] = nfcAvailable;
  doc["cycleUnitsConsumed"] = cycleUnitsConsumed;
  doc["tariffVersion"] = tariff.version;
  doc["lastAppliedRechargeCounter"] = lastAppliedRechargeCounter;
  if (!isnan(latest.voltage)) doc["voltageV"] = latest.voltage;
  if (!isnan(latest.current)) doc["currentA"] = latest.current;
  if (!isnan(latest.power)) doc["powerW"] = latest.power;
  if (!isnan(latest.energy)) doc["energyKwh"] = latest.energy;
  if (!isnan(latest.frequency)) doc["frequencyHz"] = latest.frequency;
  if (!isnan(latest.pf)) doc["powerFactor"] = latest.pf;
}

void printStatusJson(bool lowBalance) {
  StaticJsonDocument<768> doc;
  fillStatusJson(doc, lowBalance);
  serializeJson(doc, Serial);
  Serial.println();
}
