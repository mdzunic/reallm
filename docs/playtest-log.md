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
  - [x] `npm run e2e` — the suites this spec touches or drives are green;
        `e2e/post-chain.spec.ts` is new, `resize`, `context-loss`,
        `stats-overlay` and `scene-cycle` were re-run
  - [x] `three` chunk inside the 200 KB budget (162 943 B)
  - [ ] hardware GPU and handset numbers — owed, see above
- **Bugs:** one found and fixed while building this: the dev stats overlay grows
  with its event log and, on a slow frame where the `frame:order` traces are
  long enough to wrap, reached the version label at the bottom of the screen and
  swallowed taps meant for it. The panel now takes no pointer events; only its
  two buttons do.
