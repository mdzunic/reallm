// The mission runtime (SPEC-012 §4.7), shared by the surface and flight scenes.
// Pure: no Three, no DOM — progress arrives through the event bus and the
// per-step `MissionContext`, and everything that must survive a reload lives in
// `save.progress.missionsActive` (stage + counters; timers deliberately not,
// E19).
//
// Stages are sequential; the objectives inside one complete in any order.
// Progress is keyed `${stage}:${objectiveIndex}` in the counters record —
// `scan` keeps a distinct-instance bitmask under `${key}:mask` alongside the
// count, which is still a plain number and therefore round-trips the save
// unchanged.
import type { EventBus, GameEvents } from '@/core/Events';
import type { SaveV1 } from '@/core/Save';
import {
  MISSIONS,
  TUNING,
  type EnemyId,
  type FollowerId,
  type MissionDef,
  type MissionId,
  type Objective,
  type PlanetId,
  type PoiId,
  type ResourceId,
  type WaveId,
  type WeatherId,
} from '@/data/index';
import type { Fail, Result, SaveRequester } from '@/systems/Economy';
import type { LayoutPoi } from '@/systems/Layout';

/** The slice of SPEC-010's `Economy` the runtime needs. */
export interface MissionEconomy {
  missingRequirements(reqs: MissionDef['requires']): unknown[];
  applyRewards(mission: MissionDef, replay: boolean): void;
  spendResources(cost: Partial<Record<ResourceId, number>>, reason: string): boolean;
}

export interface MissionState {
  id: MissionId;
  stage: number;
  counters: Record<string, number>;
  timers: Record<string, number>;
  complete: boolean;
}

/**
 * What the scene knows each step. `follower` extends the spec's interface —
 * the escort objective completes on the *follower's* position (§4.7), which no
 * player-relative query can answer.
 */
export interface MissionContext {
  player: { x: number; z: number; alive: boolean };
  poiAt(id: PoiId): LayoutPoi[];
  heldResource(r: ResourceId): number;
  nearPoi(id: PoiId, radius?: number): LayoutPoi | null;
  follower?: { x: number; z: number; alive: boolean } | null;
}

export interface ObjectiveProgress {
  objective: Objective;
  value: number;
  target: number;
  done: boolean;
}

/**
 * One HUD line: the first incomplete objective of the pinned mission. The
 * flight HUD reads this (SPEC-013 §4.8) and the surface HUD phrases the same
 * fields, so the wording lives here rather than in either scene.
 */
export interface ObjectiveLine {
  readonly id: MissionId;
  readonly title: string;
  readonly line: string;
  readonly value: number;
  readonly target: number;
}

type ResetReason = GameEvents['mission:stageReset']['reason'];

/** The objective kinds whose progress is a running timer (E4, E19). */
function isTimed(objective: Objective): boolean {
  return objective.kind === 'survive' || objective.kind === 'defend';
}

function popcount(v: number): number {
  let n = v >>> 0;
  let count = 0;
  while (n !== 0) {
    n &= n - 1;
    count++;
  }
  return count;
}

export class Missions {
  readonly #save: SaveV1;
  readonly #economy: MissionEconomy;
  readonly #events: EventBus<GameEvents>;
  readonly #scene: 'surface' | 'flight';
  readonly #planet: PlanetId;
  readonly #saves: SaveRequester | null;
  readonly #states: MissionState[] = [];
  #pinned: MissionId | null = null;

  constructor(
    save: SaveV1,
    economy: MissionEconomy,
    events: EventBus<GameEvents>,
    scene: 'surface' | 'flight',
    planet: PlanetId,
    saves?: SaveRequester,
  ) {
    this.#save = save;
    this.#economy = economy;
    this.#events = events;
    this.#scene = scene;
    this.#planet = planet;
    this.#saves = saves ?? null;

    // E19: rebuild from the save — counters kept, timers zeroed. A timed stage
    // in flight restarts from its beginning, announced as a reload reset.
    for (const entry of save.progress.missionsActive) {
      const def = MISSIONS[entry.id];
      if (def.planet !== planet || def.scene !== scene) continue;
      const state: MissionState = { id: entry.id, stage: entry.stage, counters: entry.counters, timers: {}, complete: false };
      this.#states.push(state);
      if (this.#pinned === null) this.#pinned = entry.id;
      if ((def.stages[state.stage] ?? []).some(isTimed)) {
        this.#events.emit('mission:stageReset', { id: state.id, stage: state.stage, reason: 'reload' });
      }
    }

    events.on('enemy:killed', (p) => this.#onKill(p.enemyId), this);
    events.on('resource:collected', (p) => this.#onCollect(p.resource, p.amount), this);
    events.on('poi:reached', (p) => this.#onReach(p.poi), this);
    events.on('poi:scanned', (p) => this.#onScan(p.poi, p.instance), this);
    events.on('boss:defeated', (p) => this.#onBoss(p.boss), this);
    events.on('follower:died', () => this.#onFollowerDied(), this);
    events.on('poi:damaged', (p) => {
      if (p.hp <= 0) this.#onPoiDestroyed(p.poi);
    }, this);
    events.on('player:died', () => this.#onPlayerDied(), this);
  }

  /** Releases the bus subscriptions; the scene's `Disposer` calls it. */
  dispose(): void {
    this.#events.releaseOwner(this);
  }

  get active(): MissionState[] {
    return this.#states;
  }

  get pinned(): MissionId | null {
    return this.#pinned;
  }

  // ------------------------------------------------------------- accept flow

  /** §4.7 + 12-j: acceptable here — scene matches, requirements met, not active. */
  available(): MissionDef[] {
    const out: MissionDef[] = [];
    for (const def of Object.values(MISSIONS)) {
      if (def.planet !== this.#planet || def.scene !== this.#scene) continue;
      if (this.#stateOf(def.id as MissionId) !== null) continue;
      if (campaignLocked(this.#save, def)) continue; // E24
      if (this.#economy.missingRequirements(def.requires).length > 0) continue;
      out.push(def);
    }
    return out;
  }

  /** A completed mission may be accepted again; its rewards then pay 50 % (AC-43). */
  isReplay(id: MissionId): boolean {
    return this.#save.progress.missionsDone.includes(id);
  }

  accept(id: MissionId): Result {
    const def = MISSIONS[id];
    if (def.planet !== this.#planet || def.scene !== this.#scene) return fail('not_found');
    if (this.#stateOf(id) !== null) return fail('prerequisite');
    // E24: the campaign's last mission is over for good — the same refusal an
    // unavailable mission gets, since `available()` no longer offers it.
    if (campaignLocked(this.#save, def)) return fail('locked');
    if (this.#economy.missingRequirements(def.requires).length > 0) return fail('locked');
    const entry = { id, stage: 0, counters: {} as Record<string, number> };
    this.#save.progress.missionsActive.push(entry);
    const state: MissionState = { id, stage: 0, counters: entry.counters, timers: {}, complete: false };
    this.#states.push(state);
    if (this.#pinned === null) this.#pinned = id;
    this.#events.emit('mission:accepted', { id });
    this.#events.emit('mission:stageStarted', { id, stage: 0 });
    this.#saves?.request('stage');
    return { ok: true };
  }

  /** §4.7: counters are lost, no penalty. */
  abandon(id: MissionId): void {
    const at = this.#states.findIndex((s) => s.id === id);
    if (at < 0) return;
    this.#states.splice(at, 1);
    this.#dropSaveEntry(id);
    if (this.#pinned === id) this.#pinned = this.#states[0]?.id ?? null;
    this.#events.emit('mission:abandoned', { id });
  }

  pin(id: MissionId): void {
    if (this.#stateOf(id) !== null) this.#pinned = id;
  }

  /** E18: the map key cycles which active mission the HUD pins. */
  cyclePinned(): void {
    if (this.#states.length === 0) return;
    const at = this.#states.findIndex((s) => s.id === this.#pinned);
    this.#pinned = (this.#states[(at + 1) % this.#states.length] as MissionState).id;
  }

  // ---------------------------------------------------------------- queries

  currentObjectives(id: MissionId): ObjectiveProgress[] {
    const state = this.#stateOf(id);
    if (state === null) return [];
    const stage = MISSIONS[id].stages[state.stage] ?? [];
    return stage.map((objective, index) => this.#progressOf(state, objective, index));
  }

  /** For the spawn director's ×3 weighting (E14): undone kill targets. */
  objectiveEnemies(): EnemyId[] {
    const out: EnemyId[] = [];
    for (const state of this.#states) {
      for (const { objective, done } of this.currentObjectives(state.id)) {
        if (objective.kind === 'kill' && !done && !out.includes(objective.enemy)) out.push(objective.enemy);
      }
    }
    return out;
  }

  /** The storm an active survive stage forces on the scene (AC-26). */
  requiredWeather(): { weather: WeatherId; seconds: number } | null {
    for (const state of this.#states) {
      for (const { objective, done } of this.currentObjectives(state.id)) {
        if (objective.kind === 'survive' && objective.weather !== undefined && !done) {
          return { weather: objective.weather, seconds: objective.seconds };
        }
      }
    }
    return null;
  }

  /** The boss a current stage wants; the arena spawns it on entry (§4.7). */
  bossStage(): EnemyId | null {
    for (const state of this.#states) {
      for (const { objective, done } of this.currentObjectives(state.id)) {
        if (objective.kind === 'boss' && !done) return objective.enemy;
      }
    }
    return null;
  }

  /** The defend wave of a current stage, for the scene to start (§4.7). */
  defendStage(): { poi: PoiId; wave: WaveId; seconds: number } | null {
    for (const state of this.#states) {
      for (const { objective, done } of this.currentObjectives(state.id)) {
        if (objective.kind === 'defend' && !done) {
          return { poi: objective.poi, wave: objective.wave, seconds: objective.seconds };
        }
      }
    }
    return null;
  }

  /** The escort leg of a current stage, for the scene's follower (§4.7). */
  escortStage(): { from: PoiId; to: PoiId; follower: FollowerId } | null {
    for (const state of this.#states) {
      for (const { objective, done } of this.currentObjectives(state.id)) {
        if (objective.kind === 'escort' && !done) {
          return { from: objective.from, to: objective.to, follower: objective.follower };
        }
      }
    }
    return null;
  }

  /** The current choice objective's prompt and options, or `null` (§4.7). */
  choiceStage(id: MissionId): Extract<Objective, { kind: 'choice' }> | null {
    for (const { objective, done } of this.currentObjectives(id)) {
      if (objective.kind === 'choice' && !done) return objective;
    }
    return null;
  }

  /**
   * The HUD's objective row: the first incomplete objective, pinned mission
   * first and then the rest in acceptance order (E18). Walks the ring the way
   * `cyclePinned` does, so nothing is allocated to put the pin at the front.
   */
  objective(): ObjectiveLine | null {
    const count = this.#states.length;
    if (count === 0) return null;
    const pinnedAt = this.#states.findIndex((s) => s.id === this.#pinned);
    const start = pinnedAt < 0 ? 0 : pinnedAt;
    for (let n = 0; n < count; n++) {
      const state = this.#states[(start + n) % count] as MissionState;
      for (const { objective, value, target, done } of this.currentObjectives(state.id)) {
        if (done) continue;
        return { id: state.id, title: MISSIONS[state.id].title, line: describe(objective), value: Math.floor(value), target };
      }
    }
    return null;
  }

  /**
   * The longest unfinished `survive` requirement, in seconds. Flight turns it
   * into the throttle hint when the timer cannot fit the remaining trip
   * (SPEC-013 §4.8, AC-89); 0 when nothing live is timed.
   */
  longestSurvive(): number {
    let longest = 0;
    for (const state of this.#states) {
      for (const { objective, done } of this.currentObjectives(state.id)) {
        if (objective.kind !== 'survive' || done) continue;
        longest = Math.max(longest, objective.seconds);
      }
    }
    return longest;
  }

  /**
   * E5 / 13-g: the whole current stage goes back to zero and every mission
   * stays accepted. This is flight's recall rule, and the scene calls it
   * explicitly — the surface's death is E4, which restarts the timed stages
   * and *keeps* the counts, so that path runs through `player:died` instead.
   * The two edge cases genuinely differ; each caller asks for the one it owns.
   */
  resetStages(reason: ResetReason): void {
    for (const state of this.#states) {
      const stage = MISSIONS[state.id].stages[state.stage] ?? [];
      if (stage.length === 0) continue;
      for (let index = 0; index < stage.length; index++) {
        const key = `${state.stage}:${index}`;
        delete state.counters[key];
        delete state.counters[`${key}:mask`]; // a scan's distinct-instance set
        delete state.timers[key];
      }
      this.#events.emit('mission:stageReset', { id: state.id, stage: state.stage, reason });
    }
  }

  // ----------------------------------------------------------------- update

  update(dt: number, ctx: MissionContext): void {
    for (const state of this.#states.slice()) {
      const stage = MISSIONS[state.id].stages[state.stage] ?? [];
      for (let index = 0; index < stage.length; index++) {
        const objective = stage[index] as Objective;
        const key = `${state.stage}:${index}`;
        switch (objective.kind) {
          case 'survive': {
            if (this.#done(state, objective, index)) break;
            if (!ctx.player.alive) break;
            state.timers[key] = (state.timers[key] ?? 0) + dt;
            if ((state.timers[key] as number) >= objective.seconds) {
              this.#markDone(state, index);
            }
            break;
          }
          case 'defend': {
            if (this.#done(state, objective, index)) break;
            state.timers[key] = (state.timers[key] ?? 0) + dt;
            if ((state.timers[key] as number) >= objective.seconds) {
              this.#markDone(state, index);
            }
            break;
          }
          case 'deliver': {
            if (this.#done(state, objective, index)) break;
            if (ctx.nearPoi(objective.poi) === null) break;
            if (ctx.heldResource(objective.resource) < objective.amount) break;
            // E16: atomic — all units or none, never a partial delivery.
            if (!this.#economy.spendResources({ [objective.resource]: objective.amount }, `deliver:${state.id}`)) break;
            this.#events.emit('poi:delivered', { poi: objective.poi, resource: objective.resource, amount: objective.amount });
            this.#markDone(state, index);
            break;
          }
          case 'escort': {
            if (this.#done(state, objective, index)) break;
            const follower = ctx.follower;
            if (follower === undefined || follower === null || !follower.alive) break;
            const to = ctx.poiAt(objective.to)[0];
            if (to === undefined) break;
            if (Math.hypot(follower.x - to.x, follower.z - to.z) <= to.radius) this.#markDone(state, index);
            break;
          }
          default:
            break;
        }
      }
      this.#checkStage(state);
    }
  }

  /**
   * SPEC-024 §4.8, dev builds only: finish the current stage the way the
   * simulation would have. Stage 0 of `c6_m2` is a four-minute defence, and an
   * acceptance run cannot spend four minutes on it per attempt.
   *
   * Every objective of the stage is marked done through `#markDone` and the
   * normal `#checkStage` runs after, so the events, the stage advance, the
   * completion and the rewards are the ones a played stage produces — nothing
   * here is a shortcut *around* the runtime.
   *
   * A `choice` objective is the exception: its flags are its whole point, and
   * marking it done would end the campaign with neither ending flag set (E24).
   * The choice stays the player's, on the modal the scene opens for it.
   */
  debugFinishStage(id: MissionId): void {
    if (!import.meta.env.DEV) return;
    const state = this.#stateOf(id);
    if (state === null || state.complete) return;
    const stage = MISSIONS[id].stages[state.stage] ?? [];
    for (let index = 0; index < stage.length; index++) {
      const objective = stage[index] as Objective;
      if (objective.kind === 'choice' || this.#done(state, objective, index)) continue;
      this.#markDone(state, index);
    }
    this.#checkStage(state);
  }

  /** §4.7: a choice objective completes through this, setting its flags. */
  choose(id: MissionId, optionIndex: number): void {
    const state = this.#stateOf(id);
    if (state === null) return;
    const stage = MISSIONS[id].stages[state.stage] ?? [];
    for (let index = 0; index < stage.length; index++) {
      const objective = stage[index] as Objective;
      if (objective.kind !== 'choice' || this.#done(state, objective, index)) continue;
      const option = objective.options[optionIndex];
      if (option === undefined) return;
      for (const flag of option.flags) {
        if (!this.#save.progress.flags.includes(flag)) {
          this.#save.progress.flags.push(flag);
          this.#events.emit('flag:set', { flag });
        }
      }
      this.#markDone(state, index);
      this.#checkStage(state);
      return;
    }
  }

  // -------------------------------------------------------- event reactions

  #onKill(enemyId: EnemyId): void {
    this.#forEachObjective((state, objective, index) => {
      if (objective.kind !== 'kill' || objective.enemy !== enemyId) return;
      if (this.#done(state, objective, index)) return;
      this.#bump(state, index, 1, objective.amount);
      this.#checkStage(state);
    });
  }

  #onCollect(resource: ResourceId, amount: number): void {
    if (amount <= 0) return; // a fully blocked pickup adds nothing (E3)
    this.#forEachObjective((state, objective, index) => {
      if (objective.kind !== 'collect' || objective.resource !== resource) return;
      if (this.#done(state, objective, index)) return;
      this.#bump(state, index, amount, objective.amount);
      this.#checkStage(state);
    });
  }

  #onReach(poi: PoiId): void {
    this.#forEachObjective((state, objective, index) => {
      if (objective.kind !== 'reach' || objective.poi !== poi) return;
      if (this.#done(state, objective, index)) return;
      this.#markDone(state, index);
      this.#checkStage(state);
    });
  }

  /** §4.7: distinct instances only, kept as a bitmask beside the count. */
  #onScan(poi: PoiId, instance: number): void {
    this.#forEachObjective((state, objective, index) => {
      if (objective.kind !== 'scan' || objective.poi !== poi) return;
      if (this.#done(state, objective, index)) return;
      const key = `${state.stage}:${index}`;
      const mask = (state.counters[`${key}:mask`] ?? 0) | (1 << instance);
      state.counters[`${key}:mask`] = mask;
      const value = Math.min(popcount(mask), objective.count);
      state.counters[key] = value;
      this.#events.emit('mission:progress', { id: state.id, stage: state.stage, objective: index, value, target: objective.count });
      this.#checkStage(state);
    });
  }

  #onBoss(boss: EnemyId): void {
    this.#forEachObjective((state, objective, index) => {
      if (objective.kind !== 'boss' || objective.enemy !== boss) return;
      if (this.#done(state, objective, index)) return;
      this.#markDone(state, index);
      this.#checkStage(state);
    });
  }

  /** E13: the stage restarts; the scene respawns the follower at `from`. */
  #onFollowerDied(): void {
    for (const state of this.#states) {
      const stage = MISSIONS[state.id].stages[state.stage] ?? [];
      if (stage.some((objective) => objective.kind === 'escort')) this.#resetStage(state, 'follower_died');
    }
  }

  /** §4.7 defend: 0 HP restarts the stage — POI HP and wave are scene-side. */
  #onPoiDestroyed(poi: PoiId): void {
    for (const state of this.#states) {
      const stage = MISSIONS[state.id].stages[state.stage] ?? [];
      const guards = stage.some((objective) => objective.kind === 'defend' && objective.poi === poi);
      if (!guards) continue;
      // 12-d: destroyed while the stage is already back at zero (the death
      // reset just ran) — reset once, not twice.
      const key = stage.findIndex((objective) => objective.kind === 'defend');
      if ((state.timers[`${state.stage}:${key}`] ?? 0) === 0) continue;
      this.#resetStage(state, 'poi_destroyed');
    }
  }

  /**
   * E4: timed stages restart; counters stay (§4.8 step 2 routes through here).
   * Surface only — flight emits `player:died` too, but its recall is E5 and
   * the scene drives it through `resetStages('death')`; reacting here as well
   * would reset the stage twice and emit two `mission:stageReset` events.
   */
  #onPlayerDied(): void {
    if (this.#scene !== 'surface') return;
    for (const state of this.#states) {
      const stage = MISSIONS[state.id].stages[state.stage] ?? [];
      if (stage.some(isTimed)) this.#resetStage(state, 'death');
    }
  }

  // -------------------------------------------------------------- internals

  #stateOf(id: MissionId): MissionState | null {
    return this.#states.find((s) => s.id === id) ?? null;
  }

  #forEachObjective(fn: (state: MissionState, objective: Objective, index: number) => void): void {
    for (const state of this.#states.slice()) {
      if (state.complete) continue;
      const stage = MISSIONS[state.id].stages[state.stage] ?? [];
      for (let index = 0; index < stage.length; index++) fn(state, stage[index] as Objective, index);
    }
  }

  #progressOf(state: MissionState, objective: Objective, index: number): ObjectiveProgress {
    const key = `${state.stage}:${index}`;
    let target = 1;
    let value = state.counters[key] ?? 0;
    switch (objective.kind) {
      case 'collect':
      case 'kill':
        target = objective.amount;
        break;
      case 'scan':
        target = objective.count;
        break;
      case 'survive':
      case 'defend':
        target = objective.seconds;
        value = Math.min(objective.seconds, state.timers[key] ?? 0);
        break;
      default:
        break;
    }
    if (objective.kind === 'survive' || objective.kind === 'defend') {
      // A finished timer is recorded as done in the counters, surviving reload.
      if ((state.counters[key] ?? 0) >= 1) value = target;
    }
    return { objective, value, target, done: this.#done(state, objective, index) };
  }

  #done(state: MissionState, objective: Objective, index: number): boolean {
    const key = `${state.stage}:${index}`;
    const value = state.counters[key] ?? 0;
    switch (objective.kind) {
      case 'collect':
      case 'kill':
        return value >= objective.amount;
      case 'scan':
        return value >= objective.count;
      default:
        return value >= 1;
    }
  }

  #bump(state: MissionState, index: number, by: number, target: number): void {
    const key = `${state.stage}:${index}`;
    const value = Math.min(target, (state.counters[key] ?? 0) + by);
    state.counters[key] = value;
    this.#events.emit('mission:progress', { id: state.id, stage: state.stage, objective: index, value, target });
  }

  /** Non-count objectives record done as a 1; timers clear their key. */
  #markDone(state: MissionState, index: number): void {
    const key = `${state.stage}:${index}`;
    state.counters[key] = Math.max(1, state.counters[key] ?? 0);
    const stage = MISSIONS[state.id].stages[state.stage] ?? [];
    const objective = stage[index] as Objective;
    const target = objective.kind === 'survive' || objective.kind === 'defend' ? objective.seconds : 1;
    this.#events.emit('mission:progress', {
      id: state.id,
      stage: state.stage,
      objective: index,
      value: target,
      target,
    });
  }

  #resetStage(state: MissionState, reason: ResetReason): void {
    const stage = MISSIONS[state.id].stages[state.stage] ?? [];
    for (let index = 0; index < stage.length; index++) {
      const objective = stage[index] as Objective;
      if (!isTimed(objective)) continue;
      const key = `${state.stage}:${index}`;
      state.timers[key] = 0;
      if (!this.#done(state, objective, index)) delete state.counters[key];
    }
    this.#events.emit('mission:stageReset', { id: state.id, stage: state.stage, reason });
  }

  #checkStage(state: MissionState): void {
    if (state.complete) return;
    const def = MISSIONS[state.id];
    const stage = def.stages[state.stage] ?? [];
    for (let index = 0; index < stage.length; index++) {
      if (!this.#done(state, stage[index] as Objective, index)) return;
    }
    if (state.stage + 1 < def.stages.length) {
      state.stage += 1;
      state.timers = {};
      this.#syncStage(state);
      this.#events.emit('mission:stageStarted', { id: state.id, stage: state.stage });
      this.#saves?.request('stage');
      return;
    }
    this.#completeMission(state, def);
  }

  #completeMission(state: MissionState, def: MissionDef): void {
    state.complete = true;
    const replay = this.isReplay(state.id);
    const at = this.#states.indexOf(state);
    if (at >= 0) this.#states.splice(at, 1);
    this.#dropSaveEntry(state.id);
    if (!replay) this.#save.progress.missionsDone.push(state.id);
    // Rewards fire after the books close, so a rewarded resource can never
    // count toward the collect objective that just finished (§4.7).
    this.#economy.applyRewards(def, replay);
    if (this.#pinned === state.id) this.#pinned = this.#states[0]?.id ?? null;
    this.#events.emit('mission:completed', { id: state.id, replay });
    this.#saves?.request('mission');
  }

  #syncStage(state: MissionState): void {
    const entry = this.#save.progress.missionsActive.find((e) => e.id === state.id);
    if (entry !== undefined) entry.stage = state.stage;
  }

  #dropSaveEntry(id: MissionId): void {
    const at = this.#save.progress.missionsActive.findIndex((e) => e.id === id);
    if (at >= 0) this.#save.progress.missionsActive.splice(at, 1);
  }
}

/** §4.7: replay pays half; re-exported so the HUD can phrase it. */
export const REPLAY_REWARD_FRACTION = TUNING.REPLAY_REWARD_FRACTION;

/**
 * E24 / SPEC-024 §4.6: the mission that ends the campaign is locked once the
 * campaign is over. The rule is read off the rewards rather than off an id —
 * the mission that grants `campaign_done` is the one that can never run again —
 * so the board (`missionStatus`), the pad terminal (`available()`), the accept
 * path and the tests all ask the same question in one place.
 *
 * Without it a replay could file the other verdict and leave one save holding
 * both `ending_stay` and `ending_escape`.
 */
export function campaignLocked(save: SaveV1, def: MissionDef): boolean {
  if (def.rewards.flags?.includes('campaign_done') !== true) return false;
  return save.progress.flags.includes('campaign_done');
}

const NO_POIS: readonly LayoutPoi[] = Object.freeze([]);

/**
 * What the rail scene hands `update`. Flight has no POIs, no cargo pickups and
 * no follower — only `survive` and `kill` run there (SPEC-013 §4.8) — and its
 * three update calls are already gated on a live ship, so the context is a
 * frozen constant rather than an object built every frame (SPEC-001 §7).
 */
export const FLIGHT_MISSION_CONTEXT: MissionContext = Object.freeze({
  player: Object.freeze({ x: 0, z: 0, alive: true }),
  poiAt: () => NO_POIS as LayoutPoi[],
  heldResource: () => 0,
  nearPoi: () => null,
  follower: null,
});

/** A short player-facing description of one objective, for the HUD row. */
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

function fail(reason: Fail['reason']): Fail {
  return { ok: false, reason };
}
