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
import { PLANETS } from '@/data/index';
import { compositeOver, contrastRatio } from '@/systems/UiHelpers';

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
    // SPEC-031 AC-22: the button is a console key now — a flat --key-face with
    // a --frame-edge hairline; the accent moved to the active underline.
    expect(CSS).toMatch(/\.ui-btn\s*\{[^}]*background:\s*var\(--key-face\)/);
    expect(CSS).toMatch(/\.ui-btn\s*\{[^}]*border:\s*1px solid var\(--frame-edge\)/);
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
    // The app UI's floor is `#ui`'s own `clamp(14px, …)`. SPEC-037 §4.12
    // replaced the count of literals under it (24, the dev overlay, notes,
    // hints and the quick bar's 8 px badges among them) with a floor under the
    // literals themselves: none is below 11 px (§4.4) — the SPEC-037 block
    // below pins it.
    const small = CSS.match(/font-size:\s*(\d+(?:\.\d+)?)px/g) ?? [];
    expect(small.length).toBeGreaterThan(0);
    const belowFloor = small.filter((rule) => Number(/([\d.]+)/.exec(rule)?.[1] ?? 99) < 11);
    expect(belowFloor, belowFloor.join(' ')).toEqual([]);
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

// ------------------------------------------------------------------ SPEC-031

/** SPEC-031 §4.7: the frame tokens the console shell reads. */
const SHELL_TOKENS = [
  '--screen-scrim',
  '--frame-edge',
  '--frame-cut',
  '--rule',
  '--type-xs',
  '--type-sm',
  '--type-md',
  '--type-lg',
  '--type-xl',
  '--track',
  '--key-face',
] as const;

/** The marked shell block appended by SPEC-031. */
function shellBlock(): string {
  const start = CSS.indexOf('/* ================================================================ SPEC-031 */');
  const end = CSS.indexOf('/* SPEC-031:end */');
  expect(start, 'the SPEC-031 shell block').toBeGreaterThan(-1);
  expect(end, 'the SPEC-031 end marker').toBeGreaterThan(start);
  return CSS.slice(start, end);
}

describe('the console shell tokens (SPEC-031 AC-20)', () => {
  it('declares each token exactly once in :root and reads each through var()', () => {
    const root = rootBlock();
    for (const token of SHELL_TOKENS) {
      expect(declarations(token, root), `${token} in :root`).toBe(1);
      expect(declarations(token), `${token} declarations`).toBe(1);
      expect(references(token), `${token} references`).toBeGreaterThanOrEqual(1);
    }
  });

  it('hard-codes no colour and no font size inside the shell block', () => {
    const shell = shellBlock();
    expect(shell).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(shell).not.toMatch(/(?<![-\w])rgb\(/);
    expect(shell).not.toMatch(/(?<![-\w])rgba\(/);
    expect(shell).not.toMatch(/font-size:\s*\d/);
  });

  it('tracks headings and keys at the shared token', () => {
    expect(tokenValue('--track')).toBe('0.12em');
    expect(CSS).toMatch(/\.ui-btn\s*\{[^}]*letter-spacing:\s*var\(--track\)/);
    expect(CSS).toMatch(/\.ui-btn\s*\{[^}]*text-transform:\s*uppercase/);
  });
});

describe('the homeless elements (SPEC-031 §4.8)', () => {
  it('drops the .station-root grid and its 120 px offset entirely', () => {
    expect(CSS).not.toContain('.station-root');
  });

  it('lets the save panel be laid out by the menu, not by itself', () => {
    const at = CSS.indexOf('.save-panel {');
    expect(at).toBeGreaterThan(-1);
    const block = CSS.slice(at, CSS.indexOf('}', at));
    expect(block).not.toContain('position: absolute');
    expect(block).not.toContain('z-index');
  });

  it('hides the scene tag without ?debug and shows it with it', () => {
    const at = CSS.indexOf('.scene-tag {');
    expect(at).toBeGreaterThan(-1);
    const block = CSS.slice(at, CSS.indexOf('}', at));
    expect(block).toContain('opacity: 0;');
    expect(CSS).toMatch(/html\.debug \.scene-tag\s*\{[^}]*opacity:/);
  });

  it('puts the scrim between the backdrop and the frame', () => {
    expect(CSS).toMatch(/\.screen::before\s*\{[^}]*background:\s*var\(--screen-scrim\)/);
  });
});

// ------------------------------------------------------------------ SPEC-037

/** One rule of the sheet: its selector (prelude), its body, and the at-rules it sits in. */
interface Rule {
  selector: string;
  body: string;
  within: string[];
}

/** Every rule, with the at-rule preludes around it — comments stripped first. */
function allRules(): Rule[] {
  const code = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: Rule[] = [];
  const stack: string[] = [];
  let prelude = '';
  let body = '';
  let inRule = false;
  for (const char of code) {
    if (char === '{') {
      const text = prelude.trim().replace(/\s+/g, ' ');
      if (text.startsWith('@')) {
        stack.push(text);
      } else {
        inRule = true;
        body = '';
        stack.push(text);
      }
      prelude = '';
      continue;
    }
    if (char === '}') {
      const top = stack.pop() ?? '';
      if (inRule) {
        out.push({ selector: top, body, within: stack.filter((entry) => entry.startsWith('@')) });
        inRule = false;
      }
      prelude = '';
      continue;
    }
    if (inRule) body += char;
    else prelude += char;
  }
  return out;
}

/** The rules whose selector list names `selector` exactly. */
function rulesFor(selector: string): Rule[] {
  return allRules().filter((rule) => rule.selector.split(',').map((part) => part.trim()).includes(selector));
}

/** A colour token's value as `#rrggbb`, for the WCAG helpers. */
function hexToken(token: string): string {
  const value = tokenValue(token);
  expect(value, token).toMatch(/^#[0-9a-f]{6}$/i);
  return value;
}

describe('the HUD plate reads over every ground (SPEC-037 §4.5, AC-23)', () => {
  it('is rgba(4, 6, 10, 0.75), declared in :root with the halo', () => {
    expect(tokenValue('--hud-plate')).toBe('rgba(4, 6, 10, 0.75)');
    expect(tokenValue('--hud-halo')).toBe('0 0 2px #000, 1px 1px 0 #000, -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000');
  });

  it('keeps --ink, --warn and --good at 4.5 : 1 or better over every planet ground', () => {
    const plate = tokenValue('--hud-plate');
    const problems: string[] = [];
    for (const planet of Object.values(PLANETS)) {
      const ground = planet.surface.palette.ground;
      const under = compositeOver(plate, ground);
      for (const token of ['--ink', '--warn', '--good']) {
        const ratio = contrastRatio(hexToken(token), under);
        if (ratio < 4.5) problems.push(`${token} on ${planet.id} (${ground} → ${under}): ${ratio.toFixed(2)}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('keeps the state line at 4.5 : 1 on its band, over the slot base, over every ground', () => {
    const band = /background:\s*(rgba\([^)]*\))/.exec(rulesFor('.qb-state')[0]?.body ?? '')?.[1];
    expect(band, 'the .qb-state band').toBe('rgba(0, 0, 0, 0.8)');
    const slot = rulesFor('.qb-slot')[0]?.body ?? '';
    const base = /conic-gradient\([^;]*?(rgba\([^)]*\))\s*0\)/.exec(slot)?.[1];
    expect(base, 'the .qb-slot base').toBe('rgba(0, 0, 0, 0.55)');
    const problems: string[] = [];
    for (const planet of Object.values(PLANETS)) {
      const under = compositeOver(band as string, compositeOver(base as string, planet.surface.palette.ground));
      for (const token of ['--ink', '--warn', '--hp']) {
        const ratio = contrastRatio(hexToken(token), under);
        if (ratio < 4.5) problems.push(`${token} on ${planet.id}: ${ratio.toFixed(2)}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('backs the top-left column, the wallet, the banners, the prompt, the tip strip and the flight lines', () => {
    for (const selector of [
      '.hud-tl',
      '.hud-wallet',
      '.hud-weather',
      '.hud-shelter',
      '.hud-interact',
      '.aria-hint',
      '.hud-objective',
      '.hud-storm-warn',
      '.hud-holding',
    ]) {
      const bodies = rulesFor(selector).map((rule) => rule.body);
      expect(
        bodies.some((body) => /background:\s*var\(--hud-plate\)/.test(body)),
        `${selector} sits on --hud-plate`,
      ).toBe(true);
    }
  });

  it('dresses the text with no plate under it in the halo (§4.5)', () => {
    // SPEC-042 §4.9: the boss frame's name took the place of the boss row's.
    for (const selector of ['.waypoint-dist', '.dmg', '.hud-hostiles', '.boss-frame-name', '.qb-count']) {
      const bodies = rulesFor(selector).map((rule) => rule.body);
      expect(
        bodies.some((body) => /text-shadow:\s*var\(--hud-halo\)/.test(body)),
        `${selector} wears --hud-halo`,
      ).toBe(true);
    }
  });
});

describe('the text floor, the hover rule and the selection rules (SPEC-037 §4.4, §4.9)', () => {
  it('has no font-size literal below 11 px (AC-21)', () => {
    const literals = [...CSS.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1]));
    expect(literals.length).toBeGreaterThan(20);
    expect(literals.filter((px) => px < 11)).toEqual([]);
  });

  it('puts every :hover selector inside @media (hover: hover) (AC-33)', () => {
    const hovers = allRules().filter((rule) => rule.selector.includes(':hover'));
    expect(hovers.length).toBeGreaterThan(0);
    const outside = hovers.filter((rule) => !rule.within.includes('@media (hover: hover)')).map((rule) => rule.selector);
    expect(outside).toEqual([]);
    // A mixed list was split, not moved whole: focus, active and pressed keep
    // their underline outside the query.
    expect(rulesFor('.ui-btn:focus-visible').some((rule) => rule.within.length === 0)).toBe(true);
    expect(rulesFor(".ui-btn[aria-pressed='true']").some((rule) => rule.within.length === 0)).toBe(true);
  });

  it('declares the four selection rules on #ui, and lets the code fields select (AC-31)', () => {
    const ui = rulesFor('#ui').map((rule) => rule.body).join(';');
    expect(ui).toMatch(/(^|[;\s])user-select:\s*none/);
    expect(ui).toMatch(/-webkit-user-select:\s*none/);
    expect(ui).toMatch(/-webkit-touch-callout:\s*none/);
    expect(ui).toMatch(/-webkit-tap-highlight-color:\s*transparent/);
    for (const field of ['.credits-text', '.settings-code', '.menu-code', '.slot-code']) {
      const selectable = allRules().some(
        (rule) =>
          rule.selector.split(',').some((part) => part.trim().endsWith(field)) && /(^|[;\s])user-select:\s*text/.test(rule.body),
      );
      expect(selectable, `${field} keeps user-select: text`).toBe(true);
    }
  });

  it('holds every text field in #ui at 16 px or more (AC-34)', () => {
    const rule = allRules().find((candidate) => candidate.selector.includes("#ui input:not([type='range'])"));
    expect(rule?.body).toMatch(/font-size:\s*max\(16px,\s*1em\)/);
    expect(rule?.selector).toContain('#ui textarea');
  });
});
