# ReaLLM fourth review: gameplay, balance, progression and the moment-to-moment loop (G-)

**Build:** `main` at `dfe6f04` (2026-10-07). **Specs:** `../reallm-specs` main. **Read-only:** nothing in either repo was changed.

**Method.**
- Read every data table in scope (`src/data/*`) and the systems that consume them: `Combat`, `Loadout`, `Spawn`, `EnemyAi`, `Economy`, `Missions`, `Flight`, `Stamina`, `Weather`, `Light`, `Balance`, `UiHelpers` and `scenes/Surface.ts`.
- Re-read the decisions of PLAN R17–R26 and the three earlier reviews, and checked each one I could against the code (§2).
- Wrote three small calculators, kept beside this report in [`gsim/`](gsim/) (`dps.mjs`, `boss.mjs`, `curve.mjs`). They import nothing from the repo. They re-implement the cooldown model of `Loadout.ts:60-111` and the shared `fireCooldown` of `Combat.ts:1849,1932,647-649`, at 60 Hz. They do not simulate movement, aim or AI, so read their fight lengths as "pure DPS", a floor under real fight time.
- Bot results quoted from `docs/playtest-log.md` are the repo's own `tests/systems/threat.test.ts` runs. I did not re-run any test; the brief reserves that for the bug auditor.

**Status labels.**
- **CONFIRMED** means the mechanism is read in code, or the number is computed from code values.
- **PLAUSIBLE** means the effect on a real player is my inference.

IDs are this audit's own (`G-xx`); earlier reviews reused the same prefix with different meanings.

---

## 1. Summary

1. **The R18 threat and builds pass landed almost exactly as decided.**
   - Packs, affixes, boss move lists, the dash, telegraphs, storm waves, signature drops, the decision sink, the class retune, the fire-rate carry, contracts, bonuses and Hard all landed. So did R19's sprint and noise, and the R20/R21 caves, puzzles, treasure, remains, NG+ and Story mode (table in §2).
   - Trash dies in 0.3–1.5 s in every chapter, and boss fights sit near 35–45 s of pure DPS at the reference kit. The curve on paper is good.
2. **The biggest balance hole is not in a table. Healing and explosives have no budget.**
   - A medkit is an instant 50 % heal with no cooldown, crafted for 10 wheat and 10 water.
   - Frags throw every 0.5 s on top of the gun.
   - Resources are in permanent surplus, and since R26 the depot has no cap.
   - Every boss suite was tuned with **3 medkits**. A main-path player who never crafts collects about 10 from boss drops alone. From chapter 3 on, a boss can be face-tanked, and Hard only makes that take longer.
3. **Trash stops paying from chapter 3.**
   - Kill XP is flat: 4/8/10 per kill in every chapter.
   - Drops are resources the depot makes worthless.
   - Sprinting out of combat is free.
   - A late-game player's best move is to run past fights. The ARPG loop thins out exactly where the content gets most varied.
4. **Builds still collapse to "the best rifle".**
   - The sidearm slot only fires when the auto-swap setting is on, and that setting defaults to touch only. On desktop, two of the five signature drops (the Broodlord's Hand Cannon, Cinder-4's Last Word relic) do nothing.
   - The combat drone copies the primary's damage **per shot**, so a machine-gun user gets a third of an Edge user's drone.
   - On touch, a launcher tap costs the primary a full second of fire, so the Rocket is DPS-neutral or negative beside a tier 2–3 rifle.
5. **The missions do not use the systems built since R18.**
   - Chapters 1, 2 and 4 run the same three templates: survive a storm, then collect plus kill, then boss plus deliver.
   - Underground, puzzles, the flashlight, the stealth half of sprint and noise, and treasure appear in **zero** missions.
   - Chapters 5–6 drop storms, shelters, collects and delivers altogether.
   - The signature rule "walk, do not run" exists as a mechanic in one boss phase, which a player following the station's Refit advice sees about once.
6. **The difficulty curve is uneven.**
   - Chapter 2 is a trough: Vetra is the lowest-threat field at 3.3 %/min, and the Matriarch's worst hit is 11 % of HP.
   - The Ash Titan (worst hit ≈ 29 % of HP; the kite bot loses 97–107 % with 3 medkits) and the Hive field (17–24 %/min) are the spikes.
   - The recommended armour stays tier 1 until Eden.
7. **Flight is fine as a garnish, but thin.**
   - The first three trips carry 0, 2 and 6 enemies over 330 s.
   - Flight kills pay XP only, because the `flight_salvage` loot table is never rolled.
   - Skips make every ship tier past the Ferrum gate nearly cosmetic. The chapter-6 Refit advice even recommends Ship Guns tier 1, which changes nothing against the only enemy left.

---

## 2. Did the earlier decisions land?

| Decision (source) | In code | Notes |
|---|---|---|
| Trash HP bases 26/70/45, ranged 13 m and 15 m/s (R18-3) | Yes | `enemies.ts:161,179,197,201` |
| Dash 5 m / 0.2 s / 0.3 s i-frames / 1.4 s cooldown (R18-3) | Yes | `Dash.ts:14-30` |
| Swarm windups keep closing; rushers charge (R18-3) | Yes | SPEC-038 duel tests (`playtest-log.md:1494`) |
| Survive stages except `c1_m1` run a storm wave (R18-3) | Yes | `missions.ts:214,232,302,321,405,462`; `c1_m1` has none (`:145`) |
| Population is the design count, capped by preset (R18-3) | Yes, with the cap | `Spawn.ts:99-101`. On `low` the Hive plays 12 of 15 and Ferrum 12 of 13 (see G-15) |
| Auto-fire on by default, leads strafers (R18-3) | Yes | `Combat.ts:1800-1818` |
| Signature boss drops, first kill only, else 25 lithium (R18-4) | Yes | `loot.ts:65-143`, `Combat.ts:1414-1425` |
| Decision sink ≥ 0.75 × completionist (R18-4) | Yes | `Balance.ts:221-243`: 975 ≥ 959. Contracts bypass it (G-11) |
| Marine ×1.10, tech +10 % per point to every companion, agility +2 % crit (R18-4) | Yes | `characters.ts:63-79`, `Combat.ts:257-282`, `Flight.ts:391` |
| Fire-rate remainder carries (R18-4) | Yes | `Combat.ts:1849`, `Flight.ts:732` |
| Medic pauses in weather; Quartermaster covers ship, gear and companion; guns T1 = 14 (R18-4) | Yes | `Combat.ts:2199`, `Economy.ts:495-501`, `upgrades.ts:83` |
| Sustained DPS and slot compare on cards; Refit line (R18-4) | Yes | `UiHelpers.ts:490-506, 1342-1344, 1462-1497`. The launcher number misleads on touch (G-12) |
| Replay boss kill pays half XP and no signature (R18-4) | Yes | `Combat.ts:1341-1343, 1416` |
| Boss HP 1,800 / 4,600 / 5,200 / 6,800 / 8,400 with move lists (R18-6) | Yes | `enemies.ts:217-572` |
| Real arena lock; respawn at the arena entrance (R18-6) | Yes | `Surface.ts:3072, 4315-4358`. The boss also resets to full on any death (`Surface.ts:4366-4368`) |
| Packs (swarm 3–5, rushers 1–2, Hive drones 4–6) and affixes (R18-6) | Yes | `planets.ts:230,287,359,419,476`; `affixes.ts` |
| Lead pip, fighter bursts, hit feedback in flight (R18-6) | Yes | `Flight.ts:241, 783-791` |
| Every side mission pays an item or a resource; bonuses; contracts at 0.75 + 20 Li; Hard (R18-8) | Yes | `missions.ts` (all 9 side rows), `contracts.ts:72-74`, `tuning.ts:111` |
| Collect objectives count pickups only (R20, SPEC-043 §4.2 amended) | Yes | `Missions.ts:235`; the depot's draw is `'depot'` (`Economy.ts:471-493`) |
| Sprint ×1.35, drain 25/s only in combat, holster, ×1.5 noise; dash costs 30; the Wurm hunts by vibration (R19-3) | Yes | `Stamina.ts:21-35, 88`, `EnemyAi.ts:377, 1071`, `enemies.ts:238` |
| Treasure 5 tokens per vault, relics, blueprints (R20-7) | Yes | `caves.ts:220-295` |
| Remains; containment ×1.15 per step, capped at 3, elites +0.02 per step; Story mode (R21) | Yes | `Containment.ts`, `tuning.ts:100` |
| Depot: free, unlimited, pays fuel (R26) | Yes | `Economy.ts:418-493` |
| **Not taken, still open:** Medic draws wheat (R18 audit E-09), kill-XP scaling (R18 E-16, "not now" in R18-12), `c5_s1` 15 → 10 eggs (R18 E-11), Cinder-4 flight salvage (R18 combat G-17) | No | Each one feeds a finding below (G-03, G-10, G-19, G-20) |

**Stale text found in passing:**
- `waves.ts:150` still says "30 interceptors against `c5_m1`'s 10"; it has been 6 since R17.
- Many spec files still say `status: draft` (the known docs-hygiene item).

---

## 3. The numbers

### 3.1 Difficulty curve at SPEC-041's reference kit

The kit (`specs/041…:731-737`):
- a Marine 6/5/1/1 at the main-path levels 3/7/10/13/15/17, with no attribute points spent;
- the Rocket from chapter 2, and a level-1 combat drone from chapter 4.

DPS includes might, level, the Marine multiplier and average crit, with the desktop Rocket rotation added. Hits include armour (`Combat.ts:285-317`).

| Ch | Lvl | Max HP | Kit (armour) | DPS | TTK swarm / rusher / ranged | Rusher charge hit | Boss pure TTK | Boss worst hit |
|---|---|---|---|---|---|---|---|---|
| 1 | 3 | 168 | Kinetic (0) | 53 | 0.49 / 1.32 / 0.85 s | 7 % HP | 34 s (Wurm) | 19 % HP |
| 2 | 7 | 184 | Laser + Rocket (15) | 132 | 0.31 / 0.83 / 0.54 s | 7 % | 35 s (Matriarch) | **11 %** |
| 3 | 10 | 196 | Laser + Rocket (15) | 139 | 0.39 / 1.07 / 0.68 s | 9 % | 37 s (Broodlord) | 19 % |
| 4 | 13 | 208 | Laser + Rocket + drone (15) | 163 | 0.51 / 1.36 / 0.88 s | 11 % | 42 s (Titan) | **29 %** |
| 5 | 15 | 216 | Plasma + Rocket + drone (15) | 198 | 0.31 / 1.54 / 0.98 s | 14 % | 42 s (Queen) | **30 %** |
| 6 | 17 | 224 | Plasma + Rocket + drone (30) | 204 | 0.30 / 1.49 / 0.95 s | 12 % | — (defence) | — |

**The repo's own bot runs, from `playtest-log.md`:**
- **Bosses** (`:1630-1636`; kite bot, 3 medkits): the share of max HP lost is Wurm 58–89 %, Matriarch 37–52 %, Broodlord 36–76 %, **Titan 97–107 %**, Queen 49–84 %. The reader and dasher bots lose 0–7 %.
- **Field** (`:1638`): 3.3 %/min (Vetra, the lowest) to 17.3 %/min (the Hive, the highest).
- **Field, earlier SPEC-038 run** (before packs, `:1508-1512`): Cinder-4 11.2, Vetra 13.2, Thessaly 5.6, Ferrum 9.8, **Hive 23.9 %/min with 3 deaths in 16 runs**.

### 3.2 Weapons: sustained single-target DPS

These come from `gsim/dps.mjs`: a held trigger for 300 s at damage multiplier 1, without movement or misses.

| Primary | Firing | Desktop default (no auto-swap) | Auto-swap + Service Pistol | + Hand Cannon | + Last Word |
|---|---|---|---|---|---|
| Kinetic Repeater (T0) | 36 | 36 | 36 | 36 | 36 |
| Laser Carbine (T1, 40) | 72 | 72 | 72 | 72 | 72 |
| Plasma Lance (T2, 80) | 84 | 84 | 84 | 84 | 84 |
| Lithium Edge (T3, 130 + 120 Li) | 100 | 100 | 100 | 100 | 100 |
| Scrap Chaingun (T1, Matriarch) | 110 | **63.9** | 75.0 | 83.7 | 78.6 |
| Rotary Cannon (T3, 120 + 60 Li, Queen) | 156 | **83.7** | 95.4 | 105.4 | 99.2 |
| Cold Coil (relic, T2) | 90 | 69.0 | 75.4 | 80.4 | 77.2 |
| Slag Vent (relic, T3) | 143 | 72.8 | 85.6 | 96.5 | 90.0 |

**Launchers.** This is how much each launcher adds to single-target DPS when it is used on cooldown.
- The **desktop** rotation (select, fire, hand back) costs two switches. Each switch resets `fireCooldown` (`Combat.ts:647-649`).
- The **touch** tap (`fireSlotOnce`) sets the shared `fireCooldown = 1/rate` with no reset (`Combat.ts:1932`).

| Primary | Rocket desk / touch | Grenade desk / touch | Seeker desk / touch | Seed Drum desk / touch |
|---|---|---|---|---|
| Laser | +11.3 / +2.9 | +8.6 / +9.0 | +9.7 / +1.3 | +4.1 / +4.5 |
| Plasma | +10.8 / +1.0 | +9.0 / +7.8 | +9.2 / **−0.6** | +4.5 / +3.1 |
| Edge | +10.1 / **−1.8** | +5.5 / +5.6 | +8.5 / **−3.5** | +1.0 / +1.1 |
| Rotary | +13.4 / +9.8 | +17.1 / +15.4 | +11.8 / +8.2 | +12.6 / +10.7 |

The shop prints the Rocket as `DPS 15 sustained` (`UiHelpers.ts:490-506`). Blasts hit whole packs, which these single-target figures leave out, and the Seed Drum's linger (8 dps for 3 s per shell) is also left out.

### 3.3 Economy at a glance

- **Tokens, CONFIRMED in code.** Main missions 670, side 104, vaults 30, plus 25 a level.
  - The decision sink is 975: rifle and armour ladders 500, surface and station companions 335, the Ferrum gate 140.
  - The worst-case margins are pinned at 5 / 45 / 60 / 45 / 110 for chapters 2–6 (`balance.test.ts:73`).
- **Resources, CONFIRMED in code.** The only resource sinks are fuel, five recipes, two blueprints and the tier-3 lithium prices.
  - The depot has no cap (`Economy.ts:418-493`), and fuel draws on it.
  - Death takes only from the hold (`Economy.ts:1007-1021`).
- **Consumable supply, without crafting** (`loot.ts:44-49`, `caves.ts:203-295`, `missions.ts`):
  - **Main path:** about 10 medkits from bosses alone (2 per boss), plus 3 from bonuses.
  - **Completionist:** about 30, adding side rewards and 12 from caches.
  - **With crafting:** effectively unlimited. A medkit costs 10 wheat and 10 water (`recipes.ts:29`); a frag 10 oil and 5 water.

---

## 4. Findings

### G-01 · P1 · Balance · Healing and explosives are unbudgeted, so boss and Hard tuning stop meaning anything from chapter 3 · CONFIRMED (mechanism) / PLAUSIBLE (how many players exploit it)

**Evidence.**
- **Heals have no cooldown.** `Surface.ts:4094-4146` (`#useQuick`) refuses a heal only at full HP (`:4114-4118`).
  - A medkit is `heal 0.5, overSeconds 0` (`items.ts:486-495`). Two presses take a player from 10 % to full.
  - The heal slot refills itself from the pack (`refillQuick`, `Loadout.ts:397-405`).
- **Explosives are rate-limited only by `EXPLOSIVE_USE_SECONDS = 0.5`** (`Surface.ts:465, 4196, 4227`). A throw does not touch the gun's `fireCooldown`.
  - Frags (55 damage × the damage multiplier, radius 3.5) spammed at 2 per second add **110 × mult DPS on top of the primary**. At chapter 5's multiplier (~1.75) that is ≈ 190 DPS, more than the Edge.
  - Mines arm 6 at a time (`Deployable.ts:21-22`).
- **Supply is effectively unbounded:**
  - recipes: medkit 10 wheat + 10 water, frag 10 oil + 5 water, mine 20 oil (`recipes.ts:28-33`);
  - every boss, replays included, drops 2 medkits (`loot.ts:44-49`);
  - the pack has 20 slots (`Economy.ts:128`);
  - wheat and water sit in a surplus of hundreds, and since R26 the depot has no cap (`Economy.ts:418-493`).
- **The tuning assumed a budget that does not exist.** Every boss suite assumes **3 medkits** (`specs/041…:52, 468, 723`). Even with that budget the kite bot spends 97–107 % of max HP on the Titan (`playtest-log.md:1635`).

**Failure scenario.**
- A chapter-4 player has ≥ 6 medkits from the first three bosses alone, and can craft 20 more from one Thessaly harvest.
- They stand in front of the Ash Titan and press the heal key whenever the bar is under half. They cannot lose.
- Queen arithmetic: 42 frags (420 oil + 210 water; 9 pack slots) dumped while the gun auto-fires roughly halves the 42 s Queen fight.
- Hard's ×1.3 damage and Iteration 63's containment only change how many presses that takes.

**Why it matters.**
- R18 spent a whole pass making attacks commit and bosses read. The consumable layer bypasses all of it.
- "No deaths" bonuses become free.
- The remains (R21) and Hard's 20 % loss rarely trigger.
- Tension in the back half of the campaign rests on the player choosing not to use their tools.

**Fix (R-entry; consumables are PLAN §4).**
- (a) A shared heal cooldown: `HEAL_COOLDOWN 8 s` for the instant medkit, and 5 s for the ration's over-time heal, shown as a ring on the heal slot.
- (b) `EXPLOSIVE_USE_SECONDS 0.5 → 1.2`.
- (c) **The quick slots refill from the pack only out of combat** (`inCombat`, `Combat.ts:154-155`), so a fight is fought with one stack.
- (d) Re-run the boss suite with "unlimited medkits under the cooldown" as a second bot, and keep the Titan inside 100 % for the kiter.

**Effort.** M.

---

### G-02 · P2 · Mission design · The campaign is three templates, and none of the post-R18 systems appear in a mission · CONFIRMED

**Evidence** (`missions.ts`).

| Template | Missions |
|---|---|
| Storm, then go somewhere | `c1_m1`, `c2_m1`, `c4_m1` (`:142-146, 231-234, 404-407`) |
| Collect N + kill M | `c1_m2`, `c2_m2`, `c4_m2` (`:160-163, 249-252, 422-425`) |
| Boss → deliver or scan | `c1_m3`, `c2_m3`, `c4_m3` (`:179, 267, 443-446`) |

**Per-chapter objective mix:**

| Ch | Objectives |
|---|---|
| 1 | reach, scan ×2, survive ×2, collect ×2, kill ×2, boss, deliver |
| 2 | survive ×2, reach, collect, kill ×2, boss, scan ×2, deliver |
| 3 | collect ×2, survive, kill ×2, **escort** (the only one), boss, scan |
| 4 | survive ×2, reach, collect, kill ×2 (one in flight), boss, deliver, scan |
| 5 | survive (flight), kill ×3, reach, boss |
| 6 | scan ×3, **defend** (the only one), **choice** |

**What no mission uses.** Searching `missions.ts` for the systems added since R18 finds:
- the underground (SPEC-054 "adds no mission, objective or requirement", PLAN R20-5);
- puzzles (R20-6: "no puzzle gates a mission");
- the flashlight;
- flares and stims;
- sprint, noise and hiding, outside the Wurm's phase 2 (`enemies.ts:238`);
- treasure.

**What the late chapters drop.** The Hive and Eden have `weather: null` (`planets.ts:464, 530`). From chapter 5 there are no storms, shelters, collects or delivers, and the storm contracts cannot roll there (`Missions.ts:995`).

**Why it matters.**
- Chapter 4 plays as a re-skin of chapters 1–2.
- The most interesting systems (caves, puzzles, the dark, the Wurm's listening) are optional detours that the main path never asks for. The first hour teaches more verbs than the last hour uses.
- Escort and defend each appear once.

**Fix (R-entry; PLAN §6 locks the roster, so this re-stages, it does not add).**

| Mission | From | To |
|---|---|---|
| `c4_s1` Core Sample | scan 2 drills → survive 120 s | descend to Ferrum's cave → solve its conduit vault → survive the climb out (the cave's packs) |
| `c2_s2` Pelt Run | kill 12 crawlers → survive the avalanche | kill 12 crawlers → cross the slope POI without running (a vibration-tracking avalanche reusing the burrow telegraph) |
| `c5_m2` Lair | reach the chamber + kill 25 drones | **escort** a beacon to the queen chamber through drone packs |
| `c6_m1` Paradise | three scans | three scans with an Eden cave descent between the forest and the ridge (the machine room as a main-path beat) |

**Effort.** L (content + specs + tests). Even one of these four is a visible gain.

---

### G-03 · P2 · Loop / progression · From chapter 3, fighting trash pays nothing and running past it is free · CONFIRMED (numbers) / PLAUSIBLE (behaviour)

**Evidence.**
- **Kill XP is flat across chapters:** swarm 4, rusher 8, ranged 10 (`enemies.ts:168, 186, 204, 256, 274, … 505, 523`). The next level costs 100 + 50·L (`tuning.ts:55-56`).
  - A chapter-1 skitter is 1.6 % of a level.
  - A chapter-5 Hive drone is 0.47 % of one. A Hive warrior (233 HP) pays 8 XP.
- **Drops** are 1–3 of the planet resource (`loot.ts:53-143`). With the uncapped depot those have no value.
- **Sprinting out of combat costs no stamina** (`Stamina.ts:88`; R19-3) and holsters the gun.

**Why it matters.**
- The ARPG reward loop is "fight → number goes up".
- In chapters 4–6 the rational play is to sprint past packs to the objective. That is also exactly where packs, affixes and telegraphs are richest.
- R18 deferred kill-XP scaling as "not now" (R18-12).

**Fix.**
- (a) **Kill-XP scaling** (initial tuning; R18 audit E-16): surface non-boss XP = round(base × 1.15^(ch−1)), giving Hive warrior 14, spitter 17, drone 7. It moves SPEC-016's completionist pin 11,135 → 11,756 XP, and L19 → L20.
- (b) Elites already pay ×(3 + affixes) (`Combat.ts:1341-1343`). Add one guaranteed elite pack per landing on chapters 3–5, to give a reason to engage.
- (c) Optional: in-combat sprint drain 25 → 30, so running stays a choice.

**Effort.** M (pins move).

---

### G-04 · P2 · Build variety / honesty · The sidearm slot is dead on desktop, so two signature rewards do nothing · CONFIRMED

**Evidence.**
- **How a sidearm can fire.**
  - The primary covers a lock only with auto-swap on (`Loadout.ts:231-240`). Auto-swap defaults to touch only: `weaponAutoSwap: 'touch'` (`Settings.ts:387`, read at `Combat.ts:1776-1777`).
  - Rifles never lock (`cooldown: none`, `items.ts:212-292`).
  - Otherwise a sidearm fires only if the player presses `1` by hand.
- **What that leaves dead on desktop.**
  - The Broodlord's signature Hand Cannon (`loot.ts:104`).
  - Cinder-4's vault relic Last Word (`caves.ts:256`).
  - Both are dead for every rifle user on any scheme, and for every desktop machine-gun user on default settings.
- **The machine-gun numbers assume a cover desktop never gets.** The Rotary's own comment promises "84 sustained — the Lithium Edge's tier with a sidearm covering its locks" (`items.ts:351-354`). On desktop default it delivers 83.7, against the Edge's 100 (§3.2); with the Hand Cannon covering it would be 105.

**Why it matters.**
- A chapter-3 boss reward and a chapter-1 vault reward have no effect for most players.
- The machine-gun line is balanced against a setting most desktop players never see.

**Fix.**
- (a) `weaponAutoSwap` default `'touch' → 'on'` (S; the setting and its code path already exist).
- (b) Make the sidearm card say "covers a locked machine gun".
- (c) Consider making the Broodlord's signature something that helps a rifle build (e.g. swap it with the Titan's Grenade Launcher), and keep the Hand Cannon as a shop item.

**Effort.** S.

---

### G-05 · P2 · Build variety / honesty · The combat drone copies per-shot damage, so it punishes machine guns and misreports itself · CONFIRMED

**Evidence.**
- The drone's damage is `weapon.damage × damageMult × fraction × companionMult` per shot, at 1–1.5 shots/s (`Combat.ts:2072-2073`).
- At level 3 (0.9 × 1.5/s), per point of `damageMult × companionMult`, it deals:

| Primary | Drone L3 DPS |
|---|---|
| Edge (40 per shot) | 54 |
| Plasma | 38 |
| Laser | 24 |
| Rotary (13 per shot) | 18 |
| Chaingun | 15 |

- **Engineer, tech 8** (`companionMult` 2.25): Edge + drone = 100 + 121 ≈ 221, against Rotary + drone = 84 + 40 ≈ 124.
- **The card is not true per second.** It says "drone at 50 % of your damage" (`UiHelpers.ts:614`). With the Rotary the drone deals ~4 % of its firing DPS.

**Why it matters.**
- The Engineer's identity (R18-4) and the machine-gun line are mutually exclusive.
- The card misleads, because the drone does not deal "50 % of your damage" per second.

**Fix.**
- Base the shot on the primary's sustained DPS, cached at equip: `damage = round(weaponDps(primary).sustained × 0.4 × fraction × damageMult × companionMult)`.
  - The Edge keeps its 20/s at L1.
  - The Rotary goes 6.5 → 16.7, the Laser 9 → 14.4 and the Chaingun 5.5 → 12.8.
- Card text: "drone: 20 % of your sustained DPS".

**Effort.** S.

---

### G-06 · P2 · Difficulty curve / mechanic use · The station's Refit advice halves the Dune Wurm, so "walk, do not run" gets about one repetition · CONFIRMED (mechanism) / PLAUSIBLE (how many follow it)

**Evidence.**
- **The Refit line advertises the Laser during chapter 1.** It targets "the lowest chapter ≥ 2 with no landing" (`UiHelpers.ts:1462-1497`), so a new save reads `Refit for Vetra: Composite Weave 39 · Scanner Drone 20 · Laser Carbine 39` (`playtest-log.md:1547`) before the Wurm is fought.
- **The tokens are there.** A player has about 75 by `c1_m3` (25 from `c1_m1`/`c1_m2` plus levels 2–3).
- **The tuning assumed the Kinetic.** The Wurm's 1,800 HP was sized on the chapter-1 reference kit with the Kinetic (`specs/041…:737`); the kite bot needs 50–53 s.
- **Pure DPS halves with the Laser.** The fight goes 34 s → 17 s, and phase 2 (below 40 %, `enemies.ts:229`) 14 s → 7 s (`gsim/boss.mjs`).
- **One burrow.** The burrow starts at phase-2 entry and returns 9 s after each one ends (`enemies.ts:238`). Its 2.5 s dig and 1.2 s telegraph also make the Wurm untargetable and invulnerable (`Enemy.ts:160-162`, `EnemyAi.ts:1014, 1051`, `Combat.ts:1456, 1955`), so a Laser player sees **one** burrow, a Kinetic player two.

**Why it matters.** The game's signature rule has one mechanical expression on the main path, and the game's own advice makes it a single beat. The commendation for it (G-17) is earned almost by accident.

**Fix (initial tuning, no R-entry).** Any one of these:
- the Wurm's phase-2 `hpFraction` 0.4 → 0.55;
- burrow `every` 9 → 6;
- HP 1,800 → 2,400.

Also have `refitLine` skip the target chapter's gear until the current chapter's boss is down (`chapter{N}_done`).

**Effort.** S.

---

### G-07 · P2 · Difficulty curve · Chapter 2 is a trough, and the Titan and the Hive are spikes, while the recommended armour stays tier 1 · CONFIRMED (numbers from code and the repo's bot logs)

**Evidence.**
- **Field threat.** Vetra is the lowest at 3.3 %/min, and the Hive the highest at 17.3 %/min (`playtest-log.md:1638`). Before packs, the Hive was 23.9 %/min with 3 deaths in 16 runs (`:1508-1512`).
- **Worst boss hit as a share of HP** (§3.1):

| Wurm | Matriarch | Broodlord | Titan | Queen |
|---|---|---|---|---|
| 19 % | **11 %** | 19 % | **29 %** | **30 %** |

  The Matriarch has no damage phase (`enemies.ts:313-316`). The Titan stacks ×1.44 in phase 3 and ×1.2 on its tremor (`:478-487`).
- **The Titan's margin.** Even with 3 medkits, the kite bot loses 97–107 % of max HP to the Titan (`:1635`). A death respawns the boss at full HP (`Surface.ts:4366-4368`).
- **The armour gap.** `RECOMMENDED_LOADOUT` keeps the Composite Weave (−13 %) through chapter 5, and the Reactive Harness (−23 %) arrives only at chapter 6 (`Balance.ts:93-102`).

**Why it matters.**
- Chapter 2 asks almost nothing of a player who has just learned the game.
- Chapters 4–5 then hit at 2.6× the share of HP.
- Without the G-01 crutch this is where a typical player dies repeatedly: the Titan's phase 3, and Hive packs with two-affix elites. With the crutch, it is where they burn their heals.

**Fix (initial tuning).**
- **Vetra:** `population` 11 → 13, and the Matriarch phase 2 `damageMult` 1 → 1.2.
- **Titan:** phase-3 `damageMult` 1.44 → 1.3.
- **Hive:** `hive_warrior` pack [1,2] → [1,1], or Hive `population` 15 → 13.
- **The Reactive Harness** in the chapter-5 Refit list. This moves 80 tokens into chapter 5 against a pinned margin of 45. Pay for it by removing Ship Guns T1 from chapter 6 (G-09) and re-pinning `balance.test.ts:50,73`.

**Effort.** S (numbers) to M (re-pin and suites).

---

### G-08 · P2 · First hour · The opening ten minutes have two long stretches with nothing to do · CONFIRMED

**Evidence.**
- **The first flight.** The first interactive scene is a 90 s flight with an empty wave list (`waves.ts:116-122`). Asteroids pay nothing (G-20).
- **The first mission ends in a wait.** `c1_m1`'s last stage is a 60 s sandstorm (`missions.ts:145`):
  - the sandstorm deals 0 damage (`Weather.ts:29`);
  - there is no wave, by design (`content.test.ts:161, 722`);
  - the first-landing ramp holds the field thin.
- **The R18 option was not taken.** The R18 progression audit offered "cut it to 30 s, or add 2 × 3 skitters" (`docs/review-r18/audit-progression.md:171`, D-3), but no R-entry took it.

**Why it matters.**
- It comes right after a 93 s prologue film and creation.
- A new player waits 60 s in harmless sand before the game's first real choice. Retention is lost in exactly these minutes.

**Fix (R-entry for the PLAN §6 row).**
- `c1_m1` survive 60 → 30 s. This moves `missions.test.ts:360,1265`.
- **Or** keep the 60 s and spawn two skitter packs at 20 s and 40 s. That is the R18 option: the first fight, taught in cover.
- For the Cinder-4 flight, see G-20.

**Effort.** S.

---

### G-09 · P3 · Economy / honesty · The chapter-6 Refit recommends Ship Guns tier 1, which changes nothing that is left to fight · CONFIRMED

**Evidence.**
- **The recommendation.** `RECOMMENDED_LOADOUT[6]` includes `{ ship weapon tier 1 }` (`Balance.ts:100`), so the Refit line tells a player to buy it before Eden.
- **What it changes.**
  - Guns go 10 → 14 damage at the same 4 shots/s (`upgrades.ts:83-84`). Ship damage is flat per shot (`Flight.ts:714-715`).
  - Eden's flight carries only interceptors (`waves.ts:164-172`). At 20 HP (`enemies.ts:602`) they take 2 hits at tier 0 and still 2 at tier 1.
  - Fighters (40 HP, 4 → 3 hits) appear only on the Vetra, Thessaly and Ferrum routes, all skippable by then (`Flight.ts:315-321`).

**Why it matters.** The game's own advice spends 40 tokens on nothing.

**Fix.**
- Drop the entry from chapter 6. That frees margin for the Reactive Harness in chapter 5 (G-07).
- **Or** move it to chapter 4's list, where `c4_s2`'s fighters live. That cuts the chapter-4 margin 60 → 20; re-pin.

**Effort.** S.

---

### G-10 · P3 · Economy · The R26 depot leaves the Cargo Hold tiers, the Quartermaster's cargo bonus and Hard's death loss with almost nothing to do · CONFIRMED

**Evidence.**
- **The depot is free, unlimited and reachable from every pad terminal** (`Economy.ts:427-449`). Fuel draws on it (R26-3).
- **Collect objectives never needed a big hold.** They already count past the cap (`Economy.ts:372-373`, R17 E56), and the largest is 300 (`Balance.ts:246-256`), below the base 400.
- **Deliver objectives need at most 100.**
- **So the Cargo Hold's 600/800/1,200 tiers** (25 + 50 + 90 tokens + 40 water, `upgrades.ts:63-72`) and the Quartermaster's +100/200/300 (`companions.ts:89-93`) only save walks to the pad.
- **Death loss touches only the hold** (`Economy.ts:1007-1021`, R26-2). Hard's 20 % is avoided by shipping before a fight.

**Why it matters.** It leaves 165 tokens of purchases with no effect. Hard's only economic teeth are optional, and so are the remains (R21) on any difficulty.

**Fix.**
- Re-purpose the Cargo tiers as **+2 pack slots each** (20 → 22/24/26). The pack is the one capacity players still feel.
- Hard: death also takes 10 % of the depot, or Hard disables shipping during an active mission.

**Effort.** S–M.

---

### G-11 · P3 · Economy · The Queen contract is a dominant token farm that bypasses the decision sink · CONFIRMED (numbers) / PLAUSIBLE (rate)

**Evidence.**
- **Pay.** A finished chapter's surface replay is always a contract: 0.75 of the reward plus 20 lithium (`Missions.ts:989-997`, `contracts.ts:72-74`).
  - `c5_m3` pays 100 tokens (`missions.ts:530`), so a contract pays **75 tokens + 450 XP**. The boss adds half of its 600 XP (`Combat.ts:1341-1343`), about 20 more tokens at L17.
- **Time.** The Hive flight is skippable after `c5_m1` (`Flight.ts:315-321`), and the Queen sits 110–140 m from the pad. A run is roughly 3 minutes, against the campaign's ~12 tokens/min (R18 audit).
- **Difficulty.** The Hive has no weather, so only `elite_surge` or `swarm` roll (`Missions.ts:995`). Neither touches the sealed arena.

**Why it matters.** Ten runs buy the whole 975-token decision sink. It is a player's choice, but it is the dominant one, and it undoes R18-4's "specialization is forced".

**Fix (initial tuning).** A boss mission's contract pays 0.5 of tokens (XP stays 0.75), **or** contracts pay lithium and items only.

**Effort.** S.

---

### G-12 · P3 · Build variety / touch · A launcher tap on touch costs the primary a full second, so the Rocket and Seeker are DPS-neutral or negative beside a tier 2–3 rifle · CONFIRMED

**Evidence.**
- **Touch.** `fireSlotOnce` ends with `p.fireCooldown = 1 / weapon.fireRate` (`Combat.ts:1932`). That is the shared gun cooldown checked at `:1846`, so a Rocket tap holds the primary for 1.0 s.
- **Desktop** gets a reset from the hand-back switch (`Combat.ts:647-649`).
- **Net single-target DPS** (§3.2):

| | Edge | Plasma |
|---|---|---|
| Rocket, touch | −1.8 | +1.0 |
| Seeker, touch | −3.5 | −0.6 |
| Rocket, desktop | +10.1 | +10.8 |

- **The card** prints `DPS 15 sustained` for the Rocket regardless of scheme (`UiHelpers.ts:490-506`).

**Fix.** In `fireSlotOnce`, set `p.fireCooldown = Math.max(p.fireCooldown, SWITCH_SECONDS)` (0.25 s), which matches the desktop rotation's cost.

**Effort.** S.

---

### G-13 · P3 · Difficulty · Story difficulty keeps full enemy HP, so a plot-first player gets long, threat-free boss fights · CONFIRMED (numbers)

**Evidence.**
- Story is `enemyHpMult: 1` with all incoming damage 0 (`tuning.ts:100`). A Story player is the least likely to shop.
- On the starter Kinetic at main-path levels (Marine 6/5/1/1):
  - the Matriarch is 4,600 HP / ≈ 60 DPS ≈ **77 s** of pure shooting;
  - the Queen is 8,400 / ≈ 66 ≈ **127 s**.
- A Story player cannot lose. Two minutes of holding still in front of a boss is the definition of filler.

**Fix (initial tuning).** Story `enemyHpMult` 1 → 0.6.

**Effort.** S.

---

### G-14 · P3 · Mission design · The "elites" bonus is a dice roll · CONFIRMED (rule) / PLAUSIBLE (odds)

**Evidence.**
- `bonusHeld` counts elite kills (`Missions.ts:158-169`). Nothing forces an elite to spawn.
- Elites roll once per pack leader, at the planet's `eliteChance`: 0.06 on Thessaly and 0.07 on Ferrum (`planets.ts:364, 424`).
- Over ~15–20 pack spawns per mission:
  - `c3_s1` (1 elite) pays about 60 % of the time;
  - `c4_m2` (2 elites) about 40 % (binomial).

**Why it matters.** A skill bonus that pays on luck teaches the wrong thing. Lingering to farm elites is also the only way to improve the odds.

**Fix.** When a mission with an `elites` bonus starts its stage, force the next N pack leaders elite (the `forceElite` path exists, `Spawn.ts:728`).

**Effort.** S.

---

### G-15 · P3 · Honesty · The Swarm contract does nothing on `low` for chapters 3–5, and little on `medium` · CONFIRMED

**Evidence.**
- The swarm's scaled target is clamped by the preset's `maxEnemies` (`Spawn.ts:250-254`), which is 12 on `low` (`Quality.ts:57`).
  - The Hive goes 15 → 12, so ×1.5 makes it 12 again.
  - Ferrum goes 13 → 12 → 12, and Thessaly 12 → 12.
- On `medium` (20) the Hive gets +33 %, not +50 %.
- The badge still reads "Half as many hostiles again" (`contracts.ts:48`), and the contract still pays 0.75 + 20 Li.

**Fix.** On a preset at its cap, the board offers another modifier, **or** the swarm ×1.5 raises `eliteChance` instead.

**Effort.** S.

---

### G-16 · P3 · Unused content · Dead data in the tables · CONFIRMED

| What | Evidence |
|---|---|
| The `flight_salvage` loot table is never rolled | Flight kills pay XP only (`Flight.ts:783-803`). Defined at `loot.ts:147-151`, named by `enemies.ts:592, 611` |
| `eliteAllowed: true` on both flight enemies is dead | Flight emits `elite: false` (`Flight.ts:800`) and never rolls (`enemies.ts:594, 613`) |
| Eden's `eliteChance: 0.1` is dead | Eden has no ambient spawns and no cave packs (`planets.ts:549-551`, `caves.ts:205`). Waves use only their explicit `elite` flag (`Spawn.ts:589`), and the contract and containment elite terms never reach Eden |
| The `ambientWaves` field is in the schema and used by no planet | `planets.ts:168` |
| Stale comment | `waves.ts:150` "c5_m1's 10" |

**Fix.** Roll `flight_salvage` on flight kills (G-20), and delete the rest. Or give Eden's wave groups a per-spawn elite roll at the planet chance, which would make the finale scale with Hard and containment as players expect.

**Effort.** S.

---

### G-17 · P3 · Honesty · "Walked, did not run" counts dashes, not running · CONFIRMED

**Evidence.**
- The rule is `{ boss: 'dune_wurm', without: 'dash' }` (`commendations.ts:56-61`), and only `player:dashed` breaks it (`Commendations.ts:263-264`).
- Running (SPEC-050's sprint) is the thing the Wurm punishes (`enemies.ts:238`). A player who sprints the whole fight earns the title.

**Fix.** Also break it on `player:sprinting` (or `isLoud`) during the fight. Detail text: "Kill the Dune Wurm without running or dashing."

**Effort.** S.

---

### G-18 · P3 · Treasure · Two relics are rewards that read as downgrades · CONFIRMED

**Evidence.**
- **Seeker Tube.** The chapter-5 vault's relic is tier 3, 80 damage on a 6 s charge (`items.ts:648-669`). That is less than the chapter-1 Wurm's Rocket at 90 on the same cooldown (`:381-401`). On touch it is net negative (§3.2).
- **Last Word.** The chapter-1 vault's relic is a sidearm and inherits G-04: it never fires for a rifle user or a desktop default.
- SPEC-056 meant relics as 0.6–1.1× side-grades (`items.ts:551-554`). The puzzle-and-vault effort pays the curious player a weaker gun, and the tokens are only 5.

**Fix (initial tuning).** Seeker damage 80 → 95, so homing plus a bit more beats the Rocket. Last Word: fix G-04.

**Effort.** S.

---

### G-19 · P3 · Mission design · Filler at the end · CONFIRMED

**Evidence.**
- **`c5_s1` Egg Hunt.** Fifteen static 199 HP eggs, 5 XP each (`missions.ts:536-549`, `enemies.ts:528-545`). That is 2,985 HP of target practice, about the old Queen. The R18 audit asked for 15 → 10 (E-11); it was not taken.
- **Chapter 6** is three scans on a planet with no enemies (`missions.ts:552-570`, `planets.ts:549-550`), then one defence. The last chapter has one fight.
- R18 called `c6_m1`'s lull deliberate, which is fair. But together with G-02 the final hour is thin.

**Fix (initial tuning).** `c5_s1` 15 → 10 eggs with par 360 → 240. For Eden, see the G-02 option.

**Effort.** S.

---

### G-20 · P3 · Flight · Thin early trips and no reason to engage · CONFIRMED

**Evidence.**
- **Mandatory first trips:** Cinder-4 90 s with no ships, Vetra 110 s with 2 fighters, Thessaly 130 s with 6 (`waves.ts:116-137`).
  - Fighters leave after 25 s (`Flight.ts:220`), so they can be ignored.
  - Kills pay XP only (G-16), and asteroids pay nothing.
- **Skips.** After the first landing every route can be skipped (`Flight.ts:315-321`).
- **What ship tiers still do.** The tiers past the Ferrum gate act only on the Gauntlet and the first Eden trip:
  - Hull and Shield T3: 250 tokens + 140 lithium;
  - Guns T2–T3: 210 tokens + 80 lithium;
  - Engine: 200 tokens + 60 oil.
  - The engine's fuel cut is moot with the depot.
- **R18's salvage idea** (combat audit G-17: an asteroid of radius ≥ 3 m drops oil, capped per trip) never landed.

**Why it matters.**
- Flight is pretty and short, so it is not a chore. Skip handles that.
- But the first three trips teach steering and nothing else. The ship ladder is 1,095 tokens of mostly labelled convenience; R18 accepted that, and the depot weakened it further.

**Fix (initial tuning).**
- Roll `flight_salvage` on fighter and interceptor kills.
- Add R18's asteroid salvage: radius ≥ 3 m → 2 oil, capped at 20 a trip.
- Vetra's flight 2 → 3 fighters, and Thessaly's second group at 75 s, not 90.

**Effort.** S.

---

### Mechanics against the missions that use them

| Mechanic | Where the main path uses it | Verdict |
|---|---|---|
| Dash, telegraphs, packs, affixes | Every fight | Earns its place |
| Auto-fire (default on) | Everything | Works; it makes the heavy slot and consumables the only active inputs (see G-01, G-12) |
| Storms and shelters | 7 survive stages, chapters 1–4; none in 5–6 | Dropped after Ferrum |
| Sprint and stamina | Free travel out of combat; 4 s in combat | Used, as a speed boost |
| Noise and hiding | Aggro radius ×1.5, shelters; the Wurm's phase-2 burrow (1–2 repetitions, G-06) | Under-used: the signature rule has one boss phase |
| Underground and flashlight | No mission | Optional only |
| Puzzles (5 kinds, 17 sites) | No mission. A 90 s bypass; a flawless solve pays +1 medkit | Optional and low-stakes; fine for a story game, but invisible to the main path |
| Treasure and relics | No mission; relics are side-grades (G-18) | Lore-driven, not loot-driven |
| Remains | Every death; the depot and medkits make deaths rare and cheap (G-01, G-10) | Rarely seen |
| Escort, defend, choice | One mission each | Introduced and never revisited |
| Contracts, bonuses, Hard, NG+ | All replays | Rich on paper; G-01 and G-11 flatten them |

---

## 5. Easy wins (effort S; old → new)

| # | Change | Where | Fixes |
|---|---|---|---|
| 1 | `weaponAutoSwap` default `'touch'` → `'on'` | `Settings.ts:387` | G-04 (the Hand Cannon, Last Word and the machine guns on desktop) |
| 2 | Drone shot = `0.4 × weaponDps(primary).sustained × fraction × …` (was `weapon.damage × fraction × …`); card "of your sustained DPS" | `Combat.ts:2072`, `UiHelpers.ts:614` | G-05 |
| 3 | `fireSlotOnce`: `fireCooldown = 1/rate` → `max(fireCooldown, 0.25)` | `Combat.ts:1932` | G-12 |
| 4 | Dune Wurm phase-2 `hpFraction` 0.4 → 0.55, and burrow `every` 9 → 6 | `enemies.ts:229, 238` | G-06 |
| 5 | Remove `{ ship weapon 1 }` from `RECOMMENDED_LOADOUT[6]` (re-pin `balance.test.ts:50,73`) | `Balance.ts:100` | G-09; frees margin for G-07 |
| 6 | `EXPLOSIVE_USE_SECONDS` 0.5 → 1.2 | `Surface.ts:465` | G-01 (half of it) |
| 7 | Story `enemyHpMult` 1 → 0.6 | `tuning.ts:100` | G-13 |
| 8 | Boss-mission contract tokens 0.75 → 0.5 (XP stays 0.75) | `contracts.ts:72`, `Economy.applyRewards` | G-11 |
| 9 | Ash Titan phase-3 `damageMult` 1.44 → 1.3; Vetra `population` 11 → 13 | `enemies.ts:481`, `planets.ts:291` | G-07 |
| 10 | `c1_m1` survive 60 → 30 s (R-entry for the PLAN §6 row) | `missions.ts:145` | G-08 |
| 11 | `c5_s1` eggs 15 → 10, par 360 → 240 | `missions.ts:545-547` | G-19 |
| 12 | Seeker Tube damage 80 → 95 | `items.ts:656` | G-18 |
| 13 | Roll `flight_salvage` on flight kills; asteroids of radius ≥ 3 m drop 2 oil (cap 20 a trip) | `Flight.ts:797-801` | G-16, G-20 |
| 14 | "Walked, did not run" also breaks on sprinting | `Commendations.ts:263` | G-17 |
| 15 | `elites` bonus: force the next N pack leaders elite at stage start | `Spawn.ts:728` path | G-14 |

---

## 6. Ranked top 5

1. **G-01: budget the consumables.** Add a heal cooldown, slow the explosive throw, and refill quick slots only out of combat. Without it every threat number tuned since R18 is advisory, and Hard, no-death bonuses and the remains lose their meaning. It needs an R-entry.
2. **G-02: let the missions use the game.** Re-stage three or four existing missions so the main path goes underground, solves a puzzle, walks past something that listens, and escorts or defends more than once. Chapter 4 is the first candidate. It needs an R-entry.
3. **G-04 + G-05 + G-12: three one-line fixes that make builds real.** Auto-swap on everywhere, a drone that scales with sustained DPS, and a launcher tap that does not cost a second of fire. Together they make the machine gun, the sidearm, the Engineer and the touch Rocket viable.
4. **G-03: make trash worth fighting from chapter 3.** Scale kill XP per chapter (moves the SPEC-016 pins) and guarantee one elite pack per landing in chapters 3–5, so packs and affixes are a reward, not a detour.
5. **G-07 + G-06: smooth the curve.** Lift chapter 2, trim the Titan's phase 3 and the Hive's warrior packs, move the Reactive Harness forward, and give the Wurm's burrow enough repetitions to teach the game's signature rule.

---

## Appendix — scratch calculators

All are in [`gsim/`](gsim/). Run them with `node docs/review-2026-10/gsim/<file>`. None imports the repo.

| File | What it computes |
|---|---|
| `dps.mjs` | Sustained DPS per primary (desktop default, auto-swap with each sidearm), and each launcher's net single-target contribution on desktop and touch. It re-implements `Loadout.ts:60-111` (heat, charges, ready, spend), the shared `fireCooldown` with `FIRE_CARRY`, the 0.25 s switch, the switch-resets-cooldown handler (`Combat.ts:647-649`) and `fireSlotOnce`'s cooldown (`Combat.ts:1932`) |
| `boss.mjs` | Pure-DPS boss lengths for SPEC-041's reference kit against a player who follows the Refit line a chapter early |
| `curve.mjs` | The §3.1 table: HP, DPS, trash TTK, rusher-charge and worst boss-hit shares by chapter |
