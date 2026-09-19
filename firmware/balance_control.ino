// Balance state: warning GPIO and relay cutoff, then refresh OLED and Serial.
// Also the admin reset operations triggered from the web interface.

void setRelay(bool engaged) {
  bool pinHigh = RELAY_ACTIVE_HIGH ? engaged : !engaged;
  digitalWrite(RELAY_PIN, pinHigh ? HIGH : LOW);
  relayEngaged = engaged;
}

// Why the relay is (or isn't) engaged: "on", "manual", "pzem_fault" or "no_balance".
const char *relayReason() {
  if (relayEngaged) return "on";
  if (relayManualOff) return "manual";
  if (pzemFaultCutoff) return "pzem_fault";
  return "no_balance";
}

void applyBalanceState() {
  bool lowBalance = balancePaise < LOW_BALANCE_WARNING_PAISE;
  bool zeroBalance = balancePaise == 0;

  digitalWrite(WARNING_PIN, lowBalance ? HIGH : LOW);

  bool shouldEngageRelay = !zeroBalance && !pzemFaultCutoff && !relayManualOff;
  if (shouldEngageRelay != relayEngaged) {
    setRelay(shouldEngageRelay);
    if (relayEngaged) {
      Serial.println("Relay: load connected");
    } else if (relayManualOff) {
      Serial.println("Relay: load disconnected (manual off from the web interface)");
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

// Web "Relay OFF" (off = true) holds the load disconnected, even after a
// recharge, until "Relay ON" (off = false) releases the hold. Releasing only
// lets applyBalanceState() decide as usual — it never overrides a zero balance
// or a PZEM fault, so the prepaid cut-off can't be bypassed from here.
void setRelayManualOff(bool off) {
  relayManualOff = off;
  prefs.putBool("relayOff", relayManualOff);
  Serial.printf("Relay manual hold %s from the web interface.\n", off ? "set (power cut)" : "released");

  applyBalanceState();

  if (off) {
    showMessage("RELAY", "MANUAL OFF", 4000);
  } else if (relayEngaged) {
    showMessage("RELAY", "ON", 3000);
  } else {
    showMessage("RELAY STAYS OFF", pzemFaultCutoff ? "PZEM FAULT" : "NO BALANCE", 4000);
  }
}
