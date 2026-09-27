// SPEC-031 §6.1 — the pure half of the console shell: the titles and channel
// lines every frame prints. The grid itself is exercised by e2e/SPEC-031.spec.ts.
import { describe, expect, it } from 'vitest';
import { channelText, screenTitle, type ScreenId } from '@/ui/Screen';

const IDS: readonly ScreenId[] = ['menu', 'creation', 'station', 'starmap', 'pause'];

describe('screenTitle (SPEC-031 §4.5)', () => {
  it('names all five screens', () => {
    for (const id of IDS) expect(screenTitle(id), id).not.toBe('');
    expect(screenTitle('menu')).toBe('ReaLLM');
    expect(screenTitle('station')).toBe('Command Relay');
  });
});

describe('channelText (SPEC-031 §4.5)', () => {
  /**
   * SPEC-035 §4.12 replaced `COMMAND RELAY · CONTAINMENT LEVEL N`: the frame's
   * title already reads `Command Relay` and the header carries one
   * `Containment level N`, so the channel line said both of them twice. The
   * containment argument went with it — the line no longer depends on progress.
   */
  it('names what the station is for, without repeating the head', () => {
    expect(channelText('station')).toBe('SUPPLY · REFIT · DISPATCH');
    expect(channelText('station')).not.toContain('COMMAND RELAY');
    expect(channelText('station').toUpperCase()).not.toContain('CONTAINMENT');
  });

  it('pins the other channels', () => {
    expect(channelText('menu')).toBe('EARTH COMMAND · SALVAGE DIVISION');
    expect(channelText('creation')).toBe('PERSONNEL FILE · NEW SALVAGER');
    expect(channelText('starmap')).toBe('NAVIGATION · OUTBOUND');
    expect(channelText('pause')).toBe('SYSTEM HOLD');
  });

  it('is diegetic, never meta (PLAN §12)', () => {
    for (const id of IDS) {
      const text = channelText(id).toLowerCase();
      expect(text).not.toContain('simulation');
      expect(text).not.toContain('instance');
      expect(text).not.toContain('model');
    }
  });
});
