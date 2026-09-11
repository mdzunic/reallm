# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

"ReaLLM": a single-player, offline, desktop + mobile browser ARPG (Three.js, TypeScript, Vite) with a hidden simulation plot: the salvager slowly realizes he may be a model instance inside a machine (PLAN.md §1, §5). **The code starts at the SPEC-001 bootstrap** — toolchain, folder layout, the shell in `index.html`/`src/main.ts`, and the test harness; features begin with SPEC-002. The repository holds the design (`PLAN.md`); the implementation specs live in the sibling repository `../reallm-specs` (https://github.com/mdzunic/reallm-specs).

Read in this order before touching anything:

1. `PLAN.md` — the locked design and source of truth. §13 is the edge-case register (E1…E26); every entry names the spec that implements it.
2. `../reallm-specs/specs/000-roadmap.md` — the spec index (SPEC-000): queue, implementation order, and the spec-writing conventions. The specs are a **separate git repository** (github.com/mdzunic/reallm-specs); clone it next to this one so it sits at `../reallm-specs`. Commit spec changes there, code and PLAN changes here.
3. The spec(s) for the milestone you are working on. Specs contain the canonical TypeScript interfaces, algorithms, numbered edge cases, the exact unit tests to write, and acceptance criteria.

Rules for the docs themselves:

- Where PLAN and a spec disagree, PLAN wins. A design change needs a new entry in PLAN's refinement log (R2, R3, …) *before* the spec and code change.
- Names in a spec's Reference **Interfaces** section are canonical. Rename in the spec first, then in code.
- **Spec format (build-factory work orders).** Every spec is `specs/NNN-slug.md` in the specs repo with a flat frontmatter block (`id: SPEC-NNN`, `title`, `status`, `area`, `milestone`, `depends_on: [SPEC-…]`, `complexity: easy|normal|complex`, `story_points`), then `## Why`, `## Acceptance criteria` (one `- [ ]` per verifiable criterion), `## Out of scope`, `## Reference` (the detailed design). A new spec takes the next free number and is listed in SPEC-000; the GitHub Issue that triggers its build is titled `SPEC-NNN: <title>` and the factory (`~/git/claude-projects/dark_factory`, profile `reallm-game`) reads the file whose `id:` matches, else the Issue body. Cross-references are `SPEC-NNN §N`. Never put instructions for the factory inside a spec.
- Numbers marked *initial tuning* may be retuned without a log entry as long as the invariant tests (SPEC-009, SPEC-010, SPEC-016) stay green. Pinned constants in tests (XP table, token totals, layout hashes) are explicit literals; change them deliberately.
- When a spec is implemented and its acceptance list is green, set `status: done` in its frontmatter and in the SPEC-000 table.

## Commands

Defined in SPEC-001 (`../reallm-specs/specs/001-conventions-and-project-setup.md`); `package.json` is created in M0 with exactly these scripts.

```bash
npm run dev          # Vite dev server with --host (open on a phone over LAN)
npm run typecheck    # tsc --noEmit for src and tests
npm run test         # vitest run (all suites)
npm run test:watch
npm run e2e          # Playwright smoke + per-scene tests (headless Chromium; run npx playwright install chromium once)
npm run build        # typecheck + vite build
npm run preview
npm run check        # typecheck + test + build — must be green before any milestone tag
```

Single test file / single case:

```bash
npx vitest run tests/core/rng.test.ts
npx vitest run tests/systems/economy.test.ts -t "subsidy"
```

Dev URL flags (SPEC-001 §9): `?debug` (stats overlay + event log), `?scene=surface&planet=cinder4` (jump into a scene with a default save), `?seed=123`, `?quality=low`, `?perf` (scripted stress run).

Toolchain pins: Node ≥ 22.12, Vite 8 (Rolldown; config key is `oxc`, not `esbuild`; bundler options under `build.rolldownOptions`), TypeScript ~6.0 (not 7 yet), Vitest 5, Playwright (e2e only), three ^0.185, Howler 2.2. No React, no physics engine, no backend, no schema library; `vite-plugin-pwa` is the only planned addition (M7, build-time).

## Architecture (big picture)

- **One renderer, one loop, one active scene.** `core/Game.ts` owns the single `WebGLRenderer` and a fixed 60 Hz update loop (render every animation frame, delta clamped, max 5 steps/frame). `core/StateMachine.ts` swaps scenes (`boot → menu → creation/station ↔ starmap → flight → surface → station`); each scene is constructed on enter and disposed on exit, and owns a `Disposer` that releases every subscription, DOM listener, timer, and Three resource. Overlays (pause, dialogue, shop) are UI layers inside a scene, never scenes.
- **Pure systems vs. views.** Gameplay logic (`systems/`, `entities/`, `data/`, most of `core/`) never imports `three` and is unit-tested in node. Three.js appears only in `views/` (entity → mesh, read-only over entity state), `scenes/` (composition roots), and `core/Renderer.ts` / `Assets.ts` / `Benchmark.ts`. SPEC-001 §4 has the full import allow/deny table; an architecture test enforces it.
- **Gameplay is 2D.** Surface simulation runs on the XZ plane (`{x, z}` vectors, circle collisions, spatial hash); Y is visual only. Flight is a rail model: constant forward motion, the player steers on a bounded XY plane, hazards approach along depth. No 3D physics anywhere.
- **Typed event bus** (`core/Events.ts`, SPEC-004) decouples systems from UI/audio. Every event name and payload is in the `GameEvents` map; emitting an unknown event is a compile error. Subscriptions carry an owner and are released on scene dispose.
- **Data-driven content.** Planets, enemies, items, missions, waves, dialogue live in `src/data/*.ts` as `as const satisfies` tables; ids are `snake_case` string-literal unions derived from table keys, so cross-references are type-checked. Whatever the compiler cannot check (counts, reachability, requirement-graph cycles, balance) is covered by `tests/data/content.test.ts` and `tests/systems/balance.test.ts` (SPEC-009 §7, SPEC-010 §5).
- **Missions** are stage lists (sequential stages, any-order objectives inside a stage) run by `systems/Missions.ts`, which is shared by the surface and flight scenes and driven entirely by events. Counters persist in the save; timed objectives restart on death/reload.
- **Seeded RNG streams** (SPEC-008): planet layout is deterministic from `save.meta.seed + planetId`; runtime streams are re-seeded per visit. `Math.random` is banned outside `core/Rng.ts` (test-enforced).
- **Save** (SPEC-007): versioned `SaveV1` in `localStorage`, 3 slots plus `:bak`, hand-written validator, migration chain, export/import codes. Autosave happens only at safe points via `save.request(reason)` and is flushed after render, never inside `update()`.
- **Economy invariants** (SPEC-010) are the anti-softlock guarantees: station fuel floor, chapter refuel voucher, mission replay at 50 %, cargo cap ≥ any collect objective, and a worst-case token model that a campaign simulation test (`tests/campaign/`) proves end to end.

## Conventions that differ from defaults

- `erasableSyntaxOnly` is on: no `enum`, no parameter properties, no namespaces. `verbatimModuleSyntax` is on: use `import type`.
- Tests import `describe/it/expect` from `vitest` explicitly (no globals); every test that uses randomness constructs an `Rng` with a fixed seed.
- Hot-path rules (SPEC-001 §7): no allocations in `update()`, pooled entities with swap-remove, scratch vectors, no DOM reads in the loop, no `async` in `update()`.
- Units: meters, seconds, radians. Surface vectors are `{x, z}`, flight vectors `{x, y}`.
- Player-facing failures return typed results (`{ ok: false; reason }`) and surface as toasts; only programming errors throw.
- Assets are original and CC0: models, textures, sprites and portraits are generated by headless Blender from `scripts/assets/blender/` (PLAN R7, R8; `node scripts/assets/blender/build.mjs`), audio is synthesised by `scripts/assets/audio/` (`.webm` + `.mp3` pairs), and every file is listed in `public/assets/LICENSES.md` (`node scripts/assets/check.mjs` checks rows and budgets). Change art by editing a generator and rebuilding, never by hand-editing a GLB. Enemies are procedural meshes, not asset files.

## Milestones

M0 bootstrap → M1 core (state machine, events, save, RNG, audio) → M2 menus/creation/station shell → M3 surface scene on Cinder-4 → M4 flight → M5 economy/shop + campaign simulation → M6 all six planets and both endings → M7 mobile tuning, PWA, balancing. Definition of done per milestone (SPEC-001 §11): `npm run check` green, acceptance verified on desktop and one phone and recorded in `docs/playtest-log.md`, spec statuses updated, git tag `mN`. M0 starts from the current `main` (design docs only).
