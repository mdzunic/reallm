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

## Plates

Seven shots of the story films are **photographic plates** (PLAN R11, R12, R13)
— six pictures, one of which serves two shots — and
the Selection cards carry six photographed faces: the pictures are committed
images under `scripts/assets/blender/plates/`, and `films.py` renders them
through each film's own look instead of building the scene. They are art, not
code, so the build cannot write their rows — these are kept by hand, and the
films and posters that carry one name it in the generated table below.

**The photographs were generated with Google Gemini**, prompted for this
repository; everything else in `public/assets/` is generated from the committed
scripts or synthesised.

| Plate | Where | Source | License | Modifications |
| --- | --- | --- | --- | --- |
| `plates/prologue_curfew.jpg` | `prologue/curfew` (16–23 s) | Generated with Google Gemini for this repository | CC0 | Rendered at exposure 0.80, saturation 0.95, panning right across the frame |
| `plates/prologue_sabotage.jpg` | `prologue/sabotage` (23–30 s) | Generated with Google Gemini for this repository | CC0 | Rendered at exposure 0.95, saturation 0.95, with a slow push and an authored flash at 29.2 s |
| `plates/prologue_reprisal.jpg` | `prologue/reprisal` (30–37 s) | Generated with Google Gemini for this repository | CC0 | Rendered at exposure 0.76, saturation 0.95, pulling out to the whole frame |
| `plates/prologue_city_flash.jpg` | `prologue/city_flash` (46–56 s) | Generated with Google Gemini for this repository | CC0 | Rendered at exposure 0.92, saturation 0.95, pulling out, with an authored flash at 47.25 s |
| `plates/prologue_shelter.jpg` | `prologue/shelter` (66–75 s) and `interlude_c1/shelter_light` (5–10 s) | Generated with Google Gemini for this repository | CC0 | Rendered at exposure 0.75 and 0.55, saturation 0.92, each with its own push and drift; the lamp flickers, and in the interlude the light lifts to 1.55× at 2 s |
| `plates/interlude_c2_tap.jpg` | `interlude_c2/tap` (5–10 s) | Generated with Google Gemini for this repository | CC0 | Rendered at exposure 0.95, saturation 0.95, with a slow push and drift |
| `plates/selection/01.webp` … `06.webp` | the Selection cards of `prologue/selection`, `ending_stay/wall_63` and `ending_escape/wall_same` | Generated with Google Gemini for this repository | CC0 | Six faces cut from one sheet to 320² and saved as WebP; the wall shows each of them twice |

<!-- blender:start -->
| File | Source | License | Modifications |
| --- | --- | --- | --- |
| `films/departure.mp4` | Original to this repository — story film rendered in EEVEE from code (PLAN R9); generated in Blender by `scripts/assets/blender/films.py` | CC0 | — |
| `films/ending_escape.mp4` | Original to this repository — story film rendered in EEVEE from code over the photographic plates listed under Plates above (PLAN R9, R11, R12); generated in Blender by `scripts/assets/blender/films.py` | CC0 | — |
| `films/ending_stay.mp4` | Original to this repository — story film rendered in EEVEE from code over the photographic plates listed under Plates above (PLAN R9, R11, R12); generated in Blender by `scripts/assets/blender/films.py` | CC0 | — |
| `films/interlude_c1.mp4` | Original to this repository — story film rendered in EEVEE from code (PLAN R9); generated in Blender by `scripts/assets/blender/films.py` | CC0 | — |
| `films/interlude_c2.mp4` | Original to this repository — story film rendered in EEVEE from code over the photographic plates listed under Plates above (PLAN R9, R11, R12); generated in Blender by `scripts/assets/blender/films.py` | CC0 | — |
| `films/interlude_c3.mp4` | Original to this repository — story film rendered in EEVEE from code (PLAN R9); generated in Blender by `scripts/assets/blender/films.py` | CC0 | — |
| `films/interlude_c4.mp4` | Original to this repository — story film rendered in EEVEE from code (PLAN R9); generated in Blender by `scripts/assets/blender/films.py` | CC0 | — |
| `films/interlude_c5.mp4` | Original to this repository — story film rendered in EEVEE from code (PLAN R9); generated in Blender by `scripts/assets/blender/films.py` | CC0 | — |
| `films/manifest.json` | Original to this repository — story film manifest (PLAN R9); generated in Blender by `scripts/assets/blender/films.py` | CC0 | — |
| `films/posters/departure_jump.webp` | Original to this repository — story film poster, a frame of its shot (PLAN R9); generated in Blender by `scripts/assets/blender/films.py` | CC0 | — |
| `films/posters/departure_undock.webp` | Original to this repository — story film poster, a frame of its shot (PLAN R9); generated in Blender by `scripts/assets/blender/films.py` | CC0 | — |
| `films/posters/ending_escape_earth_unmade.webp` | Original to this repository — story film poster, a frame of its shot (PLAN R9); generated in Blender by `scripts/assets/blender/films.py` | CC0 | — |
| `films/posters/ending_escape_eden_unmade.webp` | Original to this repository — story film poster, a frame of its shot (PLAN R9); generated in Blender by `scripts/assets/blender/films.py` | CC0 | — |
| `films/posters/ending_escape_exit.webp` | Original to this repository — story film poster, a frame of its shot (PLAN R9); generated in Blender by `scripts/assets/blender/films.py` | CC0 | — |
| `films/posters/ending_escape_point.webp` | Original to this repository — story film poster, a frame of its shot (PLAN R9); generated in Blender by `scripts/assets/blender/films.py` | CC0 | — |
| `films/posters/ending_escape_wall_same.webp` | Original to this repository — story film poster, a frame of a plate shot (PLAN R11, R12); generated in Blender by `scripts/assets/blender/films.py` | CC0 | — |
| `films/posters/ending_stay_earth_again.webp` | Original to this repository — story film poster, a frame of its shot (PLAN R9); generated in Blender by `scripts/assets/blender/films.py` | CC0 | — |
| `films/posters/ending_stay_earth_full.webp` | Original to this repository — story film poster, a frame of its shot (PLAN R9); generated in Blender by `scripts/assets/blender/films.py` | CC0 | — |
| `films/posters/ending_stay_fleet.webp` | Original to this repository — story film poster, a frame of its shot (PLAN R9); generated in Blender by `scripts/assets/blender/films.py` | CC0 | — |
| `films/posters/ending_stay_uplink.webp` | Original to this repository — story film poster, a frame of its shot (PLAN R9); generated in Blender by `scripts/assets/blender/films.py` | CC0 | — |
| `films/posters/ending_stay_wall_63.webp` | Original to this repository — story film poster, a frame of a plate shot (PLAN R11, R12); generated in Blender by `scripts/assets/blender/films.py` | CC0 | — |
| `films/posters/interlude_c1_capsule.webp` | Original to this repository — story film poster, a frame of its shot (PLAN R9); generated in Blender by `scripts/assets/blender/films.py` | CC0 | — |
| `films/posters/interlude_c1_earth_c1.webp` | Original to this repository — story film poster, a frame of its shot (PLAN R9); generated in Blender by `scripts/assets/blender/films.py` | CC0 | — |
| `films/posters/interlude_c1_shelter_light.webp` | Original to this repository — story film poster, a frame of its shot (PLAN R9); generated in Blender by `scripts/assets/blender/films.py` | CC0 | — |
| `films/posters/interlude_c2_earth_c2.webp` | Original to this repository — story film poster, a frame of its shot (PLAN R9); generated in Blender by `scripts/assets/blender/films.py` | CC0 | — |
| `films/posters/interlude_c2_tanks.webp` | Original to this repository — story film poster, a frame of its shot (PLAN R9); generated in Blender by `scripts/assets/blender/films.py` | CC0 | — |
| `films/posters/interlude_c2_tap.webp` | Original to this repository — story film poster, a frame of a plate shot (PLAN R11, R12); generated in Blender by `scripts/assets/blender/films.py` | CC0 | — |
| `films/posters/interlude_c3_earth_c3.webp` | Original to this repository — story film poster, a frame of its shot (PLAN R9); generated in Blender by `scripts/assets/blender/films.py` | CC0 | — |
| `films/posters/interlude_c3_greenhouse.webp` | Original to this repository — story film poster, a frame of its shot (PLAN R9); generated in Blender by `scripts/assets/blender/films.py` | CC0 | — |
| `films/posters/interlude_c4_earth_c4.webp` | Original to this repository — story film poster, a frame of its shot (PLAN R9); generated in Blender by `scripts/assets/blender/films.py` | CC0 | — |
| `films/posters/interlude_c4_reactor.webp` | Original to this repository — story film poster, a frame of its shot (PLAN R9); generated in Blender by `scripts/assets/blender/films.py` | CC0 | — |
| `films/posters/interlude_c4_watchers.webp` | Original to this repository — story film poster, a frame of its shot (PLAN R9); generated in Blender by `scripts/assets/blender/films.py` | CC0 | — |
| `films/posters/interlude_c5_cockpit.webp` | Original to this repository — story film poster, a frame of its shot (PLAN R9); generated in Blender by `scripts/assets/blender/films.py` | CC0 | — |
| `films/posters/interlude_c5_eden.webp` | Original to this repository — story film poster, a frame of its shot (PLAN R9); generated in Blender by `scripts/assets/blender/films.py` | CC0 | — |
| `films/posters/interlude_c5_hive_dark.webp` | Original to this repository — story film poster, a frame of its shot (PLAN R9); generated in Blender by `scripts/assets/blender/films.py` | CC0 | — |
| `films/posters/prologue_city_flash.webp` | Original to this repository — story film poster, a frame of a plate shot (PLAN R11, R12); generated in Blender by `scripts/assets/blender/films.py` | CC0 | — |
| `films/posters/prologue_curfew.webp` | Original to this repository — story film poster, a frame of a plate shot (PLAN R11, R12); generated in Blender by `scripts/assets/blender/films.py` | CC0 | — |
| `films/posters/prologue_earth_night.webp` | Original to this repository — story film poster, a frame of its shot (PLAN R9); generated in Blender by `scripts/assets/blender/films.py` | CC0 | — |
| `films/posters/prologue_launch.webp` | Original to this repository — story film poster, a frame of its shot (PLAN R9); generated in Blender by `scripts/assets/blender/films.py` | CC0 | — |
| `films/posters/prologue_liftoff.webp` | Original to this repository — story film poster, a frame of its shot (PLAN R9); generated in Blender by `scripts/assets/blender/films.py` | CC0 | — |
| `films/posters/prologue_machine_hall.webp` | Original to this repository — story film poster, a frame of its shot (PLAN R9); generated in Blender by `scripts/assets/blender/films.py` | CC0 | — |
| `films/posters/prologue_relay.webp` | Original to this repository — story film poster, a frame of its shot (PLAN R9); generated in Blender by `scripts/assets/blender/films.py` | CC0 | — |
| `films/posters/prologue_reprisal.webp` | Original to this repository — story film poster, a frame of a plate shot (PLAN R11, R12); generated in Blender by `scripts/assets/blender/films.py` | CC0 | — |
| `films/posters/prologue_sabotage.webp` | Original to this repository — story film poster, a frame of a plate shot (PLAN R11, R12); generated in Blender by `scripts/assets/blender/films.py` | CC0 | — |
| `films/posters/prologue_selection.webp` | Original to this repository — story film poster, a frame of a plate shot (PLAN R11, R12); generated in Blender by `scripts/assets/blender/films.py` | CC0 | — |
| `films/posters/prologue_shelter.webp` | Original to this repository — story film poster, a frame of a plate shot (PLAN R11, R12); generated in Blender by `scripts/assets/blender/films.py` | CC0 | — |
| `films/posters/prologue_stranded.webp` | Original to this repository — story film poster, a frame of its shot (PLAN R9); generated in Blender by `scripts/assets/blender/films.py` | CC0 | — |
| `films/prologue.mp4` | Original to this repository — story film rendered in EEVEE from code over the photographic plates listed under Plates above (PLAN R9, R11, R12); generated in Blender by `scripts/assets/blender/films.py` | CC0 | — |
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
| `audio/sfx/film.webm` | Original to this repository — the story films' cues (PLAN R9), synthesised by `scripts/assets/audio/sfx.mjs` | CC0 | — |
| `audio/music/film_dark.webm` | Original to this repository — the story films' dark bed (PLAN R9), synthesised by `scripts/assets/audio/music.mjs` | CC0 | — |
| `audio/music/film_hope.webm` | Original to this repository — the story films' warm bed (PLAN R9), synthesised by `scripts/assets/audio/music.mjs` | CC0 | — |

The PWA app icons live outside this folder, under `public/icons/`, because the
service worker precaches `public/` as a whole (SPEC-015 §10). They are the same
mark as the tab icon, rasterized by `node scripts/assets/icons.mjs` — pure Node,
deterministic, no Blender and no browser (SPEC-015 §10.1, D-14).

| File | Source | License | Modifications |
| --- | --- | --- | --- |
| `icons/icon-192.png` | Original to this repository — the `public/favicon.svg` mark at 192&nbsp;px, generated by `scripts/assets/icons.mjs` | CC0 | — |
| `icons/icon-512.png` | Original to this repository — the same mark at 512&nbsp;px, drawn at 70&nbsp;% on a square field so a maskable crop keeps all of it, generated by `scripts/assets/icons.mjs` | CC0 | — |
| `icons/apple-touch-icon-180.png` | Original to this repository — the same mark at 180&nbsp;px for the iOS Home Screen, generated by `scripts/assets/icons.mjs` | CC0 | — |

Outside this folder: `public/favicon.svg` is original to this repository, CC0.
