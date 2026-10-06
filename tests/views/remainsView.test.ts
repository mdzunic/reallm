// SPEC-057 §4.6 — the remains' view: built lazily, the crate pack merged to
// one draw, the body tinted and frozen on the last frame of `Death`, a 6 m
// pillar in the secondary colour that never pulses, and the budget — at most
// 3 draws and 2 700 triangles. It runs against a fake asset port, as
// `scavBody.test.ts` does; the committed models' budgets are read off their
// GLBs' JSON chunks.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { setLogSink, type LogSink } from '@/core/Log';
import { REMAINS_PILLAR_HEIGHT, REMAINS_PILLAR_OPACITY, RemainsView, type RemainsAssets, type RemainsModel } from '@/views/RemainsView';

const DEATH = { name: 'Death', duration: 1.25, end: 0.5 };

/** A crate of two boxes (two primitives, like crate.glb's) and a one-mesh character with `clips`. */
function fake(options: { clips?: readonly { name: string; duration: number; end: number }[]; character?: boolean; crate?: boolean } = {}): {
  assets: RemainsAssets;
  template: THREE.MeshStandardMaterial;
  body: THREE.Group;
} {
  const template = new THREE.MeshStandardMaterial({ color: '#888888', emissive: '#223344', emissiveIntensity: 2 });
  const body = new THREE.Group();
  body.add(new THREE.SkinnedMesh(new THREE.BoxGeometry(1, 2, 1), template));
  const crate = new THREE.Group();
  crate.add(new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.6, 0.6), new THREE.MeshStandardMaterial({ color: '#8a6a45' })));
  crate.add(new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.3), new THREE.MeshStandardMaterial({ color: '#ffcc00' })));
  const animations = (options.clips ?? [{ name: 'Idle', duration: 1, end: 3 }, DEATH]).map(
    ({ name, duration, end }) =>
      new THREE.AnimationClip(name, duration, [new THREE.VectorKeyframeTrack('.scale', [0, duration], [1, 1, 1, end, end, end])]),
  );
  const assets: RemainsAssets = {
    model: (id) => (id === 'crate' ? crate.clone(true) : body),
    animations: (id) => (id === 'character' ? animations : []),
    hasModel: (id) => (id === 'crate' ? options.crate !== false : id === 'character' ? options.character !== false : false),
  };
  return { assets, template, body };
}

const PACK: RemainsModel = { x: 4, z: -3, look: 'pack', primary: '#b7472a', secondary: '#2a8b4c' };
const BODY: RemainsModel = { ...PACK, look: 'body' };

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

function meshes(root: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  root.traverse((node) => {
    if ((node as THREE.Mesh).isMesh === true) out.push(node as THREE.Mesh);
  });
  return out;
}

describe('RemainsView (SPEC-057 §4.6)', () => {
  it('builds nothing until the first set that shows something', () => {
    const parent = new THREE.Group();
    const view = new RemainsView(parent, fake().assets, () => 0, false);
    expect(view.root.parent).toBe(parent);
    expect(view.root.children).toHaveLength(0);
    view.set(null);
    expect(view.root.children).toHaveLength(0);
    expect(view.shown).toBe(false);
    expect(view.draws).toBe(0);
    view.dispose();
  });

  it('the pack is the crate merged to one draw, on the ground at (x, height, z), under a 6 m pillar in the secondary colour', () => {
    const parent = new THREE.Group();
    const view = new RemainsView(parent, fake().assets, (x, z) => x + z, false);
    view.set(PACK);
    expect(view.shown).toBe(true);
    expect(view.look).toBe('pack');
    expect(view.posedAt).toBeNull();
    expect(view.root.position.toArray()).toEqual([4, 1, -3]);
    const pack = view.root.getObjectByName('remains_pack') as THREE.Mesh;
    const pillar = view.root.getObjectByName('remains_pillar') as THREE.Mesh<THREE.CylinderGeometry, THREE.MeshBasicMaterial>;
    expect(pack).toBeDefined();
    // Resting on the ground: its lowest point at the root's y.
    pack.geometry.computeBoundingBox();
    expect(pack.geometry.boundingBox?.min.y).toBeCloseTo(0, 6);
    expect(pillar.geometry.parameters.height).toBe(REMAINS_PILLAR_HEIGHT);
    expect(REMAINS_PILLAR_HEIGHT).toBe(6);
    expect(`#${pillar.material.color.getHexString()}`).toBe(PACK.secondary);
    expect(pillar.material.opacity).toBe(REMAINS_PILLAR_OPACITY);
    expect(REMAINS_PILLAR_OPACITY).toBe(0.5);
    expect(pillar.material.blending).toBe(THREE.AdditiveBlending);
    // One object draw and one pillar draw; the shadow adds one on high.
    expect(meshes(view.root)).toHaveLength(2);
    expect(view.draws).toBe(2);
    view.setShadows(true);
    expect(view.draws).toBe(3);
    expect(pack.castShadow).toBe(true);
    expect(pillar.castShadow).toBe(false);
    // Two boxes' worth of crate (12 + 2) and the pillar's 24.
    expect(view.triangles).toBe(14 + 24);
    view.dispose();
  });

  it('the body is the character tinted with the save’s colours, frozen on Death’s last frame, the template untouched', () => {
    const parent = new THREE.Group();
    const { assets, template, body } = fake();
    const view = new RemainsView(parent, assets, () => 0, true);
    view.set(BODY);
    expect(view.look).toBe('body');
    expect(view.posedAt).toBe(DEATH.duration);
    expect(body.scale.x).toBeCloseTo(DEATH.end, 6);
    const mesh = meshes(body)[0] as THREE.Mesh;
    const clone = mesh.material as THREE.MeshStandardMaterial;
    expect(clone).not.toBe(template);
    expect(`#${clone.color.getHexString()}`).toBe(BODY.primary);
    expect(clone.emissiveIntensity).toBe(2);
    expect(template.color.getHexString()).toBe('888888');
    // 1 body + 1 pillar + its shadow: 3 draws at most.
    expect(view.draws).toBe(3);
    expect(view.draws).toBeLessThanOrEqual(3);
    view.dispose();
  });

  it('a character without Death leaves the bind pose, with a warning (SPEC-019 19-a)', () => {
    captureWarnings();
    const parent = new THREE.Group();
    const { assets, body } = fake({ clips: [{ name: 'Idle', duration: 1, end: 3 }] });
    const view = new RemainsView(parent, assets, () => 0, false);
    view.set(BODY);
    expect(view.posedAt).toBeNull();
    expect(body.scale.x).toBe(1);
    expect(warnings).toHaveLength(1);
    view.dispose();
  });

  it('with no character model the pack stands in; with no crate a 0.6 m box does', () => {
    captureWarnings();
    const noBody = new RemainsView(new THREE.Group(), fake({ character: false }).assets, () => 0, false);
    noBody.set(BODY);
    expect(noBody.root.getObjectByName('remains_pack')).toBeDefined();
    noBody.dispose();
    const noCrate = new RemainsView(new THREE.Group(), fake({ crate: false }).assets, () => 0, false);
    noCrate.set(PACK);
    expect(noCrate.triangles).toBe(12 + 24);
    noCrate.dispose();
    const noAssets = new RemainsView(new THREE.Group(), undefined, () => 0, false);
    noAssets.set(PACK);
    expect(noAssets.shown).toBe(true);
    noAssets.dispose();
  });

  it('null hides it without disposing; a new point moves it; a new look rebuilds it', () => {
    const view = new RemainsView(new THREE.Group(), fake().assets, () => 0, false);
    view.set(PACK);
    const pack = view.root.getObjectByName('remains_pack');
    view.set(null);
    expect(view.shown).toBe(false);
    expect(view.draws).toBe(0);
    expect(view.triangles).toBe(0);
    view.set({ ...PACK, x: -10, z: 2 });
    expect(view.root.getObjectByName('remains_pack')).toBe(pack);
    expect(view.root.position.x).toBe(-10);
    view.set(BODY);
    expect(view.root.getObjectByName('remains_pack')).toBeUndefined();
    expect(view.look).toBe('body');
    view.dispose();
  });

  it('dispose takes it out of the scene and frees its own materials', () => {
    const parent = new THREE.Group();
    const { assets, body } = fake();
    const view = new RemainsView(parent, assets, () => 0, false);
    view.set(BODY);
    const clone = (meshes(body)[0] as THREE.Mesh).material as THREE.MeshStandardMaterial;
    let disposed = false;
    clone.addEventListener('dispose', () => {
      disposed = true;
    });
    view.dispose();
    expect(view.root.parent).toBeNull();
    expect(parent.children).toHaveLength(0);
    expect(disposed).toBe(true);
  });
});

describe('the committed models fit the budget (SPEC-057 §4.6)', () => {
  /** The triangles a GLB's every primitive draws, read off its JSON chunk. */
  function glbTriangles(name: string): { primitives: number; triangles: number } {
    const glb = readFileSync(new URL(`../../public/assets/models/${name}.glb`, import.meta.url).pathname);
    const length = new DataView(glb.buffer, glb.byteOffset, glb.byteLength).getUint32(12, true);
    const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + length))) as {
      meshes: { primitives: { indices: number }[] }[];
      accessors: { count: number }[];
    };
    let primitives = 0;
    let triangles = 0;
    for (const mesh of json.meshes) {
      for (const primitive of mesh.primitives) {
        primitives++;
        triangles += (json.accessors[primitive.indices]?.count ?? 0) / 3;
      }
    }
    return { primitives, triangles };
  }

  it('the body is 2 616 triangles and the pillar 24: 2 640, inside 2 700', () => {
    const pillar = new THREE.CylinderGeometry(0.3, 0.3, REMAINS_PILLAR_HEIGHT, 12, 1, true);
    const pillarTris = (pillar.getIndex()?.count ?? 0) / 3;
    expect(pillarTris).toBe(24);
    expect(glbTriangles('character')).toEqual({ primitives: 1, triangles: 2616 });
    expect(2616 + pillarTris).toBeLessThanOrEqual(2700);
  });

  it('the crate’s primitives merge into the pack’s one draw, well inside the triangle budget', () => {
    const crate = glbTriangles('crate');
    expect(crate.primitives).toBeGreaterThanOrEqual(1);
    expect(crate.triangles + 24).toBeLessThanOrEqual(2700);
  });
});
