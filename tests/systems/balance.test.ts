// The balance invariants (SPEC-010 §7). A failure here is not a bug in a
// module — it is a design regression: someone retuned a reward, a price or a
// planet and the campaign is now unaffordable, uncarryable or unreachable for
// the worst-case player (main missions only, mission XP only, no salvage).
//
// The numbers are explicit literals, per CLAUDE.md: the §5 table and PLAN §7 are
// the design, and a change to either has to be visible in the diff.
import { describe, expect, it } from 'vitest';
import { PLANETS, TUNING, UPGRADES } from '@/data/index';
import {
  COMPLETIONIST_LEVEL,
  LOADOUT_CHAPTERS,
  RECOMMENDED_LOADOUT,
  completionistTokens,
  entryCost,
  guaranteedMainTokensThrough,
  guaranteedMainXpThrough,
  largestCollectObjective,
  loadoutCost,
  sideTokensThrough,
  totalTokenSink,
  worstCaseTokensBefore,
} from '@/systems/Balance';
import { TOKENS_PER_LEVEL, levelForXp } from '@/systems/Progression';

describe('the worst-case model (§5)', () => {
  it('reproduces the table chapter by chapter', () => {
    const chapters = [1, 2, 3, 4, 5, 6];
    expect(chapters.map(guaranteedMainTokensThrough)).toEqual([55, 125, 210, 315, 480, 670]);
    expect(chapters.map(guaranteedMainXpThrough)).toEqual([500, 1150, 1980, 2930, 4280, 5480]);
    // Mission XP alone, and the 25 tokens each of those levels is worth.
    expect(chapters.map((c) => levelForXp(guaranteedMainXpThrough(c)))).toEqual([3, 5, 7, 9, 11, 13]);
    expect(chapters.map((c) => TOKENS_PER_LEVEL * (levelForXp(guaranteedMainXpThrough(c)) - 1))).toEqual([
      50, 100, 150, 200, 250, 300,
    ]);
    // "Tokens available before chapter N" is the row for chapter N−1.
    expect([2, 3, 4, 5, 6, 7].map(worstCaseTokensBefore)).toEqual([105, 225, 360, 515, 730, 970]);
    expect(worstCaseTokensBefore(1)).toBe(0);
  });

  it('prices the recommended loadout the way the table does', () => {
    // Per chapter: armor+drone · laser+hull+shield · shield 2+drone ·
    // plasma+hull 2+engine · armor 2+ship guns+medic (§5).
    expect(LOADOUT_CHAPTERS.map((c) => RECOMMENDED_LOADOUT[c].reduce((sum, entry) => sum + entryCost(entry), 0))).toEqual([
      60, 120, 120, 170, 150,
    ]);
    expect(LOADOUT_CHAPTERS.map(loadoutCost)).toEqual([60, 180, 300, 470, 620]);
  });
});

describe('the invariants (§7)', () => {
  it('1. the recommended loadout fits inside the worst case, chapter by chapter', () => {
    const over = LOADOUT_CHAPTERS.filter((chapter) => loadoutCost(chapter) > worstCaseTokensBefore(chapter)).map(
      (chapter) => `chapter ${chapter}: ${loadoutCost(chapter)} tokens of loadout against a ${worstCaseTokensBefore(chapter)} budget`,
    );
    expect(over).toEqual([]);
    // The margins, pinned: the design is not meant to be knife-edge anywhere.
    expect(LOADOUT_CHAPTERS.map((c) => worstCaseTokensBefore(c) - loadoutCost(c))).toEqual([45, 45, 60, 45, 110]);
  });

  it('2. the Ferrum shield gate stays under 80 % of the chapter-4 budget (E2)', () => {
    const shield = UPGRADES.shield.tiers;
    const gate = (shield[0]?.tokens ?? 0) + (shield[1]?.tokens ?? 0);
    expect(gate).toBe(140);
    expect(gate).toBeLessThanOrEqual(0.8 * worstCaseTokensBefore(4));
    // PLAN §7 phrases the same margin as a percentage: 140 of 360 is 39 %.
    expect(Math.round((gate / worstCaseTokensBefore(4)) * 100)).toBe(39);
    // And the gate is a real one: Ferrum will not unlock without tier 2.
    expect(PLANETS.ferrum.unlock).toContainEqual({ kind: 'ship', system: 'shield', tier: 2 });
  });

  it('3. the hold carries any collect objective, and the tank reaches Cinder-4 (E3)', () => {
    expect(largestCollectObjective()).toBe(300);
    expect(TUNING.CARGO_BASE).toBeGreaterThanOrEqual(largestCollectObjective() + 100);
    expect(TUNING.START_OIL).toBeGreaterThanOrEqual(PLANETS.cinder4.fuelCost + 20);
    expect([TUNING.CARGO_BASE, TUNING.START_OIL, PLANETS.cinder4.fuelCost]).toEqual([400, 60, 40]);
  });

  it('4. the sink is half again the richest run, so specialization is forced', () => {
    const sink = totalTokenSink();
    expect(sink).toEqual({ ship: 1095, gear: 500, companions: 415, total: 2010 });
    // Main 670 + side 104 + 25 × 19 levels (PLAN §7).
    expect(completionistTokens()).toBe(670 + 104 + 25 * (COMPLETIONIST_LEVEL - 1));
    expect(completionistTokens()).toBe(1249);
    expect(sink.total).toBeGreaterThanOrEqual(1.5 * completionistTokens());
    // A completionist affords roughly 62 % of everything (PLAN §7).
    expect(Math.round((completionistTokens() / sink.total) * 100)).toBe(62);
  });

  it('5. the mission payout totals are the ones PLAN §7 fixes', () => {
    expect(guaranteedMainTokensThrough(6)).toBe(670);
    expect(sideTokensThrough(6)).toBe(104);
  });
});

describe('every chapter funds the jump that follows it (§4.6)', () => {
  it('the voucher a chapter flag pays covers the next planet exactly', () => {
    // The refuel voucher is the next planet's fuel cost, so the worst-case
    // player never has to grind oil to keep moving (PLAN §5, E1).
    const byChapter = [1, 2, 3, 4, 5, 6].map(
      (chapter) => Object.values(PLANETS).find((planet) => planet.chapter === chapter)?.fuelCost ?? 0,
    );
    expect(byChapter).toEqual([40, 60, 80, 100, 120, 120]);
    expect(TUNING.START_OIL).toBeGreaterThanOrEqual(byChapter[0] ?? 0);
  });
});
