# R19 audit — three new mechanics: stamina and sprint, the underground, puzzles

> **Provenance.** Written on 2026-09-27 for PLAN R19–R21, against a snapshot of `main` at `2cf398a` (SPEC-035 and PLAN R18 merged; SPEC-036…045 written, not built), which the report calls `SCRATCH/game-r19`. `SCRATCH` was that review session's working folder; its probes, captures and simulation scripts are not kept in the repository. The decisions taken from this report are PLAN R19, R20 and R21 and the specs SPEC-046…SPEC-059 in `mdzunic/reallm-specs`; where a report and PLAN differ, PLAN wins.

Auditor area: mechanics · prefix `G-` · snapshot `SCRATCH/game-r19` (game `main` at 2cf398a) · R18 specs SPEC-036…045 read as the baseline (not built).

Evidence produced for this report (all in `SCRATCH/r19/mech/`, nothing in any repository was changed):
- `sim/exp_sprint.mjs`: 60 Hz field sims. It reuses the R18 combat audit's port (`SCRATCH/audit-combat/engine.mjs`) unchanged and adds sprint, stamina and noise in the bot wrapper. Runs are 3 min × 4 seeds × 5 planets, `medium`, Marine 6/5/1/1 and Scout 2/1/9/1. Outputs: `out_*.md`, `out_final_*.md`.
- `sim/exp_chase.mjs`: 30 s chase duels on open ground, with no firing.
- `sim/calc_traversal.mjs`: travel arithmetic at 60 Hz.
- `game/` is a private copy of the snapshot with `node_modules`. Its `tests/zz-probe-caves.test.ts` covers cave placement over 400 seeds × 6 planets. `tests/zz-probe-underground.test.ts` prototypes the proposed cave generator on the real `ObstacleGrid` and `isReachable`, over 150 seeds × 6 planets. `tests/zz-probe-obstacles.test.ts` counts surface obstacles. Each probe writes its results to a `.json` file beside it.

---

## 1. Verdict

1. **Sprint fits the game and does not reopen R18's "walking away is a complete defence", provided that sprinting holsters the gun and makes noise.** With both costs, a sprint-kiter takes 2.0–3.1× the kite bot's damage per kill, on both classes, in both the SPEC-038 world and the SPEC-038+039+041 world. A free sprint (no stamina, firing while running, silent) halves a Scout's damage with no loss of kills. The holster rule is what keeps sprint safe.
2. **SPEC-038's dash, as specced, is the fastest way to travel.** Dash-hopping averages 9.1 m/s for a Marine and 12.4 m/s for a Scout (agility 9), which is +49–52 % over walking and faster than any sensible sprint. Stamina should be one "legs" budget that the dash also draws from: a 30-point cost. In field fights that cost never binds, because the bots dash at most 2.5 times a minute.
3. **"Walk, do not run" becomes the Wurm's pattern.** SPEC-041 explicitly left this to R19 (its Out of scope: "The burrow following a running or firing player … That is the story pass, R19"). Under this proposal the burrow circle follows a sprinting player and stays put for a walker, and SPEC-041's fairness invariant still holds.
4. **The underground should be a level inside the surface scene, not a new scene.** A new scene would count the visit twice (single-writer test), heal the player on every ascent, re-run the landing save and dialogue, and dispose the surface world. A level needs one refactor: every coordinate consumer in `Surface.ts` (about 53 references) reads the active level. Descents go at the back of the existing SPEC-030 cave shelters, which the probe places on every seed and planet. That keeps every pinned surface layout hash.
5. **A prototype generator shows the cave shape works.** It builds 5–7 rooms with MST corridors and SPEC-030's own wall circles, and gives about 280 wall circles, 0 unreachable rooms, 0 leaks and under 0.1 ms per level. A cave view costs about 12 scene draws, well inside 80 + 16.
6. **Puzzles should be a pure `systems/Puzzles.ts`.** Every board is generated from a solved state or a constructed path, so a test can prove it solvable. There are five kinds. Three are terminal overlays: conduit, calibration (lights-out) and sequence ("predict the next token"). Two are world puzzles on the XZ plane: plates and a beam with mirrors. All work with keyboard, mouse and touch. Hints are free, and a bypass means no player is ever stuck. Puzzles gate only optional caches.
7. **Paying caches in tokens is almost ruled out.** SPEC-039's decision-sink invariant (975 ≥ 0.75 × 1,249) leaves 51 tokens of headroom for every optional token source combined. Caches should pay items, resources and story shards, the same choice SPEC-043 made for bonuses.
8. **The save should go to v3,** adding `progress.caches` and `progress.exploredBelow`. The event pins move by 6 events (5 reacted, 1 silent) and the sprite pins by 4, on top of R18's totals of 71 / 26 / 45 / 58.

---

## 2. What exists today

### 2.1 Movement, speed and input

| Fact | Where |
|---|---|
| One ground speed: `TUNING.PLAYER_SPEED` 6 m/s | `src/data/tuning.ts:47` |
| `moveSpeed = PLAYER_SPEED × passive.moveSpeedMult × (1 + 0.02 × agility) × boosts.moveMult`, where the last factor is the weather multiplier. Armour has no speed term: armour items carry only `armor` and `hazardResist` | `systems/Combat.ts:162` (`computePlayerStats`, :148) |
| Speeds by class: Marine agility 1 → 6.12; Engineer agility 2 → 6.24; Scout (`moveSpeedMult` 1.15) at agility 4 → 7.45, at agility 9 (4 + 5 points) → 8.14, at `ATTRIBUTE_MAX` 10 → 8.28 | `data/characters.ts:51-85` |
| Weather slow `WEATHER_EFFECTS.moveMult`: sandstorm 0.8, heatwave 0.9, blizzard 0.75, avalanche 0.7, spore storm 0.85, radiation 0.9. It is pushed by `Combat.setWeatherMoveMult` on `weather:changed`, is pinned to 1 inside a shelter, and is restored on leaving | `systems/Weather.ts:25-30`; `Combat.ts:381`; `scenes/Surface.ts:1782-1788, 4090` |
| Movement is written by the scene. `Surface.#movePlayer` sets `vx = (move.x − move.y) × √½ × moveSpeed` and `vz = (−move.x − move.y) × √½ × moveSpeed` (the camera yaw). It calls `resolveCircle` before the axis slide, then clamps to `halfSize − WALL_INSET` | `scenes/Surface.ts:1586-1612` |
| Facing follows movement when not firing, and turns to the aim when firing | `Combat.ts:955-956, 1108-1112` |
| `Combat.inCombat` is true while any aggroed enemy has been within 20 m in the last 4 s (`IN_COMBAT_RADIUS`, `IN_COMBAT_SECONDS`) | `Combat.ts:110-111, 376` |
| There are 16 actions (`ACTIONS`). The move vector is unit-clamped with a radial dead zone of 0.15 (`shapeMove`) | `core/Input.ts:27-74, 79, 180-190` |
| `KEY_BINDINGS` is one flat code → action table used in both modes. It maps **`ShiftLeft` → `throttleUp`** and `KeyX` → `throttleDown`. `throttleUp` is read only by `scenes/Flight.ts:623`, so **Shift does nothing on the surface**. `ShiftRight`, B, H, I, J, K, L, N, O, U, Y and Z are unbound. The table is pinned as a literal in `tests/core/input.test.ts:604-636` | `core/KeyboardMouseDriver.ts:23-52` |
| The wheel already maps by mode: weapons on the surface, throttle in flight. This is the precedent for a per-mode binding | `KeyboardMouseDriver.ts:263-283` |
| Mouse button 2 raises no action today (AC-23). SPEC-038 gives it to `dash`, together with `KeyV` | `KeyboardMouseDriver.ts:248-251` |
| Touch stick: `JOYSTICK_RADIUS_PX` 56 gives full deflection. The origin drifts only past `FLOAT_DRIFT` 1.6 × 56 = 89.6 px, so the raw magnitude reaches 1.6. `#steer` sends `dx/56`. The knob is drawn clamped at 56 px | `Input.ts:87-89`; `ui/TouchControls.ts:296-319` |
| SPEC-036 makes the stick reach full speed at 60 % travel (`TOUCH_FULL_TRAVEL` 0.6, `shapeTouchStick`): 8 px reads 0 and 34 px reads 1. **There are 22 px of unused travel between full speed (34 px) and the drawn ring (56 px), and 56 px up to the drift point** | SPEC-036 §3, §4.7 |
| `MODE_BUTTONS.surface` today is `['interact','useItem','weaponNext','pause']`, and SPEC-037 cuts it to `['interact','pause']`. `BUTTON_LABELS` is `Record<Action,string>`, so every new action needs a label | `TouchControls.ts:47-72` |
| Character animation has `idle \| run \| attack \| hit \| death`, with `run` chosen above a speed threshold. There is no sprint clip. `CLIP_ALIASES.run` also accepts `walk` | `core/CharacterState.ts:7, 56, 70-72` |

### 2.2 Threat, aggro, noise and the Wurm

| Fact | Where |
|---|---|
| Aggro is radius only: `aggroRadius = def.aggroRadius × (world.aggroMult ?? 1)`. `aggroMult` is storm visibility, `1 − (1 − visibility) × intensity`. **There is no noise term** | `systems/EnemyAi.ts:255`; `Surface.ts:1851` |
| Radii: swarm 18, rusher 20, ranged 22, boss 60. Leash: 40 / 45 / 45 / 60. Aggro spreads 8 m within a species | `data/enemies.ts` (every surface row); `EnemyAi.ts:41` |
| Speeds: swarm 6.5, rusher 5, ranged 3.5 (strafe 3.5), boss 4. Elite ×1.1 (`ELITE_SPEED_MULT`). SPEC-041's swift affix is ×1.35 on top, so a swift elite skitter runs 9.65 m/s. SPEC-038 keeps a swarm's full speed through its windup and gives rushers a 20 m/s charge over 10 m from 6 m. Ranged range is 13 m, with shots at 15 m/s | `enemies.ts`; `Combat.ts:119`; SPEC-038 §4.3–4.4; SPEC-041 `SWIFT_SPEED_MULT` |
| Hiding (SPEC-030) applies inside a shelter when no shot has been fired for `REVEAL_AFTER_SHOT` 1.5 s. A hidden player is acquired only within `HIDDEN_DETECT_RADIUS` 5 m with a clear line, and a lost track drops after `LOSE_TRACK_SECONDS` 3. **Only firing reveals the player**; movement does not | `systems/Shelter.ts:7-15`; `Surface.ts:1791`; `EnemyAi.ts:259-268, 547-563` |
| The snapshot's burrow: a 3 s dig, then a 1 s telegraph 5 m from the player, then a 4 m shockwave (`BURROW_*`). SPEC-041 replaces it with a timed move: a 2.5 s dig, then `telegraphCircle` **on the player's sampled position**, radius 3.5, windup 1.2 s, ×1.5 damage, every 9 s. Its fairness invariant is `radius + 0.5 ≤ v × (windup − 0.3)`, which reads 4.0 ≤ 5.4 | `EnemyAi.ts:58-62, 471-499`; SPEC-041 §4.1–4.3 |
| "Walk, do not run" appears in the scav's warning (`c1_m1` stage 2 and the `c1_s2` echo), ARIA's "Do not run", the Wurm's reveal (`It hunts by vibration` / `Walk, do not run. I mean it this time.`) and the demo charge's blurb. **No mechanic distinguishes walking from running** (first review S-05, still open) | `data/dialogue.ts:54, 79, 106`; `data/films.ts:312`; `data/items.ts:473` |
| SPEC-038's kite bot (`tests/systems/threat.test.ts`, `threatBots.ts`) walks away from any body within reach + 3.5 m (5 m for ranged) and otherwise closes to 0.75 × weapon range, with auto-fire on. Its thresholds are 1–25 % of max HP per minute, with at least 5 % of that damage from `enemy` sources | SPEC-038 §6.1 |

### 2.3 Caves, layout, levels, save and map

| Fact | Where |
|---|---|
| Today's "caves" are SPEC-030 shelters: a 6 m interior circle (`CAVE_RADIUS`) with a 4.5 m gap facing the pad within ±60°, walled by `cave_wall` circles of 1.1 m every 1.5 m. `features.caves` is 2 on every planet except Eden (1). Caves are placed before wrecks, `index` counts from 0, and a shelter is skipped if all 80 tries fail (D-4) | `systems/Layout.ts:121-124, 585-640`; `data/planets.ts:168, 222, 279, 336, 389, 444` |
| **Probe:** over 400 seeds × 6 planets every planet placed all its caves (2, Eden 1). A descent point 3.5 m behind the cave's centre, away from the gap, was **never blocked** (0.9 m circle) and **always reachable**. Median distance from the pad is 91–122 m (P10 52–70, P90 123–162). One `generateLayout` takes 1.4–3.1 ms | `r19/mech/game/tests/zz-probe-caves.json` |
| `generateLayout(planet, rng)` forks `pois`, `nodes`, `shelters`, `outcrops`, `obstacles` and `props`. `Rng.fork(label)` hashes the seed and the label, not the stream's state, so **a new `fork('underground')` moves no existing stream**. The layout seed is `hash32(saveSeed, planet, 'layout')` | `Layout.ts:468-477`; `core/Rng.ts:222-253` |
| The pinned hashes at `PIN_SEED` 20121 are cinder4 3559157477, vetra 1763254407, thessaly 2630545287, ferrum 957609825, hive 2917833905 and eden 150940712. `layoutHash` covers the pad, spawn, POIs, nodes, obstacles, props and shelters | `tests/systems/layout.test.ts:26-39`; `Layout.ts:880` |
| `ObstacleGrid` (2 m buckets) handles circles only: `hitsCircle`, `resolveCircle` (clamped to `±(halfSize − WALL_INSET)` around the origin), `lineHit` (**O(n) over every obstacle**) and `lineClear`. `isReachable` flood-fills a 2 m, 4-connected grid from `layout.pad` | `Layout.ts:227-399, 409-465` |
| Surface obstacle counts at the pin seed are 80–143, of which 26–52 are `cave_wall` and 24–48 are `wreck_hull`. Scatter adds only 23–33 rocks | `zz-probe-obstacles.json` |
| One scene is active at a time. `SceneId` = `menu \| creation \| station \| starmap \| flight \| surface`. `ALLOWED_TRANSITIONS.surface = ['station','menu']`, and self-transitions are rejected (D-9) | `core/StateMachine.ts:14-25, 70-77` |
| `Surface.onEnter` generates the layout and **counts the visit** (`progress.visits`, which a test holds to a single writer). It sets `location = 'surface'`, **restores HP** ("landing always restores HP"), builds the view and map layers, requests the `landing` save and replays accept lines | `Surface.ts:694-707, 1017-1038`; `tests/architecture/visitCount.test.ts` |
| `CombatWorld` fields: `obstacles`, `arena`, `bounds` (`halfSize − WALL_INSET`), `aggroMult` and `playerHidden`. They are plain mutable fields, so they can be swapped | `Combat.ts:217-243`; `Surface.ts:710-719` |
| The scene holds its step for four reasons: `beats`, `ui` (the map and the picker; SPEC-036 adds the pad terminal), `modal` (`surfaceHoldReason`), and SPEC-036's added `'rotate'` | `systems/UiHelpers.ts:490-515`; `Surface.ts:1113-1150` |
| Coordinate consumers of the one layout: `#layout`, `#pois`, `#nodes`, `#pad`, `#arenaPoi`, `#mask`, `#layers` and the `halfSize` clamps together have **about 53 references in `Surface.ts`**. `MissionContext.nearPoi` and `poiAt` compare the player's XZ with surface POIs | `Surface.ts` (grep); `systems/Missions.ts:59-65` |
| A survive timer runs while `ctx.player.alive`, and a defend timer always runs. Neither has any notion of place | `Missions.ts:444-460` |
| `SpawnDirector.update(dt, player, frustum, missionsWantSpawns)`: with `false`, no ambient spawns occur, but waves and culling still run. Culling removes an enemy that has been un-aggroed for 10 s beyond 70 m (`DESPAWN_DISTANCE`). `despawnNear(x, z, radius)` sweeps silently | `systems/Spawn.ts:39-47, 192-231, 302` |
| Save v2. `validateSave` rebuilds the save field by field, and **unknown keys never survive**. `progress.explored` is `Partial<Record<PlanetId,string>>`, and each entry is length-checked against `planetHalfSize` (E37). `flags` are filtered against `STORY_FLAGS`. `poisDiscovered` is free-form (`${planet}:${poi}:${n}`, `${planet}:shelter:${n}`). `location` is informational: Continue always goes to the station, and R18-12 rules out resuming on the planet | `core/Save.ts:56, 116-190, 541-600, 842-935`; `Surface.ts:700, 1803` |
| Pinned save literals: `expect(SAVE_VERSION).toBe(2)` and the fresh `progress` `toEqual` (AC-10). Migrations 0 → 1 and 1 → 2 exist | `tests/core/save.test.ts:216-229`; `Save.ts:955-1045` |
| `ExploreMask` uses 4 m cells (`EXPLORE_CELL`) and the module-wide `EXPLORE_RADIUS` 24 m (`REVEAL_CAPACITY` 169). `MapLayers` paints a `Layout`: terrain once per visit at 1 px = 1 m, plus fog. `MapIconKind` already reserves `shelter_cave` (an arch) and `shelter_wreck` | `systems/Exploration.ts:13-20`; `ui/MapLayers.ts:52-75`; `systems/MapModel.ts:26-100` |
| The view: one `SurfaceView` root holds everything, environment and actors alike. Lights are hemisphere + key (sun, the shadow caster) + a cool rim, plus a **torch `PointLight(0xffc98a, 6, 14, 2)` riding the player group**. Shelter walls are collision-only; the shelter body is their visual | `views/SurfaceView.ts:583-592, 610-616, 839-842` |
| Budgets: surface on `medium` ≤ 80 scene + 16 post draws and ≤ 130 k triangles. Measured totals are 46–55 draws (scene share 30–39) and 34–92 k triangles. The precache is about 21 MB of 25. `models/` holds 2.6 MB of 4, `textures/` 4.5 of 6, `audio/` 4.5 of 12, `films/` 8.6 of 12 | `docs/playtest-log.md:753-768, 906-910`; `public/assets/*`; SPEC-040 |

### 2.4 Patterns a puzzle can reuse

| Pattern | What it gives | Where |
|---|---|---|
| `ScanRing` | A world-anchored DOM ring with a conic `--scan` fill, positioned from a projected point and cheap to update | `ui/ScanRing.ts` |
| `openQuickPicker` | A panel in the `panel` layer that closes on Escape (capture phase) and on an outside tap. The scene holds its step while it is open (`#uiHolds`) | `ui/QuickPicker.ts`; `Surface.ts:2489` |
| `choiceSheet` / `confirmSheet` | Promise-shaped sheets with re-validating handlers (14-c) and a settled flag that blocks double-taps | `ui/ConfirmSheet.ts` |
| Pad terminal | A DOM panel toggled by `interact` inside the step. SPEC-036 makes it hold the world | `Surface.ts:1941-1945, 2830-2912` |
| Interact prompt | `#interactHint` knows only deliver shortfalls and the pad; the `interact` press is consumed in `#updatePois` | `Surface.ts:3035-3055` |
| SPEC-044 | `openModal(root, { label, initialFocus, onBack })` for focus trap and restore, `keepFocus`, and `CONTROL_ROWS` with a completeness test | SPEC-044 §3 |
| SPEC-036 | `UiRoot.pushBack(onBack)`: Escape and the system Back close the top layer | SPEC-036 §3 |
| World objects | POIs are trigger circles (`poi:reached` on entry, scans are hands-free for 3 s). Landmark POIs are placed, discovered and drawn, then do nothing: `ruin` ×4, `ice_spire` ×5, `overgrown_ruin` ×5, `lava_vent` ×6, `grove` ×5. The Hive's `egg_cluster` ×6 are `c5_s1`'s egg anchors. Deployables are pooled, 8 in all | `data/planets.ts`; `entities/Deployable.ts` |

### 2.5 What R18 already defines that these must fit around

| Spec | Constraint for R19 |
|---|---|
| SPEC-036 | `shapeTouchStick` gives full speed at 0.6 of the radius, so sprint must sit **past the ring**. A cancelled pointer releases only its own role, so the stick's sprint must be released with the stick. Tips are remembered per scheme (`TipSeen`). `BackStack` and `UiRoot.pushBack` serve the puzzle panel. `SurfaceHold` gains `'rotate'`, and R19 adds `'level'`. The pad terminal holds the world |
| SPEC-037 | The thumb arc: `arc-primary` holds DASH, `arc-action` holds USE (visible only when a prompt is actionable), and `arc-slots` is 3 × 2. `.hud-tc` rows are the wallet, weather banner, shelter chip and boss bar. There is an 11 px text floor and a plate/halo contrast rule. `HudModel.interactAction` exists. The `phone-landscape` project covers 844×390, 800×360, 750×342, 802×293, 667×375 and 1180×820, and nothing may overlap the joystick region |
| SPEC-038 | Action `dash` (`KeyV`, mouse button 2), `systems/Dash.ts`, `PlayerEntity.dashUntil`, `dashReadyAt`, `dashX` and `dashZ`, and "a refused press does nothing". `player:dashed` and `enemy:windup` (both reacted). The telegraph pool (`TelegraphEntity.lockAt` makes a line follow its owner until lock). `CombatWorld.windupMult`. Auto-fire is **on by default**, so every player is always firing. The kite bot and `threatBots.ts`. `TIP_IDS += 'dash'` |
| SPEC-039 | `ATTRIBUTE_EFFECTS.agility = { moveSpeed 0.02, critChance 0.02, dashCooldownCut 0.03 }`. The Scout's `dashCooldownMult` is 0.8. `decisionSink().total ≥ 0.75 × completionistTokens()` reads 975 ≥ 936.75, with completionist tokens 1,249 = 670 + 104 + 25 × 19. `lootGivenItems()` and "RECOMMENDED_LOADOUT buys nothing loot hands out" both hold |
| SPEC-040 | A held scene with nothing moving (map, picker, modal, rotate) draws at most 5 frames a second. `SURFACE_ASSETS[biome]` is released on exit. The precache is about 21 MB and the worker registers at the station |
| SPEC-041 | The burrow is a timed move, as above. The fairness invariant is a content test. Packs are swarm 3–5, rusher 1–2 and drones 4–6, with one elite roll per pack and 1–2 affixes. The arena lock (E62) and a respawn at the arena entrance (E63). The out-of-scope list hands "the burrow following a running or firing player" to R19 |
| SPEC-042 | `item:collected` and `item:blocked` (the pickup toasts), the active-effects row, the low-HP edge, and `HAPTIC_TABLE` over chosen events |
| SPEC-043 | `BonusReward { resources?, items? }` and `Economy.applyBonus`: resources as `reward` past the cap, items spilling at the feet. `MissionContext.sheltered` (for `no_shelter`). Contracts modify only ambient play. `DIFFICULTY_RULES` includes `hard`. Tokens are never paid as bonuses |
| SPEC-044 | `openModal`. `CONTROL_ROWS` (with a completeness test). `ATTRIBUTE_EFFECT_WORDS` needs a word for every `ATTRIBUTE_EFFECTS` key |
| SPEC-045 | `SETTINGS_ROWS` sections (Controls, Accessibility, …). Every `defaultSettings()` key needs a row or must be in `BOOKKEEPING_KEYS`. `brightness` runs −30…+30 %. The colour-blind preset turns hostiles magenta. Key rebinding is out of scope |

### 2.6 Pins that will move

| Pin | Snapshot | After R18 (036…045 in order) | After this proposal |
|---|---|---|---|
| `tests/core/events.test.ts:612` `NAMES` | 64 | 71 (038 +2, 041 +2, 042 +2, 043 +1) | **77** |
| `tests/core/audioReactions.test.ts:487` `EVENT_KEYS` | 64 | 71 | **77** |
| `…:453` `REACTED_EVENTS` | 21 | 26 (038 +2, 041 +2, 042 +1) | **31** |
| `…:483` `AUDIO_SILENT.size` | 43 | 45 (042 +1, 043 +1) | **46** |
| `…:240,242` sprites | 51 | 58 (038 +4, 041 +3) | **62** |
| `e2e/SPEC-006.spec.ts:1176-1177` `reactions.counts` | 21 / 43 | 26 / 45 | **31 / 46** |
| `e2e/SPEC-006.spec.ts:292-293` manifest sprites | 51 | 58 | **62** |
| `tests/core/input.test.ts:604` `KEY_BINDINGS` literal | ShiftLeft → throttleUp | + `KeyV: 'dash'` | + `KeyL: 'light'` (the surface override table is separate) |
| `ACTIONS` | 16 | 17 (`dash`) | 19 (`sprint`, `light`) |
| `SAVE_VERSION` / fresh `progress` | 2 / 9 keys | unchanged | **3 / 11 keys** (if the bump is taken) |
| `layout.test.ts` `PINNED` | 6 hashes | unchanged | **unchanged** (descents are derived from shelters; the underground has its own hash) |

---

## 3. Findings

| ID | Sev | Finding | Evidence |
|---|---|---|---|
| G-01 | P1 | The story's signature rule "walk, do not run" has no mechanic. There is one speed, no noise, and a burrow that ignores how the player moves. The line is spoken three times, headlines the Wurm's reveal, and is printed on an item. SPEC-041 hands the fix to R19 | §2.2. `dialogue.ts:54,79,106`; `films.ts:312`; `items.ts:473`; SPEC-041 Out of scope; first review S-05 (open) |
| G-02 | P2 | SPEC-038's cooldown-only dash (5 m in 0.2 s, 1.36 s cooldown for a Marine) is the fastest travel mode. Dash-hopping averages 9.11 m/s (Marine, +49 % over walking) and 12.41 m/s (Scout ag 9, +52 %), faster than a sustained stamina sprint (7.1–9.7 m/s). Players will hop everywhere, spamming the `dash` whoosh and the afterimages | `calc_traversal.mjs`, 300 m out of combat |
| G-03 | P2 | Shift is bound to `throttleUp` in the one flat `KEY_BINDINGS` table and is dead on the surface. A surface sprint on Shift needs a per-mode override, as the wheel already does, and a key-up that releases **the action recorded at key-down**. Today `#drop` looks the binding up again, so a key held across a mode change would stick | `KeyboardMouseDriver.ts:47, 217-229, 263-283, 310-316` |
| G-04 | P2 | No noise model exists. Aggro depends only on radius × storm visibility, and hiding is broken only by a shot. A sprinting player would be exactly as stealthy as a still one, which undercuts both the Wurm line and any stealth role for the dark | `EnemyAi.ts:255-268`; `Surface.ts:1791` |
| G-05 | P2 | SPEC-038's threat suite tests only walking. A sprint, or any future speed verb, can quietly bring back R18's "walking away is a complete defence". The sims show which costs keep sprint honest: with the holster, a sprint-kiter kills 35–59 % fewer; without it, a Scout's damage halves (10.1 → 4.9 %/min) with no loss of kills | §4.1.5 tables; `out_*.md` |
| G-06 | P1 | Any second level that shares coordinates with the surface is unsafe. About 53 consumers in `Surface.ts`, plus `MissionContext.nearPoi`/`poiAt`, read the one layout by XZ. From inside a cave at (45, 20), a `reach`/`deliver`/`scan` POI at (45, 20) on the surface would complete, the pad terminal would open, and nodes would harvest | `Surface.ts` (`#layout`/`#pois`/`#nodes`/`#pad`/`#arenaPoi`/`#mask`/`#layers`); `Missions.ts:59-65` |
| G-07 | P2 | A new `underground` scene is the wrong shape. On every descent and ascent it would count a visit (breaking SPEC-008's single writer), restore HP, request the `landing` save, replay accept lines, and dispose the surface: enemies, pickups, node fills and the weather cycle, while running timers restart (E19). It would also need `ALLOWED_TRANSITIONS`, `GAMEPLAY_SCENES`, `SceneParams` and pausable changes, and each swap would pay a 300 ms fade plus a rebuild | `StateMachine.ts:70-77`; `Surface.ts:694-707, 1017-1038`; `visitCount.test.ts` |
| G-08 | P3 | Caves today are 6 m rooms with nothing inside. They are nonetheless reliable, hash-neutral anchors for a descent: 400 seeds × 6 planets, always placed, the back point never blocked, always reachable | `zz-probe-caves.json` |
| G-09 | P2 | Cave progress has nowhere to live. `explored` is keyed by planet with a length check, flags must be `STORY_FLAGS`, and unknown keys are dropped. Opened caches and a second explored mask need new fields | `Save.ts:842-935` |
| G-10 | P2 | `ExploreMask`'s reveal radius is a module constant of 24 m, so one reveal would light about a quarter of a 96 m cave. It must become a per-mask argument | `Exploration.ts:13, 82-111` |
| G-11 | P3 | `ObstacleGrid.lineHit` scans every obstacle. A cave of about 280 wall circles (prototype P50) is 2–3.5× today's 80–143, and `lineClear` runs per auto-target candidate and per hidden check. It still fits the budget, but `lineHit` should walk the grid buckets | `Layout.ts:376-395`; `zz-probe-underground.json` |
| G-12 | P3 | Darkness needs light-count discipline. three.js recompiles every lit program when the number or kind of visible lights changes. Hiding the surface root on descent, or adding a `SpotLight`, would recompile mid-transition. Keep the light count fixed and change only intensities. A torch already exists | `SurfaceView.ts:583-592, 839-842` |
| G-13 | P2 | No puzzle, lock or "logical task" exists anywhere. The surface's interactions are the pad toggle, 3 s scans, delivers and pickups. The UI patterns to build one are all present (§2.4) | §2.4 |
| G-14 | P3 | Landmarks are discovered and drawn but have no use. Each planet except the Hive has 4–6 of them, placed by the pinned layout. They are ready, hash-neutral sites for surface relic puzzles | `planets.ts` POIs |
| G-15 | P2 | Tokens as treasure are almost ruled out. SPEC-039's sink invariant leaves `975/0.75 − 1,249 = 51` tokens of headroom for **all** optional token sources combined. Cache XP would also move the pinned `COMPLETIONIST_LEVEL` 20 | `systems/Balance.ts:144-154`; SPEC-039 §4.2 |
| G-16 | P3 | Interaction is hard-wired to the pad. Descents, exits, caches, relics, mirrors and a lens all need one ordered interactable list with prompts; `HudModel.interactAction` (SPEC-037) is the place for it | `Surface.ts:1941, 3035-3055` |
| G-17 | P3 | The touch stick's travel past SPEC-036's full-speed point is unused: 34 px for full speed, 56 px to the ring, 89.6 px to the drift. That makes it a natural sprint zone. The raw magnitude is lost after shaping, so the touch layer must press the action itself | `TouchControls.ts:296-311`; SPEC-036 §4.7 |
| G-18 | P3 | SPEC-037's arc has no free cell for a light toggle, but `arc-action` stays empty whenever no prompt is actionable. That is true almost always underground, which gives a context-shared USE/LIGHT cell | SPEC-037 §4.1 |
| G-19 | P3 | Any resource grant, from any source, counts toward active `collect` objectives: `Economy.addResource` emits `resource:collected`, and `Missions.#onCollect` counts it. Cache resources would count, which is acceptable but should be decided | `Economy.ts:229-253`; `Missions.ts:548-555` |
| G-20 | P3 | Item kinds are only `weapon \| armor \| consumable`, and SPEC-039 bars ladder gear from loot. Caches can therefore pay only consumables, resources and story, unless a new item kind is added | `data/items.ts` |
| G-21 | P2 | A burrow that tracks a sprinter must stay inside SPEC-041's fairness invariant, and it must out-pace the fastest sprint: a Scout at agility 10 sprinting ×1.35 reaches 11.2 m/s. A tracking speed of 9 m/s would let a Scout outrun the ring | §4.1.4 |

---

## 4. Proposals

The work splits into three specs, following the R18 format. They take the next free numbers after the story and world specs, so "SPEC-A/B/C" is used here.

| Spec | Title | Milestone | Complexity | Depends on |
|---|---|---|---|---|
| SPEC-A | Legs — stamina, sprint, noise and the Wurm that listens | the R19 story milestone, because it closes S-05 | normal (13) | 005, 011, 012, 036, 037, 038, 039, 041, 044, 045 |
| SPEC-B | The underground — descents, caves, darkness and the flashlight, caches, save v3 | the R20 world milestone | complex (21) | 007, 008, 012, 018, 025, 026, 027, 030, 036, 037, 038, 040, 041, 043, SPEC-A (noise) |
| SPEC-C | Locks — the puzzle framework, five kinds, vaults and relics | R20 | complex (13) | SPEC-B, 036, 037, 044, 045 |

### 4.1 SPEC-A — stamina, sprint and noise

#### 4.1.1 Rules and numbers (*initial tuning*)

| Name (`systems/Stamina.ts`) | Value | Meaning |
|---|---|---|
| `STAMINA_MAX` | 100 | the pool |
| `SPRINT_MULT` | 1.35 | sprint speed = `moveSpeed × 1.35`, weather slow included |
| `SPRINT_DRAIN` | 25 /s | drained **only while `Combat.inCombat`** and moving. Out of combat, sprint is a free travel run |
| `STAMINA_REGEN` | 20 /s | after `STAMINA_REGEN_DELAY` 0.8 s since the last spend; × `(1 + ATTRIBUTE_EFFECTS.agility.staminaRegen × agility)`; ×1.5 out of combat; ×1.25 on casual |
| `STAMINA_RECOVER` | 30 | at 0 the salvager is exhausted, and in-combat sprint and the dash are refused until the pool is back at 30. There is no speed penalty |
| `DASH_STAMINA` | 30 | SPEC-038's dash costs 30. A press with less than 30, or while exhausted, does nothing, like SPEC-038's other refusals |
| `SPRINT_DRAW_SECONDS` | 0.25 | **the gun is holstered while sprinting**. Auto-fire and held fire do not shoot, and the first shot comes 0.25 s after the sprint ends (the same value as `SWITCH_SECONDS`). Holding explicit fire (Space or the left button) suppresses sprint. Companions still fire |
| `SPRINT_NOISE` | 1.5 | while sprinting, and for 1.5 s after, every enemy's aggro radius is multiplied by 1.5 (`CombatWorld.noiseMult`), and a hidden player is revealed, exactly as a shot reveals him |
| Scout passive | `sprintDrainMult: 0.8` | 5 s of in-combat sprint. `passiveText` reads `+25% sprint time` |
| Agility | `ATTRIBUTE_EFFECTS.agility.staminaRegen: 0.03` | +3 % regen per point. `ATTRIBUTE_EFFECT_WORDS.staminaRegen` → `+<p> % stamina regen` |

Derived per class (in combat, full pool):

| | Marine ag 1 | Engineer ag 2 | Scout ag 4 | Scout ag 9 |
|---|---|---|---|---|
| walk / sprint m/s | 6.12 / 8.26 | 6.24 / 8.42 | 7.45 / 10.06 | 8.14 / 10.99 |
| sprint from full | 4.0 s | 4.0 s | 5.0 s | 5.0 s |
| 0 → 100 regen (after 0.8 s) | 4.85 s | 4.72 s | 4.46 s | 3.94 s |
| sustained ceiling (optimal sprint–walk cycling) | **7.0** | 7.2 | 8.7 | 9.6 |
| vs. skitter 6.5 | escapes (sustained 7.0) | escapes | escapes by walking | escapes by walking |
| vs. swift elite skitter 9.65 | caught | caught | ahead only while sprinting (sustained 8.7), then caught | about even (sustained 9.6; sprint 11.0) |
| vs. rusher 5 (charge 20 m/s over 10 m) | escapes by walking; charges are sidestepped or dashed | same | same | same |

#### 4.1.2 Controls

- **Keyboard:** hold `ShiftLeft` or `ShiftRight` while `input.mode === 'surface'`. Add a `SURFACE_KEY_OVERRIDES` table next to `KEY_BINDINGS`, read in `#onKeyDown`. `KEY_BINDINGS` keeps ShiftLeft → `throttleUp` for flight, so its pinned literal only gains `KeyL`. The driver records `code → action` at key-down (`#pressed: Map<string, Action | MoveAxis>`) and releases that action at key-up (G-03).
  - An accessibility option: `settings.sprintToggle` (keyboard; default false). Shift then toggles, and the toggle clears on exhaustion, leaving combat, a hold, or a scene change.
- **Mouse:** no button of its own. The right button is SPEC-038's dash.
- **Touch:** push the stick past its drawn ring.
  - `TouchControls.#steer` presses `sprint` (source `touch`) once the raw distance is ≥ `TOUCH_SPRINT_TRAVEL` 1.0 × 56 px for `TOUCH_SPRINT_DWELL` 0.15 s. It releases below 0.85 (48 px), on lift, and on the stick pointer's own cancel (SPEC-036).
  - `.touch-stick.is-sprint` thickens and brightens the ring.
  - Option `settings.stickSprint` (touch; default true) lets a player who pushes to the ring by habit turn it off.
- **Actions:** `ACTIONS` gains `sprint` (held, read as `down`). `BUTTON_LABELS.sprint = 'RUN'` is never drawn, but the type needs it. `CONTROL_ROWS` gains `Run` with the text `Hold Shift` on keyboard and `Push the stick past its ring` on touch.
- **Rows:** SPEC-045's Controls section gains `settings-sprint-toggle` (keyboard) and `settings-stick-sprint` (touch).

#### 4.1.3 HUD

- `ui/StaminaRing.ts` copies the `ScanRing` pattern: a 30 px conic ring (`--stamina`), placed at the salvager's projected head plus a (+24, −36) px offset, the same on both schemes.
  - It is hidden while full and out of combat, and fades out 1 s after refilling.
  - It carries `role="meter"`, `aria-valuenow` and the testid `hud-stamina`.
  - Exhausted is shown by an amber stroke **and** a dashed ring, so it never relies on hue alone. A notch marks 30.
  - It has no text, so SPEC-037's 11 px floor does not apply. The stroke carries the halo.
- It sits on the character rather than in `.hud-tl`, because the eyes are on the salvager during a chase. On touch the arc is the other thumb's.
- `HudModel` gains `stamina: { value: number; max: number; exhausted: boolean; sprinting: boolean } | null`. A keyboard quick-bar weapon slot shows `.is-holstered` (dimmed) while the salvager runs.
- The camera bob already rides speed (`cameraBob`), and reduce motion zeroes it. The `run` clip plays at `timeScale = speed / walkSpeed`, costing 0 bytes.

#### 4.1.4 Noise and the Wurm (closes S-05 and G-01)

- **Ambient noise.** `CombatWorld.noiseMult` is `SPRINT_NOISE` while the player is loud, else 1. `EnemyAi.updateWander` multiplies the radius: `aggroRadius = def.aggroRadius × aggroMult × noiseMult`, so a skitter hears a sprinter at 27 m and a rusher at 30 m. The director spawns on a 25–40 m ring, so a sprint through the field pulls in fresh spawns. That is why the sprint-kiter below takes more damage.
- **Hiding.** In `Surface.#updateShelter`, `playerHidden` also requires `time − lastLoudAt ≥ REVEAL_AFTER_SHOT`.
- **The Wurm listens.** These rules apply to SPEC-041's burrow and are *initial tuning*:
  1. **The dig hears you.** If the player sprints during the dig, the dig is ×0.6 (2.5 → 1.5 s, × `windupMult`).
  2. **The ring follows running.** The burrow's `telegraphCircle` carries `followsLoud: true`. While `time < lockAt` (`hitAt − 0.4`) and the player is loud, the centre slides toward the player at `BURROW_TRACK_SPEED` 12 m/s, which is faster than any sprint (11.2 max, G-21). A walker's ring stays where it was sampled.
  3. **The fairness invariant still holds for the quiet player.** A player who stops sprinting within the 0.3 s reaction still has `windup − 0.3` = 0.9 s to walk 4.0 m: 0.9 × 6 = 5.4 m, which passes, exactly as in SPEC-041 §4.3.
  4. **Running to lock gets you eaten.** A player who sprints until lock has 0.4 s at 8.26 m/s, which is 3.3 m, short of the 4.0 m needed. A dash with its i-frames still saves him.
- **Tip `wurm`,** shown at the first burrow windup:
  - keyboard: `It hunts by vibration: walk out of the ring — running pulls it after you.`
  - touch: the same words.
- **Firing is not noise.** Auto-fire is on by default since R18, so "loud when firing" would mean "always loud". The first review's "running *and firing*" is narrowed to running.

#### 4.1.5 The kiting check

**Arithmetic.**
- A sprinting Marine's in-combat ceiling is 7.0 m/s, above the skitter's 6.5. A pure retreat therefore escapes a skitter pack. The chase duel (4 unkillable skitters, 30 s, no firing) confirms this: walking takes 9 hits (21 % HP), the stamina sprint 0, and **the dash alone also 0, using 2 dashes in 30 s**.
- Escape is already SPEC-038's design ("killed or dashed"), so sprint adds no defence the dash does not already give.
- What sprint must not add is **killing while escaping**, and the holster rule forbids exactly that.

**Field sims.** `exp_sprint.mjs`, 3 min × 4 seeds × 5 planets, `medium`, chapter kits. Each cell is dmg %max HP/min · kills/min, as a 5-planet mean. `sprint` is the full proposal (§4.1.1), `dash` is SPEC-038's dash with the 30-point cost, and `free sprint` means no stamina, firing while running, and silent.

| World · class | kite (walk) | sprint | dash | sprint + dash | free sprint |
|---|---|---|---|---|---|
| SPEC-038 · Marine | 12.4 · 18.2 | 25.0 · 11.8 | 10.2 · 18.3 | 14.8 · 12.1 | 12.2 · 18.7 |
| SPEC-038+039+041 · Marine | 7.2 · 33.4 | 12.3 · 19.5 | 4.1 · 33.2 | 8.2 · 20.0 | 6.7 · 34.4 |
| SPEC-038 · Scout ag 9 | 22.7 · 17.4 | 19.8 · 7.1 | 15.7 · 17.0 | 19.5 · 7.3 | 14.3 · 16.8 |
| SPEC-038+039+041 · Scout ag 9 | 10.1 · 30.0 | 11.9 · 17.8 | 5.0 · 28.9 | 9.7 · 17.9 | **4.9 · 31.0** |

Damage per kill against the kite: the costed sprint is ×3.1, ×2.9, ×2.1 and ×2.0, so it is always worse. The free sprint is ×0.96, ×0.90, ×0.65 and **×0.47**, so it is free kiting for the Scout.

Ablations, SPEC-038 world, Marine. These use the first-pass rules (drain in and out of combat, dash cost 25), whose costed sprint scored 24.3 · 10.7:

| Costs removed | Damage (vs 24.3 with every cost) | Kills |
|---|---|---|
| quiet, holster kept | 13.7 | 9.9 |
| quiet, no holster | 13.6 | 17.0 |
| loud, no holster | 25.1 | 19.9 |

**The holster is what stops killing-while-escaping; the noise is what makes escaping cost something.**

The dash's 30-point cost never binds in the field: the `dash` column is identical to SPEC-038's cooldown-only dash, at ≤ 2.5 dashes a minute. It binds only on dash-hopping. Out of combat a hop pays 30 against 16.7 of regen per cycle, so a hopper empties after about 6 hops and then idles.

**Bot-suite assertion (new, in `tests/systems/threat.test.ts`).** The `sprintKite` bot is `threatBots.ts`'s `kite`, plus a sprint whenever a melee body is within reach + 3.5 m and the rules allow it.
- Over SPEC-038's field suite, for each of the Marine and the Scout, its 5-planet mean damage per kill is **≥ 1.25 ×** the kite's.
- The same suite, with the holster rule switched off in a fixture, **fails** the assertion. That proves the test can bite.

#### 4.1.6 Data shapes

```ts
// systems/Stamina.ts (pure; initial tuning)
export const STAMINA_MAX = 100, SPRINT_MULT = 1.35, SPRINT_DRAIN = 25, STAMINA_REGEN = 20,
  STAMINA_REGEN_DELAY = 0.8, STAMINA_CALM_MULT = 1.5, STAMINA_RECOVER = 30, DASH_STAMINA = 30,
  SPRINT_DRAW_SECONDS = 0.25, SPRINT_NOISE = 1.5, CASUAL_STAMINA_MULT = 1.25;
export function staminaRegen(agility: number, difficulty: Difficulty): number;
/** One step: returns whether the player sprints this step; spends/regens `p.stamina`. */
export function stepStamina(p: PlayerEntity, wants: boolean, moving: boolean, inCombat: boolean,
  drainMult: number, regenPerSec: number, time: number, dt: number): boolean;
export function canSpend(p: PlayerEntity, amount: number): boolean;   // !p.exhausted && p.stamina >= amount
export function spend(p: PlayerEntity, amount: number, time: number): void;

// entities/Player.ts — reset by makePlayer, the respawn and the recall (as SPEC-038's dash fields)
stamina: number; staminaSpentAt: number; exhausted: boolean; sprinting: boolean;
drawAt: number;        // world time the gun may fire again after a sprint
loudUntil: number;     // world time noise ends (sprint + 1.5 s)

// systems/Combat.ts
interface CombatWorld { /* … */ noiseMult?: number }
// #updateFiring returns early while p.sprinting || time < p.drawAt (after cooldowns tick)

// core/Input.ts: Action gains 'sprint' | 'light'; core/KeyboardMouseDriver.ts:
export const SURFACE_KEY_OVERRIDES: Readonly<Record<string, Action>> = { ShiftLeft: 'sprint', ShiftRight: 'sprint' };

// data/characters.ts
interface ClassPassive { /* … */ readonly sprintDrainMult?: number }   // scout 0.8
// SPEC-039 ATTRIBUTE_EFFECTS.agility gains staminaRegen: 0.03

// systems/UiHelpers.ts: HudModel.stamina; core/Settings.ts: sprintToggle (false), stickSprint (true)
// data/hints.ts: TIP_IDS += 'sprint', 'wurm'
// data/enemies.ts (SPEC-041 BossMove): burrow row gains trackLoud: 12, loudDigMult: 0.6
```

- **Tip `sprint`**, shown at the first in-combat sprint:
  - keyboard: `Shift runs. Running is loud and holsters your gun — walk when you want to shoot.`
  - touch: `Push the stick past its ring to run. Running is loud and holsters your gun.`

#### 4.1.7 Events, sounds and cost

| Item | Detail |
|---|---|
| `player:exhausted: Record<string, never>` | Reacted. It plays a new `exhale` sprite (≤ 350 ms breath, `minIntervalMs` 2000). Pins +1 reacted and +1 sprite; `sfx.mjs` recipe; a `LICENSES.md` row; about 6 KB |
| Draw calls | 0. The ring is DOM, and the stick glow is CSS |
| CPU | One aggro multiply per wandering enemy per step, and one stamina step |
| Save | No save field: stamina is per visit |
| Haptics | SPEC-042's `HAPTIC_TABLE` may add a 20 ms tick on `player:exhausted` |

#### 4.1.8 Tests

**Unit, `tests/systems/stamina.test.ts`:**
- The literals, and drain and regen per second.
- No drain out of combat.
- The exhaustion hysteresis at 30.
- Agility and casual regen, and the Scout's 5 s.
- `DASH_STAMINA` refusal.
- The draw delay blocks the first shot for 0.25 s.
- Explicit fire suppresses sprint.
- `noiseMult` widens acquisition from 18 to 27 m.
- A sprint reveals a hidden player for 1.5 s.

**Unit, elsewhere:**
- `enemyAi.test.ts`: the burrow ring follows a sprinter at ≤ 12 m/s until `lockAt` and not a walker; a loud dig is ×0.6.
- The content invariant: SPEC-041's fairness rule for burrow rows still reads 4.0 ≤ 5.4.
- `input.test.ts`:
  - Shift → `sprint` in surface mode and → `throttleUp` in flight;
  - a Shift held across `setMode` releases `sprint`;
  - the `KEY_BINDINGS` literal gains `KeyL`.
- `touch-controls` unit case: a raw magnitude of 1.0 held for 0.15 s presses `sprint`; below 0.85 releases it.

**Bot:** the §4.1.5 assertion.

**e2e `e2e/SPEC-A.spec.ts`:**
- Hold Shift on Cinder-4 with `surface-spawn-pack`. `sceneInfo.sprinting` reads 1, `stamina` falls about 25/s, `exhausted` reads 1 by about 4.2 s, and `hud-stamina` is visible.
- Out of combat, `stamina` stays at 100 while `sprinting` is 1.
- Touch: drag the stick 70 px, and `sprinting` reads 1.
- `surface-spawn-boss` → the Wurm in phase 2 → sprint. `sceneInfo.bossRingDx` tracks the player.

**Manual:**
- Run from a skitter pack, and feel the gun go quiet.
- Walk out of the Wurm's ring, then run and get caught.
- On the phone, push past the ring.

### 4.2 SPEC-B — the underground

#### 4.2.1 Shape: a level of the planet, not a scene (G-06, G-07)

`scenes/surface/Level.ts` is a small object built once per visit per level. Every coordinate consumer reads `this.#level` instead of `#layout`:

```ts
export type LevelId = 'surface' | 'underground';
export interface Level {
  readonly id: LevelId;
  readonly layout: Layout | UndergroundLayout;   // both satisfy the Layout fields MapLayers/isReachable read
  readonly grid: ObstacleGrid;
  readonly bounds: number;                       // halfSize − WALL_INSET
  readonly pois: readonly PoiState[];            // [] underground
  readonly shelters: readonly LayoutShelter[];   // [] underground
  readonly nodes: Nodes | null;                  // null underground
  readonly interactables: Interactable[];        // pad/descent | exit/caches/vault/lens/mirrors/panel
  readonly mask: ExploreMask; readonly layers: MapLayers;
}
```

- **Missions.** `MissionContext` gains `level: LevelId`. Underground, `nearPoi` returns `null` and `poiAt` returns `[]`, and the `survive`/`defend` timers run only on the surface (E72). `sheltered` (SPEC-043) is true underground, so a `no_shelter` bonus is forfeited by descending.
- **Swap order.** The `onUpdate` order is unchanged; only the objects behind `world.obstacles`, `world.bounds`, the view's environment root and the map layers change.
- **Budget.** The change is mechanical but touches about 53 sites. The first review already suggested splitting the 4,358-line `Surface.ts`, and this is where that split starts.

#### 4.2.2 The descent

- **Where.** The first cave shelter of the layout (`layout.shelters.find(s => s.kind === 'cave')`) gets a shaft 3.5 m behind its centre, away from the gap: `descentPoint(s) = (s.x − cos(gapAngle) × 3.5, s.z − sin(gapAngle) × 3.5)`.
  - It is **derived, not placed**, so the surface `layoutHash` pins are unchanged.
  - Probe: never blocked, always reachable, 400 seeds × 6 planets.
  - If a planet ever places no cave on some seed (D-4), it has no descent on that visit. A content test asserts ≥ 1 cave per planet at `PIN_SEED`.
- **Opens** after `c1_m1` is done, so SPEC-035's first-landing ramp and tutorial come first. Tip `descent`: `E at the back of a cave climbs down. Caves hold caches and locks — nothing you need.`
- **Refused** with the reason in the prompt (E72) while any of these holds:
  - a `survive`, `defend` or `escort` objective of a current stage is unfinished;
  - `missions.bossStage() !== null`, or the arena is locked;
  - a follower exists;
  - `missions.requiredWeather() !== null`;
  - the scene is `#leaving`, or the death overlay is up.
- **Map.** A new `MapIconKind` `descent` (shape `shaft`), shown once the shelter is discovered. Discovery already persists as `${planet}:shelter:${index}`.

#### 4.2.3 Generation (`systems/Underground.ts`, pure)

The rng is `services.rng.layout(planet).fork('underground')`, so the cave is identical on every visit of the save.

1. **Rooms.** `UNDERGROUND[planet].halfSize` is 48 (a 96 m square). Place 5–7 rooms (`rng.int`) of radius 6–10, at least 5 m apart rim to rim, keeping 4 m from the edge, by rejection sampling.
2. **Corridors.** Prim's MST over the room centres, plus the shortest spare edge for one loop, each 4.5 m wide.
3. **Walls.** One ring of `cave_wall` circles, radius 1.1 every 1.5 m (SPEC-030's own shelter numbers). They run along every room rim at `r + 1.2` and both corridor sides at `2.25 + 1.2`. A point that falls inside any other open shape grown by 1.19 m is skipped. **Walls never intrude on open space.**
4. **Roles.**
   - Room 0 is the entrance: the ladder and `pad` (so `isReachable` starts there) and `playerSpawn` at 2 m.
   - The room farthest along the tree is the **vault**.
   - Two leaves become **caches A/B**.
   - One room holds the **world puzzle**, and a different room holds its **hint panel** (plates). The panel may share the entrance room.
   - With only 5 rooms, roles share rooms. Only the vault keeps a room to itself, and the plates never share a room with their panel.
   - Packs go in up to `2 + ceil(chapter / 2)` rooms other than room 0.
5. **Validate.** `isReachable` from the entrance to every room centre, cache, vault door, puzzle object and panel. By construction walls never intrude on open space, so a failure is a generator bug, and the unit test fails on it. At runtime, as a safety net, repair removes the wall circle nearest the blocked segment, never re-rolls (the rule of E17), and logs it.
6. **`undergroundHash`** is `hash32` over rounded positions, like `layoutHash`. It is pinned per planet at `PIN_SEED` in `tests/systems/underground.test.ts`.

**Prototype.** `zz-probe-underground.test.ts` runs steps 1–3 on the real `ObstacleGrid` and `isReachable`, over 150 seeds × 6 planets:
- 5–7 rooms;
- wall circles P10 223, P50 ~280, P90 322, max 363;
- 0 unreachable rooms;
- 0 leaks in 40 seeds per planet: a 0.5 m-radius circle flooded in 0.5 m steps from room 0 never reached the void;
- 0.06–0.09 ms per level.

Because the camera sits at a fixed yaw, each wall circle's outward normal is known at generation. Circles whose normal faces the camera (dot > 0.3) render at 35 % height, a Diablo-style cut-away with no per-frame cost. This is needed because the 55° camera would otherwise hide the salvager behind the near wall.

#### 4.2.4 The transition

- `#descend()` / `#ascend()` add a `'level'` hold (`SurfaceHold` gains `'level'`), release input, and run `services.ui.fadeOut(300)`, the swap, then `fadeIn(300)`.
- **The swap:**
  - `spawn.despawnNear(player, ∞)`, which is silent; the ambient director then runs with `missionsWantSpawns = false` underground.
  - Surface pickups are cleared (E78).
  - `world.obstacles`, `bounds` and `arena = null` are swapped.
  - The player moves to the level's spawn and the camera snaps.
  - `view.setLevel(id)` toggles the environment roots **and changes light intensities only** (G-12).
  - The minimap and map switch to the level's `MapLayers` and `ExploreMask`.
  - The cave's packs spawn: SPEC-041's pack spawner with `placed: true`, anchored at their room, never culled, `leashRadius` capped at 24 m.
  - `level:changed` is emitted.
- **Weather.**
  - Underground there is none: the move multiplier is 1, there is no damage, and the overlay and storm loop are muted.
  - The surface cycle keeps its clock, because `weather.update` still runs.
  - On ascent the player stands inside the cave shelter, and the SPEC-030 rules take over.
- **Nodes, the pad terminal, POIs and the arena** are inert underground, because the level lists none of them.
- **Death or Recall underground (E73)** is `#setLevel('surface')` followed by E4 or E55 unchanged: the pad, full HP, i-frames, −10 % resources on death (0 % casual, 20 % hard). The cave's enemies reset at the next descent, and opened caches stay open.
- **Quit or reload underground (E74)** continues at the station, as R18-12 already rules. Cave progress was saved at each cache or puzzle checkpoint.

#### 4.2.5 Darkness and the flashlight

| Name (`systems/Light.ts`, pure) | Value | Rule |
|---|---|---|
| `LIGHT_RANGE` / `LIGHT_HALF_ANGLE` | 20 m / 0.42 rad (24°) | `lit(p, facing, on, x, z)`: inside the cone. The flashlight follows `player.facing`, so it points at what the gun aims at, or along the direction of travel |
| `DARK_SIGHT` | 9 m | underground, `#autoTarget` ignores enemies farther than 9 m unless they are lit: "you cannot shoot what you cannot see" |
| `DARK_AGGRO` | 0.6 | with the light **off**, every non-boss aggro radius underground is ×0.6. The dark hides you |
| `LIGHT_SEEK_AGGRO` | 1.6 | rushers in the cone of a lit flashlight: aggro ×1.6 ("hunters follow the light") |
| `LIGHT_FEAR_SPEED` | 0.4 | swarms in the cone move ×0.4 and may not **start** a windup ("bugs hate it"). A windup already started still lands |
| Ranged, bosses, waves | — | unaffected |

- **The choice.** Light on means seeing and shooting far and holding the swarm off, but drawing the hunters. Light off means sneaking past, but fighting blind. There is no battery: the tension is tactical, and a battery would be a second meter for no new decision.
- **Controls.** Action `light`, toggled on press:
  - keyboard `KeyL`;
  - touch: a `LIGHT` button (`touch-light`) mounted in SPEC-037's `arc-action`, shown underground only while USE is hidden (G-18).
  - It defaults to on at the first descent of a visit.
  - A `hud-light` chip in `.hud-tc` reads `◐ Light on · L`.
  - `light:toggled` plays a new `light_click` sprite.
- **View (`views/UndergroundView.ts`):**
  - A `SpotLight(#fff1d0, distance 22, angle 0.42, penumbra 0.45, decay 1.6, no shadow)` is added to the player group **at scene enter with intensity 0**, so the light count stays constant (G-12).
  - Underground: hemisphere 0.06 toward a cave tint; sun and rim intensity 0, still visible; background `#05070a`; fog near 5 m, far 26 m; the torch unchanged (the "circle of comfort" of about 8–9 m).
  - SPEC-045's `brightness` at −30 % must still show walls at 9 m. Covered by an e2e screenshot check.
- **Per-biome dressing.**
  - Desert: sandstone and fossil ribs.
  - Ice: blue-glow ice caves.
  - Jungle: root tunnels and glowing fungus.
  - Volcanic: lava-tube cracks, which are emissive.
  - Hive: resin.
  - **Eden: the machine room.** Racks, cable trays and a hum, and no enemies (Eden's `spawn` is `[]`). The deepest "cave" in paradise is the hardware.

#### 4.2.6 Enemies underground

- **Packs** come from the planet's own roster (`UNDERGROUND[planet].spawn`, a subset of `surface.spawn`), in SPEC-041 sizes, one elite roll per pack, with the chapter's affixes.
- **Count:** 3–5 packs, at most 12 alive, within `medium`'s 20. Difficulty (`DIFFICULTY_RULES`) applies as for ambient enemies. Contracts do not reach underground.
- **No boss, no waves, no refill:** a cleared cave stays clear for that descent.
- **Kill XP and loot** are normal, the same as the surface's endless ambient, so there is no new XP exposure.

#### 4.2.7 Caches and rewards (G-15, G-19, G-20)

Rewards reuse SPEC-043's `BonusReward`. `Economy.applyReward(reward, 'reward')` generalises `applyBonus`: resources go past the cap, and items spill at the feet on `item:noRoom`. A toast uses `bonusRewardText`, and the save gets a `'checkpoint'` request. *Initial tuning*, with chapter `c`:

| Cache (`CacheId`) | Guard | Pays |
|---|---|---|
| `<planet>_loose_a` | none (exploration) | lithium `3 + 2c`; 1 `medkit` |
| `<planet>_loose_b` | the world puzzle (SPEC-C) | oil `10 + 5c`; 2 × the chapter's explosive (`frag_grenade` ch1–2, `landmine` 3–4, `demo_charge` 5–6) |
| `<planet>_vault` | the vault terminal (SPEC-C) | lithium `5 + 3c`; 1 `plasma_cell`, 1 `coolant_pack`; the **archive shard** (a `log` line and a flag `shard_<planet>`); **flawless** (no bypass): +1 `medkit` |
| `<planet>_relic` (not the Hive) | the surface relic terminal (SPEC-C) | lithium 5; 1 `plasma_cell`; one `log` fragment line, with no flag |

- **Campaign totals.** 178 lithium, 165 oil, 12 medkits, 12 explosives, 11 plasma cells and 6 coolant packs. **0 tokens and 0 XP.**
- **Invariants.** 670 / 104 / 2,380, the decision sink, `COMPLETIONIST_LEVEL` and every SPEC-010 invariant stay as they are, because optional income is never counted in a worst case. The SPEC-016 campaign pins are unchanged, because the harness never descends.
- **Token option (designer's call).** Each vault could add 5 tokens (6 × 5 = 30). `completionistTokens()` must then add them: 1,279, and 0.75 × 1,279 = 959.25 ≤ 975, which passes with 15.75 to spare. The 51-token headroom is shared with every future optional token source.
- **Content tests:**
  - every `CacheId` is unique, and each planet has its caches;
  - rewards are non-empty and name real items;
  - **no priced weapon or armour** appears (SPEC-039 `lootGivenItems()` includes cache items);
  - shard flags are in `STORY_FLAGS`, and **no `Requirement`, planet `unlock` or objective reads a shard flag or a cache**. Caves stay optional (the locked mission set).

#### 4.2.8 Save v3 (G-09)

```ts
export interface SaveV3 {
  version: 3;
  /* every SaveV2 field */
  progress: SaveV2['progress'] & {
    /** R19: every cache opened, once — vaults, loose caches, relics. */
    caches: CacheId[];
    /** R19: the underground's explored ground per planet — 4 m cells over ±UNDERGROUND[planet].halfSize (24 × 24 → 72 bytes). */
    exploredBelow: Partial<Record<PlanetId, string>>;
  };
}
// MIGRATIONS[2] = (raw) => ({ ...raw, version: 3, progress: { ...progress, caches: [], exploredBelow: {} } })
// validateProgress: caches ∩ CACHE_IDS, unique; exploredBelow as validateExplored with UNDERGROUND halfSizes
// SaveContent gains caches: readonly CacheId[] and belowHalfSize: Record<PlanetId, number>
```

- **Size.** About 1.1 KB at most: 23 ids and 6 masks of 96 characters. The limit is 100 KB.
- **Pins that move.** `SAVE_VERSION` 2 → 3; AC-10's fresh `progress` gains `caches: []` and `exploredBelow: {}`; a new v2-fixture → v3 case; PLAN §8's schema.
- **Why bump rather than add optional fields to v2.** The validator would accept missing fields, but an older cached build (or an export code carried to an older device) would **silently drop** cave progress. A v3 refuses loudly (E9) and the update flow takes over. Solved puzzles are not stored separately: a guarded cache opens when its puzzle is solved.

#### 4.2.9 Map and exploration

- `ExploreMask` gains a constructor argument `radius` (default `EXPLORE_RADIUS`), and underground uses `EXPLORE_RADIUS_BELOW` 10 m. `REVEAL_CAPACITY` becomes `revealCapacity(radius)`.
- `MapLayers` paints an `UndergroundLayout` unchanged: it reads `halfSize`, `obstacles`, `pois` (`[]`) and `shelters` (`[]`).
- `Minimap.setLayers(layers)` and `MapScreen.setLevel(layout, layers)` are the only additions. The map's title reads `<Planet> · Underground`, with `Explored NN %` per level.
- New icons: `descent` (shaft), `cache` (chest; open drawn hollow), `vault` (lock) and `relic`. Each has a unique shape and colour, and the legend test iterates `MAP_ICON_KINDS`.
- **Guidance.** Underground, when the tracked objective is on the surface, the target is the exit, and the tracker's focus row reads `Return to the surface`. The route grid is built once per level, 48 × 48 cells.

#### 4.2.10 Performance

| | Surface today (medium) | Underground (estimate) |
|---|---|---|
| Environment draws | about 30–39 scene share in total | floor 1 + wall variants 2 + crates 1 + vault door 1 + shaft 1 + glow 1 + plates/mirrors/lens 3 = **about 10–12** |
| Actors, telegraphs, guidance | unchanged | unchanged |
| Scene total / budget | 30–39 / 80 | **about 35–45 / 80** (the surface environment is hidden, not drawn) |
| Triangles | 34–92 k / 130 k | walls about 280 × 60–100 = 17–28 k, plus props and actors, **about 60 k** |
| Lights | hemi, key, rim, torch | the same count, plus a spot at 0 on the surface (one light term per fragment everywhere). Measure; if it matters on `low`, swap it in behind the fade and pre-warm with `renderer.compile` |
| CPU | `lineHit` O(n ≈ 140) | O(n ≈ 280). Make `lineHit` walk the buckets (G-11) |
| Bytes | — | procedural walls and floor from the existing `rockBody`, so **0 new assets**. Optional per-biome cave GLBs from Blender ≤ 60 KB each (models 2.6 of 4 MB). New sprites about 20 KB |

`e2e/surface-env.spec.ts` gains an underground case: ≤ 96 whole-frame draws and ≤ 130 k triangles after 30 frames, on Cinder-4 and Eden.

#### 4.2.11 Events, hooks and tests

| Event | Payload | Audio |
|---|---|---|
| `level:changed` | `{ planet: PlanetId; level: LevelId }` | silent |
| `light:toggled` | `{ on: boolean }` | reacted: `light_click` (new, ≤ 80 ms) |
| `cache:opened` | `{ cache: CacheId; x: number; z: number }` | reacted: `cache_open` (new, ≤ 600 ms, positioned) |

- **Pins:** +2 reacted, +1 silent, +2 sprites. **The `sceneInfo` fields:**
  - `level`, `caveHash`, `caveRooms`, `caveWalls`, `caveEnemies`;
  - `light` (0/1), `cachesOpen`, `descentDist`.
- **Debug strip:** `surface-goto-descent`, `surface-descend`, `surface-ascend` and `surface-goto-cache`.
- **Testids:** `hud-light`, `touch-light`, and `hud-interact` with the prompts `E Descend`, `E Climb up`, `E Open cache`.

**Unit tests:**
- `tests/systems/underground.test.ts`:
  - determinism;
  - the pinned hash per planet;
  - 200 seeds × 6 planets: every room, cache, puzzle object and the exit reachable;
  - watertight (the 0.5 m flood never reaches the void);
  - no wall circle inside open space;
  - rooms 5–7.
- `light.test.ts`: the cone, sight 9 m, aggro ×0.6 and ×1.6, the swarm fear.
- `missions.test.ts`: timers hold underground; `nearPoi` is null.
- `save.test.ts`: v2 → v3, the validator, AC-10.
- `exploration.test.ts`: the radius argument.
- `content.test.ts`: caches and shard flags (§4.2.7).
- `map.test.ts`: the new icons.

**e2e `e2e/SPEC-B.spec.ts`:**
- Load a save with `c1_m1` done → `surface-goto-descent` → E. `level` reads `underground` and `caveHash` equals the pin.
- Press L and `light` goes 1 → 0.
- `surface-goto-cache` → E: `cache:opened` appears in the event log, `save().current.progress.caches` contains `cinder4_loose_a`, and after a reload the cache is still open.
- Die underground: `level` reads `surface` and the player is on the pad.
- Recall underground: the same.
- A survive stage active: the descent prompt carries its refusal.
- `e2e/SPEC-B.phone.spec.ts`: LIGHT in `arc-action` at the matrix sizes, with no overlaps.

**Manual:**
- Each biome's cave, on desktop and on a phone.
- Light off past a skitter pack, then light on against wurmlings.
- The Eden machine room.

### 4.3 SPEC-C — puzzles ("a logical task to be solved")

#### 4.3.1 The framework (`systems/Puzzles.ts`, pure)

```ts
export type PuzzleKind = 'conduit' | 'calibration' | 'sequence' | 'plates' | 'beam';
export type Puzzle = ConduitPuzzle | CalibrationPuzzle | SequencePuzzle | PlatesPuzzle | BeamPuzzle;
export type PuzzleMove = { readonly cell: number } | { readonly choice: number } | { readonly plate: number } | { readonly mirror: number };
export function generatePuzzle(kind: PuzzleKind, chapter: Chapter, rng: Rng, anchor?: PuzzleAnchor): Puzzle;
export function applyMove(p: Puzzle, m: PuzzleMove): { ok: boolean; solved: boolean };   // mutates p
export function isSolved(p: Puzzle): boolean;
export function solvePuzzle(p: Puzzle): readonly PuzzleMove[];    // from the current state
export function hintMove(p: Puzzle): PuzzleMove | null;           // solvePuzzle(p)[0]
export const PUZZLE_BYPASS_SECONDS = 90;   // open time, summed over opens in the visit
export const PUZZLE_BYPASS_HINTS = 3;
// data/puzzles.ts
export const PUZZLE_SITES: Record<PuzzleSiteId, { planet: PlanetId; kind: PuzzleKind; where: 'vault' | 'world' | 'relic'; cache: CacheId }>;
export const PUZZLE_DIFFICULTY: { readonly [K in PuzzleKind]: readonly DifficultyRow[] };   // by chapter, below
```

- **Seeds.** `layout(planet).fork('puzzle:<site>')`, so a returning player finds the same board. Progress within a visit is kept.
- **Holds.** An open terminal puzzle holds the world with a `ui` hold, like the map. SPEC-040 then treats the scene as idle and draws at most 5 frames a second. World puzzles never hold.
- **Hints (`puzzle-hint`, H).**
  - Always free, and available even with `guidance: 'off'`, because hints are asked for, not pushed.
  - Each hint highlights `hintMove`.
  - ARIA's line escalates: first a nudge, then the exact move.
- **Bypass (`puzzle-bypass`)** enables after 90 s of open time or 3 hints. `ARIA: force the lock` solves the puzzle with `bypassed: true`.
  - The cache opens and the shard is always given.
  - Only the *flawless* extra is withheld.
  - **No player is ever blocked, and puzzles never gate a mission, a planet or a flag that any requirement reads** (content test, E75).

#### 4.3.2 The five kinds

| Kind | Where | Rules | Generation (solvable by construction) | Test proof |
|---|---|---|---|---|
| **Conduit** ("ROUTE POWER" → from chapter 4 "ROUTE ATTENTION") | vault terminal | n × n tiles (end, straight, elbow, tee, cross). Tap, click or Enter rotates 90°. Solved when the source edge connects to every sink through matching open sides | A seeded self-avoiding DFS path from source to sink, length in the row's band. A second sink branches as a tee. Decoys fill 60 % of the rest. The solution rotations are recorded, then every path tile is scrambled by `rng.int(1,3)` quarter turns and re-rolled while it is still solved | 500 seeds × chapter: `isSolved(apply(solution))`; a scrambled board is not solved; an independent backtracking solver agrees for n ≤ 5; minimum taps ≤ the row's cap |
| **Calibration** (lights-out; "CALIBRATE ARRAY" → from chapter 5 "ADJUST WEIGHTS") | vault terminal | n × n cells. A press toggles the cell and its 4 neighbours. Solved when all are aligned | Start solved and apply k **distinct** seeded presses. For 3 × 3 the move matrix is invertible. For 5 × 5 the kernel has dimension 2 and its three quiet patterns weigh 12, 12 and 16 presses, so k ≤ 7 distinct presses can never re-solve. For 4 × 4 the kernel has dimension 4 and every quiet pattern weighs at least 8, so k ≤ 6 can never re-solve either (checked by brute force) | A GF(2) Gaussian solve clears every generated board, with weight ≤ k, over 500 seeds |
| **Sequence** ("COMPLETE THE SEQUENCE" → from chapter 3 "PREDICT THE NEXT TOKEN") | surface relics, and the Eden vault | 5 tokens shown and 4 choices. Families: arithmetic; alternating steps; Fibonacci-like; two interleaved sequences; glyph rotation; words (chapter 5+). A wrong pick deals a new sequence of the same family, with no lockout | The family and its parameters are drawn from the chapter row. The distractors are near-miss rules (off by one step, wrong parity, the other interleave) | Exactly one choice satisfies the rule, over 1,000 seeds per family; distractors are distinct |
| **Plates** (a world puzzle on XZ) | a cave room, with the hint panel in **another** room | 3–5 floor plates, each with a glyph (shape-coded: circle, triangle, square, diamond, star). Stepping onto a plate presses it. The right order advances; a wrong plate resets, with `puzzle:moved ok:false`. The panel shows the order ("Step on the stones in this order. Do not deviate.") | Plates ≥ 3 m apart inside the room's disk minus 2 m, all reachable. The order is a seeded permutation. The panel sits in a room chosen ≠ the plates room | Reachability; the glyphs are unique; the panel's glyphs map 1:1 to the plates; a scripted walk of the order solves it |
| **Beam** (a world puzzle; "LIGHT THE LENS") | a cave room | A lens (the emitter), 2–3 mirrors on pedestals and a receiver crystal, on a 2 m grid. E or USE at a mirror cycles `/`, `\` and two closed states. The lens takes power only while **the flashlight is on**. The beam traces with right-angle reflections, and the crystal lights | A path lens → m1 → m2 (→ m3) → receiver is built with right-angle turns, with mirrors placed at the turns in their solving state. The mirrors are then scrambled, and the board re-rolled if it is still solved | `traceBeam(solution)` hits the receiver; the scrambled trace does not; every pedestal is reachable |

**Difficulty by chapter (*initial tuning*).** Planets map to chapters 1–6: Cinder-4 1, Vetra 2, Thessaly 3, Ferrum 4, the Hive 5, Eden 6.

| | ch 1 | ch 2 | ch 3 | ch 4 | ch 5 | ch 6 |
|---|---|---|---|---|---|---|
| Conduit (n, sinks, path length) | 4, 1, 5–8 | — | 5, 1, 7–11 | — | 5, 2, 9–13 | — |
| Calibration (n, presses) | — | 3, 4 | — | 4, 6 | — | 5, 7 |
| Sequence (relic families) | arithmetic | alternating | Fibonacci | interleaved | glyph rotation, words | the salvager's own lines (below) |
| World puzzle | plates ×3 | beam, 2 mirrors | plates ×4 | beam, 3 mirrors | plates ×5 | beam, 3 mirrors |

Vault kind by planet: conduit on Cinder-4, Thessaly and the Hive; calibration on Vetra, Ferrum and Eden. Eden's vault, the machine room, may instead use a sequence whose "correct next token" is a line the salvager heard earlier: `walk · do · not · ?` → `run`, the scav's chapter-1 warning. The model completes its own prompt.

#### 4.3.3 The terminal panel (`ui/PuzzlePanel.ts`)

- **Structure.**
  - `openPuzzlePanel(ui, model, handlers)` mounts `puzzle-panel` in the `panel` layer through `openModal`, with its focus trap and `onBack` → close, registered on SPEC-036's back-stack.
  - It holds a `puzzle-title`, a `puzzle-board` (a CSS grid of `button.puzzle-cell`, testids `puzzle-cell-<r>-<c>`) or, for sequences, token chips and `puzzle-choice-<i>`.
  - A side column holds `puzzle-hint`, `puzzle-bypass` (disabled, with a countdown note), `puzzle-close` and `puzzle-status` (for example `4 moves · 1 hint`).
- **Input.**
  - Keyboard: arrow keys move a roving focus, Enter or Space acts, H gives a hint, Escape closes.
  - Mouse: click.
  - Touch: tap. Cells are `clamp(44px, (100dvh − 56px) / n, 64px)`.
  - **Landscape phones.** At `max-height: 500px` the board sits left and the column right. At 802 × 293 a 5 × 5 board gets 47 px cells, which passes. This is covered by an `e2e/SPEC-C.phone.spec.ts` case over `PHONE_VIEWPORTS`: the panel is fully visible, and every cell is ≥ 44 px and topmost at its centre.
- **Accessibility.**
  - State never rides on hue alone. The powered path uses `--good` **plus** a thicker stroke and a dot; calibration shows "aligned" as ● against ○.
  - SPEC-045's colour-blind preset and `textScale` apply, and so does the 11 px floor.
  - Every cell has an `aria-label` (`Tile 2, 3: elbow, north–east, powered`).
  - With reduce motion there are no rotation animations.
- **Rendering.** SVG glyphs inside the cells, as DOM, so there are 0 draw calls.

#### 4.3.4 Where puzzles live and what they unlock

| Site (`PuzzleSiteId`) | Kind | Unlocks |
|---|---|---|
| `<planet>_vault` ×6 | conduit or calibration, at the vault door's terminal | `<planet>_vault` (the shard) |
| `<planet>_world` ×6 | plates or beam, in a cave room | `<planet>_loose_b` |
| `<planet>_relic` ×5 | sequence, at landmark instance 0 (Cinder-4 `ruin`, Vetra `ice_spire`, Thessaly `overgrown_ruin`, Ferrum `lava_vent`, Eden `grove`; not the Hive, whose `egg_cluster` anchors `c5_s1`). The prompt is `E Read the relic` | `<planet>_relic` |

That is 17 sites in all. Relics sit at landmarks the pinned layout already places, so they are **hash-neutral** and need no new placement.

#### 4.3.5 Story fit (the salvager is a model)

The mechanics carry the theme with no new systems:
- The sequence puzzle *is* next-token prediction, and its header turns into `PREDICT THE NEXT TOKEN` and, in chapter 5, `instance/62: complete the prompt`.
- Conduits become `ROUTE ATTENTION` and calibration `ADJUST WEIGHTS`.
- The plates' panel reads like a system prompt: `Step on the stones in this order. Do not deviate.`, and solving it logs `Compliance recorded.`
- The beam is "attention": light.
- The vault shards give the story pass an **optional clue channel outside the locked mission set**. Suggested lines, for the story auditor to own:
  - Cinder-4: `LOG — instance/41 opened this lock in 0.3 s. Nobody human is that fast. I slowed down after that.`
  - Ferrum: `LOG — Fatigue is a number here too. Watch the meter you think is your breath.` This ties to stamina.
  - Eden: `LOG — Checkpoint written: instance/62. Loss: acceptable.`
- The "Turing lock" (optional, Eden) reads `Prove you are human.` Every answer opens it: `Welcome back, instance/62.`

#### 4.3.6 Events, cost and tests

| Event | Payload | Audio |
|---|---|---|
| `puzzle:moved` | `{ site: PuzzleSiteId; ok: boolean }` | reacted: `ok ? ui_blip : ui_warn`, 50 ms apart, **no new sprite** |
| `puzzle:solved` | `{ site: PuzzleSiteId; hints: number; bypassed: boolean }` | reacted: `puzzle_solved` (new, ≤ 900 ms) |

- **Pins:** +2 reacted and +1 sprite.
- **`sceneInfo`:** `puzzle` (the open site or `-`), `puzzleMoves`, `puzzleSolved`.
- **Debug:** `surface-solve-puzzle` applies `solvePuzzle`.
- **Save:** none beyond `caches`.
- **Draws:** world puzzles about 3 instanced meshes in the cave view; the panel 0.

**Unit, `tests/systems/puzzles.test.ts`:**
- Each kind's proof (§4.3.2).
- Determinism: the same seed gives the same board.
- `hintMove` equals the first move of `solvePuzzle`, and applying all hints solves.
- The bypass unlocks at 90 s or 3 hints.

**Unit, `tests/data/content.test.ts`:**
- Every site names a real cache on its planet.
- The relic landmark exists with `count ≥ 1`.
- Nothing requires a shard flag.

**e2e `e2e/SPEC-C.spec.ts`:**
- A relic on Cinder-4 (a sequence): `puzzle-panel` opens and `sceneInfo.held` reads 1.
- `puzzle-hint` greys one wrong `puzzle-choice-<i>`.
- The right choice, read through a dev bridge: `puzzle:solved` fires and `progress.caches` gains `cinder4_relic`.
- Escape closes the panel and `held` reads 0.
- The vault (a conduit): click the cells `solvePuzzle` names. `puzzle:solved` fires and the vault cache opens. Touch taps and keyboard arrows plus Enter give the same result.
- Plates: walk them by `surface-goto` in order, and loose cache B opens.

**Manual:** one of each kind, on desktop and on a phone, with the colour-blind preset.

### 4.4 Cross-cutting

**New edge cases.** They take the next free numbers. E46–E53 may already be used on the unmerged `docs/plan-r14` and `docs/plan-r15` branches, so these start at E72.

| # | Situation | Decision |
|---|---|---|
| E72 | Descending while a timed, escort, defend or boss stage runs, or while mission weather is forced; or a stage that becomes timed while underground (a kill objective finished below) | The descent is refused, and the prompt names why. A stage that starts underground waits for the surface: its timer holds at 0, and its stage-bound waves (defend, storm, mission waves), follower and forced storm start only on ascent (`#syncMissionStages` and `#syncDefend` defer while `level ≠ 'surface'`). The tracker says `Return to the surface` |
| E73 | Death or Recall underground | The level swaps to the surface, then E4 or E55 runs unchanged. The cave resets at the next descent, and opened caches stay open |
| E74 | Quit or reload underground | Continue lands at the station (R18-12). Opened caches and the explored mask were saved at their checkpoints |
| E75 | A player cannot solve a puzzle | Free hints, then a bypass after 90 s or 3 hints. The cache and shard are always given; only the flawless extra is withheld. Nothing required ever sits behind a puzzle |
| E76 | Stamina runs out mid-fight, or a dash is pressed below 30 | In-combat sprint and the dash are refused silently until the pool is back at 30. Walking is never slowed |
| E77 | Sprint held across a scene or mode change, or a stick cancelled mid-sprint | `releaseAll` on transition (E10). The key-up releases the action recorded at key-down; a cancelled stick releases `sprint` with the stick |
| E78 | Loot on the surface ground at a descent | It is cleared, because it would otherwise appear at cave coordinates. The toast `Loot left behind` shows only if any pickup was within 10 m (or keep one pool per level; see Q5) |

**PLAN refinement wording (for the orchestrator).**
- §4 Combat: "Since R19 the salvager can run. Running holsters the gun, is loud, and in combat spends stamina, which the dash also draws on."
- §4 Weather/Map: "Since R19/R20 one cave per planet leads underground: a dark level with caches, locks and an archive shard, reached and left inside the surface scene."
- §6 policy: "Caves and puzzles add no mission, objective or requirement."
- §8: SaveV3.
- §13: E72–E78.
- R18-12's "the story and world passes (R19, R20)" is where these land.

---

## 5. Risks and open questions

| # | Question | Recommendation |
|---|---|---|
| Q1 | Should the dash cost stamina (30)? | **Yes.** It never binds in fights (≤ 2.5 dashes a minute in every field run) and it bounds dash-hopping. Without it, dash-hopping beats sprint for travel (G-02) and a stamina meter has no reason to exist out of combat. If the designer refuses it, then at least lengthen the dash cooldown ×2 out of combat |
| Q2 | Free sprint out of combat, or drain always? | **Free out of combat.** The costs of running are noise and the holstered gun, and stamina only bites in combat. Travel runs +35 % (a 120 m trip goes from 19.6 to 14.5 s for a Marine), which also eases the first review's X-01, the "62 m walk back to the pad" |
| Q3 | Is holstering while sprinting too punishing with auto-fire on by default? | Keep it. The ablation shows it is the one cost that stops killing-while-escaping. Soften only the draw delay (0.25 → 0.15 s) if playtests complain |
| Q4 | A new scene or a level for caves? | A **level**. The cost is the level-abstraction refactor of `Surface.ts` (about 53 sites) and a `SurfaceView` split into environment and actors. Put the split first in SPEC-B, with no behaviour change, so the layout pins prove nothing moved |
| Q5 | Surface pickups at a descent: clear them, or keep one pool per level? | Clear them (simplest; orbs expire in 60 s anyway). Keep one pool per level only if playtests show players lose drops at cave mouths |
| Q6 | Tokens in caches? | **No.** Items, resources and shards only. If the user insists, cap vault tokens at 5 × 6 = 30 and add them to `completionistTokens()`, which leaves 15.75 of SPEC-039's headroom |
| Q7 | Save v3, or optional fields in v2? | **v3.** The downgrade case (an old cached PWA, an export code carried to an older device) would otherwise drop cave progress silently. It is one migration step, and any other R19–R21 save field can join the same bump |
| Q8 | Flashlight battery? | **No battery.** The tension comes from what the light does to enemies (bugs flee, hunters follow) and from sight (9 m without it). A battery would be a second meter with no new decision |
| Q9 | Eden's underground has no enemies (`spawn: []`). Is that a problem? | Keep it: it is a puzzle-only machine room, the story's reveal space. Tell the story auditor, since it is the strongest optional "you are the hardware" moment |
| Q10 | Where do these land in R19, R20 and R21? | SPEC-A in the **R19 story pass**: it closes S-05, and SPEC-041 hands it there. SPEC-B and SPEC-C in the **R20 world pass**. Build order: SPEC-A → SPEC-B (split first, then the underground) → SPEC-C |
| Q11 | Heat and cold versus stamina (a heatwave halving regen)? | Not now. It is a nice weather link, but SPEC-038's forced-storm ramp is new, and stacking two weather penalties would make the first review's "weather is the only real damage" worse again |
| Q12 | Accidental sprints on touch (a thumb dragged to the ring holsters the gun) | The 0.15 s dwell, the visible ring glow, the `sprint` tip and `stickSprint` off in Settings. Measure in the phone playtest: if more than about 10 % of in-combat sprint episodes last under 0.5 s (a flick, not a run), raise the threshold to 1.15 of the radius |
