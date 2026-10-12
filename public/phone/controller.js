// Phone-side Wii Remote: reads touch + motion, streams it to the laptop.

const BUTTON = {
  A: 1 << 0,
  B: 1 << 1,
  ONE: 1 << 2,
  TWO: 1 << 3,
  MINUS: 1 << 4,
  PLUS: 1 << 5,
  HOME: 1 << 6,
  UP: 1 << 7,
  DOWN: 1 << 8,
  LEFT: 1 << 9,
  RIGHT: 1 << 10,
};

// Held like the Wii Wheel, the remote's D-pad is rotated a quarter turn:
// pushing toward the sky presses the remote's RIGHT, and so on.
const SIDEWAYS_DPAD = { up: BUTTON.RIGHT, right: BUTTON.DOWN, down: BUTTON.LEFT, left: BUTTON.UP };

const PLAYER_COLORS = ['#e5322d', '#3b82f6', '#2fb86a', '#f5c518'];
const G = 9.80665;
const DEG = Math.PI / 180;

const $ = (sel) => document.querySelector(sel);

const state = {
  ws: null,
  slot: -1,
  buttons: 0,
  seq: 0,
  // Wii Remote frame: +X left, +Y toward the bottom (1/2 end), +Z out of the face.
  // Default = held upright like a wheel with no motion data yet.
  accel: [-1, 0, 0],
  gyro: [0, 0, 0],
  // iOS reports gravity with the opposite sign to the spec; confirmed at runtime.
  accelSign: /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent) ? -1 : 1,
  signVotes: 0,
  closedOnPurpose: false,
  notice: null,
  retryDelay: 500,
  wakeLock: null,
};

const playerId = (() => {
  let id = localStorage.getItem('pk-id');
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem('pk-id', id);
  }
  return id;
})();

// ---------- Joining ----------

$('#name').value = localStorage.getItem('pk-name') ?? '';

$('#start').addEventListener('click', async () => {
  const error = $('#join-error');
  error.hidden = true;
  localStorage.setItem('pk-name', $('#name').value.trim());

  if (!window.isSecureContext) {
    showJoinError('This page must be opened over https:// for motion controls. Scan the QR code on the laptop again.');
    return;
  }
  // iOS 13+: motion access needs an explicit permission prompt from a tap.
  // Without it you can still use the buttons (menus), just not steer.
  let motionOk = true;
  if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
    try {
      motionOk = (await DeviceMotionEvent.requestPermission()) === 'granted';
    } catch {
      motionOk = false;
    }
  }

  window.addEventListener('devicemotion', onMotion);
  $('#join').hidden = true;
  $('#pad').hidden = false;
  if (!motionOk) state.notice = 'Steering is off: motion access was denied. Close this tab and reopen the link to allow it.';
  updateOrientationOverlay();
  keepAwake();
  connect();
});

function showJoinError(text) {
  const error = $('#join-error');
  error.textContent = text;
  error.hidden = false;
}

// ---------- Connection ----------

function connect() {
  state.closedOnPurpose = false;
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.binaryType = 'arraybuffer';
  state.ws = ws;

  ws.addEventListener('open', () => {
    state.retryDelay = 500;
    ws.send(JSON.stringify({ t: 'hello', id: playerId, name: localStorage.getItem('pk-name') || '' }));
  });

  ws.addEventListener('message', (e) => {
    if (typeof e.data !== 'string') return;
    const msg = JSON.parse(e.data);
    if (msg.t === 'welcome') {
      state.slot = msg.slot;
      setPlayer(msg.slot, msg.name);
      banner(state.notice, 8000);
      sendInput();
    } else if (msg.t === 'full') {
      state.closedOnPurpose = true;
      banner('Game is full (4 players).');
    }
  });

  ws.addEventListener('close', (e) => {
    if (state.ws !== ws) return;
    state.slot = -1;
    if (e.code === 4000) {
      // Another tab on this phone took over.
      state.closedOnPurpose = true;
      banner('Controller opened somewhere else.');
      return;
    }
    if (state.closedOnPurpose) return;
    banner('Reconnecting…');
    setTimeout(connect, state.retryDelay);
    state.retryDelay = Math.min(state.retryDelay * 2, 5000);
  });
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || $('#pad').hidden) return;
  keepAwake();
  if (!state.ws || state.ws.readyState > WebSocket.OPEN) connect();
});

function setPlayer(slot, name) {
  const color = PLAYER_COLORS[slot] ?? PLAYER_COLORS[0];
  document.documentElement.style.setProperty('--player', color);
  document.querySelectorAll('#leds i').forEach((led, i) => led.classList.toggle('on', i === slot));
  $('#player-name').textContent = name;
}

let bannerTimer = 0;
/** Shows a message at the top; `fadeMs` hides it again (for one-off notices). */
function banner(text, fadeMs = 0) {
  const el = $('#banner');
  clearTimeout(bannerTimer);
  el.textContent = text ?? '';
  el.hidden = !text;
  if (text && fadeMs) bannerTimer = setTimeout(() => (el.hidden = true), fadeMs);
}

// ---------- Sending ----------

const packet = new ArrayBuffer(28);
const view = new DataView(packet);

function sendInput() {
  const ws = state.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN || state.slot < 0) return;
  // Don't let a stalled Wi-Fi link queue up stale motion.
  if (ws.bufferedAmount > 512) return;
  view.setUint16(0, state.buttons, true);
  view.setUint16(2, state.seq++ & 0xffff, true);
  state.accel.forEach((v, i) => view.setFloat32(4 + i * 4, v, true));
  state.gyro.forEach((v, i) => view.setFloat32(16 + i * 4, v, true));
  ws.send(packet);
}

// Keep Dolphin fed even if motion events pause (e.g. phone lying still on some devices).
setInterval(sendInput, 100);

// ---------- Motion ----------

function screenAngle() {
  if (typeof window.orientation === 'number') return window.orientation;
  return screen.orientation?.angle ?? 0;
}

/** Device-frame vector -> frame aligned with what the user sees (x right, y up, z toward user). */
function toScreen([x, y, z], angle) {
  const t = angle * DEG;
  const c = Math.cos(t);
  const s = Math.sin(t);
  return [x * c - y * s, x * s + y * c, z];
}

/**
 * Screen frame -> Wii Remote frame, for a remote held like the Wii Wheel
 * (pointer end to the left, buttons facing you): the remote's +X points
 * down the screen, +Y to the right, +Z toward you.
 */
const toWiimote = ([sx, sy, sz]) => [-sy, sx, sz];

function onMotion(e) {
  const a = e.accelerationIncludingGravity;
  if (a && a.x !== null) {
    const angle = screenAngle();
    const screenG = toScreen([a.x / G, a.y / G, a.z / G], angle).map((v) => v * state.accelSign);
    calibrateSign(screenG, angle);
    state.accel = toWiimote(screenG);
  }
  const r = e.rotationRate;
  if (r && r.alpha !== null) {
    // rotationRate: alpha about Z, beta about X, gamma about Y (deg/s).
    state.gyro = toWiimote(toScreen([r.beta, r.gamma, r.alpha], screenAngle()));
  }
  sendInput();
  drawWheel();
}

/**
 * The screen auto-rotates to keep "up" up, so while the phone is held like a
 * wheel, gravity's reaction should point up the screen. If it consistently
 * points down instead, this browser uses the opposite sign convention.
 */
function calibrateSign([sx, sy], angle) {
  if (Math.abs(state.signVotes) >= 30 || angle % 180 === 0) return;
  if (Math.abs(sy) < 0.6 || Math.abs(sx) > 0.5) return;
  state.signVotes += sy > 0 ? 1 : -1;
  if (state.signVotes <= -30) {
    state.accelSign *= -1;
    state.signVotes = 30;
  }
}

let wheelFrame = 0;
function drawWheel() {
  if (wheelFrame) return;
  wheelFrame = requestAnimationFrame(() => {
    wheelFrame = 0;
    const [wx, wy] = state.accel;
    const tilt = Math.atan2(-wy, -wx) / DEG;
    $('#wheel').style.transform = `rotate(${tilt.toFixed(1)}deg)`;
  });
}

// ---------- Orientation ----------

function updateOrientationOverlay() {
  const portrait = window.matchMedia('(orientation: portrait)').matches;
  $('#rotate').hidden = $('#pad').hidden || !portrait;
}
window.addEventListener('resize', updateOrientationOverlay);
window.addEventListener('orientationchange', updateOrientationOverlay);

async function keepAwake() {
  try {
    if ('wakeLock' in navigator && !state.wakeLock) {
      state.wakeLock = await navigator.wakeLock.request('screen');
      state.wakeLock.addEventListener('release', () => (state.wakeLock = null));
    }
  } catch {
    // Not supported; the phone may dim during long races.
  }
}

// ---------- Buttons ----------

const haptic = $('#haptic');
function tap() {
  if (navigator.vibrate) navigator.vibrate(8);
  else haptic.click();
}

/** Keep receiving a touch's events even if the thumb slides off the button. */
function capture(el, pointerId) {
  try {
    el.setPointerCapture(pointerId);
  } catch {
    // Pointer already gone; the press still counts.
  }
}

function setButton(bit, down) {
  const next = down ? state.buttons | bit : state.buttons & ~bit;
  if (next === state.buttons) return;
  if (down) tap();
  state.buttons = next;
  sendInput();
}

for (const el of document.querySelectorAll('[data-btn]')) {
  const bit = BUTTON[el.dataset.btn];
  const active = new Set();
  const release = (e) => {
    active.delete(e.pointerId);
    if (active.size === 0) {
      el.classList.remove('pressed');
      setButton(bit, false);
    }
  };
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    capture(el, e.pointerId);
    active.add(e.pointerId);
    el.classList.add('pressed');
    setButton(bit, true);
  });
  el.addEventListener('pointerup', release);
  el.addEventListener('pointercancel', release);
  el.addEventListener('lostpointercapture', release);
}

// D-pad: direction follows the thumb so you can roll between arrows.
const dpad = $('#dpad');
const dpadPointers = new Map();
function dpadDirection(e) {
  const rect = dpad.getBoundingClientRect();
  const dx = e.clientX - (rect.left + rect.width / 2);
  const dy = e.clientY - (rect.top + rect.height / 2);
  if (Math.hypot(dx, dy) < Math.min(rect.width, rect.height) * 0.12) return null;
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 'right' : 'left';
  return dy > 0 ? 'down' : 'up';
}
function updateDpad() {
  const dirs = new Set(dpadPointers.values());
  let bits = 0;
  for (const dir of ['up', 'right', 'down', 'left']) {
    const on = dirs.has(dir);
    dpad.querySelector(`.${dir}`).classList.toggle('on', on);
    if (on) bits |= SIDEWAYS_DPAD[dir];
  }
  dpad.classList.toggle('pressed', bits !== 0);
  const mask = BUTTON.UP | BUTTON.DOWN | BUTTON.LEFT | BUTTON.RIGHT;
  const next = (state.buttons & ~mask) | bits;
  if (next !== state.buttons) {
    if ((bits & ~state.buttons) !== 0) tap();
    state.buttons = next;
    sendInput();
  }
}
dpad.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  capture(dpad, e.pointerId);
  dpadPointers.set(e.pointerId, dpadDirection(e));
  updateDpad();
});
dpad.addEventListener('pointermove', (e) => {
  if (!dpadPointers.has(e.pointerId)) return;
  dpadPointers.set(e.pointerId, dpadDirection(e));
  updateDpad();
});
for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
  dpad.addEventListener(type, (e) => {
    dpadPointers.delete(e.pointerId);
    updateDpad();
  });
}

// No scrolling, zooming or text selection while playing.
for (const type of ['touchstart', 'touchmove']) {
  document.addEventListener(type, (e) => {
    if (!$('#pad').hidden) e.preventDefault();
  }, { passive: false });
}
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('contextmenu', (e) => e.preventDefault());
