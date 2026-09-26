// The service override (SPEC-032 §4.6–§4.7): Earth Command's requisition
// bypass for playtesting. This module holds the pure pieces — the menu's
// key-sequence matcher and the station's top-up — so both are testable in
// node; the menu scene owns the listeners, the station and the menu call
// `applySupplies`, and the setting itself lives in `core/Settings.ts`.
//
// Grants only: nothing here ever lowers a resource, a balance or the hull,
// and nothing touches a mission, a flag, XP or the save's shape (§4.9).
//
// Pure per SPEC-001 §4: no `three`, no DOM, no `Math.random`.
import { cargoCap, type Save } from '@/core/Save';
import { RESOURCE_IDS, type ResourceId } from '@/data/index';
import type { Economy } from '@/systems/Economy';

/** Typed on the main menu, in order, to toggle the mode. */
export const SERVICE_CODE = 'asdf';
/** A gap longer than this between two keys starts the code over. */
export const CODE_IDLE_MS = 2_000;
/** The wallet floor the supplies top up to. */
export const SERVICE_TOKENS = 5_000;

export interface CodeState {
  readonly typed: string;
  readonly at: number;
}

export const EMPTY_CODE: CodeState = { typed: '', at: 0 };

/**
 * Feed one key. Returns the next state and whether the code just completed.
 * Only the longest suffix of what was typed that is still a prefix of
 * `SERVICE_CODE` is kept, so `aasdf` matches and `asxdf` does not; a key
 * after more than `CODE_IDLE_MS` of silence starts from nothing. A match
 * resets the state, so the next toggle needs the whole code again.
 */
export function pushCode(state: CodeState, key: string, now: number): { state: CodeState; matched: boolean } {
  const fresh = state.typed === '' || now - state.at > CODE_IDLE_MS;
  let typed = (fresh ? '' : state.typed) + key.toLowerCase();
  while (typed.length > 0 && !SERVICE_CODE.startsWith(typed)) typed = typed.slice(1);
  if (typed === SERVICE_CODE) return { state: EMPTY_CODE, matched: true };
  return { state: typed === '' ? EMPTY_CODE : { typed, at: now }, matched: false };
}

export interface SuppliesResult {
  /** What each resource was raised by; only the raised ones appear. */
  readonly resources: Partial<Record<ResourceId, number>>;
  /** Tokens granted. */
  readonly tokens: number;
  /** HP restored. */
  readonly hp: number;
}

/**
 * §4.7.2: every resource to `cargoCap(save.ship)`, tokens to at least
 * `SERVICE_TOKENS` and HP to `maxHp(…)` — each through the economy's own
 * grant path, so `resource:collected`, `tokens:changed` and `player:healed`
 * fire and the wallet follows. A value already at or above its target is left
 * alone, with no event (32-i). The caller asks for the autosave.
 */
export function applySupplies(save: Save, economy: Economy): SuppliesResult {
  const cap = cargoCap(save.ship);
  const resources: Partial<Record<ResourceId, number>> = {};
  for (const resource of RESOURCE_IDS) {
    const raise = cap - save.resources[resource];
    if (raise <= 0) continue;
    // `reward` is the grant that ignores the pickup cap; the amount is the
    // exact shortfall, so the hold lands on the cap and never past it.
    const { added } = economy.addResource(resource, raise, 'reward');
    if (added > 0) resources[resource] = added;
  }
  const tokenRaise = Math.max(0, SERVICE_TOKENS - save.player.tokens);
  if (tokenRaise > 0) economy.grantTokens(tokenRaise, 'service');
  const hp = economy.restoreHp();
  return { resources, tokens: tokenRaise, hp };
}
