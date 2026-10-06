// SPEC-054 §4.4, §4.12, §6.1 — the cave view, pinned in node on hand-made
// caves: the draw budget, the cut-away, the claimed cache, the stand-ins and
// the kit, Eden's machine room, and the dust. The fixtures place their walls
// as §4.3 does (rims at r + 1.2, corridor sides at 2.25 + 1.2, every 1.5 m,
// nothing inside another open shape) so the view reads a realistic layout
// without depending on the generator.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import type { Assets } from '@/core/Assets';
import { CAVE_ASSETS } from '@/data/assets';
import { UNDERGROUND, type UndergroundDef } from '@/data/caves';
import type { CacheId } from '@/data/ids';
import { PLANETS } from '@/data/planets';
import { groundLayer } from '@/views/ProceduralTextures';
import { DUST_BAND, DUST_BOX, DUST_FLOOR, STORM_LOOK } from '@/views/StormParticles';
import {
  CUTAWAY_HEIGHT,
  DUST_MOTES,
  KIT_GLOW,
  SPILL_RADIUS,
  TRAY_EMISSIVE,
  UndergroundView,
  WALL_HEIGHT,
  WALL_SPREAD,
  type ViewCave,
} from '@/views/UndergroundView';

type Room = { x: number; z: number; r: number };

const ROOMS: Room[] = [
  { x: 0, z: 0, r: 8 }, // the entrance
  { x: 24, z: 4, r: 7 },
  { x: -6, z: 26, r: 9 },
  { x: -28, z: -6, r: 6 },
  { x: 8, z: -28, r: 8 }, // the vault: a leaf
];
const CORRIDORS = [
  { a: 0, b: 1 },
  { a: 0, b: 2 },
  { a: 0, b: 3 },
  { a: 0, b: 4 },
  { a: 1, b: 2 }, // the loop edge
];
const CORRIDOR = 4.5;
/** §4.3 step 6: the rig's yaw on XZ. */
const CAMERA_DIR = { x: -Math.SQRT1_2, z: -Math.SQRT1_2 };

/** Distance from (x, z) to the segment a–b. */
function toSegment(x: number, z: number, a: Room, b: Room): { d: number; qx: number; qz: number } {
  const abx = b.x - a.x;
  const abz = b.z - a.z;
  const t = Math.min(1, Math.max(0, ((x - a.x) * abx + (z - a.z) * abz) / (abx * abx + abz * abz)));
  const qx = a.x + abx * t;
  const qz = a.z + abz * t;
  return { d: Math.hypot(x - qx, z - qz), qx, qz };
}

/** True when (x, z) is inside any open shape grown by `grow`, except the one it rings. */
function insideOpen(x: number, z: number, grow: number, skipRoom = -1, skipCorridor = -1): boolean {
  if (ROOMS.some((room, i) => i !== skipRoom && Math.hypot(x - room.x, z - room.z) < room.r + grow)) return true;
  return CORRIDORS.some((c, i) => i !== skipCorridor && toSegment(x, z, ROOMS[c.a] as Room, ROOMS[c.b] as Room).d < CORRIDOR / 2 + grow);
}

/** A cave in `ViewCave`'s shape: §4.3's walls, roles and beacons on the rooms above. */
function fixture(planet: 'cinder4' | 'eden'): ViewCave {
  const obstacles: ViewCave['obstacles'][number][] = [];
  const cut: number[] = [];
  const wall = (x: number, z: number, nx: number, nz: number): void => {
    if (insideOpen(x, z, 1.19)) return;
    obstacles.push({ x, z, radius: 1.1, kind: 'cave_wall' });
    cut.push(nx * CAMERA_DIR.x + nz * CAMERA_DIR.z > 0.3 ? 1 : 0);
  };
  ROOMS.forEach((room) => {
    const ring = room.r + 1.2;
    const n = Math.ceil((2 * Math.PI * ring) / 1.5);
    for (let k = 0; k < n; k++) {
      const angle = (k / n) * Math.PI * 2;
      wall(room.x + Math.cos(angle) * ring, room.z + Math.sin(angle) * ring, Math.cos(angle), Math.sin(angle));
    }
  });
  CORRIDORS.forEach((c) => {
    const a = ROOMS[c.a] as Room;
    const b = ROOMS[c.b] as Room;
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    const dx = (b.x - a.x) / length;
    const dz = (b.z - a.z) / length;
    for (const side of [-1, 1]) {
      const nx = -dz * side;
      const nz = dx * side;
      for (let s = 0; s <= length; s += 1.5) {
        wall(a.x + dx * s + nx * 3.45, a.z + dz * s + nz * 3.45, nx, nz);
      }
    }
  });
  const vault = ROOMS[4] as Room;
  const entrance = ROOMS[0] as Room;
  const toEntrance = Math.atan2(entrance.z - vault.z, entrance.x - vault.x);
  const cradles: ViewCave['cradles'][number][] = [];
  if (planet === 'eden') {
    // §4.3 step 4: six, 1.6 m apart, 1.5 m inside the back wall, facing the entrance.
    const back = toEntrance + Math.PI;
    const bx = vault.x + Math.cos(back) * (vault.r - 1.5);
    const bz = vault.z + Math.sin(back) * (vault.r - 1.5);
    for (let i = 0; i < 6; i++) {
      const along = (i - 2.5) * 1.6;
      const x = bx - Math.sin(back) * along;
      const z = bz + Math.cos(back) * along;
      cradles.push({ x, z, facing: toEntrance });
      obstacles.push({ x, z, radius: 0.6, kind: 'debris' });
      cut.push(0);
    }
  }
  const id = (slot: string): CacheId => `${planet}_${slot}` as CacheId;
  const caches = [
    { id: id('loose_a'), x: 26, z: 4 },
    { id: id('loose_b'), x: -6, z: 26 },
    { id: id('vault'), x: vault.x, z: vault.z },
  ];
  const door = { doorX: vault.x + Math.cos(toEntrance) * vault.r, doorZ: vault.z + Math.sin(toEntrance) * vault.r };
  const exit = { x: -2, z: -2 };
  return {
    hash: planet === 'eden' ? 0xeded : 0xc1d4,
    halfSize: 48,
    obstacles,
    rooms: ROOMS,
    corridors: CORRIDORS,
    exit,
    vault: { room: 4, ...door, doorFacing: toEntrance },
    caches,
    beacons: [
      { x: exit.x + 1, z: exit.z },
      { x: door.doorX + Math.cos(toEntrance), z: door.doorZ + Math.sin(toEntrance) },
      ...caches.map((c) => ({ x: c.x + 1, z: c.z })),
      { x: -5, z: 26 },
      { x: 1, z: 0 },
    ],
    cutaway: Uint8Array.from(cut),
    cradles,
  };
}

const CINDER: UndergroundDef = UNDERGROUND.cinder4;
const EDEN: UndergroundDef = UNDERGROUND.eden;

function meshesUnder(root: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  root.traverse((node) => {
    if ((node as THREE.Mesh).isMesh === true) out.push(node as THREE.Mesh);
  });
  return out;
}

function named(view: UndergroundView, name: string): THREE.Mesh[] {
  return meshesUnder(view.root).filter((mesh) => mesh.name === name);
}

function one<T extends THREE.Mesh = THREE.Mesh>(view: UndergroundView, name: string): T {
  const found = named(view, name);
  expect(found, name).toHaveLength(1);
  return found[0] as T;
}

/** Instance `slot`'s matrix, decomposed. */
function instance(mesh: THREE.InstancedMesh, slot: number): { position: THREE.Vector3; quaternion: THREE.Quaternion; scale: THREE.Vector3 } {
  const matrix = new THREE.Matrix4();
  mesh.getMatrixAt(slot, matrix);
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  matrix.decompose(position, quaternion, scale);
  return { position, quaternion, scale };
}

function topOf(geometry: THREE.BufferGeometry): number {
  geometry.computeBoundingBox();
  return (geometry.boundingBox as THREE.Box3).max.y;
}

/** The wall circle at (x, z), by position. */
function wallAt(cave: ViewCave, x: number, z: number): number {
  const index = cave.obstacles.findIndex((o) => o.kind === 'cave_wall' && Math.hypot(o.x - x, o.z - z) < 1e-4);
  expect(index, `a wall at ${x.toFixed(2)}, ${z.toFixed(2)}`).toBeGreaterThanOrEqual(0);
  return index;
}

/** A GLB-like model: one mesh per (material, box), COLOR_0 on all but `Glow`, as SPEC-052 commits them. */
function model(parts: readonly { material: string; size: [number, number, number]; y: number; color?: number }[]): THREE.Group {
  const root = new THREE.Group();
  for (const part of parts) {
    const geometry = new THREE.BoxGeometry(...part.size);
    geometry.translate(0, part.y + part.size[1] / 2, 0);
    if (part.material !== 'Glow') {
      const count = geometry.getAttribute('position').count;
      geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(count * 3).fill(0.9), 3));
    }
    const material = new THREE.MeshStandardMaterial({ color: part.color ?? 0xffffff });
    material.name = part.material;
    root.add(new THREE.Mesh(geometry, material));
  }
  return root;
}

const KIT_BODY = [
  { material: 'Body', size: [1, 1, 1] as [number, number, number], y: 0 },
  { material: 'Glow', size: [0.5, 0.2, 0.1] as [number, number, number], y: 1 },
];
const CRADLE_PARTS = [
  { material: 'Body', size: [1.2, 0.3, 1] as [number, number, number], y: 0 },
  { material: 'Suit', size: [0.6, 1.4, 0.4] as [number, number, number], y: 0.4 },
  { material: 'Trim', size: [0.7, 0.2, 0.5] as [number, number, number], y: 1.9 },
  { material: 'Glow', size: [0.2, 0.1, 0.1] as [number, number, number], y: 2.3 },
];

/** The cave kit landed: every `cave_*` id has a model. */
function kitAssets(cradle = CRADLE_PARTS): Assets {
  return {
    hasModel: (id: string) => id.startsWith('cave_'),
    model: (id: string) => model(id === 'cave_cradle' ? cradle : KIT_BODY),
  } as unknown as Assets;
}

describe('the cave view’s budget (SPEC-054 §4.4, §4.14)', () => {
  it('draws at most 12 objects — 10 in a cave, 11 in Eden’s machine room — with no light anywhere', () => {
    for (const [cave, def, biome, expected] of [
      [fixture('cinder4'), CINDER, 'desert', 10],
      [fixture('eden'), EDEN, 'temperate', 11],
    ] as const) {
      for (const assets of [undefined, kitAssets()]) {
        const parent = new THREE.Group();
        const view = new UndergroundView(parent, cave, def, biome, assets);
        expect(view.root.parent).toBe(parent);
        expect(view.drawObjects).toBeLessThanOrEqual(12);
        expect(view.drawObjects, def.planet).toBe(expected);
        expect(meshesUnder(view.root)).toHaveLength(view.drawObjects);
        // One draw each: no multi-material meshes.
        for (const mesh of meshesUnder(view.root)) expect(Array.isArray(mesh.material), mesh.name).toBe(false);
        let lights = 0;
        view.root.traverse((node) => {
          if (node instanceof THREE.Light) lights++;
        });
        expect(lights).toBe(0);
        view.dispose();
      }
    }
  });
});

describe('the cave’s walls (SPEC-054 §4.3 step 6, §4.4)', () => {
  it('draws every wall circle as one of two rock variants, 1.3 × its radius and 2.4 m tall — 35 % where cut away', () => {
    const cave = fixture('cinder4');
    const total = cave.obstacles.filter((o) => o.kind === 'cave_wall').length;
    const cut = Array.from(cave.cutaway).filter((c) => c === 1).length;
    expect(cut).toBeGreaterThan(10);
    expect(total - cut).toBeGreaterThan(10);
    const view = new UndergroundView(new THREE.Group(), cave, CINDER, 'desert');
    const layers = named(view, 'cave-walls') as THREE.InstancedMesh[];
    expect(layers).toHaveLength(2);
    expect(layers[0]?.geometry).not.toBe(layers[1]?.geometry);
    expect(layers.reduce((n, mesh) => n + mesh.count, 0)).toBe(total);
    expect(view.wallsDrawn).toBe(total);
    let cutSeen = 0;
    for (const mesh of layers) {
      const top = topOf(mesh.geometry);
      for (let slot = 0; slot < mesh.count; slot++) {
        const { position, scale } = instance(mesh, slot);
        const index = wallAt(cave, position.x, position.z);
        const o = cave.obstacles[index] as ViewCave['obstacles'][number];
        const height = scale.y * top;
        if (cave.cutaway[index] === 1) {
          cutSeen++;
          expect(height).toBeCloseTo(WALL_HEIGHT * CUTAWAY_HEIGHT, 5);
        } else {
          expect(height).toBeCloseTo(WALL_HEIGHT, 5);
        }
        expect(scale.x).toBeCloseTo(WALL_SPREAD * o.radius, 5);
        expect(scale.z).toBeCloseTo(WALL_SPREAD * o.radius, 5);
        expect(position.y).toBe(0);
      }
    }
    expect(cutSeen).toBe(cut);
    expect(CUTAWAY_HEIGHT).toBe(0.35);
    view.dispose();
  });

  it('culls the walls to what the rig sees once it has a view, and draws them all without one', () => {
    const cave = fixture('cinder4');
    const view = new UndergroundView(new THREE.Group(), cave, CINDER, 'desert');
    const total = view.wallsDrawn;
    // The fixed rig over the entrance: 55° down, 45° round, 22 m back.
    const camera = new THREE.PerspectiveCamera(40, 16 / 9, 0.5, 300);
    const pitch = (55 * Math.PI) / 180;
    const yaw = (45 * Math.PI) / 180;
    camera.position.set(22 * Math.cos(pitch) * Math.sin(yaw), 22 * Math.sin(pitch), 22 * Math.cos(pitch) * Math.cos(yaw));
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    const frustum = new THREE.Frustum().setFromProjectionMatrix(
      new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
    );
    view.setView(0, 0, 22, 40, 16 / 9, frustum);
    expect(view.wallsDrawn).toBeGreaterThan(0);
    expect(view.wallsDrawn).toBeLessThan(total);
    view.dispose();
  });

  it('draws Eden’s walls as racks, each along its wall’s tangent with its LEDs facing into the open space', () => {
    const cave = fixture('eden');
    const view = new UndergroundView(new THREE.Group(), cave, EDEN, 'temperate', kitAssets());
    const layers = named(view, 'cave-walls') as THREE.InstancedMesh[];
    expect(layers).toHaveLength(1); // §4.4: walls are one draw on Eden
    const racks = layers[0] as THREE.InstancedMesh;
    const walls = cave.obstacles.filter((o) => o.kind === 'cave_wall').length;
    expect(racks.count).toBe(walls);
    expect(racks.geometry.getAttribute('glow')).toBeDefined();
    const top = topOf(racks.geometry);
    let checked = 0;
    for (let slot = 0; slot < racks.count; slot++) {
      const { position, quaternion, scale } = instance(racks, slot);
      const index = wallAt(cave, position.x, position.z);
      expect(scale.y * top).toBeCloseTo(WALL_HEIGHT * (cave.cutaway[index] === 1 ? CUTAWAY_HEIGHT : 1), 5);
      // A rim wall's front points at its room's centre.
      const room = ROOMS.find((r) => Math.abs(Math.hypot(position.x - r.x, position.z - r.z) - (r.r + 1.2)) < 1e-6);
      if (room === undefined) continue;
      const front = new THREE.Vector3(0, 0, 1).applyQuaternion(quaternion);
      const toCentre = new THREE.Vector3(room.x - position.x, 0, room.z - position.z).normalize();
      expect(front.dot(toCentre)).toBeGreaterThan(0.999);
      checked++;
    }
    expect(checked).toBeGreaterThan(40);
    view.dispose();
  });
});

describe('the cave’s caches (SPEC-054 §4.8)', () => {
  it('setClaimed moves that cache’s instance from the closed mesh to the open one — once', () => {
    const cave = fixture('cinder4');
    const view = new UndergroundView(new THREE.Group(), cave, CINDER, 'desert');
    const closed = one<THREE.InstancedMesh>(view, 'cave-caches');
    const open = one<THREE.InstancedMesh>(view, 'cave-caches-open');
    expect(closed.count).toBe(3);
    expect(open.count).toBe(0);
    expect(open.visible).toBe(false);

    view.setClaimed('cinder4_loose_a');
    expect(closed.count).toBe(2);
    expect(open.count).toBe(1);
    expect(open.visible).toBe(true);
    const claimed = instance(open, 0).position;
    expect([claimed.x, claimed.z]).toEqual([26, 4]);
    const left = [instance(closed, 0).position, instance(closed, 1).position].map((p) => [p.x, p.z]);
    expect(left).toEqual([
      [-6, 26],
      [8, -28],
    ]);

    // Again, or an id this cave does not hold: nothing moves.
    view.setClaimed('cinder4_loose_a');
    view.setClaimed('vetra_loose_a');
    view.setClaimed('cinder4_relic');
    expect([closed.count, open.count]).toEqual([2, 1]);

    view.setClaimed('cinder4_vault');
    view.setClaimed('cinder4_loose_b');
    expect([closed.count, open.count]).toEqual([0, 3]);
    expect(closed.visible).toBe(false);
    view.dispose();
  });
});

describe('the kit and its stand-ins (SPEC-054 §4.4)', () => {
  it('draws every piece without assets: a box, a ring, an octahedron, with the glow parts marked', () => {
    const cave = fixture('cinder4');
    const view = new UndergroundView(new THREE.Group(), cave, CINDER, 'desert');
    for (const name of ['cave-floor', 'cave-caches', 'cave-caches-open', 'cave-vault-door', 'cave-shaft', 'cave-beacons', 'cave-beacon-spill']) {
      const mesh = one(view, name);
      expect(mesh.geometry.getAttribute('position').count, name).toBeGreaterThan(0);
    }
    // A stand-in beacon is all glow; a closed cache has a glowing strip on a dark body.
    const beaconGlow = one(view, 'cave-beacons').geometry.getAttribute('glow') as THREE.BufferAttribute;
    expect(Array.from(beaconGlow.array).every((g) => g === 1)).toBe(true);
    const cacheGlow = Array.from((one(view, 'cave-caches').geometry.getAttribute('glow') as THREE.BufferAttribute).array);
    expect(cacheGlow).toContain(0);
    expect(cacheGlow).toContain(1);
    // The shaft stand-in is a ring: nothing at its centre.
    const shaft = one(view, 'cave-shaft').geometry;
    shaft.computeBoundingBox();
    expect((shaft.boundingBox as THREE.Box3).max.x).toBeGreaterThan(1.2);
    view.dispose();
  });

  it('draws the GLBs once the kit is in: body and glow merged into one geometry each, authored colours kept', () => {
    const cave = fixture('cinder4');
    const view = new UndergroundView(new THREE.Group(), cave, CINDER, 'desert', kitAssets());
    const cache = one(view, 'cave-caches').geometry;
    // 2 boxes of 36 vertices: the model's, not the stand-in's.
    expect(cache.getAttribute('position').count).toBe(72);
    const glow = cache.getAttribute('glow') as THREE.BufferAttribute;
    const color = cache.getAttribute('color') as THREE.BufferAttribute;
    for (let i = 0; i < glow.count; i++) {
      if (glow.getX(i) === 0) expect(color.getX(i)).toBeCloseTo(0.9, 6); // COLOR_0 × a white material
    }
    const material = one(view, 'cave-caches').material as THREE.MeshStandardMaterial;
    expect(material.vertexColors).toBe(true);
    expect(material.color.getHex()).toBe(0xffffff);
    expect(material.emissive.getHex()).toBe(new THREE.Color(CINDER.look.beacons.color).getHex());
    expect(material.emissiveIntensity).toBe(KIT_GLOW);
    view.dispose();
  });

  it('turns the vault door to face into its corridor, as wide as the corridor', () => {
    const cave = fixture('cinder4');
    const view = new UndergroundView(new THREE.Group(), cave, CINDER, 'desert');
    const door = one(view, 'cave-vault-door');
    expect([door.position.x, door.position.z]).toEqual([cave.vault.doorX, cave.vault.doorZ]);
    const front = new THREE.Vector3(0, 0, 1).applyQuaternion(door.quaternion);
    expect(front.x).toBeCloseTo(Math.cos(cave.vault.doorFacing), 6);
    expect(front.z).toBeCloseTo(Math.sin(cave.vault.doorFacing), 6);
    door.geometry.computeBoundingBox();
    const width = (door.geometry.boundingBox as THREE.Box3).getSize(new THREE.Vector3()).x * door.scale.x;
    expect(width).toBeCloseTo(CINDER.corridor, 5);
    const shaft = one(view, 'cave-shaft');
    expect([shaft.position.x, shaft.position.z]).toEqual([cave.exit.x, cave.exit.z]);
    view.dispose();
  });

  it('lights the beacons in the biome colour, unfogged, each spilling additive light on the floor', () => {
    const cave = fixture('cinder4');
    const view = new UndergroundView(new THREE.Group(), cave, CINDER, 'desert');
    const beacons = one<THREE.InstancedMesh>(view, 'cave-beacons');
    expect(beacons.count).toBe(cave.beacons.length);
    const material = beacons.material as THREE.MeshStandardMaterial;
    expect(material.fog).toBe(false);
    expect(material.emissive.getHex()).toBe(new THREE.Color('#ffb45a').getHex());
    expect(material.emissiveIntensity).toBe(2.6);
    const spill = one<THREE.InstancedMesh>(view, 'cave-beacon-spill');
    expect(spill.count).toBe(cave.beacons.length);
    const spillMaterial = spill.material as THREE.MeshBasicMaterial;
    expect(spillMaterial.blending).toBe(THREE.AdditiveBlending);
    expect(spillMaterial.opacity).toBe(0.35);
    expect(spillMaterial.depthWrite).toBe(false);
    const { position, scale } = instance(spill, 0);
    expect([position.x, position.z]).toEqual([cave.beacons[0]?.x, cave.beacons[0]?.z]);
    expect(scale.x).toBeCloseTo(SPILL_RADIUS * 2, 6);
    // Everything else may take fog.
    for (const mesh of meshesUnder(view.root)) {
      if (mesh !== beacons) expect((mesh.material as THREE.Material & { fog?: boolean }).fog, mesh.name).not.toBe(false);
    }
    view.dispose();
  });

  it('floors the open space in one mesh: 32-segment room discs and corridor quads, world-space UVs, the planet’s first layer × the floor colour', () => {
    const cave = fixture('cinder4');
    const view = new UndergroundView(new THREE.Group(), cave, CINDER, 'desert');
    const floor = one(view, 'cave-floor');
    const geometry = floor.geometry;
    const triangles = (geometry.index?.count ?? geometry.getAttribute('position').count) / 3;
    expect(triangles).toBe(ROOMS.length * 32 + CORRIDORS.length * 2);
    const position = geometry.getAttribute('position') as THREE.BufferAttribute;
    const uv = geometry.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < position.count; i++) {
      expect(position.getY(i)).toBe(0);
      expect(uv.getX(i)).toBeCloseTo(position.getX(i), 5);
      expect(uv.getY(i)).toBeCloseTo(position.getZ(i), 5);
    }
    const material = floor.material as THREE.MeshStandardMaterial;
    expect(material.map).toBe(groundLayer(PLANETS.cinder4.surface.look.ground.layers[0]).albedo);
    expect(material.color.getHex()).toBe(new THREE.Color(CINDER.look.floor).getHex());
    view.dispose();
  });
});

describe('Eden’s machine room (SPEC-054 §4.12)', () => {
  it('reports 6 cradles there and none in a cave, with trays down the corridors at 0.3 emissive', () => {
    const plain = new UndergroundView(new THREE.Group(), fixture('cinder4'), CINDER, 'desert');
    expect(plain.cradles).toBe(0);
    expect(named(plain, 'cave-cradles')).toHaveLength(0);
    expect(named(plain, 'cave-trays')).toHaveLength(0);
    plain.dispose();

    const cave = fixture('eden');
    const eden = new UndergroundView(new THREE.Group(), cave, EDEN, 'temperate');
    expect(eden.cradles).toBe(6);
    const cradles = one<THREE.InstancedMesh>(eden, 'cave-cradles');
    expect(cradles.count).toBe(6);
    // Each faces the room's entrance: the front (+z) along `facing`.
    const { position, quaternion } = instance(cradles, 0);
    expect(position.x).toBeCloseTo(cave.cradles[0]?.x ?? NaN, 4); // instance matrices are float32
    expect(position.z).toBeCloseTo(cave.cradles[0]?.z ?? NaN, 4);
    const front = new THREE.Vector3(0, 0, 1).applyQuaternion(quaternion);
    expect(front.x).toBeCloseTo(Math.cos(cave.cradles[0]?.facing ?? 0), 6);
    expect(front.z).toBeCloseTo(Math.sin(cave.cradles[0]?.facing ?? 0), 6);
    const trays = one(eden, 'cave-trays');
    const trayMaterial = trays.material as THREE.MeshStandardMaterial;
    expect(trayMaterial.emissiveIntensity).toBe(TRAY_EMISSIVE);
    expect(trayMaterial.emissive.getHex()).toBe(new THREE.Color(EDEN.look.beacons.color).getHex());
    trays.geometry.computeBoundingBox();
    expect((trays.geometry.boundingBox as THREE.Box3).max.y).toBeLessThan(0.2);
    eden.dispose();
  });

  it('dresses the suits in the save’s colours: Suit takes the primary, Trim the secondary', () => {
    const appearance = { primary: '#33aa55', secondary: '#aa3355' };
    const view = new UndergroundView(new THREE.Group(), fixture('eden'), EDEN, 'temperate', kitAssets(), appearance);
    const geometry = one(view, 'cave-cradles').geometry;
    const position = geometry.getAttribute('position') as THREE.BufferAttribute;
    const color = geometry.getAttribute('color') as THREE.BufferAttribute;
    const primary = new THREE.Color(appearance.primary).multiplyScalar(0.9);
    const secondary = new THREE.Color(appearance.secondary).multiplyScalar(0.9);
    // Each part's box has its corners at heights no other part shares.
    const near = (y: number, ...levels: number[]): boolean => levels.some((level) => Math.abs(y - level) < 1e-5);
    let body = 0;
    let suit = 0;
    let trim = 0;
    for (let i = 0; i < position.count; i++) {
      const y = position.getY(i);
      const rgb = [color.getX(i), color.getY(i), color.getZ(i)];
      if (near(y, 0.4, 1.8)) {
        expect(rgb[0]).toBeCloseTo(primary.r, 5);
        expect(rgb[1]).toBeCloseTo(primary.g, 5);
        expect(rgb[2]).toBeCloseTo(primary.b, 5);
        suit++;
      } else if (near(y, 1.9, 2.1)) {
        expect(rgb[0]).toBeCloseTo(secondary.r, 5);
        expect(rgb[2]).toBeCloseTo(secondary.b, 5);
        trim++;
      } else if (near(y, 0, 0.3)) {
        expect(rgb).toEqual([0.9, 0.9, 0.9].map((v) => expect.closeTo(v, 5))); // the body keeps its own colour
        body++;
      }
    }
    expect([body, suit, trim]).toEqual([36, 36, 36]);
    view.dispose();
  });

  it('puts the primary on every mesh of a cradle without Suit or Trim — the stand-in capsule included', () => {
    const appearance = { primary: '#2266ee', secondary: '#ee6622' };
    const primary = new THREE.Color(appearance.primary);
    const bare = [{ material: 'Body', size: [1, 2, 1] as [number, number, number], y: 0 }];
    for (const assets of [kitAssets(bare), undefined]) {
      const view = new UndergroundView(new THREE.Group(), fixture('eden'), EDEN, 'temperate', assets, appearance);
      const color = one(view, 'cave-cradles').geometry.getAttribute('color') as THREE.BufferAttribute;
      const base = assets === undefined ? 1 : 0.9;
      for (let i = 0; i < color.count; i += 7) {
        expect(color.getX(i)).toBeCloseTo(primary.r * base, 5);
        expect(color.getZ(i)).toBeCloseTo(primary.b * base, 5);
      }
      view.dispose();
    }
  });
});

describe('the cave’s dust (SPEC-054 §4.4)', () => {
  it('pins the particle kinds and the dust’s look', () => {
    expect(Object.keys(STORM_LOOK).sort()).toEqual(['ash', 'dust', 'heat', 'sand', 'snow', 'spores']);
    expect(STORM_LOOK.dust).toMatchObject({ sprite: 'dot', width: 0.12, height: 0.12, speed: 0.3, color: '#b8c0cc', opacity: 0.35, additive: true, falling: false });
  });

  it('hangs 60 additive motes round the salvager, anchored in the world and drifting slowly', () => {
    const view = new UndergroundView(new THREE.Group(), fixture('cinder4'), CINDER, 'desert');
    const motes = meshesUnder(view.root).find((mesh) => (mesh as THREE.InstancedMesh).isInstancedMesh === true && mesh.name === '') as THREE.InstancedMesh;
    expect(motes).toBeDefined();
    expect(motes.visible).toBe(true);
    expect(motes.instanceMatrix.count).toBe(DUST_MOTES);
    const material = motes.material as THREE.MeshBasicMaterial;
    expect(material.blending).toBe(THREE.AdditiveBlending);
    expect(material.opacity).toBeCloseTo(0.35, 6);
    const at = (slot: number): THREE.Vector3 => instance(motes, slot).position;

    view.sync(10, -5, 20);
    expect(motes.count).toBe(DUST_MOTES);
    const before = Array.from({ length: DUST_MOTES }, (_, i) => at(i));
    for (const p of before) {
      expect(Math.abs(p.x - 10)).toBeLessThanOrEqual(DUST_BOX / 2);
      expect(Math.abs(p.z + 5)).toBeLessThanOrEqual(DUST_BOX / 2);
      expect(p.y).toBeGreaterThan(DUST_FLOOR - 0.2);
      expect(p.y).toBeLessThan(DUST_FLOOR + DUST_BAND + 0.2);
    }
    // A second later each mote has drifted well under half a metre — hanging, not falling.
    view.sync(10, -5, 21);
    let moved = 0;
    for (let i = 0; i < DUST_MOTES; i++) {
      const d = at(i).distanceTo(before[i] as THREE.Vector3);
      if (d < 1) {
        expect(d).toBeLessThan(0.5);
        moved++;
      }
    }
    expect(moved).toBeGreaterThan(DUST_MOTES - 4); // only a wrap at the box's edge jumps
    // Walking 3 m leaves the motes where they hang: any still in the box is unmoved.
    view.sync(10, -5, 21);
    const still = Array.from({ length: DUST_MOTES }, (_, i) => at(i));
    view.sync(13, -5, 21);
    let kept = 0;
    for (let i = 0; i < DUST_MOTES; i++) {
      const p = at(i);
      if (Math.abs((still[i] as THREE.Vector3).x - 13) < DUST_BOX / 2 - 0.01) {
        expect(p.x).toBeCloseTo((still[i] as THREE.Vector3).x, 4);
        expect(p.z).toBeCloseTo((still[i] as THREE.Vector3).z, 4);
        kept++;
      }
    }
    expect(kept).toBeGreaterThan(DUST_MOTES / 2);
    view.dispose();
  });
});

/** SPEC-052's committed kit, decoded as the game decodes it (GLTFLoader + MeshoptDecoder), behind `Assets`' two calls. */
async function committedKit(): Promise<Assets> {
  const scenes = new Map<string, THREE.Group>();
  for (const [id, url] of Object.entries(CAVE_ASSETS.models)) {
    const bytes = new Uint8Array(readFileSync(new URL(`../../public/${url}`, import.meta.url).pathname));
    const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes.buffer, '');
    scenes.set(id, gltf.scene);
  }
  return {
    hasModel: (id: string) => scenes.has(id),
    model: (id: string) => (scenes.get(id) as THREE.Group).clone(true),
  } as unknown as Assets;
}

/** Triangles the view submits with every instance drawn. */
function trianglesOf(view: UndergroundView): number {
  let total = 0;
  for (const mesh of meshesUnder(view.root)) {
    const geometry = mesh.geometry;
    const per = (geometry.index?.count ?? geometry.getAttribute('position').count) / 3;
    total += per * ((mesh as THREE.InstancedMesh).isInstancedMesh === true ? (mesh as THREE.InstancedMesh).count : 1);
  }
  return total;
}

describe('the committed kit (SPEC-052 §3.6 through SPEC-054 §4.4)', () => {
  it('draws every real piece as one geometry, keeps the budget, and dresses the real cradle’s suit', async () => {
    const assets = await committedKit();
    const appearance = { primary: '#33aa55', secondary: '#aa3355' };
    for (const [cave, def, biome, draws] of [
      [fixture('cinder4'), CINDER, 'desert', 10],
      [fixture('eden'), EDEN, 'temperate', 11],
    ] as const) {
      const view = new UndergroundView(new THREE.Group(), cave, def, biome, assets, appearance);
      expect(view.drawObjects).toBe(draws);
      for (const name of ['cave-caches', 'cave-caches-open', 'cave-vault-door', 'cave-shaft', 'cave-beacons']) {
        const glow = one(view, name).geometry.getAttribute('glow') as THREE.BufferAttribute;
        // Every committed piece carries a `Glow` part, merged in.
        expect(Array.from(glow.array).some((g) => g === 1), name).toBe(true);
        expect(Array.from(glow.array).some((g) => g === 0), name).toBe(true);
      }
      // The vault door's three nodes (Frame, Door, Lock) land in one geometry at their authored places.
      const door = one(view, 'cave-vault-door').geometry;
      door.computeBoundingBox();
      expect((door.boundingBox as THREE.Box3).getSize(new THREE.Vector3()).x).toBeCloseTo(3.4, 1);
      expect(trianglesOf(view)).toBeLessThan(def.machineRoom === true ? 90_000 : 120_000);
      if (def.machineRoom === true) {
        const color = one(view, 'cave-cradles').geometry.getAttribute('color') as THREE.BufferAttribute;
        const primary = new THREE.Color(appearance.primary);
        // The suit's near-white vertices (≥ 0.8, SPEC-052) now read as the primary, give or take that white.
        let dressed = 0;
        for (let i = 0; i < color.count; i++) {
          const r = color.getX(i);
          const g = color.getY(i);
          if (Math.abs(g / primary.g - r / primary.r) < 0.05 && g / primary.g > 0.75) dressed++;
        }
        expect(dressed).toBeGreaterThan(100);
      }
      view.dispose();
    }
  });
});

describe('the cave view’s dispose (SPEC-054 §4.4)', () => {
  it('takes the root out and frees every geometry and material it built, leaving the shared ground layer', () => {
    const parent = new THREE.Group();
    const view = new UndergroundView(parent, fixture('eden'), EDEN, 'temperate', kitAssets());
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    for (const mesh of meshesUnder(view.root)) {
      geometries.add(mesh.geometry);
      materials.add(mesh.material as THREE.Material);
    }
    const freed = new Set<object>();
    for (const resource of [...geometries, ...materials]) resource.addEventListener('dispose', () => freed.add(resource));
    const layer = groundLayer(PLANETS.eden.surface.look.ground.layers[0]).albedo;
    let layerFreed = false;
    layer.addEventListener('dispose', () => {
      layerFreed = true;
    });
    view.dispose();
    expect(parent.children).toHaveLength(0);
    for (const resource of [...geometries, ...materials]) expect(freed.has(resource)).toBe(true);
    expect(layerFreed).toBe(false);
  });
});
