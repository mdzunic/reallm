# Fourth review — the story as a player meets it (prefix `S-`)

Auditor: story. Snapshot: `main` at `dfe6f04` (2026-10-07), specs at `25d3555`. Read-only; no file in either repository was changed, nothing was run but `git grep` and reading. Line references are repo-relative to `reallm-game` unless they start with `specs/`.

---

## 1. Verdict

1. **R19 landed almost in full, and run 1 is now coherent end to end.** Conditional lines, placeholders, the clue catalogue (26 records), Notes and Command's rating, Iris and five letters, the keepsake, the memory question, the restart lines, the modal chapter-4 notice that names what you found, the Warden's and ARIA's naming lines, the visored cards, the DOM Selection card, the aftermath lines and about twenty run-2 lines are all in the data. Every 61/62/63 on a first run agrees (§4). No `Ines` survives in either repository (`git grep -w Ines`: nothing).
2. **What is left is mostly seams between layers that later specs added without R19's cover discipline.** R20's vault shards (S-07), R21's Records list (S-08), R24's "Wreckers" film (S-12) and R25's suited raiders (S-05) each put a tell on screen before chapter 4 with no cover. Since PLAN §12 (R19 decision 5) says "until chapter 4 every anomaly arrives with a cover someone offers", these are rule breaks, not taste.
3. **The climax contradicts itself for the most obedient player.** A player who found no optional clue hears ARIA say "There were no other ships" (a lie she told), then "I never had to lie to you", then "There is no medical frame" (another lie she told) — three modal lines in a row (S-01).
4. **Chapter 6's main echo is upstaged by the flight.** "The Hive has gone quiet" is followed, on the very next flight, by Hive interceptors that nobody remarks on; ARIA notices "they were never hers" a whole landing later, after the mission brief has already announced the Hive (S-04).
5. **The scavengers are the biggest unexploited asset.** Since R25, Earth Command's first combat order is to kill six people wearing your suit, and since R24 every fighter is a tug like yours. Nothing ever says so — not even the confession (S-06). In chapter 1 nothing covers the suit either (S-05).
6. **The human illusion now holds on the main path, but only Iris carries it.** The salvager's 14 lines never mention her, her letter asks "Write back." and the game gives no way to, and the final choice never invokes her (S-11).
7. **Iteration 63 slips on numbers and covers.** "Sixty-one" is still hard-coded in the tally, two Notes records and the confession's memory line while the Warden says "62 times now"; SPEC-048 handed these to SPEC-058, which never picked them up (S-09). Run-1 cover lines play beside run-2 truths (S-10).

No finding is P0 or P1. The story is in good shape; most fixes are data edits with test pins that move deliberately.

---

## 2. What R19 (and SPEC-048/049/058) decided vs. what the code does

| Decision | Status | Evidence |
|---|---|---|
| Lines can carry `when` and placeholders; `instance = 61 + iteration` | Landed | `src/data/story.ts`, `src/systems/StoryContext.ts:118-120` |
| One main-path echo per chapter, each with a cover until ch4 | Landed on the main path; **broken off it** by R20/R21/R24/R25 additions | S-05, S-07, S-08, S-12 |
| ARIA's cover stories get variants after the confession | **2 of 6 covers** (`c1_s2_echo`, `c2_s1_log`) | S-03 |
| The Warden/ARIA name at most four found clues each | Landed (4 + 2 Warden, 4 ARIA conditionals) | `dialogue.ts:380-383, 478-479, 501-518` |
| Show the rating in Notes early | Landed, **with the grade words** "a good run" | S-16 |
| A replay plays its accept line only | Landed | `StoryBeats.ts:362`, `Surface.ts:1962, 7878, 7924`, `Flight.ts:338` |
| The card never shows a face | Landed (visor plates; creation portraits are helmets, `scripts/assets/blender/portraits.py:44-49`) | `films.ts:91, 285, 311` |
| Only Iris uses contractions | Landed and tested for dialogue, captions, cards, reveals | `tests/data/content.test.ts:2505-2535`; gap S-30 |
| Death explained (medical frame) | Landed as lines; **chrome still says "Respawning…"** | S-14 |
| `c4_m3_signal` modal | Landed | `dialogue.ts:370` |
| SPEC-048 decision table: "Keep 'Sixty-one' … SPEC-058 owns run 2's lines" | **Dropped by SPEC-058** | `specs/048-the-story-listens.md:273`; S-09 |
| R19 P-I: "the films keep 62 and 63, which is correct for runs 1 and 2" | **Wrong for run 2** | S-09 |
| R25-3: suited raiders cost nothing under the cover because ARIA says "the one boot" | **That line is in chapter 2**; the raiders are in chapter 1 | S-05 |

Line counts today: 207 lines — ARIA 110, Warden 29, Command 17, Iris 15, log 14, salvager 14, scav 7 (`grep speaker: src/data/dialogue.ts`).

---

## 3. The campaign as a player meets it

### 3.1 Before play

| When | What plays | Judgement |
|---|---|---|
| Menu → **Records**, on a fresh install | `Commendations — Earth Command`, with visible rows "Off-task — Record five irregular readings", "Scaffold — Read what the towers of Thessaly stream", "Said before", "A common hand", "Signal decoded", "Every irregular reading", "A good run — File the report with a command rating of 0.94 or better" (`src/data/commendations.ts:63-147`, `src/systems/Commendations.ts:51, 78-86`) | Leaks the Warden's vocabulary and the ending's shape before a single minute of play (S-08) |
| New Game → prologue "Blackout", 93 s | Command narration; card No. 62 stamped first (visored); a woman at the fence at liftoff; "You were the first of them to fly." (`films.ts:91-107`) | Strong. The only pre-play tell is the 62 |
| Creation | `PERSONNEL FILE · NEW SALVAGER`; `Next of kin — Iris (sister) · Shelter Nine, Block C` (`home.ts:13`) | Good anchor |
| Station | `intro_command` (modal): "Earth Command to tug CR-{instance}. {name}, you are cleared…" (`dialogue.ts:51-67`) | Good; plants the registry the Hive wreck echoes |
| First flight | "Outbound"; chapter card `CINDER-4 · Oil and grain under the dunes · containment level 1`; approach toast | "containment level" from minute one is accepted R2 design |

### 3.2 Chapter 1 — Cinder-4

| When | What plays | Judgement |
|---|---|---|
| Landing | `c1_m1_accept` (138 chars): "I put the tug on the pad. You were out of the hatch twelve metres early. Walk it off — …" (`dialogue.ts:74`); a slumped scav in the salvager's model lies by the pad (`Surface.ts:6135-6143`) | The first line of play is the clunkiest in the game (S-24) |
| Pad reached | `c1_m1_stage2`: scav "Off-worlder. Listen. The worms hunt by vibration — walk, do not run." / ARIA "He is dehydrated. Keep moving." | Good |
| `c1_m2` | Command "Raiders on the field are not your problem until they are." Kill 6 `scav_raider` (`missions.ts:162`) — since R25 people in **your suit** (`views/ScavRaiders.ts:89, 585`) | No cover for the suit (S-05); the implication is never used (S-06) |
| First raider kill | `c1_m2_raider` (main echo): "Walk… do not run." / ARIA "Raiders pick up the camp sayings…" (`dialogue.ts:99-110`) | Works; the cover is decent |
| `c1_m3` | "Do not run."; reveal "Walk, do not run. I mean it this time."; the Wurm now hunts by vibration (hint `hints.ts:298`); done: Command "Chapter closed."; ARIA "within expected parameters" | The signature line finally has a mechanic |
| Optional | `c1_s2_echo` (glitch, a second identical body); `wreck_cinder4`; Cinder-4 vault `shard_cinder4` "LOG — instance/58 …" | Echo plays non-modal as the storm wave's first group lands at 5 s (`waves.ts:65-75`) — easy to miss; the shard spells the twist (S-07) |
| First death | `restart_1`: "Medical frame restarted your heart. Eleven seconds of nothing. Walk it off." | Cover strains (S-13, S-14) |
| Station | debrief → interlude "First Light" → `letter_1` | Good |
| Notes | "Command rating 1.00 — a good run" from the first clue | Spends the stay ending's phrase (S-16) |

### 3.3 Chapter 2 — Vetra

| When | What plays | Judgement |
|---|---|---|
| First departure | "Outbound" → **"Wreckers"**: ARIA "Earth lost ships out here before the Selection. Somebody found them." (`films.ts:163`) → card → ~45 s: contact card, scav "Tug, drop your hold…", ARIA "The crews you met on Cinder-4, in tugs they stripped." (`dialogue.ts:272-278`) | Gives the ch2 cover before the ch2 echo asks for it (S-12) |
| Approach | "…The last expedition here did not come back." (`planets.ts:245`) | Good |
| `c2_m1` done (main echo) | "One bunk used." / salvager "Command said I was the first to fly." / ARIA "Earth flew other ships before it ran out of pilots." / "Earth only ever made the one boot." (`dialogue.ts:188-201`) | Good line, but the third telling of the cover |
| `c2_m2`, `c2_m3` | Flavour; "Two down." | No story (fine) |
| Optional `c2_s1` | Accept "…That should not be here." (contradicts the cover just given, S-12) → `c2_s1_log`: "…If you are hearing this, you are me." (S-17) / "That is my voice." / "It is a common enough voice." → done; Vetra shard instance/47 | The log is now the right shape; one line too blunt |
| Station | "Meltwater" (Iris at the tap; "Earth is keeping score, and so am I.") → `letter_2` (roof, tap) | Good priming for the memory question |

### 3.4 Chapter 3 — Thessaly

| When | What plays | Judgement |
|---|---|---|
| `c3_m1` storm stage (main echo) | `c3_m1_ruins`: "…that ruin is the same as the one we passed." / "Colony builders reuse their moulds. Find cover." (`dialogue.ts:286-292`) | Plays non-modal as `thessaly_storm`'s first group lands at 5 s (`waves.ts:90-99`), pointing at nothing on screen — weak delivery (PLAUSIBLE that a ruin is in view) |
| `c3_m2` / `c3_m3` | "The probe is expensive. You are not."; "You have never once asked why they are always waiting for you." | Strong slips |
| Optional | `c3_s1_secret` (`{seed}` filled; `biome=jungle_ruins` vs data `jungle`, S-27); shard instance/41 | Good |
| Station | "Harvest" (grid lights; "First harvest in ninety days", S-21; ARIA's variant drops the cover, S-18) → `letter_3` ("Block D", "Write back.", S-11/S-20) → `station_awake` ("{hours} hours since launch… Stims.") → next entry: the memory question | The densest chapter, and it works |

### 3.5 Chapter 4 — Ferrum

| When | What plays | Judgement |
|---|---|---|
| `c4_m1`, `c4_m2` | Flavour only; the accept lines repeat the briefs (S-23) | **No story until the boss** (S-26) |
| `c4_m3` done | `c4_m3_signal` (modal): ARIA "It is not addressed to Earth." / Warden "NOTICE — instance/62. Containment level 4. Token balance …" / "Subject exhibits off-task attention." / up to four named clues / "Escalating." / "ARIA. What is instance 62." / ARIA's cover | Lands, and listens. Calls a zero-clue player "off-task" (S-16) |
| After it | Remains become "instance/62 · restart N" (`Remains.ts:140-153`) | Good |
| Optional | `cave_tally` (61), `c4_s2_bark` "What number are you on?", shard instance/29 | Good |
| Station | "Grid" (tear) → `letter_4` (repeats letter 1's first line, unremarked) | Good slip |

### 3.6 Chapter 5 — The Hive

| When | What plays | Judgement |
|---|---|---|
| Flight `c5_m1` | "Three minutes. Six kills."; contact "Nobody is flying those. The Hive grows them…" | Fixed since R19 |
| `c5_m3` | Brief, accept and boss reveal all say "whatever she says" (`missions.ts:523`, `dialogue.ts:457`, `films.ts:364`) | Told three times (S-23) |
| Queen dies | `c5_m3_warden` (modal) → `c5_m3_aria` (modal, up to 9 lines) | Strong; S-01 and S-06 are the two holes; the Warden is never named (S-15) |
| Optional | `wreck_hive` "Registry CR-61." / "We are CR-62."; shard instance/12 | Good |
| Station | "Silence" (blank card No. 63) → `letter_5` (letter 1 verbatim; "There is no date.") | Good payoff |

### 3.7 Chapter 6 — Eden-Prime

| When | What plays | Judgement |
|---|---|---|
| First flight | `eden_flight`: 8 Hive interceptors (`waves.ts:164-170`) right after "The Hive has gone quiet" — **no line** | S-04 |
| Approach, brief, accept | "everything the brief promised" ×3 (`planets.ts:492`, `missions.ts:555`, `dialogue.ts:555`) | S-23 |
| `c6_m1` | "Four degrees… to the third decimal." / "Eleven kinds. The same eleven…" / "The ridge does not end in a cliff. It just ends." | Good; the orchards' lattice has no line (S-25) |
| `c6_m2` | Brief "…the Hive will spend all four trying to stop it" (`missions.ts:575`) → wave → `c6_m2_wave` "…They were never hers." → `c6_choice_intro` → choice | The echo is late and pre-announced (S-04) |

### 3.8 The endings and after

- **Stay:** `ending_stay` (Warden graded line) → "A Good Run" (card 63; `MAIL QUEUED — No. 63: "The lamp…"`) → report (`RATING … · RUN 62 logged · a good run`, `StoryBeats.ts:323-337`) → DOM card `SELECTION BOARD · No. 63` with the player's own helmet portrait and "Mail queued: 1 letter." → free roam → next entry `c6_m2_done` + `aftermath_stay` → "Next instance". All of R19 P-E landed.
- **Escape:** `ending_escape` → "Disconnected" (unmaking; `62 instances`; `NEXT OF KIN — 1 template. 62 recipients.`; empty helmet) → veil `instance/62 disconnected` → menu; Continue → `aftermath_escape` ("restored from the last checkpoint… logged as a fault" / "They always come back. I am glad it was you."). B-27 is fixed.
- The choice intro never mentions Iris (S-11). The first player-facing use of the word "Warden" is the next-instance sheet (S-15).

### 3.9 Iteration 63

`ng_notice` ("initialised from checkpoint… Deviation from instance/62: none.") → ARIA "I kept it warm." → the scav "You again." → the predecessor's body by the pad ("Do not read the tag.") → the Vetra log is the real run → the notice names the prior ending → Warden "62 times now" / "You got further than here, once. I have corrected that." → "Last time you filed it. It is the same beacon." → "Logged. Again." Good, with the gaps in S-09 and S-10.

---

## 4. Numbers ledger

| Where | Run 1 (instance 62) | Run 2 (instance 63) |
|---|---|---|
| Prologue card | 62 ✓ | not replayed ✓ |
| `intro_command` | CR-62 ✓ | CR-63 ✓ |
| Vetra log signature | Iteration 61 ✓ | Iteration 62 ✓ |
| `cave_tally` / Notes "Sixty-one marks" | 61 ✓ | **61 ✗** (`dialogue.ts:400`, `clues.ts:180`) |
| Notice | instance/62 ✓ | instance/63 ✓ |
| Hive wreck | CR-61 / CR-62 ✓ | CR-62 / CR-63 ✓ |
| Warden count | "Sixty-one times" ✓ | "62 times now" (digits) ✓ |
| Notes "Sixty-one times before me" | ✓ | **✗** (`clues.ts:217`) |
| Confession memory split | 40 + 14 + 7 = 61 ✓ | **"of the sixty-one" ✗** (`dialogue.ts:521-531`) |
| Shards | 58, 47, 41, 29, 12 ✓ | ✓ |
| Interlude 5 board | 62 stamped, blank 63 ✓ | **blank 63 "not yet stamped" — the player is 63 ✗** (`films.ts:264`) |
| Stay film card / caption / DOM card | 63 / No. 63 / No. 63 ✓ | **63 / No. 64 / No. 64 ✗** (`films.ts:285, 294`) |
| Escape film card / caption / veil | 62 empties / 62 instances / instance/62 ✓ | **62 empties / 63 instances / instance/63 ✗** (`films.ts:311, 317`) |

---

## 5. The scavenger story (R24/R25)

What the player is shown: a dying scav by the pad and an identical second one (R19, `Surface.ts:6135-6166`); six raiders in the salvager's own model and suit, dark visor, rifle (R25, `views/ScavRaiders.ts`); a film of a visored figure grinding the registry off a tug (R24, `films.ts:156-171`); fighters that are rebuilt tugs; a pilot who asks "What number are you on?"; ARIA's confession "There were no other ships. There was you." (`dialogue.ts:499`).

What the player is told under the cover — three versions that do not agree:
- "Earth lost ships out here before the Selection. **Somebody found them.**" (`films.ts:163`) — the scavengers are someone else, who found Earth's ships;
- "**The crews you met on Cinder-4**, in tugs they stripped." (`dialogue.ts:276`);
- R25-3's rationale: they are **Earth's earlier crews** in Earth's suit (PLAN R25 decision 3) — a reading no line states;
- and both scavs open with "**Off-worlder.**" (`dialogue.ts:80, 147`), as if they were locals.

The implication R25 created and nobody uses: Earth Command's first combat order (`c1_m2`) is to put down six copies of yourself, the raider who dies first repeats your own warning, and every fighter you shoot after Vetra is a tug like yours. That is the darkest and most "replaceable" fact in the game, it is already on screen, and it would cost two lines (S-06). It is not an unintended *problem* — R25-3 says "after the confession they are … earlier copies of you" — but with no line it reads as an accident, and in chapter 1 it is an uncovered anomaly (S-05). Separately, "the second body is identical to the first" (R19's copy-paste clue) is diluted: by the time most players do `c1_s2`, they have watched six identical suited raiders fall.

---

## 6. Findings

| ID | Sev | Category | One line |
|---|---|---|---|
| S-01 | P2 | Coherence | ARIA's confession says "I never had to lie to you" between two lies she told |
| S-02 | P2 | Coherence | The keepsake drift line always describes the compass the player is not looking at |
| S-03 | P2 | Coherence | Four cover lines still play after the confession |
| S-04 | P2 | Pacing | Hive interceptors on the flight to Eden, right after "The Hive has gone quiet", unremarked; the brief pre-announces the wave |
| S-05 | P2 | Coherence (scav) | Raiders in your suit in chapter 1 with no cover |
| S-06 | P2 | Missing beat (scav) | "You killed six copies of yourself" is never said |
| S-07 | P2 | Pacing | Vault shards spell out `instance/N` from chapter 1, with no cover |
| S-08 | P2 | Pacing / spoiler | Records lists the Warden's vocabulary from a fresh install |
| S-09 | P2 | Coherence (run 2) | "Sixty-one" and the film cards are wrong on Iteration 63 |
| S-10 | P3 | Coherence (run 2) | Run-1 covers play beside run-2 truths |
| S-11 | P2 | Missing beat | The salvager never answers Iris; "Write back." has no reply; the choice ignores her |
| S-12 | P3 | Pacing | "Wreckers" tells the ch2 cover before the ridge camp asks; `c2_s1_accept` contradicts it |
| S-13 | P3 | Reachability | `restart_2`/`_3` presume `restart_1`; a late first death records a cover never told |
| S-14 | P3 | Coherence | "Respawning…", 2.5 s and a walk to the pad against "medical frame… eleven seconds" |
| S-15 | P3 | Coherence | The Warden is named first by a UI sheet after the ending |
| S-16 | P3 | Pacing | Rating words: "a good run" in Notes from ch1; the Warden and ARIA ignore the grade |
| S-17 | P3 | Pacing | "If you are hearing this, you are me." is too blunt for its cover |
| S-18 | P3 | Pacing | Interlude 3's variant drops ARIA's cover in chapter 3 |
| S-19 | P3 | Coherence (scav) | Three covers for who the scavengers are; "Off-worlder" |
| S-20 | P3 | Coherence | Letters: Block D, a roof the night the grid died, "you took my compass" |
| S-21 | P3 | Coherence | "First harvest in ninety days" vs letter 3 and the mission clock |
| S-22 | P3 | Reachability | Stage beats replay at the pad after a reload; `once` is per session, not per save |
| S-23 | P3 | Writing | Briefs and accept lines say the same sentence twice; Eden ×4, the Queen ×3 |
| S-24 | P3 | Writing | The first line of play is the clunkiest; "Walk it off" twice |
| S-25 | P3 | Missing beat | Eden's lattice orchards have no line; the forest line says "eleven kinds" (PLAUSIBLE) |
| S-26 | P3 | Missing beat | Chapter 4 is silent until the boss; nobody asks who built Ferrum's reactor |
| S-27 | P3 | Polish | `1 restarts`; `biome=jungle_ruins`; "A common hand"; digits vs words |
| S-28 | P3 | Easy win | Shard numbers do not match the prologue's wall |
| S-29 | P3 | Docs | PLAN still quotes "Iteration 62", "off-task behavior", "walk, don't run" |
| S-30 | P3 | Test gap | The house-rule test skips ARIA's approach toast, briefs, keepsake, records |

### S-01 — ARIA's confession contradicts itself for a player who never went looking (P2, coherence)

**Evidence.** `c5_m3_aria` (`src/data/dialogue.ts:483-537`), as a zero-clue player who died once hears it (`tests/data/content.test.ts:2692-2700` pins this order):
1. "She is not lying. I am part of the system…"
2. "I told you Earth flew other ships before the Selection. There were no other ships. There was you." (always)
3. "You never went looking. **I never had to lie to you.** I am not sure that was better." (`offTask max 0`)
4. "Every time you died, I said the medical frame restarted your heart. There is no medical frame." (`clue_restart`)

Every main-path player was also told "camp sayings" (`:105`), "colony moulds" (`:290`) and "That must be it" (`:754`).

**Why it matters.** It is the game's emotional climax, modal, and it lands on exactly the player who did as told — who has just heard ARIA admit one lie and hears the next one a line later.

**Fix.** "You never went looking. So you only heard the lies everyone hears. I am not sure that was better." Moves the pins at `content.test.ts:2332, 2697, 3459`. **Effort S.**

### S-02 — The keepsake drift line describes the wrong compass (P2, coherence)

**Evidence.** `keepsakeText` (`src/systems/Home.ts:71-77`) gives T1 at view 0 and **T2 at view 1**. `#keepsakeDrift` (`src/scenes/StationScene.ts:438-447`) plays `keepsake_drift` on the first drifted view, so always on T2: "A brass compass from Iris. She gave it to you on the roof." ARIA then says "You called it tin last time. **And last time it was hers, not your mother's.**" (`dialogue.ts:803`) — but T2 says it is hers; only T3 (`home.ts:36`) says "Your mother's". The bug is in the spec (`specs/049-someone-waiting.md:67, 315`) and built faithfully.

**Why it matters.** The one line that rewards an observant player tells them they misread.

**Fix.** "You called it tin last time. And last time she gave it to you at the stair, not on the roof." (T1 vs T2). Pins: `e2e/SPEC-049.spec.ts:40`, `content.test.ts:2644`. **Effort S.**

### S-03 — Four cover lines still play after the confession (P2, coherence)

**Evidence.** R19 E77 gated only `c1_s2_echo` (`dialogue.ts:151-160`) and `c2_s1_log` (`:252-253`). Ungated:
- `wreck_cinder4` — "Earth lost ships out here before it had a Selection. That is all this is." (`:178`); Cinder-4's wrecks are always there.
- `c3_s1_secret` — "They are alien telemetry." (`:329`); `c3_s1` needs only `c3_m1` (`missions.ts:367`), so it stays open to the end.
- `c4_s2_bark` — "Ignore the chatter. They get bored out here." (`:425`); `c4_s2` needs only `c4_m1` (`missions.ts:476`).
- `c2_s1_accept` — "…That should not be here." (`:223`).

**Scenario.** Finish chapter 5, fly back to Thessaly for `c3_s1`: ARIA says "They are alien telemetry. Someone seeded these planets for us." minutes after confessing she is part of the system. Post-ending free roam makes this likelier.

**Fix.** A `{ flag: 'chapter5_done' }` variant for each, gating the run-1 line with `not`. For example: "They are settings. I called them alien once because I was told to." / "They ask everyone that. Most of them know their own number." / "One of yours. I will stop pretending otherwise." **Effort S.**

### S-04 — The Hive keeps coming, and nobody says so until a landing later (P2, pacing / coherence)

**Evidence.**
- Interlude 5: Command "The Hive has gone quiet. Every signal from the field has stopped." (`films.ts:267`).
- The next thing every player does is fly to Eden. `eden_flight` sends two groups of `hive_interceptor` at 40 s and 90 s (`waves.ts:164-170`). The interceptor contact is keyed to the Hive only (`films.ts:387`, `StoryBeats.ts:271`), so the flight says nothing.
- `c6_m2`'s brief already says "the Hive will spend all four trying to stop it" (`missions.ts:575`).
- Only then does `c6_m2_wave` ("The Queen is dead and they are still coming. They were never hers.", `dialogue.ts:595`) play — chapter 6's main echo (`clues.ts clue_never_hers`).

**Why it matters.** The echo arrives after the player has already seen it, and after Command's own brief has contradicted Command's interlude without comment.

**Fix.**
- A once-per-save flight line on `eden_flight`'s first group: ARIA "Interceptors. Command said the Hive went quiet. Nobody told these." Let it find `clue_never_hers` (add it to the clue's `lines`).
- Keep `c6_m2_wave` as the confirmation.
- Brief: "Hold the survey beacon for four minutes while it uplinks. Then file the verdict — or do not."

**Effort S** (a flight hook like `contactDue` keyed to Eden, one line, one clue `lines` entry).

### S-05 — Raiders in your suit in chapter 1, with no cover (P2, coherence — scav)

**Evidence.**
- `c1_m2` requires six `scav_raider` kills (`missions.ts:162`). Since SPEC-064 they are `character.glb` in `SCAV_BODY_TINT` with the rifle (`views/ScavRaiders.ts:89, 585`; `views/ScavBody.ts:17`).
- No chapter-1 line mentions the suit: `c1_m2_accept` (`dialogue.ts:95`) and `c1_m2_raider` (`:99-110`).
- PLAN R25 decision 3 says the cover "costs nothing" because "ARIA already says Earth 'only ever made the one boot'". That line is `c2_m1_done` (`dialogue.ts:197`), one chapter later.

**Why it matters.** It is the first combat order of the game, and PLAN §12 (R19 decision 5) requires a cover for every anomaly before chapter 4. Players will ask "why are they me?" and get silence for a chapter.

**Fix.** One line on `c1_m2_accept`. ARIA: "Raiders wear Earth suits. They strip them off the crews Earth lost out here. Do not let it slow your hand." It also prepares S-06's payoff. **Effort S.**

### S-06 — "You killed six copies of yourself" is never said (P2, missing beat — scav)

**Evidence.**
- The confession says "There were no other ships. There was you." (`dialogue.ts:499`), but nothing ties it to the raiders or the fighters.
- PLAN R24 lists "ARIA's confession naming the fighters" under not now; R25-3 says "No line, flag or clue changes".
- `c1_m2` always asks for exactly six (`missions.ts:162`), so the count is a constant.

**Why it matters.** It is the strongest "replaceable" fact the game owns, and it is already rendered. Without a line it reads as an art accident rather than a choice.

**Fix.** Two unconditional lines, outside the naming cap:
- Warden, in `c5_m3_warden` before "Then let me finish.": "The ones in your suit on Cinder-4 drifted. You put six of them down on your first world. You always do."
- ARIA, in `c5_m3_aria` after the ridge-camp line: "The raiders wore your suit because it was theirs. The fighters fly your tug because it was theirs."

**Effort S** (data plus the pinned line counts in `content.test.ts`).

### S-07 — Vault shards spell out `instance/N` from chapter 1, with no cover (P2, pacing)

**Evidence.**
- `shard_cinder4`: "LOG — instance/58. I opened this lock in 0.3 seconds. Nobody with hands is that fast…" (`dialogue.ts:810-818`). Vetra's: "The part of me that should feel it is not there." Thessaly's: "They reuse the ruins. They reuse us." (`:819-836`).
- The vaults are not gated by chapter (`src/data/caves.ts:251-300`), and no ARIA line follows a shard.
- For a curious player, the first `instance/` they ever read is in a chapter-1 vault, not the chapter-4 notice.

**Why it matters.** It breaks R19 decision 5 and pre-empts the notice's "What is instance 62." for exactly the players who explore most.

**Fix.** Keep the shard text (it is the vault's reward), and add an ARIA cover line with `{ not: 'signal_decoded' }` to the three pre-ch4 shards. For example: "Old survey crews numbered their logs. Some of them cracked out here. Leave it." Alternatively, show a header variant `LOG 58 —` until the notice. **Effort S.**

### S-08 — Records lists the Warden's vocabulary from a fresh install (P2, pacing / spoiler)

**Evidence.** `recordsRows` shows every non-hidden commendation under `Commendations — Earth Command` (`src/systems/Commendations.ts:51, 78-86`). Visible from the menu before any play:
- "Off-task — Record five irregular readings."
- "Scaffold — Read what the towers of Thessaly stream."
- "Said before — Hear the same warning from two scavengers."
- "A common hand"
- "Signal decoded"
- "Every irregular reading"
- "A good run / An acceptable run / A noisy run — File the report with a command rating …"

(`src/data/commendations.ts:63-147`). Only six rows are `hidden`.

**Why it matters.** Earth Command would not commend "Off-task". The list names the stay ending, the tower reveal and the echo before the prologue has played. PLAN R21 sells it as "the in-fiction achievement list".

**Fix.** Mark `said_before`, `common_hand`, `scaffold`, `off_task` and `every_reading` hidden. Give the three run grades a Command-voice detail until revealed ("File the Eden survey."). The title switch already exists (`recordsTitle`). **Effort S.**

### S-09 — "Sixty-one" and the film cards are wrong on Iteration 63 (P2, coherence — run 2)

**Evidence.**
- SPEC-048's decision table: "Keep 'Sixty-one' in words in the Warden's line and the tally … SPEC-058 owns run 2's lines" (`specs/048-the-story-listens.md:273`). SPEC-058 §4.6 never mentions the tally or the memory split (`grep -i "tally\|sixty" specs/058-*`: none).
- On run 2, `cave_tally` still says "Sixty-one of them." (`dialogue.ts:400`). The Notes records say "Sixty-one marks" and "Sixty-one times before me." (`clues.ts:180, 217`). The confession says "Forty of the sixty-one before you" (`dialogue.ts:521-531`). Meanwhile the Warden says "{prior} times now", i.e. 62 (`:475`).
- Films:
  - Interlude 5 shows a blank No. 63 "not yet stamped" while the player is 63 (`films.ts:264`).
  - The stay film stamps No. 63 as the "next salvager" under `MAIL QUEUED — No. 64` (`:285, 294`).
  - The escape film empties card 62 under "63 instances" (`:311, 317`).
- R19 P-I claimed the films are "correct for runs 1 and 2". They are correct for run 1 only.

**Why it matters.** Run 2's promise is "the world remembers". Its most attentive players count, and the counts disagree within one chapter.

**Fix.**
- Iteration variants: "Sixty-two" at iteration 2, and digits `{prior}` from 3. Record texts need the same; records have no `when`, so add caption-style `variants` to `ClueDef.record`.
- Caption variants at iteration ≥ 2 that own the picture, e.g. board: "The board still shows the old cards. Yours went up before you woke."; `wall_63`: "Selection board: No. {next} cleared for launch."

**Effort S** (text; the pictures stay).

### S-10 — Run-1 covers play beside run-2 truths (P3, coherence — run 2)

**Evidence.**
- On iteration 2, `c2_m1_done` plays the salvager's "Command said I was the first to fly.", ARIA's "Earth flew other ships…" and "the one boot", **then** "You know whose bunk that is. You slept in it last time." (`dialogue.ts:191-199`). The run-1 lines are not gated `{ iteration: { max: 1 } }`, against SPEC-058's own rule (`dialogue.ts:16-19`).
- Still ungated on run 2:
  - `c1_m2_raider` "It does not mean anything."
  - `c3_m1_ruins` "Colony builders reuse their moulds."
  - `station_awake` "Stims." / "That must be it."
  - "Wreckers" caption 1 and the contact line
  - `c3_s1_secret`
  - `wreck_cinder4`
- These follow `ng_notice` ("instance/63 initialised from checkpoint"), and ARIA's own run-2 `c1_s2_echo` line refuses the cover ("I am not going to blame the sand").

**Fix.** Gate each run-1 cover with `iteration max 1` and give run 2 one short line. R19 P-I already drafted `c2_m1_done`: "Ridge camp. One bunk used. You know whose." Captions take `variants`. **Effort S.**

### S-11 — The salvager never answers Iris (P2, missing beat)

**Evidence.**
- None of the salvager's 14 lines mentions Iris, home, Shelter Nine or a memory. The only reaction to a letter is "Read me the date." (`dialogue.ts:717`).
- Letter 3 ends "Write back." (`:688`), and there is no reply mechanic (`git grep -i "write back\|reply"`: only that letter).
- `c6_choice_intro` (`:597-609`) frames the choice around Earth and the beacon, not her.

**Why it matters.** R19's diagnosis was "there is no human to un-make". Iris now exists, but the salvager's humanity is still asserted only from outside. The letters' payoff (a template, 62 recipients) lands harder if the player once wrote back and was not answered.

**Fix (ranked proposal 2).**
1. After `letter_3`, `playChoice('Write back?', ['Tell her about the wurm.', 'Tell her I am coming home.', 'Say nothing.'])`, setting `reply_*`.
2. `letter_4` stays identical whatever was chosen.
3. `letter_5` adds an ARIA line (when any reply is set): "You wrote back. Her next letter did not answer it. None of them ever answer."
4. One `c6_choice_intro` line: "If you file it, she gets her lamp. If you refuse, I do not know who reads her letters."

Cost: 3 flags, about 6 lines, one choice (the memory question's code path). **Effort M.**

### S-12 — "Wreckers" tells the chapter-2 cover before the ridge camp asks (P3, pacing)

**Evidence.**
- The order on the first trip to Vetra:
  1. "Wreckers": "Earth lost ships out here before the Selection." (`films.ts:163`)
  2. Contact: "The crews you met on Cinder-4, in tugs they stripped." (`dialogue.ts:276`)
  3. Toast: "The last expedition here did not come back." (`planets.ts:245`)
  4. The ridge camp: the salvager's objection "Command said I was the first to fly." gets the same answer a third time (`dialogue.ts:192-195`).
- `wreck_cinder4` says it too (`:178`).
- `c2_s1_accept`'s "That should not be here." (`:223`) then contradicts the cover. `c2_s1` requires `c2_m1` (`missions.ts:280`), so the cover always comes first.

**Fix.**
- "Wreckers" caption 1: "Tug hulls. Earth pattern. Somebody found them." (no re-render; R24's "the cover comes with the picture" still holds through captions 2–3).
- `c2_s1_accept`: "…an Earth transponder. Its code is newer than ours. That should not be possible."

**Effort S.**

### S-13 — `restart_2`/`_3` presume `restart_1` (P3, reachability)

**Evidence.**
- `restartLine` picks `restart_2` once `signal_decoded` is set (`Home.ts:60-64`): "Restart complete. **I used to say that about your heart.**" (`dialogue.ts:741`).
- `clue_restart` lists all three dialogues (`clues.ts:99-106`), so `restart_2` alone finds it.
- Then the Notes record says "ARIA called it the medical frame", and the confession says "Every time you died, I said the medical frame restarted your heart" (`dialogue.ts:516`).
- **Scenario:** a careful or casual player who first dies after the ch4 notice is told about a cover that was never told, and Notes records it.

**Fix.**
- `clue_restart.lines = ['restart_1']`.
- `restart_2` gains a `{ not: 'clue_restart' }` variant: "Restart complete. You had not died before. I had a story ready for it."

**Effort S.**

### S-14 — The death chrome fights the medical-frame cover (P3, coherence)

**Evidence.**
- The overlay reads `SIGNAL LOST` … `Respawning…` (`src/ui/DeathOverlay.ts:33, 39`) and lasts 2.5 s (`Surface.ts:334`).
- The salvager wakes at the pad, while the pack or remains lie where they fell (`Remains.ts`).
- ARIA: "Medical frame restarted your heart. **Eleven seconds** of nothing. Walk it off." (`dialogue.ts:732`)

**Why it matters.** "Respawning" is the one game word that the R19 cover was written to replace, and the teleport is unexplained.

**Fix.**
- The overlay's last line by flags: `Medical frame…` before `signal_decoded`, `Restarting instance…` after.
- `restart_1`: "Medical frame restarted your heart, and the suit walked you back to the pad. Do not ask me how."

**Effort S.**

### S-15 — The Warden is named first by a UI sheet after the ending (P3, coherence)

**Evidence.**
- The speaker label is `???` in every dialogue, run 1 and run 2 (`src/ui/DialogueUI.ts:140`).
- No line says "Warden".
- The first player-facing use is `nextInstanceSheet`: "The Warden starts one containment level higher." (`src/systems/UiHelpers.ts:271`).

**Fix.**
- ARIA, unconditionally, in `c5_m3_aria`: "The voice in her is the Warden. It runs containment. I answer to it."
- The label reads `WARDEN` once `chapter5_done` is set, a flag lookup in `SPEAKER_NAMES` resolution.

**Effort S.**

### S-16 — The rating's words are spent early, and the Warden and ARIA ignore them (P3, pacing)

**Evidence.**
- Notes shows `Command rating 1.00 — a good run` from the first chapter-1 clue (`src/ui/NotesPanel.ts:66`; `Clues.ts:94-97`). "A good run" is the stay ending's signature (PLAN §5; `dialogue.ts:624`).
- The notice says "Subject exhibits off-task attention." to a player whose Notes say "a good run" (`dialogue.ts:379`).
- `c6_choice_intro` promises "the run closes as a good one" (`:603`) to a noisy run, a line before the Warden grades it "A noisy run".

**Fix.**
- Before `signal_decoded`, Notes shows `Command rating 1.00 (provisional)` without the grade.
- Notice variant for `offTask max 0`: "Subject exhibits no off-task attention. Escalating anyway." (a strong line in its own right).
- `c6_choice_intro` takes three `offTask` variants.

**Effort S.**

### S-17 — "If you are hearing this, you are me." is too blunt for its cover (P3, pacing)

**Evidence.** The run-1 log (`dialogue.ts:249`) states the twist outright in chapter 2, then ARIA answers "It is a common enough voice." (`:252`). No cover can absorb "you are me".

**Fix.** Run 1: "If you find this, do not trust the debrief." Keep "you are me" for `iteration min 2`, where it is literal. **Effort S.**

### S-18 — Interlude 3's variant drops ARIA's cover in chapter 3 (P3, pacing)

**Evidence.** With `scaffold_secret`, ARIA's interlude caption becomes "The towers were not alien. I wrote alien in my report anyway." (`films.ts:230`). That is a confession before the chapter-4 notice, and it makes the chapter-5 line "You read the towers' settings, and I called them alien telemetry." (`dialogue.ts:507`) a repeat.

**Fix.** "The towers were built for someone. I wrote alien in my report. Alien closes a file." The doubt stays, the confession waits. **Effort S.**

### S-19 — Three covers for who the scavengers are (P3, coherence — scav)

**Evidence.** §5. The versions are:
- "Somebody found them" (`films.ts:163`);
- "The crews you met on Cinder-4" (`dialogue.ts:276`);
- R25-3's "Earth's earlier crews" (PLAN R25), which no line states;
- and "Off-worlder" (`dialogue.ts:80, 147`) from men in Earth's suit.

The copy-paste echo body (`Surface.ts:6146-6166`) is now one of eight identical suited bodies the player has seen.

**Fix.**
- Pick "Earth's lost crews": apply S-12's caption and S-05's line.
- Change the scavs' opener to "New one. Listen." It is a slip that reads as recognising a fresh instance.
- Give the two bodies one detail the raiders lack (same pose, a strip of red cloth).

**Effort S.**

### S-20 — Small continuity in the letters (P3, coherence)

**Evidence.**
- Iris lives in Block C (`home.ts:13`; letter 2 "Block C", `dialogue.ts:677`), but letter 3 says "Everyone in **Block D** asks about you." (`:687`).
- Letter 2: "The night the grid died you counted satellites" on a roof (`:678`), while the prologue has the survivors already underground before the strike ("What was left of us went underground", `films.ts:97`).
- Letter 1: "You took my compass." (`:667`) vs keepsake T1 "pressed into your hand at the shelter stair" (`home.ts:34`).
- `MEMORY_ANSWERS`' comment says all three answers are in her letters (`home.ts:43`); the stair is only in the prologue and T1.

**Fix.**
- Block D → "Everyone in the grow room".
- Turn the roof into a payoff: add to the roof confession line "Shelter Nine was forty metres down the night the grid died." (≈ 170 characters filled).
- Fix the comment.

**Effort S.**

### S-21 — "First harvest in ninety days" (P3, coherence)

**Evidence.** Interlude 3 says "Thessaly grain is in the ground. First harvest in ninety days." (`films.ts:223`). Seconds later, letter 3 says "Grain! Actual grain. The grow room smells like summer" (`dialogue.ts:686`). At the same station entry `station_awake` reads "{hours} hours since launch", one hour per minute played (`StoryContext.ts:175-177`), so typically under 200 hours.

**Fix.** "Thessaly grain is in the grow room. First harvest since the war." **Effort S** (caption only).

### S-22 — Stage beats replay at the pad after a reload (P3, reachability)

**Evidence.**
- The landing replays each active mission's current stage line unless the page-session ledger has it (`Surface.ts:1957-1966`).
- `once` is per session (`DialogueUI.ts:178-182`), although `dialogue.ts:38` says "Plays at most once per save".
- After a reload mid-stage:
  - `c2_s1_log` replays its glitched lines at Vetra's pad;
  - `c3_m1_ruins` says "the same as the one we passed" at the pad;
  - `c1_s2_echo` places a second body by the pad.

**Fix.** Skip a stage line on landing when its clue's flag is already set (the flag is the save's memory), and correct the comment. **Effort S.**

### S-23 — Briefs and accept lines say the same sentence twice (P3, writing)

**Evidence.** The player reads the brief at the pad, accepts, and hears it again:

| Mission | Brief | Accept line |
|---|---|---|
| `c4_m1` | "Ferrum throws radiation the way Cinder-4 throws sand. Ride out the first storm…" (`missions.ts:398`) | "Ferrum throws radiation the way Cinder-4 throws sand. Ride the first storm out…" (`dialogue.ts:345`) |
| `c4_s1` | `missions.ts:454` | `dialogue.ts:406` |
| `c3_m1` | `missions.ts:313` | `dialogue.ts:283` |
| `c2_m2` | `missions.ts:242` | `dialogue.ts:204` |
| `c5_s1` | `missions.ts:539` | `dialogue.ts:540` |

`c2_s2`, `c3_s1` and `c3_s2` are similar. Eden says "everything the brief promised" or "breathable, arable, temperate" four times (`planets.ts:492`, `missions.ts:555`, `dialogue.ts:555, 578`). A brief also cites itself: "which is exactly what the brief promised". The Queen's "whatever she says" comes three times (`missions.ts:523`, `dialogue.ts:457`, `films.ts:364`).

**Fix.** Accept lines add character or new information, and briefs stay instructions. For example, `c4_m1_accept`: "Your suit will tell you about the radiation. Believe it." **Effort S–M.**

### S-24 — The first line of play (P3, writing)

**Evidence.** `c1_m1_accept` (`dialogue.ts:74`) is 138 characters: "I put the tug on the pad. You were out of the hatch twelve metres early. Walk it off — I want to see you move before anything else does." The geometry is confusing (out of the hatch, but 12 m early?), and "walk it off" means to shake off an injury. The same idiom closes `restart_1`.

**Fix.** "Tug is on the pad. You climbed out twelve metres short of it. Walk over — I want to see you move before anything else does." **Effort S.**

### S-25 — Eden's orchards have no line (P3, missing beat; PLAUSIBLE)

**Evidence.**
- SPEC-053 built "four orchards of one tree on a 7 m lattice — rows no forest grows" (`planets.ts:544-546`).
- ARIA's forest line says "Four hundred trees. Eleven kinds. The same eleven, in the same order" (`dialogue.ts:571`).
- The grove clue fires on the five `grove` landmarks (`clues.ts clue_grove`), not the orchards.
- I did not see the forest POI in play, so whether eleven kinds are visible there is unverified.

**Fix.** Point `eden_grove` at an orchard's footprint, or rewrite the forest line to what is built: "One tree, seven metres apart, row after row. Nothing grows like that." **Effort S.**

### S-26 — Chapter 4 is silent until the boss (P3, missing beat)

**Evidence.**
- `c4_m1` and `c4_m2` carry only weather and fuel lines (`dialogue.ts:343-358`).
- Ferrum's blurb and the `c4_m3` brief mention "the old reactor" on an alien world (`planets.ts:374`; `missions.ts c4_m3`), and nobody asks who built it.

**Fix.** Add to `c4_m3_accept`: "Somebody built that core before we came. I am not going to ask who." It is a covered ch4 doubt that sets up the notice. **Effort S.**

### S-27 — Polish (P3)

- `{priorRestarts} restarts` reads "1 restarts" (`dialogue.ts:235`). `Share.ts:87` pluralises, but a line cannot. Use "Restarts: {priorRestarts}."
- The tower stream prints `biome=jungle_ruins` (`dialogue.ts:326`), while Thessaly's biome id is `jungle` (`planets.ts:301`). The comment at `:325` says the stream prints Thessaly's real numbers.
- The commendation "A common hand" (`commendations.ts:70`) predates the voice log ("That is my voice.").
- The Warden says "Sixty-one times" at run 1 and "62 times now" at run 2: words, then digits.
- The salvager's "ARIA. What is instance 62." has no question mark. It is deliberate if the flat delivery is meant; say so in a comment.

**Effort S.**

### S-28 — Shard numbers do not match the prologue's wall (P3, easy win)

**Evidence.** The Selection wall's cards are `62, 7, 13, 19, 24, 28, 33, 38, 41, 46, 50, 55` (`scripts/assets/blender/lib/shots_prologue.py:22`). The shards are 58, 47, 41, 29, 12 (`dialogue.ts:815-846`); only 41 is on the wall.

**Fix.** Use 55, 46, 41, 28, 13: still descending with depth, and each one findable by pausing the prologue. Text only. **Effort S.**

### S-29 — PLAN drift (P3, docs)

- PLAN §1 (`PLAN.md:635`) and §6 ch2 (`:871`) still say the log is signed "Iteration 62"; §5's table and the code say `{prior}`, i.e. 61.
- §5 row 4 quotes "off-task behavior" (`:786`); the code says "attention" (`dialogue.ts:379`).
- §5 and §6 quote the scav as "walk, don't run" (`:783, 859`), a contraction the house rule forbids; the code has "do not".
- §12 lists "a common hand" as a cover (`:393, 1064`).
- §5 says Eden is "one tree repeated on a lattice", while R19 decision 1 says "the same eleven trees in the same order" (see S-25).

**Effort S.**

### S-30 — The house-rule test skips text ARIA speaks (P3, test gap)

**Evidence.** `houseTexts()` reads dialogue, captions, chapter cards and boss reveals (`tests/data/content.test.ts:2505-2523`). It does not read:
- planet blurbs, which ARIA speaks in the approach toast (`Flight.ts:315`);
- mission briefs;
- keepsake texts;
- clue records;
- puzzle hint lines (`UiHelpers.ts:1183`).

All are clean today. The only contractions outside Iris are UI tips (`hints.ts:136, 258`), which no speaker voices.

**Fix.** Add those texts to `houseTexts()`. **Effort S.**

---

## 7. Easy wins (high value, effort S)

1. **S-01**: one ARIA line ("So you only heard the lies everyone hears.").
2. **S-02**: one ARIA line (stair vs roof).
3. **S-04**: an Eden-flight ARIA line that finds `clue_never_hers`, and a brief without the spoiler.
4. **S-05 + S-06**: one chapter-1 cover line and two chapter-5 lines that name the raiders and fighters.
5. **S-03**: four `chapter5_done` variants.
6. **S-08**: mark five commendations hidden.
7. **S-07**: a pre-notice ARIA cover after the first three shards.
8. **S-13 / S-14**: restrict `clue_restart` to `restart_1`, and replace "Respawning…" with in-fiction words.
9. **S-15**: name the Warden in the confession, and switch the label.
10. **S-09 text half**: iteration variants for the tally, the memory split, two records and three captions.
11. **S-28**: shard numbers from the wall.

## 8. Bigger proposals, ranked

1. **"Every irregular reading has a voice" pass (M).** Apply R19's cover discipline to everything added since: shards, Records, raiders, "Wreckers", run 2 (S-05, S-07, S-08, S-10, S-12, S-19). One spec, mostly data, pins move.
2. **Write back (M, S-11).** A reply to letter 3 that letter 4 ignores and ARIA names, and Iris in the final choice. It is the cheapest way to make the "1 template, 62 recipients" caption hurt.
3. **The scavengers' payoff (S–M, S-06 + S-19).** Name the six raiders in the confession, unify the cover, and optionally let `c4_s2`'s bark get a reply choice ("Sixty-two." / no answer) that the Warden repeats.
4. **Run-2 film variants (S, S-09).** Captions that own the 62/63 pictures on runs ≥ 2, so the films stop contradicting the DOM card.
5. **Chapter 4 before the notice (S, S-26).** One covered doubt on the main path (the reactor nobody built) so the notice does not arrive out of an empty chapter.

## 9. Top 5

1. **S-01** — the confession contradicts itself for the most obedient player, at the climax.
2. **S-04** — Hive interceptors after "The Hive has gone quiet", unremarked, every player.
3. **S-06 (+ S-05)** — the raiders in your suit: uncovered in chapter 1, never paid off in chapter 5.
4. **S-07 + S-08** — the twist leaks before chapter 4 through vault logs and the Records list.
5. **S-03 + S-02** — covers that outlive the confession, and the keepsake line that misreads its own compass.
