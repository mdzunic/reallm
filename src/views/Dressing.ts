// The surface dressing (PLAN R28 / SPEC-067) — what keeps a planet from
// reading as a plate: stone rubble grounding every obstacle and landmark,
// lying loose in the open and banked against the arena wall; three biome
// dressing kinds placed in clumps across the arena and beside the POIs; and
// the landing site, the salvager's kit spread around the pad (review V-01).
//
// All of it is view-only. Nothing collides, nothing feeds the layout hash:
// every stream derives from `hash32(layout.hash, '<layer>')`, so two visits to
// one planet dress it identically. Rubble and each dressing kind are one
// `InstancedMesh` drawn through `InstanceCuller` (SPEC-046 §4.6); the landing
// site is one merged mesh. All of them share one material: the pieces' own
// colours baked per vertex under white (as SPEC-046's authored props), and a
// per-vertex `glow` that lights the lamp, the pods and the lava's seams in the
// same draw.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { HeightField } from '@/core/HeightField';
import { fbm2, hash01 } from '@/core/Noise';
import { hash32 } from '@/core/Rng';
import type { QualityPreset } from '@/core/Quality';
import type { DressingKind } from '@/data/ids';
import type { DressingLook, PlanetDef } from '@/data/planets';
import { LANDMARK_FOOTPRINT } from '@/views/SurfaceProps';
import type { ViewLayout } from '@/views/SurfaceView';

/** SPEC-067: the glow parts' emission — the vertex colour × this (*initial tuning*). */
export const DRESSING_GLOW = 2.4;

/** SPEC-067 (*initial tuning*): loose rubble clumps per 1,000 m²… */
export const RUBBLE_CLUMPS_PER_1000M2 = 2.4;
/** …the debris pushed to the edge of the pad clearing, one stone per this many metres of its rim… */
export const RUBBLE_BERM_SPACING = 0.75;
/** …one piece per this many metres of arena wall… */
export const RUBBLE_WALL_SPACING = 0.9;
/** …and the radius range of a piece, in metres (0.2–1.2 m across). */
export const RUBBLE_SIZE: readonly [number, number] = [0.1, 0.6];

/** Mirrors of `systems/Layout` and `ArenaWall` — views must not import systems. */
const PAD_CLEARING = 15;
const WALL_INSET = 2;
const WALL_LINE_OFFSET = 0.6;
/** The wall's inner face, inside `halfSize`. */
const WALL_FACE = WALL_INSET - WALL_LINE_OFFSET;
/** As `systems/Layout`'s `SPAWN_DISTANCE`: the salvager lands this far from the pad. */
const SPAWN_DISTANCE = 12;

/** SPEC-067: the landing site's ring around the pad's centre, in metres. */
export const LANDING_RING: readonly [number, number] = [6.8, 13];
/** The pad slab's rim, where the cables start. */
const PAD_RIM = 5.5;

const scratchColor = new THREE.Color();
const scratchMatrix = new THREE.Matrix4();
const scratchPosition = new THREE.Vector3();
const scratchQuat = new THREE.Quaternion();
const scratchScale = new THREE.Vector3();
const scratchEuler = new THREE.Euler();
const Y_AXIS = new THREE.Vector3(0, 1, 0);

// ---------------------------------------------------------------- material

/**
 * SPEC-067: the one dressing material — white under the baked vertex colour,
 * and the stock emissive (white × `DRESSING_GLOW`) masked per vertex by
 * `glow × colour`, so a piece and its lit parts are one draw.
 */
export function createDressingMaterial(): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    color: '#ffffff',
    roughness: 0.85,
    metalness: 0.05,
    vertexColors: true,
    emissive: new THREE.Color('#ffffff'),
    emissiveIntensity: DRESSING_GLOW,
  });
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', 'attribute float glow;\nvarying float vGlow;\n#include <common>')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGlow = glow;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', 'varying float vGlow;\n#include <common>')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance *= vGlow * vColor.rgb;');
  };
  material.customProgramCacheKey = () => 'dressing/1';
  return material;
}

// -------------------------------------------------------------- geometry kit

/** One part of a piece: flattened, with `colour` and `glow` on every vertex. */
function part(geometry: THREE.BufferGeometry, color: string, glow = 0): THREE.BufferGeometry {
  const flat = geometry.index === null ? geometry : geometry.toNonIndexed();
  for (const name of Object.keys(flat.attributes)) {
    if (name !== 'position' && name !== 'normal') flat.deleteAttribute(name);
  }
  const count = (flat.getAttribute('position') as THREE.BufferAttribute).count;
  scratchColor.set(color);
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    colors[i * 3] = scratchColor.r;
    colors[i * 3 + 1] = scratchColor.g;
    colors[i * 3 + 2] = scratchColor.b;
  }
  flat.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  flat.setAttribute('glow', new THREE.BufferAttribute(new Float32Array(count).fill(glow), 1));
  return flat;
}

function mergeParts(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const merged = mergeGeometries(parts);
  merged.computeBoundingSphere();
  return merged;
}

/** Moves every vertex out along its direction from `centre` by a seeded fbm — a lumpy rock or blob. */
function lumpy(geometry: THREE.BufferGeometry, seed: number, amount: number): THREE.BufferGeometry {
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    const k = 1 + amount * fbm2(seed, x * 1.7 + y * 0.9, z * 1.7 - y * 0.9, 3);
    position.setXYZ(i, x * k, y * k, z * k);
  }
  position.needsUpdate = true;
  geometry.computeVertexNormals();
  return geometry;
}

/** Darkens the baked colour of every vertex below `y` by `factor` — the dust skirt. */
function skirt(geometry: THREE.BufferGeometry, y: number, factor: number): THREE.BufferGeometry {
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  const color = geometry.getAttribute('color') as THREE.BufferAttribute;
  for (let i = 0; i < position.count; i++) {
    if (position.getY(i) >= y) continue;
    color.setXYZ(i, color.getX(i) * factor, color.getY(i) * factor, color.getZ(i) * factor);
  }
  return geometry;
}

/** Recolours the faces turned up (normal.y above `facing`) — moss, snow, a lit top. */
function topColour(geometry: THREE.BufferGeometry, facing: number, color: string): THREE.BufferGeometry {
  const normal = geometry.getAttribute('normal') as THREE.BufferAttribute;
  const colors = geometry.getAttribute('color') as THREE.BufferAttribute;
  scratchColor.set(color);
  for (let i = 0; i < normal.count; i++) {
    if (normal.getY(i) > facing) colors.setXYZ(i, scratchColor.r, scratchColor.g, scratchColor.b);
  }
  return geometry;
}

/**
 * A standing arc: a partial torus of radius `r` in the XY plane, centred on
 * +y, its two ends sunk `sink` below the ground — a rib, a root, an arch.
 */
function arch(r: number, tube: number, arc: number, sink: number, radial = 5, tubular = 9): THREE.BufferGeometry {
  const torus = new THREE.TorusGeometry(r, tube, radial, tubular, arc);
  torus.rotateZ(Math.PI / 2 - arc / 2);
  torus.translate(0, -r * Math.cos(arc / 2) - sink, 0);
  return torus;
}

/** A horizontal cylinder along x, `length` long, its axis `y` up. */
function lying(radius: number, length: number, y: number, segments: number, open = false): THREE.BufferGeometry {
  const cylinder = new THREE.CylinderGeometry(radius, radius, length, segments, 1, open);
  cylinder.rotateZ(Math.PI / 2);
  cylinder.translate(0, y, 0);
  return cylinder;
}

/** Vertices whose seeded noise clears `threshold` take `color` and glow 1 — the lava's seams. */
function seams(geometry: THREE.BufferGeometry, seed: number, threshold: number, color: string): THREE.BufferGeometry {
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  const colors = geometry.getAttribute('color') as THREE.BufferAttribute;
  const glows = geometry.getAttribute('glow') as THREE.BufferAttribute;
  scratchColor.set(color);
  for (let i = 0; i < position.count; i++) {
    const n = fbm2(seed, position.getX(i) * 3.1 + position.getY(i) * 2, position.getZ(i) * 3.1, 2);
    if (n < threshold) continue;
    colors.setXYZ(i, scratchColor.r, scratchColor.g, scratchColor.b);
    glows.setX(i, 1);
  }
  return geometry;
}

// ------------------------------------------------------------------ rubble

/**
 * SPEC-067: one rubble stone of radius 1 — a faceted, lumpy icosahedron (80
 * triangles), white under the instance colour, darker underneath. Instances
 * squash and stretch it per axis, so no two read alike.
 */
export function rubbleGeometry(): THREE.BufferGeometry {
  const rock = new THREE.IcosahedronGeometry(1, 1);
  lumpy(rock, 7, 0.28);
  const stone = part(rock, '#ffffff');
  stone.computeVertexNormals();
  skirt(stone, -0.25, 0.62);
  stone.computeBoundingSphere();
  return stone;
}

// ------------------------------------------------------------ dressing kinds

/** SPEC-067: how one dressing kind is placed (*initial tuning*). */
interface DressingSpec {
  /** Clumps per 10,000 m² of arena. */
  readonly clumps: number;
  readonly pieces: readonly [number, number];
  /** A clump's radius, or a row's spacing, in metres. */
  readonly spread: number;
  /** One piece's footprint radius, in metres — what keeps it off everything else. */
  readonly footprint: number;
  /** How far a piece keeps from the walking lines, past its footprint; 0 lets it lie beside them. */
  readonly corridor: number;
  /** A row lays a clump's pieces end to end along one heading — walls and survey posts. */
  readonly row?: true;
}

export const DRESSING: Readonly<Record<DressingKind, DressingSpec>> = {
  wurm_ribs: { clumps: 1.3, pieces: [1, 1], spread: 0, footprint: 2.4, corridor: 3 },
  scav_barrels: { clumps: 5, pieces: [1, 3], spread: 3.5, footprint: 1, corridor: 0.5 },
  pipe_run: { clumps: 3.1, pieces: [1, 2], spread: 4, footprint: 2.2, corridor: 1.5 },
  ice_shards: { clumps: 5.6, pieces: [1, 3], spread: 3.5, footprint: 0.9, corridor: 1 },
  buried_crate: { clumps: 3.4, pieces: [1, 2], spread: 2.5, footprint: 0.9, corridor: 0.5 },
  frozen_pipe: { clumps: 2.8, pieces: [1, 2], spread: 4, footprint: 2.2, corridor: 1.5 },
  fallen_log: { clumps: 3.6, pieces: [1, 2], spread: 4, footprint: 2.2, corridor: 1.5 },
  stone_drums: { clumps: 3.9, pieces: [1, 3], spread: 3, footprint: 1, corridor: 0.5 },
  root_arch: { clumps: 3.1, pieces: [1, 2], spread: 3, footprint: 1.3, corridor: 1.5 },
  basalt_stumps: { clumps: 5, pieces: [1, 3], spread: 3, footprint: 1, corridor: 0.5 },
  obsidian_shards: { clumps: 4.5, pieces: [1, 3], spread: 3, footprint: 0.8, corridor: 0.5 },
  lava_blobs: { clumps: 3.6, pieces: [1, 2], spread: 3, footprint: 1.2, corridor: 0.5 },
  chitin_ribs: { clumps: 3.6, pieces: [1, 2], spread: 3, footprint: 1.4, corridor: 1.5 },
  glow_pods: { clumps: 5.3, pieces: [1, 3], spread: 3, footprint: 0.7, corridor: 0.5 },
  resin_mound: { clumps: 3.6, pieces: [1, 2], spread: 3, footprint: 1.3, corridor: 0.5 },
  field_wall: { clumps: 2.8, pieces: [1, 3], spread: 6, footprint: 2.9, corridor: 1.5, row: true },
  marker_post: { clumps: 4.2, pieces: [3, 5], spread: 3, footprint: 0.3, corridor: 1, row: true },
  flower_bed: { clumps: 3.1, pieces: [1, 1], spread: 0, footprint: 1.5, corridor: 1 },
};

/** Cinder-4: a dead wurm's ribs arching out of the sand, and a vertebra or three. */
function wurmRibs(seed: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 5; i++) {
    const r = 1.9 - i * 0.22 + hash01(seed, i, 0) * 0.15;
    const rib = arch(r, 0.1 - i * 0.008, Math.PI * 0.82, 0.12);
    rib.rotateY((hash01(seed, i, 1) - 0.5) * 0.15);
    rib.rotateX((hash01(seed, i, 2) - 0.5) * 0.25);
    rib.translate(0, 0, (i - 2) * 0.72);
    parts.push(part(rib, i % 2 === 0 ? '#e6dcc4' : '#d8ccb0'));
  }
  for (let i = 0; i < 3; i++) {
    const bone = new THREE.CylinderGeometry(0.26, 0.3, 0.32, 7);
    bone.rotateX(Math.PI / 2 + (hash01(seed, i, 3) - 0.5) * 0.6);
    bone.translate(-0.4 + hash01(seed, i, 4) * 0.8, 0.12, -2.4 - i * 0.45);
    parts.push(part(bone, '#cfc2a4'));
  }
  return skirt(mergeParts(parts), 0.12, 0.7);
}

/** Cinder-4: the scavs' leavings — rusted barrels, one on its side, and a bent sheet. */
function scavBarrels(seed: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const upright = new THREE.CylinderGeometry(0.3, 0.3, 0.9, 10);
  upright.translate(0, 0.32, 0);
  parts.push(part(upright, '#8a4a2a'));
  for (const y of [0.1, 0.55]) {
    const band = new THREE.CylinderGeometry(0.315, 0.315, 0.06, 10, 1, true);
    band.translate(0, y, 0);
    parts.push(part(band, '#5a3020'));
  }
  const fallen = lying(0.3, 0.9, 0.24, 10);
  fallen.rotateY(0.6 + hash01(seed, 0) * 0.6);
  fallen.translate(0.85, 0, 0.35);
  parts.push(part(fallen, '#4a6a66'));
  const tilted = new THREE.CylinderGeometry(0.28, 0.28, 0.85, 10);
  tilted.rotateZ(0.45);
  tilted.translate(-0.55, 0.12, 0.55);
  parts.push(part(tilted, '#9a8a3a'));
  // A bent sheet of hull plate, half in the sand.
  const sheet = new THREE.BoxGeometry(1.5, 0.04, 0.95, 6, 1, 1);
  const position = sheet.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < position.count; i++) position.setY(i, position.getY(i) + 0.22 * Math.sin((position.getX(i) / 1.5 + 0.5) * Math.PI));
  sheet.computeVertexNormals();
  sheet.rotateZ(0.32);
  sheet.rotateY(-0.8);
  sheet.translate(-0.3, 0.12, -0.75);
  parts.push(part(sheet, '#7c8084'));
  return skirt(mergeParts(parts), 0.05, 0.7);
}

/** Cinder-4 and Vetra: a buried pipe run — a long segment with flanges, a broken stub beyond. */
function pipeRun(seed: number, frozen: boolean): THREE.BufferGeometry {
  const body = frozen ? '#8a9aaa' : '#7a6656';
  const flangeColour = frozen ? '#66788a' : '#54443a';
  const parts: THREE.BufferGeometry[] = [];
  const y = frozen ? 0.62 : 0.1;
  parts.push(part(lying(0.22, 3.4, y, 8, true), body));
  for (const x of [-1.7, 1.7]) {
    const flange = lying(0.31, 0.12, y, 8);
    flange.translate(x, 0, 0);
    parts.push(part(flange, flangeColour));
  }
  const stub = lying(0.22, 1.3, frozen ? y : 0.02, 8);
  stub.rotateY(0.25 + hash01(seed, 1) * 0.3);
  stub.translate(2.55, 0, 0.25);
  parts.push(part(stub, body));
  if (frozen) {
    // On two A-frame trestles, a frost crust along the top and icicles under it.
    for (const x of [-1.1, 1.1]) {
      for (const lean of [-0.28, 0.28]) {
        const leg = new THREE.BoxGeometry(0.08, 0.75, 0.08);
        leg.rotateX(lean);
        leg.translate(x, 0.32, 0);
        parts.push(part(leg, '#5a6672'));
      }
      const drift = new THREE.SphereGeometry(0.5, 7, 3, 0, Math.PI * 2, 0, Math.PI / 2);
      drift.scale(1, 0.35, 0.8);
      drift.translate(x, -0.02, 0);
      parts.push(part(drift, '#eef4fa'));
    }
    const crust = new THREE.CylinderGeometry(0.245, 0.245, 3.3, 8, 1, true, -Math.PI / 2, Math.PI);
    crust.rotateZ(Math.PI / 2);
    crust.translate(0, y + 0.01, 0);
    parts.push(part(crust, '#f4f8fc'));
    for (let i = 0; i < 6; i++) {
      const icicle = new THREE.ConeGeometry(0.035, 0.22 + hash01(seed, i, 2) * 0.18, 4);
      icicle.rotateX(Math.PI);
      icicle.translate(-1.4 + i * 0.55 + hash01(seed, i, 3) * 0.2, y - 0.3, 0);
      parts.push(part(icicle, '#cfe8f8', 0.12));
    }
  }
  return mergeParts(parts);
}

/** Vetra: a cluster of ice shards, the tallest under 1.3 m. */
function iceShards(seed: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const count = 5 + Math.floor(hash01(seed, 0) * 3);
  for (let i = 0; i < count; i++) {
    const shard = new THREE.OctahedronGeometry(1);
    const tall = i === 0 ? 1.25 : 0.45 + hash01(seed, i, 1) * 0.6;
    shard.scale(0.16 + hash01(seed, i, 2) * 0.12, tall * 0.55, 0.16 + hash01(seed, i, 3) * 0.1);
    shard.translate(0, tall * 0.35, 0);
    const angle = hash01(seed, i, 4) * Math.PI * 2;
    const out = i === 0 ? 0 : 0.25 + hash01(seed, i, 5) * 0.45;
    shard.rotateZ(Math.cos(angle) * out * 0.8);
    shard.rotateX(-Math.sin(angle) * out * 0.8);
    shard.translate(Math.cos(angle) * out, 0, Math.sin(angle) * out);
    parts.push(part(shard, i % 3 === 0 ? '#a8d0ee' : '#d6eefc', i === 0 ? 0.12 : 0));
  }
  return mergeParts(parts);
}

/** Vetra: a snow-buried supply crate, tipped, a stripe on its flank and snow on its lid. */
function buriedCrate(seed: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const tilt = 0.18 + hash01(seed, 0) * 0.15;
  const crate = new THREE.BoxGeometry(1.1, 0.8, 0.85);
  const stripe = new THREE.BoxGeometry(1.12, 0.16, 0.87);
  const cap = new THREE.SphereGeometry(0.62, 8, 3, 0, Math.PI * 2, 0, Math.PI / 2);
  cap.scale(1, 0.32, 0.8);
  cap.translate(0, 0.39, 0);
  for (const piece of [crate, stripe, cap]) {
    piece.rotateZ(tilt);
    piece.translate(0, 0.22, 0);
  }
  parts.push(part(crate, '#5e6a4c'), part(stripe, '#c8742c'), part(cap, '#f2f6fa'));
  const mound = new THREE.SphereGeometry(1, 9, 3, 0, Math.PI * 2, 0, Math.PI / 2);
  mound.scale(1.05, 0.28, 0.85);
  mound.translate(0.15, -0.02, 0);
  parts.push(part(mound, '#eaf2f8'));
  return mergeParts(parts);
}

/** Thessaly: a fallen trunk, moss on its back, two snapped branches and its root plate. */
function fallenLog(seed: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const trunk = new THREE.CylinderGeometry(0.36, 0.44, 4.2, 9, 3);
  trunk.rotateZ(Math.PI / 2);
  trunk.translate(0, 0.32, 0);
  parts.push(topColour(part(trunk, '#5c4630'), 0.55, '#58782e'));
  for (let i = 0; i < 2; i++) {
    const branch = new THREE.CylinderGeometry(0.06, 0.1, 0.7 + hash01(seed, i, 0) * 0.3, 5);
    branch.translate(0, 0.35, 0);
    branch.rotateZ(-0.5 - hash01(seed, i, 1) * 0.5);
    branch.rotateY(i === 0 ? 0.4 : -2.4);
    branch.translate(-0.6 + i * 1.3, 0.45, i === 0 ? 0.15 : -0.15);
    parts.push(part(branch, '#4e3c28'));
  }
  const roots = new THREE.CylinderGeometry(0.85, 0.6, 0.28, 9);
  roots.rotateZ(Math.PI / 2);
  roots.translate(2.2, 0.5, 0);
  parts.push(part(roots, '#4a3a26'));
  return skirt(mergeParts(parts), 0.08, 0.7);
}

/** Thessaly: toppled pillar drums and a squared block from the ruins nobody built. */
function stoneDrums(seed: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const upright = new THREE.CylinderGeometry(0.5, 0.52, 0.6, 12);
  upright.translate(0, 0.28, 0);
  parts.push(topColour(part(upright, '#b0a890'), 0.9, '#6e7c4a'));
  const toppled = lying(0.48, 0.55, 0.42, 12);
  toppled.rotateY(0.9 + hash01(seed, 0) * 0.5);
  toppled.translate(1.05, 0, 0.35);
  parts.push(topColour(part(toppled, '#a8a088'), 0.75, '#6a7846'));
  const block = new THREE.BoxGeometry(0.8, 0.55, 0.7);
  block.rotateY(hash01(seed, 1) * Math.PI);
  block.rotateZ(0.12);
  block.translate(-0.7, 0.22, 0.75);
  parts.push(topColour(part(block, '#9c9480'), 0.9, '#647244'));
  return skirt(mergeParts(parts), 0.06, 0.7);
}

/** Thessaly: arched roots breaking the floor, crossing. */
function rootArch(seed: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 3; i++) {
    const root = arch(0.75 + hash01(seed, i, 0) * 0.35, 0.12 - i * 0.02, Math.PI * 0.85, 0.08);
    root.rotateY(i * 1.1 + hash01(seed, i, 1) * 0.4);
    root.translate((hash01(seed, i, 2) - 0.5) * 0.6, 0, (hash01(seed, i, 3) - 0.5) * 0.6);
    parts.push(topColour(part(root, i === 1 ? '#4a3a26' : '#5c4630'), 0.7, '#5a7a32'));
  }
  return mergeParts(parts);
}

/** Ferrum: a cluster of basalt hex-column stumps, their tops paler. */
function basaltStumps(seed: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const spots: readonly (readonly [number, number])[] = [
    [0, 0],
    [0.62, 0],
    [0.31, 0.54],
    [-0.31, 0.54],
    [-0.62, 0],
    [-0.31, -0.54],
    [0.31, -0.54],
  ];
  spots.forEach(([x, z], i) => {
    if (i > 0 && hash01(seed, i, 0) < 0.3) return;
    const height = i === 0 ? 1.15 : 0.25 + hash01(seed, i, 1) * 0.7;
    const column = new THREE.CylinderGeometry(0.31, 0.33, height, 6);
    column.translate(0, height / 2 - 0.05, 0);
    column.rotateX((hash01(seed, i, 2) - 0.5) * 0.12);
    column.translate(x, 0, z);
    parts.push(topColour(part(column, '#3c3734'), 0.9, '#62584f'));
  });
  return mergeParts(parts);
}

/** Ferrum: obsidian shards like dropped blades, glassy black. */
function obsidianShards(seed: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 5; i++) {
    const shard = new THREE.OctahedronGeometry(1);
    const tall = 0.35 + hash01(seed, i, 0) * 0.65;
    shard.scale(0.22 + hash01(seed, i, 1) * 0.15, tall, 0.09);
    shard.translate(0, tall * 0.55, 0);
    shard.rotateZ((hash01(seed, i, 2) - 0.5) * 0.9);
    shard.rotateY(hash01(seed, i, 3) * Math.PI);
    shard.translate((hash01(seed, i, 4) - 0.5) * 1.2, 0, (hash01(seed, i, 5) - 0.5) * 1.2);
    parts.push(part(shard, i % 2 === 0 ? '#1c1820' : '#2e2638'));
  }
  return mergeParts(parts);
}

/** Ferrum: cooling lava blobs — black crust, the seams still molten. */
function lavaBlobs(seed: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 3; i++) {
    const blob = new THREE.IcosahedronGeometry(1, 1);
    lumpy(blob, seed + i, 0.35);
    const size = i === 0 ? 0.85 : 0.4 + hash01(seed, i, 0) * 0.3;
    blob.scale(size, size * 0.38, size * 0.8);
    blob.rotateY(hash01(seed, i, 1) * Math.PI);
    blob.translate(i === 0 ? 0 : (hash01(seed, i, 2) - 0.5) * 2, 0.05, i === 0 ? 0 : (hash01(seed, i, 3) - 0.5) * 2);
    const crust = part(blob, '#2a1d16');
    crust.computeVertexNormals();
    parts.push(seams(crust, seed + 10 + i, 0.12, '#ff7a30'));
  }
  return mergeParts(parts);
}

/**
 * The Hive: chitin ribs rising out of the floor round a centre and curling in
 * over it like a closing claw, each ending in a pale tip.
 */
function chitinRibs(seed: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  /** Where a rib's curl ends: 0.4 π round from its base at π. */
  const end = Math.PI * 0.4;
  for (let i = 0; i < 4; i++) {
    const r = 0.7 + hash01(seed, i, 0) * 0.3;
    // A quarter-and-more torus from (−r, 0) up and over toward +x, its base moved to the origin.
    const rib = new THREE.TorusGeometry(r, 0.085, 5, 8, Math.PI - end);
    rib.rotateZ(end);
    rib.translate(r, -0.05, 0);
    // The tip carries on along the curl's tangent.
    const tangentX = Math.sin(end);
    const tangentY = -Math.cos(end);
    const tip = new THREE.ConeGeometry(0.085, 0.4, 5);
    tip.rotateZ(Math.atan2(tangentY, tangentX) - Math.PI / 2);
    tip.translate(r * Math.cos(end) + r + tangentX * 0.2, r * Math.sin(end) - 0.05 + tangentY * 0.2, 0);
    const yaw = (i / 4) * Math.PI * 2 + hash01(seed, i, 1) * 0.6;
    for (const piece of [rib, tip]) {
      piece.translate(-0.85, 0, 0);
      piece.rotateX((hash01(seed, i, 2) - 0.5) * 0.3);
      piece.rotateY(yaw);
    }
    parts.push(part(rib, '#4c3c5c'), part(tip, '#9a84b0'));
  }
  return mergeParts(parts);
}

/** The Hive: glow pods on thin stalks from a low mound — flora, never eggs (cool green, not the eggs' magenta). */
function glowPods(seed: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const mound = new THREE.SphereGeometry(0.45, 7, 3, 0, Math.PI * 2, 0, Math.PI / 2);
  mound.scale(1, 0.4, 1);
  parts.push(part(mound, '#3a2c48'));
  const count = 4 + Math.floor(hash01(seed, 0) * 3);
  for (let i = 0; i < count; i++) {
    const height = 0.3 + hash01(seed, i, 1) * 0.5;
    const angle = (i / count) * Math.PI * 2 + hash01(seed, i, 2);
    const out = 0.12 + hash01(seed, i, 3) * 0.25;
    const stalk = new THREE.CylinderGeometry(0.02, 0.035, height, 4);
    stalk.translate(0, height / 2, 0);
    stalk.rotateZ(Math.cos(angle) * 0.35);
    stalk.rotateX(-Math.sin(angle) * 0.35);
    stalk.translate(Math.cos(angle) * out, 0.05, Math.sin(angle) * out);
    const bulb = new THREE.IcosahedronGeometry(0.09 + hash01(seed, i, 4) * 0.07, 0);
    bulb.translate(Math.cos(angle) * (out + height * 0.33), height * 0.95 + 0.05, Math.sin(angle) * (out + height * 0.33));
    parts.push(part(stalk, '#4a5a48'), part(bulb, '#7af0c0', 1));
  }
  return mergeParts(parts);
}

/** The Hive: a resin mound, lumpy and wet, with glowing blisters. */
function resinMound(seed: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const mound = new THREE.IcosahedronGeometry(1, 1);
  lumpy(mound, seed, 0.3);
  mound.scale(1.1, 0.55, 0.9);
  mound.translate(0, 0.05, 0);
  const body = part(mound, '#6a3e5e');
  body.computeVertexNormals();
  parts.push(skirt(body, 0.1, 0.65));
  for (let i = 0; i < 4; i++) {
    const blister = new THREE.IcosahedronGeometry(0.11 + hash01(seed, i, 0) * 0.08, 0);
    const angle = hash01(seed, i, 1) * Math.PI * 2;
    blister.translate(Math.cos(angle) * 0.6, 0.38 + hash01(seed, i, 2) * 0.12, Math.sin(angle) * 0.5);
    parts.push(part(blister, '#e080f0', 0.9));
  }
  return mergeParts(parts);
}

/** Eden: a field wall too perfect to be old — identical stones in exact courses. */
function fieldWall(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 7; i++) {
    const stone = new THREE.BoxGeometry(0.76, 0.3, 0.5);
    stone.translate(-2.4 + i * 0.8, 0.14, 0);
    parts.push(part(stone, i % 2 === 0 ? '#c8c0b0' : '#b8b0a0'));
  }
  for (let i = 0; i < 6; i++) {
    const stone = new THREE.BoxGeometry(0.76, 0.26, 0.44);
    stone.translate(-2 + i * 0.8, 0.42, 0);
    parts.push(part(stone, i % 2 === 0 ? '#bcb4a4' : '#ccc4b4'));
  }
  return skirt(mergeParts(parts), 0.05, 0.75);
}

/** Eden: a white survey post with a lit cap — they stand in exact lines. */
function markerPost(): THREE.BufferGeometry {
  const post = new THREE.BoxGeometry(0.12, 1, 0.12);
  post.translate(0, 0.48, 0);
  const cap = new THREE.BoxGeometry(0.16, 0.1, 0.16);
  cap.translate(0, 1.02, 0);
  return mergeParts([part(post, '#eeeee6'), part(cap, '#9af0ff', 1)]);
}

/** Eden: a perfectly round flower bed — a stone ring, dark soil, twelve identical flowers and one in the middle. */
function flowerBed(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const ring = new THREE.TorusGeometry(1.3, 0.12, 4, 18);
  ring.rotateX(Math.PI / 2);
  ring.translate(0, 0.06, 0);
  parts.push(part(ring, '#d8d0c0'));
  const soil = new THREE.CylinderGeometry(1.24, 1.24, 0.06, 18);
  soil.translate(0, 0.02, 0);
  parts.push(part(soil, '#5a4030'));
  for (let i = 0; i <= 12; i++) {
    const angle = (i / 12) * Math.PI * 2;
    const r = i === 12 ? 0 : 0.82;
    const x = Math.cos(angle) * r;
    const z = Math.sin(angle) * r;
    const stalk = new THREE.CylinderGeometry(0.015, 0.015, 0.36, 3);
    stalk.translate(x, 0.2, z);
    const head = new THREE.IcosahedronGeometry(0.09, 0);
    head.translate(x, 0.4, z);
    parts.push(part(stalk, '#4a8a3a'), part(head, i === 12 ? '#f0e070' : i % 2 === 0 ? '#f06080' : '#f8f0f0'));
  }
  return mergeParts(parts);
}

/** SPEC-067: one dressing kind's geometry, built once per visit from `seed`. */
export function dressingGeometry(kind: DressingKind, seed: number): THREE.BufferGeometry {
  switch (kind) {
    case 'wurm_ribs':
      return wurmRibs(seed);
    case 'scav_barrels':
      return scavBarrels(seed);
    case 'pipe_run':
      return pipeRun(seed, false);
    case 'ice_shards':
      return iceShards(seed);
    case 'buried_crate':
      return buriedCrate(seed);
    case 'frozen_pipe':
      return pipeRun(seed, true);
    case 'fallen_log':
      return fallenLog(seed);
    case 'stone_drums':
      return stoneDrums(seed);
    case 'root_arch':
      return rootArch(seed);
    case 'basalt_stumps':
      return basaltStumps(seed);
    case 'obsidian_shards':
      return obsidianShards(seed);
    case 'lava_blobs':
      return lavaBlobs(seed);
    case 'chitin_ribs':
      return chitinRibs(seed);
    case 'glow_pods':
      return glowPods(seed);
    case 'resin_mound':
      return resinMound(seed);
    case 'field_wall':
      return fieldWall();
    case 'marker_post':
      return markerPost();
    case 'flower_bed':
      return flowerBed();
  }
}

// ---------------------------------------------------------------- keepout

/** True when (x, z) lies inside the shelter's interior ellipse grown by `grow` (as `SurfaceView`'s). */
function insideShelter(shelter: ViewLayout['shelters'][number], x: number, z: number, grow: number): boolean {
  const dx = x - shelter.x;
  const dz = z - shelter.z;
  const cos = Math.cos(-shelter.angle);
  const sin = Math.sin(-shelter.angle);
  const u = dx * cos - dz * sin;
  const v = dx * sin + dz * cos;
  return (u / (shelter.rx + grow)) ** 2 + (v / (shelter.rz + grow)) ** 2 <= 1;
}

/** Distance from (x, z) to the segment a–b. */
function segmentDistance(x: number, z: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const length2 = dx * dx + dz * dz;
  const t = length2 > 0 ? Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / length2)) : 0;
  return Math.hypot(x - (ax + dx * t), z - (az + dz * t));
}

/** The margins one placement keeps, past its own footprint, in metres; `null` skips a test. */
interface Margins {
  pad: number;
  poi: number;
  obstacle: number | null;
  node: number;
  shelter: number;
  corridor: number | null;
  wall: number;
}

/**
 * SPEC-067: what dressing keeps off — the pad clearing, the POI rings, the
 * obstacles and small props, the nodes, the shelters, an orchard's lawn, the
 * walking lines from the pad to each objective (the corridors `systems/Layout`
 * keeps clear) and the wall. Built once per layout.
 */
class Keepout {
  readonly #layout: ViewLayout;
  readonly #pad: { x: number; z: number };
  readonly #lines: { x: number; z: number }[];
  readonly #orchards: NonNullable<ViewLayout['features']>[number][];

  constructor(layout: ViewLayout) {
    this.#layout = layout;
    const pad = layout.pois.find((poi) => poi.kind === 'landing_pad');
    this.#pad = pad === undefined ? { x: 0, z: 0 } : { x: pad.x, z: pad.z };
    this.#lines = layout.pois.filter((poi) => poi.kind !== 'landing_pad' && poi.kind !== 'landmark').map((poi) => ({ x: poi.x, z: poi.z }));
    this.#orchards = (layout.features ?? []).filter((f) => f.kind === 'orchard');
  }

  get pad(): { x: number; z: number } {
    return this.#pad;
  }

  /** How far (x, z) is from the nearest walking line. */
  corridorDistance(x: number, z: number): number {
    let nearest = Infinity;
    for (const line of this.#lines) nearest = Math.min(nearest, segmentDistance(x, z, this.#pad.x, this.#pad.z, line.x, line.z));
    return nearest;
  }

  /** True when a piece of radius `foot` at (x, z) keeps every margin; `except` is a POI it may stand in. */
  free(x: number, z: number, foot: number, m: Margins, except?: ViewLayout['pois'][number]): boolean {
    const layout = this.#layout;
    const reach = layout.halfSize - WALL_FACE - m.wall - foot;
    if (Math.abs(x) > reach || Math.abs(z) > reach) return false;
    if (Math.hypot(x - this.#pad.x, z - this.#pad.z) < m.pad + foot) return false;
    for (const poi of layout.pois) {
      if (poi.kind === 'landing_pad' || poi === except) continue;
      if (Math.hypot(x - poi.x, z - poi.z) < poi.radius + m.poi + foot) return false;
    }
    if (m.obstacle !== null) {
      for (const o of layout.obstacles) {
        if (Math.hypot(x - o.x, z - o.z) < o.radius + m.obstacle + foot) return false;
      }
      for (const prop of layout.props) {
        if (Math.hypot(x - prop.x, z - prop.z) < prop.scale * 0.8 + m.obstacle + foot) return false;
      }
    }
    for (const node of layout.nodes) {
      if (Math.hypot(x - node.x, z - node.z) < m.node + foot) return false;
    }
    for (const shelter of layout.shelters) {
      if (insideShelter(shelter, x, z, m.shelter + foot)) return false;
    }
    for (const orchard of this.#orchards) {
      const halfW = (orchard.halfW ?? orchard.radius) + 1 + foot;
      const halfD = (orchard.halfD ?? orchard.radius) + 1 + foot;
      if (Math.abs(x - orchard.x) <= halfW && Math.abs(z - orchard.z) <= halfD) return false;
    }
    if (m.corridor !== null && this.corridorDistance(x, z) < m.corridor + foot) return false;
    return true;
  }
}

/** One instanced layer's truth, as `CulledInstances` takes it. */
export interface DressingPlacement {
  matrices: Float32Array;
  colors: Float32Array;
  count: number;
}

function pack(matrices: number[], colors: number[]): DressingPlacement {
  return { matrices: new Float32Array(matrices), colors: new Float32Array(colors), count: colors.length / 3 };
}

// ------------------------------------------------------------ rubble placement

const RUBBLE_LOOSE: Margins = { pad: PAD_CLEARING + 1, poi: 1.5, obstacle: 0.3, node: 1.5, shelter: 1, corridor: 1.2, wall: 3 };
const RUBBLE_RING: Margins = { pad: PAD_CLEARING, poi: 0.5, obstacle: null, node: 1.5, shelter: 0.5, corridor: null, wall: 0 };
const RUBBLE_WALL: Margins = { pad: PAD_CLEARING, poi: 1, obstacle: null, node: 1.5, shelter: 0.5, corridor: null, wall: -WALL_FACE };
const RUBBLE_BERM: Margins = { pad: PAD_CLEARING, poi: 1, obstacle: 0, node: 1.5, shelter: 0.5, corridor: null, wall: 3 };

/**
 * SPEC-067: every rubble stone, deterministic from `hash32(layout.hash,
 * 'rubble')` — a ring at the base of each obstacle, small prop and landmark,
 * loose clumps in the open, and a band banked against the wall's inner face.
 * Each stone squashes the radius-1 rock per axis, tilts, sinks a third of its
 * height, and takes a colour between the look's two stones ± 15 %. `low`
 * keeps every second stone.
 */
export function placeRubble(
  layout: ViewLayout,
  field: HeightField,
  look: DressingLook,
  biome: PlanetDef['biome'],
  preset: QualityPreset,
): DressingPlacement {
  const seed = hash32(layout.hash, 'rubble');
  const keepout = new Keepout(layout);
  const stoneA = new THREE.Color(look.rubble[0]);
  const stoneB = new THREE.Color(look.rubble[1]);
  const matrices: number[] = [];
  const colors: number[] = [];
  let index = 0;
  const stone = (x: number, z: number, radius: number, margins: Margins, except?: ViewLayout['pois'][number]): void => {
    const i = index++;
    if (preset === 'low' && i % 2 === 1) return;
    if (!keepout.free(x, z, radius, margins, except)) return;
    const sx = radius * (0.85 + 0.4 * hash01(seed, i, 10));
    const sy = radius * (0.5 + 0.4 * hash01(seed, i, 11));
    const sz = radius * (0.85 + 0.4 * hash01(seed, i, 12));
    scratchEuler.set((hash01(seed, i, 13) - 0.5) * 0.6, hash01(seed, i, 14) * Math.PI * 2, (hash01(seed, i, 15) - 0.5) * 0.6);
    scratchQuat.setFromEuler(scratchEuler);
    scratchPosition.set(x, field.heightAt(x, z) - sy * 0.3, z);
    scratchScale.set(sx, sy, sz);
    scratchMatrix.compose(scratchPosition, scratchQuat, scratchScale);
    for (let e = 0; e < 16; e++) matrices.push(scratchMatrix.elements[e] as number);
    scratchColor.copy(stoneA).lerp(stoneB, hash01(seed, i, 16)).multiplyScalar(0.85 + 0.3 * hash01(seed, i, 17));
    colors.push(scratchColor.r, scratchColor.g, scratchColor.b);
  };
  const [small, large] = RUBBLE_SIZE;

  // Talus at the base of every drawn obstacle and small prop: a thin skirt all
  // round, and most of the stones spilled down one side — bigger rocks shed
  // bigger stones, further.
  layout.obstacles.forEach((o, k) => {
    if (o.kind === 'tree' || o.kind === 'cave_wall' || o.kind === 'wreck_hull') return;
    const n = Math.round(4 + 2.6 * o.radius);
    const grade = Math.min(1.6, Math.max(0.7, o.radius / 2));
    const spill = hash01(seed, k, 1) * Math.PI * 2;
    for (let j = 0; j < n; j++) {
      const spilled = j % 3 !== 0;
      const angle = spilled
        ? spill + (hash01(seed, k, j, 2) - 0.5) * 2.2
        : hash01(seed, k, j, 2) * Math.PI * 2;
      const out = hash01(seed, k, j, 4);
      const d = o.radius * (0.8 + 0.25 * hash01(seed, k, j, 3)) + (spilled ? out * out * 2.6 : out * 0.4);
      const radius = (small + (large - small) * 0.6 * hash01(seed, k, j, 5) ** 2) * grade * (spilled ? 1 - 0.4 * out : 1);
      stone(o.x + Math.cos(angle) * d, o.z + Math.sin(angle) * d, radius, RUBBLE_RING);
    }
  });
  layout.props.forEach((prop, k) => {
    if (prop.kind.startsWith('tree')) return;
    for (let j = 0; j < 3; j++) {
      const angle = ((j + hash01(seed, k, j, 6)) / 3) * Math.PI * 2;
      const d = prop.scale * (0.7 + 0.5 * hash01(seed, k, j, 7));
      stone(prop.x + Math.cos(angle) * d, prop.z + Math.sin(angle) * d, small + 0.12 * hash01(seed, k, j, 8), RUBBLE_RING);
    }
  });
  // Landmarks: a wide, uneven skirt of bigger stones round the drawn footprint.
  const footprint = LANDMARK_FOOTPRINT[biome];
  layout.pois.forEach((poi, k) => {
    if (poi.kind !== 'landmark') return;
    for (let j = 0; j < 22; j++) {
      const angle = hash01(seed, k, j, 20) * Math.PI * 2;
      const out = hash01(seed, k, j, 21);
      const d = footprint * (0.8 + 0.9 * out * out);
      const radius = (small + (large - small) * (0.25 + 0.75 * hash01(seed, k, j, 22) ** 2)) * (1 - 0.45 * out);
      stone(poi.x + Math.cos(angle) * d, poi.z + Math.sin(angle) * d, radius, RUBBLE_RING, poi);
    }
  });

  // The pad clearing's rim: debris pushed aside when the ground was cleared,
  // in drifts along the edge and broken where a walking line leaves.
  const pad = keepout.pad;
  const rim = 2 * Math.PI * (PAD_CLEARING + 2);
  for (let j = 0; j < rim / RUBBLE_BERM_SPACING; j++) {
    const angle = (j / (rim / RUBBLE_BERM_SPACING)) * Math.PI * 2 + hash01(seed, j, 70) * 0.05;
    // Drifts: a slow noise round the rim decides where the stones pile.
    if (fbm2(seed + 5, Math.cos(angle) * 2.2, Math.sin(angle) * 2.2, 2) < -0.05) continue;
    const out = hash01(seed, j, 71);
    const d = PAD_CLEARING + 0.5 + out * 4.5;
    const x = pad.x + Math.cos(angle) * d;
    const z = pad.z + Math.sin(angle) * d;
    if (keepout.corridorDistance(x, z) < 2.5) continue;
    stone(x, z, small + (large - small) * 0.6 * (1 - out) * hash01(seed, j, 72), RUBBLE_BERM);
  }

  // Loose clumps in the open: one large stone and a few small ones round it.
  const clumps = Math.round((RUBBLE_CLUMPS_PER_1000M2 * (2 * layout.halfSize) ** 2) / 1000);
  const reach = layout.halfSize - 4;
  for (let c = 0, tries = 0; c < clumps && tries < clumps * 6; tries++) {
    const cx = (hash01(seed, tries, 30) * 2 - 1) * reach;
    const cz = (hash01(seed, tries, 31) * 2 - 1) * reach;
    if (!keepout.free(cx, cz, 1, RUBBLE_LOOSE)) continue;
    c++;
    const pieces = 3 + Math.floor(hash01(seed, tries, 32) * 5);
    for (let j = 0; j < pieces; j++) {
      const angle = hash01(seed, tries, j + 40) * Math.PI * 2;
      const d = j === 0 ? 0 : 0.5 + 2 * hash01(seed, tries, j + 60);
      const radius = j === 0 ? 0.3 + 0.3 * hash01(seed, tries, 33) : small + (large - small) * 0.35 * hash01(seed, tries, j + 80);
      stone(cx + Math.cos(angle) * d, cz + Math.sin(angle) * d, radius, RUBBLE_LOOSE);
    }
  }

  // Banked against the wall: most stones within a metre of its face, bigger
  // near it. Only the west and north walls' inner faces turn toward the fixed
  // rig (SPEC-012 §4.3: the camera sits south-east of its target); the east
  // and south walls hide their feet from it, so they get none.
  const face = layout.halfSize - WALL_FACE;
  for (const edge of [1, 3]) {
    for (let t = -face, j = 0; t < face; j++) {
      const depth = 0.1 + 3.6 * hash01(seed, edge, j, 50) ** 2;
      const radius = small + (large - small) * (1 - depth / 4) * (0.25 + 0.75 * hash01(seed, edge, j, 51));
      const inward = face - depth;
      const x = edge === 1 ? -inward : t;
      const z = edge === 3 ? -inward : t;
      stone(x, z, radius, RUBBLE_WALL);
      t += RUBBLE_WALL_SPACING * (0.5 + hash01(seed, edge, j, 52));
    }
  }
  return pack(matrices, colors);
}

// ---------------------------------------------------------- dressing placement

const DRESSING_FIELD: Margins = { pad: PAD_CLEARING + 1, poi: 2.5, obstacle: 0.4, node: 2.5, shelter: 2, corridor: 0, wall: 3 };

/**
 * SPEC-067: the three dressing kinds' instances, deterministic from
 * `hash32(layout.hash, 'dressing')`. Each kind lays its `clumps` per
 * 10,000 m² — a clump scattered within `spread`, or a row end to end — off
 * every keepout and the other pieces; then one or two pieces stand beside
 * each POI, outside its trigger ring. `low` keeps every second clump.
 */
export function placeDressing(
  layout: ViewLayout,
  field: HeightField,
  kinds: readonly DressingKind[],
  preset: QualityPreset,
): DressingPlacement[] {
  const seed = hash32(layout.hash, 'dressing');
  const keepout = new Keepout(layout);
  const placed: { x: number; z: number; foot: number }[] = [];
  const out = kinds.map(() => ({ matrices: [] as number[], colors: [] as number[] }));
  const area = (2 * layout.halfSize) ** 2;
  const fits = (x: number, z: number, spec: DressingSpec, margins: Margins): boolean => {
    if (!keepout.free(x, z, spec.footprint, { ...margins, corridor: spec.corridor })) return false;
    for (const other of placed) {
      if (Math.hypot(x - other.x, z - other.z) < spec.footprint + other.foot + 0.3) return false;
    }
    return true;
  };
  const put = (k: number, x: number, z: number, yaw: number, scale: number, shade: number): void => {
    const spec = DRESSING[kinds[k] as DressingKind];
    scratchQuat.setFromAxisAngle(Y_AXIS, yaw);
    scratchPosition.set(x, field.heightAt(x, z), z);
    scratchScale.setScalar(scale);
    scratchMatrix.compose(scratchPosition, scratchQuat, scratchScale);
    const layer = out[k] as { matrices: number[]; colors: number[] };
    for (let e = 0; e < 16; e++) layer.matrices.push(scratchMatrix.elements[e] as number);
    layer.colors.push(shade, shade, shade);
    placed.push({ x, z, foot: spec.footprint * scale });
  };

  kinds.forEach((kind, k) => {
    const spec = DRESSING[kind];
    const clumps = Math.round((spec.clumps * area) / 10_000);
    const reach = layout.halfSize - 4;
    for (let c = 0, tries = 0; c < clumps && tries < clumps * 10; tries++) {
      const cx = (hash01(seed, k, tries, 0) * 2 - 1) * reach;
      const cz = (hash01(seed, k, tries, 1) * 2 - 1) * reach;
      if (!fits(cx, cz, spec, DRESSING_FIELD)) continue;
      c++;
      if (preset === 'low' && c % 2 === 0) continue;
      const pieces = spec.pieces[0] + Math.floor(hash01(seed, k, tries, 2) * (spec.pieces[1] - spec.pieces[0] + 1));
      const heading = hash01(seed, k, tries, 3) * Math.PI * 2;
      for (let j = 0; j < pieces; j++) {
        let x = cx;
        let z = cz;
        let yaw = heading;
        if (j > 0 && spec.row === true) {
          // A row: end to end along the heading, exact — Eden's lines do not wander.
          x = cx + Math.cos(heading) * spec.spread * j;
          z = cz - Math.sin(heading) * spec.spread * j;
        } else if (j > 0) {
          const angle = hash01(seed, k, tries, j + 10) * Math.PI * 2;
          const d = spec.footprint * 1.6 + hash01(seed, k, tries, j + 20) * spec.spread;
          x = cx + Math.cos(angle) * d;
          z = cz + Math.sin(angle) * d;
          yaw = hash01(seed, k, tries, j + 30) * Math.PI * 2;
        }
        if (j > 0 && !fits(x, z, spec, DRESSING_FIELD)) continue;
        const scale = spec.row === true ? 1 : 0.85 + 0.35 * hash01(seed, k, tries, j + 40);
        put(k, x, z, yaw, scale, 0.9 + 0.2 * hash01(seed, k, tries, j + 50));
      }
    }
  });

  // Beside the POIs, outside the trigger ring: one or two pieces of a hashed kind.
  layout.pois.forEach((poi, p) => {
    if (poi.kind === 'landing_pad') return;
    const pieces = 1 + Math.floor(hash01(seed, p, 90) * 2);
    for (let j = 0; j < pieces; j++) {
      const k = Math.floor(hash01(seed, p, j, 91) * kinds.length);
      const spec = DRESSING[kinds[k] as DressingKind];
      for (let attempt = 0; attempt < 6; attempt++) {
        const angle = hash01(seed, p, j * 8 + attempt, 92) * Math.PI * 2;
        const d = poi.radius + 2.5 + spec.footprint + hash01(seed, p, j * 8 + attempt, 93) * 3;
        const x = poi.x + Math.cos(angle) * d;
        const z = poi.z + Math.sin(angle) * d;
        if (!fits(x, z, spec, { ...DRESSING_FIELD, poi: 2.5 })) continue;
        put(k, x, z, hash01(seed, p, j, 94) * Math.PI * 2, 1, 0.9 + 0.2 * hash01(seed, p, j, 95));
        break;
      }
    }
  });
  return out.map((layer) => pack(layer.matrices, layer.colors));
}

// ------------------------------------------------------------- landing site

/** A world-space part of the landing site, set down at (x, z) on the ground, turned `yaw`. */
function setDown(field: HeightField, geometry: THREE.BufferGeometry, x: number, z: number, yaw: number): THREE.BufferGeometry {
  geometry.rotateY(yaw);
  geometry.translate(x, field.heightAt(x, z), z);
  return geometry;
}

/** A crate stack on a pallet: two or three boxes in the salvager's orange and greys. */
function crateStack(seed: number): THREE.BufferGeometry[] {
  const parts: THREE.BufferGeometry[] = [];
  const pallet = new THREE.BoxGeometry(1.5, 0.14, 1.2);
  pallet.translate(0, 0.07, 0);
  parts.push(part(pallet, '#7a6a52'));
  const big = new THREE.BoxGeometry(1, 0.9, 1);
  big.translate(-0.2, 0.59, 0);
  const band = new THREE.BoxGeometry(1.02, 0.14, 1.02);
  band.translate(-0.2, 0.62, 0);
  const second = new THREE.BoxGeometry(0.7, 0.6, 0.7);
  second.rotateY(0.3);
  second.translate(0.45, 0.44, 0.15);
  const top = new THREE.BoxGeometry(0.6, 0.5, 0.6);
  top.rotateY(-0.2 + hash01(seed, 0) * 0.4);
  top.translate(-0.15, 1.29, 0.05);
  parts.push(part(big, '#c8742c'), part(band, '#3a3c40'), part(second, '#5e6874'), part(top, '#c8742c'));
  return parts;
}

/** A fuel bladder: a flattened black bag strapped yellow, with a pump. */
function fuelBladder(): THREE.BufferGeometry[] {
  const bag = new THREE.SphereGeometry(1, 12, 6);
  bag.scale(1.5, 0.42, 1);
  bag.translate(0, 0.3, 0);
  const parts = [part(bag, '#2e3236')];
  for (const x of [-0.6, 0.6]) {
    const strap = new THREE.BoxGeometry(0.12, 0.05, 2.05);
    strap.translate(x, 0.66, 0);
    parts.push(part(strap, '#d0a030'));
  }
  const pump = new THREE.BoxGeometry(0.5, 0.5, 0.4);
  pump.translate(1.75, 0.25, 0.1);
  const lamp = new THREE.BoxGeometry(0.08, 0.06, 0.08);
  lamp.translate(1.75, 0.53, 0.1);
  parts.push(part(pump, '#5e6874'), part(lamp, '#60ff90', 1));
  return parts;
}

/** A lamp mast: a tripod, a 3.6 m pole and a lamp head lit toward the pad (−x). */
function lampMast(): THREE.BufferGeometry[] {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 3; i++) {
    const leg = new THREE.CylinderGeometry(0.03, 0.04, 1.2, 4);
    leg.translate(0, 0.55, 0);
    leg.rotateX(0.45);
    leg.rotateY((i / 3) * Math.PI * 2);
    parts.push(part(leg, '#4a4e54'));
  }
  const pole = new THREE.CylinderGeometry(0.05, 0.06, 3.6, 5);
  pole.translate(0, 1.8, 0);
  const head = new THREE.BoxGeometry(0.3, 0.26, 0.5);
  head.translate(-0.1, 3.6, 0);
  const face = new THREE.BoxGeometry(0.04, 0.2, 0.44);
  face.translate(-0.27, 3.58, 0);
  // An amber beacon on top, the light the rig sees from above.
  const beacon = new THREE.IcosahedronGeometry(0.11, 0);
  beacon.translate(-0.1, 3.84, 0);
  parts.push(part(pole, '#5a5e64'), part(head, '#3a3c40'), part(face, '#fff2cc', 1), part(beacon, '#ffb040', 1));
  return parts;
}

/** Three barrels and one on its side. */
function barrelGroup(): THREE.BufferGeometry[] {
  const parts: THREE.BufferGeometry[] = [];
  const spots: readonly (readonly [number, number, string])[] = [
    [0, 0, '#a03a2a'],
    [0.66, 0.1, '#c8a838'],
    [0.3, 0.62, '#a03a2a'],
  ];
  for (const [x, z, colour] of spots) {
    const barrel = new THREE.CylinderGeometry(0.3, 0.3, 0.9, 10);
    barrel.translate(x, 0.45, z);
    const lid = new THREE.CylinderGeometry(0.26, 0.26, 0.02, 10);
    lid.translate(x, 0.905, z);
    parts.push(part(barrel, colour), part(lid, '#3a3c40'));
  }
  const fallen = lying(0.3, 0.9, 0.3, 10);
  fallen.rotateY(0.5);
  fallen.translate(-0.45, 0, 0.75);
  parts.push(part(fallen, '#5e6874'));
  return parts;
}

/** A generator box with a lit panel. */
function generator(): THREE.BufferGeometry[] {
  const box = new THREE.BoxGeometry(0.9, 0.6, 0.6);
  box.translate(0, 0.3, 0);
  const vent = new THREE.BoxGeometry(0.5, 0.3, 0.02);
  vent.translate(0.1, 0.32, 0.31);
  const panel = new THREE.BoxGeometry(0.16, 0.1, 0.02);
  panel.translate(-0.28, 0.42, 0.31);
  return [part(box, '#c8742c'), part(vent, '#2a2c30'), part(panel, '#ffd070', 1)];
}

/** A cable from the pad's rim to (x, z), lying on the ground with a lazy sideways sag. */
function cable(field: HeightField, pad: { x: number; z: number }, angle: number, x: number, z: number, sag: number): THREE.BufferGeometry {
  const sx = pad.x + Math.cos(angle) * PAD_RIM;
  const sz = pad.z + Math.sin(angle) * PAD_RIM;
  const points: THREE.Vector3[] = [];
  for (let i = 0; i <= 6; i++) {
    const t = i / 6;
    const bend = Math.sin(t * Math.PI) * sag;
    const px = sx + (x - sx) * t - Math.sin(angle) * bend;
    const pz = sz + (z - sz) * t + Math.cos(angle) * bend;
    points.push(new THREE.Vector3(px, field.heightAt(px, pz) + 0.035, pz));
  }
  const tube = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 14, 0.035, 4);
  return part(tube, '#1e2022');
}

/**
 * SPEC-067: the landing site's stations, in placing order — each with its
 * footprint radius, its angle from the spawn's direction round the pad, and
 * whether a cable runs back to the pad.
 */
const STATIONS: readonly {
  readonly build: (seed: number) => THREE.BufferGeometry[];
  readonly reach: number;
  readonly offset: number;
  readonly wired: boolean;
}[] = [
  { build: crateStack, reach: 1.1, offset: 0.7, wired: false },
  { build: lampMast, reach: 0.6, offset: -0.75, wired: true },
  { build: barrelGroup, reach: 1, offset: 1.35, wired: false },
  { build: fuelBladder, reach: 1.9, offset: -1.5, wired: true },
  { build: generator, reach: 0.6, offset: 2.1, wired: true },
  { build: crateStack, reach: 1.1, offset: -2.4, wired: false },
  { build: lampMast, reach: 0.6, offset: Math.PI, wired: true },
];

/**
 * SPEC-067 (review V-01): the landing site — two crate stacks, two lamp
 * masts, a barrel group, a fuel bladder and a generator spread round the pad
 * in the 6.8–13 m ring, the spawn's side first, the powered ones wired back
 * to the pad's rim, as one merged world-space geometry. Every station keeps 3.5 m off the spawn point and
 * 2.5 m off each walking line, so the salvager never lands inside one and no
 * trail is blocked; nothing reaches inside the pad's own radius or the tug.
 * Deterministic from `hash32(layout.hash, 'landing')`.
 */
export function buildLandingSite(layout: ViewLayout, field: HeightField): THREE.BufferGeometry | null {
  const keepout = new Keepout(layout);
  const pad = layout.pois.find((poi) => poi.kind === 'landing_pad');
  if (pad === undefined) return null;
  const seed = hash32(layout.hash, 'landing');
  // As `systems/Layout`'s spawn: 12 m toward the nearest objective, or east.
  let dirX = 1;
  let dirZ = 0;
  let best = Infinity;
  for (const poi of layout.pois) {
    if (poi.kind === 'landing_pad' || poi.kind === 'landmark') continue;
    const d = Math.hypot(poi.x - pad.x, poi.z - pad.z);
    if (d > 0 && d < best) {
      best = d;
      dirX = (poi.x - pad.x) / d;
      dirZ = (poi.z - pad.z) / d;
    }
  }
  const spawn = { x: pad.x + dirX * SPAWN_DISTANCE, z: pad.z + dirZ * SPAWN_DISTANCE };
  const facing = Math.atan2(dirZ, dirX);
  const parts: THREE.BufferGeometry[] = [];
  const taken: { x: number; z: number; r: number }[] = [];
  // Mirrored at random, so the kit is not always on the same hand.
  const hand = hash01(seed, 0) < 0.5 ? 1 : -1;
  STATIONS.forEach((station, s) => {
    const r = station.reach;
    for (let attempt = 0; attempt < 24; attempt++) {
      // Round the spawn's side of the pad first, where the landing frame looks;
      // each retry steps a little further round.
      const step = (attempt % 2 === 0 ? 1 : -1) * Math.ceil(attempt / 2) * 0.2;
      const angle = facing + hand * station.offset + step + (hash01(seed, s, attempt) - 0.5) * 0.25;
      const d = LANDING_RING[0] + r + hash01(seed, s, attempt, 1) * (LANDING_RING[1] - LANDING_RING[0] - 2 * r);
      const x = pad.x + Math.cos(angle) * d;
      const z = pad.z + Math.sin(angle) * d;
      if (Math.hypot(x - spawn.x, z - spawn.z) < 3.5 + r) continue;
      if (keepout.corridorDistance(x, z) < 2.5 + r) continue;
      if (taken.some((t) => Math.hypot(x - t.x, z - t.z) < t.r + r + 1)) continue;
      // The layout keeps the clearing empty, but a node or a POI ring may still reach in.
      if (!keepout.free(x, z, r, { pad: -Infinity, poi: 0.5, obstacle: 0.3, node: 1.5, shelter: 0.5, corridor: null, wall: 0 })) continue;
      taken.push({ x, z, r });
      // Faced toward the pad (local −x), give or take.
      const yaw = -angle + (hash01(seed, s, 2) - 0.5) * 0.6;
      for (const piece of station.build(seed + s)) parts.push(setDown(field, piece, x, z, yaw));
      if (station.wired) {
        parts.push(cable(field, pad, angle + (hash01(seed, s, 3) - 0.5) * 0.25, x - Math.cos(angle) * r, z - Math.sin(angle) * r, (hash01(seed, s, 4) - 0.5) * 0.8));
      }
      break;
    }
  });
  if (parts.length === 0) return null;
  return skirt(mergeParts(parts), field.heightAt(pad.x, pad.z) + 0.04, 0.8);
}
