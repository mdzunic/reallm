// SPEC-012 §4.9 (AC-52, AC-53) — the procedural enemy meshes, pinned in node.
// The scene graph is plain three.js objects, so what the GPU would draw is
// readable here: parts are InstancedMeshes shared per recipe, the per-instance
// animation moves matrices between frames, and tint / elite gold / hit-flash
// white all arrive through `instanceColor`. The browser run confirms it
// renders; this suite pins the mechanics the screenshots cannot.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Pool } from '@/core/Pool';
import { ENEMIES, PLANET_IDS, PLANETS, type EnemyDef } from '@/data/index';
import { makeEnemy, type EnemyEntity } from '@/entities/Enemy';
import {
  EnemyMeshes,
  FLASH_RIM_SCALE,
  HOSTILE_RIM,
  HOSTILE_RIM_COLOUR_BLIND,
  HOSTILE_RIM_UNIFORM,
  INSTANCES_PER_PART,
  RIM_INTENSITY,
  RIM_POWER,
  setHostileRim,
} from '@/views/ProceduralMeshes';
import { nodeCrystalScale } from '@/views/SurfaceView';
import { DEFICIENCIES, deltaE76 } from '../fixtures/colourVision';

function spawn(pool: Pool<EnemyEntity>, id: keyof typeof ENEMIES, patch: Partial<EnemyEntity> = {}): EnemyEntity {
  const e = pool.alloc();
  e.def = ENEMIES[id];
  e.id = pool.size;
  e.state = 'chase';
  e.elite = false;
  e.hitFlash = 0;
  e.invulnerable = false;
  e.facing = 0;
  e.x = 5;
  e.z = -3;
  Object.assign(e, patch);
  return e;
}

function instancedMeshes(parent: THREE.Object3D): THREE.InstancedMesh[] {
  const meshes: THREE.InstancedMesh[] = [];
  parent.traverse((obj) => {
    if (obj instanceof THREE.InstancedMesh) meshes.push(obj);
  });
  return meshes;
}

function visibleMatrixSnapshot(parent: THREE.Object3D): Float32Array {
  const parts = instancedMeshes(parent).filter((m) => m.visible);
  const total = parts.reduce((n, m) => n + m.count * 16, 0);
  const out = new Float32Array(total);
  let at = 0;
  for (const mesh of parts) {
    out.set((mesh.instanceMatrix.array as Float32Array).subarray(0, mesh.count * 16), at);
    at += mesh.count * 16;
  }
  return out;
}

describe('EnemyMeshes (AC-52)', () => {
  it('instances parts per recipe: two same-recipe enemies share meshes, counts follow the pool', () => {
    const parent = new THREE.Group();
    const meshes = new EnemyMeshes(parent);
    const pool = new Pool(makeEnemy);
    spawn(pool, 'dust_skitter');
    spawn(pool, 'dust_skitter', { x: -4, z: 8 });
    meshes.sync(pool, 0);

    const parts = instancedMeshes(parent).filter((m) => m.visible);
    expect(parts.length).toBeGreaterThan(0);
    for (const part of parts) {
      expect(part.count).toBe(2); // both skitters share every part mesh
      expect(part.instanceMatrix.count).toBe(INSTANCES_PER_PART);
    }
    expect(meshes.activeParts).toBe(parts.length);

    // A dead enemy leaves the draw; the mesh set does not grow.
    pool.at(1).state = 'dead';
    meshes.sync(pool, 0);
    for (const part of instancedMeshes(parent).filter((m) => m.visible)) expect(part.count).toBe(1);
    meshes.dispose();
  });

  it('a second recipe adds its own part meshes, not more per-enemy objects', () => {
    const parent = new THREE.Group();
    const meshes = new EnemyMeshes(parent);
    const pool = new Pool(makeEnemy);
    spawn(pool, 'dust_skitter');
    meshes.sync(pool, 0);
    const before = instancedMeshes(parent).length;
    spawn(pool, 'scav_raider');
    spawn(pool, 'scav_raider', { x: 1, z: 1 });
    meshes.sync(pool, 0);
    const after = instancedMeshes(parent);
    expect(after.length).toBeGreaterThan(before);
    // Adding a third raider reuses the same meshes — no growth.
    spawn(pool, 'scav_raider', { x: 2, z: 2 });
    meshes.sync(pool, 0);
    expect(instancedMeshes(parent).length).toBe(after.length);
    meshes.dispose();
  });
});

describe('EnemyMeshes animation (AC-53)', () => {
  it('moves the matrices of a moving enemy between frames, and holds a dead-still one', () => {
    const parent = new THREE.Group();
    const meshes = new EnemyMeshes(parent);
    const pool = new Pool(makeEnemy);
    spawn(pool, 'dust_skitter'); // swarm: hops while moving
    meshes.sync(pool, 0);
    const t0 = visibleMatrixSnapshot(parent);
    meshes.sync(pool, 0.25);
    const t1 = visibleMatrixSnapshot(parent);
    expect(t1.length).toBe(t0.length);
    expect(Array.from(t1)).not.toEqual(Array.from(t0));

    // An idle skitter stops hopping: time alone no longer moves it.
    pool.at(0).state = 'idle';
    meshes.sync(pool, 0.5);
    const idleA = visibleMatrixSnapshot(parent);
    meshes.sync(pool, 0.75);
    const idleB = visibleMatrixSnapshot(parent);
    expect(Array.from(idleB)).toEqual(Array.from(idleA));
    meshes.dispose();
  });

  it('tint, elite gold and hit-flash white all land in instanceColor', () => {
    const parent = new THREE.Group();
    const meshes = new EnemyMeshes(parent);
    const pool = new Pool(makeEnemy);
    const plain = spawn(pool, 'dust_skitter');
    const elite = spawn(pool, 'dust_skitter', { x: 9, elite: true });
    meshes.sync(pool, 0);
    const part = instancedMeshes(parent).find((m) => m.visible) as THREE.InstancedMesh;
    expect(part.instanceColor).not.toBeNull();
    const colors = part.instanceColor as THREE.InstancedBufferAttribute;
    const tint = new THREE.Color(ENEMIES.dust_skitter.look.tint);
    const at = (slot: number): [number, number, number] => [
      colors.getX(slot),
      colors.getY(slot),
      colors.getZ(slot),
    ];
    // Slot 0 wears the plain tint; the elite slot is pulled toward gold.
    expect(at(0)[0]).toBeCloseTo(tint.r, 3);
    expect(at(0)[1]).toBeCloseTo(tint.g, 3);
    expect(at(1)).not.toEqual(at(0));

    // A hit flashes the instance white — and only that instance.
    plain.hitFlash = 0.1;
    meshes.sync(pool, 0);
    expect(at(0)[0]).toBeGreaterThan(0.9);
    expect(at(0)[1]).toBeGreaterThan(0.9);
    expect(at(0)[2]).toBeGreaterThan(0.9);
    expect(at(1)[0]).toBeLessThan(0.9);
    expect(elite.hitFlash).toBe(0);
    meshes.dispose();
  });
});

describe('nodeCrystalScale (AC-24)', () => {
  it('maps fill monotonically into the crystal height', () => {
    const a = { x: 0, y: 0, z: 0 };
    const b = { x: 0, y: 0, z: 0 };
    nodeCrystalScale(0, a);
    nodeCrystalScale(1, b);
    expect(a.y).toBeCloseTo(0.25, 5);
    expect(b.y).toBeCloseTo(1.35, 5);
    let last = -Infinity;
    for (let fill = 0; fill <= 1.001; fill += 0.1) {
      nodeCrystalScale(fill, a);
      expect(a.y).toBeGreaterThan(last);
      last = a.y;
    }
  });
});

// ---------------------------------------------------------------- SPEC-017 §6

/** Every distinct material under `parent`, in traversal order. */
function materials(parent: THREE.Object3D): THREE.MeshStandardMaterial[] {
  const seen = new Set<THREE.MeshStandardMaterial>();
  for (const mesh of instancedMeshes(parent)) seen.add(mesh.material as THREE.MeshStandardMaterial);
  return [...seen];
}

describe('enemy materials (SPEC-017 §4.7, AC-88 … AC-91)', () => {
  it('a definition that glows gets standard parts wearing its emissive', () => {
    const parent = new THREE.Group();
    const meshes = new EnemyMeshes(parent);
    const pool = new Pool(makeEnemy);
    spawn(pool, 'dune_wurm');
    meshes.sync(pool, 0);
    const body = materials(parent).find((m) => m.emissiveIntensity === 0.35);
    expect(body).toBeDefined();
    expect(body?.type).toBe('MeshStandardMaterial');
    expect(body?.emissive.getHex()).toBe(new THREE.Color(ENEMIES.dune_wurm.look.emissive).getHex());
    expect(ENEMIES.dune_wurm.look.emissive).toBeDefined();
    meshes.dispose();
  });

  it('a definition with no emissive gets black, and never borrows another one', () => {
    const parent = new THREE.Group();
    const meshes = new EnemyMeshes(parent);
    const pool = new Pool(makeEnemy);
    spawn(pool, 'dust_skitter');
    meshes.sync(pool, 0);
    expect((ENEMIES.dust_skitter as EnemyDef).look.emissive).toBeUndefined();
    for (const material of materials(parent)) expect(material.emissive.getHex()).toBe(0x000000);
    meshes.dispose();
  });

  it('two definitions sharing a recipe but not an emissive get their own meshes (17-m)', () => {
    const parent = new THREE.Group();
    const meshes = new EnemyMeshes(parent);
    const pool = new Pool(makeEnemy);
    // `dust_skitter` and `hive_interceptor` are both the `bug` recipe; only
    // the second one glows, so they may not share a material.
    expect(ENEMIES.dust_skitter.look.recipe).toBe(ENEMIES.hive_interceptor.look.recipe);
    spawn(pool, 'dust_skitter');
    spawn(pool, 'hive_interceptor', { x: 9 });
    meshes.sync(pool, 0);
    const emissives = materials(parent).map((m) => m.emissive.getHex());
    expect(new Set(emissives).size).toBe(2);
    // Two variants of a three-part recipe: the parts are paid for twice.
    expect(instancedMeshes(parent).filter((m) => m.visible)).toHaveLength(6);
    expect(meshes.activeParts).toBe(6);
    meshes.dispose();
  });

  it('a recipe part with its own emissive keeps its own material, at full strength', () => {
    const parent = new THREE.Group();
    const meshes = new EnemyMeshes(parent);
    const pool = new Pool(makeEnemy);
    spawn(pool, 'magma_wraith'); // the `wraith` recipe: body + an emissive core
    meshes.sync(pool, 0);
    const core = materials(parent).find((m) => m.emissiveIntensity === 2);
    expect(core).toBeDefined();
    expect(core?.emissive.getHex()).toBe(new THREE.Color('#9ff2ff').getHex());
    // The body still wears the definition's own glow, not the core's.
    const body = materials(parent).find((m) => m.emissiveIntensity === 0.35);
    expect(body?.emissive.getHex()).toBe(new THREE.Color(ENEMIES.magma_wraith.look.emissive).getHex());
    meshes.dispose();
  });

  it('casts and receives only when it was built with shadows, and follows a preset change', () => {
    const parent = new THREE.Group();
    const meshes = new EnemyMeshes(parent);
    const pool = new Pool(makeEnemy);
    spawn(pool, 'dust_skitter');
    meshes.sync(pool, 0);
    expect(instancedMeshes(parent).some((m) => m.castShadow)).toBe(false);

    meshes.setShadows(true);
    expect(instancedMeshes(parent).every((m) => m.castShadow && m.receiveShadow)).toBe(true);
    // A recipe built after the switch inherits it.
    spawn(pool, 'magma_wraith', { x: 9 });
    meshes.sync(pool, 0);
    expect(instancedMeshes(parent).every((m) => m.castShadow && m.receiveShadow)).toBe(true);

    // And one built with the option on starts there.
    const own = new THREE.Group();
    const built = new EnemyMeshes(own, { shadows: true });
    built.sync(pool, 0);
    expect(instancedMeshes(own).every((m) => m.castShadow && m.receiveShadow)).toBe(true);
    built.dispose();
    meshes.dispose();
  });
});

// --------------------------------------------------------------- SPEC-019 §4.3

/** The first visible part's instanceEmissive triple for a pool slot. */
function emissiveAt(parent: THREE.Object3D, slot: number): [number, number, number] {
  const part = instancedMeshes(parent).find((m) => m.visible) as THREE.InstancedMesh;
  const attribute = part.geometry.attributes.instanceEmissive as THREE.InstancedBufferAttribute;
  return [attribute.getX(slot), attribute.getY(slot), attribute.getZ(slot)];
}

describe('per-instance emissive (SPEC-019 AC-45 … AC-50)', () => {
  it('a glowing definition writes its look.emissive per instance', () => {
    const parent = new THREE.Group();
    const meshes = new EnemyMeshes(parent);
    const pool = new Pool(makeEnemy);
    spawn(pool, 'dune_wurm');
    meshes.sync(pool, 0);
    const expected = new THREE.Color(ENEMIES.dune_wurm.look.emissive);
    const [r, g, b] = emissiveAt(parent, 0);
    expect(r).toBeCloseTo(expected.r, 5);
    expect(g).toBeCloseTo(expected.g, 5);
    expect(b).toBeCloseTo(expected.b, 5);
    meshes.dispose();
  });

  it('a plain definition rests at tint × 0.15, and the elite adds gold × 0.3', () => {
    const parent = new THREE.Group();
    const meshes = new EnemyMeshes(parent);
    const pool = new Pool(makeEnemy);
    spawn(pool, 'dust_skitter');
    spawn(pool, 'dust_skitter', { x: 9, elite: true });
    meshes.sync(pool, 0);
    const tint = new THREE.Color(ENEMIES.dust_skitter.look.tint);
    const plain = emissiveAt(parent, 0);
    expect(plain[0]).toBeCloseTo(tint.r * 0.15, 5);
    expect(plain[1]).toBeCloseTo(tint.g * 0.15, 5);
    expect(plain[2]).toBeCloseTo(tint.b * 0.15, 5);
    const elite = emissiveAt(parent, 1);
    expect(elite[0]).toBeCloseTo(tint.r * 0.15 + 0.9 * 0.3, 5);
    expect(elite[1]).toBeCloseTo(tint.g * 0.15 + 0.7 * 0.3, 5);
    expect(elite[2]).toBeCloseTo(tint.b * 0.15 + 0.3 * 0.3, 5);
    meshes.dispose();
  });

  it('the hit flash writes white × 2.5 and wins over elite gold (19-c)', () => {
    const parent = new THREE.Group();
    const meshes = new EnemyMeshes(parent);
    const pool = new Pool(makeEnemy);
    const elite = spawn(pool, 'dust_skitter', { elite: true });
    elite.hitFlash = 0.1;
    meshes.sync(pool, 0);
    expect(emissiveAt(parent, 0)).toEqual([2.5, 2.5, 2.5]);
    // The flash passes: gold returns.
    elite.hitFlash = 0;
    meshes.sync(pool, 0.2);
    expect(emissiveAt(parent, 0)[0]).toBeLessThan(1);
    meshes.dispose();
  });

  it('invulnerable halves the emissive, whatever produced it', () => {
    const parent = new THREE.Group();
    const meshes = new EnemyMeshes(parent);
    const pool = new Pool(makeEnemy);
    const e = spawn(pool, 'dune_wurm');
    meshes.sync(pool, 0);
    const [glowing] = emissiveAt(parent, 0);
    e.invulnerable = true;
    meshes.sync(pool, 0.1);
    const [halved] = emissiveAt(parent, 0);
    expect(halved).toBeCloseTo(glowing / 2, 5);
    // The flash is halved too — the rule applies after every branch.
    e.hitFlash = 0.1;
    meshes.sync(pool, 0.2);
    expect(emissiveAt(parent, 0)).toEqual([1.25, 1.25, 1.25]);
    meshes.dispose();
  });
});

// --------------------------------------------------------------- SPEC-035 §4.1

/** The first visible part's rim scale (`instanceEmissive.w`) for a pool slot. */
function rimScaleAt(parent: THREE.Object3D, slot: number): number {
  const part = instancedMeshes(parent).find((m) => m.visible) as THREE.InstancedMesh;
  const attribute = part.geometry.attributes.instanceEmissive as THREE.InstancedBufferAttribute;
  return attribute.getW(slot);
}

/** Runs a material's `onBeforeCompile` over the chunk names it patches. */
function compiled(material: THREE.MeshStandardMaterial): {
  vertex: string;
  fragment: string;
  uniforms: Record<string, THREE.IUniform>;
} {
  const shader = {
    vertexShader: '#include <common>\n#include <begin_vertex>\n',
    fragmentShader: '#include <common>\n#include <emissivemap_fragment>\n',
    uniforms: {},
  } as unknown as Parameters<NonNullable<THREE.MeshStandardMaterial['onBeforeCompile']>>[0];
  material.onBeforeCompile(shader, null as never);
  return { vertex: shader.vertexShader, fragment: shader.fragmentShader, uniforms: shader.uniforms };
}

describe('the hostile rim (SPEC-035 §4.1)', () => {
  it('pins the tuning the spec names', () => {
    expect(HOSTILE_RIM).toBe('#ff5a3c');
    expect(RIM_INTENSITY).toBe(0.9);
    expect(RIM_POWER).toBe(3);
    expect(FLASH_RIM_SCALE).toBe(0.4);
  });

  it('adds a fresnel rim after the per-instance emissive, on every enemy material', () => {
    const parent = new THREE.Group();
    const meshes = new EnemyMeshes(parent);
    const pool = new Pool(makeEnemy);
    // A plain recipe and a glowing one, whose parts build their own materials.
    spawn(pool, 'dust_skitter');
    spawn(pool, 'magma_wraith', { x: 20 });
    meshes.sync(pool, 0);
    const all = instancedMeshes(parent);
    expect(all.length).toBeGreaterThan(1);
    for (const mesh of all) {
      const { vertex, fragment } = compiled(mesh.material as THREE.MeshStandardMaterial);
      expect(vertex).toContain('attribute vec4 instanceEmissive;');
      // The emissive lands first, then the rim — the order §4.1 gives.
      const emissiveAtIndex = fragment.indexOf('totalEmissiveRadiance += vInstanceEmissive.rgb;');
      const rimAtIndex = fragment.indexOf('hostileRim');
      expect(emissiveAtIndex).toBeGreaterThan(0);
      expect(rimAtIndex).toBeGreaterThan(emissiveAtIndex);
      expect(fragment).toContain(`pow( 1.0 - saturate( dot( normal, normalize( vViewPosition ) ) ), ${RIM_POWER.toFixed(6)} )`);
      // SPEC-045 §4.10: the colour is a uniform now, not a baked literal.
      expect(fragment).toContain('uniform vec3 uHostileRim;');
      expect(fragment).toContain(`${RIM_INTENSITY.toFixed(6)} * hostileRim * vInstanceEmissive.w`);
    }
    meshes.dispose();
  });

  it('dims the rim while an instance flashes, so the flash still wins', () => {
    const parent = new THREE.Group();
    const meshes = new EnemyMeshes(parent);
    const pool = new Pool(makeEnemy);
    const e = spawn(pool, 'dust_skitter');
    meshes.sync(pool, 0);
    expect(rimScaleAt(parent, 0)).toBe(1);
    e.hitFlash = 0.1;
    meshes.sync(pool, 0.1);
    expect(rimScaleAt(parent, 0)).toBeCloseTo(FLASH_RIM_SCALE, 6);
    // …and the elite keeps its gold with the rim at full strength on top.
    e.hitFlash = 0;
    e.elite = true;
    meshes.sync(pool, 0.2);
    expect(rimScaleAt(parent, 0)).toBe(1);
    meshes.dispose();
  });
});

// --------------------------------------------------------------- SPEC-045 §4.5

describe('the colour-blind rim (SPEC-045 §4.5, AC-24, AC-25)', () => {
  it('is magenta, and every enemy material reads the one shared uniform', () => {
    expect(HOSTILE_RIM_COLOUR_BLIND).toBe('#ff4fd8');
    const parent = new THREE.Group();
    const meshes = new EnemyMeshes(parent);
    const pool = new Pool(makeEnemy);
    // A plain recipe, a glowing definition and a recipe whose emissive core
    // builds a part material of its own: every one of them shares the object.
    spawn(pool, 'dust_skitter');
    spawn(pool, 'hive_interceptor', { x: 10 });
    spawn(pool, 'magma_wraith', { x: 20 });
    meshes.sync(pool, 0);
    const all = materials(parent);
    expect(all.length).toBeGreaterThan(2);
    for (const material of all) {
      expect(compiled(material).uniforms['uHostileRim']).toBe(HOSTILE_RIM_UNIFORM);
      // …and the same object again on a second compile, never a copy.
      expect(compiled(material).uniforms['uHostileRim']).toBe(HOSTILE_RIM_UNIFORM);
    }
    meshes.dispose();
  });

  it('setHostileRim writes the working-space colour in place, and back', () => {
    const value = HOSTILE_RIM_UNIFORM.value;
    try {
      // The standard preset is the module's starting state: the literal's
      // colour, converted from sRGB exactly as `new THREE.Color` converts it.
      expect(value.equals(new THREE.Color(HOSTILE_RIM))).toBe(true);
      setHostileRim('colour-blind');
      expect(HOSTILE_RIM_UNIFORM.value).toBe(value); // the same Color, written into
      expect(value.equals(new THREE.Color(HOSTILE_RIM_COLOUR_BLIND))).toBe(true);
      expect(value.getHex()).toBe(0xff4fd8);
      setHostileRim('standard');
      expect(HOSTILE_RIM_UNIFORM.value).toBe(value);
      expect(value.equals(new THREE.Color(HOSTILE_RIM))).toBe(true);
      expect(value.getHex()).toBe(0xff5a3c);
    } finally {
      // Module state: whatever happened above, the next test starts standard.
      setHostileRim('standard');
    }
  });

  it('changes no program: the source and the cache key are the same under both presets (45-n)', () => {
    const parent = new THREE.Group();
    const meshes = new EnemyMeshes(parent);
    const pool = new Pool(makeEnemy);
    spawn(pool, 'dust_skitter');
    meshes.sync(pool, 0);
    const material = materials(parent)[0] as THREE.MeshStandardMaterial;
    try {
      const standard = compiled(material);
      setHostileRim('colour-blind');
      const blind = compiled(material);
      expect(blind.vertex).toBe(standard.vertex);
      expect(blind.fragment).toBe(standard.fragment);
      expect(material.customProgramCacheKey()).toBe('enemy/3');
    } finally {
      setHostileRim('standard');
      meshes.dispose();
    }
  });

  it("stays at least 20 ΔE76 from every planet's ground under each simulation", () => {
    expect(PLANET_IDS.length).toBe(6);
    for (const type of DEFICIENCIES) {
      for (const id of PLANET_IDS) {
        const ground = PLANETS[id].surface.palette.ground;
        expect(deltaE76(HOSTILE_RIM_COLOUR_BLIND, ground, type), `${type} vs ${id} (${ground})`).toBeGreaterThanOrEqual(20);
      }
    }
  });
});
