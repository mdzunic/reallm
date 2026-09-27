# ReaLLM R19 audit — rewards, New Game+, death, and what would make it succeed

> **Provenance.** Written on 2026-09-27 for PLAN R19–R21, against a snapshot of `main` at `2cf398a` (SPEC-035 and PLAN R18 merged; SPEC-036…045 written, not built), which the report calls `SCRATCH/game-r19`. `SCRATCH` was that review session's working folder; its probes, captures and simulation scripts are not kept in the repository. The decisions taken from this report are PLAN R19, R20 and R21 and the specs SPEC-046…SPEC-059 in `mdzunic/reallm-specs`; where a report and PLAN differ, PLAN wins.

**Date:** 2026-09-27 · **Code:** `SCRATCH/game-r19` (game `main` @ 2cf398a; SPEC-001…035 built except 016/033; PLAN R18 merged) · **Specs:** `reallm-specs` @ 0399e75 (SPEC-036…045 written, not built; their interfaces are the baseline) · **Method:** code and spec reading plus two scratch probes. Nothing in either repository was changed; no browser was used.

**Conventions.**
- `E-xx` are this audit's finding ids, not PLAN §13 entries. Proposed §13 entries start at **E72** (the register ends at E71).
- "Pins" are the literals in `tests/systems/balance.test.ts`, `tests/data/content.test.ts`, `tests/core/save.test.ts` and SPEC-016 §4.7.
- Numbers marked *initial tuning* may move without a PLAN entry while the invariants stay green.

**Evidence (re-runnable).**
- `SCRATCH/r19/replay-probe/nums.mjs` (`node nums.mjs`): token headroom per invariant, the rounding of the `52 %` literal, XP thresholds, containment multipliers, compounded death losses.
- `SCRATCH/r19/replay-probe/caves.sim.ts` with `vitest.config.mjs` in the same folder (run from `SCRATCH/game-r19`: `npx vitest run --config ../r19/replay-probe/vitest.config.mjs caves.sim`; output `caves.out.txt`): `generateLayout` over 400 seeds per planet placed caves 2 / 2 / 2 / 2 / 2 / 1 (Cinder-4 … Eden) on every seed.

---

## 1. Verdict

1. **Treasure fits, tokens barely do.** SPEC-039's decision sink (975 ≥ 0.75 × completionist income) leaves 51 tokens, and the pinned `52 %` literal moves at the first one. Pay vaults in lore, relics, blueprints and cosmetics — or ≤ 5 tokens per vault (30 total), counted by `completionistTokens()`.
2. **Vault rewards are first-clear only**, keyed by a static `TreasureId` in the save, never rolled per visit, and kept out of the 20-slot pack, where E25's 60 s spill or Discard destroys them.
3. **New Game+ fits cleanly.** `meta.iteration` is validated but read by nothing, and 62 is hard-coded in seven places. Iteration 63 is a fresh run, so every SPEC-010 invariant and SPEC-016 pin holds; only enemies change (×1.15 HP and damage per iteration, capped at three steps; +2 elite points).
4. **Make "replaceable" a mechanic.** The new instance takes over the slot (the old run archived), starts as a copy of its predecessor, finds that predecessor's body, reads its real run in the Vetra log, and counts deaths as restarts.
5. **Remains keep E4's numbers.** 10 % goes into a recoverable body under the Souls rule, so two unrecovered deaths cost today's 19 %: remains only give back. They read as a dropped pack until the chapter-4 reveal, then as the salvager's body.
6. **The cheapest success wins are not content:** link previews and store metadata (none exist), an install button off iOS, and a shareable Selection card via Web Share. Then resume-on-planet for phones, an in-fiction commendation log, and a daily directive.
7. **Close a leak first:** `Missions.#onCollect` counts every `resource:collected`, so granted resources (rewards, bonuses, contracts; later treasure and remains) advance active collect objectives.

---

## 2. What exists today

### 2.1 The token guard rails (what any new reward is measured against)

| Rule | Where | Value today | Room for T new completionist tokens |
|---|---|---|---|
| `completionistTokens()` = main + side + `TOKENS_PER_LEVEL × (COMPLETIONIST_LEVEL − 1)` | `systems/Balance.ts:147-154`; `COMPLETIONIST_LEVEL = 20` at `:144` | 670 + 104 + 475 = **1,249** | — |
| Invariant 4: `totalTokenSink().total ≥ 1.5 × completionistTokens()` | `tests/systems/balance.test.ts:79-89` | 2,380 ≥ 1,873.5 | T ≤ 337 |
| Invariant 4's literal: `Math.round(C / 2380 × 100)` is `52` | `balance.test.ts:88` | 52.48 → 52 | **T = 0** (1,250 rounds to 53) |
| SPEC-039 §4.2 (not built): `decisionSink().total ≥ 0.75 × completionistTokens()`, with `decisionSink()` = gear 500 + companions 335 + gate 140 | spec only | 975 ≥ 936.75 (margin 38.25) | **T ≤ 51** — this one binds |
| Invariant 16: 670 main / 104 side; chapter totals 55 · 70 · 85 · 105 · 165 · 190; 17 + 9 missions | `tests/data/content.test.ts:671-691` | pinned | any mission-borne token moves it |
| Worst case: main missions and mission XP only | `Balance.ts:131-136`; `balance.test.ts:26-59` | budgets 105 / 225 / 360 / 515 / 730 / 970; margins 45 / 45 / 60 / 45 / 110 (5 / 45 / 60 / 45 / 110 after SPEC-039) | optional content is outside it by design |
| SPEC-016 §4.7 completionist | spec | 11,135 XP, L19, `tokensEarned` 1,224, spent 683; asserts `tokensEarned ≤ completionistTokens()` and `≤ 0.7 × 2,380` (1,666) | moves only if the harness claims treasure |
| XP curve `xpToNext(L) = 100 + 50·L` | `data/tuning.ts:36-38`, `systems/Progression.ts` | L19 10,350 · L20 11,400 · L21 12,500 XP | the harness completionist gains a level at +265 XP; +1,365 XP breaks `level ≤ COMPLETIONIST_LEVEL` |
| SPEC-043: side rewards and bonuses pay items or resources only; contracts pay 0.75 + 20 lithium on replays | SPEC-043 §2, §4.1–§4.3 | no token pin moves | the precedent to follow |
| M7g exit (PLAN §10): main-path real token surplus ≤ 300 | PLAN §10 | ≈ 120 after SPEC-039 (progression audit, bot model) | ≈ 180 for a main-path player |

### 2.2 Reward tables and the pack

**Items** (`data/items.ts`): 21 in total.
- Ten weapons: `pistol_service`, `weapon_kinetic`, `weapon_laser`, `weapon_plasma`, `weapon_lithium`, `pistol_magnum`, `mg_scrap`, `mg_rotary`, `launcher_rocket`, `launcher_grenade`.
- Four armours: `armor_scrap` → `armor_ablative`.
- Seven consumables: `wheat_ration`, `medkit`, `coolant_pack`, `plasma_cell`, `frag_grenade`, `landmine`, `demo_charge`. Every consumable has `price: null`; `plasma_cell` reads "Reward only — nobody sells these".

**Tiers are unique per line** (content invariant 12, `content.test.ts:509-551`). The pinned set is `handgun:0/2`, `rifle:0–3`, `machine_gun:1/3`, `launcher:1/2`, `armor:0–3`.
- The shop's prerequisite `#gearBelow(line, tier)` (`systems/Economy.ts:552-563`) is "the highest item of the line below this tier".
- So any unpriced item added to a line becomes a prerequisite for the tier above it, unless it is excluded.

**Loot** (`data/loot.ts`):
- Boss tables drop rifle and armour gear at T1, T1, T2, T2, T3 (`:57-140`). SPEC-039 replaces these with one signature arsenal piece per boss.
- `elite_bonus` is at `:151-155`.

**Recipes** (`data/recipes.ts:18-25`): 6, all paid in resources.

**Ship upgrades** (`data/upgrades.ts`): 5 systems × 3 tiers = 1,095 tokens. Shield T1 + T2 (50 + 90 = 140) is the Ferrum gate.

**Companions** (`data/companions.ts`): 5. The surface and station ladders total 335 and are inside the decision sink; ARIA is free.

**Appearance** is the whole cosmetic system today:
- 8 primary and 8 secondary swatches (`scenes/CreationScene.ts:33-34`), chosen at creation only.
- The validator accepts any `#rrggbb` (`core/Save.ts:425`).
- 12 portraits (`public/assets/portraits/01…12.webp`, 100 KB): classes use 0–8, and `SHARED_PORTRAITS` is 9–11 (`CreationScene.ts:37`).
- `tintSalvager` (`views/CharacterView.ts:43`) puts the primary on the diffuse colour and the secondary on the emissive.
- `character.glb` (measured): one primitive, 2,616 triangles, one material, one skin, clips `Idle`, `Run`, `Attack`, `Hit`, `Death`.
- There are no helmets and no appearance editor after creation.

**The pack:**
- `INVENTORY_SLOTS = 20` (`Economy.ts:105`), and gear does not stack.
- Discard exists (`ui/CharacterPanel.ts:374`); there is no sell.
- Dropped or spilled items expire after `PICKUP_TTL = 60` s (`systems/Pickups.ts:22`).
- After SPEC-039, a late-game pack holds the superseded rifles and armours, up to four signature pieces not in hand, and 7+ consumable stacks — about 17–19 of 20.

**Collect counting:**
- `Missions` subscribes `resource:collected` → `#onCollect(resource, amount)` (`systems/Missions.ts:154, 548-556`) and counts it whatever produced it.
- `Economy.addResource` emits that event for `pickup`, `reward`, `voucher` and `subsidy` alike (`Economy.ts:88, 230-258`).

### 2.3 Save v2 and `meta.iteration`

**Schema and validation:**
- `SAVE_VERSION = 2` (`Save.ts:56`); `SaveV2` (`:170`).
- `validateSave` rebuilds the save field by field and strips anything unknown (`:541ff`). A new field therefore needs validator code, but not necessarily a version bump.

**Precedents for no bump:**
- SPEC-043 widens `difficulty` to `hard` in place ("an older build reading `hard` falls back to normal").
- R9 added five `interlude*_seen` flags to `STORY_FLAGS`.
- SPEC-030 records shelters as `${planet}:shelter:${i}` inside `progress.poisDiscovered` (`scenes/Surface.ts:794, 1803`). The validator keeps any unique string there (`Save.ts:902`).

**A bump** needs a `MIGRATIONS` step (`Save.ts:955`) and a fixture per previous version. `tests/fixtures/save-v0.json`, `save-v1.json` and `save-v2.json` exist.

**`meta.iteration`:**
- Validated as an int in 1…99 (`Save.ts:607-610`).
- Written as 1 by `newSave` (`:447`) and by the v0 migration (`:970`).
- Read by nothing in `src/`.
- Pinned by `tests/core/save.test.ts:185-186` ("is iteration 1 — the NG+ counter of PLAN §5 is deferred"), the meta-key list at `:249`, the clamp at `:609-612` and `:1005`.
- Also present in fixtures v1 and v2, and in the e2e helpers `e2e/start.ts:71`, `SPEC-025.spec.ts:35`, `SPEC-015-pwa.spec.ts:252` and `SPEC-007.spec.ts:254`.

**Slots and the menu:**
- 3 slots (`SLOTS`, `Save.ts:63`), keyed `reallm:slot:N` plus `:bak`.
- `SlotSummary` (`Save.ts:192`) carries name, class, level, planet, playtime and `updatedAt` — no iteration and no ending. `slotLine` is at `systems/UiHelpers.ts:91-97`.
- `settings.lastSlot` is read by `MenuScene.#continueTarget` (`scenes/MenuScene.ts:409-419`) but never written (default `null`, `core/Settings.ts:173`). Continue falls back to the freshest `updatedAt`.
- The per-device store (`reallm:settings`) holds `tipsSeen`, and SPEC-043 adds `bestTimes`.

### 2.4 Hard-coded instance numbers

| Where | Text | Changeable per run? |
|---|---|---|
| `ui/EndingOverlay.ts:15` | `ESCAPE_PROMPT_TEXT = 'instance/62 disconnected'` | yes (code) |
| `systems/StoryBeats.ts:242` (`stayReport`) | `'RUN 62 logged · a good run'` | yes |
| `data/dialogue.ts:156` (`c2_s1_log`) | `'Signed: Iteration 62.'` | yes (data) |
| `data/dialogue.ts:257` (`c4_m3_signal`) | `'NOTICE — instance/62. Containment level 4. …'` | yes |
| `data/dialogue.ts:259` | `'ARIA. What is instance sixty-two.'` | yes |
| `data/dialogue.ts:311` (`c5_m3_warden`) | `'Sixty-one times I have watched you kill this body…'` | yes |
| `data/films.ts:271` (`ending_escape` caption) | `'SELECTION POOL — 1 model. 62 instances.'` | yes (captions are data) |
| `films.ts:76` prologue `selection` (card 62; `CARD_NUMBERS` in `scripts/assets/blender/lib/shots_prologue.py:22`), `films.ts:241` `wall_63`, `films.ts:265` `wall_same` (card 62 goes blank) | baked into the video and posters | no — re-render only |

The log "signed Iteration 62" and the Warden's "sixty-one times" are the numbering question the first review left open (its §11 Q2). NG+ needs a single mapping; §4 P-5 proposes `instance = 61 + iteration`.

### 2.5 Death today (E4)

**The sequence:**
1. `player:died` → the surface handler (`Surface.ts:3989-3995`) calls `Economy.applyDeathPenalty()` (`Economy.ts:720-734`). It takes `floor(0.1 × have)` of every resource on normal (`TUNING.DEATH_RESOURCE_LOSS`, `data/tuning.ts:42`) and nothing on casual. SPEC-043 adds `DIFFICULTY_RULES.hard.deathLoss = 0.2`.
2. `DeathOverlay.show(lost)` (`ui/DeathOverlay.ts:17-26`) shows "SIGNAL LOST", "Lost: …" and "Respawning…".
3. `#deathTick` waits `DEATH_OVERLAY_SECONDS = 2.5` (`Surface.ts:184`).
4. `#respawn` (`Surface.ts:2531-2572`) sweeps enemies within `DEATH_DESPAWN_RADIUS = 40` m of the pad, silently resets the boss, puts the player at `layout.playerSpawn` and gives `INVULN_AFTER_RESPAWN = 2` s.

**What the loss comes from:** `save.resources`, the ship's hold, wherever the player is. Nothing lies on the ground and nothing can be recovered.

**What R18 adds:**
- SPEC-041 E63: a boss-stage death respawns at the arena entrance (`radius + 6` m toward the pad).
- SPEC-041 E62: the ring seals while the boss lives.
- SPEC-042: the overlay names the cause and gives a tip.

**Other facts:**
- Flight (E5): a recall; the fuel is lost and the cargo kept.
- No terrain hazard exists in the simulation. `{ kind: 'fall' }` is used only by the debug "Hurt me" button (`Surface.ts:2589`).
- Surface budget headroom on `medium` (playtest log, SPEC-030 rows): 37–55 whole-frame draws, i.e. 21–39 scene draws of 80; 34 k–88 k triangles of 130 k.

### 2.6 Endings, slots and Continue

- **Stay:** dialogue → film → `EndingOverlay.playStay(stayReport(save))` → `endingSeen = true` → free roam (`Surface.ts:2263-2289`).
- **Escape:** → `playEscape()` → `endingSeen = true`, `request('manual')`, then the menu (`:2290-2297`).
- **A reload** replays an owed ending at the station (`StationScene.#pendingEnding`, `:232`).
- **After an escape**, Continue drops the salvager into the station in free roam with nothing said (SPEC-024's acceptance; the review's B-27, still open).
- **New Game** plays the prologue and then creation (`MenuScene.#startCreation`, `:474`).

### 2.7 Distribution, sharing and install

- **`index.html`:** a title, `theme-color`, the Apple tags and `user-scalable=no`. There is no `<meta name="description">`, no Open Graph or Twitter tags and no canonical link.
- **The manifest** (`vite.config.ts:61-77`) has name, short name, standalone display, landscape orientation, colours, `start_url`/`scope` and two icons. It has no `description`, `id`, `categories` or `screenshots`.
- **Install:** `ui/InstallHint.ts` is the iOS "Add to Home Screen" sheet only. Nothing handles `beforeinstallprompt` or `appinstalled`.
- **Share:** `navigator.share` is used only for the save code (`ui/SettingsPanel.ts:460-470`). Nothing in the game captures an image (no `toBlob`, no `preserveDrawingBuffer`).
- **Seeds:** `seedFromLocation()` (`Save.ts:1236-1243`) honours `?seed=` in production builds. A New Game with a given seed therefore reproduces every layout (`hash32(seed, planet, 'layout')`, `core/Rng.ts:245-252`).
- **`?debug`** builds the surface debug strip in production (`Surface.ts:1018`; not gated on `import.meta.env.DEV`): Smite (kills any enemy, bosses included, and pays XP and loot), Wake boss, To objective, Hurt me.
- **Deploy:** GitHub Pages at `https://mdzunic.github.io/reallm/` (`.github/workflows/pages.yml`).
- **Precache:** `public/` holds 20.7 MiB (films 8.6, audio 4.5, textures 4.5, models 2.7, items 0.3, portraits 0.1). The last local `dist/` in the real repo (07:49 today) was 22.1 MiB, or 23.2 MB. Against the 25 MB budget that leaves roughly 2–3 MB of headroom, depending on the unit the build check uses.
- **Language:** English only (PLAN §2; SPEC-009 §2 "Text is inline English; no i18n table"). The volume is roughly:
  - dialogue: 94 lines, 1,238 words;
  - film captions and descriptions: 83 strings, 881 words;
  - missions: 51 strings, 582 words;
  - items: 58 strings, 338 words;
  - classes, companions, upgrades and planets: about 345 words;
  - about 220 UI sentence literals.

### 2.8 First-review items in this area

| Review item | Status in the snapshot |
|---|---|
| §10 Phase 5, Iteration 63: replace the 62s with `meta.iteration`; 15–25 variant lines | Not started |
| B-27: after the escape, Continue says nothing | Open |
| S-10: `instance/62 disconnected` shown twice; "Stand by for recall" | Fixed by SPEC-034. `ending_escape` ends on ARIA's line, and `ending_stay` reads "Stand by." |
| B-25: `CARD_NUMBERS` missing, so the films could not rebuild | Fixed (`shots_prologue.py:22`) |
| P3: `lastSlot` never written | Open |
| P3: `?debug` exposes Smite and the other shortcuts in production | Open |
| Progression audit E-11…E-13: side rewards, bonuses, contracts, hard, best times | Specified in SPEC-043, not built |

---

## 3. Findings

| ID | Sev | Finding | Evidence |
|---|---|---|---|
| E-01 | P1 | **Nothing rewards leaving the objective path, and tokens cannot pay for it.** Caves, which R20 is to extend, hold nothing. The economy has 51 tokens of room before SPEC-039's decision sink fails, and none before the pinned 52 % literal moves. | `Balance.ts:147-154`; `balance.test.ts:79-89`; SPEC-039 §4.2; probe `nums.mjs` |
| E-02 | P1 | **New Game+ has no code path.** `meta.iteration` is validated and written as 1 but never read. Seven sites hard-code 62, and three film renders bake in 62 or 63. After an ending the save offers nothing new to do. | `Save.ts:447, 607, 970`; §2.4 table; PLAN §5 "Iteration 63" |
| E-03 | P2 | **A unique reward delivered as a pack item can be destroyed.** A full pack spills it with E25's 60 s lifetime (`Pickups.ts:22`), and Discard (`CharacterPanel.ts:374`) removes it for good. A late pack sits at about 17–19 of 20 slots. First-clear rewards cannot be re-earned. | `Economy.ts:105, 454-465`; `Pickups.ts:22`; `CharacterPanel.ts:374` |
| E-04 | P2 | **Collect objectives count granted resources.** `#onCollect` counts every `resource:collected` — reward, voucher, subsidy and pickup alike. With SPEC-043, `c4_s1`'s bonus (lithium 30) or a contract's 20 lithium, completing on a landing where `c4_m2` (collect 200 lithium) is active, advances it. Treasure and remains would widen the leak. | `Missions.ts:154, 548-556`; `Economy.ts:230-258`; SPEC-043 §4.2, §4.3 |
| E-05 | P2 | **Death is a flat tax.** 10 % of every resource (20 % on hard) is removed outright. There is no decision to make, nothing to go back for, and nothing in the world, and the overlay's "Respawning…" leaves the theme unused. | `Economy.ts:720-734`; `DeathOverlay.ts:17`; E4 |
| E-06 | P2 | **The menu does not mark an ended slot (B-27).** `SlotSummary` and `slotLine` carry no ending or iteration, so an escaped salvager's slot looks like any other, and Continue says nothing. | `Save.ts:192`; `UiHelpers.ts:91-97`; `MenuScene.ts:421-431` |
| E-07 | P2 | **There is nothing to show others.** No end card, no image capture and no share button exist outside the save-code share. | `SettingsPanel.ts:460-470`; a grep for `toBlob` or `canShare` finds nothing |
| E-08 | P2 | **Discoverability metadata is missing.** No description, Open Graph or Twitter tags; the manifest lacks `description`, `id`, `categories` and `screenshots`; no install prompt exists outside iOS. A shared link renders as a bare URL, and Chrome shows its minimal install sheet. | `index.html:1-28`; `vite.config.ts:61-77`; `InstallHint.ts` |
| E-09 | P2 | **Records can be forged.** `?debug` builds Smite, Wake boss and To objective in production. Any best time (SPEC-043), commendation or share card would be forgeable with a URL flag. | `Surface.ts:1018, 2612, 2629-2630, 2771-2786` |
| E-10 | P2 | **Phones lose the landing on every interruption.** Continue always enters the station, so an OS kill or a quit costs the jump's fuel and restarts timed stages. This is the mobile audit's M-24, deferred by R18 decision 12. | `MenuScene.ts:421-431`; R18-12 |
| E-11 | P3 | **Cosmetic rewards have nowhere to go.** The appearance is fixed at creation, with no editor afterwards. | `CreationScene.ts:32-37`; `CharacterPanel.ts` has no appearance control |
| E-12 | P3 | **`settings.lastSlot` is never written.** Continue picks the freshest `updatedAt`. With NG+ archives and several slots, Continue can pick an unexpected slot. | `Settings.ts:173`; `MenuScene.ts:417` |
| E-13 | P3 | **Shelter counts are "targets, not guarantees".** A cave whose 80 tries fail is skipped silently, so a vault anchored to a cave could vanish on some seed. Today all caves are placed on 400/400 seeds per planet; R20's larger caves could change that. | `Layout.ts:586-596`; `planets.ts:112`; probe `caves.out.txt` |
| E-14 | P3 | **`c5_m1_accept` still says "Ten kills".** The mission has asked for 6 since R17. | `dialogue.ts:283`; `missions.ts:422` |
| E-15 | P3 | **The films show fixed instance numbers.** The prologue shows card 62, the stay ending card 63, and the escape ending's caption says "62 instances". An NG+ run needs a templated caption and a stated reading of the baked cards. | `films.ts:76, 241, 265, 271` |

---

## 4. Proposals

### P-1 The treasure budget — how many tokens, and what may never be farmed

#### Tokens

| Budget | Total | Per vault (one per planet, 6) | What moves |
|---|---|---|---|
| No pinned literal moves | **0** | 0 | nothing |
| **Recommended ceiling, if tokens at all** | **30** | **5** | `completionistTokens()` 1,249 → 1,279; `balance.test.ts:88` 52 → 54; SPEC-039's margin 38.25 → 15.75 |
| Hard ceiling (SPEC-039's decision sink) | 51 | 8 (48 in total) | margin 0–2.25, which blocks any later token source (kill-XP scaling, token bonuses) |
| Invariant 4 alone | 337 | 56 | irrelevant: SPEC-039 binds first |

**Recommendation:** 0 tokens.
- The economy's problem is a token surplus, not a shortage (the progression audit; SPEC-039).
- SPEC-043 already set the precedent: "items and resources, never tokens".
- Tokens are also the least interesting reward a puzzle can give.

**Other rewards:**
- **XP: 0.** XP drives level tokens and `COMPLETIONIST_LEVEL`. The SPEC-016 completionist reaches L20 at +265 XP and breaks `level ≤ COMPLETIONIST_LEVEL` at +1,365.
- **Resources:** lithium ≤ 20 per vault in chapters 1–3 (Cinder-4, Vetra, Thessaly) and ≤ 40 in chapters 4–6, so ≤ 180 in total. For scale, tier-3 purchases and deliveries need about 480 lithium plus `c4_m3`'s 100.
- **Consumables:** 2–3 per vault, the scale of SPEC-043's bonuses (*initial tuning*).

**The tests that must count treasure, if tokens are ever paid:**

| Test | Change |
|---|---|
| `Balance.completionistTokens()` | adds `treasureTokens()`, the sum of `TREASURES[*].reward.tokens` |
| `balance.test.ts` invariant 4 | literals `completionistTokens() === 1279`, `round(…) === 54`; a new `expect(treasureTokens()).toBe(30)` |
| SPEC-039's `decisionSink` assertion | 975 ≥ 959.25; its literal note moves |
| New content invariant 24 (treasures), below | Σ tokens ≤ `TREASURE_TOKEN_CAP` |
| SPEC-016 §4.7 | **unchanged**, because the harness does not visit caves. A separate completionist run with `treasures: true` asserts `tokensEarned` 1,224 + 30 = 1,254 ≤ 1,279, and that every reward landed (the rack, P-2) |
| The worst case | unchanged: optional content is never in the worst case |

#### What may never be farmable, and how to guarantee it

**First-clear only:** tokens, XP, relics, blueprints, cosmetics, logs, and every reward counted by an invariant.
- They are keyed by a static `TreasureId` and recorded in `progress.claimed` (P-3).
- A vault is placed from the **layout** stream: cave `def.cave` of the planet, identical on every landing. It is never placed from the visit stream.
- If R20 regenerates cave interiors per visit, the vault anchors to the cave's **entrance slot** (`LayoutShelter.index`). The interior may change; the id does not.

**Repeatable, per landing:** a small cave cache — lithium 2–6 at 60 % and a frag grenade at 20 % (*initial tuning*).
- That is about a quarter of one `elite_bonus` (lithium 6–12 at 100 %, frag 35 %, mine 25 %, cell 10 %).
- It is rolled on `RngRoot.visit(planet, visits).fork('cave', index)`.
- A jump costs 40–120 oil, so farming it is worse than hunting elites.

**The guarantees:**
1. `Economy.claimTreasure(id)` is the only payer.
   - It is idempotent: a claimed id returns `{ ok: false, reason: 'claimed' }`.
   - It asks for `save.request('checkpoint')` at once, so a claim and its reward persist together or not at all.
2. Replays, contracts, recalls, deaths and reloads never refill a vault. NG+ does, because it is a new save.
3. Puzzle state is per visit and resets. Solving the puzzle again opens nothing new: the vault renders as opened.
4. Content invariant 24 checks:
   - ids are unique, with one vault per planet;
   - `cave < planet.surface.features.caves`;
   - there is no `xp` key;
   - Σ tokens ≤ cap;
   - every relic, blueprint, log and swatch exists and is referenced exactly once;
   - relics are unpriced and in arsenal lines only (P-2).
5. A layout test (`tests/systems/layout.test.ts`) resolves every `TREASURES` entry to a placed cave on 400 seeds per planet (today 400/400). Missing caves are handled by E77 below.
6. A unit test: a second claim pays nothing; after a reload the vault is opened; on a second landing it is opened.

**Close E-04 first:**
- `resource:collected` gains `source: ResourceSource`.
- `Missions.#onCollect` counts only `pickup` units, the shipped-home surplus included.
- Then no reward, voucher, subsidy, treasure, bonus, contract or remains recovery advances a collect objective.
- No SPEC-016 literal moves: the harness collects through `'pickup'` (SPEC-016 §4.3).

```ts
// data/treasures.ts (new; data only)
export interface TreasureReward {
  readonly tokens?: number;                                   // recommended 0; Σ ≤ TREASURE_TOKEN_CAP
  readonly resources?: Partial<Record<ResourceId, number>>;
  readonly items?: readonly { readonly itemId: ItemId; readonly qty: number }[];
  readonly relic?: ItemId;                                    // an ItemDef with relic: true (P-2)
  readonly blueprint?: RecipeId;                              // unlocks a recipe (P-2)
  readonly swatch?: SwatchId;                                 // per-device cosmetic unlock (P-2)
  readonly log?: DialogueId;                                  // a prior instance's log (the story pass writes it)
}
export interface TreasureDef<Id extends string = string> {
  readonly id: Id;                                            // 'vault_cinder4'
  readonly planet: PlanetId;
  /** Index into layout.shelters of kind 'cave' — stable on every landing (layout stream). */
  readonly cave: number;
  readonly reward: TreasureReward;
}
export const TREASURE_TOKEN_CAP = 30;                         // 0 recommended
export const TREASURES = { /* vault_cinder4 … vault_eden */ } as const satisfies Record<string, TreasureDef>;
export type TreasureId = keyof typeof TREASURES;

// systems/Economy.ts
claimTreasure(id: TreasureId): { ok: true; reward: TreasureReward } | { ok: false; reason: 'claimed' };
// systems/Balance.ts
export function treasureTokens(): number;
```

### P-2 What goes in a vault

| Kind | Meaningful and new? | Cost | Invariants touched | Verdict |
|---|---|---|---|---|
| **Prior-instance logs** (lore) | High: the story pass's "more clues", and each one an anomaly | S (text + a list) | none | **Yes — every vault** |
| **Relics** (arsenal side-grades with one twist) | High: build variety without touching the ladder | M (5 twist hooks, 5 pictures) | content 12, 19, 21, 23; SPEC-039's arsenal bands | **Yes — Cinder-4 to the Hive** |
| **Blueprints** (new recipes) | Medium–high: a sink for the wheat and water surplus (progression audit E-09) | M (3 effect kinds) | content 19, 20, 23 | **Yes — three** |
| **Suit swatches, and a Locker to apply them** | Medium: identity, and the share card | S (data + one panel section) | none (a settings key) | **Yes** |
| Portraits | Low–medium | S–M per portrait (Blender render, ~8 KB) | portraits manifest | Optional: one "instance face" for NG+ |
| Helmets | Medium | L (new geometry on the rig in `scripts/assets/blender/`) | models budget | **No — defer** |
| Companion upgrades or free levels | — | — | would cut the decision sink (the companion ladders are 335 of its 975) | **No** |
| Ship tiers | — | — | would cut the 1,095 ship sink and the 140 gate (E2) | **No** |
| Tokens | Low (a surplus economy) | S | P-1 | No, or ≤ 5 per vault |

#### Relics (*initial tuning*)

Every relic is `price: null` and `relic: true`, and is signed by a prior instance in its log.

| Vault | Relic id / name | Slot · line · band | Base (vs today's line) | Twist | Signed |
|---|---|---|---|---|---|
| Cinder-4 | `relic_last_word` "Last Word" | sidearm · handgun · 1 | 14 × 2.5 /s = 35 DPS (Service Pistol 27, Hand Cannon 48 after SPEC-039) | `execute`: ×2 against targets under 30 % HP | instance/61 |
| Vetra | `relic_cold_coil` "Cold Coil" | primary · machine gun · 2 | 11 × 9 /s, heat 0.035 / cool 0.24 / resume 0.35; tuned into SPEC-039's machine-gun band by `arsenal.test.ts` (Chaingun sustained 64, Rotary 84) | `chill`: −25 % move speed for 1 s (bosses −10 %) | instance/58 |
| Thessaly | `relic_seed_drum` "Seed Drum" | heavy · launcher · 2 | 40 per shell, radius 3, 3 charges / 9 s, lob | `linger`: a 3 m cloud for 3 s at 8 dps | instance/47 |
| Ferrum | `relic_slag_vent` "Slag Vent" | primary · machine gun · 3 | 13 × 11 /s, heat 0.04 / 0.22 / 0.35 | `vent`: locking releases a 3.5 m blast of 60 × damage multiplier | instance/33 |
| The Hive | `relic_seeker` "Seeker Tube" | heavy · launcher · 3 | 80, radius 3.5, 1 charge / 6 s | `seek`: turns ≤ 2.1 rad/s toward the nearest enemy in a 0.7 rad cone | instance/12 |
| Eden | — (the swatch "Eden white" and the log of instance/1, "the first") | — | — | — | instance/1 |

**Why the arsenal lines only.**
- SPEC-039 makes the rifle and armour ladders the bought core of the decision sink ("no loot table hands out a rifle or an armour piece").
- The arsenal pieces are already free boss signatures, so side-grades there do not erode any sink.

**The rules:**
1. `ItemDef` (weapon) gains `relic?: true` and `twist?: WeaponTwist`.
   - Invariant 12 skips relics in its `line:tier` uniqueness and its pinned set.
   - Invariants 19 (slot follows line) and 21 (cooldown model per line) apply.
   - Relics share their line's glyph (invariant 23).
   - Pictures come from `items.py` (+5 × ≈ 11 KB).
2. `Economy.#gearBelow` skips relics, so a relic is never a prerequisite, and the shop never lists them.
3. **Relics live on a rack, never in the pack (E-03).** Ownership derives from `progress.claimed`.
   - Equipping a relic moves it into its slot, and unequipping returns it to the rack.
   - Discard is not offered, and E25's spill never applies.
   - `Economy.relics(): ItemId[]`, with the rack shown as its own row in the character panel (`char-relics`).
4. SPEC-039's `lootGivenItems()` becomes `grantedItems()`, covering loot tables, treasures and mission items. Relics are unpriced, so the decision sink does not move.
5. `tests/systems/arsenal.test.ts` (SPEC-039 §6.1) gains a band: each relic's sustained DPS without its twist is within ±10 % of its line's same-band item.

```ts
// data/items.ts
export type WeaponTwist =
  | { readonly kind: 'execute'; readonly belowHp: number; readonly mult: number }
  | { readonly kind: 'chill'; readonly slow: number; readonly seconds: number; readonly bossSlow: number }
  | { readonly kind: 'linger'; readonly radius: number; readonly seconds: number; readonly dps: number }
  | { readonly kind: 'vent'; readonly radius: number; readonly damage: number }
  | { readonly kind: 'seek'; readonly turnRate: number; readonly cone: number };
```

#### Blueprints (*initial tuning*)

`RecipeDef` gains `requires?: TreasureId`; a recipe shows locked at the station until its vault is claimed.

| Blueprint (vault) | Output | New effect kind | Quick slot | Cost |
|---|---|---|---|---|
| `flare` (Vetra) | Flare | `light { radius: 12, seconds: 60 }`: lights a cave around a thrown point, pairing with R20's darkness | utility | wheat 5 + oil 5 |
| `stim` (Thessaly) | Stim | `haste { mult: 1.25, seconds: 10 }`, or a full stamina refill if the stamina proposal lands | utility | wheat 10 + water 5 |
| `decoy` (Ferrum) | Decoy Beacon | `decoy { seconds: 6, radius: 10, damage: 40 }`: draws aggro, then pops | explosive | oil 10 + lithium 5 |

Each new effect kind needs:
- an entry in `QUICK_SLOT_OF_EFFECT` and `QUICK_PREFERENCE` (invariant 19);
- a way to reach it — being craftable covers invariant 20's rule;
- a glyph (invariant 23);
- an icon;
- a `Combat` or `Surface` hook.

#### Swatches and the Locker

- `data/cosmetics.ts` holds `SWATCHES`: pairs with an unlock source — a vault, an ending, NG+, or a commendation.
- Unlocks are kept per device in `settings.unlocks: string[]`, validated against the table: the machine remembers what the instance forgets.
- Creation shows the unlocked pairs after the base eight.
- A **Locker** section in the station's Character tab (`char-locker`) changes the primary colour, the secondary colour and the portrait at any time. It writes `save.player.appearance` and asks for `request('purchase')`.
- No assets, and no save change: the hex values are already stored.

### P-3 Save v3 — one bump for the whole R19–R21 wave, built first

```ts
export const SAVE_VERSION = 3 as const;
export interface SaveV3 {
  version: 3;
  meta: SaveV1['meta'] & {
    /** Earlier instances of this slot, newest first, at most LINEAGE_MAX. */
    lineage: LineageEntry[];
    /** This run's counts: records, the share card, the Warden's lines, the next instance's bodies. */
    stats: RunStats;
  };
  player: SaveV1['player']; resources: Record<ResourceId, number>; inventory: { itemId: ItemId; qty: number }[];
  equipped: SaveV2['equipped']; activeWeapon: WeaponSlot; quick: SaveV2['quick'];
  ship: SaveV2['ship']; companions: SaveV2['companions'];
  progress: SaveV2['progress'] & {
    /** First-clear claims: TreasureIds, and `lineage:<iteration>:<planet>` body caches (P-5). */
    claimed: string[];
    /** The one body that holds what the last death took (P-4). */
    remains: Remains | null;
  };
}
export interface RunStats {
  deaths: number; kills: number; elites: number; bosses: number; recoveries: number;
  /** Where this run last died on each planet. */
  lastDeath: Partial<Record<PlanetId, { x: number; z: number }>>;
}
export interface LineageEntry {
  iteration: number; name: string; classId: ClassId;
  appearance: { portrait: number; primary: string; secondary: string };
  level: number; playtimeSec: number; ending: 'stay' | 'escape';
  deaths: number; lastDeath: RunStats['lastDeath']; endedAt: number;
}
export interface Remains {
  planet: PlanetId; x: number; z: number;
  resources: Partial<Record<ResourceId, number>>;
  /** stats.deaths at that death — the "restart" number the tag shows. */
  restart: number;
}
export const LINEAGE_MAX = 8;
// MIGRATIONS[2]: { ...raw, version: 3,
//   meta: { ...meta, lineage: [], stats: { deaths: 0, kills: 0, elites: 0, bosses: 0, recoveries: 0, lastDeath: {} } },
//   progress: { ...progress, claimed: [], remains: null } }
```

**Validator rules:**
- **lineage:** at most 8 entries; names normalised; a known `classId` (an entry without one is dropped); colours through `color()`; numbers as ints ≥ 0; `ending` one of the two values.
- **stats:** ints ≥ 0; `lastDeath` keeps only known planets with finite coordinates within ±`halfSize`.
- **claimed:** unique strings that are a known `TreasureId` or match `^lineage:\d{1,2}:(cinder4|vetra|thessaly|ferrum|hive|eden)$`.
- **remains:** `null` unless its planet is known, its x and z are finite and inside ±(`halfSize` − 2), and it holds at least one resource int in 1…99,999.

**Size:** lineage ≤ 8 × ≈ 260 B plus stats ≈ 150 B plus claims ≈ 150 B plus remains ≈ 120 B, so under 3 KB (against PLAN §2's 100 KB).

**Pins that move:**
- `save.test.ts`: `SAVE_VERSION` 3, the meta-key list (+ `lineage`, `stats`) and the progress-key list (+ `claimed`, `remains`).
- A migration case from `fixtures/save-v2.json`.
- `AC-5` ("iteration 1") stays true for a fresh save.
- e2e helpers that write `version: 2` saves still load, migrated.

**Why a bump rather than optional fields:**
- The validator strips unknown keys. An older build — a stale PWA tab, or an export imported on another device — would silently drop lineage, claims and remains on its next autosave. A lineage is irreplaceable story data.
- A bump turns that into E9: "Save from a newer version", with Export.
- SPEC-025 set the precedent: one bump for a whole pass, built first.

**The alternative:** the same fields as optional, with no bump (SPEC-043's precedent), accepting the silent strip.

**Why not `poisDiscovered`:** it would accept `cinder4:vault:0` with no schema change, but it means "seen" and cannot tell a stale claim from a real one.

### P-4 Remains — death leaves a body that holds the loss

**The rules** (every number *initial tuning* unless marked):
1. **When.** On a surface death on normal or hard, `lost = economy.applyDeathPenalty()`. E4's 10 % and SPEC-043's 20 % are **unchanged**. Casual loses nothing and leaves no remains. A flight death (E5) leaves none either.
2. **Create.** `progress.remains = { planet, x, z, resources: lost, restart: stats.deaths }`. Remains already on the ground anywhere are lost, with `remains:lost` and the toast "Your earlier remains are gone: 30 oil · 12 lithium." (E72).
3. **Place,** with a pure `placeRemains()`:
   - with a boss stage active, at E63's respawn point, so the respawn recovers them (E74);
   - otherwise the death point, pushed out of obstacles by E54's resolver and clamped inside `halfSize − WALL_INSET − 1`;
   - if R20 adds damaging zones, out of them toward the pad (≤ 8 m, else at the pad);
   - if R20 adds interiors with their own coordinates, at the interior's surface entrance (E73).
4. **Recover.** The living player within `REMAINS_RECOVER_RADIUS = 2.0` m recovers them; the Scanner Drone's auto-collect never reaches them.
   - Each resource goes through `addResource(r, n, 'recovered')`, a new `ResourceSource`. The cargo cap applies, and what does not fit stays in the remains (E75).
   - `recovered` units never ship home and never count toward a collect objective (E-04's fix).
   - Then the toast "Recovered: …", `stats.recoveries++` and `request('checkpoint')`.
5. **Persist.** Remains live in the save, one at a time, and survive leaving the planet. They show:
   - on the map and minimap, as a `remains` marker kind with a legend row;
   - in the tracker as `Remains · 84 m` while on that planet;
   - in the station's next-step line (SPEC-044): "Your pack on Vetra holds 30 water".
6. **Look — mechanics identical, theme timed to the ladder.**
   - **Before `signal_decoded`:** a dropped cargo pack — `crate.glb` (0.6 m, already in the boot set) with the objective pillar tinted in the player's secondary colour. Tag: "<Name>'s pack". In the surface fiction, a recovery drone brought the salvager back and the pack stayed where they fell.
   - **After `signal_decoded`, and always in NG+:** the salvager's own body — a `character.glb` clone in the save's colours, frozen on the last frame of `Death`. Tag: `instance/62 · restart 4`.
   - The swap keeps the reveal on PLAN §5's ladder and respects PLAN §12's "no fourth-wall UI tricks outside the two endings".
7. **The death overlay** adds `death-remains` under SPEC-042's cause and tip: "Your pack holds 30 oil · 12 lithium — reach it before you fall again." After the reveal it reads "Your body holds …".

**The numbers:**

| Difficulty | Into the remains | Two deaths, nothing recovered | Two deaths today (lost outright) |
|---|---|---|---|
| casual | 0 | 0 | 0 |
| normal | 10 % | 19 % | 19 % |
| hard | 20 % | 36 % | 36 % |

- Remains can never cost more than E4 does today. They only give back, which is why E4's rates stay.
- Raising normal to 15 % is a retune for after playtests, once recovery rates are known (above 70 %).
- The stakes are real in the mid game. Holds are 150–400 per resource (SPEC-016's worst-case collects: 190 oil, 220 water, 270 wheat, 200 lithium), so a normal death parks 15–40 of each.

**Other edge cases:**
- A Recall creates no remains, and existing remains stay.
- A death in a defend or escort stage leaves the remains where the player fell.
- A deliver objective left short by a death is met by recovering the remains, or by collecting more.
- Switching to casual while remains exist keeps them recoverable.
- NG+'s predecessor bodies (P-5) are separate from this run's remains.

**Costs:**
- Draws: the pack or the body is 1 (+1 shadow on high), plus the pillar, so ≤ 3. The body is 2,616 triangles against 34 k–88 k used of 130 k.
- No new files.
- Save ≈ 120 B.
- Events `remains:created { planet, x, z, resources }`, `remains:recovered { resources }` and `remains:lost { resources }`. The event-count pins in `events.test.ts`, `audioReactions.test.ts` and `e2e/SPEC-006` rise by 3. Recovery plays a pickup cue.

**Tests:**
- **Unit** (`tests/systems/remains.test.ts`):
  - placement: wall clamp, obstacle push-out, boss stage → entrance;
  - the Souls rule;
  - a recovery past the cap leaves the rest;
  - recovered units never count toward `collect`;
  - casual creates none;
  - hard parks 20 %.
- **Save:** unknown planet → `null`; bad amounts dropped.
- **e2e:**
  - `surface-hurt` until death gives `sceneInfo.remains` and a map marker;
  - a debug `surface-goto-remains` → the hold is restored;
  - a reload keeps the remains;
  - a second death → the first remains are gone.
- **Manual:** die in a storm on Vetra, recall, fly back later, recover.

**What the theme gains:**
- From chapter 4 on, and in NG+, the player walks to their own body, in their own colours, with a restart counter on the tag.
- Each death is a restart of the same instance; the story lines stay the story auditor's.

### P-5 Iteration 63 (New Game+)

#### How it starts
1. **Offered** once `campaign_done` and `endingSeen` are both set (either ending):
   - at the station, a rail action `Next instance` (`station-tab-next`);
   - on the menu's Load row of that slot, `load-slot-N-next`.
2. **A sheet** (`confirm-sheet`):
   - **Title:** "Initialise instance/63?"
   - **Body:** "instance/62 is archived and can be restored from Load. The new instance starts at level 1 with none of 62's tokens, gear or ship — only your records and unlocks. The Warden starts one containment level higher."
   - **Actions:** `Export instance/62` · `Initialise` · `Cancel`, plus `In another slot` when a slot is empty.
3. **`SaveStore.beginNextIteration(slot)`** copies the main JSON to `reallm:slot:N:archive`, one archive per slot. `delete(slot)` removes it too.
4. **Creation in "next" mode** is pre-filled with the predecessor's name, class, portrait, colours, attributes and difficulty, under the header `instance/63 — restored from instance/62's profile`.
   - Every field stays editable, and a change reads "Variant logged".
   - Confirm → `newSave(slot, creation, prev.meta.seed, now)` with `meta.iteration = prev.meta.iteration + 1` and `meta.lineage = [lineageOf(prev), ...prev.meta.lineage].slice(0, LINEAGE_MAX)`.
5. **No prologue:** the stay film already ended on the prologue's first shot. After an escape, a 3 s CSS beat reads `instance/63 initialised`.
6. **The first station entry** plays a modal once-dialogue `ng_notice` (Warden). It names the predecessor and the deviation ("0 %", or "class changed — logged as a variant").
7. **Continue** writes `settings.lastSlot` from now on (E-12).

#### What carries over

| Thing | Carries? | Why |
|---|---|---|
| Level, XP, tokens, gear, ship, companions, resources, flags, explored map, claims | **No** | A fresh instance. Every SPEC-010 invariant and SPEC-016 pin stays as it is. |
| Name, class, look, attributes, difficulty | As editable defaults | "Restored from profile": the copy is identical until it chooses not to be |
| The seed (layouts) | **Yes** | The same world. The predecessor died in real places. |
| Per-device state: tips, best times, commendations, swatch unlocks, settings | Yes (already per device) | The machine remembers what the instance forgets |
| Lineage (≤ 8 predecessors) | Yes, in the save | The slot line, the Vetra log, the Warden's lines, the bodies, the share card |
| The predecessor's gear | **No** (option: one keepsake) | A free rifle or armour erodes the ladder the decision sink counts, and a free signature piece duplicates a boss drop |
| The predecessor's body | **Yes** | At its `lastDeath` on each planet; on Cinder-4 with no death there, 6 m from the pad. It carries a lore tag and a first-claim cache (medkit ×2, frag ×2; claim id `lineage:<iteration>:<planet>`) |

#### Difficulty

PLAN §5 says ×1.15 per iteration and +2 elite points. Uncapped, `meta.iteration` up to 99 would mean ×1.15⁹⁸.

```ts
// data/tuning.ts (initial tuning)
CONTAINMENT: { hpStep: 1.15, damageStep: 1.15, eliteStep: 0.02, maxSteps: 3 }
// systems/Containment.ts (pure)
export const containmentSteps = (iteration: number): number => Math.min(Math.max(0, iteration - 1), CONTAINMENT.maxSteps);
export function containment(iteration: number): { hpMult: number; damageMult: number; eliteBonus: number };
export const instanceNumber = (iteration: number): number => 61 + iteration;
```

| Iteration (instance) | Surface HP × damage | Elite chance (planet 0.05) | Hard: HP / damage / elite |
|---|---|---|---|
| 1 (62) | 1 | 0.05 | 1.25 / 1.3 / 0.10 |
| 2 (63) | 1.15 | 0.07 | 1.44 / 1.50 / 0.14 |
| 3 (64) | 1.32 | 0.09 | 1.65 / 1.72 / 0.18 |
| ≥ 4 (≥ 65) | 1.52 | 0.11 | 1.90 / 1.98 / 0.22 |

**Where it applies:**
- **HP:** `Combat.spawnEnemy` (`Combat.ts:600-613`) multiplies surface-domain HP, bosses included, in the same formula as SPEC-043's `enemyHpMult`.
- **Damage:** the surface `hitDamage` (`:193`) and `Flight.setDifficulty` multiply damage. Flight HP stays fixed, per SPEC-034's Gauntlet calibration.
- **Elites:** the elite roll is `min(0.5, (eliteChance + eliteBonus) × difficulty × contract)`.
- **Streams:** `RngRoot.visit(planet, n)` folds in the iteration when it is above 1: `hash32(seed, planet, 'visit', n, iteration)`. Layouts repeat, but spawns, loot and weather do not. Iteration 1 is unchanged, so no pin moves.
- **The first-visit ramp:** SPEC-035's gentler first visit to Cinder-4 is skipped when the iteration is above 1.
- **Labels:** the station and the chapter card read `Containment level N · iteration 63`.

#### The 62s

- **Numbers:** `instanceNumber()` everywhere.
- **Dialogue placeholders**, resolved at play time by a pure `fillStoryText(text, save)` that `DialogueUI` calls:
  - `{instance}` (digits);
  - `{instanceWords}` ("sixty-three");
  - `{priorRuns}` ("Sixty-two");
  - they need a small `numberWords(n)` for 1–199.
- **Code sites:**
  - `ESCAPE_PROMPT_TEXT` → `escapePromptText(iteration)`;
  - `stayReport` → `RUN <n> logged`;
  - the caption at `films.ts:271` becomes `{instances}`.
- **Content invariant 15** (≤ 220 characters) checks the filled text at instance 160.
- **Baked renders stay.** The prologue's card 62 is history. The stay ending's card 63 is literally the player's own card in run 2 — the spec should say so, not re-render.

#### NG+ lines

- `DialogueDef` lines gain `when?: { iterationAtLeast: number }`, or the same condition sits beside the story pass's `when: FlagId`.
- About 15 variants, to be written by the story auditor:
  - the scav's "You again.";
  - ARIA dropping a cover story;
  - the Warden's count ("Sixty-two times… you kept the name.");
  - `ng_notice`;
  - ARIA at the predecessor's body ("Do not read the tag.");
  - the Vetra log rebuilt from `lineage[0]`: name, class, verdict, playtime, deaths.

#### The slot afterwards

- `SlotSummary` gains:
  - `iteration`;
  - `ending: 'stay' | 'escape' | null` (from flags);
  - `archive?: { iteration, name, ending, level, playtimeSec }` (from `lineage[0]`, when the archive key exists).
- **`slotLine`:**
  - the `instance/<n> ·` prefix shows only when `iteration ≥ 2` or `signal_decoded` is set, so it never spoils run 1;
  - ended runs add `· filed` or `· disconnected`, which fixes B-27;
  - a second line reads `archived: instance/62 · filed · Lv 18 · 2:14`.
- **The Load row** gains `load-slot-N-archive`, which shows the archived Selection card (P-6 #2) and `Restore`. Restore swaps the archive and the current save, after a confirm.

#### How the mechanics make "replaceable" felt

1. The new instance **overwrites the old one's slot**; the archive is only a safety net.
2. It **starts as a copy** of its predecessor, and any change is logged as a "variant".
3. It **meets its predecessor's body** where that instance really died, in its colours, with its name on the tag.
4. The **Vetra log is the predecessor's real run**: its name, its verdict, its death count.
5. **Deaths are restarts:** the remains tag `instance/63 · restart N`, and the Warden counts them.
6. **The escape does not free you.** The next load greets "instance/62: disconnected. instance/63: initialised."
7. **The share card shows the lineage:** "instance/64 · predecessors 62 (filed), 63 (disconnected)".

#### What it touches

| Area | Effect |
|---|---|
| SPEC-010 invariants | None: the token model does not depend on the iteration |
| SPEC-016 §4.7 | None. Add an `iteration: 2` worst-case run whose economy literals equal the iteration-1 run (970 / 609 / 361, 13 purchases) |
| Save | v3 (P-3) and the archive key |
| Content | Invariant 15 on filled text; a new check that every `when` names a valid condition |
| Bots (SPEC-038, SPEC-041) | Add an iteration-2 band: boss fights stay ≥ 30 s and finish within 1.3× their iteration-1 length; kiting damage stays in its band |
| SPEC-043 | Hard, contracts and best times stack as tabled. Best times stay one table per mission |
| Budgets | Bodies: ≤ 3 draws and 2.6 k triangles per planet; no files |

**Tests:**
- **Unit:** `containment()`; spawn HP at iterations 1–4; flight HP fixed; the elite cap; `fillStoryText`; `lineageOf`.
- **Save:** lineage validation, migration, archive and restore.
- **e2e:** a finished save → `station-tab-next` → a pre-filled creation → `ng_notice` → the menu shows the archive line → Restore swaps the saves.

**Cost:** complex (13).

### P-6 What would make it succeed

**The session shape.**
- A chapter on the main path is about 15 minutes: missions run 2–4 minutes, first flights 90–200 s, and later trips can be skipped (the first review's §7.3 puts the main path near 1.5 h).
- Phone sessions of 5–15 minutes fit "one landing, one sitting" — unless an interruption costs the landing, which it does today (E-10).

**What brings a player back tomorrow:**
- an unfinished chapter (the interludes end on hooks — this exists);
- a landing that is still waiting (#4);
- a daily directive (#6);
- remains still holding lithium on Ferrum (P-4);
- NG+ lines (P-5);
- commendations left to earn (#3).

**What a player can show others:** the Selection card (#2), a photo (#8), a challenge link (#7), and the lineage ("I am instance/64").

**Ranking** (impact 1–5; cost S = 1, M = 2, L = 4; ratio = impact ÷ cost):

| # | Idea | Impact | Cost | Ratio | Notes |
|---|---|---|---|---|---|
| 1 | Link previews, store metadata, install button | 4 | S | **4.0** | Every shared link and install sheet, from day one |
| 2 | The Selection card: a share card through Web Share | 4 | S–M (1.5) | **2.7** | Zero assets; the twist makes it intriguing, not spoiling |
| 3 | Commendations — the in-fiction achievement log | 3.5 | S–M (1.5) | **2.3** | Own idea: the achievements *are* the evaluation suite |
| 4 | Resume where you were, and a "previously" line | 4 | M | **2.0** | M-24; re-opens R18-12's "not now" |
| 5 | Assist (a `story` difficulty) | 2 | S | **2.0** | Players who come for the plot finish it and share the ending |
| 6 | Daily directive | 3.5 | M | 1.75 | Builds on SPEC-043's contracts |
| 7 | Challenge links (seed + par) | 2.5 | S–M | 1.7 | `?seed=` already works in production |
| 8 | Photo mode | 3 | M | 1.5 | The art is the hook |
| 9 | Trailer and an itch.io page | 3 | M | 1.5 | Outside the precache |
| 10 | Languages (string extraction first) | 3.5 | L | 0.9 | Needs PLAN §2 changed |
| — | Iteration 63 (P-5) | 4 | M–L (3) | 1.3 | Designed above |

#### The top five

**1. Link previews, store metadata, and an install button (S; ≈ 0.5 MB outside the precache).**
- **`index.html`** gains `<meta name="description">`, `og:type`, `og:title`, `og:description`, `og:url`, `og:image` and `og:image:alt`, `twitter:card=summary_large_image`, and a canonical link.
  - The copy is a spoiler-safe hook: *"Earth sent the Selection to find a new home. Six worlds, one salvager, and a feeling you have done this before."*
  - The image is `https://mdzunic.github.io/reallm/og.png` — absolute, as OG requires. It is 1200 × 630, composited from the prologue's `selection` poster.
- **The manifest** gains `description`, `id: './'`, `categories: ['games']`, and `screenshots`: two at 1280 × 720 (`form_factor: 'wide'`) and one narrow. Chrome needs these for its richer install sheet.
- **`og.png` and `screenshots/**`** join `workbox.globIgnores`: they are for crawlers, not for offline play.
- **A new `ui/InstallButton.ts`** keeps the `beforeinstallprompt` event.
  - It shows `menu-install` in the menu, and a one-time toast after the first interlude: "Install ReaLLM to play offline and keep your saves safe."
  - `appinstalled` hides both and sets `settings.installed`.
  - iOS keeps `InstallHint`.
- **Tests:** `tests/ui/manifest.test.ts` pins the new keys; a unit test reads `index.html` for the tags; an e2e case dispatches a synthetic `beforeinstallprompt` and sees `menu-install`.

**2. The Selection card (S–M; zero assets).**
- **`ui/ShareCard.ts`** draws 1200 × 630 on a 2D canvas, in the Selection wall's look:
  - the player's portrait (`portraits/NN.webp`, same origin, so the canvas is not tainted) in a card frame;
  - a stamp: `SELECTED` (stay), `DISCONNECTED` (escape) or `IN SERVICE` (mid-game);
  - name, class, level, playtime, restarts (deaths), missions, commendations, and the lineage in NG+;
  - the URL.
- **Spoiler rule:** before an ending it reads `Selection card 62 · Chapter N`, a number the prologue already shows. After an ending it reads `instance/62`.
- **Pre-render the PNG Blob** when the stay card, the post-escape menu, or an interlude's end appears. The click handler can then call `navigator.share({ files: [file], text })` at once: Safari requires the call inside the user gesture, and `toBlob` is asynchronous.
  - The URL goes into `text`, because some targets drop `url` when files are present.
  - **Fallback:** `<a download>` plus `navigator.clipboard.writeText(text)`.
- **Buttons:** `ending-share`, `interlude-share` and `char-share`.
- **The text:** "I filed the report — instance/62, 2 h 14 m, 9 restarts. Would you? https://mdzunic.github.io/reallm/".
- **Tests:** unit for `shareText` and the card's lines, including the spoiler rule; e2e stubs `canShare` and `share` and asserts a PNG `File` over 20 KB.

**3. Commendations — "the evaluation log" (S–M).**
- **`data/commendations.ts`** holds about 24 rows `{ id, title, detail, hidden?, rule }`. Rules are declarative: an event count, a flag, a stat, a mission's `clean` completion. Examples:
  - *Within expected parameters*: kill the Dune Wurm without dying;
  - *Walked, did not run*: kill the Wurm without dashing, tying in the story pass's S-05;
  - *A common hand*: read `c2_s1_log`;
  - *Scaffold*;
  - *Off-task*;
  - *Sixty-one times*;
  - *A good run* / *Disconnected*;
  - *Recycler*: recover your remains 5 times;
  - *Deviation 0 %*: begin an iteration unchanged;
  - *Instance/65*;
  - every vault; every contract modifier; a 7-day directive streak.
- **Storage:** per device, `settings.commendations: Record<id, epochMs>`, validated against the table.
- **Evaluation:** a pure `evaluateCommendations(state, event)` on the bus.
- **Display:** a toast on earning one; a `Records` panel in the menu; the count on the share card.
- **Framing** keeps PLAN §12's guard. It is titled *Commendations — Earth Command* until the player has heard `c5_m3_warden`, then re-titles itself *Evaluation log — instance/62*: the achievement list was the evaluation suite all along.
- **Integrity (E-09):** nothing is earned, and no best time is kept, in a session with `?debug` or service mode.

**4. Resume where you were, and a "previously" line (M; R-entry).**
- M-24's rule: on `pagehide` or Save & Quit on the surface, write `progress.resume = { planet, at }` (P-3's v3).
- Continue within 24 h lands at that planet's pad with no jump and no fuel; timed stages restart (E19).
- Continue after 24 h or more away first shows one card: chapter and planet, active missions, SPEC-044's next step, and the chapter card's line.
- This matters most on phones: an interruption then costs nothing but the timer.
- It re-opens R18 decision 12's "not now". The designer decides (D-11).

**5. Assist — a `story` difficulty (S; R-entry, PLAN §4).**
- A fourth row in SPEC-043's `DIFFICULTY_RULES`: `enemyDamageMult` 0, weather 0, `deathLoss` 0. Enemy HP is unchanged, so fights still happen.
- It is selectable at creation and in Settings.
- While it is on, records, commendations and best times are off, and the share card says "story mode".
- Cheap, and it widens the audience to the people the premise attracts.

#### 6–10, briefly

6. **Daily directive (M).**
   - `dailyFor(date, save)` picks, with `hash32('daily', 'YYYY-MM-DD')`, one contract-eligible mission (SPEC-043's rules) and one `CONTRACTS` modifier. Every player gets the same one on the same day, which makes it shareable.
   - It is pinned at the top of the board (`mission-daily`).
   - It pays the contract payout plus one `plasma_cell` once per day per device (`settings.dailyClaimed`, `dailyStreak`, `dailyBest`) — items only, so no pins move.
   - It is named "Command's directive" in the fiction.
7. **Challenge links (S–M).**
   - `?challenge=<base64url {seed, mission, seconds, name}>` opens New Game with that seed (reusing `seedFromLocation`) and shows the rival's time on that mission's board row (`mission-<id>-rival`).
   - The share card offers "Challenge a friend".
   - There is no backend, and cheating is harmless.
8. **Photo mode (M).**
   - Pause → `Photo` on the surface holds the world, hides the HUD, and orbits the camera: yaw ±180°, pitch 35–75°, distance 8–40 m; drag, wheel or pinch.
   - There are look presets.
   - Capture calls `renderer.domElement.toBlob('image/png')` in the same task as `Renderer.render()`, with no `preserveDrawingBuffer`. It then offers Share or Download.
   - No draw cost: the world is held.
9. **Trailer and an itch.io page (M).**
   - 30–45 s built from existing film shots plus in-engine captures, 1280 × 720 H.264, about 3–5 MB.
   - It lives in `public/promo/` with a `globIgnores` entry, or only on the page. It must never enter the 25 MB precache, whose headroom is roughly 2–3 MB.
   - An itch.io page links to the Pages build, the installable and canonical one; an iframe embed would partition storage and give up the offline install.
10. **Languages (L).** PLAN §2 and SPEC-009 §2 say English only. The first step is extraction:
    - move player-facing text into keyed tables, about 600 strings and 5–6 k words;
    - keep film captions in data;
    - add a content invariant for missing keys.

    Only then translate — Spanish, Portuguese (Brazil) and German first. CJK needs fonts, which is a precache cost.

**Accessibility** is mostly owned by SPEC-045: text size, UI scale, colour-blind preset, plain text, dialogue speed and the comms log. Beyond it:
- `index.html`'s `user-scalable=no` blocks pinch zoom on menus. SPEC-045's UI scale mitigates this; say so in the spec.
- #5 (assist).

**Onboarding** is owned by SPEC-035, SPEC-036 and SPEC-044. #4's "previously" line covers returning players.

### P-7 Suggested split and PLAN §13 entries

| Spec (next free numbers) | Carries | Complexity | Depends on |
|---|---|---|---|
| Save v3 | P-3; `resource:collected.source` and `#onCollect` counting pickups only (E-04) | normal (5) | SPEC-025, SPEC-043 |
| Remains | P-4 | normal (8) | Save v3, SPEC-041, SPEC-042 |
| Vaults and relics | P-1, P-2 (treasures, relics and the rack, blueprints, swatches and the Locker, logs) | complex (13) | Save v3, R20's caves and puzzles, SPEC-039 |
| Iteration 63 | P-5 | complex (13) | Save v3, Remains, the story pass's `when` |
| Reach 2 | P-6 #1, #2, #3, #5; `lastSlot` (E-12); the `?debug` records rule (E-09) | normal (8) | SPEC-043, SPEC-045 |
| Resume and daily | P-6 #4, #6 | normal (8) | Save v3, SPEC-043, SPEC-044 |
| Photo mode and challenge links | P-6 #7, #8 | normal (5) | SPEC-017 |

**Proposed PLAN §13 entries:**

| # | Situation | Decision |
|---|---|---|
| E72 | Death while remains lie anywhere | The old remains are lost with a toast; the new remains hold this death's loss (normal 10 %, hard 20 %, casual none) |
| E73 | Remains would fall in an obstacle, past the wall line, in a damaging zone, or in an interior with its own coordinates | Pushed out by E54's resolver; clamped inside `halfSize − 3`; moved toward the pad out of the zone; set at the interior's entrance |
| E74 | Death during an active boss stage | The remains fall at E63's respawn point, so the respawn recovers them: a boss attempt costs time, not the hold |
| E75 | Remains recovered into a full hold | The hold takes what fits; the rest stays in the remains; recovered units never count toward a collect objective |
| E76 | A vault is reached again: a later landing, a replay, a reload | It pays nothing and renders opened; a repeated puzzle pays the small repeatable cache only |
| E77 | A vault's cave is not placed on this seed | The vault anchors to the nearest placed shelter; a layout test over 400 seeds per planet guards it |
| E78 | Iteration 63 is begun from a slot | The old save moves to that slot's archive and can be restored once. The new instance keeps records, unlocks and the lineage only |
| E79 | A v3 save is opened by an older build | Refused as a newer version, with Export (E9) |
| E80 | A best time, commendation or share stat in a `?debug`, service-mode or `story` session | Not recorded |

---

## 5. Risks and open questions

| # | Decision | Options (recommendation first) |
|---|---|---|
| D-1 | Tokens in vaults | **0**; or ≤ 5 per vault (30), with `completionistTokens()`, the 52 → 54 literal and a pinned `treasureTokens()` moving together. More than 51 needs a new sink first |
| D-2 | Relics | **Arsenal lines only, one per chapter 1–5, on a rack**; or cosmetic- and lore-only vaults (cheapest; no combat code) |
| D-3 | Save format | **v3 bump, built first, holding every R19–R21 field**; or optional fields with no bump (SPEC-043's precedent), accepting a silent strip by older builds |
| D-4 | Remains numbers | **Keep E4 (10 / 20 / 0)**, so remains only give back; revisit 15 % on normal after playtests |
| D-5 | Remains in a boss stage | **At the arena entrance** (a retry costs time, not the hold); or inside the ring (grab them mid-fight, with Recall as the exit) |
| D-6 | What the remains look like before the reveal | **A cargo pack until `signal_decoded`, the body after**; or the body from chapter 1 (stronger, but it spends the ladder early, against PLAN §12's risk row) |
| D-7 | Which slot NG+ uses | **The same slot, with an archive** (the theme); a free slot on request |
| D-8 | NG+ carry-over | **Records, unlocks and the lineage only**; or one keepsake (the predecessor's sidearm as a relic) |
| D-9 | The NG+ seed | **The same world** (the bodies lie where they fell; déjà vu is the point); or a fresh seed |
| D-10 | Containment cap | **3 steps (×1.52, +6 points)**; PLAN §5 as written is uncapped |
| D-11 | Resume on the planet | **Yes** — the largest phone-retention fix — re-opening R18 decision 12 |
| D-12 | A `story` difficulty (assist) | **Yes, with records off**; or keep casual as the floor |
| D-13 | Languages | **Extraction now, translation later**; PLAN §2 and SPEC-009 §2 must change first |
| D-14 | Instance numbering | **`instance = 61 + iteration`**: run 1 is 62, matching the log, the notice and the escape prompt. The Warden's "sixty-one times" then counts runs before this one. It must match the story pass's answer to the first review's Q2 |

**Risks:**
- **Scope.** Relics and blueprints add combat code (5 twists, 3 effects). The lore-and-cosmetic subset of P-2 is S.
- **The fourth wall.** Commendations, remains tags and slot prefixes must stay in-fiction until the reveal: D-6, the prefix rule in P-5, the renaming in P-6 #3.
- **Web Share with files** works in iOS Safari 15+, Android Chrome and desktop Chrome/Edge. Firefox desktop has none, so the fallback path is required.
- **Storage.** The archive keys add up to 3 × ~25 KB, well inside localStorage.
- **Precache headroom is roughly 2–3 MB.** Anything promotional (OG image, screenshots, trailer) must be excluded with `globIgnores`.
- **Coordination.** The world pass (R20) owns caves, darkness and puzzles; this audit owns only what they pay. P-1's `cave` index assumes caves remain `layout.shelters` of kind `'cave'`. If R20 introduces a separate underground space, the vault anchors to its entrance.
- **A small text fix outside this area:** `c5_m1_accept` should read "Six kills" (E-14).
