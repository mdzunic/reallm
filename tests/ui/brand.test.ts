// SPEC-073 §4.1, §7 — the drawn marks: the wordmark's box and strokes, the
// reticle's colours, and a brand heading that still reads "ReaLLM".
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WORDMARK_PATHS, WORDMARK_VIEWBOX, brandHeading, reticle, wordmark } from '@/ui/brand';

const CSS = readFileSync(new URL('../../src/style.css', import.meta.url).pathname, 'utf8');
const FAVICON = readFileSync(new URL('../../public/favicon.svg', import.meta.url).pathname, 'utf8');

class FakeNode {
  readonly tag: string;
  readonly attributes = new Map<string, string>();
  readonly classes = new Set<string>();
  children: FakeNode[] = [];
  className = '';
  textContent = '';
  readonly classList = { add: (name: string): void => void this.classes.add(name) };
  constructor(tag: string) {
    this.tag = tag;
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  append(...nodes: FakeNode[]): void {
    this.children.push(...nodes);
  }
  replaceChildren(...nodes: FakeNode[]): void {
    this.children = [...nodes];
  }
}

beforeEach(() => {
  vi.stubGlobal('document', {
    createElement: (tag: string) => new FakeNode(tag),
    createElementNS: (_ns: string, tag: string) => new FakeNode(tag),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the wordmark (SPEC-073 §4.1)', () => {
  it('is six stroked letters on a 205 × 40 box', () => {
    expect(WORDMARK_VIEWBOX).toBe('0 0 205 40');
    expect(WORDMARK_PATHS).toHaveLength(6);
    const svg = wordmark() as unknown as FakeNode;
    expect(svg.attributes.get('viewBox')).toBe(WORDMARK_VIEWBOX);
    expect(svg.attributes.get('aria-hidden')).toBe('true');
    expect(svg.children).toHaveLength(6);
    // Each letter sits right of the last, inside the box.
    const xs = WORDMARK_PATHS.map((letter) => letter.x);
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
    expect(Math.max(...xs)).toBeLessThan(205);
  });

  it('is stroked in --ink, 6 units wide, with mitred joins', () => {
    expect(CSS).toMatch(/\.brand-wordmark\s*\{[^}]*stroke:\s*var\(--ink\);[^}]*stroke-width:\s*6;[^}]*stroke-linejoin:\s*miter/);
  });
});

describe('the reticle (SPEC-073 §4.1)', () => {
  it("is the favicon's geometry, ring and ticks in the accent", () => {
    const svg = reticle() as unknown as FakeNode;
    expect(svg.attributes.get('viewBox')).toBe('0 0 64 64');
    expect(svg.children.map((child) => child.attributes.get('class'))).toEqual(['ring', 'pip', 'ticks']);
    expect(svg.children[2]?.attributes.get('d')).toBe('M32 6v8M32 50v8M6 32h8M50 32h8');
    expect(FAVICON).toContain('M32 6v8M32 50v8M6 32h8M50 32h8');
    expect(FAVICON).toContain('#4c9aff');
    expect(FAVICON).not.toContain('#39c5cf');
    expect(CSS).toMatch(/\.brand-mark \.ring,\s*\.brand-mark \.ticks\s*\{[^}]*stroke:\s*var\(--accent\)/);
  });
});

describe('brandHeading (SPEC-073 §4.1)', () => {
  it('fills the heading with the lockup and keeps "ReaLLM" as its text', () => {
    const heading = new FakeNode('h1');
    brandHeading(heading as unknown as HTMLElement);
    expect(heading.classes.has('brand-lockup')).toBe(true);
    expect(heading.children.map((child) => child.attributes.get('class') ?? child.className)).toEqual([
      'brand-mark',
      'brand-wordmark',
      'sr-only',
    ]);
    expect(heading.children[2]?.textContent).toBe('ReaLLM');
  });
});
