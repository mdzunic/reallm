// SPEC-057 §6.1 — the remains' pure half: where a death leaves them, what the
// bookkeeping writes, what a recovery takes back, and the words on the tag.
// The economy is the real one, so the cap and the event are the game's own.
import { describe, expect, it } from 'vitest';
import type { GameEvents } from '@/core/Events';
import { newSave, type CharacterCreation, type Remains, type Save } from '@/core/Save';
import type { ResourceId } from '@/data/index';
import { RESOLVE_SKIN } from '@/entities/World';
import { Economy } from '@/systems/Economy';
import { ObstacleGrid } from '@/systems/Layout';
import { Progression, type EventSink } from '@/systems/Progression';
import {
  PREDECESSOR_ALWAYS,
  PREDECESSOR_PAD_DISTANCE,
  PREDECESSOR_SEARCH_RADIUS,
  REMAINS_BODY_RADIUS,
  REMAINS_RECOVER_RADIUS,
  REMAINS_RETRY_SECONDS,
  dropRemains,
  placeRemains,
  predecessorStart,
  predecessorTag,
  recoverRemains,
  remainsHeld,
  remainsListText,
  remainsLook,
  remainsTag,
  type RemainsPlacement,
} from '@/systems/Remains';

const CREATION: CharacterCreation = {
  name: 'Vance',
  classId: 'marine',
  appearance: { portrait: 1, primary: '#b7472a', secondary: '#2a3b4c' },
  attributes: { might: 6, vigor: 5, agility: 1, tech: 1 },
  difficulty: 'normal',
};

function save(patch?: (data: Save) => void): Save {
  const data = newSave(0, CREATION, 7, 1_700_000_000_000);
  patch?.(data);
  return data;
}

/** A 60 m half-size surface with one 3 m rock at (10, 0). */
const HALF = 60;
const ROCK = { x: 10, z: 0, radius: 3, kind: 'rock' as const };
const GRID = new ObstacleGrid({ obstacles: [ROCK], halfSize: HALF });

function where(patch: Partial<RemainsPlacement> = {}): RemainsPlacement {
  return { obstacles: GRID, halfSize: HALF, arenaEntrance: null, descent: null, ...patch };
}

function economyOf(data: Save): { economy: Economy; collected: GameEvents['resource:collected'][] } {
  const collected: GameEvents['resource:collected'][] = [];
  const sink: EventSink = {
    emit(name, ...args) {
      if (name === 'resource:collected') collected.push((args as unknown[])[0] as GameEvents['resource:collected']);
    },
  };
  return { economy: new Economy(data, sink, new Progression(data, sink)), collected };
}

const taken = (): Record<ResourceId, number> => ({ oil: 0, wheat: 0, water: 0, lithium: 0 });

describe('the constants (§3)', () => {
  it('recover within 2 m, place for a 0.6 m circle, retry every second', () => {
    expect(REMAINS_RECOVER_RADIUS).toBe(2);
    expect(REMAINS_BODY_RADIUS).toBe(0.6);
    expect(REMAINS_RETRY_SECONDS).toBe(1);
  });
});

describe('placeRemains (§4.3, E92)', () => {
  it('a point inside an obstacle ends outside it, with the gap of resolveCircle', () => {
    const out = { x: 0, z: 0 };
    placeRemains({ x: 11, z: 0 }, where(), out);
    expect(GRID.hitsCircle(out.x, out.z, REMAINS_BODY_RADIUS)).toBe(false);
    // Pushed straight out along the centre-to-centre line, by the skin past touching.
    expect(out.z).toBeCloseTo(0, 9);
    expect(out.x - ROCK.x).toBeCloseTo(ROCK.radius + REMAINS_BODY_RADIUS + RESOLVE_SKIN, 9);
    // A clear point stays where it is.
    placeRemains({ x: -5, z: 7 }, where(), out);
    expect(out).toEqual({ x: -5, z: 7 });
  });

  it('a point past halfSize − 3 is clamped on both axes', () => {
    const out = { x: 0, z: 0 };
    placeRemains({ x: 59, z: -80 }, where(), out);
    expect(out).toEqual({ x: HALF - 3, z: -(HALF - 3) });
    placeRemains({ x: -57.5, z: 57 }, where(), out);
    expect(out).toEqual({ x: -57, z: 57 });
  });

  it('with an arena entrance it starts there, wherever the death was', () => {
    const out = { x: 0, z: 0 };
    placeRemains({ x: -30, z: 30 }, where({ arenaEntrance: { x: 20, z: -12 } }), out);
    expect(out).toEqual({ x: 20, z: -12 });
  });

  it('with a descent it starts there — even during a boss stage', () => {
    const out = { x: 0, z: 0 };
    placeRemains({ x: 3, z: 4 }, where({ descent: { x: -14, z: 22 } }), out);
    expect(out).toEqual({ x: -14, z: 22 });
    placeRemains({ x: 3, z: 4 }, where({ descent: { x: -14, z: 22 }, arenaEntrance: { x: 20, z: -12 } }), out);
    expect(out).toEqual({ x: -14, z: 22 });
    // A descent inside the rock is pushed out like any other start.
    placeRemains({ x: 0, z: 0 }, where({ descent: { x: 10, z: 1 } }), out);
    expect(GRID.hitsCircle(out.x, out.z, REMAINS_BODY_RADIUS)).toBe(false);
  });

  it('allocates nothing: it writes the same out object, and the same inputs give the same point', () => {
    const out = { x: 0, z: 0 };
    const placement = where();
    placeRemains({ x: 11, z: 0.5 }, placement, out);
    const first = { ...out };
    const again = out;
    placeRemains({ x: 11, z: 0.5 }, placement, out);
    expect(out).toBe(again);
    expect(out).toEqual(first);
  });
});

describe('dropRemains (§4.1 step 4, E91)', () => {
  it('creates the set with restart = stats.deaths, rounded to the 0.1 m lastDeath keeps', () => {
    const data = save((s) => {
      s.meta.stats.deaths = 3;
    });
    const { created, forfeited } = dropRemains(data, 'cinder4', { x: 12.345, z: -7.06 }, { oil: 20, wheat: 0, lithium: 4 });
    expect(forfeited).toBeNull();
    const expected: Remains = { planet: 'cinder4', x: 12.3, z: -7.1, resources: { oil: 20, lithium: 4 }, restart: 3 };
    expect(created).toEqual(expected);
    expect(data.progress.remains).toEqual(expected);
  });

  it('forfeits an old set lying on another planet, and the new set holds this death’s loss', () => {
    const old: Remains = { planet: 'vetra', x: 5, z: 6, resources: { water: 9 }, restart: 1 };
    const data = save((s) => {
      s.progress.remains = old;
      s.meta.stats.deaths = 2;
    });
    const { created, forfeited } = dropRemains(data, 'cinder4', { x: 1, z: 2 }, { oil: 18 });
    expect(forfeited).toEqual(old);
    expect(created).toEqual({ planet: 'cinder4', x: 1, z: 2, resources: { oil: 18 }, restart: 2 });
    expect(data.progress.remains).toBe(created);
  });

  it('an empty loss forfeits the old set and creates nothing (57-a)', () => {
    const old: Remains = { planet: 'cinder4', x: 5, z: 6, resources: { oil: 20 }, restart: 1 };
    const data = save((s) => {
      s.progress.remains = old;
    });
    expect(dropRemains(data, 'cinder4', { x: 0, z: 0 }, {})).toEqual({ created: null, forfeited: old });
    expect(data.progress.remains).toBeNull();
    // Nothing lying and nothing taken: nothing either way.
    expect(dropRemains(data, 'cinder4', { x: 0, z: 0 }, { oil: 0 })).toEqual({ created: null, forfeited: null });
  });
});

describe('recoverRemains (§4.4, E93)', () => {
  it('everything fits: the hold takes it all and the remains are gone', () => {
    const data = save((s) => {
      s.resources.oil = 180;
      s.resources.lithium = 10;
      s.progress.remains = { planet: 'cinder4', x: 0, z: 0, resources: { oil: 20, lithium: 12 }, restart: 1 };
    });
    const { economy, collected } = economyOf(data);
    const out = taken();
    expect(recoverRemains(data, economy, out)).toBe(true);
    expect(out).toEqual({ oil: 20, wheat: 0, water: 0, lithium: 12 });
    expect(data.resources.oil).toBe(200);
    expect(data.resources.lithium).toBe(22);
    expect(data.progress.remains).toBeNull();
    expect(collected.map((event) => event.source)).toEqual(['recovered', 'recovered']);
    expect(collected.some((event) => event.blocked !== undefined)).toBe(false);
  });

  it('a partial fit takes what the cap allows and leaves the rest', () => {
    const data = save((s) => {
      s.resources.oil = 395;
      s.resources.water = 400;
      s.progress.remains = { planet: 'cinder4', x: 4, z: 5, resources: { oil: 20, water: 6 }, restart: 2 };
    });
    const { economy } = economyOf(data);
    const out = taken();
    expect(recoverRemains(data, economy, out)).toBe(true);
    expect(out).toEqual({ oil: 5, wheat: 0, water: 0, lithium: 0 });
    expect(data.resources.oil).toBe(400);
    expect(data.progress.remains).toEqual({ planet: 'cinder4', x: 4, z: 5, resources: { oil: 15, water: 6 }, restart: 2 });
    expect(remainsHeld(data.progress.remains)).toBe(21);
    // A retry into the same full hold takes nothing, and says so.
    expect(recoverRemains(data, economy, out)).toBe(false);
    expect(out).toEqual(taken());
    expect(remainsHeld(data.progress.remains)).toBe(21);
  });

  it('empty after the last unit, written into the same reused record', () => {
    const data = save((s) => {
      s.resources.oil = 395;
      s.progress.remains = { planet: 'cinder4', x: 0, z: 0, resources: { oil: 20 }, restart: 1 };
    });
    const { economy } = economyOf(data);
    const out = taken();
    expect(recoverRemains(data, economy, out)).toBe(true);
    expect(data.progress.remains?.resources).toEqual({ oil: 15 });
    data.resources.oil = 100; // room again
    const record = out;
    expect(recoverRemains(data, economy, out)).toBe(true);
    expect(out).toBe(record);
    expect(out.oil).toBe(15);
    expect(data.resources.oil).toBe(115);
    expect(data.progress.remains).toBeNull();
    expect(remainsHeld(data.progress.remains)).toBe(0);
    // Nothing left: nothing to take.
    expect(recoverRemains(data, economy, out)).toBe(false);
  });
});

describe('remainsLook (§4.6)', () => {
  it('a pack on the first run before signal_decoded, the body with the flag, the body on iteration 2', () => {
    expect(remainsLook(save())).toBe('pack');
    expect(remainsLook(save((s) => s.progress.flags.push('signal_decoded')))).toBe('body');
    expect(remainsLook(save((s) => (s.meta.iteration = 2)))).toBe('body');
    // Another chapter's flag is no reveal.
    expect(remainsLook(save((s) => s.progress.flags.push('chapter3_done')))).toBe('pack');
  });
});

describe('remainsTag (§4.6)', () => {
  const remains: Remains = { planet: 'ferrum', x: 0, z: 0, resources: { oil: 1 }, restart: 4 };

  it("the pack is <Name>'s pack", () => {
    expect(remainsTag(save(), remains)).toBe("Vance's pack");
  });

  it('the body is instance/{instance} · restart <N>', () => {
    expect(remainsTag(save((s) => s.progress.flags.push('signal_decoded')), remains)).toBe('instance/62 · restart 4');
    expect(remainsTag(save((s) => (s.meta.iteration = 3)), remains)).toBe('instance/64 · restart 4');
  });

  it('a look passed in wins over the save’s, so a reveal mid-visit keeps the pack’s tag', () => {
    const revealed = save((s) => s.progress.flags.push('signal_decoded'));
    expect(remainsTag(revealed, remains, 'pack')).toBe("Vance's pack");
  });
});

describe('remainsListText (§4.7)', () => {
  it('lists in RESOURCE_IDS order, joined with a middle dot, zeros skipped', () => {
    expect(remainsListText({ lithium: 12, oil: 30 })).toBe('30 oil · 12 lithium');
    expect(remainsListText({ water: 3, lithium: 1, wheat: 2, oil: 4 })).toBe('4 oil · 2 wheat · 3 water · 1 lithium');
    expect(remainsListText({ oil: 0, water: 5 })).toBe('5 water');
    expect(remainsListText({})).toBe('');
  });
});

// ------------------------------------------------------------- SPEC-058 §4.5

describe('the predecessor’s body (SPEC-058 §4.5)', () => {
  const PAD = { x: 0, z: 0 };
  const SPAWN = { x: 12, z: 0 };
  const prior = (lastDeath: Save['meta']['stats']['lastDeath'] = {}): { lastDeath: Save['meta']['stats']['lastDeath'] } => ({ lastDeath });

  it('the constants: 6 m from the pad on Cinder-4, searched within 2.5 m', () => {
    expect(PREDECESSOR_PAD_DISTANCE).toBe(6);
    expect(PREDECESSOR_ALWAYS).toBe('cinder4');
    expect(PREDECESSOR_SEARCH_RADIUS).toBe(2.5);
  });

  it('starts where the predecessor last died on the planet', () => {
    const out = { x: 0, z: 0 };
    expect(predecessorStart(prior({ vetra: { x: -20, z: 15.5 } }), 'vetra', PAD, SPAWN, out)).toBe(true);
    expect(out).toEqual({ x: -20, z: 15.5 });
    // Cinder-4 too, when it died there: the death wins over the pad.
    expect(predecessorStart(prior({ cinder4: { x: 30, z: -8 } }), 'cinder4', PAD, SPAWN, out)).toBe(true);
    expect(out).toEqual({ x: 30, z: -8 });
  });

  it('58-d: on Cinder-4 with no death there, 6 m from the pad along the line to the spawn', () => {
    const out = { x: 0, z: 0 };
    expect(predecessorStart(prior(), 'cinder4', PAD, SPAWN, out)).toBe(true);
    expect(out).toEqual({ x: 6, z: 0 });
    expect(predecessorStart(prior(), 'cinder4', { x: 10, z: 10 }, { x: 10, z: 22 }, out)).toBe(true);
    expect(out.x).toBeCloseTo(10, 9);
    expect(out.z).toBeCloseTo(16, 9);
  });

  it('every other planet without a death shows no body', () => {
    const out = { x: 0, z: 0 };
    for (const planet of ['vetra', 'thessaly', 'ferrum', 'hive', 'eden'] as const) {
      expect(predecessorStart(prior({ cinder4: { x: 1, z: 1 } }), planet, PAD, SPAWN, out), planet).toBe(false);
    }
  });

  it('is pushed clear of the obstacles by placeRemains, like the player’s own remains', () => {
    const start = { x: 0, z: 0 };
    predecessorStart(prior({ cinder4: { x: 11, z: 0 } }), 'cinder4', PAD, SPAWN, start);
    const out = { x: 0, z: 0 };
    placeRemains(start, { obstacles: GRID, halfSize: HALF, arenaEntrance: null, descent: null }, out);
    expect(GRID.hitsCircle(out.x, out.z, REMAINS_BODY_RADIUS)).toBe(false);
  });

  it('the tag names the predecessor’s instance and name', () => {
    expect(predecessorTag({ iteration: 1, name: 'Vance' })).toBe('instance/62 · Vance');
    expect(predecessorTag({ iteration: 4, name: 'Ash' })).toBe('instance/65 · Ash');
  });
});
