// The seven placeholder music loops (SPEC-006 §2.3), one per `MusicId`.
//
// A track is a tempo, a length in bars and a list of parts; a part is either an
// instrument playing notes or a continuous bed. Every loop is rendered twice
// back to back and the second pass is kept: it already carries the first
// pass's release tails, reverb and echoes, so the loop's end flows into its
// start. Tempos are chosen so a sixteenth is a whole number of samples, and a
// bed's frequencies are snapped to whole cycles per loop, so the seam is exact.
import {
  SR,
  TAU,
  adsr,
  clamp,
  decay,
  master,
  mtof,
  noise,
  noiseTable,
  osc,
  panGains,
  pingPong,
  reverb,
  rng,
  samples,
  snap,
  soft,
  stereo,
  svf,
} from './dsp.mjs';

const ramp = (t, seconds) => Math.min(1, t / seconds);

// ----------------------------------------------------------------- notation

const PITCH = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** `'Bb2'` → 46 (C4 = 60). */
function m(name) {
  const match = /^([A-G])(#|b)?(-?\d)$/.exec(name);
  if (match === null) throw new Error(`bad note "${name}"`);
  return 12 * (Number(match[3]) + 1) + PITCH[match[1]] + (match[2] === '#' ? 1 : match[2] === 'b' ? -1 : 0);
}

const ch = (names) => names.split(' ').map(m);
const pick = (r, list) => list[Math.floor(r() * list.length)];

/** Chords held `beats` each, back to back from beat 0. */
const held = (chords, beats, vel = 1) => chords.map((pitch, k) => ({ beat: k * beats, len: beats, pitch, vel }));

/** A melody from `[note, beats]` rows, starting at `start`. */
function line(start, rows, vel = 0.8) {
  let at = start;
  return rows.map(([name, len]) => {
    const note = { beat: at, len: len - 0.1, pitch: m(name), vel };
    at += len;
    return note;
  });
}

/** Seeded sparse notes on a grid — the same sprinkle on every rebuild. */
function sprinkle(seed, { beats, step, prob, vel: [lo, hi], len, pool }) {
  const r = rng(seed);
  const out = [];
  for (let beat = 0; beat < beats; beat += step) {
    if (r() < prob) out.push({ beat, len, pitch: pool(beat, r), vel: lo + (hi - lo) * r(), pan: r() - 0.5 });
  }
  return out;
}

// -------------------------------------------------------------- instruments
// `(note, opts) => Float32Array | [left, right]`; `note.lenS` is the gate in seconds.

const INSTRUMENTS = {
  /** Two detuned saws per side through a lowpass that opens with the envelope. */
  pad({ lenS, midi, vel }, { attack = 0.6, release = 1.6, cutoff = 1600, q = 0.8 } = {}) {
    const n = samples(lenS + release);
    const f = mtof(midi);
    const out = stereo(n);
    const sides = [
      [osc('saw', 0.11), osc('saw', 0.62), 2 ** (-7 / 1200), 2 ** (5 / 1200)],
      [osc('saw', 0.37), osc('saw', 0.83), 2 ** (6 / 1200), 2 ** (-4 / 1200)],
    ];
    for (let s = 0; s < 2; s++) {
      const [a, b, da, db] = sides[s];
      const lp = svf();
      const c = out[s];
      for (let i = 0; i < n; i++) {
        const t = i / SR;
        const e = adsr(t, lenS, attack, 1, 0.8, release);
        c[i] = lp(a(f * da) + b(f * db), cutoff * (0.5 + 0.5 * e), q) * e * vel * 0.35;
      }
    }
    return out;
  },
  /** FM electric piano: a bright attack that mellows, and a faint tine. */
  keys({ lenS, midi, vel }) {
    const n = samples(lenS + 0.9);
    const f = mtof(midi);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const e = adsr(t, lenS, 0.003, 1.5, 0.25, 0.8);
      const index = 0.4 + 1.6 * decay(t, 0.35);
      const tine = 0.12 * Math.sin(TAU * f * 13.9 * t) * decay(t, 0.04);
      out[i] = (Math.sin(TAU * f * t + index * Math.sin(TAU * f * t)) + tine) * e * vel * 0.35;
    }
    return out;
  },
  pluck({ lenS, midi, vel }, { bright = 2800, tau = 0.3 } = {}) {
    const n = samples(lenS + 0.5);
    const f = mtof(midi);
    const a = osc('saw');
    const b = osc('square', 0.25);
    const lp = svf();
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const gate = t < lenS ? 1 : decay(t - lenS, 0.08);
      out[i] = lp(a(f) + 0.35 * b(2 * f), 180 + bright * decay(t, 0.14), 1.3) * decay(t, tau) * ramp(t, 0.002) * gate * vel * 0.4;
    }
    return out;
  },
  bell({ lenS, midi, vel }, { tau = 1.6, ratio = 3.5, index = 2 } = {}) {
    const n = samples(Math.max(lenS, tau * 5));
    const f = mtof(midi);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const mod = index * decay(t, tau * 0.25) * Math.sin(TAU * f * ratio * t);
      out[i] = Math.sin(TAU * f * t + mod) * decay(t, tau) * ramp(t, 0.002) * vel * 0.3;
    }
    return out;
  },
  bass({ lenS, midi, vel }, { cutoff = 500, sweep = 1400, q = 1.1, drive = 1 } = {}) {
    const n = samples(lenS + 0.06);
    const f = mtof(midi);
    const a = osc('saw');
    const sub = osc('sine');
    const lp = svf();
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const e = adsr(t, lenS, 0.003, 0.25, 0.75, 0.05);
      out[i] = soft((lp(a(f), cutoff + sweep * decay(t, 0.09), q) * 0.7 + 0.55 * sub(f)) * drive, drive) * e * vel * 0.6;
    }
    return out;
  },
  lead({ lenS, midi, vel }) {
    const n = samples(lenS + 0.3);
    const f = mtof(midi);
    const a = osc('square', 0.1);
    const b = osc('saw', 0.6);
    const lp = svf();
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const vib = 1 + 0.006 * Math.sin(TAU * 5.5 * t) * clamp((t - 0.2) / 0.3, 0, 1);
      const e = adsr(t, lenS, 0.012, 0.15, 0.7, 0.25);
      out[i] = lp(0.5 * a(f * vib) + 0.5 * b(f * vib * 1.004), 1800 + 1600 * decay(t, 0.25), 1.1) * e * vel * 0.45;
    }
    return out;
  },
  /** Brass-ish: three saws and a filter that snaps shut. */
  stab({ lenS, midi, vel }) {
    const n = samples(lenS + 0.2);
    const f = mtof(midi);
    const voices = [osc('saw', 0.1), osc('saw', 0.4), osc('saw', 0.7)];
    const detune = [1, 1.006, 0.994];
    const lp = svf();
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      let y = 0;
      for (let k = 0; k < 3; k++) y += voices[k](f * detune[k]);
      out[i] = lp(y / 3, 400 + 3200 * decay(t, 0.12), 1.4) * adsr(t, lenS, 0.004, 0.15, 0.55, 0.15) * vel * 0.45;
    }
    return out;
  },
  /** Saws through the three formants of "ah". */
  choir({ lenS, midi, vel }) {
    const n = samples(lenS + 1.2);
    const f = mtof(midi);
    const a = osc('saw', 0.2);
    const b = osc('saw', 0.7);
    const f1 = svf('bp');
    const f2 = svf('bp');
    const f3 = svf('bp');
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const vib = 1 + 0.004 * Math.sin(TAU * 5 * t + midi);
      const src = a(f * vib) + b(f * vib * 1.005);
      const y = f1(src, 730, 6) + 0.6 * f2(src, 1090, 7) + 0.25 * f3(src, 2440, 8);
      out[i] = y * adsr(t, lenS, 0.5, 0.5, 0.85, 1.2) * vel * 0.5;
    }
    return out;
  },
  kick({ vel, seed }) {
    const n = samples(0.42);
    const s = osc('sine');
    const nz = noise(seed);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      out[i] = soft(s(44 + 120 * decay(t, 0.028)) * decay(t, 0.25) * 1.3 + 0.2 * nz() * decay(t, 0.003), 1.3) * ramp(t, 0.0008) * vel;
    }
    return out;
  },
  snare({ vel, seed }) {
    const n = samples(0.32);
    const nz = noise(seed);
    const bp = svf('bp');
    const hp = svf('hp');
    const s = osc('sine');
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const x = nz();
      const body = bp(x, 1900, 0.9) * decay(t, 0.12) * 1.1 + hp(x, 5500) * decay(t, 0.08) * 0.45;
      out[i] = (body + s(185 + 60 * decay(t, 0.02)) * decay(t, 0.05) * 0.6) * ramp(t, 0.0008) * vel;
    }
    return out;
  },
  /** `tau` 0.025 is closed, 0.12 open, 0.5 a crash. */
  hat({ vel, seed }, { tau = 0.025 } = {}) {
    const n = samples(tau * 6 + 0.01);
    const nz = noise(seed);
    const hp = svf('hp');
    const bp = svf('bp');
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const x = nz();
      out[i] = (hp(x, 7800) * 0.7 + bp(x, 10500, 3) * 0.3) * decay(t, tau) * ramp(t, 0.0005) * vel;
    }
    return out;
  },
  tom({ midi, vel }) {
    const n = samples(0.55);
    const f = mtof(midi);
    const s = osc('sine');
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      out[i] = soft(s(f * (1 + 0.6 * decay(t, 0.04))) * decay(t, 0.2) * 1.2, 1.2) * ramp(t, 0.001) * vel;
    }
    return out;
  },
  /** Noise swelling up through a rising bandpass; cut on the downbeat. */
  riser({ lenS, vel, seed }) {
    const n = samples(lenS);
    const nz = noise(seed);
    const bp = svf('bp');
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const u = i / n;
      out[i] = bp(nz(), 400 + 6000 * u * u, 1.5) * u * u * vel;
    }
    return out;
  },
};

// --------------------------------------------------------------------- beds
// `(N, L) => [left, right]` over two passes of an `L`-second loop.

/** Detuned saws on held notes under a slowly breathing lowpass, plus a sub an octave down. */
function drone(midis, { cutoff = [250, 800], cycles = 1, cents = 6 } = {}) {
  return (N, L) => {
    const out = stereo(N);
    for (let side = 0; side < 2; side++) {
      const voices = midis.map((midi, k) => ({
        o: osc('saw', (k * 0.37 + side * 0.5) % 1),
        f: snap(mtof(midi) * 2 ** (((side === 0 ? -1 : 1) * cents) / 1200), L),
      }));
      const sub = osc('sine', side * 0.25);
      const subF = snap(mtof(midis[0]) / 2, L);
      const lp = svf();
      const c = out[side];
      for (let i = 0; i < N; i++) {
        const t = i / SR;
        const cut = cutoff[0] + (cutoff[1] - cutoff[0]) * (0.5 - 0.5 * Math.cos((TAU * cycles * t) / L + side * 0.6));
        let y = 0;
        for (const v of voices) y += v.o(v.f);
        c[i] = lp(y / midis.length, cut, 0.9) * 0.6 + sub(subF) * 0.25;
      }
    }
    return out;
  };
}

/** Bandpassed noise that swells and moves: air, wind, a room that is not quite empty. */
function wind({ band = [300, 1500], cycles = 2, q = 1.4 } = {}) {
  return (N, L) => {
    const n = N / 2;
    const out = stereo(N);
    for (let side = 0; side < 2; side++) {
      const table = noiseTable(n, 71 + side);
      const bp = svf('bp');
      const c = out[side];
      for (let i = 0; i < N; i++) {
        const lfo = 0.5 - 0.5 * Math.cos((TAU * cycles * (i / SR)) / L + side * 1.1);
        c[i] = bp(table[i % n], band[0] + (band[1] - band[0]) * lfo, q) * (0.35 + 0.65 * lfo);
      }
    }
    return out;
  };
}

// ------------------------------------------------------------------- engine

function fadeTail(voice) {
  for (const c of Array.isArray(voice) ? voice : [voice]) {
    const k = Math.min(c.length, samples(0.01));
    for (let i = 0; i < k; i++) c[c.length - 1 - i] *= i / k;
  }
  return voice;
}

/** Adds a voice into every send; `pump` ducks it after each beat, like a sidechain from the kick. */
function mix(sends, voice, start, pan, pump, beatSamples) {
  const [vl, vr] = Array.isArray(voice) ? voice : [voice, voice];
  const [gl, gr] = panGains(pan);
  for (const [[l, r], g] of sends) {
    const end = Math.min(vl.length, l.length - start);
    for (let i = Math.max(0, -start); i < end; i++) {
      const j = start + i;
      let k = g;
      if (pump > 0) {
        const ph = (j % beatSamples) / SR;
        k *= 1 - pump * (ph < 0.005 ? ph / 0.005 : Math.exp(-(ph - 0.005) / 0.11));
      }
      l[j] += vl[i] * gl * k;
      r[j] += vr[i] * gr * k;
    }
  }
}

function renderTrack({ bpm, bars, rmsDb, room, echo, parts }) {
  const beatSamples = (SR * 60) / bpm;
  if (!Number.isInteger(beatSamples / 4)) throw new Error(`at ${bpm} BPM a sixteenth is not a whole number of samples`);
  const n = bars * 4 * beatSamples;
  const L = n / SR;
  const N = 2 * n;
  const dry = stereo(N);
  const rev = stereo(N);
  const dly = stereo(N);
  parts.forEach((part, p) => {
    const gain = part.gain ?? 1;
    const sends = [
      [dry, gain],
      [rev, gain * (part.reverb ?? 0)],
      [dly, gain * (part.echo ?? 0)],
    ].filter(([, g]) => g > 0);
    const pump = part.pump ?? 0;
    if (part.bed !== undefined) {
      mix(sends, part.bed(N, L), 0, part.pan ?? 0, pump, beatSamples);
      return;
    }
    part.notes.forEach((note, k) => {
      const pitches = Array.isArray(note.pitch) ? note.pitch : [note.pitch ?? 60];
      pitches.forEach((midi, v) => {
        const context = { lenS: (note.len * beatSamples) / SR, midi, vel: note.vel ?? 1, seed: p * 100003 + k * 131 + v };
        const voice = fadeTail(INSTRUMENTS[part.inst](context, { ...part.opts, ...note.opts }));
        for (let cycle = 0; cycle < 2; cycle++) {
          mix(sends, voice, cycle * n + Math.round(note.beat * beatSamples), note.pan ?? part.pan ?? 0, pump, beatSamples);
        }
      });
    });
  });
  const [rl, rr] = reverb(rev, room);
  const [el, er] = pingPong(dly, (echo.beats * beatSamples) / SR, echo.feedback, echo.tone ?? 3500);
  const out = stereo(n);
  for (let i = 0; i < n; i++) {
    out[0][i] = dry[0][n + i] + rl[n + i] + el[n + i];
    out[1][i] = dry[1][n + i] + rr[n + i] + er[n + i];
  }
  return master(out, rmsDb);
}

// ------------------------------------------------------------------- tracks

const TRACK_DEFS = {
  /** D minor, 72 BPM: the salvager's ship at rest, and something humming under it. */
  menu() {
    const bells = [ch('D5 F5 A5 E5'), ch('D5 F5 A5 Bb5'), ch('D5 G5 A5 Bb5'), ch('D5 E5 A5 G5')];
    return {
      bpm: 72,
      bars: 8,
      rmsDb: -20,
      room: { room: 0.9, damp: 0.45 },
      echo: { beats: 0.75, feedback: 0.45, tone: 3000 },
      parts: [
        { bed: drone([m('D2'), m('A2')], { cutoff: [200, 650], cycles: 1 }), gain: 0.5, reverb: 0.25 },
        {
          inst: 'pad',
          opts: { attack: 2.2, release: 3, cutoff: 1300 },
          gain: 0.6,
          reverb: 0.6,
          notes: held([ch('D3 A3 E4 F4'), ch('Bb2 F3 A3 D4'), ch('G2 D3 A3 Bb3'), ch('A2 E3 G3 D4')], 8, 0.9),
        },
        {
          inst: 'bell',
          opts: { tau: 0.9, ratio: 3.5, index: 1.4 },
          gain: 0.3,
          reverb: 0.5,
          echo: 0.6,
          notes: sprinkle(101, { beats: 32, step: 0.5, prob: 0.28, vel: [0.35, 0.8], len: 0.5, pool: (beat, r) => pick(r, bells[Math.floor(beat / 8)]) }),
        },
        { bed: wind({ band: [600, 2600], cycles: 2 }), gain: 0.07, reverb: 0.4 },
      ],
    };
  },

  /** F major, 80 BPM: the station hub — warm keys, a lazy pulse. */
  station() {
    const bars = [
      [[0, 'F3 A3 C4 E4', 'F2']],
      [[0, 'E3 G3 A3 C4', 'A2']],
      [[0, 'F3 A3 C4 D4', 'D2']],
      [
        [0, 'F3 G3 Bb3 D4', 'G2'],
        [2, 'E3 G3 Bb3 C4', 'C2'],
      ],
      [[0, 'F3 A3 C4 E4', 'F2']],
      [[0, 'E3 G3 A3 C4', 'A2']],
      [[0, 'F3 A3 Bb3 D4', 'Bb1']],
      [[0, 'F3 G3 Bb3 C4', 'C2']],
    ];
    const keys = [];
    const bass = [];
    const pad = [];
    const kick = [];
    const snare = [];
    const hats = [];
    bars.forEach((segments, bar) => {
      segments.forEach(([start, chord, root], k) => {
        const span = (k + 1 < segments.length ? segments[k + 1][0] : 4) - start;
        const at = bar * 4 + start;
        const pitch = ch(chord);
        keys.push({ beat: at, len: Math.min(1.4, span - 0.1), pitch, vel: 0.8 }, { beat: at + 1.5, len: 0.45, pitch, vel: 0.5 });
        bass.push({ beat: at, len: Math.min(1.4, span - 0.1), pitch: m(root), vel: 0.9 });
        if (span === 4) {
          keys.push({ beat: at + 2.5, len: 1.3, pitch, vel: 0.7 });
          bass.push({ beat: at + 2.5, len: 1.2, pitch: m(root), vel: 0.75 });
        }
        pad.push({ beat: at, len: span, pitch, vel: 0.6 });
      });
      kick.push({ beat: bar * 4, len: 0.5, vel: 0.75 }, { beat: bar * 4 + 2.5, len: 0.5, vel: 0.6 });
      snare.push({ beat: bar * 4 + 1, len: 0.3, vel: 0.35 }, { beat: bar * 4 + 3, len: 0.3, vel: 0.4 });
      for (let e = 0; e < 8; e++) hats.push({ beat: bar * 4 + e * 0.5 + (e % 2 ? 0.08 : 0), len: 0.1, vel: e % 2 ? 0.22 : 0.35 });
    });
    return {
      bpm: 80,
      bars: 8,
      rmsDb: -20,
      room: { room: 0.7, damp: 0.5 },
      echo: { beats: 0.75, feedback: 0.3 },
      parts: [
        { inst: 'keys', gain: 0.55, reverb: 0.35, echo: 0.15, notes: keys },
        { inst: 'bass', opts: { cutoff: 380, sweep: 500 }, gain: 0.5, notes: bass },
        { inst: 'pad', opts: { attack: 0.8, release: 1.5, cutoff: 900 }, gain: 0.2, reverb: 0.4, notes: pad },
        { inst: 'kick', gain: 0.55, notes: kick },
        { inst: 'snare', gain: 0.35, reverb: 0.2, pan: 0.1, notes: snare },
        { inst: 'hat', gain: 0.3, pan: -0.25, notes: hats },
      ],
    };
  },

  /** A minor, 120 BPM: the rail run — pulsing bass, arpeggios, a lead in the second half. */
  flight() {
    const chords = [
      ['A3 C4 E4', 'A2', 'A4 C5 E5 A5'],
      ['F3 A3 C4', 'F2', 'F4 A4 C5 F5'],
      ['G3 C4 E4', 'C3', 'G4 C5 E5 G5'],
      ['G3 B3 D4', 'G2', 'G4 B4 D5 G5'],
      ['A3 C4 E4', 'A2', 'A4 C5 E5 A5'],
      ['F3 A3 C4', 'F2', 'F4 A4 C5 F5'],
      ['G3 B3 D4', 'G2', 'G4 B4 D5 G5'],
      ['G#3 B3 E4', 'E2', 'G#4 B4 E5 G#5'],
    ];
    const order = [0, 1, 2, 3, 1, 2, 3, 2];
    const pad = [];
    const bass = [];
    const arp = [];
    chords.forEach(([chord, root, tones], k) => {
      const at = k * 8;
      pad.push({ beat: at, len: 8, pitch: ch(chord), vel: 0.8 });
      for (let s = 0; s < 16; s++) bass.push({ beat: at + s * 0.5, len: 0.42, pitch: m(root) + (s % 4 === 3 ? 12 : 0), vel: s % 2 ? 0.75 : 1 });
      const pitches = ch(tones);
      for (let s = 0; s < 32; s++) arp.push({ beat: at + s * 0.25, len: 0.2, pitch: pitches[order[s % 8]], vel: s % 4 === 0 ? 0.9 : 0.55 });
    });
    const kick = [];
    const snare = [];
    const hats = [];
    for (let bar = 0; bar < 16; bar++) {
      const at = bar * 4;
      for (let b = 0; b < 4; b++) kick.push({ beat: at + b, len: 0.4, vel: 1 });
      snare.push({ beat: at + 1, len: 0.3, vel: 0.85 });
      if (bar === 15) [3, 3.25, 3.5, 3.75].forEach((beat, k) => snare.push({ beat: at + beat, len: 0.2, vel: 0.5 + k * 0.12 }));
      else snare.push({ beat: at + 3, len: 0.3, vel: 0.85 });
      for (let s = 0; s < 16; s++) hats.push({ beat: at + s * 0.25, len: 0.1, vel: [0.18, 0.12, 0.4, 0.12][s % 4] });
    }
    const lead = line(32, [
      ['E5', 2], ['D5', 1], ['C5', 1], ['A4', 4],
      ['C5', 2], ['D5', 2], ['E5', 2], ['G5', 2],
      ['A5', 3], ['G5', 1], ['F5', 2], ['E5', 2],
      ['D5', 2], ['E5', 1], ['D5', 1], ['B4', 4],
    ]);
    return {
      bpm: 120,
      bars: 16,
      rmsDb: -17,
      room: { room: 0.6, damp: 0.5 },
      echo: { beats: 0.75, feedback: 0.35 },
      parts: [
        { inst: 'kick', gain: 0.8, notes: kick },
        { inst: 'snare', gain: 0.5, reverb: 0.25, notes: snare },
        { inst: 'hat', gain: 0.3, pan: 0.2, notes: hats },
        { inst: 'bass', opts: { cutoff: 420, sweep: 1300, drive: 1.3 }, gain: 0.55, pump: 0.45, notes: bass },
        { inst: 'pad', opts: { attack: 0.3, release: 0.8, cutoff: 2200 }, gain: 0.35, pump: 0.6, reverb: 0.35, notes: pad },
        { inst: 'pluck', opts: { bright: 2400, tau: 0.16 }, gain: 0.28, pan: -0.2, reverb: 0.2, echo: 0.35, notes: arp },
        { inst: 'lead', gain: 0.3, reverb: 0.3, echo: 0.25, notes: lead },
      ],
    };
  },

  /** E minor with a lydian shade, 64 BPM: a planet that is too quiet. No drums. */
  surface_calm() {
    const bells = ch('E5 G5 A5 B5 D6 F#5 B4');
    return {
      bpm: 64,
      bars: 8,
      rmsDb: -21,
      room: { room: 0.92, damp: 0.4 },
      echo: { beats: 1.5, feedback: 0.5, tone: 2500 },
      parts: [
        { bed: drone([m('E2'), m('B2')], { cutoff: [220, 800], cycles: 1 }), gain: 0.55, reverb: 0.3 },
        { bed: wind({ band: [300, 1600], cycles: 2 }), gain: 0.12, reverb: 0.3 },
        {
          inst: 'pad',
          opts: { attack: 3, release: 4, cutoff: 1000 },
          gain: 0.45,
          reverb: 0.6,
          notes: held([ch('E3 B3 F#4 G4'), ch('C3 G3 B3 F#4')], 16, 0.8),
        },
        {
          inst: 'bell',
          opts: { tau: 2.2, ratio: 3.5, index: 1.2 },
          gain: 0.3,
          reverb: 0.6,
          echo: 0.5,
          notes: sprinkle(202, { beats: 32, step: 0.5, prob: 0.16, vel: [0.3, 0.8], len: 1, pool: (_, r) => pick(r, bells) }),
        },
      ],
    };
  },

  /** E minor, 128 BPM: the same key as the calm bed, so the crossfade between them is a key-safe swap. */
  surface_combat() {
    const roots = ['E2', 'E2', 'C2', 'D2', 'E2', 'E2', 'C2', 'B1'];
    const stabs = { E2: 'E3 G3 B3', C2: 'G3 C4 E4', D2: 'F#3 A3 D4', B1: 'F#3 B3 D#4' };
    const pattern = [1, 0, 1, 1, 0, 1, 1, 0, 1, 0, 1, 1, 0, 1, 0, 1];
    const [kick, snare, hats, bass, stab, toms, pad] = [[], [], [], [], [], [], []];
    for (let bar = 0; bar < 16; bar++) {
      const root = roots[bar % 8];
      const at = bar * 4;
      const chord = ch(stabs[root]);
      pattern.forEach((on, s) => {
        if (on) bass.push({ beat: at + s * 0.25, len: 0.2, pitch: m(root) + (s === 6 || s === 14 ? 12 : 0), vel: s % 4 === 0 ? 1 : 0.75 });
      });
      for (let b = 0; b < 4; b++) kick.push({ beat: at + b, len: 0.4, vel: 1 });
      snare.push({ beat: at + 1, len: 0.3, vel: 0.9 }, { beat: at + 2.75, len: 0.2, vel: 0.22 }, { beat: at + 3, len: 0.3, vel: 0.9 });
      for (let s = 0; s < 16; s++) hats.push({ beat: at + s * 0.25, len: 0.1, vel: [0.25, 0.15, 0.45, 0.15][s % 4] });
      hats.push({ beat: at + 3.5, len: 0.3, vel: 0.35, opts: { tau: 0.12 } });
      stab.push({ beat: at, len: 0.45, pitch: chord, vel: 0.85 }, { beat: at + 2.75, len: 0.22, pitch: chord, vel: 0.6 });
      pad.push({ beat: at, len: 4, pitch: chord, vel: 0.7 });
      if (bar % 8 === 7) ['A3', 'F3', 'D3', 'B2'].forEach((name, k) => toms.push({ beat: at + 3 + k * 0.25, len: 0.4, pitch: m(name), vel: 0.8 }));
    }
    return {
      bpm: 128,
      bars: 16,
      rmsDb: -16,
      room: { room: 0.5, damp: 0.5 },
      echo: { beats: 0.75, feedback: 0.3 },
      parts: [
        { inst: 'kick', gain: 0.85, notes: kick },
        { inst: 'snare', gain: 0.55, reverb: 0.2, notes: snare },
        { inst: 'hat', gain: 0.3, pan: 0.25, notes: hats },
        { inst: 'bass', opts: { cutoff: 350, sweep: 1800, q: 1.2, drive: 2 }, gain: 0.5, pump: 0.35, notes: bass },
        { inst: 'stab', gain: 0.38, reverb: 0.2, echo: 0.15, pan: -0.15, notes: stab },
        { inst: 'pad', opts: { attack: 0.2, release: 0.6, cutoff: 1500 }, gain: 0.15, pump: 0.5, reverb: 0.3, notes: pad },
        { inst: 'tom', gain: 0.6, reverb: 0.25, notes: toms },
        { inst: 'riser', gain: 0.22, reverb: 0.2, notes: [{ beat: 56, len: 8, vel: 1 }] },
      ],
    };
  },

  /** C minor, 150 BPM in half time: low chugs, a choir, a bell that tolls every four bars. */
  boss() {
    const roots = ['C2', 'C2', 'Ab1', 'G1', 'C2', 'C2', 'Db2', 'G1'];
    const choirChords = { C2: 'C3 Eb3 G3', Ab1: 'Ab2 C3 Eb3', G1: 'G2 B2 D3', Db2: 'Db3 F3 Ab3' };
    const stabChords = { C2: 'C4 Eb4 G4', Ab1: 'Ab3 C4 Eb4', G1: 'G3 B3 D4 Ab4', Db2: 'Db4 F4 Ab4' };
    const [kick, snare, hats, bass, choir, stabs, toms, tolls] = [[], [], [], [], [], [], [], []];
    for (let bar = 0; bar < 16; bar++) {
      const root = roots[Math.floor(bar / 2)];
      const at = bar * 4;
      for (let s = 0; s < 8; s++) {
        if (s !== 6) bass.push({ beat: at + s * 0.5, len: 0.4, pitch: m(root), vel: s === 0 || s === 3 ? 1 : 0.7 });
      }
      for (const beat of bar % 2 ? [0, 1.75, 2.5] : [0, 2.5]) kick.push({ beat: at + beat, len: 0.4, vel: 1 });
      snare.push({ beat: at + 2, len: 0.3, vel: 1 });
      for (let e = 0; e < 8; e++) hats.push({ beat: at + e * 0.5, len: 0.1, vel: e % 2 ? 0.2 : 0.35 });
      if (bar % 4 === 0) {
        hats.push({ beat: at, len: 1, vel: 0.7, opts: { tau: 0.5 } }); // crash
        tolls.push({ beat: at, len: 4, pitch: m('C3'), vel: 1 });
      }
      if (bar % 2 === 0) choir.push({ beat: at, len: 8, pitch: ch(choirChords[root]), vel: 0.8 });
      stabs.push({ beat: at, len: 0.4, pitch: ch(stabChords[root]), vel: 0.75 });
      if (bar % 4 === 3) ['C3', 'A2', 'F2', 'D2'].forEach((name, k) => toms.push({ beat: at + 3 + k * 0.25, len: 0.4, pitch: m(name), vel: 0.9 }));
    }
    return {
      bpm: 150,
      bars: 16,
      rmsDb: -15,
      room: { room: 0.75, damp: 0.4 },
      echo: { beats: 1, feedback: 0.25 },
      parts: [
        { inst: 'kick', gain: 0.9, notes: kick },
        { inst: 'snare', gain: 0.6, reverb: 0.35, notes: snare },
        { inst: 'hat', gain: 0.25, pan: 0.2, notes: hats },
        { inst: 'bass', opts: { cutoff: 260, sweep: 900, q: 1.3, drive: 3 }, gain: 0.5, pump: 0.25, notes: bass },
        { inst: 'choir', gain: 0.4, reverb: 0.45, notes: choir },
        { inst: 'stab', gain: 0.3, reverb: 0.3, pan: 0.1, notes: stabs },
        { inst: 'tom', gain: 0.65, reverb: 0.3, notes: toms },
        { inst: 'bell', opts: { tau: 2.5, ratio: 1.41, index: 3 }, gain: 0.35, reverb: 0.5, notes: tolls },
      ],
    };
  },

  /** C major, 60 BPM: arpeggiated keys and a slow bell line — the loop that lets go. */
  ending() {
    const bars = [
      ['F3 A3 C4 E4', 'F2'],
      ['G3 B3 D4 E4', 'G2'],
      ['E3 G3 B3 D4', 'E2'],
      ['A3 C4 E4 B4', 'A2'],
      ['F3 A3 C4 E4', 'F2'],
      ['G3 B3 D4 G4', 'G2'],
      ['E3 G3 C4 D4', 'E2'],
      ['E3 G3 C4 E4', 'C2'],
    ];
    const keys = [];
    const bass = [];
    const pad = [];
    bars.forEach(([chord, root], bar) => {
      const tones = ch(chord);
      const at = bar * 4;
      [0, 1, 2, 3, 2, 1, 2, 3].forEach((idx, s) => keys.push({ beat: at + s * 0.5, len: 1.5, pitch: tones[idx], vel: s === 0 ? 0.75 : 0.5 }));
      bass.push({ beat: at, len: 3.9, pitch: m(root), vel: 0.8 });
      pad.push({ beat: at, len: 4, pitch: tones, vel: 0.6 });
    });
    const melody = line(0, [
      ['E5', 2], ['G5', 2], ['D5', 3], ['E5', 1],
      ['B4', 2], ['D5', 2], ['C5', 4],
      ['A4', 2], ['C5', 2], ['D5', 2], ['B4', 2],
      ['C5', 2], ['D5', 2], ['E5', 4],
    ]);
    return {
      bpm: 60,
      bars: 8,
      rmsDb: -20,
      room: { room: 0.88, damp: 0.45 },
      echo: { beats: 1, feedback: 0.35, tone: 2800 },
      parts: [
        { inst: 'keys', gain: 0.45, reverb: 0.45, echo: 0.1, pan: -0.1, notes: keys },
        { inst: 'pad', opts: { attack: 1.2, release: 2.5, cutoff: 1100 }, gain: 0.35, reverb: 0.5, notes: pad },
        { inst: 'bass', opts: { cutoff: 260, sweep: 250 }, gain: 0.35, notes: bass },
        { inst: 'bell', opts: { tau: 1.8, ratio: 2, index: 1.2 }, gain: 0.3, reverb: 0.5, echo: 0.3, pan: 0.15, notes: melody },
      ],
    };
  },

  /** D minor, 60 BPM: the story films' dark bed (PLAN R9) — a drone, a slow pad, plucks that thin out, a sub pulse. */
  film_dark() {
    const plucks = ch('D4 F4 A4 C5 E5');
    const pulse = Array.from({ length: 8 }, (_, k) => ({ beat: k * 8, len: 1, pitch: m('D1'), vel: 0.7 }));
    return {
      bpm: 60,
      bars: 16,
      rmsDb: -20,
      room: { room: 0.93, damp: 0.4 },
      echo: { beats: 1.5, feedback: 0.45, tone: 2200 },
      parts: [
        { bed: drone([m('D2'), m('A2')], { cutoff: [160, 520], cycles: 1 }), gain: 0.6, reverb: 0.3 },
        { bed: wind({ band: [250, 1200], cycles: 2 }), gain: 0.1, reverb: 0.35 },
        {
          inst: 'pad',
          opts: { attack: 3.5, release: 5, cutoff: 900 },
          gain: 0.5,
          reverb: 0.6,
          notes: held([ch('D3 A3 F4'), ch('Bb2 F3 D4'), ch('G2 D3 Bb3'), ch('A2 E3 C#4')], 16, 0.8),
        },
        {
          inst: 'pluck',
          opts: { bright: 1400, tau: 0.5 },
          gain: 0.22,
          reverb: 0.5,
          echo: 0.5,
          notes: sprinkle(303, { beats: 64, step: 1, prob: 0.22, vel: [0.3, 0.7], len: 0.8, pool: (_, r) => pick(r, plucks) }),
        },
        { inst: 'tom', gain: 0.35, reverb: 0.4, notes: pulse },
      ],
    };
  },

  /** F major, 72 BPM: the interludes' warm bed — a pad and a slow arpeggio with an echo. */
  film_hope() {
    const chords = [ch('F3 A3 C4 E4'), ch('D3 F3 A3 C4'), ch('Bb2 D3 F3 A3'), ch('C3 E3 G3 D4')];
    const arp = [];
    chords.forEach((tones, k) => {
      [0, 1, 2, 3, 2, 1, 2, 3].forEach((idx, s) => arp.push({ beat: k * 8 + s, len: 0.9, pitch: tones[idx] + 12, vel: s === 0 ? 0.7 : 0.45 }));
    });
    return {
      bpm: 72,
      bars: 8,
      rmsDb: -19,
      room: { room: 0.88, damp: 0.45 },
      echo: { beats: 0.75, feedback: 0.4, tone: 3000 },
      parts: [
        { inst: 'pad', opts: { attack: 2, release: 3, cutoff: 1300 }, gain: 0.5, reverb: 0.55, notes: held(chords, 8, 0.8) },
        { inst: 'keys', gain: 0.35, reverb: 0.45, echo: 0.3, pan: -0.1, notes: arp },
        {
          inst: 'bass',
          opts: { cutoff: 240, sweep: 200 },
          gain: 0.3,
          notes: chords.map((tones, k) => ({ beat: k * 8, len: 7.8, pitch: tones[0] - 12, vel: 0.7 })),
        },
      ],
    };
  },
};

/** `MusicId` (`src/core/Audio.ts`) → a function returning the seamless stereo loop. */
export const TRACKS = Object.fromEntries(Object.entries(TRACK_DEFS).map(([id, def]) => [id, () => renderTrack(def())]));
