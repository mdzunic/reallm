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
  - desktop, hardware GPU — _not yet run: no display in the build container_
  - phone — _not yet run: no device and no LAN in the build container_
- **Measurements** (headless Chromium, `?debug`, `menu`, 1280×720, preset
  `medium`, effective dpr 1.00 — software rasterisation, so treat the frame
  cost as a floor, not a device number):
  - fps 59.98 · ms/frame 16.67 · updates/frame 1–2 · draws 3 · tris 120 ·
    geo 3 · tex 4
  - `dropped 0.18s`, all of it in the first frames after the gate, where asset
    upload and the first scene transition share one frame: the 250 ms clamp
    absorbing a boot hitch is exactly the behaviour E23 asks for.
- **Checklist (SPEC-001):**
  - [x] `npm ci && npm run check` green on a clean clone — 12 files, 102 tests,
        typecheck and production build clean
  - [x] `npm run e2e` green headless — 51 tests across 12 suites
  - [x] `npm run dev` serves `ReaLLM` on 5173, canvas and `#ui` overlay present
        (`e2e/smoke.spec.ts`); **opening it on a phone over LAN is still open**
  - [x] architecture tests pass (import boundaries, `Math.random` ban)
- **Checklist (SPEC-002 §7):**
  1. [x] Desktop: the rotating object turns and the loop holds 60 fps
        (`e2e/boot-gate.spec.ts`, the numbers above); resizing and rotating the
        viewport keep the drawing buffer at CSS size × dpr within 1 px on both
        axes, so nothing stretches (`e2e/resize.spec.ts`)
  2. [ ] Phone over LAN: renders, rotates, DPR clamp visible in the overlay —
        **needs a real device**
  3. [ ] Lock the phone for 30 s and unlock: no burst of updates, audio resumes
        after the tap — **needs a real device**. The update side is covered
        headless (`e2e/lifecycle.spec.ts`: no catch-up, `dropped` flat across a
        hidden period) and in node (`tests/core/loop.test.ts`, including the
        case where the hidden tab issues no animation frames at all); the audio
        side is a null seam until SPEC-006
  4. [x] Chrome: `Simulate context loss` shows the panel and the scene
        continues after the restore; the no-restore button surfaces `Reload`
        after 5 s (`e2e/context-loss.spec.ts`)
  5. [x] Asset spike: `character.glb` loads through `GLTFLoader`, is cloned with
        `SkeletonUtils.clone` and plays its `Idle` clip through an
        `AnimationMixer` advanced from `update(dt)`; `ship.glb` renders with its
        colour map reporting `srgb` (`e2e/asset-spike.spec.ts`)
  6. [x] `npm run check` and `npm run e2e` green
- **Bugs:** none open. Two found and fixed while building SPEC-002: the debug
  event log could print an entry out of order because `frame:order` is
  formatted a refresh after it is recorded (AC-32), and the fixed-step
  accumulator ran one update where two were due because `1/60` has no exact
  binary representation (AC-2).
- **Notes:** the two device rows above are the only part of the M0 definition of
  done that is still open, and both need hardware this build environment does
  not have. Everything they would confirm has a headless or node equivalent
  recorded here, but neither replaces the device: fill in rows 2 and 3, the
  phone line under **Devices** and a second set of measurements from real
  hardware before tagging `m0`.
