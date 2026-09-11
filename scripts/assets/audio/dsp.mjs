// Synthesis primitives for the placeholder sound set (`scripts/assets/audio/`).
// Everything is a pure function of its inputs and a seed, so a rebuild writes
// the same samples. 48 kHz float32 throughout; a stereo signal is `[left, right]`.

export const SR = 48000;
export const TAU = Math.PI * 2;

/** mulberry32: a rebuild draws the same noise. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const mtof = (midi) => 440 * 2 ** ((midi - 69) / 12);
export const samples = (seconds) => Math.round(seconds * SR);
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const dbToGain = (db) => 10 ** (db / 20);
export const stereo = (n) => [new Float32Array(n), new Float32Array(n)];

/** A frequency with a whole number of cycles in the loop, so a drone meets itself at the seam. */
export const snap = (freq, loopSeconds) => Math.max(1, Math.round(freq * loopSeconds)) / loopSeconds;

/** Equal-power pan, -1 (left) … 1 (right). */
export function panGains(pan) {
  const a = ((clamp(pan, -1, 1) + 1) * Math.PI) / 4;
  return [Math.cos(a), Math.sin(a)];
}

// ---------------------------------------------------------------- oscillators

function blep(t, dt) {
  if (t < dt) {
    const x = t / dt;
    return x + x - x * x - 1;
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt;
    return x * x + x + x + 1;
  }
  return 0;
}

/** A band-limited (polyBLEP) oscillator, advanced once per call at `freq` Hz. */
export function osc(shape, phase = 0) {
  let p = phase;
  return (freq) => {
    const dt = clamp(freq / SR, 0, 0.5);
    let y;
    if (shape === 'sine') y = Math.sin(TAU * p);
    else if (shape === 'saw') y = 2 * p - 1 - blep(p, dt);
    else if (shape === 'square') y = (p < 0.5 ? 1 : -1) + blep(p, dt) - blep((p + 0.5) % 1, dt);
    else y = 1 - 4 * Math.abs(p - 0.5); // triangle
    p += dt;
    p -= Math.floor(p);
    return y;
  };
}

/** White noise in -1..1 from a seed. */
export function noise(seed) {
  const r = rng(seed);
  return () => r() * 2 - 1;
}

/** A noise table read cyclically: filtered noise that repeats exactly every `n` samples. */
export function noiseTable(n, seed) {
  const r = rng(seed);
  const table = new Float32Array(n);
  for (let i = 0; i < n; i++) table[i] = r() * 2 - 1;
  return table;
}

// -------------------------------------------------------------------- filters

/** Zavalishin's TPT state-variable filter — stays stable while its cutoff moves every sample. */
export function svf(mode = 'lp') {
  let ic1 = 0;
  let ic2 = 0;
  return (x, cutoff, q = 0.707) => {
    const g = Math.tan((Math.PI * clamp(cutoff, 10, SR * 0.45)) / SR);
    const k = 1 / q;
    const a1 = 1 / (1 + g * (g + k));
    const a2 = g * a1;
    const a3 = g * a2;
    const v3 = x - ic2;
    const v1 = a1 * ic1 + a2 * v3;
    const v2 = ic2 + a2 * ic1 + a3 * v3;
    ic1 = 2 * v1 - ic1;
    ic2 = 2 * v2 - ic2;
    if (mode === 'lp') return v2;
    if (mode === 'bp') return v1;
    return x - k * v1 - v2; // hp
  };
}

export function onePole(mode = 'lp') {
  let z = 0;
  return (x, cutoff) => {
    const a = Math.exp((-TAU * cutoff) / SR);
    z = x + a * (z - x);
    return mode === 'lp' ? z : x - z;
  };
}

// ------------------------------------------------------------------ envelopes

/** ADSR level `t` s after note-on for a note held `gate` s; the release is slightly curved. */
export function adsr(t, gate, a, d, s, r) {
  const held = (u) => (u < a ? u / a : u < a + d ? 1 - (1 - s) * ((u - a) / d) : s);
  if (t < gate) return held(t);
  const u = (t - gate) / r;
  return u >= 1 ? 0 : held(gate) * (1 - u) * (1 - u);
}

export const decay = (t, tau) => Math.exp(-t / tau);

/** tanh drive, normalised so a full-scale input still peaks at 1. */
export const soft = (x, drive = 1) => Math.tanh(x * drive) / Math.tanh(drive);

// -------------------------------------------------------------------- effects

const COMB_TUNING = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
const ALLPASS_TUNING = [556, 441, 341, 225];

function freeverbChannel(input, spread, room, damp) {
  const scale = SR / 44100;
  const combs = COMB_TUNING.map((len) => ({ buf: new Float32Array(Math.round((len + spread) * scale)), i: 0, store: 0 }));
  const alls = ALLPASS_TUNING.map((len) => ({ buf: new Float32Array(Math.round((len + spread) * scale)), i: 0 }));
  const feedback = room * 0.28 + 0.7;
  const d = damp * 0.4;
  const out = new Float32Array(input.length);
  for (let n = 0; n < input.length; n++) {
    const x = input[n] * 0.015;
    let y = 0;
    for (const c of combs) {
      const o = c.buf[c.i];
      c.store = o * (1 - d) + c.store * d;
      c.buf[c.i] = x + c.store * feedback;
      if (++c.i >= c.buf.length) c.i = 0;
      y += o;
    }
    for (const a of alls) {
      const o = a.buf[a.i];
      a.buf[a.i] = y + o * 0.5;
      if (++a.i >= a.buf.length) a.i = 0;
      y = o - y;
    }
    out[n] = y;
  }
  return out;
}

/** Freeverb over a stereo send; returns only the wet pair (roughly unity gain). */
export function reverb([l, r], { room = 0.8, damp = 0.3 } = {}) {
  const mono = new Float32Array(l.length);
  for (let i = 0; i < l.length; i++) mono[i] = (l[i] + r[i]) * 0.5;
  const wetL = freeverbChannel(mono, 0, room, damp);
  const wetR = freeverbChannel(mono, 23, room, damp);
  for (let i = 0; i < mono.length; i++) {
    wetL[i] *= 3;
    wetR[i] *= 3;
  }
  return [wetL, wetR];
}

/** A ping-pong feedback delay over a stereo send; returns only the wet pair. */
export function pingPong([l, r], seconds, feedback, tone = 3500) {
  const n = l.length;
  const d = samples(seconds);
  const lineL = new Float32Array(n);
  const lineR = new Float32Array(n);
  const outL = new Float32Array(n);
  const outR = new Float32Array(n);
  const lpL = onePole();
  const lpR = onePole();
  for (let i = 0; i < n; i++) {
    const dl = i >= d ? lineL[i - d] : 0;
    const dr = i >= d ? lineR[i - d] : 0;
    lineL[i] = lpL((l[i] + r[i]) * 0.5 + feedback * dr, tone);
    lineR[i] = lpR(feedback * dl, tone);
    outL[i] = dl;
    outR[i] = dr;
  }
  return [outL, outR];
}

// ------------------------------------------------------------------ finishing

export function peakOf(channels) {
  let peak = 0;
  for (const c of channels) for (let i = 0; i < c.length; i++) peak = Math.max(peak, Math.abs(c[i]));
  return peak;
}

export function rmsOf(channels) {
  let sum = 0;
  let count = 0;
  for (const c of channels) {
    for (let i = 0; i < c.length; i++) sum += c[i] * c[i];
    count += c.length;
  }
  return Math.sqrt(sum / Math.max(1, count));
}

/** Scales every channel by one factor so the loudest sample sits at `peakDb`. */
export function normalizePeak(channels, peakDb = -1) {
  const peak = peakOf(channels);
  if (peak === 0) return channels;
  const g = dbToGain(peakDb) / peak;
  for (const c of channels) for (let i = 0; i < c.length; i++) c[i] *= g;
  return channels;
}

/**
 * Brings a mix to `rmsDb`, then rounds off whatever now pokes above the ceiling
 * with a tanh knee — a gentle limiter, so a loud hit does not set the level of
 * the whole track.
 */
export function master(channels, rmsDb, ceilingDb = -1) {
  const g = dbToGain(rmsDb) / Math.max(1e-9, rmsOf(channels));
  const ceiling = dbToGain(ceilingDb);
  const knee = ceiling * 0.7;
  for (const c of channels) {
    for (let i = 0; i < c.length; i++) {
      const x = c[i] * g;
      const ax = Math.abs(x);
      c[i] = ax <= knee ? x : Math.sign(x) * (knee + (ceiling - knee) * Math.tanh((ax - knee) / (ceiling - knee)));
    }
  }
  return channels;
}

/** Short fades at both ends, so a one-shot never starts or stops on a click. */
export function fadeEdges(x, inMs = 1.5, outMs = 12) {
  const a = Math.min(samples(inMs / 1000), x.length);
  const b = Math.min(samples(outMs / 1000), x.length);
  for (let i = 0; i < a; i++) x[i] *= i / a;
  for (let i = 0; i < b; i++) x[x.length - 1 - i] *= i / b;
  return x;
}
