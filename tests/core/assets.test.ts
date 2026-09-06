// The asset registry (SPEC-003 §6), driven through injected fake loaders (D-29)
// so it runs in node with no browser and no network.
import { afterEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Assets, type AssetLoaders, type AssetManifest } from '@/core/Assets';
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
}

function fakeLoaders(): Fakes {
  const fakes: Fakes = {
    requests: [],
    fail: new Set<string>(),
    clips: [],
    model: boxModel,
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
        return new THREE.Texture();
      },
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
