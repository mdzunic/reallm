// SPEC-020 §4.6 — the portrait resolver, pinned in node. It is pure on
// purpose: whether a screen draws a bust or a glyph is a decision, not a
// rendering, so it is decided here and the screens only do as they are told.
import { describe, expect, it } from 'vitest';
import { parsePortraitManifest, PORTRAIT_GLYPHS, portraitSource } from '@/ui/portraits';

/** What the shipped manifest holds: the file numbers 1…12. */
const ALL = new Set(Array.from({ length: 12 }, (_, i) => i + 1));
const NONE: ReadonlySet<number> = new Set();

describe('portraitSource (SPEC-020 §4.6)', () => {
  it('names the file for every index the build wrote, 1-based and two digits (AC-28)', () => {
    expect(portraitSource(0, ALL)).toEqual({ kind: 'image', url: 'assets/portraits/01.webp' });
    expect(portraitSource(6, ALL)).toEqual({ kind: 'image', url: 'assets/portraits/07.webp' });
    expect(portraitSource(9, ALL)).toEqual({ kind: 'image', url: 'assets/portraits/10.webp' });
    expect(portraitSource(11, ALL)).toEqual({ kind: 'image', url: 'assets/portraits/12.webp' });
  });

  it('falls back to the glyph of today when nothing shipped (AC-28, 20-d)', () => {
    for (let index = 0; index < PORTRAIT_GLYPHS.length; index++) {
      expect(portraitSource(index, NONE)).toEqual({ kind: 'glyph', glyph: PORTRAIT_GLYPHS[index] });
    }
  });

  it('falls back per portrait, not per manifest — a partial drop mixes both', () => {
    const some = new Set([1, 3]);
    expect(portraitSource(0, some).kind).toBe('image');
    expect(portraitSource(1, some)).toEqual({ kind: 'glyph', glyph: PORTRAIT_GLYPHS[1] });
    expect(portraitSource(2, some)).toEqual({ kind: 'image', url: 'assets/portraits/03.webp' });
  });

  it('still draws something for an index outside the twelve', () => {
    expect(portraitSource(12, ALL)).toEqual({ kind: 'glyph', glyph: PORTRAIT_GLYPHS[0] });
    expect(portraitSource(-1, ALL)).toEqual({ kind: 'glyph', glyph: PORTRAIT_GLYPHS[11] });
    expect(portraitSource(Number.NaN, ALL)).toEqual({ kind: 'glyph', glyph: PORTRAIT_GLYPHS[0] });
  });
});

describe('parsePortraitManifest (20-d)', () => {
  it('takes the list of file numbers the Blender build writes', () => {
    expect([...parsePortraitManifest([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])]).toHaveLength(12);
    expect(parsePortraitManifest([3, 7]).has(7)).toBe(true);
  });

  it('degrades to the empty set on anything else — absent, wrong shape, junk', () => {
    for (const value of [null, undefined, {}, '1,2,3', 42, { files: [1, 2] }]) {
      expect(parsePortraitManifest(value).size, JSON.stringify(value) ?? 'undefined').toBe(0);
    }
    // A well-formed array with unusable entries keeps only what it can use.
    expect([...parsePortraitManifest([1, '2', 3.5, -4, 0, null, 5])]).toEqual([1, 5]);
  });
});
