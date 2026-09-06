// Disposal discipline (SPEC-003 §4.4, D-33 … D-36). Every scene owns one
// `Disposer` and registers each subscription, DOM listener, timer and Three
// resource it creates; `dispose()` releases them in reverse order, isolating
// failures so one broken callback cannot leak the rest.
//
// `three` appears here only as types — `core/Disposer.ts` is one of the four
// core modules allowed to reach for it at all (SPEC-001 §4).
import type { BufferGeometry, Material, Object3D, Texture } from 'three';
import { log } from '@/core/Log';

/** Anything with a `userData` bag; geometries, materials and textures all have one. */
interface Taggable {
  readonly userData: Record<string, unknown>;
}

/**
 * True for a resource owned by `Assets` (D-33). Cloned models share their
 * cached geometries, materials and textures by reference, so disposing a clone
 * must leave them alone or the cache dies with it.
 */
function isShared(resource: Taggable | null | undefined): boolean {
  return resource?.userData?.['shared'] === true;
}

function isTexture(value: unknown): value is Texture {
  return typeof value === 'object' && value !== null && (value as { isTexture?: boolean }).isTexture === true;
}

function disposeMaterial(material: Material): void {
  if (isShared(material)) return;
  // Every map a material holds is a plain enumerable field (`map`, `normalMap`,
  // `alphaMap`, …), so walking its own values finds them all without a list
  // that would go stale with the next Three release.
  for (const value of Object.values(material as unknown as Record<string, unknown>)) {
    if (isTexture(value) && !isShared(value)) value.dispose();
  }
  material.dispose();
}

/**
 * Release the GPU resources of `root` and everything under it: geometries,
 * materials and the textures those materials own. Anything tagged
 * `userData.shared === true` belongs to `Assets` and is skipped (D-34).
 */
export function disposeObject3D(root: Object3D): void {
  root.traverse((node) => {
    const holder = node as Object3D & { geometry?: BufferGeometry; material?: Material | Material[] };
    const geometry = holder.geometry;
    if (geometry && !isShared(geometry)) geometry.dispose();
    const material = holder.material;
    if (!material) return;
    if (Array.isArray(material)) for (const entry of material) disposeMaterial(entry);
    else disposeMaterial(material);
  });
}

/** Reverse-order tear-down for one owner (a scene, a view, an overlay). */
export class Disposer {
  #callbacks: Array<() => void> = [];
  #disposed = false;

  get disposed(): boolean {
    return this.#disposed;
  }

  /**
   * Register a tear-down callback. After `dispose()` the callback is run
   * immediately instead of being queued for a run that will never come (D-36):
   * tear-down must never leak and must never throw.
   */
  add(fn: () => void): void {
    if (this.#disposed) {
      log.warn('disposer', 'add() after dispose(); running the callback immediately');
      this.#run(fn);
      return;
    }
    this.#callbacks.push(fn);
  }

  /** `add(() => disposeObject3D(root))`, the common case. */
  addObject3D(root: Object3D): void {
    this.add(() => disposeObject3D(root));
  }

  /** Run every callback in reverse registration order. A second call is a no-op. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (let i = this.#callbacks.length - 1; i >= 0; i--) {
      this.#run(this.#callbacks[i] as () => void);
    }
    this.#callbacks = [];
  }

  #run(fn: () => void): void {
    try {
      fn();
    } catch (error) {
      // One broken callback must not strand the ones after it (D-35).
      log.error('disposer', 'a dispose callback threw', error);
    }
  }
}
