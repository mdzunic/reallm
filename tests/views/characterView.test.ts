// SPEC-019 §4.1 (AC-9 … AC-27) — the character view against a fake asset port:
// clip fallbacks and warnings, position/rotation, per-view material clones and
// the tint, the invulnerability blink, shadows, and disposal. The no-clip
// model (19-a) constructs without a mixer and never throws.
import { afterEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { setLogSink, type LogSink } from '@/core/Log';
import { makePlayer, type PlayerEntity } from '@/entities/Player';
import { CharacterView, tintSalvager, type CharacterAssets } from '@/views/CharacterView';

const APPEARANCE = { primary: '#b7472a', secondary: '#2a3b4c' };

function fake(clipNames: readonly string[]): {
  assets: CharacterAssets;
  template: THREE.MeshStandardMaterial;
  mesh: THREE.SkinnedMesh;
} {
  const template = new THREE.MeshStandardMaterial({ color: '#888888' });
  const mesh = new THREE.SkinnedMesh(new THREE.BoxGeometry(1, 2, 1), template);
  const group = new THREE.Group();
  group.add(mesh);
  const clips = clipNames.map(
    (name) => new THREE.AnimationClip(name, 1, [new THREE.VectorKeyframeTrack('.scale', [0, 1], [1, 1, 1, 1, 1, 1])]),
  );
  return { assets: { model: () => group, animations: () => clips }, template, mesh };
}

function player(patch: Partial<PlayerEntity> = {}): PlayerEntity {
  return Object.assign(makePlayer(0, 0, 100), patch);
}

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

describe('CharacterView clips (AC-10 … AC-12)', () => {
  it('an Idle-only model still runs, with exactly four warnings (AC-11)', () => {
    captureWarnings();
    const parent = new THREE.Group();
    const { assets } = fake(['Idle']);
    const view = new CharacterView(parent, assets, 'character', APPEARANCE, false);
    expect(warnings).toHaveLength(4); // run, attack, hit, death
    // Every state plays without throwing — the mixer exists on the idle clip.
    view.sync(player({ vx: 5 }), 0.1, 0.016, 0);
    view.sync(player({ fireCooldown: 0.4 }), 0.2, 0.016, 0);
    view.dispose();
  });

  it('a model with no clips at all skips the mixer, warns once, never throws (AC-12, 19-a)', () => {
    captureWarnings();
    const parent = new THREE.Group();
    const { assets, mesh } = fake([]);
    const view = new CharacterView(parent, assets, 'character', APPEARANCE, false);
    expect(warnings).toHaveLength(1);
    const scaleBefore = mesh.scale.clone();
    view.sync(player({ vx: 5, hp: 40 }), 1, 0.016, 0.5);
    expect(mesh.scale).toEqual(scaleBefore); // bind pose: nothing animates
    view.dispose();
  });

  it('a full clip set resolves without a warning (AC-10)', () => {
    captureWarnings();
    const parent = new THREE.Group();
    const { assets } = fake(['Idle', 'Run', 'Attack', 'Hit', 'Death']);
    const view = new CharacterView(parent, assets, 'character', APPEARANCE, false);
    expect(warnings).toHaveLength(0);
    view.dispose();
  });
});

describe('CharacterView sync (AC-17 … AC-19, AC-26)', () => {
  it('places the root at (x, y, z) and turns it by π/2 − facing', () => {
    const parent = new THREE.Group();
    const { assets } = fake(['Idle']);
    const view = new CharacterView(parent, assets, 'character', APPEARANCE, false);
    view.sync(player({ x: 3, z: -2, facing: 0.5 }), 0, 0.016, 1.2);
    expect(view.root.position.x).toBe(3);
    expect(view.root.position.y).toBe(1.2);
    expect(view.root.position.z).toBe(-2);
    expect(view.root.rotation.y).toBeCloseTo(Math.PI / 2 - 0.5, 6);
    view.dispose();
  });

  it('applies the constructor shadow flag to every mesh, and setShadows follows a preset change', () => {
    const parent = new THREE.Group();
    const { assets, mesh } = fake(['Idle']);
    const view = new CharacterView(parent, assets, 'character', APPEARANCE, true);
    view.sync(player(), 0, 0.016, 0);
    expect(mesh.castShadow).toBe(true);
    expect(mesh.receiveShadow).toBe(true);
    view.setShadows(false);
    expect(mesh.castShadow).toBe(false);
    expect(mesh.receiveShadow).toBe(false);
    view.dispose();
  });

  it('the invulnerability blink writes opacity on the clones (AC-26)', () => {
    const parent = new THREE.Group();
    const { assets, mesh } = fake(['Idle']);
    const view = new CharacterView(parent, assets, 'character', APPEARANCE, false);
    const clone = mesh.material as THREE.MeshStandardMaterial;
    expect(clone.transparent).toBe(true);
    // sin(0.05 · 30) > 0 — mid-blink.
    view.sync(player({ invulnUntil: 1 }), 0.05, 0.016, 0);
    expect(clone.opacity).toBeCloseTo(0.35, 6);
    // sin(0.15 · 30) < 0 — the visible half of the blink.
    view.sync(player({ invulnUntil: 1 }), 0.15, 0.016, 0);
    expect(clone.opacity).toBe(1);
    view.dispose();
  });
});

describe('CharacterView materials (AC-21 … AC-25, AC-27)', () => {
  it('clones per view and tints the clones; the template is untouched', () => {
    const parent = new THREE.Group();
    const { assets, template, mesh } = fake(['Idle']);
    const view = new CharacterView(parent, assets, 'character', APPEARANCE, false);
    const clone = mesh.material as THREE.MeshStandardMaterial;
    expect(clone).not.toBe(template);
    expect(template.color.getHexString()).toBe(new THREE.Color('#888888').getHexString());
    expect(template.emissiveIntensity).toBe(1);

    expect(clone.color.getHexString()).toBe(new THREE.Color(APPEARANCE.primary).getHexString());
    // Emissive: the secondary swatch rescaled so its largest channel is 1.
    const expected = new THREE.Color(APPEARANCE.secondary);
    const brightest = Math.max(expected.r, expected.g, expected.b);
    expected.multiplyScalar(1 / brightest);
    expect(clone.emissive.r).toBeCloseTo(expected.r, 5);
    expect(clone.emissive.g).toBeCloseTo(expected.g, 5);
    expect(clone.emissive.b).toBeCloseTo(expected.b, 5);
    expect(clone.emissiveIntensity).toBe(2);
    view.dispose();
  });

  it('dispose disposes the clones and removes the root (AC-27)', () => {
    const parent = new THREE.Group();
    const { assets, template, mesh } = fake(['Idle']);
    const view = new CharacterView(parent, assets, 'character', APPEARANCE, false);
    const clone = mesh.material as THREE.MeshStandardMaterial;
    let cloneDisposed = false;
    let templateDisposed = false;
    clone.addEventListener('dispose', () => {
      cloneDisposed = true;
    });
    template.addEventListener('dispose', () => {
      templateDisposed = true;
    });
    expect(parent.children).toContain(view.root);
    view.dispose();
    expect(parent.children).not.toContain(view.root);
    expect(cloneDisposed).toBe(true);
    expect(templateDisposed).toBe(false);
    view.dispose(); // idempotent
  });
});

describe('tintSalvager (AC-21 … AC-23)', () => {
  it('sets color = primary and a full-brightness emissive at intensity 2', () => {
    const material = new THREE.MeshStandardMaterial();
    tintSalvager(material, '#b7472a', '#2a3b4c');
    expect(material.color.getHexString()).toBe(new THREE.Color('#b7472a').getHexString());
    expect(Math.max(material.emissive.r, material.emissive.g, material.emissive.b)).toBeCloseTo(1, 6);
    expect(material.emissiveIntensity).toBe(2);
    // The hue survives the rescale: blue stays the dominant channel.
    expect(material.emissive.b).toBeGreaterThan(material.emissive.r);
  });

  it('a black secondary leaves the emissive black at intensity 0 (AC-23)', () => {
    const material = new THREE.MeshStandardMaterial();
    tintSalvager(material, '#ffffff', '#000000');
    expect(material.emissive.getHex()).toBe(0x000000);
    expect(material.emissiveIntensity).toBe(0);
  });
});
