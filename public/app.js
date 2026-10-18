// Shared helpers for every page: API calls, SSE with reconnect, token storage, sounds, QR.
const Inferno = (() => {
  const KEY = 'inferno.token';
  const api = async (path, body) => {
    const r = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' });
    return r.json();
  };
  const token = () => { try { return localStorage.getItem(KEY) || ''; } catch { return ''; } };
  const setToken = (t) => { try { t ? localStorage.setItem(KEY, t) : localStorage.removeItem(KEY); } catch {} };
  // Server-Sent Events with automatic reconnect; onState gets every snapshot.
  const events = (onState, onStatus) => {
    let es, timer;
    const open = () => {
      es = new EventSource('/api/events');
      es.onmessage = (e) => { try { onState(JSON.parse(e.data)); } catch {} };
      es.onopen = () => onStatus && onStatus(true);
      es.onerror = () => { onStatus && onStatus(false); es.close(); clearTimeout(timer); timer = setTimeout(open, 1500); };
    };
    open();
    return () => { clearTimeout(timer); es && es.close(); };
  };
  // Tiny WebAudio synth so no audio files are needed (and no network).
  let ctx;
  const beep = (freq = 880, ms = 70, type = 'square', gain = 0.08) => {
    try {
      ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
      if (ctx.state === 'suspended') ctx.resume();
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = type; o.frequency.value = freq; g.gain.value = gain;
      o.connect(g); g.connect(ctx.destination); o.start();
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + ms / 1000); o.stop(ctx.currentTime + ms / 1000);
    } catch {}
  };
  const sounds = {
    shot: () => { beep(1200, 60, 'square'); setTimeout(() => beep(600, 60, 'sawtooth'), 40); },
    hit: () => beep(220, 140, 'sawtooth', 0.12),
    ko: () => { beep(160, 200, 'square', 0.15); setTimeout(() => beep(110, 300, 'square', 0.15), 150); },
    deny: () => beep(300, 50, 'sine', 0.05),
    respawn: () => { beep(660, 80); setTimeout(() => beep(990, 120), 90); },
  };
  const vibrate = (p) => { try { navigator.vibrate && navigator.vibrate(p); } catch {} };
  const qrSvg = (text, px = 160) => { try { const q = qrcode(0, 'M'); q.addData(text); q.make(); const n = q.getModuleCount(); return q.createSvgTag({ cellSize: Math.max(2, Math.floor(px / n)), margin: 2 }); } catch { return ''; } };
  const gameUrl = (s) => `https://${s.ip}:${s.httpsPort}/`;
  // Narrator: speaks new feed lines with the browser's offline speech engine. Needs one tap to enable.
  const narrator = (button) => {
    let on = false, seen = new Set(), primed = false, queue = 0;
    const synth = window.speechSynthesis;
    const say = (text) => {
      if (!on || !synth || queue > 4) return;
      const u = new SpeechSynthesisUtterance(text); u.rate = 1.15; u.pitch = 1; u.volume = 1;
      const v = synth.getVoices().find(v => /en[-_]US/i.test(v.lang) && /Samantha|Google US|Alex|Daniel/i.test(v.name)) || synth.getVoices().find(v => /^en/i.test(v.lang));
      if (v) u.voice = v;
      queue++; u.onend = u.onerror = () => { queue = Math.max(0, queue - 1); };
      synth.speak(u);
    };
    const phrase = (t) => t.replace(/\(-(\d+)\)/, 'for $1').replace('knocked out', 'knocked out').replace(/!$/, '');
    const update = (snapshot) => {
      const lines = snapshot.feed.slice().reverse();           // oldest first
      if (!primed) { lines.forEach(f => seen.add(f.t + f.text)); primed = true; return; }   // don't read history on load
      for (const f of lines) { const k = f.t + f.text; if (!seen.has(k)) { seen.add(k); say(phrase(f.text)); } }
      if (seen.size > 400) seen = new Set([...seen].slice(-200));
    };
    const render = () => { if (button) { button.textContent = on ? '🔊 Narration on' : '🔇 Narration off'; } };
    const toggle = () => { on = !on; if (on) { try { synth.cancel(); say('Narration on'); } catch {} } else { try { synth.cancel(); } catch {} } render(); };
    if (button) { button.onclick = toggle; render(); if (!synth) { button.disabled = true; button.textContent = 'No speech on this browser'; } }
    return { update, toggle, isOn: () => on };
  };
  return { api, token, setToken, events, sounds, vibrate, qrSvg, gameUrl, narrator };
})();
