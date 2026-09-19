// NVS persistence — balance, recharge counter, cycle units, last kWh, tariff.
// Writes happen where the values change (billing.ino, nfc_card.ino,
// energy_meter.ino); this tab loads them at boot.

void loadStateFromNvs() {
  balancePaise = prefs.getUInt("balance", 0);
  lastAppliedRechargeCounter = prefs.getUInt("lastCounter", 0);
  cycleUnitsConsumed = prefs.getDouble("cycleUnits", 0.0);
  lastMeterKwh = prefs.getFloat("lastKwh", -1.0);
  relayManualOff = prefs.getBool("relayOff", false);

  tariff.version = prefs.getUChar("tariffVer", 0);
  tariff.slabCount = prefs.getUChar("tariffCount", 0);
  size_t got = prefs.getBytes("tariffSlabs", tariff.slabs, sizeof(tariff.slabs));
  if (got != sizeof(tariff.slabs)) {
    memset(tariff.slabs, 0, sizeof(tariff.slabs));
  }

  Serial.printf(
    "Loaded state: balance=Rs %.2f, lastCounter=%lu, tariffVer=%u, cycleUnits=%.3f\n",
    balancePaise / 100.0,
    (unsigned long)lastAppliedRechargeCounter,
    tariff.version,
    cycleUnitsConsumed
  );
  if (relayManualOff) {
    Serial.println("Relay is held OFF (set from the web interface) — press Relay ON on the dashboard to release.");
  }
}
