// Serial-only Screen: prints the HUD over USB. Used until the watch's display driver is wired up.
#ifndef SCREEN_REAL
#include "screen.h"
static String lastLine;
void Screen::begin() {}
void Screen::splash() { Serial.println("\n=== INFERNO TAG wrist HUD ==="); }
void Screen::status(const char* a, const char* b) { Serial.printf("[status] %s — %s\n", a, b); }
void Screen::waiting(int card, const char* state) { String l = String("[waiting] card ") + card + " not joined · " + state; if (l != lastLine) { Serial.println(l); lastLine = l; } }
void Screen::hud(const char* name, int card, int health, int score, int kills, const char* state, int round,
                 bool down, int downLeft, bool shielded, int shieldLeft, int shieldsLeft, const char* feed) {
  String l = String("[hud] ") + name + " #" + card + " hp=" + health + " score=" + score + " ko=" + kills + " " + state + " r" + round +
             (down ? String(" DOWN ") + downLeft + "s" : "") + (shielded ? String(" SHIELD ") + shieldLeft + "s" : "") + " shields=" + shieldsLeft + " | " + feed;
  if (l != lastLine) { Serial.println(l); lastLine = l; }
}
void Screen::toast(const char* t) { Serial.printf("[toast] %s\n", t); }
void Screen::flash() { Serial.println("[flash]"); }
void Screen::tick() {}
bool Screen::touched() { return false; }
#endif
