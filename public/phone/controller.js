// Phone-side Wii Remote: reads touch + motion, streams it to the laptop.

import { fx, unlockAudio, getPrefs, setPref } from './feedback.js';

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

const PLAYER_COLORS = ['#e5322d', '#3b82f6', '#2fb86a', '#f5c518'];
const G = 9.80665;
const DEG = Math.PI / 180;
// A flick this far past 1g (in any direction) counts as a trick.
const TRICK_G = 1.6;

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
  // Some browsers (historically iOS Safari) report gravity with the opposite
  // sign to the spec. Guessed from the browser, then confirmed at runtime
  // and remembered for this phone.
  accelSign: Number(localStorage.getItem('pk-accel-sign')) || (/iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent) ? -1 : 1),
  signConfirmed: localStorage.getItem('pk-accel-sign') !== null,
  signVotes: 0,
  backwardsSince: 0,
  lastTrick: 0,
  wasConnected: false,
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
$('#opt-sound').checked = getPrefs().sound;
$('#opt-rumble').checked = getPrefs().rumble;
$('#opt-sound').addEventListener('change', (e) => setPref('sound', e.target.checked));
$('#opt-rumble').addEventListener('change', (e) => setPref('rumble', e.target.checked));

$('#start').addEventListener('click', async () => {
  // iOS only lets audio start from inside a tap, so do this before any await.
  unlockAudio();
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
  layoutRemote();
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
      state.wasConnected = true;
      fx.connected();
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
    if (state.wasConnected) fx.disconnected();
    state.wasConnected = false;
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
function banner(text, fadeMs = 0, kind = '') {
  const el = $('#banner');
  clearTimeout(bannerTimer);
  el.dataset.kind = kind;
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

// ---------- Layout ----------

const remote = $('#remote');

function screenAngle() {
  if (typeof window.orientation === 'number') return window.orientation;
  return screen.orientation?.angle ?? 0;
}

/**
 * Keep the remote glued to the phone's hardware. When the browser rotates
 * the page (e.g. mid-turn while racing), rotate the remote back the other
 * way so nothing moves under your thumbs.
 */
function layoutRemote() {
  const angle = screenAngle();
  const sideways = angle % 180 !== 0;
  const w = sideways ? innerHeight : innerWidth;
  const h = sideways ? innerWidth : innerHeight;
  remote.style.width = `${w}px`;
  remote.style.height = `${h}px`;
  remote.style.rotate = `${-angle}deg`;
  remote.dataset.angle = String(angle);
}
window.addEventListener('resize', layoutRemote);
window.addEventListener('orientationchange', layoutRemote);
screen.orientation?.addEventListener?.('change', layoutRemote);

// ---------- Motion ----------

/**
 * Phone frame -> Wii Remote frame. The phone is the remote: its top edge is
 * the remote's pointer end, the screen is the button face. Phone axes are
 * +x right, +y toward the top, +z out of the screen; Dolphin's remote axes
 * are +X left, +Y toward the 1/2 end, +Z out of the face.
 * No dependence on screen rotation, so steering can't jump when iOS rotates.
 */
const toWiimote = ([x, y, z]) => [-x, -y, z];

function onMotion(e) {
  const a = e.accelerationIncludingGravity;
  if (a && a.x !== null) {
    const raw = [a.x / G, a.y / G, a.z / G];
    calibrateSign(raw);
    state.accel = toWiimote(raw.map((v) => v * state.accelSign));
    checkGrip();
    detectTrick(raw);
  }
  const r = e.rotationRate;
  if (r && r.alpha !== null) {
    // rotationRate: alpha about z, beta about x, gamma about y (deg/s).
    state.gyro = toWiimote([r.beta, r.gamma, r.alpha]);
  }
  sendInput();
  drawWheel();
}

/**
 * Works out the browser's gravity sign convention. Whenever the page is
 * upright on screen (auto-rotated, or portrait while held upright), "up" on
 * screen is physically up, and per the spec gravity's reaction points that
 * way. Readings that consistently point the other way mean an inverted
 * convention. Held sideways with Rotation Lock on, "up" on screen is
 * horizontal, so those readings are ignored.
 */
function calibrateSign([x, y]) {
  if (state.signConfirmed) return;
  const t = screenAngle() * DEG;
  // Screen-up expressed in phone coordinates.
  const ux = Math.sin(t);
  const uy = Math.cos(t);
  const along = x * ux + y * uy;
  const across = x * uy - y * ux;
  if (Math.abs(along) < 0.6 || Math.abs(across) > 0.5) return;
  const vote = Math.sign(along) * state.accelSign;
  state.signVotes += vote;
  if (state.signVotes <= -30 || state.signVotes >= 30) {
    if (state.signVotes < 0) state.accelSign *= -1;
    state.signConfirmed = true;
    try {
      localStorage.setItem('pk-accel-sign', String(state.accelSign));
    } catch {
      // Private mode; we'll just recalibrate next time.
    }
  }
}

/** Nudge players holding the phone the wrong way round (D-pad on the right). */
function checkGrip() {
  // Correct grip: the remote's +X (left side) points at the floor, so X ≈ -1g.
  // Only trust this once we know the browser's sign convention.
  const backwards = state.signConfirmed && state.accel[0] > 0.75;
  const now = performance.now();
  if (!backwards) {
    if (state.backwardsSince && $('#banner').dataset.kind === 'grip') banner(null);
    state.backwardsSince = 0;
    return;
  }
  if (!state.backwardsSince) state.backwardsSince = now;
  else if (now - state.backwardsSince > 1200 && $('#banner').hidden) banner('Turn your phone around: D-pad on the left', 0, 'grip');
}

/** A sharp flick (trick / wheelie in Mario Kart) gets a whoosh and a bump. */
function detectTrick([x, y, z]) {
  const now = performance.now();
  if (now - state.lastTrick < 700) return;
  if (Math.abs(Math.hypot(x, y, z) - 1) > TRICK_G) {
    state.lastTrick = now;
    fx.trick();
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
  if (down) (bit === BUTTON.HOME ? fx.home : fx.press)();
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

// D-pad: whichever arm is under the thumb, so you can roll between arrows.
// Hit-testing by element works through the remote's rotation.
const dpad = $('#dpad');
const dpadPointers = new Map();
function dpadDirection(e) {
  const el = document.elementFromPoint(e.clientX, e.clientY);
  return el?.closest?.('#dpad .arm')?.dataset.dir ?? null;
}
function updateDpad() {
  const dirs = new Set(dpadPointers.values());
  let bits = 0;
  for (const arm of dpad.querySelectorAll('.arm')) {
    const on = dirs.has(arm.dataset.dir);
    arm.classList.toggle('on', on);
    if (on) bits |= BUTTON[arm.dataset.dir];
  }
  const mask = BUTTON.UP | BUTTON.DOWN | BUTTON.LEFT | BUTTON.RIGHT;
  const next = (state.buttons & ~mask) | bits;
  if (next !== state.buttons) {
    if ((bits & ~state.buttons) !== 0) fx.item();
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

// Tap the speaker grille to mute / unmute, like turning down the remote speaker.
$('#speaker').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  unlockAudio();
  const on = !getPrefs().sound;
  setPref('sound', on);
  $('#opt-sound').checked = on;
  if (on) fx.soundOn();
  banner(on ? 'Sound on' : 'Sound off (tap the speaker to turn it back on)', 1800);
});

// Resume audio whenever a finger lifts: touchend is a gesture iOS accepts
// for starting audio, and audio may have been paused by the motion prompt.
document.addEventListener('touchend', unlockAudio, { passive: true });
document.addEventListener('pointerup', unlockAudio);

// No scrolling, zooming or text selection while playing.
for (const type of ['touchstart', 'touchmove']) {
  document.addEventListener(type, (e) => {
    if (!$('#pad').hidden) e.preventDefault();
  }, { passive: false });
}
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('contextmenu', (e) => e.preventDefault());
