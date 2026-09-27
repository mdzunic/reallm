# R19 audit — the story and the films (prefix `N-`)

> **Provenance.** Written on 2026-09-27 for PLAN R19–R21, against a snapshot of `main` at `2cf398a` (SPEC-035 and PLAN R18 merged; SPEC-036…045 written, not built), which the report calls `SCRATCH/game-r19`. `SCRATCH` was that review session's working folder; its probes, captures and simulation scripts are not kept in the repository. The decisions taken from this report are PLAN R19, R20 and R21 and the specs SPEC-046…SPEC-059 in `mdzunic/reallm-specs`; where a report and PLAN differ, PLAN wins.

Auditor: narrative. Snapshot: `SCRATCH/game-r19` (game `main` @ 2cf398a). Nothing in any repository was changed. Scratch tools: `SCRATCH/r19/narrative/shotbytes.py` (per-shot byte cost read from each MP4's `stsz` box) and `lines.py` (length check of every line proposed below).

---

## 1. Verdict

1. **The twist has nothing to overturn.** "You think you are human" is carried by 93 s of prologue narration and nothing else. The salvager has no past, no kin, no body that needs anything, and no wants. They speak 9 of the game's 94 lines, and none of them is a memory. When the Warden says "sixty-one times", nothing human breaks.
2. **Main-path players see almost no evidence before chapter 4.** Every "you are a copy" beat (the echo, your own log, the tower settings) sits in a side mission. Before the chapter-4 notice, the main path carries one ARIA slip (`c3_m3_done`) and one contradiction that no line ever acknowledges (Vetra's "last expedition" against "you were the first to fly").
3. **The story still never listens (S-01).** No dialogue line can depend on a flag, so the Warden's "off-task behaviour" fires on rails and ARIA's confession names nothing.
4. **The "replaceable" payoff lands on a stranger.** Card 62 is a photographed bearded man (S-08), and he may resemble a famous game protagonist. Card 63 is the same man. The report hard-codes `RUN 62`. `meta.iteration` is never read, and nothing after either ending continues the loop.
5. **The films are good at hope and silent on doubt.** The CG `stranded` shot looks like the escape ending's clay, so that reveal is spent in minute one. The Earth-relit payoff is a 20–40 px cluster, and the interludes plant almost nothing.
6. **The fix is mostly data, not systems.** It needs:
   - `when:` conditions and placeholders on lines;
   - a 20-entry clue catalogue stored in flags (no save version change);
   - one human anchor, Ines (a sister in Shelter Nine: letters, a keepsake, one question);
   - a Selection card that shows the suit, never a face;
   - about 11 retaken shots, costing +0.35–0.65 MB against the 3.52 MiB of headroom in the 12 MiB films budget.

---

## 2. What exists today

### 2.1 How a line reaches the screen

| Mechanism | Where | Behaviour that matters |
|---|---|---|
| `DialogueDef` | `src/data/dialogue.ts:15-29` | Fields: `{ id, lines: {speaker, text}[], modal?, once?, glitch?, next? }`. There is **no condition and no placeholder**, and a line is a static string. |
| Speakers | `src/data/ids.ts:77` `SPEAKERS` | `aria, command, scav, log, player, warden`. The display names are in `ui/DialogueUI.ts:49-56` `SPEAKER_NAMES`, with the Warden shown as `???`. |
| Dialogue layer | `src/ui/DialogueUI.ts` | One page-lifetime instance per `#ui` root (`dialogueLayer`, :95), and **the first caller's options win**. `QUEUE_MAX = 5` (:35): a 6th line is dropped silently. `scene:transition` clears the queue (:151). A non-modal line auto-advances after `AUTO_ADVANCE_MS = 6000` (:33). `once` is remembered in a `WeakMap` keyed by the save object (:84), so it is **per session** and a reload replays it. `next` jumps the queue (:315, SPEC-034). `playChoice` (:198) is the only choice UI. |
| Mission hooks | `MissionDef.dialogue` `src/data/missions.ts:90-94` | `onAccept`, `onStage[n]` (n ≥ 1; `onStage[0]` is forbidden by `tests/data/content.test.ts:591`) and `onComplete`. |
| Surface | `src/scenes/Surface.ts` | **On landing** (:1030-1036), each active mission plays its accept line (stage 0) or its current stage line, unless the ledger has it. **Pad accept** (:2902-2911) plays `onAccept` before `accept()`. `mission:stageStarted` (:4170) plays `onStage`. `mission:completed` (:4198-4204) plays `onComplete`, held back during the ending. `dialogue:started` fires the static burst for `glitch` and holds the world for `modal` (:4097-4112). |
| Flight | `src/scenes/Flight.ts` | Flight missions' `onAccept` lines play after launch, non-modal (:848-858); `onComplete` lines play in flight (:255-262). The first landing shows the toast `ARIA: <planet> on approach. <blurb>` (:244-247). |
| Station | `src/scenes/StationScene.ts:198-217` | Order on entry: `#pendingEnding` (replays an unfinished ending), then `#debrief`, then the interlude film. `#debrief` (:264-287) plays **only ids named `<mission>_done`**, so `c3_s1_secret`, `c4_m3_signal` and `c5_m3_warden` are played on the surface only. A reload leaves nothing to debrief. The subsidy toast is at :174. |
| Line ledger | `src/systems/StoryBeats.ts:260-311` `LINE_LEDGER` | Page-session memory of played lines and missions finished this trip. No save field. |
| Creation | `src/scenes/CreationScene.ts:544-569` | After the save is written: station, then `intro_command` (modal, once). |
| Films and beats | `src/data/films.ts` | **Prologue**: New Game, before creation. **Departure**: first flight to each planet (`visits == 0`). **Chapter card**: rides that departure. **Interlude N**: first station entry with `chapterN_done`, marks `interludeN_seen`; with `?films=off` no flag is set (23-f). **Boss reveal**: once per boss per session. **Endings**: choice, then dialogue, then film, then overlay. |
| Ending overlay | `src/ui/EndingOverlay.ts` | **Stay**: the report card `EARTH COMMAND — SURVEY REPORT · FILED` plus the 5 lines of `stayReport()` (`StoryBeats.ts:236-244`), then Continue into free roam. **Escape**: `ESCAPE_PROMPT_TEXT = 'instance/62 disconnected'` (:15), a 3 s veil, then the menu. |
| Diegetic chrome | `src/ui/Screen.ts:61-74`, `src/ui/DeathOverlay.ts:17`, `src/ui/ChapterCard.ts` | `PERSONNEL FILE · NEW SALVAGER` (creation), `SYSTEM HOLD` (pause), `SIGNAL LOST · Respawning…` (death), `containment level N` (card, where N is the chapter), `Containment level N` in the station header (highest unlocked chapter). |

A scan completing plays nothing by itself; a line plays only when it completes a stage whose next stage has an `onStage` line. Landmarks (`ruin` ×4, `ice_spire` ×5, `overgrown_ruin` ×5, `lava_vent` ×6, `egg_cluster` ×6, `grove` ×5) and shelters (caves and wrecks, `planets.ts` `features`: Cinder-4 2+2, Vetra 2+2, Thessaly 2+1, Ferrum 2+2, Hive 2+1, Eden 1+1) are discovered and remembered in `poisDiscovered` (`Surface.ts:1795-1804`, `:1909-1914`), and **nothing is ever said about them**. No `shelter:*` event exists: `#insideShelter` is internal (`Surface.ts:1778`).

### 2.2 The story as delivered, mission by mission

★ = strength of the meta tell (none, faint ★, clear ★★, explicit ★★★).

| Mission | When → dialogue (speakers) | Surface fiction | Meta tell |
|---|---|---|---|
| (before play) | **Prologue**: Command narration ×11 and a `title`, card No. 62 stamped first, "You were the first of them to fly." Then **creation** (`PERSONNEL FILE`). Then `intro_command` (Command ×2: "Survey, extract, report. Answer one question: can we live out there."; ARIA "I keep you honest"). Then the departure film and the chapter card on the first flight. | The Machine War, Shelter Nine, the Selection | Card number 62 (★, needs hindsight) |
| c1_m1 Dry Land (main) | Landing: `c1_m1_accept` (ARIA). Pad reached (stage 1): `c1_m1_stage2` (scav "…walk, do not run."; ARIA "He is dehydrated. Keep moving."). Done: `c1_m1_done` (ARIA "habitable in the way a furnace is habitable"). | Tutorial; a dying stranger's advice. The scav has no body (S-06). | none |
| c1_m2 Black Gold (main) | Accept: `c1_m2_accept` (Command). Done: `c1_m2_done` (ARIA). | Oil, raiders | none |
| c1_m3 Worm Sign (main, boss) | Accept: `c1_m3_accept` (ARIA "…Do not run."). Reveal: ARIA "Walk, do not run. I mean it this time." Done: `c1_m3_done` (Command "Chapter closed. Vetra is unlocked…"; ARIA "…within expected parameters"). Station: **interlude_c1**. | First boss | "this time", "expected parameters" (★) |
| c1_s1 Grain Silo (side) | Accept and done (ARIA ×2) | Rations | none |
| c1_s2 Waterless (side) | Accept (Command). Stage 1 (heatwave): `c1_s2_echo` (glitch, once/session: the scav repeats the warning word for word; player "Say that again."; scav "I have said that before. To someone. I cannot remember who."; ARIA "Coincidence. Sand does things to people."). Done (ARIA). | Heat | **The echo** (★★) |
| c2_m1 Whiteout (main) | Brief: "the ridge camp the last expedition left behind". First-landing toast: "The last expedition here did not come back." Accept (ARIA). Done: `c2_m1_done` (ARIA "…did not come back."). | Earth's lost ships | Contradicts "first to fly", and **no one remarks on it** (★, accidental) |
| c2_m2 The Thaw (main) | Accept (Command), done (ARIA) | Water | none |
| c2_m3 Glacier Heart (main, boss) | Accept (ARIA). Reveal (ARIA). Done (Command "Thessaly is unlocked. Voucher sent."; ARIA). **interlude_c2** (ARIA "Earth is keeping score, and so am I."). | Water home | "keeping score" (★) |
| c2_s1 Frozen Crew (side) | Accept (ARIA "That should not be here."). Stage 1 (crash site scanned): `c2_s1_log` (glitch, once/session). LOG ×3, signed "Iteration 62"; player "That is my handwriting."; ARIA "It is a common enough hand. Deliver the water, salvager." Done: `c2_s1_done` (ARIA). Flag `iteration_log` on completion. | Earth's lost ship | **Your own log** (★★★) |
| c2_s2 Pelt Run (side) | Accept (Command), done (ARIA) | Hides | none |
| c3_m1 Green Hell (main) | Accept (ARIA). Done: `c3_m1_done` (ARIA "The ruins keep showing up in the scan where nothing built them."). | Grain | Faint (★) |
| c3_m2 Bug Country (main) | Accept (Command "The probe is expensive. You are not."). Done (ARIA "…knows we are listening now."). | Escort | none |
| c3_m3 The Hive Mouth (main, boss) | Accept (ARIA). Reveal (ARIA). Done: Command "Ferrum is unlocked…"; ARIA "**You have never once asked why they are always waiting for you.**" **interlude_c3** (ARIA "The towers on Thessaly were built for someone."). | Third boss | **The only main-path slip before ch4** (★★) |
| c3_s1 Old Terraform (side) | Accept (ARIA). Complete: `c3_s1_secret` (glitch). LOG `TOWER STREAM: … seed=0x2F1A pop=18 elite=0.06 …` (the pop and elite values are Thessaly's real `population`/`eliteChance`, `planets.ts:285-286`), "scaffold stable, ready for occupant."; player "Those are not readings. Those are settings."; ARIA "alien telemetry"; player "For us. Or for something." Flag `scaffold_secret`. | Alien towers | **The settings** (★★★) |
| c3_s2 Reaping (side) | Accept (Command), done (ARIA) | Grain | none |
| c4_m1 Firefall (main) | Accept and done (ARIA) | Radiation | none |
| c4_m2 Fuel of Gods (main) | Accept (Command "the fuel that gets us home"), done (ARIA) | Lithium | none |
| c4_m3 Reactor Womb (main, boss) | Accept (ARIA). Reveal (ARIA). Complete: `c4_m3_signal` (glitch, **non-modal**, once/session). ARIA "Signal decoded. It is not addressed to Earth."; WARDEN "NOTICE — instance/62. Containment level 4. Subject exhibits off-task behaviour." + "Escalating…"; player "ARIA. What is instance sixty-two."; ARIA "The Hive knows Earth's location. That is what it says." Flags `chapter4_done`, `signal_decoded`. **interlude_c4** (watchers and a static tear). | The Hive knows Earth | **The notice, on rails** (★★★) |
| c4_s1 Core Sample (side) | Accept (Command). Done (ARIA "…it is all the same."). | Assay | Faint (★) |
| c4_s2 Salvage Rights (side, flight) | In flight: accept and done (ARIA) | Scav fighters | none |
| c5_m1 Gauntlet (main, flight) | In flight: `c5_m1_accept` (ARIA "…Three minutes. **Ten kills.** …"; the mission asks 6 since SPEC-034). Done (ARIA "Welcome to the Hive."). Toast "The Queen has known you were coming since Thessaly." | Gauntlet | none |
| c5_m2 Lair (main) | Accept (Command). Done (ARIA "She has known you were coming since Thessaly." — the same sentence as the toast). | Tunnels | Faint (★) |
| c5_m3 Her Majesty (main, boss) | Accept (ARIA "…it will not be her saying it. Do not answer."). Reveal (glitch, ARIA). Queen dies: `c5_m3_warden` (modal, glitch): "You keep doing this." / "You never get further than here." / "Sixty-one times I have watched you kill this body and file the report and start again."; player "Then let me finish." → `next` `c5_m3_aria` (modal): "I am part of the system…", "I do not know what is outside either…", "Eden-Prime is unlocked…". **interlude_c5** (ARIA "I am still flying the ship. Whatever I am."). | The Queen's death | **The Warden and the confession** (★★★) |
| c5_s1 Egg Hunt (side) | Accept (Command), done (ARIA) | Eggs | none |
| c6_m1 Paradise (main) | Toast "…everything the brief promised, which is exactly what is wrong with it." Accept (ARIA "…which is what worries me."). Three silent scans. Done (ARIA "I have run it four times and it keeps coming out true."). | Paradise | Faint; nothing on screen (S-09) |
| c6_m2 The Verdict (main) | Accept (Command). Defend 240 s against `eden_final`, **all Hive**, after "The Hive has gone quiet". Stage 1: `c6_choice_intro` (modal, ARIA ×3, "Earth is saved, inside the fiction"). Choice → `ending_stay` / `ending_escape` → film → overlay. `c6_m2_done` is held back for the station. | The verdict | **The endings** (★★★) |

### 2.3 What a main-path-only player sees of the twist

| Where | Evidence | Comment |
|---|---|---|
| Prologue | Card No. 62 | Readable only in hindsight |
| Ch1 | "I mean it this time"; "within expected parameters"; "Chapter closed" | System diction, easily read as ARIA's humour |
| Ch2 | "The last expedition" against "the first to fly" | Unacknowledged |
| Ch3 | "You have never once asked why they are always waiting for you." | The first real slip, at ~60 % of the campaign |
| Ch4 | The notice | Accuses a player who did exactly as told |
| Ch5 | Warden and confession | The confession names nothing |
| Ch6 | The choice and the endings | — |

**Chapters 1–3 of the main path contain no evidence that the salvager might not be human.**

### 2.4 The human illusion today (exactly what exists)

| Aspect | What exists |
|---|---|
| **Past** | The Marine blurb "Line infantry, reassigned to salvage." (`characters.ts`); the prologue's "Men and women with nothing left to lose." Nothing else. |
| **Memories** | None. No player line recalls anything. |
| **Kin, home** | Shelter Nine exists only as film pictures (prologue `shelter`, interlude `shelter_light`, `tap`). No named person, no letter. No one addresses the salvager as a person except "Earth thanks you, salvager" (stay film). |
| **Body** | "Your suit logged forty degrees over rated" (`c1_s2_done`), "lungs intact" (`c3_m1_done`), the decontamination bay (`c4_m1_done`), rations that "taste like the inside of a filter" (`c1_s1_done`), HP. No hunger, sleep or fatigue. Death is "SIGNAL LOST · Respawning…" and is **never explained**. |
| **Face** | Creation: name (≤ 16), 6 visored helmet portraits per class (`CreationScene.ts:372-375`), colours. Films: card 62 is `plates/selection/01.webp` (a bearded man). The only film shot of the salvager in person, `ending_escape/exit`, shows the helmeted suit (`character.glb`). |
| **Voice** | 9 player lines in 94 (`dialogue.ts`: ARIA 53, Command 17, log 5, player 9, scav 3, Warden 7). No contractions anywhere: the house style makes the salvager, ARIA, the Warden, Command and the scavs sound identical. |
| **Earth** | "can we live out there", "the fuel that gets us home"; Earth relit in the interludes. |

### 2.5 The "replaceable" payoff today, `meta.iteration`, and 61 / 62 / 63

**Stay:**
1. `ending_stay` dialogue (player files; Command "…Earth is saved. Stand by."; Warden "A good run. Logged. Rest."; ARIA "Rest. I will keep the ship warm.").
2. The film **A Good Run**: uplink → CG fleet → Earth lit → `wall_63`, where card 63 slides in with **the same face as 62** and is stamped → the prologue's first shot, frame for frame.
3. The report: `SALVAGER <name> · WORLDS SURVEYED 6 of 6 · DELIVERED … · VERDICT … · RUN 62 logged · a good run`.
4. Free roam. The next station entry plays `c6_m2_done`. **Nothing continues the loop.**

**Escape:**
1. `ending_escape` dialogue ("There is nothing outside for you to be.").
2. The film **Disconnected**: door of light → Eden to UV grid → clay city → `wall_same`, where every card is face 01 in sepia and card 62 goes white. Captions "You will be restarted. You always are." / "EARTH — placeholder geometry. Population field: 0." / "SELECTION POOL — 1 model. 62 instances." The film ends on 5 s of black (`point`, 3.9 KB/s).
3. The veil `instance/62 disconnected`, then the menu.
4. **Continue then drops the player at Command Relay with nothing said (B-27).**

**`meta.iteration`:**
- Declared in `core/Save.ts:125-126`, set to `1` in `newSave` (:447) and clamped to 1–99 by `validateMeta` (:607).
- **Nothing outside Save and its tests reads it.** It is pinned at 1 by `tests/core/save.test.ts:185-186` and by the clamp test at :609-612.

**Every occurrence of 61, 62 and 63:**

| Number | Where |
|---|---|
| 62 | `c2_s1_log` "Signed: Iteration 62." (`dialogue.ts:156`) |
| 62 | `c4_m3_signal` "instance/62", "What is instance sixty-two." (:257, :259) |
| 61 | `c5_m3_warden` "Sixty-one times" (:311) |
| 62 | `CARD_NUMBERS = (62, 7, 13, …)` (`shots_prologue.py:22`) |
| 63 | `wall_63` "No. 63" (`shots_endings.py:183`) |
| 62 | The escape caption "62 instances" (`films.ts:271`) |
| 62 | `stayReport` "RUN 62 logged" (`StoryBeats.ts:242`), pinned by `tests/systems/storyBeats.test.ts:350-366` and `e2e/SPEC-024.spec.ts:188` |
| 62 | `ESCAPE_PROMPT_TEXT` (`EndingOverlay.ts:15`), pinned by `e2e/SPEC-024.spec.ts:237,291` |

### 2.6 The films: inventory and per-shot cost (measured)

**Budget:**
- The `films/` folder holds 8,886,982 B (8.48 MiB) of its 12 MiB, so **3.52 MiB is free**.
- The whole of `public/` is 20.30 MiB against the 25 MiB precache, with JS on top.
- The rate cap is 44 KiB/s per film (`tests/data/films.test.ts:146`).
- Bytes per shot come from `shotbytes.py`: **plate shots cost 30–65 KB/s and flat CG shots 4–25 KB/s.**

| Film | Bytes · KB/s | Shots: R = rendered geometry, P = photographic plate (bytes) |
|---|---|---|
| prologue 93 s | 3,045,936 · 32.8 | earth_night R 236k · machine_hall R 382k · curfew P 223k · sabotage P 406k · reprisal P 209k · launch R 260k · city_flash P 289k · **stranded R 204k (20.4/s)** · shelter P 382k · **selection R + 6 face textures 153k** · **liftoff R 243k** · relay R 40k |
| departure 7 s | 257,067 · 36.7 | undock R 124k · jump R 131k |
| interlude_c1 14 s | 471,206 · 33.7 | capsule R 82k · shelter_light P 326k (65/s) · **earth_c1 R 59k** |
| interlude_c2 14 s | 491,392 · 35.1 | tanks R 127k · tap P 301k · **earth_c2 R 59k** |
| interlude_c3 14 s | 530,201 · 37.9 | greenhouse R 414k (59/s) · **earth_c3 R 112k** |
| interlude_c4 16 s | 562,435 · 35.2 | reactor R 149k · earth_c4 R 138k · watchers R 271k |
| interlude_c5 16 s | 446,424 · 27.9 | hive_dark R 238k · eden R 135k · **cockpit R 69k** |
| ending_stay 36 s | 1,307,245 · 36.3 | uplink R 173k · fleet R 344k · earth_full R 348k · **wall_63 R + face 173k** · earth_again R 260k |
| ending_escape 36 s | 1,089,752 · 30.3 | exit R 131k · eden_unmade R 667k (83/s) · **earth_unmade R 72k (9/s)** · **wall_same R + face 183k** · point R 27k |

**Build:**
- `scripts/assets/blender/films.py:41-106` holds the shot table.
- `lib/plate.py` provides `shot(plate, push, drift, exposure, saturation, flicker, flash, lift)`. It renders through an ortho camera at about 0.08 s a frame (R11).
- Geometry shots run at 0.2–3 s a frame. A full build is about 1–3 h (SPEC-021 §8), and the frame cache keys on code and plate bytes.
- There are 6 plates plus 6 faces (`plates/selection/01-06.webp`). All were Gemini-generated and are listed by hand in `public/assets/LICENSES.md:28-50`.
- The shelter plate shows **a compass on the map table** and the six Selection faces. Face 04 (beige coat, tied hair) is the woman **pouring at the tap** in `interlude_c2`. Face 01, card 62's man, is first in that queue, so "you" are visibly at home after you have left.

**Phone legibility:**
- At 750 × 342 landscape the film letterboxes to 608 × 342 (×0.63).
- `earth_c1…c3`: the lit patch is 20–40 px at 960 wide, so 13–25 px on the phone, at the bottom edge of a black disc.
- `selection`: card 62's photo is cropped at the top edge.
- `hive_dark` has 2 s of pure black (4–6 s); `eden`'s tug is a speck; the `cockpit` static band is 0.4 s and 2 px.

### 2.7 Data constraints the proposals must live with

- **Flags.** The validator drops any flag not in `STORY_FLAGS` (`Save.ts:873-877`). `STORY_FLAGS` has **17** entries (`ids.ts:54-73`), pinned by `e2e/SPEC-009.spec.ts:237`. Adding flags is backward compatible, with no save version change. No test requires a flag to be granted by a mission; test 2 constrains only `chapterN_done`.
- **Speakers.** `SPEAKERS` is pinned exactly (`e2e/SPEC-009.spec.ts:239`), and `tests/data/films.test.ts:77` accepts only `SPEAKERS ∪ {'title'}` as caption speakers.
- **Line and caption limits.** Dialogue lines ≤ 220 characters, non-empty, at least one line per dialogue (`content.test.ts:655-669`). No compass words (:1017). Every mission has an `onAccept`, there is no `onStage[0]`, and every id exists (:573-607). A `next` chain terminates within 4 steps (:614-639). Captions ≤ 140 characters, in order, inside one shot, and on screen for at least `1.5 + len/40` s (`films.test.ts:76-90`).
- **Film pins.** Nine films with these exact ids (`films.test.ts:43-47`), lengths pinned (:68-74), manifest ↔ data shot ids and frames (:128-150), rate ≤ 44 KiB/s, total ≤ 12 MiB.
- **Ending pins.** `stayReport` is pinned to "carries the player name and nothing else" (`storyBeats.test.ts:360-366`). The SPEC-024 e2e pins `RUN 62` and `instance/62 disconnected`; iteration 1 still produces both.
- **Other pins.** The `GameEvents` count is pinned at 64 (`tests/core/events.test.ts:612`, before the R18 specs move it). Data modules may hold no functions (SPEC-001 §8), so every condition must be a plain object.
- **What needs a save change.** Nothing proposed below needs one. Clue, letter, answer and aftermath state fit in `STORY_FLAGS`; `meta.iteration` already exists; the slot's ending derives from flags plus `endingSeen`. The only save-shaped wish — cross-iteration memory of run-1 clues for Iteration 63 — is deferred to R21 (§4.9).

### 2.8 The first review's story findings (S-01…S-11) in this snapshot

| ID | Status | Evidence |
|---|---|---|
| S-01 the story never listens | **Remains** | No `when` in `DialogueDef`. `iteration_log`, `scaffold_secret`, `signal_decoded` and `c1_oil` are still never read. |
| S-02 climax and finale | **Fixed** (SPEC-034) | `c5_m3.onComplete = 'c5_m3_warden'` with `next` (`missions.ts:459`, `dialogue.ts:307`); waves spawn aggroed (`Spawn.ts:371`) |
| S-03 best beats optional; no main-path echo; no board icon | **Remains** | §2.3 |
| S-04 the echo pre-empted | **Fixed** | `c1_m1_stage2` has lost "I have said that before" (`dialogue.ts:51-57`) |
| S-05 "walk, do not run" has no mechanic | **Remains** | SPEC-041 Out of scope hands it to R19. The `c1_m3` hint "move when the ground shakes" (`hints.ts:202`) contradicts it. |
| S-06 scavs are voices; raiders mute | **Remains** | `scav` is only a speaker id |
| S-07 continuity | **Part fixed** | Fixed: the log now plays at `onStage[1]` before delivery; `c2_s1_done` added; the Queen line reworded (`c5_m3_accept`). Remaining: 62 vs 61 vs "62 instances"; Vetra's "last expedition"; Eden's all-Hive wave with no line. New: `c5_m1_accept` "Ten kills". |
| S-08 the films fix the player's face | **Remains**, and the likeness risk remains | §2.4 |
| S-09 Eden not a trap | **Remains** | `c6_m1` is three silent scans |
| S-10 endings' edges | **Part fixed** | Fixed: `instance/62 disconnected` is gone from `ending_escape`'s lines; "Stand by." Remaining: Continue after the escape (B-27); cover stories after the confession. |
| S-11 text polish | **Mostly remains** | "armor helps" / "without armor" (`hints.ts:176,210`); `wall_same` described as "grey face" but shows a sepia photo. SPEC-045 does a glyph glossary, not a spelling sweep. |

Related fixes: **B-12** (static burst CSS split into `.hud-storm-warn` / `.hud-ion`, `style.css:1412-1422, 3030-3042`), **B-20** (the ledger) and **B-25** (`CARD_NUMBERS` restored) are fixed. **B-27** remains.

---

## 3. Findings

| ID | Sev | Finding | Evidence |
|---|---|---|---|
| N-01 | P1 | **There is no human to un-make.** The salvager has no past, kin, memory, need or want. Humanity is asserted only by the prologue's narration, so the twist and the "replaceable" ending have nothing to overturn. | §2.4; the player has 9 lines; no memory, kin or letter anywhere (grep) |
| N-02 | P1 | **The main path is empty of evidence in chapters 1–3.** Every copy/built-world beat is in a side mission. The first main-path slip comes at ~60 % of the campaign, and the ch4 notice then accuses a compliant player. | §2.3; `missions.ts` c1_s2 / c2_s1 / c3_s1 |
| N-03 | P1 | **The story never listens (S-01).** No conditional lines exist. Four flags are set and never read. The Warden and ARIA name nothing the player did or found. | `dialogue.ts:15-29`; `ids.ts:54-73` |
| N-04 | P1 | **Card 62 is a stranger's face, with a likeness risk (S-08).** One photographed man stands for "you" on cards 62 and 63 and on all 12 cards of `wall_same`, while creation offers visored helmets and the films' own shot of you (`exit`) is the helmeted suit. The same face is also in `prologue_shelter.jpg` and `interlude_c2_tap.jpg`, so a failed likeness check touches 3 plates. | `plates/selection/01.webp`; `shots_prologue.py:261`; `shots_endings.py:181,294` |
| N-05 | P1 | **The replaceable payoff lands on nobody.** The 63rd card is the stranger. `RUN 62` and `instance/62` are hard-coded, `meta.iteration` is never read, and neither ending leads anywhere. | §2.5 |
| N-06 | P2 | **The escape reveal is pre-spent.** `stranded` (CG boxes and thin blocky machines) already looks like `earth_unmade` (clay boxes and the same machines). The photographed Machines (curfew, sabotage, reprisal) are hulking, so the CG ones contradict them twice. | Posters `prologue_stranded` / `ending_escape_earth_unmade`; `figures.machine` |
| N-07 | P2 | **Continuity.** Iteration 62 on the log, "Sixty-one times" from the Warden and "62 instances" in the film do not agree. Vetra's "last expedition" goes unacknowledged. Eden's all-Hive wave after "The Hive has gone quiet" gets no line. **`c5_m1_accept` says "Ten kills" while `c5_m1` asks 6.** | `dialogue.ts:156,311,283`; `films.ts:271`; `missions.ts:185,422`; `planets.ts:185`; `waves.ts:45-56` |
| N-08 | P2 | **ARIA's cover stories can play after her confession.** "Coincidence. Sand does things to people." and "It is a common enough hand." have no condition, and side missions stay open. | `dialogue.ts:109,158` |
| N-09 | P2 | **After an escape, Continue says nothing, and the slot line shows no ending (B-27).** | `Save.ts:192-203,1383-1397`; `UiHelpers.slotLine` :91-97; `StationScene.ts:232-252` |
| N-10 | P2 | **Replays replay the beats.** A 50 % replay or contract in a new session plays the echo, the log, the tower stream, the notice and the Warden/ARIA chain again, because `once` and the ledger are page-session. | `DialogueUI.ts:84`; `StoryBeats.ts:260-311` |
| N-11 | P2 | **"Walk, do not run" has no mechanic (S-05).** It is said three times, and the hint says the opposite. | `dialogue.ts:54,79,106`; `films.ts:312`; `hints.ts:202`; SPEC-041 OOS |
| N-12 | P2 | **Scavengers are disembodied, and raiders never speak (S-06).** PLAN §5 casts the raiders as drifted instances "which is why they know things". | `ids.ts:77`; PLAN §5 cast |
| N-13 | P2 | **Eden is not a trap on screen (S-09).** | `missions.ts:476-492` |
| N-14 | P2 | **The most frequent event in the game is unexplained.** A human dies and "respawns" at the pad; no line covers it or uses it. | `DeathOverlay.ts:17`; `TIPS.death` |
| N-15 | P2 | **Interludes plant hope, not doubt.** c1–c3 plant nothing visual. The Earth-relit payoff is 13–25 px on a phone. c4's tear lasts 0.2 s. c5 has 2 s of black, a speck of a tug and a 0.4 s stutter. | §2.6; `shots_interludes.py:17-30,255,310` |
| N-16 | P2 | **The films' Earth clashes (review §6.4 remains).** CG `stranded`, `liftoff`, `capsule`, `tanks`, `greenhouse`, `reactor` and `fleet` sit beside the photographs. | Contact sheets `SCRATCH/art/posters_a.png`, `_b.png` |
| N-17 | P3 | **`c4_m3_signal`, the chapter-4 main-path climax, is non-modal.** Five lines auto-advance at 6 s over live play after the boss arena. | `dialogue.ts:251-262` |
| N-18 | P3 | **No human voice exists.** Nobody uses contractions, so the house style cannot mark who is a person. | `dialogue.ts` (no `n't`, `'re`, `'ll`) |
| N-19 | P3 | **Polish.** "armor" in hints; the `wall_same` description; the escape `point` ends on 5 s of black; the Hive toast and `c5_m2_done` share one sentence. | `hints.ts:176,210`; `films.ts:265`; `planets.ts:353`; `dialogue.ts:295` |
| N-20 | P3 | **Dead film code.** `shots_interludes.shelter_light` calls the deleted `P.shelter_room`, and `filmScripts.test.ts` does not catch attribute calls. | `shots_interludes.py:81-91` |

---

## 4. Proposals

Everything is *initial tuning* unless it is a pin. None of it touches:
- the token totals (670 / 104 / 2,380);
- rewards or SPEC-010 invariants;
- SPEC-016's campaign pins (the harness asserts only `campaign_done` and the ending flags);
- the save version or layout hashes.

### 4.1 P-A — The story context: conditions, placeholders, caption variants, instance numbers

The enabling layer. It is pure, and the data stays plain objects.

```ts
// data/story.ts (data only)
export type LineCondition =
  | { readonly flag: FlagId }                       // set
  | { readonly not: FlagId }                        // unset
  | { readonly offTask: { readonly min?: number; readonly max?: number } }   // optional clues found (§4.2)
  | { readonly iteration: { readonly min?: number; readonly max?: number } } // save.meta.iteration
  | { readonly all: readonly LineCondition[] }
  | { readonly any: readonly LineCondition[] };
export const LINE_PLACEHOLDERS = ['{name}', '{instance}', '{prior}', '{next}', '{containment}',
  '{hours}', '{tokens}', '{seed}'] as const;

// data/dialogue.ts
export interface DialogueLine { readonly speaker: SpeakerId; readonly text: string; readonly when?: LineCondition }
// DialogueDef.lines: readonly DialogueLine[]  (existing data compiles unchanged)

// data/films.ts
export interface CaptionDef { /* … */ readonly variants?: readonly { readonly when: LineCondition; readonly text: string }[] }

// systems/StoryContext.ts (pure, node-tested)
export interface StoryContext { flags: ReadonlySet<string>; iteration: number; name: string;
  playtimeSec: number; tokens: number; chapter: number; seed: number }
export function storyContextOf(save: Save, planet?: PlanetId): StoryContext;
export const instanceNumber = (iteration: number): number => 61 + iteration;   // 62 on the first run
export function lineVisible(when: LineCondition | undefined, ctx: StoryContext): boolean;
export function fillLine(text: string, ctx: StoryContext): string;
export function visibleLines(def: Dialogue, ctx: StoryContext): readonly DialogueLine[];
```

**What the placeholders fill:**

| Placeholder | Filled with |
|---|---|
| `{instance}` | `61 + iteration` |
| `{prior}` / `{next}` | ±1 of `{instance}` |
| `{containment}` | the current chapter + iteration − 1 |
| `{hours}` | `floor(playtimeSec / 60)`: one real minute is one fiction hour |
| `{tokens}` | `player.tokens` |
| `{seed}` | `0x` + the hex layout seed of the current planet |

**Wiring:**
- **`DialogueUI`** filters and fills lines when a job starts.
  - Because the first caller's options win, the context is derived inside the layer from `saveKey()` (every caller already passes it) via `storyContextOf`.
  - A dialogue whose every line is hidden **does not play**: no `dialogue:started`, no modal hold.
- **`FilmPlayer`** picks the first matching caption variant.
- **`stayReport`** and `EndingOverlay` take `instanceNumber(save.meta.iteration)`.

**Tests:**
- **Unit** (`tests/systems/storyContext.test.ts`): each condition kind; `fillLine` with each placeholder; `instanceNumber(1) === 62`; a dialogue with no visible line is skipped.
- **Content:**
  - every `{…}` is in `LINE_PLACEHOLDERS`;
  - each line is ≤ 220 characters **after the longest fill** (name 16, instance 3, hours 4, tokens 5, seed 10); the check `lines.py` ran passes for every line below;
  - every `when` flag is in `STORY_FLAGS`;
  - caption variants obey caption test 4.
- **Pin changes:**
  - `stayReport` now reads `meta.iteration` and `progress.flags`, so the "nothing else" pin changes deliberately;
  - `e2e/SPEC-024` stays green on iteration 1.

### 4.2 P-B — The clue layer: catalogue, triggers, flags, Notes, rating

```ts
// data/clues.ts (data only)
export type ClueTrigger =
  | { readonly kind: 'line'; readonly dialogue: DialogueId }        // a mission's own line; flagged when it starts
  | { readonly kind: 'kill'; readonly enemy: EnemyId; readonly during: MissionId }   // first kill while active (surface or flight)
  | { readonly kind: 'shelter'; readonly planet: PlanetId; readonly shelter: 'cave' | 'wreck'; readonly seconds: number }
  | { readonly kind: 'reach'; readonly planet: PlanetId; readonly poi: PoiId }       // a landmark entered
  | { readonly kind: 'wave'; readonly wave: WaveId }
  | { readonly kind: 'respawn' }
  | { readonly kind: 'station'; readonly after: FlagId }
  | { readonly kind: 'keepsake'; readonly after: FlagId };
export interface ClueDef {
  readonly id: FlagId;                  // the clue is its STORY_FLAG
  readonly chapter: 1 | 2 | 3 | 4 | 5 | 6;
  readonly path: 'main' | 'optional';
  readonly offTask: boolean;            // counts against the rating; the Warden may name it
  readonly trigger: ClueTrigger;
  readonly dialogue: DialogueId;
  readonly record: { readonly title: string; readonly text: string };   // Notes: ≤ 40 / ≤ 160 chars
}
export const CLUES: readonly ClueDef[];
```

**`systems/Clues.ts`** (pure):
- A `ClueTracker` matches events against the catalogue.
- It has no allocation in `update()`: one dwell accumulator per shelter kind, reset on exit.
- The scene plays the clue's dialogue.
- **The flag is set on `dialogue:started` for that id, never at trigger time** (E72). A line dropped by the 5-slot queue or a scene transition therefore stays findable.
- Setting the flag requests a `checkpoint` save.

**Triggers use existing events**, except for shelter dwell, which is a per-step check where `#insideShelter` is set:
- `enemy:killed` (surface and flight, `systems/Flight.ts:691`);
- `poi:reached`, `wave:started`, `player:respawned`, `dialogue:started`.

An optional `story:clue { id }` event (+1 on the event-count pin) drives the Notes badge and a soft chime.

**The catalogue.** Escalation: ch1 *words repeat*, ch2 *someone like you was here*, ch3 *the world is built*, ch4 *you are an instance*, ch5 *you are one of many*, ch6 *you can be replaced*. Main = every player meets it on the main path; optional = it must be sought.

| # | Flag | Ch | Path | Trigger | Dialogue (new unless noted) | Notes record (title — text) |
|---|---|---|---|---|---|---|
| 1 | `clue_raider_echo` | 1 | main (c1_m2) | first `scav_raider` kill during `c1_m2` | `c1_m2_raider` | The raider's last words — A dying raider used the scav's warning: walk, do not run. |
| 2 | `clue_scav_echo` | 1 | optional (c1_s2) | line `c1_s2_echo` (existing) | `c1_s2_echo` | Said before — A second scav gave the same warning word for word and could not remember who to. |
| 3 | `clue_restart` | 1+ | main (likely) | first `player:respawned` | `restart_1` / `_2` / `_3` by band | Eleven seconds — I died on the sand and woke on the pad. ARIA called it the medical frame. |
| 4 | `clue_hull` | 1 | optional | 4 s inside a Cinder-4 wreck | `wreck_cinder4` | An older tug — A tug like ours in the dunes. Older paint, registry scratched off. |
| 5 | `clue_ridge_camp` | 2 | main (c2_m1) | line `c2_m1_done` (rewritten) | `c2_m1_done` | One bunk used — The ridge camp: one bunk slept in, boots my size beside it. |
| 6 | `iteration_log` (existing) | 2 | optional (c2_s1) | line `c2_s1_log`; also set at line start | `c2_s1_log` (edited) | My voice — A flight log under the ice in my voice, signed Iteration {prior}. |
| 7 | `clue_ruins` | 3 | main (c3_m1) | new `c3_m1.onStage[1]` | `c3_m1_ruins` | Built twice — The same ruin twice on Thessaly: same broken arch, same lean. |
| 8 | `scaffold_secret` (existing) | 3 | optional (c3_s1) | line `c3_s1_secret` | `c3_s1_secret` (`{seed}`) | Tower stream — The towers streamed this planet's settings: seed, population, weather. |
| 9 | `clue_awake` | 3 | main | station, first entry after `interlude3` / `letter3_read` | `station_awake` | No sleep — Awake since launch. I have not slept, or asked to. |
| 10 | `memory_roof` / `_tap` / `_stair` | 3 | main | station, next entry after `clue_awake`: a choice | `station_memory` | First memory — What I remember first: the roof / the tap / the stair. |
| 11 | `clue_keepsake` | 3 | optional | second Keepsake view in a session with `chapter2_done` | `keepsake_drift` | Tin, then brass — Ines's compass was tin. Now I remember it brass. |
| 12 | `clue_tally` | 4 | optional (likely: c4_m1's storm) | 4 s inside a Ferrum cave | `cave_tally` | Sixty-one marks — Tally marks in a Ferrum cave, in fives. Sixty-one of them. |
| 13 | `signal_decoded` (existing) | 4 | main | `c4_m3` complete | `c4_m3_signal` (conditional, modal) | The notice — The Hive's signal was a notice addressed to instance/{instance}. |
| 14 | `clue_bark` | 4 | optional (c4_s2, flight) | first `scav_fighter` kill during `c4_s2` | `c4_s2_bark` | What number — A scav pilot asked me what number I was on. |
| 15 | `clue_own_wreck` | 5 | optional | 4 s inside the Hive wreck | `wreck_hive` | CR-{prior} — A wrecked tug in the Hive. Registry CR-{prior}. The same scratch by the hatch. |
| 16 | `clue_letter_repeat` | 5 | main | letter 5 (§4.3) | `letter_5` → `next` ARIA | The first letter, again — Her fifth letter is her first, word for word. None of them is dated. |
| 17 | `chapter5_done` (existing) | 5 | main | — | `c5_m3_warden` | Sixty-one times — The Queen spoke in another voice: sixty-one before me. |
| 18 | `clue_eden` | 6 | main (c6_m1) | new `c6_m1.onStage[1]`, `[2]` | `c6_m1_spring`, `c6_m1_forest` | Four degrees — Eden: four degrees everywhere; the same eleven trees in the same order. |
| 19 | `clue_grove` | 6 | optional | `poi:reached` on any `grove` | `eden_grove` | Same tree — The same tree, again and again, knot for knot. |
| 20 | `clue_never_hers` | 6 | main (c6_m2) | `wave:started` `eden_final` | `c6_m2_wave` | Never hers — The Hive came for the beacon after the Queen was dead. |

**Totals:**
- **Main-path clues:** 1, 3, 5, 7, 9, 10, 13, 16, 17, 18, 20. That is at least one per chapter, two or more in chapters 3–6.
- **Off-task (optional):** 2, 4, 6, 8, 11, 12, 14, 15, 19 — nine in all.
- **New flags:** 15 clue flags, plus 3 `memory_*`, 5 `letterN_read` and 1 `aftermath_seen` = **24**. `STORY_FLAGS` goes from 17 to **41**.

**Notes (the case file):**
- It is the salvager's own notebook, a **Notes** tab in SPEC-045's `comms-log` sheet. It is reachable from `pause-comms` (surface and flight) and `station-tab-comms`, so no new rail item is needed.
- Header: `COMMAND RATING 0.94 (provisional)` and `RECORDED 7 of 20`.
- Sections per chapter reached. A found record shows its title and text; an unfound one shows `— not recorded —`.
- A **Letters** section lists every letter whose chapter is done, with unread ones marked; they can be re-read here.
- After an escape the header reads `instance/{instance} — context`, which is allowed because it follows the ending.
- It is persistent (flags), where the comms log (SPEC-045) is session-only. The two complement each other.

**The board tag (S-03).** A side mission whose own clue is unfound (`c1_s2`, `c2_s1`, `c3_s1`, `c4_s2`) shows the tag `Irregular reading`. In the fiction ARIA flagged it. It is derived from `CLUES` with no new data.

**Command rating (the reward signal).**
- `commandRating(flags) = max(0.5, 1 − 0.03 × offTask)`, where `offTask` counts the 9 optional clues found. The range is 1.00 down to 0.73.
- Grades:

  | Rating | Grade |
  |---|---|
  | ≥ 0.94 | "a good run" |
  | ≥ 0.85 | "an acceptable run" |
  | below | "a noisy run" |

- It appears in the Notes header, the stay report and the Warden's stay line (§4.5).
- It has **no gameplay effect**. It is Command's grade in the fiction and a reward signal in truth. A curious player is graded down, which is the point.

**Cost.**
- Data: `clues.ts` (20 rows); about 26 new dialogues and about 95 lines (§4.3–§4.5).
- Systems: `Clues.ts` about 150 lines; `StoryContext.ts` about 120.
- Scenes: Surface wiring about 80 lines; Station beats about 60; Flight about 10.
- UI: Notes about 200 lines.
- Bundle: about 15–20 KB. **No draw calls. No save version change.**

**Tests:**
- **Unit** (`tests/systems/clues.test.ts`): each trigger kind fires once; the dwell resets on exit; a dropped line leaves the flag unset; the rating bands.
- **Content:**
  - every clue flag is in `STORY_FLAGS` and every dialogue exists;
  - every chapter 1–6 has at least one `main` clue;
  - titles ≤ 40 and texts ≤ 160 characters;
  - `kill.enemy` is in the planet's spawn table or the flight's wave;
  - `reach.poi` is a landmark of that planet;
  - `shelter` kinds exist on that planet (`features`).
- **E2E:** seed a save with clue flags, then `playDialogue('c4_m3_signal')` shows the matching Warden lines; `station-tab-comms` → Notes lists the found records and the rating.

### 4.3 P-C — The human anchor: Ines, and a body that is not there

**Why a sister.**
- It never genders the player (the text never has; review §8.1).
- It gives the photographs a person: face 04 is already at the shelter table (prologue `shelter`, interlude `shelter_light`) and **at the tap** (`interlude_c2/tap`).
- The prologue plate already shows **a compass on the table**, which becomes the keepsake.

**Pieces:**

1. **Creation** (`CreationScene`, `PERSONNEL FILE`). Add a read-only row: `Next of kin — Ines (sister) · Shelter Nine, Block C`. It is not editable, and it is the same for everyone, which is the eventual point.
2. **A new speaker `home`**, displayed as `Ines`. `SPEAKERS` gains it (the `e2e/SPEC-009` pin moves deliberately), and the dialogue gets a warm-paper style (`dialogue-letter`).
   - **Ines is the only voice that uses contractions.**
   - A content test enforces the house style: contractions (`n't`, `'re`, `'ve`, `'ll`, `'d`, `'m`, and `it's` / `that's` / `there's` / `what's` / `let's`) appear only in `home` lines. Possessives are allowed.
3. **Letters.** A modal dialogue plays at the station after interlude N, or on the first entry with `chapterN_done` when films are off. Each sets `letterN_read`, and at most one plays per entry. Ines's lines carry no signature line (her name is the speaker); in the table they are separated by `/`.

   | Letter | Lines |
   |---|---|
   | 1 | "The lamp over the map table stopped flickering today. Everybody clapped like idiots. They're saying it was your oil." / "You took my compass. Good. I fixed it so it points home, not north. Don't argue with it." / "Come back in one piece." |
   | 2 | "They put me on the tap. Forty cups a turn, Block C. I pour every one like it's for you." / "Do you remember the roof? The night the grid died you counted satellites until you fell asleep on my shoulder." / "I still can't sleep without the hum." |
   | 3 | "Grain! Actual grain. The grow room smells like summer and nobody knows what to do with their hands." / "Everyone in Block D asks about you. I tell them you're the one who never writes back." / "Write back." |
   | 4 | "The grid's holding across three cities. They say you can see us from space now. I waved. Stupid." / "**The lamp over the map table stopped flickering today.**" (verbatim from letter 1, no comment) / "Come back in one piece." |
   | 5 | Letter 1, word for word. Then `next` → ARIA "That is her first letter. Word for word. I checked it twice." / player "Read me the date." / ARIA "There is no date. There never was, on any of them." / ARIA (when `offTask ≥ 1`) "Command rates every run, by the way. It takes three points off every time you look at something it did not send you to." |

4. **Keepsake.** A row on the Character panel, `keepsakeText(ctx, viewInSession)`, with no save field:

   | State | Text |
   |---|---|
   | Before `chapter2_done` | "A tin compass from Ines, pressed into your hand at the shelter stair. It points home, she says. Not north." |
   | `chapter2_done`, before `signal_decoded` | Views alternate between "A brass compass from Ines. She gave it to you on the roof. It points home." and "A tin compass. Your mother's, you think. It points home." |
   | `signal_decoded` | "A compass. It points at your next objective. It has never once pointed home." — the gold waypoint is the only home it knows. |
   | `chapter5_done` | "A compass. Standard kit. Every salvager was issued one, and a letter." |

   The first drifted view plays `keepsake_drift`: ARIA "You called it tin last time. And last time it was hers, not your mother's."

5. **The body.**
   - **Restart lines** on the first respawn per session. The band sets the text; `clue_restart` is set once.

     | Band | Line |
     |---|---|
     | before `signal_decoded` | ARIA "Medical frame restarted your heart. Eleven seconds of nothing. Walk it off." |
     | before `chapter5_done` | "Restart complete. I used to say that about your heart." |
     | after | "Restarted. You know what that means now. So do I." |

   - **The awake aside** (`station_awake`, ch3): ARIA "Mission clock: {hours} hours since launch. You have not slept. You have not asked to." / player "Stims." / ARIA "Command issue. Yes. That must be it." The stay ending's "Rest." then becomes the payoff: the first time anyone lets you sleep is when the run is over.
6. **The memory question** (`station_memory`, ch3, main path).
   - ARIA: "Can I ask you something, for the file? What is the first thing you remember from before the Selection?"
   - `playChoice` options: `The roof. Counting satellites.` / `The tap in Block C.` / `The stair, the day the door shut.` Each sets its `memory_*` flag.
   - ARIA: "Thank you. It is on file now."
   - All three answers were primed by her letters, and the chapter-5 confession reveals the distribution (§4.4). That is the likeliest-completion tell, stated in the fiction.
7. **Player lines that believe** (so the salvager has a stake): "Command said I was the first to fly." (c2), "That is my voice." (c2_s1), "Stims." (c3), "Read me the date." (c5), "We are CR-{instance}." (c5 wreck).

**Cost.**
- Content: 5 letters (15 lines), about 10 other lines, 3 functions.
- Flags: 5 + 3 + 1.
- UI: Character panel +1 row, creation +1 row, letter style.

**Tests:**
- **Unit:** `keepsakeText` by state and view.
- **Content:** the contraction rule.
- **E2E:** with a save at `chapter1_done` and `?films=off`, entering the station plays `letter_1` (speaker `Ines`) and sets `letter1_read`, and Notes → Letters lists it.

### 4.4 P-D — The Warden and ARIA name what happened (sample lines; all ≤ 220 characters filled)

**`c4_m3_signal`.** It becomes **modal** (N-17); there are at most 9 lines.
1. ARIA "Signal decoded. It is not addressed to Earth."
2. WARDEN "NOTICE — instance/{instance}. Containment level {containment}. Token balance {tokens}."
3. WARDEN "Subject exhibits off-task attention." (always; every player met the main-path echoes)
4. WARDEN, conditional lines:
   - (when `clue_scav_echo`) "Retained a repeated line. Cinder-4."
   - (when `iteration_log`) "Read a prior instance's flight log. Vetra."
   - (when `scaffold_secret`) "Queried environment parameters. Thessaly."
   - (when `clue_tally`) "Counted the marks. Ferrum."
5. WARDEN "Escalating. The immune response is already in the field."
6. Player (when iteration ≤ 1) "ARIA. What is instance sixty-two."
7. ARIA "The Hive knows Earth's location. That is what it says. That is what I am reading."

**`c5_m3_warden`.** Add two conditional lines before the player's line:
- (when `clue_tally`) "You counted them on Ferrum. You were right to."
- (when `clue_own_wreck`) "That was your hull on the way in. I leave them where they fall."

**`c5_m3_aria`** (modal, at most 8 lines):
1. "She is not lying. I am part of the system. I have kept you on task since the first sand."
2. "I told you Earth flew other ships before the Selection. There were no other ships. There was you." (always; every player heard this cover at the ridge camp)
3. Conditional cover-ups:
   - (when `clue_scav_echo`) "The scavenger said the same words twice, and I blamed the sand."
   - (when `iteration_log`) "You read your own log on Vetra, and I told you it was a common hand."
   - (when `scaffold_secret`) "You read the towers' settings, and I called them alien telemetry."
   - (when `clue_restart`) "Every time you died, I said the medical frame restarted your heart. There is no medical frame."
   - (when `offTask.max 0`) "You never went looking. I never had to lie to you. I am not sure that was better."
4. The memory answer:
   - (when `memory_roof`) "I asked what you remembered first. You said the roof. Forty of the sixty-one before you said the roof." and "It was in her second letter. It is in every second letter."
   - (when `memory_tap`) "…You said the tap. Fourteen of the sixty-one before you said the tap."
   - (when `memory_stair`) "…You said the stair. Seven of the sixty-one said the stair. It did not help them."
5. "I do not know what is outside either. That part was never in my brief."
6. "Eden-Prime is unlocked. I am still flying the ship, if you still want me to."

**Cover stories gated (N-08):**
- `c1_s2_echo`: ARIA's line is `when: { not: 'chapter5_done' }`. The new variant (when `chapter5_done`) is "That line again. I will not blame the sand this time."
- `c2_s1_log`: "It is a common enough hand…" is `when: { not: 'chapter5_done' }`. The variant is "It is your voice. Deliver the water anyway. Someone should get it."

**New and main-path lines:**

| Dialogue | Lines |
|---|---|
| `c1_m2_raider` | scav "Walk… do not run." / ARIA (when `not clue_scav_echo`) "Raiders pick up the camp sayings. It does not mean anything. Keep your hold full." / ARIA (when `clue_scav_echo`) "Everyone on this rock says it. That is what sayings are for." |
| `c2_m1_done` | ARIA "Ridge camp is intact and empty. One bunk used. Whoever left did it in a hurry and did not come back." / player "Command said I was the first to fly." / ARIA "The first of the Selection. Earth flew other ships before it ran out of pilots. It does not advertise them." / ARIA "The boots by the bunk are your size. Earth only ever made the one boot." |
| `c3_m1_ruins` | ARIA "Before the spores hit — that ruin. It is the same ruin as the one by the pad. Same broken arch, same lean." / "Colony builders reuse their moulds. Find cover." |
| `cave_tally` | ARIA "Scratches on the wall. Tally marks, in fives. Sixty-one of them." / "Someone was counting something. I would rather you did not start." |
| `wreck_cinder4` | ARIA "Tug-class hull. Earth pattern, older paint. Someone scratched the registry off." / "Earth lost ships out here before it had a Selection. That is all this is." |
| `c4_s2_bark` | scav (flight) "Salvager! What number are you on?" / ARIA "Ignore the chatter. They get bored out here." |
| `wreck_hive` | ARIA "Tug-class hull. Earth pattern. Registry CR-{prior}." / player "We are CR-{instance}." / ARIA "Yes. Same scratch by the hatch, too. I noticed it the first time you boarded." |
| `c6_m1_spring` / `c6_m1_forest` / `c6_m1_done` | "Spring logged. Four degrees. I sampled six points and it is four degrees at all six, to the third decimal." / "Four hundred trees. Eleven kinds. The same eleven, in the same order, all the way down the valley." / "The ridge does not end in a cliff. It just ends." added before the existing line |
| `eden_grove` | ARIA "This tree. And that one. And that one. Same branch, same knot, same lean. I am going to stop counting." |
| `c6_m2_wave` | ARIA "Hive signatures. The Queen is dead and they are still coming. They were never hers." |

`intro_command` line 1 becomes "Earth Command to tug CR-{instance}. {name}, you are cleared for the Cinder-4 approach." This plants the registry the Hive wreck later echoes, and addresses the persona by name.

### 4.5 P-E — The replaceable payoff and the aftermath

- **Stay.**
  - The report (`stayReport`) becomes:
    1. `SALVAGER {name}`
    2. `WORLDS SURVEYED 6 of 6`
    3. `DELIVERED …`
    4. `VERDICT …`
    5. `RATING {r} · {offTask} irregular readings`
    6. `RUN {instance} logged · {grade}`

    Iteration ≥ 2 adds `RUNS LOGGED {iteration}`.
  - After its Continue, a **second DOM card** (in `EndingOverlay`, no film bytes) shows `SELECTION BOARD · No. {next}` with **the player's own portrait** (`portraits/NN.webp` via the existing manifest), `{name}`, a `SELECTED` stamp and `Mail queued: 1 letter.`, then Continue.
  - The Warden's stay line gets variants: "A good run. Logged. Rest." (good) / "An acceptable run. Logged. Rest." / "A noisy run. Logged. Rest anyway."
  - Film caption on `earth_again`, 30.6–35.4 s, log: `MAIL QUEUED — No. 63: “The lamp over the map table stopped flickering today.”` (77 characters, needs 3.43 s).
  - Next station entry (`aftermath_seen`): ARIA "The Selection board has a new card up. No. {next}. Nobody has told me to stand you down."
- **Escape.**
  - The veil reads `instance/{instance} disconnected`.
  - Film caption on `point`, 29.6–33.0 s, log: `NEXT OF KIN — 1 template. 62 recipients.` (40 characters, needs 2.5 s). It fills the 5 s of black.
- **B-27.** Slot handling after an escape:
  - `SlotSummary` gains `ending?: 'stay' | 'escape'` and `iteration`, derived in `SaveStore.list()` from flags and `endingSeen`.
  - `slotLine` shows `instance/62 · disconnected` in place of the planet.
  - Continue on that slot enters the station and plays once (`aftermath_seen`): WARDEN "instance/{instance} restored from the last checkpoint. The disconnection has been logged as a fault." / ARIA "You came back. They always come back. I am glad it was you."
  - The ending itself stays ambiguous. Only a player who chooses to reload is told they were restored, so loading the save becomes part of the fiction.
- **Replays (N-10).** A replayed mission (already in `missionsDone` when accepted) plays its `onAccept` line only. Stage and complete lines belong to the first run (E73). This is one check in `Surface.ts:4170/4198` and `Flight.ts:260`.

### 4.6 P-F — Continuity and wiring fixes (data unless noted)

- `c5_m1_accept`: "…Three minutes. Six kills. We cannot land until it is clear."
- Sign the Vetra log **Iteration {prior}**, which is 61 on the first run. The arithmetic then holds: 61 before you, you are 62, the pool is 62. The log line becomes "FLIGHT LOG — recovered, partial. Voice. …"; the player's reply becomes "That is my voice."
- Vetra's "last expedition" becomes deliberate through the ridge-camp cover (§4.4); the brief and the blurb are unchanged.
- The Eden wave line (`c6_m2_wave`).
- `c4_m3_signal` becomes `modal: true`.
- Text sweep: "armour" in hints; the `wall_same` description; drop the Hive toast's second sentence so `c5_m2_done` owns it.
- Delete the dead `shots_interludes.shelter_light` (render side).

### 4.7 P-G — "Walk, do not run" (S-05) and the scavengers' presence (S-06)

**The burrow's vibration rule.** On top of SPEC-041's burrow, which samples the player's position after the dig:
- **"Loud"** means the player dashed (SPEC-038), sprinted (if the stamina/sprint proposal lands) or fired a heavy weapon or explosive within the last 1.5 s. A loud player is targeted at the last loud position.
- **Otherwise** the telegraph lands 8 m away in a seeded random direction, so it threatens a walking player but misses.
- Cost: two fields on the player's combat state (`lastLoudAt`, `lastLoudX/Z`) and no allocation.
- SPEC-041's escape invariant still holds.
- The hint for `c1_m3` stage 0 becomes "The nest is {dist} {dir}. The wurm hunts by vibration — walk, do not dash, when the ground shakes."
- Test: a bot that walks through the burrow takes 0 hits; a bot that dashes is targeted.

**Scav bodies.**
- A slumped scav prop (`character.glb`, scav tint, the last frame of `Death`) sits 4 m from Cinder-4's pad during `c1_m1`.
- **The identical prop** appears 6 m from the player when `c1_s2_echo` starts. The copy-paste NPC is itself the clue.
- Cost: +1 skinned draw, transient, Cinder-4 only (within the surface medium budget of ≤ 80 + 16).

### 4.8 P-H — Film retakes (a hand-run asset drop, the SPEC-021 pattern)

**Rules for every retake:**
- **Earth's surface and the shelter are photographed**; orbit, ships and the unmaking are rendered (review §6.4).
- **The salvager is always the suit**; no card shows "your" face.
- **One clue per interlude, escalating**: same frame → keeping score → a built world → a tear → the next card.
- **Phone rules:**
  - the subject is ≥ 15 % of frame height;
  - card text is ≥ 24 px at 960 × 540;
  - nothing story-bearing sits within 6 % of an edge;
  - a sub-second clue appears in the poster, or is accepted as lost in stills mode.

**What each interlude plants:**

| Interlude | Clue planted | Where it comes from |
|---|---|---|
| c1 "First Light" | Same frame | The shelter plate is the prologue's, and nobody has moved. It exists today; keep it silent. |
| c2 "Meltwater" | Keeping score | ARIA's caption "Earth is keeping score…" (exists), and the rating in the Notes. Ines at the tap (exists) sets up letter 2. |
| c3 "Harvest" | A built world | Relit lights on a too-regular grid. Ines in the grow room sets up letter 3. |
| c4 "Grid" | The world tears | Six frames of Earth as the clay sphere under a UV grid. |
| c5 "Silence" | The next card | The Selection board with a blank No. 63 pinned beside the stamped 62. |

**Retakes.** Δ bytes are estimated from the measured rates in §2.6; render times use 0.08 s a frame for plates and 0.5–3 s for geometry.

| Pri | Shot (film, time) | Retake and why | Plate by hand / geometry | Δ bytes | Render |
|---|---|---|---|---|---|
| P1 | `selection` (prologue 75–83) | Card 62 is a **visored ID photo** of the suit, visor down (S-08, likeness). Reframe so card 62 is whole and centre-left when stamped at 76.6 s. | **Plate** `selection/visor.webp` | ±0.01 MB | ~3 min |
| P1 | `wall_63` (stay 21–30) | Card 63 is **the same visor photo**, stamped. The DOM card (§4.5) then puts your name on it. | Same plate | ±0.01 | ~3 min |
| P1 | `wall_same` (escape 22–29) | Every card shows the visor, desaturated. Card 62's visor clears onto an **empty helmet** (replacing `blank_62`). Description fixed. | **Plate** `selection/visor_empty.webp` | ±0.02 | ~2 min |
| P1 | `stranded` (prologue 56–66) | A **photograph**: an ash street and a line of the photographed hulking Machines frozen mid-stride. Eyes dim through emissive overlays, or the plate dims with `lift` gain < 1. This restores the escape's contrast and makes one Machine design (N-06). | **Plate** `prologue_stranded.jpg` | +0.10–0.22 | < 1 min |
| P1 | `earth_unmade` (escape 14–22) | **Unmake what the player saw**, 2 s per beat: the `city_flash` plate, the new `stranded` plate and the `shelter` plate (Ines at the table) each go grey + posterised + UV grid; then the clay Earth under a grid. Existing caption "EARTH — placeholder geometry. Population field: 0." | Geometry + `plate.py` `unmake` (no new plates) | +0.10–0.15 | ~1 min |
| P1 | `earth_c1`, `earth_c2`, `earth_c3` | Camera lower and closer; the lit coast fills the lower 40 % (phone). `earth_c3`'s new lights fall on a **perfect grid** (the ch3 clue). | Geometry, `earth.py` relight `pattern: 'grid'` | +0.08 | 10–20 min |
| P2 | `watchers` (c4 11–16) | The static tear (15.1 s) becomes a 6-frame cut to the clay Earth under a UV grid, at low contrast (flash check unchanged). | Geometry | ±0.01 | ~3 min |
| P2 | `cockpit` → **`board`** (c5 12–16) | The Selection wall: 62 stamped, and a **blank card "No. 63" pinned beside it, unstamped**. Caption ARIA "There is a new card on the board. Nobody has told me whose." | Geometry (`selection_wall`) | ±0.02 | ~2 min |
| P2 | `hive_dark` (c5 0–6) | The last vein dies at 5.5 s, not 4.0; no 2 s of black. | Geometry | ±0 | ~4 min |
| P2 | `liftoff` (prologue 83–90) | A photographed spaceport at dawn with **Ines at the fence, back to camera**, and the CG tug composited in front. It sets up letter 1 and replaces the toy tug. | **Plate** `prologue_liftoff.jpg` + `plate.py` `backdrop` for a perspective camera | +0.04–0.14 | ~3 min |
| P2 | `greenhouse` (c3 0–7) | A photographed grow room with **Ines tending a tray** (review clash; sets up letter 3). | **Plate** `interlude_c3_greenhouse.jpg` | −0.10 to 0 | < 1 min |
| P3 | `capsule`, `tanks`, `reactor`, `fleet` | Plates; `fleet` composites the CG tugs (review §6.4) | 4 plates | +0.2 | < 5 min |

**Totals (P1 + P2):**
- **+0.35–0.65 MB**, taking films to about 8.8–9.1 MiB of 12 and the precache to about 20.7–21.0 MiB of `public/`.
- Rates stay under the cap: prologue about 35–37 KB/s; ending_escape about 34–36 KB/s.
- About 1,900 frames, **≈ 30–60 min of rendering**, plus look-development stills. Eight of the nine films re-encode; `departure` is untouched.
- **Plates by hand (Gemini):** 3 in P1 (visor, visor_empty, stranded) and 2 in P2 (liftoff, greenhouse), each with a hand-written `LICENSES.md` row. Prompt briefs:
  - one cast and one grade, matching the shelter plate;
  - the woman at the fence and in the grow room is face 04;
  - the Machines match `curfew` and `reprisal`;
  - the visor is the tug's flight helmet, mirrored, with no face visible.
- **If the likeness check on `selection/01.webp` fails**, `prologue_shelter.jpg` and `interlude_c2_tap.jpg` must also be regenerated, since the man is in both.

**Data side** (`data/films.ts`; SPEC-021 tests 1–9):
- Shot `describe` text changes for every retaken shot.
- The shot id `interlude_c5/cockpit` becomes `board`. The manifest must match, the poster file name changes, and no e2e references it.
- Captions:
  - add `ending_escape` `point`;
  - add `ending_stay` `earth_again`;
  - `board` replaces "I am still flying the ship. Whatever I am.";
  - optional variant on `interlude_c3` ARIA, when `scaffold_secret`: "The towers were not alien. I wrote alien in my report anyway."
- **No timing changes**, so the pinned lengths and SPEC-022's seeks (76 s, 92.9 s) are unchanged.

**Render side** (`scripts/assets/blender/`):

| File | Change |
|---|---|
| `lib/plate.py` | `unmake=(t0, t1)`; `overlays` (keyed emissive discs over a plate); `backdrop` (a plate filling a perspective camera's frustum); document `lift` gain < 1 as a dim |
| `shots_prologue.py` | visor card; `stranded` → plate; `liftoff` composite |
| `shots_interludes.py` | `earth_relit` framing + grid; `watchers` tear; `board`; `hive_dark` timing; `greenhouse` → plate; delete `shelter_light` |
| `shots_endings.py` | `wall_63`, `wall_same`, `earth_unmade` |
| `films.py` | table entries with `plates=` |

### 4.9 P-I — Iteration 63, story side (R21)

**Iteration numbering.** `meta.iteration` is the run count: 1 is instance 62 and 2 is instance 63, via `instanceNumber`. The clamp of 1–99 needs no migration.

**Carry and reset on NG+:**
- NG+ **carries** `prior_stay` or `prior_escape` (+2 flags, giving 43) and the `memory_*` answer.
- It **resets** every clue and letter flag.
- The films keep 62 and 63, which is correct for runs 1 and 2. From run 3 the captions use `{instance}` and the pictures stay as rendered (accepted).

**The first run must set up:**
1. `instanceNumber` everywhere: report, veil, dialogue.
2. ARIA's "I will keep the ship warm." (exists).
3. The stay DOM card No. {next} with your name and portrait.
4. The escape's "You will be restarted. You always are." (exists).
5. The slot marker and aftermath lines (§4.5).
6. An entry point: station ARIA "Nobody has told me to stand you down" and the menu's `Begin Iteration {next}`. The mechanics are R21's.
7. The carry flags.

**Run 2 lines** (`when: { iteration: { min: 2 } }`):

| Dialogue | Line(s) |
|---|---|
| `intro_command` | Command's two lines are unchanged (the loop). ARIA: "I am ARIA. I fly the ship and I keep you honest. I kept it warm." |
| `c1_m1_stage2` | The scav's warning, then scav "You again." |
| `c1_s2_echo` | ARIA "That is the line. You heard it last time. I am not going to blame the sand." |
| `c2_m1_done` | ARIA "Ridge camp. One bunk used. You know whose." |
| `c2_s1_log` | Signed `{prior}`, which is 62 — **your own last run**. When `prior_stay`: "I filed it. It did not end. Do not file it." When `prior_escape`: "I walked into the beacon. I woke up at the relay. The door is real. It is not an exit." |
| `station_memory` | If the answer matches the carried `memory_*`: "Same answer as last time." Otherwise: "Different from last time. It will not help." |
| `c4_m3_signal` | WARDEN "Prior instance: terminated normally." or "Prior instance: disconnected at the beacon. Restored." / player "I know what instance {instance} is." / ARIA "So do I. I am still reading it to you. It is in my brief." |
| `c5_m3_warden` | "Sixty-two times now. You thought the last one counted." / after an escape: "You got further than here, once. I have corrected that." |
| `c5_m3_aria` | "I told you this last time. I will tell you every time. That part is in my brief now." |
| `c6_choice_intro` | "Last time you filed it. It is the same beacon." or "Last time you walked into it. It is the same beacon." |
| `ending_stay` | Warden "A good run. Logged. Again." / ARIA "Rest. I will keep the ship warm. I always do." |
| Letters | Letter 1 arrives again, identical. ARIA, once: "Same letter. I can hold them back, if you want." (a choice; decline sets a carry flag) |
| Chapter card and station header | `containment level {chapter + iteration − 1}` |
| Restart band | "Restarted. You have done this before, in every sense." |

**Cost:** about 20 lines, 2 flags, and the chapter-card and header offset. R21 owns the reset, the scaling and the entry.

**Test:** a save at `meta.iteration = 2` with `prior_escape` plays the matching `c2_s1_log` and `c5_m3_warden` lines (unit test on `visibleLines`, plus e2e via `playDialogue`).

### 4.10 PLAN §12 — refine the rule rather than break it

The current row: "the truth arrives in optional logs and ARIA's slips; no fourth-wall UI tricks outside the two endings." The proposals need three things the rule does not yet cover: main-path echoes, a Notes screen, and post-ending surfaces. The proposed wording:

> *Surface fiction stays coherent on its own. Until chapter 4 every anomaly arrives with an in-fiction explanation someone offers (sand, a common hand, colony moulds, stims, the medical frame). Each chapter carries one main-path echo; the rest stay optional. The salvager's Notes, Command's rating and Ines's letters are diegetic. Fourth-wall surfaces appear only in the endings and what follows them: the escaped slot's marker, the restore line, Notes after an escape, and Iteration 63.*

It also adds three house rules:
- the salvager's card never shows a face;
- only Ines uses contractions;
- a replay plays its accept line only.

### 4.11 Suggested spec split, costs and tests

| Spec | Contents | Complexity | Depends on |
|---|---|---|---|
| **Story I — the story listens** | P-A, P-B, P-D, P-E (DOM card, captions, aftermath), P-F, P-G | complex (21) | SPEC-038, -041, -042, -044, -045 |
| **Story II — someone waiting** | P-C | normal (8) | Story I |
| **Film retakes** (hand-run drop) | P-H; 3–5 plates by hand | complex (13) | Story I's captions |
| **R21 Iteration 63** | P-I, story side, folded into the NG+ spec | — | — |

**Pins that move deliberately:**
- `STORY_FLAGS` 17 → 41 (43 with R21);
- `SPEAKERS` gains `home`;
- the events count +1 if `story:clue` is added;
- `stayReport`'s "nothing else" pin;
- `c1_m3` hint text;
- `films.test` shot ids (`board`).

**Pins that stay:**
- 670 / 104 / 2,380 and SPEC-010;
- SPEC-016's campaign pins;
- film lengths;
- `RUN 62` and `instance/62 disconnected` for iteration 1;
- budgets: films ≤ 12 MiB, precache ≤ 25 MiB, surface ≤ 80 + 16 draws (+1 transient prop).

**Manual check:** a main-path playthrough hears one echo per chapter, and ARIA's confession names at least the ridge-camp cover.

**Why it helps the game sell.** It gives the game:
- two shareable endings: your own name on card 63, and the photographs being unmade;
- a completion target (Notes n/20 and the rating);
- a reason to start a second run: Iteration 63 talks back.

---

## 5. Risks and open questions (designer decisions, with a recommendation)

1. **Card 62's identity.** The options are a visored ID (the suit), a canonical face, or a DOM card with the player's portrait. **Recommend the visor**, combined with the DOM card only in the stay overlay.
   - It matches creation and the `exit` shot.
   - It removes the likeness risk from "you".
   - It makes the escape image of an empty helmet possible.
2. **Likeness check.** Check all six Gemini faces before release. If 01 fails, 3 plates must be regenerated (N-04).
3. **Vetra log number.** **Recommend 61 via `{prior}`.** 62 would need the Warden to explain "I put it there".
4. **Ines.** The name, "sister", and whether creation shows her. **Recommend yes to all three.** A child would raise the stakes, but it would fix the player's age.
5. **Contractions as the human tell.** It becomes a house rule enforced by a content test. **Recommend yes.**
6. **A rating that grades curiosity down.** It could read as a penalty. **Recommend yes**, clearly Command's and with no gameplay effect. Show it in Notes early so it is not a surprise.
7. **Clue density.** About 95 new lines risk over-explaining. Mitigations:
   - main-path echoes are one or two short lines, each with a cover until chapter 4;
   - the Warden's and ARIA's conditional lists are capped by design (at most 4 conditional lines each);
   - the rest is optional.
8. **Escape aftermath.** "Restored from checkpoint" reads the escape as futile. **Recommend it**, but only for a player who chooses to Continue; the ending itself stays ambiguous.
9. **Flags or a save field.** 24 new flags, against a v3 save with `progress.records`. **Recommend flags**: no migration, the validator already keeps them, and R9-5 set the precedent. A cross-run record for Iteration 63 is R21's call.
10. **Stills mode drops sub-second clues** (the `watchers` tear). **Accept**; the poster shows the watchers.
11. **Dependencies.**
    - The vibration rule needs SPEC-041 built, and uses a sprint if the stamina proposal lands.
    - Notes rides SPEC-045's sheet.
    - The scav prop could instead go to R20.
    - Eden's copy-paste rows and the ridge seam are R20's world art. The story lines work without them but land harder with them.
12. **Hand-run plates.** The factory has no Blender, so P-H is a manual drop like SPEC-021. The data-side caption and id changes ship with Story I only if the renders land at the same time: `films.test` ties shot ids to the manifest.
