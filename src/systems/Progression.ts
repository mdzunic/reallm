// XP, levels and tokens (SPEC-010 §4.1). The curve is the one PLAN §7 locks —
// `xpToNext(L) = 100 + 50·L`, 25 tokens a level, cap 30 — and it lives here as
// three pure functions plus a small class that owns the *transitions*: what a
// level grants, in which order, and what the rest of the game hears about it.
//
// Three properties the rest of the economy leans on:
//   - a level-up is immediate (E20): tokens and the max-HP delta are applied
//     before `player:leveledUp` is delivered, and the player-facing part of it
//     is a `ui:toast`. Nothing here opens a modal or waits for an answer, so a
//     level that lands mid-fight cannot stop the fight;
//   - XP past the cap accumulates and does nothing (10-d), so a save that has
//     been ground out at 30 still carries a truthful total;
//   - everything a purchase needs from progression is `tokens`, `spendTokens`
//     and `addTokens`, which is why `Economy` takes this class rather than
//     reaching into the save for the balance itself.
//
// The max-HP delta comes from `maxHp` in `core/Save.ts` — SPEC-011 owns the real
// `computePlayerStats` and that function is its placeholder (SPEC-007 §4.1).
// Recomputing it here would be a second copy of a formula this spec does not own.
//
// Pure: no `three`, no DOM, no `Math.random` (SPEC-001 §4, §7).
import type { EmitArgs, GameEvents } from '@/core/Events';
import { log } from '@/core/Log';
import { maxHp, type SaveV1 } from '@/core/Save';
import { TUNING } from '@/data/index';

/**
 * The slice of the bus SPEC-010 emits through. A structural port rather than
 * the concrete `EventBus`, for the reason `SaveEvents` is one (SPEC-004 D-7):
 * a scene holds `GameServices.events`, which is itself a port, and a test hands
 * over an object literal — which no class with `#private` fields can satisfy.
 * `EventBus<GameEvents>`, the type SPEC-010 §3 names, satisfies this.
 */
export interface EventSink {
  emit<K extends keyof GameEvents>(name: K, ...args: EmitArgs<K>): void;
}

/** PLAN §7: the ladder stops at 30; XP beyond it is stored and inert (10-d). */
export const LEVEL_CAP = TUNING.LEVEL_CAP;
/** PLAN §4: every level is worth this many tokens, whatever produced the XP. */
export const TOKENS_PER_LEVEL = TUNING.TOKENS_PER_LEVEL;

/** E20: the level-up is a toast, never a modal. The text is shared with the UI. */
export function levelUpText(level: number, tokens: number): string {
  return `Level ${level} — +${tokens} tokens`;
}

/** XP needed to go from `level` to `level + 1` (§4.1). */
export function xpToNext(level: number): number {
  return TUNING.XP_BASE + TUNING.XP_PER_LEVEL * level;
}

/**
 * XP to reach `level` from L1: `Σ_{k=1}^{L−1} (100 + 50k)` (§4.1). Written as
 * the closed form — `k(k−1)` is always even, so it stays exact in floats — and
 * pinned at L2 150, L5 900, L10 3,150, L15 6,650, L20 11,400, L30 24,650.
 */
export function cumulativeXp(level: number): number {
  const target = Math.floor(level);
  if (!Number.isFinite(target) || target <= 1) return 0;
  return TUNING.XP_BASE * (target - 1) + (TUNING.XP_PER_LEVEL * target * (target - 1)) / 2;
}

/** The level a total of `xp` buys, capped at `LEVEL_CAP` (§4.1). */
export function levelForXp(xp: number): number {
  if (!Number.isFinite(xp) || xp <= 0) return 1;
  let level = 1;
  while (level < LEVEL_CAP && xp >= cumulativeXp(level + 1)) level += 1;
  return level;
}

export class Progression {
  readonly #save: SaveV1;
  readonly #events: EventSink;

  constructor(save: SaveV1, events: EventSink) {
    this.#save = save;
    this.#events = events;
  }

  get level(): number {
    return this.#save.player.level;
  }

  get tokens(): number {
    return this.#save.player.tokens;
  }

  /**
   * §4.1. Raises the level while the total clears the next threshold, granting
   * 25 tokens and the max-HP delta *per level* before that level's
   * `player:leveledUp` goes out. Emission order is `player:xp`, then per level
   * `tokens:changed` → `player:leveledUp` → `ui:toast`, so a listener on any of
   * the three reads a save that already carries the grant.
   */
  addXp(amount: number, reason: string): { levelsGained: number } {
    const gain = Math.floor(amount);
    if (!Number.isFinite(gain) || gain <= 0) return { levelsGained: 0 };
    const player = this.#save.player;
    player.xp += gain;
    this.#events.emit('player:xp', { amount: gain, total: player.xp });

    let levelsGained = 0;
    while (player.level < LEVEL_CAP && player.xp >= cumulativeXp(player.level + 1)) {
      const before = maxHp(player.classId, player.attributes, player.level);
      player.level += 1;
      // E20: the whole grant lands before anything is told about it.
      player.hp += maxHp(player.classId, player.attributes, player.level) - before;
      player.tokens += TOKENS_PER_LEVEL;
      levelsGained += 1;
      this.#events.emit('tokens:changed', { delta: TOKENS_PER_LEVEL, total: player.tokens, reason: 'level' });
      this.#events.emit('player:leveledUp', { level: player.level, tokens: TOKENS_PER_LEVEL });
      this.#events.emit('ui:toast', { kind: 'good', text: levelUpText(player.level, TOKENS_PER_LEVEL) });
      log.debug('progression', `level ${player.level} from ${reason}`);
    }
    // 10-d: at the cap the XP is kept and nothing else happens.
    return { levelsGained };
  }

  addTokens(amount: number, reason: string): void {
    const delta = Math.floor(amount);
    if (!Number.isFinite(delta) || delta <= 0) return;
    this.#save.player.tokens += delta;
    this.#events.emit('tokens:changed', { delta, total: this.#save.player.tokens, reason });
  }

  /** False when the balance is short; the save is untouched in that case. */
  spendTokens(amount: number, reason: string): boolean {
    const cost = Math.floor(amount);
    if (!Number.isFinite(cost) || cost < 0) return false;
    if (cost === 0) return true;
    if (this.#save.player.tokens < cost) return false;
    this.#save.player.tokens -= cost;
    this.#events.emit('tokens:changed', { delta: -cost, total: this.#save.player.tokens, reason });
    return true;
  }
}
