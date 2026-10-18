// Inferno Tag wrist HUD — one ESP32-S3 watch as a demo add-on.
// Follows one player (MY_CARD): shows health/score/state, buzzes on hits, raises a shield on button press.
// Display is behind the Screen interface (screen.h) so the same logic runs on any watch model.
#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include "secrets.h"
#include "screen.h"

#ifndef MY_CARD
#define MY_CARD 1            // the player this watch belongs to (card number)
#endif
#ifndef PIN_BUTTON
#define PIN_BUTTON 0         // boot button on most S3 boards; override per watch
#endif
#ifndef PIN_MOTOR
#define PIN_MOTOR -1         // vibration motor GPIO, -1 = none
#endif
#define POLL_MS 700

static Screen screen;
static WiFiClientSecure tls;
static int lastHealth = -1, lastScore = 0, shieldsLeft = 1;
static bool lastDown = false, lastShielded = false;
static String lastFeed, lastState = "lobby";
static unsigned long nextPoll = 0, buzzUntil = 0, btnDownAt = 0;
static bool btnWas = false;

static void buzz(unsigned ms) { if (PIN_MOTOR >= 0) { digitalWrite(PIN_MOTOR, HIGH); buzzUntil = millis() + ms; } screen.flash(); }
static void buzzPattern(int n) { for (int i = 0; i < n; i++) { if (PIN_MOTOR >= 0) digitalWrite(PIN_MOTOR, HIGH); delay(90); if (PIN_MOTOR >= 0) digitalWrite(PIN_MOTOR, LOW); delay(70); } }

static bool httpGet(const String& path, String& out) {
  HTTPClient http; http.setTimeout(2500);
  if (!http.begin(tls, GAME_HOST, GAME_PORT, path, true)) return false;
  int code = http.GET(); if (code == 200) out = http.getString(); http.end(); return code == 200;
}
static bool httpPost(const String& path, const String& body, String& out) {
  HTTPClient http; http.setTimeout(2500);
  if (!http.begin(tls, GAME_HOST, GAME_PORT, path, true)) return false;
  http.addHeader("Content-Type", "application/json");
  int code = http.POST(body); if (code == 200) out = http.getString(); http.end(); return code == 200;
}

static void connectWifi() {
  screen.status("Wi-Fi…", WIFI_SSID);
  WiFi.mode(WIFI_STA); WiFi.setSleep(false); WiFi.begin(WIFI_SSID, WIFI_PSK);
  unsigned long t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < 20000) { delay(250); screen.tick(); }
  if (WiFi.status() == WL_CONNECTED) { screen.status("Connected", WiFi.localIP().toString().c_str()); Serial.printf("wifi ok %s\n", WiFi.localIP().toString().c_str()); }
  else screen.status("Wi-Fi failed", "retrying");
}

static void raiseShield() {
  String out; if (!httpPost("/api/shield", String("{\"card\":") + MY_CARD + "}", out)) { screen.toast("no server"); return; }
  JsonDocument d; if (deserializeJson(d, out)) return;
  if (d["ok"] == true) { shieldsLeft = d["shieldsLeft"] | 0; screen.toast("SHIELD UP"); buzzPattern(2); }
  else screen.toast(String(d["reason"] | "no shield").c_str());
}

static void poll() {
  String out; if (!httpGet(String("/api/me?card=") + MY_CARD, out)) { screen.status("No server", GAME_HOST); return; }
  JsonDocument d; if (deserializeJson(d, out)) return;
  String state = d["state"] | "lobby"; int round = d["round"] | 0; String feed = d["feed"] | "";
  if (d["player"].isNull()) { screen.waiting(MY_CARD, state.c_str()); return; }
  JsonObject p = d["player"];
  int health = p["health"] | 0, score = p["score"] | 0, kills = p["kills"] | 0; bool down = p["down"] | false, shielded = p["shielded"] | false;
  int downLeft = (p["downLeft"] | 0) / 1000, shieldLeft = (p["shieldLeft"] | 0) / 1000; shieldsLeft = p["shieldsLeft"] | shieldsLeft;
  const char* name = p["name"] | "?";
  if (lastHealth >= 0 && health < lastHealth) { buzz(250); screen.toast("HIT!"); }
  if (down && !lastDown) { buzzPattern(3); screen.toast("YOU ARE DOWN"); }
  if (!down && lastDown) { buzzPattern(1); screen.toast("BACK IN"); }
  if (score > lastScore) screen.toast(kills > 0 && score - lastScore >= 6 ? "KNOCKOUT!" : "+1");
  if (feed != lastFeed && feed.length()) lastFeed = feed;
  lastHealth = health; lastScore = score; lastDown = down; lastShielded = shielded; lastState = state;
  screen.hud(name, MY_CARD, health, score, kills, state.c_str(), round, down, downLeft, shielded, shieldLeft, shieldsLeft, lastFeed.c_str());
}

void setup() {
  Serial.begin(115200); delay(300);
  if (PIN_MOTOR >= 0) { pinMode(PIN_MOTOR, OUTPUT); digitalWrite(PIN_MOTOR, LOW); }
  pinMode(PIN_BUTTON, INPUT_PULLUP);
  screen.begin(); screen.splash();
  tls.setInsecure();                       // the game server uses a self-signed certificate
  connectWifi();
}

void loop() {
  unsigned long now = millis();
  if (buzzUntil && now > buzzUntil) { if (PIN_MOTOR >= 0) digitalWrite(PIN_MOTOR, LOW); buzzUntil = 0; }
  bool btn = digitalRead(PIN_BUTTON) == LOW || screen.touched();
  if (btn && !btnWas) btnDownAt = now;
  if (!btn && btnWas && now - btnDownAt > 30) raiseShield();
  btnWas = btn;
  if (WiFi.status() != WL_CONNECTED) { connectWifi(); return; }
  if (now >= nextPoll) { nextPoll = now + POLL_MS; poll(); }
  screen.tick();
  delay(10);
}
