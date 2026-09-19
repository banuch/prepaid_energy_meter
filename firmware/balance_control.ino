// Balance state: warning GPIO and relay cutoff, then refresh OLED and Serial.
// Also the admin reset operations triggered from the web interface.

void setRelay(bool engaged) {
  bool pinHigh = RELAY_ACTIVE_LOW ? !engaged : engaged;
  digitalWrite(RELAY_PIN, pinHigh ? HIGH : LOW);
  relayEngaged = engaged;
}

void applyBalanceState() {
  bool lowBalance = balancePaise < LOW_BALANCE_WARNING_PAISE;
  bool zeroBalance = balancePaise == 0;

  digitalWrite(WARNING_PIN, lowBalance ? HIGH : LOW);

  bool shouldEngageRelay = !zeroBalance && !pzemFaultCutoff;
  if (shouldEngageRelay != relayEngaged) {
    setRelay(shouldEngageRelay);
    if (relayEngaged) {
      Serial.println("Relay: load connected");
    } else if (pzemFaultCutoff) {
      Serial.println("Relay: load disconnected (power module fault)");
    } else {
      Serial.println("Relay: load disconnected (balance exhausted)");
    }
  }

  if (lowBalance) {
    Serial.printf("WARNING: low balance — Rs %.2f remaining\n", balancePaise / 100.0);
  }

  updateDisplay();
  printStatusJson(lowBalance);
}

// Web "reset balance": overwrite the balance (0 by default). Goes through
// applyBalanceState(), so the relay cuts or reconnects as for any balance change.
// lastAppliedRechargeCounter is left alone — an already-used card can't be
// credited again.
void resetBalance(uint32_t newBalancePaise) {
  balancePaise = newBalancePaise;
  prefs.putUInt("balance", balancePaise);
  Serial.printf("Balance reset from the web interface: Rs %.2f\n", balancePaise / 100.0);

  char value[16];
  snprintf(value, sizeof(value), "Rs%.2f", balancePaise / 100.0);
  showMessage("BALANCE RESET", value, 4000);

  applyBalanceState();
}

// Web "reset billing cycle": next kWh bills from the first slab again.
void resetBillingCycle() {
  cycleUnitsConsumed = 0;
  prefs.putDouble("cycleUnits", cycleUnitsConsumed);
  Serial.println("Billing cycle reset from the web interface: cycle units = 0.");

  showMessage("BILLING CYCLE", "RESET", 3000);
  printStatusJson(balancePaise < LOW_BALANCE_WARNING_PAISE);
}
