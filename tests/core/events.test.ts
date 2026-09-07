// core/Events (SPEC-004 §6). Two halves: the runtime behaviour of the bus, and
// a type-level half that only ever runs as `tsc` — the `@ts-expect-error` lines
// and the exhaustive `Record<keyof GameEvents, true>` fail `npm run typecheck`
// if the map or the emit signature drifts, which is the whole point of a typed
// bus (AC-3, AC-4, AC-23, AC-25).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventBus, EventLoopError, MAX_EMIT_DEPTH, type GameEvents } from '@/core/Events';
import { setLogSink, type LogSink } from '@/core/Log';
import type { EventBus as ServicesEventBus } from '@/core/Services';

type Line = { level: keyof LogSink; args: unknown[] };

/** The log recorder the rest of the suite asserts through (SPEC-004 D-15). */
function recorder(): Line[] {
  const lines: Line[] = [];
  setLogSink({
    debug: (...args: unknown[]) => void lines.push({ level: 'debug', args }),
    info: (...args: unknown[]) => void lines.push({ level: 'info', args }),
    warn: (...args: unknown[]) => void lines.push({ level: 'warn', args }),
    error: (...args: unknown[]) => void lines.push({ level: 'error', args }),
  });
  return lines;
}

/** A tiny map so the behaviour tests are not tied to any real event's payload. */
type TestEvents = {
  a: void;
  b: { n: number };
  c: void;
};

const bus = (): EventBus<TestEvents> => new EventBus<TestEvents>();

afterEach(() => {
  setLogSink(console);
  vi.restoreAllMocks();
});

describe('EventBus delivery (§4.1)', () => {
  it('delivers synchronously, in subscription order', () => {
    const events = bus();
    const seen: string[] = [];
    events.on('a', () => void seen.push('first'));
    events.once('a', () => void seen.push('second'));
    events.on('a', () => void seen.push('third'));
    events.emit('a');
    // AC-6: no await, no tick — everything has already run.
    expect(seen).toEqual(['first', 'second', 'third']); // AC-7
  });

  it('passes the payload through untouched', () => {
    const events = bus();
    const seen: Array<{ n: number }> = [];
    events.on('b', (payload) => void seen.push(payload));
    events.emit('b', { n: 7 });
    expect(seen).toEqual([{ n: 7 }]);
  });

  it('keeps a handler that an earlier handler unsubscribed for this emit only', () => {
    // AC-8 / 04-d: snapshot semantics.
    const events = bus();
    const seen: string[] = [];
    events.on('a', () => off());
    const off = events.on('a', () => void seen.push('later'));
    events.emit('a');
    expect(seen).toEqual(['later']);
    events.emit('a');
    expect(seen).toEqual(['later']);
    expect(events.count('a')).toBe(1);
  });

  it('keeps the handlers of an owner released mid-delivery for this emit only', () => {
    // 04-g: releaseOwner from inside a handler is the same snapshot rule.
    const events = bus();
    const owner = {};
    const seen: string[] = [];
    events.on('a', () => void events.releaseOwner(owner));
    events.on('a', () => void seen.push('later'), owner);
    events.emit('a');
    expect(seen).toEqual(['later']);
    events.emit('a');
    expect(seen).toEqual(['later']);
  });

  it('makes a handler subscribed during delivery wait for the next emit', () => {
    // AC-9 / 04-f.
    const events = bus();
    const seen: string[] = [];
    events.on('a', () => {
      if (events.count('a') === 1) events.on('a', () => void seen.push('late'));
    });
    events.emit('a');
    expect(seen).toEqual([]);
    events.emit('a');
    expect(seen).toEqual(['late']);
  });

  it('emits for a type with no subscriptions without throwing or copying an array', () => {
    // AC-22: 04-c is an early return, so the empty case allocates nothing. The
    // snapshot is the only array copy in `emit`, so watching `slice` proves it.
    const events = bus();
    const slice = vi.spyOn(Array.prototype, 'slice');
    expect(() => events.emit('a')).not.toThrow();
    expect(slice).not.toHaveBeenCalled();
    // …and the spy really would have seen a copy, had there been anything to copy.
    events.on('a', () => {});
    events.emit('a');
    expect(slice).toHaveBeenCalled();
  });
});

describe('EventBus errors (§4.2)', () => {
  it('logs a throwing handler and runs the rest', () => {
    const lines = recorder();
    const events = bus();
    class Hud {}
    const owner = new Hud();
    const seen: string[] = [];
    events.on('a', () => {
      throw new Error('broken widget');
    }, owner);
    events.on('a', () => void seen.push('after'));

    expect(() => events.emit('a')).not.toThrow(); // AC-10
    expect(seen).toEqual(['after']); // AC-10

    // AC-11: one line, with the event type, the owner label and the thrown value.
    const errors = lines.filter((line) => line.level === 'error');
    expect(errors).toHaveLength(1);
    const [tag, message, thrown] = errors[0]?.args as [string, string, unknown];
    expect(tag).toBe('[events]');
    expect(message).toContain('"a"');
    expect(message).toContain('Hud');
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe('broken widget');
  });

  it('names an owner-less subscription "none"', () => {
    const lines = recorder();
    const events = bus();
    events.on('a', () => {
      throw new Error('nope');
    });
    events.emit('a');
    const [, message] = lines.find((line) => line.level === 'error')?.args as [string, string];
    expect(message).toContain('none');
  });

  it('fires onHandlerError at most once per (type, handler) pair', () => {
    // AC-12: an overlay that reopened every frame would be unusable.
    recorder();
    const calls: Array<[string, unknown]> = [];
    const events = new EventBus<TestEvents>({ onHandlerError: (type, error) => void calls.push([type, error]) });
    const boom = (): void => {
      throw new Error('boom');
    };
    events.on('a', boom);
    events.on('c', boom);
    events.emit('a');
    events.emit('a');
    events.emit('a');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe('a');
    // The same function under a different type is a different pair.
    events.emit('c');
    expect(calls.map(([type]) => type)).toEqual(['a', 'c']);
  });

  it('removes a throwing once, logs it, and runs the rest', () => {
    // 04-j.
    const lines = recorder();
    const events = bus();
    const seen: string[] = [];
    events.once('a', () => {
      throw new Error('once threw');
    });
    events.on('a', () => void seen.push('after'));
    events.emit('a');
    expect(events.count('a')).toBe(1);
    expect(seen).toEqual(['after']);
    expect(lines.filter((line) => line.level === 'error')).toHaveLength(1);
  });
});

describe('EventBus once (§4.1)', () => {
  it('fires exactly once, even when it re-emits the same event from inside itself', () => {
    // AC-13 / 04-b: the subscription leaves the live list before it runs.
    const events = bus();
    let fired = 0;
    events.once('a', () => {
      fired++;
      if (fired < 5) events.emit('a');
    });
    events.emit('a');
    expect(fired).toBe(1);
    events.emit('a');
    expect(fired).toBe(1);
    expect(events.count('a')).toBe(0);
  });

  it('fires exactly once when an earlier handler re-emits the same event', () => {
    // AC-13 / 04-b, the nested variant: the once runs inside the inner emit, so
    // the outer emit is still iterating a snapshot that contains it.
    const events = bus();
    let fired = 0;
    let reentered = false;
    events.on('a', () => {
      if (reentered) return;
      reentered = true;
      events.emit('a');
    });
    events.once('a', () => void fired++);
    events.emit('a');
    expect(fired).toBe(1);
    expect(events.count('a')).toBe(1); // only the `on` is left
  });

  it('still runs a once that another handler unsubscribed mid-delivery', () => {
    // AC-8 / 04-d applies to `once` too: removed but not yet fired, so the
    // current emit still delivers it — and the next one does not.
    const events = bus();
    let fired = 0;
    events.on('a', () => off());
    const off = events.once('a', () => void fired++);
    events.emit('a');
    expect(fired).toBe(1);
    events.emit('a');
    expect(fired).toBe(1);
  });

  it('cancels a pending once, and is a no-op once the handler has fired', () => {
    // AC-14.
    const events = bus();
    let fired = 0;
    const cancel = events.once('a', () => void fired++);
    cancel();
    events.emit('a');
    expect(fired).toBe(0);
    expect(events.count()).toBe(0);

    const off = events.once('a', () => void fired++);
    events.emit('a');
    expect(fired).toBe(1);
    expect(() => off()).not.toThrow();
    expect(events.count()).toBe(0);
  });
});

/** Nine `void` events, one more than the depth limit allows in flight, plus a spare. */
type ChainEvents = {
  e0: void;
  e1: void;
  e2: void;
  e3: void;
  e4: void;
  e5: void;
  e6: void;
  e7: void;
  e8: void;
  later: void;
};
const step = (i: number): keyof ChainEvents => `e${i}` as keyof ChainEvents;
/** `e0 -> e1 -> … -> e7`: the eight types in flight when the ninth emit is refused. */
const EXPECTED_CHAIN = Array.from({ length: MAX_EMIT_DEPTH }, (_, i) => `e${i}`).join(' -> ');

describe('EventBus re-entrancy (§4.3)', () => {
  /** `e0 … e{depth-1}`, each handler emitting the next — `depth` emits in flight. */
  function chain(events: EventBus<ChainEvents>, depth: number): void {
    for (let i = 0; i < depth - 1; i++) events.on(step(i), () => events.emit(step(i + 1)));
  }

  it('delivers a chain up to the depth limit', () => {
    // AC-15: eight emits in flight is fine.
    const events = new EventBus<ChainEvents>();
    let deepest = false;
    chain(events, MAX_EMIT_DEPTH);
    events.on(step(MAX_EMIT_DEPTH - 1), () => void (deepest = true));
    expect(() => events.emit('e0')).not.toThrow();
    expect(deepest).toBe(true);
  });

  it('throws EventLoopError on the emit past the limit, naming the chain', () => {
    // AC-16 / AC-17a: the ninth emit, before any of its handlers runs.
    const events = new EventBus<ChainEvents>();
    chain(events, MAX_EMIT_DEPTH + 1);
    let deepestRan = false;
    events.on(step(MAX_EMIT_DEPTH), () => void (deepestRan = true));

    let thrown: unknown;
    try {
      events.emit('e0');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(EventLoopError);
    expect((thrown as EventLoopError).message).toBe(`event loop: ${EXPECTED_CHAIN}`);
    expect(deepestRan).toBe(false);
  });

  it('is not swallowed by the handler catch and logs nothing', () => {
    // AC-17a / D-5: a loop is a programming error and must be loud.
    const lines = recorder();
    const events = new EventBus<ChainEvents>();
    chain(events, MAX_EMIT_DEPTH + 1);
    events.on(step(MAX_EMIT_DEPTH), () => {});
    expect(() => events.emit('e0')).toThrow(EventLoopError);
    expect(lines.filter((line) => line.level === 'error')).toEqual([]);
  });

  it('resets depth and chain, so the bus still delivers afterwards', () => {
    // AC-17b / 04-k.
    const events = new EventBus<ChainEvents>();
    chain(events, MAX_EMIT_DEPTH + 1);
    events.on(step(MAX_EMIT_DEPTH), () => {});
    expect(() => events.emit('e0')).toThrow(EventLoopError);

    let seen = 0;
    events.on('later', () => void seen++);
    expect(() => events.emit('later')).not.toThrow();
    expect(seen).toBe(1);

    // And the chain in a second failure names only the second run's events.
    let second: unknown;
    try {
      events.emit('e0');
    } catch (error) {
      second = error;
    }
    expect((second as EventLoopError).message).toBe(`event loop: ${EXPECTED_CHAIN}`);
  });
});

describe('EventBus ownership (§4.4)', () => {
  it('releases every subscription of one owner and returns how many', () => {
    // AC-18a, AC-18b.
    const events = bus();
    const owner = {};
    const seen: string[] = [];
    events.on('a', () => void seen.push('on'), owner);
    events.once('a', () => void seen.push('once'), owner);
    events.on('b', () => void seen.push('b'), owner);
    expect(events.releaseOwner(owner)).toBe(3);
    events.emit('a');
    events.emit('b', { n: 1 });
    expect(seen).toEqual([]);
    expect(events.count()).toBe(0);
  });

  it('leaves other owners and owner-less subscriptions alone', () => {
    // AC-18c, AC-18d, D-11 / 04-h.
    const events = bus();
    const mine = {};
    const theirs = {};
    const seen: string[] = [];
    events.on('a', () => void seen.push('mine'), mine);
    events.on('a', () => void seen.push('theirs'), theirs);
    events.on('a', () => void seen.push('nobody'));
    expect(events.releaseOwner(mine)).toBe(1);
    events.emit('a');
    expect(seen).toEqual(['theirs', 'nobody']);
    expect(events.count()).toBe(2);
  });

  it('returns 0 for an owner that never subscribed', () => {
    // AC-18e.
    const events = bus();
    events.on('a', () => {});
    expect(events.releaseOwner({})).toBe(0);
    expect(events.count()).toBe(1);
  });

  it('warns once, listing the leak count and the leaked types, and removes nothing', () => {
    // AC-27a, AC-27c.
    const lines = recorder();
    const events = bus();
    class MenuScene {}
    const owner = new MenuScene();
    events.on('a', () => {}, owner);
    events.on('a', () => {}, owner);
    events.on('b', () => {}, owner);

    events.assertNoOwner(owner);
    const warnings = lines.filter((line) => line.level === 'warn');
    expect(warnings).toHaveLength(1);
    const [tag, message] = warnings[0]?.args as [string, string];
    expect(tag).toBe('[events]');
    expect(message).toContain('3');
    expect(message).toContain('MenuScene');
    expect(message).toContain('a');
    expect(message).toContain('b');
    // It reports; it does not repair (D-13).
    expect(events.count()).toBe(3);
  });

  it('says nothing when the owner released everything', () => {
    // AC-27b.
    const lines = recorder();
    const events = bus();
    const owner = {};
    events.on('a', () => {}, owner);
    events.releaseOwner(owner);
    events.assertNoOwner(owner);
    events.assertNoOwner({});
    expect(lines).toEqual([]);
  });

  it('keeps no owner index on a dev:false bus, but releases the same subscriptions', () => {
    // AC-28. The owner index is the only thing `assertNoOwner` reads and the
    // only thing `releaseOwner` does *not* — it scans the lists (§4.4). So a bus
    // that reports no leaks while still releasing all three of them is a bus
    // with no index; and the counts match the dev bus above exactly.
    const lines = recorder();
    const events = new EventBus<TestEvents>({ dev: false });
    const owner = {};
    events.on('a', () => {}, owner);
    events.once('a', () => {}, owner);
    events.on('b', () => {}, owner);

    events.assertNoOwner(owner);
    expect(lines).toEqual([]); // AC-28a, AC-28b / 04-m
    expect(events.count()).toBe(3); // it removed nothing either

    expect(events.releaseOwner(owner)).toBe(3); // AC-28c
    expect(events.count()).toBe(0);
  });
});

describe('EventBus bookkeeping (§4.1)', () => {
  it('counts every add and removal, by total and by type', () => {
    // AC-19a, AC-19b, AC-19c.
    const events = bus();
    expect(events.count()).toBe(0);
    expect(events.count('a')).toBe(0);

    const handler = (): void => {};
    const offA = events.on('a', handler);
    events.once('a', () => {});
    const owned = {};
    events.on('b', () => {}, owned);
    expect(events.count()).toBe(3);
    expect(events.count('a')).toBe(2);
    expect(events.count('b')).toBe(1);

    offA();
    expect(events.count('a')).toBe(1);
    events.emit('a'); // the pending once fires and leaves
    expect(events.count('a')).toBe(0);

    events.on('a', handler);
    events.off('a', handler);
    expect(events.count('a')).toBe(0);

    events.releaseOwner(owned);
    expect(events.count()).toBe(0);
  });

  it('does not count onAny listeners', () => {
    // AC-19d.
    const events = bus();
    const release = events.onAny(() => {});
    expect(events.count()).toBe(0);
    expect(events.count('a')).toBe(0);
    events.on('a', () => {});
    expect(events.count()).toBe(1);
    release();
    expect(events.count()).toBe(1);
  });

  it('notifies onAny of every emit, with the name and the payload', () => {
    // The mechanism behind the `?debug` logger of §4.6.
    const events = bus();
    const seen: Array<[string, unknown]> = [];
    const release = events.onAny((type, payload) => void seen.push([type as string, payload]));
    events.emit('a');
    events.emit('b', { n: 2 });
    release();
    events.emit('a');
    expect(seen).toEqual([
      ['a', undefined],
      ['b', { n: 2 }],
    ]);
  });

  it('off removes every subscription for the pair, once included, whatever the owner', () => {
    // AC-20a, AC-20b, D-8 / 04-i.
    const events = bus();
    let fired = 0;
    const handler = (): void => void fired++;
    events.on('a', handler);
    events.on('a', handler, {});
    events.once('a', handler);
    events.on('a', () => void fired++); // a different function survives
    expect(events.count('a')).toBe(4);

    events.off('a', handler);
    expect(events.count('a')).toBe(1);
    events.emit('a');
    expect(fired).toBe(1);
  });

  it('off for a pair that is not subscribed is a no-op', () => {
    // AC-20c / 04-l.
    const events = bus();
    const handler = (): void => {};
    expect(() => events.off('a', handler)).not.toThrow();
    events.on('a', () => {});
    expect(() => events.off('a', handler)).not.toThrow();
    expect(events.count('a')).toBe(1);
  });

  it('an Unsubscribe is idempotent', () => {
    // AC-21 / 04-a.
    const events = bus();
    const handler = (): void => {};
    const first = events.on('a', handler);
    events.on('a', handler);
    expect(events.count('a')).toBe(2);
    first();
    expect(events.count('a')).toBe(1);
    first();
    expect(events.count('a')).toBe(1);
  });
});

// --------------------------------------------------------------- type level

/**
 * AC-23: exactly the events of §3.2, no more and no fewer. A key that
 * `GameEvents` does not have is an excess-property error; a key it has and this
 * literal does not is a missing-property error. Both fail `npm run typecheck`.
 */
const NAMES: Record<keyof GameEvents, true> = {
  'app:paused': true,
  'app:resumed': true,
  'renderer:resized': true,
  'renderer:context-lost': true,
  'renderer:context-restored': true,
  'scene:transition': true,
  'scene:entered': true,
  'input:schemeChanged': true,
  'audio:unlocked': true,
  'save:written': true,
  'save:failed': true,
  'settings:changed': true,
  'player:damaged': true,
  'player:healed': true,
  'player:died': true,
  'player:respawned': true,
  'player:xp': true,
  'player:leveledUp': true,
  'tokens:changed': true,
  'resource:collected': true,
  'resource:spent': true,
  'inventory:changed': true,
  'gear:equipped': true,
  'shop:purchased': true,
  'enemy:spawned': true,
  'enemy:killed': true,
  'boss:phase': true,
  'boss:defeated': true,
  'poi:discovered': true,
  'poi:reached': true,
  'poi:scanned': true,
  'poi:delivered': true,
  'poi:damaged': true,
  'follower:died': true,
  'weather:warning': true,
  'weather:changed': true,
  'wave:started': true,
  'wave:cleared': true,
  'mission:accepted': true,
  'mission:stageStarted': true,
  'mission:progress': true,
  'mission:stageReset': true,
  'mission:completed': true,
  'mission:abandoned': true,
  'flag:set': true,
  'dialogue:started': true,
  'dialogue:ended': true,
  'ship:damaged': true,
  'flight:arrived': true,
  'flight:recalled': true,
  'ui:toast': true,
  'ui:orientation': true,
};

/** AC-25c: the concrete class satisfies the structural port `core/Services.ts` keeps. */
const port: ServicesEventBus = new EventBus<GameEvents>();

describe('GameEvents (§3.2)', () => {
  it('is exactly the canonical table', () => {
    expect(Object.keys(NAMES)).toHaveLength(52);
  });

  it('still carries the nine names SPEC-002 and SPEC-003 already emit', () => {
    // AC-24: every shipped emit site compiles untouched, including the widened
    // `ui:toast` of D-2 — `{ kind: 'error', text }` is what they pass today.
    const game = new EventBus<GameEvents>();
    const seen: string[] = [];
    for (const name of [
      'scene:transition',
      'scene:entered',
      'app:paused',
      'app:resumed',
      'renderer:resized',
      'renderer:context-lost',
      'renderer:context-restored',
      'ui:orientation',
      'ui:toast',
    ] as const) {
      game.on(name, () => void seen.push(name));
    }
    game.emit('scene:transition', { from: null, to: 'menu' });
    game.emit('scene:entered', { id: 'menu' });
    game.emit('app:paused');
    game.emit('app:resumed');
    game.emit('renderer:resized', { width: 800, height: 600, dpr: 2 });
    game.emit('renderer:context-lost');
    game.emit('renderer:context-restored');
    game.emit('ui:orientation', { orientation: 'portrait' });
    game.emit('ui:toast', { kind: 'error', text: 'could not enter the scene' });
    expect(seen).toEqual([
      'scene:transition',
      'scene:entered',
      'app:paused',
      'app:resumed',
      'renderer:resized',
      'renderer:context-lost',
      'renderer:context-restored',
      'ui:orientation',
      'ui:toast',
    ]);
  });

  it('typed payloads: the wrong ones do not compile', () => {
    const events = new EventBus<GameEvents>();
    // AC-5a: a `void` payload takes no argument…
    events.emit('app:paused');
    // …and AC-5b: a payload event requires one.
    events.emit('scene:entered', { id: 'station' });

    // AC-3a: a known event with the wrong payload.
    // @ts-expect-error `scene:entered` carries `{ id: SceneId }`, not a number
    events.emit('scene:entered', { id: 42 });
    // AC-4: a name that is not in `GameEvents`.
    // @ts-expect-error there is no such event
    events.emit('scene:teleported', { id: 'menu' });
    // AC-5b again, from the other side: the payload is not optional.
    // @ts-expect-error `scene:entered` needs its payload
    events.emit('scene:entered');
    // A handler's payload is typed too.
    // @ts-expect-error `renderer:resized` has no `depth`
    events.on('renderer:resized', (payload: { depth: number }) => void payload);

    // The port assertion above is only a compile-time claim; touch it so
    // `noUnusedLocals` keeps it, and use it the way SPEC-003 does.
    port.assertNoOwner({});
    expect(events.count()).toBe(1);
  });
});
