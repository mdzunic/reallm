// The drawn brand marks (SPEC-073 §4.1, PLAN R30 decision 2). The wordmark is
// stroked paths, not type: the game loads no webfont (SPEC-020 AC-26), and a
// drawn mark reads the same on every system. The reticle is the favicon's own
// geometry, so the mark in the tab, on the home screen and in the game agree.
//
// Both are decoration: a heading that carries them keeps "ReaLLM" as its text,
// visually hidden, which is what assistive tech and the suites read.

const SVG_NS = 'http://www.w3.org/2000/svg';

/** The wordmark's design box: a 40-unit cap height, 205 units wide. */
export const WORDMARK_VIEWBOX = '0 0 205 40';

/**
 * R e a L L M, each a 6-unit stroke with 45° chamfers that echo the frame's
 * `--frame-cut`, placed at `x` along the line.
 */
export const WORDMARK_PATHS: readonly { readonly x: number; readonly d: string }[] = [
  { x: 0, d: 'M3 40V3H22L27 8V15L22 20H3M19 20L27 28V40' },
  { x: 37, d: 'M3 27H25V21L20 16H8L3 21V32L8 37H25' },
  { x: 71, d: 'M4 16H20L25 21V40M25 26H7L3 30V33L7 37H25' },
  { x: 106, d: 'M3 0V37H24' },
  { x: 138, d: 'M3 0V37H24' },
  { x: 171, d: 'M3 40V3H8L17 16L26 3H31V40' },
];

function svg(viewBox: string, className: string): SVGSVGElement {
  const node = document.createElementNS(SVG_NS, 'svg');
  node.setAttribute('class', className);
  node.setAttribute('viewBox', viewBox);
  node.setAttribute('aria-hidden', 'true');
  node.setAttribute('focusable', 'false');
  return node;
}

function child(parent: SVGElement, tag: string, attrs: Record<string, string>): void {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  parent.append(node);
}

/** `public/favicon.svg`'s mark without its field: ring and ticks in `--accent`, the pip in `--ink`. */
export function reticle(className = 'brand-mark'): SVGSVGElement {
  const node = svg('0 0 64 64', className);
  child(node, 'circle', { class: 'ring', cx: '32', cy: '32', r: '18' });
  child(node, 'circle', { class: 'pip', cx: '32', cy: '32', r: '6' });
  child(node, 'path', { class: 'ticks', d: 'M32 6v8M32 50v8M6 32h8M50 32h8' });
  return node;
}

/** The drawn wordmark, stroked in `--ink` by the stylesheet. */
export function wordmark(): SVGSVGElement {
  const node = svg(WORDMARK_VIEWBOX, 'brand-wordmark');
  for (const { x, d } of WORDMARK_PATHS) {
    child(node, 'path', x === 0 ? { d } : { d, transform: `translate(${x} 0)` });
  }
  return node;
}

/** Fills `heading` with the lockup — reticle and wordmark — keeping "ReaLLM" as its text. */
export function brandHeading(heading: HTMLElement, name = 'ReaLLM'): void {
  const label = document.createElement('span');
  label.className = 'sr-only';
  label.textContent = name;
  heading.classList.add('brand-lockup');
  heading.replaceChildren(reticle(), wordmark(), label);
}
