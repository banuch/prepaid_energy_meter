// Billing: staircase (marginal) pricing, continuous rather than whole-unit, so
// fractional kWh readings bill correctly against the tariff slabs.

void billUnits(double deltaUnits) {
  if (tariff.slabCount == 0) {
    Serial.println("No tariff loaded yet — tap the card once to sync it. Skipping billing.");
    return;
  }

  double position = cycleUnitsConsumed;
  double remaining = deltaUnits;
  double costPaise = 0;

  for (uint8_t i = 0; i < tariff.slabCount && remaining > 0; i++) {
    Slab &slab = tariff.slabs[i];
    double ceiling = slab.unbounded ? 1e18 : (double)slab.upperLimitUnits;
    if (position >= ceiling) continue;

    double capacity = ceiling - position;
    double unitsHere = remaining < capacity ? remaining : capacity;

    costPaise += unitsHere * slab.ratePaisePerUnit;
    position += unitsHere;
    remaining -= unitsHere;
  }

  cycleUnitsConsumed = position;
  uint32_t costRounded = (uint32_t)round(costPaise);

  // Consumption already physically happened — clamp balance at 0 rather than
  // going negative, and let the relay cutoff (balance_control.ino) stop
  // further usage.
  balancePaise = costRounded > balancePaise ? 0 : balancePaise - costRounded;

  prefs.putUInt("balance", balancePaise);
  prefs.putDouble("cycleUnits", cycleUnitsConsumed);

  Serial.printf(
    "Billed %.3f kWh for Rs %.2f. New balance: Rs %.2f\n",
    deltaUnits, costRounded / 100.0, balancePaise / 100.0
  );

  applyBalanceState();
}
