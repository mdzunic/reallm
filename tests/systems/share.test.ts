// SPEC-059 §4.5.1, §4.5.2, §6.1 — the Selection card's words: the model the
// canvas draws, the text that rides with it, the spoiler rule that keys on
// the ending flags, and when the menu offers one.
import { describe, expect, it } from 'vitest';
import { lineageOf, newSave, type CharacterCreation, type Save } from '@/core/Save';
import { CLUES } from '@/data/index';
import { SHARE_CARD_HEIGHT, SHARE_CARD_WIDTH, SHARE_FILE_NAME, SHARE_URL, shareAtMenu, shareCardModel, shareText } from '@/systems/Share';

const CREATION: CharacterCreation = {
  name: 'Vega',
  classId: 'marine',
  appearance: { portrait: 4, primary: '#b7472a', secondary: '#2a3b4c' },
  attributes: { might: 3, vigor: 3, agility: 1, tech: 1 },
  difficulty: 'normal',
};

const DEVICE = { commendations: 3, mode: null } as const;

function save(patch: (s: Save) => void = () => {}): Save {
  const s = newSave(0, CREATION, 62, 0);
  s.player.level = 12;
  s.meta.playtimeSec = 2 * 3600 + 14 * 60;
  s.meta.stats.deaths = 9;
  patch(s);
  return s;
}

const flags = (...list: string[]) => (s: Save): void => {
  s.progress.flags.push(...(list as Save['progress']['flags']));
};

/** A past instance of `iteration` that ended `ending`, for `meta.lineage`. */
function predecessor(iteration: number, ending: 'stay' | 'escape'): Save['meta']['lineage'][number] {
  const s = save((x) => {
    x.meta.iteration = iteration;
    if (ending === 'escape') x.progress.flags.push('ending_escape');
  });
  return lineageOf(s, iteration);
}

describe('the constants (§3)', () => {
  it('names the URL, the file and the canvas', () => {
    expect(SHARE_URL).toBe('https://mdzunic.github.io/reallm/');
    expect(SHARE_FILE_NAME).toBe('reallm-selection-card.png');
    expect([SHARE_CARD_WIDTH, SHARE_CARD_HEIGHT]).toEqual([1200, 630]);
  });
});

describe('shareCardModel (§4.5.1)', () => {
  it('before an ending, on a first run: the prologue’s card 62 and the chapter, in service', () => {
    const model = shareCardModel(save(flags('chapter1_done', 'chapter2_done')), DEVICE);
    expect(model).toEqual({
      header: 'SELECTION CARD 62 · CHAPTER 3',
      stamp: 'IN SERVICE',
      name: 'Vega',
      lines: ['MARINE · LEVEL 12 · 2 h 14 min', `RESTARTS 9 · RECORDED 0 OF ${CLUES.length}`, 'COMMENDATIONS 3 OF 24'],
      lineage: null,
      mode: null,
      url: 'mdzunic.github.io/reallm',
      portrait: 4,
      primary: '#b7472a',
    });
  });

  it('after the stay it is the run’s instance, selected; after the escape, disconnected', () => {
    const stay = shareCardModel(save(flags('campaign_done', 'ending_stay')), DEVICE);
    expect([stay.header, stay.stamp]).toEqual(['INSTANCE/62', 'SELECTED']);
    const escape = shareCardModel(save(flags('campaign_done', 'ending_escape')), DEVICE);
    expect([escape.header, escape.stamp]).toEqual(['INSTANCE/62', 'DISCONNECTED']);
  });

  it('an NG+ run before its ending: its instance, in service — the player has seen an ending (59-s)', () => {
    const model = shareCardModel(
      save((s) => {
        s.meta.iteration = 2;
      }),
      DEVICE,
    );
    expect([model.header, model.stamp]).toEqual(['INSTANCE/63', 'IN SERVICE']);
  });

  it('shows the rating only once a clue is recorded, as Notes does', () => {
    expect(shareCardModel(save(), DEVICE).lines[1]).toBe(`RESTARTS 9 · RECORDED 0 OF ${CLUES.length}`);
    const found = shareCardModel(save(flags('clue_hull', 'clue_raider_echo')), DEVICE);
    expect(found.lines[1]).toBe(`RESTARTS 9 · RECORDED 2 OF ${CLUES.length} · RATING 0.97`);
  });

  it('names at most four predecessors, oldest first, with a lead when there are more', () => {
    const two = shareCardModel(
      save((s) => {
        s.meta.iteration = 3;
        s.meta.lineage = [predecessor(2, 'escape'), predecessor(1, 'stay')];
      }),
      DEVICE,
    );
    expect(two.lineage).toBe('PREDECESSORS 62 FILED · 63 DISCONNECTED');
    const six = shareCardModel(
      save((s) => {
        s.meta.iteration = 7;
        s.meta.lineage = [6, 5, 4, 3, 2, 1].map((n) => predecessor(n, n % 2 === 0 ? 'escape' : 'stay'));
      }),
      DEVICE,
    );
    expect(six.lineage).toBe('PREDECESSORS … 64 FILED · 65 DISCONNECTED · 66 FILED · 67 DISCONNECTED');
  });

  it('marks each kind of closed session', () => {
    const line = (mode: 'story' | 'service' | 'debug'): string | null => shareCardModel(save(), { commendations: 0, mode }).mode;
    expect(line('story')).toBe('STORY MODE');
    expect(line('service')).toBe('SERVICE MODE');
    expect(line('debug')).toBe('DEBUG SESSION');
    expect(shareCardModel(save(), { commendations: 24, mode: null }).lines[2]).toBe('COMMENDATIONS 24 OF 24');
  });
});

describe('shareText (§4.5.2)', () => {
  it('a first run before its ending', () => {
    expect(shareText(save(flags('chapter1_done')), null)).toBe(
      'Selection card 62 — chapter 2 of 6, level 12, 2 h 14 min in. https://mdzunic.github.io/reallm/',
    );
  });

  it('the stay and the escape', () => {
    expect(shareText(save(flags('campaign_done', 'ending_stay')), null)).toBe(
      'I filed the report — instance/62, 2 h 14 min, 9 restarts. Would you? https://mdzunic.github.io/reallm/',
    );
    expect(shareText(save(flags('campaign_done', 'ending_escape')), null)).toBe(
      'I disconnected — instance/62, 2 h 14 min, 9 restarts. Would you? https://mdzunic.github.io/reallm/',
    );
  });

  it('a later instance before its ending, with one restart in the singular', () => {
    const s = save((x) => {
      x.meta.iteration = 2;
      x.meta.stats.deaths = 1;
      x.progress.flags.push('chapter1_done', 'chapter2_done', 'chapter3_done');
    });
    expect(shareText(s, null)).toBe('instance/63 — chapter 4 of 6, 1 restart so far. https://mdzunic.github.io/reallm/');
  });

  it('puts the closed session before the URL', () => {
    expect(shareText(save(), 'story')).toContain(' (story mode) https://mdzunic.github.io/reallm/');
    expect(shareText(save(), 'service')).toContain(' (service mode) https://mdzunic.github.io/reallm/');
    expect(shareText(save(), 'debug')).toMatch(/in\. \(debug session\) https:\/\/mdzunic\.github\.io\/reallm\/$/);
  });
});

describe('shareAtMenu (§4.5.5)', () => {
  it('holds only between the escape and the restore lines', () => {
    const s = save(flags('campaign_done', 'ending_escape'));
    expect(shareAtMenu(s)).toBe(false); // the veil has not finished
    s.progress.endingSeen = true;
    expect(shareAtMenu(s)).toBe(true);
    s.progress.flags.push('aftermath_seen');
    expect(shareAtMenu(s)).toBe(false);
    const stay = save(flags('campaign_done', 'ending_stay'));
    stay.progress.endingSeen = true;
    expect(shareAtMenu(stay)).toBe(false);
  });
});
