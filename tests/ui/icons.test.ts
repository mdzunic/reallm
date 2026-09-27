// SPEC-031 §6.1 — the pure half of the item-picture resolver. The DOM box is
// exercised by e2e/SPEC-031.spec.ts.
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { COMPANIONS, ITEMS } from '@/data/index';
import { type IconId, iconGlyph, itemIconSource, itemManifest, parseItemManifest } from '@/ui/icons';

describe('itemIconSource (SPEC-031 §4.14)', () => {
  it('returns the image when the manifest lists the id', () => {
    expect(itemIconSource('medkit', new Set(['medkit']))).toEqual({ kind: 'image', url: 'assets/items/medkit.webp' });
  });

  it('returns the glyph for an id outside the set', () => {
    const source = itemIconSource('medkit', new Set());
    expect(source.kind).toBe('glyph');
    if (source.kind === 'glyph') expect(source.glyph).toBe(iconGlyph('medkit'));
  });
});

describe('parseItemManifest (SPEC-031 §4.14)', () => {
  it('accepts only a well-formed { items: string[] }', () => {
    expect(parseItemManifest({ items: ['pistol_service', 'medkit'] })).toEqual(new Set(['pistol_service', 'medkit']));
  });

  it('turns null, an empty object and a bare array into the empty set', () => {
    expect(parseItemManifest(null).size).toBe(0);
    expect(parseItemManifest({}).size).toBe(0);
    expect(parseItemManifest(['nope']).size).toBe(0);
  });

  it('skips non-string entries', () => {
    expect(parseItemManifest({ items: ['medkit', 3, null, ''] })).toEqual(new Set(['medkit']));
  });
});

describe('itemManifest (SPEC-031 §4.14)', () => {
  it('resolves to the empty set when the fetch fails, and never rejects', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('offline'))),
    );
    try {
      const set = await itemManifest();
      expect(set.size).toBe(0);
      // Memoised: a second call is the same promise, not a second request.
      await itemManifest();
      expect(vi.mocked(fetch).mock.calls).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// SPEC-035 §6.1 — the renders are committed (§4.15), so the fallback is no
// longer the normal case: every id the shelf can show must name a picture. The
// test reads the manifest the Blender build wrote, not a fixture, so an item
// added without a render fails here and names itself.
describe('the committed manifest (SPEC-035 §4.15, AC-45)', () => {
  const manifest = parseItemManifest(
    JSON.parse(readFileSync(new URL('../../public/assets/items/manifest.json', import.meta.url).pathname, 'utf8')) as unknown,
  );
  const ids = [...Object.keys(ITEMS), ...Object.keys(COMPANIONS)] as IconId[];

  it('lists a render for all 21 items and 5 companions', () => {
    expect(ids).toHaveLength(26);
    expect([...manifest].sort()).toEqual([...ids].sort());
  });

  it('resolves every item and companion id to an image, never a glyph', () => {
    const glyphs = ids.filter((id) => itemIconSource(id, manifest).kind !== 'image');
    expect(glyphs).toEqual([]);
  });

  it('names a file that exists under public/assets/items', () => {
    for (const id of ids) {
      const source = itemIconSource(id, manifest);
      expect(source.kind).toBe('image');
      if (source.kind !== 'image') continue;
      expect(source.url).toBe(`assets/items/${id}.webp`);
      expect(readFileSync(new URL(`../../public/${source.url}`, import.meta.url).pathname).byteLength).toBeGreaterThan(0);
    }
  });
});
