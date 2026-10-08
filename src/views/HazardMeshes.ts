// The hazards' shapes (SPEC-068 §4.8, PLAN R28): procedural geometry, like the
// enemies' and the POIs' — no asset file. Each shape comes in parts the view
// draws as one `InstancedMesh` each:
// - `body`: what stands — a vent's mound, a mine, a toppler's stump, a drum;
// - `shaft`: a toppler's falling half, built with its foot at the origin so
//   the view tips it about its foot;
// - `glow`: what lights — a vent's mouth, a mine's lamp, the weak point a
//   helper shows (where to shoot), a drum's valve light.
// Colours are baked into vertex colours from the hazard's `look` (body and
// accent); the glow is white and takes its colour per instance. Every shape
// stays small: at most `HAZARD_TRIANGLE_CAP` triangles over its parts.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { fbm2 } from '@/core/Noise';
import type { HazardDef, HazardShape } from '@/data/hazards';

/** §4.8: the most triangles one hazard's parts may hold together. */
export const HAZARD_TRIANGLE_CAP = 700;

export interface HazardGeometry {
  body: THREE.BufferGeometry;
  /** A toppler's falling half; its foot is at y = 0. */
  shaft: THREE.BufferGeometry | null;
  /** Where a toppler's shaft stands on its stump, in metres. */
  shaftBase: number;
  glow: THREE.BufferGeometry;
}

const scratch = new THREE.Color();

function paint(geometry: THREE.BufferGeometry, color: string, gain = 1): THREE.BufferGeometry {
  scratch.set(color).multiplyScalar(gain);
  const count = (geometry.getAttribute('position') as THREE.BufferAttribute).count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    colors[i * 3] = scratch.r;
    colors[i * 3 + 1] = scratch.g;
    colors[i * 3 + 2] = scratch.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

/** Non-indexed, position/normal/color only, so any mix merges. */
function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const flat = parts.map((part) => {
    const g = part.index === null ? part : part.toNonIndexed();
    for (const name of Object.keys(g.attributes)) {
      if (name !== 'position' && name !== 'normal' && name !== 'color') g.deleteAttribute(name);
    }
    if (g.getAttribute('color') === undefined) paint(g, '#ffffff');
    return g;
  });
  const merged = mergeGeometries(flat);
  for (const g of flat) g.dispose();
  return merged;
}

/** Push vertices along their normals by a seeded noise — a rock's lumps. */
function lumpy(geometry: THREE.BufferGeometry, seed: number, amount: number, scale = 1.3): THREE.BufferGeometry {
  const g = geometry.index === null ? geometry : geometry.toNonIndexed();
  const position = g.getAttribute('position') as THREE.BufferAttribute;
  // Displace by position, out from the axis, so the corners the faces share
  // move together and no face splits from its neighbour.
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    const n = fbm2(seed, x * scale + y * 0.7, z * scale - y * 0.7, 3) - 0.5;
    const len = Math.hypot(x, z) || 1;
    position.setXYZ(i, x + (x / len) * n * amount, y + n * amount * 0.3, z + (z / len) * n * amount);
  }
  position.needsUpdate = true;
  g.computeVertexNormals();
  return g;
}

/** Darken the vertex colour toward the ground — a dust skirt that seats the prop. */
function skirt(geometry: THREE.BufferGeometry, below: number, factor: number): THREE.BufferGeometry {
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  const color = geometry.getAttribute('color') as THREE.BufferAttribute;
  for (let i = 0; i < position.count; i++) {
    const y = position.getY(i);
    if (y >= below) continue;
    const k = factor + (1 - factor) * Math.max(0, y / below);
    color.setXYZ(i, color.getX(i) * k, color.getY(i) * k, color.getZ(i) * k);
  }
  color.needsUpdate = true;
  return geometry;
}

function cylinder(rTop: number, rBottom: number, h: number, sides: number, y: number, color: string, open = false): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(rTop, rBottom, h, sides, 1, open);
  g.translate(0, y + h / 2, 0);
  return paint(g, color);
}

function ring(radius: number, tube: number, y: number, color: string, segments = 14): THREE.BufferGeometry {
  const g = new THREE.TorusGeometry(radius, tube, 4, segments);
  g.rotateX(-Math.PI / 2);
  g.translate(0, y, 0);
  return paint(g, color);
}

function disc(radius: number, y: number, color: string, segments = 14): THREE.BufferGeometry {
  const g = new THREE.CircleGeometry(radius, segments);
  g.rotateX(-Math.PI / 2);
  g.translate(0, y, 0);
  return paint(g, color);
}

// ---------------------------------------------------------------- shapes

/** A vent: a low cratered mound in the body colour, the accent rim, a mouth that glows. */
function mound(def: HazardDef): HazardGeometry {
  const { body, accent, height } = def.look;
  const r = def.reach * 0.62;
  const cone = lumpy(new THREE.CylinderGeometry(def.radius * 0.95, r, height, 12, 2, true), 11, 0.35);
  cone.translate(0, height / 2, 0);
  paint(cone, body);
  skirt(cone, height * 0.5, 0.7);
  const lip = ring(def.radius * 0.95, 0.12, height, accent, 12);
  const throat = cylinder(def.radius * 0.8, def.radius * 0.6, 0.4, 10, height - 0.42, accent, true);
  const glow = disc(def.radius * 0.78, height - 0.18, '#ffffff', 12);
  // Three cracks running down the flank glow with the mouth.
  const cracks: THREE.BufferGeometry[] = [glow];
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.4;
    const crack = new THREE.BoxGeometry(0.08, 0.03, r - def.radius * 0.9);
    crack.rotateX(-Math.atan2(height * 0.9, r - def.radius));
    crack.translate(0, height * 0.45, (r + def.radius) * 0.48);
    crack.rotateY(a);
    cracks.push(paint(crack, '#ffffff'));
  }
  return { body: merge([cone, lip, throat]), shaft: null, shaftBase: 0, glow: merge(cracks) };
}

/** A scav tripmine: a flat olive disc with a lamp and three prongs. */
function tripmine(def: HazardDef): HazardGeometry {
  const { body, accent } = def.look;
  const plate = cylinder(0.5, 0.56, 0.12, 10, 0, body);
  const rim = ring(0.53, 0.03, 0.1, accent, 10);
  const cap = cylinder(0.16, 0.22, 0.08, 8, 0.12, accent);
  const prongs: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const prong = new THREE.CylinderGeometry(0.02, 0.02, 0.22, 4);
    prong.rotateZ(0.5);
    prong.translate(0.3, 0.18, 0);
    prong.rotateY(a);
    prongs.push(paint(prong, accent));
  }
  const lamp = new THREE.SphereGeometry(0.07, 6, 4);
  lamp.translate(0, 0.24, 0);
  return { body: merge([plate, rim, cap, ...prongs]), shaft: null, shaftBase: 0, glow: merge([paint(lamp, '#ffffff')]) };
}

/** A spore pod: a bulging bulb in its leaves, lit from inside. */
function pod(def: HazardDef): HazardGeometry {
  const { body, accent, height } = def.look;
  const bulb = lumpy(new THREE.SphereGeometry(0.42, 10, 7), 23, 0.18);
  bulb.scale(1, height / 0.84, 1);
  bulb.translate(0, height * 0.5, 0);
  paint(bulb, body);
  skirt(bulb, height * 0.4, 0.6);
  const leaves: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 4; i++) {
    const leaf = new THREE.ConeGeometry(0.18, 0.9, 4);
    leaf.rotateZ(-1.15);
    leaf.translate(0.48, 0.12, 0);
    leaf.rotateY((i / 4) * Math.PI * 2 + 0.3);
    leaves.push(paint(leaf, accent, 0.8));
  }
  const spots: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 5; i++) {
    const spot = new THREE.SphereGeometry(0.07, 5, 3);
    const a = (i / 5) * Math.PI * 2;
    spot.translate(Math.cos(a) * 0.36, height * (0.45 + 0.12 * (i % 2)), Math.sin(a) * 0.36);
    spots.push(paint(spot, '#ffffff'));
  }
  return { body: merge([bulb, ...leaves]), shaft: null, shaftBase: 0, glow: merge(spots) };
}

/** A balanced rock: a rubble foot, a weathered column, a boulder on top — the column and boulder fall. */
function hoodoo(def: HazardDef): HazardGeometry {
  const { body, accent, height } = def.look;
  const footH = 0.7;
  const foot = lumpy(new THREE.CylinderGeometry(def.radius * 0.95, def.radius * 1.35, footH, 9, 1), 31, 0.4);
  foot.translate(0, footH / 2, 0);
  paint(foot, accent, 1.15);
  skirt(foot, 0.4, 0.65);
  const columnH = height - footH - 1.4;
  const column = lumpy(new THREE.CylinderGeometry(0.42, 0.62, columnH, 8, 3), 37, 0.28, 2);
  column.translate(0, columnH / 2, 0);
  paint(column, body);
  // Banded strata: a darker band a third of the way up.
  const band = lumpy(new THREE.CylinderGeometry(0.55, 0.58, 0.3, 8, 1), 41, 0.1);
  band.translate(0, columnH * 0.35, 0);
  paint(band, accent);
  const boulder = lumpy(new THREE.IcosahedronGeometry(0.95, 1), 43, 0.5, 1.6);
  boulder.scale(1.15, 0.85, 1);
  boulder.translate(0.1, columnH + 0.65, 0);
  paint(boulder, body, 1.08);
  const crack = new THREE.TorusGeometry(0.6, 0.05, 3, 10);
  crack.rotateX(-Math.PI / 2);
  crack.translate(0, footH - 0.05, 0);
  return {
    body: merge([foot]),
    shaft: merge([column, band, boulder]),
    shaftBase: footH - 0.1,
    glow: merge([paint(crack, '#ffffff')]),
  };
}

/** A ruin column: a square plinth, a fluted drum shaft with a capital. */
function column(def: HazardDef): HazardGeometry {
  const { body, accent, height } = def.look;
  const plinthH = 0.6;
  const plinth = new THREE.BoxGeometry(1.7, plinthH, 1.7);
  plinth.translate(0, plinthH / 2, 0);
  paint(plinth, accent, 1.1);
  skirt(plinth, 0.3, 0.7);
  const shaftH = height - plinthH;
  const drums: THREE.BufferGeometry[] = [];
  const drumCount = 4;
  const drumH = (shaftH - 0.5) / drumCount;
  for (let i = 0; i < drumCount; i++) {
    const drum = new THREE.CylinderGeometry(0.5, 0.54, drumH - 0.04, 12, 1);
    drum.rotateY(i * 0.2);
    drum.translate(0, drumH * i + drumH / 2, 0);
    drums.push(paint(drum, body, 1 - i * 0.03));
  }
  const capital = new THREE.BoxGeometry(1.3, 0.45, 1.3);
  capital.translate(0, shaftH - 0.25, 0);
  paint(capital, body, 1.05);
  const crack = ring(0.56, 0.05, plinthH + 0.04, '#ffffff', 12);
  return { body: merge([plinth]), shaft: merge([...drums, capital]), shaftBase: plinthH, glow: merge([crack]) };
}

/** A basalt column: hexagonal, cracked across its foot. */
function prism(def: HazardDef): HazardGeometry {
  const { body, accent, height } = def.look;
  const stubH = 0.8;
  const stub = new THREE.CylinderGeometry(0.75, 0.85, stubH, 6, 1);
  stub.translate(0, stubH / 2, 0);
  paint(stub, accent);
  const shaftH = height - stubH;
  const shaft = new THREE.CylinderGeometry(0.62, 0.72, shaftH, 6, 2);
  shaft.translate(0, shaftH / 2, 0);
  paint(shaft, body);
  const top = new THREE.CylinderGeometry(0.5, 0.62, 0.3, 6, 1);
  top.translate(0, shaftH + 0.15, 0);
  paint(top, body, 1.2);
  const crack = ring(0.74, 0.06, stubH, '#ffffff', 6);
  return { body: merge([stub]), shaft: merge([shaft, top]), shaftBase: stubH, glow: merge([crack]) };
}

/** An ice pillar or a chitin spire: a crystal cluster at the foot, a tall tapering spike. */
function spire(def: HazardDef): HazardGeometry {
  const { body, accent, height } = def.look;
  const footH = 0.8;
  const shards: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 5; i++) {
    const shard = new THREE.ConeGeometry(0.28, footH * (1 + (i % 3) * 0.35), 5);
    shard.translate(0, footH * 0.5, 0);
    shard.rotateZ(0.35 + (i % 2) * 0.2);
    shard.translate(0.45, 0, 0);
    shard.rotateY((i / 5) * Math.PI * 2);
    shards.push(paint(shard, accent, 1.05));
  }
  const core = cylinder(0.55, 0.75, footH, 7, 0, accent);
  const shaftH = height - footH;
  const spike = lumpy(new THREE.CylinderGeometry(0.08, 0.6, shaftH, 7, 4), 53, 0.2, 2.2);
  spike.translate(0, shaftH / 2, 0);
  paint(spike, body);
  const barb = new THREE.ConeGeometry(0.22, 1.4, 5);
  barb.rotateZ(-0.9);
  barb.translate(0.5, shaftH * 0.45, 0);
  paint(barb, body, 0.9);
  const crack = ring(0.62, 0.05, footH - 0.05, '#ffffff', 7);
  return { body: merge([core, ...shards]), shaft: merge([spike, barb]), shaftBase: footH - 0.05, glow: merge([crack]) };
}

/** A dead oak: a flared stump, a bare trunk with three broken limbs. */
function trunk(def: HazardDef): HazardGeometry {
  const { body, accent, height } = def.look;
  const stumpH = 0.8;
  const stump = lumpy(new THREE.CylinderGeometry(0.55, 0.95, stumpH, 9, 1), 61, 0.3);
  stump.translate(0, stumpH / 2, 0);
  paint(stump, accent, 1.2);
  skirt(stump, 0.35, 0.7);
  const shaftH = height - stumpH;
  const bole = lumpy(new THREE.CylinderGeometry(0.28, 0.5, shaftH, 8, 4), 67, 0.18, 2.5);
  bole.translate(0, shaftH / 2, 0);
  paint(bole, body);
  const limbs: THREE.BufferGeometry[] = [bole];
  const limbAt = [0.55, 0.72, 0.88];
  for (let i = 0; i < limbAt.length; i++) {
    const len = 1.6 - i * 0.3;
    const limb = new THREE.CylinderGeometry(0.06, 0.16, len, 5);
    limb.translate(0, len / 2, 0);
    limb.rotateZ(-0.9 + (i % 2) * 0.25);
    limb.rotateY(i * 2.1);
    limb.translate(0, shaftH * (limbAt[i] as number), 0);
    limbs.push(paint(limb, body, 0.92));
  }
  const crack = ring(0.52, 0.05, stumpH - 0.05, '#ffffff', 9);
  return { body: merge([stump]), shaft: merge(limbs), shaftBase: stumpH - 0.05, glow: merge([crack]) };
}

/** A fuel drum: ribbed, dented, with a valve lamp on the lid. */
function drum(def: HazardDef): HazardGeometry {
  const { body, accent, height } = def.look;
  const r = def.radius * 0.85;
  const can = new THREE.CylinderGeometry(r, r, height, 12, 1);
  can.translate(0, height / 2, 0);
  paint(can, body);
  skirt(can, 0.25, 0.7);
  const ribs = [0.22, 0.5, 0.78].map((f) => ring(r + 0.02, 0.035, height * f, accent, 12));
  const lid = disc(r * 0.98, height + 0.005, accent, 12);
  const valve = new THREE.SphereGeometry(0.09, 6, 4);
  valve.translate(r * 0.45, height + 0.06, 0);
  // A hazard band below the top rib, lit.
  const band = new THREE.CylinderGeometry(r + 0.012, r + 0.012, 0.1, 12, 1, true);
  band.translate(0, height * 0.64, 0);
  return { body: merge([can, ...ribs, lid]), shaft: null, shaftBase: 0, glow: merge([paint(valve, '#ffffff'), paint(band, '#ffffff', 0.6)]) };
}

/** A pressure tank: a capsule on legs with a gauge light. */
function tank(def: HazardDef): HazardGeometry {
  const { body, accent, height } = def.look;
  const r = def.radius * 0.8;
  const capsule = new THREE.CapsuleGeometry(r, height - r * 2 - 0.2, 4, 10);
  capsule.translate(0, height / 2 + 0.1, 0);
  paint(capsule, body);
  const legs: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 3; i++) {
    const leg = new THREE.BoxGeometry(0.08, 0.5, 0.08);
    leg.translate(r * 0.85, 0.25, 0);
    leg.rotateY((i / 3) * Math.PI * 2);
    legs.push(paint(leg, accent));
  }
  const stripe = ring(r + 0.02, 0.05, height * 0.5, accent, 12);
  const gauge = new THREE.SphereGeometry(0.1, 6, 4);
  gauge.translate(0, height * 0.72, r + 0.02);
  const cap = new THREE.CylinderGeometry(0.08, 0.1, 0.18, 6);
  cap.translate(0, height + 0.1, 0);
  paint(cap, accent);
  return { body: merge([capsule, stripe, cap, ...legs]), shaft: null, shaftBase: 0, glow: merge([paint(gauge, '#ffffff')]) };
}

/** A swollen bulb on a short stalk — a gas bloom, a magma blister, a spore sac — with a lit crown and lit pustules. */
function bulb(def: HazardDef): HazardGeometry {
  const { body, accent, height } = def.look;
  const r = def.radius * 0.95;
  const sy = height / (r * 2);
  const sac = lumpy(new THREE.SphereGeometry(r, 12, 8), 71, r * 0.35, 1.8);
  sac.scale(1, sy, 1);
  sac.translate(0, height * 0.55, 0);
  paint(sac, body);
  skirt(sac, height * 0.3, 0.6);
  const stalk = cylinder(0.15, 0.35, height * 0.25, 7, 0, accent);
  const lip = ring(r * 0.32, 0.07, height * 0.55 + r * sy * 0.92, accent, 8);
  // The crown: an opening at the top that glows, and pustules round the shoulder.
  const crown = disc(r * 0.3, height * 0.55 + r * sy * 0.95, '#ffffff', 8);
  const lights: THREE.BufferGeometry[] = [crown];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.3;
    const lift = 0.15 + 0.25 * (i % 2);
    const pustule = new THREE.SphereGeometry(r * 0.16, 6, 4);
    pustule.translate(Math.cos(a) * r * 0.93 * Math.cos(lift), height * 0.55 + Math.sin(lift) * r * sy, Math.sin(a) * r * 0.93 * Math.cos(lift));
    lights.push(paint(pustule, '#ffffff'));
  }
  return { body: merge([sac, stalk, lip]), shaft: null, shaftBase: 0, glow: merge(lights) };
}

const BUILDERS: Readonly<Record<HazardShape, (def: HazardDef) => HazardGeometry>> = {
  mound,
  tripmine,
  pod,
  hoodoo,
  column,
  prism,
  spire,
  trunk,
  drum,
  tank,
  bulb,
};

/** §4.8: one hazard's parts, built from its `look`. */
export function hazardGeometry(def: HazardDef): HazardGeometry {
  return BUILDERS[def.look.shape](def);
}

/** The triangles a hazard's parts hold together — `HAZARD_TRIANGLE_CAP` bounds it. */
export function hazardTriangles(geometry: HazardGeometry): number {
  const count = (g: THREE.BufferGeometry | null): number =>
    g === null ? 0 : (g.index === null ? (g.getAttribute('position') as THREE.BufferAttribute).count : g.index.count) / 3;
  return count(geometry.body) + count(geometry.shaft) + count(geometry.glow);
}
