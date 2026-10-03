// SPEC-048 §4.8, §6.1 — the scavenger bodies: a scav-tinted salvager clone
// posed on the last frame of its `Death` clip, placed once and never updated,
// and the pure bearing search the echo body uses. The view runs against a fake
// asset port, as `characterView.test.ts` does; the committed model's budget —
// one mesh, one material, 2 616 triangles — is read off its GLB's JSON chunk.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { setLogSink, type LogSink } from '@/core/Log';
import { TUG_RADIUS } from '@/systems/Layout';
import {
  bearingToward,
  echoBodySpot,
  SCAV_BODY_RADIUS,
  SCAV_BODY_TINT,
  SCAV_ECHO_DISTANCE,
  SCAV_PAD_OFFSET,
  ScavBody,
} from '@/views/ScavBody';
import type { CharacterAssets } from '@/views/CharacterView';

/** A one-mesh model whose clips each scale the root from 1 to `end` over `duration`. */
function fake(clips: readonly { name: string; duration: number; end: number }[]): {
  assets: CharacterAssets;
  template: THREE.MeshStandardMaterial;
  mesh: THREE.SkinnedMesh;
  group: THREE.Group;
} {
  const template = new THREE.MeshStandardMaterial({ color: '#888888', emissive: '#223344', emissiveIntensity: 2 });
  const mesh = new THREE.SkinnedMesh(new THREE.BoxGeometry(1, 2, 1), template);
  const group = new THREE.Group();
  group.add(mesh);
  const animations = clips.map(
    ({ name, duration, end }) =>
      new THREE.AnimationClip(name, duration, [new THREE.VectorKeyframeTrack('.scale', [0, duration], [1, 1, 1, end, end, end])]),
  );
  return { assets: { model: () => group, animations: () => animations }, template, mesh, group };
}

const DEATH = { name: 'Death', duration: 1.25, end: 0.5 };
const FULL = [{ name: 'Idle', duration: 1, end: 3 }, { name: 'Run', duration: 0.8, end: 4 }, DEATH];

let restore: LogSink | null = null;
const warnings: unknown[][] = [];

function captureWarnings(): void {
  warnings.length = 0;
  restore = setLogSink({
    debug: () => undefined,
    info: () => undefined,
    warn: (...args: unknown[]) => {
      warnings.push(args);
    },
    error: () => undefined,
  });
}

afterEach(() => {
  if (restore !== null) setLogSink(restore);
  restore = null;
});

describe('ScavBody (§4.8)', () => {
  it('poses once at the Death clip’s duration — its last frame', () => {
    const parent = new THREE.Group();
    const { assets, group } = fake(FULL);
    const body = new ScavBody(parent, assets, 0, 0, 0, false);
    expect(body.posedAt).toBe(DEATH.duration);
    // The Death track's last key, not Idle's or Run's.
    expect(group.scale.x).toBeCloseTo(DEATH.end, 6);
    expect(group.scale.z).toBeCloseTo(DEATH.end, 6);
    expect(group.scale.y).toBeCloseTo(DEATH.end, 6);
    body.dispose();
  });

  it('tints every material clone #4f4a3d with the visor unlit, and leaves the template alone', () => {
    const parent = new THREE.Group();
    const { assets, template, mesh } = fake(FULL);
    const body = new ScavBody(parent, assets, 0, 0, 0, false);
    const clone = mesh.material as THREE.MeshStandardMaterial;
    expect(clone).not.toBe(template);
    expect(`#${clone.color.getHexString()}`).toBe(SCAV_BODY_TINT.primary);
    expect(clone.emissiveIntensity).toBe(0);
    expect(clone.emissive.getHex()).toBe(0);
    expect(template.color.getHexString()).toBe('888888');
    expect(template.emissiveIntensity).toBe(2);
    body.dispose();
  });

  it('stands at (x, y, z), turned π/2 − facing, under its parent', () => {
    const parent = new THREE.Group();
    const { assets } = fake(FULL);
    const body = new ScavBody(parent, assets, 3, -2, 0.75, false, 1.5);
    expect(body.root.parent).toBe(parent);
    expect(body.root.position.toArray()).toEqual([3, 1.5, -2]);
    expect(body.root.rotation.y).toBeCloseTo(Math.PI / 2 - 0.75, 6);
    body.dispose();
  });

  it('casts shadows only when asked, and follows a preset change', () => {
    const parent = new THREE.Group();
    const { assets, mesh } = fake(FULL);
    const body = new ScavBody(parent, assets, 0, 0, 0, true);
    expect(mesh.castShadow).toBe(true);
    body.setShadows(false);
    expect(mesh.castShadow).toBe(false);
    expect(mesh.receiveShadow).toBe(false);
    body.dispose();
  });

  it('a model without Death stays in its bind pose, with one warning', () => {
    captureWarnings();
    const parent = new THREE.Group();
    const { assets, group } = fake([{ name: 'Idle', duration: 1, end: 3 }]);
    const body = new ScavBody(parent, assets, 0, 0, 0, false);
    expect(body.posedAt).toBeNull();
    expect(group.scale.x).toBe(1);
    expect(warnings).toHaveLength(1);
    body.dispose();
  });

  it('dispose takes it out of the scene and frees its own materials', () => {
    const parent = new THREE.Group();
    const { assets, mesh } = fake(FULL);
    const body = new ScavBody(parent, assets, 0, 0, 0, false);
    const clone = mesh.material as THREE.MeshStandardMaterial;
    let disposed = false;
    clone.addEventListener('dispose', () => {
      disposed = true;
    });
    body.dispose();
    expect(body.root.parent).toBeNull();
    expect(parent.children).toHaveLength(0);
    expect(disposed).toBe(true);
  });

  it('is one draw call and 2 616 triangles: character.glb is one mesh, one primitive, one material, with a Death clip', () => {
    const glb = readFileSync(new URL('../../public/assets/models/character.glb', import.meta.url).pathname);
    // The GLB header, then the JSON chunk: its length at byte 12, its text from byte 20.
    const length = new DataView(glb.buffer, glb.byteOffset, glb.byteLength).getUint32(12, true);
    const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + length))) as {
      meshes: { primitives: { indices: number }[] }[];
      materials: unknown[];
      accessors: { count: number }[];
      animations: { name: string }[];
    };
    expect(json.meshes).toHaveLength(1);
    expect(json.meshes[0]?.primitives).toHaveLength(1);
    expect(json.materials).toHaveLength(1);
    const indices = json.accessors[json.meshes[0]?.primitives[0]?.indices ?? -1];
    expect((indices?.count ?? 0) / 3).toBe(2616);
    expect(json.animations.map((clip) => clip.name)).toContain('Death');
  });
});

describe('the placement constants (§3)', () => {
  it('pins the tint, the pad offset outside the tug, the echo distance and the clear circle', () => {
    expect(SCAV_BODY_TINT).toEqual({ primary: '#4f4a3d', secondary: '#000000' });
    expect(SCAV_PAD_OFFSET).toEqual({ x: -5, z: 2 });
    expect(Math.hypot(SCAV_PAD_OFFSET.x, SCAV_PAD_OFFSET.z)).toBeGreaterThan(TUG_RADIUS + SCAV_BODY_RADIUS);
    expect(SCAV_ECHO_DISTANCE).toBe(6);
    expect(SCAV_BODY_RADIUS).toBe(0.6);
  });
});

describe('echoBodySpot (§4.8)', () => {
  const YAW = Math.PI / 4;
  const at = (bearing: number): { x: number; z: number } => ({
    x: 10 + Math.sin(bearing) * SCAV_ECHO_DISTANCE,
    z: -4 + Math.cos(bearing) * SCAV_ECHO_DISTANCE,
  });

  it('takes the camera-side bearing when it is clear, 6 m out, facing the player', () => {
    const spot = echoBodySpot(10, -4, YAW, () => true);
    expect(spot.x).toBeCloseTo(at(YAW).x, 6);
    expect(spot.z).toBeCloseTo(at(YAW).z, 6);
    expect(Math.hypot(spot.x - 10, spot.z + 4)).toBeCloseTo(SCAV_ECHO_DISTANCE, 6);
    // Facing θ from +X toward +Z, pointing back at the player.
    expect(Math.cos(spot.facing)).toBeCloseTo((10 - spot.x) / SCAV_ECHO_DISTANCE, 6);
    expect(Math.sin(spot.facing)).toBeCloseTo((-4 - spot.z) / SCAV_ECHO_DISTANCE, 6);
  });

  it('takes the next clear bearing, 45° on, when the camera side is blocked', () => {
    const blocked = at(YAW);
    const tried: Array<{ x: number; z: number }> = [];
    const spot = echoBodySpot(10, -4, YAW, (x, z) => {
      tried.push({ x, z });
      return Math.hypot(x - blocked.x, z - blocked.z) > 1e-6;
    });
    expect(tried).toHaveLength(2);
    expect(spot.x).toBeCloseTo(at(YAW + Math.PI / 4).x, 6);
    expect(spot.z).toBeCloseTo(at(YAW + Math.PI / 4).z, 6);
  });

  it('tries all eight bearings, then lies toward the pad at 6 m when none is clear', () => {
    let tries = 0;
    const pad = { x: 10, z: 20 };
    const spot = echoBodySpot(10, -4, YAW, () => {
      tries++;
      return false;
    }, bearingToward(10, -4, pad.x, pad.z));
    expect(tries).toBe(8);
    expect(spot.x).toBeCloseTo(10, 6);
    expect(spot.z).toBeCloseTo(-4 + SCAV_ECHO_DISTANCE, 6);
  });

  it('bearingToward uses the same convention: sin along x, cos along z', () => {
    expect(bearingToward(0, 0, 0, 5)).toBeCloseTo(0, 6);
    expect(bearingToward(0, 0, 5, 0)).toBeCloseTo(Math.PI / 2, 6);
  });
});
