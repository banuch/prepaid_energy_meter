// Wi-Fi: join the router without blocking metering, fall back to the meter's
// own hotspot if that fails, and bring the web server up once there's a network.
// Credentials are the constants at the top of firmware.ino.

String wifiIp() {
  return wifiApActive ? WiFi.softAPIP().toString() : WiFi.localIP().toString();
}

const char *wifiModeLabel() {
  if (wifiStaConnected) return "WIFI";
  if (wifiApActive) return "AP";
  return "OFFLINE";
}

// Runs whenever a network becomes available (router joined or hotspot up).
void onNetworkUp() {
  static bool mdnsStarted = false;

  webBegin();
  if (!mdnsStarted && MDNS.begin(MDNS_HOSTNAME)) {
    MDNS.addService("http", "tcp", WEB_PORT);
    mdnsStarted = true;
  }

  String ip = wifiIp();
  Serial.printf("Web UI: http://%s/  (http://%s.local/)\n", ip.c_str(), MDNS_HOSTNAME);

  char label[32];
  snprintf(label, sizeof(label), "WEB %s", ip.c_str());
  showMessage(label, wifiApActive ? "AP MODE" : "WIFI OK", 4000);
}

void startAccessPoint() {
  WiFi.disconnect(true);
  WiFi.mode(WIFI_AP);
  wifiConnecting = false;

  if (!WiFi.softAP(AP_SSID, AP_PASSWORD)) {
    Serial.println("Wi-Fi ERROR: could not start the hotspot — web UI unavailable.");
    return;
  }

  wifiApActive = true;
  Serial.printf("Hotspot started: SSID \"%s\"\n", AP_SSID);
  onNetworkUp();
}

// Non-blocking: returns immediately, wifiTick() finishes the job.
void wifiBegin() {
  WiFi.persistent(false); // credentials live in this sketch, not in flash
  WiFi.setHostname(MDNS_HOSTNAME);

  if (WIFI_SSID[0] == '\0') {
    Serial.println("No Wi-Fi SSID configured — starting hotspot.");
    startAccessPoint();
    return;
  }

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  wifiConnecting = true;
  wifiStartedAt = millis();
  Serial.printf("Connecting to Wi-Fi \"%s\"...\n", WIFI_SSID);
}

void wifiTick() {
  static unsigned long lastCheck = 0;
  unsigned long now = millis();
  if (now - lastCheck < 500) return;
  lastCheck = now;

  if (wifiApActive) return;

  bool connected = WiFi.status() == WL_CONNECTED;
  if (connected && !wifiStaConnected) {
    wifiStaConnected = true;
    wifiConnecting = false;
    Serial.printf("Wi-Fi connected: %s\n", WiFi.localIP().toString().c_str());
    onNetworkUp();
  } else if (!connected && wifiStaConnected) {
    // The ESP32 reconnects on its own; nothing else to do.
    wifiStaConnected = false;
    Serial.println("Wi-Fi connection lost — reconnecting...");
  } else if (!connected && wifiConnecting && now - wifiStartedAt >= WIFI_CONNECT_TIMEOUT_MS) {
    Serial.println("Wi-Fi connect timed out — starting hotspot instead.");
    startAccessPoint();
  }
}
