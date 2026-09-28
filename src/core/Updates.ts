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
// exists". SPEC-040 §4.7 adds the offline status beside it, and the module
// still has no imports.

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

// ------------------------------------------ SPEC-040 §4.7: offline play
//
// The worker no longer registers on the first page load: a first visit spends
// its bandwidth on the boot and the prologue, not a 21 MB precache. It
// registers at the first station entry — or at boot for a returning player,
// whose worker already controls the page — and this status is what Settings
// shows about it. `main.ts` owns the registration; this module owns the
// answer, and the two probes that would otherwise put `serviceWorker` in a
// file that reloads the page (tests/ui/updates.test.ts).

export type OfflineStatus = 'unsupported' | 'waiting' | 'downloading' | 'ready';

/** The page's service-worker container, or `null` where there is none (node, old browsers). */
function workers(): ServiceWorkerContainer | null {
  const nav = (globalThis as { navigator?: { serviceWorker?: ServiceWorkerContainer } }).navigator;
  return nav?.serviceWorker ?? null;
}

/** A dev server registers no worker at all, and some browsers have none to register. */
function startingStatus(): OfflineStatus {
  return import.meta.env.DEV || workers() === null ? 'unsupported' : 'waiting';
}

let offline: OfflineStatus = startingStatus();

export function offlineStatus(): OfflineStatus {
  return offline;
}

export function setOfflineStatus(status: OfflineStatus): void {
  offline = status;
}

const OFFLINE_TEXT: Readonly<Record<OfflineStatus, string>> = {
  ready: 'Offline play: ready',
  downloading: 'Offline play: downloading…',
  waiting: 'Offline play: starts after your first visit to the station',
  unsupported: 'Offline play: not in this build',
};

/** The `settings-offline` note for a status (SPEC-040 §4.7). */
export function offlineText(status: OfflineStatus): string {
  return OFFLINE_TEXT[status];
}

/**
 * What a fresh registration means: a worker that is active and already
 * controls this page has the app cached; anything else is still installing,
 * and `onOfflineReady` says when it is done.
 */
export function registeredStatus(registration: { readonly active: unknown } | undefined): OfflineStatus {
  return registration?.active && workers()?.controller ? 'ready' : 'downloading';
}

/**
 * True for a returning player: a worker controls the page, or a registration
 * exists. Those register at boot, so SPEC-015's update offer still reaches the
 * menu (40-l); everyone else waits for the station.
 */
export async function hasOfflineWorker(): Promise<boolean> {
  const container = workers();
  if (container === null) return false;
  if (container.controller !== null) return true;
  try {
    return (await container.getRegistration()) !== undefined;
  } catch {
    return false;
  }
}

/** Tests only: put the channel back to "nothing waiting", and the status to where it starts. */
export function resetUpdates(): void {
  waiting = null;
  offline = startingStatus();
}
