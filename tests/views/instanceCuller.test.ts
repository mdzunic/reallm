// SPEC-046 §6.1 — only what is on screen. The rig's ground rect and the margin
// past it are pure arithmetic, so their rows pin; the grid is held to a brute
// force over seeded points; and the compaction is read straight off the
// instanced mesh's own buffers, the arrays the GPU would be handed.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Rng } from '@/core/Rng';
import {
  CULL_CELL,
  CULL_REFRESH_DISTANCE,
  CulledInstances,
  InstanceGrid,
  RIG_PITCH_DEG,
  RIG_YAW_DEG,
  cullMargin,
  extendByFrustum,
  viewRect,
  type CullRect,
} from '@/views/InstanceCuller';

function rect(): CullRect {
  return { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };
}

describe('viewRect (SPEC-046 §4.6)', () => {
  it('pins the three rows of §4.6, ± 0.01', () => {
    const rows: ReadonlyArray<readonly [number, number, number, number, number]> = [
      [22, 40, 16 / 9, -22.78, 13.53],
      [17, 40, 844 / 390, -19.87, 11.8],
      [22, 61.4, 0.75, -31.16, 12.86],
    ];
    for (const [distance, fov, aspect, min, max] of rows) {
      const out = viewRect({ x: 0, z: 0 }, distance, fov, aspect, 0, rect());
      expect(Math.abs(out.minX - min), `${distance} m ${fov}° minX`).toBeLessThanOrEqual(0.01);
      expect(Math.abs(out.minZ - min), `${distance} m ${fov}° minZ`).toBeLessThanOrEqual(0.01);
      expect(Math.abs(out.maxX - max), `${distance} m ${fov}° maxX`).toBeLessThanOrEqual(0.01);
      expect(Math.abs(out.maxZ - max), `${distance} m ${fov}° maxZ`).toBeLessThanOrEqual(0.01);
    }
  });

  it('moves with the target, grows by the margin, writes `out` and returns it', () => {
    const out = rect();
    const at = viewRect({ x: 30, z: -12 }, 22, 40, 16 / 9, 2.5, out);
    expect(at).toBe(out);
    expect(out.minX).toBeCloseTo(-22.7847 + 30 - 2.5, 3);
    expect(out.maxX).toBeCloseTo(13.5298 + 30 + 2.5, 3);
    expect(out.minZ).toBeCloseTo(-22.7847 - 12 - 2.5, 3);
    expect(out.maxZ).toBeCloseTo(13.5298 - 12 + 2.5, 3);
  });

  it('is the ground the scene camera of the same rig actually sees', () => {
    // three's own camera at the rig's offset, looking at the target: its four
    // corner rays, cut with y = 0, span exactly the rect.
    const target = new THREE.Vector3(-14, 0, 41);
    const pitch = (RIG_PITCH_DEG * Math.PI) / 180;
    const yaw = (RIG_YAW_DEG * Math.PI) / 180;
    const camera = new THREE.PerspectiveCamera(52, 1.3, 1, 200);
    camera.position.set(
      target.x + 22 * Math.cos(pitch) * Math.sin(yaw),
      22 * Math.sin(pitch),
      target.z + 22 * Math.cos(pitch) * Math.cos(yaw),
    );
    camera.lookAt(target);
    camera.updateMatrixWorld();
    const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const box = new THREE.Box2();
    for (const [x, y] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
      const through = new THREE.Vector3(x, y, 0.5).unproject(camera).sub(camera.position).normalize();
      const hit = new THREE.Ray(camera.position.clone(), through).intersectPlane(ground, new THREE.Vector3());
      expect(hit).not.toBeNull();
      box.expandByPoint(new THREE.Vector2(hit?.x, hit?.z));
    }
    const out = viewRect({ x: target.x, z: target.z }, 22, 52, 1.3, 0, rect());
    expect(out.minX).toBeCloseTo(box.min.x, 4);
    expect(out.maxX).toBeCloseTo(box.max.x, 4);
    expect(out.minZ).toBeCloseTo(box.min.y, 4);
    expect(out.maxZ).toBeCloseTo(box.max.y, 4);
  });
});

describe('extendByFrustum (SPEC-046 §4.6)', () => {
  it('takes in what a camera turned toward its look-ahead sees, which the rig rect misses', () => {
    // The scene anchors the camera to the player and turns it toward a point
    // 2 m ahead; the rect from that look-at point misses a few metres of it.
    const pitch = (RIG_PITCH_DEG * Math.PI) / 180;
    const yaw = (RIG_YAW_DEG * Math.PI) / 180;
    const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    let missedBefore = 0;
    for (let step = 0; step < 16; step++) {
      const angle = (step / 16) * Math.PI * 2;
      const look = { x: Math.cos(angle) * 2, z: Math.sin(angle) * 2 };
      const camera = new THREE.PerspectiveCamera(40, 16 / 9, 1, 130);
      camera.position.set(22 * Math.cos(pitch) * Math.sin(yaw), 22 * Math.sin(pitch), 22 * Math.cos(pitch) * Math.cos(yaw));
      camera.lookAt(look.x, 0, look.z);
      camera.updateMatrixWorld();
      const frustum = new THREE.Frustum().setFromProjectionMatrix(
        new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
      );
      const out = viewRect(look, 22, 40, 16 / 9, 0, rect());
      const corners: THREE.Vector3[] = [];
      for (const [x, y] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
        const through = new THREE.Vector3(x, y, 0.5).unproject(camera).sub(camera.position).normalize();
        corners.push(new THREE.Ray(camera.position.clone(), through).intersectPlane(ground, new THREE.Vector3()) as THREE.Vector3);
      }
      const outside = (r: CullRect): number =>
        Math.max(...corners.map((c) => Math.max(r.minX - c.x, c.x - r.maxX, r.minZ - c.z, c.z - r.maxZ)));
      missedBefore = Math.max(missedBefore, outside(out));
      expect(extendByFrustum(frustum, 0, out)).toBe(true);
      expect(outside(out)).toBeLessThanOrEqual(1e-6);
    }
    expect(missedBefore).toBeGreaterThan(1); // the case is real: the look-ahead does skew the view
  });

  it('grows by the margin, and never shrinks the rect it is given', () => {
    const camera = new THREE.PerspectiveCamera(40, 16 / 9, 1, 130);
    camera.position.set(8.92, 18.02, 8.92);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    const frustum = new THREE.Frustum().setFromProjectionMatrix(
      new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
    );
    const plain = rect();
    plain.minX = plain.minZ = Infinity;
    plain.maxX = plain.maxZ = -Infinity;
    extendByFrustum(frustum, 0, plain);
    const grown = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
    extendByFrustum(frustum, 3, grown);
    expect(grown.minX).toBeCloseTo(plain.minX - 3, 6);
    expect(grown.maxZ).toBeCloseTo(plain.maxZ + 3, 6);
    const wide = { minX: -500, maxX: 500, minZ: -500, maxZ: 500 };
    extendByFrustum(frustum, 3, wide);
    expect(wide).toEqual({ minX: -500, maxX: 500, minZ: -500, maxZ: 500 });
  });
});

describe('cullMargin (SPEC-046 §4.6)', () => {
  it('is radius + height / tan(55° − fov / 2) + CULL_REFRESH_DISTANCE', () => {
    expect(CULL_REFRESH_DISTANCE).toBe(1);
    expect(cullMargin(5, 10, 40)).toBeCloseTo(5 + 10 / Math.tan((35 * Math.PI) / 180) + 1, 9);
    expect(cullMargin(5, 10, 40)).toBeCloseTo(20.28, 2);
    expect(cullMargin(0, 0, 66)).toBe(1);
  });
});

describe('InstanceGrid (SPEC-046 §4.6)', () => {
  it('answers exactly the brute-force filter over 1,000 seeded points, in ascending order', () => {
    const rng = new Rng(46_046);
    const xz = new Float32Array(2_000);
    for (let i = 0; i < xz.length; i++) xz[i] = rng.float(-200, 200);
    const grid = new InstanceGrid(CULL_CELL, xz);
    const out = new Int32Array(1_000);
    for (let query = 0; query < 60; query++) {
      const x = rng.float(-260, 260);
      const z = rng.float(-260, 260);
      const r: CullRect = { minX: x, maxX: x + rng.float(0, 120), minZ: z, maxZ: z + rng.float(0, 120) };
      const expected: number[] = [];
      for (let i = 0; i < 1_000; i++) {
        const px = xz[i * 2] as number;
        const pz = xz[i * 2 + 1] as number;
        if (px >= r.minX && px <= r.maxX && pz >= r.minZ && pz <= r.maxZ) expected.push(i);
      }
      const count = grid.query(r, out);
      expect(count, `query ${query}`).toBe(expected.length);
      expect([...out.subarray(0, count)], `query ${query}`).toEqual(expected);
    }
  });

  it('answers nothing for a rect off the grid, and everything for one around it', () => {
    const xz = new Float32Array([0, 0, 10, 10, -40, 25]);
    const grid = new InstanceGrid(CULL_CELL, xz);
    const out = new Int32Array(3);
    expect(grid.query({ minX: 100, maxX: 200, minZ: 100, maxZ: 200 }, out)).toBe(0);
    expect(grid.query({ minX: -1e4, maxX: 1e4, minZ: -1e4, maxZ: 1e4 }, out)).toBe(3);
    expect([...out]).toEqual([0, 1, 2]);
    expect(new InstanceGrid(CULL_CELL, new Float32Array(0)).query({ minX: -1, maxX: 1, minZ: -1, maxZ: 1 }, out)).toBe(0);
  });
});

// ---------------------------------------------------------- CulledInstances

const scratch = new THREE.Matrix4();

/** A row of `n` unit boxes along x at 10 m spacing, each with its own colour and fade. */
function row(n: number): { mesh: THREE.InstancedMesh; matrices: Float32Array; colors: Float32Array; fades: Float32Array; layer: CulledInstances } {
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  geometry.computeBoundingSphere();
  const mesh = new THREE.InstancedMesh(geometry, new THREE.MeshStandardMaterial(), n);
  const matrices = new Float32Array(n * 16);
  const colors = new Float32Array(n * 3);
  const fades = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    scratch.makeTranslation(i * 10, 0, 0).toArray(matrices, i * 16);
    colors.set([i / n, 1 - i / n, 0.5], i * 3);
    fades[i] = 1 - i / (2 * n);
  }
  const layer = new CulledInstances(mesh, { matrices, colors, fades }, geometry.boundingSphere as THREE.Sphere);
  return { mesh, matrices, colors, fades, layer };
}

/** A frustum that holds everything. */
const EVERYTHING = new THREE.Frustum(
  new THREE.Plane(new THREE.Vector3(1, 0, 0), 1e6),
  new THREE.Plane(new THREE.Vector3(-1, 0, 0), 1e6),
  new THREE.Plane(new THREE.Vector3(0, 1, 0), 1e6),
  new THREE.Plane(new THREE.Vector3(0, -1, 0), 1e6),
  new THREE.Plane(new THREE.Vector3(0, 0, 1), 1e6),
  new THREE.Plane(new THREE.Vector3(0, 0, -1), 1e6),
);

/** The instance index drawn in each slot, read back from the slot's translation. */
function drawnIndices(mesh: THREE.InstancedMesh): number[] {
  const out: number[] = [];
  for (let slot = 0; slot < mesh.count; slot++) {
    mesh.getMatrixAt(slot, scratch);
    out.push(Math.round(scratch.elements[12] / 10));
  }
  return out;
}

describe('CulledInstances (SPEC-046 §4.6)', () => {
  it('draws every instance until its first refresh', () => {
    const { mesh, layer } = row(12);
    expect(layer.total).toBe(12);
    expect(layer.drawn).toBe(12);
    expect(mesh.count).toBe(12);
    expect(mesh.visible).toBe(true);
    expect(drawnIndices(mesh)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it('draws exactly the instances inside the rect, in ascending order, with their colour and fade', () => {
    const { mesh, colors, fades, layer } = row(20);
    const drawn = layer.refresh({ minX: 35, maxX: 92, minZ: -1, maxZ: 1 }, EVERYTHING, 1);
    expect(drawn).toBe(6); // x = 40, 50, …, 90
    expect(layer.drawn).toBe(6);
    expect(drawnIndices(mesh)).toEqual([4, 5, 6, 7, 8, 9]);
    const slotColors = mesh.instanceColor?.array as Float32Array;
    const slotFades = mesh.geometry.getAttribute('instanceFade').array as Float32Array;
    [4, 5, 6, 7, 8, 9].forEach((index, slot) => {
      expect(slotColors[slot * 3]).toBeCloseTo(colors[index * 3] as number, 6);
      expect(slotColors[slot * 3 + 1]).toBeCloseTo(colors[index * 3 + 1] as number, 6);
      expect(slotFades[slot]).toBeCloseTo(fades[index] as number, 6);
    });
    // Only the drawn prefix goes up to the GPU.
    expect(mesh.instanceMatrix.updateRanges).toEqual([{ start: 0, count: 6 * 16 }]);
    expect(mesh.instanceColor?.updateRanges).toEqual([{ start: 0, count: 6 * 3 }]);
    expect(mesh.frustumCulled).toBe(false);
  });

  it('count and visible follow what is drawn, and an empty rect hides the layer', () => {
    const { mesh, layer } = row(8);
    layer.refresh({ minX: -1, maxX: 31, minZ: -1, maxZ: 1 }, null, 0);
    expect(mesh.count).toBe(4);
    expect(mesh.visible).toBe(true);
    layer.refresh({ minX: 500, maxX: 600, minZ: -1, maxZ: 1 }, null, 0);
    expect(mesh.count).toBe(0);
    expect(layer.drawn).toBe(0);
    expect(mesh.visible).toBe(false);
  });

  it('allocates no typed array across 100 refreshes', () => {
    const { mesh, layer } = row(30);
    const matrix = mesh.instanceMatrix.array;
    const color = mesh.instanceColor?.array;
    const fade = mesh.geometry.getAttribute('instanceFade');
    const fadeArray = fade.array;
    const rng = new Rng(4_600);
    for (let i = 0; i < 100; i++) {
      const x = rng.float(-50, 300);
      layer.refresh({ minX: x, maxX: x + rng.float(0, 120), minZ: -5, maxZ: 5 }, EVERYTHING, 1);
      expect(mesh.instanceMatrix.array).toBe(matrix);
      expect(mesh.instanceColor?.array).toBe(color);
      expect(mesh.geometry.getAttribute('instanceFade')).toBe(fade);
      expect(fade.array).toBe(fadeArray);
    }
  });

  it('a frustum pointing away draws nothing, and the pad grows a sphere back into it', () => {
    const { mesh, layer } = row(10);
    // Everything lies at z = 0; this frustum only keeps z ≥ 50.
    const away = new THREE.Frustum(
      new THREE.Plane(new THREE.Vector3(0, 0, 1), -50),
      new THREE.Plane(new THREE.Vector3(0, 0, 1), 1e6),
      new THREE.Plane(new THREE.Vector3(0, 0, 1), 1e6),
      new THREE.Plane(new THREE.Vector3(0, 0, 1), 1e6),
      new THREE.Plane(new THREE.Vector3(0, 0, 1), 1e6),
      new THREE.Plane(new THREE.Vector3(0, 0, 1), 1e6),
    );
    const all: CullRect = { minX: -1e3, maxX: 1e3, minZ: -1e3, maxZ: 1e3 };
    expect(layer.refresh(all, away, 0)).toBe(0);
    expect(mesh.count).toBe(0);
    expect(mesh.visible).toBe(false);
    // A pad as wide as the gap reaches back in (46-g, 46-h).
    expect(layer.refresh(all, away, 50)).toBe(10);
  });

  it('setFade and setMatrix on an undrawn instance reach its slot after the next refresh', () => {
    const { mesh, fades, matrices, layer } = row(10);
    layer.refresh({ minX: -1, maxX: 21, minZ: -1, maxZ: 1 }, EVERYTHING, 1); // draws 0, 1, 2
    // Instance 7 is off screen: the master takes both writes.
    layer.setFade(7, 0.3);
    const lifted = new THREE.Matrix4().makeTranslation(70, 0, 0).scale(new THREE.Vector3(1e-6, 1e-6, 1e-6));
    layer.setMatrix(7, lifted);
    expect(fades[7]).toBeCloseTo(0.3, 6);
    expect(matrices[0 + 7 * 16]).toBeCloseTo(1e-6, 9);
    expect(drawnIndices(mesh)).toEqual([0, 1, 2]);

    layer.refresh({ minX: 55, maxX: 75, minZ: -1, maxZ: 1 }, EVERYTHING, 1); // draws 6, 7
    expect(drawnIndices(mesh)).toEqual([6, 7]);
    const slotFades = mesh.geometry.getAttribute('instanceFade').array as Float32Array;
    expect(slotFades[1]).toBeCloseTo(0.3, 6);
    mesh.getMatrixAt(1, scratch);
    expect(new THREE.Vector3().setFromMatrixScale(scratch).x).toBeCloseTo(1e-6, 9);
  });

  it('setFade and setMatrix on a drawn instance write its slot at once, and a refresh keeps them', () => {
    const { mesh, layer } = row(10);
    layer.refresh({ minX: 25, maxX: 55, minZ: -1, maxZ: 1 }, EVERYTHING, 1); // draws 3, 4, 5
    layer.setFade(4, 0.5);
    const slotFades = mesh.geometry.getAttribute('instanceFade').array as Float32Array;
    expect(slotFades[1]).toBeCloseTo(0.5, 6);
    layer.setMatrix(5, new THREE.Matrix4().makeTranslation(50, 3, 0));
    mesh.getMatrixAt(2, scratch);
    expect(scratch.elements[13]).toBeCloseTo(3, 6);
    layer.refresh({ minX: 35, maxX: 55, minZ: -1, maxZ: 1 }, EVERYTHING, 1); // draws 4, 5
    expect(slotFades[0]).toBeCloseTo(0.5, 6);
    mesh.getMatrixAt(1, scratch);
    expect(scratch.elements[13]).toBeCloseTo(3, 6);
    expect(layer.fadeAt(4)).toBeCloseTo(0.5, 6);
  });

  it('reports the reach a margin needs: the sphere × the largest scale, and the highest top', () => {
    const geometry = new THREE.BoxGeometry(2, 2, 2);
    geometry.translate(0, 1, 0);
    geometry.computeBoundingSphere();
    const sphere = geometry.boundingSphere as THREE.Sphere;
    const mesh = new THREE.InstancedMesh(geometry, new THREE.MeshStandardMaterial(), 2);
    const matrices = new Float32Array(32);
    scratch.makeScale(3, 3, 3).setPosition(0, 0.5, 0).toArray(matrices, 0);
    scratch.makeScale(1, 1, 1).setPosition(20, 2, 0).toArray(matrices, 16);
    const layer = new CulledInstances(mesh, { matrices }, sphere);
    expect(layer.maxRadius).toBeCloseTo(sphere.radius * 3, 6);
    expect(layer.maxHeight).toBeCloseTo(0.5 + (sphere.center.y + sphere.radius) * 3, 6);
  });

  it('refuses a mesh too small for its master — a programming error', () => {
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial(), 2);
    expect(() => new CulledInstances(mesh, { matrices: new Float32Array(48) }, new THREE.Sphere())).toThrow();
  });
});
