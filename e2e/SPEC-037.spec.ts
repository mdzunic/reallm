// SPEC-037 §6.2 — one HUD for every screen, in a real browser: the quick-bar
// badges, the plate, the flash that never strobes, the toasts off the boss bar
// and the trip bar, the bottom stack, the keyboard minimap, the interact
// prompt, the wallet's light, one wallet at the station, the tablet camera,
// the flight on a phone, the touch polish and the words.
//
// 1280 × 720 on the keyboard unless a case says otherwise. The pure halves —
// the flash gate, the camera maths, the state line, the wallet clock, the toast
// shift — are pinned in node (`tests/ui/helpers.test.ts`); the phone matrix is
// `SPEC-037.phone.spec.ts`.
import { expect, test, type Page } from '@playwright/test';
import { awaitGate, COLD_START, gameUrl, start } from './start';

/** §6.2: a fresh save on Cinder-4 with the debug strip up. */
const URL = '/?debug&scene=surface&planet=cinder4&seed=123';

const CREATION = {
  name: 'Salvager',
  classId: 'marine',
  appearance: { portrait: 0, primary: '#b7472a', secondary: '#2a3b4c' },
  attributes: { might: 3, vigor: 8, agility: 1, tech: 1 },
  difficulty: 'normal',
} as const;

type Box = { x: number; y: number; width: number; height: number };

const info = async (page: Page): Promise<Record<string, number | string>> =>
  (await page.evaluate(() => window.__reallm.stats())).sceneInfo ?? {};

async function settle(page: Page, scene = 'surface'): Promise<void> {
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText(scene, COLD_START);
  await expect(page.locator('[data-testid="transition-fade"]')).toHaveCSS('pointer-events', 'none', COLD_START);
}

/** Navigate and pass the gate with a tap, as a phone does (SPEC-036 §4.2). */
async function startTouch(page: Page, url = '/'): Promise<void> {
  await page.goto(gameUrl(url));
  await awaitGate(page);
  await page.locator('[data-testid="boot-start"]').tap();
  await expect(page.locator('[data-testid="boot-overlay"]')).toBeHidden();
  await expect(page.locator('[data-testid="scene-label"]')).toBeVisible(COLD_START);
  await expect(page.locator('[data-testid="transition-fade"]')).toHaveCSS('pointer-events', 'none', COLD_START);
}

/** A debug-strip press with no pointer, so the input scheme never moves. */
async function press(page: Page, testid: string): Promise<void> {
  await page.getByTestId(testid).dispatchEvent('click');
}

async function box(page: Page, testid: string): Promise<Box> {
  const found = await page.getByTestId(testid).boundingBox();
  if (found === null) throw new Error(`${testid} has no box`);
  return found;
}

function intersects(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/**
 * Click through the dialogue the landing may have queued: the `›` of a
 * non-modal line (SPEC-037 §4.3), or the box of a modal one.
 */
async function dismissDialogue(page: Page): Promise<void> {
  const dialogue = page.getByTestId('dialogue');
  const advance = page.getByTestId('dialogue-advance');
  for (let i = 0; i < 30; i++) {
    if (!(await dialogue.isVisible().catch(() => false))) return;
    // The line can move on by itself between the look and the press; the next
    // pass looks again.
    if (await advance.isVisible().catch(() => false)) await advance.click({ force: true, timeout: 2_000 }).catch(() => undefined);
    else await dialogue.click({ force: true, timeout: 2_000 }).catch(() => undefined);
    await page.waitForTimeout(120);
  }
}

/**
 * A MutationObserver on the vignette that counts rising edges of
 * `is-flashing` — one class write per edge (§4.6), read off the record's old
 * value and the value after it — and notes when each one landed, on the
 * `performance.now()` clock the gate itself reads. The observer runs in the
 * microtask after the hit that lit the edge, so the time is the hit's.
 */
async function watchFlash(page: Page): Promise<void> {
  await page.evaluate(() => {
    const vignette = document.querySelector('.hud-vignette');
    if (!(vignette instanceof HTMLElement)) throw new Error('no vignette');
    const scope = window as unknown as { __flashEdges: number[]; __flashObserver?: MutationObserver };
    scope.__flashObserver?.disconnect();
    scope.__flashEdges = [];
    let was = vignette.classList.contains('is-flashing');
    const observer = new MutationObserver((records) => {
      const at = performance.now() / 1000;
      records.forEach((record, i) => {
        const after = i + 1 < records.length ? (records[i + 1]?.oldValue ?? '') : vignette.className;
        const now = after.split(/\s+/).includes('is-flashing');
        if (!was && now) scope.__flashEdges.push(at);
        was = now;
      });
    });
    observer.observe(vignette, { attributes: true, attributeFilter: ['class'], attributeOldValue: true });
    scope.__flashObserver = observer;
  });
}

/** When each rising edge since `watchFlash` landed, in `performance.now()` seconds. */
const flashEdgeTimes = (page: Page): Promise<number[]> =>
  page.evaluate(() => (window as unknown as { __flashEdges: number[] }).__flashEdges.slice());

const flashEdges = async (page: Page): Promise<number> => (await flashEdgeTimes(page)).length;

/** SPEC-037 §4.6's `FLASH_MIN_GAP`: the least time between two rising edges, s. */
const FLASH_MIN_GAP = 0.35;

/** The HP readout's current value — `♥184/184` reads 184. */
async function hp(page: Page): Promise<number> {
  const text = (await page.getByTestId('hud-hp').textContent()) ?? '';
  return Number(/(\d+)\s*\/\s*\d+/.exec(text)?.[1] ?? Number.NaN);
}

/**
 * Ten `surface-hurt-from` presses, 90 ms apart — inside one second on an idle
 * page. Resolves to the `performance.now()` seconds of the first and the last.
 * The gaps are timers, so on a page whose frames take longer than 90 ms each
 * press waits for the frame in its way, and the ten spread out.
 */
async function tenHits(page: Page): Promise<{ first: number; last: number }> {
  return page.evaluate(async () => {
    const button = document.querySelector('[data-testid="surface-hurt-from"]') as HTMLButtonElement;
    let first = 0;
    let last = 0;
    for (let i = 0; i < 10; i++) {
      last = performance.now() / 1000;
      if (i === 0) first = last;
      button.click();
      await new Promise((resolve) => setTimeout(resolve, 90));
    }
    return { first, last };
  });
}

/** A save, then a forced trip — what the SPEC-031 suites call `withSave` + `go`. */
async function goWithSave(page: Page, id: string, params: unknown, patch?: string): Promise<void> {
  await page.evaluate(
    async ({ creation, id, params, patch }) => {
      const data = window.__reallm.save().create(0, creation);
      data.resources['oil'] = 400;
      if (patch === 'gauntlet') {
        data.progress.flags.push('chapter4_done');
        data.progress.missionsActive.push({ id: 'c5_m1', stage: 0, counters: {} });
      }
      await window.__reallm.go(id, params, { force: true });
    },
    { creation: CREATION, id, params, patch },
  );
}

// ------------------------------------------------------------------ 1: badges

test('1. the quick-bar badges read at 11 px and up, and no slot says READY (§4.4)', async ({ page }) => {
  test.setTimeout(150_000);
  await start(page, URL);
  await settle(page);

  // A ration in the heal slot: its count is the bar's one count at landing.
  await expect(page.locator('[data-testid="qb-heal"] .qb-count')).toHaveText(/^×\d+$/);
  const badges = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.qb-key, .qb-count, .qb-state')]
      .filter((node) => getComputedStyle(node).display !== 'none' && !node.classList.contains('is-hidden'))
      .filter((node) => (node.textContent ?? '') !== '')
      .map((node) => {
        const rect = node.getBoundingClientRect();
        return { cls: node.className, size: parseFloat(getComputedStyle(node).fontSize), w: rect.width, h: rect.height };
      }),
  );
  expect(badges.length).toBeGreaterThanOrEqual(4); // six key caps and the heal count, at least
  for (const badge of badges) {
    expect(badge.size, badge.cls).toBeGreaterThanOrEqual(11);
    expect(badge.w * badge.h, badge.cls).toBeGreaterThan(0);
  }
  const healCount = await page.locator('[data-testid="qb-heal"] .qb-count').evaluate((node) => parseFloat(getComputedStyle(node).fontSize));
  expect(healCount).toBeGreaterThanOrEqual(12);

  // At rest every weapon slot's state line is empty — and hidden.
  for (const slot of ['qb-sidearm', 'qb-primary', 'qb-heavy']) {
    await expect(page.locator(`[data-testid="${slot}"] .qb-state`)).toHaveText('');
    await expect(page.locator(`[data-testid="${slot}"] .qb-state`)).toBeHidden();
  }
  await expect(page.getByTestId('quickbar')).not.toContainText('READY');

  // The rocket: 3 on the keyboard, then hold fire. Its one charge goes, the
  // hand goes back, and the slot counts the recharge down in seconds.
  await press(page, 'surface-arsenal');
  await expect(page.getByTestId('qb-heavy')).toContainText('Rocket');
  await page.mouse.move(820, 240);
  await page.keyboard.press('Digit3');
  await expect.poll(async () => (await info(page))['weaponSlot']).toBe('heavy');
  await page.keyboard.down('Space');
  await page.waitForTimeout(3000);
  await expect
    .poll(async () => page.locator('[data-testid="qb-heavy"] .qb-state').textContent(), { timeout: 15_000 })
    .toMatch(/^\d+\.\d s$/);
  await page.keyboard.up('Space');
  const state = page.locator('[data-testid="qb-heavy"] .qb-state');
  expect(await state.evaluate((node) => parseFloat(getComputedStyle(node).fontSize))).toBeGreaterThanOrEqual(11);
  await expect(page.getByTestId('quickbar')).not.toContainText('READY');
});

// ------------------------------------------------------------------- 2: plate

test('2. on Vetra the top-left column sits on the 0.75 plate and the wallet is one short row (§4.5)', async ({ page }) => {
  await start(page, '/?debug&scene=surface&planet=vetra&seed=123');
  await settle(page);
  const plate = await page.locator('.hud-tl').evaluate((node) => getComputedStyle(node).backgroundColor);
  const alpha = Number(/rgba\([^)]*,\s*([\d.]+)\)/.exec(plate)?.[1] ?? 1);
  expect(plate).toMatch(/^rgba\(4, 6, 10, /);
  expect(alpha).toBeCloseTo(0.75, 2);
  const wallet = await box(page, 'hud-wallet');
  expect(wallet.height).toBeLessThanOrEqual(24);
  await expect(page.getByTestId('hud-wallet')).toHaveCSS('pointer-events', 'none');
});

// ------------------------------------------------------------------- 3: flash

test('3. weather never flashes, a barrage rises at most three times, and Off shows none (§4.6)', async ({ page }) => {
  test.setTimeout(150_000);
  await start(page, URL);
  await settle(page);
  await dismissDialogue(page);
  await expect(page.getByTestId('hud')).toHaveAttribute('data-flash', 'full');

  // A storm in the open: HP falls tick by tick, and the edge never lights.
  await watchFlash(page);
  const hpBefore = await hp(page);
  expect(hpBefore).toBeGreaterThan(0);
  await press(page, 'surface-storm');
  await page.waitForTimeout(3000);
  expect(await flashEdges(page)).toBe(0);
  await expect.poll(async () => hp(page), { timeout: 15_000 }).toBeLessThan(hpBefore);
  expect(await flashEdges(page)).toBe(0);

  // Ten hits inside a second: the gate lets at most three edges through.
  // What the gate promises is a rising edge at most once per `FLASH_MIN_GAP`,
  // which is at most three in any one second, so that is what is asserted —
  // edge by edge, on the times the edges landed. It is the same claim as
  // "ten hits, three edges" whenever the ten land inside a second, which is
  // every run on an idle page. On a loaded GPU-less run (SPEC-040 §4.2 draws
  // every frame such a host gets) the 90 ms timers wait out ~250 ms frames,
  // the ten spread over 1.5 s or more, and a fourth edge a whole gap after the
  // third is the gate working, not failing.
  await watchFlash(page);
  const hits = await tenHits(page);
  await page.waitForTimeout(300);
  const at = await flashEdgeTimes(page);
  const report = `edges at ${at.map((t) => (t - hits.first).toFixed(3)).join(', ')} s; last hit at ${(hits.last - hits.first).toFixed(3)} s`;
  expect(at.length, report).toBeGreaterThanOrEqual(1);
  // 25 ms of slack: the observer notes the time once the whole hit has run —
  // the burst, the shake and the number after the gate read the clock — and a
  // gate that strobed would show the 90 ms of the hits, not 325.
  for (let i = 1; i < at.length; i++) {
    expect((at[i] as number) - (at[i - 1] as number), report).toBeGreaterThanOrEqual(FLASH_MIN_GAP - 0.025);
  }
  for (let i = 3; i < at.length; i++) expect((at[i] as number) - (at[i - 3] as number), report).toBeGreaterThan(1);
  if (hits.last - hits.first < 1) expect(at.length, report).toBeLessThanOrEqual(3);

  // Settings → Damage flash → Off: the same ten hits light nothing.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('pause-menu')).toBeVisible();
  await page.getByTestId('pause-settings').click();
  await expect(page.getByTestId('settings-damage-flash-full')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('settings-damage-flash-off').click();
  await expect(page.getByTestId('settings-damage-flash-off')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('settings-damage-flash-subtle')).toBeVisible();
  await page.getByTestId('settings-close').click();
  await page.getByTestId('pause-resume').click();
  await expect(page.getByTestId('pause-menu')).toBeHidden();
  await expect(page.getByTestId('hud')).toHaveAttribute('data-flash', 'off');
  await watchFlash(page);
  await tenHits(page);
  await page.waitForTimeout(300);
  expect(await flashEdges(page)).toBe(0);
});

// ------------------------------------------------------------------ 4: toasts

test('4. a toast lands under the top-right cluster, off the boss bar and off the trip bar (§4.3)', async ({ page }) => {
  test.setTimeout(150_000);
  await start(page, URL);
  await settle(page);
  await press(page, 'surface-spawn-boss');
  await expect(page.getByTestId('hud-boss')).toBeVisible({ timeout: 20_000 });
  await page.evaluate(() => window.__reallm.toast('Test toast', 'info', 60_000));
  const toast = page.locator('.toast', { hasText: 'Test toast' });
  await expect(toast).toBeVisible();
  const toastBox = await toast.boundingBox();
  if (toastBox === null) throw new Error('the toast has no box');
  expect(intersects(toastBox, await box(page, 'hud-boss'))).toBe(false);
  // Right-aligned under the (empty, on the keyboard) top-right cluster.
  expect(toastBox.x + toastBox.width).toBeGreaterThan(1280 - 20);
  expect(toastBox.y).toBeLessThan(40);

  await goWithSave(page, 'flight', { destination: 'cinder4' });
  await settle(page, 'flight');
  await page.evaluate(() => window.__reallm.toast('Flight toast', 'info', 60_000));
  const flightToast = page.locator('.toast', { hasText: 'Flight toast' });
  await expect(flightToast).toBeVisible();
  const flightBox = await flightToast.boundingBox();
  if (flightBox === null) throw new Error('the flight toast has no box');
  expect(intersects(flightBox, await box(page, 'hud-progress'))).toBe(false);
});

// ------------------------------------------------------------ 5: bottom stack

test('5. a dialogue sits on the bottom stack, clear of the quick bar and its ▲ (§4.3)', async ({ page }) => {
  await start(page, URL);
  await settle(page);
  await dismissDialogue(page);
  await page.evaluate(() => window.__reallm.playDialogue('intro_command'));
  const dialogue = page.getByTestId('dialogue');
  await expect(dialogue).toBeVisible();
  const read = await page.evaluate(() => {
    const dialogueBox = document.querySelector('[data-testid="dialogue"]')?.getBoundingClientRect();
    const bar = document.querySelector('[data-testid="quickbar"]')?.getBoundingClientRect();
    const active = document.querySelector('.qb-slot.is-active');
    if (!dialogueBox || !bar || !(active instanceof HTMLElement)) throw new Error('no dialogue, bar or active slot');
    // The ▲ is the active slot's ::after, placed against its padding box.
    const slot = active.getBoundingClientRect();
    const marker = slot.top + parseFloat(getComputedStyle(active).borderTopWidth) + parseFloat(getComputedStyle(active, '::after').top);
    return { bottom: dialogueBox.bottom, barTop: Math.min(bar.top, marker) };
  });
  expect(read.bottom).toBeLessThanOrEqual(read.barTop - 4);
  // A modal line keeps its whole-box tap and shows no advance control.
  await expect(dialogue).toHaveClass(/is-modal/);
  await expect(page.getByTestId('dialogue-advance')).toBeHidden();
});

// ---------------------------------------------------------- 6: the keyboard minimap

test('6. on the keyboard the minimap sits in the corner and a click there fires rather than opening the map (§4.2)', async ({ page }) => {
  await start(page, URL);
  await settle(page);
  await dismissDialogue(page);
  const minimap = await box(page, 'minimap');
  expect(720 - (minimap.y + minimap.height)).toBeLessThanOrEqual(20);
  expect(1280 - (minimap.x + minimap.width)).toBeLessThanOrEqual(20);
  const at = await page.evaluate(() => {
    const rect = document.querySelector('[data-testid="minimap"]')?.getBoundingClientRect();
    if (!rect) throw new Error('no minimap');
    return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.id ?? '';
  });
  expect(at).toBe('game');
  await page.mouse.click(minimap.x + minimap.width / 2, minimap.y + minimap.height / 2);
  await page.waitForTimeout(300);
  await expect(page.getByTestId('map-screen')).toBeHidden();
  // The keys are drawn: M on the rim, T after the tracker's head.
  await expect(page.locator('.hud-br > kbd.keycap')).toHaveText('M');
  await expect(page.locator('.tracker-head kbd.keycap')).toHaveText('T');
  await expect(page.getByTestId('objective-tracker')).toHaveCSS('pointer-events', 'none');
  await page.keyboard.press('KeyM');
  await expect(page.getByTestId('map-screen')).toBeVisible();
});

// ---------------------------------------------------------------- 7: interact

test('7. at the pad the prompt sits centred above the bar and leads with an E cap (§4.3)', async ({ page }) => {
  await start(page, URL);
  await settle(page);
  await dismissDialogue(page);
  await press(page, 'surface-goto-pad');
  const prompt = page.getByTestId('hud-interact');
  await expect(prompt).toBeVisible({ timeout: 10_000 });
  await expect(prompt).toHaveText(/^E\s*Open pad terminal$/);
  await expect(prompt.locator('kbd.keycap')).toHaveText('E');
  const at = await box(page, 'hud-interact');
  expect(Math.abs(at.x + at.width / 2 - 640)).toBeLessThanOrEqual(128);
  const bar = await box(page, 'quickbar');
  expect(at.y + at.height).toBeLessThanOrEqual(bar.y);
});

// ------------------------------------------------------------------ 8: wallet

test.describe('8. the wallet strip lights on a change and dims 5 s later (§4.2)', () => {
  test.use({ reducedMotion: 'reduce' });

  test('raising oil by 10 lights it, and six seconds on it is back at 0.6', async ({ page }) => {
    // A bound save — a `?scene=` jump plays on an in-memory one the bridge cannot reach.
    await start(page, '/?debug&seed=123');
    await goWithSave(page, 'surface', { planet: 'cinder4' });
    await settle(page);
    const wallet = page.getByTestId('hud-wallet');
    await expect(wallet).toHaveCSS('opacity', '0.6', { timeout: 15_000 });
    await page.evaluate(() => {
      const data = window.__reallm.save().current;
      if (data === null) throw new Error('no save');
      data.resources['oil'] = (data.resources['oil'] ?? 0) + 10;
    });
    await expect(wallet).toHaveCSS('opacity', '1');
    await page.waitForTimeout(6000);
    // Five seconds of *game* time; a starved tab stretches it past the wall's.
    await expect(wallet).toHaveCSS('opacity', '0.6', { timeout: 15_000 });
  });
});

// ------------------------------------------------------------ 9: the station

test('9. the station’s Character tab shows one wallet — the header’s (§4.2)', async ({ page }) => {
  await start(page);
  await goWithSave(page, 'station', {});
  await settle(page, 'station');
  for (let i = 0; i < 12; i++) {
    if ((await page.locator('.dialogue-dim.is-visible').count()) === 0) break;
    await page.locator('.dialogue-dim.is-visible').click({ force: true });
    await page.waitForTimeout(150);
  }
  await page.getByTestId('station-tab-character').click();
  await expect(page.getByTestId('character-panel')).toBeVisible();
  const wallets = page.locator('[data-testid="wallet"]');
  await expect(wallets.filter({ visible: true })).toHaveCount(1);
  await expect(page.locator('.screen-status [data-testid="wallet"]')).toBeVisible();
  await expect(page.locator('[data-testid="character-panel"] [data-testid="wallet"]')).toHaveCount(0);
});

// ----------------------------------------------------------- 10: the tablet

test.describe('10. an upright tablet opens the field of view and keeps the desktop distance (§4.7)', () => {
  test.use({ viewport: { width: 820, height: 1180 }, hasTouch: true, isMobile: true });

  test('fov ≥ 60 and camDistance 22 at 820 × 1180 on touch', async ({ page }) => {
    await startTouch(page, '/?scene=surface&planet=cinder4');
    await settle(page);
    expect(await page.evaluate(() => window.__reallm.input().scheme)).toBe('touch');
    await expect.poll(async () => Number((await info(page))['fov'])).toBeGreaterThanOrEqual(60);
    expect(Number((await info(page))['camDistance'])).toBe(22);
  });
});

// ------------------------------------------------------- 11: flight on touch

test.describe('11. flight on a phone (§4.8)', () => {
  test.use({ viewport: { width: 740, height: 360 }, hasTouch: true, isMobile: true, reducedMotion: 'reduce' });

  test('one reticle, an objective clear of ▲ / ▼, and a 14 px throttle', async ({ page }) => {
    await startTouch(page);
    await goWithSave(page, 'flight', { destination: 'hive' }, 'gauntlet');
    await settle(page, 'flight');
    await expect(page.getByTestId('touch-controls')).toBeVisible();
    await expect(page.getByTestId('reticle')).toBeVisible();
    await expect(page.getByTestId('touch-reticle')).toHaveCount(0);
    const objective = page.locator('.hud-objective');
    await expect(objective).toBeVisible({ timeout: 20_000 });
    await expect(objective).toContainText('Gauntlet');
    const line = await objective.boundingBox();
    if (line === null) throw new Error('no objective box');
    expect(intersects(line, await box(page, 'touch-throttleUp'))).toBe(false);
    expect(intersects(line, await box(page, 'touch-throttleDown'))).toBe(false);
    expect(line.width).toBeLessThanOrEqual(740 * 0.6 + 1);
    await expect(page.getByTestId('hud-throttle')).toHaveCSS('font-size', '14px');
    // The top centre spans the same gap as the surface's, with the pause beside it.
    const tc = await page.locator('.hud-tc').boundingBox();
    const tl = await page.locator('.hud-tl').boundingBox();
    if (tc === null || tl === null) throw new Error('no top band');
    expect(tc.x).toBeCloseTo(tl.x + tl.width + 8, 0);
    expect(tc.x + tc.width).toBeCloseTo(740 - 10 - 52 - 8, 0);
    await expect(page.getByTestId('hud-wallet')).toHaveCount(0);
  });
});

// ------------------------------------------------------------------ 12: polish

test('12. #ui selects nothing, and the callsign is a 16 px field with a Done key (§4.9)', async ({ page }) => {
  await start(page);
  await expect(page.locator('#ui')).toHaveCSS('user-select', 'none');
  await page.evaluate(() => window.__reallm.go('creation', { slot: 0 }));
  await settle(page, 'creation');
  const name = page.getByTestId('creation-name');
  expect(await name.evaluate((node) => parseFloat(getComputedStyle(node).fontSize))).toBeGreaterThanOrEqual(16);
  await expect(name).toHaveAttribute('enterkeyhint', 'done');
  await expect(name).toHaveAttribute('autocomplete', 'off');
  await expect(name).toHaveAttribute('autocorrect', 'off');
  await expect(name).toHaveAttribute('autocapitalize', 'words');
  await expect(name).toHaveAttribute('spellcheck', 'false');
  await name.click();
  await name.pressSequentially('Vance');
  await name.press('Enter');
  await expect(name).not.toBeFocused();
  await expect(name).toHaveValue('Vance');
});

test.describe('12. a touched slot is drawn pressed (§4.9)', () => {
  test.use({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true });

  test('pointerdown on qb-sidearm adds is-down and pointerup takes it away', async ({ page }) => {
    await startTouch(page, URL);
    await settle(page);
    const slot = page.getByTestId('qb-sidearm');
    await expect(slot).toBeVisible();
    await slot.dispatchEvent('pointerdown', { button: 0, pointerId: 7, pointerType: 'touch', bubbles: true });
    await expect(slot).toHaveClass(/is-down/);
    await slot.dispatchEvent('pointerup', { button: 0, pointerId: 7, pointerType: 'touch', bubbles: true });
    await expect(slot).not.toHaveClass(/is-down/);
    // In play on touch the build label is off the stick's corner.
    await expect(page.getByTestId('version-label')).toBeHidden();
  });
});

// ------------------------------------------------------------------- 13: words

test.describe('13. the touch controls sheet names no SWAP and no ITEM (§4.10)', () => {
  test.use({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true });

  test('the pause menu’s sheet', async ({ page }) => {
    await startTouch(page, '/?scene=surface&planet=cinder4');
    await settle(page);
    await page.getByTestId('touch-pause').tap();
    await expect(page.getByTestId('pause-menu')).toBeVisible();
    await page.getByTestId('pause-controls').tap();
    const sheet = page.getByTestId('pause-sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText('Tap the heal slot on the bar');
    await expect(sheet).not.toContainText('SWAP');
    await expect(sheet).not.toContainText('ITEM');
  });
});

// -------------------------------------------- 37-a, 37-j, 37-l: the scheme flip

test.describe('37-a, 37-j, 37-l. a scheme flip moves the bar, the minimap and USE (§4.1, §4.2)', () => {
  // A touch-capable window that boots on the keyboard: the flip is the player's.
  test.use({ viewport: { width: 844, height: 390 }, hasTouch: true });

  test('the bar keeps its state across a flip, USE hides with the layer, and the picker opens over the arc', async ({ page }) => {
    test.setTimeout(120_000);
    await start(page, URL);
    await settle(page);
    await dismissDialogue(page);
    const scheme = (): Promise<string> => page.evaluate(() => window.__reallm.input().scheme);
    expect(await scheme()).toBe('keyboard');

    // The keyboard: the bar in the bottom centre, no arc, the minimap in its corner.
    await expect(page.getByTestId('thumb-arc')).toBeHidden();
    await expect(page.locator('.hud-bc [data-testid="quickbar"]')).toHaveCount(1);
    await expect(page.locator('.hud-br [data-testid="minimap"]')).toHaveCount(1);
    await page.keyboard.press('Digit1');
    await expect(page.getByTestId('qb-sidearm')).toHaveClass(/is-active/);
    await press(page, 'surface-goto-pad');
    await expect(page.getByTestId('hud-interact')).toHaveText(/^E\s*Open pad terminal$/, { timeout: 10_000 });

    // One tap on open ground: the bar moves into the arc with the sidearm still
    // in hand, the minimap to the top-right cluster (re-measured), and USE
    // shows in its cell while the prompt prints nothing.
    await page.touchscreen.tap(422, 175);
    await expect.poll(scheme).toBe('touch');
    await expect(page.getByTestId('thumb-arc')).toBeVisible();
    await expect(page.locator('[data-testid="arc-slots"] [data-testid="quickbar"]')).toHaveCount(1);
    await expect(page.getByTestId('qb-sidearm')).toHaveClass(/is-active/);
    await expect(page.locator('.hud-tr [data-testid="minimap"]')).toHaveCount(1);
    await expect
      .poll(async () =>
        page.getByTestId('minimap').evaluate((node) => {
          const canvas = node as HTMLCanvasElement;
          return canvas.width === Math.round(canvas.getBoundingClientRect().width * Math.min(window.devicePixelRatio, 2));
        }),
      )
      .toBe(true);
    await expect(page.locator('[data-testid="arc-action"] [data-testid="touch-interact"]')).toBeVisible();
    await expect(page.getByTestId('hud-interact')).toBeHidden();

    // 37-l: a long press on the heal slot opens the picker above the arc, on its outer edge.
    const heal = page.getByTestId('qb-heal');
    await heal.dispatchEvent('pointerdown', { button: 0, pointerId: 9, pointerType: 'touch', bubbles: true });
    await page.waitForTimeout(700);
    await heal.dispatchEvent('pointerup', { button: 0, pointerId: 9, pointerType: 'touch', bubbles: true });
    const picker = page.getByTestId('quick-picker');
    await expect(picker).toBeVisible();
    const pickerBox = await box(page, 'quick-picker');
    const arc = await box(page, 'thumb-arc');
    expect(Math.abs(pickerBox.x + pickerBox.width - (arc.x + arc.width))).toBeLessThanOrEqual(1);
    expect(pickerBox.y + pickerBox.height).toBeLessThanOrEqual(arc.y - 16); // clear of the active slot's ▲

    // A key: the picker closes, the scheme is the keyboard's again, the bar and
    // the minimap go home with the sidearm still in hand, and USE hides with
    // the layer while the prompt says E (37-j).
    await page.keyboard.press('Escape');
    await expect(picker).toHaveCount(0);
    await expect.poll(scheme).toBe('keyboard');
    await expect(page.getByTestId('thumb-arc')).toBeHidden();
    await expect(page.locator('.hud-bc [data-testid="quickbar"]')).toHaveCount(1);
    await expect(page.getByTestId('qb-sidearm')).toHaveClass(/is-active/);
    await expect(page.locator('.hud-br [data-testid="minimap"]')).toHaveCount(1);
    await expect(page.getByTestId('touch-interact')).toBeHidden();
    await expect(page.getByTestId('hud-interact')).toHaveText(/^E\s*Open pad terminal$/);
  });
});
