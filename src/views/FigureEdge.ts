// The figure edge (SPEC-075 §4.1, PLAN R32): the player and every enemy wear
// a thin band along their silhouette that stands off the ground they fight
// on — dark on a light ground (Cinder-4's sand, Vetra's snow, Eden's lawn),
// pale on a dark one (Thessaly's moss, Ferrum's basalt, the Hive's chitin).
// The hostile rim (SPEC-035 §4.1) stays inside it, so an enemy reads as its
// hue band with an edge round it, and the player as a body with an edge.
//
// One fresnel band per fragment, mixed into the lit colour just before three
// writes it: no draw call, no extra pass, one program per material as before.
// The colours are two shared uniforms the surface sets once per visit, from
// the planet's ground, so nothing compiles when a planet changes.
import * as THREE from 'three';

/**
 * §4.1 (*initial tuning*): the band runs from this facing ratio to the
 * silhouette — `f = 1 − n·v`, 0 facing the camera, 1 edge-on — so only the
 * outermost tenth of a rounded body takes it.
 */
export const EDGE_START = 0.6;
export const EDGE_END = 0.86;
/**
 * §4.1: a ground at or above this relative luminance (WCAG's, of the
 * palette's `ground`) takes the dark edge; below it, the pale one.
 */
export const LIGHT_GROUND = 0.15;
/** §4.1: the dark edge is the theme's `--ground`, the same dark V-02 put round the telegraphs. */
export const EDGE_DARK = '#0b0f14';
/** §4.1: the player's pale edge, a cool white; the enemies', a warm one off the rim. */
export const PLAYER_EDGE_PALE = '#e3f0ff';
export const HOSTILE_EDGE_PALE = '#ffe0d4';
/** §4.1 (*initial tuning*): how far the band pulls toward its colour — the dark further than the pale. */
export const EDGE_DARK_MIX = 0.85;
export const EDGE_PALE_MIX = 0.6;

export type EdgeTone = 'dark' | 'pale';

/** WCAG relative luminance of a `#rrggbb` colour. */
export function relativeLuminance(hex: string): number {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (match === null) throw new Error(`not a #rrggbb colour: ${hex}`);
  const n = Number.parseInt(match[1] as string, 16);
  const channel = (c: number): number => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

/** §4.1: the edge a ground asks for — dark on a light ground, pale on a dark one. */
export function edgeTone(groundHex: string): EdgeTone {
  return relativeLuminance(groundHex) >= LIGHT_GROUND ? 'dark' : 'pale';
}

/**
 * The two edges as shared uniforms — `rgb` the colour in working space, `a`
 * the mix. Every patched material's `uPlayerEdge` / `uHostileEdge` *is* one of
 * these objects, so `setFigureEdges` reaches them all on the next frame.
 */
export const PLAYER_EDGE_UNIFORM: { value: THREE.Vector4 } = { value: new THREE.Vector4(0, 0, 0, 0) };
export const HOSTILE_EDGE_UNIFORM: { value: THREE.Vector4 } = { value: new THREE.Vector4(0, 0, 0, 0) };

const scratch = new THREE.Color();

function write(target: THREE.Vector4, hex: string, mix: number): void {
  scratch.set(hex);
  target.set(scratch.r, scratch.g, scratch.b, mix);
}

/** §4.1: the surface calls this on enter with the planet's palette ground. */
export function setFigureEdges(groundHex: string): EdgeTone {
  const tone = edgeTone(groundHex);
  if (tone === 'dark') {
    write(PLAYER_EDGE_UNIFORM.value, EDGE_DARK, EDGE_DARK_MIX);
    write(HOSTILE_EDGE_UNIFORM.value, EDGE_DARK, EDGE_DARK_MIX);
  } else {
    write(PLAYER_EDGE_UNIFORM.value, PLAYER_EDGE_PALE, EDGE_PALE_MIX);
    write(HOSTILE_EDGE_UNIFORM.value, HOSTILE_EDGE_PALE, EDGE_PALE_MIX);
  }
  return tone;
}

/** §4.1: no edge at all — below ground, where SPEC-054's dark is the point. */
export function clearFigureEdges(): void {
  PLAYER_EDGE_UNIFORM.value.w = 0;
  HOSTILE_EDGE_UNIFORM.value.w = 0;
}

/** A GLSL float literal — `3` on its own is an int and will not compile. */
function glsl(value: number): string {
  return value.toFixed(6);
}

/**
 * §4.1: the band, mixed into `outgoingLight` before `<opaque_fragment>` writes
 * it. `scale` is a GLSL expression the mix is multiplied by — `1.0`, or a
 * blink's opacity — and `edge` the uniform's name.
 */
export function figureEdgeChunk(edge: string, scale = '1.0'): string {
  return `
  float figureEdge = smoothstep( ${glsl(EDGE_START)}, ${glsl(EDGE_END)}, 1.0 - saturate( dot( normal, normalize( vViewPosition ) ) ) );
  outgoingLight = mix( outgoingLight, ${edge}.rgb, figureEdge * ${edge}.a * ${scale} );
  #include <opaque_fragment>`;
}
