# PLAN — "Starfall Salvage" (working title)

Space post-apocalyptic RPG browser game. Single-player, fully offline, playable on desktop and mobile.

> Status: plan locked. This document is the source of truth for implementation.
> Detailed, implementable specs live in [`specs/`](specs/README.md). Where PLAN and a spec disagree, PLAN wins; open a refinement entry below and fix the spec.

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

---

## 1. Vision & Inspiration

Earth is resource-depleted after great wars. You are a salvager sent to survey distant planets, extract critical resources, and answer one question: can humanity live anywhere else?

Gameplay alternates between three modes:

- **Space travel (first-person)** — Three.js cockpit view: dodge/shoot asteroids, fight alien ships, survive storms between planets.
- **Planet surface (Diablo-style ARPG)** — angled top-down view: fight aliens, gather resources, loot gear, complete missions.
- **Hub station** — spend tokens on assistants, ship upgrades, weapons/armor; pick the next destination on a star map.

Tone/inspiration: **Dune** (scarce resources, desert planet), **Starship Troopers** (bug swarms), **Diablo** (ARPG loot loop).

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
| Tests | **Vitest** | `vitest ^5.0.0` (released 2026-09-03; fall back to `^4.1.11` only if a blocking bug appears) | Unit-test pure game logic |
| Offline shell | `vite-plugin-pwa` (**M7, build-time only**) | `^1.3.0` | Service worker + manifest = real offline + installable = exempt from Safari 7-day storage eviction |
| Assets | **Procedural** (planets, effects, UI, **enemies**) + **Kenney.nl CC0** (humans: Mini Characters, 32 animations, GLB; ships/props: Space Kit, glTF) | — | No artist needed |

Nothing else — no React, no physics engine (arcade physics is enough), no backend, no schema library (hand-written validators).

Supported platforms (floor): Safari/iOS 16.4+, Chrome/Edge 111+, Firefox 114+ (Vite 8 default build targets). Landscape orientation is recommended on phones; portrait shows a rotate prompt but stays playable in menus.

Language: English UI. Art: procedural vector + CC0 low-poly mix.

---

## 3. Architecture

- `Game.ts`: owns the single WebGL renderer + fixed-timestep loop (60 Hz update, render every animation frame, `THREE.Timer`); **state machine** swaps scenes (each scene = `enter/exit/update/render/dispose`).
- **Data-driven content**: planets, enemies, items, upgrades, missions, dialogue as TS data files — content without code changes. A content-invariant test validates every cross-reference (§11).
- **Event bus** (typed pub/sub) decouples UI ↔ gameplay (e.g. `resource:collected`, `player:leveledUp`). Subscriptions are owned by the scene and released on exit.
- **Entity pooling** for projectiles/particles/asteroids; **instanced meshes** for swarms; **seeded RNG** per planet for reproducible procedural layout (layout stream is deterministic from save seed + planet; runtime streams are re-seeded per visit).
- Gameplay simulation on the surface is **2D on the XZ plane** (circle collisions); Y is visual only. Flight is a bounded 2D steering plane with depth-sorted hazards. No 3D physics anywhere.
- Pure logic (economy, combat math, missions, save) lives in framework-free modules → unit-testable. Three.js only appears in `scenes/`, `views/`, and `core/Renderer.ts`.

### Project structure

```
index.html  package.json  vite.config.ts  tsconfig.json
public/assets/        # CC0 sprites/models (Kenney), CC0 audio, LICENSES.md
src/
  main.ts
  core/     Game.ts Loop.ts Renderer.ts StateMachine.ts Input.ts KeyboardMouseDriver.ts Audio.ts Save.ts Settings.ts Events.ts Rng.ts Assets.ts Disposer.ts Pool.ts SpatialHash.ts Benchmark.ts Log.ts
  scenes/   Boot Menu CharacterCreation Station StarMap Flight Surface
  systems/  Combat EnemyAi Projectiles Economy Progression Balance Weather Spawn Layout Missions Flight
  entities/ Player Companion Enemy Projectile Pickup Ship Asteroid   (plain data + pools; no Three imports)
  views/    PlayerView EnemyView ProjectileView ParticleView ...    (entity → mesh; Three lives here)
  data/     ids.ts characters planets enemies items upgrades companions missions dialogue waves weather
  ui/       Hud TouchControls Minimap StarMapUI ShopUI DialogueUI Menus style.css
tests/      unit tests mirror src/ (economy, save, combat, missions, rng, content, campaign)
```

---

## 4. Core Systems

### Character creation

- **3 classes**: *Marine* (+damage/HP), *Engineer* (cheaper ship upgrades, drone bonuses), *Scout* (speed, resource detection radar).
- **Customization**: name, portrait, color scheme, **5 attribute points** over class base across `might` (damage), `vigor` (HP), `agility` (speed), `tech` (drone damage, upgrade discount). Allocated at creation only; levels grant flat +4 max HP and +2 % damage. Per-level stat points: deferred.
- **Difficulty**: `casual` (enemy damage ×0.7, no death penalty) or `normal`. Changeable in settings.
- Class defines starting gear + passive.

### Resources & economy

- Resources double as **upgrade materials and mission objectives**:
  - oil = ship fuel (outbound jumps only)
  - wheat = HP regen consumables (crafting)
  - water = support item crafting + survival (coolant packs)
  - lithium = energy weapons + reactor (tier-3 upgrades)
- **Tokens** earned by leveling up (25 per level; XP from kills, missions) and by mission rewards. Tokens buy **assistants**, **upgrades**, and **gear**; **tier-3** upgrades also consume resources so resource sinks exist late-game.
- **Cargo cap** per resource: 400 base, ship cargo tiers → 600 / 800 / 1200. Pickups stop at the cap with a HUD warning.
- **Crafting** at the station (3 recipes): wheat ration (10 wheat), medkit (10 wheat + 10 water), coolant pack (15 water).

### Assistants (companions)

Purchasable, upgradable followers (levels 1–3) that persist across scenes; each declares which scenes it acts in:

| Assistant | Domain | Effect |
|---|---|---|
| Scanner Drone | surface | Auto-collect radius + resource nodes on minimap |
| Combat Drone | surface | Auto-fires at nearest enemy |
| Field Medic | surface | HP regen over time out of combat, then in combat at L3 |
| Quartermaster | station | +cargo capacity, shop discounts |
| Ship AI "ARIA" | flight | Free at start; upgrades add shield regen / auto-aim assist |

### Upgrades

- **Ship**: engine, hull, shield, cargo hold, lasers — tiers 0 → 3, used in the flight scene (cargo/engine also affect economy).
- **Gear**: weapon tiers (kinetic → laser → plasma → lithium-edged) and armor tiers (scrap → composite → reactive → ablative). Tiers 1–2 cost tokens; tier 3 costs tokens + lithium.

### Combat

- **Ground**: real-time ARPG — move/aim, attack, enemy AI (melee rushers, ranged spitters, swarm bugs, static targets), loot drops, elites (5 %, ×3 HP) + planet boss with phases.
- **Space**: arcade first-person **rail** flight — constant forward motion, lateral steering, laser fire, asteroid dodging, enemy ship waves, shield/hull damage. Fuel is charged **per jump, up front**; the return trip is instant autopilot.
- **Death**: surface → respawn at the landing pad, lose 10 % of carried resources (normal difficulty), timed stages restart, enemies near the pad despawn, boss resets. Flight → emergency recall to the station, fuel is lost, cargo is kept.

### Weather system

Per-planet cycles (sandstorm / heatwave / blizzard / avalanche / spore storm / radiation storm) affecting visibility, movement, and damage — telegraphed via HUD warnings (10 s). Missions can force a storm. Boss arenas suppress weather.

---

## 5. Planets & Story Arc (6 chapters)

Earth Command sends you out with the ship AI **ARIA**. Each planet resolves a resource shortage and a habitability survey question. Final choice at Eden-Prime: report honestly (Earth evacuates — but the fleet drains the planets) or fake the report (Earth collapses, you keep the colonies free). Flags: `ending_honest` / `ending_free`.

| # | Planet (id) | Biome | Resources | Threats | Gate | Fuel (oil) | Travel |
|---|---|---|---|---|---|---|---|
| 1 | Cinder-4 (`cinder4`) | desert | oil, wheat | dust skitters, scav raiders, dune wurm, sandstorms/heatwaves | — | 40 | 90 s |
| 2 | Vetra (`vetra`) | ice | water | ice crawlers, ice spitters, frost matriarch, blizzards/avalanches | `chapter1_done` | 60 | 110 s |
| 3 | Thessaly (`thessaly`) | jungle ruins | wheat | hive drones, spore hounds, hive broodlord, spore storms | `chapter2_done` | 80 | 130 s |
| 4 | Ferrum (`ferrum`) | volcanic | lithium | magma wraiths, ash titan, radiation storms/heat | `chapter3_done` + ship shield ≥ 2 | 100 | 150 s |
| 5 | The Hive (`hive`) | asteroid gauntlet → hive interior | — | interceptor fleet, hive drones, eggs, hive queen | `chapter4_done` | 120 | 200 s |
| 6 | Eden-Prime (`eden`) | temperate | — | final defense wave | `chapter5_done` | 120 | 150 s |

Every planet also has small secondary yields (enemy drops) so no resource is exclusive to one planet. Completing a chapter's boss mission grants a **refuel voucher** equal to the next planet's fuel cost.

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

Beats: ARIA teaches controls (the player touches down 12 m from the pad, so "reach landing_pad" teaches movement); a dying scavenger warns "the worms hunt by vibration — walk, don't run."

### Chapter 2 — Vetra (ice; water)

| ID | Title | Stages | Rewards |
|---|---|---|---|
| c2_m1 | "Whiteout" | [survive 90 s, blizzard] → [reach `ridge_camp`] | 150 XP, 15 tokens |
| c2_m2 | "The Thaw" | [collect 200 water; kill 10 `ice_crawler`] | 200 XP, 20 tokens |
| c2_m3 | "Glacier Heart" (BOSS) | [boss `frost_matriarch`] → [scan `thermal_vent`] | 300 XP, 35 tokens, flag `chapter2_done` (unlocks Thessaly) |
| c2_s1 | "Frozen Crew" (side) | [scan `crash_site`] → [deliver 40 water to `survivor_pod`] | 100 XP, 10 tokens, item `medkit_bundle` |
| c2_s2 | "Pelt Run" (side) | [kill 12 `ice_crawler`] → [survive 60 s, avalanche] | 90 XP, 10 tokens |

Beat: crash site log reveals an earlier Earth expedition — you are not the first; Earth has been quietly losing ships.

### Chapter 3 — Thessaly (jungle ruins; wheat)

| ID | Title | Stages | Rewards |
|---|---|---|---|
| c3_m1 | "Green Hell" | [collect 250 wheat] → [survive 75 s, spore storm] | 220 XP, 20 tokens |
| c3_m2 | "Bug Country" | [kill 20 `hive_drone`] → [escort `science_probe` from `probe_site` to `hive_mouth`] | 260 XP, 25 tokens |
| c3_m3 | "The Hive Mouth" (BOSS) | [boss `hive_broodlord`] | 350 XP, 40 tokens, flag `chapter3_done` (unlocks Ferrum) |
| c3_s1 | "Old Terraform" (side) | [scan `terraform_tower` ×3; kill 8 `spore_hound`] | 120 XP, 12 tokens, flag `terraform_secret` |
| c3_s2 | "Reaping" (side) | [collect 300 wheat] with waves `thessaly_reaping` | 130 XP, 12 tokens |

Beat: terraform towers are alien tech — someone seeded these planets for *us*. Or for something else.

### Chapter 4 — Ferrum (volcanic; lithium — gated by ship shield ≥ 2)

| ID | Title | Stages | Rewards |
|---|---|---|---|
| c4_m1 | "Firefall" | [survive 90 s, radiation storm] → [reach `lithium_flats`] | 250 XP, 25 tokens |
| c4_m2 | "Fuel of Gods" | [collect 200 lithium; kill 14 `magma_wraith`] | 300 XP, 30 tokens |
| c4_m3 | "Reactor Womb" (BOSS) | [boss `ash_titan`] → [deliver 100 lithium to `reactor_core`] | 400 XP, 50 tokens, flag `chapter4_done` (unlocks The Hive) |
| c4_s1 | "Core Sample" (side) | [scan `core_drill` ×2] → [survive 120 s, heatwave] | 150 XP, 15 tokens, item `plasma_cell` |
| c4_s2 | "Salvage Rights" (side, **flight**) | [kill 8 `scav_fighter`] during the outbound flight to Ferrum | 150 XP, 15 tokens |

Beat: ARIA decodes alien signal — the Hive knows Earth's location.

### Chapter 5 — The Hive (asteroid gauntlet; space-heavy chapter)

| ID | Title | Stages | Rewards |
|---|---|---|---|
| c5_m1 | "Gauntlet" (**flight**) | [survive 180 s asteroid field; kill 10 `hive_interceptor`] during the outbound flight | 350 XP, 30 tokens |
| c5_m2 | "Lair" | [reach `queen_chamber`; kill 25 `hive_drone`] | 400 XP, 35 tokens |
| c5_m3 | "Her Majesty" (FINAL BOSS) | [boss `hive_queen` (2 phases)] | 600 XP, 100 tokens, flag `chapter5_done` (unlocks Eden-Prime) |
| c5_s1 | "Egg Hunt" (side) | [kill 15 `hive_egg`] | 200 XP, 20 tokens |

Landing at The Hive requires clearing the arrival wave, so `c5_m1` completes naturally on arrival (§13 E12).

### Chapter 6 — Eden-Prime (finale)

| ID | Title | Stages | Rewards |
|---|---|---|---|
| c6_m1 | "Paradise" | [scan `eden_spring`] → [scan `eden_forest`] → [scan `eden_ridge`] | 400 XP, 40 tokens |
| c6_m2 | "The Verdict" | [defend `survey_beacon` 240 s, waves `eden_final`] → [choice `ending`: honest → `ending_honest`, fake → `ending_free`] | 800 XP, 150 tokens, flag `campaign_done` |

### Mission content policy (locked)

- Mission set above is locked as-is for the campaign.
- "Survive X seconds" objectives are reused deliberately: one cheap mechanic, many hazards (weather changes the feel).
- Extra tiers (hardmode variants, NG+, bounties) are pure data additions — deferred to post-M7 polish. Mission replay at 50 % is the only repeatable content in v1 and exists for anti-softlock reasons.

---

## 7. Token Economy Summary (corrected in R1)

| Source | Tokens |
|---|---|
| Main missions (18) | 670 (ch1 55 · ch2 70 · ch3 85 · ch4 105 · ch5 165 · ch6 190) |
| Side missions (9) | 104 |
| Level-ups (25 each) | ~400 main-path (≈ L17) · ~475 completionist (≈ L20) |
| **Total** | **~1,070 main-path · ~1,250 completionist** |

Total sink ≈ **2,010** tokens (ship 1,095 · gear 500 · companions 415), so a completionist affords ~62 % of everything and specialization is forced. XP curve: `xpToNext(L) = 100 + 50·L` (11,400 XP to reach L20), level cap 30.

Balance invariants (unit-tested, see [specs/09](specs/09-economy-progression.md)):

- Recommended loadout for chapter N costs ≤ tokens guaranteed by the end of chapter N−1 counting **main missions only** and **mission XP only** (worst case). Ferrum's shield-2 gate (140 tokens) is 39 % of that worst case (360).
- Base cargo cap (400) ≥ largest collect objective (300) + 100.
- Starting oil (60) ≥ Cinder-4 fuel (40) + 20; every chapter's boss mission funds the next jump.

---

## 8. Save Schema (versioned, migratable) — refined in R1

```ts
interface SaveV1 {
  version: 1;
  meta: { slot: 0|1|2; seed: number; createdAt: number; updatedAt: number; playtimeSec: number; difficulty: "casual"|"normal" };
  player: { name; classId; appearance: { portrait; primary; secondary }; attributes: { might; vigor; agility; tech }; level; xp; tokens; hp };
  resources: Record<ResourceId, number>;
  inventory: { itemId: ItemId; qty: number }[];
  equipped: { weapon: ItemId; armor: ItemId };
  ship: { engine: 0|1|2|3; hull: 0|1|2|3; shield: 0|1|2|3; cargo: 0|1|2|3; weapon: 0|1|2|3 };
  companions: { id: CompanionId; level: 1|2|3; enabled: boolean }[];
  progress: { missionsDone: MissionId[]; missionsActive: { id: MissionId; stage: number; counters: Record<string, number> }[];
              flags: string[]; currentPlanet: PlanetId | null; location: "station" | "surface"; poisDiscovered: string[] };
}
// Settings are global (not per slot): { master, music, sfx, quality, reduceMotion, autoFire, joystickSide, flightMouseSteer, showFps, fullscreen, benchmark, lastSlot, persistGranted, installHintShownAt }
```

Storage rules: 3 slots, key per slot plus a `.bak` copy of the previous good save; autosave at safe points only (station, landing, stage/mission completion, settings change, page hide); hand-written validator on load; export/import as a text code; `navigator.storage.persist()` requested on first save; Safari deletes script-writable storage after 7 days without use unless installed to the Home Screen (→ PWA in M7 + export prompt).

---

## 9. Mobile Strategy

- Responsive canvas + UI breakpoints; one codebase, `pointer` events unify mouse/touch; `touch-action: none` on the canvas, safe-area insets, `100dvh`.
- **Touch controls**: floating virtual joystick (left), aim-drag with auto-fire (right), action buttons, drag-to-steer in flight, auto-fire assist option, left/right-handed swap.
- **Quality presets** (auto-detect by a 2-second boot benchmark, overridable): clamp `devicePixelRatio` (1 / 1.5 / 2), particles, draw distance, capped enemy count; target 60 fps desktop / 30+ fps mid-tier mobile.
- Screen wake lock during gameplay; pause + audio suspend when the tab is hidden; WebGL context-loss recovery overlay.
- HUD/menu built as HTML/CSS overlay → naturally adapts to small screens; touch targets ≥ 44 px.
- M7: PWA manifest + service worker (precache the whole build) → installable, truly offline, save exempt from Safari eviction.

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
| M7 | Polish: mobile tuning, quality presets, balancing pass, PWA/offline, storage persistence, reduce-motion, save migration harness | 30+ fps on mid-tier phone; installable; full manual checklist green |

---

## 11. Testing & Verification

- `npm run typecheck` (tsc --noEmit), `npm run test` (Vitest), `npm run build && npm run preview` each milestone.
- Unit tests target pure systems: economy math, save migration/corruption, combat formulas, mission runtime, seeded level generation determinism.
- **Content invariants** test: every id referenced by missions/planets/loot exists; requirement graph is acyclic; each planet layout contains every POI its missions need (with counts); kill targets exist in the planet spawn table; flight missions fit inside the flight duration.
- **Campaign simulation** test: drives the mission runtime and economy with a scripted main-path player and asserts every gate (flags, shield-2, fuel) is satisfiable with guaranteed rewards only.
- Manual playtest checklist per scene (desktop keyboard/mouse + mobile touch).

---

## 12. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Scope creep (biggest risk) | Data-driven content, hard milestone gates; M3/M4 are the proof-of-fun checkpoints |
| Mobile perf with Three.js | Pooling, instancing, quality presets from day one (M0); perf budgets in [specs/14](specs/14-mobile-performance.md) |
| First-person feel without complex physics | Rail flight model only; cockpit HUD sells immersion |
| Asset consistency | Kenney CC0 families (Space Kit, Mini Characters) for humans/ships; enemies and props procedural |
| Save loss on iOS (7-day eviction, private mode, quota) | Export/import code, `.bak` slot, `persist()`, PWA install prompt, graceful "storage unavailable" mode |
| Fresh tooling (Vitest 5 is 3 days old; TS 7 just shipped) | Pin Vitest 5 with the 4.1 fallback documented; stay on TS 6.0 until M7 |
| Skeletal animation cost on mobile | Only the player + escort NPC are skinned; enemies use procedural transform animation |

---

## 13. Edge-case register (decisions)

Each entry names the owning spec. "Casual" = casual difficulty.

| # | Situation | Decision | Spec |
|---|---|---|---|
| E1 | Player can't afford fuel to any unlocked planet | On entering the station, `oil = max(oil, cheapest unlocked jump)`; ARIA line "Earth Command wired an emergency ration". Boss missions also grant a refuel voucher | 09 |
| E2 | Player spent all tokens and can't meet the shield-2 gate | Completed missions replayable at 50 % rewards; invariant guarantees worst-case tokens ≥ loadout | 09 |
| E3 | Cargo full during a collect objective | Base cap 400 ≥ any objective; pickups stop with a "CARGO FULL" toast; invariant tested | 09 |
| E4 | Death on the surface | Respawn at pad, full HP, 2 s invulnerability, −10 % carried resources (0 % casual), timed/escort/defend stages restart, enemies within 40 m of pad despawn, boss resets | 11 |
| E5 | Death in flight | Emergency recall to station; fuel lost; cargo kept; flight mission stage resets | 12 |
| E6 | Tab hidden / phone locked mid-combat | Loop pauses, audio suspends, accumulator reset on resume (no catch-up), best-effort save on `pagehide` | 01, 06 |
| E7 | WebGL context lost (iOS memory pressure) | Pause + overlay; on restore, renderer re-inits; if not restored in 5 s, offer reload (save is at last safe point) | 01 |
| E8 | localStorage unavailable/quota exceeded/corrupt | Boot in "no-save" mode with a warning; quota → drop `.bak` and retry once; corrupt → offer `.bak` or reset; export code always available | 06 |
| E9 | Save from a newer app version | Refuse to load; show version + export option | 06 |
| E10 | Stuck keys after alt-tab / focus loss | `blur` and `visibilitychange` release all actions; `pointercancel` releases touch | 04 |
| E11 | Multi-touch: joystick + fire simultaneously | Per-pointer ownership by `pointerId`; left zone = move, right zone = aim/fire | 04 |
| E12 | Flight kill objective not met at arrival | Landing blocked until the arrival wave is cleared ("can't land with hostiles on our tail"); waves spawn ≥ 2× required kills | 12 |
| E13 | Escort follower dies / defend POI destroyed | Stage restarts (follower respawns at `from`, POI HP refills) with a toast; no mission failure state | 11 |
| E14 | Kill objective but the enemy type doesn't spawn nearby | Spawn director triples the weight of objective enemies and guarantees one spawn per 20 s | 11 |
| E15 | Boss fight during a storm | Boss arena suppresses weather; forced mission weather ends when the boss stage starts | 11 |
| E16 | Deliver objective with insufficient held resources | POI shows "need N more"; player can leave and return; delivery consumes resources atomically | 11 |
| E17 | POI unreachable due to procedural obstacles | Layout keeps a clear corridor (8 m) from the pad to every POI and re-rolls the sub-seed if flood-fill fails | 11 |
| E18 | Player accepts several missions on one planet | All accepted missions for the planet are active in parallel; HUD tracks one pinned mission; counters are per mission | 11 |
| E19 | Reload mid-mission | Active missions persist with stage + counters; timed objectives restart from 0 | 06, 11 |
| E20 | Level-up during combat | Tokens/HP apply immediately; toast only (no modal) | 09 |
| E21 | Audio blocked until user gesture (iOS) | Boot shows "Tap to start"; the tap unlocks audio, requests wake lock, and (Android) fullscreen | 05 |
| E22 | Portrait phone | Rotate prompt in gameplay scenes; menus stay usable | 14 |
| E23 | 120 Hz displays / very slow frames | Fixed 60 Hz update, max 5 steps per frame, frame delta clamped to 250 ms | 01 |
| E24 | Both endings in one save | Impossible by design; `campaign_done` locks `c6_m2`; free roam continues | 08, 11 |
| E25 | Inventory full on gear drop | Gear stays on the ground 60 s with a toast; resources have their own cap | 10 |
| E26 | Story flag or item referenced but never defined | Content-invariant test fails CI | 08, 15 |

---

## 14. Spec index

See [specs/README.md](specs/README.md). Specs are numbered by dependency order and tagged with the milestone that implements them.
