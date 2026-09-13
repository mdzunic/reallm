// SPEC-027 §6.2 — mission guidance in a real browser: the tracker panel, the
// waypoint and its edge arrow, the escalation's hint, the scan ring, the
// guidance setting, and the first-time tips.
//
// What only a composed scene can show. The target maths, the stuck clock and
// the path search are pinned in node (`tests/systems/guidance.test.ts`); what
// is here is the wiring — projection, the DOM the player actually reads, and
// the device-wide `tipsSeen` behind a reload (D-24).
import { expect, test, type Page } from '@playwright/test';
import { start } from './start';

/** §6.2: a fresh save on Cinder-4 with the debug strip up. */
const URL = '/?debug&scene=surface&planet=cinder4&seed=123';

const tracker = (page: Page) => page.locator('[data-testid="objective-tracker"]');
const waypoint = (page: Page) => page.locator('[data-testid="waypoint"]');
const hint = (page: Page) => page.locator('[data-testid="aria-hint"]');

async function land(page: Page): Promise<void> {
  await start(page, URL);
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('surface');
  await expect(page.locator('[data-testid="transition-fade"]')).toHaveCSS('pointer-events', 'none');
}

/** Click through any open dialogue — chapter-1 beats are all non-modal. */
async function dismiss(page: Page): Promise<void> {
  const dialogue = page.locator('[data-testid="dialogue"]');
  for (let i = 0; i < 20; i++) {
    if (!(await dialogue.isVisible().catch(() => false))) return;
    await dialogue.click({ force: true });
    await page.waitForTimeout(120);
  }
}

/** Accept `c1_m1` at the pad terminal; stage 0 (reach the pad) ends where it starts. */
async function acceptFirstMission(page: Page): Promise<void> {
  await page.locator('[data-testid="surface-goto-pad"]').click();
  const terminal = page.locator('[data-testid="pad-terminal"]');
  for (let i = 0; i < 6; i++) {
    if (await terminal.isVisible()) break;
    await page.keyboard.press('KeyE');
    await page.waitForTimeout(400);
  }
  await expect(terminal).toBeVisible();
  await page.locator('[data-testid="terminal-accept-c1_m1"]').click();
  await page.locator('[data-testid="terminal-close"]').click();
  await dismiss(page);
}

test('1. the tracker names the tracked mission, its stage and the distance to the target', async ({ page }) => {
  await land(page);
  // Before anything is accepted the panel still says where it stands (AC-23).
  await expect(tracker(page)).toBeVisible();
  await expect(tracker(page)).toContainText('No active mission');

  await acceptFirstMission(page);
  // D-2: the title is in the DOM as the data writes it; CSS does the shouting.
  await expect(tracker(page)).toContainText(/dry land/i);
  await expect(tracker(page)).toContainText(/stage \d\/3/);
  await expect(page.locator('[data-testid="objective-tracker"] .tracker-dist')).toContainText(/\d+ m/);
  // AC-17: the focus row *is* the objective line, and it is the only one.
  await expect(page.locator('[data-testid="hud"] .hud-objective')).toHaveCount(1);
});

test('2. the scan stage points off screen: the row names the site and the waypoint is an edge arrow', async ({
  page,
}) => {
  await land(page);
  await acceptFirstMission(page);
  // Standing on the pad, the dune sea is 60–90 m away (SPEC-009's band), so
  // its projected point is outside the inset ellipse.
  await page.locator('[data-testid="surface-goto-pad"]').click();
  await expect(tracker(page)).toContainText('Scan Dune Sea');
  await expect(waypoint(page)).toHaveAttribute('data-state', 'edge');
  await expect(waypoint(page)).toBeVisible();
});

test('3. the stuck escalation ends in a hint that names where to go', async ({ page }) => {
  test.setTimeout(90_000);
  await land(page);
  await acceptFirstMission(page);

  // Two presses cross 45 s and 90 s — `pulse`, then `nudge` (D-22). A fight
  // near the pad pauses the clock, so keep pressing until the line arrives.
  const stuck = page.locator('[data-testid="surface-stuck"]');
  await expect
    .poll(
      async () => {
        await stuck.click();
        await page.waitForTimeout(600);
        return ((await hint(page).textContent()) ?? '').includes('Dune Sea');
      },
      { timeout: 60_000 },
    )
    .toBe(true);
  await expect(hint(page)).toBeVisible();
  await expect(hint(page)).toContainText('Dune Sea');
  // The tracker pulses from level 1 on (AC-28).
  await expect(tracker(page)).toHaveClass(/is-stuck/);
});

test('4. standing in the scan ring fills it, and the stage advances behind it', async ({ page }) => {
  test.setTimeout(90_000);
  await land(page);
  await acceptFirstMission(page);

  await page.locator('[data-testid="surface-goto-objective"]').click();
  await expect(page.locator('[data-testid="scan-progress"]')).toBeVisible({ timeout: 10_000 });
  // SCAN_SECONDS is 3; the stage is the third of three once it completes.
  await expect(tracker(page)).toContainText('stage 3/3', { timeout: 20_000 });
});

test('5. guidance off keeps the tracker and drops the waypoint', async ({ page }) => {
  await land(page);
  await acceptFirstMission(page);
  await expect(waypoint(page)).toBeVisible();

  await page.keyboard.press('Escape');
  await page.locator('[data-testid="pause-settings"]').click();
  await page.locator('[data-testid="settings-guidance-off"]').click();
  await expect(page.locator('[data-testid="settings-guidance-off"]')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('[data-testid="settings-close"]').click();
  await page.locator('[data-testid="pause-resume"]').click();

  await expect(waypoint(page)).toBeHidden();
  await expect(waypoint(page)).toHaveAttribute('data-state', 'off');
  await expect(tracker(page)).toBeVisible();
});

test('6. the move tip shows once per device and is remembered across a reload (D-24)', async ({ page }) => {
  test.setTimeout(90_000);
  await land(page);

  // §4.5: the first fixed step of the first surface scene of the session.
  await expect(hint(page)).toContainText('WASD', { timeout: 15_000 });
  const seen = await page.evaluate(
    () => (JSON.parse(localStorage.getItem('reallm:settings') ?? '{}') as { tipsSeen?: string[] }).tipsSeen ?? [],
  );
  expect(seen).toContain('move');

  // A real reload onto the same device: the tip has been seen, so it is done.
  await land(page);
  await page.waitForTimeout(3000);
  expect((await hint(page).textContent()) ?? '').not.toContain('WASD');
  await expect(tracker(page)).toBeVisible();
});
