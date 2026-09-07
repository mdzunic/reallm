// The pure UI helpers of SPEC-014 §6, one describe per helper. They are the
// only part of the UI layer tests can reach (SPEC-001 §4: tests exercise pure
// code), so everything a panel prints or diffs is proven here and `ui/` merely
// renders the return values.
import { describe, expect, it } from 'vitest';
import { newSave, type CharacterCreation, type SaveV1 } from '@/core/Save';
import { MISSIONS, TUNING, type MissionDef } from '@/data/index';
import { discountTokens } from '@/systems/Economy';
import {
  abandonMission,
  acceptMission,
  cloneHud,
  computePlayerStats,
  createHudModel,
  departReason,
  diffHud,
  formatTime,
  missionStatus,
  priceText,
  pruneToasts,
  pushToast,
  requirementText,
  slotLine,
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

function save(patch?: (data: SaveV1) => void): SaveV1 {
  const data = newSave(0, CREATION, 42, 1_700_000_000_000);
  patch?.(data);
  return data;
}

// `c1_m1` requires nothing; `c1_m2` requires `c1_m1` (SPEC-009 §4.7).
const OPEN: MissionDef = MISSIONS.c1_m1;
const GATED: MissionDef = MISSIONS.c1_m2;

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

describe('priceText (AC-113)', () => {
  it('shows the discount as base → paid', () => {
    expect(priceText({ tokens: 40 }, 0.15)).toBe('40 → 34');
  });

  it('shows the plain price when no discount applies', () => {
    expect(priceText({ tokens: 40 }, 0)).toBe('40');
  });

  it('appends undiscounted resource costs', () => {
    expect(priceText({ tokens: 140, resources: { lithium: 80 } }, 0.25)).toBe('140 → 105 + 80 lithium');
    expect(priceText({ tokens: 0, resources: { wheat: 3, water: 1 } }, 0.4)).toBe('3 wheat + 1 water');
  });

  it('agrees with the charge itself', () => {
    expect(priceText({ tokens: 130 }, 0.4)).toContain(String(discountTokens(130, 0.4)));
  });

  it('a price of nothing is Free', () => {
    expect(priceText({ tokens: 0 }, 0.4)).toBe('Free');
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
