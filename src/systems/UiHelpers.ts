// The pure half of the UI layer (SPEC-014 §3, §6): every string the panels
// print and every diff the HUD flush runs, as plain functions over the save and
// the content tables. They live under `systems/` rather than `ui/` because the
// architecture rule of SPEC-001 §4 keeps tests on pure code — `tests/ui/`
// exercises this module, and `ui/` renders what it returns.
//
// Nothing here touches the DOM, `three`, or `Math.random`, and nothing mutates
// its inputs except the two mission helpers, which edit the save the way every
// `systems/` class does (SPEC-010's `Economy` is the model).
import { maxHp, type Save, type SlotSummary } from '@/core/Save';
import {
  CLASSES,
  COMPANIONS,
  ITEMS,
  MISSIONS,
  PLANETS,
  RESOURCE_IDS,
  TUNING,
  UPGRADES,
  type Attributes,
  type ClassId,
  type ItemId,
  type CompanionEffect,
  type MissionDef,
  type MissionId,
  type Price,
  type Requirement,
  type ResourceId,
  type WeatherId,
} from '@/data/index';
import { discountTokens, missingRequirements, type DepartResult, type FailReason } from '@/systems/Economy';
import type { SlotView } from '@/systems/Loadout';
import { campaignLocked } from '@/systems/Missions';
import type { Class, Item, QuickSlot, WeaponSlot } from '@/data/index';

// The schema-typed views of the content tables: on the `as const` literal types
// an absent optional — a class with no `damageMult` — is not a property at all
// (the same pattern `systems/Economy.ts` uses).
const CLASS_TABLE: Readonly<Record<ClassId, Class>> = CLASSES;
const ITEM_TABLE: Readonly<Record<ItemId, Item>> = ITEMS;

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
  if (passive.shipTokenDiscount !== undefined) parts.push(`−${Math.round(passive.shipTokenDiscount * 100)}% ship prices`);
  if (passive.companionEffectMult !== undefined) parts.push(`${pct(passive.companionEffectMult)} companion effect`);
  if (passive.moveSpeedMult !== undefined) parts.push(`${pct(passive.moveSpeedMult)} move speed`);
  if (passive.pickupRadiusMult !== undefined) parts.push(`${pct(passive.pickupRadiusMult)} pickup radius`);
  if (passive.nodeRadar === true) parts.push('resource radar');
  return parts.join(' · ');
}

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
 * SPEC-031 §4.16: the gear card's stat block, one line per stat. Weapons carry
 * damage, fire rate, the DPS the two multiply to, range, projectile speed,
 * pierce and the cooldown model in words; armor its two numbers; consumables
 * the effect and the stack.
 */
export function gearStatLines(id: ItemId): readonly string[] {
  const item = ITEM_TABLE[id];
  if (item.kind === 'weapon') {
    return [
      `Damage ${item.damage}`,
      `Fire rate ${item.fireRate}/s`,
      `DPS ${Math.round(item.damage * item.fireRate)}`,
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
  if (effect.shopDiscount !== undefined) parts.push(`−${Math.round(effect.shopDiscount * 100)}% gear and craft prices`);
  if (effect.shieldRegen !== undefined) parts.push(`+${effect.shieldRegen}/s shield regen`);
  if (effect.autoAim === true) parts.push('auto-aim');
  if (effect.hullBonus !== undefined) parts.push(`+${effect.hullBonus} hull`);
  return parts.join(' · ');
}

/** The rewards line of a mission row (§4.3): XP, tokens, resources, items. */
export function rewardsText(rewards: MissionDef['rewards'], replay = false): string {
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

/** Drops the mission from the active list; false when it was not running. */
export function abandonMission(save: Save, id: MissionId): boolean {
  const at = save.progress.missionsActive.findIndex((entry) => entry.id === id);
  if (at < 0) return false;
  save.progress.missionsActive.splice(at, 1);
  return true;
}

// -------------------------------------------------------------- player stats

/**
 * The creation screen's live preview (§4.2). SPEC-011 owns the real combat
 * formula; until it lands this is the same kind of placeholder `maxHp` is
 * (SPEC-007 §4.1), built from the attribute effects `data/characters.ts`
 * documents: might +4 % damage per point, agility +2 % speed, vigor through
 * `maxHp`, plus the class passives.
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
    hp: maxHp(classId, attributes, level) + (cls.passive.maxHpBonus ?? 0),
    damage: Math.round(base * (1 + 0.04 * attributes.might) * (cls.passive.damageMult ?? 1) * 10) / 10,
    speed: Math.round(TUNING.PLAYER_SPEED * (1 + 0.02 * attributes.agility) * (cls.passive.moveSpeedMult ?? 1) * 100) / 100,
  };
}

/**
 * AC-47: the compare line between the equipped piece and a candidate — tier
 * first, then every stat that moves, signed. Same-*line* items only (SPEC-025
 * §4.8): tiers are only comparable inside one ladder, so a rifle against a
 * handgun compares nothing, exactly as a weapon against armor does.
 */
export function gearCompareText(equipped: ItemId, candidate: ItemId): string {
  const a = ITEM_TABLE[equipped];
  const b = ITEM_TABLE[candidate];
  if (a.kind === 'consumable' || b.kind === 'consumable' || a.line !== b.line) return '';
  const parts: string[] = [];
  const delta = (label: string, from: number, to: number): void => {
    if (from !== to) parts.push(`${label} ${from} → ${to}`);
  };
  if (a.kind === 'weapon' && b.kind === 'weapon') {
    parts.push(`T${a.tier} → T${b.tier}`);
    delta('damage', a.damage, b.damage);
    delta('fire rate', a.fireRate, b.fireRate);
    delta('range', a.range, b.range);
    delta('pierce', a.pierce, b.pierce);
  } else if (a.kind === 'armor' && b.kind === 'armor') {
    parts.push(`T${a.tier} → T${b.tier}`);
    delta('armor', a.armor, b.armor);
    delta('hazard resist', a.hazardResist, b.hazardResist);
  } else {
    return '';
  }
  return parts.join(' · ');
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
  boss: { name: string; hp: number; max: number } | null;
  /** SPEC-028 §3: the quick bar's two halves; both `null` off the surface. */
  loadout: { active: WeaponSlot; slots: Record<WeaponSlot, SlotView>; fallback: boolean } | null;
  quick: Record<QuickSlot, { itemId: ItemId | null; qty: number }> | null;
  interact: string | null;
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
    loadout: null,
    quick: null,
    interact: null,
  };
}

/** Structural equality over the plain values a `HudModel` holds. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((value, i) => same(value, b[i]));
  }
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((key) => same((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

/**
 * The changed top-level keys between two models (§4.5, AC-62). Pure; an empty
 * set is the contract that `flush()` writes nothing to the DOM that frame.
 */
export function diffHud(prev: HudModel, next: HudModel): Set<HudKey> {
  const changed = new Set<HudKey>();
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)] as HudKey[]);
  for (const key of keys) {
    if (!same(prev[key], next[key])) changed.add(key);
  }
  return changed;
}

/** A deep copy, for the "last rendered" side of the diff. */
export function cloneHud(model: HudModel): HudModel {
  return structuredClone(model);
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
