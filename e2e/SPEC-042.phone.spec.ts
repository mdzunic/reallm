// SPEC-042 §6.3 — the phone matrix: at every `PHONE_VIEWPORTS` size, on touch,
// the new rows keep SPEC-037's layout whole. Project `phone-landscape` (a
// Chromium phone with touch and `isMobile`); one describe and one viewport per
// size, as SPEC-037 §4.11 sets the matrix up.
//
//   1. an effect running: SPEC-037 §6.3 case 1's busy-landing checks hold —
//      the stick region, the reach and the disjoint top band — and the chip
//      lies inside the top-left column's `Lv N` row;
//   2. the banner: in the upper half, off the arc and the bar, and on a short
//      screen the toasts wait for it;
//   3. the boss frame: in the upper half, off the arc, the tracker and the
//      minimap; on a short screen the target frame stays hidden.
//
// The layout checks of case 1 are SPEC-037's own, carried here because they
// live in that spec file's module (a spec file cannot import another's).
import { expect, test, type Page } from '@playwright/test';
import { PHONE_VIEWPORTS } from './phone';
import { awaitGate, COLD_START, gameUrl } from './start';

const CREATION = {
  name: 'Salvager',
  classId: 'marine',
  appearance: { portrait: 0, primary: '#b7472a', secondary: '#2a3b4c' },
  attributes: { might: 3, vigor: 8, agility: 1, tech: 1 },
  difficulty: 'normal',
} as const;

/** SPEC-037 §6.3 case 1's toast — SPEC-034's two-line shipped-home line. */
const SHIPPED = 'Hold full — surplus shipped to Command Relay.';
const QUICK_BAR = ['qb-sidearm', 'qb-primary', 'qb-heavy', 'qb-heal', 'qb-explosive', 'qb-utility'] as const;

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

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

/** SPEC-037 §6.3: the leading 45 % of the width over the lower 50 % of the height. */
function joystickRegion(width: number, height: number): Box {
  return { x: 0, y: height * 0.5, width: width * 0.45, height: height * 0.5 };
}

async function box(page: Page, testid: string): Promise<Box> {
  const found = await page.getByTestId(testid).boundingBox();
  if (found === null) throw new Error(`${testid} has no box`);
  return found;
}

/** The toasts the rack actually draws — it caps what it draws by height. */
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

/** A debug-strip press with no pointer, so the input scheme never moves. */
async function press(page: Page, testid: string): Promise<void> {
  await page.getByTestId(testid).dispatchEvent('click');
}

/** A fresh first boot, the gate tapped (a phone boots on touch), and a landing on Cinder-4. */
async function land(page: Page, active: string[] = []): Promise<void> {
  await page.goto(gameUrl('/?debug&seed=123'));
  await awaitGate(page);
  await page.getByTestId('boot-start').tap();
  await expect(page.getByTestId('boot-overlay')).toBeHidden();
  await expect(page.getByTestId('scene-label')).toBeVisible(COLD_START);
  await expect(page.getByTestId('transition-fade')).toHaveCSS('pointer-events', 'none', COLD_START);
  const landed = await page.evaluate(
    async ({ creation, active }) => {
      window.__reallm.save().create(0, creation, 123);
      const save = window.__reallm.save().current;
      if (save !== null) save.progress.missionsActive = active.map((id) => ({ id, stage: 0, counters: {} }));
      return window.__reallm.go('surface', { planet: 'cinder4' }, { force: true });
    },
    { creation: CREATION, active },
  );
  expect(landed, 'go("surface") was refused').toBe(true);
  await expect(page.getByTestId('scene-label')).toHaveText('surface', COLD_START);
  await expect(page.getByTestId('transition-fade')).toHaveCSS('pointer-events', 'none', COLD_START);
  expect(await page.evaluate(() => window.__reallm.input().scheme)).toBe('touch');
  await expect(page.getByTestId('thumb-arc')).toBeVisible();
}

/** Tap through any open line with its `›`. */
async function dismiss(page: Page): Promise<void> {
  const dialogue = page.getByTestId('dialogue');
  const advance = page.getByTestId('dialogue-advance');
  for (let i = 0; i < 30; i++) {
    if (!(await dialogue.isVisible().catch(() => false))) return;
    if (await advance.isVisible().catch(() => false)) await advance.tap({ force: true, timeout: 2_000 }).catch(() => undefined);
    await page.waitForTimeout(150);
  }
}

/** SPEC-037 §6.3 case 1's busy state: the storm banner, one toast, and USE at the pad. */
async function busy(page: Page): Promise<void> {
  await press(page, 'surface-storm');
  await page.evaluate((text) => window.__reallm.toast(text, 'warn', 60_000), SHIPPED);
  await press(page, 'surface-goto-pad');
  await expect(page.getByTestId('hud-weather')).toBeVisible();
  await expect(page.getByTestId('touch-interact')).toBeVisible({ timeout: 10_000 });
  await expect.poll(async () => (await shownToasts(page)).length).toBe(1);
}

/** SPEC-037 §6.3 case 1: the joystick region, the reach and the disjoint top band. */
async function checkLayout(page: Page, width: number, height: number): Promise<void> {
  const region = joystickRegion(width, height);
  for (const testid of ['objective-tracker', 'minimap', 'touch-pause', 'touch-interact', ...QUICK_BAR]) {
    expect(intersects(await box(page, testid), region), `${testid} is clear of the stick`).toBe(false);
  }
  const arc = await box(page, 'thumb-arc');
  const corner = { x: arc.x + arc.width, y: arc.y + arc.height };
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

/** Where the upper half ends, less the 8 px margin of §4.9. */
const halfLine = (page: Page): Promise<number> => page.evaluate(() => window.innerHeight / 2 - 8);

for (const size of PHONE_VIEWPORTS) {
  test.describe(`${size.name} (${size.width}×${size.height})`, () => {
    test.use({ viewport: { width: size.width, height: size.height } });
    const short = size.height <= 500;

    test('1. with an effect running, the busy landing holds, and the chip sits in the Lv N row', async ({ page }) => {
      test.setTimeout(150_000);
      await land(page);
      // A coolant pack dropped at the feet fills the gadget slot; a tap uses it.
      await press(page, 'surface-drop-item');
      const slot = page.getByTestId('qb-utility');
      await expect(slot).not.toHaveClass(/is-empty/, { timeout: 10_000 });
      // The pickup's toast goes before the busy state raises its own.
      await expect(page.locator('.toast', { hasText: 'Picked up Coolant Pack' })).toBeHidden({ timeout: 10_000 });
      await slot.tap();
      const chip = page.getByTestId('hud-effect-hazard_immunity');
      await expect(chip).toBeVisible({ timeout: 10_000 });
      await busy(page);
      await expect(chip).toBeVisible();
      await checkLayout(page, size.width, size.height);
      const row = await page.locator('[data-testid="hud"] .hud-tl .hud-level-row').boundingBox();
      if (row === null) throw new Error('the Lv N row has no box');
      expect(inside(await box(page, 'hud-effect-hazard_immunity'), row), 'the chip is inside the Lv N row').toBe(true);
      expect(inside(row, await page.locator('[data-testid="hud"] .hud-tl').boundingBox().then((b) => b as Box))).toBe(true);
    });

    test('2. the banner keeps to the upper half and off the bar, and short screens hold the toasts for it', async ({ page }) => {
      test.setTimeout(150_000);
      await land(page, ['c1_m1']);
      await dismiss(page);
      for (let i = 0; i < 6; i++) {
        const done = await page.evaluate(() => window.__reallm.save().current?.progress.missionsDone.includes('c1_m1') === true);
        if (done) break;
        await press(page, 'surface-finish-stage');
        await page.waitForTimeout(250);
      }
      const banner = page.getByTestId('mission-complete');
      await expect(banner).toBeVisible();
      if (short) await page.evaluate(() => window.__reallm.toast('Test toast', 'info', 60_000));
      const shown = await box(page, 'mission-complete');
      expect(shown.y + shown.height).toBeLessThanOrEqual((await halfLine(page)) + 0.5);
      expect(intersects(shown, await box(page, 'thumb-arc')), 'the banner is on the arc').toBe(false);
      for (const testid of QUICK_BAR) expect(intersects(shown, await box(page, testid)), `the banner is on ${testid}`).toBe(false);
      if (!short) return;
      // One line, no next line: the tracker already names the pad's offer.
      await expect(page.getByTestId('mission-complete-next')).toBeHidden();
      const toast = page.locator('.toast', { hasText: 'Test toast' });
      await expect(toast).toBeHidden();
      await expect(banner).toBeVisible();
      await expect(toast).toBeHidden();
      await expect(banner).toBeHidden({ timeout: 20_000 });
      // Once it has gone — and the line it held back has had its turn — the toast shows.
      for (let i = 0; i < 8 && !(await toast.isVisible()); i++) {
        await dismiss(page);
        await page.waitForTimeout(400);
      }
      await expect(toast).toBeVisible({ timeout: 20_000 });
    });

    test('3. the boss frame keeps to the upper half, and short screens leave the target frame out', async ({ page }) => {
      test.setTimeout(150_000);
      await land(page);
      await press(page, 'surface-spawn-boss');
      const frame = page.getByTestId('hud-boss');
      await expect(frame).toBeVisible({ timeout: 15_000 });
      const shown = await box(page, 'hud-boss');
      expect(shown.y + shown.height).toBeLessThanOrEqual((await halfLine(page)) + 0.5);
      for (const testid of ['thumb-arc', 'objective-tracker', 'minimap']) {
        expect(intersects(shown, await box(page, testid)), `the boss frame is on ${testid}`).toBe(false);
      }
      if (!short) return;
      // One row on a short screen: the name before the bar.
      const name = await box(page, 'hud-boss-name');
      const track = await frame.locator('.boss-frame-track').boundingBox();
      if (track === null) throw new Error('the boss bar has no box');
      expect(name.x + name.width).toBeLessThanOrEqual(track.x + 0.5);
      // The hit puts an elite in the frame's model; the short screen keeps it hidden.
      await press(page, 'surface-hit-elite');
      const target = page.getByTestId('hud-target');
      await expect(target).not.toHaveClass(/is-hidden/, { timeout: 10_000 });
      await expect(target).toBeHidden();
    });
  });
}
