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
  it('prints the containment level the station passes', () => {
    expect(channelText('station', { containment: 3 })).toContain('CONTAINMENT LEVEL 3');
  });

  it('defaults the containment level to 1', () => {
    expect(channelText('station')).toContain('CONTAINMENT LEVEL 1');
  });

  it('pins the other channels', () => {
    expect(channelText('menu')).toBe('EARTH COMMAND · SALVAGE DIVISION');
    expect(channelText('creation')).toBe('PERSONNEL FILE · NEW SALVAGER');
    expect(channelText('starmap')).toBe('NAVIGATION · OUTBOUND');
    expect(channelText('pause')).toBe('SYSTEM HOLD');
  });

  it('is diegetic, never meta (PLAN §12)', () => {
    for (const id of IDS) {
      for (const containment of [1, 2, 3, 4]) {
        const text = channelText(id, { containment }).toLowerCase();
        expect(text).not.toContain('simulation');
        expect(text).not.toContain('instance');
        expect(text).not.toContain('model');
      }
    }
  });
});
