// SPEC-018 AC (props): part counts and triangle caps per kind and biome, the
// GLB seam's precedence and colour baking — the budget maths of §4.11 starts
// from these caps, so they pin.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { Assets } from '@/core/Assets';
import {
  PROP_MODELS,
  boundaryGeometry,
  geometryFromModel,
  obstacleGeometry,
  poiGeometry,
  type Biome,
  type ObstacleKind,
} from '@/views/SurfaceProps';

function tris(geometry: THREE.BufferGeometry): number {
  return (geometry.getAttribute('position') as THREE.BufferAttribute).count / 3;
}

/** Every biome × kind pair the layouts can produce, with its §4.7 shape. */
const OBSTACLES: ReadonlyArray<readonly [Biome, ObstacleKind, number, boolean]> = [
  ['desert', 'rock', 320, false],
  ['desert', 'ruin', 240, false],
  ['ice', 'rock', 320, false],
  ['ice', 'spire', 200, true],
  ['jungle', 'tree', 300, false],
  ['jungle', 'ruin', 240, false],
  ['volcanic', 'rock', 320, false],
  ['volcanic', 'vent', 160, true],
  ['hive', 'spire', 200, true],
  ['hive', 'rock', 320, false],
  ['temperate', 'tree', 300, false],
  ['temperate', 'rock', 320, false],
];

describe('obstacleGeometry (SPEC-018 §4.7)', () => {
  it('every biome pair stays under its triangle cap, with the pinned glow parts', () => {
    for (const [biome, kind, cap, hasGlow] of OBSTACLES) {
      const prop = obstacleGeometry(kind, biome, 7);
      expect(tris(prop.body), `${biome}:${kind}`).toBeLessThanOrEqual(cap);
      expect(prop.body.getAttribute('color'), `${biome}:${kind} colours`).toBeDefined();
      expect(prop.glow !== undefined, `${biome}:${kind} glow`).toBe(hasGlow);
      if (prop.glow !== undefined) expect(tris(prop.glow)).toBeLessThanOrEqual(300);
    }
  });

  it('small rocks are the 80-triangle variant', () => {
    expect(tris(obstacleGeometry('rock', 'desert', 7, undefined, true).body)).toBeLessThanOrEqual(80);
  });

  it('is deterministic per seed and varies across seeds', () => {
    const a = obstacleGeometry('rock', 'desert', 11).body.getAttribute('position') as THREE.BufferAttribute;
    const b = obstacleGeometry('rock', 'desert', 11).body.getAttribute('position') as THREE.BufferAttribute;
    const c = obstacleGeometry('rock', 'desert', 12).body.getAttribute('position') as THREE.BufferAttribute;
    expect(b.array).toEqual(a.array);
    expect(c.array).not.toEqual(a.array);
  });
});

describe('the GLB seam (SPEC-018 §4.10, 18-n, 18-o)', () => {
  function crateModel(): THREE.Group {
    const group = new THREE.Group();
    const red = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ color: '#ff0000' }),
    );
    red.position.set(2, 0.5, 0);
    const glow = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), new THREE.MeshStandardMaterial({ color: '#00ff00' }));
    glow.material.name = 'Glow';
    glow.position.set(0, 1.5, 0);
    group.add(red, glow);
    return group;
  }

  const fakeAssets = (loaded: boolean): Assets =>
    ({ hasModel: () => loaded, model: () => crateModel() }) as unknown as Assets;

  it('every biome:kind pair names its _a model', () => {
    for (const [biome, kind] of OBSTACLES) {
      expect(PROP_MODELS[`${biome}:${kind}`], `${biome}:${kind}`).toBe(`${biome}_${kind}_a`);
    }
  });

  it('PROP_MODELS wins when the assets are loaded, and splits the Glow part', () => {
    const fromModel = obstacleGeometry('rock', 'desert', 7, fakeAssets(true));
    expect(fromModel.fromModel).toBe(true);
    expect(tris(fromModel.body)).toBe(12); // the one-box body, not the icosphere
    expect(fromModel.glow).toBeDefined();
    expect(tris(fromModel.glow as THREE.BufferGeometry)).toBe(12);
  });

  it('falls back to procedural when the drop has not landed (18-o)', () => {
    const procedural = obstacleGeometry('rock', 'desert', 7, fakeAssets(false));
    expect(procedural.fromModel).toBeUndefined();
    expect(tris(procedural.body)).toBeGreaterThan(12);
  });

  it('geometryFromModel bakes world transforms and material colours', () => {
    const merged = geometryFromModel(crateModel());
    const position = merged.getAttribute('position') as THREE.BufferAttribute;
    const color = merged.getAttribute('color') as THREE.BufferAttribute;
    expect(position.count / 3).toBe(24); // both boxes, merged
    let maxX = -Infinity;
    let sawRed = false;
    let sawGreen = false;
    for (let i = 0; i < position.count; i++) {
      maxX = Math.max(maxX, position.getX(i));
      if (color.getX(i) > 0.9 && color.getY(i) < 0.1) sawRed = true;
      if (color.getY(i) > 0.9 && color.getX(i) < 0.1) sawGreen = true;
    }
    expect(maxX).toBeCloseTo(2.5, 5); // the red box's world-space corner
    expect(sawRed).toBe(true);
    expect(sawGreen).toBe(true);
  });

  it('deliver POIs use the crate model when assets are loaded, a box otherwise', () => {
    const withAssets = poiGeometry('deliver', 'desert', fakeAssets(true));
    expect(withAssets.fromModel).toBe(true);
    const without = poiGeometry('deliver', 'desert');
    expect(without.fromModel).toBeUndefined();
    expect(tris(without.body)).toBe(12);
  });
});

describe('poiGeometry and boundaryGeometry (SPEC-018 §4.7, §4.8)', () => {
  it('builds every POI kind for every biome, inside the shared-arena budget', () => {
    const kinds = ['landing_pad', 'scan', 'reach', 'deliver', 'arena', 'defend', 'escort_start', 'landmark'] as const;
    const biomes: Biome[] = ['desert', 'ice', 'jungle', 'volcanic', 'hive', 'temperate'];
    for (const kind of kinds) {
      for (const biome of biomes) {
        const poi = poiGeometry(kind, biome);
        expect(tris(poi.body), `${kind}:${biome}`).toBeGreaterThan(0);
        expect(tris(poi.body), `${kind}:${biome}`).toBeLessThanOrEqual(840); // ≤ 12 POIs → ≤ 10 k
        expect(poi.body.getAttribute('color'), `${kind}:${biome}`).toBeDefined();
      }
    }
    // The emissive fixtures of §4.7 keep their glow parts.
    expect(poiGeometry('landing_pad', 'desert').glow).toBeDefined();
    expect(poiGeometry('scan', 'desert').glow).toBeDefined();
    expect(poiGeometry('arena', 'volcanic').glow).toBeDefined();
    expect(poiGeometry('landmark', 'volcanic').glow).toBeDefined();
    expect(poiGeometry('defend', 'desert').glow).toBeDefined();
  });

  it('builds every boundary kind under the ring budget (≈ 120 tris/instance)', () => {
    for (const kind of ['dunes', 'ice_wall', 'jungle_bank', 'lava_ridge', 'chitin_wall', 'hills'] as const) {
      const geometry = boundaryGeometry(kind);
      expect(tris(geometry), kind).toBeGreaterThan(0);
      expect(tris(geometry), kind).toBeLessThanOrEqual(200);
      expect(geometry.getAttribute('color'), kind).toBeDefined();
    }
  });
});
