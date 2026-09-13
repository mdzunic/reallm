// SPEC-010 in a real browser: the economy modules, loaded the way the game
// loads them, and run through the M5 acceptance of §8 that exists without a UI.
//
// The unit suites prove the rules in node and the campaign simulation proves the
// run is completable. What this suite adds is the wiring and the two lines of §8
// that are about the *whole* shop rather than one rule: that
// `systems/Economy.ts` evaluates in a browser at all — it sits on top of
// `core/Save.ts` and the whole content barrel — that a fresh save with 0 oil at
// the station can still depart to Cinder-4 (E1), and that every ship tier, every
// gear tier, every companion level and every recipe can actually be bought
// through the real API. The shop screen that drives it is SPEC-014.
//
// `e2e/` may not import `src/` (SPEC-001 §4), so the modules are pulled in from
// inside the page with a dynamic import the dev server transforms, and
// everything comes back as plain data.
import { expect, test, type Page } from '@playwright/test';

interface EconomyDigest {
  /** E1 / §8: 0 oil at the station, and what the station does about it. */
  subsidy: { granted: number; oilAfter: number; canDepart: boolean; secondCall: number };
  /** Everything the shop refused while buying one of everything. Empty is the pass. */
  refusals: string[];
  ship: Record<string, number>;
  companions: Record<string, number>;
  owned: string[];
  equipped: { armor: string; sidearm: string; primary: string; heavy: string | null };
  slotsUsed: number;
  tokensSpent: number;
  curve: { xpToNext1: number; cumulative20: number; cumulative30: number; levelAt24650: number; levelAtAMillion: number };
  balance: { budgets: number[]; loadouts: number[]; sink: number; completionist: number };
  events: string[];
}

const CREATION = {
  name: 'Vance',
  classId: 'marine',
  appearance: { portrait: 1, primary: '#b7472a', secondary: '#2a3b4c' },
  attributes: { might: 6, vigor: 5, agility: 1, tech: 1 },
  difficulty: 'normal',
} as const;

/**
 * Runs the whole acceptance pass inside the page in one round trip, so that a
 * failure names the rule rather than the transport.
 */
async function readEconomy(page: Page, creation: typeof CREATION): Promise<EconomyDigest> {
  await page.goto('/');
  return page.evaluate(async (character): Promise<EconomyDigest> => {
    const [economyMod, progressionMod, balanceMod, saveMod] = await Promise.all([
      import('/src/systems/Economy.ts'),
      import('/src/systems/Progression.ts'),
      import('/src/systems/Balance.ts'),
      import('/src/core/Save.ts'),
    ]);
    const { Economy } = economyMod as unknown as { Economy: new (...args: never[]) => EconomyApi };
    const { Progression, xpToNext, cumulativeXp, levelForXp } = progressionMod as unknown as {
      Progression: new (...args: never[]) => ProgressionApi;
      xpToNext: (level: number) => number;
      cumulativeXp: (level: number) => number;
      levelForXp: (xp: number) => number;
    };
    const { loadoutCost, worstCaseTokensBefore, totalTokenSink, completionistTokens } =
      balanceMod as unknown as {
        loadoutCost: (chapter: number) => number;
        worstCaseTokensBefore: (chapter: number) => number;
        totalTokenSink: () => { total: number };
        completionistTokens: () => number;
      };
    const { newSave } = saveMod as unknown as { newSave: (...args: never[]) => SaveShape };

    type Outcome = { ok: true } | { ok: false; reason: string };
    interface ProgressionApi {
      addTokens(amount: number, reason: string): void;
      readonly tokens: number;
    }
    interface EconomyApi {
      applyStationSubsidy(): number;
      canDepart(planet: string): { ok: boolean };
      buyShipTier(system: string): Outcome;
      buyGear(itemId: string): Outcome;
      buyCompanion(id: string): Outcome;
      upgradeCompanion(id: string): Outcome;
      craft(recipe: string, times?: number): Outcome;
      equip(itemId: string): Outcome;
      usedSlots(): number;
    }
    interface SaveShape {
      resources: Record<string, number>;
      ship: Record<string, number>;
      companions: { id: string; level: number }[];
      inventory: { itemId: string; qty: number }[];
      equipped: { armor: string; sidearm: string; primary: string; heavy: string | null };
    }

    const events: string[] = [];
    const sink = { emit: (name: string, payload?: { id?: string; tier?: number }) => void events.push(payload?.id === undefined ? name : `${name}:${payload.id}${payload.tier === undefined ? '' : `:${payload.tier}`}`) };
    const save = newSave(...([0, character, 7, 1_700_000_000_000] as never[]));
    const progression = new Progression(...([save, sink] as never[]));
    const economy = new Economy(...([save, sink, progression] as never[]));

    // ---- E1, and §8's "a fresh save with 0 oil can still depart to Cinder-4".
    save.resources['oil'] = 0;
    const granted = economy.applyStationSubsidy();
    const subsidy = {
      granted,
      oilAfter: save.resources['oil'] ?? 0,
      canDepart: economy.canDepart('cinder4').ok,
      // Asked again with a full-enough tank, the station does nothing.
      secondCall: economy.applyStationSubsidy(),
    };

    // ---- §8: the shop buys every item, tier and companion.
    const refusals: string[] = [];
    progression.addTokens(100_000, 'e2e');
    const before = progression.tokens;
    for (const resource of ['oil', 'wheat', 'water', 'lithium']) save.resources[resource] = 5_000;
    const note = (what: string, result: Outcome): void => {
      if (!result.ok) refusals.push(`${what}: ${result.reason}`);
    };
    for (const system of ['engine', 'hull', 'shield', 'cargo', 'weapon']) {
      for (const tier of [1, 2, 3]) note(`ship ${system} ${tier}`, economy.buyShipTier(system));
    }
    for (const itemId of ['weapon_laser', 'weapon_plasma', 'weapon_lithium', 'armor_composite', 'armor_reactive', 'armor_ablative']) {
      note(`gear ${itemId}`, economy.buyGear(itemId));
    }
    note('equip weapon_lithium', economy.equip('weapon_lithium'));
    note('equip armor_ablative', economy.equip('armor_ablative'));
    for (const id of ['scanner_drone', 'combat_drone', 'field_medic', 'quartermaster']) {
      note(`companion ${id}`, economy.buyCompanion(id));
      for (const level of [2, 3]) note(`companion ${id} ${level}`, economy.upgradeCompanion(id));
    }
    note('companion aria 2', economy.upgradeCompanion('aria'));
    note('companion aria 3', economy.upgradeCompanion('aria'));
    for (const recipe of ['wheat_ration', 'medkit', 'coolant_pack']) note(`craft ${recipe}`, economy.craft(recipe));

    const ship: Record<string, number> = {};
    for (const [system, tier] of Object.entries(save.ship)) ship[system] = tier;
    const companions: Record<string, number> = {};
    for (const entry of save.companions) companions[entry.id] = entry.level;

    const chapters = [2, 3, 4, 5, 6];
    return {
      subsidy,
      refusals,
      ship,
      companions,
      owned: save.inventory.map((slot) => slot.itemId).sort(),
      equipped: save.equipped,
      slotsUsed: economy.usedSlots(),
      tokensSpent: before - progression.tokens,
      curve: {
        xpToNext1: xpToNext(1),
        cumulative20: cumulativeXp(20),
        cumulative30: cumulativeXp(30),
        levelAt24650: levelForXp(24_650),
        levelAtAMillion: levelForXp(1_000_000),
      },
      balance: {
        budgets: chapters.map(worstCaseTokensBefore),
        loadouts: chapters.map(loadoutCost),
        sink: totalTokenSink().total,
        completionist: completionistTokens(),
      },
      events: events.filter((name) => name.startsWith('shop:purchased')),
    };
  }, creation);
}

test.describe('SPEC-010 — the economy in a browser', () => {
  test('a fresh save with 0 oil at the station can still depart to Cinder-4 (E1, §8)', async ({ page }) => {
    const digest = await readEconomy(page, CREATION);
    expect(digest.subsidy).toEqual({ granted: 40, oilAfter: 40, canDepart: true, secondCall: 0 });
  });

  test('the shop buys every tier, every item and every companion (§8)', async ({ page }) => {
    const digest = await readEconomy(page, CREATION);
    expect(digest.refusals).toEqual([]);
    expect(digest.ship).toEqual({ engine: 3, hull: 3, shield: 3, cargo: 3, weapon: 3 });
    expect(digest.companions).toEqual({ aria: 3, scanner_drone: 3, combat_drone: 3, field_medic: 3, quartermaster: 3 });
    expect(digest.equipped).toEqual({
      armor: 'armor_ablative',
      sidearm: 'pistol_service',
      primary: 'weapon_lithium',
      heavy: null,
    });
    // The two starters came off into the hold, and everything bought is in it.
    expect(digest.owned).toEqual([
      'armor_composite',
      'armor_reactive',
      'armor_scrap',
      'coolant_pack',
      'medkit',
      'weapon_kinetic',
      'weapon_laser',
      'weapon_plasma',
      'wheat_ration',
    ]);
    expect(digest.slotsUsed).toBeLessThanOrEqual(20);
    // 1,095 ship + 500 gear + 415 companions, less this marine's tech discount.
    expect(digest.tokensSpent).toBeGreaterThan(0);
    expect(digest.tokensSpent).toBeLessThan(2010);
    // 5 ship ladders × 3, 6 gear items, 4 companions bought and upgraded twice
    // plus ARIA's two upgrades, 3 recipes.
    expect(digest.events).toHaveLength(15 + 6 + 14 + 3);
  });

  test('the curve and the balance model are the ones the design locks', async ({ page }) => {
    const digest = await readEconomy(page, CREATION);
    expect(digest.curve).toEqual({
      xpToNext1: 150,
      cumulative20: 11_400,
      cumulative30: 24_650,
      levelAt24650: 30,
      levelAtAMillion: 30,
    });
    expect(digest.balance.budgets).toEqual([105, 225, 360, 515, 730]);
    expect(digest.balance.loadouts).toEqual([60, 180, 300, 470, 620]);
    for (const [index, cost] of digest.balance.loadouts.entries()) {
      expect(cost).toBeLessThanOrEqual(digest.balance.budgets[index] ?? 0);
    }
    expect(digest.balance.sink).toBe(2010);
    expect(digest.balance.sink).toBeGreaterThanOrEqual(1.5 * digest.balance.completionist);
  });
});
