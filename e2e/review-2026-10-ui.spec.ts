// Review 2026-10 — the UI easy wins, in a real browser.
//
//   1. V-04 / P-06: the off-screen waypoint and its distance never sit on the
//      quick bar — on the keyboard at 1280 × 720, and in the thumb arc on a
//      touch phone at 844 × 390. The geometry is pinned in node
//      (`tests/ui/waypoint.test.ts`); this reads the boxes the browser drew.
//   2. P-09: the difficulty segments run Story · Casual · Normal · Hard.
//   3. P-16: the class cards and the portraits have names a screen reader says.
//   4. P-15: the New Game sheet dims the menu, and Cancel or the dim close it.
import { expect, test, type CDPSession, type Page } from '@playwright/test';
import { awaitGate, COLD_START, frames, gameUrl, start } from './start';

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

const intersects = (a: Box, b: Box): boolean => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

async function boxOf(page: Page, selector: string): Promise<Box> {
  const found = await page.locator(selector).first().boundingBox();
  if (found === null) throw new Error(`${selector} has no box`);
  return found;
}

/** The arrow (its mark) and its distance label, read in one task. */
async function waypointBoxes(page: Page): Promise<{ mark: Box; label: Box; state: string }> {
  return page.evaluate(() => {
    const root = document.querySelector<HTMLElement>('[data-testid="waypoint"]');
    const mark = root?.querySelector('.waypoint-mark')?.getBoundingClientRect();
    const label = root?.querySelector('.waypoint-dist')?.getBoundingClientRect();
    const box = (r: DOMRect | undefined): { x: number; y: number; width: number; height: number } =>
      r === undefined ? { x: 0, y: 0, width: 0, height: 0 } : { x: r.x, y: r.y, width: r.width, height: r.height };
    return { mark: box(mark), label: box(label), state: root?.dataset['state'] ?? 'off' };
  });
}

const centre = (b: Box): { x: number; y: number } => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

/** Click through any open dialogue — chapter-1 beats are all non-modal. */
async function dismiss(page: Page): Promise<void> {
  const dialogue = page.locator('[data-testid="dialogue"]');
  const advance = page.locator('[data-testid="dialogue-advance"]');
  for (let i = 0; i < 20; i++) {
    if (!(await dialogue.isVisible().catch(() => false))) return;
    if (await advance.isVisible().catch(() => false)) await advance.click({ force: true, timeout: 2_000 }).catch(() => undefined);
    else await dialogue.click({ force: true });
    await page.waitForTimeout(120);
  }
}

// ------------------------------------------------------- 1: the waypoint

test.describe('1. V-04: the waypoint keeps off the quick bar', () => {
  test('at 1280 × 720 on the keyboard, a target behind the player draws its arrow above the bar', async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1280, height: 720 });
    // A fresh save with nothing accepted: the waypoint points at the pad.
    await start(page, '/?debug&scene=surface&planet=cinder4&seed=123');
    await expect(page.getByTestId('scene-label')).toHaveText('surface');
    await expect(page.getByTestId('transition-fade')).toHaveCSS('pointer-events', 'none');
    await dismiss(page);
    await page.getByTestId('surface-goto-pad').click();
    await expect(page.getByTestId('quickbar')).toBeVisible();
    // Walk up the screen until the pad is below the frame, so the arrow sits
    // where the bar is — the review's due-south case.
    await page.keyboard.down('KeyW');
    try {
      await expect
        .poll(
          async () => {
            const read = await waypointBoxes(page);
            return read.state === 'edge' && centre(read.mark).y > 720 / 2 + 150;
          },
          { timeout: 20_000 },
        )
        .toBe(true);
    } finally {
      await page.keyboard.up('KeyW');
    }
    await frames(page, 3);
    const read = await waypointBoxes(page);
    const bar = await boxOf(page, '[data-testid="quickbar"]');
    expect(read.state).toBe('edge');
    expect(Math.abs(centre(read.mark).x - 640), 'the arrow is near due south').toBeLessThan(200);
    expect(intersects(read.mark, bar), 'the arrow is on the quick bar').toBe(false);
    expect(intersects(read.label, bar), 'the distance is on the quick bar').toBe(false);
    // 12 px of air between the arrow and the bar.
    expect(read.mark.y + read.mark.height).toBeLessThanOrEqual(bar.y - 8);
  });

  test.describe('on a touch phone', () => {
    test.use({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true });

    test('at 844 × 390, a target to the south-east keeps the arrow out of the thumb arc', async ({ page }) => {
      test.setTimeout(120_000);
      await page.goto(gameUrl('/?debug&seed=123'));
      await awaitGate(page);
      await page.locator('[data-testid="boot-start"]').tap();
      await expect(page.locator('[data-testid="boot-overlay"]')).toBeHidden();
      await expect(page.locator('[data-testid="scene-label"]')).toBeVisible(COLD_START);
      await expect(page.locator('[data-testid="transition-fade"]')).toHaveCSS('pointer-events', 'none', COLD_START);
      const landed = await page.evaluate(async () => {
        window.__reallm.save().create(
          0,
          {
            name: 'Salvager',
            classId: 'marine',
            appearance: { portrait: 0, primary: '#b7472a', secondary: '#2a3b4c' },
            attributes: { might: 3, vigor: 8, agility: 1, tech: 1 },
            difficulty: 'normal',
          },
          123,
        );
        return window.__reallm.go('surface', { planet: 'cinder4' }, { force: true });
      });
      expect(landed).toBe(true);
      await expect(page.locator('[data-testid="scene-label"]')).toHaveText('surface', COLD_START);
      await expect(page.locator('[data-testid="transition-fade"]')).toHaveCSS('pointer-events', 'none', COLD_START);
      expect(await page.evaluate(() => window.__reallm.input().scheme)).toBe('touch');
      await expect(page.getByTestId('thumb-arc')).toBeVisible();
      // A debug-strip press with no pointer, so the scheme never moves.
      await page.getByTestId('surface-goto-pad').dispatchEvent('click');

      // Walk up and to the left with the stick until the pad lies down and to
      // the right — the arc's corner — with the arrow in that quadrant.
      const cdp: CDPSession = await page.context().newCDPSession(page);
      const at = (x: number, y: number): Array<{ x: number; y: number; id: number }> => [{ x: Math.round(x), y: Math.round(y), id: 1 }];
      const from = { x: 170, y: 300 };
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(from.x, from.y) });
      try {
        for (let i = 1; i <= 8; i++) {
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at(from.x - i * 7, from.y - i * 5) });
          await page.waitForTimeout(25);
        }
        await expect
          .poll(
            async () => {
              const read = await waypointBoxes(page);
              const c = centre(read.mark);
              return read.state === 'edge' && c.x > 844 / 2 + 60 && c.y > 390 / 2 + 20;
            },
            { timeout: 30_000 },
          )
          .toBe(true);
      } finally {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await cdp.detach();
      }
      await frames(page, 3);
      const read = await waypointBoxes(page);
      const arc = await boxOf(page, '[data-testid="thumb-arc"]');
      const bar = await boxOf(page, '[data-testid="quickbar"]');
      expect(read.state).toBe('edge');
      for (const [name, box] of [['the thumb arc', arc], ['the quick bar', bar]] as const) {
        expect(intersects(read.mark, box), `the arrow is on ${name}`).toBe(false);
        expect(intersects(read.label, box), `the distance is on ${name}`).toBe(false);
      }
    });
  });
});

// -------------------------------------------- 2, 3: creation's order and names

test('2, 3. creation: difficulty easiest to hardest, class cards and portraits named for a screen reader', async ({ page }) => {
  await start(page, '/?scene=creation');
  await expect(page.getByTestId('scene-label')).toHaveText('creation', COLD_START);
  await expect(page.getByTestId('transition-fade')).toHaveCSS('pointer-events', 'none', COLD_START);
  // P-09.
  const order = await page.locator('.creation-difficulty [data-testid^="difficulty-"]').evaluateAll((nodes) =>
    nodes.map((node) => (node as HTMLElement).dataset['testid']),
  );
  expect(order).toEqual(['difficulty-story', 'difficulty-casual', 'difficulty-normal', 'difficulty-hard']);
  await expect(page.getByTestId('difficulty-normal')).toHaveAttribute('aria-pressed', 'true');
  // P-16: each card is its class, by name.
  for (const [id, name] of [['marine', 'Marine'], ['engineer', 'Engineer'], ['scout', 'Scout']] as const) {
    await expect(page.getByTestId(`class-${id}`)).toHaveAttribute('aria-label', name);
    await expect(page.getByRole('button', { name, exact: true })).toHaveCount(1);
  }
  // P-16: the portraits are numbered as the row shows them, for every class.
  for (const id of ['marine', 'engineer', 'scout'] as const) {
    await page.getByTestId(`class-${id}`).click();
    const labels = await page.locator('.portrait-row .portrait').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-label')));
    expect(labels).toEqual(['Portrait 1', 'Portrait 2', 'Portrait 3', 'Portrait 4', 'Portrait 5', 'Portrait 6']);
  }
});

// ------------------------------------------------- 4: the New Game sheet

test('4. the New Game sheet dims the menu; Cancel, the dim and Escape each close it and its Back entry', async ({ page }) => {
  await start(page, '/?debug');
  await expect(page.getByTestId('scene-label')).toHaveText('menu');
  const depth = (): Promise<number> => page.evaluate(() => window.__reallm.backDepth());
  const base = await depth();

  await page.getByTestId('menu-new').click();
  await expect(page.getByTestId('new-slot-0')).toBeVisible();
  const backdrop = page.getByTestId('new-backdrop');
  await expect(backdrop).toBeVisible();
  await expect(backdrop).toHaveCSS('background-color', 'rgba(0, 0, 0, 0.5)');
  // It covers the screen, under the sheet: the slot row still takes the click.
  const viewport = page.viewportSize() ?? { width: 0, height: 0 };
  const dim = await boxOf(page, '[data-testid="new-backdrop"]');
  expect(dim.width).toBeGreaterThanOrEqual(viewport.width - 1);
  expect(dim.height).toBeGreaterThanOrEqual(viewport.height - 1);
  const slot = centre(await boxOf(page, '[data-testid="new-slot-0"]'));
  expect(
    await page.evaluate(({ x, y }) => (document.elementFromPoint(x, y) as HTMLElement | null)?.closest('[data-testid]')?.getAttribute('data-testid'), slot),
  ).toBe('new-slot-0');
  expect(await depth()).toBe(base + 1);

  await page.getByTestId('new-cancel').click();
  await expect(page.getByTestId('new-slot-0')).toHaveCount(0);
  await expect(backdrop).toHaveCount(0);
  await expect(page.getByTestId('menu-storage')).toBeVisible();
  expect(await depth()).toBe(base);

  // A tap on the dim, outside the sheet, closes it too. The menu's frame clips
  // what it holds, so the dim is the frame's: tap inside its left edge.
  await page.getByTestId('menu-new').click();
  await expect(page.getByTestId('new-slot-0')).toBeVisible();
  const frame = await boxOf(page, '.screen-frame');
  const spot = { x: frame.x + 30, y: frame.y + frame.height / 2 };
  expect(
    await page.evaluate(({ x, y }) => (document.elementFromPoint(x, y) as HTMLElement | null)?.dataset['testid'], spot),
  ).toBe('new-backdrop');
  await page.mouse.click(spot.x, spot.y);
  await expect(page.getByTestId('new-slot-0')).toHaveCount(0);
  expect(await depth()).toBe(base);

  // And Escape, as before (SPEC-036).
  await page.getByTestId('menu-new').click();
  await expect(page.getByTestId('new-slot-0')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('new-slot-0')).toHaveCount(0);
  expect(await depth()).toBe(base);
});
