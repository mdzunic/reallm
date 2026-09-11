# Asset licenses

Every file under `public/assets/` is listed here with its source, license and
modifications (SPEC-001 §10). Everything shipped is **CC0** (public domain).
Budget: precached assets ≤ 25 MB in total, models ≤ 4 MB, audio ≤ 12 MB,
textures ≤ 6 MB.

| File | Source | License | Modifications |
| --- | --- | --- | --- |
| `models/crate.glb` | Original to this repository — a unit box generated with `three`'s `GLTFExporter` | CC0 | — |
| `models/character.glb` | Original to this repository — a rigged two-bone figure with one `Idle` clip, glTF binary written procedurally | CC0 | — |
| `models/ship.glb` | Original to this repository — hull, wings and canopy with an embedded 64×64 sRGB hull map, glTF binary written procedurally | CC0 | — |
| `textures/grid.png` | Original to this repository — 64×64 panel grid, generated procedurally | CC0 | — |
| `textures/noise.png` | Original to this repository — 64×64 value-noise mask (non-colour data), generated procedurally | CC0 | — |

The five files above are the manifest's entries (SPEC-003 §4.3, SPEC-002 §4.5):
they exist so boot loads something real, and `character.glb` / `ship.glb` are
the asset spike — skinning through `SkeletonUtils.clone`, one named clip through
an `AnimationMixer`, and a `baseColorTexture` the loader decodes as sRGB.

SPEC-002 D-J allows Kenney Mini Characters and Kenney Space Kit here instead;
they are not fetchable from the build environment, so equivalent CC0 files were
generated in-repo, the precedent `models/crate.glb` already set. The manifest
ids, the code path and this table are the same either way. The Kenney packs land
with the scenes that need them.

The audio files are placeholders in the same spirit (SPEC-006 §2): original
sounds synthesised from code by `node scripts/assets/audio/build.mjs`, which
reads the bank layout from `src/data/assets.ts` and is deterministic, so a
rebuild writes the same samples. SPEC-006 pairs every `.webm` (Opus) with an
`.mp3` fallback; the script writes those too when `lame` is installed, and until
they land a browser without Opus stays silent with one warning (SPEC-006 06-e).
A CC0 pack can replace any file under the same name, with its row changed to
match. The 12 MB audio budget above is what they share.

| File | Source | License | Modifications |
| --- | --- | --- | --- |
| `audio/sfx/ui.webm` | Original to this repository — synthesised by `scripts/assets/audio/sfx.mjs` | CC0 | — |
| `audio/sfx/surface.webm` | Original to this repository — synthesised by `scripts/assets/audio/sfx.mjs` | CC0 | — |
| `audio/sfx/flight.webm` | Original to this repository — synthesised by `scripts/assets/audio/sfx.mjs` | CC0 | — |
| `audio/music/menu.webm` | Original to this repository — synthesised by `scripts/assets/audio/music.mjs` | CC0 | — |
| `audio/music/station.webm` | Original to this repository — synthesised by `scripts/assets/audio/music.mjs` | CC0 | — |
| `audio/music/flight.webm` | Original to this repository — synthesised by `scripts/assets/audio/music.mjs` | CC0 | — |
| `audio/music/surface_calm.webm` | Original to this repository — synthesised by `scripts/assets/audio/music.mjs` | CC0 | — |
| `audio/music/surface_combat.webm` | Original to this repository — synthesised by `scripts/assets/audio/music.mjs` | CC0 | — |
| `audio/music/boss.webm` | Original to this repository — synthesised by `scripts/assets/audio/music.mjs` | CC0 | — |
| `audio/music/ending.webm` | Original to this repository — synthesised by `scripts/assets/audio/music.mjs` | CC0 | — |

Outside this folder: `public/favicon.svg` is original to this repository, CC0.
