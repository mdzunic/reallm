// The asset manifest (SPEC-003 §4.3, D-26). Boot loads every model and texture
// listed here; audio is declared but not fetched — Howler loads it lazily
// (SPEC-006, D-27).
//
// The id unions below are derived from the table keys, so every `assets.model()`
// / `assets.texture()` call is checked against what actually ships. `core/Assets`
// describes the shape (`AssetManifest`) and checks it at the `load()` call site;
// this file imports nothing, like every other data module (SPEC-001 §4).
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
  audio: {},
} as const;

export type ModelId = keyof typeof ASSETS.models;
export type TextureId = keyof typeof ASSETS.textures;
export type SoundId = keyof typeof ASSETS.audio;
