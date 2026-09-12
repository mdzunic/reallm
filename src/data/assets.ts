// The asset manifest (SPEC-003 §4.3, D-26). Boot loads every model and texture
// listed here; audio is declared but not fetched — Howler loads it lazily
// (SPEC-006 §2.4, D-27).
//
// The id unions below are derived from the table keys, so every `assets.model()`
// / `assets.texture()` call is checked against what actually ships. `core/Assets`
// describes the shape (`AssetManifest`) and checks it at the `load()` call site;
// this file imports only data ids, like every other data module (SPEC-001 §4).
//
// The flight scene's art (PLAN R8) is not in `ASSETS`: `FLIGHT_ASSETS` and
// `PLANET_ART` below are fetched when a trip starts, never at boot.
//
// Audio (SPEC-006 §2): SFX are packed one sprite sheet per domain — `ui`,
// `surface`, `flight` — so a domain costs one request and one decode, and music
// is one looping file per track. `.webm` (Opus) is listed before `.mp3`, which
// is the order Howler tries them in: Opus everywhere it exists, MP3 for the
// rest. Sprite offsets are `[offsetMs, durationMs]`; the layouts below are the
// cut list every bank is assembled to — `scripts/assets/audio/build.mjs` reads
// them from here for the placeholder set it synthesises — spaced so a slightly
// early or late cut cannot bleed into its neighbour. A bank that will not decode
// is handled at runtime (SPEC-006 06-e).
//
// Every file is CC0 and listed in `public/assets/LICENSES.md`.

import type { PlanetId } from '@/data/ids';

export const ASSETS = {
  models: {
    crate: 'assets/models/crate.glb',
    /** Rigged, with one named clip — the skinning/animation spike of SPEC-002 §4.5. */
    character: 'assets/models/character.glb',
    /** Carries its own colour map, so the sRGB path is exercised end to end. */
    ship: 'assets/models/ship.glb',
  },
  textures: {
    grid: { url: 'assets/textures/grid.png', kind: 'color' },
    /** A non-colour mask (roughness / dust), so it must not be sRGB-decoded. */
    noise: { url: 'assets/textures/noise.png', kind: 'data' },
  },
  audio: {
    // ------------------------------------------------------- sfx banks (§2.2)
    /** Menu, HUD and dialogue stings — the one bank every scene uses. */
    ui: {
      src: ['assets/audio/sfx/ui.webm', 'assets/audio/sfx/ui.mp3'],
      bus: 'sfx',
      sprite: {
        ui_blip: [0, 200],
        ui_warn: [300, 300],
        ui_purchase: [700, 400],
        /** The simulation-plot sting; played for the dialogue ids of §5.2. */
        ui_glitch: [1200, 500],
        ui_dialogue_open: [1800, 300],
        level_up: [2200, 900],
        mission_done: [3200, 1200],
      },
    },
    /** Ground combat, pickups and weather on the XZ plane; the positioned bank. */
    surface: {
      src: ['assets/audio/sfx/surface.webm', 'assets/audio/sfx/surface.mp3'],
      bus: 'sfx',
      sprite: {
        hit_player: [0, 300],
        player_death: [400, 1200],
        bug_pop: [1700, 250],
        raider_death: [2050, 600],
        wraith_death: [2750, 700],
        elite_death: [3550, 900],
        enemy_death_generic: [4550, 500],
        boss_roar: [5150, 1800],
        boss_death: [7050, 2200],
        // PLAN §46's four core resources, plus the fallback every secondary
        // yield SPEC-009 adds takes — so the bank never has to be recut when
        // the resource table grows (§2.2).
        pickup_oil: [9350, 250],
        pickup_wheat: [9700, 250],
        pickup_water: [10050, 250],
        pickup_lithium: [10400, 250],
        pickup_generic: [10750, 250],
        scan_done: [11100, 600],
        alarm_weather: [11800, 1500],
        /** Started by the surface scene with `loop: true`, `priority: 0` (§4.2). */
        storm_loop: [13400, 4000],
      },
    },
    /** The rail scene: hits on the ship, and the two continuous channels. */
    flight: {
      src: ['assets/audio/sfx/flight.webm', 'assets/audio/sfx/flight.mp3'],
      bus: 'sfx',
      sprite: {
        ship_hit_shield: [0, 400],
        ship_hit_hull: [500, 450],
        landing_thrusters: [1050, 1600],
        engine_hum: [2750, 4000],
        laser_charge: [6850, 700],
      },
    },
    /** The story films' cues (PLAN R9, SPEC-021 §6.2), played on the film clock. */
    film: {
      src: ['assets/audio/sfx/film.webm', 'assets/audio/sfx/film.mp3'],
      bus: 'sfx',
      sprite: {
        film_hum: [0, 1600],
        film_whoosh: [1700, 1400],
        film_flash: [3200, 2500],
        film_rumble: [5800, 3000],
        film_wind: [8900, 3000],
        film_powerdown: [12000, 1200],
        film_lamp: [13300, 1500],
        film_stamp: [14900, 400],
        film_liftoff: [15400, 4000],
        film_clamp: [19500, 800],
        film_jump: [20400, 2000],
        film_relay: [22500, 1600],
        film_static: [24200, 600],
        film_beam: [24900, 2500],
        film_dissolve: [27500, 2000],
      },
    },

    // ----------------------------------------------------- music banks (§2.3)
    // One per `MusicId` (`core/Audio.ts`), reached by prefixing `music_`. No
    // sprite: each is a whole looping track, crossfaded by `audio.music()`.
    music_menu: { src: ['assets/audio/music/menu.webm', 'assets/audio/music/menu.mp3'], bus: 'music', loop: true },
    music_station: {
      src: ['assets/audio/music/station.webm', 'assets/audio/music/station.mp3'],
      bus: 'music',
      loop: true,
    },
    music_flight: {
      src: ['assets/audio/music/flight.webm', 'assets/audio/music/flight.mp3'],
      bus: 'music',
      loop: true,
    },
    music_surface_calm: {
      src: ['assets/audio/music/surface_calm.webm', 'assets/audio/music/surface_calm.mp3'],
      bus: 'music',
      loop: true,
    },
    music_surface_combat: {
      src: ['assets/audio/music/surface_combat.webm', 'assets/audio/music/surface_combat.mp3'],
      bus: 'music',
      loop: true,
    },
    music_boss: { src: ['assets/audio/music/boss.webm', 'assets/audio/music/boss.mp3'], bus: 'music', loop: true },
    music_ending: {
      src: ['assets/audio/music/ending.webm', 'assets/audio/music/ending.mp3'],
      bus: 'music',
      loop: true,
    },
    // The story films' beds (PLAN R9, SPEC-021 §6.1).
    music_film_dark: {
      src: ['assets/audio/music/film_dark.webm', 'assets/audio/music/film_dark.mp3'],
      bus: 'music',
      loop: true,
    },
    music_film_hope: {
      src: ['assets/audio/music/film_hope.webm', 'assets/audio/music/film_hope.mp3'],
      bus: 'music',
      loop: true,
    },
  },
} as const;

/**
 * The flight scene's shared art (PLAN R8, SPEC-020 §4.8): loaded by the flight
 * scene when a trip starts and cached like the boot set — never at boot, whose
 * e2e suites delay every request. Made by `scripts/assets/blender/`.
 */
export const FLIGHT_ASSETS = {
  models: {
    /** Baked `Hull` + flat `Glow`; the flight view instances both materials. */
    fighter: 'assets/models/fighter.glb',
    interceptor: 'assets/models/interceptor.glb',
    /** Camera space: the pilot looks along −Z. */
    cockpit: 'assets/models/cockpit.glb',
    /** Two rock shapes, one mesh each, mean radius 1. */
    asteroid: 'assets/models/asteroid.glb',
  },
  textures: {
    /** Grey is cloud cover — the cloud layer's alpha map, so data, not colour. */
    clouds: { url: 'assets/textures/flight/clouds.webp', kind: 'data' },
    ember: { url: 'assets/textures/sprites/ember.webp', kind: 'color' },
    flare: { url: 'assets/textures/sprites/flare.webp', kind: 'color' },
  },
  audio: {},
} as const;

/**
 * The hub scenes' backdrop set (SPEC-020 §4.4, §4.8): the dock ring, the
 * landing pad, and the nebula window the station, menu, creation screen and
 * star map sit in front of. Fetched by those scenes on `enter()`, never at
 * boot — PLAN R6-5 keeps the boot manifest at five files and
 * `e2e/boot-assets.spec.ts` measures exactly that traffic, so the two models
 * ride here rather than in `ASSETS.models`; where PLAN and a spec disagree,
 * PLAN wins. Every hub keeps its procedural modules until these land, and for
 * good if they never do (20-e).
 */
export const HUB_ASSETS = {
  models: {
    /** Flat, radius 2.2 m, origin at its centre; the scene tilts it. */
    station_ring: 'assets/models/station_ring.glb',
    /** The 1.1 m landing pad, centred. */
    dock: 'assets/models/dock.glb',
  },
  textures: {
    /** The station's forward window, on R8's `SKY_WINDOW` geometry. */
    sky_station: { url: 'assets/textures/flight/sky_station.webp', kind: 'color' },
  },
  audio: {},
} as const;

/** One destination's flight maps (PLAN R8); `emissive` only where the world glows. */
export interface PlanetArt {
  /** The forward sky window (`SKY_WINDOW` in views/FlightView). */
  readonly sky: string;
  /** Equirect albedo for SphereGeometry UVs. */
  readonly surface: string;
  /** Relief normals, OpenGL convention. */
  readonly normal: string;
  readonly emissive?: string;
}

/** Per-destination maps, owned and released by the flight scene. */
export const PLANET_ART: Readonly<Record<PlanetId, PlanetArt>> = {
  cinder4: {
    sky: 'assets/textures/flight/sky_cinder4.webp',
    surface: 'assets/textures/flight/planet_cinder4.webp',
    normal: 'assets/textures/flight/planet_cinder4_nr.webp',
  },
  vetra: {
    sky: 'assets/textures/flight/sky_vetra.webp',
    surface: 'assets/textures/flight/planet_vetra.webp',
    normal: 'assets/textures/flight/planet_vetra_nr.webp',
  },
  thessaly: {
    sky: 'assets/textures/flight/sky_thessaly.webp',
    surface: 'assets/textures/flight/planet_thessaly.webp',
    normal: 'assets/textures/flight/planet_thessaly_nr.webp',
  },
  ferrum: {
    sky: 'assets/textures/flight/sky_ferrum.webp',
    surface: 'assets/textures/flight/planet_ferrum.webp',
    normal: 'assets/textures/flight/planet_ferrum_nr.webp',
    emissive: 'assets/textures/flight/planet_ferrum_em.webp',
  },
  hive: {
    sky: 'assets/textures/flight/sky_hive.webp',
    surface: 'assets/textures/flight/planet_hive.webp',
    normal: 'assets/textures/flight/planet_hive_nr.webp',
    emissive: 'assets/textures/flight/planet_hive_em.webp',
  },
  eden: {
    sky: 'assets/textures/flight/sky_eden.webp',
    surface: 'assets/textures/flight/planet_eden.webp',
    normal: 'assets/textures/flight/planet_eden_nr.webp',
  },
};

/** The biome union of `PlanetDef` — spelled here so `data/` stays acyclic. */
type SurfaceBiome = 'desert' | 'ice' | 'jungle' | 'volcanic' | 'hive' | 'temperate';

/**
 * The per-planet surface drop (SPEC-018 §4.10): each biome's two ground layers
 * and its unit props, generated by `scripts/assets/blender/ground.py` and
 * `props.py` (PLAN R7). Loaded lazily by `SurfaceScene.onEnter`, never at boot
 * — the boot e2e suites delay every manifest request, so boot stays five
 * files. Tables may be empty for a biome whose drop has not landed.
 */
export const SURFACE_ASSETS = {
  desert: {
    models: {
      desert_rock_a: 'assets/models/props/desert_rock_a.glb',
      desert_rock_b: 'assets/models/props/desert_rock_b.glb',
      desert_ruin_a: 'assets/models/props/desert_ruin_a.glb',
      desert_ruin_b: 'assets/models/props/desert_ruin_b.glb',
    },
    textures: {
      sand_albedo: { url: 'assets/textures/ground/sand_albedo.webp', kind: 'color' },
      sand_nr: { url: 'assets/textures/ground/sand_nr.webp', kind: 'data' },
      cracked_earth_albedo: { url: 'assets/textures/ground/cracked_earth_albedo.webp', kind: 'color' },
      cracked_earth_nr: { url: 'assets/textures/ground/cracked_earth_nr.webp', kind: 'data' },
    },
  },
  ice: {
    models: {
      ice_rock_a: 'assets/models/props/ice_rock_a.glb',
      ice_rock_b: 'assets/models/props/ice_rock_b.glb',
      ice_spire_a: 'assets/models/props/ice_spire_a.glb',
      ice_spire_b: 'assets/models/props/ice_spire_b.glb',
    },
    textures: {
      snow_albedo: { url: 'assets/textures/ground/snow_albedo.webp', kind: 'color' },
      snow_nr: { url: 'assets/textures/ground/snow_nr.webp', kind: 'data' },
      ice_albedo: { url: 'assets/textures/ground/ice_albedo.webp', kind: 'color' },
      ice_nr: { url: 'assets/textures/ground/ice_nr.webp', kind: 'data' },
    },
  },
  jungle: {
    models: {
      jungle_tree_a: 'assets/models/props/jungle_tree_a.glb',
      jungle_tree_b: 'assets/models/props/jungle_tree_b.glb',
      jungle_ruin_a: 'assets/models/props/jungle_ruin_a.glb',
      jungle_ruin_b: 'assets/models/props/jungle_ruin_b.glb',
    },
    textures: {
      moss_albedo: { url: 'assets/textures/ground/moss_albedo.webp', kind: 'color' },
      moss_nr: { url: 'assets/textures/ground/moss_nr.webp', kind: 'data' },
      jungle_floor_albedo: { url: 'assets/textures/ground/jungle_floor_albedo.webp', kind: 'color' },
      jungle_floor_nr: { url: 'assets/textures/ground/jungle_floor_nr.webp', kind: 'data' },
    },
  },
  volcanic: {
    models: {
      volcanic_rock_a: 'assets/models/props/volcanic_rock_a.glb',
      volcanic_rock_b: 'assets/models/props/volcanic_rock_b.glb',
      volcanic_vent_a: 'assets/models/props/volcanic_vent_a.glb',
      volcanic_vent_b: 'assets/models/props/volcanic_vent_b.glb',
    },
    textures: {
      basalt_albedo: { url: 'assets/textures/ground/basalt_albedo.webp', kind: 'color' },
      basalt_nr: { url: 'assets/textures/ground/basalt_nr.webp', kind: 'data' },
      lava_rock_albedo: { url: 'assets/textures/ground/lava_rock_albedo.webp', kind: 'color' },
      lava_rock_nr: { url: 'assets/textures/ground/lava_rock_nr.webp', kind: 'data' },
    },
  },
  hive: {
    models: {
      hive_spire_a: 'assets/models/props/hive_spire_a.glb',
      hive_spire_b: 'assets/models/props/hive_spire_b.glb',
      hive_rock_a: 'assets/models/props/hive_rock_a.glb',
      hive_rock_b: 'assets/models/props/hive_rock_b.glb',
    },
    textures: {
      chitin_albedo: { url: 'assets/textures/ground/chitin_albedo.webp', kind: 'color' },
      chitin_nr: { url: 'assets/textures/ground/chitin_nr.webp', kind: 'data' },
      flesh_albedo: { url: 'assets/textures/ground/flesh_albedo.webp', kind: 'color' },
      flesh_nr: { url: 'assets/textures/ground/flesh_nr.webp', kind: 'data' },
    },
  },
  temperate: {
    models: {
      temperate_tree_a: 'assets/models/props/temperate_tree_a.glb',
      temperate_tree_b: 'assets/models/props/temperate_tree_b.glb',
      temperate_rock_a: 'assets/models/props/temperate_rock_a.glb',
      temperate_rock_b: 'assets/models/props/temperate_rock_b.glb',
    },
    textures: {
      grass_albedo: { url: 'assets/textures/ground/grass_albedo.webp', kind: 'color' },
      grass_nr: { url: 'assets/textures/ground/grass_nr.webp', kind: 'data' },
      soil_albedo: { url: 'assets/textures/ground/soil_albedo.webp', kind: 'color' },
      soil_nr: { url: 'assets/textures/ground/soil_nr.webp', kind: 'data' },
    },
  },
} as const satisfies Record<
  SurfaceBiome,
  {
    readonly models: Readonly<Record<string, string>>;
    readonly textures: Readonly<Record<string, { readonly url: string; readonly kind: 'color' | 'data' }>>;
  }
>;

/**
 * The lazily loaded shared surface set (SPEC-019 §4.8): models every planet's
 * surface visit uses, fetched with the per-planet drop on scene enter — never
 * at boot (PLAN R6-5: the boot manifest stays five files, and
 * `e2e/boot-assets.spec.ts` measures exactly that traffic). The shared load
 * promise dedupes by id, so each file is fetched once per session.
 */
export const SURFACE_SHARED_ASSETS = {
  models: {
    /** The escort probe (PLAN R8-1): a centred 1 m drone, lens toward +Z. */
    probe: 'assets/models/probe.glb',
  },
  textures: {},
} as const;

/** Every prop model id across the biome tables — the `PROP_MODELS` universe. */
export type SurfaceModelId = { [B in SurfaceBiome]: keyof (typeof SURFACE_ASSETS)[B]['models'] }[SurfaceBiome];
/** Every lazily loaded ground texture id (`<layer>_albedo` / `<layer>_nr`). */
export type SurfaceTextureId = { [B in SurfaceBiome]: keyof (typeof SURFACE_ASSETS)[B]['textures'] }[SurfaceBiome];

export type ModelId =
  | keyof typeof ASSETS.models
  | keyof typeof FLIGHT_ASSETS.models
  | keyof typeof HUB_ASSETS.models
  | keyof typeof SURFACE_SHARED_ASSETS.models
  | SurfaceModelId;
export type TextureId =
  | keyof typeof ASSETS.textures
  | keyof typeof FLIGHT_ASSETS.textures
  | keyof typeof HUB_ASSETS.textures
  | SurfaceTextureId;

/** Every key of `ASSETS.audio` — a sprite bank or a music track (§2.4). */
export type AudioBankId = keyof typeof ASSETS.audio;

/** `keyof` the sprite map of one entry; `never` for the music tracks, which have none. */
type SpriteKeysOf<E> = E extends { readonly sprite: infer S } ? keyof S : never;

/**
 * Every sprite key across every bank (§2.2, §2.4) — the 29 ids `audio.play()`
 * accepts. Derived rather than listed, so a sprite added above is playable and
 * a name that is not in a bank is a compile error at the call site.
 */
export type SoundId = SpriteKeysOf<(typeof ASSETS.audio)[AudioBankId]>;
