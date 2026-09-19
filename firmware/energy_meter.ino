// Energy metering: PZEM-004T v3.0 over Serial2, with fault cutoff handling.
// New kWh deltas are handed to billUnits() (billing.ino).

void pollEnergyMeter() {
  static unsigned long lastPoll = 0;
  unsigned long now = millis();
  if (now - lastPoll < 2000) return;
  lastPoll = now;

  latest.voltage = pzem.voltage();
  latest.current = pzem.current();
  latest.power = pzem.power();
  latest.energy = pzem.energy();
  latest.frequency = pzem.frequency();
  latest.pf = pzem.pf();

  // The PZEM library caches a read attempt for 200 ms even when it failed, so
  // only the first getter (voltage) reflects a real read. The rest then come
  // back as stale zeros instead of NaN. Treat a failed voltage read as a
  // failed poll, otherwise a dead PZEM looks healthy (0 kWh, 0 A).
  if (isnan(latest.voltage)) {
    latest.current = NAN;
    latest.power = NAN;
    latest.energy = NAN;
    latest.frequency = NAN;
    latest.pf = NAN;
  }
  //printMeterReadings();
  updateDisplay();

  float kwh = latest.energy;
  if (isnan(kwh)) {
    Serial.println("PZEM energy read failed — skipping billing this cycle.");
    if (!pzemFailing) {
      pzemFailing = true;
      pzemFailingSince = now;
    }
    if (!pzemFaultCutoff && now - pzemFailingSince >= PZEM_FAULT_CUTOFF_MS) {
      pzemFaultCutoff = true;
      Serial.println("PZEM has been unresponsive too long — cutting the relay.");
      applyBalanceState();
    }
    return;
  }

  pzemFailing = false;
  if (pzemFaultCutoff) {
    pzemFaultCutoff = false;
    Serial.println("PZEM recovered — restoring relay if balance allows.");
    applyBalanceState();
  }

  if (lastMeterKwh < 0) {
    // First reading after boot — establish a baseline, don't bill retroactively.
    lastMeterKwh = kwh;
    prefs.putFloat("lastKwh", lastMeterKwh);
    return;
  }

  double delta = kwh - lastMeterKwh;
  lastMeterKwh = kwh;
  prefs.putFloat("lastKwh", lastMeterKwh);

  if (delta <= 0) return; // meter reset, noise, or no consumption

  billUnits(delta);
}
