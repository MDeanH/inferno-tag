// The game screen: rear camera, ArUco detection on the phone, tap a card to shoot.
(() => {
  const $ = (id) => document.getElementById(id);
  const video = $('video'), overlay = $('overlay'), ctx2d = overlay.getContext('2d');
  const token = Inferno.token();
  if (!token) { location.replace('/'); return; }

  // ---------------------------------------------------------------- state from server
  let me = null, state = null, players = new Map();
  const nameOf = (card) => { const p = players.get(card); return p ? p.name : `#${card}`; };
  let wasDown = false, lastHealth = null;
  const gotHit = (dmg) => {                                   // you were shot: buzz (Android), red flash + thud (all phones)
    Inferno.vibrate([150, 60, 150]); Inferno.sounds.hit();
    const f = $('hitflash'); f.style.opacity = '0.75'; setTimeout(() => { f.style.opacity = '0'; }, 220);
    toast(`-${dmg} you got hit!`, 700);
  };
  Inferno.events((s) => {
    state = s; players = new Map(s.players.map(p => [p.card, p]));
    const mine = s.players.find(p => me && p.id === me.id); if (mine) me = mine;
    if (me) { if (lastHealth != null && me.health < lastHealth) gotHit(lastHealth - me.health); lastHealth = me.health; }
    $('state').textContent = s.state.toUpperCase(); $('state').className = 'badge ' + s.state;
    if (me) {
      $('me').textContent = `${me.name} · card ${me.card}`; $('score').textContent = `${me.score} pts`;
      $('hfill').style.width = me.health + '%'; $('hbar').className = 'bar' + (me.health <= 30 ? ' low' : ''); $('vignette').className = 'vignette' + (me.health <= 30 && !me.down ? ' low' : '');
      $('down').classList.toggle('hidden', !me.down); if (me.down) $('downLeft').textContent = Math.ceil(me.downLeft / 1000);
      if (me.down && !wasDown) { Inferno.sounds.ko(); Inferno.vibrate([80, 40, 160]); banner('YOU ARE DOWN'); }
      if (!me.down && wasDown) { Inferno.sounds.respawn(); }
      wasDown = me.down;
    }
    $('feed').innerHTML = s.feed.slice(0, 3).map(f => `<div>${esc(f.text)}</div>`).join('');
    if ($('manual').classList.contains('hidden') === false) renderManual();
  });
  const esc = (t) => String(t).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const heartbeat = async () => { const r = await Inferno.api('/api/heartbeat', { token }).catch(() => null); if (r && r.ok) { me = Object.assign(me || {}, r.player); } else if (r && r.reason === 'not joined') { Inferno.setToken(''); location.replace('/'); } };
  heartbeat(); setInterval(heartbeat, 10000);

  // ---------------------------------------------------------------- shooting
  let toastTimer;
  const toast = (text, ms = 600) => { $('toast').textContent = text; $('toast').classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').classList.remove('show'), ms); };
  let flashUntil = 0, flashCard = 0;
  const banner = (text) => { const b = $('banner'); b.textContent = text; b.classList.remove('show'); void b.offsetWidth; b.classList.add('show'); };
  const hitMark = (x, y, ko) => { const m = document.createElement('div'); m.className = 'hitmark' + (ko ? ' ko' : ''); m.style.left = x + 'px'; m.style.top = y + 'px'; $('play').appendChild(m); setTimeout(() => m.remove(), 500); };
  let lastTap = { x: innerWidth / 2, y: innerHeight / 2 };
  const shoot = async (card) => {
    Inferno.sounds.shot(); Inferno.vibrate(30);
    const ret = $('reticle'); ret.classList.remove('reloading'); void ret.offsetWidth; ret.classList.add('reloading');
    const r = await Inferno.api('/api/hit', { token, targetCard: card }).catch(() => ({ ok: false, reason: 'network' }));
    if (r.ok) { flashCard = card; flashUntil = performance.now() + 250; hitMark(lastTap.x, lastTap.y, r.ko); if (r.ko) { banner(`KO! ${r.targetName}`); Inferno.sounds.ko(); Inferno.vibrate([60, 40, 120]); } else { toast(`${r.targetName} −10 · ${r.targetHealth} HP`); Inferno.sounds.hit(); } }
    else { Inferno.sounds.deny(); toast(r.reason === 'cooldown' ? 'reloading…' : r.reason, 700); }
  };


  // ---------------------------------------------------------------- movement: compass + step counter -> arena position
  // The phone reports heading (compass) and steps (accelerometer peaks). Each step moves the character
  // STEP_M metres in the heading direction. It drifts over time; tapping the HUD name re-centres you.
  const STEP_M = 0.7, SEND_EVERY_MS = 250;
  let heading = 0, haveHeading = false, pendingSteps = 0, lastSend = 0, lastPeak = 0, lastHeadingSent = -1;
  const onOrient = (e) => {
    let h = null;
    if (typeof e.webkitCompassHeading === 'number') h = e.webkitCompassHeading;          // iOS: true compass
    else if (e.absolute && typeof e.alpha === 'number') h = (360 - e.alpha) % 360;        // Android absolute
    else if (typeof e.alpha === 'number') h = (360 - e.alpha) % 360;                      // relative fallback
    if (h != null && !isNaN(h)) { heading = h; haveHeading = true; }
  };
  const onMotion = (e) => {
    const a = e.accelerationIncludingGravity; if (!a) return;
    const mag = Math.hypot(a.x || 0, a.y || 0, a.z || 0);
    const t = performance.now();
    if (mag > 12.5 && t - lastPeak > 320) { lastPeak = t; pendingSteps++; }             // a step: a clear peak above gravity, max ~3/s
  };
  const sendPos = async (recentre) => {
    const t = performance.now();
    if (!recentre && t - lastSend < SEND_EVERY_MS) return;
    const body = { token };
    if (recentre) { body.x = recentre.x; body.y = recentre.y; }
    else {
      if (!pendingSteps && Math.abs(heading - lastHeadingSent) < 4) return;
      const d = pendingSteps * STEP_M, rad = heading * Math.PI / 180;
      body.dx = +(Math.sin(rad) * d).toFixed(2); body.dy = +(-Math.cos(rad) * d).toFixed(2);  // north = up on the board
      pendingSteps = 0;
    }
    body.h = Math.round(heading); lastHeadingSent = heading; lastSend = t;
    Inferno.api('/api/pos', body).catch(() => {});
  };
  setInterval(() => sendPos(), SEND_EVERY_MS);
  const startSensors = async () => {
    try { if (window.DeviceOrientationEvent && typeof DeviceOrientationEvent.requestPermission === 'function') { if (await DeviceOrientationEvent.requestPermission() !== 'granted') return; } } catch { return; }
    try { if (window.DeviceMotionEvent && typeof DeviceMotionEvent.requestPermission === 'function') await DeviceMotionEvent.requestPermission(); } catch {}
    if ('ondeviceorientationabsolute' in window) addEventListener('deviceorientationabsolute', onOrient); else addEventListener('deviceorientation', onOrient);
    addEventListener('devicemotion', onMotion);
  };
  $('me').style.pointerEvents = 'auto';
  $('me').addEventListener('click', () => { if (state && state.arena) { sendPos({ x: state.arena.w / 2, y: state.arena.h / 2 }); toast('re-centred', 500); } });

  // ---------------------------------------------------------------- camera + detection
  const detector = new AR.Detector({ dictionaryName: 'ARUCO_4X4_1000', maxHammingDistance: 0 });
  const work = document.createElement('canvas'), wctx = work.getContext('2d', { willReadFrequently: true });
  const WORK_W = 360, DETECT_EVERY_MS = 66, MEMORY_MS = 450, MARGIN = 24;
  let seen = new Map();            // card -> { corners (screen px), until }
  let lastDetect = 0, running = false;
  const fit = () => { overlay.width = overlay.clientWidth * devicePixelRatio; overlay.height = overlay.clientHeight * devicePixelRatio; };
  addEventListener('resize', fit);
  // object-fit: cover mapping from video pixels to overlay pixels
  const mapper = () => {
    const vw = video.videoWidth, vh = video.videoHeight, ow = overlay.width, oh = overlay.height;
    const s = Math.max(ow / vw, oh / vh); const dx = (ow - vw * s) / 2, dy = (oh - vh * s) / 2;
    return (x, y) => ({ x: x * s + dx, y: y * s + dy });
  };
  const loop = (t) => {
    if (!running) return;
    requestAnimationFrame(loop);
    if (video.readyState < 2 || !video.videoWidth) return;
    if (t - lastDetect >= DETECT_EVERY_MS) {
      lastDetect = t;
      const scale = WORK_W / video.videoWidth; work.width = WORK_W; work.height = Math.round(video.videoHeight * scale);
      wctx.drawImage(video, 0, 0, work.width, work.height);
      let markers = [];
      try { markers = detector.detect(wctx.getImageData(0, 0, work.width, work.height)); } catch {}
      const m = mapper();
      for (const mk of markers) {
        if (mk.id < 1 || mk.id > 20) continue;
        const corners = mk.corners.map(c => m(c.x / scale, c.y / scale));
        seen.set(mk.id, { corners, until: t + MEMORY_MS });
      }
    }
    draw(t);
  };
  const draw = (t) => {
    ctx2d.clearRect(0, 0, overlay.width, overlay.height);
    const dpr = devicePixelRatio;
    for (const [card, s] of seen) {
      if (t > s.until) { seen.delete(card); continue; }
      const p = players.get(card); const isMe = me && card === me.card;
      const c = s.corners; const cx = c.reduce((a, q) => a + q.x, 0) / 4, cy = c.reduce((a, q) => a + q.y, 0) / 4;
      const hot = flashCard === card && t < flashUntil;
      ctx2d.lineWidth = 4 * dpr; ctx2d.strokeStyle = hot ? '#ff3b3b' : isMe ? '#888' : (p && p.down) ? '#ffd166' : '#ff6a2a';
      ctx2d.beginPath(); c.forEach((q, i) => i ? ctx2d.lineTo(q.x, q.y) : ctx2d.moveTo(q.x, q.y)); ctx2d.closePath(); ctx2d.stroke();
      const top = Math.min(...c.map(q => q.y)) - 10 * dpr;
      const label = isMe ? 'YOU' : (p ? `${p.name} · ${p.down ? 'DOWN' : p.health + ' HP'}` : `card ${card} (not joined)`);
      ctx2d.font = `bold ${Math.round(18 * dpr)}px system-ui,sans-serif`; ctx2d.textAlign = 'center';
      const w = Math.max(ctx2d.measureText(label).width + 20 * dpr, 120 * dpr);
      ctx2d.fillStyle = '#000c'; ctx2d.fillRect(cx - w / 2, top - 40 * dpr, w, 38 * dpr);
      ctx2d.fillStyle = (p && !isMe && p.health <= 30) ? '#ff6b6b' : '#fff'; ctx2d.fillText(label, cx, top - 20 * dpr);
      if (p && !isMe) { const bw = w - 12 * dpr, bh = 10 * dpr, by = top - 14 * dpr; ctx2d.fillStyle = '#333'; ctx2d.fillRect(cx - bw / 2, by, bw, bh); ctx2d.fillStyle = p.down ? '#777' : p.health <= 30 ? '#ff3b3b' : p.health <= 60 ? '#ffd166' : '#6fe08a'; ctx2d.fillRect(cx - bw / 2, by, bw * p.health / 100, bh); }
    }
  };
  // point-in-quad with margin: use the bounding box grown by MARGIN (fast, forgiving)
  const hitTest = (x, y) => {
    let best = null, bestD = Infinity; const m = MARGIN * devicePixelRatio;
    for (const [card, s] of seen) {
      const xs = s.corners.map(q => q.x), ys = s.corners.map(q => q.y);
      if (x >= Math.min(...xs) - m && x <= Math.max(...xs) + m && y >= Math.min(...ys) - m && y <= Math.max(...ys) + m) {
        const d = Math.hypot(x - xs.reduce((a, b) => a + b) / 4, y - ys.reduce((a, b) => a + b) / 4);
        if (d < bestD) { bestD = d; best = card; }
      }
    }
    return best;
  };
  $('play').addEventListener('pointerdown', (e) => {
    if (!running || !$('start').classList.contains('hidden')) return;
    if (!$('manual').classList.contains('hidden') || (me && me.down)) return;
    const x = e.clientX * devicePixelRatio, y = e.clientY * devicePixelRatio; lastTap = { x: e.clientX, y: e.clientY };
    const card = hitTest(x, y);
    if (card) shoot(card); else { Inferno.sounds.deny(); toast('aim at a card', 400); }
  });
  const startCamera = async () => {
    $('startErr').textContent = '';
    startSensors();                                   // must be inside the user gesture for iOS permission prompts
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('No camera API. Are you on https:// ?');
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      video.srcObject = stream; await video.play(); fit(); running = true; requestAnimationFrame(loop);
      $('start').classList.add('hidden'); Inferno.sounds.respawn();
    } catch (e) { $('startErr').textContent = 'Camera failed: ' + (e.message || e.name) + '. Use the list instead.'; }
  };
  $('startBtn').onclick = startCamera;
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && running && video.srcObject && !video.srcObject.active) startCamera(); });

  // ---------------------------------------------------------------- manual fallback
  const renderManual = () => {
    const list = $('manualList'); list.innerHTML = '';
    for (const p of [...players.values()].sort((a, b) => a.card - b.card)) {
      if (me && p.id === me.id) continue;
      const b = document.createElement('button'); b.textContent = `${p.card} ${p.name}${p.down ? ' (down)' : ''}`; b.style.fontSize = '14px'; b.disabled = !!p.down;
      b.onclick = () => shoot(p.card); list.appendChild(b);
    }
  };
  $('manualBtn').onclick = () => { startSensors(); $('start').classList.add('hidden'); $('manual').classList.remove('hidden'); renderManual(); };
  $('manualClose').onclick = () => { $('manual').classList.add('hidden'); if (!running) $('start').classList.remove('hidden'); };
  if (new URLSearchParams(location.search).get('manual') === '1') $('manualBtn').onclick();
})();
