// SPEC-031 §6.1 — the pure half of the item-picture resolver. The DOM box is
// exercised by e2e/SPEC-031.spec.ts.
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { COMPANIONS, ITEMS } from '@/data/index';
import { EFFECT_GLYPHS, type IconId, iconGlyph, itemIconSource, itemManifest, parseItemManifest } from '@/ui/icons';

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
//
// SPEC-052 §4.8 drew seven pictures before their items existed. They waited in
// PENDING_PICTURES; SPEC-056 adds the items, moves the 26 to 33 and empties the
// list, so an item id that does not match its picture fails here (52-f).
const PENDING_PICTURES = [] as const;

describe('the committed manifest (SPEC-035 §4.15, AC-45; SPEC-052 §4.8)', () => {
  const manifest = parseItemManifest(
    JSON.parse(readFileSync(new URL('../../public/assets/items/manifest.json', import.meta.url).pathname, 'utf8')) as unknown,
  );
  const ids = [...Object.keys(ITEMS), ...Object.keys(COMPANIONS)] as IconId[];

  it('lists a render for all 28 items and 5 companions, and no picture is still waiting for its item', () => {
    expect(ids).toHaveLength(33);
    expect(PENDING_PICTURES).toHaveLength(0);
    expect([...manifest].sort()).toEqual([...ids, ...PENDING_PICTURES].sort());
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

// SPEC-056 §4.5 — the flare's and the stim's effects wear glyphs of their own.
describe('the light and stamina glyphs (SPEC-056 §4.5)', () => {
  it('light is ☼ and stamina is », each distinct from every other effect', () => {
    expect(EFFECT_GLYPHS.light).toBe('☼');
    expect(EFFECT_GLYPHS.stamina).toBe('»');
    expect(iconGlyph('flare')).toBe('☼');
    expect(iconGlyph('stim')).toBe('»');
    const glyphs = Object.values(EFFECT_GLYPHS);
    expect(new Set(glyphs).size).toBe(glyphs.length);
  });

  it('a relic wears its line\'s glyph until its picture is listed (56-k)', () => {
    expect(iconGlyph('relic_last_word')).toBe(iconGlyph('pistol_service'));
    expect(iconGlyph('relic_cold_coil')).toBe(iconGlyph('mg_scrap'));
    expect(iconGlyph('relic_seeker')).toBe(iconGlyph('launcher_rocket'));
    expect(itemIconSource('relic_seeker', new Set())).toEqual({ kind: 'glyph', glyph: iconGlyph('launcher_rocket') });
  });
});
