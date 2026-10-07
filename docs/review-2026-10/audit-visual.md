# Fourth review: visuals, art pipeline, UI/HUD and project hygiene

Auditor prefixes: **V-** (visuals, UI) and **D-** (docs, process). Read-only review of `main` at `dfe6f04` (2026-10-07) and `reallm-specs` `origin/main` at `b07edb2`. Nothing in either repository was changed.

**Method**
- Read the sources: `src/views/*`, `src/scenes/Surface.ts`, `src/data/{planets,enemies,items,assets,cosmetics}.ts`, `src/ui/*`, `src/style.css`, the generators under `scripts/assets/`, and `public/assets/LICENSES.md`.
- Ran `node scripts/assets/check.mjs`. It is read-only, and it measured the `dist/` from 2026-10-06 22:08, which predates the last merges.
- Looked at committed images. Contact sheets were built with a scratch Swift tool:
  - 33 item pictures, at 160 px and at the quick bar's 40 px;
  - 12 portraits;
  - 41 film posters;
  - 12 ground albedos;
  - the foliage atlas;
  - 6 flight planet maps;
  - the 3 promo screenshots (`public/screenshots/*.jpg`, captured 2026-10-06, the newest in-game frames committed);
  - `og.png`;
  - `docs/screenshots/spec-030`, `spec-031`.
- Computed colour pairs with WCAG relative-luminance contrast and CIE ΔE76. Palette colours stand in for the rendered ground, as the earlier reviews did.
- Checked the earlier reviews (`docs/design-review-2026-09.md` §5–6, `docs/review-r18/audit-ui.md`, `docs/review-r19/audit-world.md`, PLAN R17–R26) so as not to re-report them. Where an earlier finding is still open, it says so.

**Severity:** P0 blocks play · P1 hurts most players · P2 noticeable · P3 polish. **Effort:** S ≤ ½ day · M ≤ 2 days · L > 2 days.

---

## 1. Inventory: what the world is made of

### 1.1 Per planet (surface)

| Planet | Ground layers (512² WebP) | Obstacles (GLB, 3 variants each) + landmark | Trees | Cover / scatter / decals | Weather particles | Enemies (procedural recipe) |
|---|---|---|---|---|---|---|
| Cinder-4 | sand (stripe recipe), cracked_earth (Voronoi) | desert rock, ruin + `landmark_desert` | — | dry grass 20/1000 m² · bones+pebbles · crater, scorch | sand streaks, heat dots | skitter=`bug`, wurmling, raider=`character.glb` (SPEC-064), Dune Wurm=`worm_boss` |
| Vetra | snow, ice (Voronoi) | ice rock, spire + landmark | — | frost fern 12/1000 m² · crystals · frost, cracks | snow flakes | mite=`bug`, crawler, spitter, Frost Matriarch=`queen` |
| Thessaly | moss*, jungle_floor* | jungle **tree** (3), ruin + landmark | 14 groves, ~161 trees, LOD0 215–557 tris | undergrowth + cover · tufts+spores | spores | drone=`bug`, hound, spitter, Broodlord=`queen` |
| Ferrum | basalt (Voronoi), lava_rock (Voronoi) + emissive cracks `#ff6a2a`×3 | volcanic rock, vent + landmark | — | 10/1000 m² · slag · scorch, cracks | ash, heat | ash crawler=`crawler`, magma wraith=`wraith`, slag spitter, Ash Titan=`titan` |
| The Hive | chitin*, flesh (Voronoi) + cracks `#c04ad0`×2.5 | hive spire, rock + landmark | — | 40/1000 m² · spores+crystals · slick | — | warrior=`hound`, spitter, egg, Queen=`queen` |
| Eden | grass*, soil (flat) | temperate **tree** (2 + orchard tree), rock + landmark | 4 orchards × 35 | undergrowth + mown cover · tufts+pebbles · crater | — | mixed, higher elite chance |

\* = re-authored by SPEC-052 (stand-in build, see V-07).

**Shared and procedural on every planet:**
- The landing pad (procedural, with the tug `ship.glb` parked on it).
- All mission POIs: scan mast, reach pylon, defend pylon, escort cradle and arena are procedural; the deliver point is `crate.glb` (V-05).
- Caves and wrecks (`SHELTER_MODELS = {}`).
- The arena wall.
- Every enemy except the raiders: 10 procedural recipes for 19 surface enemies (V-06).

**Underground (SPEC-054):** the cave kit (17 GLBs, stand-in build), the flashlight, and dust motes.

### 1.2 Flight, hubs and UI art

- **Flight** is still the quality bar: Blender-baked ships (`fighter`, `interceptor`, `cockpit`, `asteroid`), six sky windows and six 2048² planet maps. The maps look good (contact sheet: Cinder ochre, Vetra ice, Thessaly green continents, Ferrum ash with red, Hive purple cells, Eden Earth-like).
- **Hubs:** `station_ring.glb`, `dock.glb` and the `sky_station` window. The star map still draws procedural `planetDisc` textures (`StarmapScene.ts:41,167`; V-16).
- **Films:** 10 films with 41 shots and posters (9.20 MB). Two looks share them:
  - photographic plates for people: the curfew, sabotage, reprisal, shelter, Selection board, tap and greenhouse shots, plus the SPEC-062 faces;
  - Blender geometry for the rest. Four posters read as untextured blockouts: `interlude_c1_capsule` (an orange capsule on a flat grey gradient), `interlude_c2_tanks` (a tub of white low-poly blobs), `interlude_c4_reactor` (a striped cylinder and a fan) and `ending_escape_point` (grey boxes on black). R21 parked the capsule, tank, reactor and fleet retakes under "Not now"; the `point` poster is new here (V-13).
- **Portraits:** 12 × 256² EEVEE busts from 2026-09-11 (V-12).
- **Item pictures:** 33 × 384². All are present; `tests/ui/icons.test.ts` has an empty `PENDING_PICTURES` (V-11).
- **Icons:** the resource glyphs are still colour emoji (`ui/glyphs.ts`: 🛢 🌾 💧 ⚡) and the star-map lock is 🔒 (`StarmapScene.ts:403`). The first review's §6.6 flagged both, and both are unchanged.

### 1.3 Where the art is thin, reused or still a stand-in (summary)
- Every mission objective and every shelter is a SPEC-018 primitive in the same grey on all six planets (V-05).
- Three of five bosses share one body (V-06).
- 77 committed files are the factory's stand-in build, not the Blender run SPEC-052 asked for (V-07). That covers every tree, every `_c` piece, every landmark, the whole cave kit, the foliage atlas, 4 ground layers plus `detail_nr`, and 7 item pictures.
- Five ground layers still use the Voronoi "crazy paving", including both of Ferrum's (V-10).
- All combat VFX draw one 32-px dot. Eight committed 256² sprites are never loaded (V-08).
- The four rifle tiers and the four armour tiers share one picture each, apart from a 1–2 px colour chip (V-11).

---

## 2. Findings: visuals and UI

### V-01 · P2 · Composition: the first frame of every landing is empty on five of six planets
- **Evidence:**
  - SPEC-053's own measurements, 30 frames after landing on `medium` (`docs/playtest-log.md:2366-2373`): static instances on screen at spawn are **2** (Cinder-4), **1** (Vetra), **3** (Ferrum), **4** (Hive) and **5** (Eden), against 22 on Thessaly.
  - The cause is `Layout.ts:123` `PAD_CLEARING = 15` plus `:125` `CORRIDOR = 8`. On the 22 m desktop camera the spawn frame (about 38 × 21 m) sits almost entirely inside the 15 m clearing.
  - The committed promo frames show it:
    - `wide-1.jpg`: an orange stripe-textured sand plain, a few bone specks, the pad and the player;
    - `narrow-1.jpg`: a white Vetra field with nothing on it;
    - `wide-2.jpg` ("The ruins of Thessaly", `vite.config.ts:93`): a fern carpet with no ruin in frame.
- **Why it matters:** the landing is the moment the game sells each new world, and it is also what the install sheet shows. R20's "the world is empty" was fixed between objectives, not where the player arrives.
- **Budget room:** the spawn frame uses 35–51 of 96 draws and 19.6–29.2 k of 130 k triangles (same table).
- **Fix:** a view-only "landing site" ring 6–15 m from the pad.
  - Non-collidable dressing, seeded from `layout.hash`: supply crates (`crate.glb`), the planet's `_c` dressing at 0.3–0.5 scale, cable runs, footprint and tread decals, a pad light mast.
  - It never enters `Layout`, so no layout pin moves.
  - Then re-shoot the promo frames at a grove, a landmark or a fight.
- **Effort:** S–M.

### V-02 · P2 · Readability: attack telegraphs vanish on Ferrum, and in the colour-blind preset on the Hive
- **Evidence:**
  - Telegraphs take `HOSTILE_RIM_UNIFORM` (`TelegraphView.ts:14-16`): `#ff5a3c` by default and `#ff4fd8` in the colour-blind preset (`ProceduralMeshes.ts:77,83`). The fill is drawn at alpha 0.35 and the outline at 0.6 (`TelegraphView.ts:29-31`).
  - Ferrum's ground glows `#ff6a2a` at ×3 emissive (`planets.ts:394`). Against the telegraph that is **ΔE 13, contrast 1.08**, close to the same colour, and the cracks are brighter than the fill.
  - The Hive's cracks are `#c04ad0` at ×2.5 (`planets.ts:456`), and so is the Queen's emissive (`enemies.ts:561`). Against the colour-blind telegraph that is **ΔE 22, contrast 1.43**.
  - On Ferrum the magma wraith's body is `#d0522a` (`enemies.ts:441`), ΔE 16.5 from the rim, so its rim adds nothing.
- **Scenario:** the Ash Titan's `fissure` and `eruption` lines (SPEC-041) are drawn across a lava field. The player reads the lava cracks and the telegraph as one red-orange pattern, and steps into the line.
  - The colour data is **CONFIRMED**. How it looks on a GPU is **PLAUSIBLE**: no live frame was taken.
- **Fix:** give the telegraph outline the waypoint's treatment (`style.css` `.waypoint-mark`: a 2 px dark stroke and a 1 px pale inner rim). In the shader, add a dark band outside the outline and a white inner edge, so it reads on any ground. Alternatively, add a per-planet override of the telegraph colour (a hot white-yellow on Ferrum, cyan on the Hive in the colour-blind preset).
- **Effort:** S.

### V-03 · P3 · Readability: player shots wear the hostile hue, and raiders shoot the starter pistol's colour
- **Evidence:**
  - Five player shot looks sit within ΔE 13 of the hostile `#ff5a3c`:
    - `weapon_laser` `#ff4a4a` (`items.ts:253`);
    - `mg_scrap` `#ff6a3a` (`:345`);
    - `launcher_grenade` `#ff4040` (`:423`);
    - `relic_slag_vent` `#ff5a1f` (`:643`);
    - `relic_seeker`'s trail is `#ff4fd8` (`:666`), **identical** to `HOSTILE_RIM_COLOUR_BLIND`.
  - The raider tracer `#ffc27a` (`ScavRaiders.ts:51`) is ΔE 20 from the starter pistol's `#ffe9a0` (`items.ts:213`), and both use the `tracer` shape (`SurfaceView.ts:396-399`).
- **Why it matters:** R17 and R18 made red-orange mean "hostile", and the player's own fire dilutes it. On Cinder-4, the first fights with people, "mine or theirs?" is a pale-amber streak either way.
- **Fix:** reserve the hostile hue band (and the colour-blind magenta) for enemies. Give player shots white-hot heads with coloured trails, and draw raider tracers in the hostile colour. Add a content test that no `ShotLook` sits within ΔE 25 of either hostile colour.
- **Effort:** S.

### V-04 · P2 · HUD: the waypoint is drawn on the quick bar and the thumb arc
- **Evidence:**
  - The off-screen arrow rides an ellipse inset 56 px from the viewport edge (`Surface.ts:494, 6992-6999`) and knows nothing of the HUD.
  - On the keyboard scheme the quick bar spans from `bottom: 48px` up 64 px slots (`style.css:1301-1305, 1527-1528`), so it covers y = H−112 … H−48. The 22 px arrow at due south is centred on y = H−56, inside the bar.
  - On a touch phone at 844 × 390, a target to the south-east lands the arrow at about (681, 293), inside the thumb arc.
  - The on-screen diamond can also sit under any HUD box.
  - Seen in the committed frames:
    - `wide-1.jpg` and `wide-2.jpg`: "12 m" and the arrow over the **V Dash** slot;
    - `narrow-1.jpg`: the label sits beside the arc;
    - `docs/screenshots/spec-030/cave-interior.png`: "60 m" over the quick-bar slots.
- **Why it matters:** the arrow and its distance are the main navigation aid, and they collide with the most-read HUD element whenever the objective lies behind the player (typically right after landing).
- **Fix:** read the quick-bar and arc rectangles once on `resize`. Clamp the ellipse to per-side insets (bottom = bar top + 12 px; on touch, keep it out of the arc's corner), or flip the label to the inside of the arrow when it would overlap.
- **Effort:** S.

### V-05 · P2 · Art: every objective and every shelter is still a grey primitive
- **Evidence:**
  - All 32 POI rows in `data/planets.ts` say `model: 'procedural'`.
  - `poiGeometry` (`SurfaceProps.ts:645-709`) builds them from primitives:
    - scan is a 6-sided cylinder with an 8 × 6 sphere dish, `#8a96a8`;
    - reach is a 5-sided cone and a torus;
    - defend is a cylinder base, a mast and a dome;
    - escort is a cylinder and three boxes;
    - deliver is `crate.glb`.
  - `SHELTER_MODELS = {}` (`:717`) keeps every cave and wreck procedural.
  - The same grey mast stands for "Dune Sea", "Silo Ruin" and every other scan site on all six planets.
- **Why it matters:** every mission ends at one of these. They are the least authored objects in a world whose rocks and trees were re-authored twice.
- **Fix:** a POI kit beside the cave kit (`cave.py` already makes terminals, beacons and a shaft):
  - a survey mast and a relay dish;
  - a defend pylon;
  - an escort cradle;
  - a delivery beacon;
  - per-biome trim through vertex colours;
  - then authored cave mouths and wreck hulls through `SHELTER_MODELS`, the seam SPEC-030 left for this.
- **Effort:** M (kit) + L (shelters).

### V-06 · P2 · Art: three of five bosses are the same mesh, and bosses are camouflaged
- **Evidence:**
  - The Frost Matriarch, the Hive Broodlord and the Hive Queen all use `recipe: 'queen'` (`enemies.ts:312, 394, 561`): one ellipsoid, six legs and a five-spike crown (`ProceduralMeshes.ts:478-496`). Only tint and scale (2.4 / 2.6 / 3.0) differ.
  - The Ash Titan is three stacked boxes (`:460-476`).
  - Bosses are excluded from SPEC-035's 3:1 tint invariant. Their contrast against their ground:

    | Boss | Contrast |
    |---|---|
    | Frost Matriarch | **1.36** |
    | Ash Titan | **1.28** (ΔE 7.7 against basalt) |
    | Dune Wurm | 1.74 |
    | Hive Queen | 1.81 |
    | Hive Broodlord | 1.93 |

- **Why it matters:** each boss is a chapter's climax, with a reveal card (SPEC-023) and its own move list (SPEC-041). Players meet the same body in chapters 2, 3 and 5.
  - Shared silhouettes for trash (spitter ×4, bug ×3, hound ×2, crawler ×2) are a defensible readability rule: same shape, same behaviour. Bosses are where the rule should break.
- **Fix:** per-boss part variants inside the recipe system, which needs no asset file:
  - the Matriarch with an ice-shard crown and long forelimbs;
  - the Broodlord with a spore-sac abdomen and vents;
  - the Queen with a crest and wings.
  - Also lift the boss tints by value to at least 2.5:1.
- **Effort:** M.

### V-07 · P2 · Pipeline: the R20 world art drop is the factory's stand-in, and the Blender run is still owed
- **Evidence:**
  - `public/assets/LICENSES.md` has 77 rows "by the stand-in build without Blender": every tree, every `_c` piece, all 6 landmarks, all 17 cave-kit pieces, `foliage/atlas.webp`, `chitin`/`grass`/`jungle_floor`/`moss` and `detail_nr`, and 7 item pictures.
  - `docs/playtest-log.md:1995-2000` says the Blender run "is still owed". The checklist at `:2055-2060` is unticked.
  - No Blender contact sheet of the trees, landmarks or kit exists; the stand-in's previews were not kept.
  - The note itself says a Blender rebuild moves vertices (`scripts/assets/README.md` §7, 52-g).
  - PLAN R20 decision 3 specified "hand-run Blender".
- **Why it matters:** the trees and landmarks are R20's answer to "the world looks low-resolution". No person has reviewed them as art, and when the real run happens the bytes change, against 1.6 MB of precache headroom (V-19).
- **Fix:** run `node scripts/assets/blender/build.mjs props foliage ground cave items --preview=<dir>` on the Mac (Blender 5.2.1 rendered SPEC-062 there), commit it, and record the sheets and the `check.mjs` table.
- **Effort:** S (a hand run) plus review time.

### V-08 · P3 · VFX: every burst is one 32-px dot, enemy hits make no spark, and eight sprites ship unused
- **Evidence:**
  - `CombatFx.ts:182` draws `map: particleSprite('dot')`, a 32 × 32 procedural falloff (`ProceduralTextures.ts:504-520`), for all eight kinds: hit, death, spawn, pickup, dust ring, muzzle, blast and dash. A grenade blast is 30 soft dots.
  - `textures/sprites/{smoke,dirt,magic,muzzle,ring,spark,streak,flake}.webp` are 256² sprites from `sprites.py` (about 70 KB, precached, with LICENSES rows 279-288). Nothing references them; only `ember` and `flare` are in `FLIGHT_ASSETS`.
  - The `hit` burst fires only on `player:damaged` (`Surface.ts:7714`). `enemy:hit` is consumed by audio alone (`AudioReactions.ts:322`). Enemies flash white, but nothing sparks where the shot lands.
- **Fix:**
  - Put the committed sprites in a 2 × 4 atlas on the same instanced mesh, still one draw (smoke and spark for blast and death, `muzzle` for muzzle, `ring`/`dirt` for the dust ring).
  - Burst `hit` on `enemy:hit` in the shot's colour, throttled like the audio (50 ms).
  - Or delete the unused files.
- **Effort:** S–M.

### V-09 · P3 · Readability: resource nodes and pickups disappear on the planets that hold them
- **Evidence:**
  - `RESOURCE_COLORS` (`SurfaceView.ts:493-498`) against the ground they sit on:

    | Resource | Planet | Contrast | ΔE |
    |---|---|---|---|
    | oil `#3a3a3a` | Ferrum basalt | **1.14** | 7.6 |
    | wheat | Cinder-4 sand | 1.48 | — |
    | water | Vetra snow | 1.79 | — |

  - Node crystals carry a near-black `0x222233` emissive at 0.4 (`:1371-1380`).
  - Dropped orbs are 0.28 m metallic octahedra with no emissive (`:1387-1391`).
  - Item and gear pickups are the same `#8ad7ff` (`:3334`).
- **Fix:** emissive at the resource colour × 0.5 with a bright rim (oil as a dark crystal with an iridescent edge), and a gold gear pickup distinct from items.
- **Effort:** S.

### V-10 · P3 · Ground: five layers are still Voronoi paving, and sand is stripes
- **Evidence:**
  - The albedo sheet shows `basalt` and `lava_rock` (both of Ferrum's layers), `cracked_earth` (Cinder-4), `ice` (Vetra) and `flesh` (the Hive) as one Voronoi cell pattern with grey interiors.
  - `sand` is horizontal sine stripes. In `wide-1.jpg` it reads as a regular diagonal ripple grid across the whole frame, even with the anti-tile sample (`TerrainMesh.ts:42-44, 248-250`).
  - `soil` is almost flat brown.
  - R20 re-authored only four layers.
- **Fix:** add these five to the Blender run in V-07: lava flow channels instead of cells, cracked mud with varied cell scale, sand with dune noise and wind streaks.
- **Effort:** M.

### V-11 · P3 · Item pictures do not separate tiers at the sizes the UI uses
- **Evidence:** the quick bar draws 40 px (keyboard) or 48 px (touch) (`QuickBar.ts:164`), and shop rows draw 40 px (`ShopPanel.ts:252,339`). At 40 px:
  - the four rifles (`weapon_kinetic`, `_laser`, `_plasma`, `_lithium`) are the same thin dark line, told apart by a 1–2 px colour chip;
  - the four armours are one navy vest;
  - both pistols read as rifles;
  - medkit and wheat ration are one jar with a green or orange label;
  - the flare reads as a red pencil;
  - dark-navy guns on the dark panel lose their silhouette.
- **Why it matters:** the slot name rescues the quick bar. The shop and compare views are where tiers must read as upgrades.
- **Fix:** in `items.py`, give each tier its own silhouette (stock, barrel, scope, drum, plates), add a pale rim light or outline pass, and use a shorter pistol frame.
- **Effort:** M.

### V-12 · P3 · Portraits are the oldest art in the game and sit beside photographs
- **Evidence:**
  - `portraits/*.webp` was last touched in `91dd9ac` (2026-09-11).
  - `portraits.py:22-35` makes three helmet types in 12 colours. The "goggles" render as sunglasses floating on a helmet, and the visors are flat colour blobs.
  - The first review (§6.6) flagged this; R17 did not adopt it.
  - The same bust appears among the photographic faces on the Selection board (posters `interlude_c5_board`, `ending_stay_wall_63`, `ending_escape_wall_same`) and on the No. 63 card (`EndingOverlay.ts:142-146`).
- **Why it matters:** this is either the story's point (the instance is not like the humans) or a style clash at the emotional peak. PLAN does not say which.
- **Fix:** decide it in PLAN. If it is not intended, re-render the busts through the SPEC-062 plate look.
- **Effort:** M.

### V-13 · P3 · Films: the escape ending's last poster is a grey blockout
- **Evidence:**
  - `films.ts:312`: `point` (29–36 s), poster at 30 s. The poster image is untextured grey boxes and a sphere on black.
  - R18 decision 10 makes reduce motion play films as posters, so for those players this is the game's last image.
- **Fix:** move the poster to the frame where everything has folded into the point of light (about 34 s) and re-export it.
- **Effort:** S.

### V-14 · P3 · PLAUSIBLE · Flight: the contact card has no backing plate
- **Evidence:** `.contact-card` (`style.css:4817-4860`) is fixed at top 18 %, centred, with `--text-glow` only. The kicker uses `--ink-dim` small caps. It shows during the first scav and interceptor waves, over the bright sky window and the planet limb.
- **Fix:** use the HUD plate and halo the elite plates use (`style.css:2284-2315`).
- **Effort:** S.

### V-15 · P3 · PLAUSIBLE · Rendering: fading one occluder makes every prop transparent
- **Evidence:** `SurfaceView.ts:3132-3141`. When any occluder fades, both shared body materials switch to `transparent = true` and `depthWrite = false` for every instance of every prop mesh.
  - Instanced transparent geometry is not sorted per instance.
  - So while the player stands behind any rock, overlapping cluster pieces (SPEC-053 clusters, 3–7 pieces within 10 m) and non-convex ruins can draw in the wrong order.
- **Fix:** the ordered dither `Foliage.ts` already uses (opaque, depth-writing), or move the faded instance to its own draw.
- **Effort:** S–M. Confirm on a GPU first.

### V-16 · P3 · Still open from the first review (§6.5, §6.6)
- The star map draws procedural `planetDisc`s (`StarmapScene.ts:41,167`), murky smudges with a central highlight (`docs/screenshots/spec-031/desktop-starmap.png`), while 2048² planet maps ship.
  - Fix: a 256 px copy per planet from `flight.py` (about 6 × 15 KB).
- The resource glyphs are colour emoji, which render differently on every OS (`ui/glyphs.ts`).
  - Fix: render four icons with `items.py`.
- **Effort:** S each.

### V-17 · P3 · PLAUSIBLE · Flight: the lens flare
- The first review reported a WebGL error every frame on `high`, at the Lensflare. The code is unchanged (`FlightView.ts:585-600`), and nothing in the history addresses it.
  - `high` uses MSAA when DPR ≤ 1.5. Three's `Lensflare` copies the framebuffer, which fails on multisampled targets.
- **Fix:** gate it on `post === 'full' && !msaa`, or replace it with an additive sprite.
- **Effort:** S.

---

## 3. Budgets and performance risk

| Folder | Size | Budget |
|---|---|---|
| models | 2.94 MB | 4.00 (R20 ceiling 3.50) |
| textures | 4.46 MB | 6.00 (R20 ceiling 4.90) |
| films | 9.20 MB | 12.00 |
| audio | 4.60 MB | 12.00 |
| items | 0.32 MB | 1.00 |
| portraits | 0.07 MB | 0.50 |
| **precache (`dist/`, 6 Oct)** | **23.38 MB** | **25.00** |

- **Draws and triangles** (pins: 96 draws, 130 k triangles on `medium`; 60 k at spawn after SPEC-046): the measured frames use 35–51 draws and 19.6–35.5 k triangles (`playtest-log.md:2366-2373`). There is room for V-01, V-05 and V-08 without moving a pin. SPEC-064 raiders: at most 54 draws and 65.6 k triangles with the full pool (`:2481`). No pin exists for `high`.

### V-18 · P3 · Perf: precache headroom is 1.6 MB, and the boot set carries dead weight
- **Evidence:**
  - At 93.5 % of the 25 MB cap, any of these would breach it:
    - the owed Blender rerun (V-07);
    - one more film;
    - SPEC-060 or SPEC-061 extras.
  - `dist/` is stale (built before #101–#103), so the figure is not today's.
  - Boot loads `grid.png` and `noise.png` (`data/assets.ts`, the SPEC-002 spike). No `assets.texture('grid'|'noise')` call exists in `src/`.
  - Boot also loads `ship.glb` (479 KB) and `character.glb` (288 KB) before the menu.
  - The eight unused sprites (V-08) are precached.
  - The game code is one 966 KB chunk (311 KB gzipped) beside `three` at 708 KB. Nothing is split: films, puzzles, the ending and the share card all load at boot.
- **Fix:**
  - Drop the dead files.
  - Rebuild `dist/` before quoting the precache.
  - Add a CI line that fails above 24 MB, so the margin is visible.
  - Consider dynamic `import()` for `FilmPlayer`, `PuzzlePanel`, `EndingOverlay` and `ShareCard`.
- **Effort:** S (files) + M (split).

---

## 4. Polish ideas (cheap, visible)

- **Calm-weather motes.** `StormParticles` runs only in storms; caves get `dust` (`StormParticles.ts:7-9, 37`). A low-intensity calm layer per planet would make a static frame breathe at no draw cost (the mesh exists): drifting sand on Cinder-4, light flakes on Vetra, spores on Thessaly and the Hive, embers on Ferrum. **S.**
- **Cloud shadows.** A slow scrolling multiply on the terrain shader, reusing the macro noise it already samples (`TerrainMesh.ts:248-253`). It breaks the uniform sun on Cinder-4 and Vetra, where the frame is one value. **S.**
- **Hit sparks** on `enemy:hit` (V-08). **S.**
- **Telegraph outline treatment** (V-02). **S.**
- **Landing-site dressing** (V-01). **S–M.**

---

## 5. Docs and process hygiene

### D-01 · P2 · PLAN on `main` is missing four refinement entries that the built code and specs cite
- **Evidence:**
  - `docs/plan-r14` (2026-09-16, "polish pass — SPEC-031, SPEC-032, milestone M7d") and `docs/plan-r15` (2026-09-20, Vercel, SPEC-033) are 276 commits behind `main` and unmerged.
  - `docs/plan-r22` (Android, SPEC-060, M7k) and `docs/plan-r23` (demo, SPEC-061, M7l) are 142 behind and unmerged.
- **Consequences on `main`:**
  - The log jumps R13 → R16 and R21 → R24.
  - §10 has no M7d, M7k or M7l, yet `PLAN.md:191` says M7e "follows M7d".
  - §13 skips E46–E53 and E98–E108.
  - SPEC-031 and SPEC-032 are built with no PLAN entry.
  - `specs/060-android-app.md` sits on specs `main` citing "PLAN R22 decision 1/4", against CLAUDE.md's "a refinement entry *before* the spec".
- **Fix:** rebase and merge R14 (it documents shipped work) and R15. For R22 and R23, either merge them as accepted-but-unbuilt, or close them and say so in SPEC-000.
- **Effort:** S.

### D-02 · P3 · Spec statuses (said once)
- 37 built specs still read `status: draft` on specs `origin/main`: 015, 016, 022–032, 040–059, 062–065. The SPEC-000 table mirrors them.
- The status PR `docs/spec-062-done` (marks 051 and 062 done) has been unmerged since 2026-10-05.
- SPEC-061 exists only on branch `spec/SPEC-061`.
- **Effort:** S.

### D-03 · P3 · No milestone tags
- `git tag -l` is empty locally and on `origin`, though M0 through M7n are built.
- CLAUDE.md's definition of done ends each milestone with `mN`. The tags are blocked on D-04.

### D-04 · P2 · Hardware verification debt
- `docs/playtest-log.md` has **112** open `- [ ]` checks across 29 sections. The largest are:
  - SPEC-042 and SPEC-045: 8 each;
  - SPEC-044, SPEC-046 and SPEC-051: 7 each;
  - SPEC-048, SPEC-050 and SPEC-064: 6 each.
- Built specs with **no mention at all** in the log: 047, 049, 054, 055, 056, 058, 059, 063, 065. SPEC-037 and SPEC-040 have no section of their own.
- Also owed:
  - SPEC-052's Blender run (V-07);
  - SPEC-062's watch-through.
- None of the SPEC-046 or SPEC-053 world captures was committed. `docs/screenshots/` was last updated 2026-09-16 and shows no R20 world; the spec-018 and spec-019 frames still carry the debug overlay.
- **Effort:** M (one device session per milestone).

### D-05 · P3 · `docs/BUGS.md` is stale
- Its header still reads "Clean Bill of Health", dated 2026-09-11 with 703 tests.
- §7 (the service long press lost on short landscape phones) is still **OPEN**: the rule is unchanged at `style.css:5661-5665`.
- The last week's fixes have no entries: mender stacking, the cargo-full beep (#97), tap-move and the mobile star map, the descent shaft mouth (#102) and the wreck gap (#103).
- **Fix:** close the header, add a dated index, and move §7 into a PLAN decision.
- **Effort:** S.

### D-06 · P3 · Dead branches and worktrees (listed only; nothing removed)
- **Game repo:**
  - 85 refs, local and remote, are merged into `origin/main` and can be deleted.
  - About 50 unmerged factory lanes, superseded by squash merges: `origin/spec/SPEC-003…065` and `origin/spec/MAIN-*` from 09-08 to 09-26, and `origin/factory/revert-694d0ee`.
  - Unmerged CI experiments: `origin/ci/e2e-budget-13`, `ci/time-balanced-shards`, `ci/proved-main-e2e` and `ci/refresh-e2e-timings`.
  - Extra worktrees, all on merged branches:
    - `../reallm-game-cargo-beep` (`fix/cargo-full-once`);
    - `../reallm-game-descent-mouth`;
    - `../reallm-game-plan-r26`;
    - `../reallm-game-wreck-gap`;
    - `.claude/worktrees/nifty-satoshi-017075` (`claude/objective-hertz-a81ce5`).
- **Specs repo:**
  - The main checkout sits on the merged `spec/cargo-full-once`, not `main`.
  - Worktrees on merged branches: `../reallm-specs-wreck-gap`, a `specs-047-suite` worktree in the system temp folder, and a dark-factory scratchpad `specs-062`.

### D-07 · P3 · Small hygiene items
- `node scripts/assets/check.mjs` exits 1 locally on three git-ignored `.DS_Store` files (`walk()` does not skip dotfiles, `check.mjs:66-70`). The first review noted this, and it is unchanged.
- `package.json:4` is still `0.0.0`. The footer reads "ReaLLM 0.0.0" (`main.ts:43`), and every save is stamped with `APP_VERSION` `0.0.0` (`Save.ts:809`), so the E9 "older build" message cannot name a real version.
- The promo label "The ruins of Thessaly" (`vite.config.ts:93`) describes a frame with no ruins in it.
- **Effort:** S.

---

## 6. What landed from the earlier reviews (spot checks)

| Decision | Status in code |
|---|---|
| R17-9: chapter 1–2 non-boss tints reach 3:1 | Holds: skitter 3.51, wurmling 3.72, mite 4.85, crawler 4.72, spitter 3.65. Bosses were exempt (V-06) |
| R17-9: Hive sun 2.0 and ambient 0.55 | Landed (`planets.ts:451,454`) |
| R18-2: HUD text at least 11 px | Landed: no `font-size` under 11 px in `style.css`, and HUD plates exist (`.hud-tl` background) |
| R18-5: no backdrop blur in play | Landed (`style.css:910-917`) |
| R20-1: props draw authored colours, all variants, culled | Landed (`SurfaceProps.ts:41-62`, white `#glbMaterial` at `SurfaceView.ts:1248-1253`) |
| R20-3: SPEC-052 "hand-run Blender" | **Not as written.** It is a stand-in build (V-07) |
| R20-3: four ground layers re-authored | Landed (moss, jungle_floor, chitin, grass); five Voronoi layers remain (V-10) |
| First review §6.5 and §6.6: star map discs, emoji icons, portraits, `.DS_Store` check | Not adopted, and still open (V-16, V-12, D-07) |

---

## 7. Easy wins (high value, effort S)

1. **V-04:** keep the waypoint out of the quick bar and the thumb arc (per-side insets read on resize).
2. **V-02:** give telegraphs a dark-and-pale double outline, plus per-planet colour overrides for Ferrum and for the Hive in the colour-blind preset.
3. **V-03:** reserve the hostile hue band (and the colour-blind magenta); move five player shot colours; draw raider tracers in the hostile colour; add a ΔE content test.
4. **V-08 (part):** a `hit` spark on `enemy:hit`, throttled.
5. **V-09:** emissive resource nodes and orbs, and a gold gear pickup.
6. **Calm-weather motes and cloud shadows** (§4).
7. **V-13:** move the escape-ending poster to 34 s.
8. **V-07:** run the owed Blender build on the Mac and commit the contact sheets.
9. **D-01:** merge PLAN R14 and R15, and decide R22 and R23.
10. **D-07:** make `check.mjs` skip dotfiles; bump the version.

## 8. Ranked top 5

1. **V-01:** an empty landing frame on five of six planets, which is also what the install sheet shows. Fix it with a view-only landing-site dressing ring; the budget has 2× headroom.
2. **V-02 + V-03:** danger is not readable where the ground or the player's own fire shares the hostile colour (Ferrum, the Hive in colour-blind mode, red player shots, raider and pistol tracers). All of it is S effort.
3. **V-04:** the waypoint sits on the quick bar and the thumb arc whenever the objective is behind the player. S effort, seen in every session.
4. **V-05 + V-06 + V-07:** the art debt where players spend their time and meet their climaxes. Grey primitive objectives and shelters, three bosses on one body, and a world art drop that no one has rendered in Blender or reviewed as art.
5. **D-01 + D-04:** PLAN on `main` lacks R14, R15, R22 and R23 while code and specs cite them. 112 hardware checks and nine specs' playtest entries are owed, and no milestone tag exists.
