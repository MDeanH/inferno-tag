// Screen interface for the watch HUD. The default build is a serial-only "screen" so the game logic
// compiles and runs on any ESP32-S3 before the display driver is known. A real display implements the
// same methods in screen_<model>.cpp and is selected with -DSCREEN_<MODEL>.
#pragma once
#include <Arduino.h>

class Screen {
 public:
  void begin();
  void splash();
  void status(const char* line1, const char* line2);
  void waiting(int card, const char* state);
  void hud(const char* name, int card, int health, int score, int kills, const char* state, int round,
           bool down, int downLeft, bool shielded, int shieldLeft, int shieldsLeft, const char* feed);
  void toast(const char* text);
  void flash();
  void tick();
  bool touched();
};
