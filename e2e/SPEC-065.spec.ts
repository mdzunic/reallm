// SPEC-065 §6.3 — the Relay depot in the browser. The economy's rules, the
// v3 → v4 step and the words are proved in node (`tests/systems/depot.test.ts`,
// `tests/core/save.test.ts`, `tests/ui/helpers.test.ts`); this proves the
// wiring a player reaches: the pad terminal's Cargo section ships the hold's
// surplus home, the station's Depot tab draws it back — by mouse, keyboard
// and touch — and a jump the depot can pay departs with no fuel refusal and
// earns no free oil on the way (E119).
import { expect, test, type Page } from '@playwright/test';
import { awaitGate, COLD_START, gameUrl, start } from './start';

const CREATION = {
  name: 'Vance',
  classId: 'marine',
  appearance: { portrait: 1, primary: '#b7472a', secondary: '#2a3b4c' },
  attributes: { might: 6, vigor: 5, agility: 1, tech: 1 },
  difficulty: 'normal',
} as const;

const URL = '/?seed=123';
const DEBUG_URL = '/?debug&seed=123';

/** What `prepare` writes into the fresh slot-0 save before anything is entered. */
interface Prep {
  oil?: number;
  water?: number;
  /** What Command Relay already keeps, per resource. */
  depot?: Record<string, number>;
  /** The pad terminal's reserve, per resource. */
  keep?: Record<string, number>;
  done?: string[];
  active?: Array<{ id: string; stage: number }>;
}

async function prepare(page: Page, prep: Prep): Promise<void> {
  await page.evaluate(
    ({ creation, prep }) => {
      const bridge = window.__reallm.save();
      bridge.create(0, creation, 123);
      const save = bridge.current;
      if (save === null) throw new Error('no save bound');
      if (prep.oil !== undefined) save.resources['oil'] = prep.oil;
      if (prep.water !== undefined) save.resources['water'] = prep.water;
      for (const [resource, amount] of Object.entries(prep.depot ?? {})) save.depot.held[resource] = amount;
      for (const [resource, amount] of Object.entries(prep.keep ?? {})) save.depot.keep[resource] = amount;
      if (prep.done !== undefined) save.progress.missionsDone = [...prep.done];
      if (prep.active !== undefined) save.progress.missionsActive = prep.active.map(({ id, stage }) => ({ id, stage, counters: {} }));
    },
    { creation: CREATION, prep },
  );
}

/** The scene is up and its fade has let go, so a press lands. */
async function settle(page: Page, scene: string): Promise<void> {
  await expect(page.getByTestId('scene-label')).toHaveText(scene, COLD_START);
  await expect(page.getByTestId('transition-fade')).toHaveCSS('pointer-events', 'none', COLD_START);
}

/** Click through any open dialogue line. */
async function dismiss(page: Page): Promise<void> {
  const dialogue = page.getByTestId('dialogue');
  const advance = page.getByTestId('dialogue-advance');
  for (let i = 0; i < 30; i++) {
    if (!(await dialogue.isVisible().catch(() => false))) return;
    if (await advance.isVisible().catch(() => false)) await advance.click({ force: true, timeout: 2_000 }).catch(() => undefined);
    else await dialogue.click({ force: true, timeout: 2_000 }).catch(() => undefined);
    await page.waitForTimeout(120);
  }
}

/** The bound save on Cinder-4's surface, past any first line. */
async function land(page: Page): Promise<void> {
  await page.evaluate(() => window.__reallm.go('surface', { planet: 'cinder4', firstLanding: false }, { force: true }));
  await settle(page, 'surface');
  await dismiss(page);
}

/** Onto the pad from the debug strip, then E until PAD TERMINAL is up. */
async function openTerminal(page: Page): Promise<void> {
  await page.evaluate(() => {
    const button = document.querySelector<HTMLButtonElement>('[data-testid="surface-goto-pad"]');
    if (button === null) throw new Error('no surface-goto-pad on the debug strip');
    button.click();
  });
  const terminal = page.getByTestId('pad-terminal');
  for (let i = 0; i < 6 && !(await terminal.isVisible()); i++) {
    await page.keyboard.press('KeyE');
    await page.waitForTimeout(400);
  }
  await expect(terminal).toBeVisible();
}

/** The station for the save already bound. */
async function station(page: Page): Promise<void> {
  await page.evaluate(() => window.__reallm.go('station', {}, { force: true }));
  await settle(page, 'station');
}

/** The live save's hold, depot and reserve for one resource. */
async function tank(page: Page, resource = 'oil'): Promise<{ hold: number; depot: number; keep: number }> {
  return page.evaluate((r) => {
    const save = window.__reallm.save().current;
    if (save === null) throw new Error('no save bound');
    return { hold: save.resources[r] ?? -1, depot: save.depot.held[r] ?? -1, keep: save.depot.keep[r] ?? -1 };
  }, resource);
}

/** The `data-testid` of whatever holds focus, or `null`. */
async function focused(page: Page): Promise<string | null> {
  return page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset['testid'] ?? null);
}

/** True while focus is inside the element with testid `id`. */
async function focusInside(page: Page, id: string): Promise<boolean> {
  return page.evaluate((testid) => document.querySelector(`[data-testid="${testid}"]`)?.contains(document.activeElement) ?? false, id);
}

/** Tab until `id` holds focus — the keyboard's own way there. */
async function tabTo(page: Page, id: string, most = 40): Promise<void> {
  for (let i = 0; i < most; i++) {
    if ((await focused(page)) === id) return;
    await page.keyboard.press('Tab');
  }
  expect(await focused(page), `Tab reached ${id}`).toBe(id);
}

/** The testids that start with `prefix`, in document order. */
async function testIds(page: Page, prefix: string): Promise<string[]> {
  return page.evaluate(
    (start) => [...document.querySelectorAll<HTMLElement>(`[data-testid^="${start}"]`)].map((node) => node.dataset['testid'] ?? ''),
    prefix,
  );
}

const walletOil = (page: Page) => page.getByTestId('wallet-oil').locator('.wallet-value');

/**
 * Records every toast the page shows from now on, kept after the toast itself
 * has expired — the subsidy's line is raised as the station enters, and a slow
 * container's fade can outlast it.
 */
async function watchToasts(page: Page): Promise<void> {
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { __seenToasts: string[] }).__seenToasts = seen;
    const rack = document.querySelector('[data-testid="toasts"]');
    if (rack === null) throw new Error('no toast rack');
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) if (node instanceof HTMLElement) seen.push(node.textContent ?? '');
      }
    }).observe(rack, { childList: true, subtree: true });
  });
}

/** Whether any toast since `watchToasts` said `text`. */
async function toastSeen(page: Page, text: string): Promise<boolean> {
  return page.evaluate((words) => ((window as unknown as { __seenToasts?: string[] }).__seenToasts ?? []).some((toast) => toast.includes(words)), text);
}

// ------------------------------------------------------------ §6.3 steps 1–3

test('1–3. the pad terminal ships the oil above the reserve home, and the Depot tab draws it back', async ({ page }) => {
  // A landing, the terminal, a return and the station: on a starved container
  // the two scene loads alone can take a minute.
  test.setTimeout(240_000);
  await start(page, DEBUG_URL);
  // 65-a: water's reserve was set on a bigger hold than this one's 400.
  await prepare(page, { oil: 400, keep: { water: 1_000 } });
  await land(page);
  await openTerminal(page);

  // §4.5: a Cargo section above the footer row, one row per resource in order.
  const cargo = page.getByTestId('terminal-cargo');
  await expect(cargo).toBeVisible();
  await expect(cargo.locator('.terminal-heading')).toHaveText('Cargo');
  expect(await testIds(page, 'terminal-cargo-')).toEqual(['terminal-cargo-oil', 'terminal-cargo-wheat', 'terminal-cargo-water', 'terminal-cargo-lithium']);
  expect(
    await page.evaluate(() => {
      const section = document.querySelector('[data-testid="terminal-cargo"]');
      const back = document.querySelector('[data-testid="terminal-return"]');
      return section !== null && back !== null && (section.compareDocumentPosition(back) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    }),
  ).toBe(true);

  // Step 1: the hold at its 400 cap and the reserve at 100, so 300 ship.
  await expect(page.getByTestId('terminal-held-oil')).toHaveText('oil 400 / 400');
  await expect(page.getByTestId('terminal-keep-oil')).toHaveText('Keep 100');
  await expect(page.getByTestId('terminal-keep-less-oil')).toHaveAttribute('aria-label', 'Keep less oil');
  await expect(page.getByTestId('terminal-keep-more-oil')).toHaveAttribute('aria-label', 'Keep more oil');
  const ship = page.getByTestId('terminal-ship-oil');
  await expect(ship).toHaveText('Ship 300 home');
  await expect(ship).toBeEnabled();
  // 65-b: the fresh 20 wheat sits under its reserve of 100.
  await expect(page.getByTestId('terminal-ship-wheat')).toHaveText('Nothing to ship');
  await expect(page.getByTestId('terminal-ship-wheat')).toBeDisabled();
  await expect(cargo).not.toContainText('Delivery needs');

  // By keyboard: the terminal re-renders through keepFocus, so focus stays in it.
  await watchToasts(page);
  await ship.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => toastSeen(page, 'Shipped 300 oil to Command Relay.')).toBe(true);
  await expect(page.getByTestId('terminal-held-oil')).toHaveText('oil 100 / 400');
  await expect(ship).toHaveText('Nothing to ship');
  await expect(ship).toBeDisabled();
  expect(await tank(page)).toEqual({ hold: 100, depot: 300, keep: 100 });
  await expect(page.getByTestId('pad-terminal')).toBeVisible();
  expect(await focusInside(page, 'pad-terminal')).toBe(true);

  // Step 2: two steps down — the reserve reads 0, and the 100 aboard can go too.
  await page.getByTestId('terminal-keep-less-oil').click();
  await expect(page.getByTestId('terminal-keep-oil')).toHaveText('Keep 50');
  await expect(ship).toHaveText('Ship 50 home');
  await page.getByTestId('terminal-keep-less-oil').click();
  await expect(page.getByTestId('terminal-keep-oil')).toHaveText('Keep 0');
  await expect(ship).toHaveText('Ship 100 home');
  await expect(page.getByTestId('terminal-keep-less-oil')).toBeDisabled();
  expect(await tank(page)).toEqual({ hold: 100, depot: 300, keep: 0 });
  // A step up and back again.
  await page.getByTestId('terminal-keep-more-oil').click();
  await expect(page.getByTestId('terminal-keep-oil')).toHaveText('Keep 50');
  await expect(ship).toHaveText('Ship 50 home');
  await page.getByTestId('terminal-keep-less-oil').click();
  await expect(page.getByTestId('terminal-keep-oil')).toHaveText('Keep 0');

  // 65-a: a reserve above the cap shows, and steps, at the cap; the stored one
  // waits for the step.
  await expect(page.getByTestId('terminal-keep-water')).toHaveText('Keep 400');
  await expect(page.getByTestId('terminal-keep-more-water')).toBeDisabled();
  expect((await tank(page, 'water')).keep).toBe(1_000);
  await page.getByTestId('terminal-keep-less-water').click();
  await expect(page.getByTestId('terminal-keep-water')).toHaveText('Keep 350');
  await expect(page.getByTestId('terminal-keep-more-water')).toBeEnabled();
  expect((await tank(page, 'water')).keep).toBe(350);

  // Step 3: home through the terminal. 100 aboard and 300 at the depot need no subsidy.
  await watchToasts(page);
  await page.getByTestId('terminal-return').click();
  await settle(page, 'station');
  expect(await toastSeen(page, 'Docking subsidy')).toBe(false);
  await expect(walletOil(page)).toHaveText('100');
  await page.getByTestId('station-tab-depot').click();
  await expect(page.getByTestId('station-tab-depot')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('depot')).toBeVisible();
  await expect(page.getByTestId('depot-title')).toHaveText('Command Relay depot');
  expect(await testIds(page, 'depot-row-')).toEqual(['depot-row-oil', 'depot-row-wheat', 'depot-row-water', 'depot-row-lithium']);
  // Opening the tab changed nothing.
  expect(await tank(page)).toEqual({ hold: 100, depot: 300, keep: 0 });
  await expect(page.getByTestId('depot-row-oil')).toContainText('oil');
  await expect(page.getByTestId('depot-held-oil')).toHaveText('Depot 300');
  await expect(page.getByTestId('depot-hold-oil')).toHaveText('Hold 100 / 400');
  const draw = page.getByTestId('depot-draw-oil');
  await expect(draw).toHaveText('Draw 300');
  await expect(draw).toBeEnabled();
  await expect(page.getByTestId('depot-draw-wheat')).toHaveText('Empty');
  await expect(page.getByTestId('depot-draw-wheat')).toBeDisabled();

  await draw.click();
  await expect(page.getByTestId('depot-held-oil')).toHaveText('Depot 0');
  await expect(page.getByTestId('depot-hold-oil')).toHaveText('Hold 400 / 400');
  await expect(walletOil(page)).toHaveText('400');
  await expect(draw).toHaveText('Empty');
  await expect(draw).toBeDisabled();
  expect(await tank(page)).toEqual({ hold: 400, depot: 0, keep: 0 });

  // E118: something at the depot and no room aboard reads Hold full.
  await page.evaluate(() => {
    const save = window.__reallm.save().current;
    if (save !== null) save.depot.held['oil'] = 50;
  });
  await page.getByTestId('station-tab-depot').click();
  await expect(draw).toHaveText('Hold full');
  await expect(draw).toBeDisabled();
});

// ---------------------------------------------------------------- §6.3 step 4

test('4. a jump the depot can pay departs with no fuel refusal, and the station entry grants no subsidy (E119)', async ({ page }) => {
  await start(page, URL);
  await prepare(page, { oil: 0, depot: { oil: 40 } });
  await watchToasts(page);
  await station(page);
  // Cinder-4 costs 40: the hold and the depot together cover it, so no line plays.
  await expect(page.getByTestId('station-root')).toBeVisible();
  expect(await toastSeen(page, 'Docking subsidy')).toBe(false);
  expect(await tank(page)).toMatchObject({ hold: 0, depot: 40 });

  await page.getByTestId('station-tab-starmap').click();
  await settle(page, 'starmap');
  await expect(page.getByTestId('starmap-info-name')).toHaveText('Cinder-4');
  await expect(page.getByTestId('starmap-depart')).toBeEnabled();
  await expect(page.getByTestId('depart-reason')).toHaveCount(0);
  await expect(page.getByTestId('starmap-fuel')).not.toHaveClass(/is-short/);
  // Review 2026-10, B-12: the fuel text counts what pays — the depot too.
  await expect(page.getByTestId('starmap-fuel')).toHaveText('Fuel: 40 oil (have 40)');
  await page.getByTestId('starmap-depart').click();
  await expect(page.locator('.sheet-body')).toContainText('charged now — you hold 40 (40 at the depot).');
  await page.getByTestId('confirm-yes').click();
  await expect(page.getByTestId('scene-label')).toHaveText('flight', COLD_START);
  // The hold had nothing to give, so the depot paid the fare.
  expect(await tank(page)).toMatchObject({ hold: 0, depot: 0 });
});

test('E119: with the depot short too, the station grants only what the hold and the depot together lack', async ({ page }) => {
  await start(page, URL);
  await prepare(page, { oil: 0, depot: { oil: 10 } });
  await watchToasts(page);
  await station(page);
  await expect.poll(() => toastSeen(page, 'Docking subsidy logged — +30 oil')).toBe(true);
  expect(await tank(page)).toMatchObject({ hold: 30, depot: 10 });
});

// ------------------------------------------------------------------- E117

test('E117: a deliver need above the reserve stays aboard, and the row says so', async ({ page }) => {
  test.setTimeout(180_000);
  await start(page, DEBUG_URL);
  // c1_m3's second stage: run 100 oil out to the beacon.
  await prepare(page, { oil: 400, done: ['c1_m1', 'c1_m2'], active: [{ id: 'c1_m3', stage: 1 }] });
  await land(page);
  await openTerminal(page);
  const row = page.getByTestId('terminal-cargo-oil');
  const ship = page.getByTestId('terminal-ship-oil');
  // A reserve of 100 is no lower than the need: it is the floor, and nothing is said.
  await expect(ship).toHaveText('Ship 300 home');
  await expect(row).not.toContainText('Delivery needs');

  await page.getByTestId('terminal-keep-less-oil').click();
  await page.getByTestId('terminal-keep-less-oil').click();
  await expect(page.getByTestId('terminal-keep-oil')).toHaveText('Keep 0');
  // Under the need, the need is the floor, and the row names it.
  await expect(row).toContainText('Delivery needs 100');
  await expect(ship).toHaveText('Ship 300 home');
  await watchToasts(page);
  await ship.click();
  await expect.poll(() => toastSeen(page, 'Shipped 300 oil to Command Relay.')).toBe(true);
  expect(await tank(page)).toEqual({ hold: 100, depot: 300, keep: 0 });
  await expect(ship).toHaveText('Nothing to ship');
  await expect(ship).toBeDisabled();
});

// ------------------------------------------------- the tab by keyboard, by touch

test('the Depot tab by keyboard: ArrowDown from Character, Enter, and a draw by Enter keeps focus in the panel', async ({ page }) => {
  await start(page, URL);
  await prepare(page, { oil: 100, water: 20, depot: { oil: 300, water: 50 } });
  await station(page);
  await page.getByTestId('station-tab-character').focus();
  await page.keyboard.press('ArrowDown');
  expect(await focused(page)).toBe('station-tab-depot');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('depot')).toBeVisible();
  expect(await focused(page)).toBe('station-tab-depot');
  await expect(page.getByTestId('station-root')).toHaveAttribute('aria-labelledby', 'station-tab-depot');

  await tabTo(page, 'depot-draw-oil');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('depot-held-oil')).toHaveText('Depot 0');
  await expect(walletOil(page)).toHaveText('400');
  // The pressed button is spent, so focus moves on to the next draw in the panel (SPEC-044 §4.2).
  expect(await focused(page)).toBe('depot-draw-water');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('depot-held-water')).toHaveText('Depot 0');
  expect(await tank(page, 'water')).toEqual({ hold: 70, depot: 0, keep: 100 });
});

/** Where each of the station's four sections sits, and whether a press at its centre reaches it. */
async function sectionTabs(page: Page): Promise<Array<{ id: string; top: number; left: number; right: number; bottom: number; topmost: boolean }>> {
  return page.evaluate(() =>
    ['missions', 'shop', 'character', 'depot'].map((section) => {
      const id = `station-tab-${section}`;
      const node = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
      const box = node?.getBoundingClientRect();
      const hit = box === undefined ? null : document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return {
        id,
        top: box?.top ?? -1,
        left: box?.left ?? -1,
        right: box?.right ?? Number.POSITIVE_INFINITY,
        bottom: box?.bottom ?? Number.POSITIVE_INFINITY,
        topmost: node !== null && node !== undefined && hit !== null && (hit === node || node.contains(hit)),
      };
    }),
  );
}

/**
 * Through the gate by touch, so the input scheme is touch from the start, and
 * on into the menu with its fade let go: a `go()` issued while boot → menu is
 * still fading is refused (SPEC-003 D-2), which on a slow runner left the
 * phone tests waiting on the menu for the station.
 */
async function startTouch(page: Page): Promise<void> {
  await page.goto(gameUrl(URL));
  await awaitGate(page);
  await page.getByTestId('boot-start').tap();
  await expect(page.getByTestId('boot-overlay')).toBeHidden();
  await settle(page, 'menu');
}

/** A tap on the Depot tab, and a tap on a draw. */
async function drawByTap(page: Page): Promise<void> {
  await page.getByTestId('station-tab-depot').tap();
  await expect(page.getByTestId('depot')).toBeVisible();
  await expect(page.getByTestId('station-tab-depot')).toHaveAttribute('aria-selected', 'true');
  await page.getByTestId('depot-draw-oil').tap();
  await expect(page.getByTestId('depot-held-oil')).toHaveText('Depot 0');
  await expect(walletOil(page)).toHaveText('400');
}

test.describe('the Depot tab by touch, on a landscape phone', () => {
  test.use({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true });

  test('it sits in the strip beside the other three, the body keeps half the height, and a tap draws', async ({ page }) => {
    await startTouch(page);
    await prepare(page, { oil: 100, depot: { oil: 300 } });
    await station(page);
    const tabs = await sectionTabs(page);
    for (const tab of tabs) {
      expect(tab.left, `${tab.id} left`).toBeGreaterThanOrEqual(-0.5);
      expect(tab.right, `${tab.id} right`).toBeLessThanOrEqual(844.5);
      expect(tab.bottom, `${tab.id} bottom`).toBeLessThanOrEqual(390.5);
      expect(tab.topmost, `${tab.id} topmost at its centre`).toBe(true);
    }
    // One strip: the four share a row.
    expect(new Set(tabs.map((tab) => Math.round(tab.top))).size).toBe(1);
    const share = await page.evaluate(() => (document.querySelector('[data-testid="station-root"]')?.closest('.screen-body')?.getBoundingClientRect().height ?? 0) / innerHeight);
    expect(share).toBeGreaterThanOrEqual(0.5);
    await drawByTap(page);
  });
});

test.describe('the Depot tab by touch, on a portrait phone', () => {
  test.use({ viewport: { width: 393, height: 851 }, hasTouch: true, isMobile: true });

  test('the four sections sit two by two in the bottom rail, and a tap draws', async ({ page }) => {
    await startTouch(page);
    await prepare(page, { oil: 100, depot: { oil: 300 } });
    await station(page);
    const tabs = await sectionTabs(page);
    for (const tab of tabs) {
      expect(tab.left, `${tab.id} left`).toBeGreaterThanOrEqual(-0.5);
      expect(tab.right, `${tab.id} right`).toBeLessThanOrEqual(393.5);
      expect(tab.bottom, `${tab.id} bottom`).toBeLessThanOrEqual(851.5);
      expect(tab.topmost, `${tab.id} topmost at its centre`).toBe(true);
    }
    // Two rows of two: Missions and Shop, then Character and Depot.
    const rows = [...new Set(tabs.map((tab) => Math.round(tab.top)))];
    expect(rows).toHaveLength(2);
    expect(tabs.map((tab) => Math.round(tab.top))).toEqual([rows[0], rows[0], rows[1], rows[1]]);
    await drawByTap(page);
  });
});
