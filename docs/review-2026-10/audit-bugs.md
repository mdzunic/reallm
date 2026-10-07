# Fourth review: bugs and correctness (B-)

**Code base:** `reallm-game` `main` at `dfe6f04` (2026-10-07). Nothing in either repository was changed.

**Scope:** the code that landed fastest since 2026-10-01 (SPEC-054 to 059, 063 to 065, and the cargo-full, shaft-mouth, wreck-gap and mender fixes), then the risky seams: scene transitions, save, missions and economy, the surface/underground swap, combat pools and input.

**Method:**
- Every finding was traced through the code.
- 25 of the findings are backed by throwaway vitest files, written only in the scratchpad. 20 of those tests fail on `main` and prove a bug. The others pass and confirm that an area is sound (the 120k-cave sweep, for example).
- Some tests are *models*: they rebuild the scene's own wiring or event order from stand-ins, because the scene itself needs a browser. Those are marked "model test". Everything else uses the real classes.

**The proofs.** The throwaway tests lived in four folders in the review session's temporary scratchpad (`t-missions`, `t-save`, `t-scenes`, `t-under`), each with its own Vitest config pointing at this repository. They are not committed: they import the repo by absolute path and some are models of scene wiring. Each finding below quotes the failing assertion (`expected … to be …`), which is the shape the regression test should take when the bug is fixed.

## 0. Suite status

| Check | Result |
|---|---|
| `npm run typecheck` | **green**: both tsconfigs, zero diagnostics |
| `npx vitest run` | **green**: 132 files; 3,350 passed, 6 skipped, 0 failed (32 s) |

**The 6 skips** are the emitted-build describe in `tests/build/pwa.test.ts:127`. It skips itself because `dist/` is older than this commit (`describe.skipIf(!built)`). That is the stale-`dist/` case. I did not chase it, and I did not run a build.

**Why a green suite still misses B-01.** The unit helper wires the economy one way, and the scene wires it another way. There is more on this in B-01.

## 1. Summary

| ID | Sev | What breaks for the player | Status | Effort |
|---|---|---|---|---|
| B-01 | **P1** | A resource node stops at a full hold even while a collect objective still needs that resource. SPEC-034's E56 fix never reached the scene. | CONFIRMED | S |
| B-02 | P2 | Underground, auto-fire shoots at enemies behind rock, and enemies in the next room aggro through walls and pile up against them | CONFIRMED | S |
| B-03 | P2 | Flight throttle: one tap moves two notches on a 30 Hz frame (phones in low-power mode) | CONFIRMED | S |
| B-04 | P2 | A second tab overwrites the newer save, and the refusal then blocks autosave on every slot | CONFIRMED | S–M |
| B-05 | P2 | "Save failed — export your save code" exports the old, or truncated, save instead of the live run | CONFIRMED | S |
| B-06 | P2 | Quitting during the ending's decision line plays the 36 s ending film over the main menu | CONFIRMED (model test) | S |
| B-07 | P2 | The station fuel subsidy re-grants on every return from the star map: free oil for crafting and upgrades | CONFIRMED | S–M |
| B-08 | P3 | The defend clock keeps running while the player is dead | CONFIRMED | S |
| B-09 | P3 | A survive stage runs without its storm whenever any other mission sits in a boss stage | CONFIRMED (read) | S |
| B-10 | P3 | The pad terminal ships away the cargo a later deliver stage needs (all three deliveries in the game) | CONFIRMED | S |
| B-11 | P3 | "Surplus shipped to Command Relay" never arrives in the new Relay depot | CONFIRMED | S |
| B-12 | P3 | The star map's fuel text counts the hold only, not the depot | CONFIRMED (read) | S |
| B-13 | P3 | Pause → Settings → Reset save leaves the player running a deleted run | CONFIRMED (read) | S |
| B-14 | P3 | A key released while a form control has focus stays held after Resume | CONFIRMED | S |
| B-15 | P3 | P resumes play under an open confirm sheet, and the sheet rides into the next scene | CONFIRMED (read) | S |
| B-16 | P3 | Next-instance refusal never reaches the menu; Confirm then overwrites the slot without asking | CONFIRMED (model test) | S |
| B-17 | P3 | A predecessor's body on the descent hides "Descend" over about half its circle | CONFIRMED | S |
| B-18 | P3 | The `elite_surge` contract reaches cave packs, which SPEC-054 §4.11 says it must not | CONFIRMED (read) | S |
| B-19 | P3 | Quota retry deletes `:bak` before the main write is verified, so both copies can be lost | CONFIRMED | S |
| B-20 | P3 | Gaps in memory-only mode (E8): New Game overwrites silently, Import is silent, next instance always refused | CONFIRMED | S |
| B-21 | P3 | Remains with a full hold are silent; no "hold full" line at all | CONFIRMED (read) | S |
| B-22 | P3 | Scorch decals and bursts carry across the level swap and draw on the other level's floor | CONFIRMED (read) | S |
| B-23 | P3 perf | The `high` flashlight renders its shadow map every frame, even on the surface | CONFIRMED (read) | S |
| B-24 | P3 perf | The mission and guidance path allocates every fixed step, against the SPEC-001 §7 hot-path rule | CONFIRMED (read) | M |

Section 3 lists the plausible and unverified items. Section 5 lists what was checked and found sound.

## 2. Findings

### B-01: A resource node stops at a full hold even while a collect objective still needs that resource (P1, missions/economy, CONFIRMED)

**Evidence:**
- `src/scenes/Surface.ts:1407-1410` builds the nodes as `new Nodes(layout.nodes, regenOf, { addResource, room })`, with no `collectDemand`.
- `src/systems/Pickups.ts:251-257` therefore reads the demand as `(undefined ?? 0) - pending`. The node's headroom is then just `room`, which is 0 on a full hold, so the node takes nothing.
- The unit-test helper `tests/systems/pickups.test.ts:300-307` *does* pass `collectDemand`, with the comment "the scene passes the active `Missions`' demand through". The scene never did. `git log -S collectDemand -- src/scenes/Surface.ts` finds no such wiring.
- Proof: `t-missions/nodes-and-depot.test.ts`, "E56 / SPEC-034 §4.12", fails with `expected 0 to be greater than 0` (model test of the scene's own wiring).

**Scenario.** This is the review's own SPEC-016 case.
- On Thessaly, `c3_m1` collects 250 wheat. `c3_s2` (`src/data/missions.ts:386-387`) then wants 300 more.
- With the base 400 hold, the player arrives at `c3_s2` with the hold at the cap.
- Standing on a wheat node moves 0 units. The counter stays put, and there is no toast. Orbs still ship home, but they are rare.
- `c1_m2` (150 oil) behaves the same way for a player who arrives with 400 oil.

**Earlier decision that did not land.** `docs/BUGS.md` §6 marks this FIXED and says "a node keeps pumping while the demand lasts". SPEC-034 §4.12's acceptance line says the same. The economy half landed; the scene half did not.
- The campaign sim missed it because it calls `addResource` directly and never goes through `Nodes`.
- The new pad terminal (SPEC-065) is a manual way out, but only for a player who thinks of shipping cargo home.

**Why it matters.** A main-path collect objective stalls with no explanation. This is the exact soft-stall the R17 review paid to remove.

**Fix:**
- Add `collectDemand: (r) => economy.collectDemand(r)` to the deps at `Surface.ts:1407`.
- Export one factory that both the scene and `pickups.test.ts` use, so they cannot drift apart again.
- Add an e2e or scene-level case: a full hold, an active collect, standing on a node, and the counter moves.

**Effort:** S.

### B-02: Underground, auto-fire and enemy aggro ignore cave walls (P2, combat, CONFIRMED)

**Evidence:**
- `src/systems/Combat.ts:1943-1973`: `#autoTarget` ends `return bestClear ?? best`. When every candidate is behind rock, it takes the nearest blocked one.
- Firing snaps `p.facing` to the aim (`Combat.ts:1841`), which also turns the flashlight beam toward the wall.
- `src/systems/Light.ts:41,55`: `inLightCone` and `lit` never check line of sight.
- `src/systems/EnemyAi.ts:378-396`: acquisition checks the line only for a *hidden* player.
- Proof: `t-under/autofire.test.ts`, which uses the real `Combat` and `EnemyAi` with a wall at x = 4:
  - Light off, enemy 7.5 m away in the next room: expected `{fired:0, facing:π}`, got `{fired:1, facing:0}`.
  - Light on, lit enemy 15 m through the wall: one `weapon:fired`.
  - A placed `dust_skitter` 9 m behind rock has `aggro: true` after 6 s and is still on the far side.

**Scenario.** Both defaults make this the normal case: the light is on (`Surface.ts:795`) and auto-fire is on (`Settings.ts:386`).
- In a cave, the salvager turns away from the room they are in and empties the magazine into rock.
- A pack in the next room runs at the wall and stays pinned against it inside its 24 m leash.

**Why it matters.** The caves are new content, and this makes their combat look broken. Shooting walls and pinned packs read as AI bugs.

**Fix:**
- While `world.sight` is set (that is, below), return `bestClear` only.
- Make placed enemies acquire only with `obstacles.lineClear`, the same rule hidden players already get.
- Later, optionally, chase over `#caveGrid`.

**Effort:** S for the two line-of-sight gates; M for cave pathing.

### B-03: Flight throttle moves two notches per tap on two-step frames (P2, input, CONFIRMED)

**Evidence:**
- `src/scenes/Flight.ts:890-891` reads `buttons.throttleUp/Down.justPressed` on every fixed step.
- That latch is per *frame*, with 0–5 steps inside it. `src/core/PressEdges.ts:1-18` describes exactly this hazard, and the surface goes through `PressEdges`. Flight does not use it (`grep PressEdges src/scenes/Flight.ts` finds nothing).
- Proof: `t-scenes/throttle.test.ts`, with a real `Loop`, `Input` and `systems/Flight` on a 33 ms frame: expected throttle 1, got 1.2.

**Scenario.** Whenever rAF runs at 30 Hz (iOS Low Power Mode, a hitching phone), one tap on + from 0.8 lands on 1.2. With `THROTTLES = [0.8, 1, 1.2]` (`src/systems/Flight.ts:186`), the middle notch cannot be reached with taps.
- That works against the "throttle down" hint for survive objectives (13-b).
- The touch pause read at `Flight.ts:823` has the same shape, but pausing twice is harmless.

**Fix:** give `FlightScene` a `PressEdges`:
- call `beginStep(state.buttons, loop.stats.frame)` at the top of `onUpdate`;
- read `pressed('throttleUp' | 'throttleDown' | 'pause')`;
- add a two-step-frame unit case.

**Effort:** S.

### B-04: The two-tab guard protects the wrong tab, then blocks every slot (P2, save, CONFIRMED)

**Evidence:**
- `src/core/Save.ts:2326-2330`: only `request()` checks `#foreignWrite`. `flush()` (`:2369-2371`) writes anyway.
- Callers that flush unconditionally:
  - `Surface.exit()` (`src/scenes/Surface.ts:1977-1979`, every surface exit)
  - Save & Quit (`src/ui/PauseMenu.ts:362-366`)
  - the station's quit and next-instance paths (`src/scenes/StationScene.ts:751-754`, `:772-776`)
- The flag is set at `Save.ts:2613-2627` and never reset (`bind()` does not touch it).
- `refusingAutosaves` (`:2630`) says "the menu offers a reload", but nothing in `src/` reads it.
- Proof: `t-save/crosstab.test.ts`:
  - flush overwrote the newer save: `expected 'Tab' to be 'OtherTab'`;
  - slot 1 never autosaves after a foreign write to slot 0: `expected 0 to be 123`.

**Scenario.**
- **Phone:** the PWA and a browser tab are both open. Tab B plays and writes slot 0. Tab A shows "Save changed in another tab" and stops autosaving. Tab A then leaves the surface or presses Save & Quit, and its stale run overwrites B's newer one. B's guard now trips too, so the stale copy wins.
- **Fresh slot:** after one such toast, a new game in slot 1 in tab A never autosaves, not even on `pagehide`.
- This breaks the spec's own edge cases 47-i and 58-l. Under 58-l, a stale tab can overwrite a just-begun next instance with the finished run.

**Fix:**
- `flush()` honours the guard (return false and log). Only `create()` and `beginNextIteration` may write through it.
- Scope the refusal to the slot the other tab wrote.
- Show a reload banner on the menu when `refusingAutosaves` is true.

**Effort:** S–M.

### B-05: The "export your save code" advice exports the wrong save (P2, save, CONFIRMED)

**Evidence:**
- `src/core/Save.ts:2520-2529`: `exportCode` takes `stored ?? current`, so whatever is on disk wins over the live run.
- The toast text is `Save.ts:105`, `SAVE_FAILED_TEXT = 'Save failed — export your save code'`.
- The in-game Backup export uses the bound slot (`src/ui/SettingsPanel.ts:578-583, 604, 627`).
- Proof: `t-save/export.test.ts`:
  - after a silent truncation, the code decodes to `NOT JSON`;
  - after a quota failure, the code has 0 tokens where the live run has 500.

**Scenario.** On Safari a write is silently truncated, or it fails on quota. The game tells the player to export. The code they copy holds the broken or previous save, so the progress the advice was meant to rescue is lost. A mid-surface export from the pause menu also misses everything since the last checkpoint.

**Fix:**
- When the slot being exported is the bound one, serialise the bound save.
- Keep the raw stored JSON only for unbound or corrupt slots. That is the original E8 intent.

**Effort:** S.

### B-06: Quitting during the ending line plays the ending film over the menu (P2, scene transitions, CONFIRMED by model test)

**Evidence:**
- `src/scenes/Surface.ts:3972-3977` (`#runEnding`): after `await dialogue.play('ending_…')`, the only guard is `#alive`. That flag goes false only in the Disposer (`:1280-1282`), which runs *after* the 300 ms fade-out.
- `src/ui/DialogueUI.ts:285-288` resolves the line on `scene:transition`.
- The Director's own skip-on-transition (`src/scenes/Director.ts:76-79`) has already fired by then, so the new film is not skipped.
- Proof: `t-scenes/endingQuit.test.ts` (real `SceneManager` and `EventBus`, stand-ins copying the three handlers): `filmStartedDuring` is `'transition'`.

**Scenario.**
1. During the modal `ending_escape` or `ending_stay` line, the player pauses (P, a blur, or the system Back) and picks Save & Quit.
2. The 36 s ending film starts over the main menu.
3. When it ends, `musicAfter` replaces the menu bed: `surface_calm` for stay, silence for escape.
4. `endingSeen` stays false, so the station plays the ending again later.

**Why it matters.** It is the campaign's last scene, and it plays over the wrong screen.

**Fix:**
- In the surface, set a `#leaving` flag on `scene:transition` (the station already does this with `#present`) and check it after every await in `#runEnding`.
- Belt and braces: `Director.playFilm` resolves `'skipped'` while `services.scenes.transitioning`.

**Effort:** S.

### B-07: The station fuel subsidy can be farmed (P2, economy, CONFIRMED)

**Evidence:**
- `src/scenes/StationScene.ts:131` runs `#enterEffects` on every `onEnter`, which calls `applyStationSubsidy` (`:288-295`; `src/systems/Economy.ts:861-880`).
- The star map's Back (`src/scenes/StarmapScene.ts:663`) re-enters the station.
- Oil has sinks the subsidy never meant to fund:
  - crafting (`src/data/recipes.ts:31-35`, a landmine is 20 oil);
  - engine tier 3 (60 oil, `src/data/upgrades.ts:36`).
- `Economy.ts:871-875` raises the floor to a main flight mission's planet: up to 120 oil while `c5_m1`, or a replay of it, is accepted.
- Proof: `t-missions/economy-holes.test.ts`: 10 cycles produce 20 landmines (`expected 20 to be +0`).

**Scenario.** With 0 oil, the player crafts 2 landmines, opens the star map, presses Back, and gets 40 more oil. Repeat. There is no token exploit, because resources are never sold. But explosives become free, and the fuel floor pays for upgrades.

**Fix (pick one):**
- grant the subsidy only on a real arrival (`arrivedFrom`, `recalled`, Continue or Load), not on the return from the star map;
- make it a fuel-only credit that `canDepart` and `payFuel` count, as E119 already treats the depot.

Optionally, leave replays out of the E58 floor.

**Effort:** S–M. This needs a PLAN note, because E1 is "unlimited on purpose".

### B-08: The defend clock runs while the player is dead (P3, missions, CONFIRMED)

**Evidence:**
- `src/systems/Missions.ts:619-628`: `defend` has no `ctx.player.alive` check, unlike `survive` at `:612`.
- `#respawn` → `#syncDefend` (`src/scenes/Surface.ts:4377`) refills the beacon and restarts the wave, but not the timer.
- Proof: `t-missions/economy-holes.test.ts`: `expected 2.4999… to be +0`.

**Scenario.** In `c6_m2`, a death resets the clock. It then climbs 2.5 s under the death overlay, and the beacon can take hits there too, which can trigger a second reset.

**Fix:** skip `defend` while `!ctx.player.alive`, or zero its timer in `#respawn`.

**Effort:** S.

### B-09: A survive stage runs without its storm while another mission is in a boss stage (P3, missions/weather, CONFIRMED by reading)

**Evidence:**
- `src/scenes/Surface.ts:3443-3452` forces the required storm only while `missions.bossStage() === null`. That is true of *any* active mission, not only the arena the player is in.
- `Missions.ts:607-617` ticks the survive timer regardless of the weather.

**Scenario.** `c1_s2` (survive 90 s in a heatwave) and `c1_m3` (boss stage) are both active. The heatwave is never forced, `c1_s2` completes in calm weather, and its `no_shelter` bonus becomes free. The same pairing happens with `c2_s2` + `c2_m3` and with `c4_s1` + `c4_m3`.

**Fix:**
- Gate on the arena actually being engaged (`#bossId`, or a sealed arena), not on any boss stage.
- Or hold the survive timer while its storm is suppressed (E15).

**Effort:** S.

### B-10: The pad terminal ships away the cargo a later deliver stage needs (P3, economy/SPEC-065, CONFIRMED)

**Evidence:**
- `src/systems/Missions.ts:289-302`: `deliverDemand` reads the *current* stage only. It is used at `src/scenes/Surface.ts:5880` and `:5950`.
- Every deliver objective in the game is a stage 2, after a boss or a scan:
  - `c1_m3` (100 oil), `src/data/missions.ts:179`
  - `c2_s1` (40 water), `:281-284`
  - `c4_m3` (100 lithium), `:443-446`
- The repo's own test pins the gap: `tests/systems/missions.test.ts:814-820` expects 0 at `c1_m3` stage 0.
- Proof: `t-missions/nodes-and-depot.test.ts`: `expected 0 to be >= 100`.

**Scenario.** The player accepts `c1_m3` at the pad. In the same terminal view, the Cargo section offers "Ship N home" for oil with no "Delivery needs" line. With the reserve stepped down to 0, the hold empties. After the wurm, the beacon needs 100 oil the hold no longer has.

**What limits it.** The default reserve is 100, which covers every delivery. The player can also mine more on the planet.

**Why it matters.** The code follows SPEC-065 §6.2 to the letter ("a later stage's … does not") but defeats E117's own stated purpose: "shipping away the oil a beacon still needs would send the player back to the station for it".

**Fix:** amend SPEC-065 §4.2/§6.2 first, then count the deliver objectives of every remaining stage of the active missions.

**Effort:** S.

### B-11: The shipped surplus never reaches the depot (P3, economy/SPEC-065, CONFIRMED)

**Evidence:**
- `src/systems/Economy.ts:373` computes `shipped` but never adds it to `depot.held`.
- The toast still reads "Cargo full — surplus shipped to Command Relay." (`src/systems/Pickups.ts:35`).
- Proof: `t-missions/controls.test.ts`: `expected +0 to be 30`.

**Scenario.** Now that Command Relay has a visible Depot tab, players will look there for the overflow, and it is not there. SPEC-065 lists this as out of scope, so it is a design decision to revisit, not a regression.

**Fix (needs a PLAN or spec note):** either credit `shipped` to the depot (it was earned by a pickup, so it is not free), or change the toast wording.

**Effort:** S.

### B-12: The star map's fuel text ignores the depot (P3, UI/economy, CONFIRMED by reading)

**Evidence:**
- The info line `Fuel: X oil (have N)` is at `src/scenes/StarmapScene.ts:522`.
- The confirm sheet's `…charged now — you hold N` is at `:567`.
- Both read `data.resources.oil` only, while `canDepart` and `payFuel` count the depot too (E119, `Economy.ts:828, 844-848`).

**Scenario.** With 0 oil in the hold and 120 at the depot, the screen says "have 0", Depart is enabled, and the jump succeeds. The player cannot tell what will pay for it.

**Fix:** "hold N + depot M", or one total with the split in the sheet.

**Effort:** S.

### B-13: "Reset save" from the pause menu leaves the player in a deleted run (P3, save/UI, CONFIRMED by reading)

**Evidence:**
- The pause menu builds its `SettingsPanel` with `onImported` but no `onReset` (`src/ui/PauseMenu.ts:151-166`).
- The reset path calls `this.#deps.onReset?.()` (`src/ui/SettingsPanel.ts:700-706`).

**Scenario.** The player deletes the slot from the pause menu and resumes into a run that has no save. In flight, the landing then enters the surface with nothing bound and builds the default jump character (`Surface.ts:1286`: level 1, "Salvager", never saved).

**Fix:** pass an `onReset` that hides the pause menu and goes to the menu, as `onImported` already does.

**Effort:** S.

### B-14: A key released on a focused form control stays held (P3, input, CONFIRMED)

**Evidence:**
- `src/core/KeyboardMouseDriver.ts:249`: `#onKeyUp` returns early for any INPUT, SELECT or TEXTAREA target.
- Pausing does not call `releaseAll()`.
- Proof: `t-scenes/keyupInput.test.ts`: `move.x` stays 1.

**Scenario.** The player holds D, pauses, opens Settings, and lets go of D while a slider or select has focus. After Resume, the salvager walks right until D is pressed again.

**Fix:** always process a keyup for a code in `#pressed` (only keydown needs the editable guard), or `releaseAll()` when the pause menu opens.

**Effort:** S.

### B-15: P resumes under an open confirm sheet (P3, UI, CONFIRMED by reading)

**Evidence:**
- `src/main.ts:374-378` toggles the pause on P.
- `PauseMenu.hide()` closes only its own sub-panels.
- `ConfirmSheet` mounts in the shared overlay layer, owned by no scene (`src/ui/ConfirmSheet.ts:113`).

**Scenario.**
1. The player opens Pause, presses Recall or Save & Quit, then presses P while the confirm sheet is up.
2. Play resumes with the sheet still on screen. Its backdrop eats the next canvas click, and it blocks Enter from advancing dialogue lines.
3. In flight, the Quit sheet survives the landing, and answering it on the surface quits.

**Fix:** ignore P while any layer above the pause menu is open. Optionally, close overlay sheets on `scene:transition`.

**Effort:** S.

### B-16: The next-instance refusal never reaches the menu (P3, scene transitions, CONFIRMED by model test)

**Evidence:**
- `src/scenes/CreationScene.ts:176-186` calls `#leave()` → `go('menu')` from a `scene:entered` handler.
- `SceneManager.#run` emits `scene:entered` (`src/core/StateMachine.ts:303`) while `#transitioning` is still true, because the lock clears in `finally` at `:315`. So `go()` is refused (`:178`), and `#leave` resets `#leaving`.
- Proof: `t-scenes/enteredGo.test.ts` (real `SceneManager`): `expected false to be true`.

**Scenario.** When `load(slot)` fails (storage full or unavailable, or another tab), the player sits on a blank creation form under a "cannot continue" toast. Confirm then runs `save.create(slot)` and overwrites the finished run, without the "Overwrite slot N?" sheet that New Game asks.

**Why only P3.** The trigger is rare.

**Fix:** defer the leave to the first `onUpdate`, which only runs once the transition has settled, or add a settled event.

**Effort:** S.

### B-17: A predecessor's body on the descent hides "Descend" (P3, SPEC-058/054 seam, CONFIRMED)

**Evidence:**
- `src/scenes/Surface.ts:4600-4606` places the body, with a 2.5 m search radius, at `lastDeath`. When the predecessor's last death was underground, that point is the descent.
- `src/systems/Interactables.ts:44` picks the nearest centre.
- Proof: `t-under/body.test.ts`: 342 of 707 sample points on the descent circle prompt the body.

**Scenario.** On iteration 2 or later, about half the descent circle reads "Search the body". After the search it reads "Searched", and E does nothing there.

**Fix:** let `descent` and `exit` win anywhere inside their own circle, or push the body at least 2.5 m off the descent.

**Effort:** S.

### B-18: The `elite_surge` contract reaches cave packs (P3, SPEC-043/054 seam, CONFIRMED by reading)

**Evidence:**
- `src/scenes/Surface.ts:2246-2247` sets `spawn.eliteMult` with the surge on every step, on either level.
- `#spawnCavePacks` rolls its leaders through the same director (`:4949`, `:5049`).

**Scenario.** During an elite-surge replay, cave leaders roll elite at four times the chance. SPEC-054 §4.11 says contracts do not reach below.

**Fix:** use the difficulty-only multiplier below.

**Effort:** S.

### B-19: The quota retry can lose both copies of a slot (P3, save, CONFIRMED in simulation)

**Evidence:**
- `src/core/Save.ts:2399-2408`: on a quota error the code removes `:bak` and retries the main write. If the retry is silently truncated (the Safari behaviour the store already guards against elsewhere), main is garbage and there is no backup.
- Proof: `t-save/quota.test.ts`: `main=604B bak=false`, and the load fails.

**Why only P3.** It is rare.

**Fix:** keep the previous main JSON in memory, and put it back if the retry fails verification.

**Effort:** S.

### B-20: Gaps in memory-only mode (E8) (P3, save, CONFIRMED)

**Evidence:**
- `src/core/Save.ts:2110-2124`: `list()` reports every slot empty while a run is bound in memory. New Game on that "empty" slot asks nothing (`src/scenes/MenuScene.ts:566`).
- `importCode` returns `'unavailable'` without a toast, and the panel assumes it always toasts (`Save.ts:2551`; `src/ui/SettingsPanel.ts:654-656`).
- The next instance is always refused, because creation calls `load(slot)` (`src/scenes/CreationScene.ts:180`).
- With nothing bound, a Copy code press rejects with `'empty'`, and nothing catches it (`SettingsPanel.ts:604`).
- Proof: `t-save/memonly.test.ts` (two cases).

**Scenario.** In private browsing, or with storage blocked, a player can wipe their only copy of the run with New Game, and three buttons do nothing visible.

**Fix:**
- report the bound save for its slot in `list()`;
- toast on `'unavailable'`;
- let creation fall back to the bound save;
- catch the export rejection.

**Effort:** S.

### B-21: Remains with a full hold are silent (P3, SPEC-057, CONFIRMED by reading)

**Evidence:**
- `src/scenes/Surface.ts:4535-4545` (`#recoverRemains`) returns before any toast when nothing was taken.
- A `'recovered'` unit emits nothing when blocked (`src/systems/Economy.ts:376-377`), so there is not even a CARGO FULL.

**Scenario.** E93 says "the rest stays … with a toast". When nothing fits, standing on the pack is silent, and so are the retries every second.

**Fix:** a throttled "Hold full — N left in your pack" on an attempt where nothing fits.

**Effort:** S.

### B-22: Combat effects carry across the level swap (P3, SPEC-054, CONFIRMED by reading)

**Evidence:**
- `src/views/SurfaceView.ts:1444` hangs `CombatFx` under `#actorRoot`, which the swap does not hide.
- `Combat.clearLevel` (`src/systems/Combat.ts:713`) clears flares and clouds, but not these view effects.

**Scenario.** Scorch decals (20 s life) and live bursts keep their XZ position and draw on the other level's floor, inside a cave wall or in an open field.

**Fix:** clear the fx bursts and scorches in `#applySwap`.

**Effort:** S.

### B-23: The `high` flashlight renders its shadow map every frame (P3 perf, SPEC-054, CONFIRMED by reading)

**Evidence:**
- `src/views/Flashlight.ts:177-180` sets `castShadow` in `spot-shadow` mode.
- `setOn` (`:206-210`) writes only the intensity.
- Three's shadow pass skips a light on `shadow.autoUpdate` or `needsUpdate`, never on intensity.
- I have not measured the cost.

**Scenario.** After the first descent on `high`, a 512² shadow pass runs every frame on the surface, and below with the light off.

**Fix:** set `light.shadow.autoUpdate = on && below`, plus `needsUpdate = true` when it turns on. This leaves the light count, and so every program, unchanged.

**Effort:** S.

### B-24: The mission and guidance path allocates on every fixed step (P3 perf, hot path, CONFIRMED by reading)

**Evidence:**
- `src/systems/Missions.ts:596` `this.#states.slice()`, and `:605` a template-literal key per objective, on every `update()`.
- `currentObjectives` (`:434-439`) returns a fresh array of fresh objects. Several callers run it every step:
  - `requiredWeather` and `bossStage` (`Surface.ts:3442, 3449`);
  - guidance (`Surface.ts:6674`) and `#scanWanted`.
- With no tracked mission, `#feedTracker` calls `missions.available()` every step (`Surface.ts:7066`). That is `Object.values(MISSIONS)` plus a `filter` array per mission inside `missingRequirements` (`Economy.ts:177-190`), plus fresh strings.

**Why it matters.** SPEC-001 §7 forbids allocation in `update()`. This is steady GC churn on phones in the most common state (between missions). The architecture test only bans `structuredClone` (`tests/architecture/hotPath.test.ts`), so nothing catches it.

**Fix:**
- Iterate without `slice()` (index loop, tolerant of the splice in `#completeMission`).
- Keep the keys precomputed per stage.
- Give `currentObjectives` an `into` array.
- Cache `available()` on `mission:*` and `flag:set` events.

**Effort:** M.

## 3. Plausible or unverified (not counted above)

Each item gives where, what, and what is unverified.

**Save timestamps on the performance clock (P3).**
- Where: `src/core/Save.ts:1915-1921` (`epochClock` = `timeOrigin + performance.now()`), used for `updatedAt`, `createdAt` and the lineage `endedAt`. `Resume.awayMs` compares those with `Date.now()` (`src/systems/Resume.ts:43-46`).
- What: if the browser stops `performance.now()` across system sleep, a long-lived tab stamps saves hours in the past. The Load list then shows the wrong times, and the "previously" card shows too early.
- Unverified: per-browser behaviour.
- Fix: `Date.now()` for persisted stamps.

**Story-beat "already shown" set is per page, not per save (P3, traced).**
- Where: `src/scenes/Director.ts:65`; `src/systems/StoryBeats.ts:190, 199, 217, 278`.
- What: a new game in another slot, or a next instance begun in the same page session, skips the departure film, the chapter card (which shows the containment level) and boss reveals that already played this session.
- Fix: key the set by save, as `LINE_LEDGER` does.

**Touch zone claims survive `Input.releaseAll()`.**
- Where: `src/ui/TouchControls.ts:367-379, 465-474`.
- What: if the OS never delivers `pointercancel` after an app switch with a thumb down, that zone ignores new touches until the scheme flips.
- Unverified: real devices.

**A vault's archive shard can be lost for good.**
- Where: `Surface.ts:4764`, `:6105`; `DialogueUI.ts:339`.
- What: the shard flag is set only when its line starts. If a full dialogue queue drops that line, nothing retries it, because the vault is already in `claimed`.
- Unverified: a full queue at the moment of a solve.

**An exception in `#applySwap` freezes the game under a black fade.**
- Where: `Surface.ts:4827-4840` has no try/finally, so `#swapping` stays true.
- Unverified: no concrete trigger found. The cave generator was clean over 120k seeds.

**A slow cave kit leaves stand-ins for the whole visit.**
- Where: `CAVE_KIT_WAIT_MS = 1500` (`Surface.ts:385`), and no late model swap in `UndergroundView` or the cave `PuzzleView`.
- Unverified: whether a cold phone load is slower than 1.5 s.

**CARGO FULL is not re-armed by a refill through nodes (P3, polish).**
- Where: `Pickups.#cargoWarned` (`src/systems/Pickups.ts:136, 167-171`) is cleared only when an *orb* adds to the hold.
- Scenario: CARGO FULL is said → the player ships home at the pad → refills the hold from nodes (which never touch `Pickups`) → the next refused orb is silent. `Surface.#shippedWarned` resets on any `resource:collected`, so the two warnings disagree.

**Known and still open: `docs/BUGS.md` §7.**
- The service-mode long press is unreachable on short landscape phones. The CSS rule is unchanged at `src/style.css:5661-5665`. No new information.

## 4. Hot-path spot check (recent files)

**Clean:**
- `src/views/ScavRaiders.ts` `sync` (pool built on first use, then no allocation), `src/scenes/surface/PuzzleSites.ts` `step`/`heldStep`, `src/views/PuzzleView.ts` `sync`, `Surface.#stepRemains`/`#remainsRow` (cached text), `Pickups`/`Nodes.update`, the HUD diff and copy.
- No DOM reads (`getBoundingClientRect`, `client*`, `getComputedStyle`) in `Surface.ts`, `Flight.ts`, `ScavRaiders.ts`, `PuzzleSites.ts`, `Hud.ts` or `RemainsTag.ts`.
- `Math.random` and `three`-in-systems are test-enforced, and green.

**Not clean:** the mission and guidance layer (B-24), and the flight HUD's `waveMarkers()` `.map` (`src/systems/Flight.ts:480`). That one runs once per enter, not per frame, so it is fine.

## 5. Checked and found sound

**Missions:**
- Each objective completes exactly once, and stages advance correctly.
- Counters across death, recall, reload, replay and abandon behave as E4, E19 and SPEC-043 say.
- A flight recall resets once (E5). The hold pattern (E12/E58) works.
- The run skip is refused while a flight mission is active.
- Underground holds (E83) cover survive, defend, escort, storm waves and the follower.

**Economy:**
- Replay pays 50 %; a contract pays 75 % plus 20 lithium.
- Purchases check the whole cost before paying, the discount cap and the 1-token floor hold, and tokens never go negative.
- Crafting checks room first, and nothing is refunded.
- The depot core is correct: `shippable`, `shipHome`, `setKeep`, `drawable`, `draw`. `payFuel` never drives the depot negative, and the subsidy counts the depot (E119).
- The campaign lock (E24) holds.

**Save:**
- The v0→v4 migration chain and the fixtures round-trip with zero warnings.
- A fully played v4 save survives flush → load deep-equal: relics, lineage, remains at the wall clamp, both explore masks, the depot, a replay, and a resume point.
- Writers match the validator's bounds.
- Backup restore, the archive and restore (SPEC-058), and the next instance's carry-over all behave: it keeps only the seed, iteration, lineage and profile, and resets the depot, claims, remains and resume.
- No reward is duplicated across a reload.

**Scenes:**
- `go()` locks synchronously and unlocks in `finally`. A pause arriving mid-transition is applied after the transition (D-40).
- Every `#leaving` flag resets when `go()` is refused.
- Flight landing and recall cannot race.
- Disposers release listeners, timers, audio ducks and film captures.

**Combat pools:**
- Every free inside a loop runs backwards; dead enemies are swept once at the end of the step.
- Telegraph and wave caps hold.
- Menders give one heal per pulse period (41-m).
- No death is possible under any hold.

**ScavRaiders (SPEC-064):** the live, falling and free slot bookkeeping is right. Pool-full stealing (E114) works, and dispose frees materials and skeletons.

**Underground and puzzles (SPEC-054 to 056):**
- 120k generated caves (20k seeds × 6 planets): at least 5 rooms each, caches and vault reachable, plates, panel and beam cells reachable (`t-under/sweep.test.ts`).
- Every shelter's descent point stays clear and reachable after the wreck-gap fix (7d44c8b) over 1,500 seeds per planet (`t-under/descent.test.ts`). Old saves' remains and bodies stay recoverable.
- The shaft mouth (384118a) hides below and is disposed.
- No puzzle soft-lock: the bypass is always reachable.
- No treasure is paid twice; every grant is gated on `progress.claimed`.

**Story difficulty (SPEC-059 §4.2):** zero damage on every path: enemy, projectile, telegraph, weather, follower, defend structure and flight hits. The debug "fall" source is the only one not zeroed, and that is debug-only.

**Records gate:** best times and commendations are gated. The share card's `COMMENDATION_TOTAL = 24` matches the table.

## 6. Easy wins (high value, effort S)

1. **B-01:** pass `collectDemand` to `Nodes` in `Surface.ts:1407`. One line, plus a shared factory so the test cannot drift from the scene.
2. **B-03:** route the flight throttle and pause through `PressEdges`.
3. **B-02, line-of-sight half:** below, return `bestClear` only and require a clear line for placed-enemy acquisition.
4. **B-06:** a `#leaving` flag on `scene:transition` in `#runEnding`, plus a `playFilm` guard while transitioning.
5. **B-05:** export the bound save when it is the slot being exported.
6. **B-04, first half:** make `flush()` honour the two-tab guard.
7. **B-08:** one `alive` check on the defend timer.
8. **B-13:** give the pause menu's Settings an `onReset`.
9. **B-12:** show hold plus depot in the two fuel lines.

## 7. Ranked top 5

1. **B-01 (P1):** a collect objective stalls at a full hold. It is the finding SPEC-034 was meant to fix, and `BUGS.md` §6 calls it fixed, but the scene never wired it.
2. **B-02 (P2):** combat in the new caves shoots at walls, and packs aggro through rock. It makes the newest content look broken.
3. **B-04 (P2):** two tabs, or the PWA plus a browser tab, can overwrite the newer save, then silence autosave everywhere. This loses progress.
4. **B-05 (P2):** the game's own advice after a failed save exports the wrong save. This loses progress exactly when the player is trying to rescue it.
5. **B-03 (P2):** throttle double-steps at 30 Hz. It touches every flight on a phone in low-power mode, and the fix is S.

The two P2s that miss the top five, B-06 (the ending film over the menu) and B-07 (the subsidy farm), are severe when they happen. They rank lower because each needs a rare action or a deliberate exploit.
