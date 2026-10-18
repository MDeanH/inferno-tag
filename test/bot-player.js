// Dummy test bot: joins as "Dummy" on card 7, heartbeats, wanders. Never exits; retries joining until the card is free.
const base = 'https://127.0.0.1:3443'; process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const api = async (p, b) => { try { const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }); return await r.json(); } catch (e) { return { ok: false, error: String(e.message || e) }; } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
process.on('unhandledRejection', e => console.log('unhandled', e && e.message));
(async () => {
  let token = '', h = Math.random() * 360;
  for (;;) {
    if (!token) { const j = await api('/api/join', { name: 'Dummy', card: 7 }); if (j.token) { token = j.token; console.log('bot joined as card 7'); } else { console.log('join not yet possible:', j.error); await sleep(10000); continue; } }
    const hb = await api('/api/heartbeat', { token }); if (hb.reason === 'not joined') { console.log('kicked or reset; rejoining'); token = ''; continue; }
    for (let i = 0; i < 6 && token; i++) { h = (h + Math.random() * 60 - 30 + 360) % 360; const rad = h * Math.PI / 180; await api('/api/pos', { token, dx: +(Math.sin(rad) * 0.4).toFixed(2), dy: +(-Math.cos(rad) * 0.4).toFixed(2), h: Math.round(h) }); await sleep(1500); }
  }
})();
