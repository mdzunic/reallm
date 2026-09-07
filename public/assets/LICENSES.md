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

`audio/` is still empty. SPEC-006 declares what will go in it — three sfx sprite
banks (`audio/sfx/{ui,surface,flight}.{webm,mp3}`) and seven looping tracks
(`audio/music/{menu,station,flight,surface_calm,surface_combat,boss,ending}.{webm,mp3}`)
— but producing the CC0 sound files is out of that spec's scope, and the audio
layer is built so a bank that will not decode falls back to silence with one
warning rather than a failure (SPEC-006 06-e). Each file gets its row here on
the day it lands; the 12 MB audio budget above is what they share.

Outside this folder: `public/favicon.svg` is original to this repository, CC0.
