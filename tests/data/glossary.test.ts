// SPEC-045 §6.1 — the glossary (§4.6): each glyph has one meaning and one
// home, `data/glossary.ts`; the words the UI audit retired are gone from the
// source; and the third quick slot reads `Gadget` while its id stays `utility`.
import { describe, expect, it } from 'vitest';
import { GLYPHS, QUICK_SLOT_NAMES } from '@/data/glossary';
import { QUICK_SLOTS, TIPS } from '@/data/index';
import { CONTROL_ROWS } from '@/ui/ControlsSheet';
import { TOAST_GLYPHS } from '@/ui/dom';
import { iconGlyph } from '@/ui/icons';
import { PORTRAIT_GLYPHS } from '@/ui/portraits';
import { stripComments } from '../architecture/source';

const RAW = import.meta.glob<string>('../../src/**/*.ts', { query: '?raw', import: 'default', eager: true });
const SOURCES: Record<string, string> = Object.fromEntries(
  Object.entries(RAW).map(([file, source]) => [file, stripComments(source)]),
);
const GLOSSARY = '../../src/data/glossary.ts';

describe('GLYPHS (SPEC-045 §4.6)', () => {
  it('gives each glyph one meaning', () => {
    const values = Object.values(GLYPHS);
    expect(new Set(values).size).toBe(values.length);
    expect(GLYPHS).toEqual({
      tokens: '◈',
      shield: '⛨',
      armor: '▣',
      warn: '▲',
      good: '✓',
      error: '✗',
      better: '↑',
      worse: '↓',
      health: '♥',
      hull: '⛭',
    });
  });

  it('no src/**/*.ts file but data/glossary.ts writes one outside a comment', () => {
    // The scan reads the tree it means to: the glossary itself is in it.
    expect(SOURCES[GLOSSARY]).toContain(GLYPHS.tokens);
    expect(Object.keys(SOURCES).length).toBeGreaterThan(100);
    const offenders: string[] = [];
    for (const [file, source] of Object.entries(SOURCES)) {
      if (file === GLOSSARY) continue;
      for (const [name, glyph] of Object.entries(GLYPHS)) {
        if (source.includes(glyph)) offenders.push(`${file} writes ${glyph} (${name})`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('its readers take it from the glossary: toasts, armour, the fifth portrait', () => {
    expect(TOAST_GLYPHS).toEqual({ good: GLYPHS.good, error: GLYPHS.error, warn: GLYPHS.warn, info: null });
    expect(iconGlyph('armor_scrap')).toBe(GLYPHS.armor);
    expect(PORTRAIT_GLYPHS[4]).toBe('❖');
    for (const glyph of Object.values(GLYPHS)) expect(PORTRAIT_GLYPHS).not.toContain(glyph);
  });

  it('▲ is a warning only: the touch throttle reads + and − (U+2212)', () => {
    expect(TIPS.flight_throttle.touch).toBe('Tap + or − to change speed.');
    expect(CONTROL_ROWS.touch.find((row) => row.what === 'Throttle (flight)')?.how).toBe('+ / − buttons');
  });
});

describe('the words (SPEC-045 §4.6)', () => {
  it('no string literal under src/ says Hull points, Hold full or utility slot', () => {
    const retired = ['Hull points', 'Hold full', 'utility slot', 'Utility slot'];
    const offenders: string[] = [];
    for (const [file, source] of Object.entries(SOURCES)) {
      for (const words of retired) {
        if (source.includes(words)) offenders.push(`${file}: ${words}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the third quick slot is Gadget, and its id stays utility', () => {
    expect(QUICK_SLOT_NAMES.utility).toBe('Gadget');
    expect(QUICK_SLOT_NAMES).toEqual({ heal: 'Heal', explosive: 'Explosive', utility: 'Gadget' });
    expect(QUICK_SLOTS).toEqual(['heal', 'explosive', 'utility']);
  });
});
