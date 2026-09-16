// Item pictures (SPEC-031 §4.14) — exactly the portrait pattern of SPEC-020
// §4.6, applied to the shelf. `itemIconSource` is pure; the one impure part —
// a single fetch of `assets/items/manifest.json`, memoised for the session —
// never rejects, never blocks a screen, and is never part of the boot
// manifest (AC-41).
import { COMPANIONS, ITEMS, type CompanionId, type ItemId } from '@/data/index';

export type IconSource =
  | { readonly kind: 'image'; readonly url: string }
  | { readonly kind: 'glyph'; readonly glyph: string };

export type IconId = ItemId | CompanionId;

const MANIFEST_URL = 'assets/items/manifest.json';

/** §4.13: one glyph per weapon line, for armor, per consumable effect, and for companions. */
const LINE_GLYPHS = {
  handgun: '⌐',
  rifle: '⌖',
  machine_gun: '☰',
  launcher: '⚟',
  armor: '⛨',
} as const;

const EFFECT_GLYPHS = {
  heal: '✚',
  hazard_immunity: '☂',
  damage_boost: '↯',
  explosive: '✸',
} as const;

const COMPANION_GLYPH = '⌬';

/**
 * §4.14: pure and total — every `ITEMS` and `COMPANIONS` id has a glyph
 * (guaranteed by the content test), so a new item without a render yet still
 * draws something (31-o).
 */
export function iconGlyph(id: IconId): string {
  if (Object.hasOwn(COMPANIONS, id)) return COMPANION_GLYPH;
  const item = ITEMS[id as ItemId];
  if (item === undefined) return COMPANION_GLYPH;
  if (item.kind === 'consumable') return EFFECT_GLYPHS[item.effect.kind];
  return LINE_GLYPHS[item.line];
}

/** §4.14: the image when the manifest listed this id, the glyph otherwise. */
export function itemIconSource(id: IconId, available: ReadonlySet<string>): IconSource {
  if (available.has(id)) return { kind: 'image', url: `assets/items/${id}.webp` };
  return { kind: 'glyph', glyph: iconGlyph(id) };
}

/**
 * The ids a manifest declares — `{"items": ["pistol_service", …]}`, written by
 * `items.py` from the files it actually rendered. Anything else is no manifest
 * at all, and the screens fall back to glyphs rather than to broken images.
 */
export function parseItemManifest(value: unknown): ReadonlySet<string> {
  const out = new Set<string>();
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return out;
  const items = (value as { items?: unknown }).items;
  if (!Array.isArray(items)) return out;
  for (const entry of items) {
    if (typeof entry === 'string' && entry !== '') out.add(entry);
  }
  return out;
}

let pending: Promise<ReadonlySet<string>> | null = null;
/** The resolved set, for synchronous readers once the fetch has landed. */
let resolved: ReadonlySet<string> | null = null;

/**
 * §4.14: fetch the manifest once per session. Absent, unreachable or
 * malformed all resolve to the empty set — never a rejection, and never a
 * second request (31-r, AC-40).
 */
export function itemManifest(): Promise<ReadonlySet<string>> {
  pending ??= fetch(MANIFEST_URL)
    .then((response) => (response.ok ? (response.json() as Promise<unknown>) : null))
    .then(parseItemManifest)
    .catch(() => parseItemManifest(null))
    .then((set) => {
      resolved = set;
      return set;
    });
  return pending;
}

/** What has resolved so far — the empty set while the fetch is in flight. */
export function itemManifestNow(): ReadonlySet<string> {
  return resolved ?? new Set();
}
