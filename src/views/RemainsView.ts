// The remains (SPEC-057 §4.6). Until the reveal they are a dropped cargo pack —
// a `crate.glb` clone resting on the ground; after it they are the salvager's
// own body — a `character.glb` clone in the save's colours, posed once on the
// last frame of its `Death` clip, as SPEC-048's scav bodies are. Either stands
// under a 6 m pillar in the save's secondary colour, SPEC-027's light-pillar
// style held still (57-h: it never pulses).
//
// A view, not an entity: nothing to fight, collide with or update (§4.6, "No
// collision"). It builds on the first `set` that shows something, so a visit
// without remains pays nothing. Budget: the object is one draw (the crate is
// merged to one geometry; the body is one skinned mesh), the pillar one, and
// the object's shadow on `high` one — 3 draws at most, 2 640 triangles for the
// body.
import * as THREE from 'three';
import { pickClip } from '@/core/CharacterState';
import { log } from '@/core/Log';
import type { ModelId } from '@/data/assets';
import { tintSalvager, type CharacterAssets } from '@/views/CharacterView';
import { geometryFromModel } from '@/views/SurfaceProps';

/** §4.6: the pillar's height, in metres. */
export const REMAINS_PILLAR_HEIGHT = 6;
/** §4.6: the pillar's opacity — SPEC-027's still value; it never pulses. */
export const REMAINS_PILLAR_OPACITY = 0.5;
/** The pillar's radius and sides (12 sides, open-ended: 24 triangles). */
const PILLAR_RADIUS = 0.3;
const PILLAR_SIDES = 12;
/** The body faces this way (θ from +X toward +Z); nothing about it is meant to read. */
const BODY_FACING = Math.PI / 4;
/** The fallback pack when the boot set's crate is not in: SPEC-019's 0.6 m crate. */
const FALLBACK_CRATE = 0.6;

/**
 * SPEC-057 §4.6: which object stands there. Spelled out rather than imported:
 * `views/` may not reach `systems/` (SPEC-001 §4), and `systems/Remains`'s
 * `RemainsLook` is this same union.
 */
export type RemainsLook = 'pack' | 'body';

/** What the view needs from the asset cache: the two models, and whether each has landed. */
export interface RemainsAssets extends CharacterAssets {
  hasModel(id: ModelId): boolean;
}

/** §3: what `set` shows — `null` hides it. */
export interface RemainsModel {
  x: number;
  z: number;
  look: RemainsLook;
  primary: string;
  secondary: string;
}

export class RemainsView {
  readonly root = new THREE.Group();
  readonly #assets: RemainsAssets | undefined;
  readonly #heightAt: (x: number, z: number) => number;
  #shadows: boolean;
  /** The pillar, built with the first object; its material takes the secondary colour. */
  #pillar: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshBasicMaterial> | null = null;
  /** The pack or the body, and what it was built for. */
  #object: THREE.Object3D | null = null;
  #objectMeshes: THREE.Mesh[] = [];
  /** This view's own materials and geometries — the asset cache's are never freed here. */
  #owned: { dispose(): void }[] = [];
  #builtLook: RemainsLook | null = null;
  #builtPrimary = '';
  #builtSecondary = '';
  /** The `Death` clip's time the body was posed at; null for the pack or a body with no clip. */
  #posedAt: number | null = null;

  constructor(parent: THREE.Object3D, assets: RemainsAssets | undefined, heightAt: (x: number, z: number) => number, shadows: boolean) {
    this.#assets = assets;
    this.#heightAt = heightAt;
    this.#shadows = shadows;
    this.root.name = 'remains';
    this.root.visible = false;
    parent.add(this.root);
  }

  /** §4.6: `null` hides the remains; a look or a colour that changed rebuilds the object. */
  set(model: RemainsModel | null): void {
    if (model === null) {
      this.root.visible = false;
      return;
    }
    if (this.#object === null || model.look !== this.#builtLook || model.primary !== this.#builtPrimary || model.secondary !== this.#builtSecondary) {
      this.#build(model);
    }
    this.root.position.set(model.x, this.#heightAt(model.x, model.z), model.z);
    this.root.visible = true;
  }

  /** A shadow caster on `high` only, following a preset change — as every character is. */
  setShadows(enabled: boolean): void {
    this.#shadows = enabled;
    for (const mesh of this.#objectMeshes) {
      mesh.castShadow = enabled;
      mesh.receiveShadow = enabled;
    }
  }

  /** True while the remains are on the ground (`sceneInfo` reads the budget only then). */
  get shown(): boolean {
    return this.root.visible && this.#object !== null;
  }

  /** The look the object was built as, or null before the first build. */
  get look(): RemainsLook | null {
    return this.#builtLook;
  }

  /** The `Death` clip's last-frame time the body holds; null for the pack, or for a body in its bind pose. */
  get posedAt(): number | null {
    return this.#posedAt;
  }

  /** §4.6, AC: draw calls while shown — each object mesh, the pillar, and the object's shadow on `high`. */
  get draws(): number {
    if (!this.shown) return 0;
    const meshes = this.#objectMeshes.length;
    return meshes + (this.#pillar === null ? 0 : 1) + (this.#shadows ? meshes : 0);
  }

  /** §4.6, AC: the triangles the main pass draws while shown — the object's and the pillar's. */
  get triangles(): number {
    if (!this.shown) return 0;
    let total = 0;
    for (const mesh of this.#objectMeshes) total += triangleCount(mesh.geometry);
    if (this.#pillar !== null) total += triangleCount(this.#pillar.geometry);
    return total;
  }

  dispose(): void {
    this.#clearObject();
    if (this.#pillar !== null) {
      this.#pillar.geometry.dispose();
      this.#pillar.material.dispose();
      this.#pillar = null;
    }
    this.root.parent?.remove(this.root);
  }

  #build(model: RemainsModel): void {
    this.#clearObject();
    const object = model.look === 'body' ? this.#buildBody(model) : this.#buildPack();
    this.#object = object;
    this.root.add(object);
    object.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (mesh.isMesh === true) this.#objectMeshes.push(mesh);
    });
    this.setShadows(this.#shadows);
    this.#buildPillar().material.color.set(model.secondary);
    this.#builtLook = model.look;
    this.#builtPrimary = model.primary;
    this.#builtSecondary = model.secondary;
  }

  /** §4.6: the pack — the boot set's crate merged to one geometry, resting on the ground. */
  #buildPack(): THREE.Object3D {
    this.#posedAt = null;
    const assets = this.#assets;
    let geometry: THREE.BufferGeometry;
    try {
      geometry = assets !== undefined && assets.hasModel('crate') ? geometryFromModel(assets.model('crate')) : fallbackCrate();
    } catch (cause) {
      log.warn('view', 'the remains pack could not use the crate model', cause);
      geometry = fallbackCrate();
    }
    // Rest it on the ground: the model's lowest point at y = 0.
    geometry.computeBoundingBox();
    const bottom = geometry.boundingBox?.min.y ?? 0;
    if (bottom !== 0) geometry.translate(0, -bottom, 0);
    const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.1 });
    this.#owned.push(geometry, material);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'remains_pack';
    return mesh;
  }

  /**
   * §4.6: the body — the salvager model in the save's colours (`tintSalvager`),
   * posed once on the last frame of `Death` by a throwaway mixer and never
   * updated again. A missing clip leaves the bind pose (SPEC-019's 19-a); a
   * missing model falls back to the pack, since remains are never a requirement.
   */
  #buildBody(model: RemainsModel): THREE.Object3D {
    const assets = this.#assets;
    if (assets === undefined || !assets.hasModel('character')) {
      log.warn('view', 'the remains body has no character model; the pack stands in');
      return this.#buildPack();
    }
    const root = assets.model('character');
    root.name = 'remains_body';
    root.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (mesh.isMesh !== true) return;
      const source = mesh.material;
      const clones = (Array.isArray(source) ? source : [source]).map((entry) => (entry as THREE.MeshStandardMaterial).clone());
      for (const clone of clones) {
        tintSalvager(clone, model.primary, model.secondary);
        this.#owned.push(clone);
      }
      mesh.material = Array.isArray(source) ? clones : (clones[0] as THREE.MeshStandardMaterial);
      // SPEC-040 AC-27: the cloned skeleton's bone texture is this view's to free.
      if ((mesh as THREE.SkinnedMesh).isSkinnedMesh === true) {
        const skeleton = (mesh as THREE.SkinnedMesh).skeleton;
        if (skeleton !== undefined) this.#owned.push(skeleton);
      }
    });
    const clips = assets.animations('character');
    const name = pickClip(
      clips.map((clip) => clip.name),
      'death',
    );
    const clip = name === null ? undefined : clips.find((entry) => entry.name === name);
    if (clip === undefined) {
      this.#posedAt = null;
      log.warn('view', 'the remains body has no death clip; it stays in the bind pose');
    } else {
      // As ScavBody's: the action is never stopped (a stop hands the bones back
      // their bind pose), and the mixer is simply dropped.
      const mixer = new THREE.AnimationMixer(root);
      const action = mixer.clipAction(clip);
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true;
      action.play();
      mixer.setTime(clip.duration);
      this.#posedAt = mixer.time;
    }
    root.rotation.y = Math.PI / 2 - BODY_FACING;
    return root;
  }

  /** The pillar, built once: open-ended, additive, alpha fading upward, never pulsing. */
  #buildPillar(): THREE.Mesh<THREE.CylinderGeometry, THREE.MeshBasicMaterial> {
    const existing = this.#pillar;
    if (existing !== null) return existing;
    const geometry = new THREE.CylinderGeometry(PILLAR_RADIUS, PILLAR_RADIUS, REMAINS_PILLAR_HEIGHT, PILLAR_SIDES, 1, true);
    // The vertical fade is four-component vertex colour, as SPEC-027's pillar:
    // opaque at the ground, gone at the top — no texture and no second draw.
    const position = geometry.getAttribute('position');
    const colors = new Float32Array(position.count * 4);
    for (let i = 0; i < position.count; i++) {
      const y = position.getY(i) / REMAINS_PILLAR_HEIGHT + 0.5;
      colors[i * 4] = 1;
      colors[i * 4 + 1] = 1;
      colors[i * 4 + 2] = 1;
      colors[i * 4 + 3] = Math.max(0, 1 - y) ** 1.5;
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 4));
    geometry.translate(0, REMAINS_PILLAR_HEIGHT / 2, 0);
    const material = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: REMAINS_PILLAR_OPACITY,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexColors: true,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'remains_pillar';
    mesh.renderOrder = 2;
    this.root.add(mesh);
    this.#pillar = mesh;
    return mesh;
  }

  #clearObject(): void {
    if (this.#object !== null) this.root.remove(this.#object);
    this.#object = null;
    this.#objectMeshes = [];
    for (const entry of this.#owned) entry.dispose();
    this.#owned = [];
    this.#builtLook = null;
  }
}

/** A 0.6 m box in the crate's brown, when the boot set's crate is not in. */
function fallbackCrate(): THREE.BufferGeometry {
  const geometry = new THREE.BoxGeometry(FALLBACK_CRATE, FALLBACK_CRATE, FALLBACK_CRATE).toNonIndexed();
  const count = geometry.getAttribute('position').count;
  const colors = new Float32Array(count * 3);
  const brown = new THREE.Color('#8a6a45');
  for (let i = 0; i < count; i++) {
    colors[i * 3] = brown.r;
    colors[i * 3 + 1] = brown.g;
    colors[i * 3 + 2] = brown.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

/** Triangles a geometry draws: its index count, else its vertex count, over three. */
function triangleCount(geometry: THREE.BufferGeometry): number {
  const index = geometry.getIndex();
  const count = index !== null ? index.count : (geometry.getAttribute('position')?.count ?? 0);
  return Math.floor(count / 3);
}
