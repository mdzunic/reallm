# Assets — how every file under `public/assets/` is made

Nothing under `public/assets/` is downloaded (PLAN R7). Models, ground
textures, VFX sprites and portraits are generated from code by **Blender**
running headless; the audio is synthesised by Node (section 4). The generators
are committed, deterministic for a given tool version, and the files they write
are committed too, so `npm run check`, the e2e suite and the build factory never
need Blender — only a rebuild of the art does.

Every file must be **CC0** and have a row in `public/assets/LICENSES.md`. Run the
checker after every change:

```bash
node scripts/assets/check.mjs
```

It fails when a category exceeds its byte budget (SPEC-001 §10), when a file
under `public/assets/` has no row in `LICENSES.md`, or when a file has an
extension the specs do not allow.

## 1. What the Blender build makes

| Generator (`scripts/assets/blender/`) | Writes | Consumer |
| --- | --- | --- |
| `character.py` (+ `lib/salvager.py`) | `models/character.glb` — the rigged salvager: one material on a 4 × 4 palette texture (base colour, metallic-roughness, emissive visor and lamps), rigid-skinned to 15 bones, clips `Idle` (first — the menu's asset spike plays clip 0), `Run`, `Attack`, `Hit`, `Death` | menu spike, creation preview, SPEC-019 §4.1 |
| `ships.py` | `models/ship.glb` (the tug, with a WebP sRGB hull map — the asset-spike colour-map check), `fighter.glb`, `interceptor.glb`, `probe.glb` | menu, station, SPEC-020 §4.3, SPEC-019 §4.1 |
| `station.py` | `models/station_ring.glb`, `dock.glb`, `cockpit.glb` (camera space), `crate.glb` (boot manifest, 0.6 m, centred) | SPEC-020 §4.3–§4.4, SPEC-018 §4.7 |
| `props.py` | `models/props/<biome>_<kind>_<a|b>.glb` — 24 unit props for the twelve biome × obstacle-kind pairs of `systems/Layout.ts` | SPEC-018 §4.7 (`PROP_MODELS`) |
| `ground.py` | `textures/ground/<layer>_albedo.webp` + `<layer>_nr.webp` for the 13 `GroundLayerId`s — seamless 512² | SPEC-018 §4.5, §4.10 |
| `sprites.py` | `textures/sprites/{smoke,dirt,flare,spark,ember,muzzle,ring,magic,flake,streak}.webp` | SPEC-019 §4.4, SPEC-020 §4.3 |
| `portraits.py` | `portraits/01.webp` … `12.webp` (256² EEVEE busts) + `portraits/manifest.json` | SPEC-020 §4.6 |

`lib/common.py` holds the shared pieces (scene reset, part primitives, the
bmesh `Builder`, materials, WebP writing, GLB export and rewrite), `lib/tex.py`
the numpy texture helpers, `lib/preview.py` the QA renders.

## 2. Rebuild

Blender **5.2 LTS** (found through `$BLENDER`, then `/Applications/Blender.app`,
`/usr/bin/blender`, the Windows default, then `PATH`):

```bash
node scripts/assets/blender/build.mjs                          # everything (about 40 s)
node scripts/assets/blender/build.mjs character ships          # some generators
node scripts/assets/blender/build.mjs props --only=hive_rock_a # one item
node scripts/assets/blender/build.mjs --preview=/tmp/art       # also write QA contact sheets
```

The runner starts Blender with `--background --factory-startup
--python-exit-code 1`, so a Python error fails the build. After the generators
it rewrites the generated table of `LICENSES.md` (between the `blender:start` /
`blender:end` markers) from the files on disk. `--preview=<dir>` renders lit
3/4 views and writes `sheet_*.png` contact sheets; they are for judging the
art and are never committed.

## 3. Conventions (for a new generator or a hand-made replacement)

- **Models** are GLB (SPEC-001 §10), metres, Y-up, **front facing +Z** (Blender's
  −Y), origin at the base centre — except the crate (centred, as the boot
  manifest's crate always was), the flight ships and the probe (centred), and the
  cockpit (camera space: the pilot looks along three's −Z, Blender's +Y).
- **Characters** carry one material whose UVs sit on palette-cell centres, so the
  runtime tint (`material.color = appearance.primary`) colours the suit and
  armour cells and leaves the dark cells dark; `emissive × emissiveMap` lights
  only the visor and lamps. Clip names follow SPEC-019's aliases, `Idle` first.
- **Instanced models** (flight ships, props) use a `Body` material with the
  colours in `COLOR_0` and, when something glows, a second `Glow` material —
  SPEC-018 §4.7 / SPEC-020 §4.3 bake `Body` into the instanced geometry and keep
  `Glow` as the glow part. Props are unit props: footprint radius 1, base on
  z 0, because the surface scales an obstacle by its radius.
- **Ground layers** are RGBA WebP pairs at 512²: `<layer>_albedo` (RGB albedo,
  sRGB; A height — except `lava_rock` and `flesh`, always slot B, whose A is
  the emissive crack/vein mask) and `<layer>_nr` (RGB OpenGL normal, A
  roughness, linear). Every layer tiles seamlessly.
- **Sprites** are white-to-grey RGB with straight alpha, 256² (the streak
  256 × 64), so the instance colour tints them.
- **Portraits** are 256² WebP; portrait index *i* (0-based, the creation
  screen's glyph order) is file *i + 1*; `manifest.json` lists the file numbers
  present.
- **Registering** a file with the game (`ASSETS` / `SURFACE_ASSETS` in
  `src/data/assets.ts`, `PROP_MODELS`) belongs to the spec that consumes it;
  keep the boot manifest short (the boot e2e suites delay every request by up
  to 250 ms under a 5 s expect); per-scene files load lazily.
- **Replacing** a generated file with a CC0 pack: keep the name, move its row
  out of the generated table into a hand-written one with the source URL, and
  drop it from the generator so a rebuild does not overwrite it.

## 4. Audio

The sound set is synthesised, not fetched: `node scripts/assets/audio/build.mjs`
renders every sprite bank and music track in `ASSETS.audio` and writes them to
`public/assets/audio/`. libopus inside Playwright's Chromium encodes the Opus
(`opus.mjs`, WebCodecs — `npx playwright install chromium`, as for the e2e
suite) and `webm.mjs` muxes it into WebM, so it runs on any OS; `lame` on PATH
(`brew install lame`) adds the `.mp3` fallbacks. The
synths are `sfx.mjs` (one per sprite id) and `music.mjs` (one per `MusicId`);
bank ids limit a rebuild to those banks, and `--wav=DIR` keeps uncompressed
renders for listening. A CC0 pack can replace any file later: cut the sfx to the
sprite offsets in `src/data/assets.ts`, keep music loops seamless, encode
`.webm` (Opus) + `.mp3`, and change the file's `LICENSES.md` row.

## 5. Budgets (SPEC-001 §10, restated by the checker)

| Category | Folder | Budget |
| --- | --- | --- |
| Models | `models/` | 4 MB |
| Audio | `audio/` | 12 MB |
| Textures | `textures/` | 6 MB |
| Portraits | `portraits/` | 0.5 MB |
| Everything precached | `public/assets/` | 25 MB |
