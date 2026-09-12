// Storm sprites (SPEC-018 §4.9): one InstancedMesh of a unit quad replaces the
// SPEC-012 point cloud — streaks for sand, embers in the ash, additive spores
// — with the fixed camera's quaternion as a build-time billboard (the camera
// never rotates, SPEC-012 §4.3). Positions keep the deterministic
// index-plus-time drift: no randomness per frame, no allocation in `sync`.
import * as THREE from 'three';
import { hash01 } from '@/core/Noise';
import { particleSprite, type SpriteKind } from '@/views/ProceduralTextures';

export type ParticleKind = 'sand' | 'snow' | 'spores' | 'ash' | 'heat' | 'none';

interface StormLook {
  sprite: SpriteKind;
  width: number;
  height: number;
  /** Lateral m/s for wind-blown kinds, fall m/s for falling kinds. */
  speed: number;
  falling: boolean;
  color: string;
  opacity: number;
  additive: boolean;
  /** The §4.9 grade tint the view forwards through `renderer.setLook`. */
  tint: [number, number, number];
}

/** §4.9 per-kind look (*initial tuning*). */
export const STORM_LOOK: Record<Exclude<ParticleKind, 'none'>, StormLook> = {
  sand: { sprite: 'streak', width: 2.2, height: 0.15, speed: 18, falling: false, color: '#e0b070', opacity: 0.8, additive: false, tint: [1.05, 0.95, 0.8] },
  heat: { sprite: 'dot', width: 0.25, height: 0.25, speed: 2, falling: false, color: '#ffd0a0', opacity: 0.35, additive: true, tint: [1.05, 1, 0.9] },
  snow: { sprite: 'flake', width: 0.3, height: 0.3, speed: 4, falling: true, color: '#e6ecf2', opacity: 0.8, additive: false, tint: [0.92, 0.97, 1.06] },
  ash: { sprite: 'dot', width: 0.25, height: 0.25, speed: 3, falling: true, color: '#909090', opacity: 0.8, additive: false, tint: [1, 0.94, 0.9] },
  spores: { sprite: 'dot', width: 0.35, height: 0.35, speed: 2, falling: true, color: '#b0e080', opacity: 0.8, additive: true, tint: [0.95, 1.05, 0.9] },
};

/** The §4.9 ember accent: one ash particle in ten, via instanceColor. */
const EMBER_COLOR = '#ff8a3a';
const EMBER_FRACTION = 0.1;
/** The drift box around the player, matching SPEC-012's cloud. */
const BOX = 44;

const scratchMatrix = new THREE.Matrix4();
const scratchPosition = new THREE.Vector3();
const scratchScale = new THREE.Vector3();
const scratchColor = new THREE.Color();

export class StormParticles {
  readonly #mesh: THREE.InstancedMesh;
  readonly #material: THREE.MeshBasicMaterial;
  readonly #billboard: THREE.Quaternion;
  readonly #capacity: number;
  #kind: ParticleKind = 'none';
  #intensity = 0;

  constructor(parent: THREE.Object3D, billboard: THREE.Quaternion, capacity: number) {
    this.#capacity = capacity;
    this.#billboard = billboard.clone();
    this.#material = new THREE.MeshBasicMaterial({
      map: particleSprite('dot'),
      transparent: true,
      depthWrite: false,
      fog: true,
    });
    this.#mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), this.#material, capacity);
    this.#mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.#mesh.setColorAt(0, scratchColor.set('#ffffff'));
    this.#mesh.count = 0;
    this.#mesh.visible = false;
    this.#mesh.frustumCulled = false; // the box follows the player (18-h)
    parent.add(this.#mesh);
  }

  /** Retarget the cloud; the scene lerps `intensity` over 3 s (SPEC-012 §4.6). */
  set(kind: ParticleKind, intensity: number): void {
    if (kind !== this.#kind && kind !== 'none') {
      const look = STORM_LOOK[kind];
      this.#material.map = particleSprite(look.sprite);
      this.#material.blending = look.additive ? THREE.AdditiveBlending : THREE.NormalBlending;
      this.#material.color.set(look.color);
      // Ember subset for ash (§4.9); everything else runs plain white.
      for (let i = 0; i < this.#capacity; i++) {
        const ember = kind === 'ash' && hash01(7, i) < EMBER_FRACTION;
        this.#mesh.setColorAt(i, ember ? scratchColor.set(EMBER_COLOR).multiplyScalar(2) : scratchColor.set('#ffffff'));
      }
      if (this.#mesh.instanceColor !== null) this.#mesh.instanceColor.needsUpdate = true;
    }
    this.#kind = kind;
    this.#intensity = intensity;
    if (kind !== 'none') this.#material.opacity = STORM_LOOK[kind].opacity * intensity;
    this.#mesh.visible = kind !== 'none' && intensity > 0.02;
  }

  /** Deterministic drift from index + time; `ground` keeps the box on the dunes. */
  sync(px: number, pz: number, time: number, ground: (x: number, z: number) => number): void {
    if (!this.#mesh.visible || this.#kind === 'none') return;
    const look = STORM_LOOK[this.#kind];
    const count = Math.min(this.#capacity, Math.max(0, Math.round(this.#capacity * this.#intensity)));
    const half = BOX / 2;
    for (let i = 0; i < count; i++) {
      const seedA = i * 12.9898;
      const seedB = i * 78.233;
      let x: number;
      let y: number;
      let z: number;
      if (look.falling) {
        x = ((seedA * 37 + time * 2) % BOX) - half;
        z = ((seedB * 17 + time * 1.3) % BOX) - half;
        y = BOX * 0.25 - ((seedA * 11 + time * look.speed) % (BOX * 0.25));
      } else if (this.#kind === 'heat') {
        x = ((seedA * 37) % BOX) - half;
        z = ((seedB * 17) % BOX) - half;
        y = 0.4 + ((seedA * 5 + time * 1.5) % 4); // the rising shimmer
      } else {
        x = ((seedA * 37 + time * look.speed) % BOX) - half;
        z = ((seedB * 17 + time * look.speed * 0.6) % BOX) - half;
        y = 0.5 + (Math.sin(seedB + time * 2) + 1) * 2;
      }
      const wx = px + x;
      const wz = pz + z;
      scratchPosition.set(wx, y + ground(wx, wz), wz);
      scratchScale.set(look.width, look.height, 1);
      scratchMatrix.compose(scratchPosition, this.#billboard, scratchScale);
      this.#mesh.setMatrixAt(i, scratchMatrix);
    }
    this.#mesh.count = count;
    this.#mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.#mesh.parent?.remove(this.#mesh);
    this.#mesh.geometry.dispose();
    this.#material.dispose(); // the sprite maps are shared, session-lifetime
    this.#mesh.dispose();
  }
}
