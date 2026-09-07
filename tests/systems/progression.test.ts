// systems/Progression (SPEC-010 §7). The curve is pinned as explicit literals —
// PLAN §7 sizes the whole token economy against 11,400 XP to L20, so a changed
// constant is a design change and has to show up in a diff, not in a snapshot.
//
// The behaviour half is about E20: a level lands mid-fight, so everything it
// grants is applied before anyone is told, and the telling is a toast.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GameEvents } from '@/core/Events';
import { setLogSink, type LogSink } from '@/core/Log';
import { maxHp, newSave, type CharacterCreation, type SaveV1 } from '@/core/Save';
import { TUNING } from '@/data/index';
import {
  LEVEL_CAP,
  Progression,
  TOKENS_PER_LEVEL,
  cumulativeXp,
  levelForXp,
  levelUpText,
  xpToNext,
  type EventSink,
} from '@/systems/Progression';

// --------------------------------------------------------------- test doubles

interface Recorder extends EventSink {
  emitted: Array<{ name: keyof GameEvents; payload: unknown }>;
  names(): Array<keyof GameEvents>;
  of<K extends keyof GameEvents>(name: K): Array<GameEvents[K]>;
}

function recorder(): Recorder {
  const emitted: Array<{ name: keyof GameEvents; payload: unknown }> = [];
  return {
    emitted,
    emit(name, ...args) {
      emitted.push({ name, payload: (args as unknown[])[0] });
    },
    names() {
      return emitted.map((entry) => entry.name);
    },
    of<K extends keyof GameEvents>(name: K): Array<GameEvents[K]> {
      return emitted.filter((entry) => entry.name === name).map((entry) => entry.payload as GameEvents[K]);
    },
  };
}

const CREATION: CharacterCreation = {
  name: 'Vance',
  classId: 'marine',
  appearance: { portrait: 1, primary: '#b7472a', secondary: '#2a3b4c' },
  attributes: { might: 6, vigor: 5, agility: 1, tech: 1 },
  difficulty: 'normal',
};

function save(): SaveV1 {
  return newSave(0, CREATION, 42, 1_700_000_000_000);
}

/** `log.debug` fires on every level-up; the suite does not need it on stdout. */
const mute: LogSink = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

beforeEach(() => {
  setLogSink(mute);
});

afterEach(() => {
  setLogSink(console);
});

// ---------------------------------------------------------------- the curve

describe('the XP curve (§4.1)', () => {
  it('xpToNext is 100 + 50·L', () => {
    expect(xpToNext(1)).toBe(150);
    expect(xpToNext(2)).toBe(200);
    expect(xpToNext(19)).toBe(1050);
    expect(xpToNext(29)).toBe(1550);
    expect(xpToNext(1)).toBe(TUNING.XP_BASE + TUNING.XP_PER_LEVEL);
  });

  it('cumulativeXp is pinned at L2 150, L5 900, L10 3150, L15 6650, L20 11400, L30 24650', () => {
    expect(cumulativeXp(1)).toBe(0);
    expect(cumulativeXp(2)).toBe(150);
    expect(cumulativeXp(5)).toBe(900);
    expect(cumulativeXp(10)).toBe(3150);
    expect(cumulativeXp(15)).toBe(6650);
    expect(cumulativeXp(20)).toBe(11400);
    expect(cumulativeXp(30)).toBe(24650);
  });

  it('the two agree: one step of the curve is one xpToNext', () => {
    for (let level = 1; level < LEVEL_CAP; level += 1) {
      expect(cumulativeXp(level + 1) - cumulativeXp(level)).toBe(xpToNext(level));
    }
  });

  it('levelForXp lands on the thresholds and stops at the cap of 30', () => {
    expect(LEVEL_CAP).toBe(30);
    expect(levelForXp(0)).toBe(1);
    expect(levelForXp(-100)).toBe(1);
    expect(levelForXp(149)).toBe(1);
    expect(levelForXp(150)).toBe(2);
    expect(levelForXp(899)).toBe(4);
    expect(levelForXp(900)).toBe(5);
    expect(levelForXp(11_400)).toBe(20);
    expect(levelForXp(24_649)).toBe(29);
    expect(levelForXp(24_650)).toBe(30);
    expect(levelForXp(10_000_000)).toBe(30);
  });
});

// --------------------------------------------------------------- addXp

describe('Progression.addXp (§4.1)', () => {
  it('grants 25 tokens and the max-HP delta on every level', () => {
    const data = save();
    const events = recorder();
    const progression = new Progression(data, events);
    const hpBefore = data.player.hp;

    expect(progression.addXp(150, 'mission:c1_m1')).toEqual({ levelsGained: 1 });

    expect(progression.level).toBe(2);
    expect(progression.tokens).toBe(TOKENS_PER_LEVEL);
    expect(TOKENS_PER_LEVEL).toBe(25);
    expect(data.player.hp).toBe(hpBefore + (maxHp('marine', data.player.attributes, 2) - maxHp('marine', data.player.attributes, 1)));
    expect(data.player.hp).toBe(hpBefore + 4);
  });

  it('takes several levels in one call and emits them in order', () => {
    const data = save();
    const events = recorder();
    const progression = new Progression(data, events);

    // 900 XP is exactly L5 (§4.1), so this is four levels at once.
    expect(progression.addXp(900, 'mission:c2_m2')).toEqual({ levelsGained: 4 });
    expect(progression.level).toBe(5);
    expect(progression.tokens).toBe(4 * TOKENS_PER_LEVEL);

    expect(events.of('player:xp')).toEqual([{ amount: 900, total: 900 }]);
    expect(events.of('player:leveledUp')).toEqual([
      { level: 2, tokens: 25 },
      { level: 3, tokens: 25 },
      { level: 4, tokens: 25 },
      { level: 5, tokens: 25 },
    ]);
    expect(events.of('tokens:changed')).toEqual([
      { delta: 25, total: 25, reason: 'level' },
      { delta: 25, total: 50, reason: 'level' },
      { delta: 25, total: 75, reason: 'level' },
      { delta: 25, total: 100, reason: 'level' },
    ]);
    // The XP total goes out first, then each level's grant, then its toast.
    expect(events.names().slice(0, 4)).toEqual(['player:xp', 'tokens:changed', 'player:leveledUp', 'ui:toast']);
  });

  it('E20: the grant is applied before anyone hears about it, and it is a toast', () => {
    const data = save();
    const events = recorder();
    // A listener that reads the save the moment the level-up is delivered —
    // which is what a HUD does. Nothing may be pending at that point.
    const seen: Array<{ tokens: number; hp: number; level: number }> = [];
    const sink: EventSink = {
      emit(name, ...args) {
        events.emit(name, ...args);
        if (name === 'player:leveledUp') seen.push({ tokens: data.player.tokens, hp: data.player.hp, level: data.player.level });
      },
    };
    const hpBefore = data.player.hp;
    new Progression(data, sink).addXp(150, 'kill:dust_skitter');

    expect(seen).toEqual([{ tokens: 25, hp: hpBefore + 4, level: 2 }]);
    expect(events.of('ui:toast')).toEqual([{ kind: 'good', text: levelUpText(2, 25) }]);
    expect(levelUpText(2, 25)).toBe('Level 2 — +25 tokens');
  });

  it('10-d: XP past the cap accumulates and grants nothing', () => {
    const data = save();
    const events = recorder();
    const progression = new Progression(data, events);

    progression.addXp(cumulativeXp(LEVEL_CAP), 'debug');
    expect(progression.level).toBe(30);
    expect(progression.tokens).toBe(29 * TOKENS_PER_LEVEL);

    const tokens = progression.tokens;
    expect(progression.addXp(50_000, 'debug')).toEqual({ levelsGained: 0 });
    expect(progression.level).toBe(30);
    expect(progression.tokens).toBe(tokens);
    expect(data.player.xp).toBe(cumulativeXp(LEVEL_CAP) + 50_000);
  });

  it('ignores nothing-amounts rather than emitting them', () => {
    const data = save();
    const events = recorder();
    const progression = new Progression(data, events);
    for (const amount of [0, -50, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(progression.addXp(amount, 'debug')).toEqual({ levelsGained: 0 });
    }
    expect(data.player.xp).toBe(0);
    expect(events.emitted).toEqual([]);
  });
});

// -------------------------------------------------------------- the balance

describe('Progression tokens', () => {
  it('addTokens announces the delta and the new total', () => {
    const data = save();
    const events = recorder();
    const progression = new Progression(data, events);
    progression.addTokens(30, 'mission:c1_m3');
    progression.addTokens(0, 'nothing');
    expect(progression.tokens).toBe(30);
    expect(events.of('tokens:changed')).toEqual([{ delta: 30, total: 30, reason: 'mission:c1_m3' }]);
  });

  it('spendTokens refuses to go negative and leaves the balance alone', () => {
    const data = save();
    const events = recorder();
    const progression = new Progression(data, events);
    progression.addTokens(40, 'test');

    expect(progression.spendTokens(41, 'gear:weapon_laser')).toBe(false);
    expect(progression.tokens).toBe(40);
    expect(progression.spendTokens(40, 'gear:weapon_laser')).toBe(true);
    expect(progression.tokens).toBe(0);
    expect(events.of('tokens:changed').at(-1)).toEqual({ delta: -40, total: 0, reason: 'gear:weapon_laser' });
  });
});
