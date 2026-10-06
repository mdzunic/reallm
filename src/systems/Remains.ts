// Remains (SPEC-057) — pure: no `three`, no DOM, no clock. A surface death on
// normal or hard still takes E4's share of the hold (`applyDeathPenalty`), but
// what it takes now stays where the salvager fell: one set of remains in
// `save.progress.remains`, recovered by walking back to it and forfeited by the
// next surface death. Two unrecovered deaths cost exactly what two deaths cost
// before this spec — the remains can only give back.
//
// The scene owns when each of these runs (§4.1, §4.4); this module owns where
// the remains lie, what the bookkeeping writes, and the words the tag uses.
import type { LineageEntry, Remains, Save } from '@/core/Save';
import { RESOURCE_IDS, type PlanetId, type ResourceId } from '@/data/index';
import type { Economy } from '@/systems/Economy';
import type { ObstacleGrid } from '@/systems/Layout';
import { instanceNumber } from '@/systems/StoryContext';

/** §3: a living player this close to the remains recovers them, in metres. */
export const REMAINS_RECOVER_RADIUS = 2;
/** §3: the circle the remains' spot is pushed clear for (placement only — they never collide). */
export const REMAINS_BODY_RADIUS = 0.6;
/** §4.4 (E93): while the player stands inside and some are left, a recovery is tried this often, in seconds. */
export const REMAINS_RETRY_SECONDS = 1;
/** §4.3: the remains lie this far inside `halfSize` — 1 m inside the wall line (`halfSize − WALL_INSET`). */
export const REMAINS_WALL_CLEAR = 3;

/** §4.3: what `placeRemains` reads besides the death point. */
export interface RemainsPlacement {
  /** The surface level's grid. */
  readonly obstacles: ObstacleGrid;
  readonly halfSize: number;
  /** E63's respawn point while a boss stage is active, else null. */
  readonly arenaEntrance: { x: number; z: number } | null;
  /** SPEC-054's descent point when the death happened underground, else null. */
  readonly descent: { x: number; z: number } | null;
}

/**
 * §4.3 (E92): the start point — the descent for a death below, E63's arena
 * entrance during a boss stage, else the death point — pushed clear of the
 * obstacles for a `REMAINS_BODY_RADIUS` circle, then clamped to
 * ±(`halfSize` − 3) on both axes. Writes `out`; never allocates. The same
 * inputs give the same point, so the remains and `stats.lastDeath` agree.
 */
export function placeRemains(death: { x: number; z: number }, where: RemainsPlacement, out: { x: number; z: number }): void {
  const start = where.descent ?? where.arenaEntrance ?? death;
  where.obstacles.resolveCircle(start.x, start.z, REMAINS_BODY_RADIUS, out);
  const limit = where.halfSize - REMAINS_WALL_CLEAR;
  out.x = Math.min(limit, Math.max(-limit, out.x));
  out.z = Math.min(limit, Math.max(-limit, out.z));
}

/** §2: 0.1 m — the precision `stats.lastDeath` keeps (SPEC-047 §2), so the two agree to the digit. */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * §4.1 step 4, E91 — the death's bookkeeping, for a surface death on normal or
 * hard (the scene skips it on casual). Any set already lying anywhere is
 * forfeited, even when this death took nothing (57-a). When `lost` holds a
 * unit, a new set is written at `at` with `restart` = `stats.deaths` — the
 * death already counted (§4.1 step 1); otherwise `progress.remains` is null.
 */
export function dropRemains(
  save: Save,
  planet: PlanetId,
  at: { x: number; z: number },
  lost: Partial<Record<ResourceId, number>>,
): { created: Remains | null; forfeited: Remains | null } {
  const forfeited = save.progress.remains;
  const resources: Partial<Record<ResourceId, number>> = {};
  let held = false;
  for (const resource of RESOURCE_IDS) {
    const amount = Math.floor(lost[resource] ?? 0);
    if (amount <= 0) continue;
    resources[resource] = amount;
    held = true;
  }
  const created: Remains | null = held
    ? { planet, x: round1(at.x), z: round1(at.z), resources, restart: save.meta.stats.deaths }
    : null;
  save.progress.remains = created;
  return { created, forfeited };
}

/** Units the remains hold, all resources together (`sceneInfo.remainsHeld`). */
export function remainsHeld(remains: Remains | null): number {
  if (remains === null) return 0;
  let held = 0;
  for (const resource of RESOURCE_IDS) held += remains.resources[resource] ?? 0;
  return held;
}

/**
 * §4.4 (E93): moves what fits into the hold — each resource through
 * `addResource(resource, n, 'recovered')`, which is charged against the cap,
 * never ships home and never flags `blocked` — and writes what it took into
 * `taken` (every resource, 0 when none). What does not fit stays; a resource
 * at 0 leaves the remains, and once none is left `progress.remains` is null.
 * Returns whether anything was taken. `taken` is the caller's reused record,
 * so a recovery allocates nothing of its own.
 */
export function recoverRemains(
  save: Save,
  economy: Pick<Economy, 'addResource'>,
  taken: Record<ResourceId, number>,
): boolean {
  for (const resource of RESOURCE_IDS) taken[resource] = 0;
  const remains = save.progress.remains;
  if (remains === null) return false;
  let any = false;
  let left = false;
  for (const resource of RESOURCE_IDS) {
    const held = remains.resources[resource] ?? 0;
    if (held <= 0) {
      delete remains.resources[resource];
      continue;
    }
    const { added } = economy.addResource(resource, held, 'recovered');
    taken[resource] = added;
    if (added > 0) any = true;
    if (held - added > 0) {
      remains.resources[resource] = held - added;
      left = true;
    } else {
      delete remains.resources[resource];
    }
  }
  if (!left) save.progress.remains = null;
  return any;
}

/** §4.6: which object the remains are — the pack until the reveal, the body after. */
export type RemainsLook = 'pack' | 'body';

/**
 * §4.6: `body` once `signal_decoded` is set or on `meta.iteration` ≥ 2, else
 * `pack` (PLAN §12 as refined: anomalies stay covered until chapter 4). The
 * scene reads it at entry, so a reveal mid-visit changes it from the next one.
 */
export function remainsLook(save: Save): RemainsLook {
  if ((save.progress.flags as readonly string[]).includes('signal_decoded')) return 'body';
  return save.meta.iteration >= 2 ? 'body' : 'pack';
}

/**
 * §4.6 — the `remains-tag` label: `<Name>'s pack`, or the body's
 * `instance/{instance} · restart <N>`. `look` defaults to the save's own; the
 * scene passes the look it chose at entry, so the tag never outruns the model.
 */
export function remainsTag(save: Save, remains: Remains, look: RemainsLook = remainsLook(save)): string {
  if (look === 'pack') return `${save.player.name}'s pack`;
  return `instance/${instanceNumber(save.meta.iteration)} · restart ${remains.restart}`;
}

/** §4.7: `<n> <resource>` joined with ` · `, in `RESOURCE_IDS` order, zeros skipped — `30 oil · 12 lithium`. */
export function remainsListText(resources: Partial<Record<ResourceId, number>>): string {
  let text = '';
  for (const resource of RESOURCE_IDS) {
    const amount = resources[resource] ?? 0;
    if (amount <= 0) continue;
    text += text === '' ? `${amount} ${resource}` : ` · ${amount} ${resource}`;
  }
  return text;
}

// ------------------------------------------- SPEC-058: the predecessor's body

/** SPEC-058 §4.5: on Cinder-4 with no death there, the body lies this far from the pad toward the player's spawn. */
export const PREDECESSOR_PAD_DISTANCE = 6;
/** SPEC-058 §4.5: the one planet that always shows a body — the first landing's. */
export const PREDECESSOR_ALWAYS: PlanetId = 'cinder4';
/** SPEC-058 §4.5: a player this close to the body is offered `Search the body`, in metres. */
export const PREDECESSOR_SEARCH_RADIUS = 2.5;

/**
 * SPEC-058 §4.5 (58-d, 58-e): where `prior`'s body starts on `planet`, into
 * `out` — its `lastDeath` there, which SPEC-057 already placed at an arena's
 * entrance or a descent; else, on Cinder-4 only, `PREDECESSOR_PAD_DISTANCE`
 * from the pad along the line to the player's spawn. False where it lies
 * nowhere. The scene then pushes the start clear through `placeRemains`.
 */
export function predecessorStart(
  prior: Pick<LineageEntry, 'lastDeath'>,
  planet: PlanetId,
  pad: { x: number; z: number } | null,
  spawn: { x: number; z: number },
  out: { x: number; z: number },
): boolean {
  const death = prior.lastDeath[planet];
  if (death !== undefined) {
    out.x = death.x;
    out.z = death.z;
    return true;
  }
  if (planet !== PREDECESSOR_ALWAYS || pad === null) return false;
  const dx = spawn.x - pad.x;
  const dz = spawn.z - pad.z;
  const length = Math.hypot(dx, dz);
  out.x = pad.x + (length > 1e-6 ? dx / length : 1) * PREDECESSOR_PAD_DISTANCE;
  out.z = pad.z + (length > 1e-6 ? dz / length : 0) * PREDECESSOR_PAD_DISTANCE;
  return true;
}

/** SPEC-058 §4.5: the `predecessor-tag` label — `instance/{prior} · <name>`. */
export function predecessorTag(prior: Pick<LineageEntry, 'iteration' | 'name'>): string {
  return `instance/${instanceNumber(prior.iteration)} · ${prior.name}`;
}
