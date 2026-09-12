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
import type {
  BoundaryKind,
  DecalKind,
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
  };
  readonly relief: { readonly amplitude: number; readonly wavelength: number; readonly ridged: number; readonly bermHeight: number };
  readonly scatter: { readonly kind: ScatterKind; readonly density: number; readonly second?: ScatterKind };
  readonly decals: readonly DecalKind[];
  readonly boundary: BoundaryKind;
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
    } | null;
    readonly pois: readonly PoiDef[];
    readonly nodes: readonly {
      readonly resource: ResourceId;
      readonly count: number;
      readonly capacity: number;
      readonly regenPerSec: number;
    }[];
    readonly obstacles: { readonly density: number; readonly minRadius: number; readonly maxRadius: number };
    readonly spawn: readonly { readonly enemy: EnemyId; readonly weight: number; readonly maxAlive: number }[];
    /** Ambient waves the planet runs on its own; Eden has none until `c6_m2`. */
    readonly ambientWaves?: WaveId;
    /** Target simultaneous enemies at 'medium' quality. */
    readonly population: number;
    readonly eliteChance: number;
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
        decals: ['crater', 'scorch'],
        boundary: 'dunes',
      },
      weather: { cycle: ['sandstorm', 'heatwave'], calmSeconds: [90, 150], stormSeconds: [45, 75] },
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
      spawn: [
        { enemy: 'dust_skitter', weight: 6, maxAlive: 10 },
        { enemy: 'wurmling', weight: 3, maxAlive: 5 },
        { enemy: 'scav_raider', weight: 2, maxAlive: 4 },
      ],
      population: 14,
      eliteChance: 0.05,
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
        decals: ['frost', 'cracks'],
        boundary: 'ice_wall',
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
      spawn: [
        { enemy: 'frost_mite', weight: 6, maxAlive: 12 },
        { enemy: 'ice_crawler', weight: 3, maxAlive: 6 },
        { enemy: 'ice_spitter', weight: 2, maxAlive: 4 },
      ],
      population: 16,
      eliteChance: 0.05,
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
        decals: ['slick', 'cracks'],
        boundary: 'jungle_bank',
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
      spawn: [
        { enemy: 'hive_drone', weight: 6, maxAlive: 14 },
        { enemy: 'spore_hound', weight: 3, maxAlive: 6 },
        { enemy: 'spore_spitter', weight: 2, maxAlive: 4 },
      ],
      population: 18,
      eliteChance: 0.06,
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
        decals: ['scorch', 'cracks'],
        boundary: 'lava_ridge',
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
      spawn: [
        { enemy: 'ash_crawler', weight: 6, maxAlive: 14 },
        { enemy: 'magma_wraith', weight: 3, maxAlive: 6 },
        { enemy: 'slag_spitter', weight: 2, maxAlive: 4 },
      ],
      population: 18,
      eliteChance: 0.07,
    },
    music: { calm: 'calm_volcanic', combat: 'combat_heavy' },
  },

  hive: {
    id: 'hive',
    name: 'The Hive',
    chapter: 5,
    biome: 'hive',
    blurb: 'An asteroid gauntlet wrapped around a living interior. The Queen has known you were coming since Thessaly.',
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
        light: {
          sun: { color: '#b07ad8', intensity: 1.3, azimuth: 40, elevation: 40 },
          sky: '#3a2a4a',
          ground: '#1a1424',
          ambient: 0.4,
        },
        ground: { layers: ['chitin', 'flesh'], tileMetres: [5, 6.5], cracks: { color: '#c04ad0', intensity: 1.5 } },
        relief: { amplitude: 0.45, wavelength: 20, ridged: 0.5, bermHeight: 8 },
        scatter: { kind: 'spores', density: 2.0, second: 'crystals' },
        decals: ['slick'],
        boundary: 'chitin_wall',
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
      spawn: [
        { enemy: 'hive_drone', weight: 6, maxAlive: 16 },
        { enemy: 'hive_warrior', weight: 3, maxAlive: 6 },
        { enemy: 'hive_spitter', weight: 2, maxAlive: 4 },
        { enemy: 'hive_egg', weight: 1, maxAlive: 18 },
      ],
      population: 22,
      eliteChance: 0.08,
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
        ground: { layers: ['grass', 'soil'], tileMetres: [3.5, 5] },
        relief: { amplitude: 0.4, wavelength: 32, ridged: 0.2, bermHeight: 5 },
        scatter: { kind: 'tufts', density: 5.0, second: 'pebbles' },
        decals: ['crater'],
        boundary: 'hills',
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
      // Eden is empty until the beacon calls them: everything that fights here
      // arrives with `eden_final` during `c6_m2` (§4.5).
      spawn: [],
      population: 0,
      eliteChance: 0.1,
    },
    music: { calm: 'calm_temperate', combat: 'combat_swarm' },
  },
} as const satisfies Record<PlanetId, PlanetDef>;

export type Planet = (typeof PLANETS)[PlanetId];
