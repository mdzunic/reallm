// The 29 placeholder sound effects (SPEC-006 §2.2), one synth per sprite id,
// packed into the three banks at the offsets `src/data/assets.ts` declares.
// Each render gets the sample count it may fill: the sprite's length less a
// small guard for one-shots, exactly the sprite's length for the loops.
import {
  SR,
  TAU,
  adsr,
  clamp,
  decay,
  fadeEdges,
  noise,
  noiseTable,
  normalizePeak,
  osc,
  rng,
  samples,
  snap,
  soft,
  svf,
} from './dsp.mjs';

/** Silence left at the end of a one-shot's sprite, so a late cut lands on nothing. */
const GUARD_MS = 20;

const fill = (n, fn) => {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = fn(i / SR, i);
  return out;
};

/** Exponential glide from `from` to `to` over `time` s, then held. */
const sweep = (t, from, to, time) => from * (to / from) ** clamp(t / time, 0, 1);

/** A sine gliding linearly `f0 → f1` over `T` s, then held — stateless, so events can overlap. */
function chirp(u, f0, f1, T) {
  const v = Math.min(u, T);
  let phase = f0 * v + ((f1 - f0) * v * v) / (2 * T);
  if (u > T) phase += f1 * (u - T);
  return Math.sin(TAU * phase);
}

/** Two-operator FM at fixed pitch: bells, coins, crystals. */
const fm = (t, f, ratio, index) => Math.sin(TAU * f * t + index * Math.sin(TAU * f * ratio * t));

const attack = (t, seconds) => Math.min(1, t / seconds);

/** Renders two periods of a stateful loop and keeps the second, which already carries the first's tails. */
function steadyLoop(n, render) {
  return render(2 * n).slice(n);
}

/** `peak` is the dBFS the sound is normalised to — the placeholder mix, set by ear. */
const SOUNDS = {
  // ------------------------------------------------------------------ ui
  ui_blip: {
    peak: -6,
    render: (n) => {
      const a = osc('sine');
      const b = osc('sine');
      return fill(n, (t) => {
        const f = sweep(t, 1760, 1480, 0.03);
        return (a(f) + 0.3 * b(2 * f)) * attack(t, 0.002) * decay(t, 0.035);
      });
    },
  },
  ui_warn: {
    peak: -9,
    render: (n) => {
      const o = osc('square');
      const lp = svf();
      return fill(n, (t) => {
        const second = t >= 0.13;
        const u = second ? t - 0.13 : t;
        const env = !second && t >= 0.12 ? 0 : adsr(u, second ? 0.11 : 0.1, 0.004, 0.03, 0.7, 0.02);
        return lp(o(second ? 440 : 587.33), 2400, 1) * env;
      });
    },
  },
  ui_purchase: {
    peak: -6,
    render: (n) =>
      fill(n, (t) => {
        const a = fm(t, 987.77, 2, 1.2 * decay(t, 0.03)) * decay(t, 0.03) * attack(t, 0.002);
        const u = t - 0.07;
        const b = u < 0 ? 0 : fm(u, 1318.51, 2, 1.5 * decay(u, 0.08)) * decay(u, 0.12) * attack(u, 0.002);
        return 0.7 * a + 0.8 * b;
      }),
  },
  ui_glitch: {
    // The simulation-plot sting (§5.2): the machine showing through.
    peak: -7,
    render: (n) => {
      const r = rng(7);
      const nz = noise(8);
      const lp = svf();
      const out = new Float32Array(n);
      let held = 0;
      for (let at = 0; at < n; ) {
        const len = samples(0.015 + r() * 0.035);
        const kind = r();
        const f = 200 + r() * 1800;
        const crush = 2 + Math.floor(r() * 14);
        const levels = 2 ** (2 + Math.floor(r() * 4));
        const amp = 0.4 + r() * 0.6;
        for (let i = at; i < Math.min(n, at + len); i++) {
          const x = kind < 0.45 ? Math.sign(Math.sin((TAU * f * i) / SR)) : kind < 0.8 ? nz() : 0;
          if (i % crush === 0) held = x; // sample-and-hold decimation
          out[i] = (Math.round(held * levels) / levels) * amp;
        }
        at += len;
      }
      const tail = samples(0.06);
      for (let i = 0; i < n; i++) out[i] = lp(out[i], 6500) * Math.min(1, (n - i) / tail);
      return out;
    },
  },
  ui_dialogue_open: {
    peak: -8,
    render: (n) => {
      const bp = svf('bp');
      const nz = noise(11);
      const s = osc('sine');
      return fill(n, (t) => {
        const env = adsr(t, 0.12, 0.05, 0.05, 0.6, 0.1);
        return (bp(nz(), sweep(t, 500, 3200, 0.2), 2.5) * 0.8 + 0.25 * s(sweep(t, 660, 1320, 0.15))) * env;
      });
    },
  },
  level_up: {
    peak: -4,
    render: (n) =>
      fill(n, (t) => {
        let y = 0;
        const notes = [1046.5, 1318.51, 1567.98, 2093];
        for (let k = 0; k < notes.length; k++) {
          const u = t - k * 0.09;
          if (u >= 0) y += fm(u, notes[k], 3, 1.1 * decay(u, 0.1)) * decay(u, 0.28) * attack(u, 0.003) * (k === 3 ? 1 : 0.75);
        }
        const u = t - 0.27;
        if (u >= 0) y += 0.25 * Math.sin(TAU * 4186 * u) * decay(u, 0.2) * (0.6 + 0.4 * Math.sin(TAU * 18 * u));
        return y;
      }),
  },
  mission_done: {
    peak: -4,
    render: (n) => {
      const freqs = [523.25, 659.25, 783.99, 525.3, 656.6, 786.3];
      const saws = freqs.map(() => osc('saw'));
      const lp = svf();
      const bells = [783.99, 1046.5, 1318.51, 1567.98];
      return fill(n, (t) => {
        let pad = 0;
        for (let k = 0; k < freqs.length; k++) pad += saws[k](freqs[k]);
        pad = lp(pad / freqs.length, sweep(t, 600, 4200, 0.25), 0.9) * adsr(t, 0.35, 0.03, 0.3, 0.6, 0.75);
        let ring = 0;
        for (let k = 0; k < bells.length; k++) {
          const u = t - k * 0.08;
          if (u >= 0) ring += fm(u, bells[k], 2, decay(u, 0.12)) * decay(u, 0.35) * attack(u, 0.003);
        }
        return pad * 0.8 + ring * 0.35;
      });
    },
  },

  // ------------------------------------------------------------- surface
  hit_player: {
    peak: -3,
    render: (n) => {
      const s = osc('sine');
      const q = osc('square');
      const nz = noise(21);
      const lp = svf();
      return fill(n, (t) =>
        soft(
          (s(sweep(t, 120, 50, 0.08)) * decay(t, 0.07) + 0.5 * lp(nz(), 1400) * decay(t, 0.025) + 0.25 * q(180) * decay(t, 0.04)) * 1.5,
          1.5,
        ),
      );
    },
  },
  player_death: {
    // A suit powering down: everything falls, and the noise floor comes up.
    peak: -3,
    render: (n) => {
      const saw1 = osc('saw');
      const saw2 = osc('saw');
      const sub = osc('sine');
      const nz = noise(22);
      const lp = svf();
      const nlp = svf();
      return fill(n, (t) => {
        const f = sweep(t, 440, 55, 1.0);
        const env = attack(t, 0.01) * (1 - clamp(t / 1.15, 0, 1)) ** 1.5;
        const tone = lp(saw1(f) + 0.5 * saw2(f * 1.5), sweep(t, 3500, 180, 1.0), 2) * 0.6;
        return (tone + sub(sweep(t, 90, 30, 1.1)) * 0.5 + nlp(nz(), sweep(t, 2000, 200, 1.0)) * 0.3 * decay(t, 0.4)) * env;
      });
    },
  },
  bug_pop: {
    peak: -5,
    render: (n) => {
      const bp = svf('bp');
      const nz = noise(23);
      const s = osc('sine');
      return fill(
        n,
        (t) =>
          (bp(nz(), sweep(t, 2800, 500, 0.09), 3) * 1.2 * decay(t, 0.05) + 0.6 * s(sweep(t, 750, 180, 0.05)) * decay(t, 0.03)) *
          attack(t, 0.001),
      );
    },
  },
  raider_death: {
    peak: -3,
    render: (n) => {
      const bp = svf('bp');
      const lp = svf();
      const nz = noise(24);
      const boom = osc('sine');
      const partials = [
        [310, 0.3],
        [523, 0.22],
        [887, 0.16],
        [1290, 0.1],
        [1730, 0.07],
      ];
      return fill(n, (t) => {
        let ring = 0;
        for (const [f, tau] of partials) ring += Math.sin(TAU * f * t) * decay(t, tau);
        const clang = bp(nz(), 900, 5) * decay(t, 0.12);
        const body = 0.9 * boom(sweep(t, 95, 38, 0.2)) * decay(t, 0.18) + 0.6 * lp(nz(), sweep(t, 4000, 400, 0.4)) * decay(t, 0.2);
        return soft(0.14 * ring + clang + body, 1.3);
      });
    },
  },
  wraith_death: {
    peak: -4,
    render: (n) => {
      const voices = [osc('sine'), osc('sine'), osc('sine')];
      const detune = [1, 1.012, 0.991];
      const hp = svf('hp');
      const nz = noise(25);
      const out = fill(n, (t) => {
        const f = sweep(t, 900, 300, 0.6) * (1 + 0.02 * Math.sin(TAU * 7 * t));
        let y = 0;
        for (let k = 0; k < voices.length; k++) y += voices[k](f * detune[k]);
        const env = attack(t, 0.03) * (1 - clamp(t / 0.62, 0, 1));
        return ((y / 3) * 0.8 + 0.3 * hp(nz(), 3000) * decay(t, 0.2)) * env;
      });
      // One short echo gives the wail its hollow room.
      const d = samples(0.07);
      for (let i = n - 1; i >= d; i--) out[i] += 0.4 * out[i - d];
      return out;
    },
  },
  elite_death: {
    peak: -2,
    render: (n) => {
      const boom = osc('sine');
      const lp = svf();
      const hp = svf('hp');
      const nz = noise(26);
      const r = rng(27);
      return fill(n, (t) => {
        const crackle = r() < 0.02 * decay(t, 0.25) ? r() * 2 - 1 : 0;
        const ring = 0.12 * (Math.sin(TAU * 440 * t) + Math.sin(TAU * 663 * t)) * decay(t, 0.25);
        return soft(
          1.1 * boom(sweep(t, 75, 28, 0.35)) * decay(t, 0.3) + 0.9 * lp(nz(), sweep(t, 5000, 300, 0.5)) * decay(t, 0.3) + 1.5 * hp(crackle, 2500) + ring,
          1.4,
        );
      });
    },
  },
  enemy_death_generic: {
    peak: -4,
    render: (n) => {
      const lp = svf();
      const nz = noise(28);
      const s = osc('sine');
      return fill(n, (t) => 0.8 * lp(nz(), sweep(t, 3000, 400, 0.3)) * decay(t, 0.11) + 0.7 * s(sweep(t, 210, 60, 0.12)) * decay(t, 0.09));
    },
  },
  boss_roar: {
    // Sawtooth throat through three formants that morph "aa" → "oo".
    peak: -5,
    render: (n) => {
      const a = osc('saw');
      const b = osc('saw');
      const c = osc('square');
      const f1 = svf('bp');
      const f2 = svf('bp');
      const f3 = svf('bp');
      const hp = svf('hp');
      const nz = noise(29);
      const len = n / SR;
      return fill(n, (t) => {
        const env = adsr(t, len - 0.45, 0.15, 0.3, 0.8, 0.4);
        const wobble = 1 + 0.03 * Math.sin(TAU * 5.5 * t) * clamp(t / 0.6, 0, 1);
        const f = 55 * wobble * sweep(t, 1.15, 0.9, len);
        const throat = a(f) + b(f * 1.007) + 0.6 * c(f * 1.5);
        const m = clamp(t / len, 0, 1);
        const y = f1(throat, 730 - 430 * m, 5) + 0.7 * f2(throat, 1090 - 220 * m, 6) + 0.3 * f3(throat, 2440 - 200 * m, 7);
        return soft((y * 0.8 + 0.15 * hp(nz(), 1500)) * env * 1.8, 2);
      });
    },
  },
  boss_death: {
    peak: -1,
    render: (n) => {
      const boom = osc('sine');
      const lp = svf();
      const rumble = svf();
      const hp = svf('hp');
      const nz = noise(30);
      const r = rng(31);
      const len = n / SR;
      return fill(n, (t) => {
        const crackle = r() < 0.025 * decay(t, 0.6) ? r() * 2 - 1 : 0;
        const tail = 1 - clamp((t - (len - 0.5)) / 0.5, 0, 1);
        return (
          soft(
            1.2 * boom(sweep(t, 65, 22, 0.8)) * decay(t, 0.55) +
              lp(nz(), sweep(t, 6000, 150, 1.4)) * decay(t, 0.7) +
              2.4 * rumble(nz(), 110) * decay(t, 1.2) +
              1.4 * hp(crackle, 2000) +
              0.1 * Math.sin(TAU * 311 * t) * decay(t, 0.5),
            1.5,
          ) * tail
        );
      });
    },
  },
  pickup_oil: {
    peak: -8,
    render: (n) =>
      fill(n, (t) => {
        let y = 0;
        for (const [at, f0, f1] of [
          [0, 170, 400],
          [0.08, 230, 520],
        ]) {
          const u = t - at;
          if (u >= 0) y += chirp(u, f0, f1, 0.05) * decay(u, 0.035) * attack(u, 0.002);
        }
        return y;
      }),
  },
  pickup_wheat: {
    peak: -8,
    render: (n) => {
      const a = osc('tri');
      const b = osc('tri');
      const bp = svf('bp');
      const nz = noise(36);
      return fill(n, (t) => (a(659.25) + 0.5 * b(987.77)) * decay(t, 0.06) * attack(t, 0.002) + 0.5 * bp(nz(), 5000, 1.5) * decay(t, 0.03));
    },
  },
  pickup_water: {
    peak: -8,
    render: (n) =>
      fill(n, (t) => {
        let y = chirp(t, 600, 1900, 0.04) * decay(t, 0.035) * attack(t, 0.001);
        const u = t - 0.065;
        if (u >= 0) y += 0.5 * chirp(u, 900, 2400, 0.03) * decay(u, 0.03) * attack(u, 0.001);
        return y;
      }),
  },
  pickup_lithium: {
    peak: -8,
    render: (n) =>
      fill(n, (t) => (fm(t, 2637, 1.41, 2 * decay(t, 0.03)) * decay(t, 0.1) + 0.4 * Math.sin(TAU * 3951 * t) * decay(t, 0.06)) * attack(t, 0.001)),
  },
  pickup_generic: {
    peak: -8,
    render: (n) =>
      fill(n, (t) => {
        let y = 0;
        for (const [at, f] of [
          [0, 880],
          [0.07, 1320],
        ]) {
          const u = t - at;
          if (u >= 0) y += Math.sin(TAU * f * u) * adsr(u, 0.045, 0.002, 0.01, 0.8, 0.012);
        }
        return y;
      }),
  },
  scan_done: {
    peak: -6,
    render: (n) =>
      fill(n, (t) => {
        let y = 0;
        if (t < 0.28) y += chirp(t, 400, 1600, 0.25) * (0.55 + 0.45 * Math.sin(TAU * 30 * t)) * adsr(t, 0.24, 0.01, 0.05, 0.8, 0.03) * 0.6;
        for (const at of [0.3, 0.41]) {
          const u = t - at;
          if (u >= 0) y += Math.sin(TAU * 1318.51 * u) * adsr(u, 0.07, 0.003, 0.01, 0.9, 0.02) * 0.8;
        }
        return y;
      }),
  },
  alarm_weather: {
    peak: -5,
    render: (n) => {
      const a = osc('saw');
      const b = osc('saw');
      const lp = svf();
      return fill(n, (t) => {
        const k = Math.floor(t / 0.48);
        if (k > 2) return 0;
        const u = t - k * 0.48;
        const f = sweep(u, 620, 880, 0.3);
        return lp(a(f) + 0.6 * b(f * 1.5), 2600, 1.2) * adsr(u, 0.34, 0.01, 0.05, 0.85, 0.05);
      });
    },
  },
  storm_loop: {
    loop: true,
    peak: -12,
    render: (n) => {
      const L = n / SR;
      const table = noiseTable(n, 32);
      const bp = svf('bp');
      const hiss = svf('bp');
      const rumble = svf();
      return steadyLoop(n, (m) =>
        fill(m, (t, i) => {
          const w = table[i % n];
          const w2 = table[(i * 7 + 13) % n];
          const lfo = 0.5 + 0.3 * Math.sin((TAU * t) / L) + 0.2 * Math.sin((TAU * 3 * t) / L + 1.3);
          const gust = 0.6 + 0.4 * Math.max(0, Math.sin((TAU * 2 * t) / L + 0.4)) ** 2;
          return (bp(w, 250 + 1100 * lfo, 1.6) * 0.9 + hiss(w2, 2400 + 1500 * lfo, 3) * 0.25) * gust + rumble(w, 120) * 2.5;
        }),
      );
    },
  },

  // -------------------------------------------------------------- flight
  ship_hit_shield: {
    peak: -4,
    render: (n) => {
      const bp = svf('bp');
      const nz = noise(33);
      const ping = osc('sine');
      const whump = osc('sine');
      return fill(
        n,
        (t) =>
          bp(nz(), 4200, 2) * decay(t, 0.07) * 0.8 +
          ping(sweep(t, 2300, 1500, 0.15)) * decay(t, 0.12) * (0.7 + 0.3 * Math.sin(TAU * 40 * t)) * 0.6 +
          whump(sweep(t, 160, 80, 0.08)) * decay(t, 0.06) * 0.7,
      );
    },
  },
  ship_hit_hull: {
    peak: -3,
    render: (n) => {
      const lp = svf();
      const nz = noise(34);
      const thud = osc('sine');
      const partials = [
        [220, 0.25],
        [347, 0.2],
        [563, 0.14],
        [781, 0.1],
        [1210, 0.07],
      ];
      return fill(n, (t) => {
        let ring = 0;
        for (const [f, tau] of partials) ring += Math.sin(TAU * f * t) * decay(t, tau);
        return soft(ring * 0.25 + lp(nz(), 3000) * decay(t, 0.03) + thud(sweep(t, 95, 45, 0.1)) * decay(t, 0.08), 1.3);
      });
    },
  },
  landing_thrusters: {
    peak: -4,
    render: (n) => {
      const lp = svf();
      const rumble = svf();
      const nz = noise(35);
      const sub = osc('sine');
      const len = n / SR;
      return fill(n, (t) => {
        const env = adsr(t, len - 0.45, 0.2, 0.3, 0.75, 0.4);
        const cut = t < 0.5 ? sweep(t, 400, 1600, 0.5) : sweep(t - 0.5, 1600, 600, len - 0.5);
        return (lp(nz(), cut, 0.9) * 0.9 + rumble(nz(), 90) * 3 + sub(45) * 0.3) * env;
      });
    },
  },
  engine_hum: {
    loop: true,
    peak: -12,
    render: (n) => {
      const L = n / SR;
      const table = noiseTable(n, 37);
      const a = osc('saw');
      const b = osc('saw');
      const sub = osc('sine');
      const lp = svf();
      const hp = svf('hp');
      const [fa, fb, fs, trem] = [snap(55, L), snap(55.25, L), snap(27.5, L), snap(6, L)];
      return steadyLoop(n, (m) =>
        fill(m, (t, i) => {
          const y = lp(a(fa) + b(fb), 420, 1.1) * 0.6 + sub(fs) * 0.5 + hp(table[i % n], 2500) * 0.05;
          return y * (0.85 + 0.15 * Math.sin(TAU * trem * t));
        }),
      );
    },
  },
  laser_charge: {
    // A held whine with a pulse, not a rising sweep: it loops for as long as the charge.
    loop: true,
    peak: -14,
    render: (n) => {
      const L = n / SR;
      const [f, g, trem, wob] = [snap(1200, L), snap(1800, L), snap(14, L), snap(4.3, L)];
      return fill(n, (t) => {
        const y = Math.sin(TAU * f * t + 0.8 * Math.sin(TAU * wob * t)) * 0.6 + 0.3 * Math.sin(TAU * g * t);
        return y * (0.6 + 0.4 * Math.sin(TAU * trem * t));
      });
    },
  },
};

/**
 * How much of a loop's own continuation is written into the silence around its
 * sprite — its tail just before it, its head just after — so the codec never
 * sees an edge at either end of the loop and the seam decodes clean.
 */
const ROLL_MS = 40;
const ROLL_FADE_MS = 10;

/** One mono bank: every sprite rendered, normalised and placed at its offset. */
export function renderSfxBank(sprite) {
  const regions = Object.entries(sprite)
    .map(([name, [offsetMs, durationMs]]) => ({ name, at: samples(offsetMs / 1000), length: samples(durationMs / 1000) }))
    .sort((a, b) => a.at - b.at);
  const roll = samples(ROLL_MS / 1000);
  const fade = samples(ROLL_FADE_MS / 1000);
  const tail = regions[regions.length - 1];
  const bank = new Float32Array(tail.at + tail.length + roll);
  regions.forEach((region, k) => {
    const def = SOUNDS[region.name];
    if (def === undefined) throw new Error(`no synth for sprite "${region.name}" — add one to scripts/assets/audio/sfx.mjs`);
    const length = region.length - (def.loop ? 0 : samples(GUARD_MS / 1000));
    const x = def.render(length);
    if (x.length !== length) throw new Error(`"${region.name}" rendered ${x.length} samples, not ${length}`);
    if (!def.loop) fadeEdges(x);
    normalizePeak([x], def.peak);
    bank.set(x, region.at);
    if (!def.loop) return;
    // Never more than half of a gap, so a neighbouring loop has room for its own.
    const previous = regions[k - 1];
    const next = regions[k + 1];
    const pre = Math.min(roll, Math.floor((previous === undefined ? region.at : region.at - previous.at - previous.length) / 2));
    const post = next === undefined ? roll : Math.min(roll, Math.floor((next.at - region.at - region.length) / 2));
    for (let j = 1; j <= pre; j++) bank[region.at - j] = x[length - j] * Math.min(1, (pre - j) / fade);
    for (let j = 0; j < post; j++) bank[region.at + length + j] = x[j] * Math.min(1, (post - 1 - j) / fade);
  });
  return bank;
}
