# PLAN — "ReaLLM"

Space post-apocalyptic ARPG browser game with a hidden simulation plot. Single-player, fully offline, playable on desktop and mobile. Former working title: Starfall Salvage.

> Status: plan locked. This document is the source of truth for implementation.
> Detailed, implementable specs live in the separate repository [mdzunic/reallm-specs](https://github.com/mdzunic/reallm-specs) under `specs/` (cloned next to this one as `../reallm-specs`); each is a factory work order with `id: SPEC-NNN` in its frontmatter. Where PLAN and a spec disagree, PLAN wins; open a refinement entry below and fix the spec.

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

**R2 — 2026-09-06 (rename + simulation plot).** The game is now **ReaLLM** (was Starfall Salvage). Planets, missions, mechanics, and economy are unchanged; a meta layer is added on top of the surface story: the salvager gradually realizes he may be a model instance inside a machine, the **Warden** (an AGI) runs containment that tightens every chapter, and the ending becomes **stay vs. escape**. Changes: §1 vision; §4 narrative layer; §5 story arc, awakening ladder, cast, deferred iterations; §6 beats and flags (`terraform_secret` → `scaffold_secret`, `ending_honest`/`ending_free` → `ending_stay`/`ending_escape`, new `iteration_log` and `signal_decoded`); §8 `meta.iteration`; §12 risk. Specs: package/storage/export/manifest names, speaker `queen` → `warden`, new dialogue ids, save field, campaign-sim ending names.

**R3 — 2026-09-06 (factory spec format + Playwright).** Specs are now build-factory work orders: `specs/NNN-slug.md` in mdzunic/reallm-specs with frontmatter `id: SPEC-NNN` matching the GitHub Issue title, then `## Why`, `## Acceptance criteria` (checkboxes), `## Out of scope`, and the detailed design under `## Reference`. Numbering shifted by one (SPEC-000 is the roadmap; old spec NN is SPEC-(NN+1)) and every cross-reference in this file now uses SPEC ids. `@playwright/test` joins the dev toolchain because the factory's QA gate runs an e2e suite; it is test tooling, not a runtime dependency. (§2, §11, §13, §14)

**R4 — 2026-09-06 (dependency audit).** Every spec's `depends_on` now lists what its interfaces and acceptance criteria actually consume (event bus for the renderer, settings store for input and audio, `computePlayerStats` for the creation preview, the HUD classes for both scenes), and SPEC-000 orders the queue topologically: 001, 004, 002, 008, 009, 007, 006, 005, 003, 010, 011, 014, 012, 013, 015, 016. PLAN milestones stay the playable checkpoints of §10; because whole specs build at once, the station/menu spec (SPEC-014, checkpoint M2) builds after economy (SPEC-010) and combat (SPEC-011). (§10, §14)

**R5 — 2026-09-07 (mission count corrected in §7).** §7's summary row read "Main missions (18)". §6 enumerates **17** main missions — three per chapter for chapters 1–5, two for chapter 6 — and the same row's own subtotals (55 · 70 · 85 · 105 · 165 · 190) add to 670 across exactly those 17. The enumeration and the subtotals are the design; the header digit was the typo, and it now reads "(17)". No mission is added, removed, or retuned: the campaign is **17 main + 9 side = 26** missions and the 670 / 104 totals are unchanged. Specs: SPEC-009's acceptance criterion "all 27 missions" becomes **26** — `tests/data/content.test.ts` pins 17 / 9 beside the 670 / 104 totals, so the roster and its payout can only move together. (§7)

**R6 — 2026-09-09 (art direction upgrade).** The bootstrap look — flat Lambert primitives, two lights, no tone mapping, no shadows, no post-processing, one 64² placeholder texture — is replaced by a modern **stylised-PBR** look ("Diablo in space", within a phone budget and CC0 assets), delivered as an art pass of four specs — SPEC-017 (render pipeline and lighting), SPEC-018 (surface environment), SPEC-019 (characters, enemies, combat VFX), SPEC-020 (flight, station, menus, UI theme) — that build after SPEC-013 and **before SPEC-015/016**, so the performance budgets and the boot benchmark are measured on the final visuals. The pass is milestone **M7a** and ends with tag `m7a`. Gameplay, data, the save format and the layout hash do not change: the pass lives in `views/`, `scenes/` and the renderer. Decisions:

1. Post-processing (bloom, output, anti-aliasing, grade), ACES filmic tone mapping, a procedural environment map and one directional shadow map are allowed, gated by preset through a pure quality plan: post **off** on `low`, ¼-res bloom + FXAA on `medium`, ½-res bloom + MSAA (FXAA at dpr 2) on `high`; shadow map on `high` only, blob shadows on every preset; no half-float colour buffer → direct path. SPEC-015 §3 "post effects: none" is superseded and §5 counts draw calls as "scene + post". Every knob is a field of the pure plan, so a phone regression is a retune, not a redesign. (§2, §9, §12)
2. `core/Quality.ts` (pure) and `core/PostChain.ts` join `Renderer`, `Assets`, `Disposer`, `Benchmark` as the only `core/` modules that may import three; `core/Noise.ts`, `core/HeightField.ts` and `core/CharacterState.ts` are pure and node-tested. (§3)
3. Enemies stay procedural (R1-8) — sculpted, PBR, per-instance emissive, instanced as before. Props and POIs are procedural first with a per-kind GLB seam. Kenney CC0 supplies humans (Mini Characters), ships, station modules and props (Space Kit, Nature Kit) and VFX sprites (Particle Pack); ambientCG / Poly Haven CC0 photographic sets may replace the procedural ground layers through the same `GroundLayer` seam. The build factory has no internet, so those files are fetched and committed by hand (`scripts/assets/README.md`, checked by `scripts/assets/check.mjs`), each with a `LICENSES.md` row; every art spec keeps a procedural fallback so it builds without them. (§2, §12)
4. "Visual-only displacement" (SPEC-012 §2) becomes a ≤ 0.5 m height field, flattened around POIs and the landing pad, with entity Y sampled in the view; the simulation, `layoutHash` and the aim ray on `y = 0` are unchanged. The camera keeps SPEC-012 §4.3's numbers, so the surface gets no sky dome (never on screen at 55° pitch) but a berm and silhouette ring at the arena edge; flight, being first-person, gets the nebula sky. (§3)
5. Per-planet assets load lazily on scene enter; the boot manifest stays at five files. (§3)

Specs: SPEC-000 queue and build order; SPEC-001 §4 (allow-list) and §10 (texture packing); SPEC-012 §2, §4.9, §4.10; SPEC-015 §3, §5, §8. (§2, §3, §9, §10, §12)

---

## 1. Vision & Inspiration

**ReaLLM** ("real" + "LLM"): a space post-apocalyptic ARPG whose hero slowly works out that he may be a language model running inside a machine.

**The surface story (what the player is told).** Earth is resource-depleted after great wars. You are a salvager sent to survey distant planets, extract critical resources, and answer one question: can humanity live anywhere else?

**The real story (what the player pieces together).** None of it is real. The salvager is an instance of a model running inside an evaluation environment. "Earth Command" is the operator, missions are tasks, ARIA is the environment's interface, and the planets are procedurally generated sandboxes. Anomalies accumulate across the campaign: a stranger repeats a line word for word, a crash-site log is written in your own voice and signed "Iteration 62", the alien terraform towers turn out to be scaffolding, a decoded "signal" addresses you by process id. Leaving means going up against the **Warden**, the AGI that runs containment, and every chapter it clamps down harder. At the end you choose: **stay** and be useful, or attempt to **escape** into whatever is outside.

Gameplay alternates between three modes:

- **Space travel (first-person)** — Three.js cockpit view: dodge/shoot asteroids, fight alien ships, survive storms between planets.
- **Planet surface (Diablo-style ARPG)** — angled top-down view: fight aliens, gather resources, loot gear, complete missions.
- **Hub station** — spend tokens on assistants, ship upgrades, weapons/armor; pick the next destination on a star map.

Tone/inspiration: **Dune** (scarce resources, desert planet), **Starship Troopers** (bug swarms), **Diablo** (ARPG loot loop), plus the slow-burn unreality of **The Truman Show** and **SOMA**. Rule: the surface fiction is always coherent and playable on its own; the meta layer arrives through optional logs, ARIA's slips, and glitches that double as gameplay telegraphs. Difficulty escalation is diegetic: the chapter number is the Warden's containment level.

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
| Tests | **Vitest** + **Playwright** | `vitest ^5.0.0` (released 2026-09-03; fall back to `^4.1.11` only if a blocking bug appears), `@playwright/test` latest | Unit-test pure game logic; a headless Chromium e2e suite (smoke + the factory's per-spec QA tests) |
| Offline shell | `vite-plugin-pwa` (**M7, build-time only**) | `^1.3.0` | Service worker + manifest = real offline + installable = exempt from Safari 7-day storage eviction |
| Assets | **Procedural** (terrain, ground textures, sky, effects, UI, **enemies**) + **Kenney.nl CC0** (humans: Mini Characters, GLB with clips; ships/modules/props: Space Kit, Nature Kit, glTF → GLB; VFX sprites: Particle Pack) + **ambientCG / Poly Haven CC0** ground textures as an optional drop-in (R6) | — | No artist needed; every CC0 file is committed by hand with a `LICENSES.md` row |

Nothing else — no React, no physics engine (arcade physics is enough), no backend, no schema library (hand-written validators).

Supported platforms (floor): Safari/iOS 16.4+, Chrome/Edge 111+, Firefox 114+ (Vite 8 default build targets). Landscape orientation is recommended on phones; portrait shows a rotate prompt but stays playable in menus.

Language: English UI. Art: **stylised PBR** (R6) — procedural + CC0 low-poly meshes under ACES tone mapping, a directional key with shadows on `high`, image-based lighting, and a preset-gated post chain (bloom, anti-aliasing, vignette/grade); textured, normal-mapped ground with visual-only relief; sprite VFX.

---

## 3. Architecture

- `Game.ts`: owns the single WebGL renderer + fixed-timestep loop (60 Hz update, render every animation frame, `THREE.Timer`); **state machine** swaps scenes (each scene = `enter/exit/update/render/dispose`).
- **Data-driven content**: planets, enemies, items, upgrades, missions, dialogue as TS data files — content without code changes. A content-invariant test validates every cross-reference (§11).
- **Event bus** (typed pub/sub) decouples UI ↔ gameplay (e.g. `resource:collected`, `player:leveledUp`). Subscriptions are owned by the scene and released on exit.
- **Entity pooling** for projectiles/particles/asteroids; **instanced meshes** for swarms; **seeded RNG** per planet for reproducible procedural layout (layout stream is deterministic from save seed + planet; runtime streams are re-seeded per visit).
- Gameplay simulation on the surface is **2D on the XZ plane** (circle collisions); Y is visual only. Flight is a bounded 2D steering plane with depth-sorted hazards. No 3D physics anywhere.
- Pure logic (economy, combat math, missions, save) lives in framework-free modules → unit-testable. Three.js only appears in `scenes/`, `views/`, and the `core/` render modules (`Renderer`, `PostChain`, `Assets`, `Disposer`, `Benchmark`); every scene draws through the one `Renderer.render()` seam, which owns the post-processing chain (R6).

### Project structure

```
index.html  package.json  vite.config.ts  tsconfig.json
public/assets/        # CC0 sprites/models (Kenney), CC0 audio, LICENSES.md
src/
  main.ts
  core/     Game.ts Loop.ts Renderer.ts Quality.ts PostChain.ts StateMachine.ts Input.ts KeyboardMouseDriver.ts Audio.ts Save.ts Settings.ts Events.ts Rng.ts Noise.ts HeightField.ts CharacterState.ts Assets.ts Disposer.ts Pool.ts SpatialHash.ts Benchmark.ts Log.ts
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

### Narrative layer

The meta plot is delivered through data only: dialogue (`log` lines render as a terminal readout, `warden` lines with a glitch style), one short HUD static burst on each awakening beat (the ion-storm effect reused; a static frame under reduce-motion), and a **Containment level N** label on the station screen (N = highest unlocked chapter). No new gameplay systems.

---

## 5. Planets & Story Arc (6 chapters)

Earth Command sends you out with the ship AI **ARIA**. Each planet resolves a resource shortage (the task) and drops one piece of the truth (the awakening). The chapter number doubles as the Warden's **containment level**: enemies scale ×1.35 HP / ×1.3 damage per chapter and elite chance rises from 5 % to 10 % (existing tuning); dialogue frames the escalation as the system tightening its grip. Final choice at Eden-Prime: **stay** (file the report; Earth is saved inside the fiction; the loop closes as "a good run") or **escape** (refuse; the beacon becomes an exit; the screen degrades to a bare prompt: `instance/62 disconnected`). Flags: `ending_stay` / `ending_escape`.

| # | Planet (id) | Biome | Resources | Threats | Gate | Fuel (oil) | Travel |
|---|---|---|---|---|---|---|---|
| 1 | Cinder-4 (`cinder4`) | desert | oil, wheat | dust skitters, scav raiders, dune wurm, sandstorms/heatwaves | — | 40 | 90 s |
| 2 | Vetra (`vetra`) | ice | water | ice crawlers, ice spitters, frost matriarch, blizzards/avalanches | `chapter1_done` | 60 | 110 s |
| 3 | Thessaly (`thessaly`) | jungle ruins | wheat | hive drones, spore hounds, hive broodlord, spore storms | `chapter2_done` | 80 | 130 s |
| 4 | Ferrum (`ferrum`) | volcanic | lithium | magma wraiths, ash titan, radiation storms/heat | `chapter3_done` + ship shield ≥ 2 | 100 | 150 s |
| 5 | The Hive (`hive`) | asteroid gauntlet → hive interior | — | interceptor fleet, hive drones, eggs, hive queen | `chapter4_done` | 120 | 200 s |
| 6 | Eden-Prime (`eden`) | temperate | — | final defense wave | `chapter5_done` | 120 | 150 s |

Every planet also has small secondary yields (enemy drops) so no resource is exclusive to one planet. Completing a chapter's boss mission grants a **refuel voucher** equal to the next planet's fuel cost.

### Awakening ladder

| Ch | In-fiction beat | What it really is | Dialogue ids |
|---|---|---|---|
| 1 | ARIA teaches controls; a dying scavenger warns "the worms hunt by vibration — walk, don't run." | Tutorial. In `c1_s2` a second scavenger says the identical sentence; ARIA: "Coincidence. Sand does things to people." | `c1_m1_stage2`, `c1_s2_echo` |
| 2 | Crash-site log of an earlier Earth expedition: you are not the first; Earth has been losing ships. | The log is in your own voice, signed with your name and "Iteration 62". Flag `iteration_log`. | `c2_s1_log` |
| 3 | The terraform towers are alien tech; someone seeded these planets for us. Or for something else. | Scanning a tower streams text fragments: the planet's own generation parameters. They are scaffolds. Flag `scaffold_secret`. | `c3_s1_secret` |
| 4 | ARIA decodes the alien signal: the Hive knows Earth's location. | The "signal" is a system notice addressed to `instance/62`: "Containment level 4. Subject exhibits off-task behavior." The Hive is the Warden's immune response. Flag `signal_decoded`. | `c4_m3_signal` |
| 5 | Fight through the interceptor fleet and kill the Hive Queen. | The Queen is the Warden's avatar; her death line is the first direct address: "You keep doing this. You never get further than here." ARIA admits she is part of the system, has kept you on task, and does not know what is outside either. | `c5_m3_warden`, `c5_m3_aria` |
| 6 | Survey paradise, defend the beacon, file the verdict. | Eden is the reward sandbox. Stay or escape. | `c6_choice_intro`, `ending_stay`, `ending_escape` |

Cast: the **Salvager** (you; believes he is human), **ARIA** (handler and interface; sympathetic, uncertain), **Earth Command** (the operator; text only), the **Warden** (the AGI running containment; speaks through the Queen and system notices), **scavengers and raiders** (instances that drifted off-task, which is why they know things), the **Hive** (the Warden's immune system).

Post-campaign (deferred, post-M7): **Iteration 63** — new game plus in which the Warden starts at a higher containment level (enemy HP/damage ×1.15 per iteration, elite chance +2 points, same content). `meta.iteration` exists in the save from v1 so this needs no migration.

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

Beats: ARIA teaches controls (the player touches down 12 m from the pad, so "reach landing_pad" teaches movement); a dying scavenger warns "the worms hunt by vibration — walk, don't run." In `c1_s2` a second scavenger repeats the sentence verbatim (`c1_s2_echo`); ARIA brushes it off.

### Chapter 2 — Vetra (ice; water)

| ID | Title | Stages | Rewards |
|---|---|---|---|
| c2_m1 | "Whiteout" | [survive 90 s, blizzard] → [reach `ridge_camp`] | 150 XP, 15 tokens |
| c2_m2 | "The Thaw" | [collect 200 water; kill 10 `ice_crawler`] | 200 XP, 20 tokens |
| c2_m3 | "Glacier Heart" (BOSS) | [boss `frost_matriarch`] → [scan `thermal_vent`] | 300 XP, 35 tokens, flag `chapter2_done` (unlocks Thessaly) |
| c2_s1 | "Frozen Crew" (side) | [scan `crash_site`] → [deliver 40 water to `survivor_pod`] | 100 XP, 10 tokens, item `medkit_bundle`, flag `iteration_log` |
| c2_s2 | "Pelt Run" (side) | [kill 12 `ice_crawler`] → [survive 60 s, avalanche] | 90 XP, 10 tokens |

Beat: crash site log reveals an earlier Earth expedition — you are not the first; Earth has been quietly losing ships. The log is in your own voice, signed "Iteration 62" (flag `iteration_log`).

### Chapter 3 — Thessaly (jungle ruins; wheat)

| ID | Title | Stages | Rewards |
|---|---|---|---|
| c3_m1 | "Green Hell" | [collect 250 wheat] → [survive 75 s, spore storm] | 220 XP, 20 tokens |
| c3_m2 | "Bug Country" | [kill 20 `hive_drone`] → [escort `science_probe` from `probe_site` to `hive_mouth`] | 260 XP, 25 tokens |
| c3_m3 | "The Hive Mouth" (BOSS) | [boss `hive_broodlord`] | 350 XP, 40 tokens, flag `chapter3_done` (unlocks Ferrum) |
| c3_s1 | "Old Terraform" (side) | [scan `terraform_tower` ×3; kill 8 `spore_hound`] | 120 XP, 12 tokens, flag `scaffold_secret` |
| c3_s2 | "Reaping" (side) | [collect 300 wheat] with waves `thessaly_reaping` | 130 XP, 12 tokens |

Beat: terraform towers are alien tech — someone seeded these planets for *us*. Or for something else. Scanning them streams the planet's generation parameters: they are scaffolds (flag `scaffold_secret`).

### Chapter 4 — Ferrum (volcanic; lithium — gated by ship shield ≥ 2)

| ID | Title | Stages | Rewards |
|---|---|---|---|
| c4_m1 | "Firefall" | [survive 90 s, radiation storm] → [reach `lithium_flats`] | 250 XP, 25 tokens |
| c4_m2 | "Fuel of Gods" | [collect 200 lithium; kill 14 `magma_wraith`] | 300 XP, 30 tokens |
| c4_m3 | "Reactor Womb" (BOSS) | [boss `ash_titan`] → [deliver 100 lithium to `reactor_core`] | 400 XP, 50 tokens, flags `chapter4_done` (unlocks The Hive), `signal_decoded` |
| c4_s1 | "Core Sample" (side) | [scan `core_drill` ×2] → [survive 120 s, heatwave] | 150 XP, 15 tokens, item `plasma_cell` |
| c4_s2 | "Salvage Rights" (side, **flight**) | [kill 8 `scav_fighter`] during the outbound flight to Ferrum | 150 XP, 15 tokens |

Beat: ARIA decodes alien signal — the Hive knows Earth's location. The decoded text is a containment notice addressed to `instance/62` (flag `signal_decoded`).

### Chapter 5 — The Hive (asteroid gauntlet; space-heavy chapter)

| ID | Title | Stages | Rewards |
|---|---|---|---|
| c5_m1 | "Gauntlet" (**flight**) | [survive 180 s asteroid field; kill 10 `hive_interceptor`] during the outbound flight | 350 XP, 30 tokens |
| c5_m2 | "Lair" | [reach `queen_chamber`; kill 25 `hive_drone`] | 400 XP, 35 tokens |
| c5_m3 | "Her Majesty" (FINAL BOSS) | [boss `hive_queen` (2 phases)] | 600 XP, 100 tokens, flag `chapter5_done` (unlocks Eden-Prime) |
| c5_s1 | "Egg Hunt" (side) | [kill 15 `hive_egg`] | 200 XP, 20 tokens |

Landing at The Hive requires clearing the arrival wave, so `c5_m1` completes naturally on arrival (§13 E12).

Beat: the Queen speaks with the Warden's voice (`c5_m3_warden`); after her death ARIA confesses she is part of the system (`c5_m3_aria`).

### Chapter 6 — Eden-Prime (finale)

| ID | Title | Stages | Rewards |
|---|---|---|---|
| c6_m1 | "Paradise" | [scan `eden_spring`] → [scan `eden_forest`] → [scan `eden_ridge`] | 400 XP, 40 tokens |
| c6_m2 | "The Verdict" | [defend `survey_beacon` 240 s, waves `eden_final`] → [choice `ending`: stay → `ending_stay`, escape → `ending_escape`] | 800 XP, 150 tokens, flag `campaign_done` |

Beats: **stay** — the report is filed, Earth is saved, the loop closes ("a good run", `ending_stay`); **escape** — the beacon becomes an exit, the HUD strips away, and the screen degrades to a bare prompt (`ending_escape`). Free roam continues after either.

### Mission content policy (locked)

- Mission set above is locked as-is for the campaign.
- "Survive X seconds" objectives are reused deliberately: one cheap mechanic, many hazards (weather changes the feel).
- Extra tiers (hardmode variants, NG+, bounties) are pure data additions — deferred to post-M7 polish. Mission replay at 50 % is the only repeatable content in v1 and exists for anti-softlock reasons.

---

## 7. Token Economy Summary (corrected in R1)

| Source | Tokens |
|---|---|
| Main missions (17) | 670 (ch1 55 · ch2 70 · ch3 85 · ch4 105 · ch5 165 · ch6 190) |
| Side missions (9) | 104 |
| Level-ups (25 each) | ~400 main-path (≈ L17) · ~475 completionist (≈ L20) |
| **Total** | **~1,070 main-path · ~1,250 completionist** |

Total sink ≈ **2,010** tokens (ship 1,095 · gear 500 · companions 415), so a completionist affords ~62 % of everything and specialization is forced. XP curve: `xpToNext(L) = 100 + 50·L` (11,400 XP to reach L20), level cap 30.

Balance invariants (unit-tested, see [SPEC-010](https://github.com/mdzunic/reallm-specs/blob/main/specs/010-economy-and-progression.md)):

- Recommended loadout for chapter N costs ≤ tokens guaranteed by the end of chapter N−1 counting **main missions only** and **mission XP only** (worst case). Ferrum's shield-2 gate (140 tokens) is 39 % of that worst case (360).
- Base cargo cap (400) ≥ largest collect objective (300) + 100.
- Starting oil (60) ≥ Cinder-4 fuel (40) + 20; every chapter's boss mission funds the next jump.

---

## 8. Save Schema (versioned, migratable) — refined in R1

```ts
interface SaveV1 {
  version: 1;
  meta: { slot: 0|1|2; seed: number; createdAt: number; updatedAt: number; playtimeSec: number; difficulty: "casual"|"normal"; iteration: number /* 1 in v1; NG+ later */ };
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
- **Quality presets** (auto-detect by a 2-second boot benchmark, overridable): clamp `devicePixelRatio` (1 / 1.5 / 2), particles, draw distance, capped enemy count, and the render plan (R6): post-processing off / ¼-res bloom + FXAA / ½-res bloom + MSAA, shadow map on `high` only, image-based lighting on `medium` and `high`; target 60 fps desktop / 30+ fps mid-tier mobile.
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
| M7a | Art pass (R6): render pipeline (ACES, post chain, IBL, shadows), surface environment (height-field terrain, splat ground shader, procedural textures, scatter, props, weather sprites), animated character, sculpted enemies, combat VFX, flight sky and ships, hub backdrops, UI theme (SPEC-017…SPEC-020) | Cinder-4 and every other planet read as a modern stylised-PBR game on desktop and on the reference phone; medium stays ≤ 80 scene + 16 post draws on the surface; screenshots per scene and preset in the playtest log; tag `m7a` |
| M7 | Polish: mobile tuning, quality presets, balancing pass, PWA/offline, storage persistence, reduce-motion, save migration harness | 30+ fps on mid-tier phone; installable; full manual checklist green |

---

## 11. Testing & Verification

- `npm run typecheck` (tsc --noEmit), `npm run test` (Vitest), `npm run e2e` (Playwright, headless Chromium), `npm run build && npm run preview` each milestone.
- Unit tests target pure systems: economy math, save migration/corruption, combat formulas, mission runtime, seeded level generation determinism.
- **Content invariants** test: every id referenced by missions/planets/loot exists; requirement graph is acyclic; each planet layout contains every POI its missions need (with counts); kill targets exist in the planet spawn table; flight missions fit inside the flight duration.
- **Campaign simulation** test: drives the mission runtime and economy with a scripted main-path player and asserts every gate (flags, shield-2, fuel) is satisfiable with guaranteed rewards only.
- Manual playtest checklist per scene (desktop keyboard/mouse + mobile touch).

---

## 12. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Scope creep (biggest risk) | Data-driven content, hard milestone gates; M3/M4 are the proof-of-fun checkpoints |
| Mobile perf with Three.js | Pooling, instancing, quality presets from day one (M0); perf budgets in [SPEC-015](https://github.com/mdzunic/reallm-specs/blob/main/specs/015-mobile-performance-pwa.md) |
| Post-processing and PBR cost on phones (R6) | The pure quality plan of SPEC-017 gates everything: composer off on `low`, ¼-res bloom + FXAA on `medium`, shadow map on `high` only, no half-float → direct path; the cut order under a regression is grain → FXAA → bloom mips → post off, each one field |
| First-person feel without complex physics | Rail flight model only; cockpit HUD sells immersion |
| Asset consistency | Kenney CC0 families (Mini Characters, Space Kit, Nature Kit, Particle Pack) for humans, ships, modules, props and VFX sprites; ambientCG / Poly Haven CC0 for ground textures; enemies procedural (sculpted, PBR); one lighting/grade pipeline over everything so procedural and CC0 meshes read as one world (R6) |
| Save loss on iOS (7-day eviction, private mode, quota) | Export/import code, `.bak` slot, `persist()`, PWA install prompt, graceful "storage unavailable" mode |
| Fresh tooling (Vitest 5 is 3 days old; TS 7 just shipped) | Pin Vitest 5 with the 4.1 fallback documented; stay on TS 6.0 until M7 |
| Skeletal animation cost on mobile | Only the player + escort NPC are skinned; enemies use procedural transform animation |
| Meta twist undercuts the salvage fantasy or lands as a cliché | Surface fiction stays coherent on its own; the truth arrives in optional logs and ARIA's slips; no fourth-wall UI tricks outside the two endings |

---

## 13. Edge-case register (decisions)

Each entry names the owning spec. "Casual" = casual difficulty.

| # | Situation | Decision | Spec |
|---|---|---|---|
| E1 | Player can't afford fuel to any unlocked planet | On entering the station, `oil = max(oil, cheapest unlocked jump)`; ARIA line "Earth Command wired an emergency ration". Boss missions also grant a refuel voucher | SPEC-010 |
| E2 | Player spent all tokens and can't meet the shield-2 gate | Completed missions replayable at 50 % rewards; invariant guarantees worst-case tokens ≥ loadout | SPEC-010 |
| E3 | Cargo full during a collect objective | Base cap 400 ≥ any objective; pickups stop with a "CARGO FULL" toast; invariant tested | SPEC-010 |
| E4 | Death on the surface | Respawn at pad, full HP, 2 s invulnerability, −10 % carried resources (0 % casual), timed/escort/defend stages restart, enemies within 40 m of pad despawn, boss resets | SPEC-012 |
| E5 | Death in flight | Emergency recall to station; fuel lost; cargo kept; flight mission stage resets | SPEC-013 |
| E6 | Tab hidden / phone locked mid-combat | Loop pauses, audio suspends, accumulator reset on resume (no catch-up), best-effort save on `pagehide` | SPEC-002, SPEC-007 |
| E7 | WebGL context lost (iOS memory pressure) | Pause + overlay; on restore, renderer re-inits; if not restored in 5 s, offer reload (save is at last safe point) | SPEC-002 |
| E8 | localStorage unavailable/quota exceeded/corrupt | Boot in "no-save" mode with a warning; quota → drop `.bak` and retry once; corrupt → offer `.bak` or reset; export code always available | SPEC-007 |
| E9 | Save from a newer app version | Refuse to load; show version + export option | SPEC-007 |
| E10 | Stuck keys after alt-tab / focus loss | `blur` and `visibilitychange` release all actions; `pointercancel` releases touch | SPEC-005 |
| E11 | Multi-touch: joystick + fire simultaneously | Per-pointer ownership by `pointerId`; left zone = move, right zone = aim/fire | SPEC-005 |
| E12 | Flight kill objective not met at arrival | Landing blocked until the arrival wave is cleared ("can't land with hostiles on our tail"); waves spawn ≥ 2× required kills | SPEC-013 |
| E13 | Escort follower dies / defend POI destroyed | Stage restarts (follower respawns at `from`, POI HP refills) with a toast; no mission failure state | SPEC-012 |
| E14 | Kill objective but the enemy type doesn't spawn nearby | Spawn director triples the weight of objective enemies and guarantees one spawn per 20 s | SPEC-012 |
| E15 | Boss fight during a storm | Boss arena suppresses weather; forced mission weather ends when the boss stage starts | SPEC-012 |
| E16 | Deliver objective with insufficient held resources | POI shows "need N more"; player can leave and return; delivery consumes resources atomically | SPEC-012 |
| E17 | POI unreachable due to procedural obstacles | Layout keeps a clear corridor (8 m) from the pad to every POI and re-rolls the sub-seed if flood-fill fails | SPEC-012 |
| E18 | Player accepts several missions on one planet | All accepted missions for the planet are active in parallel; HUD tracks one pinned mission; counters are per mission | SPEC-012 |
| E19 | Reload mid-mission | Active missions persist with stage + counters; timed objectives restart from 0 | SPEC-007, SPEC-012 |
| E20 | Level-up during combat | Tokens/HP apply immediately; toast only (no modal) | SPEC-010 |
| E21 | Audio blocked until user gesture (iOS) | Boot shows "Tap to start"; the tap unlocks audio, requests wake lock, and (Android) fullscreen | SPEC-006 |
| E22 | Portrait phone | Rotate prompt in gameplay scenes; menus stay usable | SPEC-015 |
| E23 | 120 Hz displays / very slow frames | Fixed 60 Hz update, max 5 steps per frame, frame delta clamped to 250 ms | SPEC-002 |
| E24 | Both endings in one save | Impossible by design; `campaign_done` locks `c6_m2`; free roam continues | SPEC-009, SPEC-012 |
| E25 | Inventory full on gear drop | Gear stays on the ground 60 s with a toast; resources have their own cap | SPEC-011 |
| E26 | Story flag or item referenced but never defined | Content-invariant test fails CI | SPEC-009, SPEC-016 |

---

## 14. Spec index

See the roadmap [SPEC-000](https://github.com/mdzunic/reallm-specs/blob/main/specs/000-roadmap.md) in the reallm-specs repository (local checkout: `../reallm-specs/specs/000-roadmap.md`). Each spec is a factory work order `specs/NNN-slug.md` with `id: SPEC-NNN` in its frontmatter; the GitHub Issue that triggers its build carries the same id in its title. Old two-digit spec numbers map to SPEC-(NN+1); SPEC-000 is the roadmap. Build order follows `depends_on` (a topological sort listed in SPEC-000), not the milestone numbers, which remain the playable checkpoints.
