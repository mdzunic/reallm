// SPEC-055 §6.3 — the puzzle panel on a phone: at every `PHONE_VIEWPORTS` size,
// on touch, with the Hive's 5 × 5 conduit vault open — the panel lies inside
// the viewport, every cell, HINT and Close is at least 44 px and topmost at its
// centre, the board sits left of its column on a short screen, and a tap on a
// cell turns it.
import { expect, test, type Page } from '@playwright/test';
import { PHONE_VIEWPORTS } from './phone';
import { awaitGate, COLD_START, frames, gameUrl } from './start';

type Box = { x: number; y: number; width: number; height: number };

async function info(page: Page): Promise<Record<string, number | string>> {
  return page.evaluate(() => window.__reallm.stats().sceneInfo ?? {});
}

/** A debug-strip button, clicked from script so no overlay can take the pointer. */
async function tap(page: Page, id: string): Promise<void> {
  await page.evaluate((testid) => (document.querySelector(`[data-testid="${testid}"]`) as HTMLElement).click(), id);
}

/** True when the element hit at `box`'s centre is `testid`'s own element or inside it. */
async function topmost(page: Page, testid: string, box: Box): Promise<boolean> {
  return page.evaluate(
    ({ id, x, y }) => document.elementFromPoint(x, y)?.closest(`[data-testid="${id}"]`) !== null,
    { id: testid, x: box.x + box.width / 2, y: box.y + box.height / 2 },
  );
}

for (const viewport of PHONE_VIEWPORTS) {
  test.describe(`SPEC-055 the puzzle panel at ${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height }, hasTouch: true, isMobile: true });
    test.setTimeout(180_000);

    test('the 5 × 5 panel fits, its targets are 44 px and on top, and a tap turns a cell', async ({ page }) => {
      // The gate passed with a tap, so the scheme is touch from the first frame.
      await page.goto(gameUrl('/?scene=surface&planet=hive&debug'));
      await awaitGate(page);
      await page.locator('[data-testid="boot-start"]').tap();
      await expect(page.locator('[data-testid="boot-overlay"]')).toBeHidden();
      await expect(page.locator('[data-testid="scene-label"]')).toHaveText('surface', COLD_START);
      await expect(page.locator('[data-testid="transition-fade"]')).toHaveCSS('pointer-events', 'none', COLD_START);
      expect(await page.evaluate(() => window.__reallm.input().scheme)).toBe('touch');
      await tap(page, 'surface-descend');
      await page.waitForFunction(() => window.__reallm.stats().sceneInfo?.['level'] === 'underground', undefined, COLD_START);
      await page.waitForFunction(() => window.__reallm.stats().sceneInfo?.['held'] === 0, undefined, COLD_START);
      const use = page.locator('[data-testid="touch-interact"]');
      const panel = page.locator('[data-testid="puzzle-panel"]');
      for (let attempt = 1; ; attempt++) {
        await tap(page, 'surface-goto-vault');
        await frames(page, 4);
        // The Hive's packs stand in its far rooms, the vault's among them: on a
        // loaded machine a hit can knock the salvager off the terminal before the tap.
        for (let i = 0; i < 20 && Number((await info(page))['caveEnemies']) > 0; i++) {
          await tap(page, 'surface-smite');
          await frames(page, 2);
        }
        await tap(page, 'surface-goto-puzzle');
        await expect(use).toBeVisible(COLD_START);
        await use.tap();
        const opened = await panel.waitFor({ state: 'visible', timeout: 20_000 }).then(
          () => true,
          () => false,
        );
        if (opened || (await panel.isVisible())) break;
        if (attempt === 3) await expect(panel).toBeVisible(COLD_START);
      }
      await page.waitForFunction(() => window.__reallm.stats().sceneInfo?.['held'] === 1, undefined, COLD_START);
      expect((await info(page))['puzzle']).toBe('hive_vault');
      // Toasts ride over every layer; measure once the rack is clear.
      await expect(page.locator('.toast-rack .toast')).toHaveCount(0, COLD_START);
      await frames(page, 4);

      const own = (await panel.boundingBox()) as Box;
      expect(own.x).toBeGreaterThanOrEqual(0);
      expect(own.y).toBeGreaterThanOrEqual(0);
      expect(own.x + own.width).toBeLessThanOrEqual(viewport.width + 0.5);
      expect(own.y + own.height).toBeLessThanOrEqual(viewport.height + 0.5);

      const cells = page.locator('[data-testid^="puzzle-cell-"]');
      await expect(cells).toHaveCount(25);
      const targets: string[] = [];
      for (let r = 0; r < 5; r++) for (let c = 0; c < 5; c++) targets.push(`puzzle-cell-${r}-${c}`);
      targets.push('puzzle-hint', 'puzzle-close');
      for (const id of targets) {
        const box = (await page.locator(`[data-testid="${id}"]`).boundingBox()) as Box;
        expect(box.width, `${id} width`).toBeGreaterThanOrEqual(43.5);
        expect(box.height, `${id} height`).toBeGreaterThanOrEqual(43.5);
        expect(box.x, id).toBeGreaterThanOrEqual(-0.5);
        expect(box.y, id).toBeGreaterThanOrEqual(-0.5);
        expect(box.x + box.width, id).toBeLessThanOrEqual(viewport.width + 0.5);
        expect(box.y + box.height, id).toBeLessThanOrEqual(viewport.height + 0.5);
        expect(await topmost(page, id, box), `${id} topmost`).toBe(true);
      }

      // §4.4: a short screen puts the board left of its column.
      if (viewport.height <= 500) {
        const board = (await page.locator('[data-testid="puzzle-board"]').boundingBox()) as Box;
        const side = (await page.locator('.puzzle-side').boundingBox()) as Box;
        expect(board.x + board.width).toBeLessThanOrEqual(side.x + 0.5);
      }

      // A tap on a tile that turns — the one `puzzleHint` names — is a move.
      const hint = String((await info(page))['puzzleHint']);
      expect(hint).toMatch(/^cell:\d+$/);
      const cell = Number(hint.slice('cell:'.length));
      expect((await info(page))['puzzleMoves']).toBe(0);
      await page.locator(`[data-testid="puzzle-cell-${Math.floor(cell / 5)}-${cell % 5}"]`).tap();
      await page.waitForFunction(() => window.__reallm.stats().sceneInfo?.['puzzleMoves'] === 1, undefined, COLD_START);
    });
  });
}
