// Save, slots and storage (SPEC-007). An offline game lives or dies by its
// save, so every rule here is about a write that might not land: Safari evicts
// site storage after seven days, quotas overflow silently, tabs get killed
// mid-mission and a second tab of the same game overwrites the first.
//
// Four properties the rest of the engine leans on:
//   - `update()` never writes. It asks, through `request(reason)`; the write
//     happens in `tick()` after render, or synchronously in `flush()` when the
//     page is going away (§4.5, the anti-corruption rule of SPEC-002 §3.6).
//   - every write keeps the previous good JSON in a `:bak` key and reads back
//     what it wrote, because Safari truncates at quota without throwing (§4.2).
//   - nothing here throws at the player. Storage that is missing, full or
//     corrupt degrades to a memory-only session with a banner and a toast; the
//     only exception is `exportCode`, whose promise rejects (§4.6, E8).
//   - `validateSave` rebuilds the save field by field, so unknown keys are
//     stripped and unknown ids are dropped rather than trusted (§4.4).
//
// `core/` may not import `ui/` (SPEC-001 §4), so every player-facing message is
// a `ui:toast` event and the texts are exported constants the UI and the tests
// share. Nothing here reaches for `three`, `systems/`, `scenes/` or `ui/`.
import type { EmitArgs, GameEvents } from '@/core/Events';
import { log } from '@/core/Log';
import {
  CLASS_IDS,
  COMPANION_IDS,
  PLANET_IDS,
  RESOURCE_IDS,
  SHIP_SYSTEMS,
  type ClassId,
  type CompanionId,
  type ItemId,
  type MissionId,
  type PlanetId,
  type ResourceId,
  type ShipSystem,
} from '@/data/ids';
import { TUNING } from '@/data/tuning';

export const SAVE_VERSION = 1 as const;

/** `reallm:slot:{n}` and `reallm:slot:{n}:bak`; settings live in their own key. */
export const SLOT_KEY_PREFIX = 'reallm:slot:';
export const BAK_SUFFIX = ':bak';
/** Written and removed once at construction to detect availability (§3). */
export const PROBE_KEY = 'reallm:probe';
export const SLOTS = [0, 1, 2] as const;
export type SlotId = (typeof SLOTS)[number];

/** §4.5: how long a debounced request waits before `tick()` writes it. */
export const AUTOSAVE_DEBOUNCE_MS = 500;
/** §4.2: past this the save is logged as suspicious — and still written. */
export const LARGE_SAVE_BYTES = 500_000;
/**
 * 07-c: the longest a pending write is held for a scene swap. A transition that
 * ends by throwing on both the scene and the menu fallback never emits
 * `scene:entered` (SPEC-003 §4), and a hold with no end would silently stop
 * autosaving for the rest of the session.
 */
export const TRANSITION_HOLD_MAX_MS = 10_000;
/** §4.7: the Home Screen hint is never shown twice inside this window. */
export const INSTALL_HINT_INTERVAL_MS = 14 * 24 * 60 * 60 * 1000;

/** The player-facing texts of §4.2, §4.3, §4.6 and E8. */
export const SAVE_FAILED_TEXT = 'Save failed — export your save code';
export const BACKUP_RESTORED_TEXT = 'Restored backup save';
export const STORAGE_UNAVAILABLE_TEXT = 'Storage is unavailable — this run will not be saved. Export your code to keep it.';
export const CROSS_TAB_TEXT = 'Save changed in another tab';
export const CODE_DAMAGED_TEXT = 'Code is damaged';
export const CODE_NEWER_TEXT = 'Code is from a newer version';
export const CODE_NOT_REALLM_TEXT = 'Not a ReaLLM save';
export const CODES_UNSUPPORTED_TEXT = 'Save codes need a newer browser';
export const INSTALL_HINT_TEXT =
  'Add to Home Screen to keep saves safe (Safari clears site data after 7 days unused)';

/** Every safe point that may ask for a write (§4.5). */
export type SaveReason =
  | 'new'
  | 'station_enter'
  | 'landing'
  | 'stage'
  | 'mission'
  | 'purchase'
  | 'settings'
  | 'pagehide'
  | 'manual'
  | 'checkpoint';

/** The two reasons that skip the debounce entirely (§4.5). */
const IMMEDIATE_REASONS: readonly SaveReason[] = ['pagehide', 'manual'];

// ------------------------------------------------------------------- schema

export interface SaveV1 {
  version: 1;
  meta: {
    slot: SlotId;
    seed: number;
    createdAt: number;
    updatedAt: number;
    playtimeSec: number;
    difficulty: 'casual' | 'normal';
    /** 1 in v1; the NG+ "Iteration 63" of PLAN §5 is deferred. */
    iteration: number;
    appVersion: string;
  };
  player: {
    name: string;
    classId: ClassId;
    /** Colours as `'#rrggbb'`. */
    appearance: { portrait: number; primary: string; secondary: string };
    attributes: { might: number; vigor: number; agility: number; tech: number };
    level: number;
    xp: number;
    tokens: number;
    hp: number;
  };
  resources: Record<ResourceId, number>;
  inventory: { itemId: ItemId; qty: number }[];
  equipped: { weapon: ItemId; armor: ItemId };
  ship: Record<ShipSystem, 0 | 1 | 2 | 3>;
  companions: { id: CompanionId; level: 1 | 2 | 3; enabled: boolean }[];
  progress: {
    missionsDone: MissionId[];
    /** `counters` is keyed `${stage}:${objectiveIndex}` (SPEC-012). */
    missionsActive: { id: MissionId; stage: number; counters: Record<string, number> }[];
    flags: string[];
    currentPlanet: PlanetId | null;
    location: 'station' | 'surface';
    /** `${planet}:${poi}:${instance}`. */
    poisDiscovered: string[];
    /** Runtime RNG re-seeding (SPEC-008). */
    visits: Partial<Record<PlanetId, number>>;
    endingSeen: boolean;
  };
}

export interface SlotSummary {
  slot: SlotId;
  empty: boolean;
  name?: string;
  classId?: ClassId;
  level?: number;
  planet?: PlanetId | null;
  playtimeSec?: number;
  /** 07-b: displayed as stored, even when it is in the future. Never logic. */
  updatedAt?: number;
  corrupt?: boolean;
}

/**
 * Defined here rather than in `data/characters.ts`, which is one of SPEC-009's
 * content tables: from `data`, `core` reads only the id unions and the tuning
 * constants (SPEC-001 §4). SPEC-014 builds the creation UI that fills it in.
 */
export interface CharacterCreation {
  name: string;
  classId: ClassId;
  appearance: { portrait: number; primary: string; secondary: string };
  attributes: { might: number; vigor: number; agility: number; tech: number };
  difficulty: 'casual' | 'normal';
}

export type LoadResult =
  | { ok: true; data: SaveV1; migratedFrom?: number; source: 'main' | 'bak' }
  | { ok: false; reason: 'empty' | 'corrupt' | 'newer_version' | 'unavailable'; errors?: string[]; foundVersion?: number };

// ------------------------------------------------------------------ content

type Attributes = SaveV1['player']['attributes'];

/**
 * The id universe `validateSave` checks a save against (§4.4). It is a
 * parameter rather than a set of imports because the tables it names belong to
 * other specs: SPEC-009 lands items, gear and flags, SPEC-012 lands the mission
 * stage lists. `SAVE_CONTENT` below is the PLAN-locked placeholder they
 * replace; the seam does not move when they do.
 */
export interface SaveContent {
  readonly items: readonly ItemId[];
  readonly weapons: readonly ItemId[];
  readonly armors: readonly ItemId[];
  /** Mission id → how many stages it has, for the `stage` clamp of §4.4. */
  readonly missions: Readonly<Record<MissionId, number>>;
  readonly flags: readonly string[];
  readonly classBase: Readonly<Record<ClassId, Attributes>>;
  /** SPEC-009 §4.2: the weapon a class starts with. */
  readonly starterWeapon: Readonly<Record<ClassId, ItemId>>;
  readonly starterArmor: ItemId;
}

/** PLAN §4: kinetic → laser → plasma → lithium-edged. */
const WEAPON_IDS = ['weapon_kinetic', 'weapon_laser', 'weapon_plasma', 'weapon_lithium'] as const;
/** PLAN §4: scrap → composite → reactive → ablative. */
const ARMOR_IDS = ['armor_scrap', 'armor_composite', 'armor_reactive', 'armor_ablative'] as const;
/** PLAN §4: the three station recipes. */
const CRAFTED_IDS = ['wheat_ration', 'medkit', 'coolant_pack'] as const;

/** The starting armor of §4.1 and the fallback of §4.4. */
export const STARTER_ARMOR: ItemId = 'armor_scrap';
/** The three rations a fresh save carries (§4.1). */
export const WHEAT_RATION: ItemId = 'wheat_ration';

/**
 * PLAN §6, chapter by chapter: mission id → stage count, counted from the
 * `[…] → […]` chains of the chapter tables. SPEC-012 owns the real stage
 * lists; only the count matters here, for the `stage` clamp of §4.4.
 */
const MISSION_STAGES: Record<string, number> = {
  c1_m1: 3,
  c1_m2: 1,
  c1_m3: 2,
  c2_m1: 2,
  c2_m2: 1,
  c2_m3: 2,
  c3_m1: 2,
  c3_m2: 2,
  c3_m3: 1,
  c4_m1: 2,
  c4_m2: 1,
  c4_m3: 2,
  c5_m1: 1,
  c5_m2: 1,
  c5_m3: 1,
  c6_m1: 3,
  c6_m2: 2,
};

/** The story flags PLAN §5 and §6 name. SPEC-009's content test owns the rest. */
const FLAG_IDS = [
  'c1_oil',
  'chapter1_done',
  'chapter2_done',
  'chapter3_done',
  'chapter4_done',
  'chapter5_done',
  'signal_decoded',
  'campaign_done',
  'ending_stay',
  'ending_escape',
] as const;

/**
 * PLAN §4: eight points of class base, then five allocated at creation. The
 * split expresses each class's bias — Marine damage/HP, Engineer tech, Scout
 * speed — and is *initial tuning*: SPEC-009 may retune it without a PLAN entry.
 */
const CLASS_BASE: Record<ClassId, Attributes> = {
  marine: { might: 3, vigor: 3, agility: 1, tech: 1 },
  engineer: { might: 1, vigor: 2, agility: 1, tech: 4 },
  scout: { might: 2, vigor: 1, agility: 4, tech: 1 },
};

/** SPEC-009 §4.2 owns the real per-class table; every class starts at tier 0. */
const CLASS_STARTER_WEAPON: Record<ClassId, ItemId> = {
  marine: 'weapon_kinetic',
  engineer: 'weapon_kinetic',
  scout: 'weapon_kinetic',
};

export const SAVE_CONTENT: SaveContent = {
  items: [...WEAPON_IDS, ...ARMOR_IDS, ...CRAFTED_IDS],
  weapons: WEAPON_IDS,
  armors: ARMOR_IDS,
  missions: MISSION_STAGES,
  flags: FLAG_IDS,
  classBase: CLASS_BASE,
  starterWeapon: CLASS_STARTER_WEAPON,
  starterArmor: STARTER_ARMOR,
};

/** PLAN §4: 5 points over the class base, allocated at creation only. */
export const CREATION_POINTS = 5;

/**
 * PLAN §4: 400 base, ship cargo tiers 600 / 800 / 1200. The per-resource cap
 * `validateSave` clamps to (§4.4) and SPEC-010 charges pickups against.
 */
const CARGO_BY_TIER: readonly number[] = [TUNING.CARGO_BASE, 600, 800, 1200];

export function cargoCap(ship: Pick<SaveV1['ship'], 'cargo'>): number {
  return CARGO_BY_TIER[ship.cargo] ?? TUNING.CARGO_BASE;
}

/**
 * PLAN §4: base HP, `vigor` scales it, each level grants a flat +4. A
 * placeholder for SPEC-011's `computePlayerStats`, which owns the real formula
 * — SPEC-007 needs it only to seed `player.hp` (§4.1) and to clamp it (§4.4).
 */
export function maxHp(_classId: ClassId, attributes: Attributes, level: number): number {
  return TUNING.PLAYER_BASE_HP + attributes.vigor * 10 + (level - 1) * 4;
}

// --------------------------------------------------------------- fresh save

/** Vite replaces the identifier at build time; node test runs fall back (§3). */
const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0';

const DEFAULT_NAME = 'Salvager';
const NAME_MAX = 16;
const DEFAULT_COLOR = '#c8c8c8';
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** The starting stock of §4.1: oil 60, wheat 20, water 20, lithium 0. */
export const STARTING_RESOURCES: Readonly<Record<ResourceId, number>> = {
  oil: TUNING.START_OIL,
  wheat: 20,
  water: 20,
  lithium: 0,
};

export function newSave(slot: SlotId, creation: CharacterCreation, seed: number, now: number): SaveV1 {
  const attributes = { ...creation.attributes };
  const level = 1;
  return {
    version: SAVE_VERSION,
    meta: {
      slot,
      seed: seed >>> 0,
      createdAt: now,
      updatedAt: now,
      playtimeSec: 0,
      difficulty: creation.difficulty,
      iteration: 1,
      appVersion: APP_VERSION,
    },
    player: {
      name: creation.name,
      classId: creation.classId,
      appearance: { ...creation.appearance },
      attributes,
      level,
      xp: 0,
      tokens: 0,
      hp: maxHp(creation.classId, attributes, level),
    },
    resources: { ...STARTING_RESOURCES },
    inventory: [{ itemId: WHEAT_RATION, qty: 3 }],
    equipped: { weapon: SAVE_CONTENT.starterWeapon[creation.classId], armor: SAVE_CONTENT.starterArmor },
    ship: { engine: 0, hull: 0, shield: 0, cargo: 0, weapon: 0 },
    companions: [{ id: 'aria', level: 1, enabled: true }],
    progress: {
      missionsDone: [],
      missionsActive: [],
      flags: [],
      currentPlanet: null,
      location: 'station',
      poisDiscovered: [],
      visits: {},
      endingSeen: false,
    },
  };
}

// --------------------------------------------------------------- validation

type Bag = Record<string, unknown>;

function isBag(value: unknown): value is Bag {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bagAt(parent: Bag, key: string): Bag {
  const value = parent[key];
  return isBag(value) ? value : {};
}

function arrayAt(parent: Bag, key: string): unknown[] {
  const value = parent[key];
  return Array.isArray(value) ? value : [];
}

/** A finite number, or `fallback`. Never `NaN`, never `Infinity`. */
function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function int(value: unknown, fallback: number, low: number, high: number): number {
  return clamp(Math.round(num(value, fallback)), low, high);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function color(value: unknown): string {
  return typeof value === 'string' && HEX_COLOR.test(value) ? value.toLowerCase() : DEFAULT_COLOR;
}

/** §4.4: 1..16 characters after trimming; anything else is `'Salvager'`. */
export function normalizeName(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_NAME;
  const trimmed = value.trim().slice(0, NAME_MAX).trim();
  return trimmed.length === 0 ? DEFAULT_NAME : trimmed;
}

/**
 * §4.4: rebuilds the save field by field against `content`, clamping ranges and
 * dropping ids it does not know. Extra keys never survive, because nothing is
 * copied across — every field is read out and written into a fresh object.
 * Never throws: a save it cannot rebuild at all comes back as `errors`.
 */
export function validateSave(
  raw: unknown,
  content: SaveContent = SAVE_CONTENT,
): { ok: true; data: SaveV1; warnings: string[] } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  try {
    if (!isBag(raw)) return { ok: false, errors: ['save: not an object'] };
    if (raw['version'] !== SAVE_VERSION) {
      return { ok: false, errors: [`version: expected ${SAVE_VERSION}, found ${JSON.stringify(raw['version'])}`] };
    }

    const rawMeta = bagAt(raw, 'meta');
    const rawPlayer = bagAt(raw, 'player');
    const classId = oneOf(rawPlayer['classId'], CLASS_IDS, 'marine');
    if (rawPlayer['classId'] !== classId) {
      // The character's identity: a save that does not name a class we ship is
      // not a save we can rebuild, only guess at.
      return { ok: false, errors: [`player.classId: unknown class ${JSON.stringify(rawPlayer['classId'])}`] };
    }

    const meta = validateMeta(rawMeta, warnings);
    const player = validatePlayer(rawPlayer, classId, content, warnings);
    const ship = validateShip(bagAt(raw, 'ship'), warnings);
    const cap = cargoCap(ship);
    const resources = validateResources(bagAt(raw, 'resources'), cap, warnings);
    const inventory = validateInventory(arrayAt(raw, 'inventory'), content, warnings);
    const equipped = validateEquipped(bagAt(raw, 'equipped'), classId, content, warnings);
    const companions = validateCompanions(arrayAt(raw, 'companions'), warnings);
    const progress = validateProgress(bagAt(raw, 'progress'), content, warnings);

    // The hp cap depends on the rebuilt attributes and level, so it lands here.
    const cap2 = maxHp(classId, player.attributes, player.level);
    if (player.hp > cap2 || player.hp < 0) {
      warnings.push(`player.hp: ${player.hp} clamped to 0..${cap2}`);
      player.hp = clamp(player.hp, 0, cap2);
    }

    return {
      ok: true,
      data: { version: SAVE_VERSION, meta, player, resources, inventory, equipped, ship, companions, progress },
      warnings,
    };
  } catch (error) {
    // §4.4: the result never throws, whatever shape the stored JSON has.
    errors.push(`save: ${String(error)}`);
    return { ok: false, errors };
  }
}

function validateMeta(raw: Bag, warnings: string[]): SaveV1['meta'] {
  const slot = int(raw['slot'], 0, 0, 2) as SlotId;
  if (raw['slot'] !== slot) warnings.push(`meta.slot: ${JSON.stringify(raw['slot'])} clamped to ${slot}`);
  const iteration = int(raw['iteration'], 1, 1, 99);
  if (raw['iteration'] !== iteration) {
    warnings.push(`meta.iteration: ${JSON.stringify(raw['iteration'])} clamped to ${iteration}`);
  }
  return {
    slot,
    seed: num(raw['seed'], 0) >>> 0,
    createdAt: Math.max(0, num(raw['createdAt'], 0)),
    // 07-b: an `updatedAt` in the future is kept exactly as stored. It is shown
    // in the slot list and used for nothing else, so a skewed clock cannot
    // change which save loads or whether one is written.
    updatedAt: Math.max(0, num(raw['updatedAt'], 0)),
    playtimeSec: Math.max(0, num(raw['playtimeSec'], 0)),
    difficulty: oneOf(raw['difficulty'], ['casual', 'normal'] as const, 'normal'),
    iteration,
    appVersion: typeof raw['appVersion'] === 'string' ? raw['appVersion'] : APP_VERSION,
  };
}

function validatePlayer(raw: Bag, classId: ClassId, content: SaveContent, warnings: string[]): SaveV1['player'] {
  const name = normalizeName(raw['name']);
  if (name !== raw['name']) warnings.push(`player.name: ${JSON.stringify(raw['name'])} normalised to "${name}"`);
  const level = int(raw['level'], 1, 1, TUNING.LEVEL_CAP);
  if (raw['level'] !== level) warnings.push(`player.level: ${JSON.stringify(raw['level'])} clamped to ${level}`);
  const appearance = bagAt(raw, 'appearance');
  const attributes = validateAttributes(bagAt(raw, 'attributes'), classId, content, warnings);
  return {
    name,
    classId,
    appearance: {
      portrait: int(appearance['portrait'], 0, 0, 999),
      primary: color(appearance['primary']),
      secondary: color(appearance['secondary']),
    },
    attributes,
    level,
    xp: Math.max(0, Math.round(num(raw['xp'], 0))),
    tokens: Math.max(0, Math.round(num(raw['tokens'], 0))),
    hp: Math.max(0, Math.round(num(raw['hp'], 0))),
  };
}

/**
 * §4.4: the class base is a floor (the points are *added* at creation) and the
 * total may exceed it by at most `CREATION_POINTS`. The surplus is handed out
 * in field order, so a save that asked for too much keeps its first choices
 * instead of being rescaled into something the player never picked.
 */
function validateAttributes(raw: Bag, classId: ClassId, content: SaveContent, warnings: string[]): Attributes {
  const base = content.classBase[classId];
  const keys = ['might', 'vigor', 'agility', 'tech'] as const;
  const out: Attributes = { ...base };
  let budget = CREATION_POINTS;
  let changed = false;
  for (const key of keys) {
    const asked = int(raw[key], base[key], 0, 99);
    const over = Math.max(0, asked - base[key]);
    const give = Math.min(over, budget);
    budget -= give;
    out[key] = base[key] + give;
    if (out[key] !== asked) changed = true;
  }
  if (changed) {
    const total = base.might + base.vigor + base.agility + base.tech + CREATION_POINTS;
    warnings.push(`player.attributes: clamped to the class base plus ${CREATION_POINTS} (${total} total)`);
  }
  return out;
}

function validateShip(raw: Bag, warnings: string[]): SaveV1['ship'] {
  const out = {} as SaveV1['ship'];
  for (const system of SHIP_SYSTEMS) {
    const tier = int(raw[system], 0, 0, 3) as 0 | 1 | 2 | 3;
    if (raw[system] !== undefined && raw[system] !== tier) {
      warnings.push(`ship.${system}: ${JSON.stringify(raw[system])} clamped to ${tier}`);
    }
    out[system] = tier;
  }
  return out;
}

function validateResources(raw: Bag, cap: number, warnings: string[]): SaveV1['resources'] {
  const out = {} as SaveV1['resources'];
  for (const resource of RESOURCE_IDS) {
    const held = clamp(Math.round(num(raw[resource], 0)), 0, cap);
    if (raw[resource] !== undefined && raw[resource] !== held) {
      warnings.push(`resources.${resource}: ${JSON.stringify(raw[resource])} clamped to 0..${cap}`);
    }
    out[resource] = held;
  }
  for (const key of Object.keys(raw)) {
    if (!(RESOURCE_IDS as readonly string[]).includes(key)) warnings.push(`resources.${key}: unknown resource dropped`);
  }
  return out;
}

function validateInventory(raw: unknown[], content: SaveContent, warnings: string[]): SaveV1['inventory'] {
  const byId = new Map<ItemId, number>();
  for (const entry of raw) {
    if (!isBag(entry)) continue;
    const itemId = entry['itemId'];
    if (typeof itemId !== 'string' || !content.items.includes(itemId)) {
      warnings.push(`inventory: unknown item ${JSON.stringify(itemId)} dropped`);
      continue;
    }
    const qty = Math.round(num(entry['qty'], 0));
    if (qty <= 0) {
      warnings.push(`inventory.${itemId}: quantity ${JSON.stringify(entry['qty'])} dropped`);
      continue;
    }
    const already = byId.get(itemId);
    if (already !== undefined) warnings.push(`inventory.${itemId}: duplicate entries merged`);
    byId.set(itemId, (already ?? 0) + qty);
  }
  return [...byId].map(([itemId, qty]) => ({ itemId, qty }));
}

function validateEquipped(raw: Bag, classId: ClassId, content: SaveContent, warnings: string[]): SaveV1['equipped'] {
  const weapon = raw['weapon'];
  const armor = raw['armor'];
  const okWeapon = typeof weapon === 'string' && content.weapons.includes(weapon);
  const okArmor = typeof armor === 'string' && content.armors.includes(armor);
  if (!okWeapon) warnings.push(`equipped.weapon: unknown ${JSON.stringify(weapon)} fell back to the class starter`);
  if (!okArmor) warnings.push(`equipped.armor: unknown ${JSON.stringify(armor)} fell back to the class starter`);
  return {
    weapon: okWeapon ? weapon : content.starterWeapon[classId],
    armor: okArmor ? armor : content.starterArmor,
  };
}

function validateCompanions(raw: unknown[], warnings: string[]): SaveV1['companions'] {
  const seen = new Set<CompanionId>();
  const out: SaveV1['companions'] = [];
  for (const entry of raw) {
    if (!isBag(entry)) continue;
    const id = entry['id'];
    if (typeof id !== 'string' || !(COMPANION_IDS as readonly string[]).includes(id)) {
      warnings.push(`companions: unknown companion ${JSON.stringify(id)} dropped`);
      continue;
    }
    const companionId = id as CompanionId;
    if (seen.has(companionId)) {
      warnings.push(`companions.${companionId}: duplicate dropped`);
      continue;
    }
    seen.add(companionId);
    out.push({
      id: companionId,
      level: int(entry['level'], 1, 1, 3) as 1 | 2 | 3,
      enabled: entry['enabled'] !== false,
    });
  }
  return out;
}

/**
 * The stage count of a mission the save *names*, or `undefined` for anything
 * that is not one of ours. Plain-indexing the table would resolve inherited
 * keys, so `'toString'` and `'constructor'` would read as real missions and
 * carry a function into the `stage` clamp of §4.4; the id universe is only the
 * table's own keys.
 */
function missionStages(content: SaveContent, id: unknown): number | undefined {
  if (typeof id !== 'string' || !Object.hasOwn(content.missions, id)) return undefined;
  const stages = (content.missions as Readonly<Record<string, unknown>>)[id];
  return typeof stages === 'number' && Number.isFinite(stages) ? stages : undefined;
}

function validateProgress(raw: Bag, content: SaveContent, warnings: string[]): SaveV1['progress'] {
  const missionsDone = uniqueStrings(arrayAt(raw, 'missionsDone')).filter((id) => {
    if (missionStages(content, id) !== undefined) return true;
    warnings.push(`progress.missionsDone: unknown mission ${JSON.stringify(id)} dropped`);
    return false;
  });
  const done = new Set(missionsDone);

  const missionsActive: SaveV1['progress']['missionsActive'] = [];
  const activeSeen = new Set<MissionId>();
  for (const entry of arrayAt(raw, 'missionsActive')) {
    if (!isBag(entry)) continue;
    const id = entry['id'];
    const stages = missionStages(content, id);
    if (typeof id !== 'string' || stages === undefined) {
      warnings.push(`progress.missionsActive: unknown mission ${JSON.stringify(id)} dropped`);
      continue;
    }
    if (done.has(id)) {
      warnings.push(`progress.missionsActive: ${id} is already done and was dropped`);
      continue;
    }
    if (activeSeen.has(id)) {
      warnings.push(`progress.missionsActive: duplicate ${id} dropped`);
      continue;
    }
    activeSeen.add(id);
    const stage = int(entry['stage'], 0, 0, stages - 1);
    if (entry['stage'] !== stage) {
      warnings.push(`progress.missionsActive.${id}.stage: clamped to 0..${stages - 1}`);
    }
    missionsActive.push({ id, stage, counters: validateCounters(bagAt(entry, 'counters')) });
  }

  const flags = uniqueStrings(arrayAt(raw, 'flags')).filter((flag) => {
    if (content.flags.includes(flag)) return true;
    warnings.push(`progress.flags: unknown flag ${JSON.stringify(flag)} dropped`);
    return false;
  });

  const rawPlanet = raw['currentPlanet'];
  let currentPlanet: PlanetId | null = null;
  if (typeof rawPlanet === 'string') {
    if ((PLANET_IDS as readonly string[]).includes(rawPlanet)) currentPlanet = rawPlanet as PlanetId;
    else warnings.push(`progress.currentPlanet: unknown planet ${JSON.stringify(rawPlanet)} reset to the station`);
  }
  // §4.4: without a planet there is nowhere to be but the station.
  const location = currentPlanet === null ? 'station' : oneOf(raw['location'], ['station', 'surface'] as const, 'station');

  const visits: Partial<Record<PlanetId, number>> = {};
  const rawVisits = bagAt(raw, 'visits');
  for (const planet of PLANET_IDS) {
    const value = rawVisits[planet];
    if (value === undefined) continue;
    visits[planet] = Math.max(0, Math.round(num(value, 0)));
  }

  return {
    missionsDone,
    missionsActive,
    flags,
    currentPlanet,
    location,
    poisDiscovered: uniqueStrings(arrayAt(raw, 'poisDiscovered')),
    visits,
    endingSeen: raw['endingSeen'] === true,
  };
}

function validateCounters(raw: Bag): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    out[key] = Math.max(0, value);
  }
  return out;
}

function uniqueStrings(raw: unknown[]): string[] {
  const seen = new Set<string>();
  for (const value of raw) if (typeof value === 'string') seen.add(value);
  return [...seen];
}

// --------------------------------------------------------------- migrations

/**
 * The chain of §4.3: one step per version, `v → v + 1`. A save from a *newer*
 * version is refused rather than guessed at (E9), and a version with no step is
 * `unknown_version`.
 */
const MIGRATIONS: Record<number, (raw: Bag) => Bag> = {
  // v0 is the pre-release shape: no `meta` wrapper, no `visits`, no
  // `endingSeen`, `difficulty` on the player. Everything it does not carry is
  // left out here on purpose — `validateSave` fills in the defaults.
  0: (raw: Bag): Bag => {
    const player = bagAt(raw, 'player');
    return {
      version: 1,
      meta: {
        slot: raw['slot'],
        seed: raw['seed'],
        createdAt: raw['createdAt'],
        updatedAt: raw['updatedAt'],
        playtimeSec: raw['playtimeSec'],
        difficulty: player['difficulty'] ?? raw['difficulty'],
        iteration: 1,
        appVersion: raw['appVersion'],
      },
      player: {
        name: player['name'],
        classId: player['classId'],
        appearance: player['appearance'],
        attributes: player['attributes'],
        level: player['level'],
        xp: player['xp'],
        tokens: player['tokens'],
        hp: player['hp'],
      },
      resources: raw['resources'],
      inventory: raw['inventory'],
      equipped: raw['equipped'],
      ship: raw['ship'],
      companions: raw['companions'],
      progress: { ...bagAt(raw, 'progress'), visits: {}, endingSeen: false },
    };
  },
};

export function migrate(
  raw: { version: number } & Record<string, unknown>,
): { ok: true; data: SaveV1; from: number } | { ok: false; reason: 'newer_version' | 'unknown_version' } {
  const from = raw.version;
  if (typeof from !== 'number' || !Number.isInteger(from) || from < 0) return { ok: false, reason: 'unknown_version' };
  if (from > SAVE_VERSION) return { ok: false, reason: 'newer_version' };
  let current: Bag = raw;
  for (let version = from; version < SAVE_VERSION; version++) {
    const step = MIGRATIONS[version];
    if (step === undefined) return { ok: false, reason: 'unknown_version' };
    current = step(current);
  }
  // The shape is only claimed here; `validateSave` is what hardens it (§4.3).
  return { ok: true, data: current as unknown as SaveV1, from };
}

// ------------------------------------------------------------ export codes

export const CODE_PREFIX = 'RLM1';
export type CodeErrorReason = 'unsupported' | 'not_reallm' | 'damaged' | 'newer_version' | 'empty';

/** `exportCode` rejects with this rather than throwing a bare `Error` (§4.6). */
export class SaveCodeError extends Error {
  readonly reason: CodeErrorReason;
  constructor(reason: CodeErrorReason, message: string) {
    super(message);
    this.name = 'SaveCodeError';
    this.reason = reason;
  }
}

const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let bit = 0; bit < 8; bit++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

/** CRC-32 (IEEE) of the *compressed* bytes, checked before decompression (§4.6). */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = (CRC_TABLE[(crc ^ (bytes[i] as number)) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Eight lower-case hex digits — the conventional way to write a CRC-32. */
export function crcText(bytes: Uint8Array): string {
  return crc32(bytes).toString(16).padStart(8, '0');
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  // Chunked: `String.fromCharCode(...bytes)` blows the argument limit on a
  // save of any size.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** 07-f: the floor platforms all have it; a browser that does not loses codes. */
export function codesSupported(): boolean {
  const scope = globalThis as { CompressionStream?: unknown; DecompressionStream?: unknown };
  return typeof scope.CompressionStream === 'function' && typeof scope.DecompressionStream === 'function';
}

async function pump(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

async function through(bytes: Uint8Array, transform: GenericTransformStream): Promise<Uint8Array> {
  const writer = transform.writable.getWriter();
  // Not awaited: with a transform stream the write promise settles only once
  // the other end is read, so awaiting it here would deadlock. A payload that
  // passes the crc but will not inflate rejects both of them, and an unhandled
  // rejection in a game that is otherwise fine would take the page down — the
  // error the caller acts on is the one `pump()` throws.
  const swallow = (): void => {};
  writer.write(bytes).catch(swallow);
  writer.close().catch(swallow);
  return pump(transform.readable as ReadableStream<Uint8Array>);
}

/** `RLM1.<base64url deflate-raw>.<crc32>` (§4.6). */
export async function encodeSave(json: string): Promise<string> {
  if (!codesSupported()) throw new SaveCodeError('unsupported', 'CompressionStream is unavailable');
  const compressed = await through(new TextEncoder().encode(json), new CompressionStream('deflate-raw'));
  return `${CODE_PREFIX}.${toBase64Url(compressed)}.${crcText(compressed)}`;
}

/** Verifies the crc of the compressed bytes *before* decompressing them (§4.6). */
export async function decodeSave(code: string): Promise<string> {
  if (!codesSupported()) throw new SaveCodeError('unsupported', 'DecompressionStream is unavailable');
  // 07-g: a code out of a chat window or an email arrives wrapped.
  const parts = code.replace(/\s+/g, '').split('.');
  if (parts.length !== 3 || parts[0] !== CODE_PREFIX) {
    throw new SaveCodeError('not_reallm', 'the code does not start with RLM1');
  }
  let compressed: Uint8Array;
  try {
    compressed = fromBase64Url(parts[1] as string);
  } catch {
    throw new SaveCodeError('damaged', 'the payload is not base64url');
  }
  if (crcText(compressed) !== parts[2]) throw new SaveCodeError('damaged', 'the checksum does not match');
  try {
    return new TextDecoder().decode(await through(compressed, new DecompressionStream('deflate-raw')));
  } catch {
    throw new SaveCodeError('damaged', 'the payload does not decompress');
  }
}

// ---------------------------------------------------------------- the store

/**
 * The slice of the bus this module uses. A structural port, not the concrete
 * `EventBus`, so `createNullSave()` and a test can hand over a stub — the same
 * reason `core/Services.ts` keeps its own port (SPEC-004 D-7).
 */
export interface SaveEvents {
  emit<K extends keyof GameEvents>(name: K, ...args: EmitArgs<K>): void;
  on?<K extends keyof GameEvents>(name: K, handler: (payload: GameEvents[K]) => void, owner?: object): () => void;
}

/** The two settings keys SPEC-007 owns; the store writes them through §4.7. */
export interface SavePersistSettings {
  get(): { persistGranted: boolean | null; installHintShownAt: number | null };
  set(patch: { persistGranted?: boolean | null; installHintShownAt?: number | null }): void;
}

export interface SaveStoreOptions {
  /** Wall clock. Injected so the debounce of §4.5 is testable. */
  now?: () => number;
  /** The id universe `validateSave` checks against; SPEC-009 lands the real one. */
  content?: SaveContent;
  /** Where `persistGranted` and `installHintShownAt` live (§4.7). */
  settings?: SavePersistSettings;
  /** The `storage` event source for 07-a. Defaults to `globalThis`. */
  window?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> | null;
}

/** `localStorage` where there is one; node and locked-down browsers get null. */
function defaultStorage(): Storage | null {
  try {
    return (globalThis as { localStorage?: Storage }).localStorage ?? null;
  } catch (error) {
    log.warn('save', 'localStorage is unavailable; this session is memory-only', error);
    return null;
  }
}

/** §4.2: Safari reports a full quota under several names and two numbers. */
function isQuota(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const e = error as { name?: unknown; code?: unknown; message?: unknown };
  if (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED') return true;
  if (e.code === 22 || e.code === 1014) return true;
  return typeof e.message === 'string' && /quota/i.test(e.message);
}

/** AC-6: `?seed=` wins over the random seed, so a bug report reproduces. */
function seedFromLocation(): number | null {
  const search = (globalThis as { location?: { search?: string } }).location?.search;
  if (typeof search !== 'string' || search === '') return null;
  const raw = new URLSearchParams(search).get('seed');
  if (raw === null || raw.trim() === '') return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed >>> 0 : null;
}

/**
 * A 32-bit seed from the platform CSPRNG (§4.1). The un-seeded generator is
 * banned outside `core/Rng.ts` (SPEC-001 §7) and this is not a gameplay draw
 * anyway: it is the one number the whole deterministic world hangs off.
 */
function randomSeed(): number {
  const scope = globalThis as {
    crypto?: { getRandomValues?: (array: Uint32Array) => Uint32Array };
    performance?: { now?: () => number };
  };
  const values = new Uint32Array(1);
  if (typeof scope.crypto?.getRandomValues === 'function') {
    scope.crypto.getRandomValues(values);
    return (values[0] as number) >>> 0;
  }
  // No CSPRNG at all: the array would stay zeroed and every fresh save on this
  // platform would generate the same world. The clock is a poor seed but a
  // varying one, and the un-seeded generator is banned here (SPEC-001 §7).
  log.warn('save', 'crypto.getRandomValues is unavailable; the seed comes from the clock');
  const clock = Date.now() ^ Math.round((scope.performance?.now?.() ?? 0) * 1000);
  return clock >>> 0;
}

/**
 * Whether a stored string is plausibly one of our saves — parseable, an object,
 * and versioned. Deliberately structural rather than a full `validateSave`:
 * this runs on the backup copy of every flush, and §4.3 is what decides whether
 * a save is *usable*.
 */
function looksLikeSave(raw: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  return isBag(parsed) && typeof parsed['version'] === 'number' && Number.isInteger(parsed['version']);
}

function isIosSafari(): boolean {
  const nav = (globalThis as { navigator?: { userAgent?: string; maxTouchPoints?: number } }).navigator;
  const ua = nav?.userAgent ?? '';
  if (ua === '') return false;
  // iPadOS 13+ reports a Mac UA, so the touch count is what tells them apart.
  const iOS = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && (nav?.maxTouchPoints ?? 0) > 1);
  return iOS && !/CriOS|FxiOS|EdgiOS/.test(ua);
}

function isStandalone(): boolean {
  const scope = globalThis as {
    matchMedia?: (query: string) => { matches: boolean };
    navigator?: { standalone?: boolean };
  };
  if (scope.navigator?.standalone === true) return true;
  try {
    return scope.matchMedia?.('(display-mode: standalone)').matches === true;
  } catch {
    return false;
  }
}

export class SaveStore {
  readonly #events: SaveEvents;
  readonly #storage: Storage | null;
  readonly #now: () => number;
  readonly #content: SaveContent;
  readonly #settings: SavePersistSettings | null;
  readonly #release: Array<() => void> = [];

  /** E8: false → memory-only. The probe of §3 is what decides it. */
  readonly available: boolean;

  #current: SaveV1 | null = null;
  #pending: SaveReason | null = null;
  /** The *first* request of a burst, so a stream of them still writes on time. */
  #pendingSince = 0;
  /** 07-c: set between `scene:transition` and `scene:entered`. */
  #transitioning = false;
  /** When that hold started, so a transition that never lands cannot outlast it. */
  #transitionSince = 0;
  /** 07-a: another tab wrote our slot; autosaves stop until the page reloads. */
  #foreignWrite = false;
  #unavailableReported = false;
  #persistAsked = false;

  constructor(events: SaveEvents, storage?: Storage | null, options: SaveStoreOptions = {}) {
    this.#events = events;
    this.#storage = storage === undefined ? defaultStorage() : storage;
    this.#now = options.now ?? Date.now;
    this.#content = options.content ?? SAVE_CONTENT;
    this.#settings = options.settings ?? null;
    this.available = this.#probe();
    // E8: a banner in the menu (SPEC-014 reads `available`) and one toast, so a
    // private-mode session is told once and then left alone to play. A caller
    // that passed `null` asked for a memory-only store on purpose — the null
    // store, a unit test — and is not told anything.
    if (!this.available && storage !== null) {
      log.warn('save', 'storage is unavailable; this session is memory-only');
      this.#events.emit('ui:toast', { kind: 'warn', text: STORAGE_UNAVAILABLE_TEXT, ms: 8000 });
    }
    this.#watchScenes();
    this.#watchOtherTabs(options.window);
  }

  /** §3: one write and one remove, once, to find out whether storage works. */
  #probe(): boolean {
    if (this.#storage === null) return false;
    try {
      this.#storage.setItem(PROBE_KEY, '1');
      this.#storage.removeItem(PROBE_KEY);
      return true;
    } catch (error) {
      log.warn('save', 'the storage probe failed', error);
      return false;
    }
  }

  // ------------------------------------------------------------------ slots

  get current(): SaveV1 | null {
    return this.#current;
  }

  #key(slot: SlotId): string {
    return `${SLOT_KEY_PREFIX}${slot}`;
  }

  #read(key: string): string | null {
    if (this.#storage === null) return null;
    try {
      return this.#storage.getItem(key);
    } catch (error) {
      log.warn('save', `could not read ${key}`, error);
      return null;
    }
  }

  /** One line per slot for the menu (§3). Never throws on a corrupt slot. */
  list(): SlotSummary[] {
    return SLOTS.map((slot) => {
      const result = this.load(slot);
      if (result.ok) {
        const { meta, player, progress } = result.data;
        return {
          slot,
          empty: false,
          name: player.name,
          classId: player.classId,
          level: player.level,
          planet: progress.currentPlanet,
          playtimeSec: meta.playtimeSec,
          updatedAt: meta.updatedAt,
        };
      }
      // E8/E9: "Corrupt" and "newer version" are both slots with something in
      // them — the menu offers Import and Delete, never a silent overwrite.
      if (result.reason === 'empty' || result.reason === 'unavailable') return { slot, empty: true };
      return { slot, empty: false, corrupt: true };
    });
  }

  /** §4.3. A load that came from `:bak` rewrites main and toasts on the way out. */
  load(slot: SlotId): LoadResult {
    if (!this.available) return { ok: false, reason: 'unavailable' };
    const key = this.#key(slot);
    const raw = this.#read(key);
    if (raw === null) return { ok: false, reason: 'empty' };

    const main = this.#parse(raw);
    if (main.ok) return { ok: true, data: main.data, source: 'main', ...(main.from < SAVE_VERSION ? { migratedFrom: main.from } : {}) };
    // E9 is reported, never worked around: a save from the future is not a
    // corrupt save, and its `:bak` is from the future too.
    if (main.reason === 'newer_version') return { ok: false, reason: 'newer_version', foundVersion: main.foundVersion };

    const rawBak = this.#read(key + BAK_SUFFIX);
    if (rawBak === null) return { ok: false, reason: 'corrupt', errors: main.errors };
    const bak = this.#parse(rawBak);
    if (!bak.ok) return { ok: false, reason: 'corrupt', errors: main.errors };
    log.warn('save', `slot ${slot}: the main save was unusable; the backup was loaded`);
    this.#write(key, rawBak);
    this.#events.emit('ui:toast', { kind: 'warn', text: BACKUP_RESTORED_TEXT });
    return { ok: true, data: bak.data, source: 'bak', ...(bak.from < SAVE_VERSION ? { migratedFrom: bak.from } : {}) };
  }

  /** Parse → version gate → migrate → validate, the pipeline of §4.3. */
  #parse(
    raw: string,
  ):
    | { ok: true; data: SaveV1; from: number }
    | { ok: false; reason: 'corrupt' | 'newer_version'; errors: string[]; foundVersion?: number } {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      return { ok: false, reason: 'corrupt', errors: [`save: not JSON (${String(error)})`] };
    }
    if (!isBag(parsed)) return { ok: false, reason: 'corrupt', errors: ['save: not an object'] };
    const version = parsed['version'];
    if (typeof version !== 'number' || !Number.isInteger(version)) {
      return { ok: false, reason: 'corrupt', errors: [`version: ${JSON.stringify(version)}`] };
    }
    if (version > SAVE_VERSION) return { ok: false, reason: 'newer_version', errors: [], foundVersion: version };
    const migrated = migrate(parsed as { version: number } & Bag);
    if (!migrated.ok) {
      if (migrated.reason === 'newer_version') return { ok: false, reason: 'newer_version', errors: [], foundVersion: version };
      return { ok: false, reason: 'corrupt', errors: [`version ${version}: no migration`] };
    }
    const validated = validateSave(migrated.data, this.#content);
    if (!validated.ok) return { ok: false, reason: 'corrupt', errors: validated.errors };
    for (const warning of validated.warnings) log.warn('save', warning);
    return { ok: true, data: validated.data, from: migrated.from };
  }

  /** Writes immediately, with reason `'new'` (§3). */
  create(slot: SlotId, creation: CharacterCreation, seed?: number): SaveV1 {
    const resolved = seed ?? seedFromLocation() ?? randomSeed();
    const data = newSave(slot, creation, resolved, this.#now());
    this.bind(data);
    this.#flush('new');
    return data;
  }

  /** The live save the game mutates; `request()`/`flush()` serialize it (§3). */
  bind(data: SaveV1): void {
    this.#current = data;
    this.#pending = null;
  }

  /** Removes the main key *and* the backup (§3, M1 acceptance). */
  delete(slot: SlotId): void {
    for (const key of [this.#key(slot), this.#key(slot) + BAK_SUFFIX]) {
      try {
        this.#storage?.removeItem(key);
      } catch (error) {
        log.warn('save', `could not remove ${key}`, error);
      }
    }
    // Otherwise the next autosave writes the deleted character straight back —
    // and in a memory-only session (E8) the deleted character would go on being
    // played and exported.
    if (this.#current?.meta.slot === slot) {
      this.#current = null;
      this.#pending = null;
    }
  }

  /** §4.8: accumulated by gameplay scenes per update, stored on the next flush. */
  addPlaytime(seconds: number): void {
    if (this.#current === null) return;
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    this.#current.meta.playtimeSec += seconds;
  }

  // -------------------------------------------------------------- autosaving

  /** §4.5. `pagehide` and `manual` skip the debounce; everything else waits. */
  request(reason: SaveReason): void {
    if (this.#foreignWrite) {
      log.warn('save', `autosave (${reason}) refused: another tab owns this slot`);
      return;
    }
    if (IMMEDIATE_REASONS.includes(reason)) {
      this.#flush(reason);
      return;
    }
    if (this.#pending !== null) return; // already inside a window; one write covers both
    this.#pending = reason;
    this.#pendingSince = this.#now();
  }

  /**
   * Called by `Game` after render each frame (§4.5). Never inside `update()`:
   * that is the whole point of the request/flush split.
   */
  tick(now: number = this.#now()): void {
    if (this.#pending === null) return;
    // 07-c: a scene swap is halfway through disposing its state; the write goes
    // out on the far side of it.
    if (this.#transitioning) {
      if (now - this.#transitionSince < TRANSITION_HOLD_MAX_MS) return;
      // A transition that fell over before `scene:entered`: keep saving rather
      // than hold every write for the rest of the session.
      this.#transitioning = false;
      log.warn('save', 'no scene:entered within the transition hold; autosaves resume');
    }
    if (now - this.#pendingSince < AUTOSAVE_DEBOUNCE_MS) return;
    this.#flush(this.#pending);
  }

  /** Write now, synchronously (§4.2). Returns whether the save is on disk. */
  flush(): boolean {
    return this.#flush(this.#pending ?? 'manual');
  }

  #flush(reason: SaveReason): boolean {
    const data = this.#current;
    this.#pending = null;
    if (data === null) return false;
    const slot = data.meta.slot;

    if (!this.available) {
      // E8: once per session — a toast every autosave would be unplayable, and
      // the game itself is unaffected.
      if (!this.#unavailableReported) {
        this.#unavailableReported = true;
        this.#events.emit('save:failed', { slot, error: 'unavailable' });
        log.warn('save', 'no storage: the save is kept in memory only');
      }
      return false;
    }

    data.meta.updatedAt = this.#now();
    data.meta.appVersion = APP_VERSION;
    const json = JSON.stringify(data);
    if (json.length > LARGE_SAVE_BYTES) {
      log.warn('save', `slot ${slot}: the save is ${json.length} bytes, which is far past the expected size`);
    }

    const first = this.#writeWithBackup(slot, json);
    if (first === null) return this.#succeed(slot, reason, data);
    // §4.2: a full quota is usually the backup's fault, so drop it and retry.
    if (isQuota(first) && this.#read(this.#key(slot) + BAK_SUFFIX) !== null) {
      try {
        this.#storage?.removeItem(this.#key(slot) + BAK_SUFFIX);
      } catch (error) {
        log.warn('save', 'could not drop the backup', error);
      }
      const second = this.#writeWithBackup(slot, json, false);
      return second === null ? this.#succeed(slot, reason, data) : this.#fail(slot, second);
    }
    return this.#fail(slot, first);
  }

  #succeed(slot: SlotId, reason: SaveReason, data: SaveV1): boolean {
    this.#events.emit('save:written', { slot, reason });
    this.#afterWrite(data);
    return true;
  }

  /** Returns `null` on success, or whatever went wrong. */
  #writeWithBackup(slot: SlotId, json: string, backup = true): unknown {
    const key = this.#key(slot);
    try {
      if (backup) {
        const previous = this.#read(key);
        // §4.2 backs up the previous *good* save. If the main key was mangled
        // out-of-band (another tab, a hand edit, a torn write), copying it over
        // `:bak` would destroy the one copy §4.3 recovers from.
        if (previous !== null && looksLikeSave(previous)) this.#storage?.setItem(key + BAK_SUFFIX, previous);
        else if (previous !== null) log.warn('save', `slot ${slot}: the stored save is unreadable; the backup was kept`);
      }
      this.#storage?.setItem(key, json);
      // §4.2: Safari can silently truncate at quota, so the only proof a write
      // landed is reading it back.
      if (this.#read(key) !== json) throw new Error('verify failed: the value read back is not the value written');
      return null;
    } catch (error) {
      return error;
    }
  }

  #fail(slot: SlotId, error: unknown): boolean {
    log.warn('save', `slot ${slot}: the write failed`, error);
    this.#events.emit('save:failed', { slot, error: isQuota(error) ? 'quota' : 'unknown' });
    this.#events.emit('ui:toast', { kind: 'error', text: SAVE_FAILED_TEXT, ms: 8000 });
    return false;
  }

  #write(key: string, json: string): void {
    try {
      this.#storage?.setItem(key, json);
    } catch (error) {
      log.warn('save', `could not write ${key}`, error);
    }
  }

  // ------------------------------------------------------- persistence hints

  /** §4.7: persistence is asked for once a session, the hint once a fortnight. */
  #afterWrite(data: SaveV1): void {
    if (!this.#persistAsked) {
      this.#persistAsked = true;
      this.#requestPersistence();
    }
    if (data.progress.location === 'station') this.#maybeHintInstall();
  }

  #requestPersistence(): void {
    const storage = (globalThis as { navigator?: { storage?: { persist?: () => Promise<boolean> } } }).navigator?.storage;
    const persist = storage?.persist;
    if (typeof persist !== 'function') return;
    persist
      .call(storage)
      .then((granted: boolean) => this.#settings?.set({ persistGranted: granted }))
      .catch((error: unknown) => log.warn('save', 'navigator.storage.persist() was refused', error));
  }

  /**
   * §4.7: iOS Safari clears site data after seven unused days unless the game
   * is on the Home Screen. An installed app never sees this, and nobody sees it
   * twice inside a fortnight.
   */
  #maybeHintInstall(): void {
    if (this.#settings === null) return;
    if (!isIosSafari() || isStandalone()) return;
    const shownAt = this.#settings.get().installHintShownAt;
    const now = this.#now();
    if (shownAt !== null && now - shownAt < INSTALL_HINT_INTERVAL_MS) return;
    this.#settings.set({ installHintShownAt: now });
    this.#events.emit('ui:toast', { kind: 'info', text: INSTALL_HINT_TEXT, ms: 10000 });
  }

  // ------------------------------------------------------------------- codes

  /** 07-f: false hides the Backup panel rather than letting it fail late. */
  get codesSupported(): boolean {
    return codesSupported();
  }

  /**
   * §4.6. Exports whatever the slot holds — including raw JSON a validator
   * rejected, so a corrupt slot is still recoverable by hand (E8) — and falls
   * back to the bound save, which is all a memory-only session has (E8).
   */
  async exportCode(slot: SlotId): Promise<string> {
    if (!codesSupported()) {
      this.#events.emit('ui:toast', { kind: 'warn', text: CODES_UNSUPPORTED_TEXT });
      throw new SaveCodeError('unsupported', 'CompressionStream is unavailable');
    }
    const stored = this.available ? this.#read(this.#key(slot)) : null;
    const json = stored ?? (this.#current?.meta.slot === slot ? JSON.stringify(this.#current) : null);
    if (json === null) throw new SaveCodeError('empty', `slot ${slot} is empty`);
    return encodeSave(json);
  }

  /** §4.6: verify → migrate → validate → write to the slot, backup and all. */
  async importCode(code: string, slot: SlotId): Promise<LoadResult> {
    let json: string;
    try {
      json = await decodeSave(code);
    } catch (error) {
      const reason = error instanceof SaveCodeError ? error.reason : 'damaged';
      this.#toastCodeError(reason);
      return { ok: false, reason: 'corrupt', errors: [String(error)] };
    }
    const parsed = this.#parse(json);
    if (!parsed.ok) {
      this.#toastCodeError(parsed.reason === 'newer_version' ? 'newer_version' : 'damaged');
      return parsed.reason === 'newer_version'
        ? { ok: false, reason: 'newer_version', foundVersion: parsed.foundVersion }
        : { ok: false, reason: 'corrupt', errors: parsed.errors };
    }
    // The code came from another slot, or another browser: it belongs to this
    // one now.
    parsed.data.meta.slot = slot;
    if (!this.available) return { ok: false, reason: 'unavailable' };
    const error = this.#writeWithBackup(slot, JSON.stringify(parsed.data));
    if (error !== null) {
      this.#fail(slot, error);
      return { ok: false, reason: 'corrupt', errors: [String(error)] };
    }
    return { ok: true, data: parsed.data, source: 'main', ...(parsed.from < SAVE_VERSION ? { migratedFrom: parsed.from } : {}) };
  }

  #toastCodeError(reason: CodeErrorReason): void {
    const text =
      reason === 'not_reallm'
        ? CODE_NOT_REALLM_TEXT
        : reason === 'newer_version'
          ? CODE_NEWER_TEXT
          : reason === 'unsupported'
            ? CODES_UNSUPPORTED_TEXT
            : CODE_DAMAGED_TEXT;
    this.#events.emit('ui:toast', { kind: 'error', text });
  }

  // ------------------------------------------------------------ subscriptions

  /** 07-c: `tick()` holds a pending write for the length of a scene swap. */
  #watchScenes(): void {
    const on = this.#events.on;
    if (typeof on !== 'function') return;
    this.#release.push(
      on.call(
        this.#events,
        'scene:transition',
        () => {
          this.#transitioning = true;
          this.#transitionSince = this.#now();
        },
        this,
      ),
      on.call(this.#events, 'scene:entered', () => void (this.#transitioning = false), this),
    );
  }

  /**
   * 07-a: two tabs of the same game would otherwise ping-pong their autosaves
   * over each other. Last write wins, and this tab stops writing until it is
   * reloaded.
   */
  #watchOtherTabs(source: SaveStoreOptions['window']): void {
    const target = source === undefined ? (globalThis as unknown as EventTarget) : source;
    if (target === null || typeof target.addEventListener !== 'function') return;
    const handler = (event: Event): void => {
      const key = (event as StorageEvent).key;
      if (this.#current === null || this.#foreignWrite) return;
      if (key !== this.#key(this.#current.meta.slot)) return;
      this.#foreignWrite = true;
      this.#pending = null;
      log.warn('save', 'another tab wrote this slot; autosaves are off until reload');
      this.#events.emit('ui:toast', { kind: 'warn', text: CROSS_TAB_TEXT, ms: 8000 });
    };
    target.addEventListener('storage', handler);
    this.#release.push(() => target.removeEventListener('storage', handler));
  }

  /** Whether 07-a has fired; the menu offers a reload when it has. */
  get refusingAutosaves(): boolean {
    return this.#foreignWrite;
  }

  dispose(): void {
    for (const release of this.#release.splice(0)) {
      try {
        release();
      } catch (error) {
        log.warn('save', 'a subscription would not release', error);
      }
    }
  }
}

/**
 * A store with nowhere to write: the composition root injects a real one, and
 * everything that only needs the seam (`Game`'s default, the scene-machine
 * tests) gets this. Memory-only by construction, so `request`/`tick`/`flush`
 * behave exactly as they do for a player in private mode.
 */
export function createNullSave(): SaveStore {
  return new SaveStore({ emit: () => {} }, null, { window: null });
}
