// Shelter rules (SPEC-030 §4.5) — pure: no `three`, no DOM, no clock. The
// scene computes "inside" from these each fixed step; the enemy brains read
// the constants through `systems/EnemyAi.ts`.
import type { LayoutShelter } from '@/systems/Layout';

/** §4.5: the interior ellipse is inset by this much — the doorway is outside. */
export const SHELTER_INSET = 0.3;
/** §4.6: a hidden player is acquired only inside this radius, line clear. */
export const HIDDEN_DETECT_RADIUS = 5;
/** §4.6: an aggroed enemy with no line for this long drops the track. */
export const LOSE_TRACK_SECONDS = 3;
/** §4.5: firing reveals the player for this long. */
export const REVEAL_AFTER_SHOT = 1.5;
/** D-5: the cosmetic dampening of the storm overlay and view intensity inside. */
export const STORM_SHELTER_FACTOR = 0.25;

/**
 * §4.5: the first shelter whose inset interior ellipse contains (x, z), or
 * `null`. The point is transformed into the shelter's frame (rotated by
 * −angle) and tested against `(u / (rx − inset))² + (v / (rz − inset))² ≤ 1`
 * — a player standing in the doorway counts as outside (30-h).
 */
export function shelterAt(shelters: readonly LayoutShelter[], x: number, z: number): LayoutShelter | null {
  for (const shelter of shelters) {
    const dx = x - shelter.x;
    const dz = z - shelter.z;
    const cos = Math.cos(-shelter.angle);
    const sin = Math.sin(-shelter.angle);
    const u = dx * cos - dz * sin;
    const v = dx * sin + dz * cos;
    const rx = shelter.rx - SHELTER_INSET;
    const rz = shelter.rz - SHELTER_INSET;
    if ((u / rx) ** 2 + (v / rz) ** 2 <= 1) return shelter;
  }
  return null;
}
