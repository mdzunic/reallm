// SPEC-038 §4.2, §6.1 — the ground telegraph view: one instance per live
// telegraph of its kind, a kind with none is invisible, at most three draw
// calls and none while the pool is empty; standard-or-basic like the rest of
// the surface, and 0.05 m over the ground.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Pool } from '@/core/Pool';
import { makeTelegraph, resetTelegraph, type TelegraphEntity } from '@/entities/Telegraph';
import { HOSTILE_RIM, HOSTILE_RIM_COLOUR_BLIND, setHostileRim } from '@/views/ProceduralMeshes';
import type { PlanetId } from '@/data/ids';
import { PLANETS, type PlanetDef } from '@/data/planets';
import { ELITE_OUTLINE, TELEGRAPH_LIFT, TELEGRAPH_OVERRIDES, TelegraphView } from '@/views/TelegraphView';
import { DEFICIENCIES, deltaE76 } from '../fixtures/colourVision';

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

describe('telegraphs read on any ground (review 2026-10 V-02)', () => {
  function decalColours(view: TelegraphView, root: THREE.Group): { fill: number; outline: number; elite: number } {
    const pool = new Pool(makeTelegraph);
    add(pool, { kind: 'circle', x: 0, z: 0 });
    add(pool, { kind: 'circle', x: 6, z: 0, elite: true });
    view.sync(pool, 0.5, flat, false);
    const mesh = root.children.find((node) => node.name === 'telegraph-circle') as THREE.InstancedMesh;
    const outline = mesh.geometry.attributes['aOutline'] as THREE.InstancedBufferAttribute;
    const hex = (slot: number): number => new THREE.Color(outline.getX(slot), outline.getY(slot), outline.getZ(slot)).getHex();
    return { fill: (mesh.material as THREE.MeshBasicMaterial).color.getHex(), outline: hex(0), elite: hex(1) };
  }

  it('takes the planet’s override under its preset — Ferrum on standard, the Hive on colour-blind — and keeps elites gold', () => {
    const cases = [
      ['ferrum', 'standard', '#fff0b0'],
      ['ferrum', 'colour-blind', HOSTILE_RIM_COLOUR_BLIND],
      ['hive', 'standard', HOSTILE_RIM],
      ['hive', 'colour-blind', '#4fe3ff'],
      ['cinder4', 'standard', HOSTILE_RIM],
      ['cinder4', 'colour-blind', HOSTILE_RIM_COLOUR_BLIND],
    ] as const;
    try {
      for (const [planet, preset, expected] of cases) {
        setHostileRim(preset);
        const root = new THREE.Group();
        const view = new TelegraphView(root, undefined, planet);
        const colours = decalColours(view, root);
        const want = new THREE.Color(expected).getHex();
        expect(colours.fill, `${planet} ${preset} fill`).toBe(want);
        expect(colours.outline, `${planet} ${preset} outline`).toBe(want);
        expect(colours.elite, `${planet} ${preset} elite`).toBe(new THREE.Color(ELITE_OUTLINE).getHex());
        view.dispose();
      }
    } finally {
      setHostileRim('standard');
    }
  });

  it('each override stands off the ground glow it replaces the rim on, under every colour vision', () => {
    // Ferrum's cracks against the standard rim: ΔE 13 — the clash the review measured.
    expect(deltaE76(HOSTILE_RIM, PLANETS.ferrum.surface.look.ground.cracks?.color ?? '')).toBeLessThan(15);
    for (const [planet, presets] of Object.entries(TELEGRAPH_OVERRIDES)) {
      const def: PlanetDef = PLANETS[planet as PlanetId];
      const cracks = def.surface.look.ground.cracks?.color;
      expect(cracks, planet).toBeDefined();
      for (const colour of Object.values(presets)) {
        for (const type of [null, ...DEFICIENCIES]) {
          expect(deltaE76(colour, cracks as string, type), `${planet} ${colour} ${type ?? 'normal'}`).toBeGreaterThan(25);
        }
        // Still apart from an elite's gold outline.
        expect(deltaE76(colour, ELITE_OUTLINE), `${planet} ${colour} vs gold`).toBeGreaterThan(25);
      }
    }
  });

  it('draws the outline with a dark outer band and a pale inner edge, in the same one program per kind', () => {
    const root = new THREE.Group();
    const view = new TelegraphView(root);
    const pool = new Pool(makeTelegraph);
    add(pool, { kind: 'line', x: 0, z: 0 });
    view.sync(pool, 0.5, flat, false);
    const mesh = root.children.find((node) => node.name === 'telegraph-line') as THREE.InstancedMesh;
    const material = mesh.material as THREE.MeshBasicMaterial;
    const shader = {
      uniforms: {} as Record<string, unknown>,
      vertexShader: '#include <common>\n#include <begin_vertex>',
      fragmentShader: '#include <common>\nvec4 diffuseColor = vec4( diffuse, opacity );',
    };
    material.onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, undefined as unknown as THREE.WebGLRenderer);
    // The theme's #0b0f14 on the outer edge, the outline mixed toward white on the inner one.
    expect(shader.fragmentShader).toContain('shapeColor = vec3(0.0044, 0.0056, 0.0070)');
    expect(shader.fragmentShader).toContain('mix(vOutline, vec3(1.0)');
    expect(view.drawCalls).toBe(1);
    view.dispose();
  });
});
