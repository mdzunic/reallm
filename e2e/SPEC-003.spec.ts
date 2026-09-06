// SPEC-003 QA codification: the state-machine behaviours that were reachable
// only through the dev-only `window.__reallm` bridge and were not yet covered
// by e2e/scene-cycle.spec.ts, e2e/pause.spec.ts or e2e/boot-assets.spec.ts —
// concurrency (D-2), the transition-table guard and its `force` escape hatch
// (D-8, D-11), and prefers-reduced-motion (D-16), all exercised against the
// real bundle in a real browser rather than the spy-scene unit harness.
import { expect, test, type Page } from '@playwright/test';

interface SceneBridge {
  go(id: string, params: unknown, opts?: { force?: boolean }): Promise<boolean>;
  scene(): string | null;
  memory(): { geometries: number; textures: number };
}

declare global {
  interface Window {
    __reallm: SceneBridge;
  }
}

async function atMenu(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('menu');
  // The boot → menu transition still fades in after the label appears (AC-14);
  // wait for it to settle so it cannot itself be mistaken for "a transition is
  // already running" by the assertions below.
  await expect(page.locator('[data-testid="transition-fade"]')).toHaveCSS('pointer-events', 'none');
}

test('a second go() while one is running is refused, logged and does not disturb the first (AC-2, AC-3, AC-4, AC-5)', async ({
  page,
}) => {
  await atMenu(page);
  const messages: string[] = [];
  page.on('console', (message) => messages.push(message.text()));

  const result = await page.evaluate(async () => {
    const first = window.__reallm.go('station', {});
    const before = window.__reallm.scene();
    const second = await window.__reallm.go('starmap', undefined);
    return { before, second, firstResult: await first, after: window.__reallm.scene() };
  });

  expect(result.before).toBe('menu'); // unchanged the instant the refused call returned
  expect(result.second).toBe(false);
  expect(result.firstResult).toBe(true); // the running transition still completed
  expect(result.after).toBe('station');
  expect(messages.some((text) => text.includes('a transition is already running'))).toBe(true);
});

test('a transition outside the table throws in this dev build and leaves current unchanged (AC-25, AC-28)', async ({
  page,
}) => {
  await atMenu(page);
  const result = await page.evaluate(() => {
    let threw: string | null = null;
    try {
      window.__reallm.go('surface', { planet: 'cinder4', firstLanding: true });
    } catch (error) {
      threw = error instanceof Error ? error.message : String(error);
    }
    return { threw, scene: window.__reallm.scene() };
  });
  expect(result.threw).toMatch(/menu → surface is not in the scene graph/);
  expect(result.scene).toBe('menu');
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('menu');
});

test('{ force: true } skips the table check in this dev build (AC-30)', async ({ page }) => {
  await atMenu(page);
  const ok = await page.evaluate(() =>
    window.__reallm.go('surface', { planet: 'cinder4', firstLanding: true }, { force: true }),
  );
  expect(ok).toBe(true);
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('surface');
});

test('prefers-reduced-motion collapses both fades to 0 ms without changing the outcome (AC-40, AC-41)', async ({
  page,
}) => {
  await atMenu(page);
  // Full-motion baseline for comparison, from the same page/build.
  const normal = await page.evaluate(async () => {
    const start = performance.now();
    const ok = await window.__reallm.go('station', {});
    return { ok, elapsed: performance.now() - start };
  });
  expect(normal.ok).toBe(true);
  expect(normal.elapsed).toBeGreaterThanOrEqual(500); // two real 300 ms fades

  const reduced = await page.evaluate(async () => {
    window.matchMedia = ((query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      addEventListener() {},
      removeEventListener() {},
    })) as unknown as typeof window.matchMedia;
    const start = performance.now();
    const ok = await window.__reallm.go('starmap', undefined);
    return { ok, elapsed: performance.now() - start, scene: window.__reallm.scene() };
  });
  expect(reduced.ok).toBe(true);
  expect(reduced.scene).toBe('starmap');
  expect(reduced.elapsed).toBeLessThan(100); // no 300 ms fades to wait through
});
