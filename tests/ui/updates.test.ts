// SPEC-015 §10 — the service-worker update channel and the two overlays that
// hang off it. All three are DOM-light enough to run in node with a stub
// element tree; what matters is *who* gets an Update button (AC-52) and that
// nothing applies an update on its own (15-c).
import { describe, expect, it, beforeEach } from 'vitest';
import { applyUpdate, offerUpdate, resetUpdates, updateReady } from '@/core/Updates';
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
    // `location.reload` in the tree is the context-lost offer of SPEC-002 E7
    // and the dev-server hot-update guard, neither of which is an update.
    const reloaders = Object.entries(SOURCES)
      .filter(([, source]) => /location\s*\.\s*reload\s*\(/.test(source))
      .map(([file]) => file)
      .sort();
    expect(reloaders).toEqual(['../../src/core/Game.ts', '../../src/main.ts']);
    for (const file of reloaders) expect(SOURCES[file], file).not.toMatch(/serviceWorker/);
  });

  it('listens for the typed event rather than controllerchange (D-10)', () => {
    const overlay = SOURCES['../../src/ui/UpdateOverlay.ts'] as string;
    expect(overlay).toContain("'app:update-ready'");
    // In `prompt` mode the waiting worker never takes over, so this never fires.
    expect(overlay).not.toContain('controllerchange');
  });
});
