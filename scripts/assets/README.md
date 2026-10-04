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
under `public/assets/` or `public/icons/` has no row in `LICENSES.md`, when a
file has an extension the specs do not allow, when an app icon is the wrong
pixel size, or when the whole precachable set passes 25 MB (SPEC-015 D-11).

## 1. What the Blender build makes

| Generator (`scripts/assets/blender/`) | Writes | Consumer |
| --- | --- | --- |
| `character.py` (+ `lib/salvager.py`) | `models/character.glb` — the rigged salvager: one material on a 4 × 4 palette texture (base colour, metallic-roughness, emissive visor and lamps), rigid-skinned to 15 bones, clips `Idle` (first — the menu's asset spike plays clip 0), `Run`, `Attack`, `Hit`, `Death` | menu spike, creation preview, SPEC-019 §4.1 |
| `ships.py` (+ `lib/bake.py`) | `models/ship.glb` (the tug, 1024² baked maps — its sRGB base colour is the asset-spike colour-map check), `fighter.glb`, `interceptor.glb`, `probe.glb` (512²): one baked `Hull` material each (base colour, ORM, normal, emissive) plus the flat `Glow` | menu, station, flight (`FLIGHT_ASSETS`), SPEC-019 §4.1 |
| `station.py` | `models/cockpit.glb` (camera space; 1024² baked maps with the emissive dashboard screens), `station_ring.glb`, `dock.glb`, `crate.glb` (boot manifest, 0.6 m, centred) | flight, SPEC-020 §4.4, SPEC-018 §4.7 |
| `flight.py` | `textures/flight/sky_<planet>.webp` (2048 × 1536 forward sky windows) and `sky_station.webp`, `planet_<planet>.webp` (2048 × 1024 equirect) + `_nr` (relief, 1024 × 512) + `_em` (Ferrum, Hive), `clouds.webp`, `models/asteroid.glb` (two rocks) | flight (`PLANET_ART`, `FLIGHT_ASSETS`), SPEC-020 §4.4 |
| `props.py` | `models/props/<biome>_<kind>_<a|b|c>.glb` — 36 props for the twelve biome × obstacle-kind pairs of `systems/Layout.ts`: unit props, except the two tree kinds, which are trees under SPEC-052's contract (below); and `models/props/landmark_<biome>.glb`, six set pieces in metres. Every model meshopt-compressed; only trees carry UVs | SPEC-018 §4.7 (`PROP_MODELS`), SPEC-052 §4.2–§4.4 → SPEC-053 |
| `ground.py` | `textures/ground/<layer>_albedo.webp` + `<layer>_nr.webp` for the 12 ground layers — seamless 512² — and `detail_nr.webp`, a 256² micro normal (A: a roughness offset round 0.5) | SPEC-018 §4.5, §4.10; SPEC-052 §4.7 |
| `foliage.py` | `textures/foliage/atlas.webp` — the 512² foliage atlas: a 4 × 4 grid of 128 px cells (leaf clusters, fern fronds, grasses, flowers, frost fern, ash frond, hive tendril, moss, a ground plant, opaque bark in cell 15), each with a 4 px zero-alpha gutter | SPEC-052 §3.3, §4.6 → SPEC-053 |
| `cave.py` | `models/cave/<name>.glb` — the cave kit: eleven pieces (`cache`, `cache_open`, `vault_door`, `terminal`, `plate`, `mirror`, `lens`, `receiver`, `shaft`, `rack`, `cradle`) and `beacon_<biome>` ×6, in metres, meshopt-compressed | SPEC-052 §3.6, §4.5 → SPEC-054, SPEC-055 |
| `sprites.py` | `textures/sprites/{smoke,dirt,flare,spark,ember,muzzle,ring,magic,flake,streak}.webp` | SPEC-019 §4.4, SPEC-020 §4.3 |
| `portraits.py` | `portraits/01.webp` … `12.webp` (256² EEVEE busts) + `portraits/manifest.json` | SPEC-020 §4.6 |

`items.py` (SPEC-031, SPEC-035) writes the 384² item pictures and
`items/manifest.json`; SPEC-052 §4.8 appends seven, drawn ahead of SPEC-056's
items.

`lib/common.py` holds the shared pieces (scene reset, part primitives, the
bmesh `Builder`, materials, WebP writing, GLB export and rewrite), `lib/nodes.py`
the shader-node fields and the Cycles EMIT bake every texture starts from,
`lib/bake.py` the hull maps (unique UVs, baked geometric fields, a numpy painter
for seams, rivets, wear, grime, decals, markings and lamps), `lib/tex.py` the
numpy texture helpers, `lib/preview.py` the QA renders.

## 2. Rebuild

Blender **5.2 LTS** (found through `$BLENDER`, then `/Applications/Blender.app`,
`/usr/bin/blender`, the Windows default, then `PATH`):

```bash
node scripts/assets/blender/build.mjs                          # everything (about 4 minutes)
node scripts/assets/blender/build.mjs character ships          # some generators
node scripts/assets/blender/build.mjs props --only=hive_rock_a # one item
node scripts/assets/blender/build.mjs --preview=/tmp/art       # also write QA contact sheets
node scripts/assets/blender/build.mjs props foliage ground cave items --preview=/tmp/art   # SPEC-052's drop
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
- **Baked models** (the ships, the cockpit, the asteroids — PLAN R8) carry one
  textured material: base colour (sRGB, AO folded in), metallic-roughness
  (G roughness, B metal), an OpenGL tangent-space normal map and, where
  something is lit, an emissive map, all WebP inside the GLB; a flat `Glow`
  material may sit beside it. The build tags parts with `Col` masks (paint slot,
  decal, wear) that only the painter reads — the final material does not, so
  the exporter drops them. The flight view instances these materials as they
  are (one instanced mesh per ship class, a geometry group per material).
- **Trees** (SPEC-052 §3.2, the tree contract) are five nodes with identity
  transforms — `Bark`, `Leaf`, `Bark_LOD1`, `Leaf_LOD1` on one `Foliage`
  material (`COLOR_0` × the foliage atlas, bound at runtime) and an optional
  `Glow` — with `POSITION`, `NORMAL`, `TEXCOORD_0` and `COLOR_0`. The canopy is
  the unit: `Leaf` reaches 1.00 from the y axis, the trunk is 0.14 between
  y 0.30 and 0.34 (buttress roots below 0.25), the lowest vertex is on 0, and
  `Leaf`'s top is the tree's height. LOD0 ≤ 700 triangles, LOD1 ≤ 140 with
  `Leaf_LOD1` reaching 0.90–1.05. Leaf cards are quads within 50° of
  horizontal, their normals bent toward the crown; bark UVs sit inside atlas
  cell 15 clear of its gutter, leaf UVs inside the tree's two leaf cells.
  `temperate_tree_c` alone is four-fold symmetric. `tests/assets/worldArt.test.ts`
  pins every rule.
- **Instanced props** use a `Body` material with the colours in `COLOR_0` and,
  when something glows, a second `Glow` material — SPEC-018 §4.7 bakes `Body`
  into the instanced geometry and keeps `Glow` as the glow part. Props are unit
  props: footprint radius 1, base on z 0, because the surface scales an
  obstacle by its radius.
- **Flight maps** (PLAN R8): a sky window covers three's
  `SphereGeometry(r, …, π, π, π/8, 3π/4)` — ±90° × ±67.5° around −Z — and is
  drawn from the inside; planet surfaces are equirect for `SphereGeometry` UVs
  (u = φ/2π, v = 1 − θ/π) with `_nr` relief normals (OpenGL, +v north) and an
  `_em` emissive map where the world glows; `clouds.webp` is grey cover read as
  an alpha map, so it loads as data, not colour.
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

- **Compression** (SPEC-052): `export_glb(…, texcoords=True, meshopt=False)`;
  `props.py` and `cave.py` pass `meshopt=True` (EXT_meshopt_compression, float
  attributes kept, decoded by three's `MeshoptDecoder`) and `texcoords=False`
  except for trees. The other generators keep today's exports.

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

## 5. App icons (SPEC-015 §10.1)

The three PWA icons are **not** Blender's and not new art: they are the shipped
`public/favicon.svg` mark — a `#0b0f14` field, a `#39c5cf` ring at r 18/64 with
stroke 4/64, an `#e6edf3` core at r 6/64 and four cardinal ticks from r 18/64 to
r 26/64 — rasterized at three sizes by pure Node.

```bash
node scripts/assets/icons.mjs
```

| Writes | Size | Purpose | Mark scale |
| --- | --- | --- | --- |
| `public/icons/icon-192.png` | 192² | manifest `any` | 1.0 — the favicon's own framing, `rx` 12/64 |
| `public/icons/icon-512.png` | 512² | manifest `any maskable` | **0.70** on a square field, so every mask a launcher applies keeps the whole mark (15-k) |
| `public/icons/apple-touch-icon-180.png` | 180² | `<link rel="apple-touch-icon">` | 1.0 |

No Blender, no browser and no network: the shapes are analytic signed distance
fields sampled 4× per axis and written with `node:zlib` at a fixed deflate
level, so two runs on the same Node produce identical bytes and a rebuild on a
clean tree leaves `git status` clean. The layout constants are exported and
pinned by `tests/assets/icons.test.ts`; `scripts/assets/check.mjs` reads each
PNG's IHDR to confirm the three sizes and requires a `LICENSES.md` row for each.
Change the mark by editing `public/favicon.svg` **and** `MARK` in the generator
— the test fails when the two disagree.

## 6. Budgets (SPEC-001 §10, restated by the checker)

| Category | Folder | Budget |
| --- | --- | --- |
| Models | `models/` | 4 MB |
| Audio | `audio/` | 12 MB |
| Textures | `textures/` | 6 MB |
| Portraits | `portraits/` | 0.5 MB |
| Everything precached | `public/assets/` + `public/icons/` + `public/favicon.svg`, or `dist/` where it exists | 25 MB |

The precache row is SPEC-015 D-11: it is what a first visit downloads, so the
checker measures the built output when a `dist/` is present and the sources
otherwise. It prints the measured total either way (AC-53).

## 7. Building without Blender (the stand-in, SPEC-052)

Blender 5.2 has no Linux arm64 build, and the build factory's containers have
neither it, numpy nor PIL. SPEC-052's drop was made there with
`scripts/assets/standin/`, which runs the generators above as far as it can and
stands in only for what it cannot run:

```bash
node scripts/assets/standin/build.mjs props foliage ground cave items
node scripts/assets/standin/build.mjs props --only=jungle_tree_a,landmark_ice
```

- **`props`, `cave`** — `props.py` and `cave.py` themselves run under plain
  Python 3; `standin/blender_api/` emulates the part of `bpy`, `bmesh` and
  `mathutils` they use (primitives with Blender's topology, the Builder's loops
  and sharp edges, the exporter's layout and split normals), so every model is
  the generator's own builders' output. `glb.mjs` then does what
  `export_meshopt_compression_enable` does, with meshoptimizer's encoder. Its
  noise is not Blender's, so a Blender rebuild moves vertices within the
  contracts, never the topology (SPEC-052 52-g). The twenty `_a`/`_b` props are
  not rebuilt: their Blender exports are re-encoded (no `TEXCOORD_0`, meshopt).
- **`foliage`, `ground`, `items`** — numpy painting, Cycles bakes and EEVEE have
  no stand-in, so `foliage.mjs`, `ground.mjs` and `items.mjs` port the parts
  SPEC-052 changed (the atlas; the four re-authored ground layers and
  `detail_nr`; the seven new pictures) step for step, sharing `lib/tex.py`'s
  seeded helpers through `standin/tex.mjs`. `webp.mjs` encodes through
  Chromium's libwebp (Playwright's browser, as the audio build's Opus does):
  colour lossy at the generator's quality, alpha lossless and exact.
- Every file it writes says so in its `LICENSES.md` row until Blender re-runs
  the generator that owns it.

