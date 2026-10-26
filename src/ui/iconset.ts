// The drawn icon set (SPEC-073 §3, PLAN R30 decision 3). One table of paths on
// a 24 grid — 2 px stroke, square caps, mitred joins — drawn two ways: inline
// as an `svg.ico` where an element wants a picture, and as a CSS mask over a
// glyph's own text where the UI prints a glyph.
//
// The glyph strings stay what they were. Systems, saves, toasts and the e2e
// suites print and read `◈`, `▲`, `🛢`; `glyphEl` keeps that character as the
// span's text and only the stylesheet's `@supports` rule paints the icon over
// it, so a browser without masks shows the old glyph (E139).
import { GLYPHS } from '@/data/glossary';
import { RESOURCE_GLYPHS } from '@/ui/glyphs';

export type IconName =
  | 'tokens'
  | 'oil'
  | 'wheat'
  | 'water'
  | 'lithium'
  | 'health'
  | 'shield'
  | 'hull'
  | 'armor'
  | 'warn'
  | 'good'
  | 'error'
  | 'better'
  | 'worse'
  | 'lock'
  | 'heal'
  | 'hazard'
  | 'damage'
  | 'explosive'
  | 'light'
  | 'stamina'
  | 'missions'
  | 'shop'
  | 'character'
  | 'depot'
  | 'starmap'
  | 'settings'
  | 'comms'
  | 'quit'
  | 'pause'
  | 'back'
  | 'resume'
  | 'controls'
  | 'handgun'
  | 'rifle'
  | 'machine_gun'
  | 'launcher'
  | 'timer'
  | 'boss'
  | 'marine'
  | 'engineer'
  | 'scout';

/** §3: each icon's paths on the 24 × 24 grid — the design system's `assets/Icons/`, plus seven. */
export const ICON_PATHS: Readonly<Record<IconName, readonly string[]>> = {
  tokens: ['M12 3l7.5 4.5v9L12 21l-7.5-4.5v-9z', 'M12 8.5l3 3.5-3 3.5-3-3.5z'],
  oil: ['M8 3h8l1.5 2.5v13L16 21H8l-1.5-2.5v-13z', 'M6.5 9h11', 'M6.5 15h11'],
  wheat: [
    'M12 21V9',
    'M12 9C9.5 8.5 8 6.7 8 4c2.5.4 4 2.2 4 5z',
    'M12 9c2.5-.5 4-2.3 4-5-2.5.4-4 2.2-4 5z',
    'M12 14.5c-2.5-.5-4-2.3-4-5 2.5.4 4 2.2 4 5z',
    'M12 14.5c2.5-.5 4-2.3 4-5-2.5.4-4 2.2-4 5z',
  ],
  water: ['M12 3c3.2 4.2 6 7.6 6 11a6 6 0 0 1-12 0c0-3.4 2.8-6.8 6-11z'],
  lithium: ['M13 3 6 13h5l-1 8 7-10h-5z'],
  health: ['M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z'],
  shield: ['M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6z'],
  hull: ['M12 3l7 17-7-4-7 4z'],
  armor: ['M5 5h14v14H5z', 'M9 9h6v6H9z'],
  warn: ['M12 4l9 16H3z', 'M12 10v4.5', 'M12 17v1'],
  good: ['M5 12.5l4.5 4.5L19 7.5'],
  error: ['M6 6l12 12', 'M18 6 6 18'],
  better: ['M12 20V5', 'M6 11l6-6 6 6'],
  worse: ['M12 4v15', 'M6 13l6 6 6-6'],
  lock: ['M6 11h12v9H6z', 'M9 11V8a3 3 0 0 1 6 0v3'],
  heal: ['M10 4h4v6h6v4h-6v6h-4v-6H4v-4h6z'],
  hazard: ['M4 13a8 8 0 0 1 16 0z', 'M12 13v6a2 2 0 0 1-4 0', 'M12 3v2'],
  damage: ['M6 14l6-6 6 6', 'M6 20l6-6 6 6', 'M12 3v2'],
  explosive: ['M12 3l2 5 5-2-2 5 5 2-5 2 2 5-5-2-2 5-2-5-5 2 2-5-5-2 5-2-2-5 5 2z'],
  light: [
    'M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8z',
    'M12 2v3',
    'M12 19v3',
    'M2 12h3',
    'M19 12h3',
    'M5 5l2 2',
    'M17 17l2 2',
    'M19 5l-2 2',
    'M7 17l-2 2',
  ],
  stamina: ['M5 6l6 6-6 6', 'M12 6l6 6-6 6'],
  missions: ['M6 4h12v16H6z', 'M9 9h6', 'M9 13h6', 'M9 17h3'],
  shop: ['M4 8l8-4 8 4v10l-8 4-8-4z', 'M4 8l8 4 8-4', 'M12 12v10'],
  character: ['M7 10a5 5 0 0 1 10 0v4H7z', 'M9 11h6', 'M5 21c1-3.5 3.8-5 7-5s6 1.5 7 5'],
  depot: ['M3 11h8v9H3z', 'M13 11h8v9h-8z', 'M8 3h8v8H8z'],
  starmap: ['M12 9a3 3 0 1 1 0 6 3 3 0 0 1 0-6z', 'M3.5 12a8.5 4 -20 1 0 17 0 8.5 4 -20 1 0 -17 0', 'M19.5 5.5v.5'],
  settings: ['M4 7h10', 'M18 7h2', 'M4 17h2', 'M10 17h10', 'M14 4v6', 'M6 14v6'],
  comms: ['M12 12v9', 'M8.5 21h7', 'M8 8a5.5 5.5 0 0 1 8 0', 'M5 5a10 10 0 0 1 14 0', 'M12 11.5v.5'],
  quit: ['M10 4H5v16h5', 'M14 8l4 4-4 4', 'M18 12H9'],
  pause: ['M8 5v14', 'M16 5v14'],
  back: ['M15 5l-7 7 7 7'],
  resume: ['M8 5l9 7-9 7z'],
  controls: ['M3 7h18v10H3z', 'M7 11h2', 'M15 11h2', 'M8 14h8'],
  handgun: ['M3 7h15v4H9l-1 7H5l1-7H3z', 'M18 9h3'],
  rifle: ['M2 10h17v3H9l-2 5H4l1-5H2z', 'M19 11.5h3', 'M12 7h4v3'],
  machine_gun: ['M2 9h18v4H2z', 'M20 11h2', 'M6 13v5h3v-5', 'M12 13v3'],
  launcher: ['M2 8h16v6H2z', 'M18 9l4-1v6l-4-1', 'M7 14v4h3v-4'],
  timer: ['M12 21a8 8 0 1 0 0-16 8 8 0 0 0 0 16z', 'M12 9v4l3 2', 'M10 2h4'],
  boss: ['M5 11a7 7 0 0 1 14 0v4l-2 2v3H7v-3l-2-2z', 'M9 12h1.5', 'M13.5 12H15'],
  marine: ['M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6z', 'M8.5 9.5l3.5 2.5 3.5-2.5', 'M8.5 13.5l3.5 2.5 3.5-2.5'],
  engineer: ['M15 4a4.5 4.5 0 0 0-5.2 6L4 15.8V20h4.2l5.8-5.8A4.5 4.5 0 0 0 20 9l-3 3-3-1-1-3z'],
  scout: ['M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18z', 'M12 7a5 5 0 1 0 5 5', 'M12 12l6-6'],
};

/**
 * §3: every glyph the UI prints, to its icon — the glossary, the resources,
 * the consumable effects and weapon lines of `ui/icons.ts`, and the star
 * map's lock. A trailing U+FE0F (the emoji presentation selector) is ignored.
 */
export const GLYPH_ICONS: Readonly<Record<string, IconName>> = {
  [GLYPHS.tokens]: 'tokens',
  [GLYPHS.shield]: 'shield',
  [GLYPHS.armor]: 'armor',
  [GLYPHS.warn]: 'warn',
  [GLYPHS.good]: 'good',
  [GLYPHS.error]: 'error',
  [GLYPHS.better]: 'better',
  [GLYPHS.worse]: 'worse',
  [GLYPHS.health]: 'health',
  [GLYPHS.hull]: 'hull',
  [RESOURCE_GLYPHS.oil]: 'oil',
  [RESOURCE_GLYPHS.wheat]: 'wheat',
  [RESOURCE_GLYPHS.water]: 'water',
  [RESOURCE_GLYPHS.lithium]: 'lithium',
  '🔒': 'lock',
  '✚': 'heal',
  '☂': 'hazard',
  '↯': 'damage',
  '✸': 'explosive',
  '☼': 'light',
  '»': 'stamina',
  '⌐': 'handgun',
  '⌖': 'rifle',
  '☰': 'machine_gun',
  '⚟': 'launcher',
};

const VARIATION = /️/g;

/** The icon a glyph draws as, or null for a glyph outside the table (E139). */
export function iconForGlyph(glyph: string): IconName | null {
  return GLYPH_ICONS[glyph.replace(VARIATION, '')] ?? null;
}

/** One alternation of every glyph, longest first, each optionally followed by U+FE0F. */
const GLYPH_PATTERN = new RegExp(
  `(${Object.keys(GLYPH_ICONS)
    .sort((a, b) => b.length - a.length)
    .map((glyph) => glyph.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')})\\uFE0F?`,
  'gu',
);

const urls = new Map<IconName, string>();

/** §3: `url("data:image/svg+xml,…")` — the icon as a mask, stroked black on clear. Memoised. */
export function iconUrl(name: IconName): string {
  let url = urls.get(name);
  if (url === undefined) {
    const paths = ICON_PATHS[name].map((d) => `<path d='${d}'/>`).join('');
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='square' stroke-linejoin='miter'>${paths}</svg>`;
    url = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
    urls.set(name, url);
  }
  return url;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** An inline `svg.ico`, stroked in `currentColor` by the stylesheet; decorative. */
export function iconSvg(name: IconName, className = 'ico'): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of ICON_PATHS[name]) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

function paint(span: HTMLSpanElement, name: IconName): HTMLSpanElement {
  span.dataset['icon'] = name;
  span.setAttribute('style', `--icon: ${iconUrl(name)}`);
  return span;
}

/** `span.glyph` holding `glyph`: the icon over it when the glyph has one, the glyph alone when not. */
export function glyphEl(glyph: string): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = 'glyph';
  span.textContent = glyph;
  const name = iconForGlyph(glyph);
  return name === null ? span : paint(span, name);
}

/** An icon with no glyph text — a tab's or a key's picture — hidden from assistive tech. */
export function iconEl(name: IconName): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = 'glyph';
  span.setAttribute('aria-hidden', 'true');
  return paint(span, name);
}

/**
 * `text` split around every known glyph, each glyph as `glyphEl`: appended in
 * order, the nodes' text is `text` again, so assertions on text still hold.
 */
export function glyphNodes(text: string): Array<string | HTMLSpanElement> {
  const out: Array<string | HTMLSpanElement> = [];
  let at = 0;
  for (const match of text.matchAll(GLYPH_PATTERN)) {
    const index = match.index ?? 0;
    if (index > at) out.push(text.slice(at, index));
    out.push(glyphEl(match[0]));
    at = index + match[0].length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

/** Writes `text` into `node` through `glyphNodes`, skipping the work when the text is unchanged. */
export function setGlyphText(node: HTMLElement, text: string): void {
  if (node.textContent === text) return;
  node.replaceChildren(...glyphNodes(text));
}
