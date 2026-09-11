# Asset licenses

Every file under `public/assets/` is listed here with its source, license and
modifications (SPEC-001 §10). Everything shipped is **CC0** (public domain).
Budget: precached assets ≤ 25 MB in total, models ≤ 4 MB, audio ≤ 12 MB,
textures ≤ 6 MB.

| File | Source | License | Modifications |
| --- | --- | --- | --- |
| `textures/grid.png` | Original to this repository — 64×64 panel grid, generated procedurally | CC0 | — |
| `textures/noise.png` | Original to this repository — 64×64 value-noise mask (non-colour data), generated procedurally | CC0 | — |

The boot manifest (SPEC-003 §4.3, SPEC-002 §4.5) loads these two textures and
three models — `models/crate.glb`, `models/character.glb` and `models/ship.glb`,
listed below with the rest of the Blender set. `character.glb` and `ship.glb`
are also the asset spike: skinning through `SkeletonUtils.clone`, a named clip
through an `AnimationMixer` (`Idle` is the first clip), and a `baseColorTexture`
the loader decodes as sRGB (the tug's hull map).

Models, ground layers, VFX sprites and portraits are generated in-repo rather
than downloaded (PLAN R7): each is built from code by Blender 5.2 running
headless — `node scripts/assets/blender/build.mjs` — and a rebuild with the
same Blender version writes the same files. They are original work, CC0. A CC0
pack can replace any of them under the same name, with its row moved out of the
generated table below and changed to match. The table between the markers is
rewritten by the build from the files on disk; do not edit it by hand.

<!-- blender:start -->
| File | Source | License | Modifications |
| --- | --- | --- | --- |
| `models/asteroid.glb` | Original to this repository — two rocks, normals baked from a displaced high-poly; generated in Blender by `scripts/assets/blender/flight.py` | CC0 | — |
| `models/character.glb` | Original to this repository — rigged salvager, clips Idle · Run · Attack · Hit · Death; generated in Blender by `scripts/assets/blender/character.py` | CC0 | — |
| `models/cockpit.glb` | Original to this repository — modelled from code, hull and screen maps baked in Cycles; generated in Blender by `scripts/assets/blender/station.py` | CC0 | — |
| `models/crate.glb` | Original to this repository — modelled from code; generated in Blender by `scripts/assets/blender/station.py` | CC0 | — |
| `models/dock.glb` | Original to this repository — modelled from code; generated in Blender by `scripts/assets/blender/station.py` | CC0 | — |
| `models/fighter.glb` | Original to this repository — modelled from code, hull maps baked in Cycles; generated in Blender by `scripts/assets/blender/ships.py` | CC0 | — |
| `models/interceptor.glb` | Original to this repository — modelled from code, hull maps baked in Cycles; generated in Blender by `scripts/assets/blender/ships.py` | CC0 | — |
| `models/probe.glb` | Original to this repository — modelled from code, hull maps baked in Cycles; generated in Blender by `scripts/assets/blender/ships.py` | CC0 | — |
| `models/props/desert_rock_a.glb` | Original to this repository — unit prop, biome colours in vertex colours; generated in Blender by `scripts/assets/blender/props.py` | CC0 | — |
| `models/props/desert_rock_b.glb` | Original to this repository — unit prop, biome colours in vertex colours; generated in Blender by `scripts/assets/blender/props.py` | CC0 | — |
| `models/props/desert_ruin_a.glb` | Original to this repository — unit prop, biome colours in vertex colours; generated in Blender by `scripts/assets/blender/props.py` | CC0 | — |
| `models/props/desert_ruin_b.glb` | Original to this repository — unit prop, biome colours in vertex colours; generated in Blender by `scripts/assets/blender/props.py` | CC0 | — |
| `models/props/hive_rock_a.glb` | Original to this repository — unit prop, biome colours in vertex colours; generated in Blender by `scripts/assets/blender/props.py` | CC0 | — |
| `models/props/hive_rock_b.glb` | Original to this repository — unit prop, biome colours in vertex colours; generated in Blender by `scripts/assets/blender/props.py` | CC0 | — |
| `models/props/hive_spire_a.glb` | Original to this repository — unit prop, biome colours in vertex colours; generated in Blender by `scripts/assets/blender/props.py` | CC0 | — |
| `models/props/hive_spire_b.glb` | Original to this repository — unit prop, biome colours in vertex colours; generated in Blender by `scripts/assets/blender/props.py` | CC0 | — |
| `models/props/ice_rock_a.glb` | Original to this repository — unit prop, biome colours in vertex colours; generated in Blender by `scripts/assets/blender/props.py` | CC0 | — |
| `models/props/ice_rock_b.glb` | Original to this repository — unit prop, biome colours in vertex colours; generated in Blender by `scripts/assets/blender/props.py` | CC0 | — |
| `models/props/ice_spire_a.glb` | Original to this repository — unit prop, biome colours in vertex colours; generated in Blender by `scripts/assets/blender/props.py` | CC0 | — |
| `models/props/ice_spire_b.glb` | Original to this repository — unit prop, biome colours in vertex colours; generated in Blender by `scripts/assets/blender/props.py` | CC0 | — |
| `models/props/jungle_ruin_a.glb` | Original to this repository — unit prop, biome colours in vertex colours; generated in Blender by `scripts/assets/blender/props.py` | CC0 | — |
| `models/props/jungle_ruin_b.glb` | Original to this repository — unit prop, biome colours in vertex colours; generated in Blender by `scripts/assets/blender/props.py` | CC0 | — |
| `models/props/jungle_tree_a.glb` | Original to this repository — unit prop, biome colours in vertex colours; generated in Blender by `scripts/assets/blender/props.py` | CC0 | — |
| `models/props/jungle_tree_b.glb` | Original to this repository — unit prop, biome colours in vertex colours; generated in Blender by `scripts/assets/blender/props.py` | CC0 | — |
| `models/props/temperate_rock_a.glb` | Original to this repository — unit prop, biome colours in vertex colours; generated in Blender by `scripts/assets/blender/props.py` | CC0 | — |
| `models/props/temperate_rock_b.glb` | Original to this repository — unit prop, biome colours in vertex colours; generated in Blender by `scripts/assets/blender/props.py` | CC0 | — |
| `models/props/temperate_tree_a.glb` | Original to this repository — unit prop, biome colours in vertex colours; generated in Blender by `scripts/assets/blender/props.py` | CC0 | — |
| `models/props/temperate_tree_b.glb` | Original to this repository — unit prop, biome colours in vertex colours; generated in Blender by `scripts/assets/blender/props.py` | CC0 | — |
| `models/props/volcanic_rock_a.glb` | Original to this repository — unit prop, biome colours in vertex colours; generated in Blender by `scripts/assets/blender/props.py` | CC0 | — |
| `models/props/volcanic_rock_b.glb` | Original to this repository — unit prop, biome colours in vertex colours; generated in Blender by `scripts/assets/blender/props.py` | CC0 | — |
| `models/props/volcanic_vent_a.glb` | Original to this repository — unit prop, biome colours in vertex colours; generated in Blender by `scripts/assets/blender/props.py` | CC0 | — |
| `models/props/volcanic_vent_b.glb` | Original to this repository — unit prop, biome colours in vertex colours; generated in Blender by `scripts/assets/blender/props.py` | CC0 | — |
| `models/ship.glb` | Original to this repository — modelled from code, hull maps baked in Cycles; generated in Blender by `scripts/assets/blender/ships.py` | CC0 | — |
| `models/station_ring.glb` | Original to this repository — modelled from code; generated in Blender by `scripts/assets/blender/station.py` | CC0 | — |
| `portraits/01.webp` | Original to this repository — EEVEE bust of the salvager; generated in Blender by `scripts/assets/blender/portraits.py` | CC0 | — |
| `portraits/02.webp` | Original to this repository — EEVEE bust of the salvager; generated in Blender by `scripts/assets/blender/portraits.py` | CC0 | — |
| `portraits/03.webp` | Original to this repository — EEVEE bust of the salvager; generated in Blender by `scripts/assets/blender/portraits.py` | CC0 | — |
| `portraits/04.webp` | Original to this repository — EEVEE bust of the salvager; generated in Blender by `scripts/assets/blender/portraits.py` | CC0 | — |
| `portraits/05.webp` | Original to this repository — EEVEE bust of the salvager; generated in Blender by `scripts/assets/blender/portraits.py` | CC0 | — |
| `portraits/06.webp` | Original to this repository — EEVEE bust of the salvager; generated in Blender by `scripts/assets/blender/portraits.py` | CC0 | — |
| `portraits/07.webp` | Original to this repository — EEVEE bust of the salvager; generated in Blender by `scripts/assets/blender/portraits.py` | CC0 | — |
| `portraits/08.webp` | Original to this repository — EEVEE bust of the salvager; generated in Blender by `scripts/assets/blender/portraits.py` | CC0 | — |
| `portraits/09.webp` | Original to this repository — EEVEE bust of the salvager; generated in Blender by `scripts/assets/blender/portraits.py` | CC0 | — |
| `portraits/10.webp` | Original to this repository — EEVEE bust of the salvager; generated in Blender by `scripts/assets/blender/portraits.py` | CC0 | — |
| `portraits/11.webp` | Original to this repository — EEVEE bust of the salvager; generated in Blender by `scripts/assets/blender/portraits.py` | CC0 | — |
| `portraits/12.webp` | Original to this repository — EEVEE bust of the salvager; generated in Blender by `scripts/assets/blender/portraits.py` | CC0 | — |
| `portraits/manifest.json` | Original to this repository — EEVEE bust of the salvager; generated in Blender by `scripts/assets/blender/portraits.py` | CC0 | — |
| `textures/flight/clouds.webp` | Original to this repository — cloud cover baked from Noise fields; generated in Blender by `scripts/assets/blender/flight.py` | CC0 | — |
| `textures/flight/planet_cinder4_nr.webp` | Original to this repository — planet map baked from Noise/Voronoi fields; generated in Blender by `scripts/assets/blender/flight.py` | CC0 | — |
| `textures/flight/planet_cinder4.webp` | Original to this repository — planet map baked from Noise/Voronoi fields; generated in Blender by `scripts/assets/blender/flight.py` | CC0 | — |
| `textures/flight/planet_eden_nr.webp` | Original to this repository — planet map baked from Noise/Voronoi fields; generated in Blender by `scripts/assets/blender/flight.py` | CC0 | — |
| `textures/flight/planet_eden.webp` | Original to this repository — planet map baked from Noise/Voronoi fields; generated in Blender by `scripts/assets/blender/flight.py` | CC0 | — |
| `textures/flight/planet_ferrum_em.webp` | Original to this repository — planet map baked from Noise/Voronoi fields; generated in Blender by `scripts/assets/blender/flight.py` | CC0 | — |
| `textures/flight/planet_ferrum_nr.webp` | Original to this repository — planet map baked from Noise/Voronoi fields; generated in Blender by `scripts/assets/blender/flight.py` | CC0 | — |
| `textures/flight/planet_ferrum.webp` | Original to this repository — planet map baked from Noise/Voronoi fields; generated in Blender by `scripts/assets/blender/flight.py` | CC0 | — |
| `textures/flight/planet_hive_em.webp` | Original to this repository — planet map baked from Noise/Voronoi fields; generated in Blender by `scripts/assets/blender/flight.py` | CC0 | — |
| `textures/flight/planet_hive_nr.webp` | Original to this repository — planet map baked from Noise/Voronoi fields; generated in Blender by `scripts/assets/blender/flight.py` | CC0 | — |
| `textures/flight/planet_hive.webp` | Original to this repository — planet map baked from Noise/Voronoi fields; generated in Blender by `scripts/assets/blender/flight.py` | CC0 | — |
| `textures/flight/planet_thessaly_nr.webp` | Original to this repository — planet map baked from Noise/Voronoi fields; generated in Blender by `scripts/assets/blender/flight.py` | CC0 | — |
| `textures/flight/planet_thessaly.webp` | Original to this repository — planet map baked from Noise/Voronoi fields; generated in Blender by `scripts/assets/blender/flight.py` | CC0 | — |
| `textures/flight/planet_vetra_nr.webp` | Original to this repository — planet map baked from Noise/Voronoi fields; generated in Blender by `scripts/assets/blender/flight.py` | CC0 | — |
| `textures/flight/planet_vetra.webp` | Original to this repository — planet map baked from Noise/Voronoi fields; generated in Blender by `scripts/assets/blender/flight.py` | CC0 | — |
| `textures/flight/sky_cinder4.webp` | Original to this repository — sky window baked from Noise/Voronoi fields; generated in Blender by `scripts/assets/blender/flight.py` | CC0 | — |
| `textures/flight/sky_eden.webp` | Original to this repository — sky window baked from Noise/Voronoi fields; generated in Blender by `scripts/assets/blender/flight.py` | CC0 | — |
| `textures/flight/sky_ferrum.webp` | Original to this repository — sky window baked from Noise/Voronoi fields; generated in Blender by `scripts/assets/blender/flight.py` | CC0 | — |
| `textures/flight/sky_hive.webp` | Original to this repository — sky window baked from Noise/Voronoi fields; generated in Blender by `scripts/assets/blender/flight.py` | CC0 | — |
| `textures/flight/sky_station.webp` | Original to this repository — sky window baked from Noise/Voronoi fields; generated in Blender by `scripts/assets/blender/flight.py` | CC0 | — |
| `textures/flight/sky_thessaly.webp` | Original to this repository — sky window baked from Noise/Voronoi fields; generated in Blender by `scripts/assets/blender/flight.py` | CC0 | — |
| `textures/flight/sky_vetra.webp` | Original to this repository — sky window baked from Noise/Voronoi fields; generated in Blender by `scripts/assets/blender/flight.py` | CC0 | — |
| `textures/ground/basalt_albedo.webp` | Original to this repository — baked seamless 4D noise/Voronoi fields, packed with numpy; generated in Blender by `scripts/assets/blender/ground.py` | CC0 | — |
| `textures/ground/basalt_nr.webp` | Original to this repository — baked seamless 4D noise/Voronoi fields, packed with numpy; generated in Blender by `scripts/assets/blender/ground.py` | CC0 | — |
| `textures/ground/chitin_albedo.webp` | Original to this repository — baked seamless 4D noise/Voronoi fields, packed with numpy; generated in Blender by `scripts/assets/blender/ground.py` | CC0 | — |
| `textures/ground/chitin_nr.webp` | Original to this repository — baked seamless 4D noise/Voronoi fields, packed with numpy; generated in Blender by `scripts/assets/blender/ground.py` | CC0 | — |
| `textures/ground/cracked_earth_albedo.webp` | Original to this repository — baked seamless 4D noise/Voronoi fields, packed with numpy; generated in Blender by `scripts/assets/blender/ground.py` | CC0 | — |
| `textures/ground/cracked_earth_nr.webp` | Original to this repository — baked seamless 4D noise/Voronoi fields, packed with numpy; generated in Blender by `scripts/assets/blender/ground.py` | CC0 | — |
| `textures/ground/flesh_albedo.webp` | Original to this repository — baked seamless 4D noise/Voronoi fields, packed with numpy; generated in Blender by `scripts/assets/blender/ground.py` | CC0 | — |
| `textures/ground/flesh_nr.webp` | Original to this repository — baked seamless 4D noise/Voronoi fields, packed with numpy; generated in Blender by `scripts/assets/blender/ground.py` | CC0 | — |
| `textures/ground/grass_albedo.webp` | Original to this repository — baked seamless 4D noise/Voronoi fields, packed with numpy; generated in Blender by `scripts/assets/blender/ground.py` | CC0 | — |
| `textures/ground/grass_nr.webp` | Original to this repository — baked seamless 4D noise/Voronoi fields, packed with numpy; generated in Blender by `scripts/assets/blender/ground.py` | CC0 | — |
| `textures/ground/ice_albedo.webp` | Original to this repository — baked seamless 4D noise/Voronoi fields, packed with numpy; generated in Blender by `scripts/assets/blender/ground.py` | CC0 | — |
| `textures/ground/ice_nr.webp` | Original to this repository — baked seamless 4D noise/Voronoi fields, packed with numpy; generated in Blender by `scripts/assets/blender/ground.py` | CC0 | — |
| `textures/ground/jungle_floor_albedo.webp` | Original to this repository — baked seamless 4D noise/Voronoi fields, packed with numpy; generated in Blender by `scripts/assets/blender/ground.py` | CC0 | — |
| `textures/ground/jungle_floor_nr.webp` | Original to this repository — baked seamless 4D noise/Voronoi fields, packed with numpy; generated in Blender by `scripts/assets/blender/ground.py` | CC0 | — |
| `textures/ground/lava_rock_albedo.webp` | Original to this repository — baked seamless 4D noise/Voronoi fields, packed with numpy; generated in Blender by `scripts/assets/blender/ground.py` | CC0 | — |
| `textures/ground/lava_rock_nr.webp` | Original to this repository — baked seamless 4D noise/Voronoi fields, packed with numpy; generated in Blender by `scripts/assets/blender/ground.py` | CC0 | — |
| `textures/ground/moss_albedo.webp` | Original to this repository — baked seamless 4D noise/Voronoi fields, packed with numpy; generated in Blender by `scripts/assets/blender/ground.py` | CC0 | — |
| `textures/ground/moss_nr.webp` | Original to this repository — baked seamless 4D noise/Voronoi fields, packed with numpy; generated in Blender by `scripts/assets/blender/ground.py` | CC0 | — |
| `textures/ground/rock_albedo.webp` | Original to this repository — baked seamless 4D noise/Voronoi fields, packed with numpy; generated in Blender by `scripts/assets/blender/ground.py` | CC0 | — |
| `textures/ground/rock_nr.webp` | Original to this repository — baked seamless 4D noise/Voronoi fields, packed with numpy; generated in Blender by `scripts/assets/blender/ground.py` | CC0 | — |
| `textures/ground/sand_albedo.webp` | Original to this repository — baked seamless 4D noise/Voronoi fields, packed with numpy; generated in Blender by `scripts/assets/blender/ground.py` | CC0 | — |
| `textures/ground/sand_nr.webp` | Original to this repository — baked seamless 4D noise/Voronoi fields, packed with numpy; generated in Blender by `scripts/assets/blender/ground.py` | CC0 | — |
| `textures/ground/snow_albedo.webp` | Original to this repository — baked seamless 4D noise/Voronoi fields, packed with numpy; generated in Blender by `scripts/assets/blender/ground.py` | CC0 | — |
| `textures/ground/snow_nr.webp` | Original to this repository — baked seamless 4D noise/Voronoi fields, packed with numpy; generated in Blender by `scripts/assets/blender/ground.py` | CC0 | — |
| `textures/ground/soil_albedo.webp` | Original to this repository — baked seamless 4D noise/Voronoi fields, packed with numpy; generated in Blender by `scripts/assets/blender/ground.py` | CC0 | — |
| `textures/ground/soil_nr.webp` | Original to this repository — baked seamless 4D noise/Voronoi fields, packed with numpy; generated in Blender by `scripts/assets/blender/ground.py` | CC0 | — |
| `textures/sprites/dirt.webp` | Original to this repository — numpy radial and noise fields; generated in Blender by `scripts/assets/blender/sprites.py` | CC0 | — |
| `textures/sprites/ember.webp` | Original to this repository — numpy radial and noise fields; generated in Blender by `scripts/assets/blender/sprites.py` | CC0 | — |
| `textures/sprites/flake.webp` | Original to this repository — numpy radial and noise fields; generated in Blender by `scripts/assets/blender/sprites.py` | CC0 | — |
| `textures/sprites/flare.webp` | Original to this repository — numpy radial and noise fields; generated in Blender by `scripts/assets/blender/sprites.py` | CC0 | — |
| `textures/sprites/magic.webp` | Original to this repository — numpy radial and noise fields; generated in Blender by `scripts/assets/blender/sprites.py` | CC0 | — |
| `textures/sprites/muzzle.webp` | Original to this repository — numpy radial and noise fields; generated in Blender by `scripts/assets/blender/sprites.py` | CC0 | — |
| `textures/sprites/ring.webp` | Original to this repository — numpy radial and noise fields; generated in Blender by `scripts/assets/blender/sprites.py` | CC0 | — |
| `textures/sprites/smoke.webp` | Original to this repository — numpy radial and noise fields; generated in Blender by `scripts/assets/blender/sprites.py` | CC0 | — |
| `textures/sprites/spark.webp` | Original to this repository — numpy radial and noise fields; generated in Blender by `scripts/assets/blender/sprites.py` | CC0 | — |
| `textures/sprites/streak.webp` | Original to this repository — numpy radial and noise fields; generated in Blender by `scripts/assets/blender/sprites.py` | CC0 | — |
<!-- blender:end -->

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
