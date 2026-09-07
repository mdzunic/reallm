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
