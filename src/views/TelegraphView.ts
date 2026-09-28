// The ground telegraphs (SPEC-038 §4.2): every live telegraph drawn on the
// ground in `HOSTILE_RIM` — its outline from `startAt`, a fill that grows by
// `telegraphProgress`, and a ring's travelling band. One `InstancedMesh` per
// kind, each hidden while its kind has none, so the whole layer costs at most
// three draw calls and nothing at all while the pool is empty (§4.11).
//
// Each decal is one flat quad; its shader draws the outline and the fill from
// per-instance attributes, so the outline and the fill share the draw. Decals
// sit 0.05 m over the highest ground under them, under the enemies. A kind's
// mesh is built the first time that kind is drawn. Read-only over the pool:
// nothing here writes an entity.
import * as THREE from 'three';
import type { Pool } from '@/core/Pool';
import { ringRadius, TELEGRAPH_CAPACITY, telegraphProgress, type TelegraphEntity, type TelegraphKind } from '@/entities/Telegraph';
import { HOSTILE_RIM } from '@/views/ProceduralMeshes';

/** §4.2: an elite's decal outline is gold. */
export const ELITE_OUTLINE = '#e0b34a';
/** §4.2: decals sit this far over the height field. */
export const TELEGRAPH_LIFT = 0.05;
/** The outline's width, in metres. */
const OUTLINE_WIDTH = 0.14;
/** §4.2: outline 0.6, fill 0.35, a ring's travelling band 0.5. */
const OUTLINE_ALPHA = 0.6;
const FILL_ALPHA = 0.35;
const BAND_ALPHA = 0.5;
/** The outline's breathing, in rad/s — gone under reduce motion. */
const PULSE_RATE = 9;

const KINDS: readonly TelegraphKind[] = ['circle', 'line', 'ring'];
const KIND_INDEX: Readonly<Record<TelegraphKind, number>> = { circle: 0, line: 1, ring: 2 };

/**
 * The shape, injected into `MeshBasicMaterial` after `diffuseColor` is set —
 * the enemy materials' pattern (views/ProceduralMeshes.ts), so the layer stays
 * standard-or-basic and keeps three's fog, tone mapping and colour space.
 * `vShape` by kind — circle: (radius, progress, 0, 0); line: (length, width,
 * progress, 0); ring: (half extent, ringMax, band radius or −1 in the windup,
 * band width). The fill is the material colour (`HOSTILE_RIM`); the outline
 * is `vOutline` (gold for an elite's).
 */
const SHAPE_CHUNK = /* glsl */ `
  float outlineAlpha = ${OUTLINE_ALPHA.toFixed(3)} * (1.0 - 0.18 * uPulse * (0.5 + 0.5 * sin(uTime * ${PULSE_RATE.toFixed(3)})));
  float edgeWidth = ${OUTLINE_WIDTH.toFixed(3)};
  vec3 shapeColor = diffuseColor.rgb;
  float shapeAlpha = 0.0;
#if TELEGRAPH_KIND == 0
  float radius = vShape.x;
  float d = length(vTelegraphUv - 0.5) * 2.0 * radius;
  if (d > radius) discard;
  if (d >= radius - edgeWidth) { shapeColor = vOutline; shapeAlpha = outlineAlpha; }
  else if (d >= radius * (1.0 - vShape.y)) { shapeAlpha = ${FILL_ALPHA.toFixed(3)}; }
#elif TELEGRAPH_KIND == 1
  float along = vTelegraphUv.x * vShape.x;
  float across = abs(vTelegraphUv.y - 0.5) * vShape.y;
  if (along < edgeWidth || along > vShape.x - edgeWidth || across > vShape.y * 0.5 - edgeWidth) {
    shapeColor = vOutline;
    shapeAlpha = outlineAlpha;
  } else if (vTelegraphUv.x <= vShape.z) {
    shapeAlpha = ${FILL_ALPHA.toFixed(3)};
  }
#else
  float d = length(vTelegraphUv - 0.5) * 2.0 * vShape.x;
  if (abs(d - vShape.y) <= edgeWidth * 0.5) { shapeColor = vOutline; shapeAlpha = outlineAlpha; }
  if (vShape.z >= 0.0 && abs(d - vShape.z) <= vShape.w * 0.5) { shapeColor = diffuseColor.rgb; shapeAlpha = ${BAND_ALPHA.toFixed(3)}; }
#endif
  if (shapeAlpha <= 0.0) discard;
  diffuseColor = vec4(shapeColor, diffuseColor.a * shapeAlpha);`;

/** Adds the per-instance shape to a basic material; one program per kind. */
function injectShape(material: THREE.MeshBasicMaterial, kind: TelegraphKind, pulse: { value: number }, clock: { value: number }): void {
  material.defines = { TELEGRAPH_KIND: KIND_INDEX[kind] };
  material.onBeforeCompile = (shader) => {
    shader.uniforms['uPulse'] = pulse;
    shader.uniforms['uTime'] = clock;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        'attribute vec4 aShape;\nattribute vec3 aOutline;\nvarying vec2 vTelegraphUv;\nvarying vec4 vShape;\nvarying vec3 vOutline;\n#include <common>',
      )
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvTelegraphUv = uv;\nvShape = aShape;\nvOutline = aOutline;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        'uniform float uPulse;\nuniform float uTime;\nvarying vec2 vTelegraphUv;\nvarying vec4 vShape;\nvarying vec3 vOutline;\n#include <common>',
      )
      .replace('vec4 diffuseColor = vec4( diffuse, opacity );', `vec4 diffuseColor = vec4( diffuse, opacity );${SHAPE_CHUNK}`);
  };
  material.customProgramCacheKey = () => `telegraph/${kind}`;
}

const scratchMatrix = new THREE.Matrix4();
const scratchPosition = new THREE.Vector3();
const scratchQuaternion = new THREE.Quaternion();
const scratchScale = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const RIM = new THREE.Color(HOSTILE_RIM);
const GOLD = new THREE.Color(ELITE_OUTLINE);

interface KindMesh {
  readonly mesh: THREE.InstancedMesh;
  readonly shape: THREE.InstancedBufferAttribute;
  readonly outline: THREE.InstancedBufferAttribute;
  readonly material: THREE.MeshBasicMaterial;
}

export class TelegraphView {
  readonly #parent: THREE.Object3D;
  readonly #capacity: number;
  /** Built on the first telegraph of each kind, so a visit with none adds no mesh. */
  readonly #kinds: Partial<Record<TelegraphKind, KindMesh>> = {};
  readonly #pulse = { value: 1 };
  readonly #clock = { value: 0 };

  constructor(parent: THREE.Object3D, capacity: number = TELEGRAPH_CAPACITY) {
    this.#parent = parent;
    this.#capacity = capacity;
  }

  /**
   * One kind's mesh, built on first use: a unit quad on the ground whose local
   * +X is a lane's direction, and whose uv's x runs from the origin (0) to the
   * far end (1).
   */
  #meshFor(kind: TelegraphKind): KindMesh {
    const built = this.#kinds[kind];
    if (built !== undefined) return built;
    const material = new THREE.MeshBasicMaterial({
      color: RIM,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
      side: THREE.DoubleSide,
    });
    injectShape(material, kind, this.#pulse, this.#clock);
    const geometry = new THREE.PlaneGeometry(1, 1);
    geometry.rotateX(-Math.PI / 2);
    const shape = new THREE.InstancedBufferAttribute(new Float32Array(this.#capacity * 4), 4);
    const outline = new THREE.InstancedBufferAttribute(new Float32Array(this.#capacity * 3), 3);
    shape.setUsage(THREE.DynamicDrawUsage);
    outline.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('aShape', shape);
    geometry.setAttribute('aOutline', outline);
    const mesh = new THREE.InstancedMesh(geometry, material, this.#capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.visible = false;
    mesh.frustumCulled = false;
    // Over the ground and its blobs, under the bodies (§4.2).
    mesh.renderOrder = 1;
    mesh.name = `telegraph-${kind}`;
    this.#parent.add(mesh);
    const entry: KindMesh = { mesh, shape, outline, material };
    this.#kinds[kind] = entry;
    return entry;
  }

  /** How many instances one kind drew on the last `sync` — the view test's read. */
  count(kind: TelegraphKind): number {
    return this.#kinds[kind]?.mesh.count ?? 0;
  }

  /** Whether one kind's mesh is drawn at all. */
  visible(kind: TelegraphKind): boolean {
    return this.#kinds[kind]?.mesh.visible === true;
  }

  /** The draw calls this layer adds: one per kind with a live telegraph, at most three. */
  get drawCalls(): number {
    let n = 0;
    for (const kind of KINDS) if (this.#kinds[kind]?.mesh.visible === true) n++;
    return n;
  }

  /**
   * One pass over the pool, per rendered frame: `time` is the world clock the
   * telegraphs were stamped on, `ground` the height field. Reduce motion keeps
   * the fill (it is information) and stills the outline's breathing.
   */
  sync(pool: Pool<TelegraphEntity>, time: number, ground: (x: number, z: number) => number, reduceMotion: boolean): void {
    this.#pulse.value = reduceMotion ? 0 : 1;
    this.#clock.value = time;
    for (const kind of KINDS) {
      const built = this.#kinds[kind];
      if (built !== undefined) built.mesh.count = 0;
    }
    for (let i = 0; i < pool.size; i++) {
      const t = pool.at(i);
      const target = this.#meshFor(t.kind);
      const slot = target.mesh.count;
      if (slot >= target.mesh.instanceMatrix.count) continue;
      target.mesh.count++;
      const outline = t.elite ? GOLD : RIM;
      target.outline.setXYZ(slot, outline.r, outline.g, outline.b);
      const progress = telegraphProgress(t, time);
      if (t.kind === 'circle') {
        const lift = this.#highest(ground, t.x, t.z, t.radius);
        scratchPosition.set(t.x, lift + TELEGRAPH_LIFT, t.z);
        scratchQuaternion.identity();
        scratchScale.set(t.radius * 2, 1, t.radius * 2);
        target.shape.setXYZW(slot, t.radius, progress, 0, 0);
      } else if (t.kind === 'line') {
        const cx = t.x + t.dirX * t.length * 0.5;
        const cz = t.z + t.dirZ * t.length * 0.5;
        const lift = Math.max(ground(t.x, t.z), ground(cx, cz), ground(t.x + t.dirX * t.length, t.z + t.dirZ * t.length));
        scratchPosition.set(cx, lift + TELEGRAPH_LIFT, cz);
        scratchQuaternion.setFromAxisAngle(UP, Math.atan2(-t.dirZ, t.dirX));
        scratchScale.set(t.length, 1, t.width);
        target.shape.setXYZW(slot, t.length, t.width, progress, 0);
      } else {
        const band = time >= t.hitAt ? ringRadius(t, time) : -1;
        const extent = Math.max(t.ringMax, band) + t.band;
        const lift = this.#highest(ground, t.x, t.z, t.ringMax);
        scratchPosition.set(t.x, lift + TELEGRAPH_LIFT, t.z);
        scratchQuaternion.identity();
        scratchScale.set(extent * 2, 1, extent * 2);
        target.shape.setXYZW(slot, extent, t.ringMax, band, t.band);
      }
      scratchMatrix.compose(scratchPosition, scratchQuaternion, scratchScale);
      target.mesh.setMatrixAt(slot, scratchMatrix);
    }
    for (const kind of KINDS) {
      const target = this.#kinds[kind];
      if (target === undefined) continue;
      target.mesh.visible = target.mesh.count > 0;
      if (target.mesh.count === 0) continue;
      target.mesh.instanceMatrix.needsUpdate = true;
      target.shape.needsUpdate = true;
      target.outline.needsUpdate = true;
    }
  }

  /** The highest ground under a disc — the centre and four points on its rim. */
  #highest(ground: (x: number, z: number) => number, x: number, z: number, radius: number): number {
    return Math.max(
      ground(x, z),
      ground(x + radius, z),
      ground(x - radius, z),
      ground(x, z + radius),
      ground(x, z - radius),
    );
  }

  dispose(): void {
    for (const kind of KINDS) {
      const target = this.#kinds[kind];
      if (target === undefined) continue;
      target.mesh.parent?.remove(target.mesh);
      target.mesh.geometry.dispose();
      target.material.dispose();
      target.mesh.dispose();
      delete this.#kinds[kind];
    }
  }
}
