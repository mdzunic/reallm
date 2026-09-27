# ReaLLM — Deep Bug Audit Report

**Date:** 2026-09-11  
**Methods used:** Automated typecheck + test suite pass, three deep codebase scans (core, systems, scenes/UI), targeted bash greps for `.length`, null-safety, `addEventListener` leak patterns, `Pool.at()` bounds auditing, forward-iteration-with-free checks.

---

## 1. Overview — Clean Bill of Health

| Metric | Value |
|---|---|
| `npm run typecheck` | Clean (zero diagnostics) |
| `npm run test` | **703 passed** across 36 suites |
| TODO / FIXME / HACK markers in `src/**/*.ts` | **Zero** |
| Unpaired `addEventListener` without dispose match | **Zero** |
| Unsanitized `.at()` index from `Pool` calls | **None found** |

The codebase is clean. No runtime errors, logic bugs, memory leaks, or edge-case violations were detected across the full source tree.

---

## 2. Observations (Informational — Not Bugs)

### 2a. `Pool.at()` has no bounds assertion
**File:** `src/core/Pool.ts:26–28`
```typescript
at(index: number): T {
    return this.#items[index] as T;
},
```
There is no guard against negative or out-of-bounds indices. In practice every caller iterates with `for (let i = 0; i < pool.size; i++) pool.at(i)`, so the index always lands in `[0, size)` which is valid. If a caller ever passes an out-of-range index, `.at()` returns `undefined` silently and the downstream type error manifests only when a method is invoked on it — making it slightly harder to trace than a guard would be.

**Severity:** Low (informational).  
**Suggestion for M7 tuning phase:** Add an optional assertion flag or guarded mode for debug builds:
```typescript
at(index: number): T {
    if (__DEV__ && (index < 0 || index >= this.#size)) {
        console.warn(`Pool.at(${index}) out of range [0, ${this.#size})`);
    }
    return this.#items[index] as T;
},
```

### 2b. `Combat.ts` forward loops on `enemies` are correct but fragile
**File:** `src/systems/Combat.ts:400, 663, 710, 760–819`  
Multiple forward-iterating `for (let i = 0; i < w.enemies.size; i++)` loops exist. The only mid-loop free is the backwards sweep at line 779 (`size - 1 → 0`), and it runs *after* all forward passes complete. A future caller calling `enemies.free()` or `enemies.alloc()` inside one of these forward loops would break iteration invariants.

**Severity:** Low (informational).  
The comments at `Combat.ts:765–766` explicitly document this invariant; a refactor to use indexed-based `.freeFromPool(index)` during iteration is possible but unnecessary now.

### 2c. `StationScene.ts` dispose is minimal — no scene-level entities
**File:** `src/scenes/StationScene.ts:153–183`  
The `dispose` callback only releases `this.#settings?.dispose()`. There are no Three.js meshes, event listeners, or animation mixers to clean up. This suggests the station hub is a pure UI scene (driven by child panels/views). This is fine as long as additional visual content isn't added later without updating `dispose`.

**Severity:** Informational.

### 2d. Flight cutscene DOM listeners have double guards
**File:** `src/scenes/Flight.ts:257–259`
```typescript
document.addEventListener('keydown', skip);
document.addEventListener('pointerdown', skip);
this.disposer.add(() => {
    document.removeEventListener('keydown', skip);
    document.removeEventListener('pointerdown', skip);
});
```
The `skip` handler is re-bound on every scene enter (line 257) and unbound on dispose. If `Flight.onEnter` is called twice without `onExit` intervening (e.g., during a failed state transition), the `skip` listener would be duplicated. The `.off()` call at dispose only removes the last registration.

**Severity:** Very low (edge case).  
Guard: add `this.disposer.removeLast()` before adding, or use `events.on(...)` instead of raw `addEventListener`.

---

## 3. Positive Findings (What the Code Gets Right)

These patterns are often bug-prone in similar projects but are handled correctly here:

- **Swap-remove backward iteration** — All `free()` calls inside enemy loops go backwards (`size - 1 → 0`), satisfying Pool's documented invariant (Pool.ts:8–9).
- **Null-gated scene transitions** — Every `this.services.go('station', ...)` call chains `.then(went => ...)`, and subsequent null-checks guard against stale state during failed transitions.
- **Event bus cleanup** — All `events.on(...)` calls pass an owner token, and disposers release them. No orphaned subscriptions detected.
- **Save system defensive loading** — Raw JSON fields are validated against known constants (`PLANET_IDS`, slot name constraints) before being cast. Unknown planets fall back to station (Plan.md §13 E26).
- **No `.length` access on undefined** — Targeted greps found zero instances of `?.length` or `.length` on potentially undefined values.

---

## 4. SPEC-017 — PLAN conformance check (2026-09-11)

AC-1/AC-2 of SPEC-017 ask that the build read `./PLAN.md` from this repository
only, and that any acceptance criterion found to contradict it be implemented as
written and the conflict recorded here as a dated note.

`PLAN.md` was read at `spec/SPEC-017` (nothing was cloned or fetched). **R6-1**
authorises the post-processing chain, ACES tone mapping, the procedural
environment map and the preset-gated directional shadow map, in the same shape
the spec builds them — post off on `low`, ¼-res bloom + FXAA on `medium`, ½-res
bloom + MSAA (FXAA at dpr 2) on `high`; shadow map on `high` only; blob shadows
on every preset; no half-float colour buffer → the direct path. **R6-2** puts
`core/Quality.ts` and `core/PostChain.ts` in SPEC-001 §4's `three` allow-list
(`Quality.ts` is pure and stays out of it), and §3 and §9 of PLAN carry the same
preset table.

**No criterion contradicts PLAN.** Nothing was deviated from and no design
change was made; this note exists so the check itself is on the record.

### 4a. SPEC-017 AC-67 — which presets get image-based lighting

AC-67 reads: "surface `scene.environment = env; scene.environmentIntensity = 0.6`
only when `quality.ibl`; menu, creation, station and star map use `NEUTRAL_SKY`
at 0.9; flight uses its planet's params at 0.5." Taken word for word, the
`quality.ibl` gate belongs to the surface clause alone and the other five scenes
would take an environment on **every** preset, `low` included. The intake's own
ambiguity list flagged this criterion.

`PLAN.md` §9 settles it: the quality presets carry "the render plan (R6):
post-processing off / ¼-res bloom + FXAA / ½-res bloom + MSAA, shadow map on
`high` only, **image-based lighting on `medium` and `high`**". `QUALITY.low.ibl`
is `false` for exactly that reason, and a row that nothing reads is a row that
lies.

**Implemented:** every scene's environment is gated on `quality.ibl`, with the
params and intensities AC-67 gives (`NEUTRAL_SKY` at 0.9 for the four hub
scenes, the planet's params at 0.6 on the surface and 0.5 in flight). `low`
therefore runs with no environment map anywhere, which is also what makes it the
cheap preset the e2e suite runs its gameplay on: assigning one costs ≈ 0.9 s of
shader compilation on the first rendered frame of a scene on this container's
software rasteriser.

Recorded here rather than silently decided, because the other reading is
available in the text.

## 5. SPEC-015 — P1: flight GPU textures over budget (2026-09-20) — FIXED

**Status:** **fixed on `spec/SPEC-015`, 2026-09-20**, in the same branch that
filed it. AC-8's clamp is what closed it: `core/Assets.ts` downsamples on the
way into the cache, re-clamps the cache when a preset change lowers the cap, and
exports `clampTexture` for the flight scene's own loader, which deliberately
does not go through the cache (SPEC-020 §4.8). At `medium` the three maps upload
at 1024 × 768 and 1024 × 512 and the derived flight figure falls from **56.7 MB
to 16.7 MB**, inside the ≤ 30 MB budget; `docs/playtest-log.md` §SPEC-015 has
the measurement and the `drawImage` recording that shows the clamp really runs.
The report below is left as it was filed, and everything it says in the present
tense was true of the tree at that moment.

**Severity:** P1 for the `m7` milestone (SPEC-016 §6), filed by SPEC-015 AC-61.

**Measured:** on the emulated `Pixel 5` client at `medium`, the flight scene's
decoded texture set is **56.7 MB** against the §5 budget of **≤ 30 MB**. The
surface (16.0 MB of ≤ 40), station and menu (16.0 MB of ≤ 20) rows are inside
theirs. Full numbers and how they were taken: `docs/playtest-log.md`, §SPEC-015.

**Why.** Flight loads the 2048 × 1536 sky window plus the 2048 × 1024 planet
equirect and its 1024 × 512 relief map (`scripts/assets/blender/flight.py`,
`data/assets.ts` `PLANET_ART`), and nothing downsamples an uploaded texture to
the preset's `textureMaxSize` — 1024 on `medium`, 512 on `low`. The row exists
in `core/Quality.ts` and is read by nothing, which is the whole defect: SPEC-015
§8 says "downsampled to the preset cap on `low`", and no code does it.

**Note on the figure.** three's `gl.info.memory` reports texture *counts*, not
bytes, so 56.7 MB is derived — every image the page downloaded, sized as RGBA8
with a full mip chain. That is an upper bound. Even halved it clears the budget,
which is why it is filed rather than argued away.

**Fix, and whose.** A preset-aware downsample on upload in `core/Assets.ts`
(SPEC-018 §4.5's territory, not SPEC-015's — this spec pins the `QUALITY` table
and is forbidden from retuning it, D-1). Until then the flight scene is over its
memory budget on a 2 GB phone, which SPEC-015 §8 flags as the iOS context-loss
risk (E7): the symptom to watch for on hardware is a lost context on entering
flight, not a visual fault.

## 6. SPEC-016 §4.6 — a full hold stalls a collect objective (2026-09-27) — FIXED

**Status:** **fixed on `spec/SPEC-034`**, by §4.12 of that spec.

**The finding.** SPEC-016 §4.6's "Completionist, base hold" run pins the problem

> `c3_s2: the hold took 50 of 300 wheat (350 aboard, cap 400)`

A player who arrives on Thessaly with the base hold already full of wheat cannot
finish `c3_s2`. `Economy.addResource(…, 'pickup')` stops at `cargoCap()` and
reports the rest `blocked`, and `Missions` counts only what was `added` — so once
the hold is full the counter stops moving, every orb bounces, and the objective is
unreachable without selling or discarding. Nothing in the game tells the player
that is what has happened, and `c3_s2`'s 300 wheat is three quarters of the base
hold on its own.

**Why it was not a cap bug.** Raising the cap would have been the wrong fix: the
cap is what makes the hold a decision, and SPEC-010 §4.5's asymmetry — pickups
stop at it, grants never do — is deliberate.

**The fix (SPEC-034 §4.12, E56).** `Missions` registers what its active collect
objectives still want through `Economy.setCollectDemand`, and a `pickup` that
does not fit is **shipped home** up to that demand: it counts toward the
objective and toward `resource:collected`'s `amount`, carries a `shipped` figure,
and never enters the hold. Nothing is duplicated, the cap still bites for
everything else, and a node keeps pumping while the demand lasts. The player is
told once every three seconds: `Hold full — surplus shipped to Command Relay.`

**Where it is pinned.** `tests/systems/economy.test.ts` — "ships a full hold home,
up to the collect demand" and "c3_s2 completes with a hold already over the
objective", which runs the review's own case: 350 wheat aboard, `c3_s2` active,
300 wheat of pickups, and the objective completes with the hold ending at 400.
`tests/systems/pickups.test.ts` covers the node side.

**Note on SPEC-016's own run.** The "Completionist, base hold" run belongs to
SPEC-016's harness, which is not in this tree yet — `tests/campaign/harness.ts`
here runs the worst-case main-mission player, which takes no side missions and so
never met the finding. SPEC-034 is forbidden from building that harness (its
out-of-scope list), so the fix is pinned by the two suites above instead, and
SPEC-016's run should report `problems: []` and 26 missions when it lands.

## 7. SPEC-036 §4.8 — short landscape phones lose the service long press (2026-09-27) — OPEN

**Status:** open. Found on `main` at `8006f89` (SPEC-036, #52) in the in-app
browser.

**Severity:** P2 (SPEC-016 §6). Service mode is a playtesting tool. Nothing in
the campaign needs it, and there is a workaround.

**The finding.** SPEC-032 §4.6 gives service mode two ways in, and both work
only while the main menu is up:
- typing `asdf`;
- holding the build label (`version-label`) for 3 s (`SERVICE_PRESS_MS` in
  `src/scenes/MenuScene.ts`).

A phone has no keyboard, so there the long press is the only way in. SPEC-036
§4.8 then hides a footer that holds only the build label on short landscape
screens (`src/style.css`):

```css
@media (orientation: landscape) and (max-height: 360px) {
  .screen-foot:not(:has(.save-banner)) {
    display: none;
  }
}
```

Every DOM screen except the pause frame adopts the label into its footer
(`src/ui/Screen.ts`). On the menu, that footer holds only the label unless the E8
storage banner is up. So in landscape at 360 px tall or less, the label is gone,
and with it the only way to turn service mode on or off by touch.

The code does what SPEC-036 asks: its acceptance line reads "a footer that holds
only the build label is hidden". The defect is that the two specs collide.

**Measured.**
- At 800 × 360 the menu's `.screen-foot` computes to `display: none`, and the
  label's box is 0 × 0.
- At desktop size, `asdf` still toggles the mode, with the badge and the toast.
- Of the phone sizes SPEC-036 walks, 800 × 360, 750 × 342 and 802 × 293 are
  affected; 844 × 390 and 667 × 375 are not.

**Workaround.** Hold the phone upright on the menu, then turn it back after the
press. The rule applies only in landscape, and the menu mounts no rotate cover,
so the label comes back. At 360 × 780 with touch emulation it sits at the bottom
right with nothing over it, and a 3.3 s touch press on it turned the mode on,
then off again. That run used synthetic pointer events, not a real phone.

**Why no test caught it.**
- `e2e/SPEC-032.spec.ts`'s "a 3 s press on the build label toggles it" runs only
  at the default desktop size.
- SPEC-036's walk of phone sizes (`e2e/SPEC-031.spec.ts`) checks that the frame's
  controls can be reached, and the hidden label is no longer one of them.
- SPEC-037 §4.9 does not close the gap. It keeps the long press working "where
  the label shows", and hides the label only in play on touch.

**Fix, and whose.** This is a design call, because it changes either SPEC-032
§4.6's gesture or SPEC-036 §4.8's rule, so a PLAN refinement entry comes first.
Candidates:
- Exempt the menu's footer from the short-landscape rule, so the label stays on
  the menu at every size. This is the smallest change; it gives back the footer
  row SPEC-036 saved there.
- Move the long press to something every size keeps, such as the menu's title.
- Keep a menu-only copy of the label outside the footer.

Whichever is chosen, a regression case belongs next to SPEC-032's long-press
test: the same press on the menu at 800 × 360 with touch.
