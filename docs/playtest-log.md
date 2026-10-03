# Playtest log

Each milestone and each spec gets a section here (SPEC-016 §3): the devices it
was verified on, the build, the `?perf` rows, the checklist results, and the
bugs found. The device checklists to copy into a milestone's section and tick
are [desktop](checklists/desktop.md), [iOS](checklists/ios.md) and
[Android](checklists/android.md).

A milestone tag `mN` needs all of the following, recorded in that milestone's
section (SPEC-016 §6, SPEC-001 §11):

- `npm run check` and `npm run e2e` green on the tagged commit;
- the checklists copied and ticked for desktop and at least one phone;
- that phone's `?perf` rows;
- zero open P0 in [`docs/BUGS.md`](BUGS.md), and from M6 on zero open P1;
- the milestone's specs set to `done` in their frontmatter and in SPEC-000.

| Severity | Definition | Gate |
|---|---|---|
| P0 | Softlock, data loss, crash, save corruption, cannot progress | Blocks any milestone tag |
| P1 | Progression blocker with a workaround, budget breach (SPEC-015 §5), test failure | Blocks M6 and M7 tags |
| P2 | Polish, balance feel, visual glitch, a side-content detour | Logged, not blocking |

## M0 — bootstrap

- **Build:** `spec/SPEC-002` (SPEC-001 · SPEC-003 · SPEC-002) — untagged
- **Devices:**
  - desktop — headless Chromium 153 (Playwright, Linux container, software GL)
  - desktop, hardware GPU — _not run: no display in the build container_
  - phone, **emulated** — the same headless Chromium under Playwright's
    `Pixel 5` descriptor: 393×727 CSS px, `deviceScaleFactor` 2.75, touch input,
    `Android 11; Pixel 5` user agent. A device-shaped client, not a device: the
    GPU is still the container's software rasteriser.
  - phone, **physical over LAN** — _not run: no handset and no LAN in the build
    container_
- **Measurements** (headless Chromium, `?debug`, `menu`, 1280×720, preset
  `medium`, effective dpr 1.00 — software rasterisation, so treat the frame
  cost as a floor, not a device number):
  - fps 59.98 · ms/frame 16.67 · updates/frame 1–2 · draws 3 · tris 120 ·
    geo 3 · tex 4
  - `dropped 0.18s`, all of it in the first frames after the gate, where asset
    upload and the first scene transition share one frame: the 250 ms clamp
    absorbing a boot hitch is exactly the behaviour E23 asks for.
- **Measurements** (emulated phone, `?debug`, `menu`, 393×727, preset `medium`,
  device dpr 2.75 clamped to 1.50, drawing buffer 589×1090):
  - fps 60.02 · ms/frame 16.66 · updates/frame 1 · draws 3 · tris 120 ·
    geo 3 · tex 4 · `dropped 0.18s` (the same boot hitch)
  - rotated to landscape (727×393, buffer 1090×589) the numbers do not move:
    fps 59.99 · ms/frame 16.67 · updates/frame 1 · draws 3 · tris 120
  - `?quality=low` on the same client reads `dpr 1.00 of 2.75`, buffer 393×727
- **Checklist (SPEC-001):**
  - [x] `npm ci && npm run check` green on a clean clone — 12 files, 102 tests,
        typecheck and production build clean
  - [x] `npm run e2e` green headless — 52 tests across 12 suites
  - [x] `npm run dev` serves `ReaLLM` on 5173, canvas and `#ui` overlay present
        (`e2e/smoke.spec.ts`); **opening it on a phone over LAN is still open**
  - [x] architecture tests pass (import boundaries, `Math.random` ban)
- **Checklist (SPEC-002 §7):**
  1. [x] Desktop: the rotating object turns and the loop holds 60 fps
        (`e2e/boot-gate.spec.ts`, the numbers above); resizing and rotating the
        viewport keep the drawing buffer at CSS size × dpr within 1 px on both
        axes, so nothing stretches (`e2e/resize.spec.ts`)
  2. [x] Phone: renders, rotates, DPR clamp visible in the overlay — **run on
        the emulated handset above, not on hardware.** The overlay reads
        `dpr 1.50 of 2.75`, and that gap between the two numbers is the clamp:
        the buffer is 589×1090, not the 1080×1999 the device ratio would ask
        for. `?quality=low` moves it to `dpr 1.00 of 2.75`. The prop turns
        (`spin` 1.04 → 1.14 over ten frames). Rotating the device to landscape
        through a CDP device-metrics override carries the `size` row to
        `727x393` and the buffer to 1090×589 — CSS size × dpr within 1 px on
        both axes, so nothing stretches. The gate's wake-lock request was
        refused (`NotAllowedError`) and the boot continued past it, which is
        the ignore-the-rejection half of AC-23; on the Android user agent the
        fullscreen request was granted and the loop kept 60 fps through it.
        **Still owed on hardware:** whether a real GPU holds 60 fps at the
        clamped fill rate, and a real digitizer's touch.
  3. [x] Lock the phone for 30 s and unlock: no burst of updates — **run as a
        30 s hidden page on the emulated handset, not as a locked screen.**
        Hiding moved the overlay to `state hidden` and froze the frame counter
        at 73 for the whole 30 s; `app:resumed` came back at 31.61 s and each
        of the first twelve frames ran exactly 1 update (cap is 5), with
        `dropped` unchanged at `0.10s` across the hidden period — the 30 s was
        discarded, not replayed. Also covered headless in
        `e2e/lifecycle.spec.ts` and in node in `tests/core/loop.test.ts`
        (including the case where the hidden tab issues no animation frames at
        all). Audio is the null seam until SPEC-006, so there is nothing to
        hear resume yet. **Still owed on hardware:** a real lock, which on iOS
        also suspends the `AudioContext` and on Android can drop the WebGL
        context outright (E7).
  4. [x] Chrome: `Simulate context loss` shows the panel and the scene
        continues after the restore; the no-restore button surfaces `Reload`
        after 5 s (`e2e/context-loss.spec.ts`). The emulated phone exercised
        the same path by accident and confirmed it from the other side: a
        synthetic touch tap makes headless Chromium rebuild its compositing
        surface and drop the context (it happens with the Android user agent
        and with a desktop one, so it is the touch emulation and not the
        fullscreen request). The game took it correctly — `state context-lost`,
        the panel reading `Graphics context lost. Recovering…`, no frames
        burned behind it, and the `Reload` button offered once 5 s passed with
        no restore.
  5. [x] Asset spike: `character.glb` loads through `GLTFLoader`, is cloned with
        `SkeletonUtils.clone` and plays its `Idle` clip through an
        `AnimationMixer` advanced from `update(dt)`; `ship.glb` renders with its
        colour map reporting `srgb` (`e2e/asset-spike.spec.ts`)
  6. [x] `npm run check` and `npm run e2e` green
- **Bugs:** none open. Three found and fixed while building SPEC-002: the debug
  event log could print an entry out of order because `frame:order` is
  formatted a refresh after it is recorded (AC-32); the fixed-step accumulator
  ran one update where two were due because `1/60` has no exact binary
  representation (AC-2); and the canvas was compositing with the page although
  the renderer was created with `alpha: false`, because three r185 hardcodes
  `alpha: true` in the attributes it hands to `getContext()` — the context is
  now created in `core/Renderer.ts` and passed to three, and the live context
  reports `alpha false` (AC-11).
- **Notes:** items 2 and 3 are the manual §7 items that want a handset, and this
  build environment has none — no display, no attached device, and no LAN with a
  phone on it, so `npm run dev --host` has nothing to serve to. They were run
  instead against a phone-shaped emulation, and the rows above say so and give
  the numbers that run produced; every code path those items name (the DPR
  clamp, the rotation resize, the hidden-page discard) is genuinely exercised
  there. What emulation cannot produce is a real GPU's frame cost, a real screen
  lock, or a real touchscreen. **Before tagging `m0`, put the build on one
  handset over LAN, redo rows 2 and 3, and replace the physical-phone line under
  Devices.** The measurements to compare against are in this section.

## SPEC-017 — render pipeline and lighting foundation (M7a)

- **Build:** `spec/SPEC-017` (PLAN R6-1, R6-2) — untagged
- **Devices:**
  - desktop — headless Chromium (Playwright, Linux container, **software GL**)
  - desktop, hardware GPU — _not run: no display and no GPU in the build container_
  - phone, **emulated** — _not run: the numbers below are already a software-GL
    floor, and a phone-shaped client on the same rasteriser would only repeat
    it at a different resolution. The DPR clamp is covered by
    `e2e/resize.spec.ts` and the plan it feeds by `tests/core/postPlan.test.ts`._
  - phone, **physical over LAN** — _not run: no handset and no LAN in the build
    container_
- **`three` chunk after `npm run build`:**
  `cat dist/assets/three-*.js | gzip -c | wc -c` → **162 943 bytes** of the
  204 800 budget (SPEC-015 §5), one file (`dist/assets/three-DFGm-Klo.js`,
  652 828 bytes raw). That is ≈ +10 KB gzip for `EffectComposer`, `RenderPass`,
  `ShaderPass`, `UnrealBloomPass`, `OutputPass` and `FXAAPass`, with ≈ 41 KB
  still in hand. No new npm dependency.

### Draw calls and frame cost

`draws` now counts the **whole frame** — scene + post + overlay — because
`gl.info.autoReset` is off and the renderer resets the counter once per rendered
frame (§4.2.4). The scene share is `draws − 16` on a `fxaa` plan and `draws − 15`
on the `msaa` one, and is given beside the raw total. Measured on the menu,
creation, station, star map, flight (Cinder-4) and surface (Cinder-4, first
landing) at 1280 × 720, effective dpr 1.00, sampled after 40 rendered frames.

**`medium` — the preset SPEC-015 §5's budgets are written against:**

| Scene | draws (frame) | scene share | post | tris | ms/frame | budget (SPEC-017 AC-98) |
|---|---|---|---|---|---|---|
| menu | 20 | 4 | 16 | 6 136 | 77.5 | ≤ 30 + 16 ✔ |
| creation | 18 | 2 | 16 | 2 632 | 62.9 | — (portrait overlay included) |
| station | 20 | 4 | 16 | 4 560 | 81.2 | ≤ 30 + 16 ✔ |
| star map | 25 | 9 | 16 | 2 472 | 61.0 | — |
| flight | 23 | 7 | 16 | 18 200 | 124.6 | ≤ 40 + 16 ✔ |
| surface | 32 | 16 | 16 | 2 550 | 111.3 | ≤ 80 + 16 ✔ |

**`low` (direct path, no composer) and `high` (½-res bloom + MSAA 4×), for scale:**

| Scene | low: draws / ms | high: draws (scene + 15) / ms |
|---|---|---|
| menu | 4 / 16.9 | 19 (4) / 113.1 |
| creation | 2 / 16.7 | 17 (2) / 86.6 |
| station | 4 / 16.7 | 19 (4) / 117.1 |
| star map | 9 / 16.7 | 24 (9) / 89.7 |
| flight | 7 / 55.1 | 22 (7) / 140.6 |
| surface | 14 / 16.7 | 44 (29) / 150.7 |

The surface's scene share grows from 16 to 29 on `high`: that is the shadow
pass re-drawing every caster into the 1024² map, which is exactly what the
preset buys. `e2e/post-chain.spec.ts` pins the post share itself — on the menu
at `deviceScaleFactor: 1`, `draws(medium) − draws(low)` is 16 and
`draws(high) − draws(low)` is 15, in draws and in triangles.

### What the ms/frame column is, and is not

**It is a software-rasteriser floor, not a device number.** This container has no
GPU at all: Chromium falls back to SwiftShader, which rasterises the chain's
sixteen full-screen passes on the CPU. `low` holds 60 fps because it takes the
direct path; every preset that runs a composer costs 60–140 ms a frame here, and
a phone with any GPU at all is not in that régime — the whole point of the
¼-res bright pass and the DPR clamps is that the fill this measures is what a
GPU is for. Two consequences were recorded rather than papered over:

- The one number that *is* portable is the draw and triangle count, which is
  what the budgets above are written in.
- The e2e suite now names its preset per suite. Measured on this branch before
  that change, `npm run e2e` was 133 passed / 29 failed in 15.6 min against a
  baseline of 159 passed in 4.3 min, and not one of the 29 was a behaviour
  regression: at 60–140 ms a frame the fixed-step loop sits on its
  five-steps-per-frame ceiling, so the *simulation* runs slower than the wall
  clock and every suite that waits on an in-game timer waits several times
  longer. `e2e/start.ts` fills in `quality=low` — the direct path, exactly as
  cheap as the whole game was before this spec — when a URL names no preset;
  `post-chain`, `resize`, `context-loss`, `stats-overlay` and SPEC-011's spawn
  case each name the preset they mean. No assertion was weakened.
- One more number worth having on record: the **first rendered frame of a scene
  with image-based lighting blocks the main thread for ≈ 0.9 s on `low` and
  ≈ 1.5 s on `medium`** here, compiling the PMREM chain and an env-map variant
  of every material. It is one-time per program and a real GPU compiles the same
  set in tens of milliseconds, but it is why `e2e/SPEC-006.spec.ts` waits for
  the renderer's first frames before it measures an audio ramp.
- **Two suites now run in one worker**, `e2e/SPEC-006.spec.ts` and
  `e2e/SPEC-011.spec.ts`. Both measure wall-clock audio ramps beside the most
  expensive pages in the suite, and `fullyParallel` had five of them starving
  each other: SPEC-011's surface bed was caught sitting at a gain of 0.03–0.08
  twenty seconds into a fade that takes 1.5 s, while a probe page under the same
  load held the full 0.7 throughout. The same command is green on `main`, where
  no preset runs a composer and the file is a third cheaper — so this is the
  cost of the chain, not a regression in the audio layer. Serialising SPEC-011
  takes it from ≈ 2.6 min to ≈ 3.4–5.0 min depending on scheduling; no
  assertion in either file changed.
- **Owed on hardware before `m7a`:** every ms/frame figure above, on a desktop
  GPU and on one handset, plus the manual §7 pass (soft shadows following the
  player on `high`; the wraith core, projectiles and node crystals glowing on
  `medium`/`high` and clamping to white on `low`; the vignette; the creation
  preview reading tone-mapped like the rest).

### Screenshots

One per scene per preset, headless software GL at 1280 × 720, the dev overlay
removed for the shot:

| Scene | low | medium | high |
|---|---|---|---|
| menu | [low](screenshots/spec-017/menu-low.png) | [medium](screenshots/spec-017/menu-medium.png) | [high](screenshots/spec-017/menu-high.png) |
| creation | [low](screenshots/spec-017/creation-low.png) | [medium](screenshots/spec-017/creation-medium.png) | [high](screenshots/spec-017/creation-high.png) |
| station | [low](screenshots/spec-017/station-low.png) | [medium](screenshots/spec-017/station-medium.png) | [high](screenshots/spec-017/station-high.png) |
| star map | [low](screenshots/spec-017/starmap-low.png) | [medium](screenshots/spec-017/starmap-medium.png) | [high](screenshots/spec-017/starmap-high.png) |
| flight | [low](screenshots/spec-017/flight-low.png) | [medium](screenshots/spec-017/flight-medium.png) | [high](screenshots/spec-017/flight-high.png) |
| surface | [low](screenshots/spec-017/surface-low.png) | [medium](screenshots/spec-017/surface-medium.png) | [high](screenshots/spec-017/surface-high.png) |

- **Checklist:**
  - [x] `npm run check` green (typecheck, 42 vitest suites, production build)
  - [x] `npm run e2e` — every spec file green, run in batches rather than as one
        invocation: 163 tests, the 159 of the baseline plus the three of the new
        `e2e/post-chain.spec.ts` and the one added to `e2e/context-loss.spec.ts`
  - [x] `three` chunk inside the 200 KB budget (162 943 B)
  - [ ] hardware GPU and handset numbers — owed, see above
- **Bugs:** one found and fixed while building this: the dev stats overlay grows
  with its event log and, on a slow frame where the `frame:order` traces are
  long enough to wrap, reached the version label at the bottom of the screen and
  swallowed taps meant for it. The panel now takes no pointer events; only its
  two buttons do.

## SPEC-018 — surface environment: terrain, ground, props, weather (M7a)

- **Build:** `spec/SPEC-018` (PLAN R6-4) — untagged
- **Devices:**
  - desktop — headless Chromium (Playwright, Linux container, **software GL**;
    treat every ms/fps number as a floor, not a device number)
  - desktop, hardware GPU — _not run: no display and no GPU in the build container_
  - phone, **emulated** — headless Chromium under Playwright's `Pixel 5`
    descriptor (393×727 CSS px, dpr 2.75, touch, Android UA); a device-shaped
    client on the container's software rasteriser, not a device
  - phone, **physical over LAN** — _not run: no handset and no LAN in the build
    container_

### All six planets at `?quality=medium`, sampled after 90 rendered frames

`draws` counts the whole frame (scene + post 16); budget is SPEC-018 §4.11 /
AC: `draws ≤ 96`, `tris ≤ 120 000`. Desktop 1280×720; the two runs shared the
container two workers at a time, so ms/frame is worst-case software GL.

| Planet | draws (frame) | tris | geo | tex | budget ✔ | screenshot |
|---|---|---|---|---|---|---|
| cinder4 | 41 | 76 670 | 37 | 35 | ✔ | [medium](screenshots/spec-018/cinder4-medium.png) |
| vetra | 46 | 27 898 | 42 | 35 | ✔ | [medium](screenshots/spec-018/vetra-medium.png) |
| thessaly | 45 | 72 760 | 41 | 36 | ✔ | [medium](screenshots/spec-018/thessaly-medium.png) |
| ferrum | 42 | 38 416 | 38 | 35 | ✔ | [medium](screenshots/spec-018/ferrum-medium.png) |
| hive | 49 | 65 928 | 45 | 35 | ✔ | [medium](screenshots/spec-018/hive-medium.png) |
| eden | 35 | 33 294 | 31 | 36 | ✔ | [medium](screenshots/spec-018/eden-medium.png) |

Emulated phone (`Pixel 5` descriptor, same medium preset): cinder4 40 / 74 870,
vetra 43 / 22 498, thessaly 43 / 69 160, ferrum 40 / 34 816, hive 46 / 60 528,
eden 31 / 29 374 — every planet inside the same budget. `e2e/surface-env.spec.ts`
pins the cinder4 row (draws ≤ 96, tris ≤ 120 000 after 30 frames) on every run.

### Observations

- Cinder-4 shows the two-layer splat clearly: rippled sand blending into
  cracked earth on the slopes, normal-mapped at the §4.4 six-samples cost.
- Ferrum's basalt carries the emissive crack veins (`texB.a` path) and the
  30 % slag embers read as hot spots; the crack pulse animates with `uTime`.
- Vetra initially blew out to a white field — the luminance-normalised macro
  tint pushed the near-white palette past 1. The tint is now capped at
  channel ≤ 1 and the snow layer's albedo darkened (*initial tuning*); the
  §4.1 sun/hemisphere values are unchanged. It now reads as a foggy snowfield;
  worth another tuning pass when a hardware GPU run is possible.
- The berm and silhouette ring hide the clear colour at the arena edge on the
  screenshots taken near the pad; the full walk-to-`halfSize − 2` sweep at
  16:9 and 21:9 on all six planets (AC "manual") still needs a human pass on a
  real display, as does the phone-over-LAN visit.

### Checklist

- [x] `npm run check` green (typecheck, 819 unit tests, production build)
- [x] `e2e/SPEC-012.spec.ts`, `e2e/SPEC-017.spec.ts`, `e2e/SPEC-011.spec.ts`,
      `e2e/dev-skip-flight.spec.ts`, `e2e/scene-cycle.spec.ts`,
      `e2e/surface-env.spec.ts` green (two runs; one parallel-load flake each
      in SPEC-017/SPEC-011 passed clean when re-run — same class as the
      flaky set already tracked by the factory)
- [x] `layoutHash` pins unchanged (`tests/systems/layout.test.ts`)
- [x] every planet visited **on hardware** (desktop GPU + reference phone) —
      **waived**: human resolution 2026-09-12 dropped this criterion (AC-75)
      and directed the merge; the container has neither device, and the
      emulated-phone rows above stand in for the record

## SPEC-019 — characters, enemies and combat VFX (M7a)

- **Build:** `spec/SPEC-019` — untagged
- **Devices:**
  - desktop — headless Chromium (Playwright, Linux container, **software GL**;
    every ms/fps number is a floor, not a device number)
  - desktop hardware GPU and phone-over-LAN — _not run: no display, no GPU and
    no handset in the build container; needs the human pass_

### All six planets at `?quality=medium`, sampled after 120 rendered frames

Same instrument as the SPEC-018 rows (desktop 1280×720, whole-frame `draws`
including the 16 post calls). The rows now carry the animated salvager, the
sculpted enemies with per-instance emissive, capsule projectiles with ghosts,
and the CombatFx pool. Budget: `draws ≤ 96`, `tris ≤ 130 000` (AC-96); the
capture waited for live enemies where the planet spawns any (`enemies` is the
debug row at capture time — Eden's ambient population is 0 by design).

| Planet | draws (frame) | tris | geo | tex | enemies | budget ✔ | screenshot |
|---|---|---|---|---|---|---|---|
| cinder4 | 42 | 82 872 | 37 | 38 | 9 | ✔ | [medium](screenshots/spec-019/cinder4-medium.png) |
| vetra | 46 | 34 310 | 41 | 38 | 10 | ✔ | [medium](screenshots/spec-019/vetra-medium.png) |
| thessaly | 46 | 79 416 | 41 | 39 | 11 | ✔ | [medium](screenshots/spec-019/thessaly-medium.png) |
| ferrum | 44 | 44 298 | 39 | 38 | 11 | ✔ | [medium](screenshots/spec-019/ferrum-medium.png) |
| hive | 50 | 72 806 | 45 | 38 | 14 | ✔ | [medium](screenshots/spec-019/hive-medium.png) |
| eden | 35 | 38 402 | 29 | 37 | 0 | ✔ | [medium](screenshots/spec-019/eden-medium.png) |

### Observations

- The salvager model replaces the blue capsule on every planet; the secondary
  swatch reads as the visor/lamp glow at `emissiveIntensity 2` (`tintSalvager`,
  shared with the creation preview). The torch and blob shadow are unchanged.
- Enemy counts sit at the SPEC-012 §4.5 population target
  (`round(population · maxEnemies / 32)`) — 9 on Cinder-4 at medium, 14 on
  Hive. The AC-96 e2e case polls to that ceiling; the 32-enemy worst case is
  pinned in node against `RECIPE_TRIANGLE_CAP` (AC-98).
- Cinder-4 gained ≈ 6 k triangles over the SPEC-018 row — the sculpted
  recipes, the character and the projectile/VFX pools together — and stayed
  ≈ 37 k under the ceiling on the heaviest planet.
- Software GL renders at 4 fps in the container, so hit-stop, shake feel and
  the muzzle pulse need the human pass on hardware, as does the
  reduce-motion sweep of §7's manual list.

### Checklist

- [x] `npm run check` green (typecheck, 868 unit tests, production build)
- [x] `e2e/surface-env.spec.ts` (both budget cases + the new spawn-heavy
      case), `e2e/SPEC-012.spec.ts` (death sweep), `e2e/boot-assets.spec.ts`
      (boot stays five files), `e2e/asset-spike.spec.ts`, `e2e/SPEC-014.spec.ts`,
      `e2e/SPEC-011.spec.ts` (one parallel-load flake, clean on re-run — the
      tracked class), `e2e/SPEC-018.spec.ts`, `e2e/scene-cycle.spec.ts`,
      `e2e/dev-skip-flight.spec.ts` green
- [ ] distinct animations, VFX feel and reduce-motion verified **on hardware**
      (desktop GPU + reference phone) — needs the human pass

## SPEC-020 — flight, station, menus and UI theme (M7a)

- **Build:** `spec/SPEC-020` — untagged
- **Devices:**
  - desktop — headless Chromium (Playwright, Linux container, **software GL**;
    every ms/fps number is a floor, not a device number)
  - desktop hardware GPU and phone-over-LAN — _not run: no display, no GPU and
    no handset in the build container; needs the human pass_

### AC-31 — every scene at every preset

Desktop 1280×720, captured after 40 rendered frames on the menu, creation
screen, station and star map, and after 30 on a flight whose asteroid field was
topped to the preset's cap (`window.__reallmFlight.fillAsteroids()`) with a
parked fighter in frame.

| Scene | low | medium | high |
|---|---|---|---|
| menu | [png](screenshots/spec-020/menu-low.png) | [png](screenshots/spec-020/menu-medium.png) | [png](screenshots/spec-020/menu-high.png) |
| creation | [png](screenshots/spec-020/creation-low.png) | [png](screenshots/spec-020/creation-medium.png) | [png](screenshots/spec-020/creation-high.png) |
| station | [png](screenshots/spec-020/station-low.png) | [png](screenshots/spec-020/station-medium.png) | [png](screenshots/spec-020/station-high.png) |
| star map | [png](screenshots/spec-020/starmap-low.png) | [png](screenshots/spec-020/starmap-medium.png) | [png](screenshots/spec-020/starmap-high.png) |
| flight | [png](screenshots/spec-020/flight-low.png) | [png](screenshots/spec-020/flight-medium.png) | [png](screenshots/spec-020/flight-high.png) |

Two more, for the criteria a full-screen capture does not settle: the
[character panel](screenshots/spec-020/station-character.png) with the chosen
bust beside the name line (AC-28 — the panel had no portrait before this spec),
and the [engine glow](screenshots/spec-020/flight-engine-glow.png) close-up
below.

### AC-15 — the flight frame with the field full

Whole-frame `draws` (scene + post) and `tris` at the moment of capture. The
budget is 40 scene + 16 post = 56 draws and 80 000 triangles on `medium`.

| Preset | draws (frame) | tris | geo | tex | hazards | budget ✔ |
|---|---|---|---|---|---|---|
| low | 11 | 32 098 | 22 | 43 | 41 | ✔ (post off; cap 40) |
| medium | 32 | 38 524 | 32 | 63 | 61 | ✔ |
| high | 31 | 38 523 | 32 | 63 | 61 | ✔ |

`e2e/flight-env.spec.ts` asserts the same thing on `medium` on every run. Its
other two cases cover the criteria the last two QA rounds could not reach by
hand: one aborts every flight model and map and watches the trip fly on its
SPEC-013 primitives with a full field and no page error (AC-9, 20-h), and one
warps Ferrum out to its first ion-storm window and watches the sky window's
`skyTint` climb past half (AC-14, 20-g).

### AC-10 — the engine glow is visible, and it is the glow

The round-3 defect was not the quad's position but that nobody could see it:
hazards fly nose-on (SPEC-013 §4.3), so a ship's exhaust is always inside its
own hull's depth shadow and a depth-tested 0.6 m quad at the nozzle plane
rasterises nothing at any bearing the rail allows. The material now leaves
`depthTest` off — it is additive and writes no depth, so it tints the hull it
crosses rather than hiding it, and reads as exhaust spilling around a ship
coming at you.

Measured rather than eyeballed: with a fighter parked at ~15 m on `low` (no
bloom, so nothing else is blue), 151 pixels of the frame are cyan-dominant
(blue − red > 40, blue > 90), peaking at `rgb(70, 132, 218)` at the ship's
centre — the `#9fe3ff` quad, and nothing else in the scene is that colour.
[Screenshot](screenshots/spec-020/flight-engine-glow.png).

### Observations

- The hub backdrops are one `Group` each, lit by the key + rim pair over
  SPEC-017's neutral environment. `props` reads 3 / 1 / 1 on station / menu /
  creation exactly as `e2e/stats-overlay.spec.ts` pins it; the sky window and
  the lights are the backdrop's furniture, not props.
- `station_ring.glb` and `dock.glb` load **lazily** with the station rather
  than at boot. SPEC-020 §4.8 would have put them in `ASSETS.models`, but PLAN
  R6-5 keeps the boot manifest at five files and `tests/data/content.test.ts`
  pins it — PLAN wins. The hubs show their procedural modules until the GLBs
  land, and for good if they never do (20-e).
- The ring's lit modules blow out under `medium`'s bloom (`STATION_LOOK`
  `bloomStrength 0.3` plus the baked `Glow` at emission strength 2). It reads
  correctly on `low`. Left as initial tuning: the bloom number is SPEC-017's
  and the emission is the art's, and neither is this spec's to retune. Worth a
  look on the hardware pass.
- The star map's six orbits are staggered 2.0 … 4.0 world units instead of the
  one shared 3.1 circle, so the per-planet orbit ring AC-20 asks for is
  legible rather than six coincident circles. The outermost stays well inside
  the overhead camera's 4.62-unit half-height and SPEC-014's node-placement
  case is green.
- Portraits: the twelve busts ship, so the creation screen and the character
  panel show images; deleting `assets/portraits/manifest.json` (or any of the
  files) puts the glyphs back, per portrait rather than per manifest.
- The theme's `backdrop-filter` is dropped under `prefers-reduced-transparency`
  and on `low`, through a `quality-low` class `core/Renderer` keeps on `<html>`
  — the same DOM contract `reduce-motion` uses.
- Software GL renders at 6–15 fps in this container, so the lens flare's
  occlusion behaviour, the bloom on the shot ghosts and the glass panels on a
  phone all still need the human pass.

### Checklist

- [x] `npm run check` green (typecheck, 895 unit tests, production build)
- [x] `e2e/flight-env.spec.ts` (new), `e2e/SPEC-014.spec.ts`,
      `e2e/stats-overlay.spec.ts`, `e2e/asset-spike.spec.ts`,
      `e2e/boot-assets.spec.ts`, `e2e/scene-cycle.spec.ts`,
      `e2e/post-chain.spec.ts`, `e2e/SPEC-013.spec.ts` green
- [ ] the theme, the glass panels and the flight fx verified **on hardware**
      (desktop GPU + reference phone) — needs the human pass

## SPEC-024 — the ending sequence (M7b)

- **Build:** `spec/SPEC-024` — untagged
- **Devices:**
  - desktop — headless Chromium (Playwright, Linux container, **software GL**)
  - desktop hardware GPU and phone-over-LAN — _not run: no display, no GPU and
    no handset in the build container; needs the human pass_

### What was walked, and how

The campaign was finished **both ways from one prepared save** — chapter 5
done, `c6_m1` behind it, `c6_m2` standing on its defend stage on Eden — with
the four-minute defence finished through the new dev control
(`surface-finish-stage`, §4.8). `e2e/SPEC-024.spec.ts` is that run, written
down: seven cases over the six of §6.

| Case | What it walks |
|---|---|
| 1 | `c6_choice_intro` reads in full — all three lines, in order, before `dialogue-choice-0` exists |
| 2 | Stay: the modal `ending_stay`, the `ending_stay` film, the five-line filed report, Continue → free roam on Eden with the HUD, the input and the hold released |
| 5 | The board after a stay: `mission-c6_m2` reads `done` with no Replay; `c6_m1` still offers one (E24) |
| 3 | Escape: the `ending_escape` film, the veil with `instance/62 disconnected`, the HUD stripped, the menu — and Continue back into the station |
| 4 | Tab killed inside the sequence: `campaign_done` + `ending_escape` + `endingSeen: false` in the slot, then Continue → the film and the veil replay **before** the interlude the same entry owed, and the ending dialogue does not replay (E29, 24-a) |
| 6 | `?films=off`: dialogue → overlay, no film node anywhere (24-b) |
| 7 | `?films=off` on the replay path: no film, and the report card still runs and still writes `endingSeen` |

Input was checked where §4.7 puts it: a key held during the modal ending
dialogue moves nothing, and the same key walks the salvager again after
Continue.

### Observations

- The ending's hold exposed a real defect in SPEC-023's beat hold: the "a hold
  with nothing to run releases itself" valve in `#updateReveal` fired on the
  ending's hold on the very next step, because the ending has no per-step beat
  behind it — Eden's last wave went on moving under the ending dialogue. The
  valve now only releases a hold with neither a reveal nor an ending behind it,
  and case 2 pins `held` at 1 from the choice to the Continue.
- `import.meta.env.DEV` does strip the control: `surface-finish-stage` does not
  appear anywhere in `dist/assets/index-*.js` after `vite build`.
- Both ending films run in stills mode here (the suite aborts the MP4s, as
  SPEC-023's does) — the pictures are SPEC-021/022's business, and this suite
  is about which beat runs, in what order, and what it leaves in the save.

### Checklist

- [x] `npm run check` green (typecheck, 956 unit tests, production build)
- [x] `e2e/SPEC-024.spec.ts` (new) green
- [x] `e2e/SPEC-023.spec.ts` and `e2e/SPEC-012-missions.spec.ts` green — the
      beat hold and the mission runtime this spec reaches into
- [ ] both endings verified **on hardware** (desktop GPU + reference phone),
      including the tab-close recovery on a real handset — needs the human pass

## SPEC-025 — save v2: weapon slots, quick slots, explored ground (M7c)

- **Build:** `spec/SPEC-025` — untagged
- **Devices:**
  - desktop — headless Chromium (Playwright, Linux container, **software GL**)
  - desktop hardware GPU and phone-over-LAN — _not run: no display, no GPU and
    no handset in the build container; needs the human pass_

### What was walked, and how

The spec's §7 manual pass is "load an existing v1 slot from before R10 and find
the character, the missions and the resources intact". The half of it a
container can do is `e2e/SPEC-025.spec.ts`, which writes the v1 fixture's own
JSON into a real `localStorage` and loads slot 0 through the Load menu — not
through the store's API — so the path under test is the one a returning player
actually takes.

| Case | What it walks |
|---|---|
| 1 | A fresh save at the station: the character panel's four gear cards read `Service Pistol`, `Kinetic Repeater`, `Empty`, `Scrap Plate`, and the shop badges all four worn pieces as `equipped` (§4.8) |
| 2 | A v1 slot loaded through the menu: `version === 2`, the plasma lance in `primary`, the pistol in `sidearm`, `activeWeapon: 'primary'`, the heal and utility quick slots filled from the pack, `explored: {}` — and the name, missions and resources unchanged |

### Observations

- Nothing that plays moved. `tests/systems/balance.test.ts` and the worst-case
  campaign simulation are untouched apart from the `equipped` object's shape:
  the run still buys the same ladder for the same tokens and still lands on
  level 13 with 5,480 XP.
- The pistol is deliberately the weaker weapon in every dimension (27 dps to the
  kinetic repeater's 36, 12 m to 14 m), so a save that lands with it in hand is
  never better off than one that does not. Nothing equips it as the active
  weapon: `activeWeapon` is `'primary'` on both a fresh save and a migrated one,
  and switching is SPEC-028's.
- The explored bitset costs 1,351 characters per 180 m planet and nothing at all
  until SPEC-026 writes one: a fresh save and a migrated save both carry
  `explored: {}`. Six full planets would be ≈ 9 KB of a 100 KB budget.
- The launcher line has no items until SPEC-029, so the two rules that only a
  heavy weapon can exercise — equipping into an empty slot with no swap, and a
  line whose lowest rung is for sale owing nothing — are proved in
  `tests/systems/economy.test.ts` against stand-in items installed in the item
  table for the length of one test and removed in a `finally`.

### Checklist

- [x] `npm run check` green (typecheck, 981 unit tests, production build)
- [x] `e2e/SPEC-025.spec.ts` (new) green
- [x] `e2e/SPEC-007.spec.ts` and `e2e/SPEC-010.spec.ts` green — the save
      pipeline and the economy, both re-pinned to the version-2 shape
- [x] `e2e/SPEC-014.spec.ts` and `e2e/SPEC-020.spec.ts` green — the character
      panel and shop this spec re-renders
- [ ] a real pre-R10 v1 slot loaded **on hardware** (desktop GPU + reference
      phone), with the surface played after it — needs the human pass

## SPEC-026 — surface map: legend, explored ground and the full-screen map (M7c)

- **Build:** `spec/SPEC-026` — untagged
- **Devices:**
  - desktop — headless Chromium (Playwright, Linux container, **software GL**)
  - desktop hardware GPU and phone-over-LAN — _not run: no display, no GPU and
    no handset in the build container; needs the human pass_

### What was walked, and how

The §7 pass is "walk up the screen and the arrow goes straight up; tell the pad,
the dune sea, the beacon, the nest and a landmark apart without the legend; walk
ground and find it still lit after a round trip; open and close the map with the
key and with taps while a swarm stands still". The half of it a container can do
is `e2e/SPEC-026.spec.ts` plus the shots below.

| Case | What it walks |
|---|---|
| 1 | Landing: the minimap's backing store is `round(css × min(dpr, 2))` of a round `clamp(128px, 24vmin, 184px)` box, `mmExplored > 0` and `mmTerrainBuilds === 1` |
| 2 | `M` opens the map, `mapOpen` reads 1, a full second of `KeyD` moves `px`/`pz` by nothing, the legend names the landing pad, and `Escape` closes the map without opening the pause menu |
| 3 | A minimap click opens it; `map-close`, `M` and a tap outside all close it; `map-zoom` and `Equal` toggle fit ↔ 2× |
| 4 | Travel lights ground; a real page reload through the Load menu and a station round trip both land on the ground the last visit lit |
| 5 | Two missions accepted at one terminal: `KeyT` cycles the HUD's title and `map-track-<id>` pins from the map |

### Shots

| | |
|---|---|
| minimap, 70 m, fog and rim arrow | [minimap](screenshots/spec-026/minimap.png) |
| full map, fit | [map-fit](screenshots/spec-026/map-fit.png) |
| full map, 2× around the player | [map-2x](screenshots/spec-026/map-2x.png) |

### Observations

- The arena draws as a diamond, which is what its walls look like on screen at
  the fixed 45° yaw — the reason the whole change exists. Walking `W` moves the
  arrow straight up both maps.
- The two cached layers are 360 × 360 px on Cinder-4 (1.04 MB together), built
  once per visit; a reveal repaints ≤ 113 four-pixel squares and a repaint is
  two `drawImage` calls. `surface-env.spec.ts` is unchanged and still green —
  no WebGL draw call was added.
- A 24 m reveal lights ≈ 1.4 % of a 180 m arena, so `mmExplored` reads about 1.4
  on landing and climbs a point or so per teleport.
- The full map's 2× stays centred on the player: clamping the view hard enough
  to hide the ground outside the arena pins it to the arena centre at every
  canvas a phone can show, which would put the player off the canvas.
- The touch layer dropped from z-index 10 to 9. It is a full-screen aim surface
  that mounts after the HUD, so at equal z it swallowed the tap that is now
  supposed to open the map; the minimap is the only interactive thing in the HUD
  layer, so no touch button can be covered by the swap.

### Checklist

- [x] `npm run check` green (typecheck, 997 unit tests, production build)
- [x] `e2e/SPEC-026.spec.ts` (new) green
- [x] `e2e/SPEC-012.spec.ts` and `e2e/SPEC-012-missions.spec.ts` green — the
      backing check and the pin helper this spec re-pins
- [x] `e2e/surface-env.spec.ts` green, unchanged — ≤ 80 scene + 16 post draws
- [x] `e2e/touch-controls.spec.ts` and `e2e/SPEC-012-touch.spec.ts` green — the
      layer whose z-index moved
- [ ] the arrow, the legend, the lit ground and the held map verified **on
      hardware** (desktop GPU + reference phone) — needs the human pass

## SPEC-027 — mission guidance: tracker, waypoints and hints (M7c)

- **Build:** `spec/SPEC-027` — untagged
- **Devices:**
  - desktop — headless Chromium (Playwright, Linux container, **software GL**)
  - desktop hardware GPU and phone-over-LAN — _not run: no display, no GPU and
    no handset in the build container; needs the human pass_

### What was walked, and how

The §7 pass is a person who has never seen the game playing `c1_m1` to `c1_m3`
on the tracker, the marker and the hints alone, and writing down where they
hesitated. That is a human activity (D-30) and no acceptance criterion depends
on it. What a container can walk is `e2e/SPEC-027.spec.ts` plus the shots below.

| Case | What it walks |
|---|---|
| 1 | Landing with nothing accepted reads `No active mission`; after `c1_m1` the panel names the mission, its stage and the metres, and the HUD holds exactly one `.hud-objective` |
| 2 | On the pad, the row reads `Scan Dune Sea` and the waypoint is `data-state="edge"` — the site is 61 m away on seed 123 |
| 3 | `surface-stuck` crosses 45 s and 90 s: the hint reads "Dune Sea is 61 m south-west…", the tracker carries `is-stuck`, and one more crossing reaches level 3, where the path search runs on the real layout |
| 4 | `surface-goto-objective` puts the player in the ring: `scan-progress` fills and the header reaches `stage 3/3` |
| 5 | `settings-guidance-off` hides the waypoint and keeps the tracker |
| 6 | The `move` tip shows on the first landing, `reallm:settings.tipsSeen` holds `move`, and a real reload does not show it again |
| — | A tap on the tracker cycles the tracked mission (two missions accepted at one terminal), and its hit box clears 44 px |
| — | `c1_s2`'s kill stage puts a rim arrow on the minimap for its quarry (`mmArrows` ≥ 1), and `guidance: off` takes it away |

### Shots

| | |
|---|---|
| tracker, edge arrow and the first tip | [tracker-waypoint](screenshots/spec-027/tracker-waypoint.png) |
| the level-3 hint, ground route and dashed map route | [stuck-route](screenshots/spec-027/stuck-route.png) |
| the scan ring filling inside the light pillar | [scan-ring](screenshots/spec-027/scan-ring.png) |

### Measurements

Headless Chromium, `?debug&scene=surface&planet=cinder4&seed=123&quality=medium`,
1280×720, dpr 1.00 — software rasterisation, so the frame cost is a floor and
not a device number (fps 6.2 / 160 ms on this container at `medium`; the suites
run at `low` for exactly that reason, e2e/start.ts).

| Frame | draws | triangles |
|---|---|---|
| `guidance: off` (no pillar, no route) | 42 | 82 874 |
| `guidance: full`, POI target (pillar up) | 43 | 84 068 |
| level 3, route on the ground | 43 | 84 112 |

The population is live between readings, so the triangle column moves with the
enemies on screen; what the numbers pin is the ceiling — the guidance layer adds
one draw call for the pillar and one for the 48-instance marker mesh, and the
surface sits at 43 of the 96 (80 scene + 16 post) the budget allows.
`e2e/surface-env.spec.ts` is unchanged and green.

### Observations

- The bearing words come out of the map's own north, so the hint on seed 123
  reads "61 m south-west" for a dune sea that is south-west **on screen**. A
  world-axis bearing would have said something else, and the two content strings
  that used to name a fixed compass direction are gone (§4.10).
- The waypoint's root was a zero-size anchor at first. Nothing rendered wrong,
  but a 0×0 box is invisible to a browser's hit testing and to Playwright, so it
  is a 22 px box centred by a negative margin now — `transform` still does all
  the moving.
- `guideTarget` in the `?debug` row writes the label's spaces as underscores:
  that row is `key=value` pairs split on whitespace and `surface-env.spec.ts`
  pins the shape.
- The scan ring at 52 px with a 12 % track was there but invisible on bright
  sand; 60 px with a lit track and a drop shadow reads as a ring.
- The collect node marks now follow the **tracked** mission rather than any
  active one (AC-38 ties them to the tracker). On Cinder-4 the two read the same
  whenever one mission is running, which is every case the suites walk.
- A kill objective's quarry was first carried as an objective **mark**, on the
  theory that the painter would turn it into an edge arrow when it fell outside
  the window. It never can: AC-39's 60 m is inside the minimap's 70 m, so every
  one of them drew as a ringed icon and `mmArrows` sat at 0 through a whole kill
  stage. The quarry now rides its own list and is pinned to the rim at its
  bearing whatever its distance — a direction to sweep rather than a pin on an
  enemy that is moving anyway, and the enemy layer still draws it where it
  stands once inside 25 m. The full map has no rim to point from and ignores it.

### Checklist

- [x] `npm run check` green (typecheck, 1050 unit tests, production build)
- [x] `e2e/SPEC-027.spec.ts` (new) green — eight cases
- [x] `e2e/SPEC-012.spec.ts`, `e2e/SPEC-012-missions.spec.ts` and
      `e2e/SPEC-012-touch.spec.ts` green — the objective line the tracker took
      over and the whole five-mission run
- [x] `e2e/SPEC-026.spec.ts` green — the map marks, the pin and `KeyT`
- [x] `e2e/surface-env.spec.ts` green — the draw budget and the `?debug` row
- [x] `e2e/SPEC-011.spec.ts`, `e2e/SPEC-013.spec.ts`, `e2e/SPEC-014.spec.ts`,
      `e2e/SPEC-019.spec.ts`, `e2e/SPEC-023.spec.ts`, `e2e/SPEC-024.spec.ts`,
      `e2e/scene-cycle.spec.ts`, `e2e/pause.spec.ts`, `e2e/stats-overlay.spec.ts`,
      `e2e/smoke.spec.ts`, `e2e/teardown.spec.ts` green
- [ ] a first-time player walked `c1_m1`…`c1_m3` on the guidance alone, on
      hardware (desktop GPU + reference phone) — needs the human pass (§7, D-30)

## SPEC-030 — shelters and the arena wall (M7c)

- **Build:** `spec/SPEC-030` — untagged
- **Devices:**
  - desktop — headless Chromium (Playwright, Linux container, **software GL**)
  - desktop hardware GPU and phone-over-LAN — _not run: no display, no GPU and
    no handset in the build container; needs the human pass_

### What was walked, and how (D-1)

The scripted headless sweep, per planet on
`?debug&scene=surface&planet=<id>&seed=123&quality=medium`: 30 rendered frames
for the budget row, `surface-goto-edge` to the wall, `surface-goto-shelter`
into the nearest shelter, and on Cinder-4 `surface-smite` then `surface-storm`
through a forced heatwave. `e2e/SPEC-030.spec.ts` re-walks the same cases as
assertions; `e2e/surface-env.spec.ts` holds the six-planet budget sweep.

| Case | What was seen |
|---|---|
| Six-planet edge walk | The player stops on the clamp line (`px` pins at `halfSize − 2`) with wall pieces and hull sections where they stop; `wallVisible` reads 1–3 chunks at the edge, never all 8 |
| Cave entry (Cinder-4) | `sheltered` reads 1, the chip shows, the roof instance lifts so the salvager stays visible under the 55° camera |
| Wreck entry (Cinder-4, seed 9; also walked on Vetra) | Same chip; the roof part now carries the whole dome, the ribs and the plates, so the lift leaves only the low far-side band (~1.9 m, with an inner liner) and the salvager stays visible from the fixed camera whatever way the breach faces — the QA round had caught the old split occluding him |
| Forced storm inside | `surface-storm` raises the heatwave; over a 3 s hold inside the cave HP does not move; walking back to the pad it falls within 4 s |
| Hiding | Two seconds after the last shot the chip flips to `⌂ HIDDEN`; an aggroed pack with no line gives up within 3 s (pinned in `tests/systems/enemyAi.test.ts`) |

### Measurements — medium, after 30 frames

Budget: ≤ 96 draws (80 scene + 16 post) and ≤ 130 k triangles (AC-44).

Re-measured twice: after the review-round fix moved the chunk spheres onto
`InstancedMesh.boundingSphere` (culling now tracks the real chunk positions),
and again after the QA-round fix moved the wreck dome into the roof part
(±≈100 triangles per planet with wrecks; the drift between runs is ambient
enemies in frame).

| Planet | Draw calls | Triangles | Shelters placed |
|---|---|---|---|
| cinder4 | 46 | 88,460 | 4 |
| vetra | 51 | 34,496 | 4 |
| thessaly | 48 | 84,456 | 3 |
| ferrum | 55 | 54,818 | 4 |
| hive | 54 | 76,872 | 3 |
| eden | 37 | 43,822 | 2 |

### Shots

| | |
|---|---|
| the wall where the player stops | [edge-wall](screenshots/spec-030/edge-wall.png) |
| a cave interior, roof lifted | [cave-interior](screenshots/spec-030/cave-interior.png) |
| a wreck interior, roof lifted | [wreck-interior](screenshots/spec-030/wreck-interior.png) |
| the forced storm held off, chip up | [storm-sheltered](screenshots/spec-030/storm-sheltered.png) |

### Not run, and why

- **Desktop hardware GPU:** _not run_ — the build container has no display and
  no hardware GPU; the frame numbers above are software-rasterised floors.
- **Physical phone:** _not run_ — no handset reaches the container; the
  touch-scheme texts are pinned in `tests/data/content.test.ts` instead.

## SPEC-031 — the console shell: boot, screen frame, wallet and item pictures (M7d)

- **Build:** `spec/SPEC-031` — untagged
- **Devices:**
  - desktop — headless Chromium 1280 × 800 (Playwright, Linux container, **software GL**)
  - phone — headless Chromium 393 × 851, touch + mobile emulation (Pixel-5-shaped;
    a physical handset needs the human pass)

### What was walked, and how (AC-43)

One scripted pass per device size: boot to the gate (START THE GAME up), the
gate into the menu, creation on an empty slot, the station with the §6.2 wallet
fixture (340 tokens, 180/60/45/12) on each of its three panel tabs, the star
map, and a paused surface on Cinder-4. Every frame invariant behind these
captures — one screen root, shared head/body centre, no horizontal scroll,
every control in the viewport, the 44/56 px tab floors, the operable Depart box —
is asserted per size (1920 × 1080, 800 × 600, 320 × 640 and a Pixel 5 touch
profile) by `e2e/SPEC-031.spec.ts` §6.2 group 1.

### Shots

| | desktop | phone |
|---|---|---|
| boot, gate up | [desktop-boot](screenshots/spec-031/desktop-boot.png) | [phone-boot](screenshots/spec-031/phone-boot.png) |
| menu | [desktop-menu](screenshots/spec-031/desktop-menu.png) | [phone-menu](screenshots/spec-031/phone-menu.png) |
| creation | [desktop-creation](screenshots/spec-031/desktop-creation.png) | [phone-creation](screenshots/spec-031/phone-creation.png) |
| station — missions | [desktop-station-missions](screenshots/spec-031/desktop-station-missions.png) | [phone-station-missions](screenshots/spec-031/phone-station-missions.png) |
| station — shop | [desktop-station-shop](screenshots/spec-031/desktop-station-shop.png) | [phone-station-shop](screenshots/spec-031/phone-station-shop.png) |
| station — character | [desktop-station-character](screenshots/spec-031/desktop-station-character.png) | [phone-station-character](screenshots/spec-031/phone-station-character.png) |
| star map | [desktop-starmap](screenshots/spec-031/desktop-starmap.png) | [phone-starmap](screenshots/spec-031/phone-starmap.png) |
| pause (surface) | [desktop-pause](screenshots/spec-031/desktop-pause.png) | [phone-pause](screenshots/spec-031/phone-pause.png) |

### Not run, and why

- **Physical phone over LAN:** _not run_ — no handset reaches the container;
  the phone column above is Chromium's mobile emulation with real touch
  pointers (which is also what flips the input scheme for the 56 px tabs).
- **Blender item renders:** _not rendered_ — no Blender binary in the
  container, so every icon surface above shows the committed glyph fallback
  (AC-40's path), which is also what the fallback e2e pins.

## SPEC-015 — mobile, performance, PWA (M7d)

- **Build:** `spec/SPEC-015` — untagged
- **Devices:**
  - desktop — headless Chromium (Playwright, Linux container, **software GL**;
    SwiftShader, no hardware rasteriser)
  - phone, **emulated** — the same headless Chromium under Playwright's
    `Pixel 5` descriptor: the `mobile` project of `playwright.config.ts`
    (AC-64/D-8), a 393 × 851 screen at `deviceScaleFactor` 2.75 with real touch
    points and the Android user agent, rotated to 740 × 360 landscape by the
    cases that need it. A device-shaped client, not a device.
  - phone, **physical over LAN** — _not run: no handset and no LAN in the build
    container_
  - Android / iOS install — _not run: same reason_

Every ms, fps and frame-cost number below is a **software-GL floor**, not a
device number: this container rasterises the whole post chain on the CPU, which
SPEC-017's entry already measures at 60–140 ms a frame on `medium`. Counts —
draw calls, triangles, geometries, textures — are renderer-independent and are
real numbers. The split is D-15's, and the rows a handset still owes are listed
at the end.

### What was walked, and how

The budget numbers below are **not** from the assertion suite: they are one
scripted Playwright pass per scene on the same `Pixel 5` descriptor at 740 × 360
landscape, opened at `?quality=medium&films=off&debug&scene=<id>`, sampled after
the scene settled (4 s on the hub screens, 8–9 s on surface and flight), and
reported as the median of 300 consecutive frames — §5.1's run, with its **4× CPU
throttling** (CDP `Emulation.setCPUThrottlingRate`) applied.

The pass reads `window.__reallm.stats()`, which is a dev-only bridge
(`src/main.ts`, `import.meta.env.DEV`), so it runs against the dev server rather
than against `vite preview`. The rows a *build* owns — the precache set, the
gzipped bundle, the service worker, offline and installability — are all taken
against `npm run build` served by `vite preview`, in the `pwa` project below.

`e2e/SPEC-015.spec.ts` re-walks the viewport shell, the keyboard reflow, the
rotate overlay and its auto-pause, and the settings benchmark row as assertions,
in **both** the `chromium` and the `mobile` project (§12);
`e2e/SPEC-015-pwa.spec.ts` runs in the preview project against a real
`vite build`.

The two projects are not the same run, which is the point of having both. The
desktop one reports `navigator.maxTouchPoints === 0` however narrow its window
is, so it reaches D-5's heuristic only through an init script that rewrites that
one property; the phone one reaches it with nothing faked, and is also the only
run that meets AC-33's boot-tap fullscreen (Android user agent) and AC-2's dpr
clamp (2.75 down to the preset's `maxDpr`). Three cases only make sense on one
side and say so: the no-touch overlay case skips on the phone, and the
real-touch overlay case and the dpr clamp case skip on the desktop.

| Case | What was seen |
|---|---|
| `100dvh` canvas | The canvas box height equals `window.innerHeight` to the pixel, with `touch-action: none` on both `#game` and `#ui` and `overscroll-behavior: none` on the document |
| Keyboard reflow (AC-29) | A CDP device-metrics override 140 px shorter shrinks the canvas by 140 px (±1); restoring the metrics puts it back to the original height and width within 1 px, with `scrollY` still 0 |
| Rotate overlay (AC-30) | Down at 740 × 360 with touch points; up the moment the viewport turns to 360 × 740; still down at 360 × 740 on a client with `maxTouchPoints === 0` — a narrow desktop window is not a phone. On the `mobile` project the same overlay comes up on the descriptor's own 393 × 851 portrait with nothing monkeypatched, which is the first time both halves of D-5's pair are real inputs |
| Fullscreen on Android (AC-33, AC-34) | The `mobile` project's boot tap enters fullscreen, which is what makes its window refuse a resize — the orientation cases leave it first. `settings.fullscreen` is still `null` afterwards: entering never writes it, and the settings toggle shows the live state until the player chooses |
| dpr clamp (AC-2) | `deviceDpr` 2.75, `dpr` 1.00 on `low` — the renderer sizes its backing store at `min(devicePixelRatio, maxDpr)` rather than at 7.6× the pixels |
| E22 auto-pause (AC-32, AC-33) | The rotation into portrait opens the pause menu once; returning to landscape hides the overlay and leaves the menu up, and `stats.frame` keeps climbing throughout |
| Wake lock (AC-35, AC-37) | `NotAllowedError: Wake Lock permission request denied` on entering the surface, logged once by `[wakelock]` and swallowed; the scene enters and runs. Two acquisitions, as D-2 requires: SPEC-002's gesture-bound request on the boot tap (`e2e/boot-gate.spec.ts`, unchanged from `main`, asserts `['wakeLock:screen']`), handed back on the first `scene:entered`, and the scene-scoped hold from then on |
| Texture cap (AC-8) | With `medium`'s `textureMaxSize` of 1024 in force, the flight scene's 2048 × 1536 sky and 2048 × 1024 planet/normal maps are drawn down to 1024 × 768 and 1024 × 512 before upload — observed in Chromium by recording every `drawImage` the resizer issues: `flight: 4 downscales`. The same cap is applied by `core/Assets.ts` on the way into the cache and by the flight scene's own loader (§8) |
| Boot benchmark (AC-17, AC-19) | With no `?quality=` the run starts after the asset load and resolves before the first scene. On this container every frame gap exceeds 100 ms, so it reports `hidden-abort` — correctly **not** persisted (15-a, D-4) — and the session stays on `medium`. With `?quality=low` in the URL it does not run at all and `settings.benchmark` stays `null` |
| Re-detect (AC-20) | The settings row reads `Benchmark: —` with nothing stored; pressing `Re-detect` runs the real benchmark, toasts `Detected quality: …` and leaves `settings.quality` at `null` |
| A stored measurement is reused (AC-15) | With `{preset: 'low', msPerFrame: 12.3, at: …}` seeded into `reallm:settings` and no `?quality=`, the boot logs `boot:started` and `scene:entered` and **no `benchmark:` line at all** — the run is skipped, `stats().preset` is the stored `low` rather than `DEFAULT_PRESET`'s `medium`, the record comes through the boot byte for byte, and the settings row reads `Benchmark: low · 12.3 ms/frame`. This is the half of AC-15 a container can answer; the *write* half needs a run that measures, which this container never lands (the row above), so it is pinned in node against a frame source that is a number (`tests/core/benchmark.test.ts`) |
| Reduce motion — the camera (AC-39) | Walking the surface with the setting on moves the camera by **exactly zero** on both counts (`camShake` and `camBob`, published on `debugInfo()`); a full-lock bank sweep in flight never rolls the horizon past **8°** while reaching 4°, so it is a clamp and not a still camera. The same walk bobs and the same sweep passes 8° with the setting off |
| Reduce motion (AC-38, AC-40, AC-41) | Under `prefers-reduced-motion: reduce` the `reduce-motion` class is on `<html>` with nothing written to `settings` (the class is the contract, the panel toggle is the only writer); the low-hull HUD bar computes `animation-name: none` with a solid outline instead of the `hud-pulse` beat; the prologue plays as `data-mode="stills"` with one poster, **zero** `<video>` elements, and a caption that is whole on the frame it appears. The control run with the setting off gets `hud-pulse`, no class, and a caption that grows frame by frame |
| iOS install explainer (AC-61) | On an iPhone Safari agent, a station save raises the toast *and* the `Share → Add to Home Screen` sheet; the sheet is dismissible, the loop keeps running behind it, and a second save inside the fortnight raises nothing (SPEC-007 §4.7's cadence) |
| Story films through the worker (AC-63) | Against the built app: `prologue.mp4` is in the worker's own precache by url; with the context **offline**, the same `fetch()` the film player makes returns **200** (not 206), with no `content-range` and the whole 3 MB, and the blob it yields becomes a `blob:` URL. No film request in the run carried a `Range` header — which is the point: a `<video src="…mp4">` is what would emit one, and the Blob path is what keeps the worker on plain 200s |

### Measurements — emulated Pixel 5, `medium`, 740 × 360, dpr 1.50 of 2.75

`medium` draws the post chain, so 16 of every draw-call figure is post
(SPEC-017 §4.9); the scene share is the budget row.

All four rows are one pass of §5.1 taken together: the same client, the same
build, **4× CPU throttling** through CDP `Emulation.setCPUThrottlingRate` as
§5.1 prescribes, medians over 300 frames of the stats bridge.

| Scene | Draws (total) | Scene share | Budget (scene) | Triangles | Budget | Geo | Tex |
|---|---|---|---|---|---|---|---|
| surface (cinder4) | 50 | 34 | ≤ 80 ✅ | 92,212 | ≤ 150 k ✅ | 45 | 39 |
| flight (cinder4) | 28 | 12 | ≤ 40 ✅ | 18,210 | ≤ 80 k ✅ | 29 | 56 |
| station | 23 | 7 | ≤ 30 ✅ | 8,208 | ≤ 60 k ✅ | 17 | 26 |
| menu | 21 | 5 | ≤ 30 ✅ | 7,672 | ≤ 60 k ✅ | 14 | 26 |

**Update and render (AC-43, D-13).** `StatsSnapshot.updateMs` and `renderMs` are
60-frame medians of the time the frame spent in `scenes.update()` and in
`scenes.render()`, and the debug overlay shows them as its `update` and `render`
rows — which is how these same numbers are read off a real handset later, with
no profiler attached. Both are **CPU** times, which is exactly what §5's table
budgets ("Update (sim)", "Render (CPU)"): a `render()` call returns as soon as
the commands are submitted, so the software rasteriser's cost lands on the frame
interval below and not on this row.

| Scene | update (median) | Budget | render (median) | Budget |
|---|---|---|---|---|
| surface | **0.90 ms** | ≤ 6 ms ✅ | **3.40 ms** | ≤ 8 ms ✅ |
| flight | **0.60 ms** | ≤ 3 ms ✅ | **1.95 ms** | ≤ 6 ms ✅ |
| station | **0.00 ms** | — | **1.35 ms** | ≤ 4 ms ✅ |
| menu | **0.00 ms** | — | **1.50 ms** | ≤ 4 ms ✅ |

Read the two rows differently. **`updateMs` is renderer-independent** — the
simulation is pure TypeScript over `src/systems/` and `src/entities/`, which
import no `three` at all (SPEC-001 §4) — so a 4×-throttled container core is a
defensible stand-in for a phone core and the `≤ 6 ms` / `≤ 3 ms` rows are close
to a real answer. **`renderMs` is not**: it is the CPU half of a draw whose GPU
half this container has no GPU for, so it is a floor. Both still owe the handset
measurement below. Chromium clamps `performance.now()` to 100 µs in a
non-isolated context, which is why the station and menu update rows read a flat
`0.00` rather than a small number — five fixed steps over an idle hub scene cost
less than one tick of the clock available to measure them.

**Frame cost — software-GL floors, not device numbers.** The fixed loop is at
its five-step ceiling in every row, which is the container rasterising, not the
simulation:

| Scene | fps | ms/frame | updates/frame |
|---|---|---|---|
| surface | 7.37 | 135.60 | 5 |
| flight | 7.50 | 133.35 | 5 |
| station | 11.26 | 88.81 | 5 |
| menu | 14.17 | 70.57 | 4 |

### The rest of the §5 table (AC-61)

| Metric | Measured | Budget | Verdict |
|---|---|---|---|
| JS heap (`performance.memory.usedJSHeapSize`) | surface 51.0 MB, flight 42.6 MB, station 31.6 MB, menu 31.6 MB | ≤ 120 / 100 / 80 MB | ✅ — Chromium quantises this figure for privacy, so read each as "well under" rather than to the megabyte |
| GPU textures — surface | 9.4 MB (21.4 MB unclamped) | ≤ 40 MB | ✅ |
| GPU textures — flight | 16.7 MB (56.7 MB unclamped) | ≤ 30 MB | ✅ — was the P1 below; AC-8's clamp is what closes it |
| GPU textures — station / menu | 4.0 MB (16.0 MB unclamped) | ≤ 20 MB | ✅ |
| Bundle, app (gz) | 189.55 kB (`index`) + 10.51 kB (css) + 2.20 kB (`workbox-window`) | ≤ 350 kB | ✅ |
| Bundle, three (gz) | 177.23 kB | ≤ 200 kB | ✅ |
| Precache set | **21.32 MB over 179 urls** — the build summary's own figure is 349 manifest *entries*, 21 788.33 KiB; the two count different things and the note below reconciles them | ≤ 25 MB | ✅ |
| Cold first load, 4G | **1.69 s** to "tap to start" (703.6 kB over 9 requests) | ≤ 8 s | ✅ — CDP `Network.emulateNetworkConditions` at Chrome's **Fast 4G** preset; the network half only, see the note below |

Three notes on how those were taken, because the spec's wording assumes more
than three.js offers:

- **Cold first load (AC-47).** `e2e/SPEC-015-pwa.spec.ts`, "cold first load on a
  4G profile", is the measurement — committed rather than taken by hand, so the
  figure is re-runnable: `npx playwright test --project=pwa -g "cold first load"`
  prints it. A fresh context (no worker, no precache, no HTTP cache) loads the
  **built** app from `vite preview` with CDP
  `Network.emulateNetworkConditions` set to Chrome DevTools' **Fast 4G** preset
  — 4 Mbit/s down, 3 Mbit/s up, 20 ms latency — and the number is
  `performance.now()` read in the page when `[data-testid="boot-start"]` becomes
  visible, which is what "tap to start" means everywhere in this suite
  (`e2e/start.ts`). Three consecutive runs: **1 675 / 1 691 / 1 703 ms**, median
  **1 691 ms** against a ≤ 8 s budget, moving 703.6 kB over 9 requests (the
  preview server gzips, so that is the wire size, not the 1.3 MB on disk).

  What this row is and is not: it holds the **network** half of AC-47 honestly —
  the payload and the request count are the shipped build's, and the link is a
  named public preset rather than an invented one. It does not model a phone's
  **CPU**, so the parse-and-execute part of those 1.69 s is a container core's,
  not a handset's. The margin is wide enough (4.7×) that this is recorded as met
  in-container, and the handset row below still owes the real number.
- **GPU texture bytes.** `gl.info.memory` reports texture *counts*, not bytes
  (26 / 26 / 39 / 56 above). The byte figures are therefore derived: every image
  resource the page downloaded, sized as RGBA8 with a full mip chain
  (`w · h · 4 · 4/3`). That is an **upper bound** — it counts each decoded image
  once whether or not it is resident — and it is the honest number to hold the
  budget against. The "unclamped" column is that sum at each image's *source*
  size, which is what this row measured before AC-8 existed; the budget column
  is the same sum at the size actually uploaded under `medium`'s
  `textureMaxSize` of 1024, and the `drawImage` recording in the walk table
  above is the evidence that the clamp really runs rather than being assumed.
- **Precache summary (AC-57).** `vite build` prints it, from `vite-plugin-pwa`:

  ```
  PWA v1.3.0
  mode      generateSW
  precache  349 entries (21790.76 KiB)
  files generated
    dist/sw.js
    dist/workbox-2fbc6a65.js
  ```

  `node scripts/assets/check.mjs` prints the same set counted its own way —
  `dist 21.32 MB (179 precachable files)` — and fails over 25 MB, which is what
  D-11 widened it to do.

  The two counts are both right and they are counting different things. The
  plugin's `349` is manifest *entries*, and the ~170 files under `public/assets/`
  are entered twice, because `includeAssets` and `workbox.globPatterns` both
  match them. What the worker actually stores is the 179 distinct urls the
  checker counts, confirmed in Chromium: one `workbox-precache-v2` cache
  holding **179 entries**. The size the plugin prints is of the distinct set,
  which is why it agrees with the checker and not with its own entry count.

**P1 — flight GPU textures 56.7 MB against a ≤ 30 MB budget — closed.** The
flight scene loads the 2048 × 1536 sky window plus the 2048 × 1024 planet
equirect and its relief map (`scripts/assets/blender/flight.py`), and nothing
downsampled them to the preset's `textureMaxSize` before upload — because
nothing in `src/` read `textureMaxSize` at all, which is the whole of what AC-8
asks for and what this round added.

`core/Assets.ts` now clamps on the way into the cache, and exports
`clampTexture` for the one loader that deliberately does not go through the
cache: the destination maps are owned and released by the flight scene
(SPEC-020 §4.8), and §8's budget is per preset, not per loader. At `medium` the
three maps upload at 1024 × 768 and 1024 × 512, and the derived flight figure
falls from 56.7 MB to **16.7 MB**, inside the ≤ 30 MB budget. The art files are
unchanged: a `high` device still gets them at 2048.

### PWA and installability (AC-58)

Against a real `vite build` served by `vite preview` on 4173
(`e2e/SPEC-015-pwa.spec.ts`, the `pwa` Playwright project):

| Check | Result |
|---|---|
| Served manifest parses and carries every AC-49 field | ✅ `name`/`short_name` `ReaLLM`, `display` `standalone`, `orientation` `landscape`, `background_color` `#000000`, `theme_color` `#0b0f14`, `start_url`/`scope` `./`, two icons |
| `icons/icon-192.png` and `icons/icon-512.png` | ✅ 200, IHDR reads 192 × 192 and 512 × 512 |
| `icons/apple-touch-icon-180.png` | ✅ 200, IHDR reads 180 × 180 |
| `start_url` inside `scope`, maskable icon ≥ 192, secure context | ✅ |
| Service worker reaches `activated` | ✅ registered from `virtual:pwa-register` on `load`, installs 179 entries and activates in ≈ 0.6 s on the preview server |
| CacheStorage actually holds the precache | ✅ one `workbox-precache-v2-http://localhost:4173/` cache, **179 entries** — see the collision note below for why this row exists |
| Offline reload (AC-56) | ✅ `context.setOffline(true)` then reload: every navigation is answered with the precached `index.html` and the boot gate comes up with the network gone |
| An offline save (AC-57) | ✅ a new game created **while offline** — prologue as posters, marine, Confirm — writes `reallm:slot:0`; an offline reload reads it back field for field and the menu offers `Continue`. Only `meta.updatedAt` moves, because leaving the page is a `pagehide` autosave |
| Newer save refused by the version check (AC-59, E9) | ✅ a `version: 99` slot reads as unusable, the menu offers `New Game` and no `Continue`, and no `Update` button exists with nothing waiting |

| Story films served whole, never as a Range (AC-63) | ✅ the precache holds `prologue.mp4` by url; offline, `fetch()` + `.blob()` returns a plain 200 with no `content-range`, and no request in the run carried a `Range` header |
| Cold first load on Fast 4G (AC-47) | ✅ **1.69 s** to `[data-testid="boot-start"]` of ≤ 8 s, 703.6 kB over 9 requests, nothing cached — the note under §5's table has the method |

The whole `pwa` project: **8 passed**, ≈ 23 s, serially, against `npm run build`
served by `vite preview` on 4173.

One note on how the offline save was taken. A production build has no
`?films=off` — that flag is dev-only (SPEC-022 §4.11) — so the prologue stands
between `New Game` and the creation screen, and this container's software
rasteriser dies decoding its 3 MB MP4 (a renderer-process crash, the same one
`e2e/SPEC-022.spec.ts` sidesteps by aborting the MP4 route). The case runs under
`prefers-reduced-motion`, where `chooseFilmMode()` returns `stills` and no
`<video>` is built at all — this spec's own AC-46 — and skips the posters the way
a player does. The save path under test is untouched by any of that.

**The precache collision, and why a row above checks CacheStorage.** Installing
`vite-plugin-pwa` and handing it §10's options exactly as written produced a
worker that cached *nothing*, and every green signal stayed green while it did:
`vite build` succeeded and printed its 349-entry summary, the worker reached
`activated`, and the app ran normally online. Measured in Chromium against
`vite preview`:

```
ONLINE:  { state: "activated", cacheNames: [], entries: 0 }
OFFLINE RELOAD: RELOAD FAILED: net::ERR_INTERNET_DISCONNECTED
```

The cause is a collision between §10's options and this repository's layout.
`includeAssets` globs `public/` and gives each file an md5 `revision`; the
`globPatterns` pass globs `dist/` and sets `revision: null` for whatever
`dontCacheBustURLsMatching` covers, which the plugin defaults to `/^assets\//`
from Vite's `build.assetsDir`. ReaLLM keeps its game assets in `public/assets/`,
so both passes claimed all ~170 of them and emitted each url twice under
different cache keys — `url` and `url?__WB_REVISION__=…`. Workbox's
`addToCacheList` throws `add-to-cache-list-conflicting-entries` on exactly that,
and it throws while the worker evaluates `precacheAndRoute`, before any install
handler is attached. Hence a worker that activates having cached nothing.

The fix is in `vite.config.ts`: `dontCacheBustURLsMatching` is narrowed to the
files whose *name* already carries their version — Vite's hashed build output,
`/^assets\/[^/]+-[\w-]{8}\.(js|css)$/`, four files here — so the copied-through
public assets take an md5 from both passes, the same md5 over the same bytes,
and the pairs collapse to one entry instead of colliding. After it: 179 cached
entries and an offline reload that boots the game. It is the one option in the
`workbox` block that §10 does not list, and it is load-bearing.

`tests/build/pwa.test.ts` fails if any url is ever emitted under two revisions
again. The `registers a service worker that reaches activated` case could not
catch this — it passed throughout — which is why the table above now also
asserts on CacheStorage rather than on worker state alone.

### Five criteria that were open when this section was first written

QA drove the tree and found five criteria the earlier rounds had left unmet.
They are listed here because the measurements above changed with them, and
because a reader comparing this section to an earlier revision of the branch
will find different numbers in it.

| Criterion | What was wrong | What closes it now |
|---|---|---|
| **AC-8** — `Assets` clamps uploaded textures to `textureMaxSize` | The 512/1024/2048 values were in `QUALITY` and nothing read them: `textureMaxSize` appeared in `src/` only in its own declaration, so no upload was ever clamped | `core/Assets.ts` clamps on the way into the cache, re-clamps when a preset change lowers the cap, and exports `clampTexture` for the flight scene's own loader (§8). The walk table records the four downscales it performs, and the flight GPU-texture P1 above is paid by it |
| **AC-18** — a slow run resolves to `low` | Both `slow-abort` sites in `core/Benchmark.ts` returned `FALLBACK_PRESET` (`medium`), and `tests/core/benchmark.test.ts` pinned that value, so the slowest devices were cached at `medium` for every later boot | `SLOW_ABORT_PRESET` (`low`) in `core/Quality.ts`, at both sites. D-5's split — hidden tab → `medium`, not cached; measured-and-slow → `low`, cached — now holds in the code as well as in the prose |
| **AC-26** — `#ui` safe-area padding | `#ui` had no `padding` at all; the safe area was handled only per element, which was a deliberate reading of D-6 but is not what AC-26 or §6 say | `#ui` carries the four-value `env(safe-area-inset-*)` padding of §6, and the per-element `max(Npx, env(...))` offsets stay. `tests/ui/viewport.test.ts` asserts both |
| **AC-37** — the boot-tap wake lock stays | The request was deleted from `core/Game.ts` and `e2e/boot-gate.spec.ts` was rewritten from `toEqual(['wakeLock:screen'])` to `toEqual([])` — the opposite of "stays green unchanged" | The request is back on the tap, `e2e/boot-gate.spec.ts` is restored byte-for-byte from `main`, and §7's hand-over is explicit: the boot sentinel is released on the first `scene:entered`, from which point the scene-scoped hold is the only owner. SPEC-015's own additions to that tap (the landscape lock, the fullscreen opt-out) moved to `e2e/SPEC-015.spec.ts` |
| **AC-43** — `StatsSnapshot` exposes `updateMs` and `renderMs` | Neither field existed anywhere in `src/`, and the overlay had no such rows, so §5's update and render budgets had nothing to be read from | `core/FrameTimers.ts` (a preallocated ring with a median), both fields on `StatsSnapshot`, and the `update` / `render` rows on the debug overlay. The two tables above are the first measurement of them |

Five more were reported as *not reached* rather than as defects — the QA window
ran out before it got to them — and each had node coverage but nothing a browser
could observe. They now have both, in the walk table above: **AC-39** (the
camera's own shake, bob and bank, published through `debugInfo()` the way
SPEC-020 20-g publishes `skyTint`), **AC-40** (the HUD pulse as a computed
style), **AC-41** (the prologue as posters, and the caption whole on its first
frame), **AC-61** (the iOS explainer and its fortnight cadence) and **AC-63**
(the whole-film fetch through the worker, offline, with no `Range` anywhere).

Each of the five is paired with a **control run** that asserts the opposite with
the setting off, because a reduce-motion assertion that would also pass on a
still scene proves nothing. The first draft of AC-39's bank case was exactly
that — it held a key while `settings.flightMouseSteer` quietly overrode the
keyboard axis, so the roll never left zero and the ≤ 8° clamp passed without the
camera ever banking. It steers with the mouse now and asserts the sweep reached
4° before asserting it stopped at 8°.

### Owed on hardware before `m7`

Nothing here is dropped; each row names its in-container substitute above and
the handset measurement it still needs. This list is the M7 checklist's input.

The AC numbers in this section are the ones the spec carried when it was
written. The work order renumbered them once, and the rows below map onto the
current list as: **AC-29 → AC-28** (keyboard reflow), **AC-35 → AC-34**
(orientation lock), **AC-58 → AC-62** (installability), **AC-60 → AC-43**
(surface budgets) and **AC-61 → AC-44…AC-47** (flight, station/menu, memory and
cold load). The PWA rows map **AC-54 → AC-57**, **AC-56 → AC-58**,
**AC-57 → AC-59**, **AC-59 → AC-60** and **AC-49 → AC-50**.

- [ ] **AC-29 — keyboard reflow.** Closed in-container on an emulated viewport
      shrink (canvas follows and restores within 1 px, no scroll offset). Owed:
      the same check with a **real iOS and a real Android on-screen keyboard**,
      against the same ±1 px tolerance.
- [ ] **AC-35 → AC-34 — orientation lock.** Closed in-container: the
      `screen.orientation.lock('landscape')` call is made after the fullscreen
      request settles and a rejection is swallowed and logged at warn, on the
      emulated Android client — `e2e/SPEC-015.spec.ts`, "the boot tap on
      Android", which asserts the whole order
      `['wakeLock:screen', 'fullscreen', 'lock:landscape']` and the
      desktop client's `['wakeLock:screen']` alone. Owed: that a **real Android in fullscreen
      actually holds the landscape lock** through a physical rotation.
- [ ] **AC-58 — installability.** Closed in-container on the table above: the
      served manifest, both icon URLs and the apple-touch-icon at their claimed
      pixel sizes, `start_url` inside `scope`, a secure context, and a service
      worker that reaches `activated`. Owed: **one Android install** (prompt /
      "Add to Home screen", launches standalone landscape) and **one iOS
      install** (Share → Add to Home Screen, launches full-bleed with the
      apple-touch-icon).
- [ ] **AC-60 → AC-43 — surface budgets.** Closed in-container on every row the
      criterion names: 34 scene draws of ≤ 80, 92,212 triangles of ≤ 150 k,
      **update 0.90 ms of ≤ 6 ms** and **render 3.40 ms of ≤ 8 ms** on the
      emulated Pixel 5 at `medium` under 4× CPU throttling, with
      `StatsSnapshot.updateMs` / `renderMs` and their two debug-overlay rows the
      mechanism that produced them (D-13). Owed: the same four numbers **on the
      reference phone** (iPhone 11 / Pixel 4a class). The update row should
      travel — the simulation imports no `three` — and the render row is a
      software-GL floor that will not.
- [ ] **AC-61 → AC-44…AC-47 — the rest of §5.** Closed in-container: flight
      0.60 + 1.95 ms, station 1.35 ms and menu 1.50 ms render, all inside their
      budgets, plus counts, texture bytes, heap, the gzipped bundle and the
      **cold 4G first load at 1.69 s of ≤ 8 s** (the Fast 4G note above). Owed:
      the same **per-scene ms rows on the handset**, and the cold load **over a
      real 4G radio on the reference phone**, where the parse-and-execute half
      of that 1.69 s is a phone core's rather than a container core's.

Not on this list, because it is not a measurement: the one thing this container
cannot produce is the `prompt` update flow **end to end** — it needs two
successive deploys of the same origin, so a waiting worker actually exists. The
seam either side of it is covered: `tests/ui/updates.test.ts` pins
`app:update-ready`, and `e2e/SPEC-015.spec.ts` pins the banner and the menu and
station `Update` buttons through the dev bridge.

`vite-plugin-pwa` is no longer owed either. The owner authorised the dependency
after this section was first written, so the in-repo substitute is gone and
AC-48 closes on the real package: `npm i -D vite-plugin-pwa@^1.3.0` added 370
packages with 0 vulnerabilities, `package.json` carries `"vite-plugin-pwa":
"^1.3.0"` and `package-lock.json` resolves it at 1.3.0, and it builds under this
tree's Vite 8.2.2 / Rolldown. The blocked path of AC-66 therefore does not
apply: nothing about the install or the build failed, so AC-48…AC-64 close
normally rather than being labelled *blocked — vite-plugin-pwa*.

### Not run, and why

- **Desktop hardware GPU:** _not run_ — no display and no GPU in the container;
  every frame-cost number above is a software-rasterised floor.
- **Physical phone over LAN:** _not run_ — no handset reaches the container. The
  phone column is Chromium's `Pixel 5` emulation under the `mobile` project,
  whose touch pointers and 2.75 device ratio are the context's own rather than a
  rewritten `navigator` property — which is what the rotate overlay's
  `maxTouchPoints` heuristic actually reads. What it still cannot show is feel,
  thermal behaviour and a real GPU's frame cost.

### Seven tests need the one-worker step

Run at `--workers=4`, seven of the 315 fail; run alone, all seven pass. They are
listed here by name because the last QA round spent its window rediscovering
them and could not tell contention from a regression:

| Test | Alone |
|---|---|
| `post-chain.spec.ts:46` — costs exactly 16 quads with FXAA and 15 with MSAA | 54.3 s ✅ |
| `post-chain.spec.ts:95` — the chain survives a scene change without growing | 19.0 s ✅ |
| `context-loss.spec.ts:40` — the post chain comes back with the context | 22.5 s ✅ |
| `lifecycle.spec.ts:22` — becoming visible resumes without a catch-up burst | 5.5 s ✅ |
| `SPEC-011.spec.ts:64` — enemies spawn and engage on Cinder-4 | 46.4 s ✅ |
| `SPEC-012-missions.spec.ts:96` — all five Cinder-4 missions end to end | 3.0 min ✅ |
| `surface-env.spec.ts:35` — the spawn-heavy medium frame stays in budget | 1.1 min ✅ |

They share one shape, and it is not this spec's. Every one of them waits on
*simulation* progress — frames advanced, enemies spawned, a mission run to its
end, a post chain rebuilt across a scene change — while the wait itself is
budgeted in wall-clock milliseconds. Four workers rasterising WebGL on one
software rasteriser drive the fixed loop into its five-steps-per-frame ceiling
(SPEC-002 §4.2), so in-game time advances several times slower than the clock
the wait is counting, and the budget runs out before the game gets there. The
same starvation is why `e2e/start.ts` now takes the cold-start budget for the
scene-label and fade waits.

**No spec file any of the seven lives in was changed by this branch**, and none
asserts anything SPEC-015 touches. The one file of theirs this branch did touch
is the shared `e2e/start.ts`, and its only change is the two widened waits
described above — a longer budget can turn a failure into a pass, never the
other way round. The two post-chain cases and the context-loss case
are SPEC-017's composer, `lifecycle` is SPEC-002's visibility handling,
`SPEC-011` and `SPEC-012-missions` are spawn and mission progression, and
`surface-env` is SPEC-030's per-planet draw budget. The draw and triangle counts
in that last one are *inside* budget when it is allowed to finish — it is the
wait that expires, not the budget that breaks.

The merge gate's protocol already absorbs this: `--workers=4`, then
`--last-failed --workers=4`, then `--last-failed --workers=1`, stopping at the
first green step. Both one-worker re-runs above were that third step, taken
verbatim, and both cleared everything.

### Checklist

- [x] `npm run check` green — typecheck (`src` and `tests`), **77 vitest suites
      / 1 350 tests**, production build
- [x] **both Playwright projects green** (AC-64) —
      `npx playwright test e2e/SPEC-015.spec.ts --project=chromium --project=mobile`:
      **44 passed, 6 skipped**. Each skip names itself: the dpr-clamp and
      real-touch cases are phone-only and skip on `chromium`; the no-touch
      overlay case, the off-Android boot-tap case and the two mouse-steer bank
      cases are desktop-only and skip on `mobile`
- [x] **the whole suite green** (AC-64) — all **317 tests in 47 files** across
      the three projects, run file by file at `--workers=4`: `chromium` 284,
      `mobile` 25, `pwa` 8. See "Seven tests need the one-worker step" below for
      the seven that only pass alone, and why that is the container rather than
      the tree
- [x] `e2e/boot-gate.spec.ts` green and **byte-for-byte identical to `main`**
      (AC-37) — 12 passed, including SPEC-002's own
      `expect(asked).toEqual(['wakeLock:screen'])` and
      `['wakeLock:screen', 'fullscreen']` on Android
- [x] `e2e/stats-overlay.spec.ts` green with the overlay's closed row list grown
      to eighteen (AC-43, D-13) — 11 passed
- [x] `npx playwright test --project=pwa` green — 8 passed against a real build
      served by `vite preview`, including AC-63's whole-film fetch and AC-47's
      throttled cold load
- [x] `node scripts/assets/check.mjs` green — every asset row in
      `LICENSES.md`, every budget met, precache 21.32 MB of 25 MB
- [x] the `chromium` project's dev-server flow unchanged: no worker is
      registered in a dev server, and `virtual:pwa-register` is a stub there
- [x] every criterion that is not hardware-deferred is closed, `vite-plugin-pwa`
      included — the PWA rows on the real package, measured above. The five that
      were open when this section was first written (AC-8, AC-18, AC-26, AC-37,
      AC-43) each have a row in the table above naming the code that closes it
- [x] **AC-43…AC-47 and AC-62's in-container half** closed on named evidence:
      the §5.1 proxy run (built app's counts, 4×-throttled Pixel 5 descriptor at
      `medium`, medians over 300 frames) for the budgets, the build report for
      the bundle and precache rows, `e2e/SPEC-015-pwa.spec.ts`'s Fast 4G cold
      load (1.69 s of ≤ 8 s) for AC-47's first half, and the `pwa` project
      against `vite preview` for the manifest, icons and service worker
- [ ] the five hardware rows above — the physical iPhone 11 / Pixel 4a-class
      numbers and the two device installs — owed before the `m7` tag, each with
      its in-container substitute named

Then, after this branch merges: `SPEC-015` `status: done` in its frontmatter and
in the SPEC-000 table. Both live in the sibling repository `../reallm-specs`,
which CLAUDE.md keeps separate from this one and which is not checked out in
this container, so it is the owner's step rather than part of this diff.

## SPEC-034 — stabilisation: collision, the Gauntlet, the climax, state (M7e)

Recorded from the container the branch was built in: headless Chromium over
SwiftShader, `npm run check` and the suites named below. The manual list of §7 is
a desktop-and-phone pass and is owed before the `m7` tag; every row says which
automated evidence stands in for it in the meantime.

**Verified here, by name.**

| §7 item | Evidence in this branch |
|---|---|
| Fight with your back to an outcrop until you are knocked into it, and walk away | `tests/systems/combat.test.ts` — "a shot that shoves the player at a rock leaves them outside it, and they can walk away" (a metre of walking in one second), plus `tests/systems/enemyAi.test.ts` for the enemy half and `tests/systems/layout.test.ts` for `resolveCircle` itself |
| Recall to the pad from the middle of a survive stage | `e2e/SPEC-034.spec.ts` case 1 (within 3 m of the spawn, resources unchanged, no death overlay) and `tests/systems/missions.test.ts` for the stage restart at reason `recall` |
| Fly the Hive Gauntlet with the chapter-5 recommended ship, aiming by hand | `tests/systems/gauntlet.test.ts` — 16 of 16 seeds with the no-lead autopilot and 16 of 16 with the leading one, through the real `Flight`. On the numbers this spec replaced it is 0 of 16, which is the review's own figure |
| Kill the Queen and hear the Warden, then ARIA, with the world still | `tests/ui/dialogue.test.ts` (the `onComplete` → `next` chain) and `e2e/SPEC-034.spec.ts` case 3 (`sceneInfo.held` 1, nothing moves for a second) |
| Defend the Eden beacon and watch the wave reach it | `tests/systems/defend.test.ts` — 240 s of the real stack, at least 40 of 47 engaged, the beacon damaged. On the old wave rules it reports "0 of 47 engaged" |
| Take `c3_s2` with a full hold of wheat | `tests/systems/economy.test.ts` — "c3_s2 completes with a hold already over the objective" |
| Replay a mission and reload mid-way | `tests/core/save.test.ts` — "a replay with counters survives validateSave" |
| Import a save into the slot in play | `tests/core/save.test.ts` — the import survives two autosaves in the slot and its `:bak` |
| Throttle down with X | `e2e/SPEC-034.spec.ts` case 4, and `tests/core/input.test.ts` for the binding table |

**Owed on hardware, before the `m7` tag.**

- [ ] the nine rows above, played on desktop and on the reference phone — in
      particular the two that are a matter of feel rather than of state: whether
      being knocked into a rock now *reads* as a shove rather than a snag, and
      whether the Gauntlet's six kills feel like a fight won rather than a fight
      survived. The simulations above say it is winnable; they cannot say it is
      good.
- [ ] the four overlays of §4.11 seen rather than asserted: the awakening burst
      at its own alphas, the storm vignette, the storm warning pill and the
      flight ion sheet. `tests/ui/css.test.ts` proves no rule overwrites another
      and the e2e reads the classes; neither looks at a pixel.

**The literals this spec did move.** The three events it adds —
`player:recalled`, `item:noRoom` and `enemy:dismissed` — are all silent, so
`GameEvents` went 59 → 62 and `AUDIO_SILENT` 40 → 43. Three suites pin that pair
and all three are repinned: `tests/core/events.test.ts`,
`tests/core/audioReactions.test.ts` and `e2e/SPEC-006.spec.ts`. The last of them
is the one the merge gate caught: the unit suite was green while the browser
suite was not, because the same number is written down in both places.

**Not in this branch, and why.** SPEC-016's "Completionist, base hold" run
(AC-53) and its pinned literals (AC-73) belong to a harness that is not in this
tree — `tests/campaign/harness.ts` here runs the worst-case main-mission player,
which takes no side missions and so never met the finding. SPEC-034's out-of-scope
list forbids building that harness, so §4.12's fix is pinned by
`tests/systems/economy.test.ts` and `tests/systems/pickups.test.ts` instead, and
`docs/BUGS.md` §6 records the same. Nothing in the worst-case runs moved, which
§4.18 predicts: they emit no kill XP, so `c5_m1`'s four fewer kills change none of
their numbers, and `tests/campaign/campaignSim.test.ts` passes unedited.

## SPEC-035 — legibility: the first hour reads (M7e)

- **Build:** `spec/SPEC-035` — untagged
- **Devices:**
  - desktop — headless Chromium 1280 × 800 (Playwright, Linux container, **software GL / SwiftShader**)
  - phone — headless Chromium 393 × 851, touch + mobile emulation (Pixel-5-shaped;
    a physical handset still owes the human pass)

Recorded from the container the branch was built in, as SPEC-034's section was:
`npm run check` (85 files, 1523 tests), `node scripts/assets/check.mjs` and the
suites named below. The §7 list is a desktop-and-phone pass and is owed before
the `m7` tag; each row names the automated evidence that stands in for it here.

**Verified here, by name.**

| §7 item | Evidence in this branch |
|---|---|
| Finish `c1_m1` without dying, following the tips | `e2e/SPEC-035.spec.ts` cases 6 and 7 — the first landing reports `sceneInfo.ramp` 1, the weather phase holds calm for 30 s of game time, no rusher spawns ambiently, `ramp` returns to 0 once `c1_m1` is done; the combat tip shows on the first hit and the two flight tips on the first launch, none of them twice |
| Every Cinder-4 and Vetra enemy reads against the ground at a glance | `tests/data/content.test.ts` — the WCAG contrast invariant over every non-boss surface enemy against its chapter's `palette.ground` (all ≥ 3:1), plus `tests/ui/helpers.test.ts` for `contrastRatio` itself. A ratio is not a glance: the human pass still owes the look |
| The salvager is visible on Vetra on every preset, and a rock between the camera and the salvager fades | `e2e/SPEC-035.spec.ts` case 4 (`sceneInfo.occluders` ≥ 1 behind an outcrop, back to 0 when clear) and cases 1–3 (`camDistance` 22/17, `fogNear` equal to the distance, bloom threshold 1.5 on `medium`), with `tests/ui/helpers.test.ts` for the pure `occludes` and `surfaceFogRange` |
| A hit from behind points at its source | `e2e/SPEC-035.spec.ts` case 5 (one `hud-hit-dir` on a damage event, gone after 1.2 s) and `tests/systems/combat.test.ts` for the `from` field every enemy and projectile hit carries |
| The first flight teaches its controls | `e2e/SPEC-035.spec.ts` cases 7 and 8 — `flight_steer` after the launch, `flight_throttle` 12 s later, and the hull bar reading `Hull` with no visible `hp` bar |

**The item pictures (§4.15).** The 21 item and 5 companion renders were produced
in this container rather than on a workstation: no Blender 5.2 exists for Linux
arm64 (no upstream build, no `bpy` wheel), so the drop was rendered by the
distribution's **Blender 4.0.2** headless on software GL, from the committed
`scripts/assets/blender/items.py` unchanged. 26 WebPs at 384², 0.23 MB of the
1.0 MB budget, every row written into `LICENSES.md` by the build. The framing is
§4.15's: weapons side-on with the muzzle right, everything else front
three-quarter. A rebuild on Blender 5.2 will not be byte-identical — the README's
determinism claim is per tool version — and the contact sheet
(`--preview=DIR`) is what a human should judge before the `m7` tag.

**Owed on hardware, before the `m7` tag.**

- [ ] the five rows above, played on desktop and on the reference phone — above
      all the two that are a matter of feel: whether the closer touch camera
      (17 m) still shows enough of the fight, and whether the hit markers read
      as direction rather than as noise.
- [ ] the contact sheet of the item renders seen at 28–40 px against the navy UI,
      and the same renders re-run on Blender 5.2 if the art is judged short.
- [ ] the seven new sounds heard rather than asserted: the four weapon lines, the
      impact, the explosion and the ship laser, with `engine_hum` under them.

## SPEC-036 — touch that works: aim, scheme, back, rotate and the short landscape screen (M7f)

- **Build:** `spec/SPEC-036` — untagged
- **Devices:**
  - desktop — headless Chromium 1280 × 720 (Playwright, Linux container, **software GL / SwiftShader**)
  - phone — headless Chromium with touch + mobile emulation: 844 × 390, 800 × 360,
    750 × 342, 802 × 293, 667 × 375, 727 × 393 and the Pixel 5 (393 × 851); a
    physical handset still owes the human pass

Recorded from the container the branch was built in: `npm run check` (86 files,
1570 tests) and the e2e files this spec wrote or moved — `SPEC-036.spec.ts`
(33 cases with four workers; the first 30 also twice over with six),
`SPEC-031.spec.ts`, `SPEC-015.spec.ts` in both projects, `SPEC-005.spec.ts`,
`touch-controls.spec.ts`, `SPEC-023.spec.ts` and `SPEC-014.spec.ts` for the
chapter card and the toasts, and the terminal and camera cases of
`SPEC-012.spec.ts` and `SPEC-035.spec.ts`. The §7
list is a phone-and-desktop pass owed before the `m7` tag; each row names the
automated evidence that stands in for it here.

**Verified here, by name.**

| §7 item | Evidence in this branch |
|---|---|
| The first flight by touch: the reticle stays ahead, the tips speak of thumbs | `SPEC-036.spec.ts` case 1 (`reticleX/Y` within 0.5 m of `shipX/Y` while a thumb steers; `aim.hasPointer` stays false) and case 2 (a coarse-pointer context boots on `touch` before any touch, and the first tip is the `zones` line) |
| A half-stretched thumb kites at full speed | case 10 (34 px of travel reads ≥ 0.99, 8 px reads 0) and `tests/core/input.test.ts` for `shapeTouchStick` |
| A third finger lifted drops nothing | case 11 (a cancelled aim finger leaves the stick; a cancelled stick finger leaves the fire hold) |
| The launcher tapped with auto-fire running | case 9 (one `shot_launcher` voice, `weaponSlot` stays `primary`, `charges` 1 → 0, then `Launcher recharging`) and `tests/systems/combat.test.ts` for `fireSlotOnce` |
| Upright mid-fight and back | cases 4 and 5 (held at 1 with `px`/`pz`/`viewTime` frozen, the cover topmost at z 51 in `rgba(0, 0, 0, 0.92)`, the pause menu under it and topmost again once turned back; a flight entered upright paints its chapter card over the cover and a toast under it, and in landscape a toast still lands over the card) |
| The Back gesture on the surface, at the station and at the menu | cases 6 and 7 (Escape and `page.goBack()` pause and resume the surface, the star map goes to the station, a menu sub-panel closes, the menu root leaves the page; at the station a buy sheet over the gear card closes first, then the card, each taking its back-stack entry with it, and `page.goBack()` closes a card and stays on the page) and `tests/core/backGuard.test.ts` |
| The notification shade mid-fight | case 8 (a `blur` pauses; with `pauseOnBlur` off it does not) |
| Every station tab in reach at landscape | case 12 and the `SPEC-031.spec.ts` walk at the five short sizes (every `station-tab-*` inside the viewport and topmost; `.screen-body` 52–67 % of the height) |
| The pause menu and Controls on the shortest phone | case 13 (with the touch sheet open, at all five sizes: `pause-resume` inside the viewport and topmost, and every visible action ends before the sheet begins; at 667 × 375 the actions keep the 310 px their two columns need, where they had shrunk to 271 px and the second column ran under the sheet's rows) |
| The prologue watched without touching | case 14 (one wake-lock request during the prologue, released by `film-skip`; a system Back leaves the film up) |
| The pad terminal with enemies near | case 15 (`held` 1 while it is open; Escape, E and Close each close it) |
| The zone ghosts on the first two landings | case 17 (shown on landings one and two, gone on a stick drag or 12 s later, absent on the third and in a `?perf` run) |

**The stacking under `#ui`, and what moved for it.** §4.3 puts the rotate cover
at z 51, above the pause frame (35) and every layer of `UiRoot`, and below chapter
cards (54), reveals (64), films (65) and endings (70, 80). SPEC-023 §4.2 wants a
toast (55) to land over a chapter card. Both hold only if the card, the cover and
the toasts share one stacking context. Inside the overlay layer (50) the card
could never climb past the cover. So:

- the chapter card's host now mounts directly under `#ui`, next to the reveals,
  films and endings;
- `UiRoot`'s toast rack (55) and its own fade (60) sit there too, next to the
  three layers, so a toast still lands over the card and the fade still covers
  the toasts;
- while the cover is up, the rack drops to 50 and goes under it with every other
  layer of `UiRoot`. At that moment the card and the toasts cannot both hold
  their order, and §4.3 decides it: the card stays above the cover.

The overlay layer itself stays under the cover, so a confirm sheet (52 inside
it) cannot be pressed upright.

**Owed on hardware, before the `m7` tag.**

- [ ] the twelve rows above on the reference iPhone and a 360-dp Android, in the
      browser and installed — above all the two that are a matter of feel: the
      stick at 60 % travel, and whether the zone ghosts read as a hint rather
      than as clutter.
- [ ] the edge swipe on a real Android and on iOS, where the system Back is a
      gesture rather than a button, and a reload mid-run followed by Back (36-g).
- [ ] desktop: Escape through pause, settings and a confirm sheet one layer at a
      time, and an alt-tab mid-fight.

## SPEC-038 — Threat I: the dash, committed attacks and storms that fight back (M7g)

- **Build:** `spec/SPEC-038` — untagged
- **Devices:**
  - desktop — headless Chromium 1280 × 720 (Playwright, Linux container, **software GL / SwiftShader**)
  - phone — headless Chromium 844 × 390, touch + mobile emulation, and the
    SPEC-037 phone matrix (a physical handset still owes the human pass)

Recorded from the container the branch was built in: `npm run check` (90
files, 1685 tests), `node scripts/assets/check.mjs` (audio 4.52 MB of 12 MB)
and the suites named below. The §7 list is a desktop-and-phone pass and is owed
before the `m7` tag; each row names the automated evidence that stands in for it.

**Verified here, by name.**

| §7 item | Evidence in this branch |
|---|---|
| Dash through a wurmling's charge lane and see it miss; let one hit | `tests/systems/enemyAi.test.ts` — the three duels against a 6.12 m/s player (a straight retreat 4.5 m ahead is hit by the charge; a 90° turn 0.25 s into the windup is missed; a perpendicular dash pressed 0.3 s in takes nothing), contact × 1.3 with 1 m of knockback and 0.5 s of recovery, a whiff's 0.9 s; `e2e/SPEC-038.spec.ts` case 4 (`surface-spawn-charger` draws a lane within 3 s of game time, `enemy:windup` says `charge`) |
| A skitter pack reaches a retreating player; a dash saves it | `tests/systems/enemyAi.test.ts` (a skitter 1.85 m behind a 6.12 m/s retreat lands; a rooted rusher windup whiffs), `tests/systems/dash.test.ts` (5 m in twelve steps, i-frames block at +0.25 s and not at +0.35 s, through a skitter's body, stopped at a rock and at the wall) and `e2e/SPEC-038.spec.ts` cases 1–3 (V, the right mouse button and DASH on touch; `qb-dash` rings and is ready again inside 1.5 s of game time) |
| Play `c1_s2` to the end: the storm wave comes into the cave, the heatwave ramps in | `e2e/SPEC-038.spec.ts` cases 6 and 7 (`stormWave` reads `cinder4_storm` with `wave:started`, `-` once the stage is done; `weatherDps` ≤ 0.3 after 1 s and 1.30 after 11 s), `tests/systems/weather.test.ts` (the ramp, Cinder-4's 0.65, `c1_s2`'s 90 s in the open ≤ 70 % of the chapter-1 player) and `tests/systems/missions.test.ts` (`surviveWave()`) |
| Switch to casual from the pause menu mid-fight, then back | `e2e/SPEC-038.spec.ts` case 8 (the row, `aria-pressed`, the save, a reload; no row on the unbound main menu), `tests/systems/combat.test.ts` (the next hit reads it live, casual weather × 0.7, windups × 1.25) and `tests/systems/flight.test.ts` (`setDifficulty`) |
| The DASH button in the thumb arc, and its ring | `e2e/SPEC-038.spec.ts` case 3 and `e2e/SPEC-037.phone.spec.ts` case 5 at every phone size (`touch-dash` inside `arc-primary`, which now takes pointer events) |
| The windup cues of a charge, a shot and a skitter | `tests/core/audioReactions.test.ts` (the three cues, their floors and volumes; the crit thud at 1.0) and the rebuilt `surface` bank (`dash`, `windup_melee`, `windup_charge`, `windup_shot`) |

**The field.** `tests/systems/threat.test.ts` plays the kite bot of §6.1 for
3 min × 4 seeds per planet on `medium` in the chapter reference kit: Cinder-4
14.3 %/min (23 % from blows and charges), Vetra 10.5 % (17 %), Thessaly 5.2 %
(75 %), Ferrum 18.2 % (75 %), the Hive 19.2 % (62 %) — no deaths. Before this
spec the same bot took 0–12 %, all of it from projectiles. Auto-fire's lead
lands 43 % of 30 s of Kinetic fire on a strafing raider at 10 m (seed 1).

**Re-landed on SPEC-039** (after #57's revert). §6.1 now runs 16 seeds: Cinder-4
11.2 %/min (27 % from blows and charges), Vetra 13.2 % (22 %), Thessaly 5.6 %
(57 %), Ferrum 9.8 % (74 %), the Hive 23.9 % (60 %, three deaths in sixteen
runs). On seeds 1–4 alone the Hive read 27.2 %, over the cap: seed 2 is a death
spiral at 65 % a minute.

**The budget (AC-39).** `e2e/SPEC-038.spec.ts`'s last case draws a circle and a
ring (`surface-telegraphs`, dev only) beside a charger's lane on `medium` and
reads ≤ 96 draws with all three telegraph kinds live; the view adds at most
three, none with the pool empty (`tests/views/telegraphView.test.ts`).

**Owed on hardware, before the `m7` tag.**

- [ ] the six rows above on desktop and the reference phone — above all the two
      that are a matter of feel: whether a lane reads early enough to sidestep,
      and whether the dash's 1.36 s cooldown feels like an answer or a tax.
- [ ] the four new sounds heard rather than asserted: the dash's whoosh and the
      three windup cues under a real fight's guns.

## SPEC-039 — builds that matter: signature drops, classes, the arsenal and honest numbers (M7g)

- **Build:** `spec/SPEC-039` — untagged
- **Devices:**
  - desktop — headless Chromium 1280 × 720 (Playwright, Linux container, **software GL / SwiftShader**)
  - phone — the `phone-landscape` project's matrix (`SPEC-037.phone.spec.ts`); a
    physical handset still owes the human pass

Recorded from the container the branch was built in: `npm run check` (88 files),
`e2e/SPEC-039.spec.ts` (9 cases), and the suites the change could move —
`SPEC-009`, `SPEC-010`, `SPEC-011`, `SPEC-012`, `SPEC-013`, `SPEC-014`,
`SPEC-020`, `SPEC-025`, `SPEC-028`, `SPEC-029`, `SPEC-031`, `SPEC-032`,
`SPEC-034`, `SPEC-035`, `SPEC-036`, `SPEC-037` and the phone matrix. The §7 list
is a desktop-and-phone pass owed before the `m7` tag; each row names the
automated evidence that stands in for it here.

**Verified here, by name.**

| §7 item | Evidence in this branch |
|---|---|
| Follow the Refit line into Vetra with the Laser, the Weave and the Scanner Drone | `SPEC-039.spec.ts` case 3 (a new save reads `Refit for Vetra: Composite Weave 39 · Scanner Drone 20 · Laser Carbine 39`; bought through the shop, it reads `Refit for Vetra: ready`; with every planet landed on there is no line) and `tests/ui/helpers.test.ts` for `refitText` (the Ferrum gate as `Shield tier 2 88 (required)`) |
| Kill the Wurm and pick up the Rocket Launcher; replay `c1_m3` and see lithium | case 6 (`sceneInfo.signatureDrops` 1 on a first kill, `signatureFallbacks` 1 with the launcher owned) and `tests/systems/combat.test.ts` (each boss's piece, 25 lithium in orbs on a replay or an owned piece, half the XP on a replay). The replay itself was not flown here: the arena's `replay` flag is covered by `bossStageMission` and `isReplay` in `tests/systems/missions.test.ts` |
| Read the Chaingun's card and row against the Laser, and fire both | cases 1 and 2 (`DPS 110 firing · 64 sustained`, `DPS 36 → 64` against the Kinetic Repeater a new save wears), `tests/ui/helpers.test.ts` for Laser → Chaingun, `tests/systems/arsenal.test.ts` for the delivered rates, and `SPEC-029.spec.ts` case 2 for the lock |
| Reach level 5, spend the point, and read the toast | case 7 (`1 attribute point to spend`, a cancelled sheet spends nothing, a confirmed vigor point reads `184/184 HP`) and `tests/systems/progression.test.ts` for `Level 5 — … · +1 attribute point` |
| Stand in a storm with a Field Medic and watch it wait | `tests/systems/combat.test.ts` — nothing regenerated under weather ticks, a 1 s wait after the last one, heal-over-time still healing, a coolant pack keeping the medic running |
| With the Engineer at tech 8, check a companion's discounted price | `tests/systems/economy.test.ts` (0.15 + 0.24 on a companion; with a level-3 Quartermaster, 0.54 capped at 0.40) and case 9 (`−5% shop prices`, no `craft`) |

**What the e2e runs showed besides.** With four workers, the heavy surface
batch (`SPEC-011`, `SPEC-012-missions`, `SPEC-013`, `SPEC-034`) failed
`SPEC-012-missions.spec.ts:131` — the 60 s forced-storm survive stage against a
110 s wall-clock deadline — and the same batch on untouched `main` (ad7e582)
failed the same line, alongside `SPEC-034.spec.ts:191`. Run alone, the missions
case passed twice. `SPEC-013.spec.ts:210` (`holding` read as `recalled`, one run in
seven here) is the idle 95 s warp of a pilot whose save has no fixed seed: the
Cinder-4 waves shoot a ship that never moves or fires. Simulated over seeds
1–400 through `systems/Flight` with the suite's pilot, that warp is recalled 27
times with ARIA's regeneration at ×1 (`main`) and 23 times at SPEC-039's ×1.1,
and no seed is recalled only at ×1.1 — the only SPEC-039 change on that path.

**Owed on hardware, before the `m7` tag.**

- [ ] the six rows above on desktop and on the reference phone — above all the
      two that are a matter of feel: firing the Chaingun against the Laser, and
      whether the Medic's pause makes a storm feel dangerous rather than unfair.
- [ ] a real replay of `c1_m3` from the board, to see the lithium on the ground.

## SPEC-016 — the played campaign, device checklists and the perf run (M5/M7)

- **Build:** `spec/SPEC-016` — untagged
- **Devices:**
  - desktop — headless Chromium 1280 × 720 (Playwright, Linux container, **software GL / SwiftShader**)
  - desktop, production build — the same browser against `vite preview` over `dist/`
  - phone — _not run: no handset in the build container_ (§13's pass is owed, below)

Recorded from the container the branch was built in: `npm run check`, which
now runs typecheck, then `vite build`, then `npm run test` (D-27) — 95 files and
1,915 tests with none skipped, so the six emitted-build tests of
`tests/build/pwa.test.ts` ran against the `dist/` that same command had just
built; `npx vitest run tests/campaign` in 0.59 s (30 tests); and
`e2e/SPEC-016.spec.ts` (cases 1–7 of §12.2 and D-18's lost context, in six
tests, 39 s with five workers).

**The played campaign.** Every number §4.7 pins came out of the harness as
written: the worst case at 5,480 XP, level 13, 970 earned and 609 spent; the
Hive held to 180.0 s with 3.1 s of holding (32.1 s at the 1.2 notch); the
completionist at 11,135 XP, level 19, 1,224 earned and 683 spent over seven
jumps; and the base-hold run's `c3_s2` collect starting at 350 + 300 against a
cap of 400 and shipping the surplus home, 26 missions and `problems: []`.

**The perf run, in-container.** `?perf=5&quality=low&films=off` on the
production build: the surface opened without the dev bridge (which is absent
there), the run held 20 live enemies in the sandstorm, and the card showed one
row — a software-GL floor, not a device number:

| Date | Build | Scene | Preset | dpr | Size | fps | p95 ms | Draws | Triangles | Update ms | Render ms | Heap MB | Enemies | Storm |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-09-30 | ReaLLM 0.0.0 | surface/cinder4 | low | 1.00 | 1280×720 | 11.8 | 144.50 | 38 | 102164 | 0.30 | 0.50 | 31.6 | 20 | sandstorm |

**Owed on hardware, before the `m7` tag (§13).**

- [ ] `?perf&quality=medium` on the deployed build, on the reference phone and on
      desktop: the card after about 65 s, its lines read at arm's length, Copy
      puts the row on the clipboard or selects it, and the pasted row renders
      under the header above.
- [ ] the first group of each checklist walked on the phone, to confirm it reads
      as a list a person can follow.

## SPEC-041 — Threat II: bosses with moves, packs with leaders, flight that aims (M7g)

- **Build:** `spec/SPEC-041` — untagged
- **Devices:**
  - desktop — headless Chromium 1280 × 720 (Playwright, Linux container, **software GL / SwiftShader**)
  - phone — _not run: no handset in the build container_ (§7's pass is owed, below)

Recorded from the container the branch was built in: `npm run check` — 96
files and 2,007 tests with none skipped — and, one file per invocation or a
few together, `e2e/SPEC-041.spec.ts` (§6.2's seven cases and the AC-37 budget,
all green), `e2e/SPEC-006.spec.ts`, `SPEC-011`, `SPEC-012`, `SPEC-013`,
`SPEC-023`, `SPEC-038`, `SPEC-039` and `flight-env`.

**The bot suites** (`tests/systems/threat.test.ts`, seeds 1–6 per boss, the
post-SPEC-039 reference kit with its Rocket rotation, three medkits):

| Boss | Kite: time to win | Kite: max HP lost | Reader | Dasher | Stand |
| --- | --- | --- | --- | --- | --- |
| Dune Wurm | 50–53 s | 58–89 % | 0–7 % | 0 % | ≥ 253 %, dies |
| Frost Matriarch | 39–40 s | 37–52 % | 0 % | 0 % | ≥ 199 % |
| Hive Broodlord | 43–44 s | 36–76 % | 0 % | 0 % | ≥ 251 %, dies |
| Ash Titan | 45 s | 97–107 % | 0 % | 0 % | ≥ 253 %, dies |
| Hive Queen | 45–51 s | 49–84 % | 0 % | 0 % | ≥ 252 %, dies |

The field suite on the same kit, 16 seeds × 3 minutes: 3.3–17.3 % of max HP a
minute (Vetra lowest, the Hive highest), 42–86 % of it from blows and charges,
and 0.77–0.90 aggroed enemies within 12 m on every planet. The gauntlet's
Ferrum run: `c4_s2` completed in 16 of 16 seeds at ARIA level 2, and no recall
in 16 of 16 at level 1; the Hive's two existing cases stay 16 of 16.

**Owed on hardware (§7).**

- [ ] each boss fought once with the recommended loadout on desktop and the
      reference phone: its moves read from their decals, the Matriarch's nova
      dashed through, the Titan's fissures and the Queen's dive sidestepped,
      the ring tried and recalled from;
- [ ] a death to the Wurm, coming back at the arena's mouth;
- [ ] a pack led by a mender and a bulwark elite, plates read;
- [ ] Ferrum at ARIA level 1 then 2: the lead pip found, the reticle following
      it at level 2, the hit ticks heard.

## SPEC-042 — feedback in play: the mission banner, loot, effects, danger and the boss frame (M7f)

- **Build:** `spec/SPEC-042` — untagged
- **Devices:**
  - desktop — headless Chromium 1280 × 720 (Playwright, Linux container, **software GL / SwiftShader**)
  - phone — the `phone-landscape` project's Chromium phone (Pixel 7 landscape, touch, `isMobile`) at every
    `PHONE_VIEWPORTS` size; _no handset in the build container_ (§7's pass on the reference Android phone is owed, below)

Recorded from the container the branch was built in: `npm run check` — 98
files and 2,059 tests with none skipped, `tests/ui/missionBanner.test.ts`'s
eleven among them — and, a few files per invocation,
`e2e/SPEC-042.spec.ts` (§6.2's fourteen cases and five more — the Queen's
modal chain twice, a banner behind the Wurm's reveal, a flight mission's
banner and the restarts line — twenty tests, all green under five workers),
`e2e/SPEC-042.phone.spec.ts` (§6.3's three cases at all six sizes, eighteen
tests, all green), and the neighbours this spec touches: `SPEC-006`'s
reactions case (the 26 / 44 pins), `SPEC-011`, the three `SPEC-012` files,
`SPEC-013`, `SPEC-014`, `SPEC-023`, `SPEC-024`, `SPEC-027`, `SPEC-028`,
`SPEC-029`, `SPEC-031` (the named rung), `SPEC-034`, `SPEC-035`, `SPEC-037`
with its whole phone matrix, `SPEC-038`, `SPEC-039` (the compare lines),
`SPEC-041`, `pause`, `smoke`, `touch-controls`, and the `pwa` and `mobile`
projects. Under four or five workers three cases outside this spec failed once
each — `SPEC-006`'s crossfade timing, and `SPEC-012`'s survive-stage restart
(its own dialogue helper's unguarded click) and CARGO FULL count — and each
passed on a rerun: `SPEC-006` whole on two workers, the two `SPEC-012` cases
on two workers and the CARGO FULL case four times over under four.

What the container showed, on the scene clock (`sceneInfo.viewTime`) where the
criterion is one:

| Signal | Observed |
| --- | --- |
| Banner (`c1_m1`) | `Mission complete` · `Dry Land` · `+100 XP · +10 tokens · +20 oil` · `Next: Black Gold — at the pad terminal`; up more than 3.5 and at most 5 scene seconds; `c1_m1_done` started in the tick it went, never while it was up; still up 1 s after a 3 s pause; then faded by `mission-banner-out`, 150 ms to opacity 0 — and no animation at all under reduce motion |
| Banner after a modal `onComplete` (`c5_m3`) | the Warden's line, then ARIA's, both modal, with no banner; the banner (`Her Majesty`, `+600 XP`) once ARIA's had gone — and, with ARIA's `once` line already heard, once the Warden's had |
| Banner behind a beat | a `c1_m1` banner up when the Dune Wurm's reveal started: hidden on every frame of the reveal, back after it, more than 3.5 and at most 5 scene seconds on screen in all; `c1_m1_done`, queued behind it, started only once it had gone — never under the reveal's caption |
| Banner in flight (`c4_s2`) | the eighth scav fighter shot down on the way to Ferrum: `Mission complete` · `Salvage Rights` · `+150 XP · +15 tokens`, no next line, the flight HUD's top centre's last row |
| Loot | `Picked up Coolant Pack`; with twenty full slots one `Inventory full — Coolant Pack left on the ground`, never `×2` while the pickup retried |
| Effects | `☂ 30 s` in the `Lv N` row from `C`, ≤ 28 s two scene seconds later; the row and the tracker kept their place at every phone size |
| Danger | `hud-lowhp` (static, no pointer) and `qb-heal.is-urgent` at 15 % HP; in flight, at 20 % hull |
| Death | `Killed by Dust Skitter` with a tip; Space at 0.5 s ignored, Space at 1.2 s respawned well before 2.5 s; on `c1_m1`'s survive stage, `Restarts: Survive`, cleared at the respawn |
| Beats | `Stage 2/3 — Scan Dune Sea`; `▲ Wave incoming` under the shelter chip for between 2.5 and 3.5 scene seconds |
| Levels | the level-up toast up between 3.6 and 4.8 s, `is-levelled` between 1.6 and 2.8 s (both wall clock, as their timers are); `XP 149 / 150` on the 6 px bar; `character-xp` at the station |
| Shop | `Crafted Medkit ×2`; the Plasma Lance's card over a worn Laser Carbine: `↑ T1 → T2 …`, `↓ fire rate 4 → 3` |
| Frames | `hud-boss` at least 280 px wide at 1280 × 720 with one tick (the Wurm's 0.4), `Phase 2` at the burrow; `hud-target` reading `Alpha Dust Skitter` / `Elite` / its affix, gone within 3.5 scene seconds of showing |
| Haptics (emulated phone) | `surface-hurt-from` recorded `[15]`; with Vibration unchecked, nothing; a desktop context recorded nothing and shows no row |
| Recall | `Emergency recall` and `Hull breached — ARIA flew you home. The jump's fuel is spent; your cargo is safe.` |

**Owed on hardware (§7).** On desktop and the reference Android phone, from a
fresh save:

- [ ] finish `c1_m1` and read the banner, then ARIA's line after it;
- [ ] pick up an elite's drop with room in the inventory, and with the inventory full;
- [ ] use a coolant pack and watch its timer run down in the `Lv N` row;
- [ ] fall below a quarter of HP (the edge, the heal slot's outline), then die
      to a skitter and read the cause and the tip;
- [ ] fight the Dune Wurm through its phase turn (the ticks, `Phase 2`), and hit
      an elite to see the target frame;
- [ ] craft medkits and buy a rung, reading each toast and the compare arrows.

On the phone only:

- [ ] feel the hits, a weapon lock, a death and a completion;
- [ ] then turn Vibration off in Settings and feel nothing.

## SPEC-043 — missions worth replaying: side rewards, bonus objectives, contracts and hard (M7g)

- **Build:** `spec/SPEC-043` — untagged
- **Devices:**
  - desktop — headless Chromium 1280 × 720 (Playwright, Linux container, **software GL / SwiftShader**)
  - phone — the `phone-landscape` project's Chromium phone at every `PHONE_VIEWPORTS` size, for the
    banner's layout only; _no handset in the build container_ (§7's pass on the reference phone is owed, below)

Recorded from the container the branch was built in: `npm run check` — 98
files and 2,131 tests, none skipped — and, a few files per invocation,
`e2e/SPEC-043.spec.ts` (§6.2's seven cases in nine tests, all green under two
workers), `SPEC-006`'s reactions case (the 26 / 45 pins), `SPEC-042` whole
(25 tests; case 1f now reads Salvage Rights' new 60 oil), `SPEC-042.phone`'s
banner case at all six sizes, and the neighbours this spec touches:
`SPEC-012-missions`, `SPEC-013`, `SPEC-014`, `SPEC-024`, `SPEC-030`,
`SPEC-034`, `SPEC-035`, `SPEC-038`'s Settings cases, `SPEC-039` and `SPEC-041`.

What the container showed:

| Signal | Observed |
| --- | --- |
| Board, new save | `mission-c1_m2-bonus` reads `Bonus: Under 4:00 → +2 Frag Grenade`, `c1_m3`'s `Bonus: No deaths → +1 Demolition Charge`; no bonus row on `c1_m1` |
| Board, chapter 1 done | `c1_m2`'s replay button reads `Contract · No cover · 75 % + 20 lithium` (seed 123, first landing), its badge `No cover` with the blurb as its title, its rewards `+112 XP · +11 ◈ · +20 lithium`; without `chapter1_done` it reads `Replay 50% rewards` and has no badge |
| Contract in play | accepted at the board, landed: `sceneInfo.contract` = `no_cover`; finished: `mission-complete-contract` `Contract · No cover`, rewards `+112 XP · +11 tokens · +20 lithium · contract`, lithium +20 exactly; `sceneInfo.contract` back to `-` |
| Bonus | `c1_m3` finished with no death: `Bonus: No deaths — +1 Demolition Charge`, a time row, and one charge in the pack; after a death: `Bonus missed: No deaths`, and no charge |
| Hard | Settings' `Hard` pressed, its line under the row, `save.meta.difficulty` and `sceneInfo.difficulty` `hard`; the Dune Wurm then woke at 2250 HP (1800 × 1.25) and the elite chance read 0.1; creation's `difficulty-hard` made a hard save |
| Best time | `c1_m2` accepted on the pad terminal and finished: a `Time m:ss` row, `bestTimes.c1_m2` in `reallm:settings`, and `mission-c1_m2-best` reading `Best m:ss` on the board |
| Phone banner | on the 802 × 293 phone the rewards and the new rows run together as one line, and the banner keeps to the upper half |

**Owed on hardware (§7).** On desktop and the reference phone:

- [ ] finish `c1_s2` holding the heatwave in the open, and read the banner's bonus row;
- [ ] die once during `c1_m3` and see the bonus missed;
- [ ] after chapter 1, replay `c1_m2` as a contract and play its modifier;
- [ ] switch to hard mid-chapter and feel the difference;
- [ ] read your best times on the board.

## SPEC-044 — focus and flow: keys, focus, the station's next step and honest screens (M7f)

- **Build:** `spec/SPEC-044` — untagged
- **Devices:**
  - desktop — headless Chromium 1280 × 720 (Playwright, Linux container, **software GL / SwiftShader**)
  - phone — the `phone-landscape` project's Chromium phone at every `PHONE_VIEWPORTS` size, for the
    neighbours' layouts only; _no handset in the build container_ (§7's pass on the reference phone is owed, below)

Recorded from the container the branch was built in: `npm run check` — 100
files and 2,179 tests, none skipped — and, a few files per invocation,
`e2e/SPEC-044.spec.ts` (§6.2's thirteen cases in twenty-one tests — 1b, 1c, 6b,
8b, 8c, 9b, 10b and 13b beside them — all green under four workers, the key cases
twice over), the three pins §4.10 and §4.11 move (`SPEC-007`, `SPEC-024`,
`SPEC-043`), and the neighbours this spec touches: `SPEC-003`, `SPEC-005`, `SPEC-006`,
`SPEC-008` to `SPEC-011`, the three `SPEC-012` files, `SPEC-013`, `SPEC-014`,
`SPEC-015` (desktop, `mobile` and `pwa`), `SPEC-017`, `SPEC-019`, `SPEC-020`,
`SPEC-022`, `SPEC-023`, `SPEC-025` to `SPEC-029`, `SPEC-031`, `SPEC-032`,
`SPEC-034` to `SPEC-036`, `SPEC-037` with its whole phone matrix, `SPEC-038`,
`SPEC-039`, `SPEC-040`, `SPEC-041`, `SPEC-042` with its phone matrix,
`boot-gate`, `dev-skip-flight`, `lifecycle`, `pause`, `scene-cycle`, `smoke`,
`stats-overlay`, `surface-env` and `touch-controls`. Under four workers seven
cases outside this spec failed once each and passed on a rerun: `SPEC-026`
cases 4 (a 1.5 s walk that lit nothing new on a crawling frame clock) and 5,
and `SPEC-034` case 7 (both in their own `dismiss` helper's unguarded click on
a line that had moved on by itself — case 7 is on the known-flaky list from
`main`), `SPEC-012`'s CARGO FULL count (the toast gone between its two reads),
`SPEC-019`'s reduce-motion fade (not faded inside its 5 s sampling window),
`SPEC-011`'s surface bed (the `?scene=` jump not landed inside 5 s) and
`SPEC-036` case 17's zone ghosts (their 12 s clock ran out during a slow
landing; green in the same file's earlier run on this branch).

After QA's first pass, two fixes followed. AC-9: a modal now falls past a
control that cannot take focus, so the gear card opens on Close while its Buy
is disabled. AC-17: the pause menu's Controls now shows the one
`controls-sheet`. They added cases 8b and 8c and rewrote case 9. The file's
twenty-one tests then ran green twice under four workers. So did the cases in
other files that drive the pause menu's `pause-sheet`: `SPEC-034` case 4,
`SPEC-036` case 13 at all five short phones and in flight, `SPEC-036` case 16
and `SPEC-037` case 13. `npm run check` again counted 100 files and 2,179 tests.

What the container showed:

| Signal | Observed |
| --- | --- |
| Modal line by keyboard | `intro_command` took focus as `role="dialog"` / `aria-modal="true"`; `dialogue-next` read `▸ Enter` once the line had typed out, with no animation or transition; at most six Enters 0.35 s apart ended it, and focus went back to `station-tab-missions` |
| Grace, repeat, Space / E / F | a Space dispatched in the task that opened the line, and a repeated Enter 0.4 s later, left it as it was; fresh Space, E, F and Space each filled the line they found or moved it on — judged in the page at the press — and none reached the game |
| Non-modal line | the Scav's line on Cinder-4 stayed a log with no cue and no focus; Space left it as it was and the game took it as play; Enter filled it and then moved it on to ARIA |
| A modal above a line | with the pause menu over `intro_command` and focus on the menu itself, Enter and E left the line alone; Escape resumed, focus came back to the line, and Enter read it |
| Creation | no class pressed, `Choose a class to continue` beside the disabled Confirm, `creation-back` left of it; Enter on `class-marine` removed the reason; Enter twice on `attr-might-plus` spent two points and kept its focus; the last point disabled it and focus went to a neighbour; `Might — +4 % damage per point`, `Agility — +2 % speed · +2 % crit chance · −3 % dash cooldown per point`; the card reads `Might 3 · Vigor 3 · Agility 1 · Tech 1` |
| Creation's Back | with a name typed: `Leave without creating a salvager?` on `Stay`; Leave reached the menu with no slot key written; Escape opened the same sheet and a second Escape stayed; untouched, Escape and the browser's Back both went straight to the menu |
| Station rail | three `role="tab"` buttons in `Station`'s tablist; ArrowDown then Enter opened the Shop with focus on its tab; Home, End and the wrap; the panel a `tabpanel` labelled by the tab; `Star Map ›`, `Settings` and `Quit to menu` after the rule with no role and no pressed state |
| Next step | `c2_m1` accepted by Enter: `Accepted 'Whiteout'`, `Next: Star Map → depart for Vetra`, the actions `Star Map` (primary), Pin, Abandon with focus kept in the row, and the rail's Star Map primary; `Star Map` opened the map on Vetra with Depart focused; `◆` on Vetra and Cinder-4 (`missions waiting`), none on locked Ferrum |
| Preselection | with `c1_s1` tracked and Vetra open, the map opened on Cinder-4; a locked Ferrum given fell through to Cinder-4; arrowed onto Ferrum, Depart disabled and focus went to Back |
| Pad terminal | E opened it on `terminal-accept-c1_m2`, as a dialog on the back-stack; the row reads `Main`, `+150 XP`, the brief's first sentence (all of it after a tap on the title), and `c1_m1` reads `Replay · 50 %`; Enter accepted, `Accepted 'Black Gold'`, `Black Gold — Stage 1/…` marked `Tracked` and no `◈`; twenty Tabs and three Shift+Tabs stayed inside; Escape closed it and the back-stack lost one entry |
| Sheets | the board's Abandon opened on `confirm-no`, Enter kept the mission and focus went back to Abandon |
| Gear card and stay card | on a fresh save the Hand Cannon's card opened on `gear-card-close`, its Buy disabled; with 500 tokens it opened on `gear-card-buy`; Tab stayed inside, and Escape gave focus back to Details. The stay-ending card opened as a dialog on `ending-continue`, and Enter continued |
| Controls | `settings-controls` opened `controls-sheet` on `controls-close` with `Continue a transmission` and `Back / close`; Escape closed one layer at a time, focus walking back to `settings-controls`, then `station-tab-settings`; the pause menu's Controls docked the same `controls-sheet`, with the same rows, in its `pause-sheet` beside the actions. Closed, it held nothing, and Settings opened from there left the panel's sheet as the only one |
| Menu settings | the arrows stayed inside the panel; Escape gave focus back to `menu-settings`, and the arrows walked the menu again |
| Save & Quit | on Ferrum: `Quit to the main menu?`, `You will resume at Command Relay. Flying back to Ferrum costs 100 oil, and timed objectives restart.`, `Keep playing` focused and Enter on it kept the pause menu; Quit saved slot 0 and reached the menu. In flight: `The fuel for this jump (100 oil) is already spent.` |
| Credits | `Google Gemini`, `Apache License 2.0` and `Play prologue`; `Asset licences` opened `assets/LICENSES.md` in a new tab; no `ending_escape`, `SPEC-`, `PLAN R` or table rule on the screen |
| Storage | a version-99 slot read `Slot 2 · Save from a newer version` with Export only; a corrupt slot's Delete asked `Delete slot 3 and its backup?` on `confirm-no`; Cancel kept both keys, Delete removed the slot and its backup |
| Board words | `In progress`, `New`, `Locked`, `Needs: Complete 'Black Gold'`, `Done · replay for 50 %`, `Main`, `Side`, `Tracked`; `Completed (1)` closed, opened by its summary, still open after a pin; with chapter 1 done, `c1_m2`'s contract outside the fold after the open work, and Cinder-4 with no fold |

**Owed on hardware (§7).** On desktop, keyboard only after START:

- [ ] create a salvager, and read the intro;
- [ ] accept a mission, open the star map and depart;
- [ ] on Cinder-4, accept at the pad terminal;
- [ ] pause, open Settings and the Controls sheet, and close everything with Escape;
- [ ] quit to the menu and read the cost sheet.

On the reference phone:

- [ ] tap through the same path, and check that the cue reads `▸ Tap`.

Then, on either:

- [ ] read the credits and the storage block.

## SPEC-045 — settings and accessibility: sections, scale, motion, colour and one voice (M7f)

- **Build:** `spec/SPEC-045` — untagged
- **Devices:**
  - desktop — headless Chromium at 1280 × 720, 1920 × 1080, 1920 × 1000 (screen 1920 × 1080) and
    2560 × 1080 (Playwright, Linux container, **software GL / SwiftShader**)
  - phone — Chromium's 844 × 390 touch context and the `phone-landscape` matrix, for the scheme's rows
    and the neighbours' layouts only; _no handset in the build container_ (§7's pass is owed, below)

Recorded from the container the branch was built in: `npm run check` — 104
files and 2,280 tests, none skipped — and, a few files per invocation,
`e2e/SPEC-045.spec.ts` (§6.2's seventeen cases in twenty-one tests, all green
under four workers), the files whose literals §4.10 moves (`SPEC-012`,
`SPEC-013`, `SPEC-014`, `SPEC-027`, `SPEC-034`, `SPEC-036`, `SPEC-039`,
`SPEC-042` and the two phone matrices), and `SPEC-006`, whose `sfxBuses` pin
holds. Under four workers on software GL, five cases outside this spec ran out
of their in-game time (`SPEC-006` ×3, `SPEC-012` ×2, `SPEC-036` 17, one
`SPEC-037.phone` dialogue tap); each passed alone.

| Area | What the container showed |
|---|---|
| Hold | Slow, typewriter off: `c3_m3_done`'s 82-character line stayed 7 s and gave way to ARIA's line before 9.5 s |
| Manual | `c2_m3_done`'s first line still up after 15 s with `▸ Enter`; Enter showed the second |
| Comms log | `station-tab-comms` listed Earth Command then ARIA, in their colours; Escape gave focus back to the rail; `pause-comms` opened it on the surface; after the menu it read `No transmissions yet.` |
| Sections | six titled sections in order; Mouse steer and UI scale on the keyboard, Joystick side and Button size on touch |
| Reduce motion | the toggle pressed shake Off, flash Subtle, films Stills and cleared typewriter; Films → Video left the other three; the store matched |
| UI scale | 150 % at 1280 × 720: the quick bar 1.5 × as wide about the same centre, every corner box in view; 115 % and 130 % at 1920 × 1080: no overlaps; 1920 × 1000 on a 1080 screen read 115 % without storing it |
| Text size | 140 %: the reading text 1.4 × (25.2 / 19.6 px), `hud-hp` unchanged, no `.ui-btn` clipped |
| Ultrawide | 2560 × 1080: `.hud-tl` at 320 px, `.hud-br` ending at 2240 px, the vignette 2560 px wide |
| Plain text, colour | no uppercase, 0.02 em; the dialogue at 1.55; `✓` / `✗` / `▲` toasts; the colour-blind borders `rgb(63, 182, 255)` and `rgb(255, 138, 31)` |
| Words, formats | `Health`, `Gadget slot`, the touch throttle's `+` / `−`; no `\d%`-style text in the station, star map, settings or either HUD; `Throttle 1.0×` |
| Sound, brightness, invert | `ui_blip` at 0.5 and `bug_pop` at 1 with Interface at 50 %; Mono folded Howler's master gain to one channel; +30 % brightness read exposure 1.3 on the menu; Invert turned W the other way |

**Owed on hardware (§7).** On desktop:

- [ ] play a chapter at Normal and read every non-modal line; switch to Manual in a fight and read a missed line in the comms log;
- [ ] try each UI scale at 1920 × 1080 and 1280 × 720, and each text size in the station and the settings panel;
- [ ] turn Reduce motion on, then Films back to Video, and watch a departure;
- [ ] play a surface stretch with Plain text, then with the colour-blind preset — a purchase refusal, a purchase, and enemies on Eden;
- [ ] check Brightness in Ferrum and on Vetra's snow.

On the reference phone:

- [ ] the settings rows match the phone (no Mouse steer, a Button size row);
- [ ] Text size 140 % — a dialogue, a toast and the station;
- [ ] Mono with one earbud in.

## SPEC-046 — props that look like their art, and only what is on screen (M7i)

- **Build:** `spec/SPEC-046` — untagged
- **Devices:**
  - desktop — headless Chromium at 1280 × 720, and 320 × 180 at a device ratio of 3 for the sharp case
    (Playwright, Linux container, **software GL / SwiftShader**)
  - phone — _no handset in the build container_ (§7's pass is owed, below)

Recorded from the container the branch was built in: `npm run check` — 105
files and 2,334 tests, none skipped — and the e2e files the spec names, a few
per invocation: `e2e/SPEC-046.spec.ts` (§6.2's six cases in ten tests),
`e2e/surface-env.spec.ts` (nine tests, the spawn ratchet folded into the six
per-planet medium frames) and `e2e/SPEC-018.spec.ts`'s two clamp cases, all
green under three or four workers. After the tufts became one-triangle cards,
`e2e/SPEC-046.spec.ts` and surface-env's Thessaly and Eden frames ran green
again.

**The spawn frame on `medium`** (seed 20121, 1280 × 720, 30 frames after
landing, props drawn from their GLBs, the tug on the pad):

| Planet | Draws | Triangles | Static instances drawn | Last cull |
|---|---|---|---|---|
| Cinder-4 | 38 | 19,592 | 3 | 0.2 ms |
| Vetra | 40 | 23,582 | 0 | 0.4 ms |
| Thessaly | 43 | 24,838 | 3 | 0.3 ms |
| Ferrum | 45 | 26,224 | 3 | 0.2 ms |
| The Hive | 39 | 29,096 | 2 | 0.4 ms |
| Eden | 33 | 18,834 | 4 | 0.3 ms |

The spawn's view is mostly the pad's 15 m clearing, where nothing is
scattered, so a handful of static instances is what is there to draw; the
ratchet's 60 k holds with room on every planet.

| Area | What the container showed |
|---|---|
| Scatter, seed 20121, `medium` | Cinder-4 324 bones + 130 pebbles = 25,928 triangles; Thessaly 600 tufts + 240 spores = 6,000. A tuft is two crossed cards of one triangle each (the quads were 4 triangles), which brings Thessaly under AC-14's 7,000 with §4.4's counts, placement, mask and colours unchanged — §4.4's table, at 4-triangle tufts, says 7,200. The quads hung the mask upside down (a `DataTexture`'s first row is v = 0); the cards stand it on the ground |
| The rect | the rig's rect from the look-at point misses 3–9 m of what a camera turned toward its 2 m look-ahead sees; widening it to the frustum's own ground corners left nothing outside, over 64 headings and four screen shapes |
| Moving | `surface-goto-occluder` on Cinder-4 (seed 20121) changed `instancesDrawn` and faded a desert ruin; at seed 123 no GLB prop on Cinder-4 can hide the salvager's head — the rocks are 0.5-unit slabs |
| The tug | `sceneInfo.tug` 1 on all six planets; a held walk from the spawn stopped at the hull, 3.9–6 m from the pad's centre, with `Open pad terminal` up; `surface-goto-pad` then E opened the terminal |
| Sharp | dpr 1.5 → 2 after the toggle on a 3× screen; with `slowDraw(40)` the governor stepped it below 2 inside 30 s |
| Meshopt | a GLB with `EXT_meshopt_compression` in `extensionsRequired` decoded to the same floats as its plain twin (node); three's bare loader refuses it |

**Owed on hardware (§7).** On the laptop (`high`, DPR 2) and the reference
phone (`medium`), on all six planets:

- [ ] Cinder-4's rocks read sandstone, Vetra's boulders snow and ice, not blue; no facets at 22 m;
- [ ] both variants of each kind appear; landmarks are visible from 20 m;
- [ ] Cinder-4's bones and the tufts read at play distance; Thessaly and Eden are different greens;
- [ ] the tug sits on every pad, clear of the pylons, and fades when it hides the salvager;
- [ ] walking across Thessaly, nothing pops in at the screen's edges;
- [ ] on the phone, `Sharp rendering` visibly sharpens `medium`;
- [ ] a before/after screenshot pair per planet and the `?perf` row on `medium`.

## SPEC-048 — the story listens: conditions, clues, notes and the Warden's notice (M7h)

- **Build:** `spec/SPEC-048` — untagged
- **Devices:**
  - desktop — headless Chromium at 1280 × 720 (Playwright, Linux container, **software GL / SwiftShader**)
  - phone — _no handset in the build container_ (§7's pass is owed, below)

Recorded from the container the branch was built in: `npm run check` — 108
files and 2,433 tests, none skipped — and, a few files per invocation,
`e2e/SPEC-048.spec.ts` (§6.2's eleven cases in thirteen tests, with the c4_m3
banner order and the cave and landmark shortcuts), the files whose pins §4.9
moves (`SPEC-006`, `SPEC-009`), `SPEC-044` (its intro line now reads the
bound save's name) and `SPEC-012-missions` (chapter 1 end to end, through the
raider's line and the echo), all green under one to four workers.

| Area | What the container showed |
|---|---|
| Placeholders | at the station, a save named Vega: `Earth Command to tug CR-62. Vega, you are cleared for the Cinder-4 approach.`, and the comms log kept the filled line |
| The notice | Ferrum, echo and log found: modal, `held` 1, `instance/62. Containment level 4. Token balance 0.`, eight lines; the log listed the echo and the log, not the towers |
| c4_m3 | `surface-finish-stage` on the delivery: the notice first, the banner after its last line |
| A dwell clue | `surface-goto-wreck` on Cinder-4 (seed 123): `Tug-class hull. Earth pattern, older paint.` inside 15 s of wall clock, `clue_hull` set, `cluesFound` 1 |
| E75 | Manual speed, five `c1_s1_done` queued: the dwell reached 4 s and started over with the flag unset; after the queue was read, the next dwell set it |
| Notes | `pause-comms` wore the dot; `Recorded 1 of 15`, `Command rating 0.97 — a good run`, two `— not recorded —` in chapter 1, uppercased by CSS; the arrows switched the tabs; reopened, no dot. At the station the echo dotted `station-tab-comms`, Notes took it down, focus came back to the rail |
| The board | `mission-c1_s2-irregular` read `Irregular reading`; gone once `clue_scav_echo` was set |
| Replay | `c1_m1` replayed from the pad terminal: its accept line only, and the `Dry Land` banner |
| Bodies | `scavBodies` 1 on a landing with `c1_m1` active, 2 after `c1_s2_echo`, still 2 after a second echo, 0 with `c1_m1` done. Medium, both down, adaptive quality off: 40 draws and 26,424 triangles (budget 96 and 130 k) |
| Covers, caption, kills | the echo ended on `That line again…`; `interlude_c3` at 8 s read `The towers were not alien.` with `scaffold_secret`, its own line without; `c5_m1_accept` said `Six kills.` |

**Owed on hardware (§7).** On desktop and the reference phone:

- [ ] play chapter 1 from a fresh save on the main path only: the pad body is there when the scav speaks, a raider's dying words repeat the warning, and no line reads a raw `{…}`;
- [ ] shelter in a Cinder-4 wreck through a storm and read `wreck_cinder4`;
- [ ] play `c1_s2` and see the second body;
- [ ] open Notes from the pause menu and the station: the count, the rating and the records;
- [ ] with a save at chapter 4, finish `c4_m3`: the notice holds the world and names what was found, and the banner follows it;
- [ ] replay `c1_m1` and hear only its accept line.
