// The pure half of the UI layer (SPEC-014 §3, §6): every string the panels
// print and every diff the HUD flush runs, as plain functions over the save and
// the content tables. They live under `systems/` rather than `ui/` because the
// architecture rule of SPEC-001 §4 keeps tests on pure code — `tests/ui/`
// exercises this module, and `ui/` renders what it returns.
//
// Nothing here touches the DOM, `three`, or `Math.random`, and nothing mutates
// its inputs except the two mission helpers, which edit the save the way every
// `systems/` class does (SPEC-010's `Economy` is the model).
import type { GameEvents } from '@/core/Events';
import type { Scheme } from '@/core/Input';
import { maxHp, type Save, type SlotSummary } from '@/core/Save';
import type { AutoFireMode, DamageFlashMode } from '@/core/Settings';
import {
  AFFIX_IDS,
  AFFIXES,
  ATTRIBUTE_EFFECTS,
  CLASSES,
  COMPANIONS,
  CONTRACT_LITHIUM,
  CONTRACT_REWARD_FRACTION,
  CONTRACTS,
  DEATH_TIPS,
  ENEMIES,
  FOLLOWERS,
  ITEMS,
  LOOT_TABLES,
  MISSIONS,
  PLANETS,
  PLANET_IDS,
  POI_LABELS,
  RECIPES,
  RESOURCE_IDS,
  SIGNATURE_FALLBACK_LITHIUM,
  TUNING,
  UPGRADES,
  type Attributes,
  type BonusReward,
  type ClassId,
  type CompanionId,
  type ContractId,
  type DamageSource,
  type DeathTipId,
  type Difficulty,
  type EnemyId,
  type ItemId,
  type CompanionEffect,
  type FollowerId,
  type LootEntry,
  type LootTableId,
  type MissionBonus,
  type MissionDef,
  type MissionId,
  type PlanetDef,
  type PlanetId,
  type PoiId,
  type Price,
  type RecipeId,
  type Requirement,
  type ResourceId,
  type ShipSystem,
  type WeatherId,
} from '@/data/index';
import type { EnemyEntity } from '@/entities/Enemy';
import type { PlayerEntity } from '@/entities/Player';
import { LOADOUT_CHAPTERS, RECOMMENDED_LOADOUT, type LoadoutEntry } from '@/systems/Balance';
import { damageReduction, playerDamageMult } from '@/systems/Combat';
import {
  discountTokens,
  missingRequirements,
  ownsItem,
  type DepartResult,
  type Economy,
  type FailReason,
} from '@/systems/Economy';
import type { SkipRefusal } from '@/systems/Flight';
import { weaponDps, type SlotView } from '@/systems/Loadout';
import { campaignLocked, contractFor } from '@/systems/Missions';
import { cumulativeXp, LEVEL_CAP, xpToNext } from '@/systems/Progression';
import type { Class, Item, QuickSlot, WeaponSlot } from '@/data/index';

// The schema-typed views of the content tables: on the `as const` literal types
// an absent optional — a class with no `damageMult` — is not a property at all
// (the same pattern `systems/Economy.ts` uses).
const CLASS_TABLE: Readonly<Record<ClassId, Class>> = CLASSES;
const ITEM_TABLE: Readonly<Record<ItemId, Item>> = ITEMS;
const LOOT_TABLE: Readonly<Record<LootTableId, readonly LootEntry[]>> = LOOT_TABLES;
const PLANET_TABLE: Readonly<Record<PlanetId, PlanetDef>> = PLANETS;

// ---------------------------------------------------------------- formatting

/** `1h 04m` / `12m` — playtime rows, travel times, nothing load-bearing. */
export function formatTime(seconds: number): string {
  const total = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${total}s`;
}

/** `1.15` → `+15%`, `0.85` → `−15%` — passives and effect lines share it. */
function pct(mult: number): string {
  const delta = Math.round((mult - 1) * 100);
  return `${delta >= 0 ? '+' : '−'}${Math.abs(delta)}%`;
}

/**
 * The one line a class card prints under its blurb (AC-14): every effect the
 * passive carries, joined. The numbers come straight off the table, so a
 * retune never leaves the card lying.
 */
export function passiveText(passive: Class['passive']): string {
  const parts: string[] = [];
  if (passive.damageMult !== undefined) parts.push(`${pct(passive.damageMult)} damage`);
  if (passive.maxHpBonus !== undefined) parts.push(`+${passive.maxHpBonus} max HP`);
  // SPEC-039 §4.3: the Engineer's refit discount covers companions too.
  if (passive.refitDiscount !== undefined) parts.push(`−${Math.round(passive.refitDiscount * 100)}% ship and companion prices`);
  if (passive.companionEffectMult !== undefined) parts.push(`${pct(passive.companionEffectMult)} companion effect`);
  if (passive.moveSpeedMult !== undefined) parts.push(`${pct(passive.moveSpeedMult)} move speed`);
  if (passive.pickupRadiusMult !== undefined) parts.push(`${pct(passive.pickupRadiusMult)} pickup radius`);
  if (passive.nodeRadar === true) parts.push('resource radar');
  if (passive.dashCooldownMult !== undefined) parts.push(`${pct(passive.dashCooldownMult)} dash cooldown`);
  return parts.join(' · ');
}

/**
 * SPEC-014 AC-18, SPEC-038 §4.6: the one honest line under each difficulty —
 * the creation toggle and the settings row print the same words, so it lives
 * here rather than in either of them.
 */
export const DIFFICULTY_LINES: Readonly<Record<Difficulty, string>> = {
  normal: 'Normal — the pressure the game was tuned for.',
  casual: 'Casual — softer hits and storms, longer wind-ups, kinder deaths; the story is unchanged.',
  // SPEC-043 §4.4.
  hard: 'Hard — tougher, deadlier hostiles and twice the elites; a death costs a fifth of the hold.',
};

/**
 * One line per occupied slot for the Load list (AC-4): name, class, level,
 * planet, playtime — in the order a player reads them. `Corrupt` and `Empty`
 * match SPEC-007's SavePanel wording; a run parked at the station has no
 * `currentPlanet` and reads as `Station`.
 */
export function slotLine(summary: SlotSummary): string {
  if (summary.corrupt === true) return 'Corrupt';
  if (summary.empty) return 'Empty';
  const cls = summary.classId !== undefined ? CLASS_TABLE[summary.classId].name : '';
  const planet = summary.planet != null ? PLANETS[summary.planet].name : 'Station';
  return `${summary.name ?? ''} · ${cls} · Lv ${summary.level ?? 1} · ${planet} · ${formatTime(summary.playtimeSec ?? 0)}`;
}

/**
 * One human-readable line per `Requirement` kind (§4.3): the mission board's
 * locked rows and the star map's met/unmet list share it. A chapter flag reads
 * as the chapter it gates ("Complete Chapter 2"), because `chapter2_done` is
 * not a phrase a player has ever seen.
 */
export function requirementText(req: Requirement): string {
  switch (req.kind) {
    case 'ship':
      return `Requires: Ship ${UPGRADES[req.system].name.toLowerCase()} tier ${req.tier}`;
    case 'mission':
      return `Complete '${MISSIONS[req.id as MissionId]?.title ?? req.id}'`;
    case 'level':
      return `Requires: Level ${req.level}`;
    case 'flag': {
      const chapter = /^chapter(\d)_done$/.exec(req.flag);
      if (chapter !== null) return `Complete Chapter ${chapter[1]}`;
      return `Requires: ${req.flag.replace(/_/g, ' ')}`;
    }
  }
}

/**
 * `"40 → 34 tokens"` (SPEC-031 §4.12): the base token price and what this save
 * actually pays, via the same `discountTokens` the purchase runs (SPEC-010
 * §4.2), so the label can never disagree with the charge — and every amount
 * carries its unit, because `50` means nothing with four currencies in play.
 * Undiscounted resource costs are appended (`" + 60 lithium"`); a price of
 * nothing at all is `"Free"`.
 */
export function priceText(price: Price, discount: number): string {
  const parts: string[] = [];
  if (price.tokens > 0) {
    const paid = discountTokens(price.tokens, discount);
    parts.push(paid < price.tokens ? `${price.tokens} → ${paid} tokens` : `${price.tokens} tokens`);
  }
  for (const [resource, amount] of Object.entries(price.resources ?? {})) {
    if ((amount ?? 0) > 0) parts.push(`${amount} ${resource}`);
  }
  return parts.length === 0 ? 'Free' : parts.join(' + ');
}

// ------------------------------------------------------- the wallet (SPEC-031)

export interface WalletEntry {
  readonly id: ResourceId;
  readonly value: number;
  readonly cap: number;
  readonly atCap: boolean;
}

export interface WalletModel {
  readonly tokens: number;
  readonly resources: readonly WalletEntry[];
}

/**
 * SPEC-031 §4.11: the cargo cap the wallet strip prints against — the cargo
 * tier's capacity plus the quartermaster's bonus, the same sum
 * `Economy.cargoCap()` charges by, computed purely over the save so the strip
 * needs no `Economy` instance.
 */
function walletCap(save: Save): number {
  let bonus = 0;
  for (const companion of save.companions) {
    // Owned is enough: `Economy.cargoCap()` counts the quartermaster by level
    // alone, so a disabled one still raises the cap the engine clamps by.
    const effect = COMPANIONS[companion.id].levels[companion.level - 1] as CompanionEffect | undefined;
    bonus += effect?.cargoBonus ?? 0;
  }
  return (UPGRADES.cargo.metrics['cargoCap']?.[save.ship.cargo] ?? TUNING.CARGO_BASE) + bonus;
}

/** SPEC-031 §3: what the wallet strip renders — one read of the save, no totals of its own. */
export function walletModel(save: Save): WalletModel {
  const cap = walletCap(save);
  return {
    tokens: save.player.tokens,
    resources: RESOURCE_IDS.map((id) => {
      const value = save.resources[id];
      return { id, value, cap, atCap: value >= cap };
    }),
  };
}

/**
 * SPEC-031 §4.12 / E48: the exact shortfall an unaffordable price leaves —
 * `Need 40 more tokens`, `Need 20 more lithium`, both joined when both are
 * short — or `null` when the price is affordable. The discount is applied
 * before the comparison, exactly as the charge applies it.
 */
export function shortfallText(price: Price, save: Save, discount: number): string | null {
  const parts: string[] = [];
  const paid = discountTokens(price.tokens, discount);
  if (save.player.tokens < paid) parts.push(`Need ${paid - save.player.tokens} more tokens`);
  for (const [resource, amount] of Object.entries(price.resources ?? {})) {
    const held = save.resources[resource as ResourceId];
    if ((amount ?? 0) > held) parts.push(`Need ${(amount ?? 0) - held} more ${resource}`);
  }
  return parts.length === 0 ? null : parts.join(' · ');
}

/**
 * SPEC-031 §4.12: the balance line every confirm sheet carries — one line per
 * currency the price touches, `Tokens 340 → 291`, `Wheat 60 → 30` — the last
 * chance to notice a purchase empties the tank (E1). `''` for `Free`.
 */
export function balanceAfterText(price: Price, save: Save, discount: number): string {
  const lines: string[] = [];
  if (price.tokens > 0) {
    const paid = discountTokens(price.tokens, discount);
    lines.push(`Tokens ${save.player.tokens} → ${save.player.tokens - paid}`);
  }
  for (const [resource, amount] of Object.entries(price.resources ?? {})) {
    if ((amount ?? 0) <= 0) continue;
    const held = save.resources[resource as ResourceId];
    const name = resource.charAt(0).toUpperCase() + resource.slice(1);
    lines.push(`${name} ${held} → ${held - (amount ?? 0)}`);
  }
  return lines.join('\n');
}

/** SPEC-031 §4.16: the cooldown model of a weapon, in words a player reads. */
function cooldownWords(cooldown: Extract<Item, { kind: 'weapon' }>['cooldown']): string {
  switch (cooldown.kind) {
    case 'none':
      return 'No cooldown';
    case 'heat':
      return 'Overheats — locks until it cools';
    case 'charges':
      return `${cooldown.charges} ${cooldown.charges === 1 ? 'charge' : 'charges'}, recharges in ${cooldown.rechargeSeconds} s`;
  }
}

/** SPEC-031 §4.16: a consumable's effect, in words. */
function effectWords(effect: Extract<Item, { kind: 'consumable' }>['effect']): string {
  switch (effect.kind) {
    case 'heal':
      return effect.overSeconds > 0
        ? `Heals ${Math.round(effect.fraction * 100)}% over ${effect.overSeconds} s`
        : `Heals ${Math.round(effect.fraction * 100)}% instantly`;
    case 'hazard_immunity':
      return `Hazard immunity for ${effect.seconds} s`;
    case 'damage_boost':
      return `+${Math.round((effect.mult - 1) * 100)}% damage for ${effect.seconds} s`;
    case 'explosive':
      return `Explosive — ${effect.damage} damage in a ${effect.radius} m blast`;
  }
}

/**
 * SPEC-039 §4.6: the DPS a weapon's stat line prints, rounded off `weaponDps` —
 * `DPS <n>` with no cooldown, `DPS <firing> firing · <sustained> sustained`
 * for a heat weapon, `DPS <sustained> sustained` for a launcher.
 */
export function dpsText(id: ItemId): string {
  const item = ITEM_TABLE[id];
  const dps = weaponDps(id);
  if (item.kind !== 'weapon' || dps === null) return '';
  const firing = Math.round(dps.firing);
  const sustained = Math.round(dps.sustained);
  switch (item.cooldown.kind) {
    case 'none':
      return `DPS ${firing}`;
    case 'heat':
      return `DPS ${firing} firing · ${sustained} sustained`;
    case 'charges':
      return `DPS ${sustained} sustained`;
  }
}

/**
 * SPEC-039 §4.6: the one stat line under a shop gear row's name — a weapon's
 * DPS line and its range, or an armour piece's armor, the damage it takes off
 * and its hazard resist. `''` for a consumable.
 */
export function shopStatText(id: ItemId): string {
  const item = ITEM_TABLE[id];
  if (item.kind === 'weapon') return `${dpsText(id)} · range ${item.range} m`;
  if (item.kind === 'armor') {
    const cut = Math.round(damageReduction(item.armor) * 100);
    return `armor ${item.armor} · −${cut}% damage · hazard ${Math.round(item.hazardResist * 100)}%`;
  }
  return '';
}

/**
 * SPEC-031 §4.16: the gear card's stat block, one line per stat. Weapons carry
 * damage, fire rate, the DPS (SPEC-039 §4.6: `dpsText`), range, projectile
 * speed, pierce and the cooldown model in words; armor its two numbers;
 * consumables the effect and the stack.
 */
export function gearStatLines(id: ItemId): readonly string[] {
  const item = ITEM_TABLE[id];
  if (item.kind === 'weapon') {
    return [
      `Damage ${item.damage}`,
      `Fire rate ${item.fireRate}/s`,
      dpsText(id),
      `Range ${item.range} m`,
      `Projectile speed ${item.projectileSpeed} m/s`,
      `Pierce ${item.pierce}`,
      cooldownWords(item.cooldown),
    ];
  }
  if (item.kind === 'armor') {
    return [`Armor ${item.armor}`, `Hazard resist ${Math.round(item.hazardResist * 100)}%`];
  }
  return [effectWords(item.effect), `Stack of ${item.stack}`];
}

/**
 * Why the Depart button is disabled (§4.4): `""` when it is not, the oil
 * shortfall, or the *first* missing requirement — one line, because the button
 * has room for one and the requirements list next to it shows the rest.
 */
export function departReason(result: DepartResult): string {
  if (result.ok) return '';
  if (result.reason === 'fuel') return `Need ${result.needOil ?? 0} more oil`;
  const first = result.missing?.[0];
  if (first === undefined) return 'Locked';
  switch (first.kind) {
    case 'ship':
      return `Requires ship ${UPGRADES[first.system].name.toLowerCase()} tier ${first.tier}`;
    case 'level':
      return `Requires level ${first.level}`;
    default:
      return requirementText(first);
  }
}

/**
 * SPEC-032 §4.3: why `Skip the run` is refused, in the line printed under the
 * disabled control. A flight mission is named by its title.
 */
export function skipRefusalText(refusal: SkipRefusal, mission?: MissionId): string {
  if (refusal === 'never_flown') return 'Autopilot needs a route — fly this run once.';
  const title = mission === undefined ? undefined : (MISSIONS[mission] as MissionDef | undefined)?.title;
  return `${title ?? 'This mission'} needs a flown run.`;
}

/**
 * AC-42: the one line a disabled shop button carries per `FailReason` — the
 * refusal is SPEC-010's, the phrasing is this spec's.
 */
export function failText(reason: FailReason): string {
  switch (reason) {
    case 'insufficient_tokens':
      return 'Not enough tokens';
    case 'insufficient_resources':
      return 'Not enough resources';
    case 'max_tier':
      return 'Already at the top tier';
    case 'prerequisite':
      return 'Requires the previous tier';
    case 'inventory_full':
      return 'Inventory full';
    case 'cargo_full':
      return 'Cargo full';
    case 'locked':
      return 'Locked';
    case 'not_found':
      return 'Unavailable';
  }
}

/** AC-39: one line per companion level, straight off the effect table. */
export function companionEffectText(effect: CompanionEffect): string {
  const parts: string[] = [];
  if (effect.autoCollectRadius !== undefined) parts.push(`collects within ${effect.autoCollectRadius} m`);
  if (effect.nodeRadar === true) parts.push('node radar');
  if (effect.droneDamageFraction !== undefined) parts.push(`drone at ${Math.round(effect.droneDamageFraction * 100)}% of your damage`);
  if (effect.droneFireRate !== undefined) parts.push(`${effect.droneFireRate}/s drone fire`);
  if (effect.regenOutOfCombat !== undefined) parts.push(`${Math.round(effect.regenOutOfCombat * 100)}%/s regen out of combat`);
  if (effect.regenInCombat !== undefined) parts.push(`${Math.round(effect.regenInCombat * 100)}%/s regen in combat`);
  if (effect.cargoBonus !== undefined) parts.push(`+${effect.cargoBonus} cargo`);
  // SPEC-039 §4.5: ship, gear and companion prices — a recipe has no token price.
  if (effect.shopDiscount !== undefined) parts.push(`−${Math.round(effect.shopDiscount * 100)}% shop prices`);
  if (effect.shieldRegen !== undefined) parts.push(`+${effect.shieldRegen}/s shield regen`);
  if (effect.autoAim === true) parts.push('auto-aim');
  if (effect.hullBonus !== undefined) parts.push(`+${effect.hullBonus} hull`);
  return parts.join(' · ');
}

/**
 * The rewards line of a mission row (§4.3): XP, tokens, resources, items. A
 * replay halves the XP and tokens and drops the rest (E2); SPEC-043 §4.3: a
 * contract replay reads its own payout — 75 % of each, then the lithium.
 */
export function rewardsText(rewards: MissionDef['rewards'], replay = false, contract = false): string {
  if (replay && contract) return contractPayout(rewards, '◈');
  const half = (value: number): number => (replay ? Math.floor(value / 2) : value);
  const parts: string[] = [];
  if (rewards.xp > 0) parts.push(`+${half(rewards.xp)} XP`);
  if (rewards.tokens > 0) parts.push(`+${half(rewards.tokens)} ◈`);
  if (!replay) {
    for (const [resource, amount] of Object.entries(rewards.resources ?? {})) {
      if ((amount ?? 0) > 0) parts.push(`+${amount} ${resource}`);
    }
    for (const item of rewards.items ?? []) {
      parts.push(`${ITEM_TABLE[item.itemId].name} ×${item.qty}`);
    }
  }
  return parts.join(' · ');
}

/**
 * SPEC-043 §4.3: `+<xp> XP · +<tokens> <unit> · +20 lithium` — the floored 75 %
 * of the mission's XP and tokens, and the contract's lithium. The board prints
 * tokens as `◈`, the banner as `tokens`.
 */
function contractPayout(rewards: MissionDef['rewards'], unit: string): string {
  const parts: string[] = [];
  const xp = Math.floor(rewards.xp * CONTRACT_REWARD_FRACTION);
  const tokens = Math.floor(rewards.tokens * CONTRACT_REWARD_FRACTION);
  if (xp > 0) parts.push(`+${xp} XP`);
  if (tokens > 0) parts.push(`+${tokens} ${unit}`);
  parts.push(`+${CONTRACT_LITHIUM} lithium`);
  return parts.join(' · ');
}

// ------------------------------------------- SPEC-043: bonuses, contracts, times

/** SPEC-043 §4.5: whole seconds as `m:ss` — `161` → `2:41`. */
export function timeText(seconds: number): string {
  const total = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** SPEC-043 §4.2: `No deaths` · `Under 4:00` · `No shelter` · `Kill 2 elites`. */
export function bonusText(bonus: MissionBonus): string {
  switch (bonus.kind) {
    case 'no_death':
      return 'No deaths';
    case 'par':
      return `Under ${timeText(bonus.seconds)}`;
    case 'no_shelter':
      return 'No shelter';
    case 'elites':
      return `Kill ${bonus.count} elite${bonus.count === 1 ? '' : 's'}`;
  }
}

/** SPEC-043 §4.2: `+2 Frag Grenade` · `+40 lithium` — items, then resources. */
export function bonusRewardText(reward: BonusReward): string {
  const parts: string[] = [];
  for (const item of reward.items ?? []) {
    if (item.qty > 0) parts.push(`+${item.qty} ${ITEM_TABLE[item.itemId].name}`);
  }
  for (const resource of RESOURCE_IDS) {
    const amount = reward.resources?.[resource] ?? 0;
    if (amount > 0) parts.push(`+${amount} ${resource}`);
  }
  return parts.join(' · ');
}

/** SPEC-043 §4.2: the board's bonus row — `Bonus: Under 4:00 → +2 Frag Grenade`. */
export function bonusLine(bonus: MissionBonus): string {
  return `Bonus: ${bonusText(bonus)} → ${bonusRewardText(bonus.reward)}`;
}

/**
 * SPEC-043 §4.3: `Contract · <name> · 75 % + 20 lithium` when `def` runs as a
 * contract on that landing, else `null`. The board asks for the next landing
 * (`visits + 1`), the pad terminal for this one (`visits`).
 */
export function contractLabel(save: Save, def: MissionDef, landing: number): string | null {
  const contract = contractFor(save, def, landing);
  if (contract === null) return null;
  const share = Math.round(CONTRACT_REWARD_FRACTION * 100);
  return `Contract · ${CONTRACTS[contract].name} · ${share} % + ${CONTRACT_LITHIUM} lithium`;
}

// ------------------------------------------------------------------ missions

/** Where a mission row is being read; the station is where replays start. */
export type MissionScene = 'station' | 'surface' | 'flight';

export type MissionStatus = 'locked' | 'available' | 'active' | 'done' | 'replayable';

/**
 * The one status a mission row renders from (§4.3). Order matters: an active
 * mission stays `active` even if its requirements would no longer pass, and a
 * finished one is never `locked`. A done mission reads `replayable` only at the
 * station — the board is where a replay is accepted (E2) — and plain `done`
 * from the field, where the row is a record, not an offer.
 *
 * E24 / SPEC-024 §4.6: the mission that ended the campaign reads `done`
 * everywhere, station included, so no surface offers a second verdict.
 */
export function missionStatus(save: Save, def: MissionDef, scene: MissionScene): MissionStatus {
  if (save.progress.missionsActive.some((entry) => entry.id === def.id)) return 'active';
  if ((save.progress.missionsDone as readonly string[]).includes(def.id)) {
    return scene === 'station' && !campaignLocked(save, def) ? 'replayable' : 'done';
  }
  if (missingRequirements(save, def.requires).length > 0) return 'locked';
  return 'available';
}

/**
 * SPEC-012 12-k: why the pad terminal has nothing to accept. The planet's own
 * missions are read in table order, so the first locked one is the next one
 * due and its first missing requirement is the sentence — "Complete 'Gauntlet'"
 * on The Hive, whose work starts with a flight mission the pad cannot offer
 * (12-j). With nothing locked either, the campaign is over (E24) or everything
 * here is done and only the station board still sells replays.
 */
export function padEmptyText(save: Save, planet: PlanetId): string {
  for (const def of Object.values(MISSIONS) as MissionDef[]) {
    if (def.planet !== planet || def.scene !== 'surface') continue;
    const missing = missingRequirements(save, def.requires)[0];
    if (missing === undefined) continue;
    const blocker = missing.kind === 'mission' ? MISSIONS[missing.id as MissionId] : undefined;
    const where = blocker?.scene === 'flight' ? ' — a flight mission, taken at the station board' : '';
    return `Nothing to accept yet. ${requirementText(missing)}${where}.`;
  }
  return "Nothing to accept here. The station board carries this planet's remaining work.";
}

/**
 * Accepts `def`, or re-accepts it as a replay. Pure over the save — the board
 * emits `mission:accepted` and requests the autosave itself. Returns false when
 * the mission is already running; a replay keeps its place in `missionsDone`,
 * so nothing it unlocked ever re-locks (SPEC-010 E2).
 */
export function acceptMission(save: Save, def: MissionDef): boolean {
  if (save.progress.missionsActive.some((entry) => entry.id === def.id)) return false;
  save.progress.missionsActive.push({ id: def.id as MissionId, stage: 0, counters: {} });
  return true;
}

/**
 * SPEC-034 §4.15: pins `id` by moving its entry to the front of
 * `progress.missionsActive` — the order the runtime already pins by, so the pin
 * persists with no save field. False when the mission is not running.
 */
export function pinMission(save: Save, id: MissionId): boolean {
  const list = save.progress.missionsActive;
  const at = list.findIndex((entry) => entry.id === id);
  if (at < 0) return false;
  if (at > 0) {
    const [entry] = list.splice(at, 1);
    if (entry !== undefined) list.unshift(entry);
  }
  return true;
}

/**
 * SPEC-034 §4.15: what is pinned — the front entry of `progress.missionsActive`,
 * or, with a `planet`, the front entry among that planet's active missions,
 * which is what its board rows badge.
 */
export function pinnedMission(save: Save, planet?: PlanetId): MissionId | null {
  for (const entry of save.progress.missionsActive) {
    if (planet !== undefined && MISSIONS[entry.id].planet !== planet) continue;
    return entry.id;
  }
  return null;
}

/** Drops the mission from the active list; false when it was not running. */
export function abandonMission(save: Save, id: MissionId): boolean {
  const at = save.progress.missionsActive.findIndex((entry) => entry.id === id);
  if (at < 0) return false;
  save.progress.missionsActive.splice(at, 1);
  return true;
}

/**
 * SPEC-028 §4.4 / E40: what a heal at full HP says. Shared, because SPEC-034
 * §4.15 makes the character panel refuse one the way the surface already did —
 * a medkit used at the station was simply spent for nothing.
 */
export const HP_FULL_TEXT = 'HP full';

// ---------------------------------------------- SPEC-034 §4.9: stage resets

/**
 * SPEC-034 §4.9: why a defend or escort stage went back to zero. A death, a
 * recall and a reload already announce themselves — a beacon that fell or a
 * probe that was lost do not, and the player was left watching a timer restart
 * with no idea what had happened.
 */
export function stageResetText(
  reason: GameEvents['mission:stageReset']['reason'],
  poi: PoiId | null,
  follower: FollowerId | null,
): string | null {
  if (reason === 'poi_destroyed' && poi !== null) {
    return `The ${POI_LABELS[poi]} went down — the defence restarts.`;
  }
  if (reason === 'follower_died' && follower !== null) {
    return `The ${FOLLOWERS[follower].name} was lost — the escort restarts.`;
  }
  return null;
}

// ------------------------------------------------------- the surface's holds

/** SPEC-034 §4.6: the three counters the surface step reads before it runs. */
export interface SurfaceHoldState {
  /** SPEC-023 §4.4: a held story beat — a film, a reveal, the ending sequence. */
  beats: number;
  /** SPEC-036 §4.3: the rotate block — a phone held upright, or entered upright. */
  rotate: boolean;
  /**
   * SPEC-026 §4.6 / SPEC-028 §4.6: the full-screen map, the quick picker —
   * and, since SPEC-036 §4.10, the pad terminal.
   */
  ui: number;
  /** SPEC-034 §4.6: open modal dialogues and the verdict choice. */
  modal: number;
}

export type SurfaceHold = 'beat' | 'rotate' | 'ui' | 'modal' | null;

/**
 * SPEC-034 §4.6: why the surface step is holding, or `null` when it is not.
 *
 * A modal line takes the player's movement, aim, healing and fire away, so the
 * enemies should not be able to act either: the world waits for a modal
 * dialogue and the verdict choice exactly as it already waits for the map. The
 * order is the order the step checks them in — a beat outranks the rotate
 * block (SPEC-036 §4.3), which outranks the map, which outranks a line.
 */
export function surfaceHoldReason(state: SurfaceHoldState): SurfaceHold {
  if (state.beats > 0) return 'beat';
  if (state.rotate) return 'rotate';
  if (state.ui > 0) return 'ui';
  if (state.modal > 0) return 'modal';
  return null;
}

/**
 * SPEC-040 §4.2: whether a hold leaves nothing on screen moving with the world
 * — the map, the quick picker, the pad terminal, a modal line and the rotate
 * block all stand the world still, so the surface is idle and draws at most
 * five frames a second. A beat never is: a film or a reveal moves the camera.
 */
export function holdIsIdle(hold: SurfaceHold): boolean {
  return hold === 'ui' || hold === 'modal' || hold === 'rotate';
}

// -------------------------------------------------------------- player stats

/**
 * The creation screen's live preview (§4.2) and the character panel. Its HP is
 * `maxHp` and nothing else — SPEC-034 §4.14 folded the class bonus into that
 * formula, and this used to add it a second time. SPEC-039 §4.7: the damage is
 * `playerDamageMult`, the one formula `Combat` fights with, level factor
 * included; speed reads agility's `ATTRIBUTE_EFFECTS` share.
 */
export function computePlayerStats(
  classId: ClassId,
  attributes: Attributes,
  level: number,
  weapon?: ItemId,
): { hp: number; damage: number; speed: number } {
  const cls = CLASS_TABLE[classId];
  const armed = ITEM_TABLE[weapon ?? cls.startingWeapon];
  const base = armed.kind === 'weapon' ? armed.damage : 0;
  return {
    hp: maxHp(classId, attributes, level),
    damage: Math.round(base * playerDamageMult(classId, attributes, level) * 10) / 10,
    speed:
      Math.round(
        TUNING.PLAYER_SPEED * (1 + ATTRIBUTE_EFFECTS.agility.moveSpeed * attributes.agility) * (cls.passive.moveSpeedMult ?? 1) * 100,
      ) / 100,
  };
}

/** SPEC-039 §3: the stats a `gearCompare` part can name. */
export type StatKey =
  | 'tier'
  | 'dps'
  | 'firing'
  | 'damage'
  | 'fireRate'
  | 'range'
  | 'pierce'
  | 'heat'
  | 'recharge'
  | 'cooldown'
  | 'armor'
  | 'hazardResist';

/** One part of a compare line. It carries no judgement (SPEC-042 decides which way a part points). */
export interface StatDelta {
  readonly stat: StatKey;
  /** 'DPS', 'firing DPS', 'damage', 'heat per shot', … */
  readonly label: string;
  /** Numbers for every stat but `cooldown`, whose values are the model names. */
  readonly from: number | string;
  readonly to: number | string;
}

/** A weapon's slot, or `armor`; `null` for a consumable. */
function slotOf(item: Item): WeaponSlot | 'armor' | null {
  if (item.kind === 'weapon') return item.slot;
  if (item.kind === 'armor') return 'armor';
  return null;
}

/**
 * SPEC-039 §4.6: what changes when `candidate` replaces `worn` — any two items
 * of one slot (two weapons with the same `slot`, or two armour pieces), `[]`
 * across slots or for consumables. Parts in a fixed order, each only when the
 * values differ: tier (the two share a line), sustained DPS, firing DPS (either
 * has a heat model), damage, fire rate, range, pierce, heat per shot (both
 * heat), recharge (both charges) and the cooldown model; armour compares tier,
 * armor and hazard resist as it always did.
 */
export function gearCompare(worn: ItemId, candidate: ItemId): readonly StatDelta[] {
  const a = ITEM_TABLE[worn];
  const b = ITEM_TABLE[candidate];
  const slot = slotOf(a);
  if (slot === null || slot !== slotOf(b)) return [];
  const parts: StatDelta[] = [];
  const delta = (stat: StatKey, label: string, from: number | string, to: number | string): void => {
    if (from !== to) parts.push({ stat, label, from, to });
  };
  if (a.kind !== 'consumable' && b.kind !== 'consumable' && a.line === b.line) delta('tier', 'tier', a.tier, b.tier);
  if (a.kind === 'weapon' && b.kind === 'weapon') {
    const da = weaponDps(a.id);
    const db = weaponDps(b.id);
    delta('dps', 'DPS', Math.round(da?.sustained ?? 0), Math.round(db?.sustained ?? 0));
    if (a.cooldown.kind === 'heat' || b.cooldown.kind === 'heat') {
      delta('firing', 'firing DPS', Math.round(da?.firing ?? 0), Math.round(db?.firing ?? 0));
    }
    delta('damage', 'damage', a.damage, b.damage);
    delta('fireRate', 'fire rate', a.fireRate, b.fireRate);
    delta('range', 'range', a.range, b.range);
    delta('pierce', 'pierce', a.pierce, b.pierce);
    if (a.cooldown.kind === 'heat' && b.cooldown.kind === 'heat') {
      delta('heat', 'heat per shot', a.cooldown.perShot, b.cooldown.perShot);
    }
    if (a.cooldown.kind === 'charges' && b.cooldown.kind === 'charges') {
      delta('recharge', 'recharge', a.cooldown.rechargeSeconds, b.cooldown.rechargeSeconds);
    }
    delta('cooldown', 'cooldown', a.cooldown.kind, b.cooldown.kind);
  } else if (a.kind === 'armor' && b.kind === 'armor') {
    delta('armor', 'armor', a.armor, b.armor);
    delta('hazardResist', 'hazard resist', a.hazardResist, b.hazardResist);
  }
  return parts;
}

/**
 * AC-47, SPEC-039 §4.6: the compare line between the worn piece and a
 * candidate — `gearCompare` joined as `<label> <from> → <to>` with ` · `; the
 * tier reads `T<a> → T<b>` and a recharge carries its seconds. Items of
 * different slots compare as `''`.
 */
export function gearCompareText(worn: ItemId, candidate: ItemId): string {
  return gearCompare(worn, candidate).map(compareText).join(' · ');
}

/** One compare part as the line prints it — shared with `compareDeltas` (SPEC-042 §4.8). */
function compareText(part: StatDelta): string {
  if (part.stat === 'tier') return `T${part.from} → T${part.to}`;
  if (part.stat === 'recharge') return `recharge ${part.from} s → ${part.to} s`;
  return `${part.label} ${part.from} → ${part.to}`;
}

/**
 * AC-47: the equipped card's tooltip — where this piece's ladder goes next, as
 * tier → stat deltas through `gearCompareText`. The ladder is the item's own
 * line (SPEC-025 §4.8), so the Service Pistol's next rung is a handgun and not
 * the tier-1 rifle. The top of a line has nothing above it, so it says so
 * instead of comparing to nothing; a non-gear id compares nothing and returns
 * the same empty string `gearCompareText` would.
 */
export function gearTooltip(id: ItemId): string {
  const item = ITEM_TABLE[id];
  if (item.kind !== 'weapon' && item.kind !== 'armor') return '';
  const next = (Object.keys(ITEM_TABLE) as ItemId[]).find((other) => {
    const candidate = ITEM_TABLE[other];
    return candidate.kind !== 'consumable' && candidate.line === item.line && candidate.tier === item.tier + 1;
  });
  if (next === undefined) return `T${item.tier} — top tier`;
  return gearCompareText(id, next);
}

// ------------------------------------ SPEC-039 §4.5, §4.6: the shop and board

/**
 * SPEC-039 §4.6: a board row's drop line — `null` unless a stage holds a
 * `boss` objective whose table carries a signature row (D13). A mission in
 * `missionsDone` is a replay, and a piece carried or worn is not dropped
 * again, so both read as the fallback lithium (E69).
 */
export function bossDropText(save: Save, def: MissionDef): string | null {
  for (const stage of def.stages) {
    for (const objective of stage) {
      if (objective.kind !== 'boss') continue;
      const signature = LOOT_TABLE[ENEMIES[objective.enemy].loot].find((entry) => entry.kind === 'signature');
      if (signature === undefined || signature.kind !== 'signature') return null;
      const replay = (save.progress.missionsDone as readonly string[]).includes(def.id);
      if (replay || ownsItem(save, signature.itemId)) return `Boss drop: ${SIGNATURE_FALLBACK_LITHIUM} lithium`;
      return `Boss drop: ${ITEM_TABLE[signature.itemId].name}`;
    }
  }
  return null;
}

/** One line of the Refit list (SPEC-039 §3). */
export interface RefitEntry {
  readonly label: string;
  readonly tokens: number;
  readonly required: boolean;
}

/** The loadout entry as the shop sells it: the step being priced, and whether the save has it. */
function refitHas(save: Save, entry: LoadoutEntry): boolean {
  if (entry.kind === 'gear') return ownsItem(save, entry.id);
  if (entry.kind === 'ship') return save.ship[entry.id] >= entry.tier;
  return save.companions.some((companion) => companion.id === entry.id);
}

function refitLabel(entry: LoadoutEntry): string {
  if (entry.kind === 'gear') return ITEM_TABLE[entry.id].name;
  if (entry.kind === 'ship') return `${UPGRADES[entry.id].name} tier ${entry.tier}`;
  return COMPANIONS[entry.id].name;
}

/**
 * SPEC-039 §4.6: what the next unvisited planet asks for. The target is the
 * lowest chapter ≥ 2 whose planet has no landing; with every one landed on
 * there is no line (39-k). The entries are every `RECOMMENDED_LOADOUT` entry
 * of chapters 2…target the save does not own, in table order, at the price
 * `economy` charges now — so tech, the refit discount and the Quartermaster
 * all apply — and `required` when a planet of chapter ≤ target names it in its
 * unlock (the Ferrum shield).
 */
export function refitLine(
  save: Save,
  economy: Pick<Economy, 'price'>,
): { planet: PlanetId; entries: readonly RefitEntry[] } | null {
  let target: PlanetDef | null = null;
  for (const id of PLANET_IDS) {
    const planet = PLANET_TABLE[id];
    if (planet.chapter < 2 || (save.progress.visits[id] ?? 0) > 0) continue;
    if (target === null || planet.chapter < target.chapter) target = planet;
  }
  if (target === null) return null;
  const chapter = target.chapter;
  const gates: Requirement[] = [];
  for (const id of PLANET_IDS) {
    if (PLANET_TABLE[id].chapter <= chapter) gates.push(...PLANET_TABLE[id].unlock);
  }
  const entries: RefitEntry[] = [];
  for (const step of LOADOUT_CHAPTERS) {
    if (step > chapter) continue;
    for (const entry of RECOMMENDED_LOADOUT[step]) {
      if (refitHas(save, entry)) continue;
      const price =
        entry.kind === 'ship'
          ? economy.price('ship', entry.id, entry.tier)
          : entry.kind === 'companion'
            ? economy.price('companion', entry.id, 1)
            : economy.price('gear', entry.id);
      const required =
        entry.kind === 'ship' &&
        gates.some((gate) => gate.kind === 'ship' && gate.system === entry.id && gate.tier === entry.tier);
      entries.push({ label: refitLabel(entry), tokens: price?.tokens ?? 0, required });
    }
  }
  return { planet: target.id, entries };
}

/**
 * SPEC-039 §4.6: `Refit for <planet>: <label> <tokens> · …`, with
 * ` (required)` after a gate entry, or `Refit for <planet>: ready`; `null` when
 * there is no line.
 */
export function refitText(save: Save, economy: Pick<Economy, 'price'>): string | null {
  const line = refitLine(save, economy);
  if (line === null) return null;
  const name = PLANET_TABLE[line.planet].name;
  if (line.entries.length === 0) return `Refit for ${name}: ready`;
  const parts = line.entries.map((entry) => `${entry.label} ${entry.tokens}${entry.required ? ' (required)' : ''}`);
  return `Refit for ${name}: ${parts.join(' · ')}`;
}

/** SPEC-039 §4.5: what each ship system acts on, under its name in the shop. */
const SHIP_ROLES: Readonly<Record<ShipSystem, string>> = {
  hull: 'Flight: hull points',
  shield: 'Flight: shield points',
  weapon: 'Flight: nose guns',
  engine: 'Flight time and fuel per jump',
  cargo: 'The hold, on every planet',
};

export function shipRoleText(system: ShipSystem): string {
  return SHIP_ROLES[system];
}

/**
 * SPEC-039 §4.5: `Required for <planet>` while a planet's unlock names a tier
 * of `system` above the save's — the Ferrum shield today — else `null`.
 */
export function shipGateText(save: Save, system: ShipSystem): string | null {
  for (const id of PLANET_IDS) {
    const planet = PLANET_TABLE[id];
    const gated = planet.unlock.some(
      (requirement) => requirement.kind === 'ship' && requirement.system === system && requirement.tier > save.ship[system],
    );
    if (gated) return `Required for ${planet.name}`;
  }
  return null;
}

// --------------------------------------------- SPEC-042: feedback in play

/**
 * §4.1: the mission banner's three lines, and SPEC-043 §4.6's three optional
 * rows under the rewards — each `null` when the banner has no such row.
 */
export interface CompletionLines {
  title: string;
  rewards: string;
  next: string | null;
  /** `Bonus: <bonus> — <reward>`, or `Bonus missed: <bonus>`. */
  bonus?: string | null;
  /** `Contract · <name>`. */
  contract?: string | null;
  /** `Time <m:ss>`. */
  time?: string | null;
}

/**
 * SPEC-043 §4.6: what the scene knows besides the mission — the payload's
 * `contract` and `seconds`, and the `mission:bonus` that preceded it.
 */
export interface CompletionExtras {
  contract?: ContractId | null;
  bonus?: { bonus: MissionBonus; earned: boolean } | null;
  seconds?: number | null;
}

/**
 * §4.1 — what the banner says when `def` completes: its title; the rewards,
 * `+100 XP · +10 tokens · +20 oil`, then each item (`Medkit ×2`), with zero
 * amounts left out; and where the next work is. A replay pays the halved XP
 * and tokens — off the same fraction `applyRewards` charges — then `replay`,
 * and nothing else, as `rewardsText` does. `next` is the pad's first offer
 * that is not a replay, or `null`.
 *
 * SPEC-043 §4.6: with `extras.contract` the rewards are the contract's payout,
 * `+<xp> XP · +<tokens> tokens · +20 lithium · contract`; the bonus, contract
 * and time rows come from the extras, each `null` when its extra is absent.
 */
export function completionLines(
  def: MissionDef,
  replay: boolean,
  next: MissionDef | null,
  extras?: CompletionExtras,
): CompletionLines {
  const contract = extras?.contract ?? null;
  const judged = extras?.bonus ?? null;
  const seconds = extras?.seconds ?? null;
  return {
    title: def.title,
    rewards: contract !== null ? `${contractPayout(def.rewards, 'tokens')} · contract` : bannerRewards(def, replay),
    next: next === null ? null : `Next: ${next.title} — at the pad terminal`,
    bonus:
      judged === null
        ? null
        : judged.earned
          ? `Bonus: ${bonusText(judged.bonus)} — ${bonusRewardText(judged.bonus.reward)}`
          : `Bonus missed: ${bonusText(judged.bonus)}`,
    contract: contract === null ? null : `Contract · ${CONTRACTS[contract].name}`,
    time: seconds === null ? null : `Time ${timeText(seconds)}`,
  };
}

/** SPEC-042 §4.1: a first run's or a plain replay's rewards line. */
function bannerRewards(def: MissionDef, replay: boolean): string {
  const rewards = def.rewards;
  const paid = (value: number): number => (replay ? Math.floor(value * TUNING.REPLAY_REWARD_FRACTION) : value);
  const parts: string[] = [];
  const xp = paid(rewards.xp);
  if (xp > 0) parts.push(`+${xp} XP`);
  const tokens = paid(rewards.tokens);
  if (tokens > 0) parts.push(`+${tokens} tokens`);
  if (replay) {
    parts.push('replay');
  } else {
    for (const [resource, amount] of Object.entries(rewards.resources ?? {})) {
      if ((amount ?? 0) > 0) parts.push(`+${amount} ${resource}`);
    }
    for (const item of rewards.items ?? []) {
      if (item.qty > 0) parts.push(`${ITEM_TABLE[item.itemId].name} ×${item.qty}`);
    }
  }
  return parts.join(' · ');
}

/**
 * §4.2 — what `item:collected` toasts: `Picked up Medkit ×2` for a consumable
 * (no `×1`), `Picked up Composite Weave (T1) — equip it at the station` for a
 * weapon or armour piece.
 */
export function pickupText(itemId: ItemId, qty: number): string {
  const item = ITEM_TABLE[itemId];
  if (item.kind === 'consumable') return `Picked up ${item.name}${qty > 1 ? ` ×${qty}` : ''}`;
  return `Picked up ${item.name} (T${item.tier}) — equip it at the station`;
}

/** §4.2 — what `item:blocked` toasts, once per refused pickup. */
export function blockedText(itemId: ItemId): string {
  return `Inventory full — ${ITEM_TABLE[itemId].name} left on the ground`;
}

/**
 * §4.7 — the character panel's `character-xp` line: the XP into this level,
 * the level's span and what is left, `XP 340 / 450 — 110 to level 6`; at
 * `LEVEL_CAP`, `Level 30 — the cap` (42-p).
 */
export function characterXpText(level: number, xp: number): string {
  if (level >= LEVEL_CAP) return `Level ${LEVEL_CAP} — the cap`;
  const into = xp - cumulativeXp(level);
  const span = xpToNext(level);
  return `XP ${into} / ${span} — ${span - into} to level ${level + 1}`;
}

/** §4.3: the three timed effects a consumable can leave running. */
export type EffectKind = 'heal' | 'damage_boost' | 'hazard_immunity';

export interface HudEffect {
  kind: EffectKind;
  /** Whole seconds left, rounded up. */
  seconds: number;
}

/** `out[at]` written in place — built only the first time that slot is used. */
function writeEffect(out: HudEffect[], at: number, kind: EffectKind, seconds: number): number {
  const entry = out[at];
  if (entry === undefined) {
    out[at] = { kind, seconds };
  } else {
    entry.kind = kind;
    entry.seconds = seconds;
  }
  return at + 1;
}

/**
 * §4.3 — the player's running effects into `out`, in this order: the heal over
 * time (`ceil(remaining / perSecond)`), the damage boost (the latest `until` of
 * the live boosts — a second plasma cell keeps one row, 42-h) and the hazard
 * immunity. Reuses `out`'s entries and returns how many it wrote; `out` keeps
 * any entries past that count for the next call.
 */
export function activeEffects(
  player: Pick<PlayerEntity, 'healOverTime' | 'boosts' | 'hazardImmuneUntil'>,
  time: number,
  out: HudEffect[],
): number {
  let count = 0;
  const heal = player.healOverTime;
  if (heal !== null && heal.remaining > 0 && heal.perSecond > 0) {
    count = writeEffect(out, count, 'heal', Math.ceil(heal.remaining / heal.perSecond));
  }
  let until = -Infinity;
  for (let i = 0; i < player.boosts.length; i++) {
    const boost = player.boosts[i] as { until: number };
    if (boost.until > until) until = boost.until;
  }
  if (until > time) count = writeEffect(out, count, 'damage_boost', Math.ceil(until - time));
  if (player.hazardImmuneUntil > time) {
    count = writeEffect(out, count, 'hazard_immunity', Math.ceil(player.hazardImmuneUntil - time));
  }
  return count;
}

/** `spore_storm` → `spore storm` — the weather as a death names it. */
function weatherWords(id: WeatherId): string {
  return id.replace(/_/g, ' ');
}

/** §4.5 — the death overlay's `death-cause` line: what killed the player. */
export function deathCause(cause: DamageSource): string {
  switch (cause.kind) {
    case 'enemy':
    case 'projectile':
      return `Killed by ${ENEMIES[cause.enemyId].name}`;
    case 'weather':
      return `Killed by the ${weatherWords(cause.weather)}`;
    case 'fall':
      return 'Killed by a fall';
    case 'asteroid':
      return 'Killed by an asteroid';
    case 'storm':
      return 'Killed by the ion storm';
  }
}

/** §4.5: what `deathTip` reads besides the cause. */
export interface DeathContext {
  scheme: Scheme;
  autoFire: AutoFireMode;
  /** Heal consumables in the pack — what Q, or the heal slot, could have used. */
  healsCarried: number;
}

/**
 * §4.5 — the one tip under the cause, in the scheme's wording, or `null` when
 * no row applies (a fall, an asteroid, the ion storm). The first matching row
 * wins: weather → shelter; an enemy with auto-fire off → auto-fire; an enemy
 * with a heal carried → heal; an enemy with none → craft.
 */
export function deathTip(cause: DamageSource, context: DeathContext): string | null {
  let id: DeathTipId | null = null;
  if (cause.kind === 'weather') id = 'shelter';
  else if (cause.kind === 'enemy' || cause.kind === 'projectile') {
    id = context.autoFire === 'off' ? 'autofire' : context.healsCarried > 0 ? 'heal' : 'craft';
  }
  if (id === null) return null;
  return context.scheme === 'touch' ? DEATH_TIPS[id].touch : DEATH_TIPS[id].keyboard;
}

/** §3: what a completed purchase was, as the call site knows it. */
export type PurchaseResult =
  | { kind: 'ship'; system: ShipSystem; tier: number }
  | { kind: 'gear'; id: ItemId }
  | { kind: 'companion'; id: CompanionId; level: number }
  | { kind: 'craft'; recipe: RecipeId; qty: number };

/**
 * §4.8 — the toast a purchase raises instead of `Purchased`: what was bought
 * and what it changed. A ship tier names its metrics' step from the tier below
 * (`Shield upgraded to tier 2 — Shield 80 → 120`); gear says where to equip
 * it; a companion its level; a craft its total, `Crafted Medkit ×5` (42-q).
 */
export function purchaseText(result: PurchaseResult): string {
  switch (result.kind) {
    case 'ship': {
      const def = UPGRADES[result.system];
      const deltas = Object.entries(def.metrics as Readonly<Record<string, readonly number[]>>)
        .map(([metric, values]) => upgradeDeltaText(metric, values[result.tier - 1] ?? 0, values[result.tier] ?? 0))
        .join(' · ');
      const head = `${def.name} upgraded to tier ${result.tier}`;
      return deltas === '' ? head : `${head} — ${deltas}`;
    }
    case 'gear': {
      const item = ITEM_TABLE[result.id];
      return item.kind === 'consumable' ? `${item.name} bought` : `${item.name} bought — equip it in Character`;
    }
    case 'companion': {
      const name = COMPANIONS[result.id].name;
      return result.level <= 1 ? `${name} bought` : `${name} upgraded to L${result.level}`;
    }
    case 'craft': {
      const recipe = RECIPES[result.recipe];
      const total = recipe.qty * result.qty;
      return `Crafted ${ITEM_TABLE[recipe.output].name}${total > 1 ? ` ×${total}` : ''}`;
    }
  }
}

/**
 * §4.8 — a missing rung, named: the highest item of the candidate's own line
 * below its tier, `Requires Laser Carbine (T1)`. An item with nothing below it
 * (or a consumable) falls back to `failText('prerequisite')`.
 */
export function prerequisiteText(id: ItemId): string {
  const item = ITEM_TABLE[id];
  if (item.kind === 'consumable') return failText('prerequisite');
  let below: Extract<Item, { kind: 'weapon' | 'armor' }> | null = null;
  for (const other of Object.values(ITEM_TABLE)) {
    if (other.kind === 'consumable' || other.line !== item.line || other.tier >= item.tier) continue;
    if (below === null || other.tier > below.tier) below = other;
  }
  return below === null ? failText('prerequisite') : `Requires ${below.name} (T${below.tier})`;
}

/** §3: one `gearCompare` part with the direction it points for the player. */
export interface CompareDelta extends StatDelta {
  /** +1 better, −1 worse, 0 neither (equal values, or the cooldown model). */
  readonly better: -1 | 0 | 1;
  /** The part's text exactly as `gearCompareText` prints it. */
  readonly text: string;
}

/** §4.8: the stats where less is more — heat per shot and recharge seconds. */
const LOWER_IS_BETTER: ReadonlySet<StatKey> = new Set<StatKey>(['heat', 'recharge']);

/**
 * §4.8 — SPEC-039's `gearCompare(worn, candidate)` part by part, each with its
 * direction and its text. It computes no stat of its own, so the arrows can
 * never disagree with the line. The arrow shows benefit, not the number's
 * direction: a lower heat per shot is better. The cooldown model has none.
 */
export function compareDeltas(worn: ItemId, candidate: ItemId): readonly CompareDelta[] {
  return gearCompare(worn, candidate).map((part) => ({ ...part, better: compareDirection(part), text: compareText(part) }));
}

/**
 * §4.8 — which way one part points for the player: +1 when the candidate's
 * number is higher (lower, for heat per shot and recharge), −1 the other way,
 * 0 for equal values and for the cooldown model, whose values are names.
 */
export function compareDirection(part: Pick<StatDelta, 'stat' | 'from' | 'to'>): -1 | 0 | 1 {
  if (part.stat === 'cooldown' || typeof part.from !== 'number' || typeof part.to !== 'number' || part.from === part.to) return 0;
  return part.to > part.from !== LOWER_IS_BETTER.has(part.stat) ? 1 : -1;
}

/** The affix lines already joined, per (affixA, affixB) pair — built once each. */
const AFFIX_LINES: (string | undefined)[] = [];

/**
 * SPEC-041's affix display names joined by ` · ` — what an elite's nameplate
 * and the target frame both read — or `''` for a non-elite. Cached per pair,
 * so after the first call for a pair it allocates nothing.
 */
export function affixLine(e: Pick<EnemyEntity, 'elite' | 'affixA' | 'affixB'>): string {
  if (!e.elite) return '';
  const a = e.affixA === null ? AFFIX_IDS.length : AFFIX_IDS.indexOf(e.affixA);
  const b = e.affixB === null ? AFFIX_IDS.length : AFFIX_IDS.indexOf(e.affixB);
  const key = a * (AFFIX_IDS.length + 1) + b;
  let line = AFFIX_LINES[key];
  if (line === undefined) {
    const names: string[] = [];
    if (e.affixA !== null) names.push(AFFIXES[e.affixA].name);
    if (e.affixB !== null) names.push(AFFIXES[e.affixB].name);
    line = names.join(' · ');
    AFFIX_LINES[key] = line;
  }
  return line;
}

const PHASE_MARKS = new Map<EnemyId, readonly number[]>();

/**
 * §4.9 — the boss bar's ticks: `phases[i].hpFraction` for every phase after
 * the first, cached per boss id so the HUD diff sees one array. `[]` for an
 * enemy with no phase table.
 */
export function bossPhaseMarks(id: EnemyId): readonly number[] {
  let marks = PHASE_MARKS.get(id);
  if (marks === undefined) {
    const phases = (ENEMIES[id] as { phases?: readonly { hpFraction: number }[] }).phases ?? [];
    marks = Object.freeze(phases.slice(1).map((phase) => phase.hpFraction));
    PHASE_MARKS.set(id, marks);
  }
  return marks;
}

// ------------------------------------------------------------------ HUD diff

/**
 * Everything the HUD draws in a frame (SPEC-014 §3). Systems write fields;
 * `Hud.flush()` diffs against the last rendered copy and touches only what
 * moved. `flight` is present only in flight mode.
 */
export interface HudTrackerRow {
  /** The row's wording: SPEC-027 §4.2's table, or today's line on the focus row. */
  text: string;
  done: boolean;
  focus: boolean;
  /**
   * SPEC-034 §4.9: for a `defend` row, the POI's HP as a fraction of its max —
   * the one number the player had no way to see while the thing they were
   * defending was being eaten. `null` on every other row.
   */
  defendHp: number | null;
  /**
   * SPEC-042 §4.6: the counted value of a kill, collect or scan row — what the
   * tracker bumps on when it rises; −1 on every other row, so a survive
   * timer, whose text changes every second, never bumps.
   */
  count: number;
}

/**
 * SPEC-027 §4.2 — the surface objective tracker: the tracked mission's whole
 * current stage, with the focus row's distance and map bearing beside it.
 * `null` off the surface, where the flight HUD keeps its one `objective` line.
 */
export interface HudTracker {
  title: string;
  /** `stage 2/3`; empty with no mission, where the header is the title alone. */
  stage: string;
  rows: HudTrackerRow[];
  /** Metres to the focus target; `null` when there is none. */
  distance: number | null;
  /** Radians clockwise from map-up — what the ▲ beside the row rotates by. */
  bearing: number;
  /** Stuck level ≥ 1: the tracker and the waypoint pulse (SPEC-027 AC-28). */
  pulse: boolean;
}

export interface HudModel {
  hp: [number, number];
  xp: [number, number];
  level: number;
  tokens: number;
  resources: Record<ResourceId, number>;
  cargoCap: number;
  objective: { title: string; line: string; value: number; target: number } | null;
  tracker: HudTracker | null;
  weather: { warning: WeatherId | null; active: WeatherId | null; secondsLeft: number };
  /** SPEC-030 §4.5: the chip under the weather banner (D-11). */
  shelter: 'none' | 'sheltered' | 'hidden';
  /**
   * SPEC-042 §4.9: the boss frame — its 1-based `phase`, and the `hpFraction`
   * of each later phase as the bar's ticks (`bossPhaseMarks`, one cached array
   * per boss). The scene writes one reused object, never a fresh one a step.
   */
  boss: { name: string; hp: number; max: number; phase: number; marks: readonly number[] } | null;
  /**
   * SPEC-042 §4.9: the target frame — the last non-boss enemy the player hit
   * inside 3 s, an elite winning; `affixes` is `affixLine`'s. One reused object.
   */
  target: { name: string; elite: boolean; affixes: string; hp: number; max: number } | null;
  /** SPEC-042 §4.3: the running timed effects, at most three, reused objects. */
  effects: HudEffect[];
  /** SPEC-042 §4.6: `▲ Wave incoming` is up. */
  wave: boolean;
  /** SPEC-028 §3: the quick bar's two halves; both `null` off the surface. */
  loadout: { active: WeaponSlot; slots: Record<WeaponSlot, SlotView>; fallback: boolean } | null;
  quick: Record<QuickSlot, { itemId: ItemId | null; qty: number }> | null;
  interact: string | null;
  /** SPEC-037 §4.3: true when the interact prompt is an action that E / USE performs. */
  interactAction: boolean;
  /** SPEC-037 §4.2: the wallet strip at full opacity (`walletLit`), else 0.6. */
  walletLit: boolean;
  /** SPEC-038 §4.1: the dash's cooldown ring — 1 at the press, 0 when ready. */
  dash: number;
  flight?: {
    shield: [number, number];
    hull: [number, number];
    throttle: number;
    progress: number;
    hostiles: number;
    storm: boolean;
    holding: boolean;
  };
}

export type HudKey = keyof HudModel;

/** A zeroed model, so a scene can write only what it knows. */
export function createHudModel(): HudModel {
  return {
    hp: [0, 1],
    xp: [0, 1],
    level: 1,
    tokens: 0,
    resources: { oil: 0, wheat: 0, water: 0, lithium: 0 },
    cargoCap: TUNING.CARGO_BASE,
    objective: null,
    tracker: null,
    weather: { warning: null, active: null, secondsLeft: 0 },
    shelter: 'none',
    boss: null,
    target: null,
    effects: [],
    wave: false,
    loadout: null,
    quick: null,
    interact: null,
    interactAction: false,
    walletLit: false,
    dash: 0,
  };
}

/**
 * Every top-level key of a `HudModel`, as a record so the compiler checks the
 * list is complete — a key added to the model and not here is a type error,
 * never a field the diff silently skips.
 */
const HUD_KEY_TABLE = {
  hp: true,
  xp: true,
  level: true,
  tokens: true,
  resources: true,
  cargoCap: true,
  objective: true,
  tracker: true,
  weather: true,
  shelter: true,
  boss: true,
  target: true,
  effects: true,
  wave: true,
  loadout: true,
  quick: true,
  interact: true,
  interactAction: true,
  walletLit: true,
  dash: true,
  flight: true,
} as const satisfies Record<HudKey, true>;

/** SPEC-040 §4.4: the constant key list the diff walks — built once, never per frame. */
export const HUD_KEYS: readonly HudKey[] = Object.freeze(Object.keys(HUD_KEY_TABLE) as HudKey[]);

/**
 * Structural equality over the plain values a `HudModel` holds, with no
 * allocation (SPEC-040 §4.4): identity first, then arrays index by index, then
 * plain objects key by key with `for…in` on both sides — no `Object.keys`
 * arrays, no closures.
 */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const aArray = Array.isArray(a);
  if (aArray !== Array.isArray(b)) return false;
  if (aArray) {
    const left = a as readonly unknown[];
    const right = b as readonly unknown[];
    if (left.length !== right.length) return false;
    for (let i = 0; i < left.length; i++) if (!sameValue(left[i], right[i])) return false;
    return true;
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  for (const key in left) {
    if (!(key in right) || !sameValue(left[key], right[key])) return false;
  }
  for (const key in right) {
    if (!(key in left)) return false;
  }
  return true;
}

/**
 * The changed top-level keys between two models (SPEC-014 §4.5, AC-62), into
 * `out`: it is cleared, filled and returned, so `Hud.flush()` diffs a fight's
 * every frame through one scratch set (SPEC-040 §4.4). An empty set is the
 * contract that `flush()` writes nothing to the DOM that frame.
 */
export function diffHudInto(prev: HudModel, next: HudModel, out: Set<HudKey>): Set<HudKey> {
  out.clear();
  for (let i = 0; i < HUD_KEYS.length; i++) {
    const key = HUD_KEYS[i] as HudKey;
    if (!sameValue(prev[key], next[key])) out.add(key);
  }
  return out;
}

/** `diffHudInto` into a fresh set — the pure form the SPEC-014 tests read. */
export function diffHud(prev: HudModel, next: HudModel): Set<HudKey> {
  return diffHudInto(prev, next, new Set<HudKey>());
}

/**
 * `from` written into `into`, reusing `into`'s own arrays and objects: a
 * primitive is assigned, an array is resized in place and filled element by
 * element, an object is copied key by key and loses the keys `from` lacks.
 * `into` never ends up holding a reference into `from`. It allocates only
 * where `into` has no container of the right kind — null ↔ object — or an
 * array has to grow.
 */
function copyValue(into: unknown, from: unknown): unknown {
  if (typeof from !== 'object' || from === null) return from;
  if (Array.isArray(from)) {
    const out: unknown[] = Array.isArray(into) ? (into as unknown[]) : [];
    if (out.length > from.length) out.length = from.length;
    for (let i = 0; i < from.length; i++) out[i] = copyValue(out[i], from[i]);
    return out;
  }
  const out = (typeof into === 'object' && into !== null && !Array.isArray(into) ? into : {}) as Record<string, unknown>;
  const source = from as Record<string, unknown>;
  for (const key in source) out[key] = copyValue(out[key], source[key]);
  for (const key in out) {
    if (!(key in source)) delete out[key];
  }
  return out;
}

/**
 * SPEC-040 §4.4: `source` copied into `target` in place — the "last rendered"
 * side of the diff, kept without a deep clone per changed frame. A
 * second copy of an unchanged model creates no new object. Returns `target`.
 */
export function copyHudInto(target: HudModel, source: HudModel): HudModel {
  copyValue(target, source);
  return target;
}

// -------------------------------------------------------------------- toasts

export type ToastKind = 'info' | 'warn' | 'good' | 'error';

export interface ToastEntry {
  text: string;
  kind: ToastKind;
  /** How many identical texts this toast stands for (AC-80). */
  count: number;
  shownAt: number;
  expiresAt: number;
}

/** §4.6: three on screen, 2.5 s each, and a 3 s window for merging repeats. */
export const TOAST_MAX = 3;
export const TOAST_DEFAULT_MS = 2500;
export const TOAST_COALESCE_MS = 3000;

/**
 * The pure toast queue step (§4.6, AC-78, AC-80): identical text inside the
 * window bumps the counter and keeps the toast up; a new text drops the oldest
 * past `TOAST_MAX`. The counter resets naturally — an expired toast has left
 * the stack, so the next identical text starts a fresh entry at 1.
 */
export function pushToast(
  stack: readonly ToastEntry[],
  text: string,
  kind: ToastKind,
  now: number,
  ms: number = TOAST_DEFAULT_MS,
): ToastEntry[] {
  const alive = pruneToasts(stack, now);
  const twin = alive.find((entry) => entry.text === text && now - entry.shownAt < TOAST_COALESCE_MS);
  if (twin !== undefined) {
    return alive.map((entry) =>
      entry === twin ? { ...entry, count: entry.count + 1, expiresAt: Math.max(entry.expiresAt, now + ms) } : entry,
    );
  }
  const next = [...alive, { text, kind, count: 1, shownAt: now, expiresAt: now + ms }];
  return next.length > TOAST_MAX ? next.slice(next.length - TOAST_MAX) : next;
}

/** Drops what has expired; the renderer calls it on a timer. */
export function pruneToasts(stack: readonly ToastEntry[], now: number): ToastEntry[] {
  return stack.filter((entry) => entry.expiresAt > now);
}

/**
 * SPEC-037 §4.3: every entry's expiry moved on by `ms` — the time the rack was
 * held for a dialogue on a short screen. Order, text, kind and counts are kept,
 * so a toast that queued behind the hold shows for its whole time afterwards.
 * A new array; the input is not written.
 */
export function shiftToasts(entries: readonly ToastEntry[], ms: number): ToastEntry[] {
  return entries.map((entry) => ({ ...entry, expiresAt: entry.expiresAt + ms }));
}

// ------------------------------------------------------------------- minimap

/** Enemies register on the minimap inside this range (SPEC-012 AC-59). */
export const MINIMAP_ENEMY_RANGE = 25;

/**
 * §4.12: nodes show for a scanner drone at level 2+ (its `nodeRadar` effect)
 * or the scout's class passive — whatever carries `nodeRadar`, in data terms.
 */
export function hasNodeRadar(save: Save): boolean {
  if (CLASS_TABLE[save.player.classId].passive.nodeRadar === true) return true;
  return save.companions.some((c) => {
    if (!c.enabled) return false;
    const effect = COMPANIONS[c.id].levels[c.level - 1] as CompanionEffect;
    return effect.nodeRadar === true;
  });
}

// ------------------------------------------------- SPEC-035: the readable view

/**
 * SPEC-037 §4.7 — a touch screen whose short side is under this is a phone
 * (*initial tuning*). A tablet is a monitor-sized screen that happens to be
 * touched, so it keeps the desktop distance.
 */
export const TOUCH_CAMERA_MAX_SHORT_SIDE = 500;

/**
 * SPEC-035 §4.2, SPEC-037 §4.7 — the distance `#placeCamera` eases toward: 17 m
 * on a touched phone, which shows the same view in a quarter of the physical
 * size, and 22 m everywhere else, a gamepad and a tablet included.
 */
export function cameraDistance(scheme: Scheme, shortSide: number): number {
  return scheme === 'touch' && shortSide < TOUCH_CAMERA_MAX_SHORT_SIDE ? 17 : 22;
}

/** SPEC-037 §4.7: the surface camera's vertical field of view never leaves this range, in degrees. */
export const FOV_MIN = 40;
export const FOV_MAX = 66;
/** Half the horizontal view the Hor+ rule keeps: `tan 24°`. */
const HOR_PLUS_HALF_TAN = Math.tan((24 * Math.PI) / 180);

/**
 * SPEC-037 §4.7 — Hor+: the vertical field of view, in degrees, that keeps the
 * horizontal one from dropping under 48° on a narrow screen —
 * `2·atan(tan 24° / aspect)`, clamped to [`FOV_MIN`, `FOV_MAX`]. Landscape
 * screens down to 1.22 : 1 keep the 40° they always had; an upright tablet
 * opens up to 61°, and 66° keeps the frame's top edge under the horizon at the
 * 55° pitch.
 */
export function cameraFov(aspect: number): number {
  if (!(aspect > 0)) return FOV_MAX;
  const fov = (2 * Math.atan(HOR_PLUS_HALF_TAN / aspect) * 180) / Math.PI;
  return Math.min(FOV_MAX, Math.max(FOV_MIN, fov));
}

// ------------------------------------------------- SPEC-037: the HUD for every screen

/** SPEC-037 §4.6: the least time between two rising edges of the damage flash, s (*initial tuning*). */
export const FLASH_MIN_GAP = 0.35;

export type { DamageFlashMode };

/**
 * SPEC-037 §4.6 — the photosensitivity gate (E71). A hit inside `minGap` of the
 * last rising edge extends the flash that is up rather than starting a new one,
 * so a flash rises at most once per 0.35 s — three times in any second, the
 * line the films already keep (E35). `'edge'` starts a new flash; `'extend'`
 * keeps the current one on.
 */
export function flashGate(lastEdgeAt: number, now: number, minGap: number = FLASH_MIN_GAP): 'edge' | 'extend' {
  return now - lastEdgeAt < minGap ? 'extend' : 'edge';
}

/**
 * SPEC-037 §4.4 — a weapon slot's state line: `HEAT 64%`, `LOCK`, or the
 * seconds left on a switch or a recharge (`2.4 s`). A slot that is ready — or
 * empty — prints nothing: `READY` was a word on every slot at rest.
 */
export function slotStateText(view: SlotView): string {
  switch (view.state) {
    case 'heat':
      return `HEAT ${Math.round(view.heat * 100)}%`;
    case 'lock':
      return 'LOCK';
    case 'recharge':
    case 'switch':
      return `${Math.max(0, view.cdSeconds).toFixed(1)} s`;
    case 'ready':
    case 'empty':
      return '';
  }
}

/** SPEC-037 §4.2: how long the wallet strip stays lit after a count moves, s. */
export const WALLET_LIT_SECONDS = 5;

/**
 * SPEC-037 §4.2 — the wallet strip is lit for `WALLET_LIT_SECONDS` after any
 * count changes, and for as long as a collect or deliver objective of the
 * tracked stage is open; dimmed to 0.6 otherwise.
 */
export function walletLit(lastChangeAt: number, now: number, collectOrDeliverOpen: boolean): boolean {
  return collectOrDeliverOpen || now - lastChangeAt < WALLET_LIT_SECONDS;
}

/**
 * §4.4: how far the linear fog spans past its near plane, per unit of exp²
 * density. An exp² density ρ reaches about 99 % opacity at ρ·d ≈ 2.15, so this
 * keeps each planet's distance mood while the play space stays clear.
 */
export const FOG_SPAN_K = 2.2;

/**
 * §4.4 — the surface's linear fog, from the player out: `near` is the camera's
 * own distance to its target, so nothing between the camera and the salvager is
 * ever hazed, and the span shortens as a storm thickens `fogMult`.
 */
export function surfaceFogRange(density: number, fogMult: number, camDistance: number): { near: number; far: number } {
  const near = Math.max(0, camDistance);
  const thickness = Math.max(1e-4, density * fogMult);
  return { near, far: near + FOG_SPAN_K / thickness };
}

/** §4.5: what a prop between the camera and the player fades to. */
export const OCCLUDER_OPACITY = 0.3;

/**
 * §4.5 — true when the segment from `camera` to the target's head (y 1.6)
 * passes inside the prop's cylinder: radius × 0.9 (a rock's silhouette is
 * narrower than its collision body), from the ground up to `height`.
 *
 * Pure, so `tests/ui/helpers.test.ts` can drive it without a scene: the scene
 * only supplies the camera, the player and each prop's footprint.
 */
export function occludes(
  camera: { x: number; y: number; z: number },
  target: { x: number; z: number },
  prop: { x: number; z: number; radius: number; height: number },
): boolean {
  const radius = prop.radius * 0.9;
  if (!(radius > 0) || !(prop.height > 0)) return false;
  const headY = 1.6;
  const dx = target.x - camera.x;
  const dz = target.z - camera.z;
  const dy = headY - camera.y;
  // The t-interval where the segment is inside the cylinder's circle.
  const ox = camera.x - prop.x;
  const oz = camera.z - prop.z;
  const a = dx * dx + dz * dz;
  const b = 2 * (ox * dx + oz * dz);
  const c = ox * ox + oz * oz - radius * radius;
  let lo: number;
  let hi: number;
  if (a <= 1e-9) {
    if (c > 0) return false;
    lo = 0;
    hi = 1;
  } else {
    const disc = b * b - 4 * a * c;
    if (disc <= 0) return false;
    const root = Math.sqrt(disc);
    lo = (-b - root) / (2 * a);
    hi = (-b + root) / (2 * a);
  }
  lo = Math.max(lo, 0);
  hi = Math.min(hi, 1);
  if (lo >= hi) return false;
  // …intersected with the t-interval where it is between the ground and the top.
  if (Math.abs(dy) <= 1e-9) return camera.y >= 0 && camera.y <= prop.height;
  const t0 = (0 - camera.y) / dy;
  const t1 = (prop.height - camera.y) / dy;
  const yLo = Math.max(lo, Math.min(t0, t1));
  const yHi = Math.min(hi, Math.max(t0, t1));
  return yLo < yHi;
}

// ------------------------------------------------------------ the shop's words

/** `120` / `1.15` / `0.9` — an upgrade metric's own value, without stray zeros. */
function metricValue(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(3)));
}

/** `+15 %` / `−10 %`, relative to `from`, with a real minus sign. */
function percentDelta(from: number, to: number): string {
  if (!(from > 0)) return `${metricValue(from)} → ${metricValue(to)}`;
  const percent = Math.round((to / from - 1) * 100);
  return `${percent < 0 ? '−' : '+'}${Math.abs(percent)} %`;
}

/** `heatMax` → `Heat max` — a camelCase key in sentence case (§4.12's fallback). */
function metricWords(metric: string): string {
  const words = metric.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * SPEC-035 §4.12 — an upgrade tier's effect in the player's words, so the shop
 * never prints a variable name (`speedMult 1 → 1.15`). An unknown metric falls
 * back to its key split into words, and `tests/ui/helpers.test.ts` fails if any
 * `UPGRADES` metric reaches that branch.
 */
export function upgradeDeltaText(metric: string, from: number, to: number): string {
  switch (metric) {
    case 'speedMult':
      return `Speed ${percentDelta(from, to)}`;
    case 'fuelMult':
      return `Fuel use ${percentDelta(from, to)}`;
    case 'hullHp':
      return `Hull ${metricValue(from)} → ${metricValue(to)}`;
    case 'shieldHp':
      return `Shield ${metricValue(from)} → ${metricValue(to)}`;
    case 'cargoCap':
      return `Cargo ${metricValue(from)} → ${metricValue(to)}`;
    case 'damage':
      return `Gun damage ${metricValue(from)} → ${metricValue(to)}`;
    case 'fireRate':
      return `Fire rate ${metricValue(from)} → ${metricValue(to)} /s`;
    default:
      return `${metricWords(metric)} ${metricValue(from)} → ${metricValue(to)}`;
  }
}

/** The metric keys `upgradeDeltaText` names outright — the fallback test's list. */
export const UPGRADE_METRIC_KEYS = ['speedMult', 'fuelMult', 'hullHp', 'shieldHp', 'cargoCap', 'damage', 'fireRate'] as const;

// -------------------------------------------------------------- tint contrast

/** `#rgb` / `#rrggbb` → 0–1 channels; anything else reads as black. */
function channels(hex: string): [number, number, number] {
  const raw = hex.trim().replace(/^#/, '');
  const full = raw.length === 3 ? raw.replace(/./g, (ch) => ch + ch) : raw;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return [0, 0, 0];
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255) as [number, number, number];
}

/** WCAG 2 relative luminance of a hex colour. */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = channels(hex).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * SPEC-035 §4.1 — the WCAG contrast ratio between two hex colours, 1 (equal) to
 * 21 (black on white). The enemy-tint invariant of `tests/data/content.test.ts`
 * asks for at least 3 against the planet's ground.
 */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * SPEC-037 §4.5 — an `rgba(r, g, b, a)` composited over an opaque `#rrggbb`,
 * as `#rrggbb`: what a translucent plate actually looks like over the ground,
 * which is what its text contrast has to be measured against. An `rgb()` or a
 * hex is opaque and comes back as itself; anything unreadable is black.
 */
export function compositeOver(rgba: string, ground: string): string {
  const under = channels(ground).map((c) => c * 255);
  const match = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?\s*\)/i.exec(rgba);
  const over = match === null ? channels(rgba).map((c) => c * 255) : [Number(match[1]), Number(match[2]), Number(match[3])];
  const alpha = match === null || match[4] === undefined ? 1 : Math.min(1, Math.max(0, Number(match[4])));
  const hex = over.map((value, i) => {
    const mixed = Math.round(value * alpha + (under[i] as number) * (1 - alpha));
    return Math.min(255, Math.max(0, mixed)).toString(16).padStart(2, '0');
  });
  return `#${hex.join('')}`;
}
