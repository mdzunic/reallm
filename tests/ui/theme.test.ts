// SPEC-020 §4.5 — the UI theme, read off the stylesheet itself.
//
// The theme's whole promise is that a retheme is a token swap: the eight new
// custom properties are declared once in the `:root` block and every rule that
// wears the look reaches them through `var()`. That is a property of the text
// of `src/style.css`, so the text is what this parses — along with the rules
// SPEC-014 pinned and this spec must leave alone (AC-25), and the contrast of
// body ink against the glass it now sits on (AC-24).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const CSS = readFileSync(new URL('../../src/style.css', import.meta.url).pathname, 'utf8');
const HTML = readFileSync(new URL('../../index.html', import.meta.url).pathname, 'utf8');

/** The eight §4.5 adds. `--accent` and `--accent-2` are distinct on purpose. */
const NEW_TOKENS = [
  '--panel-glass',
  '--edge-glow',
  '--accent',
  '--accent-2',
  '--bar-hp',
  '--bar-shield',
  '--bar-xp',
  '--text-glow',
] as const;

/** The `:root` block SPEC-014 opened and this spec extends. */
function rootBlock(): string {
  const at = CSS.indexOf(':root {\n  --hp:');
  expect(at, 'the SPEC-014 token block').toBeGreaterThan(-1);
  return CSS.slice(at, CSS.indexOf('}', at));
}

/** How many times a token is *declared* — `--accent:` never matches `--accent-2:`. */
function declarations(token: string, text: string = CSS): number {
  return text.match(new RegExp(`^\\s*${token}\\s*:`, 'gm'))?.length ?? 0;
}

/** How many times a token is *read* — `var(--accent)` never matches `var(--accent-2)`. */
function references(token: string): number {
  return CSS.match(new RegExp(`var\\(\\s*${token}\\s*[,)]`, 'g'))?.length ?? 0;
}

// ---------------------------------------------------------------- contrast

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function luminance([r, g, b]: readonly [number, number, number]): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** `over` composited under `rgba(...)`, so a translucent panel is judged as seen. */
function composite(rgba: readonly [number, number, number, number], over: readonly [number, number, number]): [number, number, number] {
  const alpha = rgba[3];
  return [0, 1, 2].map((i) => (rgba[i] as number) * alpha + (over[i] as number) * (1 - alpha)) as [number, number, number];
}

/** The value a token is declared with, read out of the `:root` block. */
function tokenValue(token: string): string {
  const match = new RegExp(`${token}\\s*:\\s*([^;]+);`).exec(rootBlock());
  expect(match, token).not.toBeNull();
  return (match?.[1] ?? '').trim();
}

function parseColor(value: string): [number, number, number, number] {
  const rgba = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+))?\s*\)/.exec(value);
  if (rgba) return [Number(rgba[1]), Number(rgba[2]), Number(rgba[3]), rgba[4] === undefined ? 1 : Number(rgba[4])];
  const hex = /#([0-9a-f]{6})/i.exec(value);
  if (!hex) throw new Error(`not a colour: ${value}`);
  const n = Number.parseInt(hex[1] as string, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
}

// -------------------------------------------------------------------- tests

describe('the theme tokens (SPEC-020 §4.5, AC-22)', () => {
  it('declares all eight in the :root block', () => {
    const root = rootBlock();
    for (const token of NEW_TOKENS) expect(declarations(token, root), token).toBe(1);
    // SPEC-014's own tokens are untouched beside them.
    for (const token of ['--hp', '--shield', '--warn', '--good', '--panel', '--panel-edge', '--ink', '--ink-dim']) {
      expect(declarations(token, root), token).toBe(1);
    }
  });

  it('declares each exactly once in the whole sheet and reads each at least once (AC-23)', () => {
    for (const token of NEW_TOKENS) {
      expect(declarations(token), `${token} declarations`).toBe(1);
      expect(references(token), `${token} references`).toBeGreaterThanOrEqual(1);
    }
  });

  it('dresses the panels, buttons, bars, toasts and the HUD through them (AC-23)', () => {
    // The glass and its lit edge reach the panel stack; the dialogue carries
    // `panel` in its markup, so it wears the same rule.
    expect(CSS).toMatch(/\.panel\s*\{[^}]*background:\s*var\(--panel-glass\)/);
    expect(CSS).toMatch(/\.panel\s*\{[^}]*var\(--edge-glow\)/);
    expect(CSS).toMatch(/\.toast\s*\{[^}]*background:\s*var\(--panel-glass\)/);
    expect(CSS).toMatch(/\.ui-btn\s*\{[^}]*background:\s*linear-gradient\([^;]*var\(--edge-glow\)/);
    expect(CSS).toMatch(/\.ui-btn\.is-primary\s*\{[^}]*border-color:\s*var\(--accent\)/);
    expect(CSS).toContain('.bar-hp { background: var(--bar-hp); }');
    expect(CSS).toContain('.bar-shield { background: var(--bar-shield); }');
    expect(CSS).toMatch(/\.bar-xp\s*\{\s*background:\s*var\(--bar-xp\)/);
    expect(CSS).toMatch(/\.hud-tokens\s*\{[^}]*color:\s*var\(--accent-2\)/);
    expect(CSS).toMatch(/\.menu-title\s*\{[^}]*text-shadow:\s*var\(--text-glow\)/);
  });

  it('drops the blur where transparency costs too much (20-a)', () => {
    expect(CSS).toContain('@media (prefers-reduced-transparency: reduce)');
    expect(CSS).toContain('html.quality-low .panel');
  });
});

describe('what the theme must not move (SPEC-020 AC-24 … AC-26)', () => {
  it('keeps body ink at 4.5 : 1 or better against the glass it sits on (AC-24)', () => {
    // The panel is translucent, so the ratio is measured against what the
    // player actually sees: the glass composited over the page's own black.
    const page = parseColor('#0b0f14');
    const glass = composite(parseColor(tokenValue('--panel-glass')), [page[0], page[1], page[2]]);
    expect(contrast(parseColor(tokenValue('--accent')).slice(0, 3) as [number, number, number], glass)).toBeGreaterThanOrEqual(4.5);
    for (const ink of ['--ink', '--ink-dim', '--accent-2']) {
      const colour = parseColor(tokenValue(ink)).slice(0, 3) as [number, number, number];
      expect(contrast(colour, glass), ink).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('keeps the touch floors, the font floor and the accessibility rules (AC-25)', () => {
    expect(CSS).toMatch(/\.ui-btn\s*\{[^}]*min-height:\s*44px/);
    expect(CSS).toMatch(/\.ui-btn\s*\{[^}]*min-width:\s*44px/);
    expect(CSS).toContain('font-size: clamp(14px, 1.6vmin + 8px, 18px)');
    expect(CSS).toContain('56px'); // the gameplay targets of SPEC-014 §4.10
    expect(CSS).toContain('user-select: none');
    expect(CSS).toContain('env(safe-area-inset-bottom)');
    expect(CSS).toContain('html.reduce-motion');
    // The app UI's floor is `#ui`'s own `clamp(14px, …)`; the thirteen smaller
    // rules below it are SPEC-014's dev overlay, notes and hints, and this
    // spec adds none — a theme that shrank type would show up here as a
    // fourteenth.
    const small = CSS.match(/font-size:\s*(\d+)px/g) ?? [];
    const belowFloor = small.filter((rule) => Number(/(\d+)/.exec(rule)?.[1] ?? 99) < 14);
    expect(belowFloor.length, belowFloor.join(' ')).toBe(13);
  });

  it('loads no webfont (AC-26)', () => {
    expect(CSS).not.toContain('@font-face');
    expect(CSS).not.toMatch(/@import\s+url\(/);
    expect(CSS + HTML).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
    expect(HTML).not.toMatch(/<link[^>]+\.woff2?/);
    // The system stack SPEC-014 chose is still what the body resolves to.
    expect(CSS).toContain("system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif");
  });
});
