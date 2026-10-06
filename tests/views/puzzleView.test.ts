// SPEC-055 §4.6, §4.10 — the puzzles as drawn, pinned in node: a world puzzle
// adds at most four draws (plates and their glyphs; or the mirrors, the lens
// and receiver and the beam), the terminals one more each way (lit and spent),
// nothing lights, a pressed plate's glyph burns in the beacon colour and a
// hinted one pulses, a mirror turns to its state, and the beam is one ribbon
// that goes when the scene takes it away.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { BEAM_HEIGHT, PuzzleView } from '@/views/PuzzleView';

const BEACON = '#ffb45a';

/** Equal within a Float32Array's precision. */
function same(a: THREE.Color, b: THREE.Color): boolean {
  return Math.abs(a.r - b.r) < 1e-5 && Math.abs(a.g - b.g) < 1e-5 && Math.abs(a.b - b.b) < 1e-5;
}

function meshes(view: PuzzleView): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  view.root.traverse((node) => {
    if ((node as THREE.Mesh).isMesh === true && node.visible) out.push(node as THREE.Mesh);
  });
  return out;
}

function named(view: PuzzleView, name: string): THREE.Mesh {
  const mesh = meshes(view).find((m) => m.name === name);
  if (mesh === undefined) throw new Error(`no ${name}`);
  return mesh;
}

const PLATES = [
  { x: 0, z: 0, glyph: 'circle' as const },
  { x: 4, z: 0, glyph: 'triangle' as const },
  { x: 0, z: 4, glyph: 'star' as const },
];

describe('the puzzle view (SPEC-055 §4.6, §4.10)', () => {
  it('a plates puzzle draws two objects — the plates and their glyphs — and a beam three, inside §4.10’s four', () => {
    const plates = new PuzzleView(new THREE.Group(), BEACON);
    plates.setPlates(PLATES);
    expect(plates.drawObjects).toBe(2);
    expect((named(plates, 'puzzle-plates') as THREE.InstancedMesh).count).toBe(3);

    const beam = new PuzzleView(new THREE.Group(), BEACON);
    beam.setMirrors([
      { x: 2, z: 2, state: 2 },
      { x: 2, z: 6, state: 0 },
    ]);
    beam.setEnds({ x: -2, z: 2, facing: 0 }, { x: 6, z: 6, facing: Math.PI });
    beam.setBeam([-2, 2, 2, 2, 2, 6, 6, 6]);
    expect(beam.drawObjects).toBe(3);
    expect(beam.drawObjects).toBeLessThanOrEqual(4);
    for (const view of [plates, beam]) {
      let lights = 0;
      view.root.traverse((node) => {
        if (node instanceof THREE.Light) lights++;
      });
      expect(lights).toBe(0);
      view.dispose();
    }
  });

  it('the panel’s screen shows the order in one more draw, and none once it is dark', () => {
    const view = new PuzzleView(new THREE.Group(), BEACON);
    view.setPlates(PLATES);
    view.setPanelGlyphs({ x: 20, z: 0, facing: Math.PI }, ['triangle', 'star', 'circle']);
    expect(view.drawObjects).toBe(3);
    const glyphs = named(view, 'puzzle-panel-glyphs');
    glyphs.geometry.computeBoundingBox();
    const box = glyphs.geometry.boundingBox as THREE.Box3;
    // At the terminal, at screen height, on its front (−x for a terminal facing −x).
    expect(box.min.y).toBeGreaterThan(1);
    expect(box.max.y).toBeLessThan(1.5);
    expect(box.getCenter(new THREE.Vector3()).x).toBeLessThan(20);
    expect(Math.abs(box.getCenter(new THREE.Vector3()).z)).toBeLessThan(0.05);
    view.setPanelGlyphs(null, []);
    expect(view.drawObjects).toBe(2);
    view.dispose();
  });

  it('terminals draw lit and spent apart — one object each, none for an empty side', () => {
    const view = new PuzzleView(new THREE.Group(), BEACON);
    view.setTerminals([{ x: 0, z: 0, facing: 0, spent: false }]);
    expect(view.drawObjects).toBe(1);
    view.setTerminals([
      { x: 0, z: 0, facing: 0, spent: false },
      { x: 5, z: 0, facing: Math.PI, spent: true },
    ]);
    expect(view.drawObjects).toBe(2);
    expect((named(view, 'puzzle-terminals') as THREE.InstancedMesh).count).toBe(1);
    expect((named(view, 'puzzle-terminals-spent') as THREE.InstancedMesh).count).toBe(1);
    // A spent terminal's screen is dark: its material emits nothing.
    const spent = named(view, 'puzzle-terminals-spent').material as THREE.MeshStandardMaterial;
    expect(spent.emissive.getHex()).toBe(0);
    view.setTerminals([]);
    expect(view.drawObjects).toBe(0);
    view.dispose();
  });

  it('a pressed plate’s glyph takes the beacon colour; a hinted one pulses, and holds steady under reduce motion', () => {
    const view = new PuzzleView(new THREE.Group(), BEACON);
    view.setPlates(PLATES);
    const glyphs = named(view, 'puzzle-glyphs');
    const colour = (plate: number): THREE.Color => {
      // Each glyph's vertices are contiguous, in plate order; read one from the middle of plate `plate`'s run.
      const positions = glyphs.geometry.getAttribute('position') as THREE.BufferAttribute;
      const colors = glyphs.geometry.getAttribute('color') as THREE.BufferAttribute;
      for (let v = 0; v < positions.count; v++) {
        const near = Math.hypot(positions.getX(v) - (PLATES[plate]?.x ?? 0), positions.getZ(v) - (PLATES[plate]?.z ?? 0)) < 0.6;
        if (near) return new THREE.Color(colors.getX(v), colors.getY(v), colors.getZ(v));
      }
      throw new Error(`no glyph at plate ${plate}`);
    };
    const beacon = new THREE.Color(BEACON);
    const idle = colour(0);
    expect(same(idle, beacon)).toBe(false);
    view.setPressed([true, false, false]);
    expect(same(colour(0), beacon)).toBe(true);
    expect(same(colour(1), idle)).toBe(true);
    view.setPlatePulse(1);
    view.sync(0.6, true);
    expect(same(colour(1), beacon)).toBe(true);
    view.sync(0, false);
    const half = colour(1);
    expect(same(half, beacon)).toBe(false);
    view.setPressed([false, false, false]);
    expect(same(colour(0), idle)).toBe(true);
    view.dispose();
  });

  it('a mirror turns to its state’s yaw — / and \\ on the diagonals', () => {
    const view = new PuzzleView(new THREE.Group(), BEACON);
    view.setMirrors([{ x: 0, z: 0, state: 0 }]);
    const mesh = named(view, 'puzzle-mirrors') as THREE.InstancedMesh;
    const yaw = (): number => {
      const matrix = new THREE.Matrix4();
      mesh.getMatrixAt(0, matrix);
      const q = new THREE.Quaternion();
      matrix.decompose(new THREE.Vector3(), q, new THREE.Vector3());
      return new THREE.Euler().setFromQuaternion(q, 'YXZ').y;
    };
    expect(yaw()).toBeCloseTo(Math.PI / 4, 6);
    view.setMirrorState(0, 1);
    expect(yaw()).toBeCloseTo(-Math.PI / 4, 6);
    view.setMirrorState(0, 3);
    expect(yaw()).toBeCloseTo(Math.PI / 2, 6);
    view.dispose();
  });

  it('the beam is one ribbon at the lens’s height, and setBeam(null) takes it away', () => {
    const view = new PuzzleView(new THREE.Group(), BEACON);
    view.setBeam([0, 0, 4, 0, 4, 4]);
    expect(view.beamDrawn).toBe(true);
    const beam = named(view, 'puzzle-beam');
    const positions = beam.geometry.getAttribute('position') as THREE.BufferAttribute;
    expect(positions.count).toBe(12);
    for (let v = 0; v < positions.count; v++) expect(positions.getY(v)).toBe(BEAM_HEIGHT);
    view.setBeam(null);
    expect(view.beamDrawn).toBe(false);
    expect(view.drawObjects).toBe(0);
    view.dispose();
  });
});
