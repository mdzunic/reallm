# Playtest log

One section per milestone (SPEC-016 §3): the devices it was verified on, the
build, measured fps and draw calls, the checklist results, and the bugs found.
A milestone tag (`m0`…`m7`) requires `npm run check` green, the checklists
ticked here for desktop and one phone, zero open P0, and spec statuses updated
(SPEC-001 §11, SPEC-016 §6).

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
