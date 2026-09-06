// `SceneParams` is a compile-time contract (SPEC-003 §3): the params a scene
// gets are decided by its id. The assertions here are the `@ts-expect-error`
// markers — `npm run typecheck` fails if any of these calls ever stops being an
// error, because an unused `@ts-expect-error` is itself an error.
import { describe, expect, it } from 'vitest';
import type { SceneManager } from '@/core/StateMachine';
import type { PlanetId } from '@/data/ids';

function compileTimeContract(manager: SceneManager, planet: PlanetId): void {
  // @ts-expect-error surface needs `firstLanding` as well as `planet` (AC-91)
  void manager.go('surface', { planet });
  // @ts-expect-error flight takes a `destination`, not a `planet` (AC-92)
  void manager.go('flight', { planet });
  // @ts-expect-error creation takes a save slot, and 3 is not one
  void manager.go('creation', { slot: 3 });
  // @ts-expect-error there is no such scene
  void manager.go('credits', {});

  // …and the calls the machine does accept.
  void manager.go('surface', { planet, firstLanding: true });
  void manager.go('flight', { destination: planet });
  void manager.go('menu', { reason: 'quit' });
  void manager.go('station', { arrivedFrom: planet });
  void manager.go('starmap', undefined);
}

describe('SceneParams', () => {
  it('is enforced at compile time (AC-91, AC-92)', () => {
    expect(typeof compileTimeContract).toBe('function');
  });
});
