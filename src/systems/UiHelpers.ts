// The pure half of the UI layer (SPEC-014 §3, §6): every string the panels
// print and every diff the HUD flush runs, as plain functions over the save and
// the content tables. They live under `systems/` rather than `ui/` because the
// architecture rule of SPEC-001 §4 keeps tests on pure code — `tests/ui/`
// exercises this module, and `ui/` renders what it returns.
//
// Nothing here touches the DOM, `three`, or `Math.random`, and nothing mutates
// its inputs except the two mission helpers, which edit the save the way every
// `systems/` class does (SPEC-010's `Economy` is the model).
import { maxHp, type SaveV1, type SlotSummary } from '@/core/Save';
import {
  CLASSES,
  ITEMS,
  MISSIONS,
  PLANETS,
  TUNING,
  UPGRADES,
  type Attributes,
  type ClassId,
  type ItemId,
  type MissionDef,
  type MissionId,
  type Price,
  type Requirement,
  type ResourceId,
  type WeatherId,
} from '@/data/index';
import { discountTokens, missingRequirements, type DepartResult } from '@/systems/Economy';
import type { Class, Item } from '@/data/index';

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
 * `"40 → 34"` (§4.3): the base token price and what this save actually pays,
 * via the same `discountTokens` the purchase runs (SPEC-010 §4.2), so the label
 * can never disagree with the charge. Undiscounted resource costs are appended
 * (`" + 60 lithium"`); a price of nothing at all is `"Free"`.
 */
export function priceText(price: Price, discount: number): string {
  const parts: string[] = [];
  if (price.tokens > 0) {
    const paid = discountTokens(price.tokens, discount);
    parts.push(paid < price.tokens ? `${price.tokens} → ${paid}` : `${price.tokens}`);
  }
  for (const [resource, amount] of Object.entries(price.resources ?? {})) {
    if ((amount ?? 0) > 0) parts.push(`${amount} ${resource}`);
  }
  return parts.length === 0 ? 'Free' : parts.join(' + ');
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
 */
export function missionStatus(save: SaveV1, def: MissionDef, scene: MissionScene): MissionStatus {
  if (save.progress.missionsActive.some((entry) => entry.id === def.id)) return 'active';
  if ((save.progress.missionsDone as readonly string[]).includes(def.id)) {
    return scene === 'station' ? 'replayable' : 'done';
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
export function acceptMission(save: SaveV1, def: MissionDef): boolean {
  if (save.progress.missionsActive.some((entry) => entry.id === def.id)) return false;
  save.progress.missionsActive.push({ id: def.id as MissionId, stage: 0, counters: {} });
  return true;
}

/** Drops the mission from the active list; false when it was not running. */
export function abandonMission(save: SaveV1, id: MissionId): boolean {
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

// ------------------------------------------------------------------ HUD diff

/**
 * Everything the HUD draws in a frame (SPEC-014 §3). Systems write fields;
 * `Hud.flush()` diffs against the last rendered copy and touches only what
 * moved. `flight` is present only in flight mode.
 */
export interface HudModel {
  hp: [number, number];
  xp: [number, number];
  level: number;
  tokens: number;
  resources: Record<ResourceId, number>;
  cargoCap: number;
  objective: { title: string; line: string; value: number; target: number } | null;
  weather: { warning: WeatherId | null; active: WeatherId | null; secondsLeft: number };
  boss: { name: string; hp: number; max: number } | null;
  consumable: { itemId: ItemId; qty: number } | null;
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
    weather: { warning: null, active: null, secondsLeft: 0 },
    boss: null,
    consumable: null,
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
