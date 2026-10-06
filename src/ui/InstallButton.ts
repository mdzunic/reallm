// The install button (SPEC-059 §4.6.5, §4.6.6). Module state, like
// `core/Updates.ts`: the composition root watches the window once, before the
// first scene — a browser may fire `beforeinstallprompt` early — and the menu
// and the station read what it kept.
//
// The button follows `beforeinstallprompt`, not `settings.installed` (§2): the
// browser knows whether the app can be installed. `installed` only silences
// the station's one-time toast, which shares `installHintShownAt` with iOS's
// Home Screen hint — one install nudge per device. iOS fires no prompt at
// all, so no button ever shows there and SPEC-015's sheet is unchanged.
import type { SettingsStore } from '@/core/Settings';

/** §4.6.6: what the station says once, after the first chapter. */
export const INSTALL_TOAST_TEXT = 'Install ReaLLM to play offline and keep your saves safe.';

/** Chromium's `beforeinstallprompt` — absent from the DOM typings. */
interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ readonly outcome: 'accepted' | 'dismissed' }>;
}

/** The kept prompt; a later one replaces it, and a press spends it. */
let kept: InstallPromptEvent | null = null;
let watching = false;
const listeners = new Set<() => void>();

function changed(): void {
  for (const listener of [...listeners]) listener();
}

/** `(display-mode: standalone)`, or iOS's `navigator.standalone`: launched as the installed app. */
function launchedStandalone(win: Window): boolean {
  if (typeof win.matchMedia === 'function' && win.matchMedia('(display-mode: standalone)').matches) return true;
  return (win.navigator as Navigator & { standalone?: boolean }).standalone === true;
}

/** Once, from `main.ts`, before the first scene. */
export function watchInstall(win: Window, settings: SettingsStore): void {
  if (watching) return;
  watching = true;
  win.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    kept = event as InstallPromptEvent;
    // The browser says the app is no longer installed.
    if (settings.get().installed) settings.set({ installed: false });
    changed();
  });
  win.addEventListener('appinstalled', () => {
    kept = null;
    settings.set({ installed: true });
    changed();
  });
  if (launchedStandalone(win)) settings.set({ installed: true });
}

/** Whether the menu shows `menu-install`: a prompt is kept. */
export function installAvailable(): boolean {
  return kept !== null;
}

/**
 * A press: the kept event's `prompt()`, once — called in the gesture, before
 * any await — and the event is dropped whatever the outcome (59-m), so the
 * button goes until the browser fires another.
 */
export async function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  const event = kept;
  if (event === null) return 'unavailable';
  kept = null;
  let shown: Promise<void>;
  try {
    shown = event.prompt();
  } catch {
    changed();
    return 'dismissed';
  }
  changed();
  try {
    await shown;
    return (await event.userChoice).outcome;
  } catch {
    return 'dismissed';
  }
}

/** Runs `listener` whenever a prompt is kept or spent, or the app is installed (59-n); returns the release. */
export function onInstallChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
