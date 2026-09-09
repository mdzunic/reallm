// The smoke test (SPEC-001 §3): the shell serves and the two elements every
// scene builds on are there. Runs against the dev server on 5173 — started by
// playwright.config.ts when nothing listens, reused when the factory's QA
// container has already started it.
//
// SPEC-002 §4.5 put a start gate in front of the game, so the walk from an
// empty page to a running scene goes through the shared helper (D-K).
import { expect, test } from '@playwright/test';
import { passGate } from './start';

test('the shell boots: title, canvas and UI overlay', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle('ReaLLM');
  await expect(page.locator('canvas#game')).toBeAttached();
  await expect(page.locator('#ui')).toBeAttached();
  await expect(page.locator('#ui .boot-note')).toContainText('ReaLLM');

  // …and past the gate, a scene is on screen.
  await passGate(page);
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('menu');
});
