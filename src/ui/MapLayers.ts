// The two cached canvases both maps draw from (SPEC-026 §4.4). One is the
// planet's ground in its own palette — built once per visit, world-aligned at
// 1 px = 1 m — and the other is the fog over it, which a reveal punches 4 m
// squares out of.
//
// Why canvases and not paths: a repaint of either map is then two `drawImage`
// calls under the §4.1 transform, whatever the arena holds, and a reveal costs
// a handful of `clearRect`s instead of a rebuild. `terrainBuilds` is the debug
// counter that proves the first half of that (§4.8).
import type { ExploreMask } from '@/systems/Exploration';
import type { Layout } from '@/systems/Layout';
import { MAP_YAW } from '@/systems/MapModel';
import { exploreGridSize, EXPLORE_CELL } from '@/core/Save';

/** §4.4: the unexplored ground, over everything the player has not walked. */
export const FOG_COLOR = 'rgba(5, 7, 11, 0.92)';
/** The ground fill, dimmed so icons and the fog edge both read over it. */
const GROUND_SHADE = 0.55;
/** Obstacles are the same ground, darker — a map of cover, not of rocks. */
const OBSTACLE_SHADE = 0.3;
/** A POI plate is the planet's accent, dimmed; the pad and the arena override it. */
const PLATE_SHADE = 0.45;
const PAD_PLATE = '#1d4a55';
const ARENA_PLATE = '#4a1f1f';
/** §4.4: the arena wall, along `±(halfSize − 2)`. */
const WALL_COLOR = '#11151a';
const WALL_WIDTH = 3;
/** SPEC-030 §4.10: shelter footprints ride lighter than the ground. */
const SHELTER_RING_SHADE = 0.9;

/** `'#rrggbb'` scaled toward black — the one colour operation the layers need. */
export function shade(hex: string, factor: number): string {
  const value = Number.parseInt(hex.slice(1), 16);
  const r = Math.round((((value >> 16) & 0xff) * factor));
  const g = Math.round((((value >> 8) & 0xff) * factor));
  const b = Math.round(((value & 0xff) * factor));
  return `rgb(${r}, ${g}, ${b})`;
}

/** True where the browser can blur a `drawImage`; the fog edge reads soft there. */
function supportsFilter(ctx: CanvasRenderingContext2D): boolean {
  return typeof (ctx as { filter?: unknown }).filter === 'string';
}

function canvasOf(size: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  return canvas;
}

export class MapLayers {
  /** World-aligned, 1 px = 1 m, `2 · halfSize` square: world (x, z) → px (x + half, z + half). */
  readonly terrain: HTMLCanvasElement;
  /** The same square, dark where the ground has not been walked. */
  readonly fog: HTMLCanvasElement;
  readonly halfSize: number;
  readonly #fogCtx: CanvasRenderingContext2D | null;
  /** Cells per axis, so a revealed index maps back to its square. */
  readonly #cells: number;
  #builds = 0;

  constructor(layout: Layout, palette: { ground: string; accent: string }) {
    const half = layout.halfSize;
    this.halfSize = half;
    const size = Math.round(half * 2);
    this.#cells = exploreGridSize(half);
    this.terrain = canvasOf(size);
    this.fog = canvasOf(size);
    this.#fogCtx = this.fog.getContext('2d');
    this.#buildTerrain(layout, palette, size);
    this.#fillFog();
  }

  /** How many times the terrain was painted; it stays 1 through a visit (§4.8). */
  get terrainBuilds(): number {
    return this.#builds;
  }

  /** A full fog repaint: dark everywhere, cleared over every explored cell. */
  syncFog(mask: ExploreMask): void {
    const ctx = this.#fogCtx;
    if (ctx === null) return;
    this.#fillFog();
    // The same square `reveal` clears: a grid whose last column runs a little
    // past the canvas is clipped by the canvas, never misaligned against it.
    for (let iz = 0; iz < mask.n; iz++) {
      for (let ix = 0; ix < mask.n; ix++) {
        if (mask.isExplored(ix, iz)) ctx.clearRect(ix * EXPLORE_CELL, iz * EXPLORE_CELL, EXPLORE_CELL, EXPLORE_CELL);
      }
    }
  }

  /** §4.4: a reveal repaints only its own squares — never the whole layer. */
  reveal(indices: Int32Array, count: number, cell: number): void {
    const ctx = this.#fogCtx;
    if (ctx === null) return;
    const n = this.#cells;
    for (let i = 0; i < count; i++) {
      const index = indices[i] as number;
      const ix = index % n;
      const iz = (index - ix) / n;
      ctx.clearRect(ix * cell, iz * cell, cell, cell);
    }
  }

  #fillFog(): void {
    const ctx = this.#fogCtx;
    if (ctx === null) return;
    const size = this.fog.width;
    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = FOG_COLOR;
    ctx.fillRect(0, 0, size, size);
  }

  /** §4.4: ground, obstacles, POI plates, the arena wall — once per visit. */
  #buildTerrain(layout: Layout, palette: { ground: string; accent: string }, size: number): void {
    const ctx = this.terrain.getContext('2d');
    if (ctx === null) return;
    this.#builds++;
    const half = this.halfSize;

    ctx.fillStyle = shade(palette.ground, GROUND_SHADE);
    ctx.fillRect(0, 0, size, size);

    // One path for every obstacle: a map of where the ground is not walkable.
    ctx.fillStyle = shade(palette.ground, OBSTACLE_SHADE);
    ctx.beginPath();
    for (const obstacle of layout.obstacles) {
      ctx.moveTo(obstacle.x + half + obstacle.radius, obstacle.z + half);
      ctx.arc(obstacle.x + half, obstacle.z + half, obstacle.radius, 0, Math.PI * 2);
    }
    ctx.fill();

    const plate = shade(palette.accent, PLATE_SHADE);
    for (const poi of layout.pois) {
      ctx.fillStyle = poi.kind === 'landing_pad' ? PAD_PLATE : poi.kind === 'arena' ? ARENA_PLATE : plate;
      ctx.beginPath();
      ctx.arc(poi.x + half, poi.z + half, poi.radius * 0.8, 0, Math.PI * 2);
      ctx.fill();
    }

    // SPEC-030 §4.10: each shelter footprint as a lighter ring.
    ctx.strokeStyle = shade(palette.ground, SHELTER_RING_SHADE);
    ctx.lineWidth = 1.5;
    for (const shelter of layout.shelters) {
      ctx.beginPath();
      ctx.ellipse(shelter.x + half, shelter.z + half, shelter.rx, shelter.rz, shelter.angle, 0, Math.PI * 2);
      ctx.stroke();
    }

    // The wall line, along ±(halfSize − 2) — where SPEC-030's wall stands.
    ctx.strokeStyle = WALL_COLOR;
    ctx.lineWidth = WALL_WIDTH;
    ctx.strokeRect(2, 2, size - 4, size - 4);
  }
}

/** Where a map's layers go: the canvas centre, the metres it shows per px, the world point under it. */
export interface LayerView {
  centreX: number;
  centreZ: number;
  cx: number;
  cy: number;
  pxPerMetre: number;
  /** Fog blur in px, when the browser supports a canvas filter (§4.4). */
  blur: number;
}

/**
 * §4.1: `translate(centre) · rotate(π/4) · scale(pxPerMetre) · translate(−view)`
 * — the transform that puts the terrain and the fog on exactly the pixels
 * `mapProject` sends the icons to. Both painters draw their ground through it.
 */
export function drawMapLayers(ctx: CanvasRenderingContext2D, layers: MapLayers, view: LayerView): void {
  const half = layers.halfSize;
  const size = half * 2;
  ctx.save();
  ctx.translate(view.cx, view.cy);
  ctx.rotate(MAP_YAW);
  ctx.scale(view.pxPerMetre, view.pxPerMetre);
  ctx.translate(-view.centreX, -view.centreZ);
  ctx.drawImage(layers.terrain, -half, -half, size, size);
  if (view.blur > 0 && supportsFilter(ctx)) {
    ctx.filter = `blur(${view.blur}px)`;
    ctx.drawImage(layers.fog, -half, -half, size, size);
    ctx.filter = 'none';
  } else {
    ctx.drawImage(layers.fog, -half, -half, size, size);
  }
  ctx.restore();
}
