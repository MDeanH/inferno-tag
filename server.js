// Inferno Tag — AR laser tag for a room of phones, hosted on a Raspberry Pi 4.
// Zero dependencies. Node 18+. The Pi keeps score; phones do the computer vision.
//
//   PORT        plain-HTTP port (nginx on the Pi forwards :80 here)   default 3000
//   HTTPS_PORT  self-signed HTTPS port (phone cameras need HTTPS)      default 3443
//   HOST_PIN    optional PIN for host actions                            default: none
//   PUBLIC_IP   IP to advertise in URLs/QR codes (multi-homed hosts)    default: first LAN IPv4
'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const PORT = Number(process.env.PORT) || 3000;
const HTTPS_PORT = Number(process.env.HTTPS_PORT) || 3443;
const HOST_PIN = process.env.HOST_PIN || '';                 // empty = no PIN, anyone can host
const PUBLIC_IP = process.env.PUBLIC_IP || '';          // advertise this IP (hosts with several interfaces)
const PUBLIC = path.join(__dirname, 'public');
const CERTS = path.join(__dirname, 'certs');

// ---------------------------------------------------------------- game rules
const RULES = { maxHealth: 100, damage: 34,   // 3 hits = knockout (100 → 66 → 32 → 0)
  cooldownMs: 1500, downMs: 8000, hitScore: 1, koScore: 5, cards: 20, onlineMs: 60000, feedMax: 20 };

// ---------------------------------------------------------------- state
const game = { state: 'lobby', round: 0, players: new Map(), feed: [], hits: [] };   // hits: recent {t, from, to, ko} for the arena view
const ARENA = { w: 20, h: 14 };                                                     // metres; players dead-reckon inside it
const byToken = new Map();
const sseClients = new Set();

function lanIp() {
  if (PUBLIC_IP) return PUBLIC_IP;
  for (const addrs of Object.values(os.networkInterfaces())) for (const a of addrs || []) if (a.family === 'IPv4' && !a.internal) return a.address;
  return '127.0.0.1';
}
function now() { return Date.now(); }
function spawnAtCentre(p) {                                                     // everyone starts together in the middle; small ring offset so characters don't stack
  const a = (p.card / RULES.cards) * Math.PI * 2;
  p.x = +(ARENA.w / 2 + Math.cos(a) * 0.6).toFixed(2); p.y = +(ARENA.h / 2 + Math.sin(a) * 0.6).toFixed(2);
}
function clamp(v, a, b) { return Math.max(a, Math.min(b, Number(v) || 0)); }
function log(...a) { console.log(new Date().toISOString().slice(11, 19), ...a); }
function pushFeed(text) { game.feed.unshift({ t: now(), text }); game.feed.length = Math.min(game.feed.length, RULES.feedMax); }
function isOnline(p) { return now() - p.lastSeen < RULES.onlineMs; }
function snapshot() {
  const players = [...game.players.values()].map(p => ({ id: p.id, name: p.name, card: p.card, health: p.health, score: p.score, down: p.down, downLeft: p.down ? Math.max(0, p.downUntil - now()) : 0, online: isOnline(p), kills: p.kills, deaths: p.deaths, x: p.x, y: p.y, h: p.h, moved: p.moved }))
    .sort((a, b) => b.score - a.score || a.card - b.card);
  return { state: game.state, round: game.round, players, feed: game.feed, hits: game.hits.filter(h => now() - h.t < 1500), arena: ARENA, rules: RULES, ip: lanIp(), httpsPort: HTTPS_PORT, t: now() };
}
function broadcast() {
  const data = `data: ${JSON.stringify(snapshot())}\n\n`;
  for (const res of sseClients) { try { res.write(data); } catch { sseClients.delete(res); } }
}
let dirty = false;
function changed() { dirty = true; }
setInterval(() => { if (dirty) { dirty = false; broadcast(); } }, 100);          // coalesce bursts
setInterval(() => { for (const res of sseClients) { try { res.write(': ping\n\n'); } catch { sseClients.delete(res); } } }, 15000);
setInterval(() => {                                                              // respawns
  const t = now(); let any = false;
  for (const p of game.players.values()) if (p.down && t >= p.downUntil) { p.down = false; p.health = RULES.maxHealth; pushFeed(`${p.name} is back`); any = true; }
  if (any) changed();
}, 250);

// ---------------------------------------------------------------- game actions
function join(name, card) {
  name = String(name || '').trim().slice(0, 16); card = Number(card);
  if (!name) return { error: 'Name required' };
  if (!Number.isInteger(card) || card < 1 || card > RULES.cards) return { error: `Card must be 1-${RULES.cards}` };
  for (const p of game.players.values()) if (p.card === card) {
    if (isOnline(p)) return { error: `Card ${card} is taken by ${p.name}` };
    game.players.delete(p.id); byToken.delete(p.token); pushFeed(`${p.name} (card ${card}) was replaced by ${name}`);
  }
  const id = 'p' + crypto.randomBytes(3).toString('hex');
  const token = crypto.randomBytes(16).toString('hex');
  const p = { id, token, name, card, health: RULES.maxHealth, score: 0, kills: 0, deaths: 0, down: false, downUntil: 0, lastShot: 0, lastSeen: now(),
    x: 0, y: 0, h: 0, moved: 0 };
  spawnAtCentre(p);
  game.players.set(id, p); byToken.set(token, p);
  pushFeed(`${name} joined with card ${card}`); changed(); log('join', name, card);
  return { token, playerId: id, player: { id, name, card } };
}
function hit(token, targetCard) {
  const s = byToken.get(token); if (!s) return { ok: false, reason: 'not joined' };
  s.lastSeen = now();
  if (game.state !== 'live') return { ok: false, reason: game.state === 'lobby' ? 'waiting for host' : 'round over' };
  if (s.down) return { ok: false, reason: 'you are down' };
  targetCard = Number(targetCard);
  const t = [...game.players.values()].find(p => p.card === targetCard);
  if (!t) return { ok: false, reason: `card ${targetCard} not in game` };
  if (t.id === s.id) return { ok: false, reason: "that's you" };
  if (t.down) return { ok: false, reason: `${t.name} is down` };
  const n = now();
  if (n - s.lastShot < RULES.cooldownMs) return { ok: false, reason: 'cooldown', waitMs: RULES.cooldownMs - (n - s.lastShot) };
  s.lastShot = n; t.health = Math.max(0, t.health - RULES.damage); s.score += RULES.hitScore;
  let ko = false;
  game.hits.unshift({ t: n, from: s.card, to: t.card, ko: t.health === 0 }); game.hits.length = Math.min(game.hits.length, 40);
  if (t.health === 0) { ko = true; t.down = true; t.downUntil = n + RULES.downMs; t.deaths++; s.kills++; s.score += RULES.koScore; pushFeed(`${s.name} knocked out ${t.name}!`); }
  else pushFeed(`${s.name} hit ${t.name} (-${RULES.damage})`);
  changed();
  return { ok: true, ko, targetHealth: t.health, targetName: t.name, score: s.score };
}
function host(pin, action, playerId) {
  if (HOST_PIN && pin !== HOST_PIN) return { ok: false, reason: 'bad pin' };
  if (action === 'start') { game.state = 'live'; game.round++; for (const p of game.players.values()) { p.health = RULES.maxHealth; p.down = false; p.score = 0; p.kills = 0; p.deaths = 0; spawnAtCentre(p); } game.feed = []; pushFeed(`Round ${game.round} started`); }
  else if (action === 'end') { game.state = 'ended'; const top = snapshot().players[0]; pushFeed(top ? `Round over. Winner: ${top.name} (${top.score})` : 'Round over'); }
  else if (action === 'lobby') { game.state = 'lobby'; pushFeed('Back to lobby'); }
  else if (action === 'reset') { game.state = 'lobby'; game.round = 0; game.players.clear(); byToken.clear(); game.feed = []; pushFeed('Game reset'); }
  else if (action === 'kick') { const p = game.players.get(playerId); if (p) { game.players.delete(p.id); byToken.delete(p.token); pushFeed(`${p.name} was removed`); } }
  else return { ok: false, reason: 'unknown action' };
  changed(); log('host', action); return { ok: true };
}

// ---------------------------------------------------------------- http plumbing
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon' };
const PAGES = { '/': 'index.html', '/play': 'play.html', '/board': 'board.html', '/host': 'host.html', '/cards': 'cards.html', '/landing': 'landing.html' };
function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}
function readJson(req) {
  return new Promise((resolve) => { let b = ''; req.on('data', c => { b += c; if (b.length > 1e5) req.destroy(); }); req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } }); });
}
function serveStatic(res, rel) {
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC)) return send(res, 403, 'Forbidden', 'text/plain');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found', 'text/plain');
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}
async function handle(req, res, secure) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (req.method === 'GET') {
    if (p === '/api/state') return send(res, 200, snapshot());
    if (p === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
      sseClients.add(res); req.on('close', () => sseClients.delete(res)); return;
    }
    if (p === '/' && !secure) return serveStatic(res, 'landing.html');   // plain HTTP: send phones to HTTPS
    if (PAGES[p]) return serveStatic(res, PAGES[p]);
    return serveStatic(res, p.slice(1));
  }
  if (req.method === 'POST') {
    const body = await readJson(req);
    if (p === '/api/join') { const r = join(body.name, body.card); return send(res, r.error ? 400 : 200, r); }
    if (p === '/api/hit') return send(res, 200, hit(body.token, body.targetCard));
    if (p === '/api/heartbeat') { const pl = byToken.get(body.token); if (!pl) return send(res, 404, { ok: false, reason: 'not joined' }); pl.lastSeen = now(); return send(res, 200, { ok: true, player: { id: pl.id, name: pl.name, card: pl.card, health: pl.health, score: pl.score, down: pl.down } }); }
    if (p === '/api/host') return send(res, 200, host(body.pin, body.action, body.playerId));
    if (p === '/api/pos') {                                                   // phone dead-reckoning: {token, dx, dy, h} metres since last report, or {token, x, y} to recentre
      const pl = byToken.get(body.token); if (!pl) return send(res, 404, { ok: false, reason: 'not joined' });
      pl.lastSeen = now();
      if (typeof body.x === 'number' && typeof body.y === 'number') { pl.x = clamp(body.x, 0, ARENA.w); pl.y = clamp(body.y, 0, ARENA.h); }
      else { pl.x = clamp(pl.x + (Number(body.dx) || 0), 0, ARENA.w); pl.y = clamp(pl.y + (Number(body.dy) || 0), 0, ARENA.h); }
      if (typeof body.h === 'number') pl.h = ((body.h % 360) + 360) % 360;
      pl.x = +pl.x.toFixed(2); pl.y = +pl.y.toFixed(2); pl.moved = now(); changed();
      return send(res, 200, { ok: true, x: pl.x, y: pl.y });
    }
    return send(res, 404, { ok: false, reason: 'no such endpoint' });
  }
  send(res, 405, 'Method not allowed', 'text/plain');
}
function wrap(secure) { return (req, res) => handle(req, res, secure).catch(e => { log('error', e); try { send(res, 500, { ok: false, reason: 'server error' }); } catch {} }); }

// ---------------------------------------------------------------- certificate
function ensureCert() {
  const key = path.join(CERTS, 'key.pem'), cert = path.join(CERTS, 'cert.pem');
  if (!fs.existsSync(key) || !fs.existsSync(cert)) {
    fs.mkdirSync(CERTS, { recursive: true });
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '30', '-keyout', key, '-out', cert,
      '-subj', '/CN=' + os.hostname(), '-addext', `subjectAltName=DNS:${os.hostname()},DNS:${os.hostname()}.local,DNS:localhost,IP:${lanIp()},IP:127.0.0.1`], { stdio: 'ignore' });
    log('generated self-signed certificate in', CERTS);
  }
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

// ---------------------------------------------------------------- start
http.createServer(wrap(false)).listen(PORT, () => log(`HTTP  http://${lanIp()}:${PORT}  (landing page; behind nginx :80 on the Pi)`));
try {
  https.createServer(ensureCert(), wrap(true)).listen(HTTPS_PORT, () => log(`HTTPS https://${lanIp()}:${HTTPS_PORT}  (players: /, board: /board, host: /host, cards: /cards)`));
} catch (e) { log('HTTPS disabled:', e.message, '— camera pages will not work over plain HTTP'); }
process.on('unhandledRejection', e => log('unhandledRejection', e));
