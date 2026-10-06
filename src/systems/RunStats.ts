// Run statistics (SPEC-047 §4.5) — pure: no `three`, no DOM, no clock. Nothing
// recorded a run's deaths, kills or last fall before this; the counts now live
// in `save.meta.stats`, ride the next autosave like everything else the scene
// mutates, and are what the next instance inherits (SPEC-058).
//
// Only the surface and the flight scenes subscribe, so the station, the menu
// and the SPEC-016 harness leave every count at zero. Nothing else writes the
// counts: a Recall to pad, an `enemy:dismissed` and a mission's completion are
// not on the bus slice below at all. `recoveries` is SPEC-057's: the scene
// emits `remains:recovered` only for a recovery that took a unit (§4.4).
import type { GameEvents } from '@/core/Events';
import { STAT_CEILING, type RunStats, type Save } from '@/core/Save';
import type { PlanetId } from '@/data/index';

/** The slice of the event bus `watchRunStats` needs (a structural port, SPEC-004 D-7). */
export interface RunStatsBus {
  on<K extends 'enemy:killed' | 'boss:defeated' | 'player:died' | 'remains:recovered'>(
    name: K,
    handler: (payload: GameEvents[K]) => void,
    owner: object,
  ): () => void;
}

/** 47-h: a count at `STAT_CEILING` stays there. */
function bump(value: number): number {
  return Math.min(STAT_CEILING, value + 1);
}

/** §2: enough to place a body, and it keeps the save small. */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** `kills + 1`, and `elites + 1` when the kill was an elite. 47-g: a replay's kill counts too. */
export function recordKill(stats: RunStats, elite: boolean): void {
  stats.kills = bump(stats.kills);
  if (elite) stats.elites = bump(stats.elites);
}

export function recordBoss(stats: RunStats): void {
  stats.bosses = bump(stats.bosses);
}

/** SPEC-057 §4.4: `recoveries + 1`, once per recovery that took at least one unit. */
export function recordRecovery(stats: RunStats): void {
  stats.recoveries = bump(stats.recoveries);
}

/**
 * `deaths + 1`. With a planet and a point — a surface death — that planet's
 * `lastDeath` moves to the point, rounded to 0.1 m. 47-f: a flight death has
 * neither, and leaves `lastDeath` alone.
 */
export function recordDeath(stats: RunStats, planet: PlanetId | null, at: { x: number; z: number } | null): void {
  stats.deaths = bump(stats.deaths);
  if (planet === null || at === null) return;
  stats.lastDeath[planet] = { x: round1(at.x), z: round1(at.z) };
}

/**
 * Subscribes `save.meta.stats` to the bus for one scene. `where()` answers at a
 * surface death (null in flight). Returns the release function.
 *
 * The stats object is read at each event rather than captured, so whatever the
 * save holds when the event lands is what counts.
 */
export function watchRunStats(
  bus: RunStatsBus,
  save: Save,
  owner: object,
  where: () => { planet: PlanetId; x: number; z: number } | null,
): () => void {
  const releases = [
    bus.on('enemy:killed', ({ elite }) => recordKill(save.meta.stats, elite), owner),
    bus.on('boss:defeated', () => recordBoss(save.meta.stats), owner),
    bus.on('remains:recovered', () => recordRecovery(save.meta.stats), owner),
    bus.on(
      'player:died',
      () => {
        const point = where();
        recordDeath(save.meta.stats, point?.planet ?? null, point);
      },
      owner,
    ),
  ];
  return () => {
    for (const release of releases.splice(0)) release();
  };
}
