// SPEC-012 — the press-edge sampler that makes `justPressed` safe under the
// fixed-step loop. The regression this file pins: a frame that runs two update
// steps (every frame at the 30 fps phone floor) must not let one press act
// twice — the round-2 review traced exactly that double-fire opening and then
// closing the pad terminal before a single render, and consuming two
// stimpacks per tap.
import { describe, expect, it } from 'vitest';
import { Input } from '@/core/Input';
import { PressEdges } from '@/core/PressEdges';

/** `Game.#frame` in miniature: begin, N steps, end — one loop frame id each. */
class Harness {
  readonly input = new Input();
  readonly edges = new PressEdges();
  #frame = 0;

  frame(steps: number, read: () => void = () => {}): void {
    this.input.beginFrame(1 / 30);
    for (let i = 0; i < steps; i++) {
      this.edges.beginStep(this.input.state.buttons, this.#frame);
      read();
    }
    this.input.endFrame();
    this.#frame++;
  }
}

describe('PressEdges', () => {
  it('fires a press on exactly one step of a two-step frame (the 30 fps trace)', () => {
    const h = new Harness();
    h.input.pressAction('interact', 'keyboard');

    let fired = 0;
    h.frame(2, () => {
      if (h.edges.pressed('interact')) fired++;
    });
    expect(fired).toBe(1);
  });

  it('a terminal toggle driven through the sampler survives any step count', () => {
    const h = new Harness();
    let open = false;
    const toggle = (): void => {
      if (h.edges.pressed('interact')) open = !open;
    };

    // Press on a two-step frame: net open, not open-then-closed.
    h.input.pressAction('interact', 'keyboard');
    h.frame(2, toggle);
    expect(open).toBe(true);

    // Held across the next frame: no new edge, stays open.
    h.frame(3, toggle);
    expect(open).toBe(true);

    // Release, then a fresh press on another two-step frame: net closed.
    h.input.releaseAction('interact', 'keyboard');
    h.frame(2, toggle);
    h.input.pressAction('interact', 'keyboard');
    h.frame(2, toggle);
    expect(open).toBe(false);
  });

  it('one press per latch even when the consumer skips reads (a prompt that comes and goes)', () => {
    const h = new Harness();

    // A press the scene never asks about — the central bookkeeping still ages it.
    h.input.pressAction('useItem', 'keyboard');
    h.frame(2);
    h.input.releaseAction('useItem', 'keyboard');
    h.frame(1);

    // The next press must fire exactly once.
    let fired = 0;
    h.input.pressAction('useItem', 'keyboard');
    h.frame(2, () => {
      if (h.edges.pressed('useItem')) fired++;
    });
    expect(fired).toBe(1);
  });

  it('a release landing on a zero-step frame does not swallow the next press', () => {
    const h = new Harness();

    let fired = 0;
    const read = (): void => {
      if (h.edges.pressed('fire')) fired++;
    };
    h.input.pressAction('fire', 'keyboard');
    h.frame(1, read);
    h.input.releaseAction('fire', 'keyboard');
    h.frame(0, read); // the release edge lands on a stepless frame
    h.input.pressAction('fire', 'keyboard');
    h.frame(2, read);
    expect(fired).toBe(2);
  });

  it('independent actions latch independently in the same frame', () => {
    const h = new Harness();
    h.input.pressAction('interact', 'keyboard');
    h.input.pressAction('map', 'touch');

    const seen: string[] = [];
    h.frame(2, () => {
      if (h.edges.pressed('interact')) seen.push('interact');
      if (h.edges.pressed('map')) seen.push('map');
    });
    expect(seen).toEqual(['interact', 'map']);
  });
});
