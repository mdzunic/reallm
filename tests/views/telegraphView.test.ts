// SPEC-038 §4.2, §6.1 — the ground telegraph view: one instance per live
// telegraph of its kind, a kind with none is invisible, at most three draw
// calls and none while the pool is empty; standard-or-basic like the rest of
// the surface, and 0.05 m over the ground.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Pool } from '@/core/Pool';
import { makeTelegraph, resetTelegraph, type TelegraphEntity } from '@/entities/Telegraph';
import { HOSTILE_RIM, HOSTILE_RIM_COLOUR_BLIND, setHostileRim } from '@/views/ProceduralMeshes';
import { ELITE_OUTLINE, TELEGRAPH_LIFT, TelegraphView } from '@/views/TelegraphView';

const flat = (): number => 0;

function add(pool: Pool<TelegraphEntity>, patch: Partial<TelegraphEntity>): TelegraphEntity {
  const t = pool.alloc();
  resetTelegraph(t);
  Object.assign(t, { startAt: 0, hitAt: 1, lockAt: 1, radius: 2, length: 10, width: 2.8, ringMax: 6, ringSpeed: 8, band: 1 }, patch);
  return t;
}

describe('TelegraphView (SPEC-038 §4.2)', () => {
  it('draws nothing — and builds no mesh — while no telegraph is live', () => {
    const root = new THREE.Group();
    const view = new TelegraphView(root);
    const pool = new Pool(makeTelegraph);
    view.sync(pool, 0, flat, false);
    expect(view.drawCalls).toBe(0);
    expect(root.children).toHaveLength(0);
    view.dispose();
  });

  it('has one instance per live telegraph of its kind, and a kind with none is invisible', () => {
    const root = new THREE.Group();
    const view = new TelegraphView(root);
    const pool = new Pool(makeTelegraph);
    add(pool, { kind: 'line', x: 1, z: 2 });
    add(pool, { kind: 'line', x: -4, z: 0, elite: true });
    add(pool, { kind: 'circle', x: 5, z: 5 });
    view.sync(pool, 0.5, flat, false);
    expect(view.count('line')).toBe(2);
    expect(view.count('circle')).toBe(1);
    expect(view.count('ring')).toBe(0);
    expect(view.visible('line')).toBe(true);
    expect(view.visible('circle')).toBe(true);
    expect(view.visible('ring')).toBe(false);
    expect(view.drawCalls).toBe(2);

    // All three kinds at once: still three draws, never more.
    add(pool, { kind: 'ring', x: 0, z: 0 });
    view.sync(pool, 1.2, flat, true);
    expect(view.drawCalls).toBe(3);

    // The lines go: their mesh hides, the others stay.
    for (let i = pool.size - 1; i >= 0; i--) if (pool.at(i).kind === 'line') pool.free(i);
    view.sync(pool, 1.3, flat, false);
    expect(view.count('line')).toBe(0);
    expect(view.visible('line')).toBe(false);
    expect(view.drawCalls).toBe(2);
    pool.clear();
    view.sync(pool, 1.4, flat, false);
    expect(view.drawCalls).toBe(0);
    view.dispose();
    expect(root.children).toHaveLength(0);
  });

  it('is basic material, one mesh per kind, 0.05 m over the ground and under the bodies', () => {
    const root = new THREE.Group();
    const view = new TelegraphView(root);
    const pool = new Pool(makeTelegraph);
    add(pool, { kind: 'circle', x: 3, z: 0 });
    add(pool, { kind: 'line', x: 0, z: 0, dirX: 0, dirZ: 1 });
    add(pool, { kind: 'ring', x: 0, z: 0 });
    view.sync(pool, 0.5, () => 2, false);
    expect(root.children).toHaveLength(3);
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    for (const node of root.children) {
      const mesh = node as THREE.InstancedMesh;
      expect(mesh.isInstancedMesh).toBe(true);
      expect((mesh.material as THREE.Material).type).toBe('MeshBasicMaterial');
      expect((mesh.material as THREE.Material).depthWrite).toBe(false);
      mesh.getMatrixAt(0, matrix);
      position.setFromMatrixPosition(matrix);
      expect(position.y).toBeCloseTo(2 + TELEGRAPH_LIFT, 5);
    }
    view.dispose();
  });
});

describe('the decals follow the colour preset (SPEC-045 §4.5, AC-24)', () => {
  /** One instance's outline colour, as the shader receives it. */
  function outlineAt(mesh: THREE.InstancedMesh, slot: number): [number, number, number] {
    const outline = mesh.geometry.attributes['aOutline'] as THREE.InstancedBufferAttribute;
    return [outline.getX(slot), outline.getY(slot), outline.getZ(slot)];
  }

  function expectColour(actual: [number, number, number], hex: string): void {
    const expected = new THREE.Color(hex);
    expect(actual[0]).toBeCloseTo(expected.r, 6);
    expect(actual[1]).toBeCloseTo(expected.g, 6);
    expect(actual[2]).toBeCloseTo(expected.b, 6);
  }

  it('draws a non-elite decal in the rim of the moment, and keeps an elite outline gold', () => {
    const root = new THREE.Group();
    const view = new TelegraphView(root);
    const pool = new Pool(makeTelegraph);
    add(pool, { kind: 'circle', x: 0, z: 0 });
    add(pool, { kind: 'circle', x: 6, z: 0, elite: true });
    try {
      view.sync(pool, 0.5, flat, false);
      const mesh = root.children.find((node) => node.name === 'telegraph-circle') as THREE.InstancedMesh;
      const material = mesh.material as THREE.MeshBasicMaterial;
      expect(material.color.getHex()).toBe(new THREE.Color(HOSTILE_RIM).getHex());
      expectColour(outlineAt(mesh, 0), HOSTILE_RIM);
      expectColour(outlineAt(mesh, 1), ELITE_OUTLINE);

      // 45-n: the preset changes mid-fight; the next sync retints the live
      // decals — fill and plain outline — and leaves the elite's gold alone.
      const before = material.color;
      setHostileRim('colour-blind');
      view.sync(pool, 0.6, flat, false);
      expect(material.color).toBe(before); // copied into, never replaced
      expect(material.color.getHex()).toBe(0xff4fd8);
      expectColour(outlineAt(mesh, 0), HOSTILE_RIM_COLOUR_BLIND);
      expectColour(outlineAt(mesh, 1), ELITE_OUTLINE);

      // A kind first built under the preset starts in it.
      add(pool, { kind: 'line', x: 0, z: 4 });
      view.sync(pool, 0.7, flat, false);
      const line = root.children.find((node) => node.name === 'telegraph-line') as THREE.InstancedMesh;
      expect((line.material as THREE.MeshBasicMaterial).color.getHex()).toBe(0xff4fd8);
      expectColour(outlineAt(line, 0), HOSTILE_RIM_COLOUR_BLIND);

      // And back.
      setHostileRim('standard');
      view.sync(pool, 0.8, flat, false);
      expect(material.color.getHex()).toBe(new THREE.Color(HOSTILE_RIM).getHex());
      expectColour(outlineAt(mesh, 0), HOSTILE_RIM);
      expectColour(outlineAt(mesh, 1), ELITE_OUTLINE);
    } finally {
      // Module state: the next test starts on the standard preset.
      setHostileRim('standard');
      view.dispose();
    }
  });
});
