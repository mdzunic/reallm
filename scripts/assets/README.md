# Asset drop — the hand-made step of the art pass (PLAN R6-3)

The build factory that implements the specs has no internet access, so every
real file the art pass uses (SPEC-017 … SPEC-020) is fetched **once, by a
person**, prepared with the steps below, committed under `public/assets/`, and
given a row in `public/assets/LICENSES.md`. The specs consume the files by
manifest id and keep a procedural fallback, so nothing is blocked on this
step — it only makes the result better.

Everything must be **CC0**. Verify the licence on the source page before
downloading; if a pack is not CC0, do not use it.

Run the checker after every change:

```bash
node scripts/assets/check.mjs
```

It fails when a category exceeds its byte budget (SPEC-001 §10), when a file
under `public/assets/` has no row in `LICENSES.md`, or when a file has an
extension the specs do not allow.

## 1. What to fetch

| Need | Consumer | Source (verify CC0 on the page) | Take |
| --- | --- | --- | --- |
| Player character, rigged, with clips | SPEC-019 §4.1 (`ASSETS.models.character`) | Kenney **Mini Characters 1** — https://kenney.nl/assets/mini-characters-1 (fallback: Kenney **Animated Characters 1/2/3**, or Quaternius **Universal Animation Library**, both CC0) | One or two humanoids as GLB with the animation clips; clip names should cover `idle`, `run`, `attack`, `hit`, `death` (aliases in SPEC-019 §4.1) |
| Escort probe / drone | SPEC-019 §4.1 (`FOLLOWERS.science_probe.model`) | Kenney **Space Kit** — https://kenney.nl/assets/space-kit | One small drone or satellite model |
| Fighters, interceptors, cockpit, station ring, dock | SPEC-020 §4.3, §4.4 (`ASSETS.models.fighter`, `interceptor`, `cockpit`, `station_ring`, `dock`) | Kenney **Space Kit** | Two ship silhouettes, one cockpit interior piece, one ring/hub module, one dock/pad module |
| Rocks, cliffs, trees, mushrooms, ice crystals | SPEC-018 §4.7 (`PROP_MODELS`, `SURFACE_ASSETS[biome].models`) | Kenney **Nature Kit** — https://kenney.nl/assets/nature-kit and **Space Kit** (craters, rocks) | Roughly two or three per biome kind: `rock`, `ruin`, `spire`, `vent`, `tree` |
| VFX sprites | SPEC-019 §4.4, SPEC-020 §4.3 (`textures/sprites/`) | Kenney **Particle Pack** — https://kenney.nl/assets/particle-pack | 8–10 sprites (smoke, flare, spark, dirt, magic, muzzle) |
| Ground texture sets, one per `GroundLayerId` | SPEC-018 §4.10 (`SURFACE_ASSETS[biome].textures`) | **ambientCG** — https://ambientcg.com (CC0) or **Poly Haven** — https://polyhaven.com/textures (CC0) | `sand`, `cracked_earth`, `rock`, `snow`, `ice`, `moss`, `jungle_floor`, `basalt`, `lava_rock`, `chitin` (a leather/skin-like set), `flesh`, `grass`, `soil` — 1K downloads, Color + Displacement + NormalGL + Roughness |
| Portraits (optional) | SPEC-020 §4.6 (`portraits/01.webp` … `12.webp` + `manifest.json`) | Generated originals (the `image-gen` skill) — original work, CC0 by the author | Twelve 256² faces matching the creation glyph order |

Keep the pack archives out of the repository; only the prepared files land.

## 2. Prepare

Tools (any of these are fine; nothing is added to `package.json`):

- glTF → GLB: `npx @gltf-transform/cli copy input.gltf output.glb` (or Blender's exporter). Then `npx @gltf-transform/cli prune output.glb output.glb` to drop unused nodes, and for the character `npx @gltf-transform/cli optimize` is *not* recommended (it may rename clips) — trim clips in Blender instead.
- Images: `cwebp -q 82 in.png -o out.webp` (libwebp) or ImageMagick `magick in.png -quality 82 out.webp`; resizing with `magick in.png -resize 512x512 out.png`.

### 2.1 Models → `public/assets/models/`

| File | Rule |
| --- | --- |
| `character.glb` | replaces the in-repo spike; rigged; clips named so SPEC-019's aliases find them; ≤ 300 KB |
| `probe.glb` | ≤ 60 KB |
| `fighter.glb`, `interceptor.glb`, `cockpit.glb`, `station_ring.glb`, `dock.glb` | ≤ 120 KB each |
| `props/<biome>_<kind>_<a|b|c>.glb` | e.g. `props/desert_rock_a.glb`; ≤ 60 KB each |

Models must be GLB (SPEC-001 §10), Y-up, metres, origin at the base centre.

### 2.2 Ground textures → `public/assets/textures/ground/`

For each layer `<layer>`:

1. `<layer>_albedo.webp` — 1024², **RGB = Color, A = Displacement** (height), sRGB. Build the RGBA with ImageMagick: `magick Color.jpg Displacement.jpg -resize 1024x1024 -alpha off -compose CopyOpacity -composite -define webp:alpha-quality=90 -quality 82 <layer>_albedo.webp`.
2. `<layer>_nr.webp` — 512², **RGB = NormalGL (OpenGL, +Y up), A = Roughness**, linear data: `magick NormalGL.jpg Roughness.jpg -resize 512x512 -alpha off -compose CopyOpacity -composite -define webp:alpha-quality=95 -quality 90 <layer>_nr.webp`.

Manifest entries go into `SURFACE_ASSETS[biome].textures` as `<layer>_albedo: { url, kind: 'color' }` and `<layer>_nr: { url, kind: 'data' }` (SPEC-018 §4.10). Budget for the whole set: ≤ 5 MB (the textures category is ≤ 6 MB in total).

### 2.3 Sprites → `public/assets/textures/sprites/`

256² PNG or WebP with alpha, one file per sprite (`smoke.webp`, `flare.webp`, `spark.webp`, `dirt.webp`, `muzzle.webp`, …). ≤ 400 KB in total.

### 2.4 Portraits → `public/assets/portraits/`

`01.webp` … `12.webp`, 256², plus `manifest.json` containing `[1, 2, …, 12]` (the indices that exist). ≤ 300 KB in total.

## 3. Register

1. Add one row per file to `public/assets/LICENSES.md`: `| \`models/fighter.glb\` | Kenney Space Kit — https://kenney.nl/assets/space-kit | CC0 | converted to GLB, pruned |`. The checker matches files by the backticked relative path.
2. Add the ids to `src/data/assets.ts` (`ASSETS.models` for boot-loaded models — keep the boot list short, the e2e boot suites delay every request — and `SURFACE_ASSETS[biome]` for lazy per-planet files) and to `PROP_MODELS` in `src/views/SurfaceProps.ts` for prop kinds.
3. Run `node scripts/assets/check.mjs`, then `npm run check` and `npm run e2e`.
4. Commit on a branch and open a PR titled `Asset drop: <what landed>`.

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
