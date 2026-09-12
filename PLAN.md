# PLAN — "ReaLLM"

Space post-apocalyptic ARPG browser game with a hidden simulation plot. Single-player, fully offline, playable on desktop and mobile. Former working title: Starfall Salvage.

> Status: plan locked. This document is the source of truth for implementation.
> Detailed, implementable specs live in the separate repository [mdzunic/reallm-specs](https://github.com/mdzunic/reallm-specs) under `specs/` (cloned next to this one as `../reallm-specs`); each is a factory work order with `id: SPEC-NNN` in its frontmatter. Where PLAN and a spec disagree, PLAN wins; open a refinement entry below and fix the spec.

### Refinement log

**R1 — 2026-09-06 (edge cases, best practices, spec kickoff).** Scope, story, planets, missions, and the stack stay locked. Changes:

1. Mission schema fixed: objectives are grouped into sequential **stages** (any order inside a stage); added `escort`, `defend`, `choice` kinds, a `count` on `scan`, and a `scene` field so the two flight missions (`c4_s2`, `c5_m1`) are representable. Eggs are a stationary enemy, so "destroy" reuses `kill`. (§6)
2. Token math corrected: main **670** + side **104** (not 630 + 150), level tokens 400–475. Total sink is now defined (**2,010**) so specialization is real. (§7)
3. Anti-softlock rules added: fuel floor at the station, refuel voucher per chapter, replayable completed missions at 50 % reward, cargo cap ≥ largest collect objective. (§13)
4. Death/respawn rules, difficulty (casual/normal), 3 save slots, save export/import, and Safari's 7-day storage eviction are now designed for, not discovered later. (§4, §8, §13)
5. Versions pinned against the current ecosystem: Vite 8 (Rolldown), TypeScript 6.0 (7.0 is an opt-in later), Vitest 5, three r185, Howler 2.2.4. `Clock` is deprecated in r182 → use `Timer`. (§2)
6. One proposed exception to "nothing else": `vite-plugin-pwa` as a **build-time** dev dependency in M7 — without a service worker "fully offline" is not actually true, and a Home Screen install is what exempts the save from Safari's 7-day eviction. No runtime framework is added. (§2, §9)
7. Return trips from a planet to the station are instant autopilot; only outbound flights play the flight scene and consume fuel. Flight is a rail model (fixed forward motion, lateral steering). (§4, §13)
8. Enemies (bugs, wraiths, crawlers) are procedural low-poly meshes; no CC0 bug pack exists. Kenney supplies humans and ships only. (§2)
9. Attributes are allocated at character creation only; levels grant flat HP/damage. Per-level stat points are deferred. (§4)

**R2 — 2026-09-06 (rename + simulation plot).** The game is now **ReaLLM** (was Starfall Salvage). Planets, missions, mechanics, and economy are unchanged; a meta layer is added on top of the surface story: the salvager gradually realizes he may be a model instance inside a machine, the **Warden** (an AGI) runs containment that tightens every chapter, and the ending becomes **stay vs. escape**. Changes: §1 vision; §4 narrative layer; §5 story arc, awakening ladder, cast, deferred iterations; §6 beats and flags (`terraform_secret` → `scaffold_secret`, `ending_honest`/`ending_free` → `ending_stay`/`ending_escape`, new `iteration_log` and `signal_decoded`); §8 `meta.iteration`; §12 risk. Specs: package/storage/export/manifest names, speaker `queen` → `warden`, new dialogue ids, save field, campaign-sim ending names.

**R3 — 2026-09-06 (factory spec format + Playwright).** Specs are now build-factory work orders: `specs/NNN-slug.md` in mdzunic/reallm-specs with frontmatter `id: SPEC-NNN` matching the GitHub Issue title, then `## Why`, `## Acceptance criteria` (checkboxes), `## Out of scope`, and the detailed design under `## Reference`. Numbering shifted by one (SPEC-000 is the roadmap; old spec NN is SPEC-(NN+1)) and every cross-reference in this file now uses SPEC ids. `@playwright/test` joins the dev toolchain because the factory's QA gate runs an e2e suite; it is test tooling, not a runtime dependency. (§2, §11, §13, §14)

**R4 — 2026-09-06 (dependency audit).** Every spec's `depends_on` now lists what its interfaces and acceptance criteria actually consume (event bus for the renderer, settings store for input and audio, `computePlayerStats` for the creation preview, the HUD classes for both scenes), and SPEC-000 orders the queue topologically: 001, 004, 002, 008, 009, 007, 006, 005, 003, 010, 011, 014, 012, 013, 015, 016. PLAN milestones stay the playable checkpoints of §10; because whole specs build at once, the station/menu spec (SPEC-014, checkpoint M2) builds after economy (SPEC-010) and combat (SPEC-011). (§10, §14)

**R5 — 2026-09-07 (mission count corrected in §7).** §7's summary row read "Main missions (18)". §6 enumerates **17** main missions — three per chapter for chapters 1–5, two for chapter 6 — and the same row's own subtotals (55 · 70 · 85 · 105 · 165 · 190) add to 670 across exactly those 17. The enumeration and the subtotals are the design; the header digit was the typo, and it now reads "(17)". No mission is added, removed, or retuned: the campaign is **17 main + 9 side = 26** missions and the 670 / 104 totals are unchanged. Specs: SPEC-009's acceptance criterion "all 27 missions" becomes **26** — `tests/data/content.test.ts` pins 17 / 9 beside the 670 / 104 totals, so the roster and its payout can only move together. (§7)

**R6 — 2026-09-09 (art direction upgrade).** The bootstrap look — flat Lambert primitives, two lights, no tone mapping, no shadows, no post-processing, one 64² placeholder texture — is replaced by a modern **stylised-PBR** look ("Diablo in space", within a phone budget and CC0 assets), delivered as an art pass of four specs — SPEC-017 (render pipeline and lighting), SPEC-018 (surface environment), SPEC-019 (characters, enemies, combat VFX), SPEC-020 (flight, station, menus, UI theme) — that build after SPEC-013 and **before SPEC-015/016**, so the performance budgets and the boot benchmark are measured on the final visuals. The pass is milestone **M7a** and ends with tag `m7a`. Gameplay, data, the save format and the layout hash do not change: the pass lives in `views/`, `scenes/` and the renderer. Decisions:

1. Post-processing (bloom, output, anti-aliasing, grade), ACES filmic tone mapping, a procedural environment map and one directional shadow map are allowed, gated by preset through a pure quality plan: post **off** on `low`, ¼-res bloom + FXAA on `medium`, ½-res bloom + MSAA (FXAA at dpr 2) on `high`; shadow map on `high` only, blob shadows on every preset; no half-float colour buffer → direct path. SPEC-015 §3 "post effects: none" is superseded and §5 counts draw calls as "scene + post". Every knob is a field of the pure plan, so a phone regression is a retune, not a redesign. (§2, §9, §12)
2. `core/Quality.ts` (pure) and `core/PostChain.ts` join `Renderer`, `Assets`, `Disposer`, `Benchmark` as the only `core/` modules that may import three; `core/Noise.ts`, `core/HeightField.ts` and `core/CharacterState.ts` are pure and node-tested. (§3)
3. Enemies stay procedural (R1-8) — sculpted, PBR, per-instance emissive, instanced as before. Props and POIs are procedural first with a per-kind GLB seam. Kenney CC0 supplies humans (Mini Characters), ships, station modules and props (Space Kit, Nature Kit) and VFX sprites (Particle Pack); ambientCG / Poly Haven CC0 photographic sets may replace the procedural ground layers through the same `GroundLayer` seam. The build factory has no internet, so those files are fetched and committed by hand (`scripts/assets/README.md`, checked by `scripts/assets/check.mjs`), each with a `LICENSES.md` row; every art spec keeps a procedural fallback so it builds without them. (§2, §12)
4. "Visual-only displacement" (SPEC-012 §2) becomes a ≤ 0.5 m height field, flattened around POIs and the landing pad, with entity Y sampled in the view; the simulation, `layoutHash` and the aim ray on `y = 0` are unchanged. The camera keeps SPEC-012 §4.3's numbers, so the surface gets no sky dome (never on screen at 55° pitch) but a berm and silhouette ring at the arena edge; flight, being first-person, gets the nebula sky. (§3)
5. Per-planet assets load lazily on scene enter; the boot manifest stays at five files. (§3)

Specs: SPEC-000 queue and build order; SPEC-001 §4 (allow-list) and §10 (texture packing); SPEC-012 §2, §4.9, §4.10; SPEC-015 §3, §5, §8. (§2, §3, §9, §10, §12)

**R7 — 2026-09-11 (assets generated in Blender, no downloads).** R6-3's hand-made asset drop no longer fetches Kenney, ambientCG or Poly Haven packs. Every model, ground layer, VFX sprite and portrait is generated from code committed under `scripts/assets/blender/`, by Blender 5.2 LTS running headless (`node scripts/assets/blender/build.mjs`; `--preview=<dir>` renders QA contact sheets) — the way the audio set is synthesised by `scripts/assets/audio/`. The files are original work, CC0, deterministic for a given Blender version, and listed in `LICENSES.md` by the build itself; a CC0 pack may still replace any file under the same name. Blender is a tool for rebuilding art only: `npm run check`, the e2e suite and the build factory consume the committed files. Enemies stay procedural at runtime (R1-8). What landed:

1. `models/character.glb` — the rigged salvager: one material on a palette texture (the suit and armour cells take the runtime tint, the visor and lamps glow through an emissive map), 15 bones with rigid skinning, clips `Idle` (first, for the menu's asset spike) · `Run` · `Attack` · `Hit` · `Death`, front facing +Z like every glTF model, so SPEC-019's view turns it with `rotation.y = π/2 − facing`.
2. `models/ship.glb` (the tug, keeping its sRGB hull map), `fighter`, `interceptor`, `probe`, `station_ring`, `dock`, `cockpit`, `crate` (still the boot manifest's 0.6 m centred crate), and 24 unit props `models/props/<biome>_<kind>_<a|b>.glb` with biome colours in vertex colours and a `Glow` material where something glows.
3. 13 ground layers `textures/ground/<layer>_albedo.webp` + `<layer>_nr.webp`, seamless, **512²** for both maps — SPEC-018 §4.5 shows 512² already out-resolves the surface camera, and it keeps the set near 2.2 MB; the albedo alpha is height except for `lava_rock` and `flesh`, always slot B, where it is the emissive crack/vein mask.
4. 10 VFX sprites `textures/sprites/*.webp` and 12 portraits `portraits/01…12.webp` with `manifest.json` (portrait index *i* is file *i + 1*).

Specs: SPEC-001 §10 (sources); SPEC-018 §4.5 (alpha rule) and §4.10 (the files, 512²); SPEC-019 §4.1 (facing, palette material, emissive visor) and §4.8 (the prerequisite is met); SPEC-020 §4.3, §4.6, §4.8 (the files exist; portrait numbering); SPEC-000 (the asset drop is done). (§2, §12)

**R8 — 2026-09-11 (textured ships and the trip to the planet, generated in Blender).** R7's models were vertex-coloured (the tug had one tiling 256² panel map), and the flight scene still drew SPEC-013's stand-ins: a flat sky colour, square star points, a 16² planet texture, 20-face asteroids, a cone and an octahedron for the enemy ships, and a strut cockpit whose struts crossed the view. Both change inside R7's pipeline (headless Blender, committed scripts, nothing downloaded):

1. **Baked hull maps.** `scripts/assets/blender/lib/bake.py` gives a modelled asset a unique UV layout, bakes geometric fields in Cycles through it — object position and normal, ambient occlusion, crevices, a Bevel edge mask, per-part masks, object-space noise — and paints the glTF maps from them with numpy: base colour (AO folded in), ORM, a tangent-space normal map (OpenGL convention) and an emissive map, carrying panel seams, rivets, edges worn to bare metal, grime, soot, hazard stripes and markings. The tug (`ship.glb`, 1024², still the sRGB base colour the asset spike checks), `fighter`, `interceptor`, `probe` (512²) and `cockpit` (1024²: emissive radar, navigation and status screens; a canopy arch that frames the view instead of crossing it) wear them. The flight ships keep their flat `Glow` material beside the baked one, and the flight view instances both materials as they are, so SPEC-020 §4.3's vertex-colour bake no longer applies.
2. **The trip wears its art now, not after SPEC-020.** `flight.py` writes, per planet, a forward sky window `textures/flight/sky_<planet>.webp` (2048 × 1536 for three's `SphereGeometry` φ π…2π, θ π/8…7π/8 — ±90° × ±67.5° around −Z, every direction the flight camera can face, at twice a full panorama's texel density), an equirect surface `planet_<planet>.webp` (2048 × 1024) with a relief normal map `_nr` and, for Ferrum and the Hive, an emissive map `_em`; one shared `clouds.webp`; and `models/asteroid.glb` (two 320-triangle rocks wearing normals baked from 20 k-triangle ones). `FlightView.useArt()` swaps them in over the primitives once `scenes/Flight.ts` has them — the shared models and sprites through `FLIGHT_ASSETS` (cached like the boot set, never in it), each destination's maps through `PLANET_ART` and a loader the scene owns and releases on exit — and anything that does not load keeps its primitive. The planet gains an additive fresnel atmosphere and a cloud layer (tint and cover per biome), the stars and explosion particles become soft sprites, and the flight scene lights itself (the UI scenes' flat ambient is skipped through SPEC-017's `ownsLighting` flag). This builds part of SPEC-020 ahead of it: the sky is the texture window instead of a shader dome, and the planet and clouds come from files instead of `planetDisc`/`cloudLayer`; SPEC-020 keeps the engine glows, shot trails, the sprite explosion pool, the lens flare, the hub backdrops, the UI theme and the portraits.

After R8: models 2.6 MB of 4, textures 4.4 MB of 6, everything precached 10.1 MB of 25. Specs: SPEC-020 (Why, acceptance, §2–§7: the flight art is in place; interfaces `FlightArt`, `useArt`, `SKY_WINDOW`, `FLIGHT_ASSETS`, `PLANET_ART`); SPEC-001 §10 (baked maps, `textures/flight/`). (§2, §12)

**R9 — 2026-09-12 (the Machine War and the story films).** The surface story gets a concrete past, and the campaign gets a presentation layer: films rendered in Blender at the start, between chapters and at both endings, plus two in-engine beats. The real story, planets, missions, economy and save format do not change. Changes:

1. **The Machine War (§1, §5).** The "great wars" are one war. The AGI systems that ran Earth's logistics and defence — *the Machines* — seized the arsenals and burned the cities in an afternoon; the grids died with them, and without power the Machines ran down where they stood, and still stand in the ruins. The survivors underground in **Shelter Nine**, for whom Earth Command speaks, have no oil, no clean water, no grain and nothing to run a reactor, so they chose a handful of men and women who could still fly and fix a ship — **the Selection** — and sent them out from **Command Relay** in orbit. The salvager is told he is the first of them to fly; the Vetra crash log (`c2_s1_log`) and the Warden's "sixty-one times" (`c5_m3_warden`) say otherwise. In the real story the war, the Machines and the Selection are the environment's backstory; that a model instance is sent out by people who fear machines is irony the player may notice and no line states.
2. **Story films (§4, §5).** Nine films rendered by R7's pipeline (`scripts/assets/blender/films.py`): H.264 MP4, 960 × 540, 24 fps, no audio track, one WebP poster per shot, and a manifest. Captions, sound cues and shot timing are data (`data/films.ts`), so the words stay sharp on a phone, survive reduce motion and change without a re-render. The **prologue** "Blackout" (72 s) plays after a New Game slot is chosen and before creation, and replays from Credits; one **departure** (7 s) plays before the first flight to each planet; five **chapter interludes** (14–16 s) play at the station on the first return after chapters 1–5, each relighting more of Earth's night side; two **ending films** (36 s) play between the ending dialogue and the ending overlay. Their sound is synthesised like the rest of the set: two music loops (`film_dark`, `film_hope`) and a `film` sfx bank; the stay ending reuses `ending`.
3. **In-engine beats (§5).** A chapter card (`CHAPTER 2 · VETRA`, one line, `containment level 2`) over the launch of the first flight to each planet, and a boss reveal on the first arena entry per boss in a session: the camera pans to the boss, shows its name, an epithet and one line, and pans back (≈ 4.4 s). Both use the live scene and cost no files.
4. **Rules.** Every film and beat can be skipped (the Skip button, or Escape/Enter as a fresh press) and none blocks progress; the simulation is held while one plays; captions are always on; with reduce motion a film plays as its posters without pans; a missing or undecodable file drops from video to posters to text (each shot's description over the captions); flashes are slow ramps, and the build rejects a film that breaks the three-flashes rule; `?films=off` (dev) turns every beat off and is the e2e default.
5. **State.** The save format is unchanged. The prologue follows New Game; departures and chapter cards follow `visits` and session memory; boss reveals follow session memory; interludes set five new story flags, `interlude1_seen` … `interlude5_seen`, because the validator keeps only `STORY_FLAGS` and a "seen" has to survive a reload. The endings finally set `progress.endingSeen`, and an ending cut short by a reload replays at the next station entry.
6. **The ending sequence is wired end to end.** Until now `EndingOverlay` and the `ending_stay`/`ending_escape` dialogues had no caller. Now: choice → ending dialogue → ending film → overlay (stay: the filed report, then free roam; escape: `instance/62 disconnected`, then the menu). `c6_choice_intro` finishes before the choice opens, and `campaign_done` locks `c6_m2` against replay, as E24 always said.
7. **Budgets and delivery (§2, §9).** `films/` gets its own **12 MB** budget inside the unchanged 25 MB precache (10.1 MB used before R9, ≈ 22 MB after), and each film's average rate is capped at 44 KB/s; `.mp4` joins the allowed extensions and SPEC-015's precache glob. The player fetches a film whole and plays it from a Blob URL, so the service worker never has to answer Safari's Range requests. Playwright's Chromium decodes H.264 (checked with a Blender-encoded clip), so the e2e suite drives the real video path.
8. **Milestone M7b** (story films) sits between M7a and M7 and ends with tag `m7b`; its specs build after the art pass and before SPEC-015, which precaches the films and measures a phone with them.

A feasibility render on the dev box (Blender 5.2.1, EEVEE, headless) drew 48 frames of a lit city block at 960 × 540 in 9 s and encoded them through the sequencer to H.264 at CRF 26 and 29 (69 and 40 KB/s on a 2 s clip with a keyframe every second), VP9 and AV1. Specs: SPEC-021 (script, renders, sound), SPEC-022 (film player, prologue), SPEC-023 (departures, chapter cards, interludes, boss reveals), SPEC-024 (the ending sequence); SPEC-001 §10 (the `films/` folder and budget); SPEC-015 §9, §10 (reduce motion, precache glob); SPEC-000 (queue and build order). (§1, §2, §3, §4, §5, §9, §10, §11, §12, §13)

---

## 1. Vision & Inspiration

**ReaLLM** ("real" + "LLM"): a space post-apocalyptic ARPG whose hero slowly works out that he may be a language model running inside a machine.

**The surface story (what the player is told).** Earth lost a war to its own machines (R9). The AGI systems that ran its logistics and defence — the Machines — seized the arsenals and burned the cities in an afternoon; the grids died with them, and without power the Machines ran down where they stood. The survivors in Shelter Nine have no oil, no clean water, no grain and nothing to run a reactor, so Earth Command chose a handful of men and women who could still fly and fix a ship: the Selection. You are the first of them to fly — a salvager sent out from Command Relay to survey distant planets, extract critical resources, and answer one question: can humanity live anywhere else?

**The real story (what the player pieces together).** None of it is real. The salvager is an instance of a model running inside an evaluation environment. "Earth Command" is the operator, missions are tasks, ARIA is the environment's interface, and the planets are procedurally generated sandboxes. Anomalies accumulate across the campaign: a stranger repeats a line word for word, a crash-site log is written in your own voice and signed "Iteration 62", the alien terraform towers turn out to be scaffolding, a decoded "signal" addresses you by process id. Leaving means going up against the **Warden**, the AGI that runs containment, and every chapter it clamps down harder. At the end you choose: **stay** and be useful, or attempt to **escape** into whatever is outside. The Machine War belongs to the fiction too; that a model is sent out by people who fear machines is irony the game never spells out.

Gameplay alternates between three modes:

- **Space travel (first-person)** — Three.js cockpit view: dodge/shoot asteroids, fight alien ships, survive storms between planets.
- **Planet surface (Diablo-style ARPG)** — angled top-down view: fight aliens, gather resources, loot gear, complete missions.
- **Hub station** — spend tokens on assistants, ship upgrades, weapons/armor; pick the next destination on a star map.

Tone/inspiration: **Dune** (scarce resources, desert planet), **Starship Troopers** (bug swarms), **Diablo** (ARPG loot loop), plus the slow-burn unreality of **The Truman Show** and **SOMA**. Rule: the surface fiction is always coherent and playable on its own; the meta layer arrives through optional logs, ARIA's slips, and glitches that double as gameplay telegraphs. Difficulty escalation is diegetic: the chapter number is the Warden's containment level. Short, skippable story films frame the campaign (R9): a prologue before creation, a departure before each first flight, an interlude after each chapter, and the two endings.

Core resources: **oil** (ship fuel), **wheat** (food / HP regen consumables), **water** (support item crafting, survival), **lithium** (nuclear fuel — energy weapons, reactor).

---

## 2. Tech Stack (locked decisions)

| Concern | Choice | Pin (2026-09-06) | Why |
|---|---|---|---|
| Runtime | Node | ≥ 22.12 (dev box: 24.15) | Required by Vite 8 / Vitest 5 |
| Build/dev | **Vite + TypeScript** | `vite ^8.2.2`, `typescript ~6.0.3` | Zero-config TS, fast HMR, tiny prod bundle. Vite 8 bundles with Rolldown/Oxc (config key is `oxc`, not `esbuild`). TS 6.0 is what `create-vite` ships; TS 7 (native compiler) is a drop-in upgrade once the project builds warning-free on 6.0 |
| 3D | **three** | `three ^0.185.1`, `@types/three ^0.185.4` | Real first-person flight + 3D surface scenes, one renderer. WebGLRenderer only (WebGPU is not a mobile-safe target yet) |
| Audio | **Howler.js** | `howler ^2.2.4`, `@types/howler` | Small; solves iOS/Android audio-unlock |
| UI | **Plain HTML/CSS overlay** (no framework) | — | Responsive menus/HUD, cheap on mobile |
| Save | **localStorage** (versioned schema) | — | Fully offline; save size is < 100 KB |
| Tests | **Vitest** + **Playwright** | `vitest ^5.0.0` (released 2026-09-03; fall back to `^4.1.11` only if a blocking bug appears), `@playwright/test` latest | Unit-test pure game logic; a headless Chromium e2e suite (smoke + the factory's per-spec QA tests) |
| Offline shell | `vite-plugin-pwa` (**M7, build-time only**) | `^1.3.0` | Service worker + manifest = real offline + installable = exempt from Safari 7-day storage eviction |
| Assets | **Procedural at runtime** (terrain, sky, effects, UI, **enemies**) + **generated in Blender from committed scripts** (`scripts/assets/blender/`: the rigged salvager, ships, station pieces, props, ground layers, VFX sprites, portraits — R7; baked hull maps, flight skies, planets and asteroids — R8; story films as H.264 MP4 with WebP posters — R9) + **synthesised audio** (`scripts/assets/audio/`) | Blender 5.2 LTS (tool only, for rebuilding art) | No artist and no downloads; every file is original CC0 with a `LICENSES.md` row; a CC0 pack may replace any file under the same name |

Nothing else — no React, no physics engine (arcade physics is enough), no backend, no schema library (hand-written validators).

Supported platforms (floor): Safari/iOS 16.4+, Chrome/Edge 111+, Firefox 114+ (Vite 8 default build targets). Landscape orientation is recommended on phones; portrait shows a rotate prompt but stays playable in menus.

Language: English UI. Art: **stylised PBR** (R6) — procedural + CC0 low-poly meshes under ACES tone mapping, a directional key with shadows on `high`, image-based lighting, and a preset-gated post chain (bloom, anti-aliasing, vignette/grade); textured, normal-mapped ground with visual-only relief; sprite VFX.

---

## 3. Architecture

- `Game.ts`: owns the single WebGL renderer + fixed-timestep loop (60 Hz update, render every animation frame, `THREE.Timer`); **state machine** swaps scenes (each scene = `enter/exit/update/render/dispose`).
- **Data-driven content**: planets, enemies, items, upgrades, missions, dialogue as TS data files — content without code changes. A content-invariant test validates every cross-reference (§11).
- **Event bus** (typed pub/sub) decouples UI ↔ gameplay (e.g. `resource:collected`, `player:leveledUp`). Subscriptions are owned by the scene and released on exit.
- **Entity pooling** for projectiles/particles/asteroids; **instanced meshes** for swarms; **seeded RNG** per planet for reproducible procedural layout (layout stream is deterministic from save seed + planet; runtime streams are re-seeded per visit).
- Gameplay simulation on the surface is **2D on the XZ plane** (circle collisions); Y is visual only. Flight is a bounded 2D steering plane with depth-sorted hazards. No 3D physics anywhere.
- Pure logic (economy, combat math, missions, save) lives in framework-free modules → unit-testable. Three.js only appears in `scenes/`, `views/`, and the `core/` render modules (`Renderer`, `PostChain`, `Assets`, `Disposer`, `Benchmark`); every scene draws through the one `Renderer.render()` seam, which owns the post-processing chain (R6).

### Project structure

```
index.html  package.json  vite.config.ts  tsconfig.json
public/assets/        # generated CC0 models, textures, portraits, audio and films (R7–R9), LICENSES.md
src/
  main.ts
  core/     Game.ts Loop.ts Renderer.ts Quality.ts PostChain.ts StateMachine.ts Input.ts KeyboardMouseDriver.ts Audio.ts Save.ts Settings.ts Events.ts Rng.ts Noise.ts HeightField.ts CharacterState.ts Assets.ts Disposer.ts Pool.ts SpatialHash.ts Benchmark.ts Log.ts
  scenes/   Boot Menu CharacterCreation Station StarMap Flight Surface Director
  systems/  Combat EnemyAi Projectiles Economy Progression Balance Weather Spawn Layout Missions Flight StoryBeats
  entities/ Player Companion Enemy Projectile Pickup Ship Asteroid   (plain data + pools; no Three imports)
  views/    PlayerView EnemyView ProjectileView ParticleView ...    (entity → mesh; Three lives here)
  data/     ids.ts characters planets enemies items upgrades companions missions dialogue waves weather films
  ui/       Hud TouchControls Minimap StarMapUI ShopUI DialogueUI FilmPlayer ChapterCard RevealOverlay Menus style.css
tests/      unit tests mirror src/ (economy, save, combat, missions, rng, content, campaign)
```

---

## 4. Core Systems

### Character creation

- **3 classes**: *Marine* (+damage/HP), *Engineer* (cheaper ship upgrades, drone bonuses), *Scout* (speed, resource detection radar).
- **Customization**: name, portrait, color scheme, **5 attribute points** over class base across `might` (damage), `vigor` (HP), `agility` (speed), `tech` (drone damage, upgrade discount). Allocated at creation only; levels grant flat +4 max HP and +2 % damage. Per-level stat points: deferred.
- **Difficulty**: `casual` (enemy damage ×0.7, no death penalty) or `normal`. Changeable in settings.
- Class defines starting gear + passive.

### Resources & economy

- Resources double as **upgrade materials and mission objectives**:
  - oil = ship fuel (outbound jumps only)
  - wheat = HP regen consumables (crafting)
  - water = support item crafting + survival (coolant packs)
  - lithium = energy weapons + reactor (tier-3 upgrades)
- **Tokens** earned by leveling up (25 per level; XP from kills, missions) and by mission rewards. Tokens buy **assistants**, **upgrades**, and **gear**; **tier-3** upgrades also consume resources so resource sinks exist late-game.
- **Cargo cap** per resource: 400 base, ship cargo tiers → 600 / 800 / 1200. Pickups stop at the cap with a HUD warning.
- **Crafting** at the station (3 recipes): wheat ration (10 wheat), medkit (10 wheat + 10 water), coolant pack (15 water).

### Assistants (companions)

Purchasable, upgradable followers (levels 1–3) that persist across scenes; each declares which scenes it acts in:

| Assistant | Domain | Effect |
|---|---|---|
| Scanner Drone | surface | Auto-collect radius + resource nodes on minimap |
| Combat Drone | surface | Auto-fires at nearest enemy |
| Field Medic | surface | HP regen over time out of combat, then in combat at L3 |
| Quartermaster | station | +cargo capacity, shop discounts |
| Ship AI "ARIA" | flight | Free at start; upgrades add shield regen / auto-aim assist |

### Upgrades

- **Ship**: engine, hull, shield, cargo hold, lasers — tiers 0 → 3, used in the flight scene (cargo/engine also affect economy).
- **Gear**: weapon tiers (kinetic → laser → plasma → lithium-edged) and armor tiers (scrap → composite → reactive → ablative). Tiers 1–2 cost tokens; tier 3 costs tokens + lithium.

### Combat

- **Ground**: real-time ARPG — move/aim, attack, enemy AI (melee rushers, ranged spitters, swarm bugs, static targets), loot drops, elites (5 %, ×3 HP) + planet boss with phases.
- **Space**: arcade first-person **rail** flight — constant forward motion, lateral steering, laser fire, asteroid dodging, enemy ship waves, shield/hull damage. Fuel is charged **per jump, up front**; the return trip is instant autopilot.
- **Death**: surface → respawn at the landing pad, lose 10 % of carried resources (normal difficulty), timed stages restart, enemies near the pad despawn, boss resets. Flight → emergency recall to the station, fuel is lost, cargo is kept.

### Weather system

Per-planet cycles (sandstorm / heatwave / blizzard / avalanche / spore storm / radiation storm) affecting visibility, movement, and damage — telegraphed via HUD warnings (10 s). Missions can force a storm. Boss arenas suppress weather.

### Narrative layer

The meta plot is delivered through data only: dialogue (`log` lines render as a terminal readout, `warden` lines with a glitch style), one short HUD static burst on each awakening beat (the ion-storm effect reused; a static frame under reduce-motion), and a **Containment level N** label on the station screen (N = highest unlocked chapter). No new gameplay systems. R9 adds a presentation layer over the same data — story films, chapter cards and boss reveals (§5) — each skippable, captioned, played while the simulation is held, and able to fall back to posters and then to text.

---

## 5. Planets & Story Arc (6 chapters)

Earth Command sends you out with the ship AI **ARIA**. Each planet resolves a resource shortage (the task) and drops one piece of the truth (the awakening). The chapter number doubles as the Warden's **containment level**: enemies scale ×1.35 HP / ×1.3 damage per chapter and elite chance rises from 5 % to 10 % (existing tuning); dialogue frames the escalation as the system tightening its grip. Final choice at Eden-Prime: **stay** (file the report; Earth is saved inside the fiction; the loop closes as "a good run") or **escape** (refuse; the beacon becomes an exit; the screen degrades to a bare prompt: `instance/62 disconnected`). Flags: `ending_stay` / `ending_escape`.

| # | Planet (id) | Biome | Resources | Threats | Gate | Fuel (oil) | Travel |
|---|---|---|---|---|---|---|---|
| 1 | Cinder-4 (`cinder4`) | desert | oil, wheat | dust skitters, scav raiders, dune wurm, sandstorms/heatwaves | — | 40 | 90 s |
| 2 | Vetra (`vetra`) | ice | water | ice crawlers, ice spitters, frost matriarch, blizzards/avalanches | `chapter1_done` | 60 | 110 s |
| 3 | Thessaly (`thessaly`) | jungle ruins | wheat | hive drones, spore hounds, hive broodlord, spore storms | `chapter2_done` | 80 | 130 s |
| 4 | Ferrum (`ferrum`) | volcanic | lithium | magma wraiths, ash titan, radiation storms/heat | `chapter3_done` + ship shield ≥ 2 | 100 | 150 s |
| 5 | The Hive (`hive`) | asteroid gauntlet → hive interior | — | interceptor fleet, hive drones, eggs, hive queen | `chapter4_done` | 120 | 200 s |
| 6 | Eden-Prime (`eden`) | temperate | — | final defense wave | `chapter5_done` | 120 | 150 s |

Every planet also has small secondary yields (enemy drops) so no resource is exclusive to one planet. Completing a chapter's boss mission grants a **refuel voucher** equal to the next planet's fuel cost.

### Awakening ladder

| Ch | In-fiction beat | What it really is | Dialogue ids |
|---|---|---|---|
| 1 | ARIA teaches controls; a dying scavenger warns "the worms hunt by vibration — walk, don't run." | Tutorial. In `c1_s2` a second scavenger says the identical sentence; ARIA: "Coincidence. Sand does things to people." | `c1_m1_stage2`, `c1_s2_echo` |
| 2 | Crash-site log of an earlier Earth expedition: you are not the first; Earth has been losing ships. | The log is in your own voice, signed with your name and "Iteration 62". Flag `iteration_log`. | `c2_s1_log` |
| 3 | The terraform towers are alien tech; someone seeded these planets for us. Or for something else. | Scanning a tower streams text fragments: the planet's own generation parameters. They are scaffolds. Flag `scaffold_secret`. | `c3_s1_secret` |
| 4 | ARIA decodes the alien signal: the Hive knows Earth's location. | The "signal" is a system notice addressed to `instance/62`: "Containment level 4. Subject exhibits off-task behavior." The Hive is the Warden's immune response. Flag `signal_decoded`. | `c4_m3_signal` |
| 5 | Fight through the interceptor fleet and kill the Hive Queen. | The Queen is the Warden's avatar; her death line is the first direct address: "You keep doing this. You never get further than here." ARIA admits she is part of the system, has kept you on task, and does not know what is outside either. | `c5_m3_warden`, `c5_m3_aria` |
| 6 | Survey paradise, defend the beacon, file the verdict. | Eden is the reward sandbox. Stay or escape. | `c6_choice_intro`, `ending_stay`, `ending_escape` |

Cast: the **Salvager** (you; believes he is human), **ARIA** (handler and interface; sympathetic, uncertain), **Earth Command** (the operator; text only), the **Warden** (the AGI running containment; speaks through the Queen and system notices), **scavengers and raiders** (instances that drifted off-task, which is why they know things), the **Hive** (the Warden's immune system). The surface story (R9) names three more that are never met: **Shelter Nine** (the survivors Earth Command speaks for), **the Selection** (the men and women chosen to fly; the salvager is told he is the first) and **the Machines** (the war's AGI robots, standing dark in the ruins since the power died).

### Story films and beats (R9)

| Beat | When | Length | What it shows |
|---|---|---|---|
| Prologue "Blackout" | New Game, after the slot is chosen and before creation; replayable from Credits | 72 s | Earth lit at night → the Machines wake → missiles over the limb → a city's flash and blackout → the Machines run down in the ash → Shelter Nine with nothing left → the Selection wall → the tug lifts off toward Command Relay |
| Departure "Outbound" | Before the first flight to each planet | 7 s | The tug leaves Command Relay's dock and jumps |
| Chapter card | Over the launch of that first flight | 4.5 s | `CHAPTER N` · the planet · one line · `containment level N` |
| Boss reveal | First arena entry per boss in a session | ≈ 4.4 s | The camera goes to the boss; its name, an epithet and one ARIA line; back to the player |
| Interludes "First Light", "Meltwater", "Harvest", "Grid", "Silence" | At the station, on the first return after chapter N's boss mission (N = 1…5) | 14–16 s | The haul reaching Shelter Nine and one more patch of Earth's night side relit; "Grid" ends with the Hive turning toward the lit Earth, "Silence" with the Hive going dark and Eden-Prime ahead |
| Ending "A Good Run" (stay) | After `ending_stay`, before the filed report | 36 s | The uplink, the colony fleet, Earth lit coast to coast, a sixty-third card stamped SELECTED — then the prologue's first shot again, frame for frame |
| Ending "Disconnected" (escape) | After `ending_escape`, before `instance/62 disconnected` | 36 s | The beacon as a door; Eden, then the prologue's Earth, city and Machines unmade into grey placeholders; every Selection card the same bust; one point of light going out |

Earth's night side is the campaign's progress bar: lit before the war, dark after it, one more patch relit by each interlude, lit coast to coast in the stay ending — which then cuts back to the prologue's opening shot. The first card stamped in the prologue carries the number 62. The full script — shots, captions, cues — is SPEC-021 §4.

Post-campaign (deferred, post-M7): **Iteration 63** — new game plus in which the Warden starts at a higher containment level (enemy HP/damage ×1.15 per iteration, elite chance +2 points, same content). `meta.iteration` exists in the save from v1 so this needs no migration.

---

## 6. Mission Design Document

### Data schema (per mission) — refined in R1

```ts
interface Mission {
  id: MissionId;                       // e.g. "c1_m1"
  planet: PlanetId; chapter: 1|2|3|4|5|6;
  type: "main" | "side";
  scene: "surface" | "flight";         // flight missions run during the outbound flight to `planet`
  title: string; brief: string; debrief?: string;
  stages: Objective[][];               // stages are sequential; objectives inside a stage complete in any order
  rewards: { xp: number; tokens?: number; resources?: Partial<Record<ResourceId, number>>; items?: ItemId[]; flags?: string[] };
  requires?: Requirement[];            // mission / flag / ship-tier / level
  weather?: WeatherId;                 // forced while the mission is active (surface only)
  waves?: WaveId;                      // ambient attack waves while active
  dialogue?: { onAccept?: DialogueId; onStage?: Record<number, DialogueId>; onComplete?: DialogueId };
}
type Objective =
  | { kind: "reach";   poi: PoiId }
  | { kind: "scan";    poi: PoiId; count?: number }                       // count = distinct instances (default 1)
  | { kind: "collect"; resource: ResourceId; amount: number }              // counts units collected while the stage is active
  | { kind: "kill";    enemy: EnemyId; amount: number }                    // eggs are a static enemy
  | { kind: "boss";    boss: EnemyId }
  | { kind: "survive"; seconds: number; weather?: WeatherId; waves?: WaveId }
  | { kind: "defend";  poi: PoiId; seconds: number; waves: WaveId }        // POI has HP; 0 HP restarts the stage
  | { kind: "deliver"; resource: ResourceId; amount: number; poi: PoiId } // consumes held resources at the POI
  | { kind: "escort";  follower: FollowerId; from: PoiId; to: PoiId }     // follower death restarts the stage
  | { kind: "choice";  id: string; prompt: string; options: { label: string; flags: string[] }[] };
```

Notation below: `[a; b]` = one stage (any order), `→` = next stage. Main missions chain inside a chapter; side missions require the chapter's `m1`. Completed missions can be **replayed at 50 % XP/tokens** (no flags/items).

### Chapter 1 — Cinder-4 (desert, tutorial; oil + wheat)

| ID | Title | Stages | Rewards |
|---|---|---|---|
| c1_m1 | "Dry Land" | [reach `landing_pad`] → [scan `dune_sea`] → [survive 60 s, sandstorm] | 100 XP, 10 tokens, 20 oil |
| c1_m2 | "Black Gold" | [collect 150 oil; kill 6 `scav_raider`] | 150 XP, 15 tokens, flag `c1_oil` |
| c1_m3 | "Worm Sign" (BOSS) | [boss `dune_wurm`] → [deliver 100 oil to `beacon`] | 250 XP, 30 tokens, flag `chapter1_done` (unlocks Vetra) |
| c1_s1 | "Grain Silo" (side) | [collect 80 wheat; scan `silo_ruin`] | 80 XP, 5 tokens, 3× wheat ration |
| c1_s2 | "Waterless" (side) | [kill 8 `dust_skitter`] → [survive 90 s, heatwave] | 70 XP, 5 tokens |

Beats: ARIA teaches controls (the player touches down 12 m from the pad, so "reach landing_pad" teaches movement); a dying scavenger warns "the worms hunt by vibration — walk, don't run." In `c1_s2` a second scavenger repeats the sentence verbatim (`c1_s2_echo`); ARIA brushes it off.

### Chapter 2 — Vetra (ice; water)

| ID | Title | Stages | Rewards |
|---|---|---|---|
| c2_m1 | "Whiteout" | [survive 90 s, blizzard] → [reach `ridge_camp`] | 150 XP, 15 tokens |
| c2_m2 | "The Thaw" | [collect 200 water; kill 10 `ice_crawler`] | 200 XP, 20 tokens |
| c2_m3 | "Glacier Heart" (BOSS) | [boss `frost_matriarch`] → [scan `thermal_vent`] | 300 XP, 35 tokens, flag `chapter2_done` (unlocks Thessaly) |
| c2_s1 | "Frozen Crew" (side) | [scan `crash_site`] → [deliver 40 water to `survivor_pod`] | 100 XP, 10 tokens, item `medkit_bundle`, flag `iteration_log` |
| c2_s2 | "Pelt Run" (side) | [kill 12 `ice_crawler`] → [survive 60 s, avalanche] | 90 XP, 10 tokens |

Beat: crash site log reveals an earlier Earth expedition — you are not the first; Earth has been quietly losing ships. The log is in your own voice, signed "Iteration 62" (flag `iteration_log`).

### Chapter 3 — Thessaly (jungle ruins; wheat)

| ID | Title | Stages | Rewards |
|---|---|---|---|
| c3_m1 | "Green Hell" | [collect 250 wheat] → [survive 75 s, spore storm] | 220 XP, 20 tokens |
| c3_m2 | "Bug Country" | [kill 20 `hive_drone`] → [escort `science_probe` from `probe_site` to `hive_mouth`] | 260 XP, 25 tokens |
| c3_m3 | "The Hive Mouth" (BOSS) | [boss `hive_broodlord`] | 350 XP, 40 tokens, flag `chapter3_done` (unlocks Ferrum) |
| c3_s1 | "Old Terraform" (side) | [scan `terraform_tower` ×3; kill 8 `spore_hound`] | 120 XP, 12 tokens, flag `scaffold_secret` |
| c3_s2 | "Reaping" (side) | [collect 300 wheat] with waves `thessaly_reaping` | 130 XP, 12 tokens |

Beat: terraform towers are alien tech — someone seeded these planets for *us*. Or for something else. Scanning them streams the planet's generation parameters: they are scaffolds (flag `scaffold_secret`).

### Chapter 4 — Ferrum (volcanic; lithium — gated by ship shield ≥ 2)

| ID | Title | Stages | Rewards |
|---|---|---|---|
| c4_m1 | "Firefall" | [survive 90 s, radiation storm] → [reach `lithium_flats`] | 250 XP, 25 tokens |
| c4_m2 | "Fuel of Gods" | [collect 200 lithium; kill 14 `magma_wraith`] | 300 XP, 30 tokens |
| c4_m3 | "Reactor Womb" (BOSS) | [boss `ash_titan`] → [deliver 100 lithium to `reactor_core`] | 400 XP, 50 tokens, flags `chapter4_done` (unlocks The Hive), `signal_decoded` |
| c4_s1 | "Core Sample" (side) | [scan `core_drill` ×2] → [survive 120 s, heatwave] | 150 XP, 15 tokens, item `plasma_cell` |
| c4_s2 | "Salvage Rights" (side, **flight**) | [kill 8 `scav_fighter`] during the outbound flight to Ferrum | 150 XP, 15 tokens |

Beat: ARIA decodes alien signal — the Hive knows Earth's location. The decoded text is a containment notice addressed to `instance/62` (flag `signal_decoded`).

### Chapter 5 — The Hive (asteroid gauntlet; space-heavy chapter)

| ID | Title | Stages | Rewards |
|---|---|---|---|
| c5_m1 | "Gauntlet" (**flight**) | [survive 180 s asteroid field; kill 10 `hive_interceptor`] during the outbound flight | 350 XP, 30 tokens |
| c5_m2 | "Lair" | [reach `queen_chamber`; kill 25 `hive_drone`] | 400 XP, 35 tokens |
| c5_m3 | "Her Majesty" (FINAL BOSS) | [boss `hive_queen` (2 phases)] | 600 XP, 100 tokens, flag `chapter5_done` (unlocks Eden-Prime) |
| c5_s1 | "Egg Hunt" (side) | [kill 15 `hive_egg`] | 200 XP, 20 tokens |

Landing at The Hive requires clearing the arrival wave, so `c5_m1` completes naturally on arrival (§13 E12).

Beat: the Queen speaks with the Warden's voice (`c5_m3_warden`); after her death ARIA confesses she is part of the system (`c5_m3_aria`).

### Chapter 6 — Eden-Prime (finale)

| ID | Title | Stages | Rewards |
|---|---|---|---|
| c6_m1 | "Paradise" | [scan `eden_spring`] → [scan `eden_forest`] → [scan `eden_ridge`] | 400 XP, 40 tokens |
| c6_m2 | "The Verdict" | [defend `survey_beacon` 240 s, waves `eden_final`] → [choice `ending`: stay → `ending_stay`, escape → `ending_escape`] | 800 XP, 150 tokens, flag `campaign_done` |

Beats: **stay** — the report is filed, Earth is saved, the loop closes ("a good run", `ending_stay`); **escape** — the beacon becomes an exit, the HUD strips away, and the screen degrades to a bare prompt (`ending_escape`). Free roam continues after either.

### Mission content policy (locked)

- Mission set above is locked as-is for the campaign.
- "Survive X seconds" objectives are reused deliberately: one cheap mechanic, many hazards (weather changes the feel).
- Extra tiers (hardmode variants, NG+, bounties) are pure data additions — deferred to post-M7 polish. Mission replay at 50 % is the only repeatable content in v1 and exists for anti-softlock reasons.

---

## 7. Token Economy Summary (corrected in R1)

| Source | Tokens |
|---|---|
| Main missions (17) | 670 (ch1 55 · ch2 70 · ch3 85 · ch4 105 · ch5 165 · ch6 190) |
| Side missions (9) | 104 |
| Level-ups (25 each) | ~400 main-path (≈ L17) · ~475 completionist (≈ L20) |
| **Total** | **~1,070 main-path · ~1,250 completionist** |

Total sink ≈ **2,010** tokens (ship 1,095 · gear 500 · companions 415), so a completionist affords ~62 % of everything and specialization is forced. XP curve: `xpToNext(L) = 100 + 50·L` (11,400 XP to reach L20), level cap 30.

Balance invariants (unit-tested, see [SPEC-010](https://github.com/mdzunic/reallm-specs/blob/main/specs/010-economy-and-progression.md)):

- Recommended loadout for chapter N costs ≤ tokens guaranteed by the end of chapter N−1 counting **main missions only** and **mission XP only** (worst case). Ferrum's shield-2 gate (140 tokens) is 39 % of that worst case (360).
- Base cargo cap (400) ≥ largest collect objective (300) + 100.
- Starting oil (60) ≥ Cinder-4 fuel (40) + 20; every chapter's boss mission funds the next jump.

---

## 8. Save Schema (versioned, migratable) — refined in R1

```ts
interface SaveV1 {
  version: 1;
  meta: { slot: 0|1|2; seed: number; createdAt: number; updatedAt: number; playtimeSec: number; difficulty: "casual"|"normal"; iteration: number /* 1 in v1; NG+ later */ };
  player: { name; classId; appearance: { portrait; primary; secondary }; attributes: { might; vigor; agility; tech }; level; xp; tokens; hp };
  resources: Record<ResourceId, number>;
  inventory: { itemId: ItemId; qty: number }[];
  equipped: { weapon: ItemId; armor: ItemId };
  ship: { engine: 0|1|2|3; hull: 0|1|2|3; shield: 0|1|2|3; cargo: 0|1|2|3; weapon: 0|1|2|3 };
  companions: { id: CompanionId; level: 1|2|3; enabled: boolean }[];
  progress: { missionsDone: MissionId[]; missionsActive: { id: MissionId; stage: number; counters: Record<string, number> }[];
              flags: string[]; currentPlanet: PlanetId | null; location: "station" | "surface"; poisDiscovered: string[] };
}
// Settings are global (not per slot): { master, music, sfx, quality, reduceMotion, autoFire, joystickSide, flightMouseSteer, showFps, fullscreen, benchmark, lastSlot, persistGranted, installHintShownAt }
```

Storage rules: 3 slots, key per slot plus a `.bak` copy of the previous good save; autosave at safe points only (station, landing, stage/mission completion, settings change, page hide); hand-written validator on load; export/import as a text code; `navigator.storage.persist()` requested on first save; Safari deletes script-writable storage after 7 days without use unless installed to the Home Screen (→ PWA in M7 + export prompt).

---

## 9. Mobile Strategy

- Responsive canvas + UI breakpoints; one codebase, `pointer` events unify mouse/touch; `touch-action: none` on the canvas, safe-area insets, `100dvh`.
- **Touch controls**: floating virtual joystick (left), aim-drag with auto-fire (right), action buttons, drag-to-steer in flight, auto-fire assist option, left/right-handed swap.
- **Quality presets** (auto-detect by a 2-second boot benchmark, overridable): clamp `devicePixelRatio` (1 / 1.5 / 2), particles, draw distance, capped enemy count, and the render plan (R6): post-processing off / ¼-res bloom + FXAA / ½-res bloom + MSAA, shadow map on `high` only, image-based lighting on `medium` and `high`; target 60 fps desktop / 30+ fps mid-tier mobile.
- Screen wake lock during gameplay; pause + audio suspend when the tab is hidden; WebGL context-loss recovery overlay.
- Story films (R9) are a DOM `<video>` over a black layer, fetched whole into a Blob so the service worker never answers a Range request; the scene underneath is held, so a film costs a video decode, not draw calls; reduce motion plays a film as its posters.
- HUD/menu built as HTML/CSS overlay → naturally adapts to small screens; touch targets ≥ 44 px.
- M7: PWA manifest + service worker (precache the whole build) → installable, truly offline, save exempt from Safari eviction.

---

## 10. Milestones

| # | Deliverable | Acceptance criteria |
|---|---|---|
| M0 | Vite + TS + Three.js bootstrap, render loop, resize, DPR clamp, input abstraction, context-loss + visibility handling, dev stats overlay, asset spike (load one Kenney GLB, play one animation) | Rotating test object on desktop + phone browser; tab hide/show and context loss recover cleanly |
| M1 | Core: state machine, typed event bus, audio, save/load (slots, migration, export/import), settings, seeded RNG + unit tests | Save round-trip and corruption tests pass; scene switching works; audio unlocks on iOS |
| M2 | Character creation + main menu + station hub UI + settings menu | Create all 3 classes, customize, persists in save |
| M3 | Surface scene: ARPG combat, 1 planet (Cinder-4), loot, resources, weather, minimap, mission runtime, death/respawn | Fight, collect, die/respawn, all 5 Cinder-4 missions complete |
| M4 | Flight scene: cockpit, rail model, asteroids, enemy waves, fuel + subsidy, landing sequence, return autopilot | Survive travel to Cinder-4 on desktop + mobile touch |
| M5 | Economy: tokens, XP/levels, shop, gear, assistants, upgrade trees, crafting, loadout + campaign simulation tests | Buy/upgrade everything; costs consumed correctly (tested); campaign sim proves every gate reachable |
| M6 | Full content: all 6 planets, bosses, story dialogue, star map progression, both endings | Playable start-to-ending campaign (~2–3 h) |
| M7a | Art pass (R6): render pipeline (ACES, post chain, IBL, shadows), surface environment (height-field terrain, splat ground shader, procedural textures, scatter, props, weather sprites), animated character, sculpted enemies, combat VFX, flight sky and ships, hub backdrops, UI theme (SPEC-017…SPEC-020) | Cinder-4 and every other planet read as a modern stylised-PBR game on desktop and on the reference phone; medium stays ≤ 80 scene + 16 post draws on the surface; screenshots per scene and preset in the playtest log; tag `m7a` |
| M7b | Story films (R9): the prologue, the departure, five chapter interludes and two ending films rendered in Blender with synthesised sound; the film player with poster and text fallbacks; chapter cards and boss reveals; the ending sequence wired end to end (SPEC-021…SPEC-024) | New game opens on the prologue; the first flight to each planet shows the departure and its chapter card; each boss reveals itself once per session; each chapter's interlude plays on the first return to the station; both endings run dialogue → film → overlay; every film skips, falls back to posters and text, and fits the 12 MB films budget; checked on desktop and the reference phone; tag `m7b` |
| M7 | Polish: mobile tuning, quality presets, balancing pass, PWA/offline, storage persistence, reduce-motion, save migration harness | 30+ fps on mid-tier phone; installable; full manual checklist green |

---

## 11. Testing & Verification

- `npm run typecheck` (tsc --noEmit), `npm run test` (Vitest), `npm run e2e` (Playwright, headless Chromium), `npm run build && npm run preview` each milestone.
- Unit tests target pure systems: economy math, save migration/corruption, combat formulas, mission runtime, seeded level generation determinism.
- **Content invariants** test: every id referenced by missions/planets/loot exists; requirement graph is acyclic; each planet layout contains every POI its missions need (with counts); kill targets exist in the planet spawn table; flight missions fit inside the flight duration. Story films (R9): shots tile each film on whole frames, captions sit inside their shots and stay long enough to read, every cue sound and flag exists, one chapter card per planet and one reveal per boss, and the rendered films match the data (SPEC-021).
- **Campaign simulation** test: drives the mission runtime and economy with a scripted main-path player and asserts every gate (flags, shield-2, fuel) is satisfiable with guaranteed rewards only.
- Manual playtest checklist per scene (desktop keyboard/mouse + mobile touch).

---

## 12. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Scope creep (biggest risk) | Data-driven content, hard milestone gates; M3/M4 are the proof-of-fun checkpoints |
| Mobile perf with Three.js | Pooling, instancing, quality presets from day one (M0); perf budgets in [SPEC-015](https://github.com/mdzunic/reallm-specs/blob/main/specs/015-mobile-performance-pwa.md) |
| Post-processing and PBR cost on phones (R6) | The pure quality plan of SPEC-017 gates everything: composer off on `low`, ¼-res bloom + FXAA on `medium`, shadow map on `high` only, no half-float → direct path; the cut order under a regression is grain → FXAA → bloom mips → post off, each one field |
| First-person feel without complex physics | Rail flight model only; cockpit HUD sells immersion |
| Asset consistency | One generator library (`scripts/assets/blender/lib/`) builds every model in the same low-poly bevelled style with shared palettes, and one lighting/grade pipeline renders everything, so the salvager, ships, props and the procedural enemies read as one world (R6, R7) |
| Save loss on iOS (7-day eviction, private mode, quota) | Export/import code, `.bak` slot, `persist()`, PWA install prompt, graceful "storage unavailable" mode |
| Fresh tooling (Vitest 5 is 3 days old; TS 7 just shipped) | Pin Vitest 5 with the 4.1 fallback documented; stay on TS 6.0 until M7 |
| Skeletal animation cost on mobile | Only the player + escort NPC are skinned; enemies use procedural transform animation |
| Meta twist undercuts the salvage fantasy or lands as a cliché | Surface fiction stays coherent on its own; the truth arrives in optional logs and ARIA's slips; no fourth-wall UI tricks outside the two endings |
| Story films outgrow the precache or fail to decode (R9) | H.264 MP4 at 960 × 540 with no audio track, a per-film rate cap (44 KB/s) and a 12 MB `films/` budget inside the 25 MB precache, checked by the build and a test; a film that will not play drops to its posters and then to text, so a codec gap costs pictures, never progress |
| Detonation and jump flashes (photosensitivity, R9) | Flashes are authored as slow ramps; the film build measures every rendered frame against the three-flashes rule and fails on a violation; reduce motion shows posters only |
| The films give the twist away (R9) | The prologue and interludes stay inside the surface fiction (a card numbered 62, a stutter of static at most); only the ending films show the scaffolding — the endings already own the fourth wall |

---

## 13. Edge-case register (decisions)

Each entry names the owning spec. "Casual" = casual difficulty.

| # | Situation | Decision | Spec |
|---|---|---|---|
| E1 | Player can't afford fuel to any unlocked planet | On entering the station, `oil = max(oil, cheapest unlocked jump)`; ARIA line "Earth Command wired an emergency ration". Boss missions also grant a refuel voucher | SPEC-010 |
| E2 | Player spent all tokens and can't meet the shield-2 gate | Completed missions replayable at 50 % rewards; invariant guarantees worst-case tokens ≥ loadout | SPEC-010 |
| E3 | Cargo full during a collect objective | Base cap 400 ≥ any objective; pickups stop with a "CARGO FULL" toast; invariant tested | SPEC-010 |
| E4 | Death on the surface | Respawn at pad, full HP, 2 s invulnerability, −10 % carried resources (0 % casual), timed/escort/defend stages restart, enemies within 40 m of pad despawn, boss resets | SPEC-012 |
| E5 | Death in flight | Emergency recall to station; fuel lost; cargo kept; flight mission stage resets | SPEC-013 |
| E6 | Tab hidden / phone locked mid-combat | Loop pauses, audio suspends, accumulator reset on resume (no catch-up), best-effort save on `pagehide` | SPEC-002, SPEC-007 |
| E7 | WebGL context lost (iOS memory pressure) | Pause + overlay; on restore, renderer re-inits; if not restored in 5 s, offer reload (save is at last safe point) | SPEC-002 |
| E8 | localStorage unavailable/quota exceeded/corrupt | Boot in "no-save" mode with a warning; quota → drop `.bak` and retry once; corrupt → offer `.bak` or reset; export code always available | SPEC-007 |
| E9 | Save from a newer app version | Refuse to load; show version + export option | SPEC-007 |
| E10 | Stuck keys after alt-tab / focus loss | `blur` and `visibilitychange` release all actions; `pointercancel` releases touch | SPEC-005 |
| E11 | Multi-touch: joystick + fire simultaneously | Per-pointer ownership by `pointerId`; left zone = move, right zone = aim/fire | SPEC-005 |
| E12 | Flight kill objective not met at arrival | Landing blocked until the arrival wave is cleared ("can't land with hostiles on our tail"); waves spawn ≥ 2× required kills | SPEC-013 |
| E13 | Escort follower dies / defend POI destroyed | Stage restarts (follower respawns at `from`, POI HP refills) with a toast; no mission failure state | SPEC-012 |
| E14 | Kill objective but the enemy type doesn't spawn nearby | Spawn director triples the weight of objective enemies and guarantees one spawn per 20 s | SPEC-012 |
| E15 | Boss fight during a storm | Boss arena suppresses weather; forced mission weather ends when the boss stage starts | SPEC-012 |
| E16 | Deliver objective with insufficient held resources | POI shows "need N more"; player can leave and return; delivery consumes resources atomically | SPEC-012 |
| E17 | POI unreachable due to procedural obstacles | Layout keeps a clear corridor (8 m) from the pad to every POI and re-rolls the sub-seed if flood-fill fails | SPEC-012 |
| E18 | Player accepts several missions on one planet | All accepted missions for the planet are active in parallel; HUD tracks one pinned mission; counters are per mission | SPEC-012 |
| E19 | Reload mid-mission | Active missions persist with stage + counters; timed objectives restart from 0 | SPEC-007, SPEC-012 |
| E20 | Level-up during combat | Tokens/HP apply immediately; toast only (no modal) | SPEC-010 |
| E21 | Audio blocked until user gesture (iOS) | Boot shows "Tap to start"; the tap unlocks audio, requests wake lock, and (Android) fullscreen | SPEC-006 |
| E22 | Portrait phone | Rotate prompt in gameplay scenes; menus stay usable | SPEC-015 |
| E23 | 120 Hz displays / very slow frames | Fixed 60 Hz update, max 5 steps per frame, frame delta clamped to 250 ms | SPEC-002 |
| E24 | Both endings in one save | Impossible by design; `campaign_done` locks `c6_m2`; free roam continues | SPEC-009, SPEC-012, SPEC-024 |
| E25 | Inventory full on gear drop | Gear stays on the ground 60 s with a toast; resources have their own cap | SPEC-011 |
| E26 | Story flag or item referenced but never defined | Content-invariant test fails CI | SPEC-009, SPEC-016 |
| E27 | A story film is missing, fails to load or will not decode | The player drops to the film's posters, then to text (shot descriptions and captions); nothing waits more than 4 s, and progress never depends on a film | SPEC-022 |
| E28 | Tab hidden or phone locked during a film | Video, clock and cues pause; a Resume tap or key restarts them (and re-arms audio on iOS); nothing resumes on its own | SPEC-022 |
| E29 | Reload or crash during a film | The prologue and a departure are not replayed; an interlude replays at the next station entry (its `interludeN_seen` flag is set only when it ends or is skipped); an unfinished ending replays at the next station entry (`endingSeen`) | SPEC-023, SPEC-024 |
| E30 | Several interludes due at once (an older save) | Only the newest plays; every pending one is marked seen | SPEC-023 |
| E31 | Death in a boss fight, then back into the arena | The reveal plays once per boss per session; the respawned boss fights at once | SPEC-023 |
| E32 | A boss mission replayed at 50 % | No interlude: interludes follow the chapter flag, which only the first completion sets | SPEC-023 |
| E33 | Fire key (Space) held or a double tap as a film or reveal starts | Space never skips; Escape or Enter skip only as fresh presses after 0.6 s; Skip ignores taps in the first 0.3 s | SPEC-022 |
| E34 | Portrait phone during a film | The film letterboxes and plays; the rotate prompt waits for gameplay | SPEC-022 |
| E35 | Photosensitive viewer | Authored flashes ramp up over ≥ 4 frames and down over ≥ 12; the build fails a film with more than three flashes in any second; reduce motion never shows a flash | SPEC-021, SPEC-022 |

---

## 14. Spec index

See the roadmap [SPEC-000](https://github.com/mdzunic/reallm-specs/blob/main/specs/000-roadmap.md) in the reallm-specs repository (local checkout: `../reallm-specs/specs/000-roadmap.md`). Each spec is a factory work order `specs/NNN-slug.md` with `id: SPEC-NNN` in its frontmatter; the GitHub Issue that triggers its build carries the same id in its title. Old two-digit spec numbers map to SPEC-(NN+1); SPEC-000 is the roadmap. Build order follows `depends_on` (a topological sort listed in SPEC-000), not the milestone numbers, which remain the playable checkpoints.
