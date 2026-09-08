// SPEC-012 §7 (AC-72) — the five Cinder-4 missions, end to end in one sitting.
// Every flow is the real one: terminal accepts, the hands-free scan, forced
// storms, kill and collect counters, the arena boss, the atomic delivery.
// Only travel and kill-time are compressed through the `?debug` strip — the
// same shortcuts a QA session uses — and `c1_s2_echo`'s static burst (AC-71)
// is asserted at the beat where the campaign actually fires it.
import { expect, test, type Page } from '@playwright/test';
import { start } from './start';

const CREATION = {
  name: 'Salvager',
  classId: 'marine',
  appearance: { portrait: 0, primary: '#b7472a', secondary: '#2a3b4c' },
  attributes: { might: 3, vigor: 8, agility: 1, tech: 1 },
  difficulty: 'normal',
} as const;

const info = async (page: Page): Promise<Record<string, number | string>> =>
  (await page.evaluate(() => window.__reallm.stats())).sceneInfo ?? {};

async function land(page: Page): Promise<void> {
  await start(page, '/?debug&seed=123');
  await page.evaluate((creation) => void window.__reallm.save().create(0, creation, 123), CREATION);
  await page.evaluate(() => window.__reallm.go('surface', { planet: 'cinder4', firstLanding: true }, { force: true }));
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('surface');
}

/** Click through any open dialogue — chapter-1 beats are all non-modal. */
async function dismiss(page: Page): Promise<void> {
  const dialogue = page.locator('[data-testid="dialogue"]');
  for (let i = 0; i < 30; i++) {
    if (!(await dialogue.isVisible().catch(() => false))) return;
    await dialogue.click({ force: true });
    await page.waitForTimeout(120);
  }
}

async function openTerminal(page: Page): Promise<void> {
  await dismiss(page);
  await page.locator('[data-testid="surface-goto-pad"]').click();
  const terminal = page.locator('[data-testid="pad-terminal"]');
  for (let i = 0; i < 5; i++) {
    if (await terminal.isVisible()) return;
    await page.keyboard.press('KeyE');
    await page.waitForTimeout(400);
  }
  await expect(terminal).toBeVisible();
}

async function closeTerminal(page: Page): Promise<void> {
  await dismiss(page);
  await page.locator('[data-testid="terminal-close"]').click();
  await expect(page.locator('[data-testid="pad-terminal"]')).toBeHidden();
}

const missionState = (page: Page, id: string): Promise<{ stage: number; counters: Record<string, number> } | null> =>
  page.evaluate((mid) => {
    const active = window.__reallm.save().current?.progress.missionsActive ?? [];
    const m = active.find((x) => x.id === mid);
    return m === undefined ? null : { stage: m.stage, counters: m.counters };
  }, id);

const isDone = (page: Page, id: string): Promise<boolean> =>
  page.evaluate((mid) => (window.__reallm.save().current?.progress.missionsDone ?? []).includes(mid), id);

const counter = async (page: Page, id: string, key: string): Promise<number> =>
  (await missionState(page, id))?.counters[key] ?? 0;

/** Cycle the pin (the minimap tap, E18) until the HUD line wears `title`. */
async function pin(page: Page, title: string): Promise<void> {
  const line = page.locator('[data-testid="hud"] .hud-objective');
  for (let i = 0; i < 8; i++) {
    if (((await line.textContent()) ?? '').includes(title)) return;
    await page.locator('[data-testid="minimap"]').click();
    await page.waitForTimeout(200);
  }
  expect((await line.textContent()) ?? '').toContain(title);
}

async function hp(page: Page): Promise<number> {
  const text = (await page.locator('[data-testid="hud-hp"]').textContent()) ?? '';
  return Number(/(\d+)\s*\//.exec(text)?.[1] ?? 0);
}

/** One tick of pilot upkeep: clear dialogue, thin the field, eat if hurting. */
async function upkeep(page: Page): Promise<void> {
  await dismiss(page);
  await page.locator('[data-testid="surface-smite"]').click();
  if ((await hp(page)) < 120) await page.keyboard.press('KeyQ');
}

test('all five Cinder-4 missions complete end to end, with the echo glitch burst (AC-72, AC-71)', async ({ page }) => {
  test.setTimeout(540_000);
  await land(page);

  // ------------------------------------------------ c1_m1 — Dry Land
  await openTerminal(page);
  await page.locator('[data-testid="terminal-accept-c1_m1"]').click();
  await closeTerminal(page);
  // Stage 0 (reach the pad) completes where the pilot stands.
  await expect.poll(async () => (await missionState(page, 'c1_m1'))?.stage ?? -1).toBe(1);

  // Stage 1: the hands-free scan — 3 s inside the dune sea.
  await pin(page, 'Dry Land');
  {
    const deadline = Date.now() + 40_000;
    while (Date.now() < deadline && ((await missionState(page, 'c1_m1'))?.stage ?? -1) !== 2) {
      await dismiss(page);
      await page.locator('[data-testid="surface-goto-objective"]').click();
      await page.waitForTimeout(1200);
    }
  }
  expect((await missionState(page, 'c1_m1'))?.stage).toBe(2);

  // Stage 2: survive 60 s of the forced sandstorm.
  {
    const deadline = Date.now() + 110_000;
    while (Date.now() < deadline && !(await isDone(page, 'c1_m1'))) {
      await upkeep(page);
      await page.waitForTimeout(1200);
    }
  }
  expect(await isDone(page, 'c1_m1')).toBe(true);

  // -------------------------------- the parallel trio: c1_m2, c1_s1, c1_s2
  await openTerminal(page);
  await page.locator('[data-testid="terminal-accept-c1_m2"]').click();
  await page.locator('[data-testid="terminal-accept-c1_s1"]').click();
  await page.locator('[data-testid="terminal-accept-c1_s2"]').click();
  await closeTerminal(page);

  // Kills first: 6 scav raiders (m2) and 8 dust skitters (s2). The spawn
  // director triples objective weight and force-spawns after 20 s, so the
  // smite loop converges. The 8th skitter starts s2's survive stage and plays
  // `c1_s2_echo` — glitch: true — whose 0.6 s static burst is AC-71.
  let staticSeen = false;
  {
    const deadline = Date.now() + 240_000;
    for (;;) {
      const raiders = await counter(page, 'c1_m2', '0:1');
      const skitters = await counter(page, 'c1_s2', '0:0');
      const s2 = await missionState(page, 'c1_s2');
      if ((raiders >= 6 || (await isDone(page, 'c1_m2'))) && (skitters >= 8 || (s2?.stage ?? 1) >= 1)) break;
      expect(Date.now()).toBeLessThan(deadline);
      await dismiss(page);
      await page.locator('[data-testid="surface-smite"]').click();
      if (!staticSeen && skitters === 7) {
        // That smite may have been the echo beat — the burst lasts 600 ms.
        staticSeen = await page
          .locator('[data-testid="hud"].is-static')
          .isVisible()
          .catch(() => false);
      }
      if ((await hp(page)) < 120) await page.keyboard.press('KeyQ');
      await page.waitForTimeout(500);
    }
  }
  expect(staticSeen).toBe(true);

  // Oil to 150 (m2's collect): teleport node to node, harvest at 5/s.
  await pin(page, 'Black Gold');
  {
    const deadline = Date.now() + 160_000;
    while (Date.now() < deadline && !(await isDone(page, 'c1_m2'))) {
      await upkeep(page);
      await page.locator('[data-testid="surface-goto-objective"]').click();
      await page.waitForTimeout(2500);
    }
  }
  expect(await isDone(page, 'c1_m2')).toBe(true);

  // Wheat to 80 and the silo scan (s1) — `goto-objective` follows the first
  // undone objective, so the same loop walks both.
  await pin(page, 'Grain Silo');
  {
    const deadline = Date.now() + 160_000;
    while (Date.now() < deadline && !(await isDone(page, 'c1_s1'))) {
      await upkeep(page);
      await page.locator('[data-testid="surface-goto-objective"]').click();
      await page.waitForTimeout(2500);
    }
  }
  expect(await isDone(page, 'c1_s1')).toBe(true);

  // s2's survive 90 s (heatwave, 2 dps) has been running since the 8th
  // skitter; see it out on wheat rations.
  {
    const deadline = Date.now() + 150_000;
    while (Date.now() < deadline && !(await isDone(page, 'c1_s2'))) {
      await upkeep(page);
      await page.waitForTimeout(1200);
    }
  }
  expect(await isDone(page, 'c1_s2')).toBe(true);

  // ------------------------------------------------ c1_m3 — Worm Sign
  await openTerminal(page);
  await page.locator('[data-testid="terminal-accept-c1_m3"]').click();
  await closeTerminal(page);
  await pin(page, 'Worm Sign');

  // The delivery needs 100 oil on hand; the m2 harvest left well over that.
  expect(await page.evaluate(() => window.__reallm.save().current?.resources['oil'] ?? 0)).toBeGreaterThanOrEqual(100);

  // Stage 0: walk into the nest — the arena spawns the wurm on entry.
  await page.locator('[data-testid="surface-goto-objective"]').click();
  await expect.poll(async () => (await info(page))['boss'], { timeout: 15_000 }).not.toBe('-');
  {
    const deadline = Date.now() + 150_000;
    while (Date.now() < deadline && ((await missionState(page, 'c1_m3'))?.stage ?? -1) !== 1) {
      await dismiss(page);
      // Wound respects 11-f (no damage mid-special); smite finishes the wurm
      // through the real kill path once it is the nearest vulnerable target.
      await page.locator('[data-testid="surface-wound-boss"]').click();
      await page.locator('[data-testid="surface-smite"]').click();
      if ((await hp(page)) < 120) await page.keyboard.press('KeyQ');
      await page.waitForTimeout(700);
    }
  }
  expect((await missionState(page, 'c1_m3'))?.stage).toBe(1);

  // Stage 1: run the oil out to the beacon — atomic on arrival (E16).
  {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && !(await isDone(page, 'c1_m3'))) {
      await dismiss(page);
      await page.locator('[data-testid="surface-goto-objective"]').click();
      await page.waitForTimeout(1500);
    }
  }
  expect(await isDone(page, 'c1_m3')).toBe(true);

  // ------------------------------------------------ the chapter, closed
  const progress = await page.evaluate(() => {
    const save = window.__reallm.save().current;
    return save === null ? null : { done: save.progress.missionsDone, flags: save.progress.flags, tokens: save.player.tokens };
  });
  expect(progress?.done).toEqual(expect.arrayContaining(['c1_m1', 'c1_m2', 'c1_m3', 'c1_s1', 'c1_s2']));
  expect(progress?.flags).toContain('chapter1_done');
  // The rewards actually paid out (AC-63's readout has real numbers behind it).
  expect(progress?.tokens ?? 0).toBeGreaterThanOrEqual(65);
});
