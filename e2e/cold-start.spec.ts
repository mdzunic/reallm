// The net under the run's first page load (e2e/start.ts, e2e/global-setup.ts).
//
// A dev server that has only just started can drop the first page that reaches
// it — a module request answered while the dependency optimiser re-runs, a
// watcher still draining the checkout — and the page is then left without an
// evaluated `src/main.ts`, so the boot overlay the composition root builds is
// not in the DOM at all. That is what the merge gate saw: the run's first test
// waited out the whole cold-start budget on an element that was absent rather
// than hidden, while every test after it passed the gate in about a second.
//
// `awaitGate` reloads once in exactly that case. This pins the distinction it
// draws — an absent overlay is retried, a hidden gate is not — by killing the
// entry module for one navigation and no more.
import { expect, test } from '@playwright/test';
import { gameUrl, passGate } from './start';

test('a first load that never evaluated main.ts is reloaded rather than failed', async ({ page }) => {
  // The first wait has to run out before the reload, so this test spans one
  // whole cold-start budget plus the load that follows it.
  test.setTimeout(120_000);

  let killEntry = true;
  await page.route('**/src/main.ts', async (route) => {
    if (killEntry) {
      killEntry = false;
      await route.abort();
      return;
    }
    await route.continue();
  });

  await page.goto(gameUrl('/'));
  // Absent, not hidden: nothing built the overlay, because the module that
  // builds it never arrived.
  await expect(page.locator('[data-testid="boot-overlay"]')).toHaveCount(0);

  await passGate(page);
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('menu');
});
