// SPEC-045 §4.2, §6.1 — the settings panel's row table. The panel renders it
// (`ui/SettingsPanel.ts`, driven by `e2e/SPEC-045.spec.ts` case 4); this holds
// the table to its promises: every stored setting has a control or is named
// bookkeeping, every testid follows one rule, and the rows follow the scheme.
import { describe, expect, it } from 'vitest';
import { DIFFICULTIES } from '@/core/Save';
import { defaultSettings, type Settings } from '@/core/Settings';
import {
  BOOKKEEPING_KEYS,
  kebab,
  rowNote,
  SETTINGS_ROWS,
  SETTINGS_SECTIONS,
  visibleRows,
  type RowEnv,
  type SettingsRowDef,
} from '@/ui/settingsRows';

/** The testids that keep the names they had before the rule (§4.2). */
const KEPT: Readonly<Record<string, string>> = {
  flightMouseSteer: 'settings-mouse-steer',
  serviceMode: 'settings-service',
  // SPEC-040's testids, which §4.2's table names.
  frameRate: 'settings-framerate',
};

const KEYBOARD: RowEnv = { scheme: 'keyboard', vibrate: true, fullscreen: true, saveBound: true, serviceMode: true };
const TOUCH: RowEnv = { ...KEYBOARD, scheme: 'touch' };

function keysOf(rows: readonly SettingsRowDef[]): (string | null)[] {
  return rows.map((row) => row.key);
}

/** Every testid a row puts in the page: its own, and one per choice. */
function testIds(row: SettingsRowDef): string[] {
  return [row.id, ...(row.choices ?? []).map((choice) => `${row.id}-${choice.suffix}`)];
}

describe('the settings row table (SPEC-045 §4.2)', () => {
  it('gives every key of defaultSettings() a row or names it bookkeeping, never both', () => {
    const rowKeys = new Set(SETTINGS_ROWS.map((row) => row.key));
    const bookkeeping = new Set<string>(BOOKKEEPING_KEYS);
    for (const key of Object.keys(defaultSettings()) as (keyof Settings)[]) {
      const inRows = rowKeys.has(key);
      const kept = bookkeeping.has(key);
      expect(inRows || kept, `${key} has no row and is not bookkeeping`).toBe(true);
      expect(inRows && kept, `${key} is both a row and bookkeeping`).toBe(false);
    }
    // SPEC-059 §4.4.2, §4.6.5: `commendations` and `installed` join them.
    expect([...BOOKKEEPING_KEYS].sort()).toEqual(
      [
        'benchmark',
        'bestTimes',
        'commendations',
        'installed',
        'installHintShownAt',
        'lastSlot',
        'persistGranted',
        'tipsSeen',
        'unlocks',
        'version',
        'zonesShown',
      ].sort(),
    );
  });

  it('names every row by the testid rule, except the kept names', () => {
    expect(kebab('invertFlightY')).toBe('invert-flight-y');
    expect(kebab('volumeInterface')).toBe('volume-interface');
    for (const row of SETTINGS_ROWS) {
      if (row.key === null) continue; // buttons, status lines and blocks keep their own names
      const expected = KEPT[row.key] ?? `settings-${kebab(row.key)}`;
      expect(row.id, `${row.key}'s testid`).toBe(expected);
      if (row.control !== 'choice') continue;
      expect(row.choices?.length ?? 0, `${row.key} offers choices`).toBeGreaterThan(1);
      for (const choice of row.choices ?? []) {
        // A string value is its own suffix; a scale's is its percentage, a frame rate's its number.
        const suffix =
          typeof choice.value === 'string'
            ? choice.value
            : row.key === 'frameRate'
              ? String(choice.value)
              : String(Math.round(choice.value * 100));
        expect(choice.suffix, `${row.id}'s ${String(choice.value)}`).toBe(suffix);
      }
    }
    // The buttons keep theirs (§4.2).
    const ids = SETTINGS_ROWS.map((row) => row.id);
    for (const button of ['settings-controls', 'settings-reset-tips', 'settings-reset']) expect(ids).toContain(button);
  });

  it('spells out the testids the new rows answer to', () => {
    const ids = SETTINGS_ROWS.flatMap(testIds);
    for (const id of [
      'settings-volume-interface',
      'settings-mono',
      'settings-brightness',
      'settings-weapon-auto-swap-on',
      'settings-weapon-auto-swap-off',
      'settings-weapon-auto-swap-touch',
      'settings-auto-fire-touch',
      'settings-invert-flight-y',
      'settings-joystick-side-left',
      'settings-button-scale-100',
      'settings-button-scale-125',
      'settings-button-scale-150',
      'settings-text-scale-140',
      'settings-ui-scale-115',
      'settings-ui-scale-150',
      'settings-camera-shake-0',
      'settings-camera-shake-50',
      'settings-camera-shake-100',
      'settings-film-mode-stills',
      'settings-typewriter',
      'settings-dialogue-speed-manual',
      'settings-plain-text',
      'settings-colour-preset-colour-blind',
      'settings-framerate-60',
      'settings-framerate-30',
      'settings-quality-auto',
      'settings-guidance-minimal',
      'settings-difficulty-hard',
      'settings-damage-flash-subtle',
      'settings-reduce-motion',
      'settings-pause-on-blur',
      'settings-haptics',
    ]) {
      expect(ids, id).toContain(id);
    }
  });

  it('never gives two controls one testid', () => {
    const ids = SETTINGS_ROWS.flatMap(testIds);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('shows the keyboard rows on the keyboard, the touch rows on touch, and the gamepad as the keyboard (§2)', () => {
    const keyboard = keysOf(visibleRows(KEYBOARD));
    expect(keyboard).toContain('flightMouseSteer');
    expect(keyboard).toContain('uiScale');
    for (const hidden of ['joystickSide', 'buttonScale', 'haptics']) expect(keyboard).not.toContain(hidden);

    const touch = keysOf(visibleRows(TOUCH));
    for (const shown of ['joystickSide', 'buttonScale', 'haptics']) expect(touch).toContain(shown);
    for (const hidden of ['flightMouseSteer', 'uiScale']) expect(touch).not.toContain(hidden);
    // Vibration only where haptics can fire (SPEC-042).
    expect(keysOf(visibleRows({ ...TOUCH, vibrate: false }))).not.toContain('haptics');

    expect(visibleRows({ ...KEYBOARD, scheme: 'gamepad' })).toEqual(visibleRows(KEYBOARD));
  });

  it('shows the difficulty row only with a save bound, the service row only while it is on, fullscreen only where it exists', () => {
    expect(keysOf(visibleRows({ ...KEYBOARD, saveBound: false }))).not.toContain('difficulty');
    expect(keysOf(visibleRows(KEYBOARD))).toContain('difficulty');
    expect(keysOf(visibleRows({ ...KEYBOARD, serviceMode: false }))).not.toContain('serviceMode');
    expect(keysOf(visibleRows(KEYBOARD))).toContain('serviceMode');
    expect(keysOf(visibleRows({ ...KEYBOARD, fullscreen: false }))).not.toContain('fullscreen');
  });

  it('orders the sections Audio, Display, Controls, Accessibility, Gameplay, Data, and the rows by section', () => {
    expect(SETTINGS_SECTIONS.map((section) => section.title)).toEqual([
      'Audio',
      'Display',
      'Controls',
      'Accessibility',
      'Gameplay',
      'Data',
    ]);
    // The table lists each section's rows together, in the sections' order.
    const order = SETTINGS_SECTIONS.map((section) => section.id);
    const sectionIndex = SETTINGS_ROWS.map((row) => order.indexOf(row.section));
    expect(sectionIndex).toEqual([...sectionIndex].sort((a, b) => a - b));
  });

  it("places the other specs' rows in their sections (§4.2)", () => {
    const section = (id: SettingsRowDef['section']): string[] =>
      visibleRows(KEYBOARD)
        .filter((row) => row.section === id)
        .map((row) => row.id);
    // Controls opens with SPEC-044's sheet and holds SPEC-036's blur pause.
    expect(section('controls')[0]).toBe('settings-controls');
    expect(section('controls')).toContain('settings-pause-on-blur');
    // Accessibility holds SPEC-037's damage flash, after reduce motion.
    const access = section('accessibility');
    expect(access.indexOf('settings-damage-flash')).toBeGreaterThan(access.indexOf('settings-reduce-motion'));
    // Display holds SPEC-040's frame rate and adaptive quality; Data its offline line.
    expect(section('display')).toEqual(expect.arrayContaining(['settings-framerate', 'settings-adaptive-quality']));
    expect(section('data')[0]).toBe('settings-offline');
    // Audio holds SPEC-042's vibration, on touch.
    expect(visibleRows(TOUCH).find((row) => row.key === 'haptics')?.section).toBe('audio');
    // Gameplay opens with the difficulty row while a save is bound.
    expect(section('gameplay')[0]).toBe('settings-difficulty');
  });

  it('offers the difficulties easiest to hardest, as creation does (review 2026-10 P-09)', () => {
    const row = SETTINGS_ROWS.find((r) => r.key === 'difficulty') as SettingsRowDef;
    expect(row.choices?.map((choice) => choice.label)).toEqual(['Story', 'Casual', 'Normal', 'Hard']);
    expect(row.choices?.map((choice) => choice.value)).toEqual([...DIFFICULTIES]);
  });

  it('holds the two run rows in Controls, each shown on its scheme (SPEC-050 §4.5)', () => {
    const toggle = SETTINGS_ROWS.find((row) => row.key === 'sprintToggle') as SettingsRowDef;
    expect(toggle).toMatchObject({ id: 'settings-sprint-toggle', section: 'controls', label: 'Run toggle', control: 'toggle', shown: 'keyboard' });
    const stick = SETTINGS_ROWS.find((row) => row.key === 'stickSprint') as SettingsRowDef;
    expect(stick).toMatchObject({ id: 'settings-stick-sprint', section: 'controls', label: 'Run with the stick', control: 'toggle', shown: 'touch' });
    expect(keysOf(visibleRows(KEYBOARD))).toContain('sprintToggle');
    expect(keysOf(visibleRows(KEYBOARD))).not.toContain('stickSprint');
    expect(keysOf(visibleRows(TOUCH))).toContain('stickSprint');
    expect(keysOf(visibleRows(TOUCH))).not.toContain('sprintToggle');
    // The gamepad reads as the keyboard (PLAN R18 decision 12).
    expect(keysOf(visibleRows({ ...KEYBOARD, scheme: 'gamepad' }))).toContain('sprintToggle');
  });

  it('notes the preset, Manual in the scheme\'s words, and what the colours mean', () => {
    const row = (key: string): SettingsRowDef => SETTINGS_ROWS.find((entry) => entry.key === key) as SettingsRowDef;
    expect(rowNote(row('reduceMotion'), 'keyboard')).toBe('Also sets camera shake, damage flash, films and typewriter text.');
    expect(rowNote(row('dialogueSpeed'), 'keyboard')).toBe('Manual: story lines wait for Enter or ›.');
    expect(rowNote(row('dialogueSpeed'), 'touch')).toBe('Manual: story lines wait for ›.');
    expect(rowNote(row('colourPreset'), 'touch')).toBe('Good is blue, danger is orange, and hostiles glow magenta.');
    expect(rowNote(row('master'), 'keyboard')).toBeNull();
  });

  it('holds Sharp rendering in Display, right after Adaptive quality, with its note (SPEC-046 §4.7)', () => {
    for (const env of [KEYBOARD, TOUCH]) {
      const display = visibleRows(env)
        .filter((row) => row.section === 'display')
        .map((row) => row.key);
      expect(display.indexOf('sharpRender')).toBe(display.indexOf('adaptiveQuality') + 1);
    }
    const row = SETTINGS_ROWS.find((entry) => entry.key === 'sharpRender') as SettingsRowDef;
    expect(row.id).toBe('settings-sharp-render');
    expect(row.label).toBe('Sharp rendering');
    expect(row.control).toBe('toggle');
    expect(row.shown ?? 'always').toBe('always');
    expect(rowNote(row, 'keyboard')).toBe('Medium quality at up to 2× resolution. Uses more battery.');
    expect(rowNote(row, 'touch')).toBe('Medium quality at up to 2× resolution. Uses more battery.');
  });

  it('offers Button size at 100, 125 and 150 % (§4.2)', () => {
    const scale = SETTINGS_ROWS.find((row) => row.key === 'buttonScale');
    expect(scale?.choices?.map((choice) => [choice.value, choice.label])).toEqual([
      [1, '100 %'],
      [1.25, '125 %'],
      [1.5, '150 %'],
    ]);
  });
});
