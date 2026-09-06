// Disposal (SPEC-003 §6). Built from plain `THREE` objects — no GL context is
// needed to prove that `dispose()` was called on the right things.
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { Disposer, disposeObject3D } from '@/core/Disposer';
import { setLogSink, type LogSink } from '@/core/Log';

function recorder(): { sink: LogSink; calls: Array<{ level: keyof LogSink; args: unknown[] }> } {
  const calls: Array<{ level: keyof LogSink; args: unknown[] }> = [];
  const sink: LogSink = {
    debug: (...args: unknown[]) => void calls.push({ level: 'debug', args }),
    info: (...args: unknown[]) => void calls.push({ level: 'info', args }),
    warn: (...args: unknown[]) => void calls.push({ level: 'warn', args }),
    error: (...args: unknown[]) => void calls.push({ level: 'error', args }),
  };
  setLogSink(sink);
  return { sink, calls };
}

/** A mesh that owns everything it references. */
function ownedMesh(): { mesh: THREE.Mesh; geometry: THREE.BufferGeometry; material: THREE.MeshBasicMaterial; texture: THREE.Texture } {
  const geometry = new THREE.BoxGeometry();
  const texture = new THREE.Texture();
  const material = new THREE.MeshBasicMaterial({ map: texture });
  return { mesh: new THREE.Mesh(geometry, material), geometry, material, texture };
}

afterEach(() => {
  setLogSink(console);
});

describe('Disposer', () => {
  it('runs callbacks in reverse registration order (AC-63)', () => {
    const order: number[] = [];
    const disposer = new Disposer();
    disposer.add(() => order.push(1));
    disposer.add(() => order.push(2));
    disposer.add(() => order.push(3));
    disposer.dispose();
    expect(order).toEqual([3, 2, 1]);
  });

  it('isolates a throwing callback and finishes the run (AC-64, AC-65, AC-66)', () => {
    const { calls } = recorder();
    const order: string[] = [];
    const disposer = new Disposer();
    disposer.add(() => order.push('first'));
    disposer.add(() => {
      throw new Error('subscription already gone');
    });
    disposer.add(() => order.push('last'));

    expect(() => disposer.dispose()).not.toThrow();
    expect(order).toEqual(['last', 'first']);
    expect(disposer.disposed).toBe(true);
    expect(calls.filter((call) => call.level === 'error')).toHaveLength(1);
  });

  it('is a no-op the second time (AC-67)', () => {
    let runs = 0;
    const disposer = new Disposer();
    disposer.add(() => {
      runs++;
    });
    disposer.dispose();
    disposer.dispose();
    expect(runs).toBe(1);
  });

  it('runs a late add() immediately, with a warning (AC-68, AC-69)', () => {
    const { calls } = recorder();
    const disposer = new Disposer();
    disposer.dispose();

    let ran = false;
    disposer.add(() => {
      ran = true;
    });
    expect(ran).toBe(true);
    expect(calls.filter((call) => call.level === 'warn')).toHaveLength(1);
  });

  it('runs a late addObject3D() immediately, with a warning (AC-70, AC-71)', () => {
    const { calls } = recorder();
    const { mesh, geometry } = ownedMesh();
    const spy = vi.spyOn(geometry, 'dispose');
    const disposer = new Disposer();
    disposer.dispose();

    disposer.addObject3D(mesh);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(calls.filter((call) => call.level === 'warn')).toHaveLength(1);
  });

  it('releases a whole object tree through addObject3D()', () => {
    const { mesh, geometry, material } = ownedMesh();
    const geometrySpy = vi.spyOn(geometry, 'dispose');
    const materialSpy = vi.spyOn(material, 'dispose');
    const root = new THREE.Group();
    root.add(mesh);

    const disposer = new Disposer();
    disposer.addObject3D(root);
    expect(geometrySpy).not.toHaveBeenCalled();
    disposer.dispose();
    expect(geometrySpy).toHaveBeenCalledTimes(1);
    expect(materialSpy).toHaveBeenCalledTimes(1);
  });
});

describe('disposeObject3D', () => {
  it('disposes the geometries, materials and their textures (AC-72, AC-73, AC-74)', () => {
    const { mesh, geometry, material, texture } = ownedMesh();
    const geometrySpy = vi.spyOn(geometry, 'dispose');
    const materialSpy = vi.spyOn(material, 'dispose');
    const textureSpy = vi.spyOn(texture, 'dispose');
    const root = new THREE.Group();
    root.add(mesh);

    disposeObject3D(root);
    expect(geometrySpy).toHaveBeenCalledTimes(1);
    expect(materialSpy).toHaveBeenCalledTimes(1);
    expect(textureSpy).toHaveBeenCalledTimes(1);
  });

  it('handles a multi-material mesh and a nested tree', () => {
    const geometry = new THREE.BoxGeometry();
    const first = new THREE.MeshBasicMaterial();
    const second = new THREE.MeshBasicMaterial();
    const mesh = new THREE.Mesh(geometry, [first, second]);
    const child = new THREE.Group();
    child.add(mesh);
    const root = new THREE.Group();
    root.add(child);
    const spies = [first, second].map((material) => vi.spyOn(material, 'dispose'));

    disposeObject3D(root);
    for (const spy of spies) expect(spy).toHaveBeenCalledTimes(1);
  });

  it('skips everything tagged userData.shared, so the Assets cache survives (AC-75, AC-76, AC-77)', () => {
    // What `Assets.model()` hands back: a fresh root whose geometry, material
    // and texture belong to the cache.
    const sharedGeometry = new THREE.BoxGeometry();
    const sharedTexture = new THREE.Texture();
    const sharedMaterial = new THREE.MeshBasicMaterial({ map: sharedTexture });
    for (const resource of [sharedGeometry, sharedTexture, sharedMaterial]) {
      resource.userData['shared'] = true;
    }
    const clone = new THREE.Group();
    clone.add(new THREE.Mesh(sharedGeometry, sharedMaterial));

    // …and one thing the scene made itself, which must still go.
    const own = ownedMesh();
    clone.add(own.mesh);

    const spies = {
      geometry: vi.spyOn(sharedGeometry, 'dispose'),
      material: vi.spyOn(sharedMaterial, 'dispose'),
      texture: vi.spyOn(sharedTexture, 'dispose'),
      ownGeometry: vi.spyOn(own.geometry, 'dispose'),
      ownTexture: vi.spyOn(own.texture, 'dispose'),
    };

    disposeObject3D(clone);
    expect(spies.geometry).not.toHaveBeenCalled();
    expect(spies.material).not.toHaveBeenCalled();
    expect(spies.texture).not.toHaveBeenCalled();
    expect(spies.ownGeometry).toHaveBeenCalledTimes(1);
    expect(spies.ownTexture).toHaveBeenCalledTimes(1);
  });

  it('skips a shared texture hanging off a scene-owned material (AC-77)', () => {
    const shared = new THREE.Texture();
    shared.userData['shared'] = true;
    const material = new THREE.MeshBasicMaterial({ map: shared });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), material);
    const textureSpy = vi.spyOn(shared, 'dispose');
    const materialSpy = vi.spyOn(material, 'dispose');

    disposeObject3D(mesh);
    expect(textureSpy).not.toHaveBeenCalled();
    expect(materialSpy).toHaveBeenCalledTimes(1);
  });
});
