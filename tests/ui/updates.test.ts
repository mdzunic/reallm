// SPEC-015 §10 — the service-worker update channel and the two overlays that
// hang off it. All three are DOM-light enough to run in node with a stub
// element tree; what matters is *who* gets an Update button (AC-52) and that
// nothing applies an update on its own (15-c).
import { afterEach, describe, expect, it, beforeEach, vi } from 'vitest';
import {
  applyUpdate,
  hasOfflineWorker,
  offerUpdate,
  offlineStatus,
  offlineText,
  registeredStatus,
  resetUpdates,
  setOfflineStatus,
  updateReady,
  type OfflineStatus,
} from '@/core/Updates';
import { INSTALL_STEPS } from '@/ui/InstallHint';
import { stripComments } from '../architecture/source';

describe('the update channel (SPEC-015 §10, D-10)', () => {
  beforeEach(() => resetUpdates());

  it('offers nothing until a registration says a build is waiting', () => {
    expect(updateReady()).toBe(false);
    // …and applying nothing is a no-op, not a throw: the menu may be open
    // before a worker has ever registered.
    expect(() => applyUpdate()).not.toThrow();
  });

  it('applies the waiting build exactly when asked, and never on its own', () => {
    let applied = 0;
    offerUpdate(() => applied++);
    expect(updateReady()).toBe(true);
    // Offering it is not applying it — that is the whole of `prompt` mode.
    expect(applied).toBe(0);
    applyUpdate();
    expect(applied).toBe(1);
  });

  it('keeps the last offer, so a second download replaces the first', () => {
    const calls: string[] = [];
    offerUpdate(() => calls.push('first'));
    offerUpdate(() => calls.push('second'));
    applyUpdate();
    expect(calls).toEqual(['second']);
  });
});

describe('who may offer an update (AC-52)', () => {
  const RAW = import.meta.glob<string>('../../src/**/*.ts', { query: '?raw', import: 'default', eager: true });
  /** Code only: a rule that bans a shape must not also ban writing it down. */
  const SOURCES: Record<string, string> = Object.fromEntries(
    Object.entries(RAW).map(([file, source]) => [file, stripComments(source)]),
  );

  it('is the menu and the station, and nowhere else', () => {
    const callers = Object.entries(SOURCES)
      .filter(([file, source]) => !file.endsWith('/core/Updates.ts') && /\bapplyUpdate\s*\(/.test(source))
      .map(([file]) => file)
      .sort();
    expect(callers).toEqual(['../../src/scenes/MenuScene.ts', '../../src/scenes/StationScene.ts']);
  });

  it('never reloads the page off the back of a worker', () => {
    // 15-c: an auto-reload mid-mission would be a data-loss bug. The only
    // `location.reload` in the tree is the context-lost offer of SPEC-002 E7,
    // the dev-server hot-update guard and the menu's Reload while another tab
    // holds a slot (SPEC-007 07-a, review 2026-10 B-04) — a press, at the
    // menu — none of which is an update.
    const reloaders = Object.entries(SOURCES)
      .filter(([, source]) => /location\s*\.\s*reload\s*\(/.test(source))
      .map(([file]) => file)
      .sort();
    expect(reloaders).toEqual(['../../src/core/Game.ts', '../../src/main.ts', '../../src/ui/SavePanel.ts']);
    for (const file of reloaders) expect(SOURCES[file], file).not.toMatch(/serviceWorker/);
  });

  it('listens for the typed event rather than controllerchange (D-10)', () => {
    const overlay = SOURCES['../../src/ui/UpdateOverlay.ts'] as string;
    expect(overlay).toContain("'app:update-ready'");
    // In `prompt` mode the waiting worker never takes over, so this never fires.
    expect(overlay).not.toContain('controllerchange');
  });
});

describe('the iOS install explainer (AC-55)', () => {
  it('names the two taps iOS needs, in order', () => {
    // The toast of SPEC-007 §4.7 says *why* the game wants to be on the Home
    // Screen; this says *how*, because no browser will do it on anyone's
    // behalf and Safari offers no install prompt at all.
    expect(INSTALL_STEPS).toHaveLength(3);
    expect(INSTALL_STEPS[0]).toContain('Share');
    expect(INSTALL_STEPS[1]).toContain('Add to Home Screen');
  });

  it('opens off the hint the save store raises, and nothing else', () => {
    const RAW = import.meta.glob<string>('../../src/**/*.ts', { query: '?raw', import: 'default', eager: true });
    const sources: Record<string, string> = Object.fromEntries(
      Object.entries(RAW).map(([file, source]) => [file, stripComments(source)]),
    );
    const emitters = Object.entries(sources)
      .filter(([, source]) => /emit\(\s*'app:install-hint'/.test(source))
      .map(([file]) => file);
    expect(emitters).toEqual(['../../src/core/Save.ts']);
    // …and exactly one thing listens: the overlay the composition root mounts.
    expect(sources['../../src/ui/InstallHint.ts']).toContain("'app:install-hint'");
    expect(sources['../../src/main.ts']).toContain('new InstallHintOverlay(uiRoot, events)');
  });
});

describe('offline play (SPEC-040 §4.7, AC-29)', () => {
  beforeEach(() => resetUpdates());
  afterEach(() => {
    vi.unstubAllGlobals();
    resetUpdates();
  });

  it('names each status the way Settings shows it', () => {
    const texts: Record<OfflineStatus, string> = {
      ready: 'Offline play: ready',
      downloading: 'Offline play: downloading…',
      waiting: 'Offline play: starts after your first visit to the station',
      unsupported: 'Offline play: not in this build',
    };
    for (const [status, text] of Object.entries(texts) as [OfflineStatus, string][]) {
      expect(offlineText(status)).toBe(text);
    }
  });

  it('round-trips through setOfflineStatus, and resetUpdates puts back the starting value', () => {
    // A test run is a dev build with no service worker: `unsupported` (§4.7).
    const start = offlineStatus();
    expect(start).toBe('unsupported');
    for (const status of ['waiting', 'downloading', 'ready', 'unsupported'] as const) {
      setOfflineStatus(status);
      expect(offlineStatus()).toBe(status);
    }
    setOfflineStatus('ready');
    resetUpdates();
    expect(offlineStatus()).toBe(start);
  });

  it('reads a registration as ready only when its worker is active and controls the page', () => {
    vi.stubGlobal('navigator', { serviceWorker: { controller: {} } });
    expect(registeredStatus({ active: {} })).toBe('ready');
    expect(registeredStatus({ active: null })).toBe('downloading');
    expect(registeredStatus(undefined)).toBe('downloading');
    // A first visit: installed, but nothing controls this page yet.
    vi.stubGlobal('navigator', { serviceWorker: { controller: null } });
    expect(registeredStatus({ active: {} })).toBe('downloading');
  });

  it('knows a returning visit — a controller, or a registration — from a first one', async () => {
    vi.stubGlobal('navigator', { serviceWorker: { controller: {}, getRegistration: async () => undefined } });
    expect(await hasOfflineWorker()).toBe(true);
    vi.stubGlobal('navigator', { serviceWorker: { controller: null, getRegistration: async () => ({}) } });
    expect(await hasOfflineWorker()).toBe(true);
    vi.stubGlobal('navigator', { serviceWorker: { controller: null, getRegistration: async () => undefined } });
    expect(await hasOfflineWorker()).toBe(false);
    vi.stubGlobal('navigator', {
      serviceWorker: {
        controller: null,
        getRegistration: async () => {
          throw new Error('SecurityError');
        },
      },
    });
    expect(await hasOfflineWorker()).toBe(false);
    vi.stubGlobal('navigator', {});
    expect(await hasOfflineWorker()).toBe(false);
  });
});

describe('the worker waits for the station (SPEC-040 §4.7, AC-28, AC-30)', () => {
  const RAW_MAIN = import.meta.glob<string>('../../src/main.ts', { query: '?raw', import: 'default', eager: true });
  const MAIN = stripComments(Object.values(RAW_MAIN)[0] as string);

  it('registers once, immediately, from inside registerOfflineWorker', () => {
    expect(MAIN.match(/registerSW\(/g) ?? []).toHaveLength(1);
    const body = MAIN.slice(MAIN.indexOf('function registerOfflineWorker'));
    expect(body).toMatch(/^function registerOfflineWorker\(\): void \{\s*if \(workerRegistered\) return;\s*workerRegistered = true;/);
    expect(body).toContain('immediate: true,');
    // SPEC-015 §10's offer is unchanged (AC-30).
    expect(body).toContain('onNeedRefresh: () => offerAppUpdate(() => void updateSW(true)),');
    expect(body).toContain("onOfflineReady: () => setOfflineStatus('ready'),");
  });

  it('runs at the first station entry, and at boot only for a returning player', () => {
    expect(MAIN).toMatch(/'scene:entered',\s*\(\{ id \}\) => \{\s*if \(id === 'station'\) registerOfflineWorker\(\);/);
    expect(MAIN).toMatch(/hasOfflineWorker\(\)\.then\(\(returning\) => \{\s*if \(returning\) registerOfflineWorker\(\);/);
    // Nothing registers at module load any more.
    expect(MAIN).not.toMatch(/^const updateSW = registerSW/m);
  });

  it('tries again at the next station entry after a failed registration (40-k)', () => {
    const onError = MAIN.slice(MAIN.indexOf('onRegisterError'));
    expect(onError).toMatch(/workerRegistered = false;\s*setOfflineStatus\('waiting'\);/);
  });
});
