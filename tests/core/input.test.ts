// The input system (SPEC-005 §6). Everything here runs in node: `Input` needs
// no DOM at all (AC-31), and the keyboard/mouse driver takes its targets by
// injection, so the whole desktop scheme — bindings, `preventDefault` gating,
// editable fields, mouse buttons, focus loss — is drivable with plain objects.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ACTIONS,
  COARSE_POINTER_QUERY,
  createNullInput,
  DEAD_ZONE,
  FLIGHT_AIM_ASSIST,
  FLIGHT_STEER_FRACTION,
  FLOAT_DRIFT,
  initialScheme,
  Input,
  JOYSTICK_RADIUS_PX,
  MOVE_ZONE_FRACTION,
  shapeTouchStick,
  TAP_SLOP_PX,
  TOUCH_BUTTON_PX,
  TOUCH_FULL_TRAVEL,
  zoneFor,
} from '@/core/Input';
import { KEY_BINDINGS, KeyboardMouseDriver } from '@/core/KeyboardMouseDriver';
import type { EventBus } from '@/core/Services';
import { createSettings } from '@/core/Settings';

const DT = 1 / 60;

// ------------------------------------------------------------------- fakes

interface FakeTarget {
  readonly target: EventTarget;
  hidden: boolean;
  fire(type: string, event: unknown): void;
  readonly listeners: number;
}

/** An `EventTarget` the tests can fire by hand; `hidden` is for `document`. */
function fakeTarget(extra: Record<string, unknown> = {}): FakeTarget {
  const handlers = new Map<string, Array<(event: unknown) => void>>();
  const target = {
    ...extra,
    hidden: false,
    addEventListener(type: string, handler: (event: unknown) => void): void {
      const list = handlers.get(type) ?? [];
      list.push(handler);
      handlers.set(type, list);
    },
    removeEventListener(type: string, handler: (event: unknown) => void): void {
      const list = handlers.get(type) ?? [];
      const at = list.indexOf(handler);
      if (at >= 0) list.splice(at, 1);
    },
  };
  return {
    target: target as unknown as EventTarget,
    get hidden(): boolean {
      return target.hidden;
    },
    set hidden(value: boolean) {
      target.hidden = value;
    },
    fire(type: string, event: unknown): void {
      for (const handler of [...(handlers.get(type) ?? [])]) handler(event);
    },
    get listeners(): number {
      let total = 0;
      for (const list of handlers.values()) total += list.length;
      return total;
    },
  };
}

interface FakeKeyEvent {
  code: string;
  repeat: boolean;
  target: unknown;
  prevented: boolean;
  preventDefault(): void;
}

function keyEvent(code: string, options: { repeat?: boolean; target?: unknown } = {}): FakeKeyEvent {
  const event: FakeKeyEvent = {
    code,
    repeat: options.repeat ?? false,
    target: options.target ?? null,
    prevented: false,
    preventDefault(): void {
      event.prevented = true;
    },
  };
  return event;
}

interface FakePointerEvent {
  pointerId: number;
  pointerType: string;
  button: number;
  clientX: number;
  clientY: number;
  prevented: boolean;
  preventDefault(): void;
}

function pointerEvent(options: Partial<Omit<FakePointerEvent, 'preventDefault' | 'prevented'>> = {}): FakePointerEvent {
  const event: FakePointerEvent = {
    pointerId: options.pointerId ?? 1,
    pointerType: options.pointerType ?? 'mouse',
    button: options.button ?? 0,
    clientX: options.clientX ?? 0,
    clientY: options.clientY ?? 0,
    prevented: false,
    preventDefault(): void {
      event.prevented = true;
    },
  };
  return event;
}

interface FakeBus {
  readonly bus: EventBus;
  readonly emitted: Array<{ name: string; payload: unknown }>;
  readonly subscriptions: number;
}

/** The three members of the `EventBus` port `Input` consumes (SPEC-004 D-7). */
function fakeBus(): FakeBus {
  const emitted: Array<{ name: string; payload: unknown }> = [];
  const handlers = new Map<string, Array<(payload: unknown) => void>>();
  const bus = {
    emit(name: string, payload?: unknown): void {
      emitted.push({ name, payload });
      for (const handler of [...(handlers.get(name) ?? [])]) handler(payload);
    },
    on(name: string, handler: (payload: unknown) => void): () => void {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
      return () => {
        const at = list.indexOf(handler);
        if (at >= 0) list.splice(at, 1);
      };
    },
    assertNoOwner(): void {},
  };
  return {
    bus: bus as unknown as EventBus,
    emitted,
    get subscriptions(): number {
      let total = 0;
      for (const list of handlers.values()) total += list.length;
      return total;
    },
  };
}

interface Harness {
  readonly input: Input;
  readonly driver: KeyboardMouseDriver;
  readonly win: FakeTarget;
  readonly doc: FakeTarget;
  readonly canvas: FakeTarget;
}

/** An `Input` with the keyboard/mouse driver bound to three fake targets. */
function harness(): Harness {
  const win = fakeTarget();
  const doc = fakeTarget();
  const canvas = fakeTarget({
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
  });
  const input = new Input();
  const driver = new KeyboardMouseDriver(input, {
    win: win.target,
    doc: doc.target,
    canvas: canvas.target as unknown as HTMLCanvasElement,
  });
  return { input, driver, win, doc, canvas };
}

// -------------------------------------------------------------------- state

describe('Input.state (AC-1)', () => {
  it('exposes move, aim, every button, the scheme and autoFire', () => {
    const state = new Input().state;
    expect(state.move).toEqual({ x: 0, y: 0 });
    expect(state.aim).toEqual({
      screenX: 0,
      screenY: 0,
      ndcX: 0,
      ndcY: 0,
      hasPointer: false,
      dragging: false,
      dirX: 0,
      dirY: 0,
    });
    expect(Object.keys(state.buttons).sort()).toEqual([...ACTIONS].sort());
    for (const action of ACTIONS) {
      expect(state.buttons[action]).toEqual({ down: false, justPressed: false, justReleased: false, heldFor: 0 });
    }
    expect(state.scheme).toBe('keyboard');
    expect(state.autoFire).toBe(false);
  });

  it('createNullInput() is an Input with nothing attached (SPEC-002 §3.4)', () => {
    const input = createNullInput();
    expect(input).toBeInstanceOf(Input);
    expect(() => {
      input.beginFrame(DT);
      input.endFrame();
      input.releaseAll();
      input.dispose();
    }).not.toThrow();
  });

  it('pins the tunables the touch layout and the drivers share', () => {
    expect(DEAD_ZONE).toBe(0.15);
    expect(TAP_SLOP_PX).toBe(12);
    expect(MOVE_ZONE_FRACTION).toBe(0.45);
    expect(FLIGHT_STEER_FRACTION).toBe(0.6);
    expect(FLOAT_DRIFT).toBe(1.6);
    expect(TOUCH_BUTTON_PX).toBe(56);
    expect(JOYSTICK_RADIUS_PX).toBeGreaterThan(0);
  });
});

describe('edge semantics (AC-2)', () => {
  it('a press and release inside one frame yields both edges, with down false', () => {
    const input = new Input();
    input.pressAction('fire', 'keyboard');
    input.releaseAction('fire', 'keyboard');

    input.beginFrame(DT);
    const fire = input.state.buttons.fire;
    expect(fire.justPressed).toBe(true);
    expect(fire.justReleased).toBe(true);
    expect(fire.down).toBe(false);

    input.endFrame();
    input.beginFrame(DT);
    expect(fire.justPressed).toBe(false);
    expect(fire.justReleased).toBe(false);
  });

  it('endFrame clears the edges while the hold survives', () => {
    const input = new Input();
    input.pressAction('interact', 'keyboard');
    input.beginFrame(DT);
    expect(input.state.buttons.interact.justPressed).toBe(true);
    input.endFrame();
    expect(input.state.buttons.interact.justPressed).toBe(false);
    expect(input.state.buttons.interact.down).toBe(true);
  });

  // A frame whose accumulator held less than one step runs no update at all,
  // so nothing in gameplay ever saw the edges it published. Roughly one frame
  // in five is such a frame at 60 Hz, and clearing there swallowed that share
  // of every discrete tap (E to open a terminal, a throttle notch, pause).
  it('a frame that ran no update step carries its edges to the next frame', () => {
    const input = new Input();
    const interact = input.state.buttons.interact;
    input.pressAction('interact', 'keyboard');
    input.releaseAction('interact', 'keyboard');

    input.beginFrame(DT);
    expect(interact.justPressed).toBe(true);
    input.endFrame(false); // no step ran: nothing consumed the pair

    input.beginFrame(DT);
    expect(interact.justPressed).toBe(true);
    expect(interact.justReleased).toBe(true);
    expect(interact.down).toBe(false);

    // …and exactly once: the frame that did step clears them for good.
    input.endFrame(true);
    input.beginFrame(DT);
    expect(interact.justPressed).toBe(false);
    expect(interact.justReleased).toBe(false);
  });

  it('carries across a run of zero-step frames without duplicating the press', () => {
    const input = new Input();
    const fire = input.state.buttons.fire;
    input.pressAction('fire', 'keyboard');

    let published = 0;
    for (let frame = 0; frame < 4; frame++) {
      input.beginFrame(DT);
      if (fire.justPressed) published++;
      input.endFrame(false);
    }
    expect(published).toBe(4); // still pending on every one of them

    input.beginFrame(DT);
    expect(fire.justPressed).toBe(true);
    input.endFrame(true);
    input.beginFrame(DT);
    expect(fire.justPressed).toBe(false);
    expect(fire.down).toBe(true);
  });

  it('a zero-step frame does not resurrect an edge an earlier frame consumed', () => {
    const input = new Input();
    const pause = input.state.buttons.pause;
    input.pressAction('pause', 'keyboard');
    input.beginFrame(DT);
    expect(pause.justPressed).toBe(true);
    input.endFrame(true);

    input.beginFrame(DT);
    expect(pause.justPressed).toBe(false);
    input.endFrame(false);
    input.beginFrame(DT);
    expect(pause.justPressed).toBe(false);
  });
});

describe('heldFor (AC-3)', () => {
  it('accumulates the dt given to beginFrame and resets on release', () => {
    const input = new Input();
    const button = input.state.buttons.throttleUp;
    input.pressAction('throttleUp', 'keyboard');

    input.beginFrame(0.5);
    expect(button.heldFor).toBe(0.5);
    input.endFrame();
    input.beginFrame(0.25);
    expect(button.heldFor).toBe(0.75);

    input.endFrame();
    input.releaseAction('throttleUp', 'keyboard');
    input.beginFrame(0.25);
    expect(button.heldFor).toBe(0);
  });
});

describe('sources (AC-22)', () => {
  it('down holds while any source holds, and only the last release is an edge', () => {
    const input = new Input();
    const fire = input.state.buttons.fire;
    input.pressAction('fire', 'keyboard');
    input.pressAction('fire', 'touch');
    input.beginFrame(DT);
    expect(fire.down).toBe(true);
    expect(fire.justPressed).toBe(true);

    input.endFrame();
    input.releaseAction('fire', 'keyboard');
    input.beginFrame(DT);
    expect(fire.down).toBe(true);
    expect(fire.justReleased).toBe(false);

    input.endFrame();
    input.releaseAction('fire', 'touch');
    input.beginFrame(DT);
    expect(fire.down).toBe(false);
    expect(fire.justReleased).toBe(true);
  });

  it('a second press from the same source is not a second edge', () => {
    const input = new Input();
    input.pressAction('fire', 'keyboard');
    input.beginFrame(DT);
    input.endFrame();
    input.pressAction('fire', 'keyboard');
    input.beginFrame(DT);
    expect(input.state.buttons.fire.justPressed).toBe(false);
    expect(input.state.buttons.fire.down).toBe(true);
  });
});

describe('move shaping (AC-8, AC-9)', () => {
  it('normalises a diagonal to length 1', () => {
    const input = new Input();
    input.setMove(1, 1, 'keyboard');
    const move = input.state.move;
    expect(Math.hypot(move.x, move.y)).toBeCloseTo(1, 10);
    expect(move.x).toBeCloseTo(move.y, 10);
  });

  it('leaves a straight axis at full deflection', () => {
    const input = new Input();
    input.setMove(1, 0, 'keyboard');
    expect(input.state.move.x).toBeCloseTo(1, 10);
    expect(input.state.move.y).toBe(0);
  });

  it('drops joystick input inside the 0.15 dead zone', () => {
    const input = new Input();
    input.setMove(0.1, 0.05, 'touch');
    expect(input.state.move).toEqual({ x: 0, y: 0 });
    // SPEC-036 §4.7 moved full speed in to 0.6 of the radius, so a stick past
    // the dead zone but short of it is the partial deflection this reads.
    input.setMove(0.4, 0, 'touch');
    expect(input.state.move.x).toBeGreaterThan(0);
    expect(input.state.move.x).toBeLessThan(1);
  });
});

describe('the touch stick response (SPEC-036 §4.7)', () => {
  it('reads 0 inside the dead zone and 1 from 60 % of the radius', () => {
    expect(TOUCH_FULL_TRAVEL).toBe(0.6);
    const out = { x: 9, y: 9 };
    // 8 px of a 56 px stick is 0.14 of it: inside the dead zone.
    shapeTouchStick(8 / JOYSTICK_RADIUS_PX, 0, out);
    expect(out).toEqual({ x: 0, y: 0 });
    shapeTouchStick(0.14, 0, out);
    expect(out).toEqual({ x: 0, y: 0 });
    // 34 px is 0.61: full speed.
    shapeTouchStick(34 / JOYSTICK_RADIUS_PX, 0, out);
    expect(out.x).toBeCloseTo(1, 10);
    shapeTouchStick(0, -0.61, out);
    expect(out.y).toBeCloseTo(-1, 10);
    expect(out.x).toBeCloseTo(0, 10);
    // Linear in between: halfway from the dead zone to 0.6 reads a half.
    shapeTouchStick(0.375, 0, out);
    expect(out.x).toBeCloseTo(0.5, 10);
    // Past full travel it stays a unit vector, along the thumb's direction.
    shapeTouchStick(0.8, 0.8, out);
    expect(Math.hypot(out.x, out.y)).toBeCloseTo(1, 10);
    expect(out.x).toBeCloseTo(out.y, 10);
  });

  it('shapes only the touch source with it; the keyboard keeps its own curve', () => {
    const input = new Input();
    input.setMove(0.375, 0, 'touch');
    expect(input.state.move.x).toBeCloseTo(0.5, 10);
    input.setMove(0, 0, 'touch');
    // The keyboard is unchanged: a digital axis is full deflection.
    input.setMove(1, 0, 'keyboard');
    expect(input.state.move.x).toBeCloseTo(1, 10);
  });

  it('sums a touch source and a keyboard source, each shaped, then clamps to 1', () => {
    const input = new Input();
    input.setMove(0, 0.375, 'touch'); // shaped to (0, 0.5)
    input.setMove(1, 0, 'keyboard'); // shaped to (1, 0)
    const move = input.state.move;
    expect(Math.hypot(move.x, move.y)).toBeCloseTo(1, 10);
    expect(move.y / move.x).toBeCloseTo(0.5, 10);
    // Opposing halves cancel rather than fight.
    input.setMove(-0.61, 0, 'touch');
    expect(input.state.move.x).toBeCloseTo(0, 10);
    expect(input.state.move.y).toBeCloseTo(0, 10);
  });
});

describe('the boot scheme (SPEC-036 §4.2)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('initialScheme answers touch for a coarse pointer with no hover, keyboard otherwise', () => {
    expect(COARSE_POINTER_QUERY).toBe('(hover: none) and (pointer: coarse)');
    const asked: string[] = [];
    expect(
      initialScheme((query) => {
        asked.push(query);
        return true;
      }),
    ).toBe('touch');
    expect(asked).toEqual([COARSE_POINTER_QUERY]);
    expect(initialScheme(() => false)).toBe('keyboard');
    // node has no matchMedia at all: the keyboard.
    expect(initialScheme()).toBe('keyboard');
    // A probe that throws is no answer either.
    expect(
      initialScheme(() => {
        throw new Error('no media queries here');
      }),
    ).toBe('keyboard');
  });

  it('Input starts on its answer, and announces nothing for the initial value', () => {
    expect(new Input().state.scheme).toBe('keyboard');
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === COARSE_POINTER_QUERY }));
    const bus = fakeBus();
    const input = new Input(null, bus.bus, null);
    expect(input.state.scheme).toBe('touch');
    expect(bus.emitted.filter((entry) => entry.name === 'input:schemeChanged')).toEqual([]);
    // The auto-fire default follows it from the first frame (SPEC-005 AC-18).
    expect(input.state.autoFire).toBe(true);
  });
});

describe('releaseAll (AC-10)', () => {
  it('emits justReleased for every held button, zeroes move and ends the drag', () => {
    const input = new Input();
    input.pressAction('fire', 'keyboard');
    input.pressAction('interact', 'touch');
    input.setMove(1, 0, 'keyboard');
    input.setAimDrag(1, 0, true);
    input.beginFrame(DT);
    input.endFrame();

    input.releaseAll();
    expect(input.state.move).toEqual({ x: 0, y: 0 });
    expect(input.state.aim.dragging).toBe(false);
    expect(input.state.buttons.fire.down).toBe(false);
    expect(input.state.buttons.interact.down).toBe(false);

    input.beginFrame(DT);
    expect(input.state.buttons.fire.justReleased).toBe(true);
    expect(input.state.buttons.interact.justReleased).toBe(true);
    // …and nothing is stuck: the next frame is clean.
    input.endFrame();
    input.beginFrame(DT);
    expect(input.state.buttons.fire.justReleased).toBe(false);
    expect(input.state.move).toEqual({ x: 0, y: 0 });
  });

  it('a scene transition releases everything (E10)', () => {
    const bus = fakeBus();
    const input = new Input(null, bus.bus, null);
    input.pressAction('fire', 'keyboard');
    input.setMove(1, 0, 'keyboard');

    bus.bus.emit('scene:transition', { from: 'surface', to: 'station' });
    expect(input.state.buttons.fire.down).toBe(false);
    expect(input.state.move).toEqual({ x: 0, y: 0 });
    expect(input.gameplayActive).toBe(false);
  });

  it('tracks which scenes are gameplay, for the preventDefault gate (AC-6)', () => {
    const bus = fakeBus();
    const input = new Input(null, bus.bus, null);
    bus.bus.emit('scene:entered', { id: 'surface' });
    expect(input.gameplayActive).toBe(true);
    bus.bus.emit('scene:entered', { id: 'flight' });
    expect(input.gameplayActive).toBe(true);
    bus.bus.emit('scene:entered', { id: 'station' });
    expect(input.gameplayActive).toBe(false);
  });
});

describe('setEnabled (AC-21)', () => {
  it('reads as fully released and does not replay held keys', () => {
    const input = new Input();
    input.pressAction('fire', 'keyboard');
    input.setMove(1, 0, 'keyboard');
    input.beginFrame(DT);
    input.endFrame();

    input.setEnabled(false);
    expect(input.enabled).toBe(false);
    expect(input.state.buttons.fire.down).toBe(false);
    expect(input.state.buttons.fire.heldFor).toBe(0);
    expect(input.state.move).toEqual({ x: 0, y: 0 });

    // Writes are dropped while suspended…
    input.pressAction('interact', 'keyboard');
    input.setMove(1, 1, 'keyboard');
    input.beginFrame(DT);
    expect(input.state.buttons.interact.down).toBe(false);
    expect(input.state.move).toEqual({ x: 0, y: 0 });

    // …and restoring does not resurrect the key that was held.
    input.endFrame();
    input.setEnabled(true);
    input.beginFrame(DT);
    expect(input.state.buttons.fire.down).toBe(false);
    expect(input.state.buttons.fire.justPressed).toBe(false);

    // The player re-presses, and it works again.
    input.pressAction('fire', 'keyboard');
    input.endFrame();
    input.beginFrame(DT);
    expect(input.state.buttons.fire.justPressed).toBe(true);
  });
});

describe('autoFire (AC-18)', () => {
  it('follows the setting and, for touch, the scheme', () => {
    const settings = createSettings();
    const input = new Input(null, null, settings);
    // SPEC-038 §4.7: the store now starts at 'on', so the scheme rule is the
    // stored 'touch' a player chose.
    expect(settings.autoFire).toBe('on');
    expect(input.state.autoFire).toBe(true);
    settings.setAutoFire('touch');
    expect(input.state.autoFire).toBe(false);

    input.setScheme('touch');
    expect(input.state.autoFire).toBe(true);

    settings.setAutoFire('off');
    expect(input.state.autoFire).toBe(false);

    settings.setAutoFire('on');
    input.setScheme('keyboard');
    expect(input.state.autoFire).toBe(true);

    input.setEnabled(false);
    expect(input.state.autoFire).toBe(false);
  });
});

describe('scheme (AC-19, AC-20)', () => {
  it('announces a real change once, on the bus and to its listeners', () => {
    const bus = fakeBus();
    const input = new Input(null, bus.bus, null);
    const seen: string[] = [];
    const off = input.onSchemeChanged((scheme) => void seen.push(scheme));

    input.setScheme('touch');
    input.setScheme('touch');
    expect(input.state.scheme).toBe('touch');
    expect(seen).toEqual(['touch']);
    expect(bus.emitted.filter((e) => e.name === 'input:schemeChanged')).toEqual([
      { name: 'input:schemeChanged', payload: { scheme: 'touch' } },
    ]);

    off();
    input.setScheme('keyboard');
    expect(seen).toEqual(['touch']);
  });
});

describe('aim (AC-13, AC-24)', () => {
  it('converts screen pixels to NDC and raises hasPointer', () => {
    const input = new Input();
    input.setViewport(800, 600);
    expect(input.state.aim.hasPointer).toBe(false);

    input.setAimPointer(800, 0, 'keyboard');
    expect(input.state.aim).toMatchObject({ screenX: 800, screenY: 0, ndcX: 1, ndcY: 1, hasPointer: true });

    input.setAimPointer(400, 300, 'keyboard');
    expect(input.state.aim.ndcX).toBeCloseTo(0, 10);
    expect(input.state.aim.ndcY).toBeCloseTo(0, 10);

    input.setAimPointer(0, 600, 'keyboard');
    expect(input.state.aim.ndcX).toBe(-1);
    expect(input.state.aim.ndcY).toBe(-1);
  });

  it('normalises a drag direction and clears it on release', () => {
    const input = new Input();
    input.setAimDrag(3, 4, true);
    expect(input.state.aim.dragging).toBe(true);
    expect(input.state.aim.dirX).toBeCloseTo(0.6, 10);
    expect(input.state.aim.dirY).toBeCloseTo(0.8, 10);

    input.setAimDrag(0, 0, false);
    expect(input.state.aim).toMatchObject({ dragging: false, dirX: 0, dirY: 0 });
  });
});

describe('flight aim-assist (AC-29)', () => {
  it('blends keyboard steering toward the reticle only when the setting is on', () => {
    const settings = createSettings();
    // SPEC-007 §3 ships the setting on, so the "off" half says so out loud.
    settings.setFlightMouseSteer(false);
    const input = new Input(null, null, settings);
    input.setViewport(800, 600);
    input.setMode('flight');
    input.setAimPointer(800, 300, 'keyboard'); // the reticle at NDC x = 1
    input.setMove(0, 0, 'keyboard');
    expect(input.state.move.x).toBe(0);

    settings.setFlightMouseSteer(true);
    input.setAimPointer(800, 300, 'keyboard');
    expect(input.state.move.x).toBeCloseTo(FLIGHT_AIM_ASSIST, 10);

    // Not on the surface, and not while the player is on touch.
    input.setMode('surface');
    input.setMove(0, 0, 'keyboard');
    expect(input.state.move.x).toBe(0);
  });
});

describe('zoneFor (AC-30)', () => {
  it('splits the width at the move fraction, and mirrors it', () => {
    expect(zoneFor(0, 1000, 'left')).toBe('move');
    expect(zoneFor(449, 1000, 'left')).toBe('move');
    expect(zoneFor(450, 1000, 'left')).toBe('aim');
    expect(zoneFor(999, 1000, 'left')).toBe('aim');

    expect(zoneFor(0, 1000, 'right')).toBe('aim');
    expect(zoneFor(549, 1000, 'right')).toBe('aim');
    expect(zoneFor(550, 1000, 'right')).toBe('move');
    expect(zoneFor(999, 1000, 'right')).toBe('move');
  });

  it('takes the flight split, where the steer zone is 60 % (AC-28)', () => {
    expect(zoneFor(599, 1000, 'left', FLIGHT_STEER_FRACTION)).toBe('move');
    expect(zoneFor(600, 1000, 'left', FLIGHT_STEER_FRACTION)).toBe('aim');
    expect(zoneFor(399, 1000, 'right', FLIGHT_STEER_FRACTION)).toBe('aim');
    expect(zoneFor(400, 1000, 'right', FLIGHT_STEER_FRACTION)).toBe('move');
  });

  it('a zero-width surface has no move zone to speak of', () => {
    expect(zoneFor(0, 0, 'left')).toBe('aim');
  });
});

// ------------------------------------------------------ keyboard and mouse

describe('KEY_BINDINGS (AC-4)', () => {
  it('is the physical-key table of the spec', () => {
    expect(KEY_BINDINGS).toEqual({
      KeyW: 'moveUp',
      ArrowUp: 'moveUp',
      KeyS: 'moveDown',
      ArrowDown: 'moveDown',
      KeyA: 'moveLeft',
      ArrowLeft: 'moveLeft',
      KeyD: 'moveRight',
      ArrowRight: 'moveRight',
      Space: 'fire',
      KeyE: 'interact',
      KeyF: 'interact',
      // SPEC-028 §4.1: the digits switch weapons; Q alone keeps the heal.
      KeyQ: 'useItem',
      Digit1: 'weapon1',
      Digit2: 'weapon2',
      Digit3: 'weapon3',
      KeyR: 'weaponNext',
      KeyG: 'throwItem',
      KeyC: 'useUtility',
      // SPEC-038 §4.1: V dashes (the right mouse button holds it too).
      KeyV: 'dash',
      Escape: 'pause',
      KeyP: 'pause',
      KeyM: 'map',
      KeyT: 'track',
      ShiftLeft: 'throttleUp',
      // SPEC-034 §4.16: X took Ctrl's place; Ctrl+W closes a browser tab.
      KeyX: 'throttleDown',
      Backquote: 'debug',
    });
    expect(KEY_BINDINGS['ControlLeft']).toBeUndefined();
  });
});

// ------------------------------------------------------------------ wheel

describe('the mouse wheel (SPEC-028 §4.1)', () => {
  function wheelHarness(): Harness & { at: (ms: number) => void } {
    let clock = 0;
    const win = fakeTarget();
    const doc = fakeTarget();
    const canvas = fakeTarget({
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    });
    const input = new Input();
    const driver = new KeyboardMouseDriver(input, {
      win: win.target,
      doc: doc.target,
      canvas: canvas.target as unknown as HTMLCanvasElement,
      now: () => clock,
    });
    return { input, driver, win, doc, canvas, at: (ms: number) => void (clock = ms) };
  }

  function wheelEvent(deltaY: number): { deltaY: number; prevented: boolean; preventDefault(): void } {
    const event = {
      deltaY,
      prevented: false,
      preventDefault(): void {
        event.prevented = true;
      },
    };
    return event;
  }

  it('a notch presses weaponNext (down) or weaponPrev (up) on the surface', () => {
    const h = wheelHarness();
    h.input.setMode('surface');
    h.canvas.fire('wheel', wheelEvent(120));
    h.input.beginFrame(DT);
    expect(h.input.state.buttons.weaponNext.justPressed).toBe(true);
    expect(h.input.state.buttons.weaponNext.justReleased).toBe(true);
    h.input.endFrame();

    h.at(200);
    h.canvas.fire('wheel', wheelEvent(-120));
    h.input.beginFrame(DT);
    expect(h.input.state.buttons.weaponPrev.justPressed).toBe(true);
    expect(h.input.state.buttons.weaponNext.justPressed).toBe(false);
  });

  it('drops notches closer than 120 ms apart', () => {
    const h = wheelHarness();
    h.input.setMode('surface');
    h.canvas.fire('wheel', wheelEvent(120));
    h.input.beginFrame(DT);
    expect(h.input.state.buttons.weaponNext.justPressed).toBe(true);
    h.input.endFrame();

    h.at(119);
    h.canvas.fire('wheel', wheelEvent(120));
    h.input.beginFrame(DT);
    expect(h.input.state.buttons.weaponNext.justPressed).toBe(false);
    h.input.endFrame();

    h.at(120);
    h.canvas.fire('wheel', wheelEvent(120));
    h.input.beginFrame(DT);
    expect(h.input.state.buttons.weaponNext.justPressed).toBe(true);
  });

  it('drives the throttle in flight mode instead', () => {
    const h = wheelHarness();
    h.input.setMode('flight');
    h.canvas.fire('wheel', wheelEvent(-120));
    h.input.beginFrame(DT);
    expect(h.input.state.buttons.throttleUp.justPressed).toBe(true);
    expect(h.input.state.buttons.weaponPrev.justPressed).toBe(false);
    h.input.endFrame();

    h.at(500);
    h.canvas.fire('wheel', wheelEvent(120));
    h.input.beginFrame(DT);
    expect(h.input.state.buttons.throttleDown.justPressed).toBe(true);
    expect(h.input.state.buttons.weaponNext.justPressed).toBe(false);
  });

  it('prevents the page scroll only during gameplay, and never while suspended', () => {
    const h = wheelHarness();
    const inMenu = wheelEvent(120);
    h.canvas.fire('wheel', inMenu);
    expect(inMenu.prevented).toBe(false);

    h.at(500);
    h.input.setGameplayActive(true);
    const inGame = wheelEvent(120);
    h.canvas.fire('wheel', inGame);
    expect(inGame.prevented).toBe(true);
    h.input.beginFrame(DT);
    expect(h.input.state.buttons.weaponNext.justPressed).toBe(true);
    h.input.endFrame();

    h.at(1000);
    h.input.setEnabled(false);
    const suspended = wheelEvent(120);
    h.canvas.fire('wheel', suspended);
    expect(suspended.prevented).toBe(false);
    h.input.setEnabled(true);
    h.input.beginFrame(DT);
    expect(h.input.state.buttons.weaponNext.justPressed).toBe(false);
  });
});

describe('KeyboardMouseDriver', () => {
  it('maps every bound action key through to the state (AC-4)', () => {
    const { input, win } = harness();
    for (const [code, action] of Object.entries(KEY_BINDINGS)) {
      if (action.startsWith('move')) continue;
      win.fire('keydown', keyEvent(code));
      input.beginFrame(DT);
      expect(input.state.buttons[action as 'fire'].down, code).toBe(true);
      input.endFrame();
      win.fire('keyup', keyEvent(code));
      input.beginFrame(DT);
      expect(input.state.buttons[action as 'fire'].down, code).toBe(false);
      input.endFrame();
    }
  });

  it('normalises diagonal keyboard movement (AC-8)', () => {
    const { input, win } = harness();
    win.fire('keydown', keyEvent('KeyW'));
    win.fire('keydown', keyEvent('KeyD'));
    const move = input.state.move;
    expect(Math.hypot(move.x, move.y)).toBeCloseTo(1, 10);
    expect(move.x).toBeCloseTo(move.y, 10);

    win.fire('keyup', keyEvent('KeyD'));
    expect(input.state.move.x).toBe(0);
    expect(input.state.move.y).toBeCloseTo(1, 10);

    // The opposite arrow cancels it, rather than fighting it.
    win.fire('keydown', keyEvent('ArrowDown'));
    expect(input.state.move).toEqual({ x: 0, y: 0 });
  });

  it('ignores auto-repeat (AC-5)', () => {
    const { input, win } = harness();
    win.fire('keydown', keyEvent('Space'));
    input.beginFrame(DT);
    input.endFrame();
    win.fire('keydown', keyEvent('Space', { repeat: true }));
    input.beginFrame(DT);
    expect(input.state.buttons.fire.justPressed).toBe(false);
    expect(input.state.buttons.fire.down).toBe(true);
  });

  it('prevents bound keys only during gameplay, and never unbound ones (AC-6)', () => {
    const { input, win } = harness();

    const inMenu = keyEvent('Space');
    win.fire('keydown', inMenu);
    expect(inMenu.prevented).toBe(false); // no gameplay scene yet

    input.setGameplayActive(true);
    const inGame = keyEvent('KeyE');
    win.fire('keydown', inGame);
    expect(inGame.prevented).toBe(true);

    const unbound = keyEvent('KeyZ');
    win.fire('keydown', unbound);
    expect(unbound.prevented).toBe(false); // browser shortcuts keep working

    // A suspended input stops swallowing keys (AC-21).
    input.setEnabled(false);
    const suspended = keyEvent('KeyE');
    win.fire('keydown', suspended);
    expect(suspended.prevented).toBe(false);
  });

  it('ignores keys typed into an editable element (AC-7)', () => {
    const { input, win } = harness();
    input.setGameplayActive(true);
    const typed = keyEvent('Space', { target: { tagName: 'INPUT' } });
    win.fire('keydown', typed);
    expect(typed.prevented).toBe(false);
    expect(input.state.buttons.fire.down).toBe(false);

    const inEditor = keyEvent('KeyW', { target: { isContentEditable: true } });
    win.fire('keydown', inEditor);
    expect(input.state.move).toEqual({ x: 0, y: 0 });
  });

  it('maps mouse button 0 to fire and button 2 to dash (AC-23, SPEC-038 §4.1)', () => {
    const { input, canvas, win } = harness();
    canvas.fire('pointerdown', pointerEvent({ button: 0 }));
    expect(input.state.buttons.fire.down).toBe(true);

    // SPEC-038 ends AC-23's reservation: button 2 holds `dash`, and nothing else.
    canvas.fire('pointerdown', pointerEvent({ button: 2 }));
    input.beginFrame(DT);
    expect(input.state.buttons.dash.down).toBe(true);
    expect(input.state.buttons.dash.justPressed).toBe(true);
    for (const action of ACTIONS) {
      if (action === 'fire' || action === 'dash') continue;
      expect(input.state.buttons[action].down, action).toBe(false);
    }
    input.endFrame();
    // V and the button share the one holder set: letting go of one keeps it held.
    win.fire('keydown', keyEvent('KeyV'));
    win.fire('pointerup', pointerEvent({ button: 2 }));
    expect(input.state.buttons.dash.down).toBe(true);
    win.fire('keyup', keyEvent('KeyV'));
    expect(input.state.buttons.dash.down).toBe(false);
    // A cancelled mouse pointer lets go of the dash as it does of fire.
    canvas.fire('pointerdown', pointerEvent({ button: 2 }));
    win.fire('pointercancel', pointerEvent({}));
    expect(input.state.buttons.dash.down).toBe(false);
    const menu = keyEvent('');
    canvas.fire('contextmenu', menu);
    expect(menu.prevented).toBe(true);
  });

  it('keeps fire held while either the key or the mouse holds it (AC-22)', () => {
    const { input, win, canvas } = harness();
    win.fire('keydown', keyEvent('Space'));
    canvas.fire('pointerdown', pointerEvent({ button: 0 }));
    win.fire('keyup', keyEvent('Space'));
    expect(input.state.buttons.fire.down).toBe(true);
    win.fire('pointerup', pointerEvent({ button: 0 }));
    expect(input.state.buttons.fire.down).toBe(false);
  });

  it('updates aim and its NDC on every pointer move (AC-24)', () => {
    const { input, win } = harness();
    expect(input.viewport).toEqual({ width: 800, height: 600 });
    win.fire('pointermove', pointerEvent({ clientX: 800, clientY: 0 }));
    expect(input.state.aim).toMatchObject({ screenX: 800, screenY: 0, ndcX: 1, ndcY: 1, hasPointer: true });
  });

  it('a touch or pen move sets the scheme and never the hover aim (SPEC-036 §4.1)', () => {
    for (const pointerType of ['touch', 'pen'] as const) {
      const { input, win } = harness();
      win.fire('pointermove', pointerEvent({ pointerType, clientX: 400, clientY: 300 }));
      expect(input.state.scheme, pointerType).toBe('touch');
      expect(input.state.aim, pointerType).toMatchObject({ screenX: 0, screenY: 0, ndcX: 0, ndcY: 0, hasPointer: false });
    }
    // A mouse move sets both, as before.
    const { input, win } = harness();
    win.fire('pointermove', pointerEvent({ pointerType: 'touch', clientX: 400, clientY: 300 }));
    win.fire('pointermove', pointerEvent({ pointerType: 'mouse', clientX: 800, clientY: 0 }));
    expect(input.state.scheme).toBe('keyboard');
    expect(input.state.aim).toMatchObject({ screenX: 800, screenY: 0, ndcX: 1, ndcY: 1, hasPointer: true });
    // …and a later finger leaves the mouse's aim where the mouse put it.
    win.fire('pointermove', pointerEvent({ pointerType: 'touch', clientX: 10, clientY: 10 }));
    expect(input.state.aim).toMatchObject({ screenX: 800, screenY: 0, ndcX: 1, ndcY: 1, hasPointer: true });
  });

  it('every press sets the scheme from its pointerType, in the capture phase (SPEC-036 §4.2)', () => {
    const win = fakeTarget();
    const captured: string[] = [];
    const recording = {
      addEventListener(type: string, handler: (event: unknown) => void, capture?: boolean): void {
        if (capture === true) captured.push(type);
        win.target.addEventListener(type, handler as EventListener);
      },
      removeEventListener(type: string, handler: (event: unknown) => void): void {
        win.target.removeEventListener(type, handler as EventListener);
      },
    };
    const input = new Input();
    new KeyboardMouseDriver(input, { win: recording as unknown as EventTarget, doc: null, canvas: null });
    expect(captured).toEqual(['pointerdown']);
    // A press anywhere — a DOM control, not the canvas — counts.
    win.fire('pointerdown', pointerEvent({ pointerType: 'touch' }));
    expect(input.state.scheme).toBe('touch');
    win.fire('pointerdown', pointerEvent({ pointerType: 'mouse' }));
    expect(input.state.scheme).toBe('keyboard');
    win.fire('pointerdown', pointerEvent({ pointerType: 'pen' }));
    expect(input.state.scheme).toBe('touch');
    // It only reads the press: no action is held by it.
    for (const action of ACTIONS) expect(input.state.buttons[action].down, action).toBe(false);
  });

  it('a cancelled mouse pointer drops mouse:0 alone; a cancelled finger is the touch layer\'s (SPEC-036 §4.7)', () => {
    const { input, win, canvas } = harness();
    win.fire('keydown', keyEvent('KeyW'));
    win.fire('keydown', keyEvent('KeyE'));
    canvas.fire('pointerdown', pointerEvent({ pointerType: 'mouse', button: 0 }));
    expect(input.state.buttons.fire.down).toBe(true);

    // A touch or pen cancel releases nothing here.
    win.fire('pointercancel', pointerEvent({ pointerType: 'touch' }));
    win.fire('pointercancel', pointerEvent({ pointerType: 'pen' }));
    expect(input.state.buttons.fire.down).toBe(true);
    expect(input.state.buttons.interact.down).toBe(true);
    expect(input.state.move.y).toBeCloseTo(1, 10);

    // The mouse cancel drops its own holder, and only that.
    win.fire('pointercancel', pointerEvent({ pointerType: 'mouse' }));
    expect(input.state.buttons.fire.down).toBe(false);
    expect(input.state.buttons.interact.down).toBe(true);
    expect(input.state.move.y).toBeCloseTo(1, 10);

    // Space held alongside the mouse keeps fire held through a mouse cancel.
    win.fire('keydown', keyEvent('Space'));
    canvas.fire('pointerdown', pointerEvent({ pointerType: 'mouse', button: 0 }));
    win.fire('pointercancel', pointerEvent({ pointerType: 'mouse' }));
    expect(input.state.buttons.fire.down).toBe(true);
  });

  it('switches the scheme to the last-used device (AC-19)', () => {
    const { input, win } = harness();
    win.fire('pointermove', pointerEvent({ pointerType: 'touch' }));
    expect(input.state.scheme).toBe('touch');
    win.fire('pointermove', pointerEvent({ pointerType: 'pen' }));
    expect(input.state.scheme).toBe('touch');
    win.fire('keydown', keyEvent('KeyZ')); // any key, bound or not
    expect(input.state.scheme).toBe('keyboard');
    win.fire('pointermove', pointerEvent({ pointerType: 'touch' }));
    expect(input.state.scheme).toBe('touch');
    win.fire('pointermove', pointerEvent({ pointerType: 'mouse' }));
    expect(input.state.scheme).toBe('keyboard');
  });

  it('releases everything on blur and on a hidden tab (AC-10, E10)', () => {
    // SPEC-036 §4.7: a `pointercancel` no longer drops everything — the case
    // above pins what it releases now.
    for (const drop of ['blur', 'visibilitychange'] as const) {
      const { input, win, doc } = harness();
      win.fire('keydown', keyEvent('KeyW'));
      win.fire('keydown', keyEvent('Space'));
      expect(input.state.move.y).toBeCloseTo(1, 10);

      if (drop === 'visibilitychange') {
        doc.hidden = true;
        doc.fire('visibilitychange', {});
      } else {
        win.fire(drop, {});
      }
      expect(input.state.move, drop).toEqual({ x: 0, y: 0 });
      expect(input.state.buttons.fire.down, drop).toBe(false);

      // The key the player is no longer holding must not come back with the
      // next key-up either.
      win.fire('keyup', keyEvent('KeyW'));
      expect(input.state.move, drop).toEqual({ x: 0, y: 0 });
    }
  });

  it('a visible tab is not a release', () => {
    const { input, win, doc } = harness();
    win.fire('keydown', keyEvent('Space'));
    doc.hidden = false;
    doc.fire('visibilitychange', {});
    expect(input.state.buttons.fire.down).toBe(true);
  });

  it('prevents the pinch gesture that would zoom the page (AC-26)', () => {
    const { doc } = harness();
    const gesture = keyEvent('');
    doc.fire('gesturestart', gesture);
    expect(gesture.prevented).toBe(true);
  });

  it('dispose() removes every listener it added (AC-32)', () => {
    const { input, win, doc, canvas } = harness();
    expect(win.listeners + doc.listeners + canvas.listeners).toBeGreaterThan(0);
    input.dispose();
    expect(win.listeners).toBe(0);
    expect(doc.listeners).toBe(0);
    expect(canvas.listeners).toBe(0);
  });

  it('dispose() also drops the bus subscriptions (AC-32)', () => {
    const bus = fakeBus();
    const input = new Input(null, bus.bus, null);
    expect(bus.subscriptions).toBeGreaterThan(0);
    input.dispose();
    expect(bus.subscriptions).toBe(0);
  });
});
