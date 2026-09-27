// SPEC-034 §4.11 — the stylesheet's top-level selectors, read off the text.
//
// The review found four overlays sharing two class names: the awakening burst
// and the flight ion-storm sheet both wore `.hud-static`, and the surface storm
// vignette and the flight storm warning both wore `.hud-storm`. Because CSS
// takes the later rule, each pair's second definition silently restyled the
// first — the static burst every awakening beat fires was invisible for it.
//
// A duplicate top-level selector list is therefore treated as the defect it was.
// Intended repeats — a `@media` or `@supports` override, and the
// `html.reduce-motion` variants — are allow-listed by selector.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const CSS = readFileSync(new URL('../../src/style.css', import.meta.url).pathname, 'utf8');

/**
 * Every top-level rule's selector list, normalised: comments and at-rule
 * blocks removed, whitespace collapsed. A rule inside `@media`, `@supports` or
 * `@keyframes` is not top-level — those are the intended overrides.
 */
export function topLevelSelectors(css: string): string[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  let atRuleDepth = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') {
      if (depth === 0) {
        const head = text.slice(start, i).trim().replace(/\s+/g, ' ');
        if (head.startsWith('@')) atRuleDepth = 0;
        else out.push(head);
      }
      depth++;
      continue;
    }
    if (ch === '}') {
      depth--;
      if (depth === 0) {
        atRuleDepth = -1;
        start = i + 1;
      }
      continue;
    }
    if (depth === 0 && (ch === ';' || ch === '\n')) {
      if (text.slice(start, i + 1).trim() === '') start = i + 1;
    }
    void atRuleDepth;
  }
  return out.filter((head) => head !== '' && !head.startsWith('@'));
}

/**
 * §4.11: selector lists a top-level rule is allowed to repeat. Each entry is a
 * deliberate second pass over the same elements in a different part of the
 * sheet — not a role two different elements share.
 */
const ALLOWED_REPEATS: readonly string[] = [
  '*',
  '*, *::before, *::after',
  'html.reduce-motion',
  // The two additive blocks the specs open in turn rather than restyle: the
  // SPEC-001 bootstrap's tokens and root layer, extended by SPEC-014's.
  ':root',
  '#ui',
];

describe('src/style.css top-level selectors (SPEC-034 §4.11)', () => {
  it('defines each one exactly once, outside the allow-list', () => {
    const counts = new Map<string, number>();
    for (const selector of topLevelSelectors(CSS)) {
      counts.set(selector, (counts.get(selector) ?? 0) + 1);
    }
    const duplicates: string[] = [];
    for (const [selector, count] of counts) {
      if (count > 1 && !ALLOWED_REPEATS.includes(selector)) duplicates.push(`${selector} × ${count}`);
    }
    expect(duplicates).toEqual([]);
  });

  it('gives each of the four overlays of §4.11 its own class', () => {
    // The awakening burst: the alphas of §4.11, shown by `.hud.is-static`.
    expect(CSS).toMatch(/\.hud-static\s*\{[\s\S]*?rgba\(255, 255, 255, 0\.14\)[\s\S]*?rgba\(160, 200, 255, 0\.05\)/);
    expect(CSS).toMatch(/\.hud\.is-static \.hud-static\s*\{/);
    // The surface storm vignette is radial, and nothing later overrides it.
    expect(CSS).toMatch(/\.hud-storm\s*\{[\s\S]*?radial-gradient/);
    // The storm warning pill and the flight ion sheet now stand alone.
    expect(CSS).toMatch(/\.hud-storm-warn\s*\{/);
    expect(CSS).toMatch(/\.hud-ion\s*\{[\s\S]*?rgba\(160, 190, 220, 0\.06\)/);
  });
});
