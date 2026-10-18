# Inferno Tag

AR laser tag for a room full of phones, hosted on a Raspberry Pi 4. Zero dependencies.

- Players pin a printed ArUco card (IDs 1–20) on their chest and join with that number.
- Their phone's rear camera finds cards in view (all vision runs on the phone); tapping a card hits that player.
- The Pi keeps score and pushes state to everyone over Server-Sent Events.

## Run

```bash
node server.js                      # HTTP :3000 (landing), HTTPS :3443 (game, self-signed cert made on first start)
PORT=4000 HTTPS_PORT=4443 node server.js
HOST_PIN=1234 node server.js        # optional; no PIN by default
```

Pages on the HTTPS port: `/` join · `/play` game · `/board` leaderboard · `/host` controls · `/cards` printable cards.
Plain HTTP `/` is a landing page that sends phones to the HTTPS URL (phone cameras need HTTPS).

## Players

1. Join Wi-Fi **LAB Events**. 2. Open the HTTPS URL on the board. 3. Accept the certificate warning once
(Safari: Show Details → visit this website; Chrome: Advanced → Proceed). 4. Name + card number → Start camera.

## Rules (server.js `RULES`)

100 health · 10 damage · 1.5 s cooldown per shooter · 8 s down then respawn · +1 per hit, +5 per knockout.

## Test

`node test/smoke.js` runs the server on spare ports, joins 20 simulated players, fires hits and checks rules.
