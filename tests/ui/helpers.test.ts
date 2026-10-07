// The pure UI helpers of SPEC-014 §6, one describe per helper. They are the
// only part of the UI layer tests can reach (SPEC-001 §4: tests exercise pure
// code), so everything a panel prints or diffs is proven here and `ui/` merely
// renders the return values.
import { describe, expect, it } from 'vitest';
import { Rng } from '@/core/Rng';
import { maxHp, newSave, type CharacterCreation, type Save } from '@/core/Save';
import {
  ATTRIBUTE_EFFECTS,
  CLASSES,
  COMPANIONS,
  DIFFICULTIES,
  ITEMS,
  MISSIONS,
  PLANET_IDS,
  PLANETS,
  TUNING,
  UPGRADES,
  type MissionDef,
} from '@/data/index';
import type { SlotState, SlotView } from '@/systems/Loadout';
import { discountTokens, Economy } from '@/systems/Economy';
import type { CalibrationPuzzle, ConduitPuzzle, PlatesPuzzle } from '@/systems/Puzzles';
import { Progression, type EventSink } from '@/systems/Progression';
import { SHIPPED_TOAST_TEXT } from '@/systems/Pickups';
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
  darkFogRange,
  descentRefusal,
  lightChipText,
  bypassNote,
  bypassOpen,
  cellLabel,
  platesPanelLine,
  puzzleHintLine,
  puzzleStatus,
  puzzleSubtitle,
  puzzleTitle,
  stonesText,
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
  departFuelText,
  departReason,
  diffHud,
  diffHudInto,
  HUD_KEYS,
  missionStatus,
  padEmptyText,
  priceText,
  pruneToasts,
  pushToast,
  requirementText,
  starmapFuelText,
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
  archiveLine,
  beginInstanceText,
  creationNextText,
  nextInstanceSheet,
  predecessorCacheText,
  restoreArchiveSheet,
  stageResetText,
  TOAST_COALESCE_MS,
  TOAST_DEFAULT_MS,
  TOAST_MAX,
  acceptedText,
  ATTRIBUTE_EFFECT_WORDS,
  attributeEffectText,
  attributeLine,
  firstSentence,
  needsLine,
  quitNote,
  resumedText,
  requirementItem,
  starmapPreselect,
  STAMINA_FULL_HIDE_SECONDS,
  staminaShown,
  STATUS_LABELS,
  deliveryNeedsText,
  depotDrawLabel,
  HOLD_FULL_TEXT,
  NOTHING_TO_SHIP_TEXT,
  shipHomeText,
  shippedHomeText,
  type DescentContext,
  type HudModel,
  type MissionStatus,
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
describe('surfaceHoldReason (SPEC-036 §4.3, SPEC-054 §4.2)', () => {
  it('orders beat, level, rotate, ui, modal', () => {
    const none = { beats: 0, level: false, rotate: false, ui: 0, modal: 0 };
    expect(surfaceHoldReason(none)).toBeNull();
    expect(surfaceHoldReason({ beats: 1, level: true, rotate: true, ui: 1, modal: 1 })).toBe('beat');
    expect(surfaceHoldReason({ beats: 0, level: true, rotate: true, ui: 1, modal: 1 })).toBe('level');
    expect(surfaceHoldReason({ beats: 0, level: false, rotate: true, ui: 1, modal: 1 })).toBe('rotate');
    expect(surfaceHoldReason({ beats: 0, level: false, rotate: false, ui: 1, modal: 1 })).toBe('ui');
    expect(surfaceHoldReason({ beats: 0, level: false, rotate: false, ui: 0, modal: 1 })).toBe('modal');
    // The rotate block alone holds, as the map does.
    expect(surfaceHoldReason({ ...none, rotate: true })).toBe('rotate');
    // A level swap alone holds too, outranking the rotate block.
    expect(surfaceHoldReason({ ...none, level: true })).toBe('level');
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

describe('the Relay depot’s words (SPEC-065 §4.5, §4.6)', () => {
  it('the terminal’s ship button reads Ship N home, or Nothing to ship at 0 (65-b)', () => {
    expect(shipHomeText(300)).toBe('Ship 300 home');
    expect(shipHomeText(1)).toBe('Ship 1 home');
    expect(shipHomeText(0)).toBe('Nothing to ship');
    expect(NOTHING_TO_SHIP_TEXT).toBe('Nothing to ship');
  });

  it('a ship press toasts what went where, and a deliver need above the reserve is named (E117)', () => {
    expect(shippedHomeText(300, 'oil')).toBe('Shipped 300 oil to Command Relay.');
    expect(shippedHomeText(45, 'lithium')).toBe('Shipped 45 lithium to Command Relay.');
    expect(deliveryNeedsText(100)).toBe('Delivery needs 100');
  });

  it('the Depot tab’s button follows §4.6’s table: Draw N, Hold full, Empty (E118)', () => {
    // Room in the hold, some at the depot: draw what fits.
    expect(depotDrawLabel(300, 300)).toEqual({ text: 'Draw 300', enabled: true });
    expect(depotDrawLabel(300, 150)).toEqual({ text: 'Draw 150', enabled: true });
    // A full hold, some at the depot: disabled.
    expect(depotDrawLabel(300, 0)).toEqual({ text: 'Hold full', enabled: false });
    expect(HOLD_FULL_TEXT).toBe('Hold full');
    // Nothing at the depot: Empty, whatever the hold holds.
    expect(depotDrawLabel(0, 0)).toEqual({ text: 'Empty', enabled: false });
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
      `Hazard resist ${Math.round(item.hazardResist * 100)} %`,
    ]);
  });

  it('pins a consumable: the effect in words and the stack', () => {
    expect(gearStatLines('medkit')).toEqual(['Heals 50 % instantly', 'Stack of 5']);
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

describe('the star map’s fuel lines count the depot (SPEC-065 §4.4, E119; review B-12)', () => {
  it('the info line’s `have` is the hold and the depot together', () => {
    expect(starmapFuelText(40, 180, 0)).toBe('Fuel: 40 oil (have 180)');
    // 0 aboard, 120 at the depot: the jump is paid, and the line says so.
    expect(starmapFuelText(40, 0, 120)).toBe('Fuel: 40 oil (have 120)');
  });

  it('the depart sheet names the tank, and the depot’s share when it holds any', () => {
    expect(departFuelText(40, 180, 0)).toBe('Fuel: 40 oil, charged now — you hold 180. The return trip is free.');
    expect(departFuelText(40, 20, 100)).toBe(
      'Fuel: 40 oil, charged now — you hold 120 (100 at the depot). The return trip is free.',
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
      remains: null,
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
    ).toBe('Vance · Marine · Lv 7 · Cinder-4 · 1 h 04 min');
  });

  it('a run parked at the station has no planet and reads Station', () => {
    expect(slotLine({ slot: 1, empty: false, name: 'V', classId: 'scout', level: 1, planet: null, playtimeSec: 60 })).toBe(
      'V · Scout · Lv 1 · Station · 1 min',
    );
  });

  it('empty and corrupt slots keep SPEC-007 wording', () => {
    expect(slotLine({ slot: 2, empty: true })).toBe('Empty');
    expect(slotLine({ slot: 2, empty: false, corrupt: true })).toBe('Corrupt');
  });
});

describe('slotLine after the endings and in a later instance (SPEC-058 §4.3)', () => {
  const vance = { slot: 0, empty: false, name: 'Vance', classId: 'marine', level: 11, planet: 'vetra', playtimeSec: 7200 } as const;

  it('a first run with no ending is unchanged', () => {
    expect(slotLine({ ...vance, iteration: 1, ending: null })).toBe('Vance · Marine · Lv 11 · Vetra · 2 h 00 min');
    expect(slotLine({ ...vance, iteration: 1, ending: null })).toBe(slotLine(vance));
  });

  it('a later instance with no ending leads with its instance', () => {
    expect(slotLine({ ...vance, level: 4, playtimeSec: 2400, iteration: 2, ending: null })).toBe('instance/63 · Vance · Marine · Lv 4 · Vetra · 40 min');
  });

  it('an ended run reads filed or disconnected in place of its planet', () => {
    const ended = { ...vance, level: 18, playtimeSec: 8040, iteration: 1 };
    expect(slotLine({ ...ended, ending: 'stay' })).toBe('instance/62 · Vance · Marine · Lv 18 · filed · 2 h 14 min');
    expect(slotLine({ ...ended, ending: 'escape' })).toBe('instance/62 · Vance · Marine · Lv 18 · disconnected · 2 h 14 min');
    expect(slotLine({ ...ended, planet: null, ending: 'escape', iteration: 3 })).toBe(
      'instance/64 · Vance · Marine · Lv 18 · disconnected · 2 h 14 min',
    );
  });

  it('the archive line names the archived instance and how it ended', () => {
    expect(archiveLine({ iteration: 1, name: 'Vance', ending: 'stay', level: 18, playtimeSec: 8040 })).toBe(
      'Archived: instance/62 · Vance · filed · Lv 18 · 2 h 14 min',
    );
    expect(archiveLine({ iteration: 2, name: 'Ash', ending: 'escape', level: 9, playtimeSec: 600 })).toBe(
      'Archived: instance/63 · Ash · disconnected · Lv 9 · 10 min',
    );
  });
});

describe('the next instance’s words (SPEC-058 §4.1, §4.2, §4.3, §4.5)', () => {
  it('the offer and its sheet name the slot save’s own numbers', () => {
    expect(beginInstanceText(1)).toBe('Begin instance/63');
    expect(beginInstanceText(3)).toBe('Begin instance/65');
    expect(nextInstanceSheet(1)).toEqual({
      title: 'Initialise instance/63?',
      body:
        'instance/62 is archived and can be restored once from Load. The new instance starts at level 1 with none of 62’s tokens, gear or ship. Your records and unlocks stay. The Warden starts one containment level higher.'.replace(
          '’',
          "'",
        ),
      confirmText: 'Initialise',
    });
    expect(nextInstanceSheet(2).title).toBe('Initialise instance/64?');
  });

  it('creation’s header and the archive’s sheet', () => {
    expect(creationNextText(1)).toBe("instance/63 — restored from instance/62's profile");
    expect(restoreArchiveSheet(1, 2)).toEqual({
      title: 'Restore instance/62?',
      body: 'instance/63 in this slot will be lost. The archive can be restored once.',
      confirmText: 'Restore',
    });
  });

  it('the body’s toast names what the predecessor carried', () => {
    expect(predecessorCacheText({ iteration: 1 })).toBe('instance/62: 2 Medkit · 2 Frag Grenade');
  });
});

describe('passiveText (AC-14)', () => {
  it('prints every effect the marine passive carries', () => {
    expect(passiveText({ damageMult: 1.15, maxHpBonus: 20 })).toBe('+15 % damage · +20 max HP');
  });

  it('covers discounts, multipliers and the radar flag', () => {
    expect(passiveText({ refitDiscount: 0.15, companionEffectMult: 1.25 })).toBe(
      '−15 % ship and companion prices · +25 % companion effect',
    );
    expect(passiveText({ moveSpeedMult: 1.15, pickupRadiusMult: 1.25, nodeRadar: true })).toBe(
      '+15 % move speed · +25 % pickup radius · resource radar',
    );
  });

  it('an empty passive is an empty line, not a crash', () => {
    expect(passiveText({})).toBe('');
  });

  it('prints the sprint drain as the sprint time it buys (SPEC-050 §4.1)', () => {
    expect(passiveText({ sprintDrainMult: 0.8 })).toBe('+25 % sprint time');
    expect(CLASSES.scout.passive.sprintDrainMult).toBe(0.8);
  });

  it('prints the dash cooldown multiplier, and the Scout carries it (SPEC-038 §4.1)', () => {
    expect(passiveText({ dashCooldownMult: 0.8 })).toBe('−20 % dash cooldown');
    expect(passiveText(CLASSES.scout.passive)).toBe(
      // SPEC-050 §4.1: the Scout's ×0.8 sprint drain reads as the time it buys.
      '+15 % move speed · +25 % pickup radius · resource radar · −20 % dash cooldown · +25 % sprint time',
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

  it('SPEC-043 §4.4: hard has its own line', () => {
    expect(DIFFICULTY_LINES.hard).toBe(
      'Hard — tougher, deadlier hostiles and twice the elites; a death costs a fifth of your cargo.',
    );
  });

  it('SPEC-059 §4.2.3: story says what it spares and that records are off', () => {
    expect(DIFFICULTY_LINES.story).toBe('Story — hostiles and storms cannot hurt you; the fights still happen. Records are off.');
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
    expect(companionEffectText({ cargoBonus: 100, shopDiscount: 0.1 })).toBe('+100 cargo · −10 % shop prices');
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
    expect(gearTooltip('armor_scrap')).toBe('T0 → T1 · armor 0 → 15 · hazard resist 0 % → 25 %');
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
  it('reads as §4.12 gives it', () => {
    expect(SHIPPED_TOAST_TEXT).toBe('Cargo full — surplus shipped to Command Relay.');
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
    expect(slotStateText(view('heat', { heat: 0.64 }))).toBe('HEAT 64 %');
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
    expect(upgradeDeltaText('fireRate', 4, 5)).toBe('Fire rate 4 → 5/s');
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
    expect(shopStatText('armor_composite')).toBe('armor 15 · −13 % damage · hazard 25 %');
    expect(shopStatText('armor_ablative')).toBe('armor 45 · −31 % damage · hazard 75 %');
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
    expect(gearCompareText('armor_scrap', 'armor_composite')).toBe('T0 → T1 · armor 0 → 15 · hazard resist 0 % → 25 %');
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
    expect(passiveText(CLASSES.engineer.passive)).toBe('−15 % ship and companion prices · +25 % companion effect');
    expect(passiveText(CLASSES.marine.passive)).toBe('+10 % damage · +20 max HP');
  });

  it('the Quartermaster reads −5 / −10 / −15 % shop prices, and never craft', () => {
    expect(COMPANIONS.quartermaster.levels.map((effect) => companionEffectText(effect))).toEqual([
      '+100 cargo · −5 % shop prices',
      '+200 cargo · −10 % shop prices',
      '+300 cargo · −15 % shop prices',
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
      case 'holstered':
        return rng.chance(0.5);
      case 'stamina':
        return rng.chance(0.3)
          ? null
          : { value: small(rng), max: 100, exhausted: rng.chance(0.5), sprinting: rng.chance(0.5), shown: rng.chance(0.5) };
      case 'light':
        return rng.chance(0.4) ? null : rng.chance(0.5);
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
    a.tracker = { title: 'Dry Land', stage: 'stage 1/2', rows: [{ text: 'Reach', done: false, focus: true, defendHp: null, count: -1 }], distance: 12, bearing: 0, pulse: false, remains: null };
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
    a.tracker = { title: 'T', stage: '', rows: [1, 2, 3].map((n) => ({ text: `r${n}`, done: false, focus: false, defendHp: null, count: -1 })), distance: null, bearing: 0, pulse: false, remains: null };
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
    a.tracker = { title: 'U', stage: '', rows: [], distance: null, bearing: 0, pulse: false, remains: null };
    copyHudInto(last, a);
    expect(last.tracker).not.toBe(a.tracker);
    expect(last.tracker).toEqual(a.tracker);
  });
});

// ------------------------------------------------------ SPEC-042 §6.1

import { makePlayer } from '@/entities/Player';
import { makeEnemy } from '@/entities/Enemy';
import { cumulativeXp, LEVEL_CAP, xpToNext } from '@/systems/Progression';
import {
  activeEffects,
  affixLine,
  blockedText,
  bossPhaseMarks,
  characterXpText,
  compareDeltas,
  compareDirection,
  completionLines,
  deathCause,
  deathTip,
  pickupText,
  prerequisiteText,
  purchaseText,
  availableSwatches,
  cacheRewardText,
  lockedRecipeText,
  STAMINA_FULL_TEXT,
  swatchUnlockedText,
  twistText,
  type DeathContext,
  type HudEffect,
} from '@/systems/UiHelpers';
import { CACHES, PRIMARY_SWATCHES, SECONDARY_SWATCHES, SWATCH_IDS, type ItemId, type WeaponTwist } from '@/data/index';
import { twistOf } from '@/systems/Combat';

describe('completionLines (SPEC-042 §4.1)', () => {
  it('reads c1_m1’s XP, tokens and resources, and names the next offer', () => {
    // SPEC-043 §4.6: with no extras, the three optional rows are all null.
    expect(completionLines(MISSIONS.c1_m1, false, null)).toEqual({
      title: 'Dry Land',
      rewards: '+100 XP · +10 tokens · +20 oil',
      next: null,
      bonus: null,
      contract: null,
      time: null,
    });
    expect(completionLines(MISSIONS.c1_m1, false, MISSIONS.c1_m2).next).toBe('Next: Black Gold — at the pad terminal');
  });

  it('a replay pays the halved XP and tokens and says so, with no resources or items', () => {
    expect(completionLines(MISSIONS.c1_m1, true, null).rewards).toBe('+50 XP · +5 tokens · replay');
    expect(completionLines(MISSIONS.c1_s1, true, null).rewards).toBe('+40 XP · +2 tokens · replay');
  });

  it('lists an item reward after the tokens, and leaves zero amounts out', () => {
    expect(completionLines(MISSIONS.c1_s1, false, null).rewards).toBe('+80 XP · +5 tokens · Wheat Ration ×3');
    const shell = { ...MISSIONS.c1_m1, rewards: { xp: 0, tokens: 12, resources: { oil: 0, water: 30 } } } as MissionDef;
    expect(completionLines(shell, false, null).rewards).toBe('+12 tokens · +30 water');
  });
});

describe('activeEffects (SPEC-042 §4.3)', () => {
  it('writes heal, damage boost and hazard immunity, in that order, in whole seconds', () => {
    const player = makePlayer(0, 0, 100);
    const out: HudEffect[] = [];
    expect(activeEffects(player, 0, out)).toBe(0);
    player.healOverTime = { remaining: 31, perSecond: 6 };
    player.boosts.push({ damageMult: 1.4, until: 22 });
    player.hazardImmuneUntil = 28;
    expect(activeEffects(player, 4, out)).toBe(3);
    expect(out).toEqual([
      { kind: 'heal', seconds: 6 },
      { kind: 'damage_boost', seconds: 18 },
      { kind: 'hazard_immunity', seconds: 24 },
    ]);
  });

  it('keeps one row for two boosts, from the later end (42-h), and drops what has run out', () => {
    const player = makePlayer(0, 0, 100);
    player.boosts.push({ damageMult: 1.4, until: 12 }, { damageMult: 1.4, until: 25.5 });
    const out: HudEffect[] = [];
    expect(activeEffects(player, 5, out)).toBe(1);
    expect(out[0]).toEqual({ kind: 'damage_boost', seconds: 21 });
    expect(activeEffects(player, 25.5, out)).toBe(0);
    player.hazardImmuneUntil = 30;
    expect(activeEffects(player, 30, out)).toBe(0);
  });

  it('reuses out’s entries: no new objects after the first call', () => {
    const player = makePlayer(0, 0, 100);
    player.healOverTime = { remaining: 10, perSecond: 2 };
    player.boosts.push({ damageMult: 1.4, until: 20 });
    player.hazardImmuneUntil = 30;
    const out: HudEffect[] = [];
    activeEffects(player, 0, out);
    const entries = [...out];
    for (let t = 1; t < 5; t++) {
      expect(activeEffects(player, t, out)).toBe(3);
      out.forEach((entry, i) => expect(entry).toBe(entries[i]));
    }
    expect(out[2]?.seconds).toBe(26);
  });
});

describe('deathCause and deathTip (SPEC-042 §4.5)', () => {
  const keyboard: DeathContext = { scheme: 'keyboard', autoFire: 'on', healsCarried: 2 };
  const touch: DeathContext = { scheme: 'touch', autoFire: 'on', healsCarried: 2 };

  it('names every cause', () => {
    expect(deathCause({ kind: 'enemy', enemyId: 'dust_skitter' })).toBe('Killed by Dust Skitter');
    expect(deathCause({ kind: 'projectile', enemyId: 'scav_raider' })).toBe('Killed by Scav Raider');
    expect(deathCause({ kind: 'weather', weather: 'heatwave' })).toBe('Killed by the heatwave');
    expect(deathCause({ kind: 'weather', weather: 'radiation_storm' })).toBe('Killed by the radiation storm');
    expect(deathCause({ kind: 'fall' })).toBe('Killed by a fall');
    expect(deathCause({ kind: 'asteroid' })).toBe('Killed by an asteroid');
    expect(deathCause({ kind: 'storm' })).toBe('Killed by the ion storm');
  });

  it('picks the first row that applies, in the scheme’s wording', () => {
    const weather = { kind: 'weather', weather: 'sandstorm' } as const;
    const enemy = { kind: 'enemy', enemyId: 'dust_skitter' } as const;
    const shot = { kind: 'projectile', enemyId: 'scav_raider' } as const;
    expect(deathTip(weather, keyboard)).toBe('Storms cannot reach you in caves and wrecks.');
    expect(deathTip(weather, touch)).toBe('Storms cannot reach you in caves and wrecks.');
    expect(deathTip(enemy, { ...keyboard, autoFire: 'off' })).toBe(
      'Auto-fire is off — hold Space or the left button to fire, or turn it on in Settings.',
    );
    expect(deathTip(shot, { ...touch, autoFire: 'off' })).toBe('Auto-fire is off — turn it on in Settings.');
    expect(deathTip(enemy, keyboard)).toBe('Heal with Q before the bar turns red.');
    expect(deathTip(shot, touch)).toBe('Tap the heal slot before the bar turns red.');
    expect(deathTip(enemy, { ...keyboard, healsCarried: 0 })).toBe('Craft medkits at the station: wheat and water.');
    expect(deathTip(enemy, { ...touch, healsCarried: 0 })).toBe('Craft medkits at the station: wheat and water.');
    // A gamepad reads the keyboard's words; `touch` auto-fire is not `off`.
    expect(deathTip(enemy, { ...keyboard, scheme: 'gamepad', autoFire: 'touch' })).toBe('Heal with Q before the bar turns red.');
  });

  it('has no tip for a fall, an asteroid or the ion storm', () => {
    for (const cause of [{ kind: 'fall' }, { kind: 'asteroid' }, { kind: 'storm' }] as const) {
      expect(deathTip(cause, keyboard)).toBeNull();
      expect(deathTip(cause, touch)).toBeNull();
    }
  });
});

describe('purchaseText and prerequisiteText (SPEC-042 §4.8)', () => {
  it('says what each kind of purchase did', () => {
    expect(UPGRADES.shield.metrics.shieldHp).toEqual([40, 80, 120, 160]);
    expect(purchaseText({ kind: 'ship', system: 'shield', tier: 2 })).toBe('Shield upgraded to tier 2 — Shield 80 → 120');
    expect(purchaseText({ kind: 'ship', system: 'engine', tier: 1 })).toMatch(/^Engine upgraded to tier 1 — Speed \+\d+ % · Fuel use −\d+ %$/);
    expect(purchaseText({ kind: 'gear', id: 'launcher_rocket' })).toBe('Rocket Launcher bought — equip it in Character');
    expect(purchaseText({ kind: 'gear', id: 'armor_composite' })).toBe('Composite Weave bought — equip it in Character');
    expect(purchaseText({ kind: 'companion', id: 'field_medic', level: 1 })).toBe('Field Medic bought');
    expect(purchaseText({ kind: 'companion', id: 'field_medic', level: 2 })).toBe('Field Medic upgraded to L2');
    expect(purchaseText({ kind: 'craft', recipe: 'medkit', qty: 3 })).toBe('Crafted Medkit ×3');
    expect(purchaseText({ kind: 'craft', recipe: 'medkit', qty: 1 })).toBe('Crafted Medkit');
    // 42-q: five of a recipe that makes one.
    expect(purchaseText({ kind: 'craft', recipe: 'medkit', qty: 5 })).toBe('Crafted Medkit ×5');
  });

  it('names the missing rung — the highest of the line below the candidate', () => {
    expect(prerequisiteText('weapon_plasma')).toBe('Requires Laser Carbine (T1)');
    expect(prerequisiteText('weapon_lithium')).toBe('Requires Plasma Lance (T2)');
    expect(prerequisiteText('armor_ablative')).toBe('Requires Reactive Harness (T2)');
    expect(prerequisiteText('mg_rotary')).toBe('Requires Scrap Chaingun (T1)');
    // Nothing below the first rung: the generic line stays.
    expect(prerequisiteText('weapon_kinetic')).toBe(failText('prerequisite'));
  });
});

describe('compareDeltas (SPEC-042 §4.8)', () => {
  it('points each part the way it goes for the player', () => {
    const plasma = compareDeltas('weapon_laser', 'weapon_plasma');
    expect(plasma.find((part) => part.stat === 'fireRate')?.better).toBe(-1); // 4 → 3
    expect(plasma.find((part) => part.stat === 'damage')?.better).toBe(1);
    expect(plasma.find((part) => part.stat === 'tier')?.better).toBe(1);
    // The cooldown model is a name, with no direction.
    expect(compareDeltas('weapon_laser', 'mg_scrap').find((part) => part.stat === 'cooldown')?.better).toBe(0);
    // Lower is better for recharge seconds — and for heat per shot, which no
    // two shipped heat weapons differ in, so the rule itself is pinned.
    expect(compareDeltas('launcher_grenade', 'launcher_rocket').find((part) => part.stat === 'recharge')?.better).toBe(1);
    expect(compareDeltas('launcher_rocket', 'launcher_grenade').find((part) => part.stat === 'recharge')?.better).toBe(-1);
    expect(compareDirection({ stat: 'heat', from: 0.04, to: 0.03 })).toBe(1);
    expect(compareDirection({ stat: 'heat', from: 0.03, to: 0.04 })).toBe(-1);
    expect(compareDirection({ stat: 'cooldown', from: 'none', to: 'heat' })).toBe(0);
    expect(compareDirection({ stat: 'armor', from: 4, to: 4 })).toBe(0);
  });

  it('is gearCompare part by part, each text exactly a part of gearCompareText', () => {
    const pairs = [
      ['weapon_laser', 'weapon_plasma'],
      ['weapon_laser', 'mg_scrap'],
      ['launcher_rocket', 'launcher_grenade'],
      ['armor_scrap', 'armor_reactive'],
      ['pistol_service', 'pistol_magnum'],
    ] as const;
    for (const [worn, candidate] of pairs) {
      const deltas = compareDeltas(worn, candidate);
      expect(deltas.map(({ stat, label, from, to }) => ({ stat, label, from, to }))).toEqual([...gearCompare(worn, candidate)]);
      expect(deltas.map((part) => part.text).join(' · ')).toBe(gearCompareText(worn, candidate));
    }
    expect(compareDeltas('weapon_laser', 'armor_scrap')).toEqual([]);
  });
});

describe('the boss frame, the target frame and the panel lines (SPEC-042 §4.7, §4.9)', () => {
  it('bossPhaseMarks: each later phase’s hpFraction, one cached array per boss', () => {
    expect(bossPhaseMarks('dune_wurm')).toEqual([0.4]);
    expect(bossPhaseMarks('dune_wurm')).toBe(bossPhaseMarks('dune_wurm'));
    expect(bossPhaseMarks('ash_titan')).toEqual([0.6, 0.3]);
    expect(bossPhaseMarks('dust_skitter')).toEqual([]);
  });

  it('affixLine: \'\' for a non-elite, the names joined for an elite, cached per pair', () => {
    const e = makeEnemy();
    expect(affixLine(e)).toBe('');
    e.affixA = 'swift';
    expect(affixLine(e)).toBe(''); // not an elite, whatever it carries
    e.elite = true;
    expect(affixLine(e)).toBe('Swift');
    e.affixB = 'mender';
    expect(affixLine(e)).toBe('Swift · Mender');
    expect(affixLine(e)).toBe(affixLine({ elite: true, affixA: 'swift', affixB: 'mender' }));
  });

  it('characterXpText: the XP into the level, its span and what is left; the cap says so (42-p)', () => {
    expect(xpToNext(5)).toBe(350);
    expect(characterXpText(5, cumulativeXp(5) + 340)).toBe('XP 340 / 350 — 10 to level 6');
    expect(characterXpText(1, 0)).toBe('XP 0 / 150 — 150 to level 2');
    expect(characterXpText(LEVEL_CAP, cumulativeXp(LEVEL_CAP) + 900)).toBe('Level 30 — the cap');
  });

  it('pickupText and blockedText: the loot toasts of §4.2', () => {
    expect(pickupText('medkit', 2)).toBe('Picked up Medkit ×2');
    expect(pickupText('coolant_pack', 1)).toBe('Picked up Coolant Pack');
    expect(pickupText('armor_composite', 1)).toBe('Picked up Composite Weave (T1) — equip it at the station');
    expect(pickupText('weapon_laser', 1)).toBe('Picked up Laser Carbine (T1) — equip it at the station');
    expect(blockedText('coolant_pack')).toBe('Inventory full — Coolant Pack left on the ground');
  });

  it('the model carries the new keys, and the diff sees each of them', () => {
    const a = createHudModel();
    expect(a.boss).toBeNull();
    expect(a.target).toBeNull();
    expect(a.effects).toEqual([]);
    expect(a.wave).toBe(false);
    for (const key of ['target', 'effects', 'wave'] as const) expect(HUD_KEYS).toContain(key);
    const b = copyHudInto(createHudModel(), a);
    b.effects.push({ kind: 'hazard_immunity', seconds: 30 });
    expect(diffHud(a, b)).toEqual(new Set(['effects']));
    const c = copyHudInto(createHudModel(), b);
    c.wave = true;
    c.target = { name: 'Alpha Dust Skitter', elite: true, affixes: 'Swift', hp: 70, max: 78 };
    expect(diffHud(b, c)).toEqual(new Set(['wave', 'target']));
  });
});

// ------------------------------------------------------------- SPEC-043 §6.1

import { hash32 } from '@/core/Rng';
import { CONTRACT_IDS, CONTRACTS, type MissionBonus } from '@/data/index';
import { contractFor } from '@/systems/Missions';
import { bonusLine, bonusRewardText, bonusText, contractLabel, timeText } from '@/systems/UiHelpers';

/** A save with chapter 1 finished and `c1_m2` among the done. */
function chapterOneDone(): Save {
  const save = newSave(0, CREATION, 42, 0);
  save.progress.missionsDone.push('c1_m1', 'c1_m2');
  save.progress.flags.push('chapter1_done');
  return save;
}

describe('bonus, contract and time texts (SPEC-043 §4.2, §4.3, §4.5)', () => {
  it('timeText is m:ss', () => {
    expect(timeText(161)).toBe('2:41');
    expect(timeText(240)).toBe('4:00');
    expect(timeText(1)).toBe('0:01');
    expect(timeText(59)).toBe('0:59');
    expect(timeText(3_725)).toBe('1:02:05');
    expect(timeText(-3)).toBe('0:00');
    expect(timeText(Number.NaN)).toBe('0:00');
  });

  it('bonusText names each kind', () => {
    const reward = { items: [{ itemId: 'medkit' as const, qty: 1 }] };
    expect(bonusText({ kind: 'no_death', reward })).toBe('No deaths');
    expect(bonusText({ kind: 'par', seconds: 240, reward })).toBe('Under 4:00');
    expect(bonusText({ kind: 'no_shelter', reward })).toBe('No shelter');
    expect(bonusText({ kind: 'elites', count: 2, reward })).toBe('Kill 2 elites');
    expect(bonusText({ kind: 'elites', count: 1, reward })).toBe('Kill 1 elite');
  });

  it('bonusRewardText reads +qty and the item name, then +n and the resource', () => {
    expect(bonusRewardText({ items: [{ itemId: 'frag_grenade', qty: 2 }] })).toBe('+2 Frag Grenade');
    expect(bonusRewardText({ resources: { lithium: 40 } })).toBe('+40 lithium');
    expect(bonusRewardText({ items: [{ itemId: 'demo_charge', qty: 1 }], resources: { oil: 0, lithium: 20 } })).toBe(
      '+1 Demolition Charge · +20 lithium',
    );
  });

  it('the board’s bonus row reads the table: c1_m2 is Under 4:00 → +2 Frag Grenade', () => {
    expect(bonusLine(MISSIONS.c1_m2.bonus as MissionBonus)).toBe('Bonus: Under 4:00 → +2 Frag Grenade');
    expect(bonusLine(MISSIONS.c1_m3.bonus as MissionBonus)).toBe('Bonus: No deaths → +1 Demolition Charge');
    expect(bonusLine(MISSIONS.c3_s1.bonus as MissionBonus)).toBe('Bonus: Kill 1 elite → +20 lithium');
  });

  it('contractLabel reads Contract · <name> · 75 % + 20 lithium on a contract, and null otherwise', () => {
    const save = chapterOneDone();
    for (let landing = 1; landing <= 8; landing++) {
      const id = CONTRACT_IDS[hash32(save.meta.seed, 'contract', 'c1_m2', landing) % CONTRACT_IDS.length];
      expect(id).toBe(contractFor(save, MISSIONS.c1_m2, landing));
      expect(contractLabel(save, MISSIONS.c1_m2, landing)).toBe(`Contract · ${CONTRACTS[id as keyof typeof CONTRACTS].name} · 75 % + 20 lithium`);
    }
    // A first run, an unfinished chapter, a flight mission: no label.
    expect(contractLabel(save, MISSIONS.c1_s2, 1)).toBeNull();
    const unfinished = newSave(0, CREATION, 42, 0);
    unfinished.progress.missionsDone.push('c1_m1', 'c1_m2');
    expect(contractLabel(unfinished, MISSIONS.c1_m2, 1)).toBeNull();
    const flight = newSave(0, CREATION, 42, 0);
    flight.progress.missionsDone.push('c5_m1');
    flight.progress.flags.push('chapter5_done');
    expect(contractLabel(flight, MISSIONS.c5_m1, 1)).toBeNull();
  });

  it('rewardsText prints a contract’s payout: 75 % of each, then +20 lithium', () => {
    expect(rewardsText(MISSIONS.c1_m2.rewards, true, true)).toBe('+112 XP · +11 ◈ · +20 lithium');
    // A plain replay and a first run keep their wording.
    expect(rewardsText(MISSIONS.c1_m2.rewards, true)).toBe('+75 XP · +7 ◈');
    expect(rewardsText(MISSIONS.c1_m2.rewards, true, false)).toBe('+75 XP · +7 ◈');
    expect(rewardsText(MISSIONS.c1_s2.rewards)).toBe('+70 XP · +5 ◈ · Proximity Mine ×2');
  });
});

describe('completionLines’ extras (SPEC-043 §4.6)', () => {
  const bonus = MISSIONS.c1_m3.bonus as MissionBonus;

  it('a contract reads its payout, then contract, and names the modifier', () => {
    const lines = completionLines(MISSIONS.c1_m2, true, null, { contract: 'swarm' });
    expect(lines.rewards).toBe('+112 XP · +11 tokens · +20 lithium · contract');
    expect(lines.contract).toBe('Contract · Swarm');
    expect(lines.bonus).toBeNull();
    expect(lines.time).toBeNull();
  });

  it('an earned bonus reads its reward, a missed one says so', () => {
    expect(completionLines(MISSIONS.c1_m3, false, null, { bonus: { bonus, earned: true } }).bonus).toBe(
      'Bonus: No deaths — +1 Demolition Charge',
    );
    expect(completionLines(MISSIONS.c1_m3, false, null, { bonus: { bonus, earned: false } }).bonus).toBe('Bonus missed: No deaths');
  });

  it('seconds read as the time row', () => {
    expect(completionLines(MISSIONS.c1_m2, false, null, { seconds: 161 }).time).toBe('Time 2:41');
  });

  it('all three at once, and first runs and plain replays keep SPEC-042’s rewards line', () => {
    const all = completionLines(MISSIONS.c1_m2, true, MISSIONS.c1_m3, {
      contract: 'no_cover',
      bonus: { bonus: MISSIONS.c1_m2.bonus as MissionBonus, earned: true },
      seconds: 95,
    });
    expect(all).toEqual({
      title: 'Black Gold',
      rewards: '+112 XP · +11 tokens · +20 lithium · contract',
      next: 'Next: Worm Sign — at the pad terminal',
      bonus: 'Bonus: Under 4:00 — +2 Frag Grenade',
      contract: 'Contract · No cover',
      time: 'Time 1:35',
    });
    expect(completionLines(MISSIONS.c1_m2, true, null, { contract: null, bonus: null, seconds: null })).toEqual({
      title: 'Black Gold',
      rewards: '+75 XP · +7 tokens · replay',
      next: null,
      bonus: null,
      contract: null,
      time: null,
    });
    expect(completionLines(MISSIONS.c1_s2, false, null, {}).rewards).toBe('+70 XP · +5 tokens · Proximity Mine ×2');
  });
});

// ------------------------------------------------------------------ SPEC-044

describe('quitNote (SPEC-044 §4.8)', () => {
  it('on the surface: the planet\'s pad, with no jump, and timed objectives restart (SPEC-059 §4.1.5)', () => {
    expect(quitNote('surface', 'Ferrum', 100)).toBe('You will resume at the Ferrum landing pad. Timed objectives restart.');
  });

  it('resumedText names the pad and the restarted timers (SPEC-059 §4.1.3)', () => {
    expect(resumedText('Vetra')).toBe('Resumed at the Vetra landing pad. Timed objectives restart.');
    expect(resumedText(PLANETS.cinder4.name)).toBe('Resumed at the Cinder-4 landing pad. Timed objectives restart.');
  });

  it('in flight: this jump\'s fuel is already spent (44-i)', () => {
    expect(quitNote('flight', 'Ferrum', 100)).toBe('You will resume at Command Relay. The fuel for this jump (100 oil) is already spent.');
  });

  it('the oil is Economy.fuelCost — the engine-discounted jump', () => {
    const data = save();
    expect(economyOf(data).fuelCost('ferrum')).toBe(100);
    // SPEC-059 §4.1.5: the surface's note names no fuel — a resume costs none.
    expect(quitNote('surface', PLANETS.ferrum.name, economyOf(data).fuelCost('ferrum'))).not.toContain('oil');
    data.ship.engine = 1;
    expect(quitNote('flight', PLANETS.ferrum.name, economyOf(data).fuelCost('ferrum'))).toContain('(90 oil)');
  });
});

describe('the stamina ring’s model (SPEC-050 §4.6)', () => {
  it('staminaShown is false only for a full pool out of combat, full for at least 1 s', () => {
    expect(STAMINA_FULL_HIDE_SECONDS).toBe(1);
    expect(staminaShown(100, false, 1)).toBe(false);
    expect(staminaShown(100, false, 5)).toBe(false);
    expect(staminaShown(100, false, 0.99)).toBe(true);
    expect(staminaShown(100, true, 5)).toBe(true);
    expect(staminaShown(99, false, 5)).toBe(true);
    expect(staminaShown(0, false, 0)).toBe(true);
    expect(staminaShown(40, true, 0)).toBe(true);
  });

  it('is null and not holstered in a fresh model — the flight never sets them', () => {
    const model = createHudModel();
    expect(model.stamina).toBeNull();
    expect(model.holstered).toBe(false);
    expect(HUD_KEYS).toContain('stamina');
    expect(HUD_KEYS).toContain('holstered');
  });

  it('a change of value, state or shown diffs the stamina key alone', () => {
    const a = createHudModel();
    a.stamina = { value: 100, max: 100, exhausted: false, sprinting: false, shown: false };
    const b = copyHudInto(createHudModel(), a);
    expect(diffHud(a, b).size).toBe(0);
    (b.stamina as NonNullable<HudModel['stamina']>).value = 99;
    expect([...diffHud(a, b)]).toEqual(['stamina']);
    b.holstered = true;
    expect([...diffHud(a, b)].sort()).toEqual(['holstered', 'stamina']);
  });
});

describe('attributeEffectText and attributeLine (SPEC-044 §4.4)', () => {
  it('reads all four attributes at SPEC-039\'s numbers', () => {
    expect(attributeEffectText('might')).toBe('Might — +4 % damage per point');
    expect(attributeEffectText('vigor')).toBe('Vigor — +8 max HP per point');
    // SPEC-050 §4.1: agility's stamina regen joins the line.
    expect(attributeEffectText('agility')).toBe(
      'Agility — +2 % speed · +2 % crit chance · −3 % dash cooldown · +3 % stamina regen per point',
    );
    expect(attributeEffectText('tech')).toBe('Tech — +10 % companion effect · −3 % prices per point');
  });

  it('has words for every effect key ATTRIBUTE_EFFECTS holds, and for nothing else', () => {
    const keys = new Set<string>();
    for (const effects of Object.values(ATTRIBUTE_EFFECTS)) for (const key of Object.keys(effects)) keys.add(key);
    const missing = [...keys].filter((key) => !Object.hasOwn(ATTRIBUTE_EFFECT_WORDS, key));
    expect(missing, 'effect keys with no words').toEqual([]);
    expect(Object.keys(ATTRIBUTE_EFFECT_WORDS).sort()).toEqual([...keys].sort());
  });

  it('reads the table the formulas read: each word carries the per-point value', () => {
    expect(ATTRIBUTE_EFFECT_WORDS.damage(0.05)).toBe('+5 % damage');
    expect(ATTRIBUTE_EFFECT_WORDS.maxHp(10)).toBe('+10 max HP');
    expect(ATTRIBUTE_EFFECT_WORDS.priceCut(0.025)).toBe('−3 % prices');
  });

  it('spells a class card\'s base attributes', () => {
    expect(attributeLine(CLASSES.marine.baseAttributes)).toBe('Might 3 · Vigor 3 · Agility 1 · Tech 1');
    expect(attributeLine(CLASSES.scout.baseAttributes)).toBe('Might 2 · Vigor 1 · Agility 4 · Tech 1');
  });
});

describe('requirementItem and needsLine (SPEC-044 §4.11)', () => {
  it('words each requirement kind as an item', () => {
    expect(requirementItem({ kind: 'level', level: 3 })).toBe('Level 3');
    expect(requirementItem({ kind: 'ship', system: 'shield', tier: 2 })).toBe('Ship shield tier 2');
    expect(requirementItem({ kind: 'mission', id: 'c1_m2' })).toBe("Complete 'Black Gold'");
    expect(requirementItem({ kind: 'flag', flag: 'chapter2_done' })).toBe('Complete Chapter 2');
    expect(requirementItem({ kind: 'flag', flag: 'signal_decoded' })).toBe('Signal decoded');
  });

  it('joins them in one grammar', () => {
    expect(needsLine([{ kind: 'mission', id: 'c1_m2' }, { kind: 'level', level: 3 }])).toBe("Needs: Complete 'Black Gold' · Level 3");
    expect(needsLine([{ kind: 'ship', system: 'shield', tier: 2 }])).toBe('Needs: Ship shield tier 2');
    expect(needsLine([{ kind: 'flag', flag: 'chapter2_done' }, { kind: 'flag', flag: 'signal_decoded' }])).toBe(
      'Needs: Complete Chapter 2 · Signal decoded',
    );
  });
});

describe('STATUS_LABELS (SPEC-044 §4.11)', () => {
  it('covers every MissionStatus with words, never the id', () => {
    const statuses: readonly MissionStatus[] = ['active', 'available', 'locked', 'replayable', 'done'];
    expect(Object.keys(STATUS_LABELS).sort()).toEqual([...statuses].sort());
    expect(STATUS_LABELS).toEqual({
      active: 'In progress',
      available: 'New',
      locked: 'Locked',
      replayable: 'Done · replay for 50 %',
      done: 'Done',
    });
    for (const status of statuses) expect(STATUS_LABELS[status]).not.toBe(status);
  });
});

describe('firstSentence (SPEC-044 §4.7)', () => {
  it('keeps the first sentence of a two-sentence brief', () => {
    expect(firstSentence(MISSIONS.c2_m1.brief)).toBe('Vetra greets every landing with a blizzard.');
    expect(firstSentence('Hold the line! Then fall back.')).toBe('Hold the line!');
    expect(firstSentence('Who is out there? Find out.')).toBe('Who is out there?');
  });

  it('a brief with no full stop is whole', () => {
    expect(firstSentence('Walk it off')).toBe('Walk it off');
    expect(firstSentence('One sentence.')).toBe('One sentence.');
    // A stop inside a number is not a sentence end.
    expect(firstSentence('Pull 1.5 tonnes out')).toBe('Pull 1.5 tonnes out');
  });
});

describe('acceptedText (SPEC-044 §4.7)', () => {
  it('reads the same at the board and the pad terminal', () => {
    expect(acceptedText('Black Gold', false)).toBe("Accepted 'Black Gold'");
    expect(acceptedText('Black Gold', true)).toBe("Replaying 'Black Gold' — 50 % rewards");
    expect(acceptedText('Black Gold', true, 'Swarm')).toBe("Replaying 'Black Gold' — Swarm contract");
  });
});

describe('starmapPreselect (SPEC-044 §4.6)', () => {
  /** Chapter 1 done: Vetra open, `c2_m1` a main mission available there. */
  const chapterOne = (patch?: (data: Save) => void): Save =>
    save((d) => {
      d.progress.missionsDone.push('c1_m1', 'c1_m2', 'c1_m3');
      d.progress.flags.push('chapter1_done');
      patch?.(d);
    });
  const unlockedIn = (data: Save) => (planet: (typeof PLANET_IDS)[number]) => economyOf(data).isUnlocked(planet);

  it('the planet it was given wins when it is unlocked', () => {
    const data = chapterOne((d) => d.progress.missionsActive.push({ id: 'c1_s1', stage: 0, counters: {} }));
    expect(starmapPreselect(data, unlockedIn(data), 'vetra')).toBe('vetra');
    expect(starmapPreselect(data, unlockedIn(data), 'cinder4')).toBe('cinder4');
  });

  it('a locked planet given falls through to the tracked mission (44-h)', () => {
    const data = chapterOne((d) => d.progress.missionsActive.push({ id: 'c1_s1', stage: 0, counters: {} }));
    expect(unlockedIn(data)('ferrum')).toBe(false);
    expect(starmapPreselect(data, unlockedIn(data), 'ferrum')).toBe('cinder4');
  });

  it('the tracked mission\'s planet — the front of missionsActive — before the newest work', () => {
    const data = chapterOne((d) => {
      d.progress.missionsActive.push({ id: 'c1_s1', stage: 0, counters: {} }, { id: 'c2_m1', stage: 0, counters: {} });
    });
    expect(starmapPreselect(data, unlockedIn(data))).toBe('cinder4');
    const flipped = chapterOne((d) => {
      d.progress.missionsActive.push({ id: 'c2_m1', stage: 0, counters: {} }, { id: 'c1_s1', stage: 0, counters: {} });
    });
    expect(starmapPreselect(flipped, unlockedIn(flipped))).toBe('vetra');
  });

  it('with nothing tracked, the unlocked planet of the highest chapter with an available main mission', () => {
    const data = chapterOne();
    expect(starmapPreselect(data, unlockedIn(data))).toBe('vetra');
    // A fresh save: only Cinder-4 is open, and `c1_m1` is its available main mission.
    const fresh = save();
    expect(starmapPreselect(fresh, unlockedIn(fresh))).toBe('cinder4');
  });

  it('Cinder-4 last', () => {
    // Cinder-4's main missions done but its chapter not closed: nothing main is available anywhere open.
    const data = save((d) => d.progress.missionsDone.push('c1_m1', 'c1_m2', 'c1_m3'));
    expect(starmapPreselect(data, unlockedIn(data))).toBe('cinder4');
    // Nothing unlocked at all, and a locked planet asked for.
    expect(starmapPreselect(save(), () => false, 'eden')).toBe(PLANET_IDS[0]);
    expect(PLANET_IDS[0]).toBe('cinder4');
  });

  it('is pure: the save is not written', () => {
    const data = chapterOne();
    const before = JSON.stringify(data);
    starmapPreselect(data, unlockedIn(data), 'vetra');
    expect(JSON.stringify(data)).toBe(before);
  });
});

// --------------------------------------------------------------- SPEC-054

describe('darkFogRange (SPEC-054 §4.4)', () => {
  it('near is the camera distance, far is near plus the span', () => {
    expect(darkFogRange(17, 24)).toEqual({ near: 17, far: 41 });
  });

  it('tracks whatever camera distance and span it is given', () => {
    expect(darkFogRange(0, 10)).toEqual({ near: 0, far: 10 });
    expect(darkFogRange(22, 24)).toEqual({ near: 22, far: 46 });
  });
});

describe('descentRefusal (SPEC-054 §4.2)', () => {
  const OPEN_DESCENT: DescentContext = {
    tutorialDone: true,
    clockTitle: null,
    bossAwake: false,
    follower: false,
    stormForced: false,
  };

  it('gives each text of §4.2 in order, and null once nothing refuses', () => {
    expect(descentRefusal({ ...OPEN_DESCENT, tutorialDone: false })).toBe('Sealed — finish "Dry Land" first');
    expect(descentRefusal({ ...OPEN_DESCENT, clockTitle: 'Dry Land' })).toBe(
      'Not now — the clock is running on "Dry Land"',
    );
    expect(descentRefusal({ ...OPEN_DESCENT, bossAwake: true })).toBe('Not now — the boss is awake');
    expect(descentRefusal({ ...OPEN_DESCENT, follower: true })).toBe('Not now — the probe cannot follow you down');
    expect(descentRefusal({ ...OPEN_DESCENT, stormForced: true })).toBe('Not now — ride out the storm first');
    expect(descentRefusal(OPEN_DESCENT)).toBeNull();
  });

  it('the seal outranks every other refusal', () => {
    expect(
      descentRefusal({
        tutorialDone: false,
        clockTitle: 'Dry Land',
        bossAwake: true,
        follower: true,
        stormForced: true,
      }),
    ).toBe('Sealed — finish "Dry Land" first');
  });

  it('checks run in the given order once the seal is open', () => {
    expect(
      descentRefusal({ ...OPEN_DESCENT, clockTitle: 'Dry Land', bossAwake: true, follower: true, stormForced: true }),
    ).toBe('Not now — the clock is running on "Dry Land"');
    expect(descentRefusal({ ...OPEN_DESCENT, bossAwake: true, follower: true, stormForced: true })).toBe(
      'Not now — the boss is awake',
    );
    expect(descentRefusal({ ...OPEN_DESCENT, follower: true, stormForced: true })).toBe(
      'Not now — the probe cannot follow you down',
    );
  });
});

describe('lightChipText (SPEC-054 §4.5)', () => {
  it('reads the state and the key legend on keyboard', () => {
    expect(lightChipText(true, 'keyboard')).toBe('◐ Light on · L');
    expect(lightChipText(false, 'keyboard')).toBe('○ Light off · L');
  });

  it('drops the key legend on touch, where the button is the control', () => {
    expect(lightChipText(true, 'touch')).toBe('◐ Light on');
    expect(lightChipText(false, 'touch')).toBe('○ Light off');
  });

  it('a gamepad reads the keyboard legend, like every other scheme-aware helper here', () => {
    expect(lightChipText(true, 'gamepad')).toBe('◐ Light on · L');
  });
});

// ------------------------------------------------------------- SPEC-055 §4.4–§4.6

describe('puzzleTitle (SPEC-055 §4.4)', () => {
  it('names each kind by chapter: the Warden’s words from chapter 4 for conduit and calibration, from 3 for a sequence', () => {
    for (let chapter = 1; chapter <= 6; chapter++) {
      expect(puzzleTitle('conduit', chapter, false), `conduit ${chapter}`).toBe(chapter < 4 ? 'ROUTE POWER' : 'ROUTE ATTENTION');
      expect(puzzleTitle('calibration', chapter, false), `calibration ${chapter}`).toBe(chapter < 4 ? 'CALIBRATE ARRAY' : 'ADJUST WEIGHTS');
      expect(puzzleTitle('sequence', chapter, false), `sequence ${chapter}`).toBe(chapter < 3 ? 'COMPLETE THE SEQUENCE' : 'PREDICT THE NEXT TOKEN');
      expect(puzzleTitle('plates', chapter, false)).toBe('STEP IN ORDER');
      expect(puzzleTitle('beam', chapter, false)).toBe('ALIGN THE LENS');
    }
  });

  it('the human lock reads its own title, whatever the kind or chapter', () => {
    for (const kind of ['conduit', 'calibration', 'sequence', 'plates', 'beam'] as const) {
      expect(puzzleTitle(kind, 6, true)).toBe('HUMAN VERIFICATION — complete the sentence');
    }
  });
});

describe('puzzleStatus, the subtitles and ARIA’s hint line (SPEC-055 §4.4, §4.5)', () => {
  it('reads Moves <m> · Hints <h>', () => {
    expect(puzzleStatus(4, 1)).toBe('Moves 4 · Hints 1');
    expect(puzzleStatus(0, 0)).toBe('Moves 0 · Hints 0');
  });

  it('the three panel kinds read §4.4’s subtitles until the first move', () => {
    expect(puzzleSubtitle('conduit')).toBe('Turn the tiles until power reaches every output.');
    expect(puzzleSubtitle('calibration')).toBe('Each press flips a cell and its neighbours. Clear the board.');
    expect(puzzleSubtitle('sequence')).toBe('Choose what comes next.');
  });

  it('ARIA tries the first hint, then insists', () => {
    expect(puzzleHintLine(1)).toBe('ARIA: try this one.');
    expect(puzzleHintLine(2)).toBe('ARIA: this one. Trust me.');
    expect(puzzleHintLine(5)).toBe('ARIA: this one. Trust me.');
  });
});

describe('bypassNote (SPEC-055 §4.5)', () => {
  it('counts the open seconds left down to the bypass, and is null once it is open', () => {
    expect(bypassNote(48, 1)).toBe('ARIA can force it in 42 s');
    expect(bypassNote(0, 0)).toBe('ARIA can force it in 90 s');
    expect(bypassNote(89.2, 2)).toBe('ARIA can force it in 1 s');
    expect(bypassNote(90, 0)).toBeNull();
    expect(bypassNote(10, 3)).toBeNull();
  });

  it('opens at 90 s or three hints, whichever is first', () => {
    expect(bypassOpen(89.9, 2)).toBe(false);
    expect(bypassOpen(90, 0)).toBe(true);
    expect(bypassOpen(0, 3)).toBe(true);
  });
});

describe('cellLabel (SPEC-055 §4.4)', () => {
  /**
   * A 4 × 4 board by hand: the input at the north-west corner, two straights
   * east, an elbow down, an elbow across and the output straight on the east
   * edge — row 2, column 3 is the `north–east` elbow of §4.4's example.
   */
  function board(): ConduitPuzzle {
    const pieces = new Uint8Array(16);
    const rots = new Uint8Array(16);
    const set = (cell: number, piece: number, rot: number): void => {
      pieces[cell] = piece;
      rots[cell] = rot;
    };
    set(0, 2, 1); // straight, east–west
    set(1, 2, 1);
    set(2, 3, 2); // elbow, south–west
    set(6, 3, 0); // elbow, north–east
    set(7, 2, 1); // the output
    set(12, 4, 0); // a stray tee, on no path
    return {
      kind: 'conduit',
      n: 4,
      pieces,
      rots,
      source: { cell: 0, side: 8 },
      sinks: [{ cell: 7, side: 2 }],
      solution: Uint8Array.from([1, 1, 2, 0, 1]),
      path: Int16Array.from([0, 1, 2, 6, 7]),
    };
  }

  it('names the row and column from 1, the piece, its open sides and whether power reaches it', () => {
    const p = board();
    expect(cellLabel(p, 6)).toBe('Tile 2, 3: elbow, north–east, powered');
    expect(cellLabel(p, 2)).toBe('Tile 1, 3: elbow, south–west, powered');
    expect(cellLabel(p, 0)).toBe('Tile 1, 1: straight, east–west, powered, input');
    expect(cellLabel(p, 7)).toBe('Tile 2, 4: straight, east–west, powered, output');
    expect(cellLabel(p, 12)).toBe('Tile 4, 1: tee, north–east–south, unpowered');
    expect(cellLabel(p, 5)).toBe('Tile 2, 2: empty');
  });

  it('a turned tile reads its new sides, and the tiles past it lose their power', () => {
    const p = board();
    p.rots[1] = 0;
    expect(cellLabel(p, 1)).toBe('Tile 1, 2: straight, north–south, unpowered');
    expect(cellLabel(p, 6)).toBe('Tile 2, 3: elbow, north–east, unpowered');
    expect(cellLabel(p, 0)).toBe('Tile 1, 1: straight, east–west, powered, input');
  });

  it('a calibration cell is aligned or misaligned', () => {
    const p: CalibrationPuzzle = { kind: 'calibration', n: 3, lit: Uint8Array.from([0, 1, 0, 0, 0, 0, 0, 0, 1]), presses: 4 };
    expect(cellLabel(p, 1)).toBe('Tile 1, 2: array cell, misaligned');
    expect(cellLabel(p, 4)).toBe('Tile 2, 2: array cell, aligned');
    expect(cellLabel(p, 8)).toBe('Tile 3, 3: array cell, misaligned');
  });
});

describe('the stones’ words (SPEC-055 §4.6)', () => {
  const plates: PlatesPuzzle = {
    kind: 'plates',
    plates: [
      { x: 0, z: 0, glyph: 'square' },
      { x: 4, z: 0, glyph: 'circle' },
      { x: 0, z: 4, glyph: 'triangle' },
    ],
    order: [1, 2, 0],
    progress: 0,
    panel: { x: 20, z: 0 },
  };

  it('the panel says the rule, then the glyphs in order; the tracker lists them', () => {
    expect(platesPanelLine(plates)).toBe('Step on the stones in this order. Do not deviate. circle, triangle, square');
    expect(stonesText(plates)).toBe('Stones: circle · triangle · square');
  });
});

// ------------------------------------------------------------- SPEC-056

describe('the treasure\'s words (SPEC-056 §4.1, §4.4, §4.5, §4.6)', () => {
  it('twistText reads each twist kind', () => {
    const twist = (id: ItemId): WeaponTwist => {
      const found = twistOf(id);
      if (found === null) throw new Error(id);
      return found;
    };
    expect(twistText(twist('relic_last_word'))).toBe('Double damage to targets under 30 % health');
    expect(twistText(twist('relic_cold_coil'))).toBe('Hits slow the target by 25 % for 1 s (bosses 10 %)');
    expect(twistText(twist('relic_seed_drum'))).toBe('Shells leave a 3 m cloud: 8 damage a second for 3 s');
    expect(twistText(twist('relic_slag_vent'))).toBe('Overheating vents a 3.5 m blast of 60');
    expect(twistText(twist('relic_seeker'))).toBe('Rockets turn toward the nearest target ahead');
  });

  it('cacheRewardText prints tokens, resources, items, relic, blueprint, swatch and shard, in that order', () => {
    expect(
      cacheRewardText({
        shard: 'shard_cinder4',
        swatch: 'eden_vault',
        blueprint: 'flare',
        relic: 'relic_last_word',
        items: [
          { itemId: 'plasma_cell', qty: 1 },
          { itemId: 'medkit', qty: 2 },
        ],
        resources: { lithium: 8, oil: 3 },
        tokens: 5,
      }),
    ).toBe('+5 ◈ · +3 oil · +8 lithium · +1 Plasma Cell · +2 Medkit · Relic: Last Word · Blueprint: Flare · Swatch: Checkpoint · Archive shard');
    // The rows as they are: a vault, a world puzzle with a blueprint, a relic terminal.
    expect(cacheRewardText(CACHES.cinder4_vault.reward)).toBe(
      '+5 ◈ · +8 lithium · +1 Plasma Cell · +1 Coolant Pack · Relic: Last Word · Archive shard',
    );
    expect(cacheRewardText(CACHES.vetra_loose_b.reward)).toBe('+20 oil · +2 Frag Grenade · Blueprint: Flare');
    expect(cacheRewardText(CACHES.cinder4_relic.reward)).toBe('+5 lithium · +1 Plasma Cell · Swatch: Dune Rust');
    expect(cacheRewardText({})).toBe('');
  });

  it('lockedRecipeText names the planet whose cave holds the blueprint', () => {
    expect(lockedRecipeText('flare')).toBe('Locked — found in a Vetra cave');
    expect(lockedRecipeText('stim')).toBe('Locked — found in a Thessaly cave');
    expect(lockedRecipeText('medkit')).toBe('');
  });

  it('swatchUnlockedText is the unlock toast', () => {
    expect(swatchUnlockedText('cinder4_relic')).toBe('Swatch unlocked: Dune Rust — wear it from the Locker');
  });

  it('availableSwatches is the base eight, then each unlocked colour in SWATCH_IDS order, once', () => {
    expect(availableSwatches('primary', [])).toEqual([...PRIMARY_SWATCHES]);
    expect(availableSwatches('secondary', [])).toEqual([...SECONDARY_SWATCHES]);
    // Unlocked out of order, with a duplicate and an unknown id: the table's order, once each.
    expect(availableSwatches('primary', ['eden_vault', 'cinder4_relic', 'eden_vault', 'nope'])).toEqual([
      ...PRIMARY_SWATCHES,
      '#c2703d',
      '#e6e9ec',
    ]);
    expect(availableSwatches('secondary', ['vetra_relic'])).toEqual([...SECONDARY_SWATCHES, '#1d3b4a']);
    expect(availableSwatches('primary', [...SWATCH_IDS])).toHaveLength(14);
  });

  it('the stim refusal\'s text, and a relic\'s tooltip says its twist rather than a ladder', () => {
    expect(STAMINA_FULL_TEXT).toBe('Stamina is full');
    expect(gearTooltip('relic_slag_vent')).toBe('Relic — Overheating vents a 3.5 m blast of 60');
    // The Last Word (handgun T1) is no rung above the Service Pistol: its
    // tooltip reads as it did before the relic existed.
    expect(gearTooltip('pistol_service')).toBe('T0 — top tier');
    expect(gearTooltip('mg_scrap')).not.toContain('Cold Coil');
    expect(prerequisiteText('pistol_magnum')).toBe('Requires Service Pistol (T0)');
    expect(prerequisiteText('mg_rotary')).toBe('Requires Scrap Chaingun (T1)');
  });

  it('the flare\'s and the stim\'s cards say what they do', () => {
    expect(gearStatLines('flare')).toEqual(['Lights 12 m for 60 s where it lands', 'Stack of 5']);
    expect(gearStatLines('stim')).toEqual(['Refills stamina and clears exhaustion', 'Stack of 5']);
  });
});

// ------------------------------------------------------------- SPEC-057 §4.7

import { remainsFullText, remainsLostText, remainsOverlayLine, remainsRecoveredText, remainsTrackerText } from '@/systems/UiHelpers';

describe('the remains lines (SPEC-057 §4.1, §4.4, §4.5, §4.7)', () => {
  it('the overlay line names what the pack or the body holds, and is null when nothing was taken', () => {
    expect(remainsOverlayLine('pack', { oil: 30, lithium: 12 })).toBe('Your pack holds 30 oil · 12 lithium — reach it before you fall again.');
    expect(remainsOverlayLine('body', { lithium: 12, oil: 30 })).toBe('Your body holds 30 oil · 12 lithium — reach it before you fall again.');
    expect(remainsOverlayLine('pack', {})).toBeNull();
    expect(remainsOverlayLine('pack', { oil: 0 })).toBeNull();
  });

  it('the recovery toast adds the rest only while some is left', () => {
    expect(remainsRecoveredText('pack', { oil: 20 }, false)).toBe('Recovered: 20 oil');
    expect(remainsRecoveredText('pack', { oil: 5, wheat: 0 }, true)).toBe('Recovered: 5 oil — the rest stays with your pack');
    expect(remainsRecoveredText('body', { oil: 5, water: 3 }, true)).toBe('Recovered: 5 oil · 3 water — the rest stays with your body');
  });

  it('an attempt that took nothing says the hold is full, and what is left (E93, review B-21)', () => {
    expect(remainsFullText('pack', 15)).toBe('Hold full — 15 left in your pack');
    expect(remainsFullText('body', 1)).toBe('Hold full — 1 left in your body');
  });

  it('the forfeit toast names the lost set', () => {
    expect(remainsLostText('pack', { oil: 20 })).toBe('Your earlier pack is gone: 20 oil.');
    expect(remainsLostText('body', { wheat: 4, oil: 20 })).toBe('Your earlier body is gone: 20 oil · 4 wheat.');
  });

  it('the tracker row reads the whole-metre distance', () => {
    expect(remainsTrackerText('pack', 42.4)).toBe('Recover your pack — 42 m');
    expect(remainsTrackerText('body', 0.3)).toBe('Recover your body — 0 m');
  });
});
