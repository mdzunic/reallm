// The mission runner (SPEC-013 §4.8; the schema is SPEC-009 §4.7's). One
// instance per gameplay scene, scoped to a `(scene, planet)` pair: only
// missions the player accepted at the station whose def names this scene and
// this planet are live — everything else in `missionsActive` is carried, not
// run (AC-84). SPEC-012's surface scene will construct the same class with
// `scene: 'surface'` and teach it the ground objective kinds; flight needs
// `survive` and `kill`, so those are the two implemented here. An objective
// kind this instance does not know simply never progresses — it can neither
// complete a stage early nor crash a trip.
//
// Three rules the rest of the game leans on:
//   - counters persist in the save (`${stage}:${objectiveIndex}`,
//     SPEC-009 §4.7), but timed objectives restart on entry: a reloaded
//     `survive` starts at 0, a reloaded `kill` keeps its count;
//   - a death resets the *current stage* and the mission stays accepted
//     (E5, 13-g): counters back to zero, `mission:stageReset`, no abandon;
//   - completion pays immediately through `Economy.applyRewards` — before
//     landing (AC-87) — with the replay half-rate when the mission was
//     already in `missionsDone` (SPEC-010 §4.7).
//
// Pure: no `three`, no DOM, no `Math.random` (SPEC-001 §4, §7).
import type { EmitArgs, GameEvents } from '@/core/Events';
import type { SaveV1 } from '@/core/Save';
import { MISSIONS, type MissionDef, type MissionId, type Objective, type PlanetId } from '@/data/index';
import type { Economy } from '@/systems/Economy';

/**
 * The slice of the bus this system needs: emit, plus `on` for `enemy:killed`.
 * Structural (SPEC-004 D-7), so a test hands over an object literal or the
 * real `EventBus` — both satisfy it.
 */
export interface MissionEvents {
  emit<K extends keyof GameEvents>(name: K, ...args: EmitArgs<K>): void;
  on<K extends keyof GameEvents>(name: K, handler: (payload: GameEvents[K]) => void, owner: object): () => void;
}

export interface MissionScope {
  readonly scene: 'surface' | 'flight';
  readonly planet: PlanetId;
}

/** One HUD line: the first incomplete objective of the first live mission. */
export interface ObjectiveLine {
  readonly id: MissionId;
  readonly title: string;
  readonly line: string;
  readonly value: number;
  readonly target: number;
}

/** The save entry a live mission runs against. */
type ActiveEntry = SaveV1['progress']['missionsActive'][number];

function counterKey(stage: number, objective: number): string {
  return `${stage}:${objective}`;
}

/** What an objective needs to be done, for the kinds a counter can measure. */
function targetOf(objective: Objective): number {
  switch (objective.kind) {
    case 'kill':
      return objective.amount;
    case 'survive':
      return objective.seconds;
    case 'scan':
      return objective.count;
    case 'collect':
    case 'deliver':
      return objective.amount;
    default:
      return 1;
  }
}

export class Missions {
  readonly #save: SaveV1;
  readonly #scope: MissionScope;
  readonly #economy: Economy;
  readonly #events: MissionEvents;
  readonly #offKilled: () => void;

  constructor(save: SaveV1, scope: MissionScope, economy: Economy, events: MissionEvents) {
    this.#save = save;
    this.#scope = scope;
    this.#economy = economy;
    this.#events = events;
    // Timed objectives restart on entry (CLAUDE.md): a survive counter loaded
    // from the save is stale by definition — the timer only runs live.
    for (const entry of this.#live()) {
      const def = MISSIONS[entry.id];
      def.stages[entry.stage]?.forEach((objective, index) => {
        if (objective.kind === 'survive') delete entry.counters[counterKey(entry.stage, index)];
      });
    }
    this.#offKilled = events.on('enemy:killed', (payload) => this.#onKilled(payload.enemyId), this);
  }

  /** The accepted missions this scope runs, in acceptance order (AC-84). */
  get active(): readonly MissionId[] {
    return this.#live().map((entry) => entry.id);
  }

  /**
   * Advances every live `survive` objective by `dt`. The caller owns the gate:
   * flight calls this only while the ship is alive, through both cruise and
   * holding (§4.8, AC-88) — the timer is real seconds, not trip progress.
   */
  update(dt: number): void {
    if (!(dt > 0)) return;
    for (const entry of this.#live()) {
      const def = MISSIONS[entry.id];
      const stage = def.stages[entry.stage];
      if (stage === undefined) continue;
      let moved = false;
      stage.forEach((objective, index) => {
        if (objective.kind !== 'survive') return;
        const key = counterKey(entry.stage, index);
        const before = entry.counters[key] ?? 0;
        if (before >= objective.seconds) return;
        const now = Math.min(objective.seconds, before + dt);
        entry.counters[key] = now;
        moved = true;
        // A per-frame float tick is not a HUD event; whole seconds are (§4.8).
        if (Math.floor(now) > Math.floor(before) || now >= objective.seconds) {
          this.#events.emit('mission:progress', {
            id: entry.id,
            stage: entry.stage,
            objective: index,
            value: Math.floor(now),
            target: objective.seconds,
          });
        }
      });
      if (moved) this.#settle(entry);
    }
  }

  /**
   * E5 / 13-g: a recall resets the current stage of every live mission — the
   * counters, never the acceptance. Both the side mission and the main mission
   * come back zeroed and still accepted (AC-103).
   */
  resetStages(reason: 'death' | 'reload'): void {
    for (const entry of this.#live()) {
      const def = MISSIONS[entry.id];
      const stage = def.stages[entry.stage];
      if (stage === undefined) continue;
      stage.forEach((_objective, index) => {
        delete entry.counters[counterKey(entry.stage, index)];
      });
      this.#events.emit('mission:stageReset', { id: entry.id, stage: entry.stage, reason });
    }
  }

  /** The HUD's objective row: first incomplete objective of the first live mission. */
  objective(): ObjectiveLine | null {
    for (const entry of this.#live()) {
      const def = MISSIONS[entry.id];
      const stage = def.stages[entry.stage];
      if (stage === undefined) continue;
      for (const [index, objective] of stage.entries()) {
        const target = targetOf(objective);
        const value = Math.min(target, Math.floor(entry.counters[counterKey(entry.stage, index)] ?? 0));
        if (value >= target) continue;
        return { id: entry.id, title: def.title, line: describe(objective), value, target };
      }
    }
    return null;
  }

  /** The live `survive` objective with the longest requirement, for the HUD hint (AC-89). */
  longestSurvive(): number {
    let longest = 0;
    for (const entry of this.#live()) {
      const stage = MISSIONS[entry.id].stages[entry.stage];
      if (stage === undefined) continue;
      for (const [index, objective] of stage.entries()) {
        if (objective.kind !== 'survive') continue;
        if ((entry.counters[counterKey(entry.stage, index)] ?? 0) >= objective.seconds) continue;
        longest = Math.max(longest, objective.seconds);
      }
    }
    return longest;
  }

  dispose(): void {
    this.#offKilled();
  }

  // ---------------------------------------------------------------- internals

  /** The accepted entries whose def matches this scope. Recomputed, never cached. */
  #live(): ActiveEntry[] {
    return this.#save.progress.missionsActive.filter((entry) => {
      const def: MissionDef | undefined = MISSIONS[entry.id];
      return def !== undefined && def.scene === this.#scope.scene && def.planet === this.#scope.planet;
    });
  }

  /** Kills count only for the enemy an objective names (AC-113). */
  #onKilled(enemyId: GameEvents['enemy:killed']['enemyId']): void {
    for (const entry of this.#live()) {
      const def = MISSIONS[entry.id];
      const stage = def.stages[entry.stage];
      if (stage === undefined) continue;
      let moved = false;
      stage.forEach((objective, index) => {
        if (objective.kind !== 'kill' || objective.enemy !== enemyId) return;
        const key = counterKey(entry.stage, index);
        const before = entry.counters[key] ?? 0;
        if (before >= objective.amount) return;
        entry.counters[key] = before + 1;
        moved = true;
        this.#events.emit('mission:progress', {
          id: entry.id,
          stage: entry.stage,
          objective: index,
          value: before + 1,
          target: objective.amount,
        });
      });
      if (moved) this.#settle(entry);
    }
  }

  /** Advance the stage when every objective in it is done; complete at the end. */
  #settle(entry: ActiveEntry): void {
    const def = MISSIONS[entry.id];
    const stage = def.stages[entry.stage];
    if (stage === undefined) return;
    const done = stage.every((objective, index) => {
      const value = entry.counters[counterKey(entry.stage, index)] ?? 0;
      return value >= targetOf(objective);
    });
    if (!done) return;
    if (entry.stage + 1 < def.stages.length) {
      entry.stage += 1;
      this.#events.emit('mission:stageStarted', { id: entry.id, stage: entry.stage });
      // The freshly-entered stage may be empty in data terms; settle again so a
      // zero-objective stage cannot strand the mission.
      this.#settle(entry);
      return;
    }
    this.#complete(entry, def);
  }

  /** §4.8: rewards land immediately, before any landing (AC-87). */
  #complete(entry: ActiveEntry, def: MissionDef): void {
    const at = this.#save.progress.missionsActive.indexOf(entry);
    if (at >= 0) this.#save.progress.missionsActive.splice(at, 1);
    const doneList = this.#save.progress.missionsDone;
    const replay = (doneList as readonly string[]).includes(def.id);
    if (!replay) doneList.push(def.id as MissionId);
    this.#economy.applyRewards(def, replay);
    this.#events.emit('mission:completed', { id: def.id as MissionId, replay });
  }
}

/** A short player-facing description of one objective. */
function describe(objective: Objective): string {
  switch (objective.kind) {
    case 'kill':
      return `Destroy ${objective.amount}`;
    case 'survive':
      return `Survive ${objective.seconds} s`;
    case 'scan':
      return `Scan ${objective.count}`;
    case 'collect':
      return `Collect ${objective.amount}`;
    case 'deliver':
      return `Deliver ${objective.amount}`;
    case 'reach':
      return 'Reach the marker';
    case 'boss':
      return 'Defeat the boss';
    case 'defend':
      return `Defend for ${objective.seconds} s`;
    case 'escort':
      return 'Escort';
    case 'choice':
      return 'Decide';
  }
}
