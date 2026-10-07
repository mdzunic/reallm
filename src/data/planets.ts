// The six worlds (SPEC-009 §4.5). A planet owns everything the surface scene
// needs to build itself — POIs by distance band rather than by coordinate, so
// the seeded layout stays procedural and reproducible (§2, fifth decision) —
// plus the flight leg that gets you there and the gate that opens it.
//
// This module is deliberately last after `missions.ts`: `unlock` is a
// `Requirement<MissionId>`, so every planet gate is checked against the real
// mission and flag universes at compile time.
//
// Travel and gating follow PLAN §5, which differs from SPEC-009 §4.5 on three
// fuel costs and one travel time (Vetra 60 not 55, Thessaly 80 not 70, Ferrum
// 100 not 90 and 150 s not 160 s). PLAN wins where the two disagree (CLAUDE.md),
// and the values the spec pins to other specs — Cinder-4 at 40 oil and 90 s
// (E1, SPEC-013 §6), Eden at 120 oil (SPEC-010 edge 10-f), the Hive at 200 s so
// `c5_m1`'s 180 s survive fits (SPEC-013 §4.8), Ferrum's shield-2 gate (E2) —
// are the same in both.
//
// Data modules are plain objects: no imports but other data, no functions
// (SPEC-001 §4, §8).
import type { ModelId } from '@/data/assets';
import type { EnemyId } from '@/data/enemies';
import type { HazardPlacement } from '@/data/hazards';
import type {
  BoundaryKind,
  DecalKind,
  DressingKind,
  GroundLayerId,
  MusicId,
  PlanetId,
  ResourceId,
  ScatterKind,
  WeatherId,
} from '@/data/ids';
import type { MissionId, Requirement } from '@/data/missions';
import { POI_LABELS, type PoiId } from '@/data/pois';
import type { WaveId } from '@/data/waves';

export interface PoiDef {
  readonly id: PoiId;
  readonly kind: 'landing_pad' | 'scan' | 'reach' | 'deliver' | 'arena' | 'defend' | 'escort_start' | 'landmark';
  readonly label: string;
  /** Instances placed; each one gets an index 0..count−1. */
  readonly count: number;
  /** Distance from the pad, in metres; the pad itself is [0, 0]. */
  readonly band: readonly [number, number];
  /** Trigger radius, in metres. */
  readonly radius: number;
  /** `defend` POIs only. */
  readonly hp?: number;
  /** `arena` POIs only. */
  readonly boss?: EnemyId;
  /** An arena that also accepts a deliver objective (`reactor_core`). */
  readonly deliver?: boolean;
  readonly model: ModelId | 'procedural';
}

/**
 * SPEC-053 §3: a planet's streamed ground cover — the atlas cells it draws, by
 * weight, each sized in metres, and how many clumps per 1,000 m².
 */
export interface CoverLook {
  readonly kinds: readonly { readonly cell: number; readonly weight: number; readonly size: readonly [number, number] }[];
  readonly per1000m2: number;
  /** Density multiplier under a canopy; 1 when absent. */
  readonly underCanopy?: number;
}

/**
 * PLAN R28 / SPEC-067 (*initial tuning*): what keeps a planet from reading as
 * a plate — a macro patch field in the ground's vertex colour, stone rubble,
 * three biome dressing kinds and the worn trails toward the POIs. All of it is
 * view-only and seeded from the layout hash.
 */
export interface DressingLook {
  /**
   * The ground's 20–90 m patch field: two hues (sRGB, used at luminance 1) it
   * drifts between, how far it pulls toward them (0–1), how much the patches
   * lighten and darken (± fraction), and how much layer B the large patches
   * add to the splat (0–1).
   */
  readonly macro: {
    readonly hues: readonly [string, string];
    readonly strength: number;
    readonly value: number;
    readonly patches: number;
  };
  /** The rubble's two stone colours (sRGB); each piece lies between them. */
  readonly rubble: readonly [string, string];
  /** The biome's dressing kinds, placed in clumps across the arena. */
  readonly kinds: readonly [DressingKind, DressingKind, DressingKind];
  /** The worn trails' tint (sRGB). */
  readonly trail: string;
}

/**
 * Everything the surface environment draws for one planet (SPEC-018 §4.1,
 * *initial tuning*): the lighting rig, the two-layer ground, the visual-only
 * relief, scatter, decals and the arena-edge boundary.
 */
export interface SurfaceLook {
  readonly light: {
    readonly sun: { readonly color: string; readonly intensity: number; readonly azimuth: number; readonly elevation: number };
    readonly sky: string;
    readonly ground: string;
    readonly ambient: number;
  };
  readonly ground: {
    readonly layers: readonly [GroundLayerId, GroundLayerId];
    readonly tileMetres: readonly [number, number];
    readonly cracks?: { readonly color: string; readonly intensity: number };
    /** SPEC-046 §4.5: 0..1, how strongly the macro tint pulls the ground; absent reads `TERRAIN_TINT_AMOUNT`. */
    readonly tint?: number;
    /**
     * SPEC-053 §4.6: one straight line where the lawn does not match itself —
     * past `poi` instance 0 along `axis`, both layers' UVs move by `shift` m.
     */
    readonly seam?: { readonly poi: PoiId; readonly axis: 'x' | 'z'; readonly shift: number };
  };
  readonly relief: { readonly amplitude: number; readonly wavelength: number; readonly ridged: number; readonly bermHeight: number };
  readonly scatter: { readonly kind: ScatterKind; readonly density: number; readonly second?: ScatterKind };
  readonly decals: readonly DecalKind[];
  readonly boundary: BoundaryKind;
  /** PLAN R28 / SPEC-067: the view-only dressing pass — every planet has one. */
  readonly dressing: DressingLook;
  /** SPEC-053 §4.1: the leaves' colour and how hard the wind moves them (0–2); a planet with trees has one. */
  readonly foliage?: { readonly tint: string; readonly wind: number };
  /** SPEC-053 §4.4: atlas clumps placed once, denser under canopies. */
  readonly undergrowth?: { readonly cells: readonly number[]; readonly underPer1000m2: number; readonly openPer1000m2: number };
  /** SPEC-053 §4.5: ground cover streamed around the view. */
  readonly cover?: CoverLook;
}

export interface PlanetDef {
  readonly id: PlanetId;
  readonly name: string;
  readonly chapter: 1 | 2 | 3 | 4 | 5 | 6;
  readonly biome: 'desert' | 'ice' | 'jungle' | 'volcanic' | 'hive' | 'temperate';
  readonly blurb: string;
  readonly unlock: readonly Requirement<MissionId>[];
  /** Oil, charged per outbound jump up front; the return is free (PLAN §4). */
  readonly fuelCost: number;
  readonly travelSeconds: number;
  readonly flight: {
    readonly asteroidDensity: number;
    readonly waves: readonly WaveId[];
    readonly ionStorm: boolean;
  };
  readonly surface: {
    /** Arena half-extent, in metres. */
    readonly halfSize: number;
    readonly palette: { readonly ground: string; readonly sky: string; readonly fog: string; readonly accent: string };
    readonly fogDensity: number;
    readonly look: SurfaceLook;
    readonly weather: {
      readonly cycle: readonly WeatherId[];
      readonly calmSeconds: readonly [number, number];
      readonly stormSeconds: readonly [number, number];
      /**
       * SPEC-038 §4.5 (*initial tuning*): scales what a storm here deals a
       * player in the open (`Weather.exposureDps`); 1 when absent.
       */
      readonly dpsMult?: number;
    } | null;
    readonly pois: readonly PoiDef[];
    readonly nodes: readonly {
      readonly resource: ResourceId;
      readonly count: number;
      readonly capacity: number;
      readonly regenPerSec: number;
    }[];
    readonly obstacles: { readonly density: number; readonly minRadius: number; readonly maxRadius: number };
    /**
     * SPEC-030 §4.1: shelter and outcrop counts — targets, not guarantees
     * (D-25). SPEC-053 §4.3: and the set pieces placed after the outcrops,
     * also targets — groves of trees, all-or-nothing orchards on an exact
     * lattice, and clusters of the planet's two obstacle kinds.
     */
    readonly features: {
      readonly caves: number;
      readonly wrecks: number;
      readonly outcrops: number;
      readonly groves?: { readonly count: number; readonly radius: readonly [number, number]; readonly treesPer1000m2: number };
      readonly orchards?: { readonly count: number; readonly rows: number; readonly cols: number; readonly spacing: number };
      readonly clusters?: { readonly count: number; readonly pieces: readonly [number, number]; readonly spread: number };
    };
    /**
     * SPEC-041 §4.5 (*initial tuning*): a row with `pack` spawns `[min, max]`
     * together around one ring point, its leader rolling the elite for all of
     * them. Swarm rows run [3, 5] (the Hive's drones [4, 6]), rushers [1, 2];
     * ranged rows come alone.
     */
    readonly spawn: readonly {
      readonly enemy: EnemyId;
      readonly weight: number;
      readonly maxAlive: number;
      readonly pack?: readonly [number, number];
    }[];
    /** Ambient waves the planet runs on its own; Eden has none until `c6_m2`. */
    readonly ambientWaves?: WaveId;
    /**
     * SPEC-038 §4.4: target simultaneous enemies on every preset, capped by
     * `maxEnemies` (`populationTarget`).
     */
    readonly population: number;
    readonly eliteChance: number;
    /**
     * SPEC-068 §4.1 (*initial tuning*): the planet's trap and two helpers —
     * groups placed from the layout seed in the open, and helpers in the arena.
     */
    readonly hazards: readonly HazardPlacement[];
  };
  readonly music: { readonly calm: MusicId; readonly combat: MusicId };
}

export const PLANETS = {
  cinder4: {
    id: 'cinder4',
    name: 'Cinder-4',
    chapter: 1,
    biome: 'desert',
    blurb: 'A furnace with oil under it. Sandstorms, heatwaves, and something enormous moving beneath the dunes.',
    unlock: [],
    fuelCost: 40,
    travelSeconds: 90,
    flight: { asteroidDensity: 0.2, waves: ['cinder4_flight'], ionStorm: false },
    surface: {
      halfSize: 180,
      palette: { ground: '#c19a5b', sky: '#e8b56a', fog: '#d8a866', accent: '#7a4a22' },
      // SPEC-018 §4.8 (*initial tuning*): thin enough that the berm, not the
      // fog, is what hides the arena edge.
      fogDensity: 0.014,
      look: {
        light: {
          sun: { color: '#ffd9a8', intensity: 2.8, azimuth: 35, elevation: 52 },
          sky: '#e8b56a',
          ground: '#8a6a3a',
          ambient: 0.55,
        },
        ground: { layers: ['sand', 'cracked_earth'], tileMetres: [4, 5.5] },
        relief: { amplitude: 0.5, wavelength: 30, ridged: 0.6, bermHeight: 5 },
        scatter: { kind: 'bones', density: 2.5, second: 'pebbles' },
        decals: ['crater', 'scorch', 'ripples', 'mudflat', 'gravel'],
        boundary: 'dunes',
        // PLAN R28 / SPEC-067 (*initial tuning*): rust-red and bleached-grey
        // sand, cracked-earth flats, a dead wurm's ribs and the scavs' leavings.
        dressing: {
          macro: { hues: ['#e07040', '#d8d4cc'], strength: 0.6, value: 0.38, patches: 0.6 },
          rubble: ['#a88e6c', '#6a5442'],
          kinds: ['wurm_ribs', 'scav_barrels', 'pipe_run'],
          trail: '#7a5434',
        },
        // SPEC-053 §4.5 (*initial tuning*): dry grass.
        cover: { kinds: [{ cell: 8, weight: 1, size: [0.4, 0.7] }], per1000m2: 20 },
      },
      // SPEC-038 §4.5: Cinder-4's heat runs at 1.3 dps — the first chapter's
      // storms bite without costing the whole bar.
      weather: { cycle: ['sandstorm', 'heatwave'], calmSeconds: [90, 150], stormSeconds: [45, 75], dpsMult: 0.65 },
      pois: [
        { id: 'landing_pad', kind: 'landing_pad', label: POI_LABELS.landing_pad, count: 1, band: [0, 0], radius: 6, model: 'procedural' },
        { id: 'dune_sea', kind: 'scan', label: POI_LABELS.dune_sea, count: 1, band: [60, 90], radius: 8, model: 'procedural' },
        { id: 'beacon', kind: 'deliver', label: POI_LABELS.beacon, count: 1, band: [40, 70], radius: 6, model: 'procedural' },
        { id: 'silo_ruin', kind: 'scan', label: POI_LABELS.silo_ruin, count: 1, band: [70, 110], radius: 8, model: 'procedural' },
        { id: 'wurm_nest', kind: 'arena', label: POI_LABELS.wurm_nest, count: 1, band: [110, 140], radius: 20, boss: 'dune_wurm', model: 'procedural' },
        { id: 'ruin', kind: 'landmark', label: POI_LABELS.ruin, count: 4, band: [40, 150], radius: 6, model: 'procedural' },
      ],
      nodes: [
        { resource: 'oil', count: 6, capacity: 100, regenPerSec: 0.5 },
        { resource: 'wheat', count: 4, capacity: 80, regenPerSec: 0.4 },
      ],
      obstacles: { density: 0.06, minRadius: 1.2, maxRadius: 3.5 },
      // SPEC-053 §4.3 (*initial tuning*): rock-and-ruin clusters on the walks between objectives.
      features: { caves: 2, wrecks: 2, outcrops: 3, clusters: { count: 24, pieces: [3, 7], spread: 10 } },
      spawn: [
        { enemy: 'dust_skitter', weight: 6, maxAlive: 10, pack: [3, 5] },
        { enemy: 'wurmling', weight: 3, maxAlive: 5, pack: [1, 2] },
        { enemy: 'scav_raider', weight: 2, maxAlive: 4 },
      ],
      population: 10,
      eliteChance: 0.05,
      hazards: [
        { id: 'scav_mine', groups: 6, per: [2, 4], arena: 0 },
        { id: 'balanced_rock', groups: 9, per: [1, 1], arena: 2 },
        { id: 'fuel_drum', groups: 8, per: [2, 3], arena: 2 },
      ],
    },
    music: { calm: 'calm_desert', combat: 'combat_light' },
  },

  vetra: {
    id: 'vetra',
    name: 'Vetra',
    chapter: 2,
    biome: 'ice',
    blurb: 'Ice, wind, and the water Earth is dying without. The last expedition here did not come back.',
    unlock: [{ kind: 'flag', flag: 'chapter1_done' }],
    fuelCost: 60,
    travelSeconds: 110,
    flight: { asteroidDensity: 0.35, waves: ['vetra_flight'], ionStorm: false },
    surface: {
      halfSize: 180,
      palette: { ground: '#dbe9f2', sky: '#a8c6dd', fog: '#c9dde9', accent: '#4a7a99' },
      fogDensity: 0.02,
      look: {
        light: {
          sun: { color: '#eaf4ff', intensity: 2.4, azimuth: 60, elevation: 60 },
          sky: '#a8c6dd',
          ground: '#6f8ea6',
          ambient: 0.6,
        },
        ground: { layers: ['snow', 'ice'], tileMetres: [4, 6] },
        relief: { amplitude: 0.4, wavelength: 26, ridged: 0.3, bermHeight: 8 },
        scatter: { kind: 'crystals', density: 2.0, second: 'pebbles' },
        decals: ['frost', 'cracks', 'ice_sheet', 'snowdrift', 'gravel'],
        boundary: 'ice_wall',
        // PLAN R28 / SPEC-067 (*initial tuning*): white snow against blue ice
        // sheets, blue-grey scree, and what the last expedition left behind.
        dressing: {
          macro: { hues: ['#f4f2ee', '#78a2d6'], strength: 0.65, value: 0.22, patches: 0.65 },
          rubble: ['#8e9cac', '#546272'],
          kinds: ['ice_shards', 'buried_crate', 'frozen_pipe'],
          trail: '#a9bccf',
        },
        // SPEC-053 §4.5 (*initial tuning*): frost fern.
        cover: { kinds: [{ cell: 10, weight: 1, size: [0.4, 0.8] }], per1000m2: 12 },
      },
      weather: { cycle: ['blizzard', 'avalanche'], calmSeconds: [90, 150], stormSeconds: [45, 90] },
      pois: [
        { id: 'landing_pad', kind: 'landing_pad', label: POI_LABELS.landing_pad, count: 1, band: [0, 0], radius: 6, model: 'procedural' },
        { id: 'ridge_camp', kind: 'reach', label: POI_LABELS.ridge_camp, count: 1, band: [80, 110], radius: 8, model: 'procedural' },
        { id: 'thermal_vent', kind: 'scan', label: POI_LABELS.thermal_vent, count: 1, band: [100, 130], radius: 8, model: 'procedural' },
        { id: 'crash_site', kind: 'scan', label: POI_LABELS.crash_site, count: 1, band: [60, 90], radius: 8, model: 'procedural' },
        { id: 'survivor_pod', kind: 'deliver', label: POI_LABELS.survivor_pod, count: 1, band: [70, 100], radius: 6, model: 'procedural' },
        { id: 'glacier_heart', kind: 'arena', label: POI_LABELS.glacier_heart, count: 1, band: [120, 150], radius: 20, boss: 'frost_matriarch', model: 'procedural' },
        { id: 'ice_spire', kind: 'landmark', label: POI_LABELS.ice_spire, count: 5, band: [40, 150], radius: 6, model: 'procedural' },
      ],
      nodes: [
        { resource: 'water', count: 6, capacity: 100, regenPerSec: 0.5 },
        { resource: 'wheat', count: 2, capacity: 60, regenPerSec: 0.4 },
      ],
      obstacles: { density: 0.07, minRadius: 1.2, maxRadius: 4 },
      // SPEC-053 §4.3 (*initial tuning*).
      features: { caves: 2, wrecks: 2, outcrops: 3, clusters: { count: 20, pieces: [3, 6], spread: 10 } },
      spawn: [
        { enemy: 'frost_mite', weight: 6, maxAlive: 12, pack: [3, 5] },
        { enemy: 'ice_crawler', weight: 3, maxAlive: 6, pack: [1, 2] },
        { enemy: 'ice_spitter', weight: 2, maxAlive: 4 },
      ],
      // Review 2026-10 (G-07, *initial tuning*): 13 (was 11) — Vetra was the
      // quietest field of the five, a trough right after the first boss.
      population: 13,
      eliteChance: 0.05,
      hazards: [
        { id: 'cryo_geyser', groups: 6, per: [2, 3], arena: 0 },
        { id: 'ice_pillar', groups: 9, per: [1, 1], arena: 2 },
        { id: 'coolant_tank', groups: 8, per: [1, 3], arena: 2 },
      ],
    },
    music: { calm: 'calm_ice', combat: 'combat_light' },
  },

  thessaly: {
    id: 'thessaly',
    name: 'Thessaly',
    chapter: 3,
    biome: 'jungle',
    blurb: 'Wheat growing over ruins nobody built, under three towers that are older than the ruins.',
    unlock: [{ kind: 'flag', flag: 'chapter2_done' }],
    fuelCost: 80,
    travelSeconds: 130,
    flight: { asteroidDensity: 0.45, waves: ['thessaly_flight'], ionStorm: false },
    surface: {
      halfSize: 200,
      palette: { ground: '#4f6b39', sky: '#8fae72', fog: '#6f8a55', accent: '#c2d98a' },
      // SPEC-018 §4.8 (*initial tuning*): the jungle reads dense from the
      // canopy ring and decals now, so the fog itself thins.
      fogDensity: 0.024,
      look: {
        light: {
          sun: { color: '#fff1c8', intensity: 2.0, azimuth: 20, elevation: 48 },
          sky: '#8fae72',
          ground: '#2f4a24',
          ambient: 0.5,
        },
        ground: { layers: ['moss', 'jungle_floor'], tileMetres: [3.5, 5] },
        relief: { amplitude: 0.45, wavelength: 22, ridged: 0.4, bermHeight: 6 },
        scatter: { kind: 'tufts', density: 4.0, second: 'spores' },
        decals: ['slick', 'cracks', 'leaf_litter', 'mudflat', 'gravel'],
        boundary: 'jungle_bank',
        // PLAN R28 / SPEC-067 (*initial tuning*): sunlit and deep moss, mud
        // and leaf-litter floors, and the ruins' fallen stone.
        dressing: {
          macro: { hues: ['#b8c860', '#4c8070'], strength: 0.5, value: 0.22, patches: 0.6 },
          rubble: ['#8a8a74', '#5c6450'],
          kinds: ['fallen_log', 'stone_drums', 'root_arch'],
          trail: '#6a5434',
        },
        // SPEC-053 §4.1, §4.4, §4.5 (*initial tuning*): a humid canopy in a
        // steady wind, ferns and broad leaves under it, moss and grass between.
        foliage: { tint: '#e2ebcc', wind: 1 },
        undergrowth: { cells: [4, 5, 14], underPer1000m2: 40, openPer1000m2: 8 },
        cover: {
          kinds: [
            { cell: 13, weight: 3, size: [0.4, 0.8] },
            { cell: 6, weight: 2, size: [0.4, 0.7] },
            { cell: 4, weight: 2, size: [0.6, 1.0] },
          ],
          per1000m2: 220,
          underCanopy: 1.6,
        },
      },
      weather: { cycle: ['spore_storm'], calmSeconds: [100, 160], stormSeconds: [60, 75] },
      pois: [
        { id: 'landing_pad', kind: 'landing_pad', label: POI_LABELS.landing_pad, count: 1, band: [0, 0], radius: 6, model: 'procedural' },
        { id: 'probe_site', kind: 'escort_start', label: POI_LABELS.probe_site, count: 1, band: [50, 80], radius: 8, model: 'procedural' },
        { id: 'hive_mouth', kind: 'arena', label: POI_LABELS.hive_mouth, count: 1, band: [120, 160], radius: 20, boss: 'hive_broodlord', model: 'procedural' },
        { id: 'terraform_tower', kind: 'scan', label: POI_LABELS.terraform_tower, count: 3, band: [70, 150], radius: 8, model: 'procedural' },
        { id: 'overgrown_ruin', kind: 'landmark', label: POI_LABELS.overgrown_ruin, count: 5, band: [50, 180], radius: 6, model: 'procedural' },
      ],
      // `c3_s2` collects 300 wheat, and invariant §7.7 wants three times the
      // largest collect in the ground: 7 × 150 clears 900. SPEC-009 §4.5 writes
      // capacity 100, which does not — retuned here (*initial tuning*).
      nodes: [
        { resource: 'wheat', count: 7, capacity: 150, regenPerSec: 0.6 },
        { resource: 'water', count: 2, capacity: 60, regenPerSec: 0.4 },
      ],
      obstacles: { density: 0.1, minRadius: 1.5, maxRadius: 4.5 },
      // SPEC-053 §4.3 (*initial tuning*): the jungle inside the wall — six
      // trees per 1,000 m² cover about half of each grove.
      features: { caves: 2, wrecks: 1, outcrops: 3, groves: { count: 14, radius: [20, 30], treesPer1000m2: 6 } },
      spawn: [
        { enemy: 'hive_drone', weight: 6, maxAlive: 14, pack: [3, 5] },
        { enemy: 'spore_hound', weight: 3, maxAlive: 6, pack: [1, 2] },
        { enemy: 'spore_spitter', weight: 2, maxAlive: 4 },
      ],
      population: 12,
      eliteChance: 0.06,
      hazards: [
        { id: 'spore_pod', groups: 6, per: [2, 4], arena: 0 },
        { id: 'ruin_column', groups: 9, per: [1, 2], arena: 2 },
        { id: 'gas_bloom', groups: 8, per: [2, 3], arena: 2 },
      ],
    },
    music: { calm: 'calm_jungle', combat: 'combat_heavy' },
  },

  ferrum: {
    id: 'ferrum',
    name: 'Ferrum',
    chapter: 4,
    biome: 'volcanic',
    blurb: 'Lithium all the way down, under radiation storms and the ash titan sitting on the old reactor.',
    unlock: [
      { kind: 'flag', flag: 'chapter3_done' },
      { kind: 'ship', system: 'shield', tier: 2 },
    ],
    fuelCost: 100,
    travelSeconds: 150,
    flight: { asteroidDensity: 0.6, waves: ['ferrum_flight'], ionStorm: true },
    surface: {
      halfSize: 200,
      palette: { ground: '#3a2f2a', sky: '#7a3320', fog: '#5a2f22', accent: '#ff6a2a' },
      // SPEC-018 §4.8 (*initial tuning*): the crack glow carries the menace.
      fogDensity: 0.026,
      look: {
        light: {
          sun: { color: '#ff8a4a', intensity: 1.8, azimuth: 15, elevation: 25 },
          sky: '#7a3320',
          ground: '#2a1a14',
          ambient: 0.45,
        },
        ground: { layers: ['basalt', 'lava_rock'], tileMetres: [4.5, 6], cracks: { color: '#ff6a2a', intensity: 3 } },
        relief: { amplitude: 0.5, wavelength: 28, ridged: 0.8, bermHeight: 7 },
        scatter: { kind: 'slag', density: 2.5 },
        decals: ['scorch', 'cracks', 'ash', 'lava_pool', 'gravel'],
        boundary: 'lava_ridge',
        // PLAN R28 / SPEC-067 (*initial tuning*): rust and ash-grey basalt,
        // ash drifts and cooling pools, hex stumps and obsidian.
        dressing: {
          macro: { hues: ['#c0704a', '#8a8890'], strength: 0.55, value: 0.25, patches: 0.3 },
          rubble: ['#7a6a5e', '#463c36'],
          kinds: ['basalt_stumps', 'obsidian_shards', 'lava_blobs'],
          trail: '#463c36',
        },
        // SPEC-053 §4.5 (*initial tuning*): ash fronds.
        cover: { kinds: [{ cell: 11, weight: 1, size: [0.5, 0.9] }], per1000m2: 10 },
      },
      weather: { cycle: ['radiation_storm', 'heatwave'], calmSeconds: [90, 140], stormSeconds: [60, 90] },
      pois: [
        { id: 'landing_pad', kind: 'landing_pad', label: POI_LABELS.landing_pad, count: 1, band: [0, 0], radius: 6, model: 'procedural' },
        { id: 'lithium_flats', kind: 'reach', label: POI_LABELS.lithium_flats, count: 1, band: [80, 110], radius: 8, model: 'procedural' },
        // Both the titan's arena and the deliver target of `c4_m3` (§4.5).
        { id: 'reactor_core', kind: 'arena', label: POI_LABELS.reactor_core, count: 1, band: [130, 160], radius: 20, boss: 'ash_titan', deliver: true, model: 'procedural' },
        { id: 'core_drill', kind: 'scan', label: POI_LABELS.core_drill, count: 2, band: [60, 120], radius: 8, model: 'procedural' },
        { id: 'lava_vent', kind: 'landmark', label: POI_LABELS.lava_vent, count: 6, band: [50, 180], radius: 6, model: 'procedural' },
      ],
      nodes: [
        { resource: 'lithium', count: 6, capacity: 100, regenPerSec: 0.4 },
        { resource: 'oil', count: 2, capacity: 60, regenPerSec: 0.4 },
      ],
      obstacles: { density: 0.09, minRadius: 1.5, maxRadius: 5 },
      // SPEC-053 §4.3 (*initial tuning*).
      features: { caves: 2, wrecks: 2, outcrops: 3, clusters: { count: 24, pieces: [3, 7], spread: 10 } },
      spawn: [
        { enemy: 'ash_crawler', weight: 6, maxAlive: 14, pack: [3, 5] },
        { enemy: 'magma_wraith', weight: 3, maxAlive: 6, pack: [1, 2] },
        { enemy: 'slag_spitter', weight: 2, maxAlive: 4 },
      ],
      population: 13,
      eliteChance: 0.07,
      hazards: [
        { id: 'lava_vent', groups: 7, per: [2, 3], arena: 0 },
        { id: 'basalt_column', groups: 9, per: [1, 1], arena: 2 },
        { id: 'magma_blister', groups: 8, per: [2, 3], arena: 2 },
      ],
    },
    music: { calm: 'calm_volcanic', combat: 'combat_heavy' },
  },

  hive: {
    id: 'hive',
    name: 'The Hive',
    chapter: 5,
    biome: 'hive',
    // SPEC-048 §4.7: the Queen's sentence is `c5_m2_done`'s alone.
    blurb: 'An asteroid gauntlet wrapped around a living interior.',
    unlock: [{ kind: 'flag', flag: 'chapter4_done' }],
    fuelCost: 120,
    travelSeconds: 200,
    flight: { asteroidDensity: 0.9, waves: ['hive_flight'], ionStorm: true },
    surface: {
      halfSize: 160,
      palette: { ground: '#3a2f4a', sky: '#241a33', fog: '#2f2440', accent: '#c04ad0' },
      // SPEC-018 §4.8 (*initial tuning*): still the thickest, but no longer so
      // dense the vein glow drowns.
      fogDensity: 0.032,
      look: {
        // SPEC-035 §4.3 (*initial tuning*): the surface look's bloom threshold
        // rose to 1.5, so the one world lit entirely by its own glow needs more
        // of it — sun 1.3 → 2.0, ambient 0.4 → 0.55, cracks 1.5 → 2.5.
        light: {
          sun: { color: '#b07ad8', intensity: 2.0, azimuth: 40, elevation: 40 },
          sky: '#3a2a4a',
          ground: '#1a1424',
          ambient: 0.55,
        },
        ground: { layers: ['chitin', 'flesh'], tileMetres: [5, 6.5], cracks: { color: '#c04ad0', intensity: 2.5 } },
        relief: { amplitude: 0.45, wavelength: 20, ridged: 0.5, bermHeight: 8 },
        scatter: { kind: 'spores', density: 2.0, second: 'crystals' },
        decals: ['slick', 'goo', 'cracks', 'gravel'],
        boundary: 'chitin_wall',
        // PLAN R28 / SPEC-067 (*initial tuning*): violet and cold teal flesh,
        // goo pools, and the hive's ribs, pods and resin.
        dressing: {
          macro: { hues: ['#b070c8', '#5a88a8'], strength: 0.5, value: 0.22, patches: 0.55 },
          rubble: ['#5a4868', '#382c44'],
          kinds: ['chitin_ribs', 'glow_pods', 'resin_mound'],
          trail: '#3a2c48',
        },
        // SPEC-053 §4.5 (*initial tuning*): hive tendrils.
        cover: { kinds: [{ cell: 12, weight: 1, size: [0.5, 1.0] }], per1000m2: 40 },
      },
      weather: null,
      pois: [
        { id: 'landing_pad', kind: 'landing_pad', label: POI_LABELS.landing_pad, count: 1, band: [0, 0], radius: 6, model: 'procedural' },
        { id: 'queen_chamber', kind: 'arena', label: POI_LABELS.queen_chamber, count: 1, band: [110, 140], radius: 22, boss: 'hive_queen', model: 'procedural' },
        // The spawn anchors the eggs of `c5_s1` grow on: 6 clusters × 3 (§7.4).
        { id: 'egg_cluster', kind: 'landmark', label: POI_LABELS.egg_cluster, count: 6, band: [40, 120], radius: 7, model: 'procedural' },
      ],
      nodes: [{ resource: 'lithium', count: 2, capacity: 60, regenPerSec: 0.4 }],
      obstacles: { density: 0.12, minRadius: 1.5, maxRadius: 4 },
      // SPEC-053 §4.3 (*initial tuning*).
      features: { caves: 2, wrecks: 1, outcrops: 2, clusters: { count: 16, pieces: [3, 6], spread: 9 } },
      spawn: [
        { enemy: 'hive_drone', weight: 6, maxAlive: 16, pack: [4, 6] },
        { enemy: 'hive_warrior', weight: 3, maxAlive: 6, pack: [1, 2] },
        { enemy: 'hive_spitter', weight: 2, maxAlive: 4 },
        { enemy: 'hive_egg', weight: 1, maxAlive: 18 },
      ],
      population: 15,
      eliteChance: 0.08,
      hazards: [
        { id: 'bile_geyser', groups: 6, per: [2, 3], arena: 0 },
        { id: 'chitin_spire', groups: 8, per: [1, 1], arena: 2 },
        { id: 'spore_sac', groups: 8, per: [2, 3], arena: 2 },
      ],
    },
    music: { calm: 'calm_hive', combat: 'combat_swarm' },
  },

  eden: {
    id: 'eden',
    name: 'Eden-Prime',
    chapter: 6,
    biome: 'temperate',
    blurb: 'Breathable, arable, temperate — everything the brief promised, which is exactly what is wrong with it.',
    unlock: [{ kind: 'flag', flag: 'chapter5_done' }],
    fuelCost: 120,
    travelSeconds: 150,
    flight: { asteroidDensity: 0.5, waves: ['eden_flight'], ionStorm: false },
    surface: {
      halfSize: 180,
      palette: { ground: '#6f9f5a', sky: '#bfe0f0', fog: '#a9d0b0', accent: '#f0e0a0' },
      // SPEC-018 §4.8 (*initial tuning*): the clearest sky in the game.
      fogDensity: 0.01,
      look: {
        light: {
          sun: { color: '#fff6dc', intensity: 2.6, azimuth: 30, elevation: 55 },
          sky: '#bfe0f0',
          ground: '#4f7a3a',
          ambient: 0.6,
        },
        // SPEC-053 §4.6: the seam — one straight line through the High Ridge
        // where the lawn does not match itself.
        ground: { layers: ['grass', 'soil'], tileMetres: [3.5, 5], seam: { poi: 'eden_ridge', axis: 'x', shift: 1.75 } },
        relief: { amplitude: 0.4, wavelength: 32, ridged: 0.2, bermHeight: 5 },
        scatter: { kind: 'tufts', density: 5.0, second: 'pebbles' },
        decals: ['crater', 'gravel', 'mudflat'],
        boundary: 'hills',
        // PLAN R28 / SPEC-067 (*initial tuning*): the paradise is tended —
        // gentle patches, straight gravel paths, field walls, survey posts and
        // perfectly round flower beds.
        dressing: {
          macro: { hues: ['#c0d870', '#6aa078'], strength: 0.35, value: 0.12, patches: 0.45 },
          rubble: ['#b4ac9c', '#8a8c80'],
          kinds: ['field_wall', 'marker_post', 'flower_bed'],
          trail: '#b8a88a',
        },
        // SPEC-053 §4.1, §4.4, §4.5 (*initial tuning*): leaves exactly as
        // authored in a light breeze, broad leaves and flowers under them, and
        // the densest, greenest lawn in the game.
        foliage: { tint: '#ffffff', wind: 0.6 },
        undergrowth: { cells: [14, 9], underPer1000m2: 20, openPer1000m2: 6 },
        cover: {
          kinds: [
            { cell: 6, weight: 3, size: [0.4, 0.6] },
            { cell: 7, weight: 2, size: [0.4, 0.6] },
            { cell: 9, weight: 1, size: [0.4, 0.6] },
          ],
          per1000m2: 300,
        },
      },
      weather: null,
      pois: [
        { id: 'landing_pad', kind: 'landing_pad', label: POI_LABELS.landing_pad, count: 1, band: [0, 0], radius: 6, model: 'procedural' },
        { id: 'eden_spring', kind: 'scan', label: POI_LABELS.eden_spring, count: 1, band: [50, 80], radius: 8, model: 'procedural' },
        { id: 'eden_forest', kind: 'scan', label: POI_LABELS.eden_forest, count: 1, band: [80, 120], radius: 8, model: 'procedural' },
        { id: 'eden_ridge', kind: 'scan', label: POI_LABELS.eden_ridge, count: 1, band: [120, 150], radius: 8, model: 'procedural' },
        { id: 'survey_beacon', kind: 'defend', label: POI_LABELS.survey_beacon, count: 1, band: [30, 50], radius: 10, hp: 600, model: 'procedural' },
        { id: 'grove', kind: 'landmark', label: POI_LABELS.grove, count: 5, band: [40, 150], radius: 6, model: 'procedural' },
      ],
      nodes: [
        { resource: 'wheat', count: 3, capacity: 80, regenPerSec: 0.5 },
        { resource: 'water', count: 3, capacity: 80, regenPerSec: 0.5 },
      ],
      obstacles: { density: 0.05, minRadius: 1.2, maxRadius: 3 },
      // SPEC-053 §4.3 (*initial tuning*): four orchards of one tree on a 7 m
      // lattice — rows no forest grows.
      features: { caves: 1, wrecks: 1, outcrops: 2, orchards: { count: 4, rows: 5, cols: 7, spacing: 7 } },
      // Eden is empty until the beacon calls them: everything that fights here
      // arrives with `eden_final` during `c6_m2` (§4.5).
      spawn: [],
      population: 0,
      eliteChance: 0.1,
      hazards: [
        { id: 'water_main', groups: 5, per: [1, 2], arena: 0 },
        { id: 'dead_oak', groups: 7, per: [1, 1], arena: 2 },
        { id: 'fertiliser_tank', groups: 7, per: [1, 2], arena: 2 },
      ],
    },
    music: { calm: 'calm_temperate', combat: 'combat_swarm' },
  },
} as const satisfies Record<PlanetId, PlanetDef>;

export type Planet = (typeof PLANETS)[PlanetId];
