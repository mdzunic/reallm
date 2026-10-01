// The pure UI helpers of SPEC-014 §6, one describe per helper. They are the
// only part of the UI layer tests can reach (SPEC-001 §4: tests exercise pure
// code), so everything a panel prints or diffs is proven here and `ui/` merely
// renders the return values.
import { describe, expect, it } from 'vitest';
import { Rng } from '@/core/Rng';
import { maxHp, newSave, type CharacterCreation, type Save } from '@/core/Save';
import { CLASSES, COMPANIONS, DIFFICULTIES, ITEMS, MISSIONS, PLANET_IDS, TUNING, UPGRADES, type MissionDef } from '@/data/index';
import type { SlotState, SlotView } from '@/systems/Loadout';
import { discountTokens, Economy } from '@/systems/Economy';
import { Progression, type EventSink } from '@/systems/Progression';
import { CARGO_TOAST_SECONDS, SHIPPED_TOAST_TEXT } from '@/systems/Pickups';
import {
  surfaceHoldReason,
  abandonMission,
  acceptMission,
  cameraDistance,
  cameraFov,
  compositeOver,
  contrastRatio,
  FLASH_MIN_GAP,
  flashGate,
  FOV_MAX,
  FOV_MIN,
  shiftToasts,
  slotStateText,
  TOUCH_CAMERA_MAX_SHORT_SIDE,
  WALLET_LIT_SECONDS,
  walletLit,
  FOG_SPAN_K,
  occludes,
  OCCLUDER_OPACITY,
  relativeLuminance,
  surfaceFogRange,
  upgradeDeltaText,
  UPGRADE_METRIC_KEYS,
  balanceAfterText,
  gearStatLines,
  shortfallText,
  skipRefusalText,
  walletModel,
  copyHudInto,
  computePlayerStats,
  createHudModel,
  departReason,
  diffHud,
  diffHudInto,
  HUD_KEYS,
  formatTime,
  missionStatus,
  padEmptyText,
  priceText,
  pruneToasts,
  pushToast,
  requirementText,
  companionEffectText,
  failText,
  gearCompare,
  gearCompareText,
  gearTooltip,
  bossDropText,
  refitLine,
  refitText,
  shipGateText,
  shipRoleText,
  shopStatText,
  passiveText,
  DIFFICULTY_LINES,
  rewardsText,
  slotLine,
  stageResetText,
  TOAST_COALESCE_MS,
  TOAST_DEFAULT_MS,
  TOAST_MAX,
  type HudModel,
} from '@/systems/UiHelpers';

const CREATION: CharacterCreation = {
  name: 'Vance',
  classId: 'marine',
  appearance: { portrait: 1, primary: '#b7472a', secondary: '#2a3b4c' },
  attributes: { might: 6, vigor: 5, agility: 1, tech: 1 },
  difficulty: 'normal',
};

function save(patch?: (data: Save) => void): Save {
  const data = newSave(0, CREATION, 42, 1_700_000_000_000);
  patch?.(data);
  return data;
}

// `c1_m1` requires nothing; `c1_m2` requires `c1_m1` (SPEC-009 §4.7).
const OPEN: MissionDef = MISSIONS.c1_m1;
const GATED: MissionDef = MISSIONS.c1_m2;

// SPEC-012 12-k / PLAN R16: the pad terminal is allowed to have nothing on it.
// What it may not do is read empty, which is how a landing on The Hive with the
// gauntlet unflown looks like a broken game.
describe('surfaceHoldReason (SPEC-036 §4.3)', () => {
  it('orders beat, rotate, ui, modal', () => {
    const none = { beats: 0, rotate: false, ui: 0, modal: 0 };
    expect(surfaceHoldReason(none)).toBeNull();
    expect(surfaceHoldReason({ beats: 1, rotate: true, ui: 1, modal: 1 })).toBe('beat');
    expect(surfaceHoldReason({ beats: 0, rotate: true, ui: 1, modal: 1 })).toBe('rotate');
    expect(surfaceHoldReason({ beats: 0, rotate: false, ui: 1, modal: 1 })).toBe('ui');
    expect(surfaceHoldReason({ beats: 0, rotate: false, ui: 0, modal: 1 })).toBe('modal');
    // The rotate block alone holds, as the map does.
    expect(surfaceHoldReason({ ...none, rotate: true })).toBe('rotate');
  });
});

describe('padEmptyText (12-k)', () => {
  it("names the flight mission the Hive's surface work waits on", () => {
    expect(padEmptyText(save(), 'hive')).toBe(
      "Nothing to accept yet. Complete 'Gauntlet' — a flight mission, taken at the station board.",
    );
  });

  it('names a surface mission plainly, with no detour to the board', () => {
    const data = save((d) => d.progress.missionsDone.push('c1_m1'));
    // Cinder-4's own chain: `c1_m3` waits on `c1_m2`, a surface mission.
    expect(padEmptyText(data, 'cinder4')).toBe(`Nothing to accept yet. Complete '${MISSIONS.c1_m2.title}'.`);
  });

  it('sends the player to the board when nothing here is locked', () => {
    const data = save((d) => {
      for (const id of ['c1_m1', 'c1_m2', 'c1_m3', 'c1_s1', 'c1_s2'] as const) d.progress.missionsDone.push(id);
    });
    expect(padEmptyText(data, 'cinder4')).toBe(
      "Nothing to accept here. The station board carries this planet's remaining work.",
    );
  });

  it('is pure: the save is not written', () => {
    const data = save();
    const before = JSON.stringify(data);
    padEmptyText(data, 'hive');
    expect(JSON.stringify(data)).toBe(before);
  });
});

describe('missionStatus (AC-111)', () => {
  it('a mission whose requirements are unmet is locked', () => {
    expect(missionStatus(save(), GATED, 'station')).toBe('locked');
  });

  it('a mission with its requirements met is available', () => {
    expect(missionStatus(save(), OPEN, 'station')).toBe('available');
    const unlocked = save((data) => data.progress.missionsDone.push('c1_m1'));
    expect(missionStatus(unlocked, GATED, 'station')).toBe('available');
  });

  it('an accepted mission is active in every scene, even past its requirements', () => {
    const data = save((d) => d.progress.missionsActive.push({ id: 'c1_m2', stage: 0, counters: {} }));
    for (const scene of ['station', 'surface', 'flight'] as const) {
      expect(missionStatus(data, GATED, scene)).toBe('active');
    }
  });

  it('a done mission is replayable at the station and plain done in the field (E2)', () => {
    const data = save((d) => d.progress.missionsDone.push('c1_m1'));
    expect(missionStatus(data, OPEN, 'station')).toBe('replayable');
    expect(missionStatus(data, OPEN, 'surface')).toBe('done');
    expect(missionStatus(data, OPEN, 'flight')).toBe('done');
  });

  it('is pure: the save is not written', () => {
    const data = save();
    const before = JSON.stringify(data);
    missionStatus(data, GATED, 'station');
    expect(JSON.stringify(data)).toBe(before);
  });

  // SPEC-024 §4.6 / E24: the board must not offer the verdict a second time.
  it('the campaign mission reads done at the station once campaign_done is set', () => {
    const data = save((d) => d.progress.missionsDone.push('c6_m2'));
    expect(missionStatus(data, MISSIONS.c6_m2, 'station')).toBe('replayable');
    data.progress.flags.push('campaign_done');
    expect(missionStatus(data, MISSIONS.c6_m2, 'station')).toBe('done');
    // Only that mission: everything else stays replayable.
    data.progress.missionsDone.push('c1_m1');
    expect(missionStatus(data, OPEN, 'station')).toBe('replayable');
  });
});

describe('requirementText (AC-112)', () => {
  it('covers every Requirement kind', () => {
    expect(requirementText({ kind: 'ship', system: 'shield', tier: 2 })).toBe('Requires: Ship shield tier 2');
    expect(requirementText({ kind: 'mission', id: 'c1_m2' })).toBe("Complete 'Black Gold'");
    expect(requirementText({ kind: 'level', level: 12 })).toBe('Requires: Level 12');
    expect(requirementText({ kind: 'flag', flag: 'chapter2_done' })).toBe('Complete Chapter 2');
  });

  it('a non-chapter flag falls back to its readable name', () => {
    expect(requirementText({ kind: 'flag', flag: 'signal_decoded' })).toBe('Requires: signal decoded');
  });
});

describe('priceText (AC-113, SPEC-031 §4.12)', () => {
  it('shows the discount as base → paid, with the unit', () => {
    expect(priceText({ tokens: 40 }, 0.15)).toBe('40 → 34 tokens');
  });

  it('shows the plain price when no discount applies', () => {
    expect(priceText({ tokens: 40 }, 0)).toBe('40 tokens');
  });

  it('appends undiscounted resource costs', () => {
    expect(priceText({ tokens: 140, resources: { lithium: 80 } }, 0.25)).toBe('140 → 105 tokens + 80 lithium');
    expect(priceText({ tokens: 0, resources: { wheat: 3, water: 1 } }, 0.4)).toBe('3 wheat + 1 water');
  });

  it('agrees with the charge itself', () => {
    expect(priceText({ tokens: 130 }, 0.4)).toContain(String(discountTokens(130, 0.4)));
  });

  it('a price of nothing is Free', () => {
    expect(priceText({ tokens: 0 }, 0.4)).toBe('Free');
  });
});

describe('walletModel (SPEC-031 §4.11)', () => {
  it('reads a fresh save: four entries in order, capped by the cargo tier', () => {
    const data = save();
    const model = walletModel(data);
    expect(model.tokens).toBe(data.player.tokens);
    expect(model.resources.map((entry) => entry.id)).toEqual(['oil', 'wheat', 'water', 'lithium']);
    const cap = UPGRADES.cargo.metrics['cargoCap']?.[data.ship.cargo];
    for (const entry of model.resources) {
      expect(entry.cap).toBe(cap);
      expect(entry.value).toBe(data.resources[entry.id]);
      expect(entry.atCap).toBe(false);
    }
  });

  it('marks atCap only at the cap', () => {
    const data = save((s) => {
      s.resources.oil = 400;
      s.resources.wheat = 399;
    });
    const model = walletModel(data);
    expect(model.resources.find((entry) => entry.id === 'oil')?.atCap).toBe(true);
    expect(model.resources.find((entry) => entry.id === 'wheat')?.atCap).toBe(false);
  });

  it('follows the cargo tier and the quartermaster bonus', () => {
    const data = save((s) => {
      s.ship.cargo = 2;
      s.companions.push({ id: 'quartermaster', level: 1, enabled: true });
    });
    const bonus = COMPANIONS.quartermaster.levels[0]?.cargoBonus ?? 0;
    expect(walletModel(data).resources[0]?.cap).toBe((UPGRADES.cargo.metrics['cargoCap']?.[2] ?? 0) + bonus);
  });

  it('counts a disabled quartermaster, exactly as Economy.cargoCap does', () => {
    // `Economy.cargoCap()` resolves the quartermaster by owned level alone and
    // never reads `enabled` — the strip must clamp by the same number, or a
    // shop-disabled quartermaster shows a false CARGO FULL at the old cap.
    const data = save((s) => {
      s.companions.push({ id: 'quartermaster', level: 1, enabled: false });
    });
    const bonus = COMPANIONS.quartermaster.levels[0]?.cargoBonus ?? 0;
    const base = UPGRADES.cargo.metrics['cargoCap']?.[data.ship.cargo] ?? 0;
    expect(walletModel(data).resources[0]?.cap).toBe(base + bonus);
  });
});

describe('shortfallText (SPEC-031 §4.12, E48)', () => {
  it('is null when affordable', () => {
    const data = save((s) => {
      s.player.tokens = 100;
    });
    expect(shortfallText({ tokens: 40 }, data, 0)).toBeNull();
  });

  it('names the token shortfall', () => {
    const data = save((s) => {
      s.player.tokens = 10;
    });
    expect(shortfallText({ tokens: 50 }, data, 0)).toBe('Need 40 more tokens');
  });

  it('names the resource shortfall', () => {
    const data = save((s) => {
      s.player.tokens = 999;
      s.resources.lithium = 60;
    });
    expect(shortfallText({ tokens: 10, resources: { lithium: 80 } }, data, 0)).toBe('Need 20 more lithium');
  });

  it('joins both when both are short', () => {
    const data = save((s) => {
      s.player.tokens = 10;
      s.resources.lithium = 12;
    });
    expect(shortfallText({ tokens: 130, resources: { lithium: 80 } }, data, 0)).toBe(
      'Need 120 more tokens · Need 68 more lithium',
    );
  });

  it('applies the discount before the comparison', () => {
    const data = save((s) => {
      s.player.tokens = 34;
    });
    expect(shortfallText({ tokens: 40 }, data, 0.15)).toBeNull();
    expect(shortfallText({ tokens: 40 }, data, 0)).toBe('Need 6 more tokens');
  });
});

describe('balanceAfterText (SPEC-031 §4.12)', () => {
  it('prints the token balance line', () => {
    const data = save((s) => {
      s.player.tokens = 340;
    });
    expect(balanceAfterText({ tokens: 49 }, data, 0)).toBe('Tokens 340 → 291');
  });

  it('prints one line per resource', () => {
    const data = save((s) => {
      s.player.tokens = 340;
      s.resources.wheat = 60;
      s.resources.water = 45;
    });
    expect(balanceAfterText({ tokens: 0, resources: { wheat: 30, water: 30 } }, data, 0)).toBe(
      'Wheat 60 → 30\nWater 45 → 15',
    );
  });

  it('applies the discount to the token line', () => {
    const data = save((s) => {
      s.player.tokens = 100;
    });
    expect(balanceAfterText({ tokens: 40 }, data, 0.15)).toBe('Tokens 100 → 66');
  });

  it('is empty for Free', () => {
    expect(balanceAfterText({ tokens: 0 }, save(), 0.4)).toBe('');
  });
});

describe('gearStatLines (SPEC-031 §4.16)', () => {
  it('pins a weapon: damage, fire rate, DPS, range, speed, pierce, cooldown', () => {
    const item = ITEMS.pistol_magnum;
    expect(gearStatLines('pistol_magnum')).toEqual([
      `Damage ${item.damage}`,
      `Fire rate ${item.fireRate}/s`,
      `DPS ${Math.round(item.damage * item.fireRate)}`,
      `Range ${item.range} m`,
      `Projectile speed ${item.projectileSpeed} m/s`,
      `Pierce ${item.pierce}`,
      'No cooldown',
    ]);
  });

  it('describes the heat and charge models in words', () => {
    expect(gearStatLines('mg_scrap')).toContain('Overheats — locks until it cools');
    expect(gearStatLines('launcher_grenade')).toContain('3 charges, recharges in 9 s');
  });

  it('pins an armor piece', () => {
    const item = ITEMS.armor_ablative;
    expect(gearStatLines('armor_ablative')).toEqual([
      `Armor ${item.armor}`,
      `Hazard resist ${Math.round(item.hazardResist * 100)}%`,
    ]);
  });

  it('pins a consumable: the effect in words and the stack', () => {
    expect(gearStatLines('medkit')).toEqual(['Heals 50% instantly', 'Stack of 5']);
  });
});

describe('departReason (AC-114)', () => {
  it('an allowed departure has no reason', () => {
    expect(departReason({ ok: true })).toBe('');
  });

  it('a fuel shortfall names the missing oil', () => {
    expect(departReason({ ok: false, reason: 'fuel', needOil: 20 })).toBe('Need 20 more oil');
  });

  it('a lock names the first missing requirement', () => {
    expect(
      departReason({ ok: false, reason: 'locked', missing: [{ kind: 'ship', system: 'shield', tier: 2 }] }),
    ).toBe('Requires ship shield tier 2');
    expect(
      departReason({ ok: false, reason: 'locked', missing: [{ kind: 'flag', flag: 'chapter2_done' }] }),
    ).toBe('Complete Chapter 2');
    expect(departReason({ ok: false, reason: 'locked', missing: [{ kind: 'level', level: 8 }] })).toBe(
      'Requires level 8',
    );
  });
});

describe('skipRefusalText (SPEC-032 §4.3)', () => {
  it('asks for one flown run on a route never landed on', () => {
    expect(skipRefusalText('never_flown')).toBe('Autopilot needs a route — fly this run once.');
    expect(skipRefusalText('never_flown', 'c4_s2')).toBe('Autopilot needs a route — fly this run once.');
  });

  it('names the flight mission that needs the run flown', () => {
    expect(skipRefusalText('flight_mission', 'c4_s2')).toBe('Salvage Rights needs a flown run.');
    expect(skipRefusalText('flight_mission', 'c5_m1')).toBe('Gauntlet needs a flown run.');
    expect(skipRefusalText('flight_mission')).toBe('This mission needs a flown run.');
  });
});

/**
 * A deep copy the way `Hud` keeps its last rendered model since SPEC-040 §4.4:
 * copied into a fresh zeroed model, not cloned.
 */
function cloneHud(model: HudModel): HudModel {
  return copyHudInto(createHudModel(), model);
}

describe('diffHud (AC-115, AC-62)', () => {
  it('two equal models diff to the empty set — the no-DOM-write contract', () => {
    const a = createHudModel();
    const b = cloneHud(a);
    expect(diffHud(a, b).size).toBe(0);
  });

  it('returns exactly the changed keys', () => {
    const a = createHudModel();
    const b = cloneHud(a);
    b.hp = [50, 100];
    b.tokens = 25;
    b.resources.oil = 10;
    expect(diffHud(a, b)).toEqual(new Set(['hp', 'tokens', 'resources']));
  });

  it('sees into nested objects and nulls', () => {
    const a = createHudModel();
    const b = cloneHud(a);
    b.objective = { title: 'Dry Land', line: 'Reach the rig', value: 0, target: 1 };
    expect(diffHud(a, b)).toEqual(new Set(['objective']));
    const c = cloneHud(b);
    c.objective = { title: 'Dry Land', line: 'Reach the rig', value: 1, target: 1 };
    expect(diffHud(b, c)).toEqual(new Set(['objective']));
  });

  it('notices the flight block appearing and its fields moving', () => {
    const a: HudModel = createHudModel();
    const b = cloneHud(a);
    b.flight = { shield: [40, 40], hull: [100, 100], throttle: 1, progress: 0, hostiles: 0, storm: false, holding: false };
    expect(diffHud(a, b)).toEqual(new Set(['flight']));
    const c = cloneHud(b);
    c.flight = { ...c.flight!, progress: 0.5 };
    expect(diffHud(b, c)).toEqual(new Set(['flight']));
  });

  it('is pure: neither model is written', () => {
    const a = createHudModel();
    const b = cloneHud(a);
    b.level = 5;
    const before = [JSON.stringify(a), JSON.stringify(b)];
    diffHud(a, b);
    expect([JSON.stringify(a), JSON.stringify(b)]).toEqual(before);
  });

  // SPEC-027 §6.1: the tracker is one model key, rows and all, so the panel is
  // rewritten exactly when something in it moved (AC-21).
  it('sees the tracker appear, its rows move, and nothing when it is unchanged', () => {
    const a = createHudModel();
    expect(a.tracker).toBeNull();
    const b = cloneHud(a);
    b.tracker = {
      title: 'Dry Land',
      stage: 'stage 2/3',
      rows: [{ text: 'Dry Land — Scan Dune Sea', done: false, focus: true, defendHp: null, count: 0 }],
      distance: 84,
      bearing: 0,
      pulse: false,
    };
    expect(diffHud(a, b)).toEqual(new Set(['tracker']));
    expect(diffHud(b, cloneHud(b)).size).toBe(0);

    const c = cloneHud(b);
    (c.tracker as NonNullable<HudModel['tracker']>).distance = 83;
    expect(diffHud(b, c)).toEqual(new Set(['tracker']));

    const d = cloneHud(c);
    (d.tracker as NonNullable<HudModel['tracker']>).rows[0]!.done = true;
    expect(diffHud(c, d)).toEqual(new Set(['tracker']));

    const e = cloneHud(d);
    (e.tracker as NonNullable<HudModel['tracker']>).rows.push({ text: 'Survive 60 s', done: false, focus: false, defendHp: null, count: -1 });
    expect(diffHud(d, e)).toEqual(new Set(['tracker']));
  });

  // SPEC-028 §6.1: `loadout` and `quick` replaced `consumable`; each is one
  // model key, so the bar is rewritten exactly when something in it moved,
  // and an equal model still writes nothing to the DOM.
  it('sees the loadout appear, its slots move, and nothing when it is unchanged', () => {
    const slot = (itemId: 'pistol_service' | 'weapon_kinetic' | null): {
      itemId: 'pistol_service' | 'weapon_kinetic' | null;
      state: 'ready' | 'switch' | 'empty';
      cd: number;
      heat: number;
      charges: number;
      maxCharges: number;
      cdSeconds: number;
    } => ({ itemId, state: itemId === null ? 'empty' : 'ready', cd: 0, heat: 0, charges: 0, maxCharges: 0, cdSeconds: 0 });

    const a = createHudModel();
    expect(a.loadout).toBeNull();
    expect(a.quick).toBeNull();
    expect('consumable' in a).toBe(false);

    const b = cloneHud(a);
    b.loadout = {
      active: 'primary',
      fallback: false,
      slots: { sidearm: slot('pistol_service'), primary: slot('weapon_kinetic'), heavy: slot(null) },
    };
    expect(diffHud(a, b)).toEqual(new Set(['loadout']));
    expect(diffHud(b, cloneHud(b)).size).toBe(0);

    const c = cloneHud(b);
    const loadout = c.loadout as NonNullable<HudModel['loadout']>;
    loadout.active = 'sidearm';
    loadout.slots.sidearm.state = 'switch';
    loadout.slots.sidearm.cd = 0.8;
    expect(diffHud(b, c)).toEqual(new Set(['loadout']));
  });

  it('sees a quick-slot count move and nothing when it is unchanged', () => {
    const a = createHudModel();
    const b = cloneHud(a);
    b.quick = {
      heal: { itemId: 'wheat_ration', qty: 3 },
      explosive: { itemId: null, qty: 0 },
      utility: { itemId: null, qty: 0 },
    };
    expect(diffHud(a, b)).toEqual(new Set(['quick']));
    expect(diffHud(b, cloneHud(b)).size).toBe(0);

    const c = cloneHud(b);
    (c.quick as NonNullable<HudModel['quick']>).heal.qty = 2;
    expect(diffHud(b, c)).toEqual(new Set(['quick']));
  });
});

describe('toast coalescing (AC-116, AC-78, AC-80)', () => {
  it('a new text joins the stack for the default 2.5 s', () => {
    const stack = pushToast([], 'Saved', 'info', 1000);
    expect(stack).toEqual([{ text: 'Saved', kind: 'info', count: 1, shownAt: 1000, expiresAt: 1000 + TOAST_DEFAULT_MS }]);
  });

  it('the ms override is honoured', () => {
    expect(pushToast([], 'Slow', 'warn', 0, 8000)[0]?.expiresAt).toBe(8000);
  });

  it('identical text inside 3 s coalesces with a counter instead of stacking', () => {
    let stack = pushToast([], 'Cargo full', 'warn', 0);
    stack = pushToast(stack, 'Cargo full', 'warn', 1000);
    expect(stack).toHaveLength(1);
    expect(stack[0]?.count).toBe(2);
  });

  it('the counter resets once the toast has expired', () => {
    let stack = pushToast([], 'Cargo full', 'warn', 0);
    stack = pushToast(stack, 'Cargo full', 'warn', TOAST_DEFAULT_MS + TOAST_COALESCE_MS + 1);
    expect(stack).toHaveLength(1);
    expect(stack[0]?.count).toBe(1);
  });

  it(`no more than ${TOAST_MAX} stack; the oldest is dropped`, () => {
    let stack: ReturnType<typeof pushToast> = [];
    for (const text of ['a', 'b', 'c', 'd']) stack = pushToast(stack, text, 'info', 100);
    expect(stack.map((entry) => entry.text)).toEqual(['b', 'c', 'd']);
  });

  it('pruning drops only what has expired', () => {
    let stack = pushToast([], 'a', 'info', 0);
    stack = pushToast(stack, 'b', 'info', 1000);
    const alive = pruneToasts(stack, TOAST_DEFAULT_MS + 1);
    expect(alive.map((entry) => entry.text)).toEqual(['b']);
  });

  it('is pure: the input stack is never written', () => {
    const stack = pushToast([], 'a', 'info', 0);
    const before = JSON.stringify(stack);
    pushToast(stack, 'a', 'info', 100);
    pushToast(stack, 'b', 'info', 100);
    pruneToasts(stack, 99999);
    expect(JSON.stringify(stack)).toBe(before);
  });
});

describe('formatTime', () => {
  it('formats seconds, minutes and hours the way the slot rows do', () => {
    expect(formatTime(42)).toBe('42s');
    expect(formatTime(12 * 60)).toBe('12m');
    expect(formatTime(3600 + 4 * 60)).toBe('1h 04m');
    expect(formatTime(Number.NaN)).toBe('0s');
  });
});

describe('computePlayerStats (creation preview, AC-17)', () => {
  it('moves with the attributes it previews', () => {
    const base = computePlayerStats('marine', { might: 3, vigor: 3, agility: 1, tech: 1 }, 1);
    const more = computePlayerStats('marine', { might: 5, vigor: 4, agility: 2, tech: 1 }, 1);
    expect(more.hp).toBeGreaterThan(base.hp);
    expect(more.damage).toBeGreaterThan(base.damage);
    expect(more.speed).toBeGreaterThan(base.speed);
  });

  it('applies the class passives over the shared base', () => {
    const attrs = { might: 2, vigor: 2, agility: 2, tech: 2 };
    const marine = computePlayerStats('marine', attrs, 1);
    const scout = computePlayerStats('scout', attrs, 1);
    expect(marine.hp).toBeGreaterThan(scout.hp); // marine +20 max HP
    expect(scout.speed).toBeGreaterThan(marine.speed); // scout ×1.15 speed
    expect(scout.speed).toBeCloseTo(TUNING.PLAYER_SPEED * 1.04 * 1.15, 2);
  });
});

describe('accept/abandon mission helpers', () => {
  it('accept adds the mission once; a second accept is refused', () => {
    const data = save();
    expect(acceptMission(data, OPEN)).toBe(true);
    expect(acceptMission(data, OPEN)).toBe(false);
    expect(data.progress.missionsActive).toEqual([{ id: 'c1_m1', stage: 0, counters: {} }]);
  });

  it('abandon removes it; abandoning a mission that is not running is refused', () => {
    const data = save();
    acceptMission(data, OPEN);
    expect(abandonMission(data, 'c1_m1')).toBe(true);
    expect(data.progress.missionsActive).toEqual([]);
    expect(abandonMission(data, 'c1_m1')).toBe(false);
  });

  it('a replay keeps its place in missionsDone (E2)', () => {
    const data = save((d) => d.progress.missionsDone.push('c1_m1'));
    expect(acceptMission(data, OPEN)).toBe(true);
    expect(data.progress.missionsDone).toContain('c1_m1');
  });
});

describe('slotLine (AC-4)', () => {
  it('prints name, class, level, planet and playtime in reading order', () => {
    expect(
      slotLine({ slot: 0, empty: false, name: 'Vance', classId: 'marine', level: 7, planet: 'cinder4', playtimeSec: 3840 }),
    ).toBe('Vance · Marine · Lv 7 · Cinder-4 · 1h 04m');
  });

  it('a run parked at the station has no planet and reads Station', () => {
    expect(slotLine({ slot: 1, empty: false, name: 'V', classId: 'scout', level: 1, planet: null, playtimeSec: 60 })).toBe(
      'V · Scout · Lv 1 · Station · 1m',
    );
  });

  it('empty and corrupt slots keep SPEC-007 wording', () => {
    expect(slotLine({ slot: 2, empty: true })).toBe('Empty');
    expect(slotLine({ slot: 2, empty: false, corrupt: true })).toBe('Corrupt');
  });
});

describe('passiveText (AC-14)', () => {
  it('prints every effect the marine passive carries', () => {
    expect(passiveText({ damageMult: 1.15, maxHpBonus: 20 })).toBe('+15% damage · +20 max HP');
  });

  it('covers discounts, multipliers and the radar flag', () => {
    expect(passiveText({ refitDiscount: 0.15, companionEffectMult: 1.25 })).toBe(
      '−15% ship and companion prices · +25% companion effect',
    );
    expect(passiveText({ moveSpeedMult: 1.15, pickupRadiusMult: 1.25, nodeRadar: true })).toBe(
      '+15% move speed · +25% pickup radius · resource radar',
    );
  });

  it('an empty passive is an empty line, not a crash', () => {
    expect(passiveText({})).toBe('');
  });

  it('prints the dash cooldown multiplier, and the Scout carries it (SPEC-038 §4.1)', () => {
    expect(passiveText({ dashCooldownMult: 0.8 })).toBe('−20% dash cooldown');
    expect(passiveText(CLASSES.scout.passive)).toBe(
      '+15% move speed · +25% pickup radius · resource radar · −20% dash cooldown',
    );
  });
});

describe('DIFFICULTY_LINES (SPEC-038 §4.6)', () => {
  it('has a line for every difficulty, and casual names the softer storms and wind-ups', () => {
    expect(Object.keys(DIFFICULTY_LINES).sort()).toEqual([...DIFFICULTIES].sort());
    expect(DIFFICULTY_LINES.casual).toBe(
      'Casual — softer hits and storms, longer wind-ups, kinder deaths; the story is unchanged.',
    );
    expect(DIFFICULTY_LINES.normal).toBe('Normal — the pressure the game was tuned for.');
  });
});

describe('failText (AC-42)', () => {
  it('covers every FailReason with a printable line', () => {
    const reasons = [
      'insufficient_tokens',
      'insufficient_resources',
      'max_tier',
      'prerequisite',
      'not_found',
      'inventory_full',
      'cargo_full',
      'locked',
    ] as const;
    for (const reason of reasons) {
      expect(failText(reason)).not.toBe('');
    }
    expect(failText('insufficient_tokens')).toBe('Not enough tokens');
    expect(failText('prerequisite')).toBe('Requires the previous tier');
  });
});

describe('rewardsText', () => {
  it('prints xp, tokens, resources and items in order', () => {
    expect(
      rewardsText({ xp: 120, tokens: 40, resources: { lithium: 20 }, items: [{ itemId: 'medkit', qty: 2 }] }),
    ).toBe('+120 XP · +40 ◈ · +20 lithium · Medkit ×2');
  });

  it('a replay halves xp and tokens and drops everything else (E2)', () => {
    expect(rewardsText({ xp: 125, tokens: 41, resources: { oil: 30 }, items: [{ itemId: 'medkit', qty: 1 }] }, true)).toBe(
      '+62 XP · +20 ◈',
    );
  });
});

describe('companionEffectText (AC-39)', () => {
  it('reads the scanner drone levels off the table', () => {
    expect(companionEffectText({ autoCollectRadius: 6, nodeRadar: true })).toBe('collects within 6 m · node radar');
  });

  it('covers station and flight domains', () => {
    expect(companionEffectText({ cargoBonus: 100, shopDiscount: 0.1 })).toBe('+100 cargo · −10% shop prices');
    expect(companionEffectText({ shieldRegen: 2, autoAim: true, hullBonus: 20 })).toBe('+2/s shield regen · auto-aim · +20 hull');
  });
});

describe('gearCompareText (AC-47)', () => {
  it('prints tier and the stats that move between two weapons', () => {
    const text = gearCompareText('weapon_kinetic', 'weapon_laser');
    expect(text).toMatch(/^T0 → T1/);
    expect(text).toContain('damage');
  });

  it('compares armor by armor stats', () => {
    expect(gearCompareText('armor_scrap', 'armor_composite')).toMatch(/^T0 → T1 · armor \d+ → \d+/);
  });

  it('crossing kinds compares nothing', () => {
    expect(gearCompareText('weapon_kinetic', 'armor_scrap')).toBe('');
    expect(gearCompareText('weapon_kinetic', 'medkit')).toBe('');
  });

  // SPEC-025 §4.8: tiers only mean something inside one ladder, so a rifle
  // against a handgun is as incomparable as a weapon against armor.
  it('crossing lines compares nothing', () => {
    expect(gearCompareText('pistol_service', 'weapon_kinetic')).toBe('');
    expect(gearCompareText('weapon_laser', 'pistol_service')).toBe('');
  });
});

describe('gearTooltip (AC-47)', () => {
  it('compares an equipped weapon to the next tier in its ladder', () => {
    expect(gearTooltip('weapon_kinetic')).toBe('T0 → T1 · DPS 36 → 72 · damage 12 → 18 · fire rate 3 → 4 · range 14 → 18');
  });

  it('compares an equipped armor to the next tier in its ladder', () => {
    expect(gearTooltip('armor_scrap')).toBe('T0 → T1 · armor 0 → 15 · hazard resist 0 → 0.25');
  });

  it('the top tier states it plainly instead of comparing to nothing', () => {
    expect(gearTooltip('weapon_lithium')).toBe('T3 — top tier');
    expect(gearTooltip('armor_ablative')).toBe('T3 — top tier');
  });

  // SPEC-025 §4.8: the pistol is the whole handgun line for now, so its ladder
  // ends where it starts rather than stepping sideways into the rifles.
  it('reads the item’s own line, not the next tier of any line', () => {
    expect(gearTooltip('pistol_service')).toBe('T0 — top tier');
  });

  it('a non-gear id compares nothing', () => {
    expect(gearTooltip('medkit')).toBe('');
  });
});

// ---------------------------------------------------------------- SPEC-034

/**
 * SPEC-034 §4.9: a defend or escort stage that goes back to zero says why. A
 * death, a recall and a reload announce themselves; a beacon that fell and a
 * probe that was lost did not, and the player watched a four-minute timer
 * restart with no idea what had happened.
 */
describe('stageResetText (SPEC-034 §4.9)', () => {
  it('names the POI that went down and the follower that was lost', () => {
    expect(stageResetText('poi_destroyed', 'survey_beacon', null)).toBe(
      'The Survey Beacon went down — the defence restarts.',
    );
    expect(stageResetText('follower_died', null, 'science_probe')).toBe(
      'The Science Probe was lost — the escort restarts.',
    );
  });

  it('says nothing for the reasons that already speak for themselves', () => {
    for (const reason of ['death', 'recall', 'reload'] as const) {
      expect(stageResetText(reason, 'survey_beacon', 'science_probe'), reason).toBeNull();
    }
    // …and nothing it cannot name.
    expect(stageResetText('poi_destroyed', null, null)).toBeNull();
    expect(stageResetText('follower_died', null, null)).toBeNull();
  });
});

/**
 * SPEC-034 §4.14: one max-HP formula. A Marine read 170, 150 and 160 in three
 * screens, because creation added the class bonus on top of a `maxHp` that had
 * already been given a different vigor weight from combat's.
 */
describe('one max HP (SPEC-034 §4.14)', () => {
  it('the creation preview shows the number the player fights with', () => {
    const attributes = { might: 3, vigor: 8, agility: 1, tech: 1 };
    // 100 base + 20 marine + 8 x 8 vigor + 0 = 184.
    expect(maxHp('marine', attributes, 1)).toBe(184);
    expect(computePlayerStats('marine', attributes, 1).hp).toBe(184);
    // Every level is a flat +4, on every class.
    expect(maxHp('marine', attributes, 5)).toBe(200);
    expect(maxHp('scout', attributes, 1)).toBe(164); // no class bonus
    expect(computePlayerStats('scout', attributes, 1).hp).toBe(164);
  });
});

/**
 * SPEC-034 §4.12: what a full hold says when a collect objective still wants the
 * units it cannot carry.
 */
describe('the shipped-home toast (SPEC-034 §4.12)', () => {
  it('reads as §4.12 gives it, and shares CARGO FULL’s throttle', () => {
    expect(SHIPPED_TOAST_TEXT).toBe('Hold full — surplus shipped to Command Relay.');
    expect(CARGO_TOAST_SECONDS).toBe(3);
  });
});

// --------------------------------------------------- SPEC-035: the readable view

// SPEC-037 §4.12: SPEC-035's scheme-only distance became §6.1's cases — the
// camera goes by the screen's short side as well as by the scheme.
describe('cameraDistance (SPEC-035 §4.2, SPEC-037 §4.7)', () => {
  it('is 17 only on touch with a short side under 500 px, and 22 otherwise', () => {
    expect(cameraDistance('touch', 390)).toBe(17);
    // A tablet is a monitor-sized screen that happens to be touched.
    expect(cameraDistance('touch', 820)).toBe(22);
    expect(cameraDistance('keyboard', 390)).toBe(22);
    // A gamepad is a desktop screen, so it keeps the keyboard distance.
    expect(cameraDistance('gamepad', 390)).toBe(22);
    expect(TOUCH_CAMERA_MAX_SHORT_SIDE).toBe(500);
    expect(cameraDistance('touch', 499)).toBe(17);
    expect(cameraDistance('touch', 500)).toBe(22);
  });
});

describe('cameraFov (SPEC-037 §4.7)', () => {
  it('is 2·atan(tan 24° / aspect), clamped to 40°–66°', () => {
    const cases: ReadonlyArray<readonly [number, number]> = [
      [1.78, 40],
      [1.33, 40],
      [1, 48.0],
      [0.75, 61.4],
      [0.46, 66],
    ];
    for (const [aspect, fov] of cases) expect(Math.abs(cameraFov(aspect) - fov), `aspect ${aspect}`).toBeLessThanOrEqual(0.1);
    // §4.7's table carries one more row between the two clamps.
    expect(Math.abs(cameraFov(0.695) - 65.3)).toBeLessThanOrEqual(0.1);
    expect([FOV_MIN, FOV_MAX]).toEqual([40, 66]);
  });

  it('never leaves the range, however wide or narrow the screen', () => {
    for (const aspect of [0.1, 0.3, 0.6, 0.9, 1.1, 1.22, 1.5, 2, 3.5, 10]) {
      expect(cameraFov(aspect)).toBeGreaterThanOrEqual(FOV_MIN);
      expect(cameraFov(aspect)).toBeLessThanOrEqual(FOV_MAX);
    }
  });
});

// ------------------------------------------------- SPEC-037: the HUD for every screen

/** The rising edges `flashGate` lets through for a train of hit times. */
function edgesOf(hits: readonly number[]): number[] {
  const edges: number[] = [];
  let lastEdgeAt = -Infinity;
  for (const t of hits) {
    if (flashGate(lastEdgeAt, t) === 'edge') {
      edges.push(t);
      lastEdgeAt = t;
    }
  }
  return edges;
}

/** The most edges any one-second window holds (closed at both ends, the strict reading). */
function mostInOneSecond(edges: readonly number[]): number {
  let most = 0;
  for (let i = 0; i < edges.length; i++) {
    let n = 0;
    for (let j = i; j < edges.length && (edges[j] as number) - (edges[i] as number) <= 1 + 1e-9; j++) n++;
    most = Math.max(most, n);
  }
  return most;
}

describe('flashGate (SPEC-037 §4.6, E71)', () => {
  it('extends inside FLASH_MIN_GAP of the last edge and starts a new one past it', () => {
    expect(FLASH_MIN_GAP).toBe(0.35);
    expect(flashGate(-Infinity, 0)).toBe('edge');
    expect(flashGate(1, 1.2)).toBe('extend');
    expect(flashGate(1, 1.349)).toBe('extend');
    expect(flashGate(1, 1.35)).toBe('edge');
    expect(flashGate(1, 2)).toBe('edge');
    expect(flashGate(1, 1.3, 0.2)).toBe('edge');
  });

  it('holds any regular hit train to three rising edges in any second', () => {
    for (const every of [0.05, 0.2, 0.4]) {
      const hits: number[] = [];
      for (let t = 0; t <= 3 + 1e-9; t += every) hits.push(Math.round(t * 1000) / 1000);
      const edges = edgesOf(hits);
      expect(edges.length, `every ${every} s`).toBeGreaterThan(0);
      expect(mostInOneSecond(edges), `every ${every} s`).toBeLessThanOrEqual(3);
    }
  });

  it('holds a seeded random train to three rising edges in any second', () => {
    const rng = new Rng(37);
    const hits: number[] = [];
    let t = 0;
    while (t < 30) {
      t += rng.float(0.01, 0.5);
      hits.push(t);
    }
    const edges = edgesOf(hits);
    expect(edges.length).toBeGreaterThan(20);
    expect(mostInOneSecond(edges)).toBeLessThanOrEqual(3);
  });
});

describe('compositeOver (SPEC-037 §4.5)', () => {
  it('puts the HUD plate over Vetra’s snow at about #3a3f44', () => {
    const out = compositeOver('rgba(4, 6, 10, 0.75)', '#dbe9f2');
    expect(out).toMatch(/^#[0-9a-f]{6}$/);
    const want = [0x3a, 0x3f, 0x44];
    for (let i = 0; i < 3; i++) {
      expect(Math.abs(parseInt(out.slice(1 + i * 2, 3 + i * 2), 16) - (want[i] as number))).toBeLessThanOrEqual(1);
    }
  });

  it('is the ground at alpha 0 and the colour at alpha 1', () => {
    expect(compositeOver('rgba(255, 0, 0, 0)', '#123456')).toBe('#123456');
    expect(compositeOver('rgba(255, 0, 0, 1)', '#123456')).toBe('#ff0000');
    expect(compositeOver('#00ff00', '#123456')).toBe('#00ff00');
  });
});

describe('slotStateText (SPEC-037 §4.4)', () => {
  const view = (state: SlotState, patch: Partial<SlotView> = {}): SlotView => ({
    itemId: 'weapon_kinetic',
    state,
    cd: 0,
    heat: 0,
    charges: 0,
    maxCharges: 0,
    cdSeconds: 0,
    ...patch,
  });

  it('prints the state only while the slot is not ready, and never READY', () => {
    expect(slotStateText(view('ready'))).toBe('');
    expect(slotStateText(view('empty', { itemId: null }))).toBe('');
    expect(slotStateText(view('heat', { heat: 0.64 }))).toBe('HEAT 64%');
    expect(slotStateText(view('lock', { heat: 1 }))).toBe('LOCK');
    expect(slotStateText(view('recharge', { cd: 0.4, cdSeconds: 2.43 }))).toBe('2.4 s');
    expect(slotStateText(view('switch', { cd: 0.8, cdSeconds: 0.2 }))).toBe('0.2 s');
  });

  it('covers every SlotState, and none of them reads READY', () => {
    const states: readonly SlotState[] = ['ready', 'switch', 'empty', 'heat', 'lock', 'recharge'];
    for (const state of states) {
      const text = slotStateText(view(state, { heat: 0.5, cdSeconds: 1.25 }));
      expect(typeof text, state).toBe('string');
      expect(text, state).not.toMatch(/READY/i);
    }
  });
});

describe('walletLit (SPEC-037 §4.2)', () => {
  it('stays lit for WALLET_LIT_SECONDS after a change, then dims', () => {
    expect(WALLET_LIT_SECONDS).toBe(5);
    expect(walletLit(10, 14.9, false)).toBe(true);
    expect(walletLit(10, 15.1, false)).toBe(false);
    // Nothing has changed yet this visit.
    expect(walletLit(-Infinity, 0, false)).toBe(false);
  });

  it('stays lit while a collect or deliver objective is open', () => {
    expect(walletLit(10, 15.1, true)).toBe(true);
    expect(walletLit(-Infinity, 1000, true)).toBe(true);
  });
});

describe('shiftToasts (SPEC-037 §4.3)', () => {
  it('moves every expiry by the given milliseconds and keeps order, text and counts', () => {
    let stack = pushToast([], 'Saved', 'info', 1000);
    stack = pushToast(stack, 'Cargo full', 'warn', 1200);
    stack = pushToast(stack, 'Cargo full', 'warn', 1300);
    const before = JSON.stringify(stack);
    const shifted = shiftToasts(stack, 4000);
    expect(JSON.stringify(stack)).toBe(before); // a new array; the input is not written
    expect(shifted).not.toBe(stack);
    expect(shifted.map((entry) => entry.text)).toEqual(['Saved', 'Cargo full']);
    expect(shifted.map((entry) => entry.count)).toEqual([1, 2]);
    expect(shifted.map((entry) => entry.kind)).toEqual(['info', 'warn']);
    expect(shifted.map((entry) => entry.shownAt)).toEqual(stack.map((entry) => entry.shownAt));
    expect(shifted.map((entry) => entry.expiresAt)).toEqual(stack.map((entry) => entry.expiresAt + 4000));
  });

  it('keeps a held toast alive for the time it had left', () => {
    // Shown at 0 for 2.5 s, held from 1 s to 9 s: 1.5 s left when the hold ends.
    const stack = pushToast([], 'Test toast', 'info', 0);
    const released = shiftToasts(stack, 8000);
    expect(pruneToasts(released, 9000)).toHaveLength(1);
    expect(pruneToasts(released, 10_400)).toHaveLength(1);
    expect(pruneToasts(released, 10_600)).toHaveLength(0);
  });
});

describe('surfaceFogRange (SPEC-035 §4.4)', () => {
  it('starts the fog at the camera and spans FOG_SPAN_K / density past it', () => {
    const range = surfaceFogRange(0.014, 1, 22);
    expect(range.near).toBe(22);
    expect(range.far).toBeCloseTo(22 + FOG_SPAN_K / 0.014, 6);
    expect(FOG_SPAN_K).toBe(2.2);
  });

  it('shortens the span as a storm thickens fogMult, and keeps near at the camera', () => {
    const calm = surfaceFogRange(0.014, 1, 22);
    const storm = surfaceFogRange(0.014, 3, 22);
    expect(storm.near).toBe(22);
    expect(storm.far - storm.near).toBeLessThan(calm.far - calm.near);
    expect(storm.far).toBeCloseTo(22 + FOG_SPAN_K / (0.014 * 3), 6);
  });

  it('follows the camera distance, and never goes behind it', () => {
    expect(surfaceFogRange(0.02, 1, 17).near).toBe(17);
    expect(surfaceFogRange(0.02, 1, -5).near).toBe(0);
    // A zero density does not divide by zero.
    expect(Number.isFinite(surfaceFogRange(0, 1, 22).far)).toBe(true);
  });
});

describe('occludes (SPEC-035 §4.5)', () => {
  // The camera sits up and to the +x/+z side, the way the 55°/45° rig does.
  const camera = { x: 14, y: 18, z: 14 };
  const player = { x: 0, z: 0 };

  it('is true for a tall prop on the camera side of the player', () => {
    expect(occludes(camera, player, { x: 5, z: 5, radius: 2, height: 8 })).toBe(true);
  });

  it('is false for a prop behind the player', () => {
    expect(occludes(camera, player, { x: -5, z: -5, radius: 2, height: 8 })).toBe(false);
  });

  it('is false for a prop beside the sight line', () => {
    expect(occludes(camera, player, { x: 5, z: -5, radius: 2, height: 8 })).toBe(false);
  });

  it('is false for a prop too short to reach the line', () => {
    expect(occludes(camera, player, { x: 5, z: 5, radius: 2, height: 0.4 })).toBe(false);
  });

  it('uses radius × 0.9, so a prop just outside that circle does not occlude', () => {
    // The sight line runs along x = z, so a body at (6.35, 3.65) sits 1.91 m
    // to its side: inside 2.2 × 0.9 = 1.98, outside 2 × 0.9 = 1.8.
    expect(occludes(camera, player, { x: 6.35, z: 3.65, radius: 2.2, height: 8 })).toBe(true);
    expect(occludes(camera, player, { x: 6.35, z: 3.65, radius: 2, height: 8 })).toBe(false);
  });

  it('is false for a prop with no footprint or no height', () => {
    expect(occludes(camera, player, { x: 5, z: 5, radius: 0, height: 8 })).toBe(false);
    expect(occludes(camera, player, { x: 5, z: 5, radius: 2, height: 0 })).toBe(false);
  });

  it('pins the opacity a faded prop reaches', () => {
    expect(OCCLUDER_OPACITY).toBe(0.3);
  });
});

describe('upgradeDeltaText (SPEC-035 §4.12)', () => {
  it('names every metric in the words §4.12 gives', () => {
    expect(upgradeDeltaText('speedMult', 1, 1.15)).toBe('Speed +15 %');
    expect(upgradeDeltaText('fuelMult', 1, 0.9)).toBe('Fuel use −10 %');
    expect(upgradeDeltaText('hullHp', 100, 150)).toBe('Hull 100 → 150');
    expect(upgradeDeltaText('shieldHp', 40, 80)).toBe('Shield 40 → 80');
    expect(upgradeDeltaText('cargoCap', 400, 600)).toBe('Cargo 400 → 600');
    expect(upgradeDeltaText('damage', 10, 13)).toBe('Gun damage 10 → 13');
    expect(upgradeDeltaText('fireRate', 4, 5)).toBe('Fire rate 4 → 5 /s');
  });

  it('falls back to the key split into words for an unknown metric', () => {
    expect(upgradeDeltaText('heatMax', 1, 2)).toBe('Heat max 1 → 2');
  });

  /**
   * §4.12: the invariant that matters — no `UPGRADES` metric may reach the
   * fallback, because that is what would print a variable name at the player.
   */
  it('covers every UPGRADES metric without falling back', () => {
    const named = new Set<string>(UPGRADE_METRIC_KEYS);
    const problems: string[] = [];
    for (const upgrade of Object.values(UPGRADES)) {
      for (const metric of Object.keys(upgrade.metrics)) {
        if (!named.has(metric)) problems.push(metric);
      }
    }
    expect(problems).toEqual([]);
  });

  it('never prints a metric key, for any tier of any upgrade', () => {
    const keyish = /[a-z]+(Mult|Hp|Cap)\b/;
    for (const upgrade of Object.values(UPGRADES)) {
      for (const [metric, values] of Object.entries(upgrade.metrics)) {
        for (let tier = 0; tier < 3; tier++) {
          const text = upgradeDeltaText(metric, values[tier] as number, values[tier + 1] as number);
          expect(text, `${metric} tier ${tier}`).not.toMatch(keyish);
        }
      }
    }
  });
});

describe('contrastRatio (SPEC-035 §4.1)', () => {
  it('is 21 for black on white and 1 for a colour against itself', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 6);
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 6);
    expect(contrastRatio('#3a7a5a', '#3a7a5a')).toBeCloseTo(1, 10);
  });

  it('accepts the short form and reads an unparseable colour as black', () => {
    expect(contrastRatio('#fff', '#000')).toBeCloseTo(21, 6);
    expect(contrastRatio('not a colour', '#ffffff')).toBeCloseTo(21, 6);
  });

  it('pins the WCAG luminance of white and black', () => {
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 10);
    expect(relativeLuminance('#000000')).toBeCloseTo(0, 10);
  });
});

// ------------------------------------------------------------------ SPEC-039

/** A real `Economy` over `data`, for the prices the Refit line charges. */
function economyOf(data: Save): Economy {
  const sink: EventSink = { emit: () => {} };
  return new Economy(data, sink, new Progression(data, sink));
}

describe('gearStatLines and the shop stat line (SPEC-039 §4.6)', () => {
  it('prints the DPS of each cooldown model, rounded off weaponDps', () => {
    expect(gearStatLines('weapon_laser')).toContain('DPS 72');
    expect(gearStatLines('mg_scrap')).toContain('DPS 110 firing · 64 sustained');
    expect(gearStatLines('mg_rotary')).toContain('DPS 156 firing · 84 sustained');
    expect(gearStatLines('launcher_rocket')).toContain('DPS 15 sustained');
    expect(gearStatLines('launcher_grenade')).toContain('DPS 19 sustained');
    // The other lines are unchanged.
    expect(gearStatLines('mg_scrap')).toEqual([
      'Damage 11',
      'Fire rate 10/s',
      'DPS 110 firing · 64 sustained',
      'Range 13 m',
      'Projectile speed 30 m/s',
      'Pierce 0',
      'Overheats — locks until it cools',
    ]);
  });

  it('the shop row prints the DPS line and the range, or the armour numbers', () => {
    expect(shopStatText('weapon_laser')).toBe('DPS 72 · range 18 m');
    expect(shopStatText('mg_scrap')).toBe('DPS 110 firing · 64 sustained · range 13 m');
    expect(shopStatText('launcher_rocket')).toBe('DPS 15 sustained · range 22 m');
    // 15 / (15 + 100) of the damage, and a quarter of the weather.
    expect(shopStatText('armor_composite')).toBe('armor 15 · −13% damage · hazard 25%');
    expect(shopStatText('armor_ablative')).toBe('armor 45 · −31% damage · hazard 75%');
    expect(shopStatText('medkit')).toBe('');
  });
});

describe('gearCompare and gearCompareText (SPEC-039 §4.6)', () => {
  it('compares two weapons of one slot across lines: DPS, firing, damage, rate, range, cooldown — no tier', () => {
    expect(gearCompare('weapon_laser', 'mg_scrap')).toEqual([
      { stat: 'dps', label: 'DPS', from: 72, to: 64 },
      { stat: 'firing', label: 'firing DPS', from: 72, to: 110 },
      { stat: 'damage', label: 'damage', from: 18, to: 11 },
      { stat: 'fireRate', label: 'fire rate', from: 4, to: 10 },
      { stat: 'range', label: 'range', from: 18, to: 13 },
      { stat: 'cooldown', label: 'cooldown', from: 'none', to: 'heat' },
    ]);
    expect(gearCompareText('weapon_laser', 'mg_scrap')).toBe(
      'DPS 72 → 64 · firing DPS 72 → 110 · damage 18 → 11 · fire rate 4 → 10 · range 18 → 13 · cooldown none → heat',
    );
    expect(gearCompareText('weapon_kinetic', 'mg_scrap')).toBe(
      'DPS 36 → 64 · firing DPS 36 → 110 · damage 12 → 11 · fire rate 3 → 10 · range 14 → 13 · cooldown none → heat',
    );
  });

  it('inside one line it leads with the tier, and compares heat or recharge where both carry it', () => {
    expect(gearCompareText('mg_scrap', 'mg_rotary')).toBe(
      'T1 → T3 · DPS 64 → 84 · firing DPS 110 → 156 · damage 11 → 13 · fire rate 10 → 12 · range 13 → 16',
    );
    expect(gearCompareText('launcher_rocket', 'launcher_grenade')).toBe(
      'T1 → T2 · DPS 15 → 19 · damage 90 → 60 · fire rate 1 → 2.5 · range 22 → 16 · recharge 6 s → 9 s',
    );
    expect(gearCompareText('pistol_service', 'pistol_magnum')).toBe(
      'T0 → T2 · DPS 27 → 48 · damage 9 → 30 · fire rate 3 → 1.6 · range 12 → 15 · pierce 0 → 1',
    );
  });

  it('armour compares as it always did', () => {
    expect(gearCompareText('armor_scrap', 'armor_composite')).toBe('T0 → T1 · armor 0 → 15 · hazard resist 0 → 0.25');
    expect(gearCompare('armor_composite', 'armor_reactive').map((part) => part.stat)).toEqual(['tier', 'armor', 'hazardResist']);
  });

  it('items of different slots, and consumables, compare as nothing', () => {
    expect(gearCompare('weapon_laser', 'pistol_magnum')).toEqual([]);
    expect(gearCompare('weapon_laser', 'launcher_rocket')).toEqual([]);
    expect(gearCompare('weapon_laser', 'armor_composite')).toEqual([]);
    expect(gearCompare('medkit', 'wheat_ration')).toEqual([]);
    expect(gearCompareText('weapon_laser', 'pistol_magnum')).toBe('');
    expect(gearCompareText('launcher_rocket', 'mg_scrap')).toBe('');
  });

  it('the same piece compares as nothing', () => {
    expect(gearCompare('mg_scrap', 'mg_scrap')).toEqual([]);
  });
});

describe('bossDropText (SPEC-039 §4.6)', () => {
  it('names the piece while the mission is new and the piece unowned', () => {
    expect(bossDropText(save(), MISSIONS.c1_m3)).toBe('Boss drop: Rocket Launcher');
    expect(bossDropText(save(), MISSIONS.c2_m3)).toBe('Boss drop: Scrap Chaingun');
  });

  it('reads 25 lithium on a replay, or with the piece carried or worn', () => {
    expect(bossDropText(save((s) => void s.progress.missionsDone.push('c1_m3')), MISSIONS.c1_m3)).toBe('Boss drop: 25 lithium');
    expect(bossDropText(save((s) => void s.inventory.push({ itemId: 'launcher_rocket', qty: 1 })), MISSIONS.c1_m3)).toBe(
      'Boss drop: 25 lithium',
    );
    expect(bossDropText(save((s) => void (s.equipped.heavy = 'launcher_rocket')), MISSIONS.c1_m3)).toBe('Boss drop: 25 lithium');
  });

  it('is null for a mission with no boss objective', () => {
    expect(bossDropText(save(), MISSIONS.c1_m1)).toBeNull();
    expect(bossDropText(save(), MISSIONS.c1_m2)).toBeNull();
  });
});

describe('the Refit line (SPEC-039 §4.6)', () => {
  it('a new marine 6/5/1/1 reads Vetra and the chapter-2 loadout at its discounted prices', () => {
    const data = save();
    expect(refitText(data, economyOf(data))).toBe('Refit for Vetra: Composite Weave 39 · Scanner Drone 20 · Laser Carbine 39');
    expect(refitLine(data, economyOf(data))?.planet).toBe('vetra');
  });

  it('drops what the save owns, and reads ready with nothing missing', () => {
    const laser = save((s) => void s.inventory.push({ itemId: 'weapon_laser', qty: 1 }));
    expect(refitText(laser, economyOf(laser))).toBe('Refit for Vetra: Composite Weave 39 · Scanner Drone 20');
    const ready = save((s) => {
      s.inventory.push({ itemId: 'weapon_laser', qty: 1 });
      s.equipped.armor = 'armor_composite';
      s.companions.push({ id: 'scanner_drone', level: 1, enabled: true });
    });
    expect(refitText(ready, economyOf(ready))).toBe('Refit for Vetra: ready');
  });

  it('before Ferrum with shield 1, the shield tier the gate names is marked required', () => {
    const data = save((s) => {
      s.progress.visits = { cinder4: 3, vetra: 1, thessaly: 1 };
      s.inventory.push({ itemId: 'weapon_laser', qty: 1 });
      s.equipped.armor = 'armor_composite';
      s.companions.push({ id: 'scanner_drone', level: 1, enabled: true });
      s.ship.hull = 1;
      s.ship.shield = 1;
    });
    expect(refitText(data, economyOf(data))).toBe('Refit for Ferrum: Shield tier 2 88 (required) · Combat Drone 30');
    const line = refitLine(data, economyOf(data));
    expect(line?.entries.map((entry) => entry.required)).toEqual([true, false]);
  });

  it('prices every entry through the economy, discounts and all', () => {
    const data = save((s) => {
      s.player.classId = 'engineer';
      s.player.attributes = { ...CLASSES.engineer.baseAttributes, tech: 8 };
    });
    // 0.15 refit on the companion, 0.24 of tech on everything.
    expect(refitText(data, economyOf(data))).toBe(
      `Refit for Vetra: Composite Weave ${discountTokens(40, 0.24)} · Scanner Drone ${discountTokens(20, 0.39)} · Laser Carbine ${discountTokens(40, 0.24)}`,
    );
  });

  it('39-k: with every planet of chapter ≥ 2 landed on there is no line', () => {
    const data = save((s) => {
      for (const planet of PLANET_IDS) s.progress.visits[planet] = 1;
    });
    expect(refitLine(data, economyOf(data))).toBeNull();
    expect(refitText(data, economyOf(data))).toBeNull();
  });
});

describe('ship role and gate lines (SPEC-039 §4.5)', () => {
  it('says what each system acts on', () => {
    expect(shipRoleText('hull')).toBe('Flight: hull points');
    expect(shipRoleText('shield')).toBe('Flight: shield points');
    expect(shipRoleText('weapon')).toBe('Flight: nose guns');
    expect(shipRoleText('engine')).toBe('Flight time and fuel per jump');
    expect(shipRoleText('cargo')).toBe('The hold, on every planet');
  });

  it('marks the shield Required for Ferrum until the save meets the gate', () => {
    expect(shipGateText(save(), 'shield')).toBe('Required for Ferrum');
    expect(shipGateText(save((s) => void (s.ship.shield = 1)), 'shield')).toBe('Required for Ferrum');
    expect(shipGateText(save((s) => void (s.ship.shield = 2)), 'shield')).toBeNull();
    expect(shipGateText(save((s) => void (s.ship.shield = 3)), 'shield')).toBeNull();
    for (const system of ['hull', 'weapon', 'engine', 'cargo'] as const) expect(shipGateText(save(), system)).toBeNull();
  });
});

describe('one damage formula (SPEC-039 §4.7)', () => {
  it('the preview carries the level factor: a marine 6/5/1/1 at level 17 with the Lithium Edge reads 72', () => {
    const attributes = { might: 6, vigor: 5, agility: 1, tech: 1 };
    expect(computePlayerStats('marine', attributes, 17, 'weapon_lithium').damage).toBe(72);
    // Unchanged at level 1: 40 × 1.10 × 1.24.
    expect(computePlayerStats('marine', attributes, 1, 'weapon_lithium').damage).toBe(54.6);
  });
});

describe('the class card and the Quartermaster line (SPEC-039 §4.3, §4.5)', () => {
  it("prints the classes' passives off the table: the Engineer's refit and the Marine's ×1.10", () => {
    expect(passiveText(CLASSES.engineer.passive)).toBe('−15% ship and companion prices · +25% companion effect');
    expect(passiveText(CLASSES.marine.passive)).toBe('+10% damage · +20 max HP');
  });

  it('the Quartermaster reads −5 / −10 / −15 % shop prices, and never craft', () => {
    expect(COMPANIONS.quartermaster.levels.map((effect) => companionEffectText(effect))).toEqual([
      '+100 cargo · −5% shop prices',
      '+200 cargo · −10% shop prices',
      '+300 cargo · −15% shop prices',
    ]);
  });
});

// ------------------------------------------------ SPEC-040 §4.4: the HUD diff

describe('diffHudInto and copyHudInto (SPEC-040 §4.4, AC-20)', () => {
  const WEAPON_SLOTS = ['sidearm', 'primary', 'heavy'] as const;
  const QUICK_SLOTS = ['heal', 'explosive', 'utility'] as const;
  const SLOT_STATES: readonly SlotState[] = ['ready', 'switch', 'empty', 'heat', 'lock', 'recharge'];
  const ITEM_IDS = Object.keys(ITEMS) as Array<keyof typeof ITEMS>;

  function pick<T>(rng: Rng, values: readonly T[]): T {
    return values[rng.int(0, values.length - 1)] as T;
  }

  /** Small domains, so two random models agree on many keys and differ on some. */
  function small(rng: Rng): number {
    return rng.int(0, 2);
  }

  function slotView(rng: Rng): SlotView {
    return {
      itemId: rng.chance(0.3) ? null : pick(rng, ITEM_IDS),
      state: pick(rng, SLOT_STATES),
      cd: small(rng) / 2,
      heat: small(rng),
      charges: small(rng),
      maxCharges: 2,
      cdSeconds: small(rng),
    };
  }

  /** One field of a model, drawn at random — `null` ↔ object and array lengths included. */
  function field(rng: Rng, key: (typeof HUD_KEYS)[number]): unknown {
    switch (key) {
      case 'hp':
      case 'xp':
        return [small(rng), 2];
      case 'level':
      case 'tokens':
      case 'cargoCap':
        return small(rng);
      case 'resources':
        return { oil: small(rng), wheat: small(rng), water: small(rng), lithium: small(rng) };
      case 'objective':
        return rng.chance(0.4) ? null : { title: pick(rng, ['A', 'B']), line: 'Reach the rig', value: small(rng), target: 2 };
      case 'tracker':
        if (rng.chance(0.3)) return null;
        return {
          title: pick(rng, ['Dry Land', 'Oil']),
          stage: pick(rng, ['', 'stage 1/2']),
          rows: Array.from({ length: rng.int(0, 3) }, () => ({
            text: pick(rng, ['Reach', 'Collect']),
            done: rng.chance(0.5),
            focus: rng.chance(0.5),
            defendHp: rng.chance(0.5) ? null : small(rng) / 2,
          })),
          distance: rng.chance(0.5) ? null : small(rng),
          bearing: small(rng),
          pulse: rng.chance(0.5),
        };
      case 'weather':
        return { warning: rng.chance(0.5) ? null : 'dust_storm', active: null, secondsLeft: small(rng) };
      case 'shelter':
        return pick(rng, ['none', 'sheltered', 'hidden']);
      case 'boss':
        return rng.chance(0.5) ? null : { name: 'Wurm', hp: small(rng), max: 2 };
      case 'loadout':
        if (rng.chance(0.3)) return null;
        return {
          active: pick(rng, WEAPON_SLOTS),
          slots: { sidearm: slotView(rng), primary: slotView(rng), heavy: slotView(rng) },
          fallback: rng.chance(0.5),
        };
      case 'quick':
        if (rng.chance(0.3)) return null;
        return Object.fromEntries(QUICK_SLOTS.map((slot) => [slot, { itemId: rng.chance(0.5) ? null : pick(rng, ITEM_IDS), qty: small(rng) }]));
      case 'interact':
        return rng.chance(0.5) ? null : pick(rng, ['Press E', 'Need 20 more oil']);
      case 'interactAction':
      case 'walletLit':
        return rng.chance(0.5);
      case 'flight':
        return rng.chance(0.5)
          ? undefined
          : { shield: [small(rng), 2], hull: [small(rng), 2], throttle: small(rng), progress: small(rng) / 2, hostiles: small(rng), storm: rng.chance(0.5), holding: false };
    }
  }

  function randomModel(rng: Rng): HudModel {
    const model = createHudModel() as unknown as Record<string, unknown>;
    for (const key of HUD_KEYS) {
      const value = field(rng, key);
      if (value === undefined) delete model[key];
      else model[key] = value;
    }
    return model as unknown as HudModel;
  }

  /** `a` with each top-level key re-drawn at random, 30 % of the time. */
  function nearby(rng: Rng, a: HudModel): HudModel {
    const b = JSON.parse(JSON.stringify(a)) as Record<string, unknown>;
    for (const key of HUD_KEYS) {
      if (!rng.chance(0.3)) continue;
      const value = field(rng, key);
      if (value === undefined) delete b[key];
      else b[key] = value;
    }
    return b as unknown as HudModel;
  }

  /** The reference diff §6.1 names: every key whose JSON differs. */
  function reference(a: HudModel, b: HudModel): string[] {
    return HUD_KEYS.filter((key) => JSON.stringify(a[key]) !== JSON.stringify(b[key])).sort();
  }

  /** Every nested array and object under `root`, in walk order. */
  function containers(root: unknown, out: object[] = []): object[] {
    if (typeof root !== 'object' || root === null) return out;
    out.push(root);
    if (Array.isArray(root)) for (const value of root) containers(value, out);
    else for (const value of Object.values(root)) containers(value, out);
    return out;
  }

  it('walks every key of the model', () => {
    expect([...HUD_KEYS].sort()).toEqual(
      [...Object.keys(createHudModel()), 'flight'].sort(),
    );
  });

  it('agrees with a JSON reference diff over 200 seeded random pairs, and returns out', () => {
    const rng = new Rng(40);
    const out = new Set<(typeof HUD_KEYS)[number]>();
    let changedSome = 0;
    let changedNone = 0;
    for (let i = 0; i < 200; i++) {
      const a = randomModel(rng);
      const b = rng.chance(0.5) ? nearby(rng, a) : randomModel(rng);
      // Stale content in the scratch set must not survive the call.
      out.add('hp');
      out.add('flight');
      const result = diffHudInto(a, b, out);
      expect(result).toBe(out);
      expect([...result].sort(), `pair ${i}`).toEqual(reference(a, b));
      expect([...diffHud(a, b)].sort(), `pair ${i}`).toEqual(reference(a, b));
      if (result.size > 0) changedSome++;
      else changedNone++;
    }
    // The pairs exercised both answers, not only "everything changed".
    expect(changedSome).toBeGreaterThan(20);
    expect(changedNone + changedSome).toBe(200);
  });

  it('diffs to nothing after copyHudInto, whatever changed shape in between', () => {
    const rng = new Rng(41);
    const target = createHudModel();
    const out = new Set<(typeof HUD_KEYS)[number]>();
    for (let i = 0; i < 200; i++) {
      const source = randomModel(rng);
      expect(copyHudInto(target, source)).toBe(target);
      expect([...diffHudInto(target, source, out)], `model ${i}`).toEqual([]);
      expect(JSON.stringify(target)).toBe(JSON.stringify(source));
      // The copy is the target's own: nothing in it is shared with the source.
      const sourceContainers = new Set(containers(source));
      for (const node of containers(target)) expect(sourceContainers.has(node)).toBe(false);
    }
  });

  it('creates no new nested object on a second copy of an unchanged model', () => {
    const rng = new Rng(42);
    for (let i = 0; i < 50; i++) {
      const source = randomModel(rng);
      const target = copyHudInto(createHudModel(), source);
      const before = containers(target);
      copyHudInto(target, source);
      const after = containers(target);
      expect(after.length).toBe(before.length);
      after.forEach((node, index) => expect(node).toBe(before[index]));
    }
  });

  it('reuses every nested object when only values move', () => {
    const a = createHudModel();
    a.tracker = { title: 'Dry Land', stage: 'stage 1/2', rows: [{ text: 'Reach', done: false, focus: true, defendHp: null, count: -1 }], distance: 12, bearing: 0, pulse: false };
    a.boss = { name: 'Wurm', hp: 10, max: 20, phase: 1, marks: [0.4] };
    const last = copyHudInto(createHudModel(), a);
    const before = containers(last);
    a.hp = [5, 10];
    a.resources.oil = 7;
    a.boss = { name: 'Wurm', hp: 9, max: 20, phase: 1, marks: [0.4] }; // a new object, the same shape
    (a.tracker.rows[0] as { done: boolean }).done = true;
    a.tracker.distance = 11;
    copyHudInto(last, a);
    const after = containers(last);
    after.forEach((node, index) => expect(node).toBe(before[index]));
    expect(last.boss?.hp).toBe(9);
    expect(last.tracker?.rows[0]?.done).toBe(true);
  });

  it('shrinks an array in place and allocates only for a longer one or null → object', () => {
    const a = createHudModel();
    a.tracker = { title: 'T', stage: '', rows: [1, 2, 3].map((n) => ({ text: `r${n}`, done: false, focus: false, defendHp: null, count: -1 })), distance: null, bearing: 0, pulse: false };
    const last = copyHudInto(createHudModel(), a);
    const rows = last.tracker?.rows;
    const first = rows?.[0];
    a.tracker.rows.length = 1;
    copyHudInto(last, a);
    expect(last.tracker?.rows).toBe(rows);
    expect(last.tracker?.rows).toHaveLength(1);
    expect(last.tracker?.rows[0]).toBe(first);
    // null ↔ object: the object goes, and a new one is built when it returns.
    a.tracker = null;
    copyHudInto(last, a);
    expect(last.tracker).toBeNull();
    a.tracker = { title: 'U', stage: '', rows: [], distance: null, bearing: 0, pulse: false };
    copyHudInto(last, a);
    expect(last.tracker).not.toBe(a.tracker);
    expect(last.tracker).toEqual(a.tracker);
  });
});
