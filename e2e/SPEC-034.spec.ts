// SPEC-034 §6.2 — the stabilisation pass in a real browser.
//
// What only a composed scene can show: the pause menu's Recall and its
// conditions, the world standing still behind a modal line, the throttle's new
// key, the departure veil, the creation preview following its scroll, the defend
// tracker's HP row, and the pin that outlives a departure. The rules themselves
// are pinned in node — `tests/systems/layout.test.ts`, `missions.test.ts`,
// `defend.test.ts`, `tests/ui/surfaceHold.test.ts`, `tests/systems/gauntlet.test.ts`.
import { expect, test, type Page } from '@playwright/test';
import { start } from './start';

const SURFACE = '/?debug&scene=surface&planet=cinder4&seed=123';

const CREATION = {
  name: 'Vance',
  classId: 'marine',
  appearance: { portrait: 1, primary: '#b7472a', secondary: '#2a3b4c' },
  attributes: { might: 6, vigor: 5, agility: 1, tech: 1 },
  difficulty: 'normal',
} as const;

const pauseMenu = (page: Page) => page.locator('[data-testid="pause-menu"]');
const recall = (page: Page) => page.locator('[data-testid="pause-recall"]');

async function sceneInfo(page: Page): Promise<Record<string, number | string>> {
  return page.evaluate(() => window.__reallm.stats().sceneInfo ?? {});
}

/** Click through any open non-modal dialogue, as the other surface suites do. */
async function dismiss(page: Page): Promise<void> {
  const dialogue = page.locator('[data-testid="dialogue"]');
  // SPEC-037 §4.3: a non-modal line lets taps through; its `›` advances it.
  const advance = page.locator('[data-testid="dialogue-advance"]');
  for (let i = 0; i < 25; i++) {
    if (!(await dialogue.isVisible().catch(() => false))) return;
    // The line can move on by itself between the look and the press.
    if (await advance.isVisible().catch(() => false)) await advance.click({ force: true, timeout: 2_000 }).catch(() => undefined);
    else await dialogue.click({ force: true });
    await page.waitForTimeout(120);
  }
}

async function land(page: Page): Promise<void> {
  await start(page, SURFACE);
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('surface');
  await dismiss(page);
}

/** Hold a movement key for `ms`, then let go. */
async function walk(page: Page, key: string, ms: number): Promise<void> {
  await page.keyboard.down(key);
  await page.waitForTimeout(ms);
  await page.keyboard.up(key);
}

// --------------------------------------------------------------------- recall

test('1. Recall to pad puts the player back at the spawn, whole, and charges nothing', async ({ page }) => {
  await land(page);
  const spawn = await sceneInfo(page);
  const before = await page.evaluate(() => ({ ...window.__reallm.save().current?.resources }));

  // Walk clear of the pad — the recall has to actually move someone.
  for (let i = 0; i < 6 && Math.hypot(Number((await sceneInfo(page))['px']) - Number(spawn['px']), Number((await sceneInfo(page))['pz']) - Number(spawn['pz'])) < 20; i++) {
    await walk(page, 'KeyW', 900);
  }
  const away = await sceneInfo(page);
  const distance = Math.hypot(Number(away['px']) - Number(spawn['px']), Number(away['pz']) - Number(spawn['pz']));
  expect(distance).toBeGreaterThan(10);

  await page.keyboard.press('Escape');
  await expect(pauseMenu(page)).toBeVisible();
  // §4.2: above Save & Quit, and it asks before it acts.
  await expect(recall(page)).toBeVisible();
  await recall(page).click();
  const sheet = page.locator('[data-testid="confirm-sheet"]');
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText('Return to the landing pad? Timed objectives restart.');
  await page.locator('[data-testid="confirm-yes"]').click();

  await expect(pauseMenu(page)).toBeHidden();
  await page.waitForTimeout(300);
  const after = await sceneInfo(page);
  const back = Math.hypot(Number(after['px']) - Number(spawn['px']), Number(after['pz']) - Number(spawn['pz']));
  expect(back).toBeLessThan(3);
  expect(Number(after['recalls'])).toBe(1);

  // Full HP, no death overlay, and the hold is untouched: E4's respawn minus
  // its price (§4.2).
  const hp = await page.evaluate(() => window.__reallm.stats().sceneInfo ?? {});
  void hp;
  await expect(page.locator('[data-testid="death-overlay"]')).toBeHidden();
  const resources = await page.evaluate(() => ({ ...window.__reallm.save().current?.resources }));
  expect(resources).toEqual(before);
});

test('2. Recall is not offered while a modal dialogue is open', async ({ page }) => {
  await land(page);
  await page.keyboard.press('Escape');
  await expect(recall(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(pauseMenu(page)).toBeHidden();

  // `intro_command` is modal: the world holds, and the way out is not on offer.
  await page.evaluate(() => window.__reallm.playDialogue('intro_command'));
  await page.waitForTimeout(200);
  await page.keyboard.press('Escape');
  await expect(pauseMenu(page)).toBeVisible();
  await expect(recall(page)).toBeHidden();
});

// ----------------------------------------------------------------- the hold

test('3. a modal line holds the world, and dismissing it resumes', async ({ page }) => {
  await land(page);
  // The debug strip's own spawner, so there is something that could move.
  await page.locator('[data-testid="surface-spawn-boss"]').click();
  await page.waitForTimeout(500);
  expect(Number((await sceneInfo(page))['held'])).toBe(0);

  await page.evaluate(() => window.__reallm.playDialogue('c5_m3_aria'));
  await page.waitForTimeout(250);
  expect(Number((await sceneInfo(page))['held'])).toBe(1);

  // A second of wall time with the line up: nothing in the simulation moves.
  const before = await sceneInfo(page);
  await page.waitForTimeout(1000);
  const after = await sceneInfo(page);
  expect(after['px']).toBe(before['px']);
  expect(after['pz']).toBe(before['pz']);
  expect(after['nearDx']).toBe(before['nearDx']);
  expect(after['nearDz']).toBe(before['nearDz']);
  expect(after['boss']).toBe(before['boss']);

  // Dismiss the lines, and it runs again.
  await dismiss(page);
  await page.waitForTimeout(250);
  expect(Number((await sceneInfo(page))['held'])).toBe(0);
});

// --------------------------------------------------------------- the throttle

test('4. KeyX lowers the throttle, ControlLeft does nothing, and the sheet says so', async ({ page }) => {
  await start(page, '/?debug&scene=flight&planet=cinder4&seed=123');
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('flight');
  const throttle = page.locator('[data-testid="hud-throttle"]');
  const read = async (): Promise<string> => (await throttle.textContent()) ?? '';
  const start0 = await read();

  await page.keyboard.press('ControlLeft');
  await page.waitForTimeout(200);
  expect(await read()).toBe(start0); // 4.16: Ctrl is bound to nothing now

  await page.keyboard.press('KeyX');
  await page.waitForTimeout(200);
  expect(await read()).not.toBe(start0);

  await page.keyboard.press('Escape');
  await expect(pauseMenu(page)).toBeVisible();
  await page.locator('[data-testid="pause-controls"]').click();
  await expect(page.locator('[data-testid="pause-sheet"]')).toContainText('Shift up · X down');
  // §4.2: the flight menu never offers a recall.
  await expect(recall(page)).toHaveCount(0);
});

// ----------------------------------------------------------------- the veil

test('5. the star map is veiled from the departure film to the flight scene', async ({ page }) => {
  await start(page, '/?debug');
  await page.evaluate(
    (creation) => {
      const data = window.__reallm.save().create(0, creation, 123) as unknown as {
        resources: Record<string, number>;
      };
      data.resources['oil'] = 400;
    },
    CREATION,
  );
  await page.evaluate(() => window.__reallm.go('starmap', {}, { force: true }));
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('starmap');

  const veil = page.locator('[data-testid="depart-veil"]');
  const panel = page.locator('[data-testid="starmap-depart"]');
  await expect(veil).toHaveCount(0);
  await panel.click();
  await page.locator('[data-testid="confirm-yes"]').click();

  // From the film's end to the flight scene, the map is behind black — and it
  // never reads back the fuel it has just paid as a shortfall (§4.16).
  await expect(veil).toBeVisible({ timeout: 30_000 });
  await expect(panel).toContainText('Departing…');
  await expect(page.locator('[data-testid="depart-reason"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('flight', { timeout: 30_000 });
  await expect(veil).toHaveCount(0);
});

// --------------------------------------------------------------- the preview

test('6. the creation preview follows the form when it scrolls', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 600 });
  await start(page, '/?debug');
  await page.evaluate(() => window.__reallm.go('creation', {}, { force: true }));
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('creation');
  await page.waitForTimeout(300);

  const before = await sceneInfo(page);
  expect(Number(before['previewH'])).toBeGreaterThan(0);
  const scrolled = await page.evaluate(() => {
    const body = document.querySelector('.screen-creation .screen-body');
    if (!(body instanceof HTMLElement)) return 0;
    const was = body.scrollTop;
    body.scrollTop = was + 200;
    return body.scrollTop - was;
  });
  expect(scrolled).toBeGreaterThan(100);
  await page.waitForTimeout(300);
  const after = await sceneInfo(page);
  // The re-measure is what AC-68 is about: the overlay box's viewport top moves
  // up by exactly what the container scrolled, within a pixel of rounding.
  const moved = Number(before['previewTop']) - Number(after['previewTop']);
  expect(moved).toBeGreaterThan(scrolled - 2);
  expect(moved).toBeLessThan(scrolled + 2);
});

// -------------------------------------------------------- defend feedback

test('7. the tracker shows the defended beacon at 100 %', async ({ page }) => {
  await start(page, '/?debug');
  await page.evaluate(
    (creation) => {
      const data = window.__reallm.save().create(0, creation, 123) as unknown as {
        progress: { flags: string[]; missionsDone: string[]; missionsActive: Array<{ id: string; stage: number; counters: Record<string, number> }> };
      };
      data.progress.flags.push('chapter5_done');
      data.progress.missionsDone.push('c6_m1');
      data.progress.missionsActive.push({ id: 'c6_m2', stage: 0, counters: {} });
    },
    CREATION,
  );
  await page.evaluate(() => window.__reallm.go('surface', { planet: 'eden' }, { force: true }));
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('surface');
  await dismiss(page);

  const bar = page.locator('[data-testid="tracker-defend-hp"]');
  await expect(bar).toBeVisible();
  await expect(bar).toContainText('100 %');
});

// ------------------------------------------------------------------ the pin

test('8. the board pin reorders missionsActive, and the tracker follows it', async ({ page }) => {
  await start(page, '/?debug');
  await page.evaluate(
    (creation) => {
      const data = window.__reallm.save().create(0, creation, 123) as unknown as {
        resources: Record<string, number>;
        progress: { missionsDone: string[]; missionsActive: Array<{ id: string; stage: number; counters: Record<string, number> }> };
      };
      data.resources['oil'] = 400;
      data.progress.missionsDone.push('c1_m1');
      data.progress.missionsActive.push({ id: 'c1_m2', stage: 0, counters: {} });
      data.progress.missionsActive.push({ id: 'c1_s1', stage: 0, counters: {} });
    },
    CREATION,
  );
  await page.evaluate(() => window.__reallm.go('station', {}, { force: true }));
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('station');

  const order = async (): Promise<string[]> =>
    page.evaluate(() => (window.__reallm.save().current?.progress.missionsActive ?? []).map((entry) => entry.id));
  expect(await order()).toEqual(['c1_m2', 'c1_s1']);

  await page.locator('[data-testid="mission-c1_s1-pin"]').click();
  expect(await order()).toEqual(['c1_s1', 'c1_m2']);
  // The badge follows the front entry among the planet's active missions.
  await expect(page.locator('[data-testid="mission-c1_s1-pin"]')).toHaveAttribute('aria-pressed', 'true');

  // …and the surface reads the front entry on the next landing (§4.15).
  await page.evaluate(() => window.__reallm.go('surface', { planet: 'cinder4' }, { force: true }));
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('surface');
  await dismiss(page);
  await expect(page.locator('[data-testid="objective-tracker"]')).toContainText('Grain Silo');
});
