// SPEC-018 AC (height field): built from a literal fake layout, never
// `generateLayout` — the bounds and flattenings are what the whole surface
// view stands on, so they pin here in node.
import { describe, expect, it } from 'vitest';
import {
  HEIGHT_CELL,
  PAD_FLATTEN,
  TERRAIN_APRON,
  buildHeightField,
  type HeightFieldLayout,
  type ReliefParams,
} from '@/core/HeightField';
import { hash01 } from '@/core/Noise';

const LAYOUT: HeightFieldLayout = {
  halfSize: 100,
  hash: 0xbeefcafe,
  pois: [
    { x: 40, z: -30, radius: 8 },
    { x: -60, z: 50, radius: 20 },
    { x: 0, z: 0, radius: 6 },
  ],
};

const RELIEF: ReliefParams = { amplitude: 0.5, wavelength: 30, ridged: 0.6, bermHeight: 5 };

const field = buildHeightField(LAYOUT, RELIEF);

describe('the grid (SPEC-018 §4.2)', () => {
  it('covers ±(halfSize + 40) at 2 m, with the arrays sized to match', () => {
    const extent = LAYOUT.halfSize + TERRAIN_APRON;
    expect(field.origin).toBe(-extent);
    expect(field.cell).toBe(HEIGHT_CELL);
    expect(field.n).toBe((2 * extent) / HEIGHT_CELL + 1);
    expect(field.heights.length).toBe(field.n * field.n);
    expect(field.occlusion.length).toBe(field.n * field.n);
    expect(field.splat.length).toBe(field.n * field.n);
  });

  it('is deterministic: a second build is bit-identical', () => {
    const again = buildHeightField(LAYOUT, RELIEF);
    expect(again.heights).toEqual(field.heights);
    expect(again.splat).toEqual(field.splat);
  });

  it('stays within ±amplitude inside the arena', () => {
    for (let iz = 0; iz < field.n; iz++) {
      for (let ix = 0; ix < field.n; ix++) {
        const x = field.origin + ix * HEIGHT_CELL;
        const z = field.origin + iz * HEIGHT_CELL;
        if (Math.abs(x) > LAYOUT.halfSize || Math.abs(z) > LAYOUT.halfSize) continue;
        const h = field.heights[iz * field.n + ix] as number;
        expect(Math.abs(h)).toBeLessThanOrEqual(RELIEF.amplitude + 1e-6);
      }
    }
  });

  it('is flat (±1e-6) within poi.radius + 2 of every POI', () => {
    for (const poi of LAYOUT.pois) {
      for (let i = 0; i < 40; i++) {
        const angle = hash01(7, i) * Math.PI * 2;
        const d = hash01(9, i) * (poi.radius + 2);
        const h = field.heightAt(poi.x + Math.cos(angle) * d, poi.z + Math.sin(angle) * d);
        expect(Math.abs(h)).toBeLessThanOrEqual(1e-6);
      }
    }
  });

  it('is flat (±1e-6) within 15 m of the origin', () => {
    for (let i = 0; i < 60; i++) {
      const angle = hash01(11, i) * Math.PI * 2;
      const d = hash01(13, i) * PAD_FLATTEN;
      expect(Math.abs(field.heightAt(Math.cos(angle) * d, Math.sin(angle) * d))).toBeLessThanOrEqual(1e-6);
    }
  });

  it('keeps the apron between 0 and bermHeight + 1.5 + amplitude', () => {
    const top = RELIEF.bermHeight + 1.5 + RELIEF.amplitude;
    for (let iz = 0; iz < field.n; iz++) {
      for (let ix = 0; ix < field.n; ix++) {
        const x = field.origin + ix * HEIGHT_CELL;
        const z = field.origin + iz * HEIGHT_CELL;
        if (Math.max(Math.abs(x), Math.abs(z)) <= LAYOUT.halfSize) continue;
        const h = field.heights[iz * field.n + ix] as number;
        expect(h).toBeGreaterThanOrEqual(0);
        expect(h).toBeLessThanOrEqual(top + 1e-6);
      }
    }
  });
});

describe('heightAt / normalAt', () => {
  it('equals the grid at nodes', () => {
    for (let i = 0; i < 200; i++) {
      const ix = Math.floor(hash01(17, i) * field.n);
      const iz = Math.floor(hash01(19, i) * field.n);
      const x = field.origin + ix * HEIGHT_CELL;
      const z = field.origin + iz * HEIGHT_CELL;
      expect(field.heightAt(x, z)).toBeCloseTo(field.heights[iz * field.n + ix] as number, 5);
    }
  });

  it('is continuous across cell borders (±1e-3 m)', () => {
    for (let i = 0; i < 200; i++) {
      const ix = 1 + Math.floor(hash01(23, i) * (field.n - 2));
      const borderX = field.origin + ix * HEIGHT_CELL;
      const z = field.origin + hash01(29, i) * (field.n - 1) * HEIGHT_CELL;
      expect(Math.abs(field.heightAt(borderX - 1e-4, z) - field.heightAt(borderX + 1e-4, z))).toBeLessThanOrEqual(1e-3);
      const borderZ = field.origin + ix * HEIGHT_CELL;
      const x = field.origin + hash01(31, i) * (field.n - 1) * HEIGHT_CELL;
      expect(Math.abs(field.heightAt(x, borderZ - 1e-4) - field.heightAt(x, borderZ + 1e-4))).toBeLessThanOrEqual(1e-3);
    }
  });

  it('allocates nothing: repeated samples reuse the caller result object', () => {
    const out = { x: 0, y: 0, z: 0 };
    const first = field.heightAt(33.3, -21.7);
    for (let i = 0; i < 1000; i++) {
      expect(field.heightAt(33.3, -21.7)).toBe(first);
      field.normalAt(33.3, -21.7, out);
    }
    // The same object came back with the same answer every time.
    expect(Math.hypot(out.x, out.y, out.z)).toBeCloseTo(1, 6);
  });

  it('returns unit normals everywhere, and (0, 1, 0) on the pad', () => {
    const out = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < 300; i++) {
      const x = (hash01(37, i) - 0.5) * 2 * (LAYOUT.halfSize + TERRAIN_APRON);
      const z = (hash01(41, i) - 0.5) * 2 * (LAYOUT.halfSize + TERRAIN_APRON);
      field.normalAt(x, z, out);
      expect(Math.hypot(out.x, out.y, out.z)).toBeCloseTo(1, 6);
    }
    field.normalAt(0, 0, out);
    expect(out.x).toBeCloseTo(0, 6);
    expect(out.y).toBeCloseTo(1, 6);
    expect(out.z).toBeCloseTo(0, 6);
    field.normalAt(4, -6, out);
    expect(out.y).toBeCloseTo(1, 6);
  });
});
