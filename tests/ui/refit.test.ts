// SPEC-073 §2, §4.6, §4.7, §7 — the Refit's tokens and rules read off the
// stylesheet, the board's short lines, and the class cards' new data.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CLASSES, MISSIONS, type MissionBonus } from '@/data/index';
import { bonusChip, bonusLine, bossDropChip, needsLine, needsShort } from '@/systems/UiHelpers';

const CSS = readFileSync(new URL('../../src/style.css', import.meta.url).pathname, 'utf8');

/** The `:root` block SPEC-014 opened, where every token lives. */
function rootBlock(): string {
  const at = CSS.indexOf(':root {\n  --hp:');
  return CSS.slice(at, CSS.indexOf('}', at));
}

describe('the Refit tokens (SPEC-073 §2, AC 1)', () => {
  it('declares --ground, --key-lit, --font-ui and --font-mono once, in :root, and reads each', () => {
    const root = rootBlock();
    for (const [token, value] of [
      ['--ground', '#0b0f14'],
      ['--key-lit', 'rgba(76, 154, 255, 0.18)'],
      ['--font-ui', "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"],
      ['--font-mono', "ui-monospace, 'Cascadia Mono', 'SF Mono', Menlo, Consolas, monospace"],
    ] as const) {
      expect(root, token).toContain(`${token}: ${value};`);
      expect(CSS.match(new RegExp(`^\\s*${token}\\s*:`, 'gm'))?.length, token).toBe(1);
      expect(CSS, token).toMatch(new RegExp(`var\\(${token}[,)]`));
    }
  });

  it('lights the primary key with --key-lit and spells no monospace stack twice', () => {
    expect(CSS).toMatch(/\.ui-btn\.is-primary\s*\{[^}]*background:\s*var\(--key-lit\)/);
    expect(CSS.match(/ui-monospace/g)).toHaveLength(1);
  });
});

describe('the Refit rules (SPEC-073 §3, §4)', () => {
  it('paints glyph icons only where masks exist (E139)', () => {
    expect(CSS.match(/\.glyph\[data-icon\]\s*\{/g)).toHaveLength(1);
    expect(CSS).toMatch(/@supports \(mask-image: none\) or \(-webkit-mask-image: none\) \{\s*\.glyph\[data-icon\] \{[^}]*mask: var\(--icon\)/);
  });

  it('lights the four chamfers in the accent', () => {
    const rule = /\.screen-frame::after\s*\{([^}]*)\}/.exec(CSS)?.[1] ?? '';
    expect(rule.match(/var\(--accent\)/g)).toHaveLength(4);
    expect(rule).toContain('var(--frame-cut)');
  });

  it('dims the frame behind settings with a scrim, and keeps the pause frame compact', () => {
    expect(CSS).toMatch(/\.settings-scrim\s*\{[^}]*pointer-events:\s*none/);
    expect(CSS).toMatch(/\.settings\s*\{[^}]*background:\s*var\(--panel\)/);
    expect(CSS).toMatch(/\.screen-pause \.screen-frame\s*\{[^}]*width:\s*min\(320px, 100%\);[^}]*height:\s*auto/);
  });

  it('never ellipsises a station tab or action (E140)', () => {
    for (const rule of CSS.match(/\.screen-(?:tab|action)\s*\{[^}]*\}/g) ?? []) expect(rule).not.toContain('text-overflow: ellipsis');
  });

  it('notches the vitals every tenth', () => {
    expect(CSS).toMatch(/\.bar\.is-notched::after\s*\{[^}]*repeating-linear-gradient\(90deg/);
  });
});

describe("the board's short lines (SPEC-073 §4.6)", () => {
  it('drops the bonus prefix and keeps the rest of the line', () => {
    for (const id of ['c1_m2', 'c1_m3', 'c3_s1'] as const) {
      const bonus = MISSIONS[id].bonus as MissionBonus;
      expect(`Bonus: ${bonusChip(bonus)}`).toBe(bonusLine(bonus));
    }
    expect(bonusChip(MISSIONS.c1_m2.bonus as MissionBonus)).toBe('Under 4:00 → +2 Frag Grenade');
  });

  it('drops the boss-drop prefix', () => {
    expect(bossDropChip('Boss drop: Rocket Launcher')).toBe('Rocket Launcher');
    expect(bossDropChip('Boss drop: 20 lithium')).toBe('20 lithium');
    expect(bossDropChip('Rocket Launcher')).toBe('Rocket Launcher');
  });

  it('says After for a mission and the needsLine item for the rest', () => {
    expect(needsShort([{ kind: 'mission', id: 'c1_m2' }])).toBe('After Black Gold');
    expect(needsShort([{ kind: 'mission', id: 'c1_m2' }, { kind: 'level', level: 3 }])).toBe('After Black Gold · Level 3');
    expect(needsShort([{ kind: 'ship', system: 'shield', tier: 2 }])).toBe('Ship shield tier 2');
    expect(needsLine([{ kind: 'flag', flag: 'chapter2_done' }])).toBe(`Needs: ${needsShort([{ kind: 'flag', flag: 'chapter2_done' }])}`);
  });
});

describe('the class cards (SPEC-073 §4.7)', () => {
  it('gives every class a tagline of at most 32 characters and two perks of at most 16', () => {
    for (const cls of Object.values(CLASSES)) {
      expect(cls.tagline.length, cls.id).toBeLessThanOrEqual(32);
      expect(cls.tagline, cls.id).not.toBe(cls.blurb);
      expect(cls.perks, cls.id).toHaveLength(2);
      for (const perk of cls.perks) expect(perk.length, `${cls.id}: ${perk}`).toBeLessThanOrEqual(16);
    }
    expect(CLASSES.marine.tagline).toBe('Hits harder, lasts longer.');
    expect(CLASSES.engineer.perks).toEqual(['−15 % prices', '+25 % drones']);
  });
});
