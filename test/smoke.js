// Smoke test: start the server on spare ports, join 20 players, fire hits, check every rule.
// Usage: node test/smoke.js      (exits 0 on pass, 1 on fail)
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const PORT = 5100 + Math.floor(Math.random() * 300), HTTPS_PORT = PORT + 1000, PIN = '4242';
const base = `http://127.0.0.1:${PORT}`;
const api = async (p, body) => (await fetch(base + p, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})).json();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let fails = 0; const check = (ok, msg) => { console.log((ok ? '  ok   ' : '  FAIL ') + msg); if (!ok) fails++; };

(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT, HTTPS_PORT, HOST_PIN: PIN }, stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stderr.on('data', d => process.stderr.write('[server] ' + d));
  for (let i = 0; i < 40; i++) { try { await api('/api/state'); break; } catch { await sleep(100); } }
  console.log(`server up on ${PORT}/${HTTPS_PORT}`);

  // join 20 players
  const players = [];
  for (let c = 1; c <= 20; c++) { const r = await api('/api/join', { name: 'P' + c, card: c }); players.push(r); }
  check(players.every(p => p.token), 'twenty players joined');
  check((await api('/api/join', { name: 'Dup', card: 7 })).error, 'duplicate card rejected while holder is online');
  check((await api('/api/join', { name: 'X', card: 21 })).error, 'card 21 rejected');
  check((await api('/api/join', { name: '', card: 3 })).error, 'empty name rejected');

  // lobby: hits ignored
  let r = await api('/api/hit', { token: players[0].token, targetCard: 2 });
  check(!r.ok && /host/.test(r.reason), 'hit in lobby rejected: ' + r.reason);

  // host start
  check(!(await api('/api/host', { pin: '0000', action: 'start' })).ok, 'bad PIN rejected');
  check((await api('/api/host', { pin: PIN, action: 'start' })).ok, 'round started');

  r = await api('/api/hit', { token: players[0].token, targetCard: 2 });
  check(r.ok && r.targetHealth === 90, 'first hit lands: -10');
  r = await api('/api/hit', { token: players[0].token, targetCard: 2 });
  check(!r.ok && r.reason === 'cooldown', 'second hit inside cooldown rejected');
  r = await api('/api/hit', { token: players[0].token, targetCard: 1 });
  check(!r.ok, 'self hit rejected: ' + r.reason);
  r = await api('/api/hit', { token: 'nope', targetCard: 2 });
  check(!r.ok, 'unknown token rejected');

  // knock out player 2: 9 more hits from different shooters
  for (let i = 2; i <= 10; i++) { r = await api('/api/hit', { token: players[i].token, targetCard: 2 }); }
  check(r.ok && r.ko && r.targetHealth === 0, 'tenth hit knocks out');
  r = await api('/api/hit', { token: players[11].token, targetCard: 2 });
  check(!r.ok && /down/.test(r.reason), 'hitting a downed player rejected');
  r = await api('/api/hit', { token: players[1].token, targetCard: 3 });
  check(!r.ok && /you are down/.test(r.reason), 'downed player cannot shoot');

  let s = await api('/api/state');
  const p10 = s.players.find(p => p.card === 11);
  check(p10.score === 6 && p10.kills === 1, 'knockout shooter scored +1 +5');
  check(s.players[0].card === 11, 'leaderboard sorted by score');
  check(s.feed.length > 0 && s.feed.length <= 20, 'feed populated and capped');

  // SSE delivers snapshots
  const es = await fetch(base + '/api/events'); const reader = es.body.getReader(); const { value } = await reader.read();
  check(Buffer.from(value).toString().startsWith('data: {'), 'SSE first message is a snapshot'); reader.cancel();

  // respawn timing (server downMs is 8000; wait for it)
  process.stdout.write('  waiting for respawn (8s)…\n'); await sleep(8600);
  s = await api('/api/state'); check(s.players.find(p => p.card === 2).health === 100, 'downed player respawned at 100');

  // 20 players * 30 hits burst: server stays responsive
  const t0 = Date.now(); let okHits = 0;
  for (let round = 0; round < 30; round++) { await Promise.all(players.map((p, i) => api('/api/hit', { token: p.token, targetCard: (i + 1) % 20 + 1 }).then(x => { if (x.ok) okHits++; }))); }
  check(Date.now() - t0 < 5000, `600 hit requests served in ${Date.now() - t0} ms (${okHits} landed)`);

  check((await api('/api/host', { pin: PIN, action: 'end' })).ok, 'round ended');
  check((await api('/api/host', { pin: PIN, action: 'reset' })).ok && (await api('/api/state')).players.length === 0, 'reset clears players');

  srv.kill();
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
