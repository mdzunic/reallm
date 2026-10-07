// PLAN R28 / SPEC-067 — the surface dressing: rubble, the biome dressing kinds
// and the landing site. Placement is checked on the pinned layouts (seed
// 20121) of every planet, where the keepouts have real POIs, nodes, shelters
// and corridors to measure from; the geometry kit in isolation.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildHeightField } from '@/core/HeightField';
import { RngRoot } from '@/core/Rng';
import { PLANETS, type PlanetId } from '@/data/index';
import type { DressingKind } from '@/data/ids';
import { generateLayout } from '@/systems/Layout';
import {
  DRESSING,
  DRESSING_GLOW,
  LANDING_RING,
  RUBBLE_SIZE,
  buildLandingSite,
  createDressingMaterial,
  dressingGeometry,
  placeDressing,
  placeRubble,
  rubbleGeometry,
} from '@/views/Dressing';
import type { ViewLayout } from '@/views/SurfaceView';

const IDS = Object.keys(PLANETS) as PlanetId[];

const worlds = new Map<PlanetId, { layout: ViewLayout; field: ReturnType<typeof buildHeightField> }>();
function world(id: PlanetId): { layout: ViewLayout; field: ReturnType<typeof buildHeightField> } {
  let entry = worlds.get(id);
  if (entry === undefined) {
    const def = PLANETS[id];
    const layout = generateLayout(def, new RngRoot(20121).layout(id));
    const field = buildHeightField({ halfSize: layout.halfSize, hash: layout.hash, pois: layout.pois }, def.surface.look.relief);
    entry = { layout, field };
    worlds.set(id, entry);
  }
  return entry;
}

const scratch = new THREE.Matrix4();
const position = new THREE.Vector3();
const quaternion = new THREE.Quaternion();
const scale = new THREE.Vector3();

function instances(matrices: Float32Array): { x: number; y: number; z: number; sx: number; sy: number; sz: number }[] {
  const out: { x: number; y: number; z: number; sx: number; sy: number; sz: number }[] = [];
  for (let i = 0; i < matrices.length / 16; i++) {
    scratch.fromArray(matrices, i * 16).decompose(position, quaternion, scale);
    out.push({ x: position.x, y: position.y, z: position.z, sx: scale.x, sy: scale.y, sz: scale.z });
  }
  return out;
}

function triangles(geometry: THREE.BufferGeometry): number {
  return (geometry.index?.count ?? (geometry.getAttribute('position') as THREE.BufferAttribute).count) / 3;
}

/** Distance from (x, z) to the segment from the origin to (bx, bz). */
function lineDistance(x: number, z: number, bx: number, bz: number): number {
  const length2 = bx * bx + bz * bz;
  const t = Math.min(1, Math.max(0, (x * bx + z * bz) / length2));
  return Math.hypot(x - bx * t, z - bz * t);
}

describe('the dressing material (SPEC-067)', () => {
  it('is one white, vertex-coloured MeshStandardMaterial whose emissive the per-vertex glow masks', () => {
    const material = createDressingMaterial();
    expect(material.type).toBe('MeshStandardMaterial');
    expect(material.vertexColors).toBe(true);
    expect(material.color.getHex()).toBe(0xffffff);
    expect(material.emissiveIntensity).toBe(DRESSING_GLOW);
    expect(material.customProgramCacheKey()).toBe('dressing/1');
    const shader = {
      uniforms: {},
      vertexShader: '#include <common>\n#include <begin_vertex>',
      fragmentShader: '#include <common>\n#include <emissivemap_fragment>',
    };
    material.onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, undefined as unknown as THREE.WebGLRenderer);
    expect(shader.vertexShader).toContain('attribute float glow;');
    expect(shader.fragmentShader).toContain('totalEmissiveRadiance *= vGlow * vColor.rgb;');
  });
});

describe('the geometry kit (SPEC-067)', () => {
  it('a rubble stone is an 80-triangle rock of radius ≈ 1 with colour and glow', () => {
    const rock = rubbleGeometry();
    expect(triangles(rock)).toBe(80);
    expect(rock.boundingSphere?.radius).toBeLessThan(1.5);
    expect(rock.getAttribute('color')).toBeDefined();
    expect(rock.getAttribute('glow')).toBeDefined();
  });

  it('every kind is position, normal, colour and glow, ≤ 700 triangles, under 2.2 m and off the ground by no more than it sinks', () => {
    for (const kind of Object.keys(DRESSING) as DressingKind[]) {
      const geometry = dressingGeometry(kind, 7);
      expect(Object.keys(geometry.attributes).sort(), kind).toEqual(['color', 'glow', 'normal', 'position']);
      expect(triangles(geometry), kind).toBeLessThanOrEqual(700);
      geometry.computeBoundingBox();
      const box = geometry.boundingBox as THREE.Box3;
      expect(box.max.y, kind).toBeLessThanOrEqual(2.2);
      expect(box.min.y, kind).toBeLessThanOrEqual(0.05); // it stands on, or in, the ground
    }
  });

  it('the lit kinds glow and the rest do not', () => {
    const lit = new Set<DressingKind>(['ice_shards', 'frozen_pipe', 'lava_blobs', 'glow_pods', 'resin_mound', 'marker_post']);
    for (const kind of Object.keys(DRESSING) as DressingKind[]) {
      const glow = dressingGeometry(kind, 7).getAttribute('glow') as THREE.BufferAttribute;
      let any = false;
      for (let i = 0; i < glow.count; i++) if (glow.getX(i) > 0) any = true;
      expect(any, kind).toBe(lit.has(kind));
    }
  });

  it('is deterministic from its seed', () => {
    for (const kind of Object.keys(DRESSING) as DressingKind[]) {
      const a = dressingGeometry(kind, 11).getAttribute('position') as THREE.BufferAttribute;
      const b = dressingGeometry(kind, 11).getAttribute('position') as THREE.BufferAttribute;
      expect(a.array, kind).toEqual(b.array);
    }
  });
});

describe('placeRubble (SPEC-067)', () => {
  it('is deterministic, halves on low, and stays inside the size band, on the ground, inside the wall', () => {
    for (const id of IDS) {
      const { layout, field } = world(id);
      const look = PLANETS[id].surface.look.dressing;
      const medium = placeRubble(layout, field, look, PLANETS[id].biome, 'medium');
      const again = placeRubble(layout, field, look, PLANETS[id].biome, 'medium');
      expect(again.matrices, id).toEqual(medium.matrices);
      expect(medium.count, id).toBeGreaterThan(1000);
      expect(medium.colors.length, id).toBe(medium.count * 3);
      const low = placeRubble(layout, field, look, PLANETS[id].biome, 'low');
      expect(low.count / medium.count, id).toBeGreaterThan(0.4);
      expect(low.count / medium.count, id).toBeLessThan(0.6);
      for (const stone of instances(medium.matrices)) {
        expect(Math.max(stone.sx, stone.sy, stone.sz)).toBeLessThanOrEqual(RUBBLE_SIZE[1] * 1.6 * 1.25 + 1e-6);
        expect(Math.min(stone.sx, stone.sy, stone.sz)).toBeGreaterThan(0);
        expect(stone.y).toBeLessThanOrEqual(field.heightAt(stone.x, stone.z) + 1e-5); // sunk, never floating
        // At most on the wall's inner face (1.4 m inside halfSize) — a corner stone lies against the next wall.
        expect(Math.max(Math.abs(stone.x), Math.abs(stone.z))).toBeLessThanOrEqual(layout.halfSize - 1.4 + 1e-3);
      }
    }
  });

  it('keeps out of the pad clearing, the objectives’ rings and the nodes; rings a landmark', () => {
    for (const id of IDS) {
      const { layout, field } = world(id);
      const stones = instances(placeRubble(layout, field, PLANETS[id].surface.look.dressing, PLANETS[id].biome, 'medium').matrices);
      for (const stone of stones) {
        expect(Math.hypot(stone.x, stone.z), id).toBeGreaterThanOrEqual(15);
        for (const poi of layout.pois) {
          if (poi.kind === 'landing_pad' || poi.kind === 'landmark') continue;
          expect(Math.hypot(stone.x - poi.x, stone.z - poi.z), `${id} ${poi.kind}`).toBeGreaterThanOrEqual(poi.radius);
        }
        for (const node of layout.nodes) expect(Math.hypot(stone.x - node.x, stone.z - node.z), id).toBeGreaterThanOrEqual(1.5);
      }
      const landmark = layout.pois.find((poi) => poi.kind === 'landmark');
      if (landmark !== undefined) {
        const skirt = stones.filter((stone) => Math.hypot(stone.x - landmark.x, stone.z - landmark.z) < 9);
        expect(skirt.length, id).toBeGreaterThanOrEqual(8);
      }
    }
  });
});

describe('placeDressing (SPEC-067)', () => {
  it('lays every kind of every planet, deterministically, fewer on low', () => {
    for (const id of IDS) {
      const { layout, field } = world(id);
      const kinds = PLANETS[id].surface.look.dressing.kinds;
      const medium = placeDressing(layout, field, kinds, 'medium');
      expect(medium, id).toHaveLength(3);
      expect(placeDressing(layout, field, kinds, 'medium').map((p) => p.matrices)).toEqual(medium.map((p) => p.matrices));
      const low = placeDressing(layout, field, kinds, 'low');
      medium.forEach((placed, k) => {
        expect(placed.count, `${id} ${kinds[k]}`).toBeGreaterThan(5);
        expect((low[k] as (typeof low)[number]).count, `${id} ${kinds[k]}`).toBeLessThan(placed.count);
      });
    }
  });

  it('keeps every piece off the pad clearing, the POI rings, the nodes, the obstacles, the other pieces and the walking lines', () => {
    for (const id of IDS) {
      const { layout, field } = world(id);
      const kinds = PLANETS[id].surface.look.dressing.kinds;
      const lines = layout.pois.filter((poi) => poi.kind !== 'landing_pad' && poi.kind !== 'landmark');
      const all: { x: number; z: number; foot: number }[] = [];
      placeDressing(layout, field, kinds, 'medium').forEach((placed, k) => {
        const spec = DRESSING[kinds[k] as DressingKind];
        for (const piece of instances(placed.matrices)) {
          const foot = spec.footprint * piece.sx;
          const where = `${id} ${kinds[k]} at ${piece.x.toFixed(1)}, ${piece.z.toFixed(1)}`;
          expect(Math.hypot(piece.x, piece.z), where).toBeGreaterThanOrEqual(16);
          for (const poi of layout.pois) {
            if (poi.kind === 'landing_pad') continue;
            expect(Math.hypot(piece.x - poi.x, piece.z - poi.z), where).toBeGreaterThanOrEqual(poi.radius + 2);
          }
          for (const node of layout.nodes) expect(Math.hypot(piece.x - node.x, piece.z - node.z), where).toBeGreaterThanOrEqual(2.5);
          for (const o of layout.obstacles) expect(Math.hypot(piece.x - o.x, piece.z - o.z), where).toBeGreaterThanOrEqual(o.radius);
          for (const line of lines) {
            expect(lineDistance(piece.x, piece.z, line.x, line.z), where).toBeGreaterThanOrEqual(spec.corridor + spec.footprint - 1e-6);
          }
          expect(piece.y).toBeCloseTo(field.heightAt(piece.x, piece.z), 5);
          for (const other of all) expect(Math.hypot(piece.x - other.x, piece.z - other.z), where).toBeGreaterThan(0.5 * (foot + other.foot));
          all.push({ x: piece.x, z: piece.z, foot });
        }
      });
    }
  });
});

describe('buildLandingSite (SPEC-067, review V-01)', () => {
  it('spreads the kit round the pad, never inside the slab, and keeps it off the spawn point', () => {
    for (const id of IDS) {
      const { layout, field } = world(id);
      const site = buildLandingSite(layout, field);
      expect(site, id).not.toBeNull();
      const geometry = site as THREE.BufferGeometry;
      expect(triangles(geometry), id).toBeLessThanOrEqual(3_000);
      const at = geometry.getAttribute('position') as THREE.BufferAttribute;
      const spawn = generateLayout(PLANETS[id], new RngRoot(20121).layout(id)).playerSpawn;
      let nearest = Infinity;
      let lit = 0;
      const glow = geometry.getAttribute('glow') as THREE.BufferAttribute;
      for (let i = 0; i < at.count; i++) {
        const d = Math.hypot(at.getX(i), at.getZ(i));
        expect(d, id).toBeGreaterThanOrEqual(5.4); // the slab's rim, where the cables start
        expect(d, id).toBeLessThanOrEqual(LANDING_RING[1] + 2.5);
        // Cables lie on the ground; only the stations stand up.
        if (at.getY(i) > 0.15) nearest = Math.min(nearest, Math.hypot(at.getX(i) - spawn.x, at.getZ(i) - spawn.z));
        if (glow.getX(i) > 0) lit++;
      }
      expect(nearest, id).toBeGreaterThan(1.5);
      expect(lit, id).toBeGreaterThan(0); // the lamps and the generator
      expect((buildLandingSite(layout, field) as THREE.BufferGeometry).getAttribute('position').array).toEqual(at.array);
    }
  });
});
