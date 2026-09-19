// Prepaid card handling: PN532 bring-up and health, card reads, recharge
// credit and tariff sync.
//
// Card memory layout — MUST match lib/services/nfc_service.dart in the
// Flutter app. If you change one side, change the other.
//
// Sector 1
//   block 4  amount              uint32 BE, paise (pending recharge amount,
//                                 NOT a running balance)
//   block 5  recharge meta       bytes 0-3   recharge counter, uint32 BE
//                                 bytes 4-7   last recharge amount, paise, uint32 BE
//                                 byte  8     billing-cycle year offset from 2020
//                                 byte  9     billing-cycle month (1-12)
//                                 bytes 10-13 units consumed this cycle, uint32 BE
//   block 6  service number      16 bytes ASCII, zero-padded
//
// Sector 2
//   block 8  tariff header       byte 0 version, byte 1 slab count
//   block 9  tariff slabs 1-4    4 bytes/slab: upperLimit uint16 BE, rate paise uint16 BE
//   block 10 tariff slabs 5-8    same format, unused slots are zeroed

uint32_t readUint32BE(const uint8_t *data, uint8_t offset) {
  return (static_cast<uint32_t>(data[offset]) << 24) |
         (static_cast<uint32_t>(data[offset + 1]) << 16) |
         (static_cast<uint32_t>(data[offset + 2]) << 8) |
         static_cast<uint32_t>(data[offset + 3]);
}

uint16_t readUint16BE(const uint8_t *data, uint8_t offset) {
  return (static_cast<uint16_t>(data[offset]) << 8) | data[offset + 1];
}

// Authenticates the sector containing blockNumber with Key A, then reads it.
bool readBlock(uint8_t *uid, uint8_t uidLength, uint8_t blockNumber, uint8_t *outData) {
  if (!nfc.mifareclassic_AuthenticateBlock(uid, uidLength, blockNumber, 0, defaultKey)) {
    return false;
  }
  return nfc.mifareclassic_ReadDataBlock(blockNumber, outData);
}

// Tries to bring up the PN532. Safe to call repeatedly (used for retries).
void initNfc() {
  nfc.begin();

  uint32_t versiondata = nfc.getFirmwareVersion();
  if (!versiondata) {
    if (nfcAvailable || millis() < 5000) {
      Serial.println("NFC ERROR: PN532 not found. Check SPI wiring (SCK/MISO/MOSI/SS) and the PN532 SPI mode switches!");
    }
    nfcAvailable = false;
    return;
  }

  if (!nfcAvailable) {
    Serial.print("PN532 OK: found PN5");
    Serial.println((versiondata >> 24) & 0xFF, HEX);
  }
  nfc.SAMConfig();
  nfcAvailable = true;
}

// While the reader is up, verify every few seconds that it still answers;
// while it's down, keep retrying. Either way the OLED is refreshed on a change.
void checkNfcHealth() {
  static unsigned long lastCheck = 0;
  unsigned long now = millis();
  if (now - lastCheck < 5000) return;
  lastCheck = now;

  bool wasAvailable = nfcAvailable;
  if (wasAvailable) {
    if (!nfc.getFirmwareVersion()) {
      nfcAvailable = false;
      Serial.println("NFC ERROR: PN532 stopped responding. Retrying...");
    }
  } else {
    initNfc();
  }

  if (nfcAvailable != wasAvailable) updateDisplay();
}

void pollCard() {
  if (!nfcAvailable) {
    checkNfcHealth();
    return;
  }

  uint8_t uid[7];
  uint8_t uidLength;

  // Short timeout so this doesn't starve pollEnergyMeter() while waiting.
  bool success = nfc.readPassiveTargetID(PN532_MIFARE_ISO14443A, uid, &uidLength, 200);
  if (!success) {
    checkNfcHealth(); // no card, or the reader died — tell them apart
    return;
  }

  Serial.println("Card detected — processing...");
  showMessage("CARD DETECTED", "READING...", 1000);
  handleCardTap(uid, uidLength);
  delay(1000); // debounce, avoid re-reading the same tap instantly
}

void handleCardTap(uint8_t *uid, uint8_t uidLength) {
  uint8_t amountData[16];
  uint8_t metaData[16];
  uint8_t tariffHeaderData[16];
  uint8_t slab1Data[16];
  uint8_t slab2Data[16];

  bool okAmount = readBlock(uid, uidLength, AMOUNT_BLOCK, amountData);
  bool okMeta = readBlock(uid, uidLength, META_BLOCK, metaData);
  bool okTariffHeader = readBlock(uid, uidLength, TARIFF_HEADER_BLOCK, tariffHeaderData);
  bool okSlab1 = readBlock(uid, uidLength, TARIFF_SLAB_BLOCK_1, slab1Data);
  bool okSlab2 = readBlock(uid, uidLength, TARIFF_SLAB_BLOCK_2, slab2Data);

  if (!okAmount || !okMeta) {
    Serial.println("Could not authenticate/read balance sector — aborting this tap.");
    showMessage("CARD ERROR", "READ FAIL", 3000);
    return;
  }

  // Tariff sync — the card is always the source of truth.
  if (okTariffHeader && (okSlab1 || okSlab2)) {
    applyTariffFromCard(tariffHeaderData, slab1Data, slab2Data);
  }

  // Recharge credit, de-duplicated by the card's monotonic recharge counter.
  uint32_t cardAmountPaise = readUint32BE(amountData, 0);
  uint32_t cardRechargeCounter = readUint32BE(metaData, 0);

  if (cardRechargeCounter > lastAppliedRechargeCounter) {
    balancePaise += cardAmountPaise;
    lastAppliedRechargeCounter = cardRechargeCounter;
    prefs.putUInt("balance", balancePaise);
    prefs.putUInt("lastCounter", lastAppliedRechargeCounter);
    Serial.printf(
      "Credited Rs %.2f (recharge #%lu). New balance: Rs %.2f\n",
      cardAmountPaise / 100.0,
      (unsigned long)cardRechargeCounter,
      balancePaise / 100.0
    );
    char label[32];
    char value[16];
    snprintf(label, sizeof(label), "RECHARGED +Rs%.2f", cardAmountPaise / 100.0);
    snprintf(value, sizeof(value), "Rs%.2f", balancePaise / 100.0);
    showMessage(label, value, 4000);
  } else {
    Serial.println("Recharge already applied (counter not newer) — ignoring.");
    showMessage("ALREADY USED", "NO CREDIT", 3000);
  }

  applyBalanceState();
}

void applyTariffFromCard(uint8_t *header, uint8_t *slab1, uint8_t *slab2) {
  uint8_t version = header[0];
  uint8_t slabCount = header[1];
  if (version == 0 || slabCount == 0) return;

  uint8_t combined[32];
  memcpy(combined, slab1, 16);
  memcpy(combined + 16, slab2, 16);

  Tariff newTariff;
  newTariff.version = version;
  newTariff.slabCount = slabCount > 8 ? 8 : slabCount;

  for (uint8_t i = 0; i < newTariff.slabCount; i++) {
    uint8_t offset = i * 4;
    uint16_t limitRaw = readUint16BE(combined, offset);
    uint16_t rate = readUint16BE(combined, offset + 2);
    newTariff.slabs[i].unbounded = (limitRaw == UNBOUNDED_SENTINEL);
    newTariff.slabs[i].upperLimitUnits = limitRaw;
    newTariff.slabs[i].ratePaisePerUnit = rate;
  }

  if (newTariff.version != tariff.version) {
    Serial.printf(
      "Tariff updated: v%u -> v%u (%u slabs)\n",
      tariff.version, newTariff.version, newTariff.slabCount
    );
  }

  tariff = newTariff;
  prefs.putUChar("tariffVer", tariff.version);
  prefs.putUChar("tariffCount", tariff.slabCount);
  prefs.putBytes("tariffSlabs", tariff.slabs, sizeof(tariff.slabs));
}
