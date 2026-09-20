// The service-worker update channel (SPEC-015 §10, D-10, 15-c).
//
// `registerType: 'prompt'` means a new build downloads and then *waits*: it
// never takes over on its own, because an auto-reload mid-fight would lose
// field progress. So there are exactly two moving parts here — a flag saying
// a build is waiting, and the one call that applies it — and both live in a
// module with no imports, so `ui/` and `scenes/` can read the flag without
// either of them knowing what a service worker is.
//
// The composition root fills it in from `virtual:pwa-register` (`main.ts`);
// everything else reads it. Until a worker is registered the flag is false and
// no Update button is built anywhere, which is the correct answer to "no update
// exists".

/** What applies the waiting build. `null` until a registration offers one. */
let waiting: (() => void) | null = null;

/**
 * A build is downloaded and waiting. Called by `main.ts` from the plugin's
 * `onNeedRefresh`, which also emits `app:update-ready` on the bus so open
 * screens can add their button without polling.
 */
export function offerUpdate(apply: () => void): void {
  waiting = apply;
}

/** Whether to build an `Update` button at all (AC-52). */
export function updateReady(): boolean {
  return waiting !== null;
}

/**
 * Apply it: `updateSW(true)` activates the waiting worker and reloads. Only the
 * menu's and the station's buttons call this — the two screens where losing the
 * current frame costs nothing (15-c). A no-op when nothing is waiting.
 */
export function applyUpdate(): void {
  waiting?.();
}

/** Tests only: put the channel back to "nothing waiting". */
export function resetUpdates(): void {
  waiting = null;
}
