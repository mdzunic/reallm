// Escort followers (SPEC-009 §4.8). An `escort` objective walks one of these
// from a POI to another; if it dies the stage restarts (E13), which is why it
// has HP at all.
//
// One follower ships: `c3_m2` is the only escort in the campaign (PLAN §6).
// `model` names the probe of `SURFACE_SHARED_ASSETS` (SPEC-019 §4.8), loaded
// lazily with the per-planet drop; the procedural probe stays the fallback
// when the file is missing or fails to load (19-l).
//
// Data modules are plain objects: no imports but other data, no functions
// (SPEC-001 §4, §8).
import type { ModelId } from '@/data/assets';

export interface FollowerDef<Id extends string = string> {
  readonly id: Id;
  readonly name: string;
  readonly hp: number;
  readonly speed: number;
  readonly radius: number;
  /** How far behind the player it trails, in metres. */
  readonly followDistance: number;
  readonly model: ModelId | 'procedural';
}

export const FOLLOWERS = {
  science_probe: {
    id: 'science_probe',
    name: 'Science Probe',
    hp: 200,
    speed: 5.5,
    radius: 0.6,
    followDistance: 3,
    model: 'probe',
  },
} as const satisfies Record<string, FollowerDef>;

export type FollowerId = keyof typeof FOLLOWERS;
export type Follower = FollowerDef<FollowerId>;
