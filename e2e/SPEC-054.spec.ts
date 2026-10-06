// SPEC-054 §6.2 — the underground in a real browser: the surface unchanged,
// the seal, the descent behind its held fade, the light, the loose cache, death
// and recall through the surface, the refusals, a cave position at the pad's
// coordinates reaching nothing, loot left behind, the medium budget, and Eden's
// machine room. The rules are pinned in node — tests/systems/underground,
// light, interactables, enemyAi, combat, spawn, economy, missions,
// exploration, tests/ui/helpers, map and tests/views/flashlight,
// undergroundView.
import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';
import { COLD_START, frames, start } from './start';

const CREATION = {
  name: 'Vance',
  classId: 'marine',
  appearance: { portrait: 1, primary: '#b7472a', secondary: '#2a3b4c' },
  attributes: { might: 6, vigor: 5, agility: 1, tech: 1 },
  difficulty: 'normal',
} as const;

/** The e2e seed's pins (`e2e/` may not import `src/`; tests/systems/underground.test.ts derives them). */
const LAYOUT_HASH = 2726625427;
const CAVE_HASH = { cinder4: 2655388326, eden: 2449418380 } as const;
const SEALED = 'Sealed — finish "Dry Land" first';
/** The game runs at a fraction of the wall clock on a GPU-less container. */
const SLOW = { timeout: 90_000 } as const;

async function info(page: Page): Promise<Record<string, number | string>> {
  return page.evaluate(() => window.__reallm.stats().sceneInfo ?? {});
}

/** A debug-strip button, clicked from script so no overlay can take the pointer. */
async function tap(page: Page, id: string): Promise<void> {
  await page.evaluate((testid) => (document.querySelector(`[data-testid="${testid}"]`) as HTMLElement).click(), id);
}

/** One key press held across a few rendered frames, so a fixed step reads its edge. */
async function press(page: Page, code: string): Promise<void> {
  await page.keyboard.down(code);
  await frames(page, 4);
  await page.keyboard.up(code);
  await frames(page, 2);
}

async function untilInfo(page: Page, key: string, value: number | string, options = SLOW): Promise<void> {
  await page.waitForFunction(
    ({ name, want }) => window.__reallm.stats().sceneInfo?.[name] === want,
    { name: key, want: value },
    { polling: 'raf', ...options },
  );
}

/** Click through any open dialogue, as the other surface suites do. */
async function dismiss(page: Page): Promise<void> {
  const dialogue = page.locator('[data-testid="dialogue"]');
  const advance = page.locator('[data-testid="dialogue-advance"]');
  for (let i = 0; i < 25; i++) {
    if (!(await dialogue.isVisible().catch(() => false))) return;
    if (await advance.isVisible().catch(() => false)) await advance.click({ force: true, timeout: 2_000 }).catch(() => undefined);
    else await dialogue.click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(120);
  }
}

interface Landing {
  done?: readonly string[];
  active?: { id: string; stage: number; counters: Record<string, number> };
}

/** A slot-0 save on seed 123, then a landing through the scene machine; the page must be past the gate. */
async function land(page: Page, planet: string, landing: Landing = { done: ['c1_m1'] }): Promise<void> {
  await page.evaluate(
    ({ creation, done, active }) => {
      const bridge = window.__reallm.save();
      bridge.create(0, creation, 123);
      const save = bridge.current;
      if (save === null) throw new Error('no save bound');
      save.progress.missionsDone.push(...done);
      if (active !== null) save.progress.missionsActive.push(active);
    },
    { creation: CREATION, done: [...(landing.done ?? [])], active: landing.active ?? null },
  );
  await page.evaluate((id) => window.__reallm.go('surface', { planet: id }, { force: true }), planet);
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('surface', COLD_START);
  await expect(page.locator('[data-testid="transition-fade"]')).toHaveCSS('pointer-events', 'none', COLD_START);
  await dismiss(page);
}

async function descend(page: Page): Promise<void> {
  await tap(page, 'surface-descend');
  await untilInfo(page, 'level', 'underground');
  await untilInfo(page, 'held', 0);
}

function eventLines(messages: ConsoleMessage[], name: string): string[] {
  return messages.filter((m) => m.type() === 'debug' && m.text().startsWith(`[events] ${name}`)).map((m) => m.text());
}

test.describe('SPEC-054 the underground', () => {
  test.setTimeout(240_000);

  test('1, 2: the surface is unchanged, and the descent is sealed until Dry Land is done', async ({ page }) => {
    await start(page, '/?debug');
    await land(page, 'cinder4', {});
    const surface = await info(page);
    expect(surface['layoutHash']).toBe(LAYOUT_HASH);
    expect(surface['level']).toBe('surface');
    await tap(page, 'surface-goto-descent');
    await expect(page.locator('[data-testid="hud-interact"]')).toContainText(SEALED, SLOW);
    await press(page, 'KeyE');
    await frames(page, 20);
    expect((await info(page))['level']).toBe('surface');
  });

  test('3: going down holds the fade, then the cave, the spot and the light chip', async ({ page }) => {
    await start(page, '/?debug&quality=medium');
    await land(page, 'cinder4');
    await tap(page, 'surface-goto-descent');
    await expect(page.locator('[data-testid="hud-interact"]')).toContainText('Descend', SLOW);
    await page.keyboard.down('KeyE');
    await untilInfo(page, 'held', 1);
    await page.keyboard.up('KeyE');
    await untilInfo(page, 'level', 'underground');
    await untilInfo(page, 'held', 0);
    const below = await info(page);
    expect(below['caveHash']).toBe(CAVE_HASH.cinder4);
    expect(below['flashlight']).toBe('spot');
    expect(below['light']).toBe(1);
    await expect(page.locator('[data-testid="hud-light"]')).toHaveText('◐ Light on · L');
  });

  // Eden's machine room holds no packs, so nothing can hurt the salvager while
  // the tip queue and the light count are read.
  test('3, 4: the dark tip shows; L and the swaps change the light, never the light count', async ({ page }) => {
    await start(page, '/?debug&quality=medium');
    await land(page, 'eden');
    await descend(page);
    expect((await info(page))['caveHash']).toBe(CAVE_HASH.eden);
    await expect(page.locator('[data-testid="aria-hint"]')).toContainText('L switches your light', { timeout: 150_000 });
    const lights = (await info(page))['lights'];
    await press(page, 'KeyL');
    await untilInfo(page, 'light', 0);
    await expect(page.locator('[data-testid="hud-light"]')).toHaveText('○ Light off · L');
    expect((await info(page))['lights']).toBe(lights);
    await press(page, 'KeyL');
    await untilInfo(page, 'light', 1);
    await tap(page, 'surface-ascend');
    await untilInfo(page, 'level', 'surface');
    await untilInfo(page, 'held', 0);
    expect((await info(page))['lights']).toBe(lights);
    await expect(page.locator('[data-testid="hud-light"]')).toBeHidden();
    await descend(page);
    expect((await info(page))['lights']).toBe(lights);
  });

  test('5: the loose cache opens once, and the claim survives a reload', async ({ page }) => {
    const messages: ConsoleMessage[] = [];
    page.on('console', (message) => void messages.push(message));
    await start(page, '/?debug');
    await land(page, 'cinder4');
    await descend(page);
    await tap(page, 'surface-goto-cache');
    await expect(page.locator('[data-testid="hud-interact"]')).toContainText('Open cache', SLOW);
    await press(page, 'KeyE');
    await untilInfo(page, 'claimed', 1);
    expect(eventLines(messages, 'cache:opened').some((line) => line.includes('cinder4_loose_a'))).toBe(true);
    await expect(page.locator('.toast-rack .toast-good').filter({ hasText: 'Cache opened' }).first()).toBeVisible();
    expect(await page.evaluate(() => window.__reallm.save().current?.progress.claimed ?? [])).toContain('cinder4_loose_a');
    await press(page, 'KeyE');
    await frames(page, 10);
    expect(eventLines(messages, 'cache:opened')).toHaveLength(1);
    expect((await info(page))['claimed']).toBe(1);

    await page.evaluate(() => window.__reallm.save().flush());
    await start(page, '/?debug');
    const loaded = await page.evaluate(() => window.__reallm.save().load(0));
    expect(loaded.ok).toBe(true);
    expect(loaded.data?.progress.claimed ?? []).toContain('cinder4_loose_a');
  });

  // On Eden, where no pack can take the salvager's life before the test does.
  test('6: death below respawns at the pad on the surface; Recall below comes up and counts', async ({ page }) => {
    await start(page, '/?debug');
    await land(page, 'eden');
    await descend(page);
    const recalls = (await info(page))['recalls'];
    for (let i = 0; i < 12 && (await info(page))['level'] === 'underground'; i++) {
      await tap(page, 'surface-hurt');
      await frames(page, 30);
    }
    await untilInfo(page, 'level', 'surface');
    await page.waitForFunction(() => Math.hypot(Number(window.__reallm.stats().sceneInfo?.['px']), Number(window.__reallm.stats().sceneInfo?.['pz'])) < 16, undefined, SLOW);
    expect((await info(page))['recalls']).toBe(recalls);

    await page.waitForTimeout(2_500); // the respawn's i-frames, so the next descent is not refused for a dead player
    await descend(page);
    await page.keyboard.press('Escape');
    await page.locator('[data-testid="pause-recall"]').click();
    await page.locator('[data-testid="confirm-yes"]').click();
    await untilInfo(page, 'level', 'surface');
    expect((await info(page))['recalls']).toBe(Number(recalls) + 1);
  });

  test('7: a running clock refuses the descent with its reason', async ({ page }) => {
    await start(page, '/?debug');
    await land(page, 'cinder4', { done: ['c1_m1'], active: { id: 'c1_s2', stage: 1, counters: {} } });
    await tap(page, 'surface-goto-descent');
    await expect(page.locator('[data-testid="hud-interact"]')).toContainText('Not now — the clock is running on "', SLOW);
  });

  test('8, 9: the cave at the pad’s coordinates reaches nothing, and loot left at a descent is said', async ({ page }) => {
    const messages: ConsoleMessage[] = [];
    page.on('console', (message) => void messages.push(message));
    await start(page, '/?debug');
    await land(page, 'cinder4');
    // 9: an item at the feet, and a descent before the step that would collect it.
    await page.evaluate(() => {
      (document.querySelector('[data-testid="surface-drop-item"]') as HTMLElement).click();
      (document.querySelector('[data-testid="surface-descend"]') as HTMLElement).click();
    });
    await expect(page.locator('.toast-rack .toast-warn').filter({ hasText: 'Loot left behind' }).first()).toBeVisible(SLOW);
    await untilInfo(page, 'level', 'underground');
    await untilInfo(page, 'held', 0);
    const before = eventLines(messages, 'poi:reached').length;
    await tap(page, 'surface-goto-origin');
    await frames(page, 30);
    await press(page, 'KeyE');
    await frames(page, 10);
    expect(eventLines(messages, 'poi:reached').slice(before).some((line) => line.includes('landing_pad'))).toBe(false);
    await expect(page.locator('[data-testid="pad-terminal"]')).toBeHidden();
  });

  for (const planet of ['cinder4', 'eden'] as const) {
    test(`10, 11: ${planet} below on medium stays in budget${planet === 'eden' ? ', with no enemies and six cradles' : ''}`, async ({ page }) => {
      await start(page, `/?scene=surface&planet=${planet}&debug&quality=medium`);
      await dismiss(page);
      await descend(page);
      await frames(page, 30);
      const stats = await page.evaluate(() => window.__reallm.stats());
      expect(stats.drawCalls).toBeLessThanOrEqual(96);
      expect(stats.triangles).toBeLessThanOrEqual(130_000);
      if (planet === 'eden') {
        const below = await info(page);
        expect(below['caveEnemies']).toBe(0);
        expect(below['cradles']).toBe(6);
      }
    });
  }
});
