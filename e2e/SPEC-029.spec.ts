// SPEC-029's browser acceptance run (§6.2): the arsenal debug press, the
// chaingun's heat lock, one rocket into a spawned pack with its recharge, a
// thrown grenade, the six-mine limit, and the station's grouped shop with the
// grenade recipe. The rules themselves are pinned in node
// (`tests/systems/loadout.test.ts`, `tests/systems/combat.test.ts`); this is
// the composed wiring.
import { expect, test, type Page } from '@playwright/test';
import { start } from './start';

/** §6.2: a fresh save on Cinder-4 with the debug strip up. */
const URL = '/?debug&scene=surface&planet=cinder4&seed=123';

const info = async (page: Page): Promise<Record<string, number | string>> =>
  (await page.evaluate(() => window.__reallm.stats())).sceneInfo ?? {};

/** Wait for a `?scene=` jump to have finished fading in (SPEC-003 AC-14). */
async function settle(page: Page): Promise<void> {
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('surface');
  await expect(page.locator('[data-testid="transition-fade"]')).toHaveCSS('pointer-events', 'none');
}

/** A ground point a few metres from the player, clear of the HUD. */
function aimPoint(page: Page): { x: number; y: number } {
  const size = page.viewportSize();
  const w = size?.width ?? 1280;
  const h = size?.height ?? 720;
  return { x: Math.round(w / 2 + 180), y: Math.round(h / 2 - 120) };
}

/**
 * Plant one explosive with KeyG and wait for the held count to fall to
 * `expected` — one press per attempt, and nothing is pressed while the drop is
 * being waited for.
 *
 * The press is a DOM event the game consumes on its next frame, so a count read
 * in the same step that pressed still reads the state from *before* it; and a
 * press inside the 0.5 s explosive cooldown (§4.8) is refused silently. Pressing
 * inside a poll predicate combines the two badly: once the poll's backoff grew
 * past the cooldown, every retry spent another mine while the poll was still
 * comparing a stale count, so six placements could spend all seven mines and the
 * loop then waited out its timeout on a count that had already gone past it.
 * That is what failed on a SwiftShader container at ~27 fps (expected 4, got 1);
 * how fast frames come is not what this case is about.
 *
 * Here a spend can happen at most once per attempt, and a press lost to the
 * cooldown is retried well outside it, so the assertion is the same on any host:
 * each press spends exactly one mine.
 */
async function plant(page: Page, expected: number): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    if ((await info(page))['qExplosive'] === expected) return;
    // Let the 0.5 s cooldown from the previous placement run out first.
    await page.waitForTimeout(700);
    await page.keyboard.press('KeyG');
    try {
      await expect.poll(async () => (await info(page))['qExplosive'], { timeout: 2_500 }).toBe(expected);
      return;
    } catch {
      // Refused inside the cooldown — it spent nothing, so press again.
    }
  }
  // Out of attempts: fail on the real count rather than on a timeout.
  expect((await info(page))['qExplosive']).toBe(expected);
}

test('surface-arsenal equips the chaingun and the rocket and stocks the explosives (§6.2 case 1)', async ({ page }) => {
  await start(page, URL);
  await settle(page);

  await page.getByTestId('surface-arsenal').click();
  await expect(page.getByTestId('qb-primary')).toContainText('Chaingun');
  await expect(page.getByTestId('qb-heavy')).toContainText('Rocket');
  await expect(page.getByTestId('qb-explosive')).toContainText('Frag');
  await expect(page.getByTestId('qb-explosive')).toContainText('×3');
});

test('holding fire locks the chaingun: weaponState lock, is-locked on the bar (§6.2 case 2)', async ({ page }) => {
  await start(page, URL);
  await settle(page);
  await page.getByTestId('surface-arsenal').click();

  // Aim at an empty patch and hold Space: 10 shots/s at 0.04 heat against
  // 0.2/s of cooling locks on the 49th shot, comfortably inside 8 s.
  const at = aimPoint(page);
  await page.mouse.move(at.x, at.y);
  await page.keyboard.down('Space');
  // 8 s of game time; wall time stretches when parallel workers starve the tab.
  await expect.poll(async () => (await info(page))['weaponState'], { timeout: 20_000 }).toBe('lock');
  await page.keyboard.up('Space');
  await expect(page.getByTestId('qb-primary')).toHaveClass(/is-locked/);
  await expect(page.getByTestId('qb-primary')).toContainText('LOCK');
});

test('one rocket clears most of a pack, hands back and recharges in 6 s (§6.2 case 3)', async ({ page }) => {
  await start(page, URL);
  await settle(page);
  await page.getByTestId('surface-arsenal').click();

  const at = aimPoint(page);
  await page.mouse.move(at.x, at.y);
  // A synthetic click: a real one would move the pointer onto the strip and
  // drag the last aim projection — the ring must land at the aim point.
  await page.evaluate(() => {
    (document.querySelector('[data-testid="surface-spawn-pack"]') as HTMLButtonElement).click();
  });
  const before = Number((await info(page))['kills'] ?? 0);

  await page.keyboard.press('Digit3');
  await expect.poll(async () => (await info(page))['weaponSlot']).toBe('heavy');
  // Click until the shot lands — a click inside the 0.25 s switch is refused,
  // and game time lags wall time under parallel load.
  await expect
    .poll(
      async () => {
        await page.mouse.click(at.x, at.y);
        return (await info(page))['charges'];
      },
      { timeout: 10_000 },
    )
    .toBe(0);

  await expect.poll(async () => Number((await info(page))['kills'] ?? 0) - before, { timeout: 5_000 }).toBeGreaterThanOrEqual(3);
  // §4.2: the heavy hands back after its last charge and rebuilds holstered.
  await expect.poll(async () => (await info(page))['weaponSlot']).toBe('primary');
  await expect.poll(async () => (await info(page))['charges'], { timeout: 15_000 }).toBe(1);
});

test('KeyG throws a frag at the pointer and spends exactly one (§6.2 case 4)', async ({ page }) => {
  await start(page, URL);
  await settle(page);
  await page.getByTestId('surface-arsenal').click();

  const at = aimPoint(page);
  await page.mouse.move(at.x, at.y);
  await page.evaluate(() => {
    (document.querySelector('[data-testid="surface-spawn-pack"]') as HTMLButtonElement).click();
  });
  expect((await info(page))['qExplosive']).toBe(3);

  // The pack aggros at 18 m and converges; wait for contact, then throw at a
  // point beside the player — the blast covers the swarm and never hurts the
  // thrower (E42).
  await expect
    .poll(
      async () => {
        const i = await info(page);
        return Math.hypot(Number(i['nearDx'] ?? 99), Number(i['nearDz'] ?? 99));
      },
      { timeout: 10_000 },
    )
    .toBeLessThan(3);
  const size = page.viewportSize();
  await page.mouse.move(Math.round((size?.width ?? 1280) / 2 + 50), Math.round((size?.height ?? 720) / 2));
  const before = Number((await info(page))['kills'] ?? 0);
  await page.keyboard.press('KeyG');
  await expect.poll(async () => (await info(page))['qExplosive']).toBe(2);
  await expect.poll(async () => Number((await info(page))['kills'] ?? 0) - before, { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
});

test('the seventh mine is refused at the six-mine limit and spends nothing (§6.2 case 5)', async ({ page }) => {
  await start(page, URL);
  await settle(page);
  await page.getByTestId('surface-arsenal').click();

  // Pick the mine into the explosive slot through the picker (right-click,
  // in the Windows event order the SPEC-028 run pinned).
  await page.evaluate(() => {
    const slot = document.querySelector('[data-testid="qb-explosive"]');
    if (slot === null) throw new Error('qb-explosive missing');
    slot.dispatchEvent(new PointerEvent('pointerdown', { button: 2, bubbles: true }));
    slot.dispatchEvent(new PointerEvent('pointerup', { button: 2, bubbles: true }));
    slot.dispatchEvent(new MouseEvent('contextmenu', { button: 2, bubbles: true }));
  });
  await expect(page.locator('[data-testid="quick-picker"]')).toBeVisible();
  await page.getByTestId('quick-pick-landmine').click();
  await expect(page.getByTestId('qb-explosive')).toContainText('Mine');
  expect((await info(page))['qExplosive']).toBe(7);

  // Six placements, each spending exactly one mine.
  for (let placed = 1; placed <= 6; placed++) await plant(page, 7 - placed);
  await expect.poll(async () => (await info(page))['mines'], { timeout: 10_000 }).toBe(6);

  // The seventh is refused whole — pressed until it lands outside the
  // cooldown, where the refusal toasts instead of spending.
  await expect
    .poll(
      async () => {
        await page.keyboard.press('KeyG');
        return page.getByTestId('toasts').textContent();
      },
      { timeout: 10_000 },
    )
    .toContain('Mine limit reached');
  // Nothing was spent on the refusal: 7 − 6 placed = 1 left.
  expect((await info(page))['qExplosive']).toBe(1);
  expect((await info(page))['mines']).toBe(6);
});

test('the shop groups Machine guns and Launchers, and the Craft tab makes a frag (§6.2 case 6)', async ({ page }) => {
  await start(page, '/?debug&scene=station');
  await page.evaluate(() =>
    window.__reallm.save().create(0, {
      name: 'Salvager',
      classId: 'marine',
      appearance: { portrait: 0, primary: '#b7472a', secondary: '#2a3b4c' },
      attributes: { might: 3, vigor: 8, agility: 1, tech: 1 },
      difficulty: 'normal',
    }),
  );
  await page.evaluate(() => window.__reallm.go('station', {}, { force: true }));
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('station');
  // The arrival dialogue covers the tabs on a fresh save.
  for (let i = 0; i < 12; i++) {
    if ((await page.locator('.dialogue-dim.is-visible').count()) === 0) break;
    await page.locator('.dialogue-dim.is-visible').click({ force: true });
    await page.waitForTimeout(150);
  }

  // Oil and water through the dev bridge, so the recipe is affordable.
  await page.evaluate(() => {
    const save = window.__reallm.save().current;
    if (save === null) throw new Error('no save');
    save.resources['oil'] = 100;
    save.resources['water'] = 100;
  });

  await page.getByTestId('station-tab-shop').click();
  await page.getByTestId('shop-tab-gear').click();
  await expect(page.getByTestId('shop-heading-machine_gun')).toHaveText('Machine guns');
  await expect(page.getByTestId('shop-heading-launcher')).toHaveText('Launchers');
  await expect(page.getByTestId('shop-gear-launcher_rocket')).toContainText('heavy');

  await page.getByTestId('shop-tab-craft').click();
  await expect(page.getByTestId('shop-craft-frag_grenade')).toBeVisible();
  await page.getByTestId('shop-craft-frag_grenade-buy').click();
  await page.getByTestId('confirm-yes').click();
  const held = await page.evaluate(
    () => window.__reallm.save().current?.inventory.find((entry) => entry.itemId === 'frag_grenade')?.qty ?? 0,
  );
  expect(held).toBe(1);
});
