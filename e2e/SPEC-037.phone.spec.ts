// SPEC-037 §6.3 — the phone matrix: at every `PHONE_VIEWPORTS` size, on touch,
// the HUD keeps out of the stick's way and out of its own way. Project
// `phone-landscape` (a Chromium phone with touch and `isMobile`); one describe
// and one viewport per size (§4.11).
//
//   1. the busy landing — storm banner, a toast, USE at the pad: nothing
//      interactive in the joystick region, every slot within a thumb's reach
//      of the arc's corner, the top band's pieces and the arc pairwise
//      disjoint, and the aim ghost clear of the arc and the toast; and the
//      arc's cells (§6.3 case 5);
//   2. a line of dialogue: clear of the arc, the tracker and the minimap,
//      above half the height on a short screen with the toasts held behind
//      it, and pass-through to the play surface;
//   3. three toasts: one shown on a phone, three on the tablet, none on the arc;
//   4. the same landing mirrored, with `joystickSide: 'right'` stored.
import { expect, test, type CDPSession, type Page } from '@playwright/test';
import { PHONE_VIEWPORTS } from './phone';
import { awaitGate, COLD_START, gameUrl } from './start';

const CREATION = {
  name: 'Salvager',
  classId: 'marine',
  appearance: { portrait: 0, primary: '#b7472a', secondary: '#2a3b4c' },
  attributes: { might: 3, vigor: 8, agility: 1, tech: 1 },
  difficulty: 'normal',
} as const;

/** The busy state's toast (§6.3 case 1) — SPEC-034's two-line shipped-home line. */
const SHIPPED = 'Cargo full — surplus shipped to Command Relay.';

const QUICK_BAR = ['qb-sidearm', 'qb-primary', 'qb-heavy', 'qb-heal', 'qb-explosive', 'qb-utility'] as const;

type Side = 'left' | 'right';
interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

const info = async (page: Page): Promise<Record<string, number | string>> =>
  (await page.evaluate(() => window.__reallm.stats())).sceneInfo ?? {};

function intersects(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function inside(inner: Box, outer: Box): boolean {
  return (
    inner.x >= outer.x - 0.5 &&
    inner.y >= outer.y - 0.5 &&
    inner.x + inner.width <= outer.x + outer.width + 0.5 &&
    inner.y + inner.height <= outer.y + outer.height + 0.5
  );
}

/** §6.3: the leading 45 % of the width over the lower 50 % of the height, mirrored with the side. */
function joystickRegion(width: number, height: number, side: Side): Box {
  const w = width * 0.45;
  return { x: side === 'left' ? 0 : width - w, y: height * 0.5, width: w, height: height * 0.5 };
}

async function box(page: Page, testid: string): Promise<Box> {
  const found = await page.getByTestId(testid).boundingBox();
  if (found === null) throw new Error(`${testid} has no box`);
  return found;
}

/** The one toast on screen with `text`, drawn — the rack caps what it draws by height. */
async function shownToasts(page: Page): Promise<Box[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('[data-testid="toasts"] .toast')]
      .filter((node) => node.getClientRects().length > 0 && getComputedStyle(node).display !== 'none')
      .map((node) => {
        const r = node.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      }),
  );
}

/**
 * A fresh context's first boot, with `joystickSide` stored when mirrored, the
 * gate passed by a tap (a phone boots on touch, SPEC-036 §4.2), a save
 * created, and a landing on Cinder-4 with the debug strip up.
 */
async function land(page: Page, side: Side = 'left'): Promise<void> {
  if (side === 'right') {
    await page.addInitScript(() => {
      try {
        if (sessionStorage.getItem('reallm-e2e-seeded') !== null) return;
        sessionStorage.setItem('reallm-e2e-seeded', '1');
        localStorage.setItem('reallm:settings', JSON.stringify({ version: 1, joystickSide: 'right' }));
      } catch {
        /* a document with no storage of its own */
      }
    });
  }
  await page.goto(gameUrl('/?debug&seed=123'));
  await awaitGate(page);
  await page.locator('[data-testid="boot-start"]').tap();
  await expect(page.locator('[data-testid="boot-overlay"]')).toBeHidden();
  await expect(page.locator('[data-testid="scene-label"]')).toBeVisible(COLD_START);
  // The menu's entry fade still runs after its label appears, and a `go()`
  // issued during it is refused (SPEC-003 AC-14, D-2): wait it out, as
  // `start()` does. Unwaited, this landing lost that race on CI's GPU runner.
  await expect(page.locator('[data-testid="transition-fade"]')).toHaveCSS('pointer-events', 'none', COLD_START);
  const landed = await page.evaluate(async (creation) => {
    window.__reallm.save().create(0, creation, 123);
    return window.__reallm.go('surface', { planet: 'cinder4' }, { force: true });
  }, CREATION);
  expect(landed, 'go("surface") was refused, or fell back to the menu').toBe(true);
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('surface', COLD_START);
  await expect(page.locator('[data-testid="transition-fade"]')).toHaveCSS('pointer-events', 'none', COLD_START);
  expect(await page.evaluate(() => window.__reallm.input().scheme)).toBe('touch');
  await expect(page.getByTestId('thumb-arc')).toBeVisible();
}

/** A debug-strip press with no pointer, so the input scheme never moves. */
async function press(page: Page, testid: string): Promise<void> {
  await page.getByTestId(testid).dispatchEvent('click');
}

/** §6.3 case 1's busy state: the storm banner, one toast, and USE at the pad. */
async function busy(page: Page): Promise<void> {
  await press(page, 'surface-storm');
  await page.evaluate((text) => window.__reallm.toast(text, 'warn', 60_000), SHIPPED);
  await press(page, 'surface-goto-pad');
  await expect(page.getByTestId('hud-weather')).toBeVisible();
  await expect(page.getByTestId('touch-interact')).toBeVisible({ timeout: 10_000 });
  await expect.poll(async () => (await shownToasts(page)).length).toBe(1);
}

/** §6.3 cases 1 and 4: the joystick region, the reach, and the disjoint top band. */
async function checkLayout(page: Page, width: number, height: number, side: Side): Promise<void> {
  const region = joystickRegion(width, height, side);
  for (const testid of ['objective-tracker', 'minimap', 'touch-pause', 'touch-interact', ...QUICK_BAR]) {
    expect(intersects(await box(page, testid), region), `${testid} is clear of the ${side} stick`).toBe(false);
  }

  // Every slot within a thumb's reach of the arc's outer bottom corner. The
  // arc's own geometry (§4.1: 262 × 150, three 56 px columns 6 px apart) puts
  // the far slot's centre 260.3 px out, so the reach is read to the whole pixel.
  const arc = await box(page, 'thumb-arc');
  const corner = { x: side === 'left' ? arc.x + arc.width : arc.x, y: arc.y + arc.height };
  for (const testid of QUICK_BAR) {
    const slot = await box(page, testid);
    const reach = Math.hypot(slot.x + slot.width / 2 - corner.x, slot.y + slot.height / 2 - corner.y);
    expect(Math.round(reach), `${testid} from the arc's corner`).toBeLessThanOrEqual(260);
  }

  const toasts = await shownToasts(page);
  expect(toasts).toHaveLength(1);
  const pieces: Array<[string, Box]> = [];
  for (const testid of ['hud-hp', 'objective-tracker', 'hud-wallet', 'hud-weather', 'minimap', 'touch-pause', 'thumb-arc']) {
    pieces.push([testid, await box(page, testid)]);
  }
  pieces.push(['toast', toasts[0] as Box]);
  for (let i = 0; i < pieces.length; i++) {
    for (let j = i + 1; j < pieces.length; j++) {
      const [a, boxA] = pieces[i] as [string, Box];
      const [b, boxB] = pieces[j] as [string, Box];
      expect(intersects(boxA, boxB), `${a} and ${b} overlap`).toBe(false);
    }
  }
}

/** A real one-finger touch drag through the compositor — hit-tested, as a thumb is. */
async function touchDrag(
  page: Page,
  from: { x: number; y: number },
  during: () => Promise<void>,
): Promise<void> {
  const cdp: CDPSession = await page.context().newCDPSession(page);
  const point = (x: number, y: number): Array<{ x: number; y: number; id: number }> => [{ x: Math.round(x), y: Math.round(y), id: 1 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(from.x, from.y) });
  for (let i = 1; i <= 8; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: point(from.x - i * 8, from.y - i * 5) });
    await page.waitForTimeout(25);
  }
  await during();
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

for (const size of PHONE_VIEWPORTS) {
  test.describe(`${size.name} (${size.width}×${size.height})`, () => {
    test.use({ viewport: { width: size.width, height: size.height } });

    test('1, 5. the busy landing keeps the stick, the reach and the top band clear, and the arc holds its cells', async ({
      page,
    }) => {
      await land(page);
      // The zone ghosts of a first touch landing (SPEC-036 §4.12), read
      // before anything takes them down.
      const aim = page.getByTestId('touch-zone-aim');
      await expect(aim).toBeVisible();
      await busy(page);
      await expect(aim).toBeVisible();
      const ghost = await box(page, 'touch-zone-aim');
      expect(intersects(ghost, await box(page, 'thumb-arc')), 'the aim ghost is on the arc').toBe(false);
      expect(intersects(ghost, (await shownToasts(page))[0] as Box), 'the aim ghost is under the toast').toBe(false);

      await checkLayout(page, size.width, size.height, 'left');

      // §6.3 case 5, as SPEC-038 §4.1 fills it: the corner cell holds DASH and
      // takes pointer events; USE is in its own cell.
      const primary = page.getByTestId('arc-primary');
      expect(await page.getByTestId('touch-dash').evaluate((node) => node.parentElement?.dataset['testid'])).toBe('arc-primary');
      await expect(page.getByTestId('touch-dash')).toBeVisible();
      expect(inside(await box(page, 'touch-dash'), await box(page, 'arc-primary'))).toBe(true);
      await expect(primary).toHaveCSS('pointer-events', 'auto');
      expect(await page.getByTestId('touch-interact').evaluate((node) => node.parentElement?.dataset['testid'])).toBe('arc-action');
      expect(inside(await box(page, 'touch-interact'), await box(page, 'arc-action'))).toBe(true);
      await expect(page.getByTestId('touch-weaponNext')).toHaveCount(0);
      await expect(page.getByTestId('touch-useItem')).toHaveCount(0);
    });

    test.describe('2. a line of dialogue', () => {
      // The whole line lands at once, so an unchanged text means an unskipped line.
      test.use({ reducedMotion: 'reduce' });

      test('clear of the arc, the tracker and the minimap, docked short, and pass-through', async ({ page }) => {
        await land(page);
        await page.evaluate(() => window.__reallm.playDialogue('c1_m1_accept'));
        const dialogue = page.getByTestId('dialogue');
        await expect(dialogue).toBeVisible();
        await expect(dialogue).not.toHaveClass(/is-modal/);
        await expect(page.getByTestId('dialogue-advance')).toBeVisible();
        const line = await box(page, 'dialogue');
        for (const testid of ['thumb-arc', 'objective-tracker', 'minimap']) {
          expect(intersects(line, await box(page, testid)), `the dialogue is on ${testid}`).toBe(false);
        }
        const short = size.height <= 500;
        if (short) {
          const half = await page.evaluate(() => window.innerHeight / 2 - 8);
          expect(line.y + line.height).toBeLessThanOrEqual(half + 0.5);
          // The rack holds for the line: a toast raised now waits for it.
          await page.evaluate(() => window.__reallm.toast('Test toast', 'info', 60_000));
          await page.waitForTimeout(300);
          await expect(page.locator('.toast', { hasText: 'Test toast' })).toBeHidden();
        }

        // A thumb that lands on the line's middle lands on the play surface.
        const text = await page.locator('.dialogue-text').textContent();
        const centre = { x: line.x + line.width / 2, y: line.y + line.height / 2 };
        const moveZone = centre.x < size.width * 0.45; // the stick is on the left here
        const before = await info(page);
        let aimed = false;
        await touchDrag(page, centre, async () => {
          await page.waitForTimeout(700);
          aimed = (await page.evaluate(() => window.__reallm.input().aim.dragging)) === true;
        });
        await expect(page.locator('.dialogue-text')).toHaveText(text ?? '');
        if (moveZone) {
          const after = await info(page);
          expect([after['px'], after['pz']]).not.toEqual([before['px'], before['pz']]);
        } else {
          expect(aimed, 'the drag aimed from the play surface').toBe(true);
        }

        // `›` advances the line; once it ends, a held toast shows.
        const advance = page.getByTestId('dialogue-advance');
        for (let i = 0; i < 6 && (await dialogue.isVisible()); i++) {
          await advance.tap();
          await page.waitForTimeout(150);
        }
        await expect(dialogue).toBeHidden();
        if (short) await expect(page.locator('.toast', { hasText: 'Test toast' })).toBeVisible();
      });
    });

    test('3. three toasts: one on a phone, three on the tablet, none on the arc', async ({ page }) => {
      await land(page);
      await page.evaluate((newest) => {
        window.__reallm.toast('First toast', 'info', 60_000);
        window.__reallm.toast('Second toast', 'info', 60_000);
        window.__reallm.toast(newest, 'warn', 60_000);
      }, SHIPPED);
      await expect(page.locator('[data-testid="toasts"] .toast')).toHaveCount(3);
      const expected = size.height <= 420 ? 1 : size.height <= 500 ? 2 : 3;
      expect(expected, 'every phone in the matrix shows one').toBe(size.width >= 1000 ? 3 : 1);
      await expect.poll(async () => (await shownToasts(page)).length).toBe(expected);
      const arc = await box(page, 'thumb-arc');
      for (const toast of await shownToasts(page)) expect(intersects(toast, arc)).toBe(false);
      if (expected !== 1) return;
      // The newest is the one a phone keeps: two lines of it, or at 320 px and
      // under one, cut with an ellipsis. The whole text stays in the DOM.
      const newest = page.locator('.toast', { hasText: SHIPPED });
      await expect(newest).toBeVisible();
      await expect(newest).toContainText(SHIPPED);
      const clamp = await newest.evaluate((node) => {
        const style = getComputedStyle(node);
        return { lines: style.webkitLineClamp, clipped: node.scrollHeight > node.clientHeight + 1, height: node.getBoundingClientRect().height };
      });
      if (size.height <= 320) {
        expect(clamp.lines).toBe('1');
        expect(clamp.clipped, 'the one line is cut').toBe(true);
        expect(clamp.height).toBeLessThan(45);
      } else {
        expect(clamp.lines).toBe('2');
        expect(clamp.height).toBeLessThan(64);
      }
    });

    test('4. mirrored: with the stick on the right the arc goes bottom-left, and case 1 holds', async ({ page }) => {
      await land(page, 'right');
      await busy(page);
      const arc = await box(page, 'thumb-arc');
      expect(arc.x).toBeLessThan(size.width / 2);
      expect(arc.y + arc.height).toBeGreaterThan(size.height * 0.75);
      await expect(page.getByTestId('hud')).toHaveAttribute('data-side', 'right');
      await checkLayout(page, size.width, size.height, 'right');
    });
  });
}
