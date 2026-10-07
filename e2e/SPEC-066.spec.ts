// SPEC-066 §6.10 — pressure that holds, in a real browser: the heal lock's
// refusal and its ring on the heal slot (case 1), one stack per fight — a slot
// emptied mid-fight stays dry, refuses the picker, and refills from the pack
// once the fight is over (case 2), and the combat drone's card reading its DPS
// against the equipped primary (case 6). The rules themselves are pinned in
// node (`tests/systems/combat.test.ts`, `tests/systems/loadout.test.ts`,
// `tests/ui/quickBar.test.ts`); what this proves is the wiring. Cases 3–5 (the
// racks, the half-paid Queen and Hard at the depot) are another file's.
import { expect, test, type Page } from '@playwright/test';
import { COLD_START, start } from './start';

const CREATION = {
  name: 'Vance',
  classId: 'marine',
  appearance: { portrait: 1, primary: '#b7472a', secondary: '#2a3b4c' },
  attributes: { might: 3, vigor: 8, agility: 1, tech: 1 },
  difficulty: 'normal',
} as const;

const URL = '/?debug&seed=123';

/** What `prepare` writes into the fresh slot-0 save before anything is entered. */
interface Prep {
  inventory?: Array<{ itemId: string; qty: number }>;
  quick?: Record<string, string | null>;
}

async function sceneInfo(page: Page): Promise<Record<string, number | string>> {
  return page.evaluate(() => window.__reallm.stats().sceneInfo ?? {});
}

/** A debug-strip press in the page — no pointer, so the input scheme never moves. */
async function press(page: Page, id: string): Promise<void> {
  await page.evaluate((testId) => {
    const button = document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
    if (button === null) throw new Error(`no ${testId} on the debug strip`);
    button.click();
  }, id);
}

/** The toasts on screen, by their text alone — the kind's glyph and the ×N count left out. */
async function toastTexts(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="toasts"] .toast')].map((toast) =>
      [...toast.childNodes]
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent ?? '')
        .join('')
        .trim(),
    ),
  );
}

/** The live HP, off the bound save — `damagePlayer` writes it as the hit lands. */
async function hp(page: Page): Promise<number> {
  return page.evaluate(() => window.__reallm.save().current?.player.hp ?? NaN);
}

/**
 * `surface-hurt` (60) exactly `times` times. A press inside the 0.3 s i-frames
 * of the last hit lands nothing, so each is retried until the HP has fallen.
 */
async function hurt(page: Page, times: number): Promise<void> {
  for (let i = 0; i < times; i++) {
    const before = await hp(page);
    for (let attempt = 0; attempt < 10 && (await hp(page)) >= before; attempt++) {
      if (attempt > 0) await page.waitForTimeout(400);
      await press(page, 'surface-hurt');
    }
    expect(await hp(page)).toBeLessThan(before);
  }
}

/** How many of `itemId` the bound save's pack holds. */
async function packCount(page: Page, itemId: string): Promise<number> {
  return page.evaluate(
    (id) => window.__reallm.save().current?.inventory.find((entry) => entry.itemId === id)?.qty ?? 0,
    itemId,
  );
}

/** A fresh save prepared by `prep`, landed on Cinder-4 with the debug strip up. */
async function land(page: Page, prep: Prep): Promise<void> {
  await start(page, URL);
  await page.evaluate(
    ({ creation, prep }) => {
      const bridge = window.__reallm.save();
      bridge.create(0, creation, 123);
      const save = bridge.current;
      if (save === null) throw new Error('no save bound');
      if (prep.inventory !== undefined) save.inventory = prep.inventory;
      if (prep.quick !== undefined) Object.assign(save.quick, prep.quick);
    },
    { creation: CREATION, prep },
  );
  await page.evaluate(() => window.__reallm.go('surface', { planet: 'cinder4', firstLanding: false }, { force: true }));
  await expect(page.getByTestId('scene-label')).toHaveText('surface', COLD_START);
  await expect(page.getByTestId('transition-fade')).toHaveCSS('pointer-events', 'none', COLD_START);
}

/** Auto-fire off before boot, so only the strip's smite ends a fight. */
async function autoFireOff(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem('reallm:settings', JSON.stringify({ version: 1, autoFire: 'off' })));
}

const healCount = (page: Page) => page.locator('[data-testid="qb-heal"] .qb-count');

test('1. the heal lock: a second heal waits 8 s, says so, and the slot wears the ring', async ({ page }) => {
  test.setTimeout(120_000);
  await land(page, { inventory: [{ itemId: 'medkit', qty: 3 }], quick: { heal: 'medkit' } });
  await expect(healCount(page)).toHaveText('×3');
  await hurt(page, 2); // 184 − 120: a medkit's 92 leaves the bar short of full

  await page.keyboard.press('KeyQ');
  await expect(healCount(page)).toHaveText('×2');
  await expect(page.getByTestId('qb-heal')).toHaveClass(/is-cooling/);
  expect(Number(await page.getByTestId('qb-heal').evaluate((node) => (node as HTMLElement).style.getPropertyValue('--cd')))).toBeGreaterThan(0);

  // E121: a press during the lock spends nothing and says how long is left.
  await page.keyboard.press('KeyQ');
  await expect.poll(async () => (await toastTexts(page)).find((text) => text.startsWith('Heal ready'))).toMatch(/^Heal ready in [78] s$/);
  await expect(healCount(page)).toHaveText('×2');
  expect(await packCount(page, 'medkit')).toBe(2);

  // Once the lock has run out, the ring is gone and the slot spends again.
  await expect.poll(async () => Number((await sceneInfo(page))['healLockLeft']), { timeout: 30_000 }).toBe(0);
  await expect(page.getByTestId('qb-heal')).not.toHaveClass(/is-cooling/);
  await page.keyboard.press('KeyQ');
  await expect(healCount(page)).toHaveText('×1');
});
