// SPEC-045 §4.5 — colour vision, for the tests that hold the colour-blind
// preset and the hostile rim apart from what they sit beside. Machado,
// Oliveira and Fernandes' 2009 simulation matrices at severity 1, applied in
// linear sRGB and clamped back into gamut, then ΔE76 in CIELAB under D65.
// Pure arithmetic: no DOM and no `three`, so both the theme test and the
// procedural-mesh test can read it in node.

export type Deficiency = 'protan' | 'deutan' | 'tritan';

/** The three simulations every SPEC-045 colour pin runs under. */
export const DEFICIENCIES: readonly Deficiency[] = ['protan', 'deutan', 'tritan'];

type Row = readonly [number, number, number];
type Matrix = readonly [Row, Row, Row];

/** Machado et al. 2009, severity 1.0, linear RGB → linear RGB. */
const MACHADO: Readonly<Record<Deficiency, Matrix>> = {
  protan: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deutan: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  tritan: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.3039],
  ],
};

/** The sRGB transfer curve, decoded: a 0…1 channel to linear light. */
function toLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

/** `#rrggbb` → linear sRGB, each channel 0…1. */
export function linearRgb(hex: string): [number, number, number] {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (match === null) throw new Error(`not a #rrggbb colour: ${hex}`);
  const n = Number.parseInt(match[1] as string, 16);
  return [toLinear(((n >> 16) & 255) / 255), toLinear(((n >> 8) & 255) / 255), toLinear((n & 255) / 255)];
}

/** `hex` as the deficiency sees it, in linear sRGB clamped to 0…1; unchanged with no deficiency. */
export function simulate(hex: string, type: Deficiency | null): [number, number, number] {
  const rgb = linearRgb(hex);
  if (type === null) return rgb;
  const m = MACHADO[type];
  const clamp = (v: number): number => Math.min(1, Math.max(0, v));
  return [
    clamp(m[0][0] * rgb[0] + m[0][1] * rgb[1] + m[0][2] * rgb[2]),
    clamp(m[1][0] * rgb[0] + m[1][1] * rgb[1] + m[1][2] * rgb[2]),
    clamp(m[2][0] * rgb[0] + m[2][1] * rgb[1] + m[2][2] * rgb[2]),
  ];
}

/** D65 reference white. */
const WHITE = [0.95047, 1, 1.08883] as const;

/** Linear sRGB → CIELAB (D65). */
export function lab([r, g, b]: readonly [number, number, number]): [number, number, number] {
  const x = 0.4124564 * r + 0.3575761 * g + 0.1804375 * b;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = 0.0193339 * r + 0.119192 * g + 0.9503041 * b;
  const f = (t: number): number => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  const fx = f(x / WHITE[0]);
  const fy = f(y / WHITE[1]);
  const fz = f(z / WHITE[2]);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** ΔE76 between two `#rrggbb` colours, as seen under `type` (or by typical vision with `null`). */
export function deltaE76(a: string, b: string, type: Deficiency | null = null): number {
  const [l1, a1, b1] = lab(simulate(a, type));
  const [l2, a2, b2] = lab(simulate(b, type));
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}
