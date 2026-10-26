// SPEC-073 §3, §7 — the drawn icon set: every glyph the UI prints has an
// icon, every icon is drawn on the 24 grid, and the glyph text survives.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COMPANIONS, ITEMS, type CompanionId, type ItemId } from '@/data/index';
import { GLYPHS } from '@/data/glossary';
import { RESOURCE_GLYPHS } from '@/ui/glyphs';
import { EFFECT_GLYPHS, iconGlyph } from '@/ui/icons';
import { GLYPH_ICONS, ICON_PATHS, glyphEl, glyphNodes, iconEl, iconForGlyph, iconSvg, iconUrl, type IconName } from '@/ui/iconset';

/** Just enough of an element for the helpers: text, classes, attributes, children. */
class FakeNode {
  readonly tag: string;
  readonly dataset: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  readonly children: (FakeNode | string)[] = [];
  className = '';
  textContent = '';
  constructor(tag: string) {
    this.tag = tag;
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  append(...nodes: (FakeNode | string)[]): void {
    this.children.push(...nodes);
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

const textOf = (node: FakeNode | string): string => (typeof node === 'string' ? node : node.textContent);

describe('GLYPH_ICONS (SPEC-073 §3)', () => {
  it('covers every glyph the glossary, the resources and the effects print', () => {
    for (const glyph of [...Object.values(GLYPHS), ...Object.values(RESOURCE_GLYPHS), ...Object.values(EFFECT_GLYPHS)]) {
      expect(iconForGlyph(glyph), glyph).not.toBeNull();
    }
    expect(iconForGlyph('🔒')).toBe('lock');
  });

  it("covers every item's fallback glyph; a companion's stays plain text (E139)", () => {
    for (const id of Object.keys(ITEMS) as ItemId[]) expect(iconForGlyph(iconGlyph(id)), id).not.toBeNull();
    for (const id of Object.keys(COMPANIONS) as CompanionId[]) expect(iconForGlyph(iconGlyph(id)), id).toBeNull();
  });

  it('ignores the emoji presentation selector and names only icons that exist', () => {
    expect(iconForGlyph(`${RESOURCE_GLYPHS.oil}️`)).toBe('oil');
    for (const name of Object.values(GLYPH_ICONS)) expect(ICON_PATHS[name], name).toBeDefined();
  });
});

describe('ICON_PATHS (SPEC-073 §3)', () => {
  it('holds the forty-two icons', () => {
    expect(Object.keys(ICON_PATHS)).toHaveLength(42);
  });

  it('draws every icon as plain path data on the 24 grid', () => {
    for (const [name, paths] of Object.entries(ICON_PATHS)) {
      expect(paths.length, name).toBeGreaterThan(0);
      for (const d of paths) {
        expect(d, name).toMatch(/^[MmLlHhVvCcSsQqAaZz0-9.\s,-]+$/);
        // Absolute coordinates stay on the grid; relative ones and arc radii are small.
        for (const number of d.match(/-?\d*\.?\d+/g) ?? []) expect(Math.abs(Number(number)), `${name}: ${d}`).toBeLessThanOrEqual(24);
      }
    }
  });

  it('makes a memoised mask URL of each icon', () => {
    const url = iconUrl('tokens');
    expect(url).toMatch(/^url\("data:image\/svg\+xml,/);
    expect(decodeURIComponent(url)).toContain("viewBox='0 0 24 24'");
    expect(iconUrl('tokens')).toBe(url);
  });
});

describe('the glyph helpers (SPEC-073 §3, E139)', () => {
  it('glyphEl keeps the glyph as its text and paints a known one', () => {
    const known = glyphEl(GLYPHS.warn) as unknown as FakeNode;
    expect(known.textContent).toBe('▲');
    expect(known.className).toBe('glyph');
    expect(known.dataset['icon']).toBe('warn');
    expect(known.attributes.get('style')).toBe(`--icon: ${iconUrl('warn')}`);
    const unknown = glyphEl('⌬') as unknown as FakeNode;
    expect(unknown.textContent).toBe('⌬');
    expect(unknown.dataset['icon']).toBeUndefined();
  });

  it('iconEl is an empty, hidden glyph span', () => {
    const icon = iconEl('missions') as unknown as FakeNode;
    expect(icon.textContent).toBe('');
    expect(icon.dataset['icon']).toBe('missions');
    expect(icon.attributes.get('aria-hidden')).toBe('true');
  });

  it('glyphNodes splits around every glyph and gives the text back', () => {
    for (const text of ['+450 XP · +50 ◈ · +20 lithium', '▲ Heatwave in 10 s', `${RESOURCE_GLYPHS.water}️ 45`, 'no glyph here', '']) {
      const nodes = glyphNodes(text) as unknown as (FakeNode | string)[];
      expect(nodes.map(textOf).join(''), text).toBe(text);
    }
    const nodes = glyphNodes('+5 ◈ and ✓') as unknown as (FakeNode | string)[];
    expect(nodes.filter((node) => typeof node !== 'string').map((node) => (node as FakeNode).dataset['icon'])).toEqual(['tokens', 'good']);
  });

  it('iconSvg draws one path per entry, hidden from assistive tech', () => {
    const name: IconName = 'wheat';
    const svg = iconSvg(name) as unknown as FakeNode;
    expect(svg.attributes.get('viewBox')).toBe('0 0 24 24');
    expect(svg.attributes.get('aria-hidden')).toBe('true');
    expect(svg.children).toHaveLength(ICON_PATHS[name].length);
  });
});
