# ReaLLM — Design review and improvement plan

**Date:** 2026-09-27 · **Build:** `main` @ `ad41d30` (SPEC-001…SPEC-032 merged) · **Reviewer:** Claude, as senior staff game designer

**How it was reviewed:**
- **Played it.** A fresh-browser new game (prologue → creation → station → first flight → Cinder-4) on desktop (1024×768, `medium`), then every biome, the shop, and a 740×360 phone-landscape pass.
- **Read the design.** PLAN.md, the R14 branch and the spec roadmap.
- **Ran four audits in parallel:** code, balance, story wiring and art.
  - The code and balance audits ran the game's own systems in scratch tests: 8 proof tests for bugs, and 60 Hz simulations for combat, flight, economy and pacing.
  - The story audit checked four of its findings live in the running game.
- **Nothing in the repo was changed except this file.**

**Follow-up:** Phases 0 and 1 of the plan (§10) are specified as **SPEC-034** (stabilization) and **SPEC-035** (the first hour) in `mdzunic/reallm-specs`, authorised by PLAN **R17**. Two of the review's items were already owned by the rescoped SPEC-016: B-26 (the order of `npm run check`) and the played campaign. The Gauntlet fix was re-simulated for the specs:
- Interceptors at 20 HP, 6 kills and the shot-sweep fix clear `c5_m1` with the stock guns in 15–16 of 16 seeded runs, for a pilot who aims where the target is.
- Interceptors at 25 HP clear it in only 3–4 of 16.

Severity:
- **P0** blocks the campaign or traps the player.
- **P1** most players will hit it, or it breaks a story beat.
- **P2** noticeable.
- **P3** polish.

---

## 1. Verdict

ReaLLM has a genuinely good idea, told with discipline:
- A salvager who slowly works out they are a model instance.
- ARIA's voice.
- The films.
- Earth's night side used as the progress bar.

The systems work underneath is solid, and the guidance layer (tracker, waypoint, shelter routing, escalating hints) is better than most shipped indies.

**The game is not ready for new players, for three reasons:**

1. **It can stop them.**
   - A hit near a rock freezes the salvager forever (P0, reproduced live and in a test).
   - The Hive Gauntlet is very likely unwinnable, which locks chapter 5. The mechanism is verified in code; 0 of 8 simulated runs succeeded, with any ship.
2. **The first ten minutes teach the wrong lesson.**
   - I died twice inside four minutes of the tutorial mission.
   - The enemies are tinted to match the sand: luminance contrast 1.08–1.51 against the ground, where 3:1 is a reasonable bar.
   - The first flight explains nothing.
3. **The story's climax misfires.**
   - The Warden's first direct address plays when the mission is *accepted*, or never.
   - The finale's defence wave never attacks.
   - The awakening "static burst" is invisible because of a CSS collision.
   - None of the optional discoveries is ever acknowledged.

Everything needed to fix this is small relative to what already exists. §9 lists two dozen easy wins of half a day or less. The plan in §10 is ordered to unblock first, then fix the first hour, then retune threat and economy, then make the story listen to the player.

### Scorecard

| Area | State | One line |
|---|---|---|
| Premise and writing | **Strong** | ARIA, the briefs and item flavour are the best part of the game |
| Story delivery | Needs work | The ladder is right; the wiring of chapters 5–6 is broken; the player's choices are never heard |
| Films | Solid, one clash | Pacing and captions are good; photographs next to greybox renders |
| Guidance and HUD | **Strong** | Tracker, edge marker, pillar, stuck pulse, shelter routing, tips |
| Surface readability | **Blocking** | Camouflaged enemies, small character, bloom and fog washing out the player, occluding rocks |
| Surface world | Needs work | Ferrum and the Hive read well; Cinder-4, Thessaly and Eden read as empty planes |
| Audio | Needs work | Guns, hits and explosions are silent; one calm and one combat loop for six planets; no `.mp3` fallback, and no phone ever verified |
| Combat feel and threat | Needs work | Trivial with auto-fire, surprise-lethal without it; bosses can't catch a kiter |
| Flight | Solid look, one blocker | Beautiful cockpit; the Gauntlet can't be won; shots tunnel through divers |
| Economy and progression | Needs work | Free gear drops leave ~715 tokens unspent; dominated weapons; Marine dominant |
| Stability | Blocking | Two P0s, thirteen P1s |
| Pipeline and process | Good, with gaps | Tests are thorough but miss exactly the blockers; PLAN on `main` lags what is built |

### Top ten, in order

| # | Sev | Problem | Where it lives |
|---|---|---|---|
| 1 | P0 | Knockback into a rock or wall freezes the player permanently; no in-game recovery | `Combat.ts:436,1112,1133` + `Surface.ts:1440` |
| 2 | P0 | Hive Gauntlet (`c5_m1`, 10 interceptor kills) is likely unwinnable: 83 HP divers, a ~3 s dive, a third of shots tunnel through them. Failing locks every Hive mission | `Flight.ts:435-437,626-651`, `enemies.ts` `hive_interceptor` |
| 3 | P1 | First-session lethality: camouflaged enemies, desktop auto-fire off by default, storms, no flight tutorial | `enemies.ts` tints, `Settings.ts:167`, `hints.ts` |
| 4 | P1 | The Queen's death line (`c5_m3_warden`) plays at accept on the pad, or never when accepted at the board | `missions.ts:455`, `Surface.ts:3734`, `MissionBoard.ts:159` |
| 5 | P1 | Modal story dialogues freeze and disarm the player while combat keeps running: the Queen's death with her 12 summoned drones, Eden's choice with the wave alive | `Surface.ts:1021-1046` |
| 6 | P1 | The finale's defence wave never engages: 0 of 47 enemies came in, and the beacon took 0 damage over 240 s | `Spawn.ts` wave aggro and leash; `waves.ts` `eden_final` |
| 7 | P1 | The player is barely visible: camera 28 m away at FOV 40° (≈5 % of frame height, ≈10 px on a phone); bloom threshold 0.85 turns Vetra into a whiteout on medium and high; exp² fog on the player; rocks with no fade | `Surface.ts:127-130`, `Quality.ts:245`, `planets.ts` fog, outcrops |
| 8 | P1 | Save and economy bugs: replays vanish on reload, imports get overwritten, resources over the base cap are deleted, collect objectives stall at the cargo cap | `Save.ts:552,841`, `SettingsPanel.ts:410`, `Pickups.ts:117` |
| 9 | P1 | The story never listens: `iteration_log`, `scaffold_secret` and `signal_decoded` are set and never read; the "off-task behaviour" notice fires on rails | `missions.ts:239,314,377` |
| 10 | P1 | Presentation holes: guns, hits and explosions make no sound (no event exists for them); no item has a picture, and the generator as written would render every item from behind; quick-bar item names render 0 px tall | `core/AudioReactions.ts`, `scripts/assets/blender/items.py:254`, `ui/QuickBar.ts:89` |

---

## 2. What to protect

These are working. Keep them as the fixes land.

- **ARIA's voice and the house style.** No contractions, dry and protective. "Cinder-4 is habitable in the way a furnace is habitable." "The probe is expensive. You are not." Her intro line "I keep you honest" pays off as "I have kept you on task since the first sand."
- **The flavour text.** "Earth Command issue. It will not win a fight, but it will never be the reason you lost one." Every item and brief is written like this.
- **Diegetic tells:**
  - "SIGNAL LOST" on death;
  - "PAUSED — SYSTEM HOLD";
  - Command's gamey "X is unlocked";
  - the chapter card's `containment level N`.
- **The story structure:**
  - The awakening ladder: echo → your own log → generation parameters → containment notice → the Warden → choice.
  - Earth's night side relit one patch per interlude.
  - The stay ending cutting back to the prologue's first frame.
- **Guidance (R10):**
  - tracker, edge marker and light pillar;
  - "hold still inside the ring" for scans;
  - the storm banner with the waypoint sending you to shelter;
  - the stuck pulse;
  - first-time tips;
  - the controls sheet in the pause menu.
- **The depart sheet copy:** "Fuel: 40 oil, charged now — you hold 60. The return trip is free." Skip-the-run is explained in place.
- **Flight presentation:** the nebula sky windows, streaking stars, the lit cockpit dashboard, and the planet growing to fill the canopy.
- **Ferrum** (glowing cracks) and **the Hive** (chitin cells): the two surfaces with a real identity.
- **Engineering:**
  - The economy's worst-case invariants hold with margin.
  - The voucher loop never strands a main-path player.
  - Kill objectives finish in 0.4–2.7 min on every preset.
  - Lithium is a healthy late sink.
  - No typos, no over-long lines, and no compass bearings in any of 454 strings.

---

## 3. The first fifteen minutes, as a new player (desktop, normal)

| t | Moment | What happened |
|---|---|---|
| 0:00 | Boot | Wordmark, a percentage bar, START THE GAME. Clean. |
| 0:10 | Main menu | A generic button column over a 3D backdrop hidden by the scrim. The footer reads `ReaLLM 0.0.0 · M0 engine`. |
| 0:15 | New Game | The menu reflows under the cursor, which lands on SETTINGS. The three empty slots are listed twice (picker + STORAGE). |
| 0:20 | Prologue, 93 s | Strong narration. The photographic shots are striking; the rendered ones between them look unfinished (§6.4). |
| 1:55 | Creation | Good class copy and live stats. Portraits are 30×40 px. The 3D preview floats out of its frame when the form scrolls. |
| 2:40 | Station | ARIA lands. The hub is a list with no place. The mission brief is hidden until tapped. ACCEPT turns into ABANDON under the cursor. |
| 3:00 | Depart | The film plays. Then for ~5 s the star map looks broken — "Need 20 more oil", red fuel, Depart disabled, planets gone — while flight loads. |
| 3:15 | First flight, 90 s | Beautiful. No instructions at all. Two identical heart bars (player HP and hull). Nothing is asked of the player. |
| 4:45 | Cinder-4 | The tracker and tips work. The character is tiny. The "dying scavenger" speaks from empty sand. |
| 5:10 | Walk to the Dune Sea | Sand-coloured wurmlings hit from behind: 160 → 0 HP in ~10 s. Death #1. |
| 6:30 | Ambient sandstorm | Death #2. `kills: 0` after 6 minutes and 29 spawns. |
| 8:00 | Scan, forced storm, survive | The guidance sends me to shelter. This part works well. |
| 9:30 | Mission complete | ARIA's line lands. Then "NO ACTIVE MISSION", and a 62 m walk back to the pad terminal. |
| 9:40 | **Softlock** | Knocked into a rock outcrop; no direction moves the salvager. The pause menu has no recall. Only Save & Quit gets out, and Continue lands at the station, not the planet. |

---

## 4. Blocking and correctness bugs

"Proof" says how each bug is established:
- **live** — seen in the running game;
- **test** — a passing scratch test in the review scratchpad;
- **code** — read in the source;
- **sim** — the balance audit's simulation of the real systems.

### 4.1 P0

**B-01 · Knockback or push-out traps the player inside an obstacle (live, test)**
- **Cause, combat side.** These move the player with no obstacle test:
  - `Combat.#knockbackPlayer` (`Combat.ts:436`), summed and applied in `#applyKnockback` (`:1133`), up to 1 m per step;
  - `#pushPlayerOut` (`:1112`).
- **Cause, movement side.** `Surface.#movePlayer` (`Surface.ts:1440-1441`) accepts a step only if its destination is obstacle-free. Once the player overlaps a rock, every step overlaps too, so the player is frozen for good.
- **Same for enemies.** Projectile knockback at `Combat.ts:800` plus `EnemyAi.ts:205` freezes an enemy the same way.
- **Seen live:** at (21.4, −58.1) on Cinder-4, position unchanged after 1 s holds in six directions while input registered and the loop ran.
- **Fix:**
  - Push the player out along the obstacle normal before moving.
  - Clamp knockback and push-out against `hitsCircle`, as `Combat.explode` already does at `:680`.
  - Add **Recall to pad** to the surface pause menu, as a universal unstick (design: needs an R-entry).

**B-02 · The Hive Gauntlet is likely unwinnable, and failing it locks chapter 5 (code, sim)**
- `c5_m1` needs 10 `hive_interceptor` kills during the outbound flight.
  - The interceptor carries **83 HP** (`enemies.ts`, already chapter-scaled) and dives the last 160 m in ~2.9 s.
  - Ship guns are 10 / 13 / 17 / 22 damage at 4 / 4 / 5 / 5 shots/s (`upgrades.ts:82-83`).
- **Shots tunnel.** `#updateShots` runs before `#updateHazards` (`Flight.ts:435-437`) and tests the hazard's current depth against the shot's forward window (`:636`). A target closing on the ship jumps from ahead of the window to behind it. **37 % of perfectly aimed shots pass through interceptors, and 25 % through asteroids.**
- **Simulated full trips: 0/8 completions for every ship**, including guns tier 3 at throttle 0.8; the best average was 5.2 of 10 kills. In 200 duels, guns 0–1 never killed an interceptor before it rammed.
- **What happens on failure:**
  - The holding pattern lands anyway after 90 s with `c5_m1` open.
  - Every Hive mission requires it.
  - A re-fly costs 108–120 oil, which the station subsidy (E1, cheapest jump = 40) does not cover.
- **Why nobody caught it:**
  - The campaign harness auto-satisfies kill objectives (`tests/campaign/harness.ts:14`).
  - The dev "Skip to planet" completes the flight missions (R16-5).
  - Service mode refuses to skip them (R14-6).
- **Confirm first:** fly the Gauntlet once by hand with the recommended ship, before anything else.
- **Fixes, validated in simulation:**
  - (a) **Bug.** Sweep relative motion: hit when `hazard.depth ≥ from && hazard.depth + hazard.vDepth·dt ≤ to`.
  - (b) **Design (R-entry).** Flight enemies skip chapter HP scaling: interceptor 83 → 25, scav fighter 98 → 40.
  - (c) **Initial tuning.** Put ship guns tier 1 in the chapter-5 recommended loadout.
  - (d) **Design (R-entry).** Cut `c5_m1` kills 10 → 6.
  - (e) **Initial tuning.** Extend the E1 subsidy to the fuel for a planet with an open main flight mission.
  - With (a) + (b): guns 1 gets 8/8 with a leading pilot and 4/8 with a no-lead pilot; guns 2 gets 8/8 even with no lead.

### 4.2 P1

| ID | Bug | Proof | Fix direction |
|---|---|---|---|
| B-03 | **Modal story dialogues disarm the player while combat runs.** `Surface.ts:1021-1046` skips movement and the quick bar when `modal`, but still calls `combat.update`, and the modal disables input, which turns auto-fire off. Where it bites: `c5_m3_aria` plays at the Queen's death with her 12 summoned drones alive; `c6_choice_intro` and the verdict open with the `eden_final` remainder alive. Measured: a level-14 scout dies at 25 s to 12 drones while reading. | code, test | Hold the simulation (`#uiHolds`) while a modal dialogue or choice is up, as the map and the ending already do; or despawn the remaining wave and summons when the stage ends |
| B-04 | **The Warden's first direct address plays at the wrong time or never.** `c5_m3` is the only mission with `onStage[0]` (`missions.ts:455`). Stage 0 fires on `mission:stageStarted` at pad accept (`Surface.ts:3725-3737`), *before* ARIA's warning and the fight. The station board emits only `mission:accepted` (`MissionBoard.ts:159-165`), and landing replays only accept lines (`Surface.ts:941-949`), so board players never hear it. ARIA's confession then answers a speech that happened at the wrong time or not at all. | live, code | Add `onStageDone` to the schema (R-entry, SPEC-009 interface), or with no schema change fold the Warden lines into the head of `c5_m3_aria`; add a content test forbidding `onStage[0]` |
| B-05 | **The finale's defence never engages.** `eden_final` spawns 30–55 m from the beacon, un-aggroed, wandering within 8 m and leashed at 40–45 m; far enemies may be despawned. Standing at the beacon: 0/47 came in, and the beacon took 0 of 600 damage over 240 s. Eden has no ambient population, and its `eliteChance` is never rolled for waves. | sim | Spec conformance (SPEC-012 §4.5/§4.7): wave enemies spawn aggroed, leash anchored at the wave centre, excluded from far despawn; band 30–55 → 25–40 m. Validated: 46/47 engage, and the beacon takes 255/600 |
| B-06 | **Collect objectives stall at the cargo cap.** Pickups stop at the cap (`Pickups.ts:117-126`, `Economy.ts:202`), and nothing on a surface can spend a resource. After `c3_m1` the hold carries 270–390 wheat, so `c3_s2` (300 wheat) stalls at 10–130. `c3_m1` itself stalls for anyone arriving with >150 wheat. The only message is `CARGO FULL`. | test, sim | Design (R-entry, amends E3): pickups made at the cap still count toward an active collect and ship home; or `c3_s2` 300 → 150. Add the invariant "per planet, same-resource collects + 100 ≤ cap" |
| B-07 | **Accepted replays vanish on reload.** The validator drops any active mission also in `missionsDone` (`Save.ts:841-844`), which is what a replay looks like (`UiHelpers.ts:409`, `Missions.ts:175`). `tests/core/save.test.ts:692` pins the old rule, and `missions.test.ts:357` contradicts it. | test | Keep active replays in the validator; the PLAN §6 / E2 replay rule wins over SPEC-007's older rule |
| B-08 | **An imported save code is overwritten by the running character.** Import writes storage only (`Save.ts:1676-1702`, `SettingsPanel.ts:410-416,486`). The next autosave writes the old character back; the one after also overwrites `:bak`. The menu path does the same: Continue prefers the in-memory save (`MenuScene.ts:399-416`). | test | After an import into the active slot, rebind and reload the imported save (or refuse, or return to the menu) |
| B-09 | **Resources above the base cargo tier are deleted on every load.** The validator clamps to `cargoCap(ship)` without the Quartermaster bonus (`Save.ts:389-393,552`), while `Economy.cargoCap()` includes it and rewards may exceed it on purpose (`Economy.ts:189,202`). Example: Quartermaster L1 with 500 oil reloads as 400; a 60-oil voucher on 390 oil reloads as 400. | test | One cap function shared by the validator and the economy; the validator never clamps below what the economy allows |
| B-10 | **Max HP has three formulas.** `Save.maxHp` = 100 + 10·vigor + 4·(L−1), no class bonus (`Save.ts:400`); combat = 100 + bonus + 8·vigor + 4·(L−1) (`Combat.ts:136`); the creation preview = `Save.maxHp` + bonus (`UiHelpers.ts:442`). My Marine (vigor 5) showed **170** at creation, **150** in flight, at the station and on the character panel, and **160** on the surface. Level-ups add HP only to the save's copy (`Progression.ts:105`). | live, test | One `maxHp` in a pure module, used everywhere; one vigor weight |
| B-11 | **Ctrl+W closes the tab.** Throttle-down is `ControlLeft` (`KeyboardMouseDriver.ts:48`) and steering is WASD. Chrome and Edge on Windows/Linux reserve Ctrl+W, and a page can't cancel it. Invisible on a Mac. | code | Rebind throttle-down (e.g. `KeyX`, keeping the wheel); never bind a lone modifier |
| B-12 | **The awakening "static burst" is invisible.** `.hud-static` is defined twice; the later ion-storm rule (`style.css:2943`) overrides the burst's gradient (`:1370`) with a 6 %-alpha scanline under `mix-blend-mode: screen`. `.hud-storm` is also duplicated (`:1360` / `:2933`): the surface storm vignette renders as a flat grey sheet, and the flight ion-storm warning is probably never visible. | live (computed style), code | Rename one of each pair; add a CSS lint for duplicate top-level selectors |
| B-13 | **Defend and escort give no feedback.** The beacon's HP is tracked and `poi:damaged` emitted (`Surface.ts:1887-1903`), but nothing shows it, and the 0-HP reset is silent (E13 promises a toast). The escort's death is silent too, and a player death does not restart an escort stage (E4; `Missions.ts:549-555`). | code | An objective HP bar in the tracker, the E13 toast, escort restart on death |
| B-14 | **The star map looks broken after the departure film.** Fuel is paid, the film is awaited, then `go('flight')` loads while the star map re-renders against the reduced oil: red fuel, "Need 20 more oil", Depart disabled, planets gone, for ~5 s (`StarmapScene.ts:478-497`). | live | Keep the film's black frame (or a "JUMP" card) until `scene:entered` |
| B-15 | **Flight shots tunnel** through anything closing on the ship (asteroids 25 %). It's part of B-02 but affects every trip. | sim, code | See B-02 (a) |

### 4.3 P2

| ID | Bug | Proof | Fix direction |
|---|---|---|---|
| B-16 | Enemy population follows the graphics preset. `maxEnemies` is 12 / 20 / 32 (`Quality.ts:51,71,88`); medium plays at 62.5 % of the designed population and low at 37.5 %, so difficulty depends on the device | sim | `P = round(population × min(1, maxEnemies / 20))`; cap draw cost, not the design |
| B-17 | Resource nodes stop regenerating after almost any harvest: regen waits for `pending == 0`, and the flush moves whole units only (`Pickups.ts:210-224`) | test | Regenerate regardless; credit or drop fractions |
| B-18 | Reward items that don't fit a full pack are lost for good (`Economy.ts:628-633`, "left behind", but nothing drops them) | code | Drop at the player's feet (E25), or mail to the station |
| B-19 | "Use" on a heal at the station always wastes it: the station heals to full on entry (`StationScene.ts:183`; E40) | code | Refuse at full HP, as on the surface |
| B-20 | Mission lines at the wrong moment or never: flight accept lines never play (`c4_s2_accept`, `c5_m1_accept`); flight `_done` lines surface late at the station; every surface `_done` line plays twice (surface, then the station debrief, which runs *after* the interlude), and stale ones replay after any reload (`StationScene.ts:38,256-274`); on the pad, `c1_m1`'s scav plays before ARIA's landing line; `c2_s1_log` plays *after* delivery but ends "Deliver the water, salvager." | live, code | One per-save "played" set shared by both scenes; debrief only what the surface didn't play, before the interlude; flight plays its mission lines |
| B-21 | Mission-level waves never start (`MissionDef.waves`, so `thessaly_reaping` never runs), and survive stages run no waves, although the R10 risk table relies on "survive stages still run their waves" | sim, code | Start mission waves while active (spec conformance) |
| B-22 | The board's **Pin** does nothing: it's stored in a WeakMap only the board reads (`MissionBoard.ts:25-31`), and the runtime pins the first active mission (`Missions.ts:128`) | code | Persist the pin in the save, or remove the button |
| B-23 | Fire rates round down at 60 Hz: `fireCooldown = 1/rate` fires only on a step, so 3 → 2.86/s, 10 → 8.57/s (`combat.test` pins `1/3`) | sim | `fireCooldown += 1/rate` (carry the remainder), then retune the Rotary |
| B-24 | The creation preview model stays fixed on screen while its DOM frame scrolls away (every screen shorter than the form, including all landscape phones) | live | Pin the preview column (`position: sticky`) or track the frame's rect each frame |
| B-25 | Film rebuilds crash: `CARD_NUMBERS` is used at `scripts/assets/blender/lib/shots_prologue.py:252` but was deleted in `5b7e57a`. The prologue's `selection` and both ending walls raise `NameError` | code | Restore the constant `(62, 7, 13, …)` |
| B-26 | The PWA build tests never run in CI: `npm run check` runs `test` before `vite build`, and `tests/build/pwa.test.ts:118` is `describe.skipIf(!built)`. Locally, a stale `dist/` fails 5 of them (it did on this checkout) | live | Already specified by the rescoped SPEC-016 §11: `check` builds, then tests |
| B-27 | After the **escape** ending, Continue drops the "disconnected" salvager back at Command Relay with nothing said (`MenuScene.ts:400-420`) | code | Mark the slot `instance/62 · disconnected`; either start Iteration 63 from it or play one Warden line |

### 4.4 P3

- `?debug` exposes Smite, To objective and Wake boss in production builds; those kills pay XP and loot.
- `settings.lastSlot` is never written.
- A second wheat ration within 5 s replaces the first's heal-over-time.
- Equipping a duplicate of worn gear consumes the duplicate.
- Buying shield tier 2 raises the "containment level" (`StationScene.ts:296`).
- The star map shows "Travel: 1m" for a 90 s trip, and its detail panel covers the Vetra node.
- Class cards in creation are unnamed buttons (accessibility).

---

## 5. Onboarding, readability and UX

### 5.1 First-session lethality (P1)

Two deaths in four minutes of the tutorial mission is the single biggest retention risk after the P0s. The causes stack:

**1. The enemies are camouflaged by design.**

Luminance contrast of each enemy tint against its planet's ground colour; 3:1 is a reasonable minimum for a hostile silhouette:

| Planet | Enemies (contrast) |
|---|---|
| Cinder-4 | skitter 1.08 · wurmling 1.40 · raider 1.51 · Dune Wurm 1.74 |
| Vetra | spitter 1.07 · mite 1.25 · matriarch 1.36 · crawler 1.55 |
| Thessaly | hound 1.93 · broodlord 1.93 · drone 2.81 · spitter 3.42 |
| Ferrum | Ash Titan 1.28 · crawler 1.99 · slag spitter 2.41 · wraith 3.04 (emissive) |
| Hive | Queen 1.81 · warrior 2.68 · spitter 4.11 · egg 5.26 |

The two chapters where players learn are the worst.

**2. Auto-fire is off on desktop** (`autoFire: 'touch'`, `Settings.ts:167`), and nothing warns "under attack" beyond the red vignette.

**3. The route to the first scan crosses the ambient spawns.** An ambient sandstorm also landed in the same four minutes.

**4. The flight explains nothing,** yet it's the first interactive gameplay: `hints.ts` has no flight tips.

**The asymmetry.** With auto-fire (the touch default), the balance simulation takes **0–4 % of max HP per minute** from enemies (§7.1), so the difficulty is bimodal. Fix readability first, then tune threat.

**Fixes:**
- A consistent hostile accent on every enemy, all biomes: emissive eyes or a rim light, plus a tint pushed to ≥ 3:1 by value, not hue.
- A first-combat tip.
- Desktop auto-fire on for chapter 1, or a clear "hold to fire" prompt.
- No ambient spawns within 25 m of the `c1_m1` route for its first two minutes.
- Two flight tips: steer and fire, then throttle.
- A hull icon for the hull bar; hide the salvager's HP in flight.

### 5.2 The player is too small and too hidden (P1)

- **Camera:** distance 28 m, FOV 40°, pitch 55° (`Surface.ts:127-130`). A 1.8 m salvager projects to ~1 m against ~20 m of frame height: ≈5 % of the screen (genre norm ≈10 %), and ≈10 px tall at 740×360.
- **Bloom:** the surface inherits `DEFAULT_LOOK.bloomThreshold` 0.85 (`Quality.ts:245`). Sunlit snow sits far above it, so on medium and high Vetra becomes a **whiteout with no weather active** and the salvager disappears; Cinder-4 and Eden get a milky veil. On `low` (no post) the same frames are crisp. An in-browser A/B at 1.6 brings the player back and removes the veil. The playtest log already flagged the Vetra blowout, pending a GPU run (`playtest-log.md:277-281`).
- **Fog:** `FogExp2` (`planets.ts` fog density 0.010–0.032) has no near distance, so it hazes the player and anything next to them.
  - Vetra at 0.020, with fog `#c9dde9` over snow `#dbe9f2`, stays pale even after the bloom fix.
  - The Hive, at 0.032 with sun 1.3 and ambient 0.4, is nearly black; the player is a glowing dot.
- **Rocks:** free-standing outcrops (SPEC-030) hide the player completely. Caves already lift their roof (playtest log §SPEC-030); outcrops don't.
- **Fixes:**
  - The surface's own `bloomThreshold: 1.5` in `SurfaceView.ts:499-504`, leaving the shared default pinned by `postPlan.test.ts:182` alone. Raise the Hive cracks' emissive 1.5 → 2.5 so they still bloom. This is initial tuning, with no PLAN entry.
  - A per-form-factor camera distance (≈20 m on phones, ≈22–24 m on desktop).
  - Linear fog starting at the camera-to-player distance, or much lower exp² densities.
  - Vetra's grade darkened, or its ground layer given more value contrast.
  - Hive sun 1.3 → 2.0 and ambient 0.4 → 0.55.
  - Dither or fade any prop between the camera and the player, and a player silhouette through occluders.
  - PLAN R6-4 locks SPEC-012's camera numbers, so this needs an R entry.

### 5.3 Flow and UI friction

| ID | Sev | Issue | Fix |
|---|---|---|---|
| X-01 | P2 | After a mission completes: "NO ACTIVE MISSION", and the next job needs a walk back to the pad terminal | Offer the next main mission in the completion toast (`E` to accept remotely), or let the tracker say "Next: return to the pad terminal (62 m)" |
| X-02 | P2 | The mission board hides the brief until tapped | Show the brief on available and active missions by default |
| X-03 | P3 | ACCEPT turns into ABANDON in the same spot, so a double-click opens the abandon sheet (it asks first, so nothing is lost) | Put ABANDON at the far end of the row |
| X-04 | P2 | The board lists replayable missions above new ones | Sort: active → available → locked → replayable |
| X-05 | P2 | The ship shop shows raw keys: `speedMult 1 → 1.15 · fuelMult 1 → 0.9`, `hullHp`, `shieldHp`, `cargoCap`; a "50 → 49 tokens" discount appears on some rows only | Human labels ("Speed +15 % · fuel use −10 %"); hide sub-1-token discounts |
| X-06 | P2 | The station header prints "Command Relay" and "Containment level 1" twice each; the hub has no sense of place — the tug-in-dock backdrop is barely readable behind the scrim and the panels | Drop the duplicates; lighten the scrim; see §6.5 |
| X-07 | P2 | Main menu: the footer says `ReaLLM 0.0.0 · M0 engine` (`main.ts:33,39`); New Game reflows the column under the cursor; the slots are listed twice | Version and short sha from `package.json` and git (SPEC-033 already plans `build.json`); fixed-height menu; one slot list |
| X-08 | P2 | Creation: portraits render at 30×40 px; no class preselected; the preview is dark and crops the head | Portraits ≥ 64 px; preselect Marine; light the preview |
| X-09 | P2 | Phone landscape: the minimap covers the token counter; HUD furniture takes ~40 % of the screen | Move the wallet column under the minimap or into the tracker; shrink the idle tracker panel |
| X-10 | P3 | Continue always resumes at the station (by design), so a mid-mission quit costs a relaunch. Skip-the-run covers it after the first visit | Fine; say so on the Save & Quit button ("returns you to Command Relay") |

---

## 6. World and visual content

### 6.1 Biomes at playfield scale

| Planet | Reads as | Why |
|---|---|---|
| Cinder-4 | an orange plane | The sand layer is good; bones and pebbles are invisible at camera height; ruins are 4 landmarks spread 40–150 m from the pad |
| Vetra | a white screen | Bloom threshold 0.85 on sunlit snow, then fog (§5.2) |
| Thessaly | a green floor in green fog | "Jungle ruins" exists only as the boundary canopy ring; scatter is tufts and spores; 5 overgrown ruins spread 50–180 m from the pad |
| Ferrum | **volcanic — works** | Dark basalt with emissive orange cracks |
| The Hive | **alien — reads, too dark** | Purple chitin cells, lit mostly by the player (sun 1.3, ambient 0.4, fog 0.032) |
| Eden-Prime | a flat lawn | Tufts at density 5 read as texture; nothing tall |

**Arena scale.** Arenas are 320–400 m squares (`halfSize` 160–200) walked at 6 m/s, and points of interest sit 40–180 m from the pad. With no mid-scale dressing, walking between objectives is the main activity.

**Fix: a "set dressing" tier between scatter and landmarks.** Using the existing prop generator (`models/props/<biome>_<kind>_<a|b>.glb`), 20–60 instanced 1–4 m pieces per biome:
- **Thessaly:** broken columns, fern clumps, small trees.
- **Cinder-4:** rib cages, half-buried pipes, wind-cut rock.
- **Vetra:** ice shards.
- **Eden:** trees, and a few deliberately *repeated* ones (§8).

Consider `halfSize` 180 → 140 on the early planets.

### 6.2 The ship is never on the pad

We "touch down twelve metres short of the pad", and the pad is empty. Parking `ship.glb` (the tug the player upgrades) on or beside the pad gives every landing an anchor and a place to return to. Cheap: the model exists.

### 6.3 Items have no pictures, and the quick bar hides their names (P1)

- **The renders never existed.** `public/assets/items/` is on no branch; commit `f2285d7` says the container had no Blender (R14-4, SPEC-031 §4.13-§4.17).
- **What shows instead:** every surface falls back to a shared glyph per kind:
  - both handguns `⌐`;
  - all four rifles `⌖`;
  - both machine guns `☰`;
  - both launchers `⚟`;
  - all four armours `⛨`;
  - the ration and the medkit `✚`;
  - all five companions `⌬`.
- **The gear card** shows a lone ~160 px `⌐` in an empty frame, which reads as broken, not minimal. It also stretches edge to edge on desktop, because the legacy `.gear-card` rule (`style.css:2526`) overrides its 420 px width (`:4090`).
- **The generator can't simply be run.** `items.py:254` puts the camera on Blender's −Y side (the portrait formula), while every item builder puts its front detail on +Y. As written it would render every gun from behind and make the ration and medkit, and the four armours, look identical.
- **The quick bar hides names.** Slots are 48 px (56 on touch) and the icon box 40 px (48), so the name label measures **0 px tall** (`QuickBar.ts:89`). The Pistol and Hand Cannon, and all four rifles, are indistinguishable mid-fight. SPEC-031's e2e passes because `toContainText('Repeater')` (`e2e/SPEC-031.spec.ts:351`) checks presence, not visibility.
- **Fix:**
  - A camera angle per item kind: weapons side-on with the barrel to the right, everything else front three-quarter. Add a rim light or a faint backdrop so gunmetal reads against the navy UI.
  - One Blender run, then commit (≤ 0.94 MB of the 1.0 MB budget).
  - Slots 48×64 (56×72 on touch), and an e2e that asserts the name is visible.
  - `.gear-card-sheet { flex: none; }`.

### 6.4 Films: one clash to fix

- **The photographs are consistent with each other.** They share one grade and one cast (the Selection faces reappear at the shelter table and the tap), and the CG space shots sit comfortably beside them.
- **The clash is wherever CG shows Earth's surface or the shelter:** seven shots, about 45 s of screen time.
  - Prologue: `stranded` (56–66 s, blocky machines among grey boxes) and `liftoff` (a toy tug over a grey-box skyline).
  - Interludes: `capsule` (a flat orange disc on a flat sky), `tanks` (an untextured grey tank), and `greenhouse` and `reactor` (CG rooms inside the same shelter the photographs show — the problem R13 fixed for one shot).
  - Stay ending: `fleet` (Earth's spaceport as grey boxes).
- **This undercuts the escape ending.** Its reveal is "the prologue's Earth, city and street as grey placeholders". `stranded` already looks like that in minute one, so the contrast the ending depends on is spent.
- **Fix (R-entry): adopt one rule.** Earth's surface and the shelter are photographed; orbit, other planets, ships and the unmaking are rendered.
  - Make `stranded`, `capsule`, `tanks`, `greenhouse` and `reactor` plates. For `stranded`, the "eyes dim" beat becomes a plate dim.
  - Give `lib/plate.py` a mode that composites the CG tug over a photograph, for `liftoff` and `fleet`.
  - Each plate shot costs ~0.1–0.3 MB; `films/` uses 8.48 of 12 MB.
- **Phone legibility:**
  - In `earth_c1`–`earth_c3` the payoff (Earth lighting up) is a tiny cluster at the bottom edge of a black disc.
  - The prologue crops card No. 62 at the top edge.
  - `hive_dark` ends with ~2 s of pure black.
- **Two related risks:**
  - **Identity.** Card No. 62 — "you" — is a specific photographed bearded man, and both ending films reuse that face. Creation offers a name and six helmets. §8, S-08.
  - **Likeness.** The AI-generated face on card 62 (`plates/selection/01.webp`) may resemble a well-known video-game protagonist. Worth a deliberate check before release, since it becomes the player's face in both endings.

### 6.5 Menus and the hub: show the progress bar

The films' best idea — Earth's night side relit one patch per chapter — never appears outside the films.

- Put Earth behind the main menu and the station, lit to the save's progress.
- The interlude posters (`earth_c1…c4`) and the ending's `earth_full` already exist.

That turns two dead backdrops into the campaign's progress bar, and gives the hub a place. It's a small spec.

- **Main menu:** its overlay (`style.css:594`, 55 % at the centre to 90 % at the edges) leaves the salvager and tug only 20–30 % visible, so the first screen reads as a dark web form. Lighten it on the menu only, and keep it heavy for the text-heavy station tabs.
- **Star map:** its planets use an old procedural texture (`StarmapScene.ts:142`) and read as murky smudges, while the detailed flight maps already exist. Use those, equator to camera.

### 6.6 The committed art, asset by asset

- **Quality bar.** The baked ship models (R8: tug, fighter, interceptor, probe, cockpit) and the flight skies are the quality bar. Flight is the part of the game that looks finished.
- **Ground textures:**
  - They tile with no seams. Desert and volcanic read instantly.
  - But 8 of 13 layers share one "crazy paving" cell pattern (`ground.py`): the jungle floor reads as a stained-glass patio, the chitin rings as agate, the grass bumps as cobbles.
  - Distinctive spots repeat every tile.
  - Thessaly and Eden read as the same green field.
  - Fix: leaf litter for the jungle floor; Thessaly darker teal-olive under canopy shadow, Eden a yellow-green meadow; break tile repetition.
- **Portraits are twelve recolours of one helmeted bust** (four helmet shapes × three colours, `lib/salvager.py:133-145`).
  - No face, so no range of gender, age or ethnicity.
  - The suit colour is baked in and ignores the player's pick.
  - The six Selection faces in the films are three men and three women, all adults, and all appear white.
  - Cheap fix: tighter crop, distinct helmet silhouettes, a hint of a face behind the visor, tinted by the chosen colours.
  - Bigger fix (R-entry): a broader photographic cast; see S-08.
- **Three icon styles are mixed:**
  - colour emoji for resources and the star-map lock (`ui/glyphs.ts`, `StarmapScene.ts:313`), which differ across Apple, Google and Microsoft;
  - monochrome symbols for items (some — `⚟ ⛨ ⌬` — may be blank boxes on older Android fonts);
  - renders for portraits.
  - Render resource, token and lock icons with the item generator and use them everywhere.
- **Props** look like pastel toys next to the weathered ships. The jungle "trees" are cyan mushrooms, and the a/b variants barely differ.
- **P3:**
  - 8 px WebP blocks in soil, moss, flesh and snow (quality 84 → 92–95, +0.2 MB).
  - The unused `rock` layer ships 123 KB.
  - A hot band at Ferrum's north pole and a dark cap on Cinder-4 in the flight planet maps.
  - The three.js lens flare throws a WebGL error every frame on the `high` preset (`FlightView.ts:570`).
  - `wall_same` is described as a "grey face" but shows a sepia photo.
  - `check.mjs` fails locally only because of three git-ignored `.DS_Store` files.
  - The spec-018 and spec-019 screenshots still show the debug overlay.
- **Budgets** are all inside:

  | Category | Used | Budget |
  |---|---|---|
  | Models | 2.59 MB | 4 MB |
  | Textures | 4.36 MB | 6 MB |
  | Films | 8.48 MB | 12 MB |
  | Audio | 4.50 MB | 12 MB |
  | Portraits | 0.07 MB | 0.5 MB |
  | `public/assets` total | 20.05 MB | 25 MB |

### 6.7 Audio (P1 for feel, and a verification debt)

- **The guns are silent.** `GameEvents` has no `weapon:fired` or `enemy:hit`, and `core/AudioReactions.ts` maps no sound to firing, in flight or on the surface.
  - Only deaths, damage taken, UI and a few beats make noise.
  - Explosions borrow `elite_death`; arming a mine borrows `scan_done`.
  - `engine_hum`, `storm_loop` and `laser_charge` ship in the banks (`data/assets.ts:82,93,94`) and are never played.
  - For an ARPG this is the single biggest game-feel gap after readability.
- **One loop per mood.** Six planets share one ~30 s calm loop and one ~30 s combat loop, and all bosses share one ~26 s loop. A ten-minute visit hears the calm loop about twenty times. Planets already name per-biome tracks (`ids.ts:106`), but `Audio.ts` never reads them. There is no biome ambience.
- **No `.mp3` fallback, and the WebM check looks for Vorbis.**
  - All 13 files are WebM/Opus; the manifest names an `.mp3` for each, and none exists (the audio build needs `lame`).
  - Howler picks WebM only if `canPlayType('audio/webm; codecs="vorbis"')` passes (`howler.js:287`).
  - Where it doesn't, Howler requests the missing `.mp3`, and `Audio.ts` marks the bank silent for the session with one console warning (`Audio.ts:592-603,700-704`).
  - **No phone has ever been checked:** the playtest log's hardware rows read "not run: no handset". Test sound on the reference iPhone first.
  - If it fails, either probe Opus yourself and set Howler's WebM codec flag, or ship MP3 or AAC fallbacks. An MP3 set at the build's bitrates is ~6.7 MB, which breaks the 25 MB precache unless MP3 is cached on first use or the music bitrate drops 112 → ~80 kbps.
- **Fix:**
  - `weapon:fired` (per weapon line, rate-limited) and `enemy:hit`, with shot, impact and explosion sounds synthesised in `scripts/assets/audio/sfx.mjs` (~60 KB).
  - Start the engine hum in flight and the storm loop in surface storms, as SPEC-006 §4.2 already describes.
  - Six calm and three combat variants, per biome.

---

## 7. Combat, economy and pacing

These numbers come from 60 Hz simulations of the real systems with bots. Bots use auto-fire and kite perfectly. Read absolute values as ±25 %; the pass/fail results are robust.

### 7.1 Threat

- **Trash doesn't threaten.** Non-boss enemies die in 0.2–0.9 s but need 1–3 s to close. A hunting bot took **0–4 % of max HP per minute** on every planet.
- **Enemies arrive one at a time.** Rifles (14–18 m) outrange spitters (12 m), and the spawn director places one enemy per 0.5 s tick.
- **Bosses are short and can't catch a kiter.** They die in **13–36 s**. Melee bosses move at 4 m/s against the player's 6.1 m/s and never hit a kiter; only the Queen's acid does.
- **Weather is the only real damage:** 18–32 HP/min in the open. A cave or a 30-token Field Medic L1 cancels it. Forced storms in the open are lethal instead: `c1_s2`'s heatwave deals 110 % of max HP, and `c4_m1`'s radiation 88 %.
- **Validated fix (initial tuning, SPEC-009 §4.3, keeping ×1.35 / ×1.3 per chapter):**
  - swarm HP 18 → 30, speed 6.5 → 7.5
  - rusher HP 45 → 80, speed 5 → 6
  - ranged HP 35 → 55, range 12 → 14
  - boss HP 900 → 2,250, speed 4 → 5.2, phase-2 speed ≥ ×1.25
  - swarm spawns in packs of 3–5
  - forced storms capped at 50 % of the chapter's max HP
  - Result: ambient damage 1–23 % of HP per minute, boss fights 32–54 s.

### 7.2 Economy

- **Free gear.** Bosses and elites hand out every rifle and armour tier: 500 of the 870-token gear sink plus 200 lithium. The main path ends with **~715 unspent tokens**, so R10's "specialisation is forced" isn't true in play. `RECOMMENDED_LOADOUT` (`Balance.ts:64`) "buys" gear that has already dropped, which makes the invariants conservative by ~240 tokens.
  - *Fix:* boss gear tier `ceil(ch/2)` → `floor(ch/2)`; elites drop lithium and explosives instead of gear; re-measure; only then consider `TOKENS_PER_LEVEL` 25 → 20 (R-entry).
- **Dominated and dominant items:**
  - Hand Cannon (a rifle user never fires the sidearm), Scrap Chaingun (beaten by the free Laser) and Grenade Launcher (beaten by the Rocket) are dominated.
  - The Rotary Cannon is +37 % over the Lithium Edge.
  - Explosives are pointless against trash but brutal against bosses: 6 mines + 3 charges take 59 % of the Queen.
  - *Fixes, initial tuning:* Rocket 70 → 120; Grenade Launcher 45 → 60 damage, 90 → 60 price; Chaingun heat 0.04 → 0.03 and damage 10 → 12; Hand Cannon 50 → 30; carry the fire-rate remainder (B-23).
- **Classes:**
  - The Marine has +48 % DPS×HP over the others.
  - The Engineer's "+25 % companion effect" multiplies only the combat drone's damage (`Combat.ts:1014`).
  - Agility and tech are trap attributes.
  - *Fix:* Marine ×1.15 → ×1.10; the Engineer multiplier applies to every companion effect; agility +2 % crit per point; tech +10 % companion effect per point.
- **Resources:**
  - Wheat is meaningless: a 250–600 surplus.
  - Kill XP is flat across chapters, so the earliest planets are the best farms.
  - The Quartermaster's discount is near-worthless.
  - Hull and shield tiers past the Ferrum gate have no measurable effect.

### 7.3 Pacing

- **Length.** Main path ≈ **1.5 h** (completionist ≈ 2 h) against PLAN's 2–3 h.
- **Repetition.**
  - 13 of 26 missions are "survive N s" or "collect N".
  - Timers are 18–24 % of mission time, and every survive stage plays as "walk to a cave and wait", because survive stages run no waves (B-21).
  - Three templates repeat almost verbatim: survive → reach, collect + kill, kill → survive.
- **Objective mix:** kill 12, scan 10, survive 9, collect 7, boss 6, reach 5, deliver 4, escort 2, defend 2, choice 2.
- **Fix, no new missions needed.** Survive stages run the planet's ambient waves; wave enemies engage (B-05); bosses gain the phase-2 speed-up. Estimated +15–25 min, landing the main path near 1.8 h.
- **Adding variety, needs an R-entry.** A "hold the line", a "carry" (slowed while holding), or a "wurm hunts by vibration" stage (§8, S-05) would add verbs without new content systems.

### 7.4 Flight

- Survival is easy. The stock ship is only dangerous on the Ferrum run, which justifies the shield-2 gate.
- `c4_s2` needs a pilot who leads targets: a no-lead pilot (ARIA's auto-aim style) got 0/6. *Fix:* ARIA L2+ aim assist leads by target velocity × shot travel time.
- The Gauntlet: B-02.

---

## 8. Story and narrative delivery

### 8.1 Protect

- The ladder, ARIA, the irony left unstated (R9), the Earth-lights progress bar, and the stay ending's return to frame one (§2).
- The text has no typos and no compass bearings, and never genders the player.

### 8.2 Findings

| ID | Sev | Finding | Fix |
|---|---|---|---|
| S-01 | P1 | **The meta layer never listens.** `iteration_log`, `scaffold_secret`, `signal_decoded` (and `c1_oil`) are set and never read (`missions.ts:132,239,314,377`); `ids.ts:50` mentions "dialogue conditions" that don't exist. The Warden's "Subject exhibits off-task behaviour" (`c4_m3_signal`) fires on the main path, where the player has done exactly as told. For a story about going off-task, off-task should be a verb. | A `when: FlagId` on dialogue lines (R-entry, SPEC-009). The Warden lists what the player actually did ("Accessed a prior instance's log. Queried scaffold telemetry."). ARIA's confession names what she covered up ("You read your own log on Vetra, and I told you it was a common hand."). The stay report counts `ANOMALIES LOGGED n/3` |
| S-02 | P1 | The climax misfires (B-04), and the finale has no fight (B-05) | See those |
| S-03 | P2 | **The best beats are optional and completion-gated.** The echo (`c1_s2`), your own log (`c2_s1`) and the scaffold stream (`c3_s1`) are side missions paying 5–12 tokens; two fire only on completion. A main-path player reaches "Sixty-one times…" having seen only the scav's first line and a card number. | Keep them optional, but give the main path one short echo per chapter (a line in `c2_m1_done` about the camp, a scan hit on a tower in `c3_m1`). Make the side missions visibly *different* on the board (an anomaly icon) |
| S-04 | P2 | **The echo is pre-empted.** The first scav already says "I have said that before. To someone. I cannot remember who." (`dialogue.ts:49`), so the repeat in `c1_s2` has no surprise left | Delete `dialogue.ts:49`; PLAN §5 wanted the first warning plain |
| S-05 | P2 | **"Walk, do not run" has no mechanic.** It's said three times (tutorial, echo, boss reveal: "I mean it this time"), but there's no walk/run distinction, and the wurm reacts to nothing | Tie it to the wurm's existing `burrow_telegraph`: the burrow targets the player's position only while they moved faster than X m/s in the last second (or fired). Walking or standing makes it surface elsewhere. The signature line becomes the boss's pattern |
| S-06 | P2 | **The scavengers are voices from nowhere.** `scav` is only a speaker id (`ids.ts:77`); "He is dehydrated" points at empty sand. The raiders — "instances that drifted off-task, which is why they know things" (PLAN §5) — never speak | A slumped scav prop at the pad (the character model, scav tint, a death pose) and a second one for `c1_s2`. Raider barks keyed by chapter ("Don't file it." "Sixty-what are you on?") |
| S-07 | P2 | **Continuity errors:** the log "from an earlier expedition" is signed **Iteration 62**, the Warden says **sixty-one** times, and the escape film says "62 instances"; Vetra's main path mentions "the last expedition", which contradicts "you were the first to fly" and pre-spends chapter 2's reveal; Eden's final wave is all Hive right after the film "The Hive has gone quiet"; `c2_s1_log` says "Deliver the water" after the delivery; the Queen line "she is using the Hive to say it" contradicts the brief ("she is not the one saying it") | Decide the numbering (§11 Q2); make the ridge camp a pre-war survey camp; add an ARIA line at the Eden defence ("The Queen is dead and they are still coming. They were never hers."); move the log to `onStage[1]` and add `c2_s1_done`; reword the Queen line |
| S-08 | P2 | **The films fix the player's face.** Card 62 is one specific photographed face; both endings reuse it; creation offers a name and helmets. A player who builds someone else is told twice that they were that person | §11 Q1: either the salvager has a canonical face (creation becomes callsign, class, suit), or card 62 becomes a visored ID photo matching the creation portraits (films re-rendered) |
| S-09 | P2 | **Eden doesn't look like a trap.** "Eden is everything the brief promised, which is what worries me" has nothing on screen to worry about; `c6_m1` is three scans | Make Eden subtly *too* perfect: identical trees in rows, a flower repeating on a grid, the ridge ending in a clean seam, a patch of untextured ground at `eden_ridge`. The scans become the reveal |
| S-10 | P2 | **The endings' edges:** `instance/62 disconnected` shows at the end of the dialogue **and** as the final overlay, which blunts it; "Stand by for recall" is followed by no recall; after the escape, Continue says nothing (B-27); ARIA's cover stories ("Coincidence…", "a common hand") can play *after* her chapter-5 confession, from side missions still open | Cut the dialogue's last line; "Stand by."; mark the slot; gate cover stories on `!chapter5_done` or write post-confession variants |
| S-11 | P3 | **Text polish:** British and US spelling mixed (armour/armor, colonise, metres vs "Licenses", "toward"); curly and straight apostrophes mixed; "Backup your save" (verb: *back up*); "worms" vs "wurm"; "utility" vs "GADGET" for one slot; two missing question marks; the Cinder-4 "Survey Beacon" shares a name with Eden's climactic one; a hint says skitters swarm "near the pad" while spawns keep ≥ 20 m from it | One sweep. The prose is British, so go British in the UI too |

---

## 9. Easy wins

Each is half a day or less, needs no PLAN entry unless marked, and has a visible payoff.

| # | Change | Where | Fixes | Cost |
|---|---|---|---|---|
| 1 | Surface `bloomThreshold: 1.5`; Hive cracks emissive 2.5 | `views/SurfaceView.ts:499-504`, `data/planets.ts` | Vetra whiteout, the milky veil (tested A/B) | 2 lines |
| 2 | Push the player out of obstacles in `#movePlayer`; test knockback and push-out against `hitsCircle` | `Surface.ts:1440`, `Combat.ts:1112,1133` | B-01 softlock | ~15 lines |
| 3 | Shot sweep with relative motion | `Flight.ts:636` | B-15, half of B-02 | 1 condition |
| 4 | Hold the simulation while a modal dialogue or choice is up | `Surface.ts:1021-1046` | B-03 | a few lines |
| 5 | Fold the Warden's three lines into the head of `c5_m3_aria` (with `glitch`) and drop `onStage: {0: 'c5_m3_warden'}` — needs #4 | `missions.ts:455`, `dialogue.ts` | B-04: the climax plays at the Queen's death, in both accept paths | data only |
| 6 | Delete the scav's pre-echo line | `dialogue.ts:49` | S-04 | 1 line |
| 7 | Rename the duplicated `.hud-static` and `.hud-storm` rules | `style.css:1360-1395` vs `2933-2952` | B-12: static burst, storm vignette, ion-storm warning | CSS |
| 8 | One `maxHp` | `Save.ts:400`, `Combat.ts:136`, `UiHelpers.ts:442` | B-10 | small |
| 9 | Throttle-down off Ctrl (e.g. `KeyX`), and update the controls sheet | `KeyboardMouseDriver.ts:48` | B-11 | 1 line + text |
| 10 | Keep the departure film's black frame until flight's `scene:entered` | `StarmapScene.ts:489-492` | B-14 | small |
| 11 | Flight HUD: a hull icon instead of `♥`; hide the salvager's HP in flight; two flight tips | `ui/Hud.ts:55,58`, `data/hints.ts` | §5.1 | small |
| 12 | Chapter 1–2 enemy tints and emissive to ≥ 3:1 against the ground | `data/enemies.ts` `look` | §5.1 | data only |
| 13 | Items camera per kind, then one Blender run | `scripts/assets/blender/items.py:254` | 26 item pictures (§6.3) | 2 lines + a build |
| 14 | Quick-bar slots 48×64 (56×72 touch); assert the name is visible | `style.css:988`, `ui/QuickBar.ts:89`, `e2e/SPEC-031.spec.ts:351` | names mid-fight | a few lines |
| 15 | `.gear-card-sheet { flex: none; }` | `style.css` near 4090 | full-width gear card | 1 line |
| 16 | Play the shipped `engine_hum` in flight and `storm_loop` in storms | flight and surface scenes | part of §6.7 | ~10 lines |
| 17 | Station header without the duplicate "Command Relay" and "Containment level" | `StationScene.ts:303-307` | X-06 | 1 line |
| 18 | Footer without "· M0 engine" | `main.ts:33,39` | X-07 | 1 line |
| 19 | Board: brief open on available and active missions; replays sorted last | `ui/MissionBoard.ts` | X-02, X-04 | small |
| 20 | Ship shop: human stat labels | `ui/ShopPanel.ts` | X-05 | small |
| 21 | Lighter menu overlay; Hive sun 2.0 and ambient 0.55 | `style.css:594`, `data/planets.ts` | §6.5, §5.2 | 3 values |
| 22 | Star map globes wear the flight planet maps | `StarmapScene.ts:141-151` | murky planets | small |
| 23 | Park the tug on the landing pad | surface view (`ship.glb` exists) | §6.2 | small |
| 24 | `c2_s1_log` on `onStage[1]` plus a new `c2_s1_done`; cut `instance/62 disconnected` from the end of `ending_escape`; "Stand by for recall" → "Stand by." | `missions.ts:240`, `dialogue.ts:353,368` | S-07, S-10 | data only |
| 25 | Restore `CARD_NUMBERS` | `scripts/assets/blender/lib/shots_prologue.py:252` | B-25 (films can rebuild) | 1 line |
| 26 | `check` builds before the build tests | `package.json`, `tests/build/pwa.test.ts` | B-26 | 1 line |

Wins 2–5 and 8–10 are Phase 0 bug fixes; the rest can land in any order.

---

## 10. Improvement plan

**Order matters:** unblock → the first hour → threat and economy → the story listens → the world → Iteration 63.

**Process:**
- **Bug fixes** (spec non-conformance) go straight to fix PRs.
- **Design changes** open a PLAN refinement entry first, per CLAUDE.md. The next free number is **R17**.
  - Findings above marked "R-entry" are filed with the phase that carries them. R17 is written and covers Phases 0 and 1; later phases take R18 threat, R19 story, R20 world and R21 Iteration 63.
  - Merge `docs/plan-r14` and `docs/plan-r15` before writing R17, so the log stays in order (Process items, below).
- **Specs.** Phases 0 and 1 are SPEC-034 and SPEC-035 (written); later phases start at SPEC-036.

**Effort:** S ≤ ½ day · M 1–3 days · L 1–2 weeks.

### Phase 0 — Unblock (SPEC-034)

| Item | Findings | Effort | Needs |
|---|---|---|---|
| Fly the Gauntlet by hand with the recommended ship (confirm B-02) | B-02 | S | — |
| Test sound on the reference iPhone (the Opus probe itself is in SPEC-035) | §6.7 | S | hand check |
| Depenetrate the player and enemies; clamp knockback and push-out against obstacles; Recall to pad | B-01 | S | SPEC-034 |
| Flight shot sweep uses relative motion; interceptors 20 HP; `c5_m1` 6 kills; E1 covers the re-fly | B-02, B-15 | S | SPEC-034 |
| Hold the simulation during modal dialogues and choices; the Warden at the Queen's death | B-03, B-04 | S | SPEC-034 |
| Wave enemies spawn aggroed, leash at the wave centre, no far despawn | B-05, B-21 | M | SPEC-034 |
| Keep replays across reload; one cargo-cap function; rebind the import; collects count at a full hold | B-06…B-09 | M | SPEC-034 |
| One `maxHp`; rebind throttle-down; black frame until flight is ready; de-duplicate the CSS rules; lines at their moment | B-10…B-14, B-20 | S | SPEC-034 |
| Restore `CARD_NUMBERS` (B-25); order the PWA build test after the build (B-26) | B-25, B-26 | S | SPEC-034; SPEC-016 §11 |
| Turn the 8 scratch proof tests into regression tests | B-01…B-09 | S | SPEC-034 |

**Exit:**
- A person plays `c1_m1` → `c6_m2` on normal with no trap.
- The Gauntlet completes with the recommended ship by hand.
- `npm run check` builds before the build tests.

### Phase 1 — The first hour (SPEC-035)

- **Readability and onboarding:**
  - hostile accent and ≥ 3:1 value contrast for every enemy;
  - flight tips and a hull icon;
  - first-combat tip, desktop auto-fire default for chapter 1, `c1_m1` spawn buffer;
  - per-form-factor camera distance;
  - surface bloom threshold 1.5; linear fog from the player outward; Vetra grade; Hive lighting;
  - occluder fade for outcrops and landmarks;
  - Recall to pad in the pause menu;
  - weapon sound: `weapon:fired` and `enemy:hit` events with synthesised shot, impact and explosion sounds; the shipped engine hum and storm loop played.
  - **Needs R17:** camera numbers (R6-4 lock), recall and the new events. (§5.1, §5.2, §6.7, B-01)
- **Station and board polish:**
  - brief shown; ABANDON moved; sort order; Pin fixed (B-22);
  - human ship-shop labels; no duplicate header labels;
  - next-mission prompt;
  - menu build label, fixed menu height, one slot list;
  - portraits ≥ 64 px, preselected class, sticky preview (B-24).
  - (§5.3)
- **Asset drop** (hand-run, like SPEC-021): fix the item camera and render `items.py` (SPEC-031 debt, §6.3); quick-bar names visible and the gear card at its width; park the tug on the pad (§6.2).

**Exit:**
- ≥ 4 of 5 first-time testers finish `c1_m1` on normal without dying.
- Every chapter 1–2 enemy is ≥ 3:1 against its ground.
- The salvager is ≥ 8 % of frame height on desktop and ≥ 28 px at 740×360.
- The salvager is visible on Vetra on every preset.
- No item shows a glyph.
- Every shot makes a sound.

### Phase 2 — Threat and economy (R18 "threat pass", mostly initial tuning; SPEC-036)

- Enemy archetype HP, speed and range, swarm packs, boss speed and phase 2, forced-storm cap (§7.1).
- Boss and elite gear tiers; re-measure the token surplus (§7.2).
- Dominated weapons, class multipliers, fire-rate carry (§7.2, B-23).
- Population independent of preset (B-16).
- Cargo rule for collects, and the per-planet collect invariant (B-06).
- Survive stages run ambient waves; mission waves start (B-21).
- Gauntlet numbers: flight enemies unscaled, `c5_m1` 10 → 6 kills, guns 1 in the chapter-5 loadout, E1 covers an open main flight mission (B-02 b–e).
- ARIA aim assist leads (§7.4).

**Exit (the bot suite from this review, made permanent under `tests/balance/`):**
- Boss fights 30–60 s.
- Ambient damage 5–15 % of HP per minute.
- Main-path token surplus ≤ 300.
- Every weapon line has a situation it wins.
- Main path ≥ 1.8 h (bot time × 1.3).

### Phase 3 — The story listens (R19 "the Warden notices"; SPEC-037)

- `when: FlagId` on dialogue lines; the Warden's notice and ARIA's confession name what the player did; `ANOMALIES LOGGED n/3` on the stay report (S-01).
- The Warden's address at the Queen's death, in both accept paths (B-04).
- Remove the pre-echo line; one main-path echo per chapter; an anomaly icon on side missions (S-03, S-04).
- The wurm's burrow follows running and firing (S-05).
- Scav props; raider barks (S-06).
- Continuity pass and the text sweep (S-07, S-10, S-11); fix line timing and duplicates (B-20).
- Eden's "too perfect" tells, and an ARIA line for the Hive wave (S-09, S-07).
- The escape slot marked `disconnected` (B-27).
- Earth-lights backdrop on the menu and station, lighter menu overlay, star-map globes from the flight maps (§6.5).
- Films (a hand-run asset drop, like SPEC-021): Earth's surface and the shelter are photographed, and everything else is rendered.
  - `stranded`, `capsule`, `tanks`, `greenhouse` and `reactor` become plates.
  - `liftoff` and `fleet` composite the CG tug over a photograph.
  - Reframe `earth_c1`–`c3` and the Selection wall for phones.
  - Decide card 62's identity, and run the likeness check (§6.4, S-08).

**Exit:**
- A main-path player hears at least one line that exists because of something optional they did.
- The Warden speaks at the Queen's death in both accept paths.
- No ARIA cover story plays after her confession.

### Phase 4 — The world (R20 "set dressing"; SPEC-038)

- A mid-scale dressing tier per biome.
- Thessaly's jungle inside the playfield, with real trees in `props.py` in place of cyan mushrooms.
- More landmarks and bigger ones.
- Early arenas shrunk (§6.1).
- A ground-texture pass: fewer "crazy paving" layers, leaf litter for the jungle floor, Thessaly and Eden pulled apart, tile repetition broken, WebP quality raised on smooth layers (§6.6).
- Portraits with distinct silhouettes tinted by the chosen colours, and one rendered icon set for resources, tokens and locks (§6.6).
- Per-biome calm and combat music, and biome ambience (§6.7).
- Budgets re-measured under SPEC-015.

**Exit:** screenshots per biome in the playtest log in which a stranger can name the biome without the HUD.

### Phase 5 — Iteration 63 (R21; SPEC-039)

The loop story's natural second act, and the cheapest content in the plan.

- New Game+ from a stay-ending save: `meta.iteration` 63, containment ×1.15, the same content.
- **The game remembers:** 15–25 variant lines keyed on `meta.iteration > 62`:
  - the scav says "You again.";
  - ARIA drops a cover story;
  - the Warden stops pretending.
- Replace the hard-coded "62" in dialogue, the overlay and the report with `meta.iteration`. The films keep 62 and 63, which is correct for the first two runs.

### Process items (any time, S each)

- **Merge `docs/plan-r14` and `docs/plan-r15` into `main`.**
  - PLAN on `main` (the source of truth) has no R14, although SPEC-031 and SPEC-032 are built.
  - R15 still plans Vercel while `pages.yml` deploys to GitHub Pages. Settle one host, and record it.
- **Set `status: done`** for SPEC-015 and SPEC-022…032 in their frontmatter and in SPEC-000.
- **Add a "no dev shortcut" playthrough to the release checklist.** Both P0s were hidden by test shortcuts: the campaign harness auto-completes kill objectives, and the dev skip completes flight missions. The rescoped SPEC-016 plays the campaign through the real runtime but still emits the flight kills. SPEC-034 adds the test that flies the Gauntlet with a scripted pilot and asserts `c5_m1` completes.
- **Pay the hardware debt.** The playtest log's physical-phone rows read "not run: no handset", yet every milestone's definition of done (SPEC-001 §11) includes one phone. Before calling `m7` done, run one real iPhone and one mid-range Android through boot, sound, one flight and one surface mission, and log the results.
- **Consider splitting `scenes/Surface.ts` (3,865 lines).** Six of this review's bugs live in its dialogue, modal, defend and landing wiring.

---

## 11. Decisions only you can make

1. **Card 62's face.** Does the salvager have a canonical face (drop portraits; creation is callsign, class and suit), or does the player's choice reach the films (visored ID photos, re-render)? Either is fine; the current mix contradicts itself.
2. **The iteration number.** Is the Vetra log signed 61 (the arithmetic clicks with the Warden's "sixty-one times") or 62 (the Warden explains "I put it there")?
3. **After the escape:** menu, as R9-6 says, or free roam, as PLAN §6 says? Whatever the answer, Continue must acknowledge it.
4. **Desktop auto-fire:** on by default, or teach hold-to-fire? This decides whether chapter-1 threat is tuned for twin-stick or for click-to-attack.
5. **Arena size:** shrink the early arenas, or densify them?
6. **The Gauntlet:** which of fewer kills, weaker interceptors, or better starting guns? Simulations support any two.
7. **The photographic plates:** keep the Gemini photographs (after the likeness check), or render every shot? This decides whether `stranded` becomes a plate.

---

## Appendix A — Evidence and how to re-run it

The scratch work lives in this session's scratchpad (`…/scratchpad/`), not in the repo:
- `bughunt/`: 8 proof tests (10 cases, all passing), run with `npx vitest run --config <scratchpad>/bughunt/vitest.scratch.config.mjs` from the repo root.
- `balance/`: the simulations (`*.sim.ts`) and output tables (`out/*.md`), run with `npx vitest run --config <scratchpad>/balance/vitest.config.mjs <name>.sim`.
- `contrast/contrast.mjs`: the enemy-versus-ground contrast table.
- `art/`: contact sheets of every committed image, sampled film frames, live captures on a GPU at each preset, and the bloom A/B (`bloom_ab.png`). The capture scripts drive a browser only and never write to the repo.

Phase 0 moves the proof tests into `tests/`, and Phase 2 moves the balance bots into `tests/balance/`.

## Appendix B — Numbers used above

- **Camera:** FOV 40°, pitch 55°, distance 28 m (`Surface.ts:127-130`); `PLAYER_SPEED` 6 m/s (`tuning.ts:47`).
- **Arena `halfSize`:** Cinder-4 180, Vetra 180, Thessaly 200, Ferrum 200, Hive 160, Eden 180.
- **Fog density (exp²):** Cinder-4 0.014, Vetra 0.020, Thessaly 0.024, Ferrum 0.026, Hive 0.032, Eden 0.010.
- **`maxEnemies` by preset:** 12 / 20 / 32.
- **Ship guns (damage × rate):** tier 0 10×4, tier 1 13×4, tier 2 17×5, tier 3 22×5.
- **Unit tests on this checkout:** 1,394 passed, 5 failed (all `tests/build/pwa.test.ts` against a stale `dist/` from 2026-09-20; B-26).
