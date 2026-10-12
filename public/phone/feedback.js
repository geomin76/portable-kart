// Wii Remote-style feedback on the phone: rumble and little speaker sounds.
//
// Dolphin's DSU link only carries input, so these can't come from the game
// itself. Instead we play the moments a real remote would: the rumble +
// chime when it connects, button ticks, an item buzz, a trick whoosh, and
// the Home button sound. Sounds go through a band-limited, slightly
// overdriven chain so they sound like the remote's tiny speaker.

const prefs = {
  sound: localStorage.getItem('pk-sound') !== 'off',
  rumble: localStorage.getItem('pk-rumble') !== 'off',
};

export function getPrefs() {
  return { ...prefs };
}

export function setPref(key, on) {
  prefs[key] = on;
  try {
    localStorage.setItem(`pk-${key}`, on ? 'on' : 'off');
  } catch {
    // Private mode; the choice lasts for this visit.
  }
}

// ---------- Rumble ----------

// iPhone Safari has no vibration API. Toggling a <input switch> plays the
// system's light haptic tap (Safari 17.4+), so "rumble" there is a quick
// series of taps. Android gets real vibration.
const hapticLabel = document.querySelector('#haptic');
const canVibrate = typeof navigator.vibrate === 'function';
let rumbleTimers = [];

function hapticTap() {
  hapticLabel?.click();
}

/** pattern: [on ms, off ms, on ms, ...] like navigator.vibrate. */
export function rumble(pattern) {
  if (!prefs.rumble) return;
  const steps = typeof pattern === 'number' ? [pattern] : pattern;
  if (canVibrate) {
    navigator.vibrate(steps);
    return;
  }
  rumbleTimers.forEach(clearTimeout);
  rumbleTimers = [];
  let t = 0;
  steps.forEach((ms, i) => {
    if (i % 2 === 0) {
      // One tap per ~40 ms of "on" time, at least one.
      for (let k = 0; k < Math.max(1, Math.round(ms / 40)); k++) {
        if (t === 0 && k === 0) hapticTap();
        else rumbleTimers.push(setTimeout(hapticTap, t + k * 40));
      }
    }
    t += ms;
  });
}

// ---------- Sound ----------

let ctx = null;
let out = null;

/**
 * Must be called from a tap (iOS only allows audio to start from a user
 * gesture). On iPhone that means a `click` or `touchend`; touch-down events
 * don't count. iOS also pauses audio when a system prompt (like the motion
 * permission dialog) appears, so this is safe to call on every tap.
 */
export function unlockAudio() {
  if (ctx && ctx.state === 'running') return;
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    // The Wii Remote speaker: small, bright, a bit crunchy.
    const highpass = new BiquadFilterNode(ctx, { type: 'highpass', frequency: 500, Q: 0.7 });
    const lowpass = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 5200, Q: 0.9 });
    const drive = new WaveShaperNode(ctx, { curve: driveCurve(2.2) });
    const volume = new GainNode(ctx, { gain: 0.5 });
    highpass.connect(lowpass).connect(drive).connect(volume).connect(ctx.destination);
    out = highpass;
  }
  if (ctx.state === 'suspended') ctx.resume();
  // Playing a silent buffer inside the gesture fully unlocks iOS audio.
  const silent = ctx.createBufferSource();
  silent.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
  silent.connect(ctx.destination);
  silent.start();
}

function driveCurve(amount) {
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(amount * x) / Math.tanh(amount);
  }
  return curve;
}

function ready() {
  return prefs.sound && ctx && ctx.state === 'running';
}

/** A short enveloped tone. */
function tone(freq, start, duration, { type = 'sine', gain = 0.35, endFreq } = {}) {
  const t0 = ctx.currentTime + start;
  const osc = new OscillatorNode(ctx, { type, frequency: freq });
  if (endFreq) osc.frequency.exponentialRampToValueAtTime(endFreq, t0 + duration);
  const env = new GainNode(ctx, { gain: 0 });
  env.gain.setValueAtTime(0, t0);
  env.gain.linearRampToValueAtTime(gain, t0 + 0.006);
  env.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  osc.connect(env).connect(out);
  osc.start(t0);
  osc.stop(t0 + duration + 0.02);
}

/** A burst of filtered noise (whooshes, clicks). */
function noise(start, duration, { from = 800, to = 3000, gain = 0.3, q = 1.2 } = {}) {
  const t0 = ctx.currentTime + start;
  const len = Math.ceil(ctx.sampleRate * duration);
  const buffer = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  const src = new AudioBufferSourceNode(ctx, { buffer });
  const band = new BiquadFilterNode(ctx, { type: 'bandpass', frequency: from, Q: q });
  band.frequency.exponentialRampToValueAtTime(to, t0 + duration);
  const env = new GainNode(ctx, { gain: 0 });
  env.gain.setValueAtTime(0, t0);
  env.gain.linearRampToValueAtTime(gain, t0 + duration * 0.3);
  env.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  src.connect(band).connect(env).connect(out);
  src.start(t0);
}

// ---------- The moments a real remote reacts to ----------

export const fx = {
  /** Remote syncs: the classic rumble pulse and a bright little chime. */
  connected() {
    rumble([220]);
    if (!ready()) return;
    tone(1318.5, 0, 0.12, { type: 'triangle', gain: 0.3 });
    tone(1975.5, 0.09, 0.28, { type: 'triangle', gain: 0.3 });
  },

  disconnected() {
    rumble([60, 60, 60]);
    if (!ready()) return;
    tone(987.8, 0, 0.12, { type: 'triangle', gain: 0.25 });
    tone(659.3, 0.1, 0.22, { type: 'triangle', gain: 0.25 });
  },

  /** Any face button: a light tick, like the click under your thumb. */
  press() {
    rumble(12);
    if (!ready()) return;
    noise(0, 0.025, { from: 3500, to: 2500, gain: 0.12, q: 4 });
  },

  /** D-pad (use item): a short buzz and a pop. */
  item() {
    rumble([45]);
    if (!ready()) return;
    tone(520, 0, 0.09, { type: 'square', gain: 0.12, endFreq: 1040 });
  },

  /** Flick (trick / wheelie): whoosh + bump. */
  trick() {
    rumble([70]);
    if (!ready()) return;
    noise(0, 0.32, { from: 600, to: 4200, gain: 0.35, q: 0.9 });
  },

  /** Home button: the Wii's two-note Home menu cue. */
  home() {
    rumble(25);
    if (!ready()) return;
    tone(1568, 0, 0.09, { type: 'sine', gain: 0.32 });
    tone(2093, 0.07, 0.2, { type: 'sine', gain: 0.32 });
  },

  /** Preview played when sound is switched on. */
  soundOn() {
    if (!ready()) return;
    tone(1046.5, 0, 0.1, { type: 'triangle', gain: 0.25 });
    tone(1568, 0.08, 0.16, { type: 'triangle', gain: 0.25 });
  },
};
