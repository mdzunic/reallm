// The campaign simulation (SPEC-010 §7, SPEC-016 §4). The executable proof that
// the game is completable: a scripted worst-case player — main missions only,
// mission XP only, the least-discounted class — walks the whole campaign
// through the real `Economy`, and has to reach `campaign_done` without the
// station ever bailing them out.
//
// Two runs, one per ending, because E24 makes them mutually exclusive inside a
// save: `campaign_done` locks `c6_m2`, so a single run can only file one verdict.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setLogSink, type LogSink } from '@/core/Log';
import { MISSIONS, PLANETS, TUNING } from '@/data/index';
import { worstCaseTokensBefore } from '@/systems/Balance';
import { runCampaign, type RunReport } from './harness';

const mute: LogSink = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

beforeEach(() => {
  setLogSink(mute);
});

afterEach(() => {
  setLogSink(console);
});

const MAIN_MISSIONS = Object.values(MISSIONS)
  .filter((mission) => mission.type === 'main')
  .map((mission) => mission.id);

describe('the worst-case campaign run', () => {
  let run: RunReport;

  beforeEach(() => {
    run = runCampaign({ ending: 'ending_stay' });
  });

  it('finishes, with nothing refusing along the way', () => {
    expect(run.problems).toEqual([]);
    expect(run.missionsDone).toEqual(MAIN_MISSIONS);
    expect(run.missionsDone).toHaveLength(17);
    expect(run.save.progress.flags).toContain('campaign_done');
  });

  it('never needs the station subsidy (E1, AC-28)', () => {
    // The station is asked on every visit — that is the rule — and answers
    // "you can already get somewhere" every single time.
    expect(run.subsidyCalls).toBe(6);
    expect(run.subsidyOil).toBe(0);
    expect(run.lowestOil).toBeGreaterThanOrEqual(0);
  });

  it('pays its own way, chapter by chapter, on the boss vouchers alone', () => {
    expect(run.jumps.map((jump) => jump.planet)).toEqual(['cinder4', 'vetra', 'thessaly', 'ferrum', 'hive', 'eden']);
    // Chapters 1–4 pay the table price; the tier-1 engine bought before the
    // Hive thins the last two jumps by a tenth (§4.6).
    expect(run.jumps.map((jump) => jump.cost)).toEqual([40, 60, 80, 100, 108, 108]);
    expect(run.jumps.every((jump) => jump.oilAfter >= 0)).toBe(true);
    expect(run.lowestOil).toBe(TUNING.START_OIL - PLANETS.cinder4.fuelCost);
  });

  it('buys the whole recommended loadout out of worst-case income', () => {
    expect(run.purchases).toEqual([
      'gear:armor_composite@39',
      'companion:scanner_drone@20',
      'gear:weapon_laser@39',
      'ship:hull:1@30',
      'ship:shield:1@49',
      'ship:shield:2@88',
      'companion:combat_drone@30',
      'gear:weapon_plasma@78',
      'ship:hull:2@59',
      'ship:engine:1@30',
      'gear:armor_reactive@78',
      'ship:weapon:1@39',
      'companion:field_medic@30',
    ]);
    // The Ferrum gate is the one the whole model exists for (E2).
    expect(run.save.ship.shield).toBe(2);
    expect(run.save.equipped).toEqual({ weapon: 'weapon_plasma', armor: 'armor_reactive' });
    expect(run.save.player.tokens).toBeGreaterThanOrEqual(0);
  });

  it('lands on the level the balance model predicts', () => {
    // §5: main-mission XP alone is 5,480, which is level 13.
    expect(run.save.player.xp).toBe(5480);
    expect(run.save.player.level).toBe(13);
    // Everything earned, less everything the loadout cost, is what is left.
    const earned = worstCaseTokensBefore(7);
    const spent = run.purchases.reduce((total, entry) => total + Number(entry.split('@')[1] ?? 0), 0);
    expect(earned).toBe(970);
    expect(run.save.player.tokens).toBe(earned - spent);
  });

  it('files one verdict, and only one (E24)', () => {
    expect(run.save.progress.flags).toContain('ending_stay');
    expect(run.save.progress.flags).not.toContain('ending_escape');
  });
});

describe('both endings, one run each (§7)', () => {
  it('the refusal is reachable from the same worst-case run', () => {
    const escape = runCampaign({ ending: 'ending_escape' });
    expect(escape.problems).toEqual([]);
    expect(escape.subsidyOil).toBe(0);
    expect(escape.save.progress.flags).toContain('campaign_done');
    expect(escape.save.progress.flags).toContain('ending_escape');
    expect(escape.save.progress.flags).not.toContain('ending_stay');

    // The two runs differ in exactly one flag: the verdict.
    const stay = runCampaign({ ending: 'ending_stay' });
    const difference = (a: string[], b: string[]): string[] => a.filter((flag) => !b.includes(flag));
    expect(difference(escape.save.progress.flags, stay.save.progress.flags)).toEqual(['ending_escape']);
    expect(difference(stay.save.progress.flags, escape.save.progress.flags)).toEqual(['ending_stay']);
    expect(stay.save.player.tokens).toBe(escape.save.player.tokens);
  });
});
