// SPEC-015 §7 — the scene-scoped screen wake lock. Everything the browser can
// say no to is a fake here: a missing API, a refusal, a rejected release.
import { describe, expect, it, vi } from 'vitest';
import { holdWakeLock, type WakeLockDeps, type WakeLockSentinel } from '@/core/WakeLock';

function harness(opts: { refuse?: boolean; hidden?: boolean } = {}): {
  deps: WakeLockDeps;
  requests: () => number;
  releases: () => number;
  setHidden(value: boolean): void;
} {
  let hidden = opts.hidden ?? false;
  let requests = 0;
  let releases = 0;
  const listeners = new Set<() => void>();
  const deps: WakeLockDeps = {
    wakeLock: {
      request: (): Promise<WakeLockSentinel> => {
        requests++;
        if (opts.refuse) return Promise.reject(new Error('NotAllowedError'));
        return Promise.resolve({
          release: (): Promise<unknown> => {
            releases++;
            return Promise.resolve();
          },
        });
      },
    },
    hidden: () => hidden,
    onVisibilityChange: (handler) => {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
  };
  return {
    deps,
    requests: () => requests,
    releases: () => releases,
    setHidden(value: boolean): void {
      hidden = value;
      for (const handler of [...listeners]) handler();
    },
  };
}

describe('holdWakeLock (SPEC-015 §7)', () => {
  it('requests on entry and releases on the way out (AC-38)', async () => {
    const h = harness();
    const release = holdWakeLock(h.deps);
    expect(h.requests()).toBe(1);
    await Promise.resolve();
    release();
    await Promise.resolve();
    expect(h.releases()).toBe(1);
  });

  it('re-requests when the page comes back (AC-38)', async () => {
    const h = harness();
    const release = holdWakeLock(h.deps);
    await Promise.resolve();
    // The browser drops the lock when the page hides; asking again while it is
    // hidden would only be refused.
    h.setHidden(true);
    expect(h.requests()).toBe(1);
    h.setHidden(false);
    expect(h.requests()).toBe(2);
    release();
  });

  it('is idempotent to release', async () => {
    const h = harness();
    const release = holdWakeLock(h.deps);
    await Promise.resolve();
    release();
    release();
    await Promise.resolve();
    expect(h.releases()).toBe(1);
  });

  it('swallows a refusal and logs it once per hold (AC-40, 15-e)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const h = harness({ refuse: true });
    const release = holdWakeLock(h.deps);
    await Promise.resolve();
    await Promise.resolve();
    h.setHidden(true);
    h.setHidden(false);
    await Promise.resolve();
    await Promise.resolve();
    expect(h.requests()).toBe(2); // it keeps trying…
    expect(warn).toHaveBeenCalledTimes(1); // …and keeps quiet about it
    release();
    warn.mockRestore();
  });

  it('is a silent no-op with no navigator.wakeLock at all (AC-40)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const release = holdWakeLock({
      wakeLock: undefined,
      hidden: () => false,
      onVisibilityChange: () => () => undefined,
    });
    expect(() => release()).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('hands back a lock that arrived after the hold ended', async () => {
    const h = harness();
    const release = holdWakeLock(h.deps);
    release(); // the scene left before the request settled
    await Promise.resolve();
    await Promise.resolve();
    expect(h.releases()).toBe(1);
  });

  it('does not ask while the page is already hidden', () => {
    const h = harness({ hidden: true });
    const release = holdWakeLock(h.deps);
    expect(h.requests()).toBe(0);
    h.setHidden(false);
    expect(h.requests()).toBe(1);
    release();
  });
});
