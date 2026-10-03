// SPEC-044 §4.5, §6.1 — the controls sheet's one table. Two hand-kept sheets
// drifted (the pause sheet never listed the terminal, dialogue or the quick
// picker), so the rows live in `CONTROL_ROWS` and this suite fails when an
// action bound in `KEY_BINDINGS` has no keyboard row to explain it. SPEC-038's
// dash is covered by whatever `KEY_BINDINGS` holds when this runs; SPEC-050
// adds the surface's `SURFACE_KEY_OVERRIDES` to what the rows must explain.
import { describe, expect, it } from 'vitest';
import { KEY_BINDINGS, SURFACE_KEY_OVERRIDES } from '@/core/KeyboardMouseDriver';
import { CONTROL_ROWS, controlRowsFor, type ControlRow } from '@/ui/ControlsSheet';

/** SPEC-050 §4.5: every binding the keyboard driver can resolve — the flat table and the surface's overrides. */
const ALL_BINDINGS: Readonly<Record<string, string>> = {
  ...KEY_BINDINGS,
  ...Object.fromEntries(Object.entries(SURFACE_KEY_OVERRIDES).map(([code, action]) => [`surface:${code}`, action])),
};

/** The `KEY_BINDINGS` values no keyboard row lists in its `actions` — `debug` is a developer key. */
export function unexplained(bindings: Readonly<Record<string, string>>, rows: readonly ControlRow[]): string[] {
  const listed = new Set(rows.flatMap((row) => row.actions ?? []));
  const bound = new Set(Object.values(bindings).filter((action) => action !== 'debug'));
  return [...bound].filter((action) => !listed.has(action)).sort();
}

describe('CONTROL_ROWS (SPEC-044 §4.5)', () => {
  it('every action KEY_BINDINGS and SURFACE_KEY_OVERRIDES bind, but debug, has a keyboard row', () => {
    expect(unexplained(ALL_BINDINGS, CONTROL_ROWS.keyboard)).toEqual([]);
    // SPEC-050 §4.5: the collection holds the surface's run, which only the overrides bind.
    expect(Object.values(ALL_BINDINGS)).toContain('sprint');
    expect(Object.values(KEY_BINDINGS)).not.toContain('sprint');
    const noRun = CONTROL_ROWS.keyboard.filter((row) => !(row.actions ?? []).includes('sprint'));
    expect(unexplained(ALL_BINDINGS, noRun)).toEqual(['sprint']);
  });

  it('gains the Run rows of SPEC-050 §4.5: Shift on the keyboard, after Dash; the stick on touch', () => {
    const keyboard = CONTROL_ROWS.keyboard;
    const run = keyboard.find((row) => row.what === 'Run');
    expect(run).toEqual({ what: 'Run', how: 'Hold Shift (on the ground)', actions: ['sprint'] });
    const whats = keyboard.map((row) => row.what);
    expect(whats.indexOf('Run')).toBe(whats.indexOf('Dash') + 1);
    expect(CONTROL_ROWS.touch.find((row) => row.what === 'Run')?.how).toBe('Push the stick past its ring');
  });

  it('the rule fails on a binding with no row, so it cannot pass vacuously', () => {
    const bound = new Set(Object.values(KEY_BINDINGS));
    expect(bound.size).toBeGreaterThan(15);
    expect(bound.has('dash')).toBe(true);
    // A planted binding with no row, and a row table missing the dash.
    expect(unexplained({ ...KEY_BINDINGS, KeyZ: 'zoomIn' }, CONTROL_ROWS.keyboard)).toEqual(['zoomIn']);
    const noDash = CONTROL_ROWS.keyboard.filter((row) => !(row.actions ?? []).includes('dash'));
    expect(unexplained(KEY_BINDINGS, noDash)).toEqual(['dash']);
    // `debug` is the one binding with no row on purpose.
    expect(unexplained({ Backquote: 'debug' }, [])).toEqual([]);
  });

  it('every row of both schemes says how', () => {
    for (const scheme of ['keyboard', 'touch'] as const) {
      expect(CONTROL_ROWS[scheme].length).toBeGreaterThan(0);
      for (const row of CONTROL_ROWS[scheme]) {
        expect(row.what.trim(), `${scheme} row`).not.toBe('');
        expect(row.how.trim(), `${scheme} ${row.what}`).not.toBe('');
      }
    }
  });

  it('the keyboard rows name the transmission, the choice, the picker, the map zoom and Back', () => {
    const rows = CONTROL_ROWS.keyboard.map((row) => `${row.what} — ${row.how}`);
    expect(rows).toContain('Continue a transmission — Enter, Space or E');
    expect(rows).toContain('Answer a choice — 1 to 9');
    expect(rows).toContain('Choose what a slot holds — right-click the slot on the bar');
    expect(rows).toContain('Map — M · zoom + / −');
    expect(rows).toContain('Back / close — Esc');
    // The pad terminal rides the interact row.
    expect(rows).toContain('Interact · pad terminal — E or F');
  });

  it('keeps §4.5\'s order: movement first, Back / close last', () => {
    const whats = CONTROL_ROWS.keyboard.map((row) => row.what);
    expect(whats[0]).toBe('Move / steer');
    expect(whats[whats.length - 1]).toBe('Back / close');
    expect(whats.indexOf('Continue a transmission')).toBe(whats.indexOf('Interact · pad terminal') + 1);
    expect(whats.indexOf('Pause')).toBe(whats.length - 2);
  });

  it('the gamepad scheme reads the keyboard rows (44-l: touch reads its own)', () => {
    expect(controlRowsFor('gamepad')).toBe(CONTROL_ROWS.keyboard);
    expect(controlRowsFor('keyboard')).toBe(CONTROL_ROWS.keyboard);
    expect(controlRowsFor('touch')).toBe(CONTROL_ROWS.touch);
  });
});
