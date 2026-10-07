# The fourth review (2026-10-07)

A Senior Staff Game Designer review of ReaLLM on `main` at `dfe6f04`. Every spec through SPEC-065 is built, except SPEC-033, SPEC-060 and SPEC-061.

The review covered five things:
- the story as a player meets it;
- the visual content;
- bugs;
- gameplay and balance;
- the state of the project.

The lead played a new game, then visited all six planets, the underground, puzzles, bosses and the phone layout at 60 fps, and sampled every film. Four read-only audits ran beside the playtest. Nothing in `src/` changed. This folder holds the findings and the plan.

| Report | Scope | Findings |
|---|---|---|
| [playtest.md](playtest.md) | The lead's own session: the first hour, every planet, the phone, the films, with screenshots in [`shots/`](shots/) | P-01…P-16 |
| [audit-story.md](audit-story.md) | The campaign line by line: covers, the reveal's pacing, Iris, the scavengers, Iteration 63's numbers | S-01…S-30 |
| [audit-gameplay.md](audit-gameplay.md) | The difficulty curve, the economy, builds, mission design and flight, with three calculators in [`gsim/`](gsim/) | G-01…G-20 |
| [audit-bugs.md](audit-bugs.md) | Typecheck, the unit suite and a correctness hunt through the code that landed since 2026-10-01 | B-01…B-24 |
| [audit-visual.md](audit-visual.md) | Art inventory, readability, the HUD, budgets, and docs/process hygiene | V-01…V-18, D-01…D-07 |

The earlier reviews are [`design-review-2026-09.md`](../design-review-2026-09.md) (R17), [`review-r18/`](../review-r18/README.md) (R18) and [`review-r19/`](../review-r19/README.md) (R19–R21). Every audit checked whether their decisions landed. Almost all did, and the exceptions are listed in each report's "did it land" table.

## 1. Verdict

**ReaLLM is feature-complete and stable, and the systems are deep.** Since the third review the factory has built caves, puzzles, treasure, remains, New Game+, a story difficulty, commendations, Iris, the "Wreckers" film, suited raiders and the depot. The first run's story is coherent end to end. The game holds 60 fps on `high` on every planet, with half the draw-call budget unused. Typecheck is clean and the unit suite is green: 132 files, 3,350 tests. Even so, the bug hunt found 24 confirmed bugs. One is a P1 the suite cannot see: collect objectives stall at a full hold, because the scene never wired in the fix SPEC-034 made in the economy (B-01).

What holds it back is not missing features. It is the gap between what the game has built and what the player is asked to do with it, and what they see while doing it.

1. **The world the player lands in is the least authored thing in the game.**
   - From the 22 m camera, four fifths of every frame is one tiling ground texture.
   - Every mission objective and every shelter is the same grey primitive on all six planets.
   - Three of the five bosses share one body.
   - The R20 world art is still the factory's stand-in build, which no one has reviewed as art.
   - Flight, the films' photographs and Eden's grove show the standard the surface could reach.
2. **The missions never ask for the newer systems.**
   - Caves, puzzles, the flashlight, treasure and the "walk, do not run" stealth appear in no main mission.
   - Chapters 1, 2 and 4 repeat one three-mission template.
   - Chapters 5 and 6 drop storms, shelters, collects and deliveries.
3. **Nothing limits consumables, so the threat tuning stops mattering.**
   - Medkits heal 50 % at once with no cooldown.
   - Frags can be thrown every half second.
   - Resources are always in surplus.
   - From chapter 3 on, a boss can be out-healed. The R18 threat pass, Hard and the no-death bonuses all lean on the player choosing not to do that.
4. **The twist leaks before chapter 4, and its strongest fact goes unsaid.**
   - The game shows the twist's own vocabulary before chapter 4:
     - "Containment level 1" on the first station screen;
     - a helmet among photographs on the Selection board;
     - `instance/58` in a chapter-1 vault;
     - "Off-task" in the Records list on a fresh install.
   - Since R25, the first combat order is to kill six raiders wearing the player's own suit, and nothing ever says so.
   - The climax tells the most obedient player "I never had to lie to you" between two admitted lies.
5. **Builds collapse to "the best rifle".**
   - On desktop the sidearm never fires on its own.
   - The combat drone copies per-shot damage.
   - On touch, a launcher tap costs a full second of fire.
   - Each of these is a one-line fix.
6. **The project carries process debt that blocks "done":**
   - four PLAN refinement entries that live only on branches;
   - 37 built specs still marked `draft`;
   - 112 hardware checks owed;
   - no milestone tag.

## 2. Scorecard

| Area | State | In one line |
|---|---|---|
| Story | **Good, with seams** | Run 1 is coherent and R19 landed. Specs added after R19 brought tells without covers, and run 2's numbers slip (S-05…S-09) |
| Films | **Mixed** | The photographic plates are the best images in the game. The interludes and the stay ending open on grey-void Blender shots (P-04, V-13) |
| Surface visuals | **Needs work** | Flat ground, primitive objectives, landmarks and shelters, reused boss bodies, a stand-in art drop (P-10, V-01, V-05…V-07, V-10) |
| Flight visuals | **Strong** | Baked ships, planet maps and sky windows. The first trips are empty (P-12, G-20) |
| Readability | **Good, with gaps** | Telegraphs vanish on Ferrum's lava and on the Hive in colour-blind mode. Five player shots wear the hostile hue (V-02, V-03, V-09) |
| HUD and mobile | **Good, with overlaps** | The waypoint sits on the quick bar, and at 844 × 390 the top half of the screen is HUD (P-06, P-07, V-04) |
| Combat and builds | **Deep but flattened** | Packs, affixes, telegraphs and boss moves all landed. Consumables and three build bugs flatten them (G-01, G-04, G-05, G-12) |
| Progression and economy | **Loose** | Kill XP is flat, the depot makes cargo moot, and one contract out-earns the campaign (G-03, G-10, G-11) |
| Mission design | **Thin late** | Three templates. No mission uses the systems built since R18 (G-02, G-19) |
| Code and tests | **Strong, with seams** | Typecheck and 3,350 unit tests green, 60 fps everywhere. 24 confirmed bugs: one P1 where the test helper wires what the scene does not (B-01), new caves where auto-fire shoots walls (B-02), and save edge cases that can lose progress (B-04, B-05, B-19, B-20) |
| Process | **Debt** | PLAN R14, R15, R22 and R23 are on branches only; statuses are stale; device checks and tags are owed (D-01…D-04) |

## 3. The top ten, ranked across every report

| # | Problem | IDs | Severity | Effort |
|---|---|---|---|---|
| 1 | **Collect objectives stall at a full hold.** The scene never passes `collectDemand` to the resource nodes, though `BUGS.md` §6 calls it fixed | B-01 | P1 | S |
| 2 | **Consumables have no budget.** Medkits heal 50 % at once with no cooldown, frags can be thrown every 0.5 s, and resources are always in surplus, so boss and Hard tuning stop mattering from chapter 3 | G-01 | P1 | M (R) |
| 3 | **The world the player lands in is the least authored part.** Flat tiling ground, grey primitive objectives and shelters, three bosses on one body, an art drop no one has reviewed | P-10, V-01, V-05, V-06, V-07 | P1/P2 | L |
| 4 | **The missions never use what was built.** No main mission uses caves, puzzles, the flashlight, treasure or stealth; three templates repeat | G-02 | P2 | L (R) |
| 5 | **The twist leaks early, and its strongest fact goes unsaid.** The containment label, card 62, `instance/58` in a chapter-1 vault and "Off-task" in Records all show before chapter 4. The six raiders in your suit are never named | P-01, P-05, S-05…S-08 | P2 | S–M |
| 6 | **The climax trips on its own lines.** "I never had to lie to you" sits between two lies, four covers outlive the confession, and the Hive keeps coming after "the Hive has gone quiet" with no one remarking on it | S-01, S-03, S-04 | P2 | S |
| 7 | **Builds collapse to the best rifle.** The sidearm never fires on desktop, the drone copies per-shot damage, and a touch launcher tap costs a second of fire | G-04, G-05, G-12 | P2 | S |
| 8 | **Save safety.** A stale tab overwrites the newer save and then silences autosave on every slot; "export your save code" exports the wrong save | B-04, B-05, B-19 | P2 | S–M |
| 9 | **Danger and navigation do not always read.** Telegraphs vanish on Ferrum's lava, five player shots wear the hostile hue, the waypoint sits on the quick bar, and in caves auto-fire shoots walls while packs aggro through rock | V-02, V-03, V-04, B-02 | P2 | S |
| 10 | **Process debt blocks "done".** PLAN R14, R15, R22 and R23 live on branches only, 37 specs are stale, 112 hardware checks are owed, and there are no tags | D-01…D-04 | P2 | S–M |

## 4. Easy wins

Each change below takes half a day or less. Most are data edits, one-line code changes, or numbers marked *initial tuning*, which can be retuned without a PLAN entry while the invariant tests stay green. The rows marked **R** change a PLAN-locked row (§6 missions, §4 consumables, the R2 label), so they need a refinement entry first. The rows marked **pins** move a literal in `tests/`, which must change deliberately.

### 4.1 Story and text (data only)

| ID | Change | Where |
|---|---|---|
| S-01 | "You never went looking. So you only heard the lies everyone hears. I am not sure that was better." (**pins**) | `src/data/dialogue.ts:510` |
| S-02 | Keepsake drift line: "…last time she gave it to you at the stair, not on the roof." (**pins**) | `dialogue.ts:803` |
| S-03 | `chapter5_done` variants for four cover lines that outlive the confession | `dialogue.ts:178, 223, 329, 425` |
| S-04 | An ARIA line on the Eden flight's first interceptors that finds `clue_never_hers`; a `c6_m2` brief without the spoiler | `waves.ts:164`, `missions.ts:575`, `clues.ts` |
| S-05, S-06 | A chapter-1 cover for the suited raiders, and two chapter-5 lines that say you killed six of yourself (**pins**) | `dialogue.ts:95, 475, 499` |
| S-07, S-08 | An ARIA cover after the first three vault logs; five commendations hidden until earned | `dialogue.ts:810-836`, `commendations.ts` |
| S-09, S-10 | Iteration variants for "Sixty-one" (tally, two Notes records, the memory split) and run-1 covers gated `iteration max 1` | `dialogue.ts:400, 521`, `clues.ts:180, 217` |
| S-13, S-14, S-15 | `clue_restart` from `restart_1` only; in-fiction death chrome; the Warden named in the confession | `clues.ts:99`, `DeathOverlay.ts:39`, `dialogue.ts` |
| S-24, S-28 | A cleaner first line of play; shard numbers taken from the prologue's wall | `dialogue.ts:74, 815-846` |
| P-02 | Paint **CR-62** on the tug, not RL-07 | `scripts/assets/blender/ships.py:103` + a rebuild |
| P-03 | Dark eyes on the "ran down" Machines plate | the prologue plate |

### 4.2 Builds and balance (numbers)

| ID | Change (old → new) | Where |
|---|---|---|
| G-04 | `weaponAutoSwap` `'touch'` → `'on'` | `src/core/Settings.ts:387` |
| G-05 | Drone shot from the primary's sustained DPS × 0.4, and honest card text | `Combat.ts:2072`, `UiHelpers.ts:614` |
| G-12 | Touch launcher tap: `fireCooldown = 1/rate` → `max(fireCooldown, 0.25)` | `Combat.ts:1932` |
| G-01 (half) | `EXPLOSIVE_USE_SECONDS` 0.5 → 1.2 | `Surface.ts:465` |
| G-06 | Dune Wurm phase 2 at 55 % (was 40 %), burrow every 6 s (was 9) | `enemies.ts:229, 238` |
| G-07 | Titan phase-3 damage ×1.44 → ×1.3; Vetra population 11 → 13 | `enemies.ts:481`, `planets.ts:291` |
| G-09 | Drop Ship Guns T1 from chapter 6's recommended loadout (**pins**) | `Balance.ts:100` |
| G-11 | A boss-mission contract pays 0.5 of its tokens (was 0.75); XP unchanged | `contracts.ts:72` |
| G-13 | Story difficulty `enemyHpMult` 1 → 0.6 | `tuning.ts:100` |
| G-14, G-17, G-18 | An "elites" bonus forces its elites; "Walked, did not run" also breaks on sprinting; Seeker 80 → 95 | `Spawn.ts:728`, `Commendations.ts:263`, `items.ts:656` |
| G-19 | Egg Hunt 15 → 10 eggs, par 360 → 240 | `missions.ts:545` |
| G-20 | Roll `flight_salvage` on flight kills | `Flight.ts:797` |

### 4.3 UI, readability and visuals

| ID | Change | Where |
|---|---|---|
| V-04 / P-06 | Keep the waypoint out of the quick bar and the thumb arc | `Surface.ts:6992`, `ui/Waypoint.ts` |
| V-02 | A dark-and-pale double outline on telegraphs; per-planet colour overrides on Ferrum and on the Hive in colour-blind mode | `views/TelegraphView.ts` |
| V-03 | Reserve the hostile hue band for enemies; raider tracers in the hostile colour; a ΔE content test | `items.ts`, `ScavRaiders.ts:51` |
| V-09 | Emissive resource nodes and orbs; a gold gear pickup | `views/SurfaceView.ts:1371, 3334` |
| V-08 (part) | A hit spark on `enemy:hit`, throttled to 50 ms | `views/CombatFx.ts` |
| V-13 | Move the escape ending's last poster to about 34 s | `data/films.ts:312` |
| P-08 | One puzzle tip per kind | `data/hints.ts:189` |
| P-09 | Difficulty order Story · Casual · Normal · Hard | `CreationScene.ts:658`, `settingsRows.ts:289` |
| P-11 | Dim the cave motes outside the light | `views/StormParticles.ts` |
| P-14, V-17 | `PCFShadowMap` explicitly; gate the flight lens flare off MSAA | `core/Renderer.ts`, `views/FlightView.ts:585` |
| P-15, P-16 | Dim and Cancel on the slot picker; accessible names on the class cards and portraits | `MenuScene.ts`, `CreationScene.ts` |

### 4.4 Bugs (each with a regression test shaped like the audit's failing assertion)

| ID | Fix | Where |
|---|---|---|
| **B-01** | Pass `collectDemand: (r) => economy.collectDemand(r)` to `Nodes`, through one factory the unit helper shares, so the two cannot drift again | `src/scenes/Surface.ts:1407` |
| B-02 | Below ground, auto-fire takes clear-line targets only, and placed enemies acquire only with a clear line | `Combat.ts:1973`, `EnemyAi.ts:378` |
| B-03 | Flight throttle and pause go through `PressEdges` | `scenes/Flight.ts:890` |
| B-04 | `flush()` honours the two-tab guard; the refusal is scoped to the slot the other tab wrote; the menu shows a reload banner | `core/Save.ts:2326, 2369` |
| B-05 | "Export your save code" exports the live save when it is the bound slot | `core/Save.ts:2525` |
| B-06 | A `#leaving` flag, checked after every await in `#runEnding`; `playFilm` skips while a transition runs | `Surface.ts:3972`, `Director.ts` |
| B-07 | Grant the fuel subsidy only on a real arrival, not on Back from the star map. E1 says "unlimited on purpose", so this needs a PLAN note | `StationScene.ts:131` |
| B-08, B-09 | The defend clock pauses while the player is dead; a survive stage's storm is suppressed only while its arena is engaged | `Missions.ts:619`, `Surface.ts:3443` |
| B-10, B-11, B-12 | Later deliver stages protect their cargo (amend SPEC-065 first); shipped surplus reaches the depot or the toast changes; the fuel text shows hold plus depot | `Missions.ts:289`, `Economy.ts:373`, `StarmapScene.ts:522, 567` |
| B-13…B-17 | Reset from pause leaves to the menu; a keyup always releases; P is ignored under a confirm sheet; a refused next instance reaches the menu; the descent wins over a predecessor's body | see the bug audit |
| B-18…B-23 | Contracts stay off cave packs; the quota retry keeps the old main; memory-only mode stops losing runs silently; remains say "hold full"; effects clear on the level swap; the flashlight's shadow pass runs only below | see the bug audit |

### 4.5 Housekeeping

| ID | Change |
|---|---|
| V-07 | Run the owed Blender build on this Mac (`node scripts/assets/blender/build.mjs props foliage ground cave items --preview=<dir>`), review the contact sheets, commit |
| D-01 | Rebase and merge PLAN R14 and R15. Decide R22 and R23 (merge as accepted-unbuilt, or close) |
| D-02 | Flip the 37 built specs to `status: done` in their frontmatter and in SPEC-000; merge `docs/spec-062-done` |
| D-05, D-07 | Re-index `docs/BUGS.md`; bump the version from 0.0.0; make `check.mjs` skip dotfiles |
| D-06 | Prune the merged branches and the five leftover worktrees (listed in the visual audit; nothing was removed) |

## 5. The plan

Seven steps, 0 to 6, in order, and film retakes that can run beside any of them. Each step names its goal, the findings it closes and how to know it is done. The bigger steps are written as the PLAN entries and specs the project already uses: the next free numbers are **R27**, **SPEC-066**, **E121** and milestone **M7o**. Every step ends with the existing definition of done: `npm run check` green, acceptance on desktop and one phone, the playtest log updated.

### Step 0 — Clean the slate (1 day; no design change)

- **Do:**
  - fix **B-01** first: it is a one-line P1, and it stalls a main-path collect;
  - the housekeeping table in §4.5, D-01 first, so that R27 lands on a PLAN with no gaps.
- **Done when:**
  - PLAN on `main` has R14–R26 in order;
  - SPEC-000 reads true;
  - the art drop is a real Blender run, with its contact sheets in the playtest log.

### Step 1 — The easy-win sprint (about one week; one PR per area, or three small specs)

- **Do:** everything in §4.1–§4.4 except the rows marked **R**.
- **How to build it:**
  - It is mostly data and constants, so it is a good fit for hand-made PRs (as `fix/cargo-full-once` was) rather than the factory.
  - The pinned test literals move in the same commit as the line they pin.
  - The story lines can go through the factory as one small spec if a written record is preferred; step 3 then carries the rest of the story pass.
- **Done when:**
  - the three build fixes show in the shop's DPS numbers;
  - a zero-clue player's confession reads cleanly (a content test);
  - the waypoint never overlaps `.quickbar` at 1280 × 720 or 844 × 390 (an e2e case);
  - B-01 has a scene-level case: a full hold, an active collect, standing on a node, and the counter moves.
- **Close the gaps that let these through:**
  - B-01 passed a green suite because the unit helper wired `Nodes` differently from the scene. Share one factory between scene and test wherever a test builds a system "the way the scene does".
  - Extend `tests/architecture/hotPath.test.ts` beyond `structuredClone`, so that the mission and guidance allocations of B-24 are caught next time.
  - Rebuild `dist/` before quoting precache numbers or trusting `tests/build/` (the 6 skips).

### Step 2 — R27 "Pressure that holds": budget the consumables, pay for fights (M; one spec)

- **Why first among the big steps:** every balance number since R18 assumes a budget that does not exist. Fixing it before any re-tuning keeps the later work honest.
- **Decisions to write into PLAN:**
  - a shared heal cooldown (8 s for the medkit, 5 s for the ration);
  - quick slots refill from the pack only out of combat (G-01);
  - kill XP scales ×1.15 per chapter (G-03; the SPEC-016 completionist pin moves from 11,135 to about 11,756 XP);
  - the Cargo Hold tiers become +2 pack slots each, and Hard's death also takes 10 % of the depot (G-10);
  - the first ten minutes:
    - `c1_m1`'s storm is cut to 30 s, or gets two skitter packs (G-08);
    - the first flight carries a scripted asteroid lane and one harmless target (P-12, G-20).
- **Spec:** SPEC-066 (or the next free number), with the boss suite re-run under "unlimited medkits on the cooldown" as a second bot, and the Titan kept inside 100 % of HP for the kite bot.
- **Done when:**
  - the bot suite passes with the new budget;
  - the chapter 4–5 field and boss numbers in G-07 sit inside the curve;
  - a first-time player meets the first fight within 3 minutes of creation.

### Step 3 — R28 "Every reading has a voice": the story pass (M; one spec)

- **Do:**
  - the cover discipline of R19 decision 5, applied to everything added since: vault logs, Records, raiders, "Wreckers", run 2 (S-05, S-07, S-08, S-10, S-12, S-19);
  - the scavengers' payoff (S-06);
  - "Write back": a reply to letter 3 that letter 4 ignores and ARIA names, plus Iris in the final choice (S-11);
  - run-2 caption variants for the 62/63 films (S-09);
  - one covered doubt in chapter 4 (S-26);
  - the containment label, if you choose to change it (P-01);
  - card 62's look, if you choose to change it (P-05, V-12).
- **Done when:**
  - a content test proves that no `instance/`, "Warden" or "off-task" text reaches the player before `signal_decoded`, except through a line that carries a cover;
  - run 2's numbers ledger (story audit §4) is all ticks.

### Step 4 — R29 "The world you land in": the surface art pass (L; two or three specs, hand-run Blender drops)

- **Do, in order of what the player sees most:**
  1. A view-only landing-site ring of dressing between 6 and 15 m from the pad (V-01). No layout pin moves.
  2. A POI kit (survey mast, relay dish, defend pylon, escort cradle, delivery beacon) and authored cave mouths and wreck hulls through `SHELTER_MODELS` (V-05).
  3. Three distinct boss bodies within the recipe system, with boss tints lifted to at least 2.5:1 (V-06).
  4. Height and landmark models per planet (P-10), and the five Voronoi ground layers re-authored (V-10).
  5. The combat sprites that ship unused, wired into the burst atlas (V-08).
  6. Item tiers that read at 40 px (V-11).
  7. Star-map discs from the flight planet maps, and drawn resource icons in place of emoji (V-16).
- **Budget:** precache headroom is 1.6 MB (V-18).
  - Drop the dead boot files.
  - Add a CI line at 24 MB.
  - Split `FilmPlayer`, `PuzzlePanel`, `EndingOverlay` and `ShareCard` into dynamic imports before the drop.
- **Done when:** the three promo frames are re-shot at a landmark, a grove and a fight, and still sit inside 96 draws and 130 k triangles on `medium`.

### Step 5 — R30 "Missions that use the game" (L; one spec)

- **Do:** re-stage, without adding, four missions so the main path uses what was built (G-02):
  - `c4_s1` goes underground and solves a conduit vault;
  - `c2_s2` crosses a slope that listens;
  - `c5_m2` becomes an escort through the drone packs;
  - `c6_m1` descends into Eden's machine room.
- **Also:** give chapters 5 and 6 one weather or shelter beat each.
- **Done when:** every system in the gameplay audit's "mechanics against missions" table is used by at least one main mission.

### Step 6 — Ship M7 (M; mostly device time)

- **Do:**
  - clear the 112 owed hardware checks, milestone by milestone, on the laptop and the reference phone (D-04);
  - re-take the screenshots;
  - tag `m7a`…`m7o` as each clears (D-03).
- **Then decide the three unbuilt specs:** SPEC-033 (Vercel), SPEC-060 (Android) and SPEC-061 (demo).

### Film retakes (parallel, any time; hand-run)

- **Do:**
  - a plate pass (or the plate grade) on the CGI shots that are not deliberate, starting with the first shot of each ending, then the capsule, tank and reactor openings of interludes 1, 2 and 4 (P-04);
  - the Machines' dark eyes (P-03).
- **Why separately:** R21 parked these retakes as "not now". They are the cheapest large gain in perceived quality, because every player sees the films.

## 6. Decisions only you can make

1. **The containment label (P-01).** Keep R2's diegetic "Containment level N" from minute one, or show a fiction label that glitches into it at the chapter-4 notice?
2. **Card 62 and the portraits (P-05, V-12).** Is the helmet-among-photographs clash the point (the instance is not like the humans), or should the cards and creation portraits move to the plate look?
3. **The consumable budget (G-01).** A heal cooldown and an in-combat refill lock change how the game feels in a boss fight. Is that the game you want, or should bosses be re-tuned around unlimited heals instead?
4. **The depot (G-10).** Repurpose the Cargo Hold tiers as pack slots, cap the depot, or accept that cargo no longer matters?
5. **Re-staging missions (G-02).** PLAN §6 locks the roster. Re-staging four missions changes their stages but not their count or rewards. Is that inside the lock?
6. **Factory or hand-made.** Step 1 fits hand-made PRs; steps 2–5 fit the factory as specs. Which do you want for each?
