// Web server: dashboard page, JSON status API and the password-protected
// reset operations.
//
//   GET  /                     dashboard (web_page.ino)
//   GET  /api/status           live status as JSON (open)
//   POST /api/reset-balance    body amount=<rupees> (optional, default 0)  [admin]
//   POST /api/reset-cycle      billing cycle units back to 0               [admin]
//   POST /api/relay            body state=off (hold power cut) | on (release) [admin]
//
// Admin calls carry HTTP Basic auth (user "admin", password ADMIN_PASSWORD).
// Wrong passwords answer 401 without WWW-Authenticate, so the browser doesn't
// pop its own login box — the page sends the header itself.

constexpr const char *ADMIN_USER = "admin";
constexpr double MAX_RESET_BALANCE_RUPEES = 99999.99;

// After this many wrong passwords in a row, admin calls are refused for a while.
constexpr uint8_t AUTH_MAX_FAILURES = 5;
constexpr unsigned long AUTH_LOCKOUT_MS = 60000;

uint8_t authFailures = 0;
bool authLocked = false;
unsigned long authLockedUntil = 0;

void sendJson(int code, const String &body) {
  server.sendHeader("Cache-Control", "no-store");
  server.send(code, "application/json", body);
}

void sendError(int code, const char *message) {
  String body = "{\"ok\":false,\"error\":\"";
  body += message;
  body += "\"}";
  sendJson(code, body);
}

// True if the request carries the admin password. Otherwise the error reply
// has already been sent and the handler should just return.
bool requireAdmin() {
  unsigned long now = millis();

  if (authLocked) {
    if ((long)(now - authLockedUntil) < 0) {
      sendError(429, "Too many wrong passwords - try again in a minute");
      return false;
    }
    authLocked = false;
    authFailures = 0;
  }

  if (server.authenticate(ADMIN_USER, ADMIN_PASSWORD)) {
    authFailures = 0;
    return true;
  }

  if (++authFailures >= AUTH_MAX_FAILURES) {
    authLocked = true;
    authLockedUntil = now + AUTH_LOCKOUT_MS;
    Serial.println("Web: too many wrong admin passwords — locked for 60 s.");
  }
  sendError(401, "Wrong password");
  return false;
}

// Everything the dashboard shows: the Serial status fields plus tariff,
// network and uptime.
String statusJson() {
  StaticJsonDocument<2048> doc;
  fillStatusJson(doc, balancePaise < LOW_BALANCE_WARNING_PAISE);

  doc["lowBalanceThresholdPaise"] = LOW_BALANCE_WARNING_PAISE;
  doc["pzemOk"] = !isnan(latest.voltage);
  doc["relayReason"] = relayReason();
  doc["wifiMode"] = wifiModeLabel();
  doc["ip"] = wifiIp();
  doc["uptimeS"] = millis() / 1000;

  JsonArray slabs = doc.createNestedArray("tariffSlabs");
  for (uint8_t i = 0; i < tariff.slabCount; i++) {
    JsonObject slab = slabs.createNestedObject();
    slab["unbounded"] = tariff.slabs[i].unbounded;
    slab["upToUnits"] = tariff.slabs[i].upperLimitUnits;
    slab["ratePaise"] = tariff.slabs[i].ratePaisePerUnit;
  }

  String out;
  serializeJson(doc, out);
  return out;
}

void handleRoot() {
  server.sendHeader("Cache-Control", "no-store");
  server.send(200, "text/html", INDEX_HTML);
}

void handleStatus() {
  sendJson(200, statusJson());
}

void handleResetBalance() {
  if (!requireAdmin()) return;

  double rupees = 0; // empty amount means reset to zero
  String amount = server.arg("amount");
  amount.trim();
  if (amount.length() > 0) {
    char *end;
    rupees = strtod(amount.c_str(), &end);
    if (end == amount.c_str() || *end != '\0' || isnan(rupees) || rupees < 0 || rupees > MAX_RESET_BALANCE_RUPEES) {
      sendError(400, "Amount must be between 0 and 99999.99");
      return;
    }
  }

  resetBalance((uint32_t)round(rupees * 100.0));
  sendJson(200, statusJson());
}

void handleResetCycle() {
  if (!requireAdmin()) return;

  resetBillingCycle();
  sendJson(200, statusJson());
}

void handleRelay() {
  if (!requireAdmin()) return;

  String state = server.arg("state");
  if (state == "off") {
    setRelayManualOff(true);
  } else if (state == "on") {
    setRelayManualOff(false);
  } else {
    sendError(400, "state must be on or off");
    return;
  }
  sendJson(200, statusJson());
}

void handleNotFound() {
  sendError(404, "Not found");
}

// Idempotent — called every time a network comes up.
void webBegin() {
  if (webStarted) return;

  // authenticate() needs the Authorization header kept.
  const char *headerKeys[] = {"Authorization"};
  server.collectHeaders(headerKeys, 1);

  server.on("/", HTTP_GET, handleRoot);
  server.on("/api/status", HTTP_GET, handleStatus);
  server.on("/api/reset-balance", HTTP_POST, handleResetBalance);
  server.on("/api/reset-cycle", HTTP_POST, handleResetCycle);
  server.on("/api/relay", HTTP_POST, handleRelay);
  server.onNotFound(handleNotFound);
  server.begin();
  webStarted = true;
}

void webTick() {
  if (webStarted) server.handleClient();
}
