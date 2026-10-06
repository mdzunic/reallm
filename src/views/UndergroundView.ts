// The cave view (SPEC-054 §4.3, §4.4, §4.12) — one planet's underground,
// drawn from its generated layout under one root the surface view shows in
// place of its environment. About ten draws (§4.4's table):
//
//   floor            1   room discs + corridor quads, the planet's first ground layer × `look.floor`
//   walls            2   two instanced rock variants (Eden: 1, the racks)
//   caches           2   closed and claimed, instanced
//   vault door, shaft 2
//   beacons, spill   2   the beacons ignore fog; the spill is additive light on the floor
//   dust             1   `StormParticles` kind `dust`
//   Eden             2   the cradle row and the cable trays
//
// No light lives here: the scene's light count must never move at a swap
// (§4.5). The cave is flat — everything stands on y = 0.
//
// The kit (SPEC-052's `CAVE_ASSETS`) draws once `assets` holds it; until then
// each piece has a procedural stand-in. Either way a piece is ONE geometry —
// its `Glow` parts merged in with a per-vertex weight that the kit material
// turns into emission — so a piece costs one draw, not one per material.
// GLB bodies keep their authored colours under a white material (SPEC-046).
//
// Hundreds of wall instances would cost tens of thousands of triangles if all
// of them drew, so the walls go through SPEC-046's compaction: `setView` takes
// the same camera the surface's does. A view nothing culls draws every wall.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Assets } from '@/core/Assets';
import { disposeObject3D } from '@/core/Disposer';
import { hash01 } from '@/core/Noise';
import { hash32 } from '@/core/Rng';
import type { CaveModelId } from '@/data/assets';
import type { UndergroundDef } from '@/data/caves';
import type { CacheId } from '@/data/ids';
import { PLANETS } from '@/data/planets';
import {
  CULL_REFRESH_DISTANCE,
  CulledInstances,
  cullMargin,
  extendByFrustum,
  frustumGroundCorners,
  viewRect,
  type CullRect,
} from '@/views/InstanceCuller';
import { groundLayer, layerFromAssets, type GroundLayer } from '@/views/ProceduralTextures';
import { StormParticles, rigBillboard } from '@/views/StormParticles';
import { obstacleGeometry, type Biome } from '@/views/SurfaceProps';

/**
 * A structural mirror of `systems/Underground.UndergroundLayout` — the parts
 * this view reads. Views must not import `systems` (SPEC-001 §4); the scene
 * passes the real layout and the compiler checks the fit at the call site.
 */
export interface ViewCave {
  /** `undergroundHash` — the seed every decoration choice derives from. */
  hash: number;
  halfSize: number;
  /** `cave_wall` circles, then (Eden) the cradles' `debris` circles. */
  obstacles: readonly { x: number; z: number; radius: number; kind: string }[];
  rooms: readonly { x: number; z: number; r: number }[];
  /** Room indices; every corridor is `def.corridor` wide. */
  corridors: readonly { a: number; b: number }[];
  exit: { x: number; z: number };
  vault: { room: number; doorX: number; doorZ: number; doorFacing: number };
  caches: readonly { id: CacheId; x: number; z: number }[];
  beacons: readonly { x: number; z: number }[];
  /** Per `obstacles` entry: 1 when it draws cut away (§4.3 step 6). */
  cutaway: Uint8Array;
  /** Eden: the cradle row; `facing` turns the front (+z) toward the room's entrance. */
  cradles: readonly { x: number; z: number; facing: number }[];
}

/** §4.4 (*initial tuning*): a wall's drawn height. */
export const WALL_HEIGHT = 2.4;
/** Mirrors `systems/Underground.CUTAWAY_HEIGHT`: a cut-away wall keeps this share of its height. */
export const CUTAWAY_HEIGHT = 0.35;
/** §4.4: a wall's footprint, × its circle's radius. */
export const WALL_SPREAD = 1.3;
/** §4.12: the cable trays' width, and their emissive in the beacon colour. */
export const TRAY_WIDTH = 0.8;
export const TRAY_EMISSIVE = 0.3;
/** §4.4 (*initial tuning*): a beacon's spill on the floor, its radius in metres. */
export const SPILL_RADIUS = 2;
/** §4.4: the motes by default — `min(60, quality.maxParticles)` is the scene's. */
export const DUST_MOTES = 60;
/** *Initial tuning*: the kit's own glow parts (a strip, the lock, the LEDs) burn at this × the beacon colour. */
export const KIT_GLOW = 1.4;
/** §4.4: the segments of a room's floor disc. */
const ROOM_SEGMENTS = 32;
const TRAY_HEIGHT = 0.06;
const SPILL_LIFT = 0.03;
/** A cache's and the shaft's front (+z) turned toward the fixed rig, 45° round (SPEC-012 §4.3). */
const TOWARD_RIG = Math.PI / 4;
/** 19-h: the swatches a bare `?scene=surface` jump runs on, as `SurfaceView`'s. */
const DEFAULT_APPEARANCE = { primary: '#b7472a', secondary: '#2a3b4c' };

const WHITE = new THREE.Color('#ffffff');
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const scratchMatrix = new THREE.Matrix4();
const scratchPosition = new THREE.Vector3();
const scratchQuat = new THREE.Quaternion();
const scratchScale = new THREE.Vector3();
const scratchColor = new THREE.Color();
const scratchInward = { x: 0, z: 0 };
/** The dust stands on the flat cave floor. */
const FLAT = (): number => 0;

// ------------------------------------------------------------------- the kit

/** One part of a kit piece: a geometry in the piece's frame, its colour and material name. */
interface KitPart {
  geometry: THREE.BufferGeometry;
  color: THREE.Color | string;
  /** The GLB material's name: `Glow` emits; `Suit` and `Trim` take the save's colours. */
  material: string;
}

/** The save's two colours, as the cradles' suits wear them (§4.12). */
interface SuitColours {
  primary: THREE.Color;
  secondary: THREE.Color;
}

function materialOf(mesh: THREE.Mesh): THREE.MeshStandardMaterial | undefined {
  return (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshStandardMaterial | undefined;
}

/** A GLB's meshes in the root's frame, with their materials' colours and names (SPEC-046: COLOR_0 × colour). */
function modelParts(root: THREE.Object3D): KitPart[] {
  root.updateMatrixWorld(true);
  const parts: KitPart[] = [];
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (mesh.isMesh !== true) return;
    const material = materialOf(mesh);
    parts.push({
      geometry: mesh.geometry.clone().applyMatrix4(mesh.matrixWorld),
      color: material?.color ?? WHITE,
      material: material?.name ?? '',
    });
  });
  return parts;
}

/**
 * The parts merged into one non-indexed geometry with exactly `position`,
 * `normal`, `color` and `glow` (1 on `Glow` parts). With `suit`, `Suit` parts
 * take its primary and `Trim` parts its secondary — or, with neither material
 * present, every part takes the primary (§4.4).
 */
function mergeKit(parts: readonly KitPart[], suit?: SuitColours): THREE.BufferGeometry {
  const named = parts.some((part) => part.material === 'Suit' || part.material === 'Trim');
  const cleaned = parts.map((part) => {
    const geometry = part.geometry.index === null ? part.geometry : part.geometry.toNonIndexed();
    const count = (geometry.getAttribute('position') as THREE.BufferAttribute).count;
    const base = scratchColor.set(part.color);
    if (suit !== undefined) {
      const tint = named ? (part.material === 'Suit' ? suit.primary : part.material === 'Trim' ? suit.secondary : WHITE) : suit.primary;
      base.multiply(tint);
    }
    const existing = geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
    const colors = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      colors[i * 3] = (existing === undefined ? 1 : existing.getX(i)) * base.r;
      colors[i * 3 + 1] = (existing === undefined ? 1 : existing.getY(i)) * base.g;
      colors[i * 3 + 2] = (existing === undefined ? 1 : existing.getZ(i)) * base.b;
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute('glow', new THREE.BufferAttribute(new Float32Array(count).fill(part.material === 'Glow' ? 1 : 0), 1));
    if (geometry.getAttribute('normal') === undefined) geometry.computeVertexNormals();
    for (const name of Object.keys(geometry.attributes)) {
      if (name !== 'position' && name !== 'normal' && name !== 'color' && name !== 'glow') geometry.deleteAttribute(name);
    }
    geometry.morphAttributes = {};
    return geometry;
  });
  const merged = mergeGeometries(cleaned);
  if (merged === null) throw new Error('UndergroundView: a kit piece would not merge');
  return merged;
}

/** A box `w × h × d` standing on y = 0 at (x, z), for the stand-ins. */
function box(w: number, h: number, d: number, x: number, y: number, z: number, color: string, material = 'Body'): KitPart {
  const geometry = new THREE.BoxGeometry(w, h, d);
  geometry.translate(x, y + h / 2, z);
  return { geometry, color, material };
}

/** A flat ring at height `y`, for the shaft's stand-in. */
function ring(radius: number, tube: number, y: number, color: string, material = 'Body'): KitPart {
  const geometry = new THREE.TorusGeometry(radius, tube, 8, 24);
  geometry.rotateX(Math.PI / 2);
  geometry.translate(0, y, 0);
  return { geometry, color, material };
}

/**
 * §4.4: each piece's procedural stand-in, at the GLB's size and with its
 * front on +z — a box for a cache or the door, a ring for the shaft, an
 * octahedron for a beacon, a capsule for a cradle, a box for a rack.
 */
function standIn(id: CaveModelId): KitPart[] {
  switch (id) {
    case 'cave_cache':
      return [box(1.2, 0.9, 0.8, 0, 0, 0, '#6b665c'), box(1, 0.08, 0.04, 0, 0.58, 0.41, '#ffffff', 'Glow')];
    case 'cave_cache_open':
      // The lid stands open at the back; a spent cache has nothing left to glow.
      return [box(1.2, 0.6, 0.8, 0, 0, 0, '#6b665c'), box(1.2, 0.9, 0.06, 0, 0.6, -0.4, '#5a564e')];
    case 'cave_vault_door':
      return [box(3.4, 3.6, 1, 0, 0, 0, '#4a4e55'), box(0.6, 0.6, 0.1, 0, 1.3, 0.55, '#ffffff', 'Glow')];
    case 'cave_shaft':
      return [ring(1.3, 0.22, 0.22, '#5c5f66'), ring(1.05, 0.05, 0.3, '#ffffff', 'Glow')];
    case 'cave_rack':
      return [box(0.8, 2.2, 1.2, 0, 0, 0, '#2c3038'), box(0.6, 1.6, 0.04, 0, 0.3, 0.61, '#ffffff', 'Glow')];
    case 'cave_cradle': {
      const capsule = new THREE.CapsuleGeometry(0.4, 1.5, 4, 12);
      capsule.translate(0, 1.15, 0);
      return [{ geometry: capsule, color: '#ffffff', material: 'Body' }];
    }
    default: {
      // Every beacon and the puzzle pieces SPEC-055 draws.
      const octahedron = new THREE.OctahedronGeometry(0.3);
      octahedron.translate(0, 0.6, 0);
      return [{ geometry: octahedron, color: '#ffffff', material: 'Glow' }];
    }
  }
}

/** One kit piece as one geometry: the GLB once `assets` holds it (SPEC-052), else its stand-in. */
function kitGeometry(id: CaveModelId, assets: Assets | undefined, suit?: SuitColours): THREE.BufferGeometry {
  const parts = assets?.hasModel(id) === true ? modelParts(assets.model(id)) : standIn(id);
  return mergeKit(parts.length > 0 ? parts : standIn(id), suit);
}

/**
 * The kit's glow: the stock emissive (colour × intensity) masked per vertex by
 * the `glow` attribute, so a piece's body and its `Glow` parts share one draw.
 */
function injectVertexGlow(material: THREE.MeshStandardMaterial): void {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', 'attribute float glow;\nvarying float vGlow;\n#include <common>')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGlow = glow;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', 'varying float vGlow;\n#include <common>')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance *= vGlow;');
  };
  material.customProgramCacheKey = () => 'cave-glow/1';
}

// ----------------------------------------------------------------- the floor

/**
 * §4.4: the open space as one geometry — a 32-segment disc per room and a
 * `width`-wide quad between the centres of each corridor's rooms — with UVs
 * in world metres, as the terrain's (the map's repeat makes them tiles).
 * Overlaps shade identically, so they need no union.
 */
function floorGeometry(cave: ViewCave, width: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (const room of cave.rooms) {
    const disc = new THREE.CircleGeometry(room.r, ROOM_SEGMENTS);
    disc.rotateX(-Math.PI / 2);
    disc.translate(room.x, 0, room.z);
    parts.push(disc);
  }
  for (const corridor of cave.corridors) {
    const a = cave.rooms[corridor.a];
    const b = cave.rooms[corridor.b];
    if (a === undefined || b === undefined) continue;
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    if (length <= 0) continue;
    const quad = new THREE.PlaneGeometry(length, width);
    quad.rotateX(-Math.PI / 2);
    quad.rotateY(-Math.atan2(b.z - a.z, b.x - a.x));
    quad.translate((a.x + b.x) / 2, 0, (a.z + b.z) / 2);
    parts.push(quad);
  }
  if (parts.length === 0) return new THREE.BufferGeometry();
  const floor = mergeGeometries(parts);
  if (floor === null) throw new Error('UndergroundView: the floor would not merge');
  const position = floor.getAttribute('position') as THREE.BufferAttribute;
  const uv = floor.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < position.count; i++) {
    position.setY(i, 0); // exactly flat, whatever the rotations left behind
    uv.setXY(i, position.getX(i), position.getZ(i));
  }
  return floor;
}

/**
 * §4.12: a tray 0.8 m wide down each corridor's axis, rim to rim — not into
 * the rooms, where the shaft, the caches and the cradles stand — merged, with
 * how many trays it holds.
 */
function trayGeometry(cave: ViewCave): { geometry: THREE.BufferGeometry; trays: number } | null {
  const parts: THREE.BufferGeometry[] = [];
  for (const corridor of cave.corridors) {
    const a = cave.rooms[corridor.a];
    const b = cave.rooms[corridor.b];
    if (a === undefined || b === undefined) continue;
    const span = Math.hypot(b.x - a.x, b.z - a.z);
    const length = span - a.r - b.r;
    if (length <= 0) continue;
    const dx = (b.x - a.x) / span;
    const dz = (b.z - a.z) / span;
    const mid = (a.r + span - b.r) / 2;
    const tray = new THREE.BoxGeometry(length, TRAY_HEIGHT, TRAY_WIDTH);
    tray.translate(0, TRAY_HEIGHT / 2, 0);
    tray.rotateY(-Math.atan2(dz, dx));
    tray.translate(a.x + dx * mid, 0, a.z + dz * mid);
    parts.push(tray);
  }
  if (parts.length === 0) return null;
  const geometry = mergeGeometries(parts);
  return geometry === null ? null : { geometry, trays: parts.length };
}

/**
 * The unit direction from (x, z) into the open space it rings: toward the
 * centre of the room, or the axis of the corridor, whose edge is nearest.
 */
function inward(cave: ViewCave, width: number, x: number, z: number, out: { x: number; z: number }): void {
  let best = Infinity;
  out.x = 0;
  out.z = 1;
  for (const room of cave.rooms) {
    const d = Math.hypot(room.x - x, room.z - z);
    if (d > 0 && d - room.r < best) {
      best = d - room.r;
      out.x = (room.x - x) / d;
      out.z = (room.z - z) / d;
    }
  }
  for (const corridor of cave.corridors) {
    const a = cave.rooms[corridor.a];
    const b = cave.rooms[corridor.b];
    if (a === undefined || b === undefined) continue;
    const abx = b.x - a.x;
    const abz = b.z - a.z;
    const lengthSq = abx * abx + abz * abz;
    const t = lengthSq > 0 ? Math.min(1, Math.max(0, ((x - a.x) * abx + (z - a.z) * abz) / lengthSq)) : 0;
    const qx = a.x + abx * t - x;
    const qz = a.z + abz * t - z;
    const d = Math.hypot(qx, qz);
    if (d > 0 && d - width / 2 < best) {
      best = d - width / 2;
      out.x = qx / d;
      out.z = qz / d;
    }
  }
}

/** The beacons' spill: white, its alpha falling smoothly to nothing at the rim (32², built in JS). */
function spillTexture(size = 32): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  const centre = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const t = Math.min(1, Math.max(0, 1 - Math.hypot(x - centre, y - centre) / centre));
      const at = (y * size + x) * 4;
      data[at] = 255;
      data[at + 1] = 255;
      data[at + 2] = 255;
      data[at + 3] = Math.round(255 * t * t * (3 - 2 * t));
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

function topOf(geometry: THREE.BufferGeometry): number {
  geometry.computeBoundingBox();
  return geometry.boundingBox?.max.y ?? 1;
}

function widthOf(geometry: THREE.BufferGeometry): number {
  geometry.computeBoundingBox();
  const box3 = geometry.boundingBox;
  return box3 === null ? 1 : Math.max(1e-3, box3.max.x - box3.min.x);
}

function sphereOf(geometry: THREE.BufferGeometry): THREE.Sphere {
  geometry.computeBoundingSphere();
  return geometry.boundingSphere ?? new THREE.Sphere(new THREE.Vector3(), 1);
}

/** (x, 0, z), turned `yaw` about y and scaled (sx, sy, sz), into `out` at `at`. */
function writeMatrix(out: Float32Array, at: number, x: number, z: number, yaw: number, sx: number, sy: number, sz: number): void {
  scratchPosition.set(x, 0, z);
  scratchQuat.setFromAxisAngle(Y_AXIS, yaw);
  scratchScale.set(sx, sy, sz);
  scratchMatrix.compose(scratchPosition, scratchQuat, scratchScale);
  scratchMatrix.toArray(out, at * 16);
}

export class UndergroundView {
  /** Everything the cave draws; the surface view swaps it in for its environment. */
  readonly root = new THREE.Group();
  readonly #cave: ViewCave;
  readonly #dust: StormParticles;
  /** The wall layers — two rock variants, or Eden's racks — drawn through compaction. */
  readonly #walls: CulledInstances[] = [];
  readonly #cacheClosed: THREE.InstancedMesh;
  readonly #cacheOpen: THREE.InstancedMesh;
  /** Per `caches` entry: 1 once claimed. */
  readonly #claimed: Uint8Array;
  readonly #cradles: number;
  /** §4.12: what the walls draw as — `cave_rack` in the machine room. */
  readonly #wallModel: 'cave_rack' | 'rock';
  /** §4.12: the cable trays laid, one per corridor long enough to hold one. */
  readonly #trays: number;
  /** §4.12: the colours the cradles' suits wear, `#primary/#secondary`; `-` with no cradles. */
  readonly #suit: string;
  // SPEC-046 §4.6: the last view the walls were culled for.
  readonly #view = { x: 0, z: 0, distance: -1, fov: -1, aspect: -1 };
  readonly #rect: CullRect = { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };
  readonly #corners = new Float32Array(8);
  readonly #lastCorners = new Float32Array(8);
  #culled = false;

  constructor(
    parent: THREE.Object3D,
    u: ViewCave,
    def: UndergroundDef,
    biome: Biome,
    assets?: Assets,
    appearance?: { primary: string; secondary: string },
    dust = DUST_MOTES,
  ) {
    this.#cave = u;
    this.root.name = 'underground';
    parent.add(this.root);
    const planet = PLANETS[def.planet];
    const beacon = new THREE.Color(def.look.beacons.color);

    // Floor: the planet's first ground layer — the committed one once it is
    // in, as the terrain swaps it — times the cave's floor colour (§4.4).
    const layerId = planet.surface.look.ground.layers[0];
    const tileMetres = planet.surface.look.ground.tileMetres[0];
    const layer: GroundLayer =
      assets?.hasTexture?.(`${layerId}_albedo`) === true && assets.hasTexture(`${layerId}_nr`)
        ? layerFromAssets(assets, layerId, tileMetres)
        : { ...groundLayer(layerId), tileMetres };
    // The layers are shared; the terrain sets this same repeat on them.
    layer.albedo.repeat.setScalar(1 / tileMetres);
    layer.normalRough.repeat.setScalar(1 / tileMetres);
    const floorMaterial = new THREE.MeshStandardMaterial({
      map: layer.albedo,
      normalMap: layer.normalRough,
      color: def.look.floor,
      roughness: 1,
      metalness: 0,
      envMapIntensity: 0.25,
    });
    floorMaterial.normalScale.set(0.8, 0.8);
    const floor = new THREE.Mesh(floorGeometry(u, def.corridor), floorMaterial);
    floor.name = 'cave-floor';
    floor.receiveShadow = true;
    this.root.add(floor);

    // The kit's one material: authored colours under white, the glow parts
    // burning in the beacon colour.
    const kitMaterial = new THREE.MeshStandardMaterial({
      color: '#ffffff',
      vertexColors: true,
      roughness: 0.7,
      metalness: 0.2,
      emissive: beacon,
      emissiveIntensity: KIT_GLOW,
    });
    injectVertexGlow(kitMaterial);

    // Walls (§4.4): every `cave_wall` circle, at 1.3 × its radius and 2.4 m
    // tall, or 35 % of that where it is cut away.
    const walls: number[] = [];
    u.obstacles.forEach((o, i) => {
      if (o.kind === 'cave_wall') walls.push(i);
    });
    this.#wallModel = def.machineRoom === true ? 'cave_rack' : 'rock';
    if (def.machineRoom === true) {
      // §4.12: Eden's walls are racks, each along the wall's tangent with its
      // LEDs (+z) facing into the room or corridor it rings.
      const rack = kitGeometry('cave_rack', assets);
      const height = topOf(rack);
      const width = widthOf(rack);
      const matrices = new Float32Array(walls.length * 16);
      walls.forEach((index, slot) => {
        const o = u.obstacles[index] as ViewCave['obstacles'][number];
        inward(u, def.corridor, o.x, o.z, scratchInward);
        const cut = u.cutaway[index] === 1 ? CUTAWAY_HEIGHT : 1;
        const yaw = Math.atan2(scratchInward.x, scratchInward.z);
        writeMatrix(matrices, slot, o.x, o.z, yaw, (WALL_SPREAD * o.radius) / width, (WALL_HEIGHT * cut) / height, 1);
      });
      this.#addWalls(rack, kitMaterial, matrices);
    } else {
      const rockMaterial = new THREE.MeshStandardMaterial({
        color: planet.surface.palette.accent,
        vertexColors: true,
        roughness: 0.9,
        metalness: 0.05,
      });
      const seed = hash32(u.hash, 'wall');
      for (let variant = 0; variant < 2; variant++) {
        const mine = walls.filter((index) => hash32(u.hash, 'wall', index) % 2 === variant);
        if (mine.length === 0) continue;
        const rock = obstacleGeometry('rock', biome, hash32(u.hash, 'wall', 'variant', variant)).body;
        const height = topOf(rock);
        const matrices = new Float32Array(mine.length * 16);
        mine.forEach((index, slot) => {
          const o = u.obstacles[index] as ViewCave['obstacles'][number];
          const cut = u.cutaway[index] === 1 ? CUTAWAY_HEIGHT : 1;
          const spread = WALL_SPREAD * o.radius;
          writeMatrix(matrices, slot, o.x, o.z, hash01(seed, index) * Math.PI * 2, spread, (WALL_HEIGHT * cut) / height, spread);
        });
        this.#addWalls(rock, rockMaterial, matrices);
      }
    }

    // Caches (§4.8): closed and claimed, one instanced mesh each; a claim
    // moves an instance from the first to the second.
    const capacity = Math.max(1, u.caches.length);
    this.#cacheClosed = new THREE.InstancedMesh(kitGeometry('cave_cache', assets), kitMaterial, capacity);
    this.#cacheOpen = new THREE.InstancedMesh(kitGeometry('cave_cache_open', assets), kitMaterial, capacity);
    this.#cacheClosed.name = 'cave-caches';
    this.#cacheOpen.name = 'cave-caches-open';
    for (const mesh of [this.#cacheClosed, this.#cacheOpen]) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.root.add(mesh);
    }
    this.#claimed = new Uint8Array(u.caches.length);
    this.#writeCaches();

    // The vault door, across the corridor mouth it faces into, as wide as the
    // corridor; the shaft back up at the exit (§4.3). Drawn only.
    const doorGeometry = kitGeometry('cave_vault_door', assets);
    const door = new THREE.Mesh(doorGeometry, kitMaterial);
    door.name = 'cave-vault-door';
    door.position.set(u.vault.doorX, 0, u.vault.doorZ);
    door.rotation.y = Math.PI / 2 - u.vault.doorFacing;
    door.scale.x = def.corridor / widthOf(doorGeometry);
    const shaft = new THREE.Mesh(kitGeometry('cave_shaft', assets), kitMaterial);
    shaft.name = 'cave-shaft';
    shaft.position.set(u.exit.x, 0, u.exit.z);
    shaft.rotation.y = TOWARD_RIG;
    for (const mesh of [door, shaft]) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.root.add(mesh);
    }

    // Beacons (§4.4): instanced, never fogged, burning in the biome's colour;
    // each spills a little additive light on the floor round its foot.
    const beaconMaterial = new THREE.MeshStandardMaterial({
      color: '#ffffff',
      vertexColors: true,
      roughness: 0.5,
      metalness: 0.1,
      emissive: beacon,
      emissiveIntensity: def.look.beacons.emissive,
      fog: false,
    });
    injectVertexGlow(beaconMaterial);
    const beaconCount = Math.max(1, u.beacons.length);
    const beacons = new THREE.InstancedMesh(kitGeometry(`cave_beacon_${biome}`, assets), beaconMaterial, beaconCount);
    beacons.name = 'cave-beacons';
    const spillPlane = new THREE.PlaneGeometry(1, 1);
    spillPlane.rotateX(-Math.PI / 2);
    const spill = new THREE.InstancedMesh(
      spillPlane,
      new THREE.MeshBasicMaterial({
        color: beacon,
        map: spillTexture(),
        transparent: true,
        opacity: def.look.beacons.spill,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
      beaconCount,
    );
    spill.name = 'cave-beacon-spill';
    const beaconMatrices = beacons.instanceMatrix.array as Float32Array;
    const spillMatrices = spill.instanceMatrix.array as Float32Array;
    u.beacons.forEach((b, i) => {
      writeMatrix(beaconMatrices, i, b.x, b.z, TOWARD_RIG, 1, 1, 1);
      writeMatrix(spillMatrices, i, b.x, b.z, 0, SPILL_RADIUS * 2, 1, SPILL_RADIUS * 2);
      spillMatrices[i * 16 + 13] = SPILL_LIFT;
    });
    for (const mesh of [beacons, spill]) {
      mesh.count = u.beacons.length;
      mesh.visible = u.beacons.length > 0;
      mesh.instanceMatrix.needsUpdate = true;
      this.root.add(mesh);
    }

    // §4.12: Eden's cradle row, the suits in the save's colours, and the
    // cable trays down the corridors.
    this.#cradles = def.machineRoom === true ? u.cradles.length : 0;
    this.#suit = '-';
    this.#trays = 0;
    if (this.#cradles > 0) {
      const colours = appearance ?? DEFAULT_APPEARANCE;
      const suit: SuitColours = { primary: new THREE.Color(colours.primary), secondary: new THREE.Color(colours.secondary) };
      this.#suit = `#${suit.primary.getHexString()}/#${suit.secondary.getHexString()}`;
      const cradles = new THREE.InstancedMesh(kitGeometry('cave_cradle', assets, suit), kitMaterial, this.#cradles);
      cradles.name = 'cave-cradles';
      const matrices = cradles.instanceMatrix.array as Float32Array;
      u.cradles.forEach((c, i) => writeMatrix(matrices, i, c.x, c.z, Math.PI / 2 - c.facing, 1, 1, 1));
      cradles.instanceMatrix.needsUpdate = true;
      cradles.castShadow = true;
      cradles.receiveShadow = true;
      this.root.add(cradles);
    }
    if (def.machineRoom === true) {
      const laid = trayGeometry(u);
      if (laid !== null) {
        this.#trays = laid.trays;
        const trays = new THREE.Mesh(
          laid.geometry,
          new THREE.MeshStandardMaterial({
            color: '#30343c',
            roughness: 0.55,
            metalness: 0.6,
            emissive: beacon,
            emissiveIntensity: TRAY_EMISSIVE,
          }),
        );
        trays.name = 'cave-trays';
        trays.receiveShadow = true;
        this.root.add(trays);
      }
    }

    // Dust (§4.4): the motes, round the salvager.
    this.#dust = new StormParticles(this.root, rigBillboard(), Math.max(1, dust));
    this.#dust.set('dust', 1);
  }

  /** §4.12: the cradles in the vault room — 6 on Eden, else 0 (`sceneInfo.cradles`). */
  get cradles(): number {
    return this.#cradles;
  }

  /** §4.12: what the walls draw as — `cave_rack` in the machine room, else `rock` (`sceneInfo.caveWallModel`). */
  get wallModel(): 'cave_rack' | 'rock' {
    return this.#wallModel;
  }

  /** §4.12: the cable trays down the machine room's corridors; 0 in a cave (`sceneInfo.caveTrays`). */
  get trays(): number {
    return this.#trays;
  }

  /** §4.12: the colours the cradles' suits wear, `#primary/#secondary`, or `-` with none (`sceneInfo.cradleSuit`). */
  get suit(): string {
    return this.#suit;
  }

  /** Meshes under the root that can draw — each at most one draw call (§4.14's ≤ 12). */
  get drawObjects(): number {
    let count = 0;
    this.root.traverse((node) => {
      if ((node as THREE.Mesh).isMesh === true) count++;
    });
    return count;
  }

  /** Wall instances the last cull kept (every wall before the first `setView`). */
  get wallsDrawn(): number {
    let drawn = 0;
    for (const layer of this.#walls) drawn += layer.drawn;
    return drawn;
  }

  /** §4.8: the cache draws open from now on; an id not in this cave, or claimed already, changes nothing. */
  setClaimed(cache: CacheId): void {
    const caches = this.#cave.caches;
    for (let i = 0; i < caches.length; i++) {
      if ((caches[i] as ViewCave['caches'][number]).id !== cache || this.#claimed[i] === 1) continue;
      this.#claimed[i] = 1;
      this.#writeCaches();
      return;
    }
  }

  /** The dust drifts round the salvager. Allocates nothing. */
  sync(px: number, pz: number, time: number): void {
    this.#dust.sync(px, pz, time, FLAT);
  }

  /**
   * SPEC-046 §4.6, as `SurfaceView.setView`: the camera the scene placed —
   * its look-at point, distance, field of view, aspect and frustum. The walls
   * keep only what the rig can see, refreshed when the view has moved a metre
   * or changed shape. Never called, every wall draws.
   */
  setView(targetX: number, targetZ: number, camDistance: number, fovDeg: number, aspect: number, frustum: THREE.Frustum): void {
    const view = this.#view;
    let stale =
      !this.#culled ||
      Math.hypot(targetX - view.x, targetZ - view.z) >= CULL_REFRESH_DISTANCE ||
      camDistance !== view.distance ||
      fovDeg !== view.fov ||
      aspect !== view.aspect;
    const corners = this.#corners;
    const seen = frustumGroundCorners(frustum, corners);
    if (!stale && seen) {
      const last = this.#lastCorners;
      for (let i = 0; i < 8 && !stale; i += 2) {
        const dx = (corners[i] as number) - (last[i] as number);
        const dz = (corners[i + 1] as number) - (last[i + 1] as number);
        stale = dx * dx + dz * dz >= CULL_REFRESH_DISTANCE * CULL_REFRESH_DISTANCE;
      }
    }
    if (!stale) return;
    view.x = targetX;
    view.z = targetZ;
    view.distance = camDistance;
    view.fov = fovDeg;
    view.aspect = aspect;
    if (seen) this.#lastCorners.set(corners);
    const rect = this.#rect;
    for (let i = 0; i < this.#walls.length; i++) {
      const layer = this.#walls[i] as CulledInstances;
      const margin = cullMargin(layer.maxRadius, layer.maxHeight, fovDeg);
      viewRect(view, camDistance, fovDeg, aspect, margin, rect);
      extendByFrustum(frustum, margin, rect);
      layer.refresh(rect, frustum, CULL_REFRESH_DISTANCE);
    }
    this.#culled = true;
  }

  /** Takes the root out and frees every geometry, material, texture and instance buffer it built. */
  dispose(): void {
    this.#dust.dispose();
    this.root.removeFromParent();
    const instanced: THREE.InstancedMesh[] = [];
    this.root.traverse((node) => {
      if ((node as THREE.InstancedMesh).isInstancedMesh === true) instanced.push(node as THREE.InstancedMesh);
    });
    // The ground layers are shared (session or asset cache) and skipped.
    disposeObject3D(this.root);
    for (const mesh of instanced) mesh.dispose();
  }

  /** One wall layer: an instanced mesh of `geometry` drawn through compaction. */
  #addWalls(geometry: THREE.BufferGeometry, material: THREE.Material, matrices: Float32Array): void {
    const total = matrices.length / 16;
    const mesh = new THREE.InstancedMesh(geometry, material, total);
    mesh.name = 'cave-walls';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.#walls.push(new CulledInstances(mesh, { matrices }, sphereOf(geometry)));
    this.root.add(mesh);
  }

  /** The unclaimed caches into the closed mesh and the claimed into the open one, in layout order. */
  #writeCaches(): void {
    const closed = this.#cacheClosed;
    const open = this.#cacheOpen;
    const closedMatrices = closed.instanceMatrix.array as Float32Array;
    const openMatrices = open.instanceMatrix.array as Float32Array;
    let closedCount = 0;
    let openCount = 0;
    this.#cave.caches.forEach((cache, i) => {
      if (this.#claimed[i] === 1) writeMatrix(openMatrices, openCount++, cache.x, cache.z, TOWARD_RIG, 1, 1, 1);
      else writeMatrix(closedMatrices, closedCount++, cache.x, cache.z, TOWARD_RIG, 1, 1, 1);
    });
    for (const [mesh, count] of [
      [closed, closedCount],
      [open, openCount],
    ] as const) {
      mesh.count = count;
      mesh.visible = count > 0;
      mesh.instanceMatrix.needsUpdate = true;
      // The set changed: three re-measures the culling sphere on its next test.
      mesh.boundingSphere = null;
      mesh.boundingBox = null;
    }
  }
}
