// systems/Interactables (SPEC-054 §3, §6.1): the circle the player stands in
// decides the prompt and the `interact` press — the nearest wins, kind order
// breaks a tie, and outside every circle there is nothing.
import { describe, expect, it } from 'vitest';
import { nearestInteractable, type Interactable, type InteractKind } from '@/systems/Interactables';

function thing(kind: InteractKind, id: string, x: number, z: number, radius = 1.5): Interactable {
  return { kind, id, x, z, radius };
}

describe('nearestInteractable (SPEC-054 §4.1)', () => {
  it('the nearest circle that holds the point wins', () => {
    const cacheA = thing('cache', 'cinder4_loose_a', 0, 0, 2);
    const vault = thing('vault', 'cinder4_vault', 3, 0, 2);
    const list = [cacheA, vault];
    expect(nearestInteractable(list, 1, 0)).toBe(cacheA);
    expect(nearestInteractable(list, 2, 0)).toBe(vault);
    // Inside only the farther circle's reach: a big circle still holds it.
    const big = thing('exit', 'exit', 10, 0, 9);
    expect(nearestInteractable([cacheA, big], 1.9, 0)).toBe(cacheA);
    expect(nearestInteractable([cacheA, big], 2.1, 0)).toBe(big);
  });

  it('the rim counts as inside', () => {
    const pad = thing('pad', 'pad', 0, 0, 6);
    expect(nearestInteractable([pad], 6, 0)).toBe(pad);
    expect(nearestInteractable([pad], 6.01, 0)).toBeNull();
  });

  it('on a tie, the kind listed first wins, whatever the list order', () => {
    const cache = thing('cache', 'cinder4_loose_b', 4, 4);
    const descent = thing('descent', 'descent', 4, 4);
    expect(nearestInteractable([cache, descent], 4.5, 4)).toBe(descent);
    expect(nearestInteractable([descent, cache], 4.5, 4)).toBe(descent);
    // The same distance from two different centres ties too.
    const panel = thing('panel', 'panel', -1, 0);
    const mirror = thing('mirror', 'mirror', 1, 0);
    expect(nearestInteractable([panel, mirror], 0, 0)).toBe(mirror);
    const pad = thing('pad', 'pad', 0, 1);
    expect(nearestInteractable([panel, mirror, pad], 0, 0)).toBe(pad);
  });

  it('the kind order is pad, descent, exit, cache, vault, relic, mirror, panel, and SPEC-058’s body last', () => {
    const order: InteractKind[] = ['pad', 'descent', 'exit', 'cache', 'vault', 'relic', 'mirror', 'panel', 'body'];
    for (let a = 0; a < order.length; a++) {
      for (let b = a + 1; b < order.length; b++) {
        const first = thing(order[a] as InteractKind, 'a', 0, 0);
        const second = thing(order[b] as InteractKind, 'b', 0, 0);
        expect(nearestInteractable([second, first], 0.5, 0)).toBe(first);
      }
    }
  });

  it('outside every circle, or with none, is null', () => {
    const list = [thing('pad', 'pad', 0, 0, 6), thing('descent', 'descent', 40, 0)];
    expect(nearestInteractable(list, 20, 0)).toBeNull();
    expect(nearestInteractable(list, 40, 1.6)).toBeNull();
    expect(nearestInteractable([], 0, 0)).toBeNull();
  });
});
