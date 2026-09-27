# ReaLLM — Combat audit: threat, feel, variety, bosses, flight

> **Provenance.** Written on 2026-09-27 for PLAN R18, against a snapshot of `main` with SPEC-035 applied (the factory lane at `dc9310d`), which the report calls `scratchpad/game-r18`. Paths under `scratchpad/` were that review session's working folder. Its simulation scripts (`scratchpad/audit-combat/`) stayed in that folder and are not part of this repository. The decisions taken from this report are PLAN R18 and SPEC-036…SPEC-045 in `mdzunic/reallm-specs`.

**Date:** 2026-09-27 · **Build:** snapshot `game-r18` (`main` @ `2fc28fd`, SPEC-001…SPEC-034, plus SPEC-035 in progress) · **Reviewer:** Claude, as senior combat designer · **Scope:** the moment-to-moment fight, on the surface and in flight. Economy, story and art belong to the first review (`review-2026-09.md`); where this audit re-checks that review's §7.1 and §7.4, it says so.

**Method.**
- **Read** `Combat`, `EnemyAi`, `Projectiles`, `Spawn`, `Weather`, `Shelter`, `Flight`, the data tables, the surface scene's step and feedback, and specs 009–013, 019, 029, 030, 034 and 035.
- **Ported the surface fight** to a standalone node simulation, 60 Hz, no repo imports (`scratchpad/audit-combat/`). The port covers:
  - the enemy brains, including boss phases, the burrow and the acid;
  - swept projectiles, and auto-fire with its 60 Hz fire quantisation;
  - i-frames and knockback;
  - the spawn director.
  - Each is copied line for line from the TypeScript.
- **Ran seven experiments** with bots, against three rule sets: the current rules, the first review's §7.1 tuning, and this audit's proposal.
- **How to read the numbers.** They are bot numbers, so read absolute values as ±25 %. The zeroes and the orderings are robust.
- **Reference player:** a Marine 6/5/1/1 (SPEC-016's worst-case creation) at the first review's main-path level and loadout for each chapter:
  - chapter 1: L3, Kinetic, Scrap;
  - chapters 2–3: L7 and L10, Laser, Weave;
  - chapters 4–5: L13 and L15, Plasma, Harness, combat drone.
- **The bots:**
  - **stand** never moves: a new player firing in place.
  - **walker** walks a 150 m route with auto-fire: travel to an objective. **walker, no fire** does the same without firing: the desktop default before the player learns to fire.
  - **kite** uses auto-fire, walks away from anything within its reach + 3.5 m, and otherwise closes to ¾ of its weapon range.
  - **dodger** is the kite bot plus a reading of every windup, telegraph and projectile with a 0.25 s reaction. It walks the safest of 16 headings.
  - **dasher** is the dodger with the proposed dash.
  - **cheese** stands 8 m outside a boss arena and shoots.

Severity: **P1** most players meet it and it shapes the core loop · **P2** noticeable · **P3** polish. Effort: **S** ≤ ½ day · **M** 1–3 days · **L** 1–2 weeks.

---

## 1. Summary

1. **Walking away is a complete defence.** Windups root the attacker and the hit is checked at reach + 0.2 m. A retreating player takes 0 melee hits from any trash enemy or boss, and ranged shots miss anyone moving sideways (duel sim, 40 s × 4 seeds).
2. **Bosses are HP bars.** They are five copies of one 4 m/s melee body. A kiter takes 0–7 % of max HP (51 % against the Queen) in 15–23 s, and standing outside the "sealed" ring also works. The first review's HP ×2.5 only stretches that to 32–53 s.
3. **Trash arrives one at a time and dies before it reaches the player.** Time to kill is 0.18–0.78 of the time it needs to close, and a kiter has ≤ 0.53 aggroed enemies within 12 m on average. Ambient damage is 0–11 %/min for a kiter and 0.4–1.8 %/min for a walker with auto-fire.
4. **What kills is standing still, and storms.** `c1_s2`'s heatwave deals 107 % of max HP in the open. Survive stages are 585 s of waiting in caves. Casual does not soften weather, and it cannot be turned on mid-game, although the death hint says it can.
5. **Proposal: three new mechanics, plus content.** M1: a dash (5 m, 0.3 s of invulnerability, 1.4 s cooldown). M2: committed attacks with ground telegraphs (mobile swarm windups, rusher charges, boss move lists). M3: packs led by elites with affixes. Content: storm waves in survive stages, and per-boss HP.
6. **Simulated result.** Ambient damage: kite 1–13 %/min, dodger ≈ 0, a walker who never fires 27–43 %/min (hence desktop auto-fire on by default). Bosses: 32–47 s, costing a kiter 22–77 % of max HP, a telegraph reader 0–11 % and a dasher 0 %.
7. **The first review, re-checked.** Kept: packs and ARIA's lead. Rejected: the speed increases, which land 0 extra hits. Changed: HP increases moderated and made per boss; the storm cap replaced by a ramp and storm waves.
8. **Flight.** 94 % of fighter shots miss a weaving ship, and only 7 % of un-led player shots hit a strafing fighter. A lead pip, ARIA L2 leading and 3-round leading bursts fix both.

---

## 2. Findings

Paths are relative to the game repo. "Duel", "field", "boss", "aim", "flight", "weather" and "TTK" refer to the experiments in Appendix A.

| ID | Sev | Problem | Evidence (file:line + numbers) | Player impact | Proposal | Verified by | Effort |
|---|---|---|---|---|---|---|---|
| G-01 | P1 | **Melee can never land on a player who keeps moving** | `EnemyAi.ts:327-357`: the windup is rooted, and the hit check is at `meleeReach + 0.2` (`:351-354`). Windups are 0.25 / 0.35 / 0.6 s (`:20`), during which the player walks 1.5–3.7 m. Duel (40 s, 25 m area, player not firing): skitter vs retreat 6 attacks → 0 hits; wurmling 0 attacks started (5 m/s < the player's 6.12); Dune Wurm melee 0 attacks; wurmling vs a circling player 24 → 0; raider vs lateral movement 19 → 0. With the first review's speeds, skitters at 7.5 m/s start 18 attacks against a retreat and land 0 | Threat is binary: stand and be hit, move and be immune. "Keep walking" is the whole defensive skill. Rushers never rush, so SPEC-011 §7's "wurmlings rush" is not delivered | **M2**: the swarm windup keeps closing; rushers **charge** (trigger 6 m, 0.5 s windup, 20 m/s, 10 m lane) | `enemyAi.test.ts` new cases. `tests/balance/duel.test.ts`: a skitter lands ≥ 90 % of attacks on a 6.12 m/s retreat; a charge lands ≥ 70 % on a retreat, ≤ 10 % on a 0.25 s sidestep and 0 % through a dash | M |
| G-02 | P1 | **No boss has a pattern that threatens a moving player** | `enemies.ts:136-470`: every boss moves at 4 m/s with melee range 3 and cooldown 1.4. Specials: the wurm's burrow (phase 2); the Queen's acid, phase 2 only (`EnemyAi.ts:499-511`). The Titan's phases only multiply damage (`enemies.ts:386-390`). Boss sim, 6 seeds: kite 7 / 0 / 0 / 0 / 51 % of max HP (wurm → Queen) in 15–23 s; stand 61–187 %. First review's tuning (×2.5 HP, 5.2 m/s): kite 2 / 0 / 0 / 0 / 62 % in 32–53 s | Each boss is learned in one attempt and beaten by walking backwards. Longer fights are not harder fights | **M2 boss move lists** (§4) and per-boss HP (§3) | `tests/balance/boss.test.ts`, per boss, 6 seeds: kite 20–80 %, dodger ≤ 15 %, dasher ≤ 5 %, 30–55 s. Content invariant 24: every move can be escaped on foot | L |
| G-03 | P2 | **The Dune Wurm's burrow cannot hit a player who stands still** | `EnemyAi.ts:56-59, 452-468`: it resurfaces 5 m from the player with a shockwave of radius 4. Only a player who walks toward the telegraph gets hit | The tutorial boss's signature attack teaches the opposite of its own ring | Resurface on the player's position sampled at the end of the dig: 1.2 s telegraph, radius 3.5, ×1.5 damage, repeating every 9 s in phase 2. Option (review S-05): it targets only a player who ran (> 3 m/s) or fired in the last 1 s, so "walk, do not run" becomes the pattern | `enemyAi.test`: a still player at the sampled point is hit; one who moves 4 m within 1.2 s is not | S |
| G-04 | P1 | **Trash arrives one at a time and dies before it arrives** | `Spawn.ts:218-229`: one enemy per 0.5 s tick, at a random point on a 25–40 m ring. At the chapter loadouts, time to kill ÷ time to close is 0.18–0.78 for every trash enemy (TTK table). Field: 0.12–0.53 aggroed enemies within 12 m on average for the kiter, at most 2–3; median time from aggro to death 1.0–1.7 s | No fight asks for a decision | **M3 packs** (swarms 3–5, rushers 1–2, drones 4–6 at the Hive and Eden) with pack-wide aggro. Trash HP +29–56 % (§3) | `spawn.test`: pack sizes, one elite roll per pack, pack aggro. Field bot: ≥ 0.8 aggroed within 12 m on average, max ≥ 6 | M |
| G-05 | P2 | **Ambient population follows the graphics preset** | `Spawn.ts:58-61`: `P = round(population × maxEnemies / 32)`, with `maxEnemies` 12 / 20 / 32 (`Quality.ts:51,71,88`). Medium plays 62.5 % and low 37.5 % of `population`, which `planets.ts:117` documents as the medium target (the first review's B-16, still open) | A phone on low fights 60 % of what a desktop on high fights | `population` is the design count on every preset (10 / 11 / 12 / 13 / 15), and `P = min(population, maxEnemies)` | `spawn.test.ts:94-108` rewritten: the same P on every preset, up to the cap | S |
| G-06 | P1 | **Survive stages are waiting, not fighting** | 7 surface survive stages total 585 s (315 s on the main path). Each is a forced storm with no enemies. `missions.ts:51` gives `survive` no `waves`, although PLAN §6 (`PLAN.md:339`) lists `waves?`. A shelter zeroes the weather (`Surface.ts:1830`) | About 10 minutes of standing in caves. R10's risk mitigation "survive stages still run their waves" is not true | **Storm waves.** `survive.waves` is PLAN-conformant; add 4 new waves (§3). Waves ignore hiding (E43), so the cave mouth becomes the fight, and mines and launchers win there | Content test: every weather survive stage except `c1_m1` names a wave. `missions.test`: the wave starts with the stage and is dismissed when it completes. e2e: `c1_s2` spawns it | M |
| G-07 | P2 | **Forced storms hit at full strength with no warning, and hurt chapter 1 most** | `Weather.ts:136-139`: `force()` skips the 10 s warning. Heatwave is 2 dps on every planet. In the open, `c1_s2` deals 180 damage, 107 % of the chapter-1 reference max HP with no armour; `c4_m1` 87 %, `c4_s1` 58 %, `c3_m1` 57 %. Ferrum's heatwave is halved by armour (resist 0.5); Cinder-4's is not | The first side mission kills in 84 s in the open. A forced storm is instant | A 10 s ramp from 0 to full on forced storms; `weather.dpsMult` 0.65 on Cinder-4; casual ×0.7 on weather (G-08) | `weather.test`: the ramp. Weather table: `c1_s2` ≤ 70 % | S |
| G-08 | P1 | **Casual cannot be chosen after creation, and does not soften the main killer** | `hints.ts:176` says "…casual difficulty is in Settings", but no difficulty control exists outside `CreationScene.ts:499-524`. PLAN §4 (`PLAN.md:215`): "Changeable in settings". Casual scales only hits (`Combat.ts:193-197`); weather skips it (`:449`); and Combat caches the difficulty at construction (`:320`) | The recovery advice shown at the moment of failure is false. A struggling player cannot get help | A Difficulty row in the pause menu that writes `save.meta.difficulty`, read live. Casual ×0.7 on weather, and casual windups ×1.25 (accessibility for M2) | Unit: Combat reads the difficulty per hit. e2e: the pause-menu toggle changes a hit's damage | S |
| G-09 | P1 | **No evade verb** | No dash or roll: `KeyboardMouseDriver.ts:23-51`, `Input.ts:53-74`. The right mouse button is unbound (`:250`) | Once attacks commit (M2), the player needs a skilled answer beyond walking. Agility has no combat role (the first review's "trap attribute") | **M1 dash** | `dash.test.ts`; the dasher balance bot takes ≤ 5 % per boss | M |
| G-10 | P2 | **Elites are bigger sponges** | `Combat.ts:117-120, 612-616`: ×3 HP, ×1.5 damage, ×1.3 scale, ×1.1 speed, gold tint. Waves never roll `eliteChance` (`Spawn.ts:333`), so Eden's 10 % (`planets.ts:449`) is dead data | Nothing to recognise, prioritise or play around | **M3 affixes**: swift, bulwark, volley, mender, volatile | `affixes.test.ts`; the field bot | M |
| G-11 | P2 | **Ranged enemies are outranged and cannot hit a moving player** | Enemy range 12 (every ranged row) against rifle ranges of 14–18 (`items.ts`). Shots aim at the current position at 14 m/s (`EnemyAi.ts:327-347`). Duel: 0 % against a circling or dodging player, 95 % against a standing one | Spitters are target practice unless you stand still | Range 12 → 13 and projectile speed 14 → 15 m/s, keeping "no leading, by design". The `volley` affix for elites | `enemyAi.test` band test; duel | S |
| G-12 | P2 | **Telegraphs are a 15 % size bump, and silent** | The windup visual is a ×1.15 scale (`ProceduralMeshes.ts:43, 582`). The only ground marker is the wurm's burrow (`SurfaceView.ts:867-875`). `AUDIO_REACTIONS` has no windup cue (`AudioReactions.ts:213-258`) | At 17 m on a phone, a skitter's windup changes about 1 px. An off-screen attacker gives no warning | **M2** ground decals (circle, lane, ring) that fill over the windup, plus an `enemy:windup` event with a cue per archetype | View test: one decal per live telegraph, progress 0 → 1. Audio exhaustiveness test | M |
| G-13 | P2 | **The sealed arena is not sealed** | The lock ring is drawn "while a boss fight seals the arena" (`SurfaceView.ts:733-740`), but `ArenaState.locked` is never read for the player: it is set at `Surface.ts:1978` and cleared at `Combat.ts:668`. The cheese bot 8 m outside takes 0 % from the Titan, 9 % from the Broodlord and 22 % from the Matriarch. The arena leash measures the boss (`EnemyAi.ts:476-496`), and the soft wall pushes back at ≤ 4 m/s (`:186-198`). With the first review's 5.2 m/s bosses, the stand bot saw 12–14 full-HP resets per fight against four of the five bosses | It is an exploit. Faster bosses also reset whenever a knocked-back player stands at the ring | Clamp the player inside `radius − 0.5` while the boss lives; the exits are death and Recall (E55). Keep boss speed at 4 | Surface test of the clamp; e2e walking into the ring | S |
| G-14 | P2 | **Auto-fire aims where the target is, not where it will be** | `Combat.ts:931-943`. Aim sim (30 s at 10 m), share of shots that land against a strafing raider: Kinetic 23 %, Plasma 27 %, Lithium 29 %, Laser 68 %. Against weaving skitters: 44–51 % | "My gun is weak": invisible misses cut raider DPS to a quarter | Lead only targets in `strafe`, using velocity smoothed over 0.2 s × flight time, capped at 3 m. Raiders go 23 → 44 %. Do not lead swarms: their weave makes a lead worse (47 → 37 %) | `combat.test`: a strafing target is hit ≥ 40 % of the time | S |
| G-15 | P3 | **Gaps in hit feedback** | A crit is rolled and then dropped (`Combat.ts:965-966`, `.amount`). Damage numbers are HP deltas drawn in one style (`Surface.ts:1323-1349`). Hit-stop happens only on elite and boss kills (`Surface.ts:4262`). Flight's non-lethal hits emit nothing (`Flight.ts:683-695`), so a 40 HP fighter takes 3 silent hits | Crits and chip damage don't read; flight hits feel like misses | `enemy:hit` carries `crit`, shown as a yellow number at ×1.3 with a tick. A 1-frame hit-stop on charge and slam hits taken. `flight:hazardHit` gives a flash, a tick and a reticle hit-marker | Unit tests on the payloads; view tests | S |
| G-16 | P2 | **Flight: fighters cannot hit a moving ship, and cannot be hit without leading** | Fighters aim at the ship's current position (`Flight.ts:878-897`). ARIA L2 snaps to the target's current projection (`:594-605`). Flight sim: 99 % of fighter shots hit a still ship and 6 % a weaving one. Un-led shots hit a strafing fighter 7 % of the time (56 % of fighters killed, only while they approach); led shots 61 % (100 % killed) | Flight becomes "weave, and fire only when they come close" | A lead pip at every ARIA level; L2+ snaps to the pip. Fighters fire 3-round bursts 0.12 s apart at 50 % lead | `flight.test`: the lead math. Pilot bot: `c4_s2` with a no-lead pilot and ARIA L2 completes ≥ 14 of 16 | M |
| G-17 | P3 | **Flight variety, and the first trip** | Two enemy ship types across 6 trips. Cinder-4's trip has no enemies (`waves.ts:61-66`), so the first flight never asks for a shot. SPEC-032's skip makes each route mostly a single trip | Flight stays beautiful but thin | Salvage: an asteroid of radius ≥ 3 m drops 2 oil when shot, capped at 20 per trip. Every trip gets a reason to shoot, and the first teaches it | `flight.test` | S |
| G-18 | P3 | **Chapter 5–6 drones are one-shot fodder** | `hive_drone` is the chapter-3 block (33 HP, `enemies.ts:238`), used at the Hive, at Eden and for the Queen's 12 summons. One Plasma shot deals 48.9 | The finale's swarm doesn't register | Drone packs of 4–6 at the Hive (with M3). This keeps SPEC-009 09-a's rule: raise counts, not stats | Field bot | S |
| G-19 | P3 | **Weapon lines lack situations** | Against one target the rifles dominate. Launchers add +9 DPS in rotation, and the Chaingun trails the free Laser (first review's weapon bench). Nothing rewards a burst window or area damage | Loadout choice reduces to "the highest-tier rifle" | Situations come from M2, M3 and storm waves (§4). Rocket damage 70 → 90 | Balance: a rotation bench against a pack of 4 | S |
| G-20 | P3 | **The death loop after dying to a boss** | Respawn at the pad (E4), 110–160 m from the arena: a 20–27 s walk per retry, with the boss at full HP | Harder bosses (M2) turn this into dead time | During an active boss stage, respawn at the arena entrance (radius + 6 m, toward the pad) | e2e | S |
| G-21 | P3 | **Fire-rate quantisation still costs 4–17 %** | `Combat.ts:962` sets `fireCooldown = 1/rate` (the first review's B-23): 3 → 2.86/s, 10 → 8.57/s, 12 → 10/s | Machine guns under-deliver the rate on their card | Carry the remainder (`+=`) | `combat.test.ts:245,296` | S |

---

## 3. Tuning

"Pinned by" names every test that holds the current value. **`tests/systems/balance.test.ts` pins none of these**: it checks only the economy's worst case, and no row below changes a price, a reward or mission XP. "Content #9" is `tests/data/content.test.ts` invariant 9, whose `archetypeBase` literals and chapter formula (HP ×1.35 and damage ×1.3 per chapter) pin every enemy's HP and damage.

| Entity / constant (file) | Current | Proposed | Why | Pinned by |
|---|---|---|---|---|
| Swarm base HP (`enemies.ts` swarm rows; SPEC-009 §4.3) | 18 (ch1–4: 18 / 24 / 33 / 44) | **26** (26 / 35 / 47 / 64) | TTK ÷ TTC 0.18–0.34 → 0.26–0.53. A pack of 4 takes 1.4–2.8 s to kill against a 1.9–2.5 s approach, so it reaches the player | Content #9 `archetypeBase.swarm` (literal) |
| Rusher base HP | 45 (45 / 61 / 82 / 111 / 149) | **70** (70 / 95 / 128 / 172 / 233) | Survives long enough to finish its charge windup (TTK 1.3–2.0 s against a 1.6–2.4 s approach to the 6 m trigger) | Content #9 `archetypeBase.rusher` |
| Ranged base HP | 35 (35 / 47 / 64 / 86 / 116) | **45** (45 / 61 / 82 / 111 / 149) | Lives through one windup, so it gets one shot per engagement | Content #9 `archetypeBase.ranged` |
| Ranged `attack.range` / `projectileSpeed` (every ranged row) | 12 / 14 m/s | **13 / 15 m/s** | Still outranged by the Kinetic (14). The first review's 14 ties the starter rifle: this audit's first pass at 14, with ranged pairs, cost the kite bot up to 20 %/min on Cinder-4 | Not pinned (the `enemyAi.test` band test reads the def) |
| Boss HP (`enemies.ts`; bosses leave the ×1.35 formula) | Wurm 900, Matriarch 1,215, Broodlord 1,640, Titan 2,214, Queen 2,989 | **1,800 / 3,000 / 3,700 / 5,400 / 6,000** | 32–47 s fights with moves (15–23 s today). One chapter factor cannot follow the player's DPS, which doubles at chapter 2 with the Laser. This assumes the reference loadout: if the first review's `floor(ch/2)` boss-gear change lands, re-run `boss.test` | Content #9 (boss base 900 × 1.35^(c−1)): replace with an explicit per-boss table |
| Boss `speed`, phase `speedMult` | 4; ×1.2 / ×1.3 | **Unchanged** (the first review's 5.2 and ×1.25 rejected) | Moves carry the threat. A boss above 4 m/s escapes the 4 m/s soft wall and resets (G-13) | — |
| `planet.surface.population` (`planets.ts`) + `P` (`Spawn.ts:58-61`) | 14 / 16 / 18 / 18 / 22 (played on medium as 9 / 10 / 11 / 11 / 14) | **10 / 11 / 12 / 13 / 15**, with `P = min(population, maxEnemies)` | The same fight on every preset (G-05); roughly today's medium + 1. With packs, a larger count was too hot in the sim (the Hive kiter died 1.3 times per 5 min at 22) | `spawn.test.ts:94-108` (`toBe(14)`, the /32 formula); content #10 |
| Spawn row `pack` (new field) | — (always 1) | Swarm **[3, 5]**, rusher **[1, 2]**, ranged [1, 1]; `hive_drone` [4, 6] at the Hive | Aggroed within 12 m: 0.12–0.53 → 0.74–1.03 on average, max 3 → 6–8 | New content invariant: `pack[1] ≤ maxAlive` |
| `WINDUP_SECONDS` / new `SWARM_WINDUP_TRACK`, `CHARGE` (`EnemyAi.ts:20`) | Windups rooted | Swarm windup closes at **1.0 ×** speed. Rusher `CHARGE`: trigger 6 m, windup 0.5 s, lock 0.15 s, turn 8 rad/s, 20 m/s, 10 m, pad 0.3, ×1.3 damage, knockback 1.5 m, recover 0.5 s after a hit / 0.9 s after a whiff, cooldown 2.5 s | M2; the numbers are in §4 | `enemyAi.test.ts:75-117` reads the constants (symbolic); add new cases |
| Dash (new `TUNING` keys) | — | `DASH_DISTANCE` 5, `DASH_SECONDS` 0.2, `DASH_IFRAMES` 0.3, `DASH_COOLDOWN` 1.4, `DASH_AGILITY_CUT` 0.03 | M1 | `tests/data/tuning.test.ts` (`TUNING` literal `toEqual`): add them deliberately |
| Weather (`Weather.ts`, `planets.ts`) | Forced storms at full DPS immediately; one DPS per weather id | `FORCED_RAMP_SECONDS` **10** (from 0 to full). `weather.dpsMult` **0.65** on Cinder-4, 1 elsewhere | `c1_s2` 107 % → 70 % of max HP in the open, with no full-strength surprise | `weather.test.ts:96` ("skipping the warning") still holds; add a ramp case |
| Casual (`Combat.damagePlayer`, EnemyAi windups) | ×0.7 on hits only | ×0.7 on weather too; windups and telegraphs **×1.25**; dash cooldown ×0.8 | Casual has to help against what actually kills (G-08) and against reaction checks (M2) | `combat.test.ts:134` (casual ×0.7 on hits) holds; add weather and windup cases |
| `autoFire` default (`Settings.ts:167`) | `'touch'` | **`'on'`** (PLAN decision, the first review's §11 Q4) | Under M2, a walker who never fires takes 27–43 %/min. The skill moves to movement, the dash and target choice. A held mouse aim still overrides | `tests/core/settings.test.ts:162` |
| `ELITE_XP_MULT` (`Combat.ts:120`) | ×3 | **×(3 + affixes)** | An elite with affixes is worth the risk | `combat.test.ts:574` |
| `launcher_rocket.damage` (`items.ts:312`) | 70 | **90** | Packs of 3–5 inside its 3.5 m blast: the heavy slot wins against packs | Not pinned by content or balance; SPEC-029 §4.1 table. `loadout.test` pins charges and recharge only |
| Fire cooldown (`Combat.ts:962`) | `= 1 / rate` | `+= 1 / rate` (carry the remainder) | Recovers 4–17 % of the rated DPS (G-21) | `combat.test.ts:245, 296` (`toBeCloseTo(1/3)`) |
| Fighter fire (`Flight.ts:878-897`) | 1 shot at the ship's current position every 2 s | A **3-round burst**, 0.12 s apart, aimed at `ship + 0.5 × ship lateral velocity × eta`, every 2 s | Constant weaving dodges 94 % today; a direction change should be the dodge | `flight.test` (SPEC-013 §4.4: "lead it and it misses") |
| ARIA assist (`Flight.ts:594-605`) | L2+ snaps to the target's current projection | L1+ draws a **lead pip** on the cone target; L2+ snaps to the pip | Share of shots hitting a strafing fighter 7 % → 61 %; fighters killed 56 % → 100 % | `flight.test.ts:610` (extend); the Gauntlet test's no-lead pilot is unaffected |
| New surface waves (`waves.ts`; not simulated) | — | `cinder4_storm` (c1_s2): 4 skitters @5 s, 1 wurmling + 3 skitters @30, 2 raiders @55, 5 skitters @75. `vetra_storm` (c2_m1, c2_s2): 5 mites @5, 2 crawlers @30, 6 mites @50, 2 spitters @70. `thessaly_storm` (c3_m1): 6 drones @5, 2 hounds @25, 8 drones @45, 2 spitters @60. `ferrum_storm` (c4_m1, c4_s1): 6 crawlers @5, 2 wraiths @25, 2 spitters @45, 8 crawlers @65, 2 wraiths (elite) @90. All with `spawnBand` [18, 30], no loop | G-06: 15–20 kills per stage, with the shelter mouth as a choke point | Content #11 (waves spawn real enemies in order); new invariant (G-06) |

### 3.1 The first review's §7.1 proposal, re-checked against the current code

| First review | Verdict | Evidence |
|---|---|---|
| Swarm HP 18 → 30, speed 6.5 → 7.5 | **Keep the HP direction (26); reject the speed.** A faster skitter still stops to wind up: 18 attacks, 0 hits on a retreat (duel) | Duel; field |
| Rusher HP 45 → 80, speed 5 → 6 | **Replace with the charge**, HP 70. At 6 m/s the rusher is still slower than every class (6.12–7.45) | Duel: 0 attacks started |
| Ranged HP 35 → 55, range 12 → 14 | **45 HP, range 13, projectile 15.** At 14 the chapter-1 raider matches the starter rifle and out-trades a standing player | Field (the first pass of this audit) |
| Boss HP 900 → 2,250, speed 4 → 5.2, phase 2 ≥ ×1.25 | **Reject the speed; replace the flat ×2.5 with a per-boss table plus move lists.** The kiter still takes 0–2 % (Queen 62 %). 5.2 m/s bosses leave the soft wall and reset 12–14 times against a standing player | Boss sim |
| Swarm packs of 3–5 | **Keep**, plus rusher pairs, pack-wide aggro and a leader who may be an elite with affixes (M3) | Field ablation: no single lever (packs, HP, population or committed melee) moves ambient damage beyond noise; together they do |
| Forced storms capped at 50 % of max HP | **Replace** with a 10 s ramp, a per-planet DPS multiplier (Cinder-4 0.65), casual ×0.7 and storm waves. A cap alone leaves survive stages as waiting | Weather table |
| ARIA aim assist leads | **Keep**, plus a lead pip at L1 and leading fighter bursts | Flight sim |

---

## 4. The three new mechanics

These three changes are one design, and they are specced together as the threat pass. They should ship in the same spec. The rules they share:
- **The architecture.** Pure systems in `systems/`, a fixed 60 Hz step, pooled entities, module-level scratch and no allocation in `update()`.
- **Randomness.** Boss move picks use the `ai` stream, and pack sizes and affixes use the director's visit stream, so the layout hash is unchanged.
- **The PLAN entry.** They need PLAN **R18** "the threat pass", which the first review reserved, with edge cases **E59–E64**. The vehicle is **SPEC-036**. If the factory wants it smaller, split it in two: M1 + M2 for trash, then M2 for bosses + M3.

### M1 — Dash (the evade verb)

**What it is.** A short burst of movement with invulnerability, the player's answer to a committed attack. Walking still dodges bosses' big telegraphs; the dash is for the lanes and bursts that walking cannot clear, and for getting out of a surround.

**Numbers (initial tuning, `TUNING`):**
- `DASH_DISTANCE` 5 m over `DASH_SECONDS` 0.2 s, which is 25 m/s.
- `DASH_IFRAMES` 0.3 s from the press, which covers 0.1 s past the end of the movement.
- `DASH_COOLDOWN` 1.4 s × (1 − `DASH_AGILITY_CUT` 0.03 × agility):
  - Marine (agility 1): 1.36 s.
  - Engineer (agility 2): 1.32 s.
  - Scout (agility 4–9): 1.23–1.02 s.
- This gives agility a combat role, the first review's "trap attribute" fix.
- Casual: cooldown ×0.8.

**Rules:**
- **Direction:**
  - the camera-mapped move input at the press (the same mapping as `Surface.#movePlayer`, `Surface.ts:1595-1596`);
  - with no input, the facing.
- **During the dash:**
  - movement input is ignored;
  - no weapon fires, although cooldowns, heat and charges keep ticking;
  - enemy push-out is skipped, so the dash passes through bodies;
  - knockback is dropped, not deferred.
- **Obstacles and the wall.** Obstacles use the same axis slide plus `resolveCircle` as walking (E54). The dash ends at the first contact, and its i-frames still run the full 0.3 s. The arena wall clamp and the boss-ring clamp (G-13) apply.
- **Invulnerability.** `player.invulnUntil = max(invulnUntil, t + 0.3)`. It blocks every direct hit: melee, projectiles (which are still consumed, AC-51), telegraphs and charges. Weather ignores it, since weather already bypasses i-frames.
- **Not affected:** hiding (a dash is not a shot, so it does not reveal the player), harvesting, and scan progress (a dash out of the scan ring breaks the scan, as walking out does). Flight ignores the action.
- **Refused silently:** while dead, during a modal, the map or a beat (the step returns before it), and on cooldown. A cooldown refusal plays a soft `ui_blip` at most once per 0.5 s.
- **Allowed:** during the 0.25 s weapon switch (the switch keeps running), a heat lock or a recharge.

**Interfaces:**
- `entities/Player.ts` gains `dashUntil`, `dashReadyAt`, `dashX` and `dashZ`.
- `systems/Dash.ts` (pure):
  - `dashCooldown(agility, difficulty)`;
  - `tryDash(player, dirX, dirZ, time, agility, difficulty): boolean`;
  - `isDashing(player, time)`.
- `Combat.update`:
  - skips `#updateFiring` while dashing;
  - `#pushPlayerOut` and `#applyKnockback` no-op while dashing.
- Event `player:dashed { x, z, dirX, dirZ }`. `AudioReactions` maps it to a new `dash` whoosh, synthesised in `scripts/assets/audio/sfx.mjs`, about 4 KB. `CombatFx` gets a `dash` burst: 3 afterimage streaks.

**Input:**
- A new action `dash`, on the **right mouse button** and `KeyV`. Shift is taken by the flight throttle and Space by fire.
- Touch: a **DASH** button (56 px, `TOUCH_BUTTON_PX`) beside SWAP in `MODE_BUTTONS.surface`, with the label in `BUTTON_LABELS`.
- The controls sheet reads "Right-click / V — dash".

**HUD:** a dash pip at the left end of the quick bar, with a cooldown ring (`qb-dash`).

**Tip `dash`**, per device, shown at the first telegraph the player sees:
- keyboard: "Right-click or V to dash. Nothing can touch you mid-dash."
- touch: "Tap DASH to slip an attack. Nothing can touch you mid-dash."

**Edge cases:**
- **E59** Dash into an obstacle or the wall: it stops at the contact, is never inside the obstacle, and the i-frames still run.
- A dash pressed in the same step as a hit: movement runs first in the step (`Surface.ts:1161`), so the i-frames are already up when combat resolves. The dash wins, deterministically.

**Tests (`tests/systems/dash.test.ts`), each on open ground:**
- Distance 5 ± 0.05 m in 12 steps.
- A melee hit at t + 0.25 s is blocked; one at t + 0.35 s is not.
- A second press inside 1.36 s is refused (Marine, agility 1); agility 9 gives 1.02 s.
- A dash stops at a rock, and `resolveCircle` leaves the player outside it.
- A dash passes through a skitter's body.
- Weather still ticks during the dash.
- No shot is fired while dashing.

**Balance (`tests/balance/boss.test.ts`):** the dasher bot takes ≤ 5 % of max HP from each boss. It took 0 % in the sim, using about 1 dash per fight.

**e2e:** `?scene=surface`; press V; `sceneInfo.dashes` goes 0 → 1 and the player moves about 5 m.

**Effort:** M, 2–3 days including input, touch, view and sound.

### M2 — Committed attacks and ground telegraphs

**What it is.** Enemy attacks commit to an area or a lane, and the ground shows it. Walking away no longer erases an attack; reading it does. It has three parts: one telegraph primitive, trash that commits, and boss move lists.

#### M2.1 The telegraph primitive

- **The pool.** `entities/Telegraph.ts` defines `TelegraphEntity`, pooled at 32 and owned by `Combat`:
  - `kind`: circle, line or ring;
  - `x`, `z`, `dirX`, `dirZ`;
  - `radius`, `length`, `width`;
  - `ringSpeed`, `ringMax`, `band`;
  - `startAt`, `hitAt`, `damage`, `elite`, `ownerId`, `source` (an `EnemyId`);
  - `bodyResolved` (a lane whose hit is the owner's charge contact), `resolved`.
  - Every field is reset on reuse.
- **Resolution.** In `Combat.update`, right after the brains:
  - At `hitAt`, a circle or line tests the player's circle, and the follower's. On a hit it calls `damagePlayer` (i-frames apply, so a dash avoids it) with 1.0 m of knockback away from the centre.
  - A ring expands from `hitAt` at `ringSpeed` up to `ringMax`, and hits once when its band `[R − band/2, R + band/2]` crosses the player.
  - A resolved telegraph is freed backwards, like deployables.
- **Cancellation.** A boss's pending telegraphs are cancelled when its phase changes, and when it dies or resets.
- **Hooks.** `AiHooks` gains `telegraph(e, spec): number`, which returns the pool index or −1 when the pool is full (the attack still resolves, without its decal), and `cancelTelegraphs(e)`.
- **The view.** `views/TelegraphView.ts`: three `InstancedMesh`es for circle, lane and ring, which is +3 draw calls. Check that against SPEC-015's medium budget (≤ 80 scene draws).
  - Each instance carries `progress = (t − startAt)/(hitAt − startAt)`. Circles and lanes fill from the edge to the centre (for lanes, from the owner outward), in `HOSTILE_RIM` `#ff5a3c` at 35 % alpha. Elites get a gold border.
  - A ring shows a thin outline at `ringMax` during its windup, then the band.
  - Under reduce motion the fill still advances (it is information), with no pulse.
  - `sceneInfo.telegraphs` counts the live telegraphs.
- **Sound.** A new event `enemy:windup { enemyId, kind: 'melee' | 'charge' | 'shot' | BossMoveKind, x, z }` fires on every windup start. `AudioReactions` maps it to a positioned cue per archetype: a click for a swarm, a growl for a rusher, a charge-up for ranged, a roar for a boss. That is 4 new sounds of about 6 KB each, rate-limited to 100 ms per archetype.
- **E60.** A telegraph lands on the escort follower: circles, lines and rings hurt the player and the follower, never a defended POI. The POI keeps its contact rule (`Surface.ts:2164-2180`).

#### M2.2 Trash that commits

**Swarm: mobile windup.**
- During its 0.25 s windup a swarm keeps closing at `SWARM_WINDUP_TRACK` (1.0) × its speed, until it is within half its melee reach. The hit check at the end is unchanged: reach + 0.2.
- Consequence: a Marine or Engineer (6.12–6.24 m/s) cannot out-walk a skitter (6.5 m/s). They kill it or dash. A Scout (7.45) still escapes.
- Duel: 100 % of attacks land on a retreating Marine; a 0.25 s windup is shorter than human reaction, so swarm hits are unavoidable by reaction. They are the tax for letting a pack reach you, 4–9 damage each, capped by the 0.3 s i-frames.

**Rusher: the charge** (`CHARGE`, initial tuning):
- **Trigger.** In chase, with the target ≤ 6 m away, `cooldown ≤ 0` and a clear line (`lineClear`).
- **Windup.** 0.5 s, rooted, with the ×1.15 scale plus a lane telegraph 10 m long and 2.8 m wide. The facing tracks the target at ≤ 8 rad/s until 0.15 s before the charge, then locks, and the lane locks with it.
- **Charge.**
  - It moves at 20 m/s along the locked facing for up to 10 m, with no separation steering.
  - On contact (centre distance ≤ its radius + the player's radius + 0.3): ×1.3 damage, 1.5 m of knockback, then a 0.5 s recovery.
  - At an obstacle (`hitsCircle`) or the wall it stops: that is a whiff.
  - At 10 m with no contact: a whiff, and a 0.9 s recovery. This is the **punish window**, and it plays a "dazed" wobble.
- **Cooldown.** 2.5 s between charges. Inside melee reach the rusher still uses its 0.35 s melee.
- **Duel.** 100 % of charges land on the kite bot and 67 % on a circling player. They land 0 % on a 0.25 s-reaction sidestep and 0 % through the dash.
- **E61.** A charge can hit the follower; it never pushes the player into an obstacle (E54 resolve).

**Ranged: unchanged behaviour** (range 13, 15 m/s, §3). Their threat comes from packs and the `volley` affix (M3).

#### M2.3 Boss move lists

**Schema.** `EnemyDef.moves?: readonly BossMove[]` (SPEC-009 §4.3):

```ts
type BossMoveKind = 'slam_target' | 'slam_self' | 'charge' | 'lines' | 'volley' | 'ring';
interface BossMove {
  id: string; kind: BossMoveKind; phaseMin: 1 | 2 | 3;
  range: readonly [number, number]; // target distance band, m
  weight: number; windup: number; cooldown: number; recover: number; damageMult: number;
  radius?: number;                                      // slam_*: metres beyond the body for slam_self
  length?: number; width?: number; speed?: number; lock?: number; // charge, lines
  lines?: number; spread?: number;                      // lines: count, radians between
  count?: number; projectileSpeed?: number; projectileRadius?: number; projectileRange?: number; // volley (spread = total fan)
  ringMax?: number; band?: number;                      // ring (speed = expansion m/s)
}
```

**Runtime (`EnemyAi.ts`):**
- New brain states `cast` and `bossCharge`, plus entity scratch `moveIndex`, `moveCd`, `castT` and `recover` (flat numbers).
- In `chase`, when `moveCd ≤ 0`, the boss picks a move by weight among those whose `phaseMin ≤ phase` and whose range band contains the target's distance. The pick uses the `ai` stream and a module-level scratch array.
- It then stays rooted in `cast` through the windup:
  - for charges and volleys, the facing tracks at ≤ 4 rad/s until `lock` before the end;
  - it resolves as follows:
    - `slam_*` and `lines` use the telegraph;
    - `volley` goes through the existing enemy projectile pool;
    - `charge` travels at `speed` and stops at the arena ring + 2 m;
    - `ring` expands.
  - It then sits in `recover`, the punish window, before chasing again.
- The basic melee stays as it is (rooted, 0.6 s). A big body can be out-walked; the moves carry the threat.
- The wurm's burrow is replaced as in G-03.
- The Queen's phase-2 acid (`EnemyAi.ts:499-511`) becomes her `acid_volley` move.

**Move tables** (initial tuning; damage is × the phase damage):

| Boss (HP) | Move | Phase | Kind | Range m | Weight | Windup s | Geometry | Damage × | Cooldown / recover s |
|---|---|---|---|---|---|---|---|---|---|
| Dune Wurm (1,800) | `sand_rush` | 1+ | charge | 5–22 | 3 | 0.9 (lock 0.25) | 14 m × 3.2 m at 18 m/s | 1.2 | 5 / 1.0 |
| | `tail_slam` | 1+ | slam_self | 0–9 | 2 | 1.0 | 3.5 m beyond its body | 1.0 | 4 / 0.8 |
| | burrow (G-03) | 2 | slam_target | any | — | 1.2 after a 2.5 s dig | r 3.5 on the player's position | 1.5 | repeats every 9 s |
| Frost Matriarch (3,000) | `shard_fan` | 1+ | volley | 4–20 | 3 | 0.6 | 5 shards over 0.9 rad, 15 m/s, r 0.35, 20 m | 0.5 | 3.2 / 0.4 |
| | `frost_nova` | 2 | ring | 0–14 | 2 | 1.0 | 9 m/s to 11 m, band 1.5 m | 0.9 | 7 / 0.8 |
| Hive Broodlord (3,700) | `brood_stomp` | 1+ | slam_target | 0–16 | 3 | 1.0 | r 3.5 | 1.0 | 4 / 0.8 |
| | `acid_spit` | 1+ | volley | 5–18 | 2 | 0.5 | 3 over 0.5 rad, 13 m/s, r 0.4, 18 m | 0.6 | 3 / 0.3 |
| | `burrow_rush` | 2 | charge | 6–22 | 2 | 0.9 (lock 0.25) | 14 m × 3.2 m at 18 m/s | 1.2 | 6 / 1.0 |
| Ash Titan (5,400) | `tremor` | 1+ | slam_self | 0–8 | 3 | 1.1 | 4 m beyond its body | 1.2 | 4.5 / 1.0 |
| | `fissure` | 1+ | lines | 6–24 | 3 | 1.0 | 3 lines 0.35 rad apart, 16 m × 2 m (5 lines from phase 2) | 0.8 | 5 / 0.6 |
| | `eruption` | 3 | ring | 0–16 | 2 | 1.0 | 8 m/s to 13 m, band 1.4 m | 1.0 | 8 / 0.8 |
| Hive Queen (6,000) | `acid_volley` | 1+ | volley | 4–18 | 3 | 0.5 | 3 over 0.6 rad, 13 m/s, r 0.35, 18 m | 0.45 | 2.4 / 0.2 |
| | `royal_dive` | 1+ | charge | 6–24 | 2 | 1.0 (lock 0.25) | 16 m × 3.6 m at 20 m/s | 1.2 | 6 / 1.2 |
| | `brood_burst` | 2 | slam_target | 0–18 | 2 | 1.1 | r 4 | 1.0 | 5 / 0.8 |

**Fairness invariant (content test 24, pure data).** Every move is escapable **on foot** by a player at `PLAYER_SPEED` 6 m/s reacting in 0.3 s, and every ring is dashable:
- **target circle:** `radius + 0.5 ≤ 6 × (windup − 0.3)`;
- **self circle:** `radius + 0.5 ≤ 6 × (windup − 0.3)`, where the radius is measured beyond the body;
- **lane:** `width/2 + 0.5 ≤ 6 × (windup − 0.3)`;
- **ring:** `3 + 6 × (windup + ringMax/speed − 0.3) ≥ ringMax + band/2 + 0.5` and `DASH_IFRAMES × speed ≥ band + 1.0`.

Every row above passes; brood stomp and tail slam are the tightest, at 4.0 ≤ 4.2, and eruption's dash check is exact (2.4 ≥ 2.4). The sim ran eruption with a 1.6 m band and the fissure with 3 lines throughout; the table's 1.4 m band and 5-line phase 2 are the invariant-safe versions, not yet simulated. The rusher charge counts its approach time: `1.4 ≤ 6 × (0.5 − 0.3 + (6 − 2.3)/20) = 2.3`.

**Arena lock (G-13).** While the boss lives and `arena.locked`, the player's position is clamped inside `arena.radius − 0.5`, like the wall (`WALL_INSET`), so the drawn lock ring becomes true.
- **E62:** the player cannot leave a live boss's ring. The exits are death and Recall to pad (E55), and both reset the boss.
- The boss's own leash can then only trip when the player is dead, and E4 already resets it then.

**Death loop (G-20).**
- **E63:** a death during an active boss stage respawns the player at the arena entrance (the point on the pad → nest line at radius + 6 m). The 2 s i-frames apply, and the boss resets.

**Casual.** Every windup and telegraph lasts ×1.25; damage ×0.7 as today.

**Simulated result** (6 seeds, 3 medkits):

| Bot | Damage (% of max HP) | Fight length | Deaths |
|---|---|---|---|
| kite | 22 / 38 / 64 / 77 / 39 | 47 / 32 / 38 / 36 / 43 s | 0 |
| dodger | 1 / 0 / 1 / 11 / 0 | — | — |
| dasher | 0 | — | — |
| stand | 167–233 | — | 4 of 30 fights, plus 7 fights that did not finish |

Order: wurm → Queen. The stand bot is the new player who never moves; the fights that did not finish were resets after knockback carried it out of the ring, which the arena lock removes.

**Tests:**
- `tests/systems/telegraph.test.ts`:
  - circle, lane and ring geometry;
  - resolution exactly once at `hitAt`;
  - i-frames block;
  - a ring hits once;
  - pool reuse resets every field;
  - a phase change cancels the boss's pending telegraphs.
- `enemyAi.test`:
  - the swarm windup closes on a 6.12 m/s retreat, and a 7.45 m/s player escapes;
  - the charge triggers at ≤ 6 m, locks 0.15 s early, travels ≤ 10 m at 20 m/s, stops at a rock or the wall, and recovers 0.5 s after a hit or 0.9 s after a whiff;
  - boss moves pick by phase and range, on the `ai` stream only.
- Content invariant 24, as above.
- `tests/balance/duel.test.ts` and `boss.test.ts` (the bots of this audit, over the real `Combat` harness `tests/systems/combatFixtures.ts`), with the thresholds in G-01 and G-02.
- **e2e:** debug "Wake boss" on Cinder-4; `sceneInfo.telegraphs ≥ 1` within 6 s; a dash on the first lane leaves HP unchanged.

**Effort:** L. The telegraph pool and view take 2–3 days, the trash brains 1–2, the boss runtime and five tables 3–4, and the tests 2.

### M3 — Packs led by elites with affixes

**What it is.** Encounters arrive as groups with a leader worth recognising. The same 15 stat blocks produce new situations: shoot the mender first, flank the bulwark, and don't stand next to the volatile one when it dies.

**Packs (spawn director, `Spawn.ts`):**
- **Size.** A spawn row gains `pack?: [min, max]`, with the values in §3. The size is `rng.int(min, max)`, capped by the row's `maxAlive` room and by `P + 4` (a pack is never split).
- **Placement.** Members sit inside a 2.5 m disc around one ring point. Each position is checked with `circleHits`; a failed member is dropped (**E64**).
- **Elite roll.** One roll per pack at `eliteChance`, and it applies to the first member, the leader.
- **Aggro.** All members share a `packId`. When one acquires the player by proximity, the whole pack aggroes. Damage already spreads aggro to the same species within 8 m.
- **Waves.** Waves keep their scripted groups. A group's `elite: true` now also rolls affixes, which is Eden's 6 warriors.

**Affixes (`data/affixes.ts`, `AffixId` union):**
- Rolled on the director's stream right after the elite roll: 1 affix in chapters 1–3, 2 in chapters 4–6, no duplicates, from the archetype's pool. Bosses never get affixes.
- They are stored in flat fields `affixA` and `affixB`, so nothing is allocated.

| Affix | Archetypes | Rule | Readability |
|---|---|---|---|
| `swift` | swarm, rusher, ranged | Speed ×1.35 on top of the elite ×1.1; windups ×0.8 | A streak trail |
| `bulwark` | swarm, rusher | A projectile hit arriving within ±60° of its facing deals ×0.25. Shots with pierce ≥ 1 and blasts ignore the guard (`ProjectileEntity.armorPiercing`, set at spawn from `weapon.pierce ≥ 1`) | A plate arc in front; guarded hits show grey damage numbers |
| `volley` | ranged | Fires 3 projectiles at ±0.25 rad, projectile speed ×1.2 | Triple muzzle glow during the windup |
| `mender` | swarm, rusher, ranged | Heals other non-boss enemies within 8 m by 3 % of their max HP per second, never itself (spatial-hash query, no allocation) | A green pulse ring at 8 m every 1 s |
| `volatile` | swarm, rusher | On death leaves a 3 m circle telegraph that resolves after 1.0 s for ×1.5 its damage. It hits the player only: never the follower, never other enemies (E42 still holds for the player's blasts) | A throbbing red core, then the decal |

**Readability.**
- A pooled nameplate layer (`ui/ElitePlates.ts`, 6 nodes, projected like the damage numbers) shows elites within 25 m, e.g. "Alpha Wurmling · Swift · Bulwark".
- The minimap's elite icon stays.

**Reward.** `ELITE_XP_MULT` becomes ×(3 + the number of affixes); `elite_bonus` loot is unchanged. No token total moves.

**Where each weapon line now wins (G-19):**
- launcher and mines: packs, and the cave mouth during storm waves;
- machine gun: bursts into the 0.9 s charge whiff and a boss's recover window;
- Hand Cannon, Plasma, Lithium: pierce breaks the bulwark;
- Laser: strafing raiders (68 % of shots land, against 23 % for the Kinetic).

**Simulated result** (field, 4 min × 6 seeds, medium, with the §3 HP and population):

| Bot | Damage, % of max HP per minute | Aggroed within 12 m | Median aggro → death |
|---|---|---|---|
| kite | 1.4–13 (today 0–11) | 0.74–1.03 on average, max 6–8 (today 0.12–0.53, max 3) | 2.2–3.9 s (today 1.0–1.7) |
| walker | 2.9–5.7 (today 0.4–1.8) | — | — |
| walker, no fire | 27–43 | — | — |
| dasher | 0–0.1 | — | — |
| kite, with affixes | 1.4–20 | — | — |

The Hive is the hottest planet, at 20 %/min and 0.6 deaths per 5 min for the non-dodging kiter. If playtests agree, its knob is `eliteChance` 0.08 → 0.06.

**Tests:**
- `tests/systems/affixes.test.ts`:
  - rolls use only the director's stream, and the layout hash is unchanged after 1,000 spawns;
  - counts per chapter, and pools per archetype;
  - the bulwark reduces frontal non-pierce hits ×0.25, but not side or rear hits, pierce shots or blasts;
  - the mender heals others 3 %/s within 8 m, never itself and never a boss;
  - the volley fires 3;
  - the volatile telegraph hits the player within 3 m after 1.0 s, and never the follower.
- `spawn.test`:
  - pack sizes;
  - one elite roll per pack;
  - pack aggro;
  - E64 drops a blocked member;
  - `maxAlive` and `P + 4` hold.
- Content: every archetype pool has ≥ 2 affixes, and `pack[1] ≤ maxAlive`.
- Field bot (`tests/balance/field.test.ts`): the kiter takes ≤ 20 %/min on every planet with no deaths, and the walker 2–8 %/min.

**Effort:** M, 2–3 days.

**Not a new mechanic, shipped alongside: storm waves (G-06).** `survive.waves` (PLAN §6 already has it) runs the planet's storm wave (§3) with centre `'player'` while the stage is active, and dismisses it when the stage completes (SPEC-034's `stopWave({ dismiss })`). `c1_m1` stays wave-free, because SPEC-035's ramp owns the first landing.

---

## 5. Top ten, ranked

| # | Change | Findings | Effort | Why this rank |
|---|---|---|---|---|
| 1 | **M2 committed attacks + ground telegraphs**: trash commits, boss move lists, per-boss HP, arena lock | G-01, G-02, G-12, G-13 | L | Removes "walk away = immune", the root of every threat symptom |
| 2 | **M1 dash** | G-09 | M | M2's fairness depends on it (0 % boss damage for the dasher); gives agility a role |
| 3 | **Storm waves in survive stages** | G-06 | M | Turns ~10 minutes of waiting into fights; PLAN-conformant |
| 4 | **Difficulty in the pause menu; casual softens weather and stretches windups; desktop auto-fire on** | G-08 | S | Makes the death hint true, and is the safety net for 1–3 |
| 5 | **M3 packs led by elites with affixes** | G-04, G-10, G-18 | M | Enemies arrive together; elites become recognisable problems |
| 6 | **Retune trash HP, ranged range/speed and population per preset** | G-05, G-11, §3 | S | Data only; needed for 1 and 5 to land at their numbers |
| 7 | **Wurm burrow on the player** (optionally "walk, do not run") | G-03 | S | Fixes the tutorial boss's signature, and can carry the story line |
| 8 | **Flight: lead pip, ARIA L2 lead, leading fighter bursts, flight hit feedback** | G-16, G-15 | M | Makes flight about aiming and direction changes, not constant weaving |
| 9 | **Forced-storm ramp and the Cinder-4 weather multiplier** | G-07 | S | Removes the chapter-1 storm deaths the first review hit twice |
| 10 | **Hit feedback: crit numbers and ticks, hit-stop on big hits taken, respawn at the arena** | G-15, G-20 | S | The feel of 1–5, and less dead time between boss attempts |

After those: auto-fire leads strafing targets (G-14), fire-rate carry (G-21), the rocket at 90 (G-19), asteroid salvage (G-17).

---

## 6. What to protect

- **Auto-fire on touch, and the heavy slot's explicit trigger** (R10). With M2 the skill axis is movement, so auto-aim stays. A held mouse aim keeps overriding it.
- **The readability work of SPEC-035:** the hostile rim, the ≥ 3:1 tints, hit-direction markers, occluder fade, and weapon, impact and explosion sounds. Telegraph decals use the same `HOSTILE_RIM` so the palette stays one language.
- **The safety rules:**
  - 0.3 s i-frames against stun-lock;
  - the 1 m knockback clamp;
  - E54 collision safety: the dash and charges must use `resolveCircle`;
  - E42: the player's own blasts never hurt the player or the escort;
  - Recall to pad (E55) as the universal exit, including from a locked arena.
- **Shelters.** Weather stays zero inside, and ambient enemies still lose a player who hides and holds fire. Storm waves ignore hiding by design (E43). Don't make ambient enemies ignore it too.
- **SPEC-034's fixes:** the Gauntlet (flight sweep, 20 HP interceptors, 6 kills); boss summons leaving with the boss; defend waves dismissed; wave enemies spawning aggroed and anchored.
- **Determinism:** fixed 60 Hz, pooled entities, and seeded streams. The layout stream is never touched by combat, and the layout hash is unchanged by any proposal here.
- **The boss's basic melee stays out-walkable** (rooted, 0.6 s). Big bodies should feel heavy; the danger belongs to the telegraphed moves.
- **The swarm weave and hop.** They make swarms read as organic, and their cost to auto-fire accuracy is thematic.
- **The economy invariants.** Nothing here changes a price, a mission reward or mission XP (the worst-case model). Kill XP only rises (affix elites), which can only help.
- **The kill-objective clock** (0.4–2.7 min per objective in the first review). Re-measure it with the new HP: packs raise kill rates (kiter 14–40 kills/min in the sim).

---

## Appendix A — Evidence and how to re-run it

Everything is in `scratchpad/audit-combat/`, plain node 24 with no dependencies. Run `node <file>` from that folder; the outputs are in `out/`.

| Script | What it measures | Output |
|---|---|---|
| `engine.mjs` | The port: brains (`EnemyAi.ts`), swept projectiles (`Projectiles.ts`), auto-fire with 60 Hz quantisation, i-frames and knockback (`Combat.ts`), the spawn director (`Spawn.ts`), boss phases, burrow and acid. Plus the proposed rules behind switches: mobile swarm windup, rusher charge, telegraph pool, boss moves, dash, packs, pack aggro, affixes, per-boss HP, population | — |
| `bots.mjs` | stand, kite, dodger (danger model over telegraphs, projectiles, windups and charges, 0.25 s reaction), dasher, walker, walker without fire | — |
| `rules.mjs` | `CURRENT`, `REVIEW1` (the first review's §7.1), `proposed()` | — |
| `exp1_duel.mjs` | One aggroed enemy, 40 s, the player confined to 25 m and not firing: attacks started vs hits landed per movement policy | `out/duel.md` |
| `exp2_field.mjs` | The director at medium, 4 min × 6 seeds per planet: % of max HP per minute, deaths, kills, time from aggro to death, enemies engaged (`SET=ablation` for one lever at a time) | `out/field.md`, `out/field_ablation.md` |
| `exp3_boss.mjs` | Each boss in its arena, 6 seeds, 3 medkits: wins, time, damage, sources | `out/boss.md` |
| `exp4_ttk.mjs` | Time to kill vs time to close per chapter and archetype, now and proposed | `out/ttk.md` |
| `exp5_flight.mjs` | Fighter and interceptor motion, converging shots; no-lead vs lead aim; fighter shots vs a still or weaving ship | `out/flight.md` |
| `exp6_weather.mjs` | Forced-storm damage in the open per survive stage vs the chapter's max HP | `out/weather.md` |
| `exp7_aim.mjs` | Auto-fire accuracy per weapon vs strafing, charging and weaving enemies, current vs lead | `out/aim.md` |

**Simplifications:**
- open ground: no obstacles or shelters in the field and boss runs;
- no follower;
- the camera frustum is ignored (the 25–40 m ring is off screen anyway);
- one class (the Marine), and idealised bots.

The claims that rest on geometry (G-01, G-03, G-11, G-14, G-16) don't depend on any of these.

**Headline numbers** (current → proposed, from the outputs):
- **Duel, hits landed on a retreating player:** skitter 0 → 100 %; wurmling 0 attacks → 100 % of charges on a kiter, 0 % on a sidestep.
- **Boss, kite bot:** 0–7 % (Queen 51 %) in 15–23 s → 22–77 % in 32–47 s. Dodger 0–11 %, dasher 0 %.
- **Field, kite bot:** 0–11 %/min → 1.4–13 %/min. Enemies within 12 m 0.12–0.53 → 0.74–1.03 on average. Median aggro → death 1.0–1.7 s → 2.2–3.9 s.
- **Time to kill ÷ time to close** (chapters 1–5): 0.18–0.78 → 0.26–1.30.
- **Flight:** fighters killed 56 → 100 %; share of shots that hit 7 → 61 %; fighter shots hitting a weaving ship 6 %, a still one 99 %.
- **Storms in the open:** `c1_s2` 107 %, `c4_m1` 87 %, `c4_s1` 58 %, `c3_m1` 57 %, `c2_m1` 37 %, `c2_s2` 33 % of the chapter's reference max HP.
