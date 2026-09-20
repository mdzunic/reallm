// The asset registry (SPEC-003 §6), driven through injected fake loaders (D-29)
// so it runs in node with no browser and no network.
import { afterEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Assets, clampedTextureSize, type AssetLoaders, type AssetManifest } from '@/core/Assets';
import { QUALITY } from '@/core/Quality';
import { setLogSink } from '@/core/Log';
import { ASSETS, type ModelId, type TextureId } from '@/data/assets';

const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function boxModel(): THREE.Group {
  const group = new THREE.Group();
  const material = new THREE.MeshBasicMaterial({ map: new THREE.Texture() });
  group.add(new THREE.Mesh(new THREE.BoxGeometry(), material));
  return group;
}

function skinnedModel(): THREE.Group {
  const group = new THREE.Group();
  const bone = new THREE.Bone();
  group.add(bone);
  const mesh = new THREE.SkinnedMesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  group.add(mesh);
  mesh.bind(new THREE.Skeleton([bone]));
  return group;
}

interface Fakes extends AssetLoaders {
  requests: string[];
  fail: Set<string>;
  clips: THREE.AnimationClip[];
  model: () => THREE.Group;
  /** The image every fake texture loads with; `null` for a texture with none. */
  image: { width: number; height: number } | null;
  /** SPEC-015 AC-8: every downscale `Assets` asked for, in order. */
  resized: Array<{ width: number; height: number }>;
  /** Make the resizer fail the way a browser with no 2D context would. */
  cannotResize: boolean;
}

function fakeLoaders(): Fakes {
  const fakes: Fakes = {
    requests: [],
    fail: new Set<string>(),
    clips: [],
    model: boxModel,
    image: null,
    resized: [],
    cannotResize: false,
    gltf: {
      loadAsync: async (url: string) => {
        fakes.requests.push(url);
        if (fakes.fail.has(url)) throw new Error('network is down');
        return { scene: fakes.model(), animations: fakes.clips };
      },
    },
    texture: {
      loadAsync: async (url: string) => {
        fakes.requests.push(url);
        if (fakes.fail.has(url)) throw new Error('network is down');
        const texture = new THREE.Texture();
        if (fakes.image !== null) texture.image = { ...fakes.image };
        return texture;
      },
    },
    // Node has no `<canvas>`, so the drawing half is the injected seam (D-29);
    // what it returns stands in for the scaled-down image.
    resize: (_image: unknown, width: number, height: number): unknown | null => {
      fakes.resized.push({ width, height });
      return fakes.cannotResize ? null : { width, height };
    },
  };
  return fakes;
}

const MANIFEST: AssetManifest = {
  models: { crate: 'assets/models/crate.glb' },
  textures: {
    grid: { url: 'assets/textures/grid.png' },
    noise: { url: 'assets/textures/noise.png', kind: 'data' },
  },
  audio: {},
};

const CRATE = 'crate' as ModelId;
const GRID = 'grid' as TextureId;
const NOISE = 'noise' as TextureId;

afterEach(() => {
  setLogSink(console);
});

describe('Assets.load()', () => {
  it('preloads every model and texture, reporting item progress (AC-42, AC-43, AC-44)', async () => {
    const fakes = fakeLoaders();
    const assets = new Assets(fakes);
    const progress: Array<[number, number]> = [];

    await assets.load(MANIFEST, (done, total) => progress.push([done, total]));

    expect(fakes.requests).toEqual([
      'assets/models/crate.glb',
      'assets/textures/grid.png',
      'assets/textures/noise.png',
    ]);
    expect(progress).toEqual([
      [0, 3],
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
    for (let i = 1; i < progress.length; i++) {
      expect(progress[i]?.[0]).toBeGreaterThanOrEqual(progress[i - 1]?.[0] ?? 0);
    }
    expect(assets.loaded).toBe(true);
  });

  it('loads the manifest the game ships (AC-42)', async () => {
    const fakes = fakeLoaders();
    const assets = new Assets(fakes);
    await assets.load(ASSETS);
    const urls = [
      ...Object.values(ASSETS.models),
      ...Object.values(ASSETS.textures).map((entry) => entry.url),
    ];
    expect(fakes.requests.sort()).toEqual(urls.sort());
    // Audio is declared but not fetched at boot (D-27).
    expect(fakes.requests.some((url) => url.includes('/audio/'))).toBe(false);
  });

  it('applies the declared colour space and mipmaps (§4.3, D-28)', async () => {
    const assets = new Assets(fakeLoaders());
    await assets.load(MANIFEST);
    expect(assets.texture(GRID).colorSpace).toBe(THREE.SRGBColorSpace);
    expect(assets.texture(NOISE).colorSpace).toBe(THREE.NoColorSpace);
    expect(assets.texture(GRID).generateMipmaps).toBe(true);
    expect(assets.texture(GRID).anisotropy).toBe(1);
    assets.setMaxAnisotropy(16);
    expect(assets.texture(GRID).anisotropy).toBe(4);
  });

  it('rejects with the failing id and url, and stays unloaded (AC-46, AC-49)', async () => {
    setLogSink(silent);
    const fakes = fakeLoaders();
    fakes.fail.add('assets/textures/noise.png');
    const assets = new Assets(fakes);

    await expect(assets.load(MANIFEST)).rejects.toThrow(/noise.*assets\/textures\/noise\.png/);
    expect(assets.loaded).toBe(false);
  });

  it('re-fetches only what is missing on retry (AC-48, AC-49)', async () => {
    setLogSink(silent);
    const fakes = fakeLoaders();
    fakes.fail.add('assets/textures/noise.png');
    const assets = new Assets(fakes);
    await expect(assets.load(MANIFEST)).rejects.toThrow();
    expect(assets.loaded).toBe(false);

    fakes.fail.clear();
    fakes.requests.length = 0;
    const progress: Array<[number, number]> = [];
    await assets.load(MANIFEST, (done, total) => progress.push([done, total]));

    expect(fakes.requests).toEqual(['assets/textures/noise.png']);
    expect(progress.at(-1)).toEqual([3, 3]);
    expect(assets.loaded).toBe(true);
  });

  it('shares one in-flight promise between concurrent calls (D-30)', async () => {
    const fakes = fakeLoaders();
    const assets = new Assets(fakes);
    const [first, second] = [assets.load(MANIFEST), assets.load(MANIFEST)];
    expect(first).toBe(second);
    await Promise.all([first, second]);
    expect(fakes.requests).toHaveLength(3);
  });
});

describe('the cache', () => {
  it('hands back independent clones that share the cached resources (AC-51, AC-52, AC-55)', async () => {
    const fakes = fakeLoaders();
    const assets = new Assets(fakes);
    await assets.load(MANIFEST);

    const first = assets.model(CRATE);
    const second = assets.model(CRATE);
    expect(first).not.toBe(second);

    const meshOf = (root: THREE.Object3D): THREE.Mesh => root.children[0] as THREE.Mesh;
    expect(meshOf(first)).not.toBe(meshOf(second));
    // The geometry and material are the cache's, by reference…
    expect(meshOf(first).geometry).toBe(meshOf(second).geometry);
    expect(meshOf(first).material).toBe(meshOf(second).material);
    // …which is why they carry the tag `disposeObject3D` looks for (D-33).
    expect(meshOf(first).geometry.userData['shared']).toBe(true);
    expect((meshOf(first).material as THREE.MeshBasicMaterial).userData['shared']).toBe(true);
    expect((meshOf(first).material as THREE.MeshBasicMaterial).map?.userData['shared']).toBe(true);

    // Moving a clone leaves the other one where it was.
    first.position.set(1, 2, 3);
    expect(second.position.x).toBe(0);
  });

  it('rebinds the skeleton of a skinned model (AC-50)', async () => {
    const fakes = fakeLoaders();
    fakes.model = skinnedModel;
    const assets = new Assets(fakes);
    await assets.load(MANIFEST);

    const clone = assets.model(CRATE);
    const cloned = clone.children.find((child) => (child as THREE.SkinnedMesh).isSkinnedMesh) as THREE.SkinnedMesh;
    const original = assets.model(CRATE).children.find(
      (child) => (child as THREE.SkinnedMesh).isSkinnedMesh,
    ) as THREE.SkinnedMesh;

    // `SkeletonUtils.clone` gives each clone its own skeleton bound to its own
    // bones; `Object3D.clone()` would have shared one pose between them.
    expect(cloned.skeleton).not.toBe(original.skeleton);
    expect(cloned.skeleton.bones[0]).toBe(clone.children[0]);
    expect(cloned.skeleton.bones[0]).not.toBe(original.skeleton.bones[0]);
  });

  it('returns the same texture instance every time (AC-53, AC-54)', async () => {
    const assets = new Assets(fakeLoaders());
    await assets.load(MANIFEST);
    expect(assets.texture(GRID)).toBe(assets.texture(GRID));
    expect(assets.texture(GRID).userData['shared']).toBe(true);
  });

  it('returns [] for a model without clips (AC-62)', async () => {
    const assets = new Assets(fakeLoaders());
    await assets.load(MANIFEST);
    expect(assets.animations(CRATE)).toEqual([]);
  });

  it('returns the model clips it loaded', async () => {
    const fakes = fakeLoaders();
    fakes.clips = [new THREE.AnimationClip('walk', 1, [])];
    const assets = new Assets(fakes);
    await assets.load(MANIFEST);
    expect(assets.animations(CRATE).map((clip) => clip.name)).toEqual(['walk']);
  });
});

describe('programming errors', () => {
  it('throws before load() has finished (AC-57, AC-59, AC-61)', () => {
    const assets = new Assets(fakeLoaders());
    expect(() => assets.model(CRATE)).toThrow(/before load/);
    expect(() => assets.texture(GRID)).toThrow(/before load/);
    expect(() => assets.animations(CRATE)).toThrow(/before load/);
  });

  it('throws for an unknown id (AC-56, AC-58, AC-60)', async () => {
    const assets = new Assets(fakeLoaders());
    await assets.load({ models: {}, textures: {}, audio: {} });
    expect(() => assets.model(CRATE)).toThrow(/unknown model id "crate"/);
    expect(() => assets.animations(CRATE)).toThrow(/unknown model id "crate"/);
    expect(() => assets.texture(GRID)).toThrow(/unknown texture id "grid"/);
  });
});

// ------------------------------------------- SPEC-015 §3/§8, AC-8: the cap
//
// `textureMaxSize` is 512/1024/2048 (SPEC-015 §3), and the criterion is not
// that the numbers exist — it is that `Assets` clamps what it uploads to them.
// Node has no `<canvas>`, so the drawing half arrives through the injected
// `resize` seam, exactly the way the loaders do (SPEC-003 D-29).

describe('clampedTextureSize (AC-8)', () => {
  it('leaves an image that already fits exactly as it is', () => {
    expect(clampedTextureSize(512, 512, 1024)).toEqual({ width: 512, height: 512 });
    expect(clampedTextureSize(1024, 1024, 1024)).toEqual({ width: 1024, height: 1024 });
    expect(clampedTextureSize(1024, 256, 1024)).toEqual({ width: 1024, height: 256 });
  });

  it('halves until both sides fit, so a power of two stays one', () => {
    expect(clampedTextureSize(2048, 2048, 512)).toEqual({ width: 512, height: 512 });
    expect(clampedTextureSize(4096, 4096, 1024)).toEqual({ width: 1024, height: 1024 });
    // The aspect ratio is preserved: the short side halves with the long one.
    expect(clampedTextureSize(2048, 512, 1024)).toEqual({ width: 1024, height: 256 });
  });

  it('treats a cap of 0, a negative cap or a missing size as uncapped', () => {
    expect(clampedTextureSize(4096, 4096, 0)).toEqual({ width: 4096, height: 4096 });
    expect(clampedTextureSize(4096, 4096, -1)).toEqual({ width: 4096, height: 4096 });
    expect(clampedTextureSize(4096, 4096, Number.NaN)).toEqual({ width: 4096, height: 4096 });
    expect(clampedTextureSize(0, 0, 512)).toEqual({ width: 0, height: 0 });
  });
});

describe('the preset texture cap (AC-8)', () => {
  it('carries §3 values that Assets can be driven with', () => {
    expect(QUALITY.low.textureMaxSize).toBe(512);
    expect(QUALITY.medium.textureMaxSize).toBe(1024);
    expect(QUALITY.high.textureMaxSize).toBe(2048);
  });

  it('clamps an oversized texture on the way into the cache', async () => {
    const fakes = fakeLoaders();
    fakes.image = { width: 2048, height: 2048 };
    const assets = new Assets(fakes);
    assets.setMaxTextureSize(QUALITY.low.textureMaxSize);
    await assets.load(MANIFEST);
    // Both manifest textures were drawn down to 512, and the cached texture is
    // the scaled image — not the 2048 one the loader returned.
    expect(fakes.resized).toEqual([
      { width: 512, height: 512 },
      { width: 512, height: 512 },
    ]);
    expect(assets.texture(GRID).image).toEqual({ width: 512, height: 512 });
    // `needsUpdate` is a write-only setter; the version it bumps is the read.
    expect(assets.texture(GRID).version).toBeGreaterThan(0);
  });

  it('leaves a texture that already fits the cap untouched', async () => {
    const fakes = fakeLoaders();
    fakes.image = { width: 512, height: 512 };
    const assets = new Assets(fakes);
    assets.setMaxTextureSize(QUALITY.medium.textureMaxSize);
    await assets.load(MANIFEST);
    expect(fakes.resized).toEqual([]);
    expect(assets.texture(GRID).image).toEqual({ width: 512, height: 512 });
  });

  it('uploads at full size while no preset has set a cap', async () => {
    const fakes = fakeLoaders();
    fakes.image = { width: 2048, height: 2048 };
    const assets = new Assets(fakes);
    await assets.load(MANIFEST);
    expect(fakes.resized).toEqual([]);
  });

  it('re-clamps what is already cached when the cap drops (a preset change)', async () => {
    const fakes = fakeLoaders();
    fakes.image = { width: 2048, height: 2048 };
    const assets = new Assets(fakes);
    assets.setMaxTextureSize(QUALITY.high.textureMaxSize);
    await assets.load(MANIFEST);
    expect(fakes.resized).toEqual([]); // 2048 fits `high`

    assets.setMaxTextureSize(QUALITY.low.textureMaxSize);
    expect(fakes.resized).toEqual([
      { width: 512, height: 512 },
      { width: 512, height: 512 },
    ]);
    expect(assets.texture(GRID).image).toEqual({ width: 512, height: 512 });
  });

  it('is a no-op when the cap is set again to the value it already had', async () => {
    const fakes = fakeLoaders();
    fakes.image = { width: 2048, height: 2048 };
    const assets = new Assets(fakes);
    assets.setMaxTextureSize(1024);
    await assets.load(MANIFEST);
    fakes.resized.length = 0;
    // `renderer:resized` fires on every plain resize too, not only on a preset
    // change; setting the same cap again must not redraw anything.
    assets.setMaxTextureSize(1024);
    expect(fakes.resized).toEqual([]);
  });

  it('leaves the source alone, and warns, when there is nothing to draw on', async () => {
    const warnings: string[] = [];
    setLogSink({ ...silent, warn: (_scope: string, message: string) => warnings.push(message) });
    const fakes = fakeLoaders();
    fakes.image = { width: 2048, height: 2048 };
    fakes.cannotResize = true;
    const assets = new Assets(fakes);
    assets.setMaxTextureSize(512);
    await assets.load(MANIFEST);
    // The cap is a budget, not a correctness rule: a texture that could not be
    // scaled ships at its own size rather than being replaced with nothing.
    expect(assets.texture(GRID).image).toEqual({ width: 2048, height: 2048 });
    expect(warnings.some((line) => /could not be clamped to 512px/.test(line))).toBe(true);
  });
});
