# R19 audit — the world's look (terrain, foliage, set dressing, dark underground)

> **Provenance.** Written on 2026-09-27 for PLAN R19–R21, against a snapshot of `main` at `2cf398a` (SPEC-035 and PLAN R18 merged; SPEC-036…045 written, not built), which the report calls `SCRATCH/game-r19`. `SCRATCH` was that review session's working folder; its probes, captures and simulation scripts are not kept in the repository. The decisions taken from this report are PLAN R19, R20 and R21 and the specs SPEC-046…SPEC-059 in `mdzunic/reallm-specs`; where a report and PLAN differ, PLAN wins.

Auditor prefix **W-**. Snapshot `SCRATCH/game-r19` (game `main` @ 2cf398a). Nothing in any repository was changed.
`SCRATCH` is the review session's working folder (not kept).

**Evidence produced for this report (all in SCRATCH, read-only for the repos):**

| What | Where |
|---|---|
| Props contact sheet + 24 single renders (Blender 5.2, `build.mjs props --preview`, 8.0 s) | `r19/props-preview/sheet_props.png`, `prop_<name>.png` |
| Live captures, spawn, first vs second landing (6 planets, medium 1280×720 @1) | `r19/world/live/*.png`, `*.json` |
| Targeted captures (densest obstacle cluster, a landmark, a shelter, the arena edge) per planet; Retina `high` @2; phone 844×390 @3 `low`/`medium`; 1:1 crops; A/B of the GLB-material fix; first-landing clusters | `r19/world/live2/*.png`, `*.json` |
| Node census: every mesh the surface view hands the GPU, per planet × preset, procedural vs GLB props (seed 20121) | `r19/world/probe-out.json` (test: `r19/world/game-probe/tests/zz-r19-world.test.ts`) |
| Probe copy (not the shared snapshot) with two dev hooks: `?spawn=x,z`, `__probeLayout`, `?r19fix` | `r19/world/game-probe/` (`src/scenes/Surface.ts:721`, `src/views/SurfaceView.ts:630`) |
| Capture scripts (headless Chromium via Playwright, GPU/Metal; never the in-app browser) | `r19/world/capture.mjs`, `capture2.mjs`, `first.mjs` |

---

## 1. Verdict

- **The trees are not trees, and the renderer makes them worse.** The jungle "tree" is a 594-triangle mushroom (`props.py:99` "A giant bioluminescent mushroom"), the Eden tree four 80-triangle icosphere blobs. Each is a unit prop scaled by its collision radius (1.2–4.5 m), so canopies are 2.4–9 m across with facets 0.5–2 m wide.
- **Two renderer defects stack on top.**
  - `SurfaceView` draws every prop body with `flatShading: true` and `color: palette.accent` × vertex colour (`SurfaceView.ts:604-611`). That throws away the authored normals and removes 25–89 % of the authored luminance: Cinder-4's sandstone turns maroon, Vetra's snow boulders turn saturated blue, Thessaly's teal caps turn green.
  - On a **first landing the GLBs are never drawn at all**. The view is built before the lazy per-planet drop lands (`Surface.ts:815-856`), so 20–300-triangle procedural stand-ins show: lime faceted domes on Thessaly, olive icosphere blobs on Eden (`live2/*_first_landing_cluster.png`). After SPEC-040 §4.6 releases planet assets on exit, they would never be drawn.
- **Which cause dominates depends on the screen.**
  - **Phone:** resolution. The vsync-bound benchmark puts every 60 Hz phone on `low` (R18 M-06): DPR 1 on a 3× panel is 11 % of the native pixels, with no anti-aliasing. After SPEC-040, `medium` still renders at DPR 1.5 with FXAA.
  - **Retina desktop:** on `high` (DPR 2) the frame is crisp, and the assets are the problem. On `medium` (DPR 1.5 + FXAA) or a benchmark `low` the frame is also soft.
- **The ground has enough texels but the wrong content.**
  - 79–146 texels/m against 37–94 px/m on screen, so resolution is not the problem.
  - 9 of 13 layers are built on a Voronoi edge field (paving, stained glass, cobbles). The recipes are low-frequency, with no 5–15 cm detail.
  - A full-strength palette cast `uMacroTint` turns Cinder orange (blue ×0.20) and makes Thessaly and Eden the same green.
- **The world is empty, and the triangle budget is spent off screen.**
  - The playfield holds 0.23–0.42 obstacles and props per screen. Landmarks are drawn at 1–3 m.
  - 60–88 % of today's 33–118 k drawn triangles are off screen: instanced layers are never culled per instance (Cinder's bones scatter alone is 48.6 k).
  - Culling per instance frees 20–92 k triangles per frame on `medium` (55–92 k on Cinder-4, Thessaly, Ferrum and the Hive). That pays for real trees, ground cover and a dressing tier inside ≤ 80 scene draws and ≤ 130 k triangles.
- **Caves need no new technology.**
  - The Hive already shows the recipe: dark palette, emissive way-finding, a torch.
  - The flashlight: a `SpotLight` on `medium`, the same plus a 512² shadow and a cookie on `high`, and a fake beam decal on `low`.
  - The per-scene look already carries exposure and bloom.

---

## 2. What exists today

### 2.1 The render path (per preset)

| Field (`core/Quality.ts:45-100`) | low | medium | high |
|---|---|---|---|
| `maxDpr` | 1 | 1.5 | 2 |
| `post` → AA (`postPlanFor`, :175-199) | off → none | lite → FXAA, ¼-res bloom | full → MSAA 4× if dpr ≤ `MSAA_MAX_DPR` 1.5 (:164), else FXAA; ½-res bloom |
| `shadowMapSize` | 0 | 0 | 1024 (PCFSoft, `Renderer.ts:183`; `SHADOW_EXTENT` 34 m, `SurfaceView.ts:237`) |
| `ibl` | false | true (env intensity 0.6, `SurfaceView.ts:264`) | true |
| `textureMaxSize` | 512 | 1024 | 2048 |
| `drawDistance` → `camera.far = drawDistance + 40` (`Surface.ts:872`) | 60 → 100 | 90 → 130 | 140 → 180 |
| `targetFps` | 30 | 60 | 60 |

- **Preset choice.** `presetFor(ms)`: under 8 ms is `high`, under 14 ms `medium` (`Quality.ts:110-147`). The ms comes from rAF gaps, so a 60 Hz screen measures 16.7 ms and gets `low` (R18 M-06, fixed by SPEC-040, not yet built).
- **Context.** `contextAntialias` is always false (D-2).
- **Tone mapping.** `ACESFilmicToneMapping` with `toneMappingExposure = look.exposure` on both paths (`Renderer.ts:181-182`, `setLook` :273-279). On the composer path, `OutputPass` applies it.
- **The grade** (`PostChain.ts:53-92`): contrast, saturation, tint and vignette. Grain is `(hash − 0.5) · uGrain · (1 − l)`, strongest in dark pixels. `uLift`, `uGamma` and `uGain` exist but are neutral, and not in `Look` (`Quality.ts:228-238`).
- **Surface look** (`SurfaceView.ts:565-575`): exposure 1.05, contrast 1.04, saturation 1.05, **bloomThreshold 1.5** (SPEC-035 §4.3), tint 8 % toward `palette.fog`. `DEFAULT_LOOK`: exposure 1.0, bloom 0.35 / 0.4 / 0.85, vignette 0.35, grain 0.025 (`Quality.ts:241-251`).
- **Camera** (`Surface.ts:143-146`, `UiHelpers.ts:783`): FOV 40° vertical, pitch 55°, yaw 45°, near 1. Distance `CAMERA_DISTANCE` is 22 m (keyboard, gamepad) and 17 m (touch).
- **Ground footprint on screen** (computed):

  | Camera | Aspect | Bottom × top width | Depth | Area |
  |---|---|---|---|---|
  | 22 m | 16:9 | 22.7 × 38.2 m | 20.9 m | ≈ 640 m² |
  | 17 m | 844:390 | 21.3 × 35.9 m | 16.2 m | ≈ 460 m² |

- **Fog** is linear (`THREE.Fog`, `SurfaceView.ts:561`). `surfaceFogRange` gives near = camera distance and far = near + `FOG_SPAN_K` 2.2 / (density × fogMult) (`UiHelpers.ts:795-806`).
- **Lights on the surface.** Hemisphere (`look.light`), a key `DirectionalLight` (the sun, the caster), a rim `DirectionalLight(0x7fa6ff, 0.6)` at (−30, 20, −24) (`:590`), and the torch `PointLight(0xffc98a, 6, 14, 2)` at y 1.6 on the player group (`:840`). `CombatFx` adds a `PointLight(0xffffff, 0, 8, 2)` (`CombatFx.ts:162`). That is 1 hemi, 2 directional and 2 point lights, compiled into every lit shader.

### 2.2 Terrain and ground layers

- **Tiles.** 60 m `PlaneGeometry` tiles with 30 segments (2 m quads, 1,800 triangles each), built from the shared `HeightField` (`TerrainMesh.ts:17-86`). The field is 2·(halfSize + `TERRAIN_APRON` 40) square (`HeightField.ts:18`): 64 tiles (49 on the Hive), 4–9 visible.
  - Vertex colour tint: occlusion 0.72, flats 1.06.
  - There is **no** darkening under props or trees.
- **Material** (`createTerrainMaterial`, :161-210): `MeshStandardMaterial` with a height-weighted two-layer splat, `normalScale 0.8`, `envMapIntensity 0.25`, `uHeightBlend 1.5`.
  - Macro modulation: layer A sampled again at ×0.137, mixed 35 %.
  - **`uMacroTint`** multiplies the full albedo (`MAP_CHUNK` :118-125). It is `palette.ground` normalised to luminance 1, then capped at 1 (`macroTint` :151-159). Computed values (linear):

    | Planet | `uMacroTint` (r, g, b) |
    |---|---|
    | Cinder-4 | 1.00, 0.61, **0.20** |
    | Vetra | 0.80, 0.92, 1.00 |
    | Thessaly | **0.53**, 1.00, **0.28** |
    | Ferrum | 1.00, 0.67, 0.55 |
    | Hive | 0.62, 0.42, 1.00 |
    | Eden | **0.46**, 1.00, **0.29** |

  - Emissive cracks read `texB.a` on Ferrum (#ff6a2a × 3) and the Hive (#c04ad0 × 2.5).
- **Layers.** Procedural 512² `DataTexture`s are built first (`ProceduralTextures.ts:34-35`: `DEFAULT_SIZE` 512, `DEFAULT_TILE_METRES` 4; trilinear, anisotropy 4, :331-343). They are swapped for the committed WebPs when `SURFACE_ASSETS[biome]` lands (`Surface.ts:834-856` → `setGroundTextures` → `setTerrainLayers`, no recompile).
  - Loaded textures get mipmaps and `anisotropy = min(4, max)` (`Assets.ts:249, 289-290`).
  - Tiling per planet: Cinder sand + cracked_earth 4 / 5.5 m, Vetra snow + ice 4 / 6, Thessaly moss + jungle_floor 3.5 / 5, Ferrum basalt + lava_rock 4.5 / 6, Hive chitin + flesh 5 / 6.5, Eden grass + soil 3.5 / 5 (`data/planets.ts`).
- **Committed WebPs** (`scripts/assets/blender/ground.py`):
  - 512² each (`SIZE` :24); albedo WebP q84, normal-roughness q92 (:232-233). 26 files, 1.76 MB.
  - **9 of 13 recipes use the Voronoi `'edge'` field:** cracked_earth, rock, ice, jungle_floor, basalt, lava_rock, chitin, flesh, grass (`LAYERS` :202-216).
  - The unused `rock` layer still ships (68.5 + 57.2 KB).
- **Texel versus pixel density at the player** (computed):

  | Layer tiling | Texels/m | | Screen | Pixels/m (across / along the ground) |
  |---|---|---|---|---|
  | 3.5 m | 146 | | desktop 720 CSS px tall @1 (`low`) | 45 / 37 |
  | 4 m | 128 | | @1.5 (`medium`) | 67 / 55 |
  | 6.5 m | 79 | | @2 (`high`) | 90 / 74 |
  | | | | phone 390 CSS px, 17 m camera @1 | 32 / 26 |
  | | | | phone @1.5 | 47 / 39 |
  | | | | phone @2 | 63 / 52 |

  Texels exceed pixels everywhere except the Hive's flesh (6.5 m tile) on a Retina `high` frame.

### 2.3 Props and the GLB seam

- **Obstacle kinds per biome** (`Layout.ts:194-201` `BIOME_OBSTACLES`, primary first): desert rock/ruin, ice rock/spire, jungle tree/ruin, volcanic rock/vent, hive spire/rock, temperate tree/rock. Outcrops and cave boulders use the primary kind, so they are **trees** on Thessaly and Eden.
- **Scale.** Obstacles draw a unit prop scaled by `o.radius` (1.2–5 m by planet, `SurfaceView.ts:617`). Small props (`layout.props`, not collidable) draw at `prop.scale × 0.5`, i.e. 0.25–0.7 m (:623).
- **`PROP_MODELS`** (`SurfaceProps.ts:34-47`) maps each biome:kind to its **`_a`** model only.
  - `SURFACE_ASSETS` (`data/assets.ts:280-371`) loads `_a` **and** `_b`. The 12 `_b` GLBs (368 KB) are precached and fetched on every landing, and never drawn.
- **The seam** (`geometryFromModel`, :117-143): bakes each material's colour into COLOR_0 and merges into position, normal and colour only. `merge` (:68-79) **deletes `uv`**.
- **Precedence** (`obstacleGeometry`, :290-316): the GLB wins only if `assets.hasModel(id)` **at view construction**. The procedural fallbacks are:
  - `treeBody` (:251-283): jungle is a 7-sided trunk, a 12×6 hemisphere cap and a gill ring; temperate is a trunk and 3 `IcosahedronGeometry(r, 1)` blobs;
  - caps pinned in `tests/views/surfaceProps.test.ts`: tree ≤ 300, rock ≤ 320/80, ruin ≤ 240, spire ≤ 200, vent ≤ 160.
- **One shared body material** (`SurfaceView.ts:604-611`): `MeshStandardMaterial({ color: palette.accent, flatShading: true, roughness 0.85, metalness 0.05, vertexColors: true })` with SPEC-035's `instanceFade` (`injectInstanceFade` :392). Glow parts get `obstacleGlow` (:412).
  - The boundary ring, the wall and the shelter roofs also use `flatShading: true` (:1045, `ArenaWall.ts:24-31`, `SurfaceView.ts:931`).
- **The committed props** (`props.py`, run here): see the table below. Vertex colours are biome colours ("Biome colours are baked into vertex colours", :4-6). Every GLB carries `POSITION`, `NORMAL`, `TEXCOORD_0` and `COLOR_0`, no images, no compression, about 75 bytes per triangle. `ice_rock` has `smooth=None` and 80 triangles.

  | Kind | Triangles a / b | Bytes a / b |
  |---|---|---|
  | desert_rock | 320 / 400 | 20.5 / 26.9 KB |
  | desert_ruin | 352 / 264 | |
  | ice_rock | 80 / 80 | |
  | ice_spire | 160 / 180 | |
  | jungle_tree | 594 / 594 | 44.7 / 44.9 KB |
  | jungle_ruin | 292 / 292 | |
  | volcanic_rock | 320 / 320 | |
  | volcanic_vent | 344 / 424 | |
  | hive_spire | 576 / 596 | |
  | hive_rock | 320 / 320 | |
  | temperate_tree | 376 / 376 | 47.6 / 47.3 KB |
  | temperate_rock | 320 / 320 | |

  Rebuilding reproduced every size; `jungle_tree_a/b` rebuilt with different bytes at the same size, so the drop is not byte-reproducible. The snapshot's originals were restored.
- **What the contact sheet shows** (`r19/props-preview/sheet_props.png`, Blender's own shading, azimuth 35°, elevation 28°):
  - Clean pastel low-poly toys: tan boulders, crisp bevelled beige pillars with no damage, 80-triangle white icospheres, teal-capped mushrooms on bone stems, purple cones with neon rings, four-blob lollipop trees.
  - `a` and `b` differ by one sub-boulder, 0.3–0.4 m of height, or one extra shard.
  - Nothing has a texture, a silhouette finer than about 0.3 m, or a leaf.
  - In game this art is then accent-tinted and flat-shaded (below).
- **Accent × authored colour** (linear product, computed; the screenshots agree):

  | Part | Authored | In game | Luminance kept |
  |---|---|---|---|
  | desert rock top | #d9b07a | **#67300a** | 11 % |
  | ice rock top | #f1f7fb | **#457697** | 18 % |
  | jungle cap | #3f8a95 | #2e754e | 65 % |
  | volcanic rock | #4a3d36 | #4a1303 | 38 % |
  | hive spire | #7a5a9a | #5a147d | 30 % |
  | Eden leaves | #7fb35a | #779d35 | 75 % |

- **POIs** are one mesh each at scale 1, except `arena` (`mesh.scale = radius × 0.2`, :690). The **landmarks** are therefore 1–3 m objects on a 6–7 m trigger radius:
  - a leaning slab (Cinder-4);
  - a 2.6 m blue crystal (Vetra);
  - a slab plus a small tree (Thessaly, Eden);
  - a 1.25 m lava disc (Ferrum);
  - a 1.3 m mound (the Hive).

### 2.4 Scatter, decals, boundary, wall

- **Scatter** (`Scatter.ts`):
  - `SCATTER_CAP` is 300 / 600 / 900 (:16); count = min(cap, density·(2·halfSize)²/1000) (:266); one instanced mesh plus 40 % of a second kind.
  - Measured triangles per instance: bones **150** (3 × `CapsuleGeometry(0.05, …, 2, 5)`; SPEC-018 §4.6 says 60), spores 80 (`IcosahedronGeometry(0.3, 1)`), pebbles and slag 20, crystals 8, tufts 4.
  - The tuft mask is a **32² `DataTexture` with three's defaults: `NearestFilter`, no mipmaps** (`Scatter.ts:35-63`; `three/src/textures/DataTexture.js:32,60`). Tufts are 0.7 × 0.5 m, `alphaTest 0.5`, and tinted `palette.ground` ± 8 %, the colour of the ground they stand on (:241).
- **Decals.** One merged mesh of up to 80 patches, 3–7 m.
- **Boundary ring** (`#buildBoundaryRing` :1038-1075). One `InstancedMesh` of 80–140 biome bodies (Thessaly: the procedural mushroom × 1.5), 6–28 m past the wall. Its bounding sphere spans the arena, so all of it draws every frame.
- **Arena wall** (SPEC-030, `ArenaWall.ts`): 8 chunks (`WALL_CHUNKS`), each ≤ 2 `InstancedMesh` with its own bounding sphere. This is **the codebase's only per-region culling**.

### 2.5 Layout (seed 20121) and density

- **Counts per planet** (`layout.obstacles` without the collision-only `cave_wall`/`wreck_hull`, plus `layout.props`):

  | Planet | Area | Obstacles | Props | Objects per 1,000 m² | Per screen (640 m²) |
  |---|---|---|---|---|---|
  | Cinder-4 | 129,600 m² | 43 (33 rock, 9 debris, 1 ruin) | 24 | 0.52 | **0.33** |
  | Vetra | 129,600 | 35 (23 rock, 10 debris, 2 spire) | 27 | 0.48 | **0.31** |
  | Thessaly | 160,000 | 40 (29 tree, 7 ruin, 4 debris) | 47 | 0.54 | **0.35** |
  | Ferrum | 160,000 | 44 (30 rock, 9 debris, 5 vent) | 40 | 0.53 | **0.34** |
  | Hive | 102,400 | 32 (24 spire, 6 debris, 2 rock) | 35 | 0.65 | **0.42** |
  | Eden | 129,600 | 29 (21 tree, 6 debris, 2 rock) | 18 | 0.36 | **0.23** |

- **Placement rules.**
  - Obstacle attempts are `density · area / 1000`, i.e. 6–16 per planet (`scatterObstacles`, `Layout.ts:772-795`), plus outcrops (5–8 per crescent, :725-770) and shelter debris and boulders.
  - Props are 3× the attempts (:797-813).
- **What the hash pins.** `layoutHash` covers pad, spawn, POIs, nodes, obstacles, **props** and shelters (:880-919). It is pinned per planet in `tests/systems/layout.test.ts:33-40` (`PIN_SEED` 20121).
  - Scatter and decals derive from `hash32(layout.hash, …)` and do **not** feed the hash.
- **Obstacles are combat geometry.** They truncate shots (`Projectiles.ts:110` `lineHit`) and block enemy line of sight (`EnemyAi.ts:265` `lineClear`).
- **Arena size is in the save.** `progress.explored[planet]` is sized from `halfSize` and **dropped** when the size differs (`Save.ts:923-925`).

### 2.6 Measured frames (headless Chromium, GPU; `__reallm.stats()`, whole frame including 16 post draws on `medium`)

**Spawn, `medium`, 1280×720 @1.** The first landing uses procedural props; the second (forced re-enter) uses the GLBs.

| Planet | First landing draws / triangles | Second landing draws / triangles |
|---|---|---|
| Cinder-4 | 43 / 87.3 k | 43 / 97.7 k |
| Vetra | 52 / 33.4 k | 52 / 33.2 k |
| Thessaly | 47 / 76.0 k | 49 / 104.6 k |
| Ferrum | 56 / 51.3 k | 58 / 67.7 k |
| Hive | 52 / 75.4 k | 54 / 86.8 k |
| Eden | 36 / 42.1 k | 36 / 47.8 k |

**Targeted spots, second landing, `medium` @1:**

| Planet | Cluster | Landmark | Shelter | Edge |
|---|---|---|---|---|
| Cinder-4 | 51 / 112.7 k | 52 / 112.1 k | 47 / 111.0 k | 41 / 105.3 k |
| Vetra | 52 / 40.2 k | 55 / 40.4 k | 54 / 41.0 k | 48 / 38.6 k |
| Thessaly | 51 / 112.7 k | **57 / 118.1 k** | 53 / 114.2 k | 51 / 113.1 k |
| Ferrum | 56 / 76.0 k | 57 / 73.7 k | 54 / 71.4 k | 55 / 71.7 k |
| Hive | 57 / 91.7 k | 56 / 89.8 k | 55 / 89.8 k | 56 / 89.6 k |
| Eden | 42 / 56.7 k | 38 / 54.5 k | 40 / 56.2 k | 37 / 54.1 k |

**Other presets and screens** (same Thessaly cluster unless noted):

| Screen and preset | Draws / triangles |
|---|---|
| Thessaly `high` @2 (shadow pass included) | 72 / 149.0 k |
| Thessaly `medium` @2 (renders at 1.5) | 51 / 112.7 k |
| Thessaly phone `low` @3 | 37 / 106.6 k |
| Thessaly phone `medium` @3 | 53 / 117.4 k |
| Cinder-4 `low` @1 | 32 / 108.3 k |

**Where the triangles go** (node census, `medium` with GLB props, whole scene before frustum culling):

| Planet | Terrain (all tiles) | Wall (8 chunks) | Boundary ring | Scatter | Prop and shelter bodies | Prop glow parts | Within 30 m of spawn |
|---|---|---|---|---|---|---|---|
| Cinder-4 | 115.2 k | 33.2 k | 10.5 k | **51.2 k** | 20.4 k | 0 | 10.3 k |
| Vetra | 115.2 k | 33.6 k | 3.1 k | 4.2 k | 6.4 k | ≈ 0.3 k | 10.8 k |
| Thessaly | 115.2 k | 37.0 k | **25.8 k** | 21.6 k | 21.5 k | **17.9 k** | 9.6 k |
| Ferrum | 115.2 k | 37.0 k | 11.2 k | 8.0 k | 22.5 k | 3.4 k | 9.5 k |
| Hive | 88.2 k | 29.5 k | 17.0 k | 17.1 k | 15.2 k | ≈ 15.9 k | 11.8 k |
| Eden | 115.2 k | 33.6 k | 10.5 k | 7.2 k | 15.6 k | 0 | 8.6 k |

- Shelter roofs and glows add another 0.5–1.4 k per planet.
- The in-browser numbers match: terrain and wall are culled by tile and chunk, and everything instanced draws in full.
- Within 30 m of the player there are only **1–3 k triangles of props and scatter**, the rest being terrain.

### 2.7 The Hive, today's dark precedent (`data/planets.ts` hive; `live2/hive_*`)

- **Light:** sun #b07ad8 at 2.0, elevation 40°; hemisphere sky #3a2a4a, ground #1a1424 at 0.55 (both raised by SPEC-035 §4.3).
- **Fog and background:** fog #2f2440 at 0.032, so the linear far plane is 22 + 68.75 m; background #241a33.
- **Emissive:** ground cracks #c04ad0 × 2.5 with a 0.7 Hz sine; spire glow rings at 1.5; the torch pool at the salvager's feet.
- **Result:** it reads (captures), but it is still sunlit. Nothing in the game is dark enough to need a light the player carries.

### 2.8 Budgets and bytes (measured)

- **Asset folders** (`scripts/assets/check.mjs:24-32` budgets; run on the snapshot):

  | Folder | Used | Budget | Headroom |
  |---|---|---|---|
  | models | 2.59 MB (props 0.73) | 4 MB | 1.41 MB |
  | textures | 4.36 MB (ground 1.76, flight 2.62, sprites 0.10) | 6 MB | 1.64 MB |
  | films | 8.48 MB | 12 MB | |
  | audio | 4.51 MB | 12 MB | |
  | items | 0.23 MB | 1 MB | |
  | portraits | 0.07 MB | 0.5 MB | |

- **Totals.** `public/assets` is 20.29 MB. The precache, from `vite build` of the probe copy, is **21.62 MB of 25 MB (3.38 MB headroom)**, pinned by `tests/build/pwa.test.ts:28,190`.
- **Draws and triangles.**
  - `e2e/surface-env.spec.ts`: ≤ 96 draws (80 + 16) and ≤ 120 k triangles on Cinder-4 (:20-22); ≤ 130 k on every planet (:96).
  - SPEC-016 §8 `PERF_BUDGETS` (not built): surface 96 draws, 150 k.
  - `e2e/SPEC-018.spec.ts:66-67`: at the clamp on `low` (Hive, Ferrum), draws > 15 and triangles > 5 k.
- **R18 draws already claimed.** SPEC-038 telegraphs add ≤ 3 draws, and SPEC-041 plates are DOM.

### 2.9 Per-biome read at playfield scale (`medium`, `live2/<planet>_*`)

- **Arena wall** (SPEC-030, the same on every planet): 5–7 m pieces, 4–6 m high, a hull section every 6th–8th piece, flat-shaded, 8 culled chunks. Colours (`WALL_COLORS`): dunes #c2a068, ice_wall #cfe4f2, jungle_bank #6a5a3c, lava_ridge #463a32, chitin_wall #5a4668, hills #5c8440. It reads as a lumpy border; it is not what fails.
- **Cinder-4.**
  - Ground: sand + cracked_earth, 4 / 5.5 m, tinted orange (blue ×0.20).
  - Scatter: 324 bones + 130 pebbles, 2.2 per screen, all sub-readable (5 cm bones).
  - Props: 33 rocks, drawn as maroon faceted boulders 2.4–8 m across, plus outcrops; 1 ruin (+13 small).
  - Landmarks: 4 ruins, a leaning 1.5 m slab each. Ring: dune blobs (80 triangles).
  - **Reads as:** an orange plane with maroon boulders.
- **Vetra.**
  - Ground: snow + ice, 4 / 6 m, cool tint; readable since SPEC-035.
  - Scatter: 259 emissive crystals + 104 pebbles.
  - Props: 23 rocks, 80-triangle GLBs drawn as saturated-blue polyhedra up to 8 m; 2 spires (+12 small).
  - Landmarks: 5 ice spires, a 2.6 m blue crystal each.
  - **Reads as:** a white field with blue low-poly lumps.
- **Thessaly.**
  - Ground: moss + jungle_floor, 3.5 / 5 m, green tint over a stained-glass Voronoi floor.
  - Scatter: 600 tufts (invisible) + 240 spores (pale blobs).
  - Props: 29 "trees" (+18 small), giant green mushroom caps; lime domes on a first landing. 7 ruins (+29 small).
  - Landmarks: 5, a slab plus a small tree. Ring: 140 procedural mushrooms ×1.5, **the only "jungle", and it stands outside the wall**.
  - **Reads as:** green paving with giant mushrooms.
- **Ferrum.**
  - Ground: basalt + lava_rock, 4.5 / 6 m, with emissive cracks.
  - Scatter: 400 slag (30 % embers).
  - Props: 30 rocks with per-face glow (orange triangle confetti); 5 vents (+24 small).
  - Landmarks: 6 lava pools, 1.25 m discs.
  - **Reads as:** the best biome; the menace works.
- **The Hive.**
  - Ground: chitin (agate rings) + flesh, 5 / 6.5 m, veins ×2.5.
  - Scatter: 205 spores + 82 crystals.
  - Props: 24 spires, 576-triangle GLBs with glowing rings, which read; 2 rocks (+19 small).
  - Landmarks: 6 egg mounds, 1.3 m each.
  - **Reads as:** alien, purple, readable.
- **Eden-Prime.**
  - Ground: grass (cobble Voronoi) + soil, 3.5 / 5 m, saturated green; a pale patch repeats every tile.
  - Scatter: 600 tufts (invisible) + 240 pebbles.
  - Props: 21 trees (+9 small), olive blobs; 80-triangle icosphere blobs on a first landing.
  - Landmarks: 5 "groves" of one tree and a slab.
  - **Reads as:** a bright lawn with a few blob trees; nothing hints that it is "too perfect".

### 2.10 The first review's §6.1 and §6.6, checked against the snapshot

| Finding | Status |
|---|---|
| Vetra "a white screen" | **Fixed** by SPEC-035 §4.3–4.4 (bloom threshold 1.5, linear fog from the camera). Snow reads. |
| Hive "too dark" | **Fixed** by SPEC-035 §4.3 (sun 2.0, ambient 0.55, cracks 2.5) |
| Thessaly "green floor in green fog" | Fog part **fixed** (SPEC-035 §4.4). A green floor with no jungle **not fixed**. |
| Cinder-4 "orange plane; bones, pebbles invisible; ruins far" | **Not fixed** (bones are 5 cm thick; the orange is `uMacroTint`, §2.2) |
| Eden "flat lawn, nothing tall" | **Not fixed** |
| Set-dressing tier; smaller early arenas | **Not done** |
| Ground: 8 layers share the paving cell; Thessaly and Eden one green; spots repeat every tile | **Not fixed** (9 of 13 use `'edge'`; root cause of "one green" is `uMacroTint`) |
| Props "pastel toys, cyan mushrooms, a/b barely differ" | **Not fixed.** In game they are not pastel but accent-darkened and faceted; `_b` is never drawn |
| P3: WebP q84 blocks; unused `rock` layer 123 KB | **Not fixed** (q84; `rock_*` 126 KB still ships) |

---

## 3. Findings

| ID | Sev | Finding | Evidence |
|---|---|---|---|
| W-01 | P1 | **GLB props are multiplied by `palette.accent`.** The authored biome colours lose 25–89 % of their luminance and shift hue: Cinder-4 sandstone becomes #67300a, Vetra snow #457697, Thessaly's teal caps green. | `SurfaceView.ts:604-611` (`color: palette.accent`, `vertexColors: true`) against `props.py:4-6`. The table in §2.3; `live2/cinder4_…_cluster.png` against `…_r19fix_cluster.png` |
| W-02 | P1 | **`flatShading: true` on every prop body** (and on the ring, wall and roofs) discards the GLB's authored smooth normals (`smooth=35–60` in `props.py`). Every facet of an 80–600-triangle mesh scaled to 3–9 m shows (0.5–2 m facets, 30–110 px on `medium`). | `SurfaceView.ts:606, 931, 1045`; `ArenaWall.ts:24-31`; the A/B captures |
| W-03 | P1 | **A first landing never draws the GLBs.** `obstacleGeometry` checks `hasModel` at view construction, and the per-planet drop is loaded after (`Surface.ts:834-856`, which swaps only the ground). Players see the procedural stand-ins: lime domes on Thessaly, 80-triangle blob trees on Eden. **SPEC-040 §4.6** (release on exit) makes that every landing. | Spawn triangles first → second landing +5.7 k to +28.6 k (§2.6); `live2/thessaly_medium_first_landing_cluster.png`, `eden_…`; SPEC-040 AC "releases `SURFACE_ASSETS[biome]` on exit" |
| W-04 | P1 | **The trees are not trees.** The jungle tree is a 594-triangle mushroom; the Eden tree four ico-2 blobs (376 triangles); the jungle boundary ring the procedural mushroom × 1.5. No trunk structure, branches or leaves; a/b are near twins, and `_b` is never drawn. | `props.py:99-112, 168-177`; `SurfaceProps.ts:731-735`; `r19/props-preview/sheet_props.png` |
| W-05 | P1 phone / P2 desktop | **Render resolution.** `low` is DPR 1 with no AA, and every 60 Hz device lands there (M-06): a 3× phone renders 11 % of its pixels, a Retina laptop 25 %. `medium` is DPR 1.5 + FXAA. HUD text stays crisp over a soft, jagged world, which reads as "low resolution". | `Quality.ts:45-100, 141-147`; `live2/crop_phone_low.png` (3×3 px stair steps) against `crop_phone_medium.png` against Retina `high` |
| W-06 | P2 | **`uMacroTint` is a full-strength palette cast on the ground.** Cinder-4's blue channel is ×0.20, so the sand is orange. Thessaly (0.53 / 1 / 0.28) and Eden (0.46 / 1 / 0.29) get the same green, overriding the authored leaf browns and grass yellows. | `TerrainMesh.ts:123, 151-159`; the table in §2.2 |
| W-07 | P2 | **The ground content is low-frequency and patterned.** 9 of 13 recipes use Voronoi edges (the jungle floor as stained glass, grass as cobbles, chitin as agate). Moss and soil are soft fbm with no 5–15 cm detail. The 3.5–6.5 m tile repeats visibly. Resolution is not the cause (79–146 texels/m against ≤ 94 px/m). | `ground.py:202-216`; `live2/crop_thessaly_high_ground.png`, `crop_eden_high_ground.png` |
| W-08 | P2 | **The playfield is empty.** 0.23–0.42 obstacles and props per screen. Landmarks are drawn at scale 1 (1–3 m) on a 6–7 m trigger. Cinder-4's bones (5 cm thick) and every tuft (ground-coloured, 0.5 m) are sub-readable. | §2.5; `SurfaceView.ts:690`; `live2/*_landmark.png` |
| W-09 | P2 | **Instanced layers are not culled per instance.** Every prop kind, glow part, scatter layer and the boundary ring is drawn in full every frame. 60–88 % of the drawn triangles are off screen: spawn frames against what lies within 30 m plus the salvager, Vetra 60 %, Cinder-4 and Thessaly 87–88 %; within 30 m there are 1–3 k of props and scatter. Cinder-4 frames sit at 97.7–112.7 k against the e2e's 120 k. | §2.6 census; three's `InstancedMesh` culls by its whole-set bounding sphere |
| W-10 | P2 | **Scatter overshoots SPEC-018 §4.6.** Bones are 150 triangles per instance (spec 60), so Cinder-4's scatter is **51.2 k** (spec "≤ 12 k"). Thessaly's spores are 19.2 k and its boundary ring 25.8 k (spec ≈ 10 k). | §2.4; SPEC-018 §4.6 and §4.8 |
| W-11 | P2 | The tuft mask is 32², `NearestFilter`, with no mipmaps: blocky, shimmering blades, and the only "grass" in the game. | `Scatter.ts:35-63`; three r185 `DataTexture` defaults |
| W-12 | P2 | **Ferrum's volcanic rock `Glow` is assigned per face.** The lava reads as orange triangles and reveals the polygon size. | `props.py:131-133`; `live2/ferrum_…_cluster.png` |
| W-13 | P2 | Props have no contact grounding off `high`: no occlusion in the terrain tint and no blob under props. Boulders and trees float on `low` and `medium`. | `TerrainMesh.ts:57-67` (occlusion from the height field only); blobs only for entities (`SurfaceView.ts:885-900`) |
| W-14 | P3 | Wasted bytes: the unused `_b` GLBs (368 KB) and the `rock` ground layer (126 KB) are precached and shipped, the `_b` GLBs fetched on every landing. The prop GLBs also carry `TEXCOORD_0` that the seam deletes (≈ 15 % of 748 KB). | `data/assets.ts:280-371`; `SurfaceProps.ts:68-79`; `common.py:379-390` |
| W-15 | P3 | WebP q84 blocks remain on smooth layers (snow, soil, moss, flesh). | `ground.py:232` |
| W-16 | P2 (caves) | Light counts are compiled into every lit shader. Toggling a light's `visible` or `castShadow` recompiles every lit material mid-play: a hitch on phones. A flashlight must toggle **intensity** only, and three's `SpotLight.map` (a cookie) only works with `castShadow`. | three r185 `WebGLPrograms` light-count parameters; `SpotLight.map` documentation |
| W-17 | P3 (caves) | Two surface defaults would light a dark level. The IBL sky has a sun lobe of 6 (`skyParamsFor`, `Environment.ts:35-45`). The rim light (0.6) is fixed. Grain grows as `1 − luminance`. | `Environment.ts`; `SurfaceView.ts:590`; `PostChain.ts:89` |
| W-18 | P3 | Shrinking an arena ("halfSize 180 → 140", first review §6.1) silently drops the player's explored-map mask for that planet, and moves every layout pin and POI band. | `Save.ts:234-243, 923-925` |

---

## 4. Proposals

Two build tracks.

- **Hand-run Blender asset drop.** The factory has no Blender, so these follow the SPEC-021 and SPEC-035 §4.15 precedent: rendered and committed with the generator change before the spec is labelled ready.
- **Runtime code** (`views/`, `data/`, `systems/Layout.ts`, `scenes/Surface.ts`), built by the factory.

Numbers marked † are *initial tuning*.

### W-A — Props that look like their art (runtime, S; do first)

1. **One material per prop source** (`SurfaceView.ts:604-660`).
   - GLB bodies draw with `#glbMaterial = MeshStandardMaterial({ color: '#ffffff', roughness: 0.85, metalness: 0.05, vertexColors: true })`: no `flatShading`, authored normals.
   - Procedural bodies keep the accent material, and with it the faceted read SPEC-018 §4.7 designed. `displace()` and `toCreasedNormals(π/4)` already bake flat or creased normals, so dropping `flatShading` there too is a look call, not a requirement.
   - Both carry `instanceFade`; SPEC-035's fade flips the material of the faded mesh (it currently flips one shared material).
   - The A/B: `live2/*_r19fix_cluster.png` against `*_cluster.png`.
   - Cost: 0 draws (each kind is already its own mesh); +1 program variant.
2. **GLBs on every landing.**
   - `SurfaceScene.enter` awaits `assets.load(SURFACE_ASSETS[biome] + SURFACE_SHARED_ASSETS)` for up to `PROP_DROP_WAIT_MS = 1500`† (the state machine already awaits `enter`, `StateMachine.ts:227`, behind the fade), then builds the view.
   - If the drop lands later, `SurfaceView.setPropModels(assets)` rebuilds each prop `InstancedMesh` in place: same matrices, fades and occluder slots, and the procedural geometry is disposed.
   - Robust to SPEC-040 §4.6. Only `setGroundTextures` exists today.
3. **Variants.**

   ```ts
   export const PROP_MODELS: Partial<Record<`${Biome}:${ObstacleKind}`, readonly ModelId[]>> = {
     'desert:rock': ['desert_rock_a', 'desert_rock_b'], /* … */
   };
   ```

   An instance takes `variants[hash32(layout.hash, 'variant', kind, i) % n]`. The layout hash is untouched.
   - One `InstancedMesh` per (kind, variant): +1 body draw per extra variant, +1 if the variant glows.
   - With 2 variants: +2 to +4 draws per planet. The `_b` bytes stop being dead weight.
4. **Landmarks read as landmarks.** `poi.kind === 'landmark'` draws at `LANDMARK_SCALE = 0.4 × poi.radius`† (so ×2.4–2.8); the occluder candidate grows with it. Real landmark models come with W-C.
5. **Scatter back inside SPEC-018 §4.6.**
   - Bones become 3 × `CapsuleGeometry(0.1, 0.9–1.3, 1, 4)`, 72 triangles per instance and twice the thickness, so they read.
   - Spores become `IcosahedronGeometry(0.3, 0)` (20 triangles).
   - The tuft mask becomes 64², `LinearMipmapLinearFilter`, `generateMipmaps`, tinted `palette.ground × 1.3` toward #d8d0a0 so tufts stand off the ground.
   - Cinder-4 scatter 51.2 k → 25.9 k; Thessaly spores 19.2 k → 4.8 k.
6. **`uMacroTint` at 35 %.** `albedo *= mix(vec3(1.0), uMacroTint, uTintAmount)` with `uTintAmount = 0.35`†, per planet in `look.ground.tint?`.
   - The planet hue survives and the authored colours come back: Cinder-4 gets tan sand with orange light; Thessaly's leaf-litter browns return.
   - Pinned in `tests/views/terrain.test.ts` as a new uniform; no new chunk.
7. **Drop the dead bytes.** Remove `textures/ground/rock_*.webp` (−126 KB) and the unused UV channel from non-tree prop GLBs (export `export_texcoords=False` for `Body`; −≈ 110 KB, with the W-C drop).

**Tests.**
- `tests/views/surfaceView.test.ts`:
  - a GLB-sourced body mesh has `flatShading === false` and colour #ffffff, and a procedural one keeps the accent;
  - `setPropModels` keeps `instanceMatrix` values and swaps the geometry;
  - a landmark's scale is `0.4 · radius`.
- `tests/views/surfaceProps.test.ts`: `PROP_MODELS` values become arrays (line 85's `${biome}_${kind}_a` pin changes deliberately).
- `tests/views/scatter.test.ts`: bones ≤ 72 and spores 20 triangles; the tuft texture's filters.
- `e2e`: on a first `?scene=surface&planet=thessaly` landing, within 2 s, `sceneInfo.propSource === 'glb'` (new key).

**PLAN.** None of the token totals, the save or the SPEC-010 invariants move; this is R20's first decision.

### W-B — Draw only what is on screen (runtime, M; funds everything after it)

**What.** A CPU visible-set compaction for every static instanced layer: prop bodies, glows, scatter, the boundary ring, shelters, and the new foliage, cover and dressing.
- The fixed camera shows ≈ 640 m² of a 102,400–160,000 m² arena, 0.4–0.6 %.
- A 16 m grid over each layer's instances; the view rectangle, grown by margins, selects ≈ 1.5–3 % of them.

```ts
// views/InstanceCuller.ts (three allowed)
export interface CullRect { minX: number; maxX: number; minZ: number; maxZ: number }
/** Pure: the fixed rig's ground trapezoid for this target, distance and aspect, as an AABB grown by
 *  `margin` (tallest instance height × cot 35° + 2 m; on `high` also toward the sun by h / tan(elevation)). */
export function viewRect(target: { x: number; z: number }, camDistance: number, aspect: number, margin: number, out: CullRect): CullRect;
export class InstanceGrid {
  constructor(cell: number, xz: Float32Array);
  query(rect: CullRect, out: Int32Array): number;
}
export class CulledInstances {
  constructor(mesh: THREE.InstancedMesh, master: { matrices: Float32Array; colors?: Float32Array; fades?: Float32Array }, grid: InstanceGrid);
  /** Writes the visible subset into instanceMatrix/instanceColor/instanceFade, sets count and visible. No allocation. */
  refresh(rect: CullRect): number;
  /** SPEC-035's occluder fade writes through the master, by master index. */
  setFade(index: number, value: number): void;
}
```

**Cadence.** `refresh` runs when the camera target has moved > 1 m† or the distance has eased. Estimated ≤ 0.3 ms on a phone. `sceneInfo.cullMs` and `sceneInfo.instancesDrawn` are reported.

**Result.** The spawn frame falls from 33–105 k to ≈ 12–16 k plus entities (entities ≤ 25 k: `RECIPE_TRIANGLE_CAP` × population, SPEC-019 AC-98). Hidden layers (`count 0 → visible false`) also stop costing draws.

**Tests.**
- `tests/views/instanceCuller.test.ts`:
  - `viewRect(22, 16/9)` and `(17, 2.16)` contain the four pinned trapezoid corners of §2.1;
  - `refresh` writes exactly the instances whose position is inside, carries colour and fade, allocates nothing (buffers keep identity), and sets `visible false` at count 0.
- `e2e/surface-env.spec.ts`: a ratchet of **≤ 60 k triangles at spawn on every planet on `medium`**†.
- **Watch** `e2e/SPEC-018.spec.ts:66`: `drawCalls > 15` at the clamp on `low`. Hidden empty layers can take it to 13–17, so re-pin deliberately (> 10) or keep empty meshes visible there.

### W-C — Real trees, groves, and a dressing tier

**Asset drop (hand-run Blender, `props.py` plus a leaf and ground-cover atlas generator)**

- **GLB contract for trees** (pinned in the spec and read by a node test):
  - Unit: canopy radius 1 (the widest horizontal extent of `Leaf`); base y 0; origin at the trunk base.
  - Trunk base radius 0.14 ± 0.02 (the collision radius = 0.14 × canopy scale).
  - Nodes and materials: `Bark` (COLOR_0, smooth normals, TEXCOORD_0 into the atlas's opaque bark cell), `Leaf` (TEXCOORD_0 into the foliage atlas, COLOR_0 ±10 % per card, normals bent `normalize(p − crownCentre)` for soft crowns), optional `Glow` (jungle seed-pods: Thessaly keeps a bioluminescent note). LOD1 as `Bark_LOD1` and `Leaf_LOD1`.
  - LOD0 ≤ 700 triangles (bark ≤ 450, ≤ 125 leaf cards); LOD1 ≤ 140.
- **Models:**

  | Id | Replaces / new | Triangles | Est. bytes |
  |---|---|---|---|
  | `jungle_tree_a` / `_b` | buttress-root trunk, 3–5 curved limbs, broad-leaf card crown ± pods | ≤ 700 + 140 | ≈ 62 KB each |
  | `jungle_tree_c` | fern tree (single stem, frond crown) | ≤ 500 | ≈ 40 KB |
  | `temperate_tree_a` / `_b` | Eden deciduous, rounded crown | ≤ 700 + 140 | ≈ 62 KB each |
  | `temperate_tree_c` | **the "perfect" orchard tree**: symmetric, identical | ≤ 600 | ≈ 55 KB |
  | Dressing `_c` per biome kind, 12 GLBs | desert rib-cage arch (wurm bones), a wind-cut arch; ice shard cluster, survey cairn; jungle root-wrapped column; basalt column cluster, slag heap with a cart; hive rib arch, egg cluster (Glow); Eden dry-stone wall, ruin corner | 150–350 | ≈ 25 KB each |
  | `landmark_<biome>` × 6 | landmark models, 4–8 m | ≤ 900 | ≈ 60 KB each (optional; W-A's scale is the cheap version) |

- **Textures:** `textures/foliage/atlas.webp`, 512² RGBA q90, 4×4 cells of 128² (≈ 150–250 KB), alpha dilated 4 px for mips. Cells: jungle leaf cluster ×2, temperate leaf cluster ×2, fern ×2, grass lush ×2, grass dry, flowers, frost fern, ash frond, hive tendril, moss clump, broad-leaf plant, and one opaque bark cell (two tones) that the trunks sample.
- **`build.mjs`** `GENERATED` gains `[/^textures\/foliage\/.+\.webp$/, '<generator>', …]`. Without it `LICENSES.md` gets no rows and `check.mjs` fails. `models/props/*` is already covered (:91).
- **Bytes.**

  | Total | Change | After |
  |---|---|---|
  | Models | +≈ 0.46 MB (−0.11 MB with W-A 7) | ≈ 2.94 of 4 MB |
  | Textures | +≈ 0.25 MB | |
  | Precache | +≈ 0.6 MB | ≈ 22.2 of 25 MB |

  Optional landmarks add +0.36 MB to models.

**Runtime**

- **The foliage seam** (`SurfaceProps.ts`):

  ```ts
  export interface FoliageGeometry {
    /** Bark + leaves merged, keeping `uv` (today's `merge` deletes it, :68-79). */
    body: THREE.BufferGeometry;
    glow?: THREE.BufferGeometry;
    lod1: THREE.BufferGeometry;
  }
  export function foliageFromModel(root: THREE.Object3D): FoliageGeometry;
  ```

- **Materials.** One material and **one draw per tree variant**.
  - Bark UVs sample an opaque bark cell of the atlas, so bark and leaves share `MeshLambertMaterial({ map: atlas, alphaTest: 0.45, side: DoubleSide, vertexColors: true })`.
  - Lambert because foliage needs no specular, and it roughly halves the fragment cost of `MeshStandardMaterial`.
  - Only the jungle's `Glow` part is a second draw.
  - `onBeforeCompile`, in the vertex shader: `transformed.xz += uWind * sin(uTime·1.3 + dot(instanceMatrix[3].xz, vec2(0.37, 0.61))) * position.y²` with amplitude 0.035 m per m²†, 0 under reduce motion.
  - In the fragment shader, a **dithered fade and cut-out**: `if (bayer4(gl_FragCoord.xy) > vFade) discard;`, plus a screen-space disc around the player (`uCutout = (sx, sy, r)`, only for fragments nearer the camera than the player). No transparency flip, no sorting.
  - Shadows (`high`): three's depth material copies `map` and `alphaTest`; the wind is not replicated (acceptable).
- **LOD by preset, not distance.** The view range is a fixed 17–35 m, so distance LOD and impostors buy nothing. `low` draws LOD1; `medium` and `high` draw LOD0. The boundary ring on jungle and hills uses the biome's LOD1 tree, not the procedural mushroom or blob.
- **Collision decoupled from canopy.** A tree obstacle's `radius` is its **trunk** radius (0.5–0.9 m†), and the view scales the canopy by `radius / 0.14`, i.e. 3.6–6.4 m. You walk under canopies; the dither shows you.
- **Groves, orchards and clusters are Layout features**, placed like SPEC-030 outcrops (`Layout.ts:725-770`: pad, POI, node and corridor clearances and 10 m from corridors). They add to the obstacles, so the **hash pins move deliberately**.

  ```ts
  // data/planets.ts — PlanetDef.surface.features gains:
  readonly groves?: { readonly count: number; readonly radius: readonly [number, number]; readonly treesPer1000m2: number; readonly kinds: readonly ObstacleKind[] };
  readonly orchards?: { readonly count: number; readonly rows: number; readonly cols: number; readonly spacing: number };
  readonly clusters?: { readonly count: number; readonly pieces: readonly [number, number]; readonly spread: number };
  ```

  | Planet | Feature† | Collidable additions | Per screen |
  |---|---|---|---|
  | Thessaly | groves 14 × r 20–30 m at 12 trees / 1,000 m² | ≈ 330 trunks (≈ 17 % of the area) | 7–8 trees in a grove, 1–2 in clearings |
  | Eden | orchards 4 × 6 rows × 8 cols at 7 m | 192 identical trees | W-E |
  | Cinder-4, Vetra, Ferrum, Hive | clusters 30 × 4–10 dressing pieces (mixed `_a` / `_b` / `_c` of the existing kinds), 6–15 m spread | ≈ 200 pieces | 1–3 set pieces per screen |

  - The clusters are "set pieces" such as a wurm rib cage beside a wind-cut arch or a basalt cluster with a slag heap. They sit along corridors (outside the 8 m half-width) and around landmarks, where the walk between objectives happens.
- **Undergrowth (view-only, not collidable).** Ferns and broad-leaf plants: 2 kinds per jungle and temperate biome, cross-quad clumps (6 triangles) from the atlas, 40 per 1,000 m²† under canopies and 8 in the open.
- **Grounding.**
  - Terrain tint darkened under canopies at build time: `tint *= 1 − 0.3·smoothstep(rCanopy, 0.3·rCanopy, d)`†, zero runtime cost.
  - One instanced contact-shadow layer (the existing 32² radial `DataTexture`) under every prop and trunk: +1 draw, 2 triangles each, culled by W-B.
- **Readability under canopies.** A canopy instance whose footprint holds a live enemy or a pickup within 25 m of the player dithers to 0.35 (checked every 0.1 s, like SPEC-035's occluders).

### W-D — Ground cover and the ground pass

**Asset drop (`ground.py`)**
- Re-author four recipes, all 512², the same packing, and the same alpha rule (SPEC-018 §4.5):
  - `jungle_floor`: leaf litter from rotated elongated leaf stamps in 3 hues, with twigs and no cell edges;
  - `grass`: anisotropic blade noise plus clover, no edges;
  - `moss`: clumped cushions;
  - `chitin`: plates without agate rings.
- Albedo quality 84 → 90 (snow, soil, moss and flesh → 92): +≈ 0.2 MB. The normal-roughness maps stay at q92.
- Add `textures/ground/detail_nr.webp`: 256², a tileable micro normal plus roughness at 1.2 m repeat, ≈ 40 KB.
- Remove `rock_*`.

**Runtime**
- **Terrain shader** (`TerrainMesh.ts`), gated by the defines `TERRAIN_DETAIL` and `TERRAIN_ANTITILE` on `medium` and `high` (program key `terrain/2…`):
  - detail normal at strength 0.35;
  - a second sample of layer A at `R(37°)·vMapUv·0.43`, blended by a value noise over 23 m, which breaks the repetition.
  - Cost: +3 texture fetches per ground fragment.
- **Ground cover** (`views/GroundCover.ts`), streamed, with no master list.
  - For each 8 m cell in the grown view rectangle, clumps come from `hash01(hash32(layout.hash,'cover'), cx, cz, i)`, rejected against a 2 m "blocked" `Uint8Array` built once (POIs + 2 m, pad 15 m, nodes 1.5 m, obstacles r + 0.6, corridors 3 m). The grid is 40 KB on a 400 m arena.
  - One `InstancedMesh` with an instanced `uvCell` attribute: **1 draw**. Capacity by preset: 0 / 700 / 1,200.

  ```ts
  // SurfaceLook gains:
  readonly cover?: {
    readonly kinds: readonly { readonly cell: number; readonly weight: number; readonly size: readonly [number, number] }[];
    readonly per1000m2: number;
    readonly underCanopy?: number;
    readonly lattice?: { readonly spacing: number; readonly jitter: number };
  };
  ```

  - Densities†: Eden 300, Thessaly 220 (×1.6 under canopy), Hive 40, Cinder-4 20, Vetra 12, Ferrum 10. On `low` cover is off, and W-A's tufts remain.

### W-E — Eden, "too perfect" (runtime hooks; the story pass owns the lines)

- **Orchards** (W-C): `temperate_tree_c` only, rotation 0, scale 1.0, exact 7 m lattice, no jitter, no decals inside. Everywhere else in the game gets variation, so the contrast is the tell.
- **Cover lattice.** Inside orchards, cover uses `lattice: { spacing: 1.8, jitter: 0 }`: mown rows.
- **The seam.** `look.ground.seam?: { axis: 'x' | 'z'; at: number; shift: number }`. The terrain shader offsets UVs by `shift` tiles past the line (`vMapUv.x > uSeamU ? vMapUv + uSeamShift : vMapUv`: 1 compare), and the cover lattice restarts its phase there.
  - One straight line where the lawn does not match itself. 0 draws, 1 uniform.
  - Eden only; placement by the story pass (for example crossing `eden_ridge`).
- **An optional second tell for the story pass.** Reuse one ruin model identically, crack for crack, on Cinder-4, Thessaly and Eden ("ruins nobody built", the Thessaly blurb).

### W-F — The dark underground, rendering side (runtime, M; the caves gameplay spec owns layout, entry and puzzles)

**The contract**, attached to whatever level definition the caves spec uses:

```ts
// data/planets.ts — SurfaceLook gains an optional block; SurfaceView reads it when present
export interface DarkLook {
  readonly background: string;                    // clear and fog colour, '#05060a'†
  readonly fogSpan: number;                       // linear fog past the camera distance: 24 m†
  readonly ambient: { readonly sky: string; readonly ground: string; readonly intensity: number }; // '#1a2230' / '#07080b' / 0.12†
  readonly rim: number;                           // 0.15† (surface 0.6)
  readonly ibl: number;                           // 0.12†, from a dark sky: sky = background, sunIntensity 0
  readonly grade: { readonly exposure: number; readonly bloomThreshold: number; readonly bloomStrength: number;
                    readonly vignette: number; readonly grain: number; readonly lift?: readonly [number, number, number] };
                    // 1.35 / 0.9 / 0.5 / 0.5 / 0.015 / [0.012, 0.014, 0.02]†
  readonly flashlight: { readonly color: string; readonly intensity: number; readonly distance: number; readonly angle: number;
                         readonly penumbra: number; readonly decay: number; readonly aimAhead: number; readonly height: number };
                         // '#fff2d8', 45, 24 m, 0.42 rad, 0.5, 1.3, 7 m, 1.7 m†
  readonly beacons: { readonly color: string; readonly emissive: number; readonly spill: number; readonly fogFree: boolean };
                      // e.g. '#7fe0ff', 2.6, 0.35, true†
}
```

- **No sun.** A dark level is built without the key `DirectionalLight` (not at intensity 0, which still costs a light).
- **Fog.** `THREE.Fog(background, camDistance, camDistance + fogSpan)`. The top of the screen (≈ 31 m slant) is ≈ 38 % fogged: "lower visibility" at no cost.
- **Grade.** `Look` gains `lift?`, carried to `PostChain` `uLift` (it already exists, neutral). Tone mapping stays ACES; exposure lifts the mid-tones. Try AgX only if emissive hues skew (Q7).
- **The flashlight follows the aim.** The target moves `aimAhead` along `player.facing`, eased at 12 rad/s. On and off change **intensity only**, never `visible` or `castShadow` (W-16). An input action `flashlight`: the placement belongs to SPEC-037 and SPEC-045; battery is gameplay.

**Options per preset** (`QualitySettings` gains `flashlight: 'fake' | 'spot' | 'spot-shadow'`; low / medium / high):

| Option | low | medium | high |
|---|---|---|---|
| Light set | hemi, rim, torch, fx point (4 lights, one fewer than the surface) | + 1 `SpotLight` (5) | + spot shadow (5) |
| Flashlight | Fake: an additive ground quad (the cookie) 7 m ahead, 7 × 5 m, 2 triangles, plus a faint open cone (32 triangles, 0.08 opacity). The torch widens to intensity 10†, 10 m | `SpotLight`, no shadow | `SpotLight` + 512² shadow (casters in the 24 m cone) + a 64² cookie `SpotLight.map` (lens rings) |
| Draws | +2 | +0 | +5–12 in the shadow pass |
| Triangles | +34 | +0 | +5–15 k (depth pass) |
| Fragment cost | an additive quad over ≈ 6–10 % of the screen | +1 light evaluation per lit fragment (≈ the sun it replaces) | + PCFSoft taps and 1 cookie sample |
| Beacons (instanced emissive crystals or fungus + additive spill decals) | +2 draws, colour-clamped | +2, bloom at threshold 0.9 | +2, bloom |
| Cave walls | a cutaway: extruded wall chunks with a flat black cap (`MeshBasicMaterial('#020203', fog: false)`); W-C's screen-space cut-out dithers camera-side walls around the player | same | same |
| Dust | `StormParticles` `dot`, 60 instances, additive | same | same |

- **Way-finding.**
  - Beacons are `fog: false` so the chosen few read as beacons through the dark; decorative fungus keeps fog.
  - **No point light per crystal**: every light enters every lit shader. The spill decals fake it at 1 draw.
  - SPEC-035's hostile rim already keeps enemies readable in darkness. Whether it should dim outside the beam is a gameplay call (Q8).
- **Budget.** A cave scene of ≤ 120 × 120 m sits well inside ≤ 80 + 16 draws and ≤ 130 k triangles. The only real risk is the phone fragment cost of the spot light, to be measured on hardware; SPEC-040's governor steps down.

**Tests.**
- `tests/views/flashlight.test.ts`:
  - `'spot'` adds exactly one `SpotLight`, and `setOn(false)` leaves it in the graph at intensity 0;
  - `'fake'` adds no light and 2 meshes;
  - `'spot-shadow'` sets `castShadow`, `mapSize 512` and a non-null `map`;
  - `sync` aims `aimAhead` m along the facing (pure math).
- `tests/core/quality.test.ts`: the `flashlight` column.
- A pure `darkFogRange(camDistance, span)`.
- e2e on the cave scene on `medium`:
  - `sceneInfo.flashlight === 'spot'`;
  - draws ≤ 96;
  - with the light on, the luminance of a pixel 7 m ahead is more than 3× a corner pixel's; with it off, less than 1.5×.

### Budget math, `medium`, worst planet (Thessaly), after W-A to W-D

| Layer | Drawn triangles today | After | Scene draws after |
|---|---|---|---|
| Terrain (4–9 visible tiles) | 7–16 k | 7–16 k | 4–9 |
| Wall, plus the ring near an edge | ≈ 10 k + ring 25.8 k (always) | ≤ 14 k near an edge, else ≈ 0 | 0–6 |
| POIs and decals (culled per mesh) | 3.5 k | ≤ 4.5 k (landmarks ×2.5) | 2–6 |
| Rocks, ruins, debris, shelters, glows | 21.5 k + glows 17.9 k (all) | ≤ 5 k visible | 3–6 |
| **Trees in a grove** (≤ 14 visible × ≤ 700; one material per variant) | (in the row above) | ≤ 9.8 k | 3–5 (a/b/c + jungle glow) |
| Scatter (tufts and spores) | 21.6 k | ≤ 1 k | 0–2 |
| Undergrowth (≤ 60 × 6) | — | 0.4 k | 1–2 |
| Ground cover (≤ 700 × 6) | — | 4.2 k | 0–1 |
| Dressing clusters (≤ 20 × 350; `_c` variants of the existing kinds) | — | ≤ 7 k | (in the rocks row) |
| Contact shadows | — | 0.2 k | 1 |
| Entities: character, a roster's 3–4 recipes (≤ 22 × 700), projectiles, pickups, blobs, VFX, storm, telegraphs (SPEC-038), route, nodes | 3–25 k | 3–25 k | ≈ 25–35 in a fight |
| **Total** | 104.6–118.1 k measured at quiet spots | **≤ 87 k worst case** (a grove fight at the edge) ≤ 130 k (≥ 43 k headroom; ≤ 120 k holds on Cinder-4) | **≤ 72** of 80 (today's quiet spots are 35–41) |

- **`low`:** LOD1, no cover, no post, undergrowth at 50 %. **`high`:** + ≤ 12 caster draws in the shadow pass (not budget-pinned; measure).
- **Fill** is the unmeasured risk: alpha-tested leaves inside a grove cover up to 50 % of the screen at 2 layers, ≈ +1 screen of discard fragments at DPR 1.5. Mitigated by Lambert leaves, the opaque LOD1 on `low`, and SPEC-040's governor.
- **Budget pin.** A new §4.11 sub-budget, **foliage and dressing ≤ 30 k triangles and ≤ 12 draws on `medium`**†, e2e-pinned in a grove (`?spawn` or a scripted walk).

### Asset drop versus runtime

| Piece | Hand-run Blender drop (committed before the spec is ready) | Runtime (factory) |
|---|---|---|
| W-A | — (optionally re-export `Body` without UVs with W-C) | material split, bounded await and `setPropModels`, variants, landmark scale, scatter fixes, tint amount, remove `rock_*` |
| W-B | — | `InstanceCuller`, SurfaceView wiring, occluder fade through the master |
| W-C | trees a/b/c, 12 dressing `_c`, optional landmarks, the foliage atlas, previews reviewed on the contact sheet | foliage seam and materials, LOD by preset, Layout groves, orchards and clusters, canopy tint, contact shadows, `SURFACE_ASSETS` entries |
| W-D | four re-authored layers, WebP quality, `detail_nr` | terrain defines, `GroundCover.ts`, `look.cover` data |
| W-E | `temperate_tree_c` (in W-C) | orchard lattice, cover lattice, seam uniform |
| W-F | — (the cookie is a 64² `DataTexture` built in JS) | `DarkLook`, `Flashlight.ts`, `Look.lift`, beacons and spill, cutaway, preset column |

### What pins what

| Pin | Moves under |
|---|---|
| `tests/systems/layout.test.ts` `PINNED` (SPEC-012 AC-1), AC-3 corridors, AC-5 reachability over 200 seeds | W-C groves, orchards and clusters (deliberate literal update; corridors and reachability must stay green) |
| `tests/systems/spawn.test.ts` (real layouts) | W-C (the spawn ring must still find free ground) |
| `tests/views/surfaceProps.test.ts` `PROP_MODELS` `_a` (l.85); procedural caps | W-A variants; the fallbacks unchanged |
| `tests/views/surfaceView.test.ts` mesh count ≤ 60 (small layout); `enemyParts()` keys on `flatShading && count 64` | W-A to W-C (new meshes; props never take capacity 64) |
| `tests/views/scatter.test.ts` counts 300 / 400 / 160 | unchanged (culling runs in the view, not at build) |
| `tests/views/terrain.test.ts` replaced chunks and program keys | W-A tint uniform; W-D defines (`terrain/2`) |
| `tests/data/content.test.ts` boot manifest = 5 files | every new asset goes in `SURFACE_ASSETS` (lazy) |
| `e2e/surface-env.spec.ts` 96 draws / 120 k / 130 k | ratchets added (W-B ≤ 60 k at spawn; the W-C grove sub-budget) |
| `e2e/SPEC-018.spec.ts` AC-59: draws > 15 at the clamp on `low`; straight +x walks on the Hive and Ferrum | W-B (hidden empty layers); W-C clusters (keep them off the +x line from spawn, or re-pin) |
| `scripts/assets/check.mjs` budgets and LICENSES rows; `build.mjs` `GENERATED` | W-C and W-D (a new `textures/foliage/` row) |
| `tests/build/pwa.test.ts` precache ≤ 25 MB | W-C and W-D (+≈ 0.6 MB, leaving ≈ 2.8 MB for the rest of R19) |
| Save format; token totals 670 / 104 / 2,380; SPEC-010 | **untouched** (all decoration derives from `layout.hash`; no save fields) |

---

## 5. Risks and open questions

1. **Trunks as cover.** Collidable trunks change combat: they truncate shots and block enemy line of sight. **Recommend yes:** thin trunks (0.5–0.9 m) make groves the ambush biome Thessaly's blurb promises, and groves cover ≤ 20 % of the area with corridors kept. The combat auditor should confirm with SPEC-038/041's kiting numbers.
2. **Readability under canopies.** A top-down jungle hides enemies and pickups. **Recommend** the dithered player cut-out, plus the canopy that dithers to 0.35 when an enemy or pickup is under it. Groves stay out of arena rings and mission bands' last 20 m. Fallback: lower canopies (scale ×0.8).
3. **Phone fill rate** with alpha-tested leaves is unmeasured (the playtest log's phone rows still read "not run"). **Recommend** Lambert leaves and LOD1 opaque crowns on `low`. The first hardware run pastes a `?perf` row in a Thessaly grove, and a breach (> 8 ms render on `medium`) drops cover density first.
4. **Layout pins move.** W-C is the first change since SPEC-030 to alter layout hashes. **Recommend** landing it after SPEC-016's rescoped campaign run and in one PR with the literal updates, as CLAUDE.md asks.
5. **Sequencing with SPEC-040.** Its §4.6 release makes W-03 total. **Recommend** W-A's bounded await plus `setPropModels` land **with or before** SPEC-040, or become an amendment to it.
6. **Precache allocation.** R19 as a whole has ≈ 3.4 MB of precache left. The world pass takes ≈ 0.6 MB (≈ 1.0 MB with landmarks). Film re-takes and new audio compete for the rest. **Recommend** the designer allot it in the R-entry.
7. **Tone mapping for caves.** **Recommend** ACES with exposure 1.35 and lift first (no pipeline change). AgX per scene is possible (`OutputPass` reads `renderer.toneMapping`; the direct path compiles per scene), but it changes the game's look in those levels; test it only if the beacon hues skew.
8. **Enemies in darkness.** Should the hostile rim dim outside the flashlight cone (tension) or stay (fairness)? **Recommend** it stays at 60 % outside the cone. That is gameplay's call.
9. **Arena size.** **Recommend** no `halfSize` shrink. It drops explored masks (`Save.ts:923-925`), moves every layout pin and every POI band. Densify instead (W-C clusters along corridors).
10. **Resolution after SPEC-040.** `medium` still renders a 3× phone at a quarter of its pixels. **Recommend** a SPEC-045 "Sharp" option (DPR up to 2 on `medium`) with SPEC-040's governor stepping back 0.25 at a time, rather than retuning the preset table blind.
11. **BatchedMesh instead of W-B.** three r185's `BatchedMesh` culls per instance and multi-draws several geometries in one call. It depends on `WEBGL_multi_draw`, whose iOS Safari support is unverified, and it has no per-instance custom attributes (SPEC-035's fade). **Recommend** the CPU compaction.
12. **Asset determinism.** Rebuilding `props.py` changes `jungle_tree_*` bytes at the same size, so review the drop by contact sheet and triangle counts, not by byte diff.
