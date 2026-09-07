// SPEC-011's browser acceptance run on Cinder-4, against the combat demo
// harness (`scenes/SurfaceCombatDemo.ts`). The archetype mechanics are pinned
// in node (`tests/systems/`); what this suite proves is the wiring only a
// browser shows — enemies actually spawn and engage on a real planet, the
// boss's phase machinery runs, and the die → respawn round trip closes
// (AC on death/respawn; Combat itself has no respawn method).
import { expect, test, type Page } from '@playwright/test';
import { start } from './start';

const info = async (page: Page): Promise<Record<string, number | string>> =>
  (await page.evaluate(() => window.__reallm.stats())).sceneInfo ?? {};

test('enemies spawn and engage on Cinder-4 (AC-36..38, AC-40)', async ({ page }) => {
  await start(page, '/?debug&scene=surface&planet=cinder4');
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('surface');

  // Landing HP: marine demo pilot at full (the §6 pin, 184).
  await expect(page.locator('[data-testid="hud-hp"]')).toContainText('HP 184/184');

  // The spawn director fills the field (plus the boss in its nest).
  await expect.poll(async () => Number((await info(page))['enemies'] ?? 0), { timeout: 15_000 }).toBeGreaterThan(4);
  await expect.poll(async () => Number((await info(page))['spawned'] ?? 0), { timeout: 15_000 }).toBeGreaterThan(4);
  await expect(page.locator('[data-testid="hud-counters"]')).toContainText('spawned');

  // Something closed in and hit the player, or at least aggroed: with
  // auto-fire on and skitters spawning 14 m out, combat starts by itself.
  await expect.poll(async () => Number((await info(page))['spawned'] ?? 0), { timeout: 20_000 }).toBeGreaterThan(8);
});

test('the player dies and respawns (AC-41)', async ({ page }) => {
  await start(page, '/?debug&scene=surface&planet=cinder4');
  await expect(page.locator('[data-testid="hud-hp"]')).toContainText('HP 184/184');

  // 60 a click against 184 HP; clicks are spaced past the 0.3 s i-frames.
  for (let i = 0; i < 4; i++) {
    await page.locator('[data-testid="demo-hurt"]').click();
    await page.waitForTimeout(400);
  }
  await expect(page.locator('[data-testid="hud-death"]')).toBeVisible();
  await expect(page.locator('[data-testid="hud-death"]')).toContainText('Cause: fall');

  await page.locator('[data-testid="demo-respawn"]').click();
  await expect(page.locator('[data-testid="hud-death"]')).toBeHidden();
  await expect(page.locator('[data-testid="hud-hp"]')).toContainText('HP 184/184');
});

test('the dune wurm aggroes and burrows into phase 2 (AC-39)', async ({ page }) => {
  await start(page, '/?debug&scene=surface&planet=cinder4');
  await expect.poll(async () => String((await info(page))['boss'] ?? '')).toMatch(/^p1 /);

  // Into the nest: the boss aggroes (its bar appears) and the arena arms.
  await page.locator('[data-testid="demo-goto-boss"]').click();
  await expect(page.locator('[data-testid="hud-boss"]')).toBeVisible({ timeout: 10_000 });

  // Three 25 % wounds cross the 0.4 threshold; the wurm burrows on phase 2
  // entry (invulnerable while under, so extra clicks are ignored — 11-f).
  for (let i = 0; i < 3; i++) {
    await page.locator('[data-testid="demo-wound-boss"]').click();
    await page.waitForTimeout(250);
  }
  await expect.poll(async () => String((await info(page))['boss'] ?? ''), { timeout: 10_000 }).toMatch(/^p2 /);
});
