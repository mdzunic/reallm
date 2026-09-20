// SPEC-015 §6 — the viewport contract, read off `src/style.css` and
// `index.html` themselves.
//
// The safe-area rule (D-6) is the one worth a machine: `#ui` is a full-bleed
// `inset: 0` layer, so a blanket `padding: env(...)` on it would move every
// child twice. Instead each element anchored to a viewport edge clears that
// edge itself, with `max(Npx, env(safe-area-inset-*))`. That is a property of
// every rule in the sheet, and the only way to keep it true as rules are added
// is to fail a build that adds one without it.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const CSS = readFileSync(new URL('../../src/style.css', import.meta.url).pathname, 'utf8');
const HTML = readFileSync(new URL('../../index.html', import.meta.url).pathname, 'utf8');

/** The sheet with comments removed, so prose naming a property never matches. */
const CODE = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

interface Rule {
  selector: string;
  declarations: Record<string, string>;
}

/** Every top-level declaration block. Nested at-rules keep their inner blocks. */
function rules(): Rule[] {
  const out: Rule[] = [];
  for (const match of CODE.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = (match[1] as string).trim().replace(/\s+/g, ' ');
    const declarations: Record<string, string> = {};
    for (const part of (match[2] as string).split(';')) {
      const at = part.indexOf(':');
      if (at < 0) continue;
      declarations[part.slice(0, at).trim()] = part.slice(at + 1).trim();
    }
    out.push({ selector, declarations });
  }
  return out;
}

function block(selector: string): Record<string, string> {
  const found = rules().find((rule) => rule.selector === selector);
  expect(found, `a rule for ${selector}`).toBeDefined();
  return (found as Rule).declarations;
}

describe('the viewport shell (SPEC-015 §6)', () => {
  it('gives #game the dynamic viewport height and no touch gestures (AC-25)', () => {
    const game = block('#game');
    expect(game['position']).toBe('fixed');
    expect(game['height']).toBe('100dvh');
    expect(game['touch-action']).toBe('none');
  });

  it('keeps #ui a full-bleed, non-interactive, gesture-free layer (AC-25)', () => {
    const ui = block('#ui');
    expect(ui['position']).toBe('fixed');
    expect(ui['inset']).toBe('0');
    expect(ui['pointer-events']).toBe('none');
    expect(ui['touch-action']).toBe('none');
  });

  it('keeps html/body as shipped and adds overscroll containment (AC-26)', () => {
    const doc = block('html, body');
    expect(doc['margin']).toBe('0');
    expect(doc['height']).toBe('100%');
    expect(doc['overflow']).toBe('hidden');
    expect(doc['background']).toBe('#0b0f14');
    expect(doc['overscroll-behavior']).toBe('none');
  });
});

// --------------------------------------------------------------- safe areas

const EDGES = ['top', 'right', 'bottom', 'left'] as const;

/**
 * Rules whose edge offsets are measured from a *positioned ancestor*, not from
 * the viewport — so the safe area is already the ancestor's problem. Each one
 * names the box it sits in; a new entry is a deliberate claim, reviewed here.
 */
const NOT_VIEWPORT_ANCHORED: Readonly<Record<string, string>> = {
  '.qb-key': 'inside .qb-slot (position: relative)',
  '.starmap-lock': 'inside the .starmap-node button (position: absolute)',
  '.starmap-info': 'inside .starmap-root, in the console frame body',
  '.hud-reticle::after': 'inside .hud-reticle (position: absolute)',
  '.waypoint-dist': 'inside .waypoint (position: absolute)',
};

/** A centring or pull-back offset, not a gutter: `0`, `auto`, `50%`, negatives. */
function isGutter(value: string): boolean {
  if (value === '' || value === 'auto' || value === 'inherit' || value === 'unset') return false;
  if (/^0(px|%|em|rem)?$/.test(value)) return false;
  if (value === '50%') return false;
  if (value.startsWith('-')) return false;
  return true;
}

/** Split a shorthand on top-level whitespace — `max(10px, env(…))` is one part. */
function parts(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of value) {
    if (char === '(') depth++;
    else if (char === ')') depth--;
    if (/\s/.test(char) && depth === 0) {
      if (current !== '') out.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current !== '') out.push(current);
  return out;
}

/** The `inset` shorthand expanded to its four edges, in CSS's own order. */
function expandInset(value: string): Partial<Record<(typeof EDGES)[number], string>> {
  const p = parts(value);
  const [a, b, c, d] = p;
  if (p.length === 1) return { top: a, right: a, bottom: a, left: a };
  if (p.length === 2) return { top: a, right: b, bottom: a, left: b };
  if (p.length === 3) return { top: a, right: b, bottom: c, left: b };
  return { top: a, right: b, bottom: c, left: d };
}

/** Every `edge: <gutter>` in the sheet that is measured from the viewport. */
function edgeAnchored(): Array<{ selector: string; edge: (typeof EDGES)[number]; value: string }> {
  const out: Array<{ selector: string; edge: (typeof EDGES)[number]; value: string }> = [];
  for (const rule of rules()) {
    const position = rule.declarations['position'];
    if (position !== 'fixed' && position !== 'absolute') continue;
    if (rule.selector in NOT_VIEWPORT_ANCHORED) continue;
    const inset = rule.declarations['inset'];
    const shorthand = inset === undefined ? {} : expandInset(inset);
    for (const edge of EDGES) {
      // The longhand wins: CSS applies them in source order and every rule in
      // this sheet that writes both writes the longhand after the shorthand.
      const value = rule.declarations[edge] ?? shorthand[edge];
      if (value === undefined || !isGutter(value)) continue;
      out.push({ selector: rule.selector, edge, value });
    }
  }
  return out;
}

describe('safe areas are per element (SPEC-015 D-6, AC-27)', () => {
  it('finds edge-anchored rules at all, so a broken scanner cannot pass', () => {
    expect(edgeAnchored().length).toBeGreaterThan(20);
  });

  it('clears the inset on every edge a viewport-anchored element touches', () => {
    const offenders = edgeAnchored()
      .filter(({ edge, value }) => !value.includes(`env(safe-area-inset-${edge})`))
      .map(({ selector, edge, value }) => `${selector} { ${edge}: ${value} }`);
    expect(offenders).toEqual([]);
  });

  it('keeps the not-anchored list honest — every entry still exists', () => {
    const selectors = new Set(rules().map((rule) => rule.selector));
    for (const selector of Object.keys(NOT_VIEWPORT_ANCHORED)) {
      expect(selectors.has(selector), `${selector} is still in style.css`).toBe(true);
    }
  });
});

// --------------------------------------------------------------------- meta

describe('index.html (SPEC-015 §6, AC-28)', () => {
  it('covers the display cut-out and refuses pinch zoom', () => {
    const viewport = /<meta name="viewport" content="([^"]+)"/.exec(HTML)?.[1] ?? '';
    expect(viewport).toContain('viewport-fit=cover');
    expect(viewport).toContain('user-scalable=no');
    expect(viewport).toContain('width=device-width');
  });

  it('paints the chrome the same colour as the page (D-9)', () => {
    expect(HTML).toContain('<meta name="theme-color" content="#0b0f14" />');
    expect(CSS).toContain('background: #0b0f14');
  });

  it('carries the iOS standalone meta', () => {
    expect(HTML).toContain('<meta name="apple-mobile-web-app-capable" content="yes" />');
    expect(HTML).toContain('<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />');
  });

  it('links the 180 px apple-touch-icon', () => {
    expect(HTML).toMatch(/<link rel="apple-touch-icon" sizes="180x180" href="icons\/apple-touch-icon-180\.png"/);
  });
});
