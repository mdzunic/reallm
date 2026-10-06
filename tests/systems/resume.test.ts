// SPEC-059 §4.1, §6.1 — resume where you were: where Continue lands a save
// with a resume point, how long its player has been away, and what the
// "previously" card says after a day.
import { describe, expect, it } from 'vitest';
import { newSave, type CharacterCreation, type Save } from '@/core/Save';
import { MISSIONS, PLANETS, type MissionId } from '@/data/index';
import { awayMs, nextStepText, previouslyCard, RESUME_WINDOW_MS, resumeTarget } from '@/systems/Resume';
import { padEmptyText } from '@/systems/UiHelpers';

const CREATION: CharacterCreation = {
  name: 'Vega',
  classId: 'marine',
  appearance: { portrait: 0, primary: '#b7472a', secondary: '#2a3b4c' },
  attributes: { might: 3, vigor: 3, agility: 1, tech: 1 },
  difficulty: 'normal',
};

function save(patch: (s: Save) => void = () => {}): Save {
  const s = newSave(0, CREATION, 62, 1_000);
  patch(s);
  return s;
}

/** Active entries at stage 0, in this order — the first is the tracked one. */
function active(s: Save, ...ids: MissionId[]): void {
  s.progress.missionsActive = ids.map((id) => ({ id, stage: 0, counters: {} }));
}

describe('resumeTarget (§4.1.2)', () => {
  it('is the station without a resume point', () => {
    expect(resumeTarget(save(), false)).toEqual({ scene: 'station' });
  });

  it('is the planet’s pad for a resume point on a planet the save has unlocked', () => {
    const s = save((x) => {
      x.progress.flags.push('chapter1_done');
      x.progress.resume = { planet: 'vetra', at: 5_000 };
    });
    expect(resumeTarget(s, false)).toEqual({ scene: 'surface', planet: 'vetra' });
  });

  it('is the station for a planet still locked, unless service mode unlocks it (59-c)', () => {
    const s = save((x) => {
      x.progress.resume = { planet: 'vetra', at: 5_000 };
    });
    expect(resumeTarget(s, false)).toEqual({ scene: 'station' });
    expect(resumeTarget(s, true)).toEqual({ scene: 'surface', planet: 'vetra' });
  });

  it('is the station while an ending is owed, so it replays there (E29, 59-a)', () => {
    const s = save((x) => {
      x.progress.flags.push('chapter1_done', 'chapter2_done', 'chapter3_done', 'chapter4_done', 'chapter5_done', 'campaign_done', 'ending_stay');
      x.progress.endingSeen = false;
      x.progress.resume = { planet: 'eden', at: 5_000 };
    });
    expect(resumeTarget(s, false)).toEqual({ scene: 'station' });
    expect(resumeTarget(s, true)).toEqual({ scene: 'station' });
    // Once seen, the stay's free roam resumes on Eden.
    s.progress.endingSeen = true;
    expect(resumeTarget(s, false)).toEqual({ scene: 'surface', planet: 'eden' });
  });
});

describe('awayMs (§4.1.2)', () => {
  it('measures from the later of the last write and the resume point', () => {
    const s = save((x) => {
      x.meta.updatedAt = 10_000;
      x.progress.resume = { planet: 'cinder4', at: 4_000 };
    });
    expect(awayMs(s, 25_000)).toBe(15_000);
    s.progress.resume = { planet: 'cinder4', at: 20_000 };
    expect(awayMs(s, 25_000)).toBe(5_000);
    s.progress.resume = null;
    expect(awayMs(s, 25_000)).toBe(15_000);
  });

  it('reads 0 for a stamp in the future (59-d)', () => {
    const s = save((x) => {
      x.meta.updatedAt = 50_000;
    });
    expect(awayMs(s, 25_000)).toBe(0);
    s.meta.updatedAt = 0;
    s.progress.resume = { planet: 'cinder4', at: 90_000 };
    expect(awayMs(s, 25_000)).toBe(0);
  });

  it('opens the card from a day away (§4.1.3)', () => {
    expect(RESUME_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
    const s = save((x) => {
      x.meta.updatedAt = 1_000;
    });
    expect(awayMs(s, 1_000 + RESUME_WINDOW_MS)).toBeGreaterThanOrEqual(RESUME_WINDOW_MS);
    expect(awayMs(s, RESUME_WINDOW_MS)).toBeLessThan(RESUME_WINDOW_MS);
  });
});

describe('previouslyCard and nextStepText (§4.1.4)', () => {
  it('a Vetra target with Whiteout tracked at stage 0', () => {
    const s = save((x) => {
      x.progress.flags.push('chapter1_done');
      x.progress.resume = { planet: 'vetra', at: 5_000 };
      active(x, 'c2_m1');
    });
    const target = resumeTarget(s, false);
    expect(previouslyCard(s, target)).toEqual({
      chapter: 'Chapter 2 — Water, under a mile of ice.',
      where: 'Resuming at the Vetra landing pad',
      missions: ['Whiteout — Stage 1/2 · Tracked'],
      next: "Next: continue 'Whiteout' — Stage 1/2",
    });
  });

  it('a Cinder-4 target with Dry Land done and nothing active: the pad terminal’s next mission', () => {
    const s = save((x) => {
      x.progress.missionsDone.push('c1_m1');
    });
    const card = previouslyCard(s, { scene: 'surface', planet: 'cinder4' });
    expect(card.chapter).toBe('Chapter 1 — Oil and grain under the dunes.');
    expect(card.missions).toEqual(['No mission in progress']);
    expect(card.next).toBe(`Next: ${MISSIONS.c1_m2.title} — at the pad terminal`);
    expect(card.next).toBe('Next: Black Gold — at the pad terminal');
  });

  it('a Hive target with only the flight mission Gauntlet active: the pad’s line, never a continue', () => {
    const s = save((x) => {
      x.progress.flags.push('chapter1_done', 'chapter2_done', 'chapter3_done', 'chapter4_done');
      active(x, 'c5_m1');
    });
    const next = nextStepText(s, { scene: 'surface', planet: 'hive' });
    expect(MISSIONS.c5_m1.scene).toBe('flight');
    expect(next).not.toContain("continue 'Gauntlet'");
    expect(next).toBe(padEmptyText(s, 'hive'));
  });

  it('a planet with nothing left to offer: R16’s empty pad', () => {
    const s = save((x) => {
      for (const def of Object.values(MISSIONS)) {
        if (def.planet === 'cinder4') x.progress.missionsDone.push(def.id as MissionId);
      }
    });
    expect(nextStepText(s, { scene: 'surface', planet: 'cinder4' })).toBe(padEmptyText(s, 'cinder4'));
  });

  it('a station target with a flight mission tracked: the flight suffix', () => {
    const s = save((x) => {
      active(x, 'c5_m1', 'c2_m1');
    });
    const target = resumeTarget(s, false);
    expect(target).toEqual({ scene: 'station' });
    const card = previouslyCard(s, target);
    expect(card.where).toBe('Resuming at Command Relay');
    expect(card.next).toBe(`Next: Star Map → depart for ${PLANETS.hive.name}; the mission runs during the flight`);
    // With nothing active, the board.
    expect(nextStepText(save(), { scene: 'station' })).toBe('Next: accept a mission on the board');
    // A surface mission tracked has no suffix.
    const surface = save((x) => active(x, 'c2_m1'));
    expect(nextStepText(surface, { scene: 'station' })).toBe('Next: Star Map → depart for Vetra');
  });

  it('four active missions: three lines, then +1 more', () => {
    const s = save((x) => {
      active(x, 'c1_m1', 'c1_m2', 'c2_m1', 'c2_m2');
      (x.progress.missionsActive[1] as { stage: number }).stage = 1;
    });
    const { missions } = previouslyCard(s, { scene: 'station' });
    expect(missions).toEqual([
      `${MISSIONS.c1_m1.title} — Stage 1/${MISSIONS.c1_m1.stages.length} · Tracked`,
      `${MISSIONS.c1_m2.title} — Stage 2/${MISSIONS.c1_m2.stages.length}`,
      'Whiteout — Stage 1/2',
      '+1 more',
    ]);
  });
});
