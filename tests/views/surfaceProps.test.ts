// SPEC-018 AC (props): part counts and triangle caps per kind and biome, the
// GLB seam's precedence and colour baking — the budget maths of §4.11 starts
// from these caps, so they pin.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { Assets } from '@/core/Assets';
import { hash32 } from '@/core/Rng';
import {
  LANDMARK_FOOTPRINT,
  LANDMARK_MODELS,
  LANDMARK_SCALE,
  ORCHARD_MODEL,
  PROP_MODELS,
  foliageAtlas,
  foliageFromModel,
  SHELTER_MODELS,
  boundaryGeometry,
  geometryFromModel,
  hullPieceGeometry,
  isTreeContract,
  obstacleGeometry,
  obstacleModelIds,
  poiGeometry,
  propFromModel,
  shelterGeometry,
  variantIndex,
  wallPieceGeometry,
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

  it('every biome:kind pair names its variants in order: _a, _b, then a non-tree kind’s _c (SPEC-046 §4.2, SPEC-053 §4.1)', () => {
    // SPEC-053 §4.1 moved this table: the ten non-tree kinds gained their _c
    // as a third variant, the jungle's trees are a, b and c, and the temperate
    // trees stay a and b — their _c is ORCHARD_MODEL, which only orchards draw.
    for (const [biome, kind] of OBSTACLES) {
      const expected =
        biome === 'temperate' && kind === 'tree'
          ? ['temperate_tree_a', 'temperate_tree_b']
          : [`${biome}_${kind}_a`, `${biome}_${kind}_b`, `${biome}_${kind}_c`];
      expect(PROP_MODELS[`${biome}:${kind}`], `${biome}:${kind}`).toEqual(expected);
    }
    expect(PROP_MODELS['jungle:tree']).toEqual(['jungle_tree_a', 'jungle_tree_b', 'jungle_tree_c']);
    expect(ORCHARD_MODEL).toBe('temperate_tree_c');
    expect(Object.values(PROP_MODELS).some((ids) => ids?.includes(ORCHARD_MODEL))).toBe(false);
    expect(Object.keys(PROP_MODELS)).toHaveLength(12);
    // The collision-only kinds never look a model up (SPEC-030 D-19).
    expect(obstacleModelIds('wreck_hull', 'desert')).toEqual([]);
    expect(obstacleModelIds('spire', 'desert')).toEqual([]);
  });

  it('PROP_MODELS wins when the assets are loaded, and splits the Glow part', () => {
    const fromModel = obstacleGeometry('rock', 'desert', 7, fakeAssets(true));
    expect(fromModel.fromModel).toBe(true);
    expect(tris(fromModel.body)).toBe(12); // the one-box body, not the icosphere
    expect(fromModel.glow).toBeDefined();
    expect(tris(fromModel.glow as THREE.BufferGeometry)).toBe(12);
  });

  it('takes the first loaded variant when only the second has landed (46-b)', () => {
    const second = { hasModel: (id: string) => id === 'desert_rock_b', model: () => crateModel() } as unknown as Assets;
    const prop = obstacleGeometry('rock', 'desert', 7, second);
    expect(prop.fromModel).toBe(true);
    expect(tris(prop.body)).toBe(12);
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

// ---------------------------------------------------------------- SPEC-046

describe('variants and the tree contract (SPEC-046 §4.1, §4.2)', () => {
  it('variantIndex is hash32(layoutHash, "variant", kind, index) % n — deterministic and in range', () => {
    for (const [hash, kind, index, n] of [
      [0x18a7c3d1, 'rock', 0, 2],
      [0x18a7c3d1, 'rock_small', 41, 2],
      [3559157477, 'ruin', 7, 3],
    ] as const) {
      const v = variantIndex(hash, kind, index, n);
      expect(v).toBe(hash32(hash, 'variant', kind, index) % n);
      expect(variantIndex(hash, kind, index, n)).toBe(v);
      expect(Number.isInteger(v) && v >= 0 && v < n).toBe(true);
    }
    // The layout kind string is part of the key: an obstacle and a small prop
    // at the same index pick independently.
    let differ = 0;
    for (let i = 0; i < 64; i++) if (variantIndex(99, 'rock', i, 2) !== variantIndex(99, 'rock_small', i, 2)) differ++;
    expect(differ).toBeGreaterThan(0);
  });

  it('over 1,000 indices, two variants each take 40–60 %', () => {
    for (const [hash, kind] of [
      [0x5eed0046, 'rock'],
      [2630545287, 'tree_small'],
    ] as const) {
      let b = 0;
      for (let i = 0; i < 1_000; i++) b += variantIndex(hash, kind, i, 2);
      expect(b, `${kind} _b share`).toBeGreaterThanOrEqual(400);
      expect(b, `${kind} _b share`).toBeLessThanOrEqual(600);
    }
  });

  /** SPEC-052's tree contract: a trunk, an LOD1 copy and the leaf cards. */
  function treeModel(lod: boolean): THREE.Group {
    const group = new THREE.Group();
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.3, 2, 6), new THREE.MeshStandardMaterial());
    trunk.name = 'Trunk';
    group.add(trunk);
    const other = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshStandardMaterial());
    other.name = lod ? 'Tree_LOD1' : 'Leaf';
    group.add(other);
    return group;
  }

  it('isTreeContract is true for a group with a Leaf or *_LOD1 node, false for a crate', () => {
    expect(isTreeContract(treeModel(false))).toBe(true);
    expect(isTreeContract(treeModel(true))).toBe(true);
    const crate = new THREE.Group();
    const box = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
    box.name = 'Crate';
    crate.add(box);
    expect(isTreeContract(crate)).toBe(false);
    // A name that merely contains the word is not the contract.
    box.name = 'Leafless_LOD0';
    expect(isTreeContract(crate)).toBe(false);
  });

  it('propFromModel refuses a tree contract, and that kind draws procedurally (46-c)', () => {
    expect(propFromModel(treeModel(false))).toBeNull();
    const trees = { hasModel: () => true, model: () => treeModel(false) } as unknown as Assets;
    const prop = obstacleGeometry('tree', 'jungle', 7, trees);
    expect(prop.fromModel).toBeUndefined();
    expect(tris(prop.body)).toBe(tris(obstacleGeometry('tree', 'jungle', 7).body));
  });

  it('a landmark scales by 0.4 × its radius (SPEC-046 §4.3)', () => {
    expect(LANDMARK_SCALE).toBe(0.4);
    expect(LANDMARK_SCALE * 6).toBeCloseTo(2.4, 9);
    expect(LANDMARK_SCALE * 7).toBeCloseTo(2.8, 9);
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

// ---------------------------------------------------------------- SPEC-030

describe('SPEC-030 — shelterGeometry (AC-39, AC-42, AC-43)', () => {
  const BIOMES: readonly Biome[] = ['desert', 'ice', 'jungle', 'volcanic', 'hive', 'temperate'];

  it('returns body ≤ 1.6 k and roof ≤ 600 triangles for every biome and kind', () => {
    for (const biome of BIOMES) {
      for (const kind of ['cave', 'wreck'] as const) {
        const parts = shelterGeometry(kind, biome, 11);
        expect(tris(parts.body), `${biome}:${kind} body`).toBeLessThanOrEqual(1600);
        expect(tris(parts.roof), `${biome}:${kind} roof`).toBeLessThanOrEqual(600);
        expect(parts.body.getAttribute('color'), `${biome}:${kind} colours`).toBeDefined();
        if (parts.glow !== undefined) expect(tris(parts.glow)).toBeLessThanOrEqual(300);
      }
    }
  });

  it('the wreck body stays low, so the lifted roof leaves the player visible (AC-41)', () => {
    // Everything overhead — the dome, the ribs, the plates — must live in the
    // roof part `setOccupiedShelter` lifts; the body may keep only the low
    // far-side band (top edge ≈ 1.9 m plus ≤ 0.25 m of displacement), which
    // never reaches the 55° sightline over a player at the centre.
    for (const biome of BIOMES) {
      for (const seed of [3, 11, 29]) {
        const parts = shelterGeometry('wreck', biome, seed);
        parts.body.computeBoundingBox();
        parts.roof.computeBoundingBox();
        const bodyBox = parts.body.boundingBox as THREE.Box3;
        const roofBox = parts.roof.boundingBox as THREE.Box3;
        expect(bodyBox.max.y, `${biome} seed ${seed} body top`).toBeLessThanOrEqual(2.2);
        // …and it must actually stand above ground — a band buried in the
        // terrain would satisfy the cap while the shelter vanished.
        expect(bodyBox.max.y, `${biome} seed ${seed} body above ground`).toBeGreaterThan(1.5);
        expect(roofBox.max.y, `${biome} seed ${seed} roof top`).toBeGreaterThan(3);
      }
    }
  });

  it("Ferrum's cave and the Hive's carry a glow part; the wreck carries its console", () => {
    expect(shelterGeometry('cave', 'volcanic', 3).glow).toBeDefined();
    expect(shelterGeometry('cave', 'hive', 3).glow).toBeDefined();
    expect(shelterGeometry('cave', 'desert', 3).glow).toBeUndefined();
    expect(shelterGeometry('wreck', 'desert', 3).glow).toBeDefined();
  });

  it('SHELTER_MODELS ships empty and wins through geometryFromModel when it names a model (D-24)', () => {
    expect(SHELTER_MODELS).toEqual({});
    // Name a model: the seam takes the GLB path, exactly like PROP_MODELS.
    const cube = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshStandardMaterial({ color: '#ff0000' }));
    const root = new THREE.Group();
    root.add(cube);
    const assets = {
      hasModel: (id: string) => id === 'crate',
      model: () => root,
    } as unknown as Assets;
    SHELTER_MODELS['desert:cave'] = 'crate';
    try {
      const parts = shelterGeometry('cave', 'desert', 3, assets);
      expect(tris(parts.body)).toBe(12); // the cube, through geometryFromModel
    } finally {
      delete SHELTER_MODELS['desert:cave'];
    }
  });

  it('obstacleGeometry accepts the collision-only kinds and debris (D-19)', () => {
    // cave_wall and wreck_hull keep the switch exhaustive and return rock.
    expect(tris(obstacleGeometry('cave_wall', 'desert', 5).body)).toBeGreaterThan(0);
    expect(tris(obstacleGeometry('wreck_hull', 'ice', 5).body)).toBeGreaterThan(0);
    const debris = obstacleGeometry('debris', 'desert', 5);
    expect(tris(debris.body)).toBeGreaterThan(0);
    expect(tris(debris.body)).toBeLessThanOrEqual(200);
    expect(debris.body.getAttribute('color')).toBeDefined();
  });
});

describe('SPEC-030 — wall pieces (AC-35)', () => {
  const BOUNDARIES = ['dunes', 'ice_wall', 'jungle_bank', 'lava_ridge', 'chitin_wall', 'hills'] as const;

  it('rock pieces stay ≤ 140 triangles for every boundary kind and variant', () => {
    for (const kind of BOUNDARIES) {
      for (const variant of [0, 1, 2] as const) {
        const piece = wallPieceGeometry(kind, variant);
        expect(tris(piece), `${kind}:${variant}`).toBeLessThanOrEqual(140);
        expect(piece.getAttribute('color')).toBeDefined();
      }
    }
  });

  it('the inner face (z = 0) stays flat through the displacement', () => {
    const piece = wallPieceGeometry('dunes', 0);
    const position = piece.getAttribute('position') as THREE.BufferAttribute;
    let sawInner = false;
    for (let i = 0; i < position.count; i++) {
      const z = position.getZ(i);
      if (z < 0.02) {
        expect(z).toBeGreaterThanOrEqual(-1e-6);
        sawInner = true;
      }
    }
    expect(sawInner).toBe(true);
  });

  it('hull pieces stay ≤ 320 triangles', () => {
    expect(tris(hullPieceGeometry())).toBeLessThanOrEqual(320);
  });

  it('hull pieces keep the wall-piece local frame: x ± 0.5, y and z in [0, 1]', () => {
    // ArenaWall stands local z = 0 on the clamp line + 0.6 m; any vertex at
    // z < 0 would protrude past where the player stops (AC-34), and y < 0
    // would bury geometry below the terrain.
    const hull = hullPieceGeometry();
    hull.computeBoundingBox();
    const box = hull.boundingBox as THREE.Box3;
    expect(box.min.x).toBeGreaterThanOrEqual(-0.5 - 1e-6);
    expect(box.max.x).toBeLessThanOrEqual(0.5 + 1e-6);
    expect(box.min.y).toBeGreaterThanOrEqual(-1e-6);
    expect(box.max.y).toBeLessThanOrEqual(1 + 1e-6);
    expect(box.min.z).toBeGreaterThanOrEqual(-1e-6);
    expect(box.max.z).toBeLessThanOrEqual(1 + 1e-6);
  });
});

// ---------------------------------------------------------------- SPEC-053

describe('the foliage seam and the landmarks (SPEC-053 §4.1, §4.8)', () => {
  /** A strip of `n` triangles with uvs and colours, indexed like the GLB's. */
  function strip(n: number, y: number, u: number): THREE.BufferGeometry {
    const geometry = new THREE.PlaneGeometry(1, 1, n, 1);
    geometry.translate(0, y, 0);
    const count = (geometry.getAttribute('position') as THREE.BufferAttribute).count;
    const uv = geometry.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < count; i++) uv.setXY(i, u + uv.getX(i) * 0.25, uv.getY(i) * 0.25);
    geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(count * 3).fill(0.5), 3));
    return geometry;
  }

  /** SPEC-052's tree contract: five named nodes, `Foliage` on four and `Glow` on the pods. */
  function tree(): THREE.Group {
    const group = new THREE.Group();
    const foliage = new THREE.MeshStandardMaterial({ name: 'Foliage', vertexColors: true });
    const parts: [string, THREE.BufferGeometry, THREE.Material][] = [
      ['Bark', strip(4, 0.5, 0.75), foliage],
      ['Leaf', strip(6, 1.8, 0), foliage],
      ['Bark_LOD1', strip(1, 0.5, 0.75), foliage],
      ['Leaf_LOD1', strip(2, 1.8, 0), foliage],
      ['Glow', new THREE.SphereGeometry(0.1, 4, 3), new THREE.MeshStandardMaterial({ name: 'Glow' })],
    ];
    for (const [name, geometry, material] of parts) {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = name;
      group.add(mesh);
    }
    return group;
  }

  const indexedTris = (geometry: THREE.BufferGeometry): number => (geometry.index?.count ?? geometry.getAttribute('position').count) / 3;

  it('foliageFromModel merges Bark and Leaf into a body that keeps its atlas uvs, and splits glow and lod1', () => {
    const prop = foliageFromModel(tree());
    expect(prop.foliage).toBe(true);
    expect(prop.fromModel).toBe(true);
    expect(Object.keys(prop.body.attributes).sort()).toEqual(['color', 'normal', 'position', 'uv']);
    expect(indexedTris(prop.body)).toBe(4 * 2 + 6 * 2); // Bark + Leaf
    expect(prop.lod1).toBeDefined();
    expect(indexedTris(prop.lod1 as THREE.BufferGeometry)).toBe(1 * 2 + 2 * 2); // Bark_LOD1 + Leaf_LOD1
    expect((prop.lod1 as THREE.BufferGeometry).getAttribute('uv')).toBeDefined();
    // The leaf's uvs are the atlas cell's, untouched: u in [0, 0.25] for the leaf, [0.75, 1] for the bark.
    const uv = prop.body.getAttribute('uv') as THREE.BufferAttribute;
    let maxU = 0;
    for (let i = 0; i < uv.count; i++) maxU = Math.max(maxU, uv.getX(i));
    expect(maxU).toBeCloseTo(1, 6);
    // COLOR_0 × the white material: the authored 0.5 survives.
    expect((prop.body.getAttribute('color') as THREE.BufferAttribute).getX(0)).toBeCloseTo(0.5, 6);
    expect(prop.glow).toBeDefined();
    expect(prop.glow?.getAttribute('uv')).toBeUndefined(); // the glow is a plain prop part
  });

  it('obstacleGeometry draws a tree through the seam once the model and the atlas are both in (53-a)', () => {
    const atlas = new THREE.Texture();
    const both = {
      hasModel: (id: string) => id === 'jungle_tree_a',
      model: () => tree(),
      hasTexture: (id: string) => id === 'foliage_atlas',
      texture: () => atlas,
    } as unknown as Assets;
    expect(foliageAtlas(both)).toBe(atlas);
    const seam = obstacleGeometry('tree', 'jungle', 7, both);
    expect(seam.foliage).toBe(true);
    expect(seam.lod1).toBeDefined();
    // The model without the atlas stays procedural.
    const noAtlas = { ...both, hasTexture: () => false } as unknown as Assets;
    expect(foliageAtlas(noAtlas)).toBeNull();
    const procedural = obstacleGeometry('tree', 'jungle', 7, noAtlas);
    expect(procedural.foliage).toBeUndefined();
    expect(tris(procedural.body)).toBe(tris(obstacleGeometry('tree', 'jungle', 7).body));
  });

  it('LANDMARK_FOOTPRINT is 4, 3.5, 4, 4.5, 4, 4.2 m and each biome names landmark_<biome>', () => {
    expect(LANDMARK_FOOTPRINT).toEqual({ desert: 4, ice: 3.5, jungle: 4, volcanic: 4.5, hive: 4, temperate: 4.2 });
    for (const biome of ['desert', 'ice', 'jungle', 'volcanic', 'hive', 'temperate'] as const) {
      expect(LANDMARK_MODELS[biome]).toBe(`landmark_${biome}`);
    }
  });

  it('a landmark POI takes its model once loaded, with its Glow split, and the procedural body until then', () => {
    const landmark = (): THREE.Group => {
      const group = new THREE.Group();
      group.add(new THREE.Mesh(new THREE.BoxGeometry(4, 5, 4).translate(0, 2.5, 0), new THREE.MeshStandardMaterial({ name: 'Body' })));
      group.add(new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), new THREE.MeshStandardMaterial({ name: 'Glow' })));
      return group;
    };
    const loaded = { hasModel: (id: string) => id === 'landmark_ice', model: () => landmark() } as unknown as Assets;
    const prop = poiGeometry('landmark', 'ice', loaded);
    expect(prop.fromModel).toBe(true);
    expect(tris(prop.body)).toBe(12);
    expect(prop.glow).toBeDefined();
    // Another biome's model is not this one's; nothing loaded keeps SPEC-046's body.
    expect(poiGeometry('landmark', 'desert', loaded).fromModel).toBeUndefined();
    expect(poiGeometry('landmark', 'ice').fromModel).toBeUndefined();
  });
});
