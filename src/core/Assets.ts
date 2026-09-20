// The asset registry (SPEC-003 §4.3, D-26 … D-34). Boot loads every model and
// texture in the manifest once; scenes then take clones (`model()`) or the
// shared instance (`texture()`), and dispose their clones freely because
// everything the cache owns is tagged `userData.shared = true` (D-33/D-34).
//
// The loaders are injected so the unit tests run in node with fakes and no
// browser (D-29); they default to `GLTFLoader` / `TextureLoader` on one shared
// `LoadingManager`.
import type { AnimationClip, BufferGeometry, Group, Material, Object3D, Texture } from 'three';
import { LoadingManager, NoColorSpace, SRGBColorSpace, TextureLoader } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { ModelId, TextureId } from '@/data/assets';
import { log } from '@/core/Log';

/** A texture declares its colour space rather than having it guessed (D-28). */
export interface TextureEntry {
  readonly url: string;
  readonly kind?: 'color' | 'data';
}

export interface AudioEntry {
  readonly src: readonly string[];
  readonly sprite?: Readonly<Record<string, readonly [number, number]>>;
  readonly loop?: boolean;
  readonly bus: 'sfx' | 'music';
}

/**
 * The shape of `data/assets.ts`. The ids stay `string` here because a data
 * module imports nothing (SPEC-001 §4); the narrow `ModelId` / `TextureId`
 * unions derived from the table guard the public getters below.
 */
export interface AssetManifest {
  readonly models: Readonly<Record<string, string>>;
  readonly textures: Readonly<Record<string, TextureEntry>>;
  readonly audio: Readonly<Record<string, AudioEntry>>;
}

export interface AssetLoaders {
  gltf: { loadAsync(url: string): Promise<{ scene: Group; animations: AnimationClip[] }> };
  texture: { loadAsync(url: string): Promise<Texture> };
  /**
   * SPEC-015 AC-8: downscale one oversized image to `width × height`. Injected
   * for the same reason the loaders are (D-29) — the default draws to a
   * `<canvas>`, which node does not have. `null` means "could not", and the
   * source image is then left exactly as it was.
   */
  resize: TextureResizer;
}

/** The seam `Assets` clamps through; `null` when there is nothing to draw on. */
export type TextureResizer = (image: unknown, width: number, height: number) => unknown | null;

/**
 * SPEC-015 §3/§8, AC-8: the size an image may be uploaded at under a preset's
 * `textureMaxSize`. Pure, and exported for its own unit test.
 *
 * The reduction halves, rather than fitting the cap exactly: every texture this
 * game ships is a power of two, halving keeps it one, and a non-power-of-two
 * upload would silently lose its mip chain — which is the memory this cap is
 * here to save in the first place. A cap of `0` (or anything non-finite) means
 * "uncapped" and returns the source size untouched.
 */
export function clampedTextureSize(
  width: number,
  height: number,
  max: number,
): { readonly width: number; readonly height: number } {
  if (!Number.isFinite(max) || max <= 0 || !(width > 0) || !(height > 0)) return { width, height };
  let scaledWidth = width;
  let scaledHeight = height;
  while ((scaledWidth > max || scaledHeight > max) && scaledWidth > 1 && scaledHeight > 1) {
    scaledWidth = Math.max(1, Math.floor(scaledWidth / 2));
    scaledHeight = Math.max(1, Math.floor(scaledHeight / 2));
  }
  return { width: scaledWidth, height: scaledHeight };
}

/** The browser default for `AssetLoaders.resize`: draw the image down a canvas. */
export function canvasTextureResizer(image: unknown, width: number, height: number): unknown | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (context === null) return null;
  context.drawImage(image as CanvasImageSource, 0, 0, width, height);
  return canvas;
}

interface ModelEntry {
  readonly scene: Group;
  readonly animations: AnimationClip[];
}

function markShared(resource: { userData: Record<string, unknown> }): void {
  resource.userData['shared'] = true;
}

function isTexture(value: unknown): value is Texture {
  return typeof value === 'object' && value !== null && (value as { isTexture?: boolean }).isTexture === true;
}

/** Tag everything a cached model owns, so `disposeObject3D` walks past it (D-33). */
function markModelShared(root: Object3D): void {
  root.traverse((node) => {
    const holder = node as Object3D & { geometry?: BufferGeometry; material?: Material | Material[] };
    if (holder.geometry) markShared(holder.geometry);
    const material = holder.material;
    if (!material) return;
    for (const entry of Array.isArray(material) ? material : [material]) {
      markShared(entry);
      for (const value of Object.values(entry as unknown as Record<string, unknown>)) {
        if (isTexture(value)) markShared(value);
      }
    }
  });
}

function hasSkinnedMesh(root: Object3D): boolean {
  let skinned = false;
  root.traverse((node) => {
    if ((node as { isSkinnedMesh?: boolean }).isSkinnedMesh === true) skinned = true;
  });
  return skinned;
}

export class Assets {
  readonly #manager = new LoadingManager();
  readonly #injected: Partial<AssetLoaders>;
  readonly #models = new Map<string, ModelEntry>();
  readonly #textures = new Map<string, Texture>();
  #gltfLoader: AssetLoaders['gltf'] | null = null;
  #textureLoader: AssetLoaders['texture'] | null = null;
  #inflight: Promise<void> | null = null;
  #inflightManifest: AssetManifest | null = null;
  #loaded = false;
  #maxAnisotropy = 1;
  /** `0` until a preset says otherwise, which means "no cap" (AC-8). */
  #maxTextureSize = 0;

  constructor(loaders: Partial<AssetLoaders> = {}) {
    this.#injected = loaders;
  }

  /** True only after a complete successful pass over the manifest (D-30). */
  get loaded(): boolean {
    return this.#loaded;
  }

  /**
   * Preload every model and texture in the manifest. Items already in the cache
   * are counted but not re-fetched, so a retry after a partial failure only
   * asks for what is missing (D-30); concurrent calls share one promise.
   */
  load(manifest: AssetManifest, onProgress?: (done: number, total: number) => void): Promise<void> {
    if (this.#inflight) {
      // Concurrent calls for the same manifest share the promise (D-30); a
      // *different* manifest queues behind the current pass so its items are
      // still fetched (SPEC-018 18-m: lazy per-planet loads after boot).
      if (this.#inflightManifest === manifest) return this.#inflight;
      return this.#inflight.catch(() => undefined).then(() => this.load(manifest, onProgress));
    }
    this.#inflightManifest = manifest;
    const run = this.#loadAll(manifest, onProgress).finally(() => {
      this.#inflight = null;
      this.#inflightManifest = null;
    });
    this.#inflight = run;
    return run;
  }

  /** A deep clone the caller owns; it shares the cached geometry/materials (D-33). */
  model(id: ModelId): Group {
    const entry = this.#requireModel(id);
    // `SkeletonUtils.clone` is the only clone that rebinds a skeleton to the
    // cloned bones; plain `clone()` would leave every instance sharing one pose.
    const root = hasSkinnedMesh(entry.scene) ? (cloneSkinned(entry.scene) as Group) : entry.scene.clone(true);
    return root;
  }

  /** The model's clips, shared — do not mutate. `[]` for a model without any (D-32). */
  animations(id: ModelId): AnimationClip[] {
    return this.#requireModel(id).animations;
  }

  /**
   * True once `load()` has cached this model — how the surface prop path asks
   * "did the lazy per-planet drop land yet?" without throwing (SPEC-018 §4.10).
   */
  hasModel(id: string): boolean {
    return this.#models.has(id);
  }

  /** The one shared instance, tagged `userData.shared === true` (D-33). */
  texture(id: TextureId): Texture {
    if (!this.#loaded) throw new Error(`assets: texture("${id}") requested before load() finished`);
    const texture = this.#textures.get(id);
    if (!texture) throw new Error(`assets: unknown texture id "${id}"`);
    return texture;
  }

  /**
   * SPEC-015 §3/§8, AC-8: the preset's `textureMaxSize`. `Game` sets it before
   * the first upload and again whenever the preset changes, and every texture —
   * boot manifest or a lazy per-planet drop afterwards — is clamped to it on
   * the way into the cache.
   *
   * Lowering the cap re-clamps what is already cached. Raising it does not
   * restore detail that was already thrown away: the full-size image is not
   * kept alive for a resolution the session has decided it cannot afford, so a
   * preset that goes up mid-session gets its larger textures on the next boot.
   */
  setMaxTextureSize(max: number): void {
    const next = Number.isFinite(max) && max > 0 ? Math.floor(max) : 0;
    if (next === this.#maxTextureSize) return;
    this.#maxTextureSize = next;
    for (const texture of this.#textures.values()) this.#clamp(texture);
  }

  /** Called by `Game` once the renderer exists; defaults to 1 (SPEC-003 §4.3). */
  setMaxAnisotropy(max: number): void {
    this.#maxAnisotropy = Math.max(1, Math.floor(max));
    for (const texture of this.#textures.values()) {
      texture.anisotropy = Math.min(4, this.#maxAnisotropy);
      texture.needsUpdate = true;
    }
  }

  #requireModel(id: ModelId): ModelEntry {
    if (!this.#loaded) throw new Error(`assets: model("${id}") requested before load() finished`);
    const entry = this.#models.get(id);
    if (!entry) throw new Error(`assets: unknown model id "${id}"`);
    return entry;
  }

  async #loadAll(manifest: AssetManifest, onProgress?: (done: number, total: number) => void): Promise<void> {
    const models = Object.entries(manifest.models);
    const textures = Object.entries(manifest.textures);
    const total = models.length + textures.length;
    let done = 0;
    // Progress is item counts, not bytes (D-31): monotonic, ending at (total, total).
    onProgress?.(done, total);

    for (const [id, url] of models) {
      if (!this.#models.has(id)) this.#models.set(id, await this.#loadModel(id, url));
      onProgress?.(++done, total);
    }
    for (const [id, entry] of textures) {
      if (!this.#textures.has(id)) this.#textures.set(id, await this.#loadTexture(id, entry));
      onProgress?.(++done, total);
    }
    this.#loaded = true;
  }

  async #loadModel(id: string, url: string): Promise<ModelEntry> {
    const gltf = await this.#fetch('model', id, url, () => this.#gltf().loadAsync(url));
    markModelShared(gltf.scene);
    return { scene: gltf.scene, animations: gltf.animations };
  }

  async #loadTexture(id: string, entry: TextureEntry): Promise<Texture> {
    const texture = await this.#fetch('texture', id, entry.url, () => this.#texture().loadAsync(entry.url));
    texture.colorSpace = (entry.kind ?? 'color') === 'color' ? SRGBColorSpace : NoColorSpace;
    texture.generateMipmaps = true;
    texture.anisotropy = Math.min(4, this.#maxAnisotropy);
    // AC-8: before the texture is ever handed out, so nothing over the preset's
    // cap reaches the GPU — including the lazy per-planet drops of SPEC-018.
    this.#clamp(texture, id);
    markShared(texture);
    return texture;
  }

  /** Draw an oversized image down to the cap; a no-op when it already fits. */
  #clamp(texture: Texture, id?: string): void {
    const image = texture.image as { width?: number; height?: number } | null | undefined;
    const width = image?.width ?? 0;
    const height = image?.height ?? 0;
    const target = clampedTextureSize(width, height, this.#maxTextureSize);
    if (target.width === width && target.height === height) return;
    const scaled = this.#resize()(image, target.width, target.height);
    if (scaled === null || scaled === undefined) {
      // No canvas to draw on. The source is left alone rather than corrupted:
      // the cap is a budget, not a correctness rule (SPEC-015 §8).
      log.warn('assets', `texture "${id ?? '?'}" could not be clamped to ${this.#maxTextureSize}px`);
      return;
    }
    texture.image = scaled;
    texture.needsUpdate = true;
  }

  /** One failing item rejects the whole load, naming what could not be fetched (D-30). */
  async #fetch<T>(kind: string, id: string, url: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (cause) {
      log.error('assets', `${kind} "${id}" failed to load from ${url}`, cause);
      throw new Error(`assets: ${kind} "${id}" failed to load from ${url}`, { cause });
    }
  }

  #gltf(): AssetLoaders['gltf'] {
    this.#gltfLoader ??= this.#injected.gltf ?? new GLTFLoader(this.#manager);
    return this.#gltfLoader;
  }

  #texture(): AssetLoaders['texture'] {
    this.#textureLoader ??= this.#injected.texture ?? new TextureLoader(this.#manager);
    return this.#textureLoader;
  }

  #resize(): TextureResizer {
    return this.#injected.resize ?? canvasTextureResizer;
  }
}
