// SPEC-034 §4.6, §6.1 — the surface's hold, as the pure decision behind it.
//
// The review's `modal.test.ts`: a modal dialogue disarms the player — no
// movement, no aim, no heal, no fire — and the world kept running behind it. The
// Queen's twelve summoned drones went on attacking through the lines her death
// plays, and reading a story beat in a fight was a way to be killed. The step now
// holds for a modal line and the verdict choice exactly as it already held for
// the full-screen map, and `surfaceHoldReason` is the decision it reads.
import { describe, expect, it } from 'vitest';
import { surfaceHoldReason, type SurfaceHoldState } from '@/systems/UiHelpers';
import { stripComments } from '../architecture/source';

const RAW = import.meta.glob<string>('../../src/**/*.ts', { query: '?raw', import: 'default', eager: true });
const SOURCES: Record<string, string> = Object.fromEntries(
  Object.entries(RAW).map(([file, source]) => [file, stripComments(source)]),
);

const RUNNING: SurfaceHoldState = { beats: 0, rotate: false, ui: 0, modal: 0 };

describe('surfaceHoldReason (SPEC-034 §4.6)', () => {
  it('runs with nothing open', () => {
    expect(surfaceHoldReason(RUNNING)).toBeNull();
  });

  it('holds for a modal line or the verdict choice', () => {
    expect(surfaceHoldReason({ ...RUNNING, modal: 1 })).toBe('modal');
    // Two at once — a `next` chain hands one modal job to the next — still one hold.
    expect(surfaceHoldReason({ ...RUNNING, modal: 2 })).toBe('modal');
  });

  it('keeps the two holds that came before it, in their order', () => {
    // SPEC-023 §4.4's story beat outranks the map, which outranks a line: a
    // film or a reveal owns the screen outright.
    expect(surfaceHoldReason({ ...RUNNING, beats: 1, ui: 1, modal: 1 })).toBe('beat');
    expect(surfaceHoldReason({ ...RUNNING, beats: 0, ui: 1, modal: 1 })).toBe('ui');
    expect(surfaceHoldReason({ ...RUNNING, beats: 1, ui: 0, modal: 0 })).toBe('beat');
    expect(surfaceHoldReason({ ...RUNNING, beats: 0, ui: 1, modal: 0 })).toBe('ui');
  });

  it('holds for the rotate block, between a beat and the map (SPEC-036 §4.3)', () => {
    expect(surfaceHoldReason({ ...RUNNING, rotate: true })).toBe('rotate');
    expect(surfaceHoldReason({ beats: 1, rotate: true, ui: 1, modal: 1 })).toBe('beat');
    expect(surfaceHoldReason({ beats: 0, rotate: true, ui: 1, modal: 1 })).toBe('rotate');
  });

  it('resumes the moment the line closes', () => {
    const state: SurfaceHoldState = { beats: 0, rotate: false, ui: 0, modal: 1 };
    expect(surfaceHoldReason(state)).toBe('modal');
    state.modal = 0;
    expect(surfaceHoldReason(state)).toBeNull();
  });
});

describe("the surface step obeys it (SPEC-034 §4.6)", () => {
  const surface = () => SOURCES['../../src/scenes/Surface.ts'] as string;

  it('returns before combat.update while a modal line is open', () => {
    const source = surface();
    const hold = source.indexOf('if (this.#modalOpen > 0) {');
    const combat = source.indexOf('combat.update(dt, input,');
    expect(hold, 'the modal hold in onUpdate').toBeGreaterThan(-1);
    expect(combat).toBeGreaterThan(-1);
    // The hold is upstream of combat, and it returns rather than skipping a part.
    expect(hold).toBeLessThan(combat);
    const block = source.slice(hold, combat);
    expect(block).toContain('return;');
    // …and upstream of the spawn, weather, mission, pickup and node passes too.
    for (const call of [
      'this.#updateWeather(world, dt)',
      'missions.update(dt, this.#missionContext(world))',
      'spawn.update(dt, world.player, this.#frustumXZ, true)',
      'pickups.update(dt, world.player, world.stats.pickupRadius)',
      'this.#nodes?.update(dt, world.player)',
      'this.#updateGuidance(world, dt)',
    ]) {
      const at = source.indexOf(call);
      expect(at, call).toBeGreaterThan(hold);
    }
  });

  it("the death overlay's clock does not run while held", () => {
    const source = surface();
    // `#deathTick` sits *after* the modal return, so a held line does not run
    // the respawn countdown out from under the player.
    expect(source.indexOf('if (this.#modalOpen > 0) {')).toBeLessThan(source.indexOf('this.#deathTick(world, dt)'));
  });

  it('publishes the hold as sceneInfo.held', () => {
    expect(surface()).toContain("info['held'] = this.#holdReason() === null ? 0 : 1;");
    // SPEC-036 §4.3: the rotate block is one of the reasons, in its place.
    expect(surface()).toContain(
      'surfaceHoldReason({ beats: this.#holds, rotate: this.#rotateBlocked(), ui: this.#uiHolds, modal: this.#modalOpen })',
    );
  });

  it('returns before movement and combat while the rotate block is up (SPEC-036 §4.3)', () => {
    const source = surface();
    const hold = source.indexOf('if (this.#rotateBlocked()) {');
    const move = source.indexOf('this.#movePlayer(world, dt)');
    const combat = source.indexOf('combat.update(dt, input,');
    expect(hold, 'the rotate hold in onUpdate').toBeGreaterThan(-1);
    expect(hold).toBeLessThan(move);
    expect(hold).toBeLessThan(combat);
    // …after the beat's own branch, before the map's.
    expect(source.indexOf('if (this.#holds > 0) {')).toBeLessThan(hold);
    expect(hold).toBeLessThan(source.indexOf('if (this.#uiHolds > 0) {'));
    expect(source.slice(hold, move)).toContain('return;');
  });
});
