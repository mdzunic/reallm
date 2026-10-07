// One placed hazard (SPEC-068 §3, PLAN R28): a trap or a helper on the surface
// plane. The list is fixed for a landing — built once from the layout seed by
// `systems/Hazards.ts`, never pooled, never saved (E131) — so a view may keep
// its index. Plain data; `systems/Hazards.ts` writes it, `views/HazardView.ts`
// reads it.
import type { HazardDef, HazardId } from '@/data/hazards';

/**
 * - `idle`: a vent between eruptions, a mine armed, a helper standing;
 * - `warn`: a vent charging, a mine's or a volatile's fuse burning;
 * - `falling`: a toppler on its way down;
 * - `spent`: a mine or a volatile that burst, a toppler that fell (its stump stays).
 */
export type HazardState = 'idle' | 'warn' | 'falling' | 'spent';

export interface HazardEntity {
  readonly id: HazardId;
  readonly def: HazardDef;
  readonly x: number;
  readonly z: number;
  /** The prop's turn about Y, radians — the view's only (its circle is round). */
  readonly yaw: number;
  /** 0.9–1.1, the view's only. */
  readonly scale: number;
  /** Placed inside a boss arena (helpers only). */
  readonly arena: boolean;
  state: HazardState;
  /** World time the warning (or the fall) started, and when it lands. */
  startAt: number;
  hitAt: number;
  /** A vent's next eruption. */
  nextAt: number;
  /** World time it last landed; −∞ before. The view's plume, flash and dust read it. */
  burstAt: number;
  /** A toppler's fall direction (unit), set when it is set off. */
  dirX: number;
  dirZ: number;
}
