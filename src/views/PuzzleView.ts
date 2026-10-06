// The puzzles as drawn (SPEC-055 §4.1, §4.6, §4.10): the terminals — a vault's
// below, the plates' panel, and a relic's beside its landmark above — the
// pressure plates with their glyphs, and the beam's mirrors, its lens and
// receiver and the beam itself. One root per level: the scene hangs the cave's
// under the cave view (so it shows and hides with the cave) and the surface's
// beside the environment.
//
// Every piece is SPEC-052's cave kit through `kitGeometry` — the GLB once the
// asset cache holds it, a procedural stand-in until then — under the kit's own
// glow material. Nothing here collides: SPEC-054's walls and reachability are
// fixed before a puzzle is generated, and props that never block keep that
// proof valid (§2). A world puzzle adds at most four draws: plates and their
// glyphs, or mirrors, the lens and receiver, and the beam (§4.10).
//
// Views may not import `systems/` (SPEC-001 §4): the scene hands in plain
// positions, states and booleans, and this draws them. The beam's ribbon is
// rebuilt only when the scene says the trace changed — a mirror move or a light
// toggle — and the pulse writes a handful of colours in place, so a frame
// allocates nothing.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Assets } from '@/core/Assets';
import { disposeObject3D } from '@/core/Disposer';
import { injectVertexGlow, kitGeometry, KIT_GLOW, writeMatrix } from '@/views/UndergroundView';

/** A terminal: where it stands, the way its screen faces (radians on XZ, as `player.facing`), and whether it is spent. */
export interface TerminalSpot {
  x: number;
  z: number;
  facing: number;
  /** §4.8: a solved site's terminal shows a dark screen. */
  spent: boolean;
}

export type PlateGlyph = 'circle' | 'triangle' | 'square' | 'diamond' | 'star';

/** §4.6 *initial tuning*: the beam rides this high, and is this wide. */
export const BEAM_HEIGHT = 1.25;
export const BEAM_WIDTH = 0.14;
/** §4.5: a pulsing plate or mirror throbs at this rate (Hz). */
const PULSE_HZ = 1.6;
/** The glyph decal: its size on a plate, its lift, and the unpressed ink. */
const GLYPH_SIZE = 0.34;
const GLYPH_LIFT = 0.135;
const GLYPH_IDLE = new THREE.Color('#8f969e');
/** A plate's GLB is 1.6 m across; the plates are drawn at their 0.9 m radius (§3's `PLATE_RADIUS`). */
const PLATE_MODEL_RADIUS = 0.8;
/** §4.2: the mirror states' yaws — `/`, `\`, then the two closed states square to the grid. */
const MIRROR_YAW: readonly number[] = [Math.PI / 4, -Math.PI / 4, 0, Math.PI / 2];

/** `facing` (a direction on XZ) as the yaw that turns a kit piece's front (+z) toward it. */
function yawOf(facing: number): number {
  return Math.PI / 2 - facing;
}

/** One glyph's outline, in the plate's plane, about its centre. */
function glyphShape(glyph: PlateGlyph): THREE.Shape {
  const s = GLYPH_SIZE;
  const shape = new THREE.Shape();
  switch (glyph) {
    case 'circle':
      shape.absarc(0, 0, s, 0, Math.PI * 2, false);
      return shape;
    case 'triangle':
      shape.moveTo(0, s);
      shape.lineTo(-s * 0.95, -s * 0.7);
      shape.lineTo(s * 0.95, -s * 0.7);
      shape.closePath();
      return shape;
    case 'square':
      shape.moveTo(-s * 0.8, -s * 0.8);
      shape.lineTo(s * 0.8, -s * 0.8);
      shape.lineTo(s * 0.8, s * 0.8);
      shape.lineTo(-s * 0.8, s * 0.8);
      shape.closePath();
      return shape;
    case 'diamond':
      shape.moveTo(0, s * 1.1);
      shape.lineTo(s * 0.8, 0);
      shape.lineTo(0, -s * 1.1);
      shape.lineTo(-s * 0.8, 0);
      shape.closePath();
      return shape;
    case 'star':
      for (let k = 0; k < 10; k++) {
        const r = k % 2 === 0 ? s * 1.1 : s * 0.45;
        const a = Math.PI / 2 + (k * Math.PI) / 5;
        if (k === 0) shape.moveTo(Math.cos(a) * r, Math.sin(a) * r);
        else shape.lineTo(Math.cos(a) * r, Math.sin(a) * r);
      }
      shape.closePath();
      return shape;
  }
}

/**
 * One level's puzzle furniture. Each `set*` replaces what it draws; the
 * pulse (`sync`) and the pressed and hinted states write in place.
 */
export class PuzzleView {
  readonly root = new THREE.Group();
  readonly #assets: Assets | undefined;
  readonly #kit: THREE.MeshStandardMaterial;
  /** Spent terminals: the same pieces with nothing glowing. */
  readonly #dark: THREE.MeshStandardMaterial;
  readonly #beacon: THREE.Color;
  #terminals: THREE.InstancedMesh | null = null;
  #spentTerminals: THREE.InstancedMesh | null = null;
  #plates: THREE.InstancedMesh | null = null;
  #glyphs: THREE.Mesh | null = null;
  /** Per plate: its first vertex in the glyph geometry and how many it has. */
  #glyphRanges: { start: number; count: number }[] = [];
  #pressed: boolean[] = [];
  #platePulse = -1;
  #mirrors: THREE.InstancedMesh | null = null;
  #mirrorSpots: { x: number; z: number; state: number }[] = [];
  #mirrorPulse = -1;
  #ends: THREE.Mesh | null = null;
  #beam: THREE.Mesh | null = null;
  #reduceMotion = false;

  constructor(parent: THREE.Object3D, beaconColor: string, assets?: Assets) {
    this.root.name = 'puzzles';
    parent.add(this.root);
    this.#assets = assets;
    this.#beacon = new THREE.Color(beaconColor);
    this.#kit = new THREE.MeshStandardMaterial({
      color: '#ffffff',
      vertexColors: true,
      roughness: 0.7,
      metalness: 0.2,
      emissive: this.#beacon,
      emissiveIntensity: KIT_GLOW,
    });
    injectVertexGlow(this.#kit);
    this.#dark = new THREE.MeshStandardMaterial({ color: '#ffffff', vertexColors: true, roughness: 0.7, metalness: 0.2 });
  }

  /** Meshes under the root that can draw — each one draw call. */
  get drawObjects(): number {
    let count = 0;
    this.root.traverse((node) => {
      if ((node as THREE.Mesh).isMesh === true && node.visible) count++;
    });
    return count;
  }

  /** The terminals standing on this level, lit or spent; `[]` takes them away. */
  setTerminals(spots: readonly TerminalSpot[]): void {
    this.#dropMesh(this.#terminals);
    this.#dropMesh(this.#spentTerminals);
    this.#terminals = null;
    this.#spentTerminals = null;
    if (spots.length === 0) return;
    const geometry = kitGeometry('cave_terminal', this.#assets);
    const lit = spots.filter((spot) => !spot.spent);
    const spent = spots.filter((spot) => spot.spent);
    this.#terminals = this.#instanced(geometry, this.#kit, lit, 'puzzle-terminals');
    this.#spentTerminals = this.#instanced(geometry.clone(), this.#dark, spent, 'puzzle-terminals-spent');
  }

  /**
   * §4.6: the plates, each a `cave_plate` at its 0.9 m radius with its glyph on
   * top; a pressed one's glyph burns in the beacon colour until a reset.
   */
  setPlates(plates: readonly { x: number; z: number; glyph: PlateGlyph }[]): void {
    this.#dropMesh(this.#plates);
    this.#dropMesh(this.#glyphs);
    this.#plates = null;
    this.#glyphs = null;
    this.#glyphRanges = [];
    this.#pressed = plates.map(() => false);
    this.#platePulse = -1;
    if (plates.length === 0) return;
    const scale = 0.9 / PLATE_MODEL_RADIUS;
    this.#plates = this.#instanced(
      kitGeometry('cave_plate', this.#assets),
      this.#kit,
      plates.map((plate) => ({ x: plate.x, z: plate.z, facing: Math.PI / 2, spent: false })),
      'puzzle-plates',
      scale,
    );
    const parts: THREE.BufferGeometry[] = [];
    let start = 0;
    for (const plate of plates) {
      const shape = new THREE.ShapeGeometry(glyphShape(plate.glyph), 6);
      // The shape is drawn in its own XY; laid flat, its top points away from the rig.
      shape.rotateX(-Math.PI / 2);
      shape.rotateY(Math.PI / 4);
      shape.translate(plate.x, GLYPH_LIFT, plate.z);
      const flat = shape.index === null ? shape : shape.toNonIndexed();
      for (const name of Object.keys(flat.attributes)) if (name !== 'position') flat.deleteAttribute(name);
      const count = (flat.getAttribute('position') as THREE.BufferAttribute).count;
      this.#glyphRanges.push({ start, count });
      start += count;
      parts.push(flat);
    }
    const merged = mergeGeometries(parts);
    if (merged === null) return;
    merged.setAttribute('color', new THREE.BufferAttribute(new Float32Array(start * 3), 3));
    const glyphs = new THREE.Mesh(merged, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }));
    glyphs.name = 'puzzle-glyphs';
    this.root.add(glyphs);
    this.#glyphs = glyphs;
    this.#writeGlyphs(0);
  }

  /** §4.6: which plates are pressed (the order so far); a reset clears them. */
  setPressed(pressed: readonly boolean[]): void {
    let changed = false;
    for (let i = 0; i < this.#pressed.length; i++) {
      const on = pressed[i] === true;
      if (this.#pressed[i] !== on) {
        this.#pressed[i] = on;
        changed = true;
      }
    }
    if (changed) this.#writeGlyphs(0);
  }

  /** §4.5: the plate that pulses — the next in the order after a wrong press — or −1. */
  setPlatePulse(index: number): void {
    if (this.#platePulse === index) return;
    this.#platePulse = index;
    this.#writeGlyphs(0);
  }

  /** §4.6: the mirrors, each a `cave_mirror` turned to its state's yaw. */
  setMirrors(mirrors: readonly { x: number; z: number; state: number }[]): void {
    this.#dropMesh(this.#mirrors);
    this.#mirrors = null;
    this.#mirrorSpots = mirrors.map((mirror) => ({ ...mirror }));
    this.#mirrorPulse = -1;
    if (mirrors.length === 0) return;
    this.#mirrors = this.#instanced(
      kitGeometry('cave_mirror', this.#assets),
      this.#kit,
      mirrors.map((mirror) => ({ x: mirror.x, z: mirror.z, facing: 0, spent: false })),
      'puzzle-mirrors',
    );
    this.#writeMirrors(0);
  }

  /** §4.6: a mirror's new state (a move cycles it). */
  setMirrorState(index: number, state: number): void {
    const spot = this.#mirrorSpots[index];
    if (spot === undefined || spot.state === state) return;
    spot.state = state;
    this.#writeMirrors(0);
  }

  /** §4.5: the mirror that pulses — the next `hintMove` names — or −1. */
  setMirrorPulse(index: number): void {
    if (this.#mirrorPulse === index) return;
    this.#mirrorPulse = index;
    this.#writeMirrors(0);
  }

  /** §4.6: the lens (pointing along `lens.facing`) and the receiver (its receptor toward `receiver.facing`), one draw. */
  setEnds(lens: { x: number; z: number; facing: number } | null, receiver: { x: number; z: number; facing: number } | null): void {
    this.#dropMesh(this.#ends);
    this.#ends = null;
    const parts: THREE.BufferGeometry[] = [];
    const matrix = new THREE.Matrix4();
    const at = (geometry: THREE.BufferGeometry, spot: { x: number; z: number; facing: number }): THREE.BufferGeometry => {
      matrix.makeRotationY(yawOf(spot.facing));
      matrix.setPosition(spot.x, 0, spot.z);
      return geometry.applyMatrix4(matrix);
    };
    if (lens !== null) parts.push(at(kitGeometry('cave_lens', this.#assets), lens));
    if (receiver !== null) parts.push(at(kitGeometry('cave_receiver', this.#assets), receiver));
    if (parts.length === 0) return;
    const merged = mergeGeometries(parts);
    if (merged === null) return;
    const ends = new THREE.Mesh(merged, this.#kit);
    ends.name = 'puzzle-lens-receiver';
    ends.castShadow = true;
    ends.receiveShadow = true;
    this.root.add(ends);
    this.#ends = ends;
  }

  /**
   * §4.6: the beam, one ribbon through `points` (x, z pairs) at the lens's
   * height in the beacon colour, or none. The scene passes it only while the
   * flashlight is on.
   */
  setBeam(points: readonly number[] | null): void {
    this.#dropMesh(this.#beam);
    this.#beam = null;
    if (points === null || points.length < 4) return;
    const segments = points.length / 2 - 1;
    const positions = new Float32Array(segments * 6 * 3);
    const half = BEAM_WIDTH / 2;
    let w = 0;
    for (let i = 0; i < segments; i++) {
      const ax = points[i * 2] as number;
      const az = points[i * 2 + 1] as number;
      const bx = points[i * 2 + 2] as number;
      const bz = points[i * 2 + 3] as number;
      const length = Math.hypot(bx - ax, bz - az) || 1;
      // Flat across the travel, extended by half a width so the turns close.
      const nx = (-(bz - az) / length) * half;
      const nz = ((bx - ax) / length) * half;
      const ex = ((bx - ax) / length) * half;
      const ez = ((bz - az) / length) * half;
      const corners = [
        [ax - ex + nx, az - ez + nz],
        [ax - ex - nx, az - ez - nz],
        [bx + ex - nx, bz + ez - nz],
        [ax - ex + nx, az - ez + nz],
        [bx + ex - nx, bz + ez - nz],
        [bx + ex + nx, bz + ez + nz],
      ];
      for (const [x, z] of corners) {
        positions[w++] = x as number;
        positions[w++] = BEAM_HEIGHT;
        positions[w++] = z as number;
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const beam = new THREE.Mesh(
      geometry,
      new THREE.MeshBasicMaterial({
        color: this.#beacon,
        transparent: true,
        opacity: 0.85,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        fog: false,
      }),
    );
    beam.name = 'puzzle-beam';
    beam.renderOrder = 2;
    this.root.add(beam);
    this.#beam = beam;
  }

  /** Whether a beam is drawn (`sceneInfo` reads it). */
  get beamDrawn(): boolean {
    return this.#beam !== null;
  }

  /** §4.5: the pulse, on the view clock; steady under reduce motion. Allocates nothing. */
  sync(time: number, reduceMotion: boolean): void {
    this.#reduceMotion = reduceMotion;
    if (this.#platePulse < 0 && this.#mirrorPulse < 0) return;
    const wave = reduceMotion ? 1 : 0.5 + 0.5 * Math.sin(time * Math.PI * 2 * PULSE_HZ);
    if (this.#platePulse >= 0) this.#writeGlyphs(wave);
    if (this.#mirrorPulse >= 0) this.#writeMirrors(wave);
  }

  dispose(): void {
    this.root.removeFromParent();
    const instanced: THREE.InstancedMesh[] = [];
    this.root.traverse((node) => {
      if ((node as THREE.InstancedMesh).isInstancedMesh === true) instanced.push(node as THREE.InstancedMesh);
    });
    disposeObject3D(this.root);
    for (const mesh of instanced) mesh.dispose();
    this.#kit.dispose();
    this.#dark.dispose();
  }

  #instanced(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    spots: readonly TerminalSpot[],
    name: string,
    scale = 1,
  ): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, spots.length));
    mesh.name = name;
    const matrices = mesh.instanceMatrix.array as Float32Array;
    spots.forEach((spot, i) => writeMatrix(matrices, i, spot.x, spot.z, yawOf(spot.facing), scale, 1, scale));
    mesh.count = spots.length;
    mesh.visible = spots.length > 0;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.root.add(mesh);
    return mesh;
  }

  #dropMesh(mesh: THREE.Mesh | null): void {
    if (mesh === null) return;
    mesh.removeFromParent();
    mesh.geometry.dispose();
    const material = mesh.material as THREE.Material;
    if (material !== this.#kit && material !== this.#dark) material.dispose();
    if ((mesh as THREE.InstancedMesh).isInstancedMesh === true) (mesh as THREE.InstancedMesh).dispose();
  }

  /** The glyphs' colours: idle ink, the beacon once pressed, and the pulsing one. */
  #writeGlyphs(wave: number): void {
    const glyphs = this.#glyphs;
    if (glyphs === null) return;
    const colors = glyphs.geometry.getAttribute('color') as THREE.BufferAttribute;
    const array = colors.array as Float32Array;
    const pulse = this.#reduceMotion ? 1 : wave;
    for (let i = 0; i < this.#glyphRanges.length; i++) {
      const range = this.#glyphRanges[i] as { start: number; count: number };
      let r = GLYPH_IDLE.r;
      let g = GLYPH_IDLE.g;
      let b = GLYPH_IDLE.b;
      if (this.#pressed[i] === true) {
        r = this.#beacon.r;
        g = this.#beacon.g;
        b = this.#beacon.b;
      } else if (i === this.#platePulse) {
        r = GLYPH_IDLE.r + (this.#beacon.r - GLYPH_IDLE.r) * pulse;
        g = GLYPH_IDLE.g + (this.#beacon.g - GLYPH_IDLE.g) * pulse;
        b = GLYPH_IDLE.b + (this.#beacon.b - GLYPH_IDLE.b) * pulse;
      }
      for (let v = range.start; v < range.start + range.count; v++) {
        array[v * 3] = r;
        array[v * 3 + 1] = g;
        array[v * 3 + 2] = b;
      }
    }
    colors.needsUpdate = true;
  }

  /** The mirrors' matrices: each at its state's yaw, the pulsing one swelling a little. */
  #writeMirrors(wave: number): void {
    const mesh = this.#mirrors;
    if (mesh === null) return;
    const matrices = mesh.instanceMatrix.array as Float32Array;
    for (let i = 0; i < this.#mirrorSpots.length; i++) {
      const spot = this.#mirrorSpots[i] as { x: number; z: number; state: number };
      const swell = i === this.#mirrorPulse ? 1 + 0.12 * (this.#reduceMotion ? 1 : wave) : 1;
      writeMatrix(matrices, i, spot.x, spot.z, MIRROR_YAW[spot.state] ?? 0, swell, swell, swell);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }
}
