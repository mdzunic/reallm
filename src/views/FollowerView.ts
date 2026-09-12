// The escort probe (SPEC-019 §4.8) — the committed `probe.glb` when its lazy
// load has landed, otherwise a procedural drone (body, antenna ring, emissive
// lens). Either way it hovers at `0.8 + 0.1 · sin(2t)` above the height field
// with an engine glow bright enough to cross SPEC-017's bloom threshold.
import * as THREE from 'three';
import { disposeObject3D } from '@/core/Disposer';
import { log } from '@/core/Log';
import type { ModelId } from '@/data/assets';
import type { FollowerEntity } from '@/entities/Follower';
import type { CharacterAssets } from '@/views/CharacterView';

/** §4.8 (*initial tuning*): hover height and bob; the glow clears bloom at 0.85. */
const HOVER_BASE = 0.8;
const HOVER_BOB = 0.1;
const GLOW_INTENSITY = 2.5;
const GLOW_COLOR = '#8ad7ff';

export class FollowerView {
  readonly root: THREE.Object3D;
  /** Material clones this view owns (the model path); procedural owns it all. */
  readonly #ownMaterials: THREE.Material[] = [];
  readonly #fromModel: boolean;

  constructor(parent: THREE.Object3D, assets: CharacterAssets | undefined, model: ModelId | 'procedural') {
    let root: THREE.Object3D | null = null;
    if (model !== 'procedural' && assets !== undefined) {
      try {
        root = assets.model(model);
        // The probe's `Glow` material is the engine; its own clone is driven
        // past the bloom threshold without touching the cached template.
        root.traverse((node) => {
          const mesh = node as THREE.Mesh;
          if (mesh.isMesh !== true) return;
          const source = mesh.material;
          const clones = (Array.isArray(source) ? source : [source]).map((entry) => entry.clone());
          for (const clone of clones) {
            const standard = clone as THREE.MeshStandardMaterial;
            if (clone.name === 'Glow' && standard.isMeshStandardMaterial === true) {
              standard.emissive.set(GLOW_COLOR);
              standard.emissiveIntensity = GLOW_INTENSITY;
            }
            this.#ownMaterials.push(clone);
          }
          mesh.material = Array.isArray(source) ? clones : (clones[0] as THREE.Material);
        });
      } catch (cause) {
        // 19-l: the lazy drop has not landed or the file is broken — the
        // procedural probe stands in and the escort mission is unaffected.
        log.warn('view', `follower model "${model}" unavailable; using the procedural probe`, cause);
        root = null;
      }
    }
    this.#fromModel = root !== null;
    this.root = root ?? buildProceduralProbe();
    this.root.visible = false;
    parent.add(this.root);
  }

  sync(follower: FollowerEntity | null, time: number, y: number): void {
    const visible = follower !== null && follower.alive;
    this.root.visible = visible;
    if (follower === null || !visible) return;
    this.root.position.set(follower.x, HOVER_BASE + HOVER_BOB * Math.sin(time * 2) + y, follower.z);
    this.root.rotation.y = Math.PI / 2 - follower.facing;
  }

  dispose(): void {
    this.root.parent?.remove(this.root);
    if (this.#fromModel) {
      // The clones inherited the cache's `shared` tag — freed by hand, while
      // geometry and textures stay with `Assets` (D-33).
      for (const material of this.#ownMaterials) material.dispose();
      this.#ownMaterials.length = 0;
    } else {
      disposeObject3D(this.root);
    }
  }
}

/** The SPEC-012-era probe, sculpted a little: body, antenna ring, lens, engine. */
function buildProceduralProbe(): THREE.Group {
  const group = new THREE.Group();
  const hull = new THREE.MeshStandardMaterial({ color: '#c0d8e8', roughness: 0.4, metalness: 0.6 });
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.42, 10, 8), hull);
  body.castShadow = true;
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.05, 6, 20), hull);
  ring.rotation.x = Math.PI / 2;
  // The lens looks along +Z like the GLB (PLAN R8-1); the engine glow points
  // down. Both share one emissive material bright enough to bloom (§4.8).
  const glow = new THREE.MeshStandardMaterial({
    color: '#000000',
    emissive: new THREE.Color(GLOW_COLOR),
    emissiveIntensity: GLOW_INTENSITY,
  });
  glow.name = 'Glow';
  const lens = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 6), glow);
  lens.position.z = 0.38;
  const engine = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.2, 8), glow);
  engine.position.y = -0.4;
  engine.rotation.x = Math.PI;
  group.add(body, ring, lens, engine);
  return group;
}
