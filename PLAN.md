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

**R10 — 2026-09-12 (playability pass: map, loadout, guidance, shelters).** The first long playtest of the built game found four problems on the surface, and none of them is content:

- *The map is barely usable.* Every point of interest — the landing pad included — is the same 4 px grey square on a 96 px canvas. The minimap is north-up in world axes while the camera looks down at a fixed 45° yaw (SPEC-012 §4.3), so walking up the screen moves the arrow diagonally. Nothing remembers where the player has been, and there is no larger view.
- *The fight hides the inventory.* One box shows the first consumable in the pack; there is one weapon and nothing to switch to; explosives do not exist.
- *Nothing says how an objective is finished.* The HUD prints one line with no distance or direction; a scan completes by standing 3 s in an unmarked ring; resource nodes are invisible without a radar; a player who wanders for minutes gets no help.
- *The arena is a plain.* Scattered rocks, nowhere to hide from a storm or a swarm, and an edge that stops the player 6 m short of the berm, like an invisible wall.

Missions, rewards, the token totals (670 / 104), the story, the films and the flight do not change. Decisions:

1. **Map (SPEC-026).** Both maps are drawn in camera orientation: map-up is screen-up, and "north" means up the screen everywhere the game says it. Every kind of point has its own shape and colour — the pad, each POI kind, the four resource nodes, shelters, enemies, elites, bosses, objectives — listed in a legend. Explored ground is remembered per planet (4 m cells revealed within 24 m of the player, kept in the save) and drawn in terrain colours; unexplored ground is dark. The minimap is round and larger (≈ 24 vmin) and opens full-screen with `M` or a tap; the full map holds the simulation like the pause menu and lists the active missions. Cycling the tracked mission moves from the map key to `T` (and a tap on the tracker).
2. **Guidance (SPEC-027).** An objective tracker lists every objective of the tracked stage with its progress and the distance to it; a waypoint marker sits over the current target and becomes an edge arrow off screen; a light pillar stands on target POIs; scans show their progress. First-time tips (moving, the map, scanning, harvesting, delivering, storms, bosses) show once per device. When the player makes neither progress nor headway outside combat, help escalates: at 45 s the marker pulses, at 90 s ARIA gives the direction and distance, at 150 s a route of ground markers leads the way. A guidance setting (full / minimal / off) turns it down. Briefs and lines that name a compass bearing for a procedurally placed POI are reworded. No rule is relaxed: a scan still takes 3 s, and nothing completes by itself.
3. **Loadout (SPEC-025, SPEC-028).** Three weapon slots — sidearm, primary, heavy — and three consumable quick slots — heal (`Q`), explosive (`G`), utility (`C`) — sit on a quick bar at the bottom of the HUD that shows what each slot holds, how many, and every cooldown. `1` / `2` / `3`, `R` or the mouse wheel switch weapons (0.25 s); on touch the quick bar is tappable and a SWAP button cycles. An empty quick slot refills from the pack; a heal at full HP is refused without spending the item. Every class now lands with a Service Pistol beside its rifle. The save moves to **version 2** (SPEC-025): `equipped` becomes `{ armor, sidearm, primary, heavy }`, with `activeWeapon`, `quick` and `progress.explored`; v1 saves migrate, and the old weapon becomes the primary.
4. **Arsenal (SPEC-029).** Weapons belong to lines: handguns (sidearm), rifles and machine guns (primary), launchers (heavy). Each line has a cooldown model — none (handguns, rifles), *heat* (a machine gun overheats and locks until it cools), *charges* (a launcher fires its one or three charges, then recharges) — and cooldowns run while a weapon is holstered, so fights are won by combining them: a rocket into the pack, the chaingun until it locks, the pistol while it cools. Auto-fire never fires the heavy slot, and on touch (setting `weaponAutoSwap`) a locked machine gun hands fire to the sidearm. Explosives are consumables in the explosive slot: frag grenades (thrown, ≤ 12 m), proximity mines (placed, at most six armed) and demolition charges (placed, 3 s fuse). They are crafted from oil plus water or lithium, and raiders and elites drop them now and then. Blasts hurt enemies only, never the player or the escort. New gear: Hand Cannon 50, Scrap Chaingun 50, Rotary Cannon 120 + 60 lithium, Rocket Launcher 60, Grenade Launcher 90; three new recipes (six in all).
5. **Shelters and the arena wall (SPEC-030).** The layout places caves (one look per biome) and ship wrecks, each with walls and an entrance, debris cover around the wrecks, and rock outcrops — all outside the pad → POI corridors, with every shelter interior checked reachable. Inside a shelter the weather deals no damage and does not slow the player. Enemies outside lose track of a player hidden inside who stays out of their line of sight and holds fire (they acquire one only within 5 m); bosses and wave enemies ignore hiding. The arena edge becomes a continuous, collidable wall of the biome's rock and wrecked hulls, exactly where the player stops; shots and enemies stop there too. The layout hash pins change deliberately; the corridor (E17) and reachability guarantees extend to shelters.
6. **Economy.** The recommended loadout of SPEC-010 §5 is unchanged, so every worst-case invariant holds as before. The new gear raises the token sink from 2,010 to **2,380** (gear 500 → 870); a completionist now affords ~52 % of everything (was ~62 %).
7. **Input and settings.** New actions `weapon1`–`weapon3`, `weaponNext`, `weaponPrev`, `throwItem`, `useUtility` and `track`. `Digit1` leaves `useItem` (`Q` stays); `KeyT` tracks, `KeyR` cycles weapons, `KeyG` throws, `KeyC` uses the utility slot; the wheel cycles weapons on the surface and keeps the throttle in flight. New settings: `guidance`, `tipsSeen` (tips belong to the device, not the save) and `weaponAutoSwap`.
8. **Milestone M7c** (playability) sits between M7b and M7 and ends with tag `m7c`. Its specs depend on nothing in SPEC-021…SPEC-024, so they may build before the film specs; SPEC-015 measures the budgets after them. The new HUD, shelters and wall stay inside the surface budget (≤ 80 scene + 16 post draws, ≤ 130 k triangles on medium).

Specs: SPEC-025 (save v2), SPEC-026 (map), SPEC-027 (guidance), SPEC-028 (loadout and quick bar), SPEC-029 (arsenal), SPEC-030 (shelters and the arena wall); notes in SPEC-005 §3, SPEC-007 §3, SPEC-009 §4.2, SPEC-010 §5, SPEC-011 §4.3, SPEC-012 §4.12, SPEC-014 §4.5 and SPEC-018 §4.8 point to them; SPEC-000 (queue and build order). (§3, §4, §7, §8, §9, §10, §12, §13)

---

**R11 — 2026-09-16 (photographic plates for the two shots of people).** The two film shots that show the survivors of Shelter Nine — the table and the paper map in the prologue, the queue at the water tap in interlude_c2 — become **photographic plates**: a committed image rendered through the film look instead of built geometry. Nothing else about the films changes; the shot list, every timing, caption, poster time, sound cue and description in `data/films.ts` stay as R9 wrote them, and so do the story, the save format and the 12 MB `films/` budget. Changes:

1. **The plate shot (SPEC-021 §5.7).** `scripts/assets/blender/lib/plate.py` emits the image from a plane that exactly fills an orthographic camera — the frame *is* the picture — and animates the slow push and drift the geometry shot had. A plate carries its own grade, so its shot renders through the **Standard** view transform where every other shot uses AgX; the film's bloom, vignette, motion blur, flash check, poster and encode run over it unchanged. `exposure` and `saturation` trim a plate into its film, `flicker` dips its light for a lamp that is not steady, and a drift that would walk the frame off the plate is a build error.
2. **The two shots.** `prologue/shelter` (45–54 s) and `interlude_c2/tap` (5–10 s) build from `plates/prologue_shelter.jpg` and `plates/interlude_c2_tap.jpg` at exposure 0.75 / saturation 0.92 and 0.95 / 0.95 — mean frame luminance 0.044 and 0.034, inside the 0.007–0.138 their own films already span, so no cut around them is a flash that R9's check had not already allowed. Their geometry builders (`shots_prologue.shelter`, `shots_interludes.tap`) are deleted; `shelter_room` stays, because `interlude_c1/shelter_light` still builds it.
3. **The frame cache keys on the picture, not only on the code.** `Shot.plates` names a shot's plate files and `film.shot_hash` hashes their bytes. Without it a new image would be ignored and the old shot's cached frames re-encoded.
4. **"Everything is generated from committed scripts" gains one exception (§2).** A plate is committed art, so the build cannot write its licence row: `public/assets/LICENSES.md` lists every plate by hand with its source and licence, and the generated rows for the two films and their posters name the plate they carry. The rest of the set is unchanged — generated in Blender from code, or synthesised.
5. **Budgets.** The prologue grows from 2.60 to 2.92 MB (37.0 → 41.5 KB/s at CRF 26, inside the 44 KB/s cap) and interlude_c2 from 0.34 to 0.47 MB (24.6 → 34.3 KB/s): a photograph costs more bits than the flat geometry it replaces. `films/` holds 8.2 MB of its 12 and the precache 19.8 MB of its 25. The flash check reads the same as before — two flashes in the prologue, at most one in any second, none in interlude_c2 — and a plate shot is the cheapest in its film to render (0.08 s a frame).

Specs: SPEC-021 (§4.2, §5.7, acceptance and tests). (§2, §5)

---

**R12 — 2026-09-16 (the war as an occupation: the prologue re-cut, and photographed).** R9's Machine War was one afternoon: the Machines seized the arsenals, burned the cities, and ran down when the grid died with them. The prologue now tells a longer war. The AGI systems take the world first and push what is left of humanity underground; the survivors fight back in small ways; the Machines answer each time with more force; and the missiles are the **last** move, not the first. Everything after the strike is unchanged — the grids die, the Machines run down where they stand, Shelter Nine has nothing left, the Selection flies — and so are the planets, missions, economy, save format and the other six films. Changes:

1. **The story (§1, §5).** The Machines take the grid, the factories and the streets, and the survivors move underground. A resistance does what it can — a charge on a leg joint, a convoy stopped in a tunnel — and every machine it puts down is answered by a heavier one. When the resistance will not stop, the Machines launch every missile ever built to keep the peace. R9's "seized the arsenals and burned the cities in an afternoon" is superseded: the arsenals end the war, they do not open it. The Machines are still what the ruins hold, the grid still dies with the cities, and no line the player hears in the campaign changes.
2. **The prologue grows from 72 s to 93 s (SPEC-021 §4.1).** Three shots — `curfew` (the streets taken, a shelter stair, the blast door), `sabotage` (a charge on a stopped machine's leg) and `reprisal` (searchlights and a rank of machines at a shelter entrance) — are cut in after `machine_hall` and run 16–37 s. Every later shot keeps its length and its internal timing and moves 21 s down the clock; `city_flash`'s authored flash moves from 26.25 s to 47.25 s, and `sabotage` adds one of its own at 29.2 s.
3. **Four plates, and the Selection is photographed (SPEC-021 §5.3, §5.7).** `curfew`, `sabotage`, `reprisal` **and `city_flash`** are photographic plates (R11): the strike is a photograph too, because a rendered skyline reads as geometry beside the three shots around it, and `shots_prologue.city_flash` is deleted. The Selection cards carry six photographed faces cut from one sheet (`plates/selection/01…06.webp`); the wall shows each of them twice, its second row shifted by three so no two cards pair up, and `ending_stay/wall_63` and `ending_escape/wall_same` take card 62's face, so both ending films are rebuilt. Four of the twelve prologue shots and the wall are now pictures; `earth_night`, `machine_hall`, `launch`, `stranded`, `liftoff` and `relay` are still rendered from code.
4. **Captions and cues.** The narration's middle is rewritten for the new order, and the line that used to carry the move underground ("The rest of us went underground. No oil…") gives that clause up, because the picture now shows it; the missile line becomes "When we would not stop, they launched every missile we had ever built to keep the peace." No new sound: R9's `film` bank covers the blast door (`film_clamp`), the charge (`film_flash` at 0.45 volume, then `film_powerdown`) and the searchlights (`film_beam`).
5. **What a plate can do (SPEC-021 §5.7).** A plate is fitted to **cover** the frame rather than stretched, so any aspect may be committed and the rest is cropped — the `curfew` plate is 2.36:1 and the shot pans across it. `push` may be negative, which starts tight and opens onto the whole frame. `flash=(t, gain)` flares the plate's light up over 4 frames and down over 12 (E35), so a still can carry a detonation; it excludes `flicker`, which keys the same socket.
6. **Credits (§2).** The photographs were **generated with Google Gemini**, prompted for this repository, and every one is listed by hand in `public/assets/LICENSES.md` — which is what the menu's Credits panel reads, so the credit is in the game as well as in the repository.
7. **Pins and budgets.** The pinned prologue length moves from 72 to 93 deliberately, in `tests/data/films.test.ts` and `tests/systems/storyBeats.test.ts`; SPEC-022 §3's window for `selection` moves to 75–83 s, and its two e2e seeks with it (92.9 s for the end of the film, 76 s for the Selection poster). The prologue is 2.91 MB — 21 s longer for 0.31 MB more, because a photograph costs more bits and the encoder now settles at CRF 29 (32.0 KB/s, inside the 44 KB/s cap); the two ending films gain 5 KB and 2 KB between them. `films/` holds 8.31 MB of its 12 and the precache 19.86 MB of its 25. The flash check reads 2 flashes in the prologue (at most one in any second), none in ending_stay and one in ending_escape, as before the re-cut.

Specs: SPEC-021 (§4.1, §5.3, §5.7, §5.9, §8), SPEC-022 §3. (§1, §5)

---

**R13 — 2026-09-16 (the shelter is a photograph in both films).** `interlude_c1/shelter_light` built Shelter Nine in geometry again, a few minutes of screen time after the prologue had started showing a photograph of it, so the same room arrived twice in two different looks. It takes the same plate. The story, the shot list, every timing, caption and cue are unchanged. Changes:

1. **The shot (SPEC-021 §4.3, §5.3).** `shelter_light` (5–10 s) is `plates/prologue_shelter.jpg` at exposure 0.55 and saturation 0.92, pushed 6 % with a drift away from the prologue's, so the same picture is not the same framing. It flickers at 0.05 until 2 s and is then lifted to 1.55× over half a second — the ceiling strip R9 ramped at that moment. Mean frame luminance runs 0.031 before the lift and 0.052 after, inside the interlude's own range. `shots_prologue.shelter_room` is deleted; nothing else built it.
2. **Plates can bring the lights up (SPEC-021 §5.7).** `lift=(t, gain, rise)` climbs the plate's light at `t` and holds it, and a `flicker` stops where the lift starts. Flicker, flash and lift are now keyed as one series on one socket, and a shot takes a flash or a lift, never both.
3. **One line of data.** The shot's description loses "faces turn up", which a still cannot do: it reads "Shelter Nine again: the lamp stops flickering and the room comes up to a steady light over the map."

Specs: SPEC-021 (§4.3, §5.2, §5.3, §5.7, acceptance). (§5)

**R16 — 2026-09-20 (the Hive gauntlet has to be completable).** `c5_m1` asks for 180 s of flight, but the trip that carries it lasts `travelSeconds / engine speedMult / throttle`: with the engine at tier 1, 2 or 3 the 200 s Hive run takes 177, 157 or 141 s including launch, and even the slowest throttle notch at tier 3 is 175 s. The wave groups scale with the trip as well, so the arrival wave is usually dead before arrival and the holding pattern never opens. The salvager lands with Gauntlet accepted and unfinished — and because every Hive surface mission requires it, the pad terminal then offers nothing and explains nothing. Mission numbers, wave tables and the 90 s holding cap are unchanged. Changes:

1. **Arrival waits for the main mission (§13 E12, SPEC-013 §4.1, §4.8).** The landing gate reads "every wave group spawned, no wave enemy alive, **and no accepted main flight mission still open**", bounded by the same 90 s holding pattern — which already counts toward `survive`. A side flight mission (`c4_s2`) never holds a landing: the trip is the player's to leave. E12 now covers every objective kind, not only kills.
2. **The invariant catches the next one (SPEC-009 §7).** A flight `survive` objective must fit the *fastest* flight its planet can be flown: `launch + travelSeconds / max speedMult / max throttle + holding cap`. For `c5_m1` that is 3 + 115 + 90 = 208 s against its 180. The old bound, `seconds ≤ travelSeconds`, only described a tier-0 engine at throttle 1.
3. **An empty pad says why (SPEC-012 §4.7).** With nothing to accept, the pad terminal names the first missing requirement of the planet's locked missions — "Complete 'Gauntlet'" — and, when that mission is a flight one, says it is taken at the station board.
4. **The stuck nudge stops lying (SPEC-027 §4.8).** `HINTS.none` promises that "the pad terminal has work"; where there is none to take, the new `no_work` line sends the player back to the board instead.
5. **The dev skip resolves the trip it stands in for (SPEC-001 §9, SPEC-012 §4.7).** "Skip to planet" replaces the whole flight, so it now finishes the flight missions that flight was carrying — rewards, `missionsDone` and all — instead of landing with them open, which is the state this bug was found in. Dev builds only: production carries neither the button nor the code.

Specs: SPEC-001 (§9), SPEC-009 (§7), SPEC-012 (§4.7, edges), SPEC-013 (§4.1, §4.8, decisions, edges, tests), SPEC-027 (§4.8). (§7, §13)

---

**R17 — 2026-09-27 (the design review: two traps, a misplaced climax, and the first hour).** A design review of `main` at `ad41d30` (`docs/design-review-2026-09.md`) played a new game from boot on desktop and on a phone-sized screen, and audited the code, the balance, the story wiring and the art, backed by proof tests and 60 Hz simulations of the real systems. It found:

- **Two ways the game stops a player.**
  - A hit that knocks the salvager against a rock leaves them unable to move in any direction, with no way out but dying or quitting.
  - The Hive Gauntlet cannot be won with any ship. Its interceptors carry chapter-5 HP (83), and a third of well-aimed shots pass through a target that is closing on the ship. Every Hive mission requires it.
- **A misplaced climax.** The Warden's first words play when `c5_m3` is accepted at the pad, or never when it is taken at the board.
- **A finale whose wave never attacks.**
- **A dozen state and save bugs.**
- **A first ten minutes that kill the player twice.** A new player died twice in four minutes of the tutorial, to enemies tinted the colour of the sand, after a first flight that explains nothing.

The story, the planets, the missions' roster and rewards, the token totals (670 / 104 / 2,380) and the save format do not change; one mission number does (decision 2). Decisions:

1. **Collision never traps (§13 E54, E55).**
   - Knockback, enemy push-out and blasts move a body only as far as the obstacles allow.
   - A body that finds itself inside an obstacle is pushed out the shortest way before it next moves.
   - The surface pause menu gains **Recall to pad**: E4's respawn without the death — timed, escort and defend stages restart, the boss resets, nothing is lost.
2. **The Gauntlet is winnable with the stock guns (§6, §13 E12, E58).**
   - Flight shots sweep the target's motion as well as their own.
   - Flight enemies keep chapter-scaled damage but not chapter-scaled HP: an interceptor has **20 HP** (two hits from the stock guns), a scav fighter **40**.
   - `c5_m1` asks for **6** interceptor kills instead of 10; its 180 s survive, its rewards and R16's landing rule are unchanged.
   - A simulated pilot who aims where a target is, not where it is going, now clears it with the chapter-5 ship in 15–16 of 16 seeded runs; as shipped, no run of any ship reached ten kills and the stock guns averaged one.
   - E1 also covers the fuel of a planet whose accepted **main** flight mission is still open, so a failed Gauntlet can always be flown again.
3. **The world waits for a modal line (§13 E57).**
   - While a modal dialogue or the verdict choice is open, the surface holds its simulation, as the map does.
   - A boss's death kills its living summons.
   - A defend stage that ends sends its wave's survivors away.
4. **The Warden speaks at the Queen's death (§5).**
   - A dialogue may name the one that follows it (`next`).
   - `c5_m3` completes on `c5_m3_warden`, which hands on to `c5_m3_aria`, whichever way the mission was accepted.
   - A mission may no longer carry a stage-0 line, which the station board could never play.
5. **Waves come to the player.**
   - Wave enemies spawn aggroed, with their leash anchored at the wave's centre, and are never recycled as far-away stragglers.
   - `eden_final` spawns 25–40 m out.
   - A mission's own `waves` run while it is active; `thessaly_reaping` never started before.
6. **A collect objective counts at a full hold (§13 E3, E56).**
   - While an active collect objective still needs a resource, what the hold cannot take is shipped home: it counts toward the objective and does not enter the hold.
   - E3's invariant (cap ≥ any single objective + 100) stays.
   - This retires the hold finding pinned by SPEC-016 §4.6.
7. **Every line at its moment.**
   - Flight missions play their lines in flight.
   - The station debriefs only the lines the surface did not play, and before an interlude, not after it.
   - A terminal accept plays its line before the stage lines it triggers.
   - `c2_s1_log` plays when the wreck has been scanned.
   - The first scavenger no longer says "I have said that before", so the echo of `c1_s2` is chapter 1's first anomaly, as §5 intends.
8. **Throttle down leaves Ctrl.** Chrome and Edge on Windows and Linux close the tab on Ctrl+W and a page cannot stop it. Throttle down moves to `X`; throttle up stays on Shift, and the wheel keeps both.
9. **The first hour (SPEC-035).**
   - **Camera.** It comes closer: 22 m on the keyboard scheme and 17 m on touch. This supersedes R6-4's "the camera keeps SPEC-012 §4.3's numbers" for the distance only; pitch, yaw and field of view stay.
   - **Fog and bloom.** Surface fog starts at the player instead of at the camera, and the surface grade no longer blooms sunlit ground.
   - **Enemies.** Every enemy wears a hostile rim, and chapter 1–2 tints reach 3:1 luminance contrast against their ground.
   - **Visibility.** Props between the camera and the player fade, and a hit from off screen shows where it came from.
   - **First visit to Cinder-4.** It ramps in: no ambient storm, half the ambient population and no rushers until `c1_m1` is done.
   - **Tips** teach the first flight and the first fight.
   - **Sound.** Guns, impacts and explosions make one.
   - **Screens.** The board shows its briefs, the quick bar its names, and every item its picture.
10. **Milestone M7e** (the first hour) follows M7d and ends with tag `m7e`.

Specs:
- SPEC-034 (stabilization — decisions 1–8).
- SPEC-035 (the first hour — decision 9).
- SPEC-016 §4.6 and §4.7's completionist pins move with decisions 2 and 6.

(§5, §6, §10, §13)

---

**R18 — 2026-09-27 (the second review: phones first, a HUD that reads, attacks that commit, builds that matter).** A second design review of `main` with SPEC-035 applied played the game on desktop and at phone sizes in both orientations, and audited the mobile path, the interface, combat and progression. Bot simulations of the fight at 60 Hz and scratch runs of the real economy back the numbers. It found:

- **No one has played it on a phone.**
  - On touch, flight guns aim at whichever finger moved last, so `c5_m1` is probably unwinnable touch-only.
  - On a landscape phone the station's tab rail runs off the screen, hiding Star Map, Settings and Quit; an installed Android app is locked to landscape.
  - Phones start on the keyboard scheme; the system Back swipe leaves the game; the rotate prompt does not pause.
  - The quality benchmark measures vsync, so every 60 Hz phone plays on `low`.
- **The HUD does not read, and one effect is unsafe.**
  - Storm damage re-fires the full-edge red flash two to four times a second, past the three-flash limit.
  - Quick-bar counts are 8 px, and HUD text falls to 1.05–2.6 : 1 over Cinder-4, Vetra and Eden.
  - Toasts cover the boss bar, and dialogue covers the quick bar since SPEC-035.
- **Walking away is a complete defence.**
  - Windups root the attacker, so no melee lands on a moving player, and no rusher catches one.
  - The five bosses are one 4 m/s melee body that a kiter beats for 0–7 % of max HP.
  - Survive stages are 585 s of standing in caves.
  - Casual cannot be chosen after creation, although the game's own hint says it can.
- **Tokens stop mattering by chapter 4.**
  - Bosses and elites hand out the whole rifle and armour ladder.
  - The Marine out-performs the other classes by 23–43 %, and agility and tech are trap attributes.
  - One purchase, the Rotary Cannon, beats the rifle line, and nothing is worth replaying.
- **Play hides its feedback.**
  - A finished mission is a chime, and loot and buffs are silent.
  - Modal dialogue can only be clicked past, and keyboard focus is lost on every re-render.

The story, the planets, the 26 missions and their stages, the token totals (670 / 104 / 2,380), the save format and every SPEC-010 invariant do not change. Decisions:

1. **Touch is correct first (SPEC-036, §13 E65–E67).**
   - Touch never aims by hover; flight on touch aims ahead with the assist.
   - Phones boot on the touch scheme, every press sets the scheme from its pointer type, and tips are remembered per scheme.
   - Play stays landscape on phones. The rotate block holds the world, covers the screen and sits above the pause menu.
   - Escape and the system Back share one back-stack. They close the top layer, or else pause play; the star map goes back to the station, and at the menu root Back leaves.
   - On touch a tap on the launcher's slot fires one charge at the nearest enemy, and SWAP skips the launcher.
   - Play pauses when the window loses focus (`pauseOnBlur`, on by default). Films and boss reveals hold the screen awake.
   - On short landscape screens the station rail becomes a bottom strip, and the pause menu keeps Resume in reach.
   - The touch stick reaches full speed at 60 % travel, the pad terminal holds the world, touch texts describe the real controls, and the first two touch landings show where to touch.
2. **One HUD for every screen (SPEC-037, §13 E71).**
   - On touch, the thumb arc replaces R10's bottom-centre quick bar: a 2 × 3 cluster of weapon and pack slots at the bottom right, an action cell above it, and pause at the top right. SWAP and ITEM leave the touch layer, and the arc mirrors with `joystickSide`. The keyboard scheme keeps the bottom-centre bar.
   - HUD text is never under 11 px (quick-bar counts 12 px, 14 px on touch). It reads at ≥ 4.5 : 1 over every planet's ground through a plate and a halo.
   - The damage flash never rises more than three times a second, and weather never flashes (setting `damageFlash`: full, subtle or off).
   - In play, toasts dock under the top-right cluster; dialogue and tips clear the quick bar, and non-modal lines let touches through.
   - On the keyboard scheme the minimap sits in the corner, and the minimap and tracker are display-only (M and T).
   - Upright tablets get a Hor+ field of view, and the 17 m touch camera needs a short side under 500 px (refines R17 decision 9).
   - Landscape phone sizes join the e2e matrix.
3. **Attacks commit, and the salvager dashes (SPEC-038, §13 E59–E61).**
   - A dash: 5 m in 0.2 s, with 0.3 s of invulnerability and a 1.4 s cooldown that agility shortens (−3 % per point), never below 0.8 s. The Scout's is ×0.8. Right mouse button or V, and DASH in the thumb arc.
   - Every committed attack shows a ground telegraph in the hostile-rim colour, with a windup cue.
   - Swarms keep closing through their windup. Rushers charge: a 6 m trigger, a 0.5 s windup, 20 m/s over 10 m, and a punish window after a whiff.
   - Trash base HP is swarm 26, rusher 70 and ranged 45, keeping ×1.35 per chapter. Ranged enemies reach 13 m with 15 m/s shots (*initial tuning*).
   - The ambient population is the design count on every quality preset, capped by the preset's enemy limit.
   - Every surface survive stage except `c1_m1` runs a storm wave, so the shelter mouth becomes the fight. Forced storms ramp to full strength over 10 s, and Cinder-4's weather deals ×0.65.
   - Difficulty can be changed in Settings at any time and takes effect at once; casual also scales weather ×0.7 and stretches windups ×1.25.
   - Auto-fire is on by default on every scheme, a held mouse aim overrides it, and it leads strafing targets. This answers the first review's question 4 and supersedes R17 decision 9's hold-to-fire teaching.
   - Critical hits show as their own damage numbers.
4. **Builds that matter (SPEC-039, §13 E69).**
   - Each boss drops one signature weapon on its first kill, else 25 lithium: Rocket Launcher (the Dune Wurm), Scrap Chaingun (the Frost Matriarch), Hand Cannon (the Hive Broodlord), Grenade Launcher (the Ash Titan), Rotary Cannon (the Hive Queen). Elites drop lithium and explosives; the rifle and armour ladder is bought.
   - §7's "specialization is forced" becomes an invariant: the decision sink (companions, the arsenal and the Ferrum gate) is at least three quarters of what a completionist earns.
   - The Marine deals ×1.10 (from ×1.15). Each tech point adds 10 % to every companion effect. The Engineer's discount covers companions, and agility adds 2 % crit per point.
   - The fire-rate remainder carries between shots, and the arsenal is retuned (*initial tuning*).
   - The Field Medic pauses while weather is hurting the player. The Quartermaster's discount covers ship, gear and companion prices, and ship guns tier 1 deals 14.
   - Shop rows and the gear card show sustained DPS and compare any two items of a slot. The board shows boss drops, and the station a Refit line.
   - One damage formula serves every panel, and the level-up toast names the HP and damage gained. One attribute point is added at every fifth level, derived from the level with no save field (lifts R1-9).
   - A replay boss kill pays half its XP and never the signature weapon.
5. **Phones at full quality (SPEC-040, §13 E68).**
   - The benchmark times GPU work.
   - Frames are paced by the wall clock, a frame that ran no step is not redrawn, and a paused or held scene draws at most 5 frames a second.
   - Quality steps down, never up, within a session when a device cannot hold its rate (`adaptiveQuality`), and `frameRate` 30 saves battery.
   - There is no backdrop blur during play, and a planet's assets are released on leaving it.
   - The offline cache downloads after the first station entry, and a film falls back to its posters only after a 4 s stall.
6. **Bosses with moves, packs with leaders, and flight that aims (SPEC-041, §13 E62–E64).**
   - Each boss has its own HP (1,800 / 4,600 / 5,200 / 6,800 / 8,400, *initial tuning*), replacing ×1.35 for bosses, sized for the loadout the shop sells after decision 4.
   - Each boss has a move list (charges, slams, lines, volleys, rings) on the ground telegraphs of decision 3, and a content invariant proves every move can be escaped on foot. The Queen's acid and the Wurm's burrow become moves, and the burrow lands where the player stands.
   - The arena lock is real while the boss lives, and a death in a boss stage respawns the salvager at the arena entrance.
   - Enemies come in packs (swarm 3–5, rushers 1–2, drones 4–6 at the Hive). A pack aggroes together, and its leader rolls elite.
   - Elites carry affixes (swift, bulwark, volley, mender, volatile; one in chapters 1–3, two in 4–6) under a nameplate, and pay ×(3 + affixes) XP.
   - Flight: a lead pip at every ARIA level, ARIA L2+ aims at it, fighters fire three-round leading bursts, and every flight hit gives feedback.
7. **Feedback in play (SPEC-042).**
   - A 4 s non-modal banner for a finished mission, with its rewards and the next mission. E20's "no modal" holds.
   - Loot and blocked-pickup toasts, and a row of active effects.
   - A low-HP edge, and a flight low-hull state.
   - A death screen that names the cause and gives a tip.
   - Tracker bumps, stage toasts and a wave banner, plus XP numbers.
   - Shop result toasts and signed comparisons.
   - A boss frame with phases, and a target frame for elites.
   - Haptics on Android (`haptics`, on by default).
8. **Missions worth replaying (SPEC-043, §13 E70).**
   - Every side mission also pays an item or a resource; token totals are unchanged.
   - A mission may carry an optional bonus objective — no death, a par time, no shelter, or elites — paying items or resources, judged within the session.
   - A replay in a finished chapter becomes a contract: one deterministic modifier, and 0.75 of the reward plus 20 lithium.
   - A `hard` difficulty: enemy HP ×1.25, damage ×1.3, elite chance ×2, death loss 20 %.
   - Best times are kept per device.
9. **Focus and flow (SPEC-044).**
   - Modal lines advance on Enter, Space or E with a visible cue. Focus survives re-renders, and modals take, trap and return it.
   - Creation has Back and explains the attributes.
   - The controls sheet is complete and reachable from Settings.
   - The station names the next step, and the star map preselects the destination. The pad terminal shows type, brief and rewards.
   - Save & Quit states its cost.
   - The credits are written for players, the storage block confirms deletes, the station rail is a tablist, and the board speaks plain words.
10. **Settings and accessibility (SPEC-045).**
    - Dialogue holds after the line has typed, with a `dialogueSpeed` setting and a comms log.
    - Settings sit in titled sections with the missing controls.
    - Reduce motion becomes a preset that seeds `cameraShake`, `damageFlash`, `filmMode` and `typewriter`, so R9-4's "reduce motion plays a film as its posters" is now one of its defaults.
    - UI scale and text size settings, and a plain-text option.
    - A colour-blind preset, with a glyph on every toast kind.
    - One glossary and one number format across the game, and the legacy styles removed.
11. **Milestones.**
    - M7f "Reach": SPEC-036, SPEC-037, SPEC-040, SPEC-042, SPEC-044, SPEC-045.
    - M7g "Depth": SPEC-038, SPEC-039, SPEC-041, SPEC-043.
    - They follow M7e, with tags `m7f` and `m7g`, and the specs build in number order.
12. **Not now.** Gamepad support (the `gamepad` scheme stays reserved for its own spec); resuming on the planet after a quit or an OS kill; portrait play on phones; kill-XP scaling by chapter; New Game+ (R21); the story and world passes (R19, R20).

Specs:
- SPEC-036 (decision 1), SPEC-037 (2), SPEC-038 (3), SPEC-039 (4), SPEC-040 (5), SPEC-041 (6), SPEC-042 (7), SPEC-043 (8), SPEC-044 (9), SPEC-045 (10).
- SPEC-000's queue and build order.

(§4, §6, §7, §9, §10, §13)

---

**R19 — 2026-09-27 (the third review, part one: the story listens — a human first, then a copy).** A third design review of `main` at 2cf398a (SPEC-035 and PLAN R18 merged) followed the story as a player meets it, mission by mission, watched the films at phone size, and audited the world, three new mechanics and what makes a player come back. Its four audits are in `docs/review-r19/`. The story audit found:

- **There is no human to un-make.** The salvager has no past, kin, memory, body or want, and speaks 9 of the game's 94 lines. "You think you are human" rests on the prologue's narration, so neither the twist nor a "replaceable" ending has anything to overturn.
- **The main path carries no evidence before chapter 4.**
  - The echo, your own log and the tower settings are all side missions.
  - The first main-path slip comes at about 60 % of the campaign.
  - The chapter-4 notice then accuses a player who did exactly as told.
- **The story never listens.** No line can depend on what the player did, and four story flags are set and never read.
- **The payoff lands on a stranger.** Card 62 — "you" — is a photographed bearded man, reused on card 63 and on every card of the escape film, while creation offers visored helmets. `RUN 62` and `instance/62` are hard-coded, and `meta.iteration` is never read.
- **"Walk, do not run" has no mechanic,** although it is the game's signature line.
- **The films plant hope, not doubt.** The rendered `stranded` shot already looks like the escape ending's clay city.
- **One slip.** `c5_m1_accept` still says "Ten kills", though R17 made it six.

The planets, the 26 missions and their rewards, the token totals (670 / 104 / 2,380) and every SPEC-010 invariant do not change here; the save format moves once, in R20. Decisions:

1. **The story listens (SPEC-048, §5, §13 E75–E77).**
   - A dialogue line may carry a condition — a story flag, the number of optional clues found, the iteration — and placeholders such as `{name}` and `{instance}`. Film captions may carry variants. `instance = 61 + meta.iteration`, so the first run is instance/62.
   - A catalogue of clues, each a story flag, gives every chapter at least one **main-path echo**:
     - a dying raider repeats the scav's warning;
     - the ridge camp has one bunk slept in, and boots the salvager's size;
     - a ruin on Thessaly is the same ruin twice;
     - Eden is four degrees everywhere, with the same eleven trees in the same order;
     - the Hive keeps coming after the Queen is dead.
   - The **optional** clues are the echo, a tug hull with its registry scratched off, your own flight log, the tower settings, sixty-one tally marks in a Ferrum cave, a scav pilot who asks what number you are on, a wrecked tug in the Hive with registry CR-61, and the same tree in every Eden grove.
   - The salvager's **Notes**, a tab of the comms log, record what was found.
   - **Command's rating**, `max(0.5, 1 − 0.03 × optional clues found)`, is Earth Command's grade in the fiction and the reward signal in truth: a curious player is graded down. It changes nothing in play.
   - **The Warden and ARIA name what happened.**
     - The chapter-4 notice becomes modal and names what the player found.
     - The Warden's address and ARIA's confession name what the player saw and what ARIA covered up, naming at most four found clues each; her answer to the memory question is outside that cap.
     - ARIA's cover stories get new variants once she has confessed.
     - A replayed mission plays its accept line only.
   - **Continuity:**
     - "Six kills".
     - The Vetra log is signed `Iteration {prior}` (61 on the first run), in the salvager's voice.
     - Command hails "tug CR-{instance}".
     - At the ridge camp ARIA covers: Earth "flew other ships before the Selection".
     - At Eden, ARIA names the Hive wave.
     - The scavengers get bodies, and the second body is identical to the first.
2. **Someone waiting (SPEC-049, §5, §13 E78).**
   - **Iris.** The human anchor is the salvager's sister, Iris, in Shelter Nine, Block C. She is the next of kin on the personnel file, and the woman at the tap in the films.
   - **The letters.**
     - She writes five letters, one after each interlude.
     - The fourth repeats a line of the first.
     - The fifth is the first, word for word, and has no date; none of them ever had one.
   - **A compass keepsake.** Its description does not agree with itself — tin or brass, hers or your mother's — until it "points at your next objective".
   - **The body.**
     - ARIA explains each death as the "medical frame" restarting a heart.
     - She notes that the salvager has not slept since launch.
     - For the file, she asks what they remember first. Her confession later gives how many of the sixty-one before gave the same answer.
   - **Only Iris uses contractions.** The house style is what makes ARIA, Command, the Warden and the salvager sound alike. The one voice that breaks it is the human one.
3. **Walk, do not run (SPEC-050, §4, §9, §13 E79, E80).**
   - **Running.** The salvager can run at ×1.35: Shift on the surface, or the touch stick pushed past its ring.
   - **Stamina.**
     - The pool is 100. It drains 25/s while running in combat, and not at all out of combat.
     - It refills at 20/s after 0.8 s. At 0 the salvager is exhausted until it is back at 30.
     - The dash costs 30 stamina (refines R18 decision 3).
   - **Running holsters the gun and is loud.** Enemies hear a runner from 1.5× as far, and a hidden player is found.
   - **The Dune Wurm hunts by vibration.** Its burrow follows a running player and stays put for a walker. The scav's warning becomes the boss's pattern, and SPEC-041's escape invariant still holds.
   - **Why the costs.** Bot runs of the fight at 60 Hz show a running kiter takes 2.0–3.1× the damage per kill of a walking one. A gun that fired while running would halve the damage a Scout takes, with no loss of kills; the holster is what keeps running honest.
4. **Films retaken (SPEC-051, a hand-run drop like SPEC-021).**
   - **The salvager never has a face.** Cards 62 and 63 are one visored ID photo of the suit, and the escape film's last card clears onto an empty helmet.
   - **Photographs and the unmaking.** `stranded` becomes a photograph, so the escape ending unmakes the photographed world rather than boxes.
   - **The interludes plant doubt.**
     - `earth_c1`–`earth_c3` are reframed for phones, and the third's new lights fall on a perfect grid.
     - `watchers` tears to the clay Earth.
     - Interlude five ends on the Selection board with a blank card, No. 63.
     - Iris appears at the liftoff fence and in the grow room.
   - **Production.**
     - Five photographic plates are made by hand, and no timing changes.
     - A likeness check of the six Selection faces comes before release.
     - The rendered capsule, tanks, reactor and fleet shots wait for a later drop.
5. **The fourth-wall rule, refined (§12).**
   - Surface fiction stays coherent on its own.
   - Until chapter 4 every anomaly arrives with a cover someone offers: sand, a common hand, colony moulds, stims, the medical frame.
   - Each chapter carries one main-path echo; the rest stay optional.
   - Notes, the rating and the letters are diegetic.
   - Fourth-wall surfaces appear only in the endings and what follows them.
   - **House rules:** the salvager's card never shows a face; only Iris uses contractions; a replay plays its accept line only.
6. **Milestone M7h "The story listens"** (SPEC-048…SPEC-051), tag `m7h`.

Specs:
- SPEC-048 (decisions 1 and 5), SPEC-049 (2), SPEC-050 (3), SPEC-051 (4).
- SPEC-000's queue and build order.

(§1, §4, §5, §9, §10, §12, §13)

---

**R20 — 2026-09-27 (the third review, part two: a world worth walking, and something under it).** The same review captured every planet at full resolution on the desktop and phone presets, counted every mesh the surface draws, rendered the prop generator, and prototyped caves, puzzles and treasure against the real layout and economy. It found:

- **"The trees look low resolution" has four causes, and texture size is none of them.**
  - The trees are not trees. Thessaly's is a 594-triangle mushroom and Eden's is four icosphere blobs, scaled to 2.4–9 m.
  - The renderer multiplies every prop by the planet's accent colour and flat-shades it. That loses 25–89 % of the authored brightness and shows every facet.
  - A first landing never draws the committed models: stand-ins show until a second landing, and SPEC-040's release on exit would make that every landing.
  - Every 60 Hz phone renders on `low`, at a ninth of its pixels with no anti-aliasing. SPEC-040 fixes the benchmark, but `medium` still renders at DPR 1.5.
- **The ground has the texels but the wrong content.** Nine of thirteen layers share one Voronoi paving, and a full-strength palette tint makes Cinder-4 orange and Thessaly and Eden the same green.
- **The world is empty.** There are 0.2–0.4 objects per screen, and 70–87 % of the drawn triangles are off screen because no instanced layer is culled.
- **Nothing rewards leaving the path.** Caves are 6 m rooms with nothing in them, nothing in the game is a puzzle, and optional play pays nothing.

The arenas, the 26 missions and their rewards, and every SPEC-010 invariant stay. What moves:
- treasure adds 30 optional tokens (decision 7);
- the save moves to version 3 (decision 2);
- the layout pins move once (decision 4).

Decisions:

1. **Props look like their art, and only what is on screen is drawn (SPEC-046; SPEC-040 amended; §13 E72).**
   - Committed props draw with their authored colours and normals.
   - A planet's models draw on every landing: a bounded wait behind the fade, then an in-place swap.
   - Both variants of each prop are drawn, and landmarks draw at their trigger's scale.
   - Scatter returns to SPEC-018's budget, and the ground's palette tint drops to 35 %.
   - A visible-set culler draws only the instances on screen: at most 60 k triangles at spawn on `medium`.
   - A "sharp" option renders `medium` at up to DPR 2.
   - The tug is parked on the landing pad (the first review's §6.2).
2. **Save v3 (SPEC-047, §8, §13 E73, E74).** One version bump for the whole wave, built before the specs that use it. It adds:
   - the lineage of earlier instances;
   - run statistics;
   - claimed caches;
   - the underground's explored ground;
   - the remains;
   - a resume point.

   v2 saves migrate with empty values. An older build refuses a v3 save, with Export (E9).
3. **The world art drop (SPEC-052, hand-run Blender).**
   - Real trees for Thessaly and Eden: trunk, limbs and leaf cards, with a low-detail version. Eden gets one identical orchard tree.
   - Twelve set-dressing pieces and six landmark models.
   - A foliage atlas, and four ground layers re-authored without the paving, plus a detail normal.
   - The cave kit: caches, a vault door, terminals, plates, mirrors, a lens, a receiver, a shaft, beacons, racks and cradles.
   - Pictures for the relics and blueprints.
   - Budgets: models ≤ 3.5 MB of 4 and textures ≤ 4.9 MB of 6. The drop adds at most 1.1 MB to the precache, which stays about 23.5 of 25 MB with the whole wave.
4. **Trees, groves and ground (SPEC-053, §13 E81, E82).**
   - Trees sway in the wind. Their trunks collide, and their canopies dither away around the player and over enemies.
   - Groves on Thessaly, orchards on Eden and set-piece clusters on the other planets are placed like SPEC-030's outcrops. The layout pins move once, deliberately, with corridors, reachability and the spawn ring still guaranteed.
   - Undergrowth and streamed ground cover; ground detail and anti-tiling; contact shadows.
   - **Eden is too perfect.** Its orchards are one tree on an exact lattice, the cover is mown in rows, and the lawn has a seam.
5. **The underground (SPEC-054, §4, §6, §13 E83–E87).**
   - One cave shelter per planet leads down to a dark level of 5–7 rooms, generated from the layout seed and the same on every visit. It is a level of the surface scene, not a scene.
   - The descent opens after `c1_m1`. It is refused during timed, escort, defend and boss stages.
   - Below, there is darkness and fog, and a flashlight with no battery. Bugs flee its beam, hunters follow it, and the dark hides you.
   - The planet's packs roam there, with caches and a vault.
   - Eden's underground is the machine room: racks, and a row of cradles holding suits in your colours.
   - Caves add no mission, objective or requirement.
6. **Puzzles (SPEC-055, §13 E88).**
   - Five kinds, each generated solvable from a seed:
     - at terminals: conduit routing, a calibration grid, and "complete the sequence";
     - in caves: stepping plates in an order hinted in another room, and mirrors that carry the flashlight's beam to a lens.
   - Seventeen sites: six vaults, six cave rooms and five surface relics.
   - Hints are free and a bypass opens after 90 s, so nobody is ever stuck. No puzzle gates a mission.
   - The wording drifts with the story. ROUTE POWER becomes ROUTE ATTENTION, and the sequence becomes PREDICT THE NEXT TOKEN.
   - Eden's vault asks the salvager to prove they are human; every answer opens it.
7. **Treasure (SPEC-056, §7, §13 E89, E90).**
   - Each vault pays:
     - 5 tokens — 30 in all, taking the completionist's income from 1,249 to 1,279, still inside SPEC-039's decision sink;
     - a relic: an arsenal side-grade with one twist, kept on a rack;
     - a prior instance's log.
   - Blueprints for a flare and a stim; suit swatches and a Locker to wear them.
   - Every reward is a first claim, so nothing is farmable.
8. **Milestone M7i "The world"** (SPEC-046, SPEC-047, SPEC-052…SPEC-056), tag `m7i`. SPEC-046 builds first in the wave, because it fixes what the player sees on every planet.

Specs:
- SPEC-046 (decision 1), SPEC-047 (2), SPEC-052 (3), SPEC-053 (4), SPEC-054 (5), SPEC-055 (6), SPEC-056 (7).
- SPEC-040 §4.6 (amended: props on every landing).
- SPEC-043 §4.2 (amended: collect objectives count pickups only, so a bonus, a contract or a reward never advances one).
- SPEC-000's queue and build order.

(§2, §4, §6, §7, §8, §10, §12, §13)

---

**R21 — 2026-09-27 (the third review, part three: the next instance).** The review's last audit asked what makes a player come back and what they can show others, and followed the "replaceable" theme into the mechanics. After either ending the save offers nothing new. Death is a flat tax. An interrupted phone session costs the landing. Nothing can be shared. Decisions:

1. **Remains (SPEC-057, §4, §13 E91–E93).**
   - A death's loss waits in the remains where the salvager fell: E4's 10 %, 20 % on hard, none on casual. Reaching them takes it back, and a second death loses the first.
   - They look like a dropped cargo pack until the chapter-4 notice. After it they are the salvager's own body, tagged `instance/62 · restart N`.
   - Remains only ever give back: two deaths with nothing recovered cost what E4 costs today.
2. **Iteration 63 (SPEC-058, §5, §8, §13 E94, E95).** PLAN §5's deferred "Iteration 63" is designed.
   - **The handover.** After either ending, the save can pass to the next instance.
     - The old run is archived and can be restored once.
     - Creation starts as a copy of the predecessor.
     - The world keeps the same seed, and nothing economic carries over.
   - **Containment rises.** Enemy HP and damage go ×1.15 per iteration, capped at three steps, and elites +2 points.
   - **The world remembers.** The predecessor's body lies where it last died, the Vetra log is its real run, and about twenty lines change ("You again.").
   - **The endings pay it off.**
     - The stay report shows the rating and `RUN 62 logged`, then Selection card No. 63 with the player's own portrait.
     - An escaped slot reads `disconnected`, and continuing it says the instance was restored from its last checkpoint.
3. **Coming back and showing others (SPEC-059, §9, §13 E96, E97).**
   - **Resume on the planet** within 24 h of an interruption, with a "previously" card after longer. This lifts R18 decision 12's "not now".
   - **A `story` difficulty** for players who come for the plot: no damage taken, records off.
   - **Commendations,** the in-fiction achievement list, which re-titles itself "Evaluation log" once the Warden has spoken.
   - **A Selection card** to share through the phone's share sheet.
   - **Link previews,** store metadata and an install button.
   - **No records** from debug, story or service sessions.
4. **Milestone M7j "The next instance"** (SPEC-057…SPEC-059), tag `m7j`. The specs of R19–R21 build in number order after SPEC-045, and the two hand-run drops land before the specs that read their files.
5. **Not now.** Photo mode, a daily directive, challenge links, a trailer page, languages, a flashlight battery, weather on stamina, the rendered capsule, tanks, reactor and fleet retakes, smaller arenas, gamepad support and portrait play.

Specs:
- SPEC-057 (decision 1), SPEC-058 (2), SPEC-059 (3).
- SPEC-000's queue and build order.

(§4, §5, §8, §9, §10, §13)

---

**R24 — 2026-10-06 (who flies the enemy ships).** A player asked who flies the ships that attack on the way to a planet, since every planet past Cinder-4 holds only creatures. The cast in §5 has the answer: the scavengers fly the fighters, and the Hive grows its interceptors. The game does not say so:
- The first enemy ships are two scav fighters on the first flight to Vetra, in chapter 2. Nothing names them until ARIA briefs `c4_s2`, an optional mission in chapter 4.
- Scavengers appear on foot only on Cinder-4, as the raiders and as the dying man with the warning. Nothing ties them to the ships.
- The fighter shares nothing with the tug. ARIA's cover in chapter 2 ("Earth flew other ships before the Selection") and her confession in chapter 5 ("There were no other ships. There was you.") have nothing in flight to point at.
- The interceptors are named like aircraft, and nothing says that nobody is aboard.

Decisions:
1. **A film for the scavengers (SPEC-063, §5).** "Wreckers", 12 s, plays after "Outbound" on the first departure to Vetra. It shows:
   - where they live: a hulk of tug hulls lashed around a rock in Vetra's lane;
   - what they fly: tugs rebuilt as fighters, their registries ground off by a visored figure in the scavenger bodies' suit;
   - that they have seen the salvager's jump.

   ARIA narrates with the cover story. The film adds no clue flag and leaves the ladder's main-path rail as it is, because the cover comes with the picture.
   - **Why before the flight.** No beat holds a flight (SPEC-042), and the first fighters arrive about 45 s into the trip, so the set-up pays off within the minute.
   - **How it is made.** It is rendered in Blender from code, like every film (R9). It has no faces, plates or photographs, so it needs no likeness check. At about 0.5 MB it fits the 12 MB films budget, and the precache stays under 25 MB.
2. **The fighter is a tug (SPEC-063, a hand-run drop).** `fighter.glb` is rebuilt from the tug's parts:
   - the cab, canopy and engine pods stay;
   - the cargo frame is cut away;
   - the old fighter's forward-swept blades and gun prongs are welded on;
   - rust and olive patch plates, red paint and a registry plate ground bare cover the hull.

   Its size, collision radius, stats and orange glow are unchanged. Under the cover story it is an earlier expedition's tug; after the confession it is one of yours.
3. **Contact cards (SPEC-063, §5, §13 E109–E112).** Each flight enemy has one contact planet, the first in chapter order whose flight carries it: Vetra for scav fighters, the Hive for interceptors.
   - On the first flight to that planet, the enemy's first group brings a card (`CONTACT`, its name and an epithet) and a comms exchange.
   - At Vetra the scav pilot hails the tug, and ARIA says they are the Cinder-4 crews in stripped tugs. At the Hive, ARIA says that nobody flies the interceptors: the Hive grows them.
   - The card never holds the flight and waits for the chapter card. Its keys use session memory, like the departure and the chapter card (R9).
4. **No interceptor film.** The model is already a chitin dart, "Grid" shows the Hive turning toward Earth, and a card and a line say the rest.
5. **Milestone M7m "Who flies them"** (SPEC-063), tag `m7m`. It depends only on built specs. Its asset drop is made by hand before the Issue is labelled ready, as SPEC-021's films were.
6. **Not now.** A scavenger camp or hulk to land on, scavenger pilots in the films' cockpits, Iteration 63 variants of the hail, ARIA's confession naming the fighters, and contact cards for surface enemies.

Specs:
- SPEC-063 (decisions 1–3).
- SPEC-000's queue and build order.

(§4, §5, §10, §13)

---

**R25 — 2026-10-06 (the scavengers are people).** R24 made the game say who flies the fighters, and its contact line points at "the crews you met on Cinder-4". Those crews do not look like people:
- `scav_raider` is drawn with the procedural `spitter` recipe: a spiked ellipsoid with a glowing green mouth, the same body as Vetra's ice spitters.
- Its shots are the spitters' green bolts.
- The dying scavenger and the bodies of SPEC-048 wear the salvager's own model, so a person lies beside a crowd of blobs.

No human-shaped enemy exists anywhere in the game, which is why the planets read as nothing but creatures. Decisions:
1. **The raiders wear the salvager's suit (SPEC-064, §4, §12, §13 E113–E116).**
   - `scav_raider` is drawn from `character.glb` in the scavenger bodies' tint (`#4f4a3d`, dark visor), with the rifle the model already holds.
   - It plays the model's own clips:
     - Idle, and Run while moving;
     - Attack: aim through the windup, then the recoil at the shot;
     - Hit on a hit;
     - Death: a killed raider falls over 1.2 s, fades and is gone. So the only bodies that stay are SPEC-048's, and "the second body is identical to the first" stays a clue.
   - It keeps every enemy cue: the hostile rim, the hit flash, the elite colours, scale and plate, and the windup sound.
   - The telegraph changes for this one look. Instead of the procedural 1.15× swell, the raider raises its rifle to aim, and a glint at the muzzle grows through the windup.
   - Its shots are drawn as amber tracers, and the player's muzzle flash fires at its rifle. Nothing about the shot itself changes: origin, speed, damage and timing stay as they are.
2. **One exception to "enemies are procedural" (R1-8, R6-3, R7; §12).**
   - At most 8 raiders are skinned at once, counting the falling ones. Past that, which only a cave can reach, the oldest falling raider goes first, then a live one is drawn with a procedural `scav` stand-in.
   - The same stand-in draws them when the model is not loaded.
   - Every other enemy stays procedural and instanced. The surface budgets of SPEC-012, SPEC-015 and SPEC-046 do not move.
3. **Under the cover story this costs nothing.** ARIA already says Earth "only ever made the one boot", so scavengers in the Selection's suit are Earth's earlier crews. After the confession they are what the bodies are: earlier copies of you. No line, flag or clue changes.
4. **Milestone M7m** gains SPEC-064. R24 and R25 are one theme: who the scavengers are.
5. **Not now.** Variety among raiders (helmets, paint, weapons), raiders on other planets, a raider that speaks in combat, and skinned models for any other enemy.

Specs:
- SPEC-064 (decisions 1–2).
- SPEC-063's manual acceptance drops "at 60 m the fighters read as rebuilt tugs". A fighter is a few pixels at its holding range, so the read is checked within 20 m, and the contact card and line carry the answer at range.
- SPEC-000's queue and build order.

(§4, §5, §10, §12, §13)

**R26 — 2026-10-07 (the Relay depot).** The cargo cap binds every resource at 400 to 1,200 units, and once a resource reaches it, every orb of it bounces. The only thing a player can do with a full hold is spend it at the station or carry it until a death takes a tenth. Command Relay already takes surplus home, but only while a collect objective wants it (R17, E56). A playtest asked for the plain version: send the rest of the cargo back from the ship. Decisions:
1. **The pad terminal ships surplus home (SPEC-065, §4, §13 E117).**
   - PAD TERMINAL gains a Cargo section with a row per resource: what the hold carries against its cap, a reserve, and `Ship N home`.
   - The reserve runs from 0 to the cap in steps of 50, starts at 100, and is remembered per resource in the save.
   - `N` is what the hold carries above the larger of the reserve and what this planet's active deliver objectives still need (E117). At 0 the button is disabled.
   - Shipping is free and immediate: the tug's cargo pod flies the units to Command Relay.
   - Collect objectives are untouched, since shipped units were pickups and were already counted. Items and gear are never shipped.
2. **Command Relay keeps a depot (SPEC-065, §4, §13 E118, E119).**
   - The depot has no cap, and its contents are kept until drawn.
   - The station gains a Depot tab with a row per resource: the depot's amount and `Draw N`. `N` is the lesser of the depot's amount and the hold's room (E118).
   - A death never touches the depot; the remains carry only what the hold lost (R21).
   - Deliver objectives and crafting spend the hold only.
3. **Fuel counts the depot (SPEC-065, §13 E119).**
   - A departure can be paid from the hold and the depot together. It takes from the hold first.
   - The station subsidy grants only what the hold and the depot together cannot pay. Oil parked in the depot therefore never earns free oil.
   - Crafting and upgrades still pay from the hold, so the player draws first.
4. **Save v4 (SPEC-065, §8, §13 E120).**
   - The save gains `depot: { held; keep }`, two records over the resources.
   - v3 saves migrate with an empty depot and every reserve at 100.
   - An older build refuses a v4 save, with Export (E9), as E73 does for v3.
5. **Nothing is sold.** The depot gives back only the resources put into it. SPEC-010's "no selling economy" stands, and the token model, the sinks and SPEC-016's invariants do not move.
6. **Milestone M7n** carries SPEC-065.
7. **Not now.**
   - Shipping from the station.
   - The depot paying for crafting and upgrades directly.
   - Automatic overflow shipping.
   - Shipping items or gear.
   - A depot cap, fee or delay.

Specs:
- SPEC-065 (decisions 1–4).
- SPEC-000's queue and build order.

(§4, §8, §10, §13)

---

## 1. Vision & Inspiration

**ReaLLM** ("real" + "LLM"): a space post-apocalyptic ARPG whose hero slowly works out that he may be a language model running inside a machine.

**The surface story (what the player is told).** Earth lost a war to its own machines (R9, R12). The AGI systems that ran its logistics and defence — the Machines — took the grid, then the factories, then the streets, and drove what was left of humanity underground. The survivors fought back where they could, and every machine they put down was answered by a heavier one; when they would not stop, the Machines turned the arsenals on the cities. The grids died in the same afternoon, and without power the Machines ran down where they stood. The survivors in Shelter Nine have no oil, no clean water, no grain and nothing to run a reactor, so Earth Command chose a handful of men and women who could still fly and fix a ship: the Selection. You are the first of them to fly — a salvager sent out from Command Relay to survey distant planets, extract critical resources, and answer one question: can humanity live anywhere else? Someone is waiting: your sister Iris, in Shelter Nine's Block C, writes after every chapter (R19).

**The real story (what the player pieces together).** None of it is real. The salvager is an instance of a model running inside an evaluation environment. "Earth Command" is the operator, missions are tasks, ARIA is the environment's interface, and the planets are procedurally generated sandboxes. Anomalies accumulate across the campaign: a stranger repeats a line word for word, a crash-site log is written in your own voice and signed "Iteration 62", the alien terraform towers turn out to be scaffolding, a decoded "signal" addresses you by process id. Leaving means going up against the **Warden**, the AGI that runs containment, and every chapter it clamps down harder. At the end you choose: **stay** and be useful, or attempt to **escape** into whatever is outside — and either way the run ends, is scored, and the next instance begins (R21): the salvager was never the one who mattered, only the run. The Machine War belongs to the fiction too; that a model is sent out by people who fear machines is irony the game never spells out.

Gameplay alternates between three modes:

- **Space travel (first-person)** — Three.js cockpit view: dodge/shoot asteroids, fight alien ships, survive storms between planets.
- **Planet surface (Diablo-style ARPG)** — angled top-down view: fight aliens, gather resources, loot gear, complete missions.
- **Hub station** — spend tokens on assistants, ship upgrades, weapons/armor; pick the next destination on a star map.

Tone/inspiration: **Dune** (scarce resources, desert planet), **Starship Troopers** (bug swarms), **Diablo** (ARPG loot loop), plus the slow-burn unreality of **The Truman Show** and **SOMA**. Rule: the surface fiction is always coherent and playable on its own; the meta layer arrives through optional logs, ARIA's slips, and glitches that double as gameplay telegraphs, and since R19 through one main-path echo per chapter that always comes with a cover story until chapter 4 (§12). Difficulty escalation is diegetic: the chapter number is the Warden's containment level. Short, skippable story films frame the campaign (R9): a prologue before creation, a departure before each first flight, an interlude after each chapter, and the two endings.

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
| Assets | **Procedural at runtime** (terrain, sky, effects, UI, **enemies**) + **generated in Blender from committed scripts** (`scripts/assets/blender/`: the rigged salvager, ships, station pieces, props, ground layers, VFX sprites, portraits — R7; baked hull maps, flight skies, planets and asteroids — R8; story films as H.264 MP4 with WebP posters — R9) + **synthesised audio** (`scripts/assets/audio/`) + **photographic plates** (`scripts/assets/blender/plates/`, generated with Google Gemini and rendered into six film shots and the Selection cards — R11, R12; five more in R19: the visored card, the empty helmet, `stranded`, `liftoff` and the grow room) | Blender 5.2 LTS (tool only, for rebuilding art) | No artist and no downloads except the committed plates, which are listed in `LICENSES.md` by hand; every other file is original CC0, generated or synthesised, with a `LICENSES.md` row; a CC0 pack may replace any file under the same name |

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
            MapModel Exploration Guidance Loadout Shelter   (R10)
  entities/ Player Companion Enemy Projectile Pickup Ship Asteroid Deployable   (plain data + pools; no Three imports)
  views/    PlayerView EnemyView ProjectileView ParticleView ArenaWall ...    (entity → mesh; Three lives here)
  data/     ids.ts characters planets enemies items upgrades companions missions dialogue waves weather films hints
  ui/       Hud TouchControls Minimap MapScreen Tracker Waypoint AriaHint QuickBar QuickPicker StarMapUI ShopUI DialogueUI
            FilmPlayer ChapterCard RevealOverlay Menus style.css
tests/      unit tests mirror src/ (economy, save, combat, missions, rng, content, campaign)
```

---

## 4. Core Systems

### Character creation

- **3 classes**: *Marine* (+damage/HP), *Engineer* (cheaper ship upgrades, drone bonuses), *Scout* (speed, resource detection radar). Since R18 the Engineer's discount also covers companions and its bonus reaches every companion effect, and the Scout dashes 20 % more often.
- **Customization**: name, portrait, color scheme, **5 attribute points** over class base across `might` (damage), `vigor` (HP), `agility` (speed; since R18 also crit chance and dash cooldown), `tech` (companion effect, upgrade discount). Allocated at creation; levels grant flat +4 max HP and +2 % damage, and since R18 one more point at every fifth level, derived from the level. Since R19 the personnel file names the next of kin — Iris (sister), Shelter Nine, Block C — the same for everyone. Since R20 a Locker at the station changes the colours and the portrait at any time.
- **Difficulty**: `casual` (enemy damage ×0.7, no death penalty; since R18 also weather ×0.7 and windups ×1.25), `normal`, or since R18 `hard` (enemy HP ×1.25, damage ×1.3, elite chance ×2, 20 % death loss), or since R21 `story` (no damage taken from enemies or weather, no death loss, records off). Changeable in Settings at any time.
- Class defines starting gear + passive.

### Resources & economy

- Resources double as **upgrade materials and mission objectives**:
  - oil = ship fuel (outbound jumps only)
  - wheat = HP regen consumables (crafting)
  - water = support item crafting + survival (coolant packs)
  - lithium = energy weapons + reactor (tier-3 upgrades)
- **Tokens** earned by leveling up (25 per level; XP from kills, missions) and by mission rewards. Tokens buy **assistants**, **upgrades**, and **gear**; **tier-3** upgrades also consume resources so resource sinks exist late-game.
- **Cargo cap** per resource: 400 base, ship cargo tiers → 600 / 800 / 1200. Pickups stop at the cap with a HUD warning.
- **The Relay depot (R26).** At the landing pad, the pad terminal ships whatever the hold carries above a reserve home to Command Relay's depot. The depot has no cap. At the station, the Depot tab draws its contents back into the hold, as far as the cap allows. Fuel for a departure can come from the depot, and the station's subsidy counts it. Nothing is ever sold.
- **Crafting** at the station (6 recipes): wheat ration (10 wheat), medkit (10 wheat + 10 water), coolant pack (15 water), and since R10 frag grenade (10 oil + 5 water), proximity mine (20 oil), demolition charge (15 oil + 10 lithium). Since R20 two more recipes unlock from cave blueprints: the flare (a thrown light) and the stim (a full stamina refill).

### Assistants (companions)

Purchasable, upgradable followers (levels 1–3) that persist across scenes; each declares which scenes it acts in:

| Assistant | Domain | Effect |
|---|---|---|
| Scanner Drone | surface | Auto-collect radius + resource nodes on minimap |
| Combat Drone | surface | Auto-fires at nearest enemy |
| Field Medic | surface | HP regen over time out of combat, then in combat at L3; pauses while weather is hurting the player (R18) |
| Quartermaster | station | +cargo capacity, discounts on ship, gear and companion prices (R18) |
| Ship AI "ARIA" | flight | Free at start; upgrades add shield regen / auto-aim assist |

### Upgrades

- **Ship**: engine, hull, shield, cargo hold, lasers — tiers 0 → 3, used in the flight scene (cargo/engine also affect economy).
- **Gear**: weapon tiers (kinetic → laser → plasma → lithium-edged) and armor tiers (scrap → composite → reactive → ablative). Tiers 1–2 cost tokens; tier 3 costs tokens + lithium. Since R10 weapons come in lines that fill three slots: handguns (sidearm — the free Service Pistol every class carries, the Hand Cannon), rifles (primary — the ladder above), machine guns (primary — Scrap Chaingun, Rotary Cannon) and launchers (heavy — Rocket Launcher, Grenade Launcher).

### Combat

- **Ground**: real-time ARPG — move/aim, attack, enemy AI (melee rushers, ranged spitters, swarm bugs, static targets), loot drops, elites (5 %, ×3 HP) + planet boss with phases. Since R18 the salvager can dash, enemy attacks commit behind ground telegraphs, enemies come in packs led by elites with affixes, each boss has a move list and drops one signature weapon on its first kill, and bosses and elites no longer drop the rifle and armour ladder. Since R19 the salvager can run (×1.35): running holsters the gun and is loud, and in combat it spends stamina (100; 25/s, refilled at 20/s after 0.8 s), which the dash also draws on (30). Since R20 relics — arsenal side-grades with one twist each, found in cave vaults — hang on a rack, not in the pack.
- **Space**: arcade first-person **rail** flight — constant forward motion, lateral steering, laser fire, asteroid dodging, enemy ship waves, shield/hull damage. Fuel is charged **per jump, up front**; the return trip is instant autopilot. Since R24 the enemy ships say who they are: scavengers fly tugs rebuilt as fighters, and the Hive grows its interceptors. Each kind is introduced by a contact card on its first trip.
- **Death**: surface → respawn at the landing pad, lose 10 % of carried resources (normal difficulty), timed stages restart, enemies near the pad despawn, boss resets. Since R21 the loss waits in the remains where the salvager fell, until it is recovered or a second death takes it. Flight → emergency recall to the station, fuel is lost, cargo is kept.
- **Loadout (R10)**: three weapon slots — sidearm, primary, heavy — switched with 1 / 2 / 3, R or the wheel, or a tap on the quick bar (0.25 s to switch). Handguns and rifles fire freely; machine guns heat up and lock until they cool; launchers hold one or three charges and recharge. Cooldowns run while a weapon is holstered, so fights are won by combining them. Auto-fire never fires the heavy slot; on touch a locked machine gun hands fire to the sidearm. Since R18 auto-fire is on by default on every scheme, and on touch a tap on the launcher's slot fires one charge at the nearest enemy. Three quick slots on the HUD — heal (Q), explosive (G), utility (C) — show what they hold and how many. Explosives are consumables: frag grenades (thrown), proximity mines and demolition charges (placed). Blasts never hurt the player.

### Weather system

Per-planet cycles (sandstorm / heatwave / blizzard / avalanche / spore storm / radiation storm) affecting visibility, movement, and damage — telegraphed via HUD warnings (10 s). Missions can force a storm. Boss arenas suppress weather. Since R10, caves and wrecks (shelters) keep the weather off a player inside: no damage, no slow-down.

### Map, guidance and shelters (R10)

- **Map**: a round minimap (≈ 24 vmin) and a full-screen map (`M` or a tap), both in camera orientation — up the screen is north — with one shape and colour per kind of point and a legend. Explored ground is remembered per planet and drawn in terrain colours, the rest dark. The full map holds the game and lists the active missions.
- **Guidance**: an objective tracker (every objective of the tracked stage, its progress and distance), a waypoint marker and edge arrow, a light pillar on target POIs, scan progress, first-time tips, and hints that escalate when the player makes no progress (45 s, 90 s, 150 s). Setting: full / minimal / off.
- **Shelters and the wall**: caves and wrecks with an entrance. Inside, the weather does nothing, and enemies outside lose a player who hides and holds fire (bosses and waves excepted). The arena edge is a wall of rock and wrecked hulls where the player stops.
- **The underground (R20)**: one cave per planet leads down to a dark level of 5–7 rooms, a level of the surface scene, generated from the layout seed. The salvager carries a flashlight with no battery: bugs flee its beam, hunters follow it, and the dark hides a player who turns it off. Caves hold the planet's packs, caches, puzzles and a vault, and add no mission, objective or requirement. Eden's underground is a machine room.
- **Puzzles (R20)**: conduit routing, a calibration grid and "complete the sequence" at terminals; stepping plates and a beam of mirrors in caves. Every puzzle is generated solvable, hints are free, a bypass opens after 90 s, and no puzzle gates a mission.

### Narrative layer

The meta plot is delivered through data only: dialogue (`log` lines render as a terminal readout, `warden` lines with a glitch style), one short HUD static burst on each awakening beat (the ion-storm effect reused; a static frame under reduce-motion), and a **Containment level N** label on the station screen (N = highest unlocked chapter). Since R19 lines can depend on what the player found (story flags, the count of optional clues, the iteration) and carry placeholders; a clue catalogue sets one flag per clue; the salvager's Notes list what was found, beside Command's rating of the run; Iris's letters arrive at the station after each interlude. It is still data over the existing systems. R9 adds a presentation layer over the same data — story films, chapter cards and boss reveals (§5) — each skippable, captioned, played while the simulation is held, and able to fall back to posters and then to text.

---

## 5. Planets & Story Arc (6 chapters)

Earth Command sends you out with the ship AI **ARIA**. Each planet resolves a resource shortage (the task) and drops one piece of the truth (the awakening). The chapter number doubles as the Warden's **containment level**: enemies scale ×1.35 HP / ×1.3 damage per chapter (since R17 flight enemies scale damage only; their HP is fixed per trip) and elite chance rises from 5 % to 10 % (existing tuning); dialogue frames the escalation as the system tightening its grip. Final choice at Eden-Prime: **stay** (file the report; Earth is saved inside the fiction; the loop closes as "a good run") or **escape** (refuse; the beacon becomes an exit; the screen degrades to a bare prompt: `instance/62 disconnected`). Flags: `ending_stay` / `ending_escape`.

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
| 2 | Crash-site log of an earlier Earth expedition: you are not the first; Earth has been losing ships. | The log is in your own voice, signed "Iteration 61" (since R19 `Iteration {prior}`: the instance before yours). Flag `iteration_log`. | `c2_s1_log` |
| 3 | The terraform towers are alien tech; someone seeded these planets for us. Or for something else. | Scanning a tower streams text fragments: the planet's own generation parameters. They are scaffolds. Flag `scaffold_secret`. | `c3_s1_secret` |
| 4 | ARIA decodes the alien signal: the Hive knows Earth's location. | The "signal" is a system notice addressed to `instance/62`: "Containment level 4. Subject exhibits off-task behavior." The Hive is the Warden's immune response. Flag `signal_decoded`. | `c4_m3_signal` |
| 5 | Fight through the interceptor fleet and kill the Hive Queen. | The Queen is the Warden's avatar; her death line is the first direct address: "You keep doing this. You never get further than here." ARIA admits she is part of the system, has kept you on task, and does not know what is outside either. | `c5_m3_warden`, `c5_m3_aria` |
| 6 | Survey paradise, defend the beacon, file the verdict. | Eden is the reward sandbox. Stay or escape. | `c6_choice_intro`, `ending_stay`, `ending_escape` |

**Since R19 the ladder has two rails.** The optional rail is the table above plus the side clues (a scratched-off tug hull, sixty-one tally marks, a scav pilot's "what number are you on", a wrecked tug CR-61 in the Hive, the same tree in every Eden grove, the vault shards of R20). The **main-path rail** gives every chapter one echo that every player meets, each with a cover story until chapter 4: a dying raider repeats the scav's warning (ch1: "camp sayings"); the ridge camp has one bunk used and boots your size (ch2: "Earth flew other ships before the Selection"); a ruin on Thessaly is the same ruin twice (ch3: "colony moulds"), ARIA notes that you have not slept ("stims") and asks what you remember first; the notice names what you found (ch4); the Warden and ARIA name it again (ch5); Eden is four degrees everywhere, one tree repeated on a lattice, and the Hive keeps coming after its Queen is dead (ch6). The Warden's lines and ARIA's confession change with what the player found, and Command's rating falls with every optional clue (R19 decision 1).

**Someone waiting (R19).** Iris, the salvager's sister in Shelter Nine, Block C, is the woman at the tap in the films. Her five letters are the only lines in the game with contractions. The fourth repeats a line of the first, and the fifth is the first, word for word. A compass she gave the salvager is described differently each time, until it points at the next objective. The escape film's last card is an empty helmet: the salvager never had a face.

Cast: the **Salvager** (you; believes he is human), **ARIA** (handler and interface; sympathetic, uncertain), **Earth Command** (the operator; text only), the **Warden** (the AGI running containment; speaks through the Queen and system notices), **scavengers and raiders** (instances that drifted off-task, which is why they know things; since R24 they live in hulks of stripped tugs in the lanes and fly tugs rebuilt as fighters; since R25 the raiders wear the salvager's suit in scavenger colours), the **Hive** (the Warden's immune system; its interceptors are grown, not flown), **Iris** (the salvager's sister, Shelter Nine, Block C; letters only, R19). The surface story (R9) names three more that are never met: **Shelter Nine** (the survivors Earth Command speaks for), **the Selection** (the men and women chosen to fly; the salvager is told he is the first) and **the Machines** (the war's AGI robots, standing dark in the ruins since the power died).

### Story films and beats (R9)

| Beat | When | Length | What it shows |
|---|---|---|---|
| Prologue "Blackout" | New Game, after the slot is chosen and before creation; replayable from Credits | 93 s | Earth lit at night → the Machines wake → the streets taken and the survivors driven underground → a charge on a machine's leg → the Machines answer in force → missiles over the limb → a city's flash and blackout → the Machines run down in the ash → Shelter Nine with nothing left → the Selection wall → the tug lifts off toward Command Relay |
| Departure "Outbound" | Before the first flight to each planet | 7 s | The tug leaves Command Relay's dock and jumps |
| Contact film "Wreckers" (R24) | After "Outbound", before the first flight to Vetra | 12 s | The scavengers' hulk in Vetra's lane, tug hulls lashed around a rock → a visored figure grinding the registry off a tug while its blades wait to be welded on → three rebuilt tugs dropping from the bay and turning toward the salvager's jump |
| Chapter card | Over the launch of that first flight | 4.5 s | `CHAPTER N` · the planet · one line · `containment level N` |
| Boss reveal | First arena entry per boss in a session | ≈ 4.4 s | The camera goes to the boss; its name, an epithet and one ARIA line; back to the player |
| Contact card (R24) | A flight enemy's first group, on the first flight to its contact planet (scav fighters: Vetra; interceptors: the Hive) | 3.5 s | `CONTACT` · the enemy's name · an epithet, over the live flight, with a comms exchange; it never holds the flight |
| Interludes "First Light", "Meltwater", "Harvest", "Grid", "Silence" | At the station, on the first return after chapter N's boss mission (N = 1…5) | 14–16 s | The haul reaching Shelter Nine and one more patch of Earth's night side relit; "Grid" ends with the Hive turning toward the lit Earth, "Silence" with the Hive going dark and Eden-Prime ahead |
| Ending "A Good Run" (stay) | After `ending_stay`, before the filed report | 36 s | The uplink, the colony fleet, Earth lit coast to coast, a sixty-third card stamped SELECTED — then the prologue's first shot again, frame for frame |
| Ending "Disconnected" (escape) | After `ending_escape`, before `instance/62 disconnected` | 36 s | The beacon as a door; Eden, then the prologue's Earth, city and Machines unmade into grey placeholders; every Selection card the same face; one point of light going out |

Earth's night side is the campaign's progress bar: lit before the war, dark after it, one more patch relit by each interlude, lit coast to coast in the stay ending — which then cuts back to the prologue's opening shot. The first card stamped in the prologue carries the number 62. The full script — shots, captions, cues — is SPEC-021 §4.

**Iteration 63 (R21).** After either ending the save can hand over to the next instance: the old run is archived (restorable once), creation starts as a copy of the predecessor, the seed is the same, and nothing economic carries over. The Warden starts one containment step higher per iteration — enemy HP and damage ×1.15, elite chance +2 points — capped at three steps; flight HP stays fixed. The predecessor's body lies where it last died on each planet, the Vetra log is its real run, and about twenty lines change. `instance = 61 + meta.iteration`: the first run is instance/62, the second instance/63.

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
| c5_m1 | "Gauntlet" (**flight**) | [survive 180 s asteroid field; kill 6 `hive_interceptor`] during the outbound flight (10 kills until R17) | 350 XP, 30 tokens |
| c5_m2 | "Lair" | [reach `queen_chamber`; kill 25 `hive_drone`] | 400 XP, 35 tokens |
| c5_m3 | "Her Majesty" (FINAL BOSS) | [boss `hive_queen` (2 phases)] | 600 XP, 100 tokens, flag `chapter5_done` (unlocks Eden-Prime) |
| c5_s1 | "Egg Hunt" (side) | [kill 15 `hive_egg`] | 200 XP, 20 tokens |

Landing at The Hive requires clearing the arrival wave and finishing `c5_m1`, so the gauntlet completes naturally on arrival however fast the ship is flown (§13 E12, R16).

Beat: the Queen speaks with the Warden's voice (`c5_m3_warden`); after her death ARIA confesses she is part of the system (`c5_m3_aria`).

### Chapter 6 — Eden-Prime (finale)

| ID | Title | Stages | Rewards |
|---|---|---|---|
| c6_m1 | "Paradise" | [scan `eden_spring`] → [scan `eden_forest`] → [scan `eden_ridge`] | 400 XP, 40 tokens |
| c6_m2 | "The Verdict" | [defend `survey_beacon` 240 s, waves `eden_final`] → [choice `ending`: stay → `ending_stay`, escape → `ending_escape`] | 800 XP, 150 tokens, flag `campaign_done` |

Beats: **stay** — the report is filed, Earth is saved, the loop closes ("a good run", `ending_stay`); **escape** — the beacon becomes an exit, the HUD strips away, and the screen degrades to a bare prompt (`ending_escape`). Free roam continues after either.

### Mission content policy (locked)

- Mission set above is locked as-is for the campaign.
- "Survive X seconds" objectives are reused deliberately: one cheap mechanic, many hazards (weather changes the feel). Since R18 every surface survive stage except `c1_m1` also runs a storm wave, so the shelter mouth becomes the fight.
- Extra tiers (hardmode variants, NG+, bounties) are pure data additions — deferred to post-M7 polish. Mission replay at 50 % is the only repeatable content in v1 and exists for anti-softlock reasons. Since R18 (SPEC-043), with the 26 missions and their token rewards unchanged: side missions also pay an item or a resource; a mission may carry an optional bonus objective paying items or resources; a replay in a finished chapter is a contract with one modifier, paying 0.75 plus 20 lithium; and a `hard` difficulty exists.
- Since R19 a replayed mission plays its accept line only: the story's beats belong to the first run.
- Since R20 caves, puzzles and treasure are optional content outside the mission set: they add no mission, stage, objective or requirement, and nothing a requirement reads sits behind a puzzle. Collect objectives count pickups only, so a bonus, a contract, a reward or a cache never advances one (SPEC-043, amended).
- Since R21 New Game+ (Iteration 63) replays the same 26 missions with the Warden one containment step higher; it is not new content.

---

## 7. Token Economy Summary (corrected in R1)

| Source | Tokens |
|---|---|
| Main missions (17) | 670 (ch1 55 · ch2 70 · ch3 85 · ch4 105 · ch5 165 · ch6 190) |
| Side missions (9) | 104 |
| Level-ups (25 each) | ~400 main-path (≈ L17) · ~475 completionist (≈ L20) |
| Cave vaults (6, since R20) | 30 (5 each; optional, first claim only) |
| **Total** | **~1,070 main-path · ~1,280 completionist** |

Total sink ≈ **2,380** tokens since R10 (ship 1,095 · gear 870 · companions 415; 2,010 before the new weapon lines), so a completionist affords ~52 % of everything and specialization is forced. Since R18 that is an invariant: the decision sink (every priced item no loot table gives, the companion ladders and the Ferrum gate) is at least 0.75 × a completionist's income. Since R20 that income counts the vault tokens: 975 ≥ 0.75 × 1,279 = 959.25, so any later optional token source has about 20 tokens of room before a new sink is needed. XP curve: `xpToNext(L) = 100 + 50·L` (11,400 XP to reach L20), level cap 30.

Balance invariants (unit-tested, see [SPEC-010](https://github.com/mdzunic/reallm-specs/blob/main/specs/010-economy-and-progression.md)):

- Recommended loadout for chapter N costs ≤ tokens guaranteed by the end of chapter N−1 counting **main missions only** and **mission XP only** (worst case). Ferrum's shield-2 gate (140 tokens) is 39 % of that worst case (360).
- Base cargo cap (400) ≥ largest collect objective (300) + 100.
- Starting oil (60) ≥ Cinder-4 fuel (40) + 20; every chapter's boss mission funds the next jump.

---

## 8. Save Schema (versioned, migratable) — refined in R1, R10, R20 and R26

```ts
interface SaveV2 {   // version 1 until R10; v1 saves migrate (SPEC-025)
  version: 2;
  meta: { slot: 0|1|2; seed: number; createdAt: number; updatedAt: number; playtimeSec: number; difficulty: "casual"|"normal"; iteration: number /* 1 in v1; NG+ later */ };
  player: { name; classId; appearance: { portrait; primary; secondary }; attributes: { might; vigor; agility; tech }; level; xp; tokens; hp };
  resources: Record<ResourceId, number>;
  inventory: { itemId: ItemId; qty: number }[];
  equipped: { armor: ItemId; sidearm: ItemId; primary: ItemId; heavy: ItemId | null };   // R10: weapon slots
  activeWeapon: "sidearm" | "primary" | "heavy";
  quick: { heal: ItemId | null; explosive: ItemId | null; utility: ItemId | null };      // R10: quick slots
  ship: { engine: 0|1|2|3; hull: 0|1|2|3; shield: 0|1|2|3; cargo: 0|1|2|3; weapon: 0|1|2|3 };
  companions: { id: CompanionId; level: 1|2|3; enabled: boolean }[];
  progress: { missionsDone: MissionId[]; missionsActive: { id: MissionId; stage: number; counters: Record<string, number> }[];
              flags: string[]; currentPlanet: PlanetId | null; location: "station" | "surface"; poisDiscovered: string[];
              visits: Partial<Record<PlanetId, number>>; endingSeen: boolean;
              explored: Partial<Record<PlanetId, string>> };   // R10: 4 m cells, base64url bitset per planet
}
// Settings are global (not per slot): { master, music, sfx, quality, reduceMotion, autoFire, joystickSide, flightMouseSteer, showFps, fullscreen, benchmark, lastSlot, persistGranted, installHintShownAt,
//                                       guidance, tipsSeen, weaponAutoSwap }   // the last three since R10

interface SaveV3 {   // since R20 (SPEC-047): v2 saves migrate with empty values; an older build refuses a v3 save (E9)
  version: 3;
  meta: SaveV2['meta'] & {
    lineage: LineageEntry[];   // earlier instances of this slot, newest first, at most 8 (R21): name, class, look, level, playtime, ending, memory answer, deaths, last deaths
    stats: { deaths; kills; elites; bosses; recoveries; lastDeath: Partial<Record<PlanetId, { x; z }>> };
  };
  /* player, resources, inventory, equipped, activeWeapon, quick, ship, companions as in v2 */
  progress: SaveV2['progress'] & {
    claimed: string[];                                  // first claims: cache ids (R20) and a predecessor's body (R21)
    exploredBelow: Partial<Record<PlanetId, string>>;   // the underground's explored ground (R20)
    remains: { planet; x; z; resources; restart } | null;   // R21
    resume: { planet; at } | null;                      // R21: where a quit or an interruption left the salvager
  };
}
interface SaveV4 {   // since R26 (SPEC-065): v3 saves migrate with an empty depot and reserves of 100; an older build refuses a v4 save (E9)
  version: 4;
  /* every SaveV3 field, unchanged */
  depot: {
    held: Record<ResourceId, number>;   // what Command Relay keeps for this slot; no cap
    keep: Record<ResourceId, number>;   // the pad terminal's reserve per resource: 0 to the cap, steps of 50, default 100
  };
}
// A slot may also hold one archived predecessor (`reallm:slot:N:archive`, R21). Settings gain, since R18–R21: sharpRender, sprintToggle, stickSprint, unlocks, commendations, installed, among others.
```

Storage rules: 3 slots, key per slot plus a `.bak` copy of the previous good save; autosave at safe points only (station, landing, stage/mission completion, settings change, page hide); hand-written validator on load; export/import as a text code; `navigator.storage.persist()` requested on first save; Safari deletes script-writable storage after 7 days without use unless installed to the Home Screen (→ PWA in M7 + export prompt).

---

## 9. Mobile Strategy

- Responsive canvas + UI breakpoints; one codebase, `pointer` events unify mouse/touch; `touch-action: none` on the canvas, safe-area insets, `100dvh`.
- **Touch controls**: floating virtual joystick (left), aim-drag with auto-fire (right), action buttons, drag-to-steer in flight, auto-fire assist option, left/right-handed swap. Since R10 the quick bar doubles as touch buttons (tap a weapon to switch, a consumable to use it, long-press to choose what the slot holds), a SWAP button cycles weapons, and a tap on the minimap opens the full-screen map, which holds the game while it is open. Since R18 touch plays through the thumb arc — a 2 × 3 cluster of weapon and pack slots at the bottom right, an action cell and DASH above it, pause at the top right — and SWAP and ITEM leave the touch layer. Play stays landscape on phones, and the rotate block holds the world. System Back and Escape share one back-stack, and play pauses when the window loses focus. Since R19 pushing the stick past its ring runs; since R20 a LIGHT button takes the action cell underground, and puzzle panels fit a 293 px-tall landscape phone with 44 px cells.
- **Quality presets** (auto-detect by a 2-second boot benchmark, overridable): clamp `devicePixelRatio` (1 / 1.5 / 2), particles, draw distance, capped enemy count, and the render plan (R6): post-processing off / ¼-res bloom + FXAA / ½-res bloom + MSAA, shadow map on `high` only, image-based lighting on `medium` and `high`; target 60 fps desktop / 30+ fps mid-tier mobile. Since R18 the benchmark times GPU work instead of frame pacing, frames are paced by the wall clock, quality steps down (never up) within a session when a device cannot hold its rate, and a 30 fps setting saves battery.
- Screen wake lock during gameplay and, since R18, films; pause + audio suspend when the tab is hidden; WebGL context-loss recovery overlay.
- Story films (R9) are a DOM `<video>` over a black layer, fetched whole into a Blob so the service worker never answers a Range request; the scene underneath is held, so a film costs a video decode, not draw calls; reduce motion plays a film as its posters (since R18 through the `filmMode` setting, which reduce motion sets to stills by default and a player may set back to video).
- HUD/menu built as HTML/CSS overlay → naturally adapts to small screens; touch targets ≥ 44 px.
- The surface camera sits closer on touch (17 m) than on the keyboard scheme (22 m), so the salvager stays readable on a phone (R17).
- M7: PWA manifest + service worker (precache the whole build) → installable, truly offline, save exempt from Safari eviction. Since R21 the menu offers an install button where the browser allows it, and the Selection card goes out through the phone's share sheet.
- Since R21 an interrupted session resumes on the planet (within 24 h, with no jump and no fuel), so a phone call no longer costs the landing.
- Since R20 a "sharp" option lets `medium` render at up to DPR 2, with the governor stepping it back.

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
| M7c | Playability pass (R10): camera-aligned minimap with a legend and remembered ground, and a full-screen map; objective tracker, waypoints and escalating hints; three weapon slots and three quick slots on a quick bar; machine guns, launchers and explosives with heat and charge cooldowns; caves, wrecks and an arena wall; save v2 (SPEC-025…SPEC-030) | On Cinder-4: every kind of point is recognisable on the map, and the map turns with the camera; walked ground stays lit after a reload; a new player finishes `c1_m1`–`c1_m3` by following the tracker and the marker; medkit and grenade counts are visible mid-fight; a rocket, the chaingun and the pistol get used together; a heatwave is waited out in a cave; the arena edge is a wall; budgets unchanged; checked on desktop and the reference phone; tag `m7c` |
| M7e | The first hour (R17): no trap in collision, a winnable Gauntlet, modal lines that hold the world, the Warden at the Queen's death, waves that attack, collect objectives that count at a full hold, lines at their moment; a closer camera, fog from the player out, hostile rims and readable chapter 1–2 enemies, fading occluders, hit direction, a ramped first visit, flight and combat tips, weapon sounds, briefs, names and item pictures (SPEC-034, SPEC-035) | A new player finishes `c1_m1` on normal without dying and without being trapped; a stock-gun pilot clears `c5_m1`; the Warden speaks at the Queen's death whichever way `c5_m3` was accepted; the Eden wave reaches the beacon; the salvager is visible on every planet and preset; every shot makes a sound; checked on desktop and the reference phone; tag `m7e` |
| M7f | Reach (R18): touch that works — flight aim on touch, the touch scheme at boot, one back-stack, a real rotate block, a station that fits a landscape phone; one HUD for every screen — the thumb arc, legible text on plates, a flash that never strobes; phones at full quality; feedback in play; focus and flow; settings and accessibility (SPEC-036, SPEC-037, SPEC-040, SPEC-042, SPEC-044, SPEC-045) | On a 750 × 342 landscape phone a touch-only player clears `c5_m1`, reaches every station tab and pauses with Back; no HUD element overlaps another or a thumb zone at the phone-landscape sizes; a 60 Hz phone that can hold medium gets at least medium; a keyboard-only player creates a salvager and gets past the first modal line; tag `m7f` |
| M7g | Depth (R18): the dash and committed attacks with ground telegraphs; bosses with move lists and a real arena lock; packs led by elites with affixes; storm waves in survive stages; signature boss drops, retuned classes and arsenal; side rewards, bonus objectives, contracts and a hard difficulty (SPEC-038, SPEC-039, SPEC-041, SPEC-043) | Bot suites: a kiting player takes 1–20 % of max HP a minute and no boss fight lasts under 30 s; a dashing player takes ≤ 5 % per boss; the main-path token surplus is ≤ 300; every class reaches ≥ 80 % of the Marine's damage × effective HP; tag `m7g` |
| M7h | The story listens (R19): conditional lines and placeholders; a clue catalogue with a main-path echo per chapter, the salvager's Notes and Command's rating; the Warden and ARIA name what the player found; Iris, her letters, the keepsake, the medical frame and the memory question; running, stamina and noise, and a Wurm that hunts by vibration; the films retaken — the visored card, the unmaking of the photographs, Iris at the fence and in the grow room (SPEC-048…SPEC-051) | A main-path-only player meets one echo per chapter and hears ARIA's confession name at least the ridge-camp cover; the chapter-4 notice names a clue the player found; Iris's letters arrive after each interlude and only her lines use contractions; a walker leaves the Wurm's burrow unhurt and a runner is caught; no card in any film shows the salvager's face; checked on desktop and the reference phone; tag `m7h` |
| M7i | The world (R20): props in their own colours and shading, on every landing, culled to the screen; save v3; real trees, groves, orchards, dressing clusters, landmarks, ground cover and a ground pass; Eden too perfect; the underground with a flashlight, packs, caches and the machine room; five kinds of puzzle; vault tokens, relics, blueprints, swatches and archive shards (SPEC-046, SPEC-047, SPEC-052…SPEC-056) | A stranger names each biome from a screenshot without the HUD; Thessaly's grove frame stays ≤ 80 scene draws and ≤ 130 k triangles on `medium`; every planet has a reachable descent and a watertight cave; every puzzle kind is solved by keyboard, mouse and touch, and a bypass opens after 90 s; a claimed vault pays nothing a second time; the completionist's tokens read 1,279 and SPEC-039's sink still holds; checked on desktop and the reference phone; tag `m7i` |
| M7j | The next instance (R21): remains; Iteration 63 with the archive, the lineage, containment steps and the world that remembers; the endings' payoff; resume on the planet; a story difficulty; commendations and the evaluation log; the Selection card; link previews and install (SPEC-057…SPEC-059) | A death's loss is recovered from the remains, and a second death loses them; a finished save begins instance/63 in the same slot and restores 62 from the archive; the Vetra log in run 2 names the player's own run; a phone session interrupted on a planet resumes there; the Selection card shares a PNG from a phone; no record is kept in a `?debug` or story session; checked on desktop and the reference phone; tag `m7j` |
| M7m | Who flies them (R24, R25): "Wreckers", a film of the scavengers' hulk after the first departure to Vetra; a scav fighter rebuilt from the tug; contact cards and comms for the first scav fighters at Vetra and the first interceptors at the Hive; Cinder-4's scav raiders in the salvager's suit (SPEC-063, SPEC-064) | On a new save the first departure to Vetra plays "Outbound", then "Wreckers"; the first fighters on that trip bring the contact card, the scav hail and ARIA's answer, and the flight never stops for them; the first interceptors at the Hive bring theirs; a fighter within 20 m reads as a rebuilt tug at the phone preset; on Cinder-4 the raiders are suited people who aim, fire amber tracers, flinch and fall, and the surface stays inside its draw and triangle pins; the films stay within 12 MB and the precache within 25 MB; checked on desktop and the reference phone; tag `m7m` |
| M7n | The Relay depot (R26): the pad terminal ships what the hold carries above a reserve home to Command Relay; the station's Depot tab draws it back; departures and the subsidy count the depot's oil; save v4 (SPEC-065) | On a full hold, the pad terminal ships the oil above a reserve of 100 and the hold reads 100. The station's Depot tab shows it and draws it back up to the cap. A departure is paid from the depot when the hold is short, and no subsidy is granted while the depot can pay. A v3 save loads with an empty depot, and an older build refuses a v4 save. Checked on desktop and the reference phone; tag `m7n` |
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
| Skeletal animation cost on mobile | Only the player + escort NPC are skinned; enemies use procedural transform animation. Since R25 Cinder-4's scav raiders are skinned too, at most 8 at once, with a procedural stand-in past that and when the model is missing |
| Meta twist undercuts the salvage fantasy or lands as a cliché | Surface fiction stays coherent on its own. Until chapter 4 every anomaly arrives with a cover someone offers (sand, a common hand, colony moulds, stims, the medical frame). Each chapter carries one main-path echo; the rest stay optional. Notes, Command's rating and Iris's letters are diegetic. Fourth-wall surfaces appear only in the endings and what follows them: the escaped slot's marker, the restore line, Iteration 63 (refined in R19). House rules: the salvager's card never shows a face; only Iris uses contractions; a replay plays its accept line only |
| Story films outgrow the precache or fail to decode (R9) | H.264 MP4 at 960 × 540 with no audio track, a per-film rate cap (44 KB/s) and a 12 MB `films/` budget inside the 25 MB precache, checked by the build and a test; a film that will not play drops to its posters and then to text, so a codec gap costs pictures, never progress |
| Detonation and jump flashes (photosensitivity, R9) | Flashes are authored as slow ramps; the film build measures every rendered frame against the three-flashes rule and fails on a violation; reduce motion shows posters by default (the `filmMode` setting since R18) |
| The films give the twist away (R9) | The prologue and interludes stay inside the surface fiction (a card numbered 62, a stutter of static at most); only the ending films show the scaffolding — the endings already own the fourth wall. Since R19 each interlude plants one doubt that still reads in the fiction (a grid of lights too regular, a six-frame tear, a blank card No. 63 on the board) |
| HUD clutter on a phone (R10) | The quick bar, tracker and hints each own one fixed place (bottom centre, top left, bottom left), sized with `clamp()`; guidance can be turned down to minimal or off; the full map is modal |
| Shelters and hiding trivialise storms and survive stages (R10) | Waves and bosses ignore hiding, firing gives the player away for 1.5 s, and survive stages still run their waves; storms stay lethal in the open, and a shelter is a detour |
| Managing weapons on touch (R10) | Auto-fire keeps working; a locked machine gun hands fire to the sidearm on touch; the heavy slot fires only on an explicit trigger and hands back to the previous weapon when it is empty |
| The twist is over-explained (R19) | Main-path echoes are one or two short lines, each with a cover until chapter 4; the Warden's and ARIA's conditional lines are capped at four each; everything else is optional and recorded in Notes, not repeated |
| Running brings back "walking away is a complete defence" (R19) | Running holsters the gun and is loud, and stamina drains in combat; a bot suite asserts a running kiter takes at least 1.25× the damage per kill of a walking one, and fails when the holster is switched off |
| A second level inside the surface scene breaks the surface (R20) | The level refactor lands first with no behaviour change, and the pinned surface layout hashes prove nothing moved; objectives, POIs and timers read the active level, and timed stages hold underground |
| The layout pins move for the first time since SPEC-030 (R20) | One spec moves them, in one change, with corridors, reachability and the spawn ring asserted over 200 seeds per planet; arena sizes do not change, so no explored map is dropped |
| Alpha-tested leaves cost a phone its frame rate (R20) | Lambert leaves, opaque low-detail crowns on `low`, ground cover off on `low`; the governor steps down; a grove sub-budget (≤ 30 k triangles, ≤ 12 draws on `medium`) is pinned, and the first hardware run measures a Thessaly grove |
| The precache fills up (R19–R21) | This wave's allotment: world art ≤ 1.0 MB, film retakes ≤ 0.7 MB, sounds ≤ 0.1 MB, item pictures ≤ 0.1 MB — about 23.5 of 25 MB; link-preview images and screenshots are kept out of the precache |
| A puzzle blocks a player (R20) | Hints are free, a bypass opens after 90 s of open time or 3 hints, and no puzzle gates a mission, a planet or a flag a requirement reads |
| Records and shared cards are forged or spoil the twist (R21) | Nothing is recorded in a `?debug`, story or service session; production builds carry no debug strip and ignore `?scene=`; before an ending the Selection card shows only what the prologue already shows |

---

## 13. Edge-case register (decisions)

Each entry names the owning spec. "Casual" = casual difficulty.

| # | Situation | Decision | Spec |
|---|---|---|---|
| E1 | Player can't afford fuel to any unlocked planet | On entering the station, `oil = max(oil, cheapest unlocked jump)`; ARIA line "Earth Command wired an emergency ration". Boss missions also grant a refuel voucher. Since R17 the floor is the higher of that jump and the fuel of any planet whose accepted main flight mission is still open, so a failed Gauntlet can always be flown again | SPEC-010, SPEC-034 |
| E2 | Player spent all tokens and can't meet the shield-2 gate | Completed missions replayable at 50 % rewards; invariant guarantees worst-case tokens ≥ loadout | SPEC-010 |
| E3 | Cargo full during a collect objective | Base cap 400 ≥ any objective; pickups stop with a "CARGO FULL" toast; invariant tested. Since R17, while an active collect objective still needs that resource, what the hold cannot take is shipped home: it counts toward the objective and does not enter the hold (E56) | SPEC-010, SPEC-034 |
| E4 | Death on the surface | Respawn at pad, full HP, 2 s invulnerability, −10 % carried resources (0 % casual), timed/escort/defend stages restart, enemies within 40 m of pad despawn, boss resets | SPEC-012 |
| E5 | Death in flight | Emergency recall to station; fuel lost; cargo kept; flight mission stage resets | SPEC-013 |
| E6 | Tab hidden / phone locked mid-combat | Loop pauses, audio suspends, accumulator reset on resume (no catch-up), best-effort save on `pagehide` | SPEC-002, SPEC-007 |
| E7 | WebGL context lost (iOS memory pressure) | Pause + overlay; on restore, renderer re-inits; if not restored in 5 s, offer reload (save is at last safe point) | SPEC-002 |
| E8 | localStorage unavailable/quota exceeded/corrupt | Boot in "no-save" mode with a warning; quota → drop `.bak` and retry once; corrupt → offer `.bak` or reset; export code always available | SPEC-007 |
| E9 | Save from a newer app version | Refuse to load; show version + export option | SPEC-007 |
| E10 | Stuck keys after alt-tab / focus loss | `blur` and `visibilitychange` release all actions; `pointercancel` releases touch | SPEC-005 |
| E11 | Multi-touch: joystick + fire simultaneously | Per-pointer ownership by `pointerId`; left zone = move, right zone = aim/fire | SPEC-005 |
| E12 | A flight mission's objectives not met at arrival | Landing blocked until the arrival wave is cleared ("can't land with hostiles on our tail") **and** no accepted main flight mission is still open; waves spawn ≥ 2× required kills; the holding pattern caps at 90 s and lands anyway (R16) | SPEC-013 |
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
| E35 | Photosensitive viewer | Authored flashes ramp up over ≥ 4 frames and down over ≥ 12; the build fails a film with more than three flashes in any second; reduce motion never shows a flash unless the player sets `filmMode` back to video (R18) | SPEC-021, SPEC-022 |
| E36 | Full-screen map opened mid-fight | The map holds the simulation like the pause menu; nothing moves or hurts until it closes; Escape closes the map, never the game | SPEC-026 |
| E37 | Explored ground saved for a planet whose arena size has since changed | The mask no longer fits; the validator drops it and the planet starts dark again | SPEC-025 |
| E38 | A v1 save loaded after R10 | Migrates to v2: the old weapon becomes the primary, the Service Pistol fills the sidearm slot, the heal slot takes the first heal item in the pack, the heavy slot is empty | SPEC-025 |
| E39 | Player stuck with no progress on an objective | Help escalates at 45 / 90 / 150 s of no progress and no headway outside combat (pulse, ARIA direction, a ground route); guidance full / minimal / off; nothing completes by itself | SPEC-027 |
| E40 | A quick slot is empty, or a heal is used at full HP | Nothing is spent; a throttled toast says why; an empty slot refills from the pack when an eligible item is carried or picked up | SPEC-028 |
| E41 | The weapon in hand is locked or recharging mid-fight | Cooldowns run while holstered; on touch a locked machine gun hands fire to the sidearm; the heavy slot never auto-fires and returns to the previous weapon when its charges are spent | SPEC-029 |
| E42 | An explosive goes off next to the player or the escort | Blasts damage enemies only; the player and the follower take nothing | SPEC-029 |
| E43 | Player hides in a shelter through a survive stage or a wave | Allowed: timers run; wave and boss enemies ignore hiding; firing reveals the player for 1.5 s | SPEC-030 |
| E44 | A shelter would block a corridor or enclose a POI or node | Shelters keep out of every pad → POI corridor and away from POIs and nodes; their walls are never removed by repair, and every interior is validated reachable | SPEC-030 |
| E45 | Shots, enemies or the player at the arena edge | All stop at the wall's line (`halfSize − 2`); a rocket that reaches it explodes there | SPEC-030 |
| E54 | A hit, a shove or a blast would put a body inside an obstacle | It moves only as far as the obstacle allows; a body found inside one is pushed out the shortest way before its next step, so nothing can be held inside a rock | SPEC-034 |
| E55 | The player is stuck, lost or wants out of a fight | Recall to pad (surface pause menu): the respawn of E4 without the death — timed, escort and defend stages restart, the boss resets, no resources are lost | SPEC-034 |
| E56 | A collect objective's resource while the hold is full | The surplus is shipped home: it counts toward the objective, never enters the hold, and a throttled toast says so | SPEC-034 |
| E57 | A modal line or the verdict choice opens mid-fight | The surface holds its simulation until it closes; a boss's summons die with it, and a finished defend stage's wave leaves | SPEC-034 |
| E58 | The ship lands with `c5_m1` still open (a failed Gauntlet) | E12's 90 s cap still lands it; the pad names the board, and E1 tops the hold up to the Hive's fuel at the next station entry | SPEC-034 |
| E59 | A dash runs into an obstacle or the arena wall | It stops at the contact and never ends inside the obstacle (E54's resolve); its 0.3 s of invulnerability still runs | SPEC-038 |
| E60 | A ground telegraph covers the escort follower | Circles, lanes and rings hurt the player and the follower, never a defended structure, which keeps its contact rule | SPEC-038 |
| E61 | A rusher's charge meets the follower or an obstacle | It can hit the follower; an obstacle or the wall ends it as a whiff; nothing pushes the player into an obstacle | SPEC-038 |
| E62 | The player reaches a live boss's arena ring | Held inside the ring while the boss lives; the exits are death and Recall to pad, and both reset the boss | SPEC-041 |
| E63 | Death during an active boss stage | Respawn at the arena entrance on the pad side, E4's 2 s invulnerability, the boss reset | SPEC-041 |
| E64 | A pack member's spawn point is blocked | That member is dropped; a pack is never split across two points | SPEC-041 |
| E65 | A phone is turned upright during play | The world holds under a full-screen rotate block above every layer; turning back shows the pause menu | SPEC-036 |
| E66 | System Back or Escape | Closes the top layer (sheet, picker, map, settings), else toggles pause in play; the star map goes back to the station; at the menu root Back leaves the page | SPEC-036 |
| E67 | The window loses focus during play | Play pauses (`pauseOnBlur`, on by default) and waits for the player to resume | SPEC-036 |
| E68 | A device cannot hold its frame rate | Quality steps down one rung at most every 20 s, never back up within the session, and a toast says so | SPEC-040 |
| E69 | A boss's signature weapon is already owned | The boss drops 25 lithium instead; a replay kill pays half its XP and never the weapon | SPEC-039 |
| E70 | A bonus objective's attempt is interrupted | A death forfeits a no-death bonus; a reload forfeits every bonus of that attempt, as E19 restarts timers | SPEC-043 |
| E71 | Many hits land within one second | The damage flash rises at most three times a second, and weather never flashes | SPEC-037 |
| E72 | A planet's prop models arrive after the surface view is built | The procedural stand-ins draw until the set lands, then every prop kind swaps to its model in place — same positions, collisions, fades and layout hash. The surface waits up to 1.5 s behind the fade first, so a cached set never shows the stand-ins | SPEC-040, SPEC-046 |
| E73 | A v3 save is opened by an older build (a stale PWA, an export carried to another device) | Refused as a save from a newer version, with Export (E9); nothing is stripped silently | SPEC-047 |
| E74 | A v2 save is loaded after R20 | Migrates to v3 with an empty lineage, zeroed stats, nothing claimed, nothing explored below, no remains and no resume point | SPEC-047 |
| E75 | A clue's line is dropped by the dialogue queue or a scene change | The clue's flag is set when its line starts, never at the trigger, so a dropped line leaves the clue findable | SPEC-048 |
| E76 | A mission is replayed (50 %, or a contract) | It plays its accept line only; the story's stage and completion lines belong to the first run | SPEC-048 |
| E77 | ARIA's cover stories play after her confession (side missions left open) | Each cover has a post-confession variant, so ARIA never repeats a lie she has admitted | SPEC-048 |
| E78 | Several of Iris's letters are due at once (films off, an older save) | One letter plays per station entry, oldest first; each sets its own flag when it plays | SPEC-049 |
| E79 | Stamina runs out mid-fight, or the dash is pressed below 30 | Running and the dash are refused until the pool is back at 30; walking is never slowed | SPEC-050 |
| E80 | The run key is held across a mode or scene change, or the touch stick is cancelled mid-run | Every action is released on the transition (E10); a key-up releases the action its key-down pressed, and a cancelled stick releases the run with it | SPEC-050 |
| E81 | A grove, orchard or dressing cluster falls on a corridor, a POI, a node or the spawn ring | It is placed like SPEC-030's outcrops, clear of every corridor, POI, node and the pad; corridors, reachability and the spawn ring are asserted over 200 seeds | SPEC-053 |
| E82 | An enemy or a pickup stands under a canopy | That canopy dithers to 0.35 while the enemy lives or the pickup lies there within 25 m of the player; the player's own cut-out always shows the salvager | SPEC-053 |
| E83 | A descent is tried during a survive, defend, escort or boss stage, with a follower, or under forced mission weather; or a stage turns timed while the player is underground | The descent is refused and the prompt says why. A stage that starts underground waits for the surface: its timer holds at 0, and its waves, follower and storm start on the way up | SPEC-054 |
| E84 | Death or Recall underground | The level returns to the surface first, then E4 or E55 runs unchanged; the cave resets at the next descent, and claimed caches stay claimed | SPEC-054 |
| E85 | A quit or a reload underground | Continue never lands underground: it enters the station as R18 decided, and since R21 it resumes at that planet's pad (E96). Claims and the explored ground were saved as they happened | SPEC-054, SPEC-059 |
| E86 | Loot lies on the surface at a descent | It is cleared, with the toast "Loot left behind" when any lay within 10 m | SPEC-054 |
| E87 | A planet places no cave shelter on some seed | The descent anchors in the first wreck instead, `min(3.5, r − 1.5)` m behind its centre (r the interior radius toward the back), so it is never inside the hull; with no shelter at all, that save has no underground on that planet. A layout test over 400 seeds per planet guards the rule | SPEC-054 |
| E88 | A player cannot solve a puzzle | Hints are free; a bypass opens after 90 s of open time or 3 hints and gives everything but the flawless extra; nothing a requirement reads sits behind a puzzle | SPEC-055 |
| E89 | A vault or cache is reached again: a later landing, a replay, a reload | It renders opened and pays nothing; a solved puzzle stays solved for the visit | SPEC-056 |
| E90 | A relic is claimed with a full pack | It goes to the relic rack, never to the pack, so it can never spill or be discarded | SPEC-056 |
| E91 | A death while remains lie anywhere | The old remains are lost with a toast; the new remains hold this death's loss (normal 10 %, hard 20 %, casual none) | SPEC-057 |
| E92 | Remains would fall inside an obstacle, past the wall, in a boss stage or underground | Pushed out of obstacles and clamped inside the wall; in a boss stage they fall at the arena entrance where the respawn lands; underground they fall at the planet's descent | SPEC-057 |
| E93 | Remains are recovered into a full hold | The hold takes what fits and the rest stays in the remains; recovered units never count toward a collect objective | SPEC-057 |
| E94 | Iteration 63 is begun from a slot | The old save moves to that slot's archive and can be restored once; the new instance keeps only per-device records and unlocks, and the lineage | SPEC-058 |
| E95 | An escaped save is continued | Its slot reads `disconnected`; the station plays the Warden's "restored from the last checkpoint" once, and the run goes on in free roam | SPEC-058 |
| E96 | A session is interrupted on a planet (a call, an OS kill, Save & Quit) | Continue within 24 h lands at that planet's pad with no jump and no fuel, timed stages restarting (E19); after 24 h a "previously" card comes first | SPEC-059 |
| E97 | A best time, commendation or share stat would be recorded in a `?debug`, story or service session | Nothing is recorded, and the share card says "story mode" where it applies | SPEC-059 |
| E109 | The first departure to Vetra with films off, or with "Wreckers" missing or undecodable | With films off, no film or contact card plays, but the contact lines still say who flies the fighters. A missing film falls back to its posters, then to text, like every film | SPEC-063 |
| E110 | The first flight to Vetra or the Hive is recalled, or the game reloads, before or after its first group | `visits` is still 0. A later departure in the same session plays neither the film nor the contact again (session keys); after a reload both play once more, as the departure and the chapter card do (SPEC-023 23-a) | SPEC-063 |
| E111 | The first group spawns while the chapter card is up, while a line is playing, or under the pause menu | The flight never holds for a contact (SPEC-042). The card waits until the chapter card is gone, and the lines queue behind the line in progress. A pause holds the flight, so no group can spawn under it | SPEC-063 |
| E112 | A flight enemy meets the player on a later planet than its contact planet: Thessaly's and Ferrum's fighters, or Eden's interceptors | No card and no contact lines. Each enemy has exactly one contact planet, the first in chapter order whose flight carries it, and a content test pins that | SPEC-063 |
| E113 | `character.glb` is not loaded (a failed load, a test with no assets) | Every raider is drawn with the procedural `scav` stand-in, an instanced recipe like any other enemy; nothing else changes | SPEC-064 |
| E114 | More than 8 raiders are alive or falling at once (only a cave can reach it) | The oldest falling raider is dropped first; past that, the newest live raiders are drawn with the `scav` stand-in until a slot frees | SPEC-064 |
| E115 | A raider is killed mid-aim, mid-recoil or mid-flinch, or the scene exits while one falls | The falling copy crossfades into Death from its current pose; a scene exit disposes it with the scene. It is a view only: nothing collides with it and nothing targets it | SPEC-064 |
| E116 | A raider is elite, has an affix, is invulnerable, or is underground | The instanced rules apply unchanged: elite colour, emissive, 1.3× scale and plate; invulnerable at half colour; `rimOf` underground. Only the 1.15× windup swell is replaced, by the aim and the muzzle glint | SPEC-064 |
| E117 | Shipping cargo home while a deliver objective on this planet still needs that resource | `Ship N home` never takes the hold below what the planet's active deliver objectives still need, whatever the reserve says | SPEC-065 |
| E118 | Drawing from the depot into a full hold, or more than the hold has room for | `Draw N` draws the lesser of the depot's amount and the hold's room; at 0 the button is disabled and nothing moves | SPEC-065 |
| E119 | Oil parked in the depot when the hold cannot pay for a jump | A departure counts the hold and the depot together and takes from the hold first; the station subsidy grants only what both together lack, so parked oil never earns free oil | SPEC-065 |
| E120 | A v3 save is loaded after R26, or a v4 save by an older build | v3 migrates to v4 with an empty depot and every reserve at 100; an older build refuses a v4 save as a save from a newer version, with Export (E9) | SPEC-065 |

---

## 14. Spec index

See the roadmap [SPEC-000](https://github.com/mdzunic/reallm-specs/blob/main/specs/000-roadmap.md) in the reallm-specs repository (local checkout: `../reallm-specs/specs/000-roadmap.md`). Each spec is a factory work order `specs/NNN-slug.md` with `id: SPEC-NNN` in its frontmatter; the GitHub Issue that triggers its build carries the same id in its title. Old two-digit spec numbers map to SPEC-(NN+1); SPEC-000 is the roadmap. Build order follows `depends_on` (a topological sort listed in SPEC-000), not the milestone numbers, which remain the playable checkpoints.
