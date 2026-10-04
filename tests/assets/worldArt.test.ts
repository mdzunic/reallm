// SPEC-052 §4.9, §6.1 — the world-art drop, pinned on the committed files:
// every model, texture and constant claim of the spec, read from
// public/assets and scripts/assets/blender. A tree over its triangle cap or off
// its contract fails here and names the model and the rule (52-d); a folder
// over its ceiling fails here as well as in check.mjs (52-e).
//
// Models are read twice: the GLB's JSON chunk (names, transforms, attributes,
// extensions), and the meshes decoded in node through three's GLTFLoader with
// the MeshoptDecoder the game uses (SPEC-046) — counts, bounds, normals, UVs.
// WebP sizes come from the RIFF header.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { describe, expect, it } from 'vitest';

const ASSETS = new URL('../../public/assets/', import.meta.url);
const BLENDER = new URL('../../scripts/assets/blender/', import.meta.url);
const MB = 1024 * 1024;
const EXT = 'EXT_meshopt_compression';

interface GltfNode {
  name?: string;
  mesh?: number;
  children?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
  matrix?: number[];
}
interface GltfJson {
  asset: { version: string };
  scenes: { nodes: number[] }[];
  nodes: GltfNode[];
  meshes: { primitives: { attributes: Record<string, number>; material?: number }[] }[];
  materials?: { name: string }[];
  extensionsUsed?: string[];
  extensionsRequired?: string[];
}

function assetPath(rel: string): string {
  return new URL(rel, ASSETS).pathname;
}

/** The JSON chunk of a GLB: magic `glTF`, version 2, the first chunk JSON. */
function glbJson(rel: string): GltfJson {
  const bytes = readFileSync(assetPath(rel));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(new TextDecoder().decode(bytes.subarray(0, 4)), `${rel} magic`).toBe('glTF');
  expect(view.getUint32(4, true), `${rel} version`).toBe(2);
  const length = view.getUint32(12, true);
  expect(view.getUint32(16, true), `${rel} first chunk is JSON`).toBe(0x4e4f534a);
  return JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + length))) as GltfJson;
}

/** The scene, decoded as the game decodes it (GLTFLoader + MeshoptDecoder), world matrices up to date. */
async function decode(rel: string): Promise<THREE.Group> {
  const bytes = new Uint8Array(readFileSync(assetPath(rel)));
  const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes.buffer, '');
  gltf.scene.updateMatrixWorld(true);
  return gltf.scene;
}

/** A WebP's canvas size and whether it carries alpha, from its VP8 / VP8L / VP8X header. */
function webpSize(rel: string): { width: number; height: number; alpha: boolean } {
  const b = readFileSync(assetPath(rel));
  const text = (at: number, n: number) => new TextDecoder().decode(b.subarray(at, at + n));
  expect(text(0, 4), `${rel} RIFF`).toBe('RIFF');
  expect(text(8, 4), `${rel} WEBP`).toBe('WEBP');
  const kind = text(12, 4);
  const u24 = (at: number) => (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8) | ((b[at + 2] ?? 0) << 16);
  if (kind === 'VP8X') return { width: u24(24) + 1, height: u24(27) + 1, alpha: ((b[20] ?? 0) & 0x10) !== 0 };
  if (kind === 'VP8L') {
    const bits = (b[21] ?? 0) | ((b[22] ?? 0) << 8) | ((b[23] ?? 0) << 16) | ((b[24] ?? 0) << 24);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1, alpha: ((bits >>> 28) & 1) === 1 };
  }
  expect(kind, `${rel} chunk`).toBe('VP8 ');
  return { width: ((b[26] ?? 0) | ((b[27] ?? 0) << 8)) & 0x3fff, height: ((b[28] ?? 0) | ((b[29] ?? 0) << 8)) & 0x3fff, alpha: false };
}

/** Every mesh under `root`, with its material name. */
function meshes(root: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  root.traverse((node) => {
    if ((node as THREE.Mesh).isMesh === true) out.push(node as THREE.Mesh);
  });
  return out;
}

function materialName(mesh: THREE.Mesh): string {
  return (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material)?.name ?? '';
}

function triangles(list: readonly THREE.Mesh[]): number {
  return list.reduce((sum, mesh) => sum + (mesh.geometry.index?.count ?? mesh.geometry.getAttribute('position').count) / 3, 0);
}

/** World-space positions of every vertex of `list`. */
function points(list: readonly THREE.Mesh[]): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (const mesh of list) {
    const position = mesh.geometry.getAttribute('position');
    for (let i = 0; i < position.count; i++) out.push(new THREE.Vector3().fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld));
  }
  return out;
}

function bounds(list: readonly THREE.Mesh[]): THREE.Box3 {
  return new THREE.Box3().setFromPoints(points(list));
}

/** The widest distance of any vertex from the y axis. */
function reach(list: readonly THREE.Mesh[]): number {
  return Math.max(...points(list).map((p) => Math.hypot(p.x, p.z)));
}

/** Each triangle's three corners, in world space. */
function faces(mesh: THREE.Mesh): [THREE.Vector3, THREE.Vector3, THREE.Vector3][] {
  const position = mesh.geometry.getAttribute('position');
  const index = mesh.geometry.index;
  const count = index?.count ?? position.count;
  const at = (k: number) => new THREE.Vector3().fromBufferAttribute(position, index ? index.getX(k) : k).applyMatrix4(mesh.matrixWorld);
  const out: [THREE.Vector3, THREE.Vector3, THREE.Vector3][] = [];
  for (let k = 0; k < count; k += 3) out.push([at(k), at(k + 1), at(k + 2)]);
  return out;
}

/** Pieces of a mesh that share no vertex position (a pod, a shard). */
function components(mesh: THREE.Mesh): number {
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    let r = k;
    while (parent.get(r) !== r) r = parent.get(r) ?? r;
    parent.set(k, r);
    return r;
  };
  const key = (p: THREE.Vector3) => `${p.x.toFixed(4)},${p.y.toFixed(4)},${p.z.toFixed(4)}`;
  for (const tri of faces(mesh)) {
    const keys = tri.map(key);
    for (const k of keys) if (!parent.has(k)) parent.set(k, k);
    for (const k of keys.slice(1)) parent.set(find(k), find(keys[0] as string));
  }
  return new Set([...parent.keys()].map(find)).size;
}

/** Atlas cell `cell` (§3.3), in glTF UVs (v = 0 at the image's top), shrunk by `pad`. */
function inCell(u: number, v: number, cell: number, pad = 0): boolean {
  const u0 = (cell % 4) / 4 + pad;
  const v0 = Math.floor(cell / 4) / 4 + pad;
  const eps = 1e-5;
  return u >= u0 - eps && u <= u0 + 0.25 - 2 * pad + eps && v >= v0 - eps && v <= v0 + 0.25 - 2 * pad + eps;
}

function uvTriangles(mesh: THREE.Mesh): [number, number][][] {
  const uv = mesh.geometry.getAttribute('uv');
  const index = mesh.geometry.index;
  const count = index?.count ?? uv.count;
  const out: [number, number][][] = [];
  for (let k = 0; k < count; k += 3) {
    out.push([0, 1, 2].map((j) => {
      const i = index ? index.getX(k + j) : k + j;
      return [uv.getX(i), uv.getY(i)] as [number, number];
    }));
  }
  return out;
}

function isIdentity(node: GltfNode): boolean {
  const same = (a: number[] | undefined, b: number[]) => a === undefined || a.every((x, i) => Math.abs(x - (b[i] ?? 0)) < 1e-6);
  return node.matrix === undefined && same(node.translation, [0, 0, 0]) && same(node.rotation, [0, 0, 0, 1]) && same(node.scale, [1, 1, 1]);
}

/** Attribute names on every primitive of the node called `name`. */
function attributesOf(json: GltfJson, name: string): string[][] {
  const node = json.nodes.find((n) => n.name === name);
  if (node?.mesh === undefined) return [];
  return (json.meshes[node.mesh]?.primitives ?? []).map((p) => Object.keys(p.attributes).sort());
}

function materialsOf(json: GltfJson, name: string): string[] {
  const node = json.nodes.find((n) => n.name === name);
  if (node?.mesh === undefined) return [];
  return (json.meshes[node.mesh]?.primitives ?? []).map((p) => json.materials?.[p.material ?? -1]?.name ?? '');
}

function allPrimitives(json: GltfJson): { attributes: Record<string, number>; material: string }[] {
  return json.meshes.flatMap((m) => m.primitives.map((p) => ({ attributes: p.attributes, material: json.materials?.[p.material ?? -1]?.name ?? '' })));
}

function folderBytes(rel: string): number {
  let total = 0;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name !== '.gitkeep') total += statSync(full).size;
    }
  };
  walk(assetPath(rel).replace(/\/$/, ''));
  return total;
}

// ------------------------------------------------------------------- tables

/** §3.2: height of `Leaf`'s top, and the leaf cells. */
const TREES = {
  jungle_tree_a: { height: 2.4, cells: [0, 1], glow: true },
  jungle_tree_b: { height: 2.2, cells: [0, 1], glow: true },
  jungle_tree_c: { height: 1.8, cells: [4, 5], glow: false },
  temperate_tree_a: { height: 2.1, cells: [2, 3], glow: false },
  temperate_tree_b: { height: 2.2, cells: [2, 3], glow: false },
  temperate_tree_c: { height: 1.7, cells: [2, 3], glow: false },
} as const;
const BARK_CELL = 15;
const GUTTER_UV = 4 / 512;

/** §3.4: today's builders' triangle counts, which the rebuild keeps. */
const REBUILT = {
  desert_rock: [320, 400],
  desert_ruin: [352, 264],
  ice_rock: [80, 80],
  ice_spire: [160, 180],
  jungle_ruin: [292, 292],
  volcanic_rock: [320, 320],
  volcanic_vent: [344, 424],
  hive_spire: [576, 596],
  hive_rock: [320, 320],
  temperate_rock: [320, 320],
} as const;
/** §3.4: the `_c`s that carry a `Glow`. */
const DRESSING_GLOW = new Set(['ice_spire', 'volcanic_rock', 'volcanic_vent', 'hive_spire', 'hive_rock']);

/** §3.5: height (± 10 %), the footprint radius it stays within, and whether it glows. */
const LANDMARKS = {
  desert: { height: 5, footprint: 4, glow: false },
  ice: { height: 7, footprint: 3.5, glow: true },
  jungle: { height: 6, footprint: 4, glow: false },
  volcanic: { height: 4, footprint: 4.5, glow: true },
  hive: { height: 4, footprint: 4, glow: true },
  temperate: { height: 5, footprint: 4.2, glow: false },
} as const;

/** §3.6: w × d × h (± 10 %) and the triangle cap. */
const CAVE = {
  cache: [1.2, 0.8, 0.9, 400],
  cache_open: [1.2, 0.8, 1.5, 450],
  vault_door: [3.4, 1.0, 3.6, 900],
  terminal: [0.8, 0.6, 1.4, 500],
  plate: [1.6, 1.6, 0.12, 200],
  mirror: [1.0, 0.8, 1.7, 400],
  lens: [0.9, 0.9, 1.5, 400],
  receiver: [1.0, 1.0, 2.2, 450],
  shaft: [3.0, 3.0, 3.5, 800],
  rack: [0.8, 1.2, 2.2, 400],
  cradle: [1.2, 1.0, 2.4, 900],
  beacon_desert: [0.5, 0.5, 1.2, 200],
  beacon_ice: [0.8, 0.8, 0.9, 200],
  beacon_jungle: [0.8, 0.8, 0.6, 200],
  beacon_volcanic: [0.7, 0.7, 0.8, 200],
  beacon_hive: [0.8, 0.8, 0.7, 200],
  beacon_temperate: [0.4, 0.4, 1.5, 200],
} as const;
/** SPEC-054's CAVE_ASSETS, one for one with the files. */
const CAVE_ASSET_IDS = Object.keys(CAVE).map((name) => `cave_${name}`);

/** SPEC-018 §4.5 less SPEC-046's rock: the twelve layers. */
const GROUND_LAYERS = ['sand', 'cracked_earth', 'snow', 'ice', 'moss', 'jungle_floor', 'basalt', 'lava_rock', 'chitin', 'flesh', 'grass', 'soil'];
/** §4.8: the seven pictures SPEC-056's items will name, after `aria`. */
const NEW_PICTURES = ['relic_last_word', 'relic_cold_coil', 'relic_seed_drum', 'relic_slag_vent', 'relic_seeker', 'flare', 'stim'];

// ------------------------------------------------------------------- trees

describe('the six trees (SPEC-052 §3.2, §4.2)', () => {
  const names = Object.keys(TREES) as (keyof typeof TREES)[];

  it('carry Bark, Leaf, Bark_LOD1, Leaf_LOD1 (+ Glow) with identity transforms, their materials and attributes, meshopt-compressed', () => {
    for (const name of names) {
      const json = glbJson(`models/props/${name}.glb`);
      const nodeNames = json.nodes.map((n) => n.name).sort();
      const expected = ['Bark', 'Bark_LOD1', 'Leaf', 'Leaf_LOD1', ...(TREES[name].glow ? ['Glow'] : [])].sort();
      expect(nodeNames, name).toEqual(expected);
      for (const node of json.nodes) expect(isIdentity(node), `${name} ${node.name} transform`).toBe(true);
      for (const node of ['Bark', 'Leaf', 'Bark_LOD1', 'Leaf_LOD1']) {
        expect(materialsOf(json, node), `${name} ${node} material`).toEqual(['Foliage']);
        for (const attrs of attributesOf(json, node)) expect(attrs, `${name} ${node} attributes`).toEqual(['COLOR_0', 'NORMAL', 'POSITION', 'TEXCOORD_0']);
      }
      if (TREES[name].glow) expect(materialsOf(json, 'Glow'), `${name} Glow material`).toEqual(['Glow']);
      expect(json.extensionsRequired ?? [], name).toContain(EXT);
    }
  });

  it('stand on y 0, reach 1.00 with Leaf, hold a 0.14 trunk at y 0.30–0.34 and top out at their height', async () => {
    for (const name of names) {
      const scene = await decode(`models/props/${name}.glb`);
      const all = meshes(scene);
      const named = (n: string) => all.filter((m) => m.name === n);
      expect(bounds(all).min.y, `${name} lowest vertex`).toBeCloseTo(0, 2);
      expect(Math.abs(bounds(all).min.y), `${name} lowest vertex`).toBeLessThanOrEqual(0.01);
      expect(Math.abs(reach(named('Leaf')) - 1), `${name} canopy`).toBeLessThanOrEqual(0.02);
      const band = points(named('Bark')).filter((p) => p.y >= 0.3 && p.y <= 0.34);
      expect(band.length, `${name} trunk vertices in the band`).toBeGreaterThan(0);
      const trunk = Math.max(...band.map((p) => Math.hypot(p.x, p.z)));
      expect(Math.abs(trunk - 0.14), `${name} trunk radius ${trunk.toFixed(3)}`).toBeLessThanOrEqual(0.02);
      expect(Math.abs(bounds(named('Leaf')).max.y - TREES[name].height), `${name} height`).toBeLessThanOrEqual(0.05);
    }
  });

  it('keep LOD0 within 700 triangles and LOD1 within 140, LOD1 reaching 0.90–1.05', async () => {
    for (const name of names) {
      const all = meshes(await decode(`models/props/${name}.glb`));
      const of = (...n: string[]) => all.filter((m) => n.includes(m.name));
      expect(triangles(of('Bark', 'Leaf', 'Glow')), `${name} LOD0`).toBeLessThanOrEqual(700);
      expect(triangles(of('Bark_LOD1', 'Leaf_LOD1')), `${name} LOD1`).toBeLessThanOrEqual(140);
      const lod1 = reach(of('Leaf_LOD1'));
      expect(lod1, `${name} LOD1 extent`).toBeGreaterThanOrEqual(0.9);
      expect(lod1, `${name} LOD1 extent`).toBeLessThanOrEqual(1.05);
    }
  });

  it('face every Leaf card within 50° of ±y', async () => {
    const limit = Math.cos((50 * Math.PI) / 180);
    for (const name of names) {
      const leaf = meshes(await decode(`models/props/${name}.glb`)).filter((m) => m.name === 'Leaf');
      for (const [a, b, c] of leaf.flatMap(faces)) {
        const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).normalize();
        expect(Math.abs(n.y), `${name} card normal`).toBeGreaterThanOrEqual(limit);
      }
    }
  });

  it('map the bark inside cell 15 clear of its gutter, and every card inside the tree’s leaf cells', async () => {
    for (const name of names) {
      const all = meshes(await decode(`models/props/${name}.glb`));
      for (const mesh of all.filter((m) => m.name === 'Bark' || m.name === 'Bark_LOD1')) {
        for (const tri of uvTriangles(mesh)) {
          for (const [u, v] of tri) expect(inCell(u, v, BARK_CELL, GUTTER_UV), `${name} ${mesh.name} uv ${u},${v}`).toBe(true);
        }
      }
      for (const mesh of all.filter((m) => m.name === 'Leaf' || m.name === 'Leaf_LOD1')) {
        for (const tri of uvTriangles(mesh)) {
          const ok = TREES[name].cells.some((cell) => tri.every(([u, v]) => inCell(u, v, cell)));
          expect(ok, `${name} ${mesh.name} card uv ${JSON.stringify(tri)}`).toBe(true);
        }
      }
    }
  });

  it('make temperate_tree_c four-fold symmetric, and no other tree symmetric within 0.05', async () => {
    for (const name of names) {
      const box = bounds(meshes(await decode(`models/props/${name}.glb`)).filter((m) => m.name === 'Leaf'));
      const measures = [Math.abs(box.min.x + box.max.x), Math.abs(box.min.z + box.max.z), Math.abs(box.max.x - box.min.x - (box.max.z - box.min.z))];
      if (name === 'temperate_tree_c') for (const m of measures) expect(m, name).toBeLessThanOrEqual(0.02);
      else expect(Math.max(...measures), `${name} is not symmetric`).toBeGreaterThan(0.05);
    }
  });

  it('hang 4–7 glowing seed pods on jungle_tree_a and _b, and no Glow on any other tree', async () => {
    for (const name of names) {
      const glow = meshes(await decode(`models/props/${name}.glb`)).filter((m) => m.name === 'Glow');
      if (!TREES[name].glow) {
        expect(glow, name).toHaveLength(0);
        continue;
      }
      expect(glow, name).toHaveLength(1);
      const pods = components(glow[0] as THREE.Mesh);
      expect(pods, `${name} pods`).toBeGreaterThanOrEqual(4);
      expect(pods, `${name} pods`).toBeLessThanOrEqual(7);
    }
  });
});

// ----------------------------------------------------- dressing and rebuilt

describe('the ten dressing pieces and the twenty rebuilt props (SPEC-052 §3.4, §4.3)', () => {
  const kinds = Object.keys(REBUILT) as (keyof typeof REBUILT)[];

  it('build each _c as a unit prop: Body (+ Glow where §3.4 says), COLOR_0, no TEXCOORD_0, radius 1, base 0, ≤ 350 triangles', async () => {
    for (const kind of kinds) {
      const rel = `models/props/${kind}_c.glb`;
      const json = glbJson(rel);
      const prims = allPrimitives(json);
      const mats = new Set(prims.map((p) => p.material));
      expect([...mats].sort(), rel).toEqual(DRESSING_GLOW.has(kind) ? ['Body', 'Glow'] : ['Body']);
      for (const p of prims) {
        expect(Object.keys(p.attributes), rel).not.toContain('TEXCOORD_0');
        if (p.material === 'Body') expect(Object.keys(p.attributes), rel).toContain('COLOR_0');
      }
      expect(json.extensionsRequired ?? [], rel).toContain(EXT);
      const all = meshes(await decode(rel));
      expect(Math.abs(reach(all) - 1), `${rel} footprint`).toBeLessThanOrEqual(0.02);
      expect(Math.abs(bounds(all).min.y), `${rel} base`).toBeLessThanOrEqual(0.01);
      expect(triangles(all), rel).toBeLessThanOrEqual(350);
    }
  });

  it('rebuild every _a and _b with today’s triangle counts, no TEXCOORD_0 and meshopt', async () => {
    for (const kind of kinds) {
      for (const [v, letter] of (['a', 'b'] as const).entries()) {
        const rel = `models/props/${kind}_${letter}.glb`;
        const json = glbJson(rel);
        for (const p of allPrimitives(json)) expect(Object.keys(p.attributes), rel).not.toContain('TEXCOORD_0');
        expect(json.extensionsRequired ?? [], rel).toContain(EXT);
        const all = meshes(await decode(rel));
        expect(triangles(all), rel).toBe(REBUILT[kind][v]);
        expect(Math.abs(reach(all) - 1), `${rel} footprint`).toBeLessThanOrEqual(0.02);
        expect(Math.abs(bounds(all).min.y), `${rel} base`).toBeLessThanOrEqual(0.01);
      }
    }
  });

  it('compresses every GLB under models/props and models/cave with EXT_meshopt_compression, decoded to float attributes', async () => {
    for (const folder of ['models/props', 'models/cave']) {
      for (const file of readdirSync(assetPath(folder), { withFileTypes: true }).filter((e) => e.name.endsWith('.glb'))) {
        const rel = `${folder}/${file.name}`;
        const json = glbJson(rel);
        expect(json.extensionsUsed ?? [], rel).toContain(EXT);
        expect(json.extensionsRequired ?? [], rel).toContain(EXT);
        for (const mesh of meshes(await decode(rel))) {
          for (const name of ['position', 'normal']) expect(mesh.geometry.getAttribute(name).array, `${rel} ${name}`).toBeInstanceOf(Float32Array);
        }
      }
    }
  });
});

// ---------------------------------------------------------------- landmarks

describe('the six landmarks (SPEC-052 §3.5, §4.4)', () => {
  it('stand in metres on y 0 about their base centre, at §3.5’s height and footprint, ≤ 900 triangles, Body (+ Glow), no UVs', async () => {
    for (const [biome, spec] of Object.entries(LANDMARKS)) {
      const rel = `models/props/landmark_${biome}.glb`;
      const json = glbJson(rel);
      const prims = allPrimitives(json);
      expect([...new Set(prims.map((p) => p.material))].sort(), rel).toEqual(spec.glow ? ['Body', 'Glow'] : ['Body']);
      for (const p of prims) {
        expect(Object.keys(p.attributes), rel).not.toContain('TEXCOORD_0');
        if (p.material === 'Body') expect(Object.keys(p.attributes), rel).toContain('COLOR_0');
      }
      expect(json.extensionsRequired ?? [], rel).toContain(EXT);
      const all = meshes(await decode(rel));
      const box = bounds(all);
      expect(Math.abs(box.min.y), `${rel} base`).toBeLessThanOrEqual(0.01);
      expect(Math.abs(box.max.y - spec.height), `${rel} height ${box.max.y.toFixed(2)}`).toBeLessThanOrEqual(0.1 * spec.height);
      expect(reach(all), `${rel} footprint`).toBeLessThanOrEqual(spec.footprint);
      // the origin is the base centre: the piece spreads round it, not off to one side
      expect(Math.hypot((box.min.x + box.max.x) / 2, (box.min.z + box.max.z) / 2), `${rel} centre`).toBeLessThanOrEqual(0.25 * spec.footprint);
      expect(triangles(all), rel).toBeLessThanOrEqual(900);
    }
  });
});

// ----------------------------------------------------------------- cave kit

describe('the cave kit (SPEC-052 §3.6, §4.5)', () => {
  it('holds exactly the seventeen files SPEC-054’s CAVE_ASSETS names', () => {
    const files = readdirSync(assetPath('models/cave'), { withFileTypes: true }).map((e) => e.name).sort();
    expect(files).toEqual(Object.keys(CAVE).map((name) => `${name}.glb`).sort());
    expect(CAVE_ASSET_IDS).toHaveLength(17);
  });

  it('sizes every piece within ± 10 % of w × d × h, under its cap, base on y 0, COLOR_0 on all but Glow, no UVs, meshopt', async () => {
    for (const [name, [w, d, h, cap]] of Object.entries(CAVE)) {
      const rel = `models/cave/${name}.glb`;
      const json = glbJson(rel);
      for (const p of allPrimitives(json)) {
        expect(Object.keys(p.attributes), rel).not.toContain('TEXCOORD_0');
        if (p.material !== 'Glow') expect(Object.keys(p.attributes), `${rel} ${p.material}`).toContain('COLOR_0');
      }
      expect(json.extensionsRequired ?? [], rel).toContain(EXT);
      const all = meshes(await decode(rel));
      const size = bounds(all).getSize(new THREE.Vector3());
      expect(Math.abs(size.x - w), `${rel} width ${size.x.toFixed(2)}`).toBeLessThanOrEqual(0.1 * w + 1e-6);
      expect(Math.abs(size.z - d), `${rel} depth ${size.z.toFixed(2)}`).toBeLessThanOrEqual(0.1 * d + 1e-6);
      expect(Math.abs(size.y - h), `${rel} height ${size.y.toFixed(2)}`).toBeLessThanOrEqual(0.1 * h + 1e-6);
      expect(Math.abs(bounds(all).min.y), `${rel} base`).toBeLessThanOrEqual(0.01);
      expect(triangles(all), rel).toBeLessThanOrEqual(cap);
    }
  });

  it('gives the single-node pieces Body and Glow, and the cradle Body, Suit, Trim and Glow with near-white Suit and Trim', async () => {
    for (const name of Object.keys(CAVE).filter((n) => n !== 'vault_door' && n !== 'mirror')) {
      const json = glbJson(`models/cave/${name}.glb`);
      expect(json.nodes, name).toHaveLength(1);
      const mats = [...new Set(allPrimitives(json).map((p) => p.material))].sort();
      expect(mats, name).toEqual(name === 'cradle' ? ['Body', 'Glow', 'Suit', 'Trim'] : ['Body', 'Glow']);
    }
    for (const mesh of meshes(await decode('models/cave/cradle.glb'))) {
      if (materialName(mesh) !== 'Suit' && materialName(mesh) !== 'Trim') continue;
      const colour = mesh.geometry.getAttribute('color');
      for (let i = 0; i < colour.count; i++) {
        expect(Math.min(colour.getX(i), colour.getY(i), colour.getZ(i)), `cradle ${materialName(mesh)} is near-white`).toBeGreaterThanOrEqual(0.8);
      }
    }
  });

  it('hinges vault_door’s Door at x = −1.3 with Lock its child, and turns mirror’s Head on the post’s axis', () => {
    const vault = glbJson('models/cave/vault_door.glb');
    const byName = (json: GltfJson, n: string) => json.nodes.findIndex((node) => node.name === n);
    const frame = vault.nodes[byName(vault, 'Frame')];
    const door = vault.nodes[byName(vault, 'Door')];
    expect(vault.nodes.map((n) => n.name).sort()).toEqual(['Door', 'Frame', 'Lock']);
    expect(frame?.children ?? []).toContain(byName(vault, 'Door'));
    expect(door?.children ?? []).toEqual([byName(vault, 'Lock')]);
    expect(door?.translation?.[0]).toBeCloseTo(-1.3, 5);
    expect(materialsOf(vault, 'Frame')).toEqual(['Body']);
    expect(materialsOf(vault, 'Door')).toEqual(['Body']);
    expect(materialsOf(vault, 'Lock')).toEqual(['Glow']);
    const mirror = glbJson('models/cave/mirror.glb');
    const head = mirror.nodes[byName(mirror, 'Head')];
    expect(mirror.nodes.map((n) => n.name).sort()).toEqual(['Base', 'Head']);
    expect(head?.translation?.[0] ?? 0).toBeCloseTo(0, 5);
    expect(head?.translation?.[2] ?? 0).toBeCloseTo(0, 5);
    expect(materialsOf(mirror, 'Base')).toEqual(['Body']);
    expect([...materialsOf(mirror, 'Head')].sort()).toEqual(['Body', 'Glow']);
  });

  it('faces the pieces with a front toward +z: the terminal’s screen, the rack’s LEDs and the vault’s lock', async () => {
    for (const name of ['terminal', 'rack']) {
      const glow = meshes(await decode(`models/cave/${name}.glb`)).filter((m) => materialName(m) === 'Glow');
      expect(bounds(glow).getCenter(new THREE.Vector3()).z, name).toBeGreaterThan(0.05);
    }
    const lock = meshes(await decode('models/cave/vault_door.glb')).filter((m) => materialName(m) === 'Glow');
    expect(bounds(lock).getCenter(new THREE.Vector3()).z).toBeGreaterThan(0.05);
  });

  it('keeps every beacon within 200 triangles, at least half of them on Glow', async () => {
    for (const name of Object.keys(CAVE).filter((n) => n.startsWith('beacon_'))) {
      const all = meshes(await decode(`models/cave/${name}.glb`));
      const total = triangles(all);
      expect(total, name).toBeLessThanOrEqual(200);
      expect(triangles(all.filter((m) => materialName(m) === 'Glow')) / total, `${name} glow share`).toBeGreaterThanOrEqual(0.5);
    }
  });
});

// ----------------------------------------------------------------- textures

describe('the atlas, detail_nr and the ground layers (SPEC-052 §4.6, §4.7)', () => {
  it('writes the foliage atlas at 512² with alpha and detail_nr at 256² with alpha', () => {
    expect(webpSize('textures/foliage/atlas.webp')).toEqual({ width: 512, height: 512, alpha: true });
    expect(webpSize('textures/ground/detail_nr.webp')).toEqual({ width: 256, height: 256, alpha: true });
  });

  it('keeps the twelve ground layers at 512² with their alpha, and no rock_* file (SPEC-046)', () => {
    const files = readdirSync(assetPath('textures/ground'), { withFileTypes: true }).map((e) => e.name);
    expect(files.filter((f) => f.startsWith('rock_'))).toEqual([]);
    expect(files.sort()).toEqual([...GROUND_LAYERS.flatMap((l) => [`${l}_albedo.webp`, `${l}_nr.webp`]), 'detail_nr.webp'].sort());
    for (const layer of GROUND_LAYERS) {
      for (const half of ['albedo', 'nr']) expect(webpSize(`textures/ground/${layer}_${half}.webp`), `${layer}_${half}`).toEqual({ width: 512, height: 512, alpha: true });
    }
  });

  it('pins ground.py’s qualities and keeps every Voronoi edge out of the four re-authored recipes', () => {
    const ground = readFileSync(new URL('ground.py', BLENDER).pathname, 'utf8');
    expect(ground).toMatch(/^ALBEDO_QUALITY = 90\b/m);
    expect(ground).toMatch(/^SMOOTH_QUALITY = 92\b/m);
    expect(ground).toMatch(/^NR_QUALITY = 92\b/m);
    expect(ground).toMatch(/^DETAIL_SIZE = 256\b/m);
    for (const layer of ['jungle_floor', 'grass', 'moss', 'chitin']) {
      const row = new RegExp(`^\\s*'${layer}':\\s*\\(\\s*\\[([^\\]]*)\\]`, 'm').exec(ground);
      expect(row, `${layer}'s LAYERS row`).not.toBeNull();
      expect(row?.[1] ?? '', layer).not.toContain("'edge'");
    }
  });

  it('pins foliage.py’s grid', () => {
    const foliage = readFileSync(new URL('foliage.py', BLENDER).pathname, 'utf8');
    expect(foliage).toMatch(/^ATLAS_SIZE = 512\b/m);
    expect(foliage).toMatch(/^CELL = 128\b/m);
    expect(foliage).toMatch(/^GUTTER = 4\b/m);
  });
});

// ----------------------------------------------------------------- pictures

describe('the seven pictures (SPEC-052 §4.8)', () => {
  it('writes each at 384² within 36 KB', () => {
    for (const id of NEW_PICTURES) {
      const rel = `items/${id}.webp`;
      expect(existsSync(assetPath(rel)), rel).toBe(true);
      const size = webpSize(rel);
      expect([size.width, size.height], rel).toEqual([384, 384]);
      expect(statSync(assetPath(rel)).size, rel).toBeLessThanOrEqual(36 * 1024);
    }
  });

  it('lists the 33 ids in SUBJECTS order, the seven new ones after aria', () => {
    const items = readFileSync(new URL('items.py', BLENDER).pathname, 'utf8');
    const block = items.slice(items.indexOf('SUBJECTS = {'), items.indexOf('\n}\n', items.indexOf('SUBJECTS = {')));
    const subjects = [...block.matchAll(/^\s*'([a-z0-9_]+)':\s*\(/gm)].map((m) => m[1]);
    const manifest = (JSON.parse(readFileSync(assetPath('items/manifest.json'), 'utf8')) as { items: string[] }).items;
    expect(subjects).toHaveLength(33);
    expect(manifest).toEqual(subjects);
    expect(manifest.slice(manifest.indexOf('aria') + 1)).toEqual(NEW_PICTURES);
  });
});

// -------------------------------------------------------------------- bytes

describe('the folder totals (SPEC-052 §3.7, PLAN R20 decision 3)', () => {
  it('keeps models/ within 3.50 MB and textures/ within 4.90 MB', () => {
    expect(folderBytes('models/') / MB).toBeLessThanOrEqual(3.5);
    expect(folderBytes('textures/') / MB).toBeLessThanOrEqual(4.9);
    expect(folderBytes('items/') / MB).toBeLessThanOrEqual(1.0);
  });
});
