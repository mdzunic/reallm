// Portraits (SPEC-020 §4.6). The twelve busts `scripts/assets/blender/portraits.py`
// renders are optional art: the creation screen and the character panel show
// `assets/portraits/NN.webp` when the build wrote it, and the glyph they have
// always shown when it did not (20-d).
//
// `portraitSource` is pure, so the choice is testable without a DOM and without
// a network. What is left impure — one `fetch` of the manifest, memoised for
// the session — never throws, never blocks a screen, and is never part of the
// boot manifest (PLAN R6-5).

/** AC-15: the twelve faces, in the order `data/characters.ts` indexes them. */
export const PORTRAIT_GLYPHS = ['☉', '☍', '⚙', '✦', '◈', '⌬', '☄', '♆', '⚑', '◮', '⌘', '✧'] as const;

export type PortraitSource = { readonly kind: 'image'; readonly url: string } | { readonly kind: 'glyph'; readonly glyph: string };

const MANIFEST_URL = 'assets/portraits/manifest.json';

/** `assets/portraits/07.webp` for index 6 — the file names are 1-based. */
function urlFor(number: number): string {
  return `assets/portraits/${String(number).padStart(2, '0')}.webp`;
}

/** An index that is not one of the twelve still has to draw something. */
function glyphIndex(index: number): number {
  if (!Number.isFinite(index)) return 0;
  const count = PORTRAIT_GLYPHS.length;
  return ((Math.trunc(index) % count) + count) % count;
}

/**
 * §4.6: the image when `available` holds this portrait's file number, the
 * glyph otherwise. `available` is what `parsePortraitManifest` made of the
 * manifest — the empty set when there was none.
 */
export function portraitSource(index: number, available: ReadonlySet<number>): PortraitSource {
  const number = Math.trunc(index) + 1;
  if (Number.isFinite(index) && available.has(number)) return { kind: 'image', url: urlFor(number) };
  return { kind: 'glyph', glyph: PORTRAIT_GLYPHS[glyphIndex(index)] as string };
}

/**
 * The file numbers a manifest declares. Anything that is not an array of
 * positive integers is no manifest at all, and the screens fall back to glyphs
 * rather than to a broken `<img>` (20-d).
 */
export function parsePortraitManifest(value: unknown): ReadonlySet<number> {
  const out = new Set<number>();
  if (!Array.isArray(value)) return out;
  for (const entry of value) {
    if (typeof entry === 'number' && Number.isInteger(entry) && entry > 0) out.add(entry);
  }
  return out;
}

let pending: Promise<ReadonlySet<number>> | null = null;

/**
 * §4.6: fetch the manifest once per session. Absent, unreachable or malformed
 * all resolve to the empty set — never a rejection, never an error screen.
 */
export function portraitManifest(): Promise<ReadonlySet<number>> {
  pending ??= fetch(MANIFEST_URL)
    .then((response) => (response.ok ? (response.json() as Promise<unknown>) : null))
    .then(parsePortraitManifest)
    .catch(() => parsePortraitManifest(null));
  return pending;
}
