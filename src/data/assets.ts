// The asset manifest (SPEC-003 §4.3, D-26). Boot loads every model and texture
// listed here; audio is declared but not fetched — Howler loads it lazily
// (SPEC-006 §2.4, D-27).
//
// The id unions below are derived from the table keys, so every `assets.model()`
// / `assets.texture()` call is checked against what actually ships. `core/Assets`
// describes the shape (`AssetManifest`) and checks it at the `load()` call site;
// this file imports nothing, like every other data module (SPEC-001 §4).
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
  },
} as const;

export type ModelId = keyof typeof ASSETS.models;
export type TextureId = keyof typeof ASSETS.textures;

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
