// The screen wake lock (SPEC-015 §7). One owner, scene-scoped: `surface` and
// `flight` hold it while they are on screen and release it on the way out, so
// a phone left on the station screen is free to sleep. The unconditional
// boot-tap request that used to live in `core/Game.ts` is gone — "released
// elsewhere" is now true by construction (D-7, AC-39).
//
// A lock is lost whenever the page is hidden, so the hold re-requests on the
// way back (AC-38). Everything the browser can say no to — a missing API, a
// refusal, a rejected promise — is swallowed, and the refusal is logged once
// per hold rather than once per attempt (15-e, AC-40).
import { log } from '@/core/Log';

export interface WakeLockSentinel {
  release(): Promise<unknown>;
}

export interface WakeLockApi {
  request(type: 'screen'): Promise<WakeLockSentinel>;
}

/** The seams the hold needs; a structural port, so node tests fake all three. */
export interface WakeLockDeps {
  /** `navigator.wakeLock`; `undefined` on iOS < 16.4 and every desktop Safari. */
  wakeLock: WakeLockApi | undefined;
  hidden(): boolean;
  onVisibilityChange(handler: () => void): () => void;
}

/** The browser's own seams — what a scene gets when it passes nothing. */
export function browserWakeLockDeps(): WakeLockDeps {
  return {
    wakeLock: (navigator as Navigator & { wakeLock?: WakeLockApi }).wakeLock,
    hidden: () => document.hidden,
    onVisibilityChange: (handler) => {
      document.addEventListener('visibilitychange', handler);
      return () => document.removeEventListener('visibilitychange', handler);
    },
  };
}

/**
 * Take the lock and keep it until the returned function is called. Idempotent
 * to release; safe to call with no `wakeLock` at all, where it is a silent
 * no-op that still returns a releaser (AC-40).
 */
export function holdWakeLock(deps: WakeLockDeps = browserWakeLockDeps()): () => void {
  const api = deps.wakeLock;
  if (api === undefined) return () => {};

  let held: WakeLockSentinel | null = null;
  let released = false;
  let warned = false;
  let pending = false;

  const acquire = (): void => {
    if (released || pending || held !== null || deps.hidden()) return;
    pending = true;
    api.request('screen').then(
      (sentinel) => {
        pending = false;
        // The hold ended while the request was in flight: hand it straight back.
        if (released) {
          void sentinel.release().catch(() => undefined);
          return;
        }
        held = sentinel;
      },
      (error: unknown) => {
        pending = false;
        // 15-e: low-battery mode denies it. Once per hold, not once per retry.
        if (warned) return;
        warned = true;
        log.warn('wakelock', 'the screen wake lock was refused', error);
      },
    );
  };

  const onVisibility = (): void => {
    // Hidden drops the lock on the browser's side; visible is where it is worth
    // asking again (§7, AC-38).
    if (deps.hidden()) held = null;
    else acquire();
  };

  let stopWatching: () => void;
  try {
    stopWatching = deps.onVisibilityChange(onVisibility);
  } catch (error) {
    log.warn('wakelock', 'could not watch visibility; the lock will not be renewed', error);
    stopWatching = () => {};
  }
  acquire();

  return (): void => {
    if (released) return;
    released = true;
    stopWatching();
    const sentinel = held;
    held = null;
    void sentinel?.release().catch((error: unknown) => log.warn('wakelock', 'the wake lock would not release', error));
  };
}
