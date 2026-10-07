// SPEC-047 §6.2 — the version-3 save in a real browser. The schema, the
// migration and every validation rule are proved in `tests/core/save.test.ts`;
// what only a browser shows is the path a player takes: a fresh save, a save
// left by the v2 build, a save from a build newer than this one, a death that
// is still counted after a reload, and a code carried to another slot.
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { frames, start, type SaveSnapshot } from './start';

const CREATION = {
  name: 'Vance',
  classId: 'marine',
  appearance: { portrait: 1, primary: '#b7472a', secondary: '#2a3b4c' },
  attributes: { might: 6, vigor: 5, agility: 1, tech: 1 },
  difficulty: 'normal',
} as const;

/**
 * The v2 fixture itself — the JSON the build before this one leaves behind.
 * Read off disk rather than imported: `e2e/` imports nothing from `tests/`.
 */
const V2_SAVE = JSON.parse(readFileSync(new URL('../tests/fixtures/save-v2.json', import.meta.url), 'utf8')) as SaveSnapshot;

const EMPTY_STATS = { deaths: 0, kills: 0, elites: 0, bosses: 0, recoveries: 0, lastDeath: {} };

const info = async (page: Page): Promise<Record<string, number | string>> =>
  (await page.evaluate(() => window.__reallm.stats())).sceneInfo ?? {};

const stats = (page: Page): Promise<SaveSnapshot['meta']['stats'] | null> =>
  page.evaluate(() => window.__reallm.save().current?.meta.stats ?? null);

// SPEC-065 §4.1 moved the current version on to 4: what this suite pins of
// version 3 — its fields — is unchanged, and the numbers it reads say 4.

test('1. a fresh save is the current version with the version-3 fields empty', async ({ page }) => {
  await start(page, '/?debug');
  const fresh = await page.evaluate((creation) => window.__reallm.save().create(0, creation), CREATION);
  expect(fresh.version).toBe(4);
  expect(fresh.meta.lineage).toEqual([]);
  expect(fresh.meta.stats).toEqual(EMPTY_STATS);
  expect(fresh.meta.iteration).toBe(1);
  expect(fresh.progress.claimed).toEqual([]);
  expect(fresh.progress.exploredBelow).toEqual({});
  expect(fresh.progress.remains).toBeNull();
  expect(fresh.progress.resume).toBeNull();
  // …and that is what was written.
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('reallm:slot:0') ?? '{}').version)).toBe(4);
});

test('2. E74: the v2 fixture loads as the current version, every v2 value kept and the new fields empty', async ({ page }) => {
  await start(page, '/?debug');
  await page.evaluate((fixture) => localStorage.setItem('reallm:slot:0', JSON.stringify(fixture)), V2_SAVE);

  const loaded = await page.evaluate(() => window.__reallm.save().load(0));
  expect(loaded.ok).toBe(true);
  const data = loaded.data as SaveSnapshot;
  expect(data.version).toBe(4);
  expect(data.player).toEqual(V2_SAVE.player);
  expect(data.resources).toEqual(V2_SAVE.resources);
  expect(data.progress.missionsDone).toEqual(V2_SAVE.progress.missionsDone);
  expect(data.progress.explored).toEqual(V2_SAVE.progress.explored);
  expect(data.meta.lineage).toEqual([]);
  expect(data.meta.stats).toEqual(EMPTY_STATS);
  expect(data.progress).toMatchObject({ claimed: [], exploredBelow: {}, remains: null, resume: null });

  // Through the Load menu: the station's first autosave writes it as v4, and
  // `:bak` keeps the v2 JSON it replaced. SPEC-059 §4.1.3: the fixture was last
  // written long ago, so the "previously" card comes first.
  await page.getByTestId('menu-load').click();
  await page.getByTestId('load-slot-0').click();
  await page.getByTestId('resume-continue').click();
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('station');
  await expect
    .poll(async () => page.evaluate(() => JSON.parse(localStorage.getItem('reallm:slot:0') ?? '{}').version), { timeout: 10_000 })
    .toBe(4);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('reallm:slot:0:bak') ?? '{}').version)).toBe(2);
});

test('3. E73: a version-5 save is refused as newer, and its Load row offers Export', async ({ page }) => {
  await start(page, '/?debug');
  await page.evaluate(() => localStorage.setItem('reallm:slot:1', JSON.stringify({ version: 5, player: {} })));

  const refused = await page.evaluate(() => window.__reallm.save().load(1));
  expect(refused).toMatchObject({ ok: false, reason: 'newer_version', foundVersion: 5 });

  await page.getByTestId('menu-load').click();
  const row = page.getByTestId('load-row-1');
  await expect(row).toContainText('Save from a newer version');
  await expect(page.getByTestId('load-slot-1-export')).toBeVisible();
  await expect(page.getByTestId('load-slot-1')).toHaveCount(0);
  // Refused, never rewritten.
  expect(await page.evaluate(() => localStorage.getItem('reallm:slot:1'))).toBe(JSON.stringify({ version: 5, player: {} }));
});

test('4. a kill and a death are counted, and the death is still counted after a reload', async ({ page }) => {
  test.setTimeout(120_000);
  // Auto-fire would add kills of its own; the smite is the only shot here.
  await page.addInitScript(() => localStorage.setItem('reallm:settings', JSON.stringify({ autoFire: 'off' })));
  await start(page, '/?debug&seed=123');
  await page.evaluate((creation) => void window.__reallm.save().create(0, creation, 123), CREATION);
  await page.evaluate(() => window.__reallm.go('surface', { planet: 'cinder4', firstLanding: false }, { force: true }));
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('surface');
  expect(await stats(page)).toEqual(EMPTY_STATS);

  // One smite, one kill. A press with nothing in reach kills nothing, so it
  // is pressed again only while the count is still 0.
  await expect.poll(async () => Number((await info(page))['enemies'] ?? 0), { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
  await expect
    .poll(
      async () => {
        if ((await stats(page))?.kills === 0) await page.getByTestId('surface-smite').click();
        return (await stats(page))?.kills ?? 0;
      },
      { timeout: 30_000, intervals: [500] },
    )
    .toBeGreaterThan(0);
  expect((await stats(page))?.kills).toBe(1);

  // `surface-hurt` until the death overlay, remembering where the salvager
  // stood before each hit (a hit inside the i-frames is ignored, so the count
  // of presses is not fixed).
  const death = page.getByTestId('death-overlay');
  let before = { x: Number.NaN, z: Number.NaN };
  for (let i = 0; i < 12 && !(await death.isVisible()); i++) {
    const s = await info(page);
    before = { x: Number(s['px']), z: Number(s['pz']) };
    await page.getByTestId('surface-hurt').click();
    await page.waitForTimeout(400);
  }
  await expect(death).toBeVisible();
  const died = await stats(page);
  expect(died?.deaths).toBe(1);
  const at = died?.lastDeath['cinder4'];
  expect(at).toBeDefined();
  expect(Math.hypot((at?.x ?? Infinity) - before.x, (at?.z ?? Infinity) - before.z)).toBeLessThanOrEqual(1);
  // Rounded to 0.1 m.
  expect(Math.round((at?.x ?? 0) * 10) / 10).toBe(at?.x);
  expect(Math.round((at?.z ?? 0) * 10) / 10).toBe(at?.z);

  // A reload is a `pagehide`: the next autosave carries the counts.
  await start(page, '/?debug&seed=123');
  const reloaded = await page.evaluate(() => window.__reallm.save().load(0));
  expect(reloaded.ok).toBe(true);
  expect(reloaded.data?.meta.stats.deaths).toBe(1);
  expect(reloaded.data?.meta.stats.kills).toBe(1);
  expect(reloaded.data?.meta.stats.lastDeath['cinder4']).toEqual(at);
});

test('5. 47-a: a code exported from slot 0 imports into slot 2 as the same save, at the current version', async ({ page }) => {
  await start(page, '/?debug');
  const codesSupported = await page.evaluate(() => window.__reallm.save().codesSupported);
  test.skip(!codesSupported, 'this browser has no CompressionStream (07-f)');

  // A save with something in every new field the game already writes.
  await page.evaluate((creation) => {
    const save = window.__reallm.save();
    const data = save.create(0, creation);
    data.meta.stats.deaths = 2;
    data.meta.stats.kills = 31;
    data.meta.stats.elites = 1;
    data.meta.stats.lastDeath['cinder4'] = { x: 12.3, z: -45.6 };
    data.progress.claimed.push('cinder4_vault', 'lineage:1:vetra');
    save.flush();
  }, CREATION);

  const code = await page.evaluate(() => window.__reallm.save().exportCode(0));
  expect(code).toMatch(/^RLM1\./);
  const imported = await page.evaluate((text) => window.__reallm.save().importCode(text, 2), code);
  expect(imported.ok).toBe(true);

  const [zero, two] = await page.evaluate(() => {
    const save = window.__reallm.save();
    return [save.load(0), save.load(2)];
  });
  expect(two.ok).toBe(true);
  const slot2 = two.data as SaveSnapshot;
  const slot0 = zero.data as SaveSnapshot;
  expect(slot2.version).toBe(4);
  expect(slot2.meta.slot).toBe(2);
  expect({ ...slot2, meta: { ...slot2.meta, slot: 0 } }).toEqual(slot0);
  expect(slot2.meta.stats.kills).toBe(31);
  expect(slot2.progress.claimed).toEqual(['cinder4_vault', 'lineage:1:vetra']);
});

// ---------------------------------------------------------------- QA additions
// The paths §4.5 names beyond the one kill and one death above, each through
// the game's own controls: a boss's kill, a Recall to pad, and the flight
// scene's subscription (its kill and its crash).

interface FlightHook {
  phase(): string;
  blockArrival(): void;
  clearSky(): void;
  hit(amount: number): void;
}

const flightHook = (page: Page): Promise<FlightHook | undefined> =>
  page.evaluate(() => (window as unknown as { __reallmFlight?: FlightHook }).__reallmFlight);

test('6. a boss kill raises bosses and kills, and a Recall to pad changes no count', async ({ page }) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => localStorage.setItem('reallm:settings', JSON.stringify({ autoFire: 'off' })));
  await start(page, '/?debug&seed=123');
  await page.evaluate((creation) => void window.__reallm.save().create(0, creation, 123), CREATION);
  await page.evaluate(() => window.__reallm.go('surface', { planet: 'cinder4', firstLanding: false }, { force: true }));
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('surface');
  expect(await stats(page)).toEqual(EMPTY_STATS);

  // Wake the wurm and stand at its nest, then wound and smite it until it falls.
  await page.getByTestId('surface-spawn-boss').click();
  await expect.poll(async () => String((await info(page))['boss'] ?? '-'), { timeout: 15_000 }).not.toBe('-');
  await page.getByTestId('surface-goto-boss').click();
  await expect
    .poll(
      async () => {
        if ((await stats(page))?.bosses === 0) {
          await page.getByTestId('surface-wound-boss').click();
          await page.getByTestId('surface-smite').click();
        }
        return (await stats(page))?.bosses ?? 0;
      },
      { timeout: 60_000, intervals: [800] },
    )
    .toBe(1);
  const afterBoss = await stats(page);
  expect(afterBoss?.kills).toBeGreaterThanOrEqual(1);
  expect(afterBoss?.deaths).toBe(0);

  // A Recall is a respawn without the death: no count moves.
  await page.keyboard.press('Escape');
  await page.getByTestId('pause-recall').click();
  await page.getByTestId('confirm-yes').click();
  await expect.poll(async () => Number((await info(page))['recalls'] ?? 0), { timeout: 15_000 }).toBe(1);
  expect(await stats(page)).toEqual(afterBoss);
});

test('7. 47-f: in flight a kill counts, and a crash counts a death without touching lastDeath', async ({ page }) => {
  test.setTimeout(150_000);
  await page.addInitScript(() =>
    localStorage.setItem('reallm:settings', JSON.stringify({ autoFire: 'off', flightMouseSteer: false })),
  );
  await start(page, '/?debug&seed=123');
  await page.evaluate((creation) => void window.__reallm.save().create(0, creation, 123), CREATION);
  await page.evaluate(() => window.__reallm.go('flight', { destination: 'cinder4' }, { force: true }));
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('flight');
  await expect.poll(async () => (await flightHook(page)) !== undefined, { timeout: 30_000 }).toBe(true);
  // A surface death from an earlier run, so "left alone" has something to leave.
  await page.evaluate(() => {
    const current = window.__reallm.save().current;
    if (current !== null) current.meta.stats.lastDeath['vetra'] = { x: 4.2, z: -7.5 };
  });
  const before = await stats(page);
  expect(before).not.toBeNull();

  // The guns wake after the launch, and the chase camera settles with them: a
  // pointer swept while it still moves finds the cone somewhere else.
  await page.waitForFunction(() => (window as unknown as { __reallmFlight: FlightHook }).__reallmFlight.phase() !== 'launch', null, {
    timeout: 20_000,
  });
  // One still fighter dead ahead and nothing else in the sky, found as
  // SPEC-042's case 6 finds it: the pointer down the screen's middle a few
  // pixels at a time — three frames each, so the step has read it — until
  // ARIA's 6° cone takes it; then on its lead pip, and hold fire on Space.
  await page.evaluate(() => {
    const hook = (window as unknown as { __reallmFlight: FlightHook }).__reallmFlight;
    hook.clearSky();
    hook.blockArrival();
  });
  const viewport = page.viewportSize() ?? { width: 1280, height: 720 };
  for (let k = 0; k <= 30 && Number((await info(page))['lead']) !== 1; k++) {
    await page.mouse.move(viewport.width / 2, viewport.height * (0.4 + 0.01 * k));
    await frames(page, 3);
  }
  const pip = page.getByTestId('lead-pip');
  await expect(pip).toBeVisible({ timeout: 10_000 });
  const at = await pip.boundingBox();
  if (at === null) throw new Error('the lead pip has no box');
  await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2);
  await page.keyboard.down('Space');
  await expect.poll(async () => (await stats(page))?.kills ?? 0, { timeout: 60_000, intervals: [250] }).toBe((before?.kills ?? 0) + 1);
  await page.keyboard.up('Space');

  // More damage than any hull carries: the crash.
  const killed = await stats(page);
  await page.evaluate(() => (window as unknown as { __reallmFlight: FlightHook }).__reallmFlight.hit(10_000));
  await expect.poll(async () => (await stats(page))?.deaths, { timeout: 10_000 }).toBe((before?.deaths ?? 0) + 1);
  const crashed = await stats(page);
  expect(crashed?.lastDeath).toEqual(before?.lastDeath);
  expect(crashed?.kills).toBe(killed?.kills);

  // The recall lands at the station, which counts nothing, and the crash rode the autosave.
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('station', { timeout: 30_000 });
  await expect
    .poll(async () => page.evaluate(() => JSON.parse(localStorage.getItem('reallm:slot:0') ?? '{}').meta?.stats?.deaths), { timeout: 10_000 })
    .toBe(crashed?.deaths);
  expect(await stats(page)).toEqual(crashed);
});
