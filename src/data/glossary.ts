// The glossary (SPEC-045 §4.6): the glyphs a player learns once and then reads
// on every screen, each with one meaning, and the quick slots' names as a
// player reads them. It lives in `data/` because both halves of the UI print
// from it — `systems/UiHelpers.ts` writes the tokens glyph into its lines and
// `ui/` the rest — and `systems/` may not import `ui/` (SPEC-001 §4).
//
// `tests/data/glossary.test.ts` fails any `.ts` file under `src/` but this one
// that writes a glyph below outside a comment, so a glyph cannot pick up a
// second meaning in a corner of the UI. CSS `content:` values are outside that
// scan; the wallet's at-cap `▲` there is a warning too.
//
// Data modules are plain objects: no imports but other data, no functions
// (SPEC-001 §4, §8).
import type { QuickSlot } from '@/data/items';

/** §4.6: one glyph, one meaning. */
export const GLYPHS = {
  /** `◈` tokens — not the tracked mission, and not a portrait (`PORTRAIT_GLYPHS[4]` is `❖`). */
  tokens: '◈',
  /** `⛨` the ship's shield. Armour has its own. */
  shield: '⛨',
  /** `▣` armour. */
  armor: '▣',
  /**
   * `▲` a warning: warn toasts, the flight's storm line, the wallet's at-cap
   * mark, `Wave incoming`. Never the active quick slot (a bar), the tracker's
   * bearing (a drawn arrow) or the touch throttle (`+` / `−`).
   */
  warn: '▲',
  /** `✓` good, or a requirement met. */
  good: '✓',
  /** `✗` an error, or a requirement unmet. */
  error: '✗',
  /** `↑` better for the player — a compare part (SPEC-042 §4.8). */
  better: '↑',
  /** `↓` worse for the player. */
  worse: '↓',
  /** `♥` the salvager's health. */
  health: '♥',
  /** `⛭` the ship's hull. */
  hull: '⛭',
} as const;

/**
 * §4.6: the quick slots as a player reads them — the picker's title, the
 * character panel's rows, the bar's labels. The third is a gadget wherever it
 * is read; its id stays `utility`, which the save and the bindings carry.
 */
export const QUICK_SLOT_NAMES: Readonly<Record<QuickSlot, string>> = {
  heal: 'Heal',
  explosive: 'Explosive',
  utility: 'Gadget',
};
