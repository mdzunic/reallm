// SPEC-020 §4.4 — the hub scenes' shared backdrop pieces, pinned in node. The
// scenes themselves are composition roots the suites may not import, so what is
// testable here is the shape every one of them composes: the key + rim pair,
// the window on R8's geometry, and the swap that replaces a procedural module
// with its model without changing what the group holds.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { addHubLights, hubSkyMesh, proceduralDock, proceduralRing, swapModule } from '@/views/HubBackdrop';
import { SKY_WINDOW } from '@/views/FlightView';

describe('the hub backdrop (SPEC-020 §4.4)', () => {
  it('lights the group with one key and one rim (AC-18)', () => {
    const group = new THREE.Group();
    addHubLights(group);
    const lights = group.children.filter((node) => node instanceof THREE.DirectionalLight) as THREE.DirectionalLight[];
    expect(lights).toHaveLength(2);
    const [key, rim] = lights as [THREE.DirectionalLight, THREE.DirectionalLight];
    expect(key.color.getHex()).toBe(new THREE.Color(0xdfe8ff).getHex());
    expect(key.intensity).toBeCloseTo(1.8);
    expect(key.position.toArray()).toEqual([2, 3, 2]);
    expect(rim.color.getHex()).toBe(new THREE.Color(0x4c9aff).getHex());
    expect(rim.intensity).toBeCloseTo(0.6);
    expect(rim.position.toArray()).toEqual([-3, 1.5, -4]);
  });

  it('hangs the station window on R8 geometry, behind everything (AC-19)', () => {
    const texture = new THREE.Texture();
    const mesh = hubSkyMesh(texture) as THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
    expect(mesh.geometry.parameters).toMatchObject(SKY_WINDOW);
    expect(mesh.material.map).toBe(texture);
    expect(mesh.material.side).toBe(THREE.BackSide);
    expect(mesh.material.fog).toBe(false);
    expect(mesh.material.depthWrite).toBe(false);
    expect(mesh.renderOrder).toBeLessThan(0);
    expect(mesh.frustumCulled).toBe(false);
  });

  it('builds the modules with emissive strips when the models are absent (AC-19)', () => {
    for (const module of [proceduralRing(), proceduralDock()]) {
      const material = module.material as THREE.MeshStandardMaterial;
      expect(material.emissive.getHex()).not.toBe(0x000000);
      expect(material.emissiveIntensity).toBeGreaterThan(0);
    }
    expect((proceduralRing().geometry as THREE.TorusGeometry).parameters.radius).toBeCloseTo(2.2);
  });

  it('swaps a module for its model in place, so `props` never moves (AC-17, 20-e)', () => {
    const group = new THREE.Group();
    const module = proceduralRing();
    module.position.set(0, -1.05, 0.5);
    module.rotation.x = Math.PI / 2.4;
    group.add(module);
    const model = new THREE.Group();
    const before = group.children.length;

    swapModule(group, module, model);

    expect(group.children).toHaveLength(before);
    expect(group.children).toContain(model);
    expect(group.children).not.toContain(module);
    expect(model.position.toArray()).toEqual([0, -1.05, 0.5]);
    expect(model.rotation.x).toBeCloseTo(Math.PI / 2.4);
  });
});
