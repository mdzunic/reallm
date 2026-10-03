// SPEC-047 §6.2 — the version-3 save in a real browser. The schema, the
// migration and every validation rule are proved in `tests/core/save.test.ts`;
// what only a browser shows is the path a player takes: a fresh save, a save
// left by the v2 build, a save from a build newer than this one, a death that
// is still counted after a reload, and a code carried to another slot.
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { start, type SaveSnapshot } from './start';

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

test('1. a fresh save is version 3 with the new fields empty', async ({ page }) => {
  await start(page, '/?debug');
  const fresh = await page.evaluate((creation) => window.__reallm.save().create(0, creation), CREATION);
  expect(fresh.version).toBe(3);
  expect(fresh.meta.lineage).toEqual([]);
  expect(fresh.meta.stats).toEqual(EMPTY_STATS);
  expect(fresh.meta.iteration).toBe(1);
  expect(fresh.progress.claimed).toEqual([]);
  expect(fresh.progress.exploredBelow).toEqual({});
  expect(fresh.progress.remains).toBeNull();
  expect(fresh.progress.resume).toBeNull();
  // …and that is what was written.
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('reallm:slot:0') ?? '{}').version)).toBe(3);
});

test('2. E74: the v2 fixture loads as version 3, every v2 value kept and the new fields empty', async ({ page }) => {
  await start(page, '/?debug');
  await page.evaluate((fixture) => localStorage.setItem('reallm:slot:0', JSON.stringify(fixture)), V2_SAVE);

  const loaded = await page.evaluate(() => window.__reallm.save().load(0));
  expect(loaded.ok).toBe(true);
  const data = loaded.data as SaveSnapshot;
  expect(data.version).toBe(3);
  expect(data.player).toEqual(V2_SAVE.player);
  expect(data.resources).toEqual(V2_SAVE.resources);
  expect(data.progress.missionsDone).toEqual(V2_SAVE.progress.missionsDone);
  expect(data.progress.explored).toEqual(V2_SAVE.progress.explored);
  expect(data.meta.lineage).toEqual([]);
  expect(data.meta.stats).toEqual(EMPTY_STATS);
  expect(data.progress).toMatchObject({ claimed: [], exploredBelow: {}, remains: null, resume: null });

  // Through the Load menu: the station's first autosave writes it as v3, and
  // `:bak` keeps the v2 JSON it replaced.
  await page.getByTestId('menu-load').click();
  await page.getByTestId('load-slot-0').click();
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('station');
  await expect
    .poll(async () => page.evaluate(() => JSON.parse(localStorage.getItem('reallm:slot:0') ?? '{}').version), { timeout: 10_000 })
    .toBe(3);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('reallm:slot:0:bak') ?? '{}').version)).toBe(2);
});

test('3. E73: a version-4 save is refused as newer, and its Load row offers Export', async ({ page }) => {
  await start(page, '/?debug');
  await page.evaluate(() => localStorage.setItem('reallm:slot:1', JSON.stringify({ version: 4, player: {} })));

  const refused = await page.evaluate(() => window.__reallm.save().load(1));
  expect(refused).toMatchObject({ ok: false, reason: 'newer_version', foundVersion: 4 });

  await page.getByTestId('menu-load').click();
  const row = page.getByTestId('load-row-1');
  await expect(row).toContainText('Save from a newer version');
  await expect(page.getByTestId('load-slot-1-export')).toBeVisible();
  await expect(page.getByTestId('load-slot-1')).toHaveCount(0);
  // Refused, never rewritten.
  expect(await page.evaluate(() => localStorage.getItem('reallm:slot:1'))).toBe(JSON.stringify({ version: 4, player: {} }));
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

test('5. 47-a: a code exported from slot 0 imports into slot 2 as the same version-3 save', async ({ page }) => {
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
  expect(slot2.version).toBe(3);
  expect(slot2.meta.slot).toBe(2);
  expect({ ...slot2, meta: { ...slot2.meta, slot: 0 } }).toEqual(slot0);
  expect(slot2.meta.stats.kills).toBe(31);
  expect(slot2.progress.claimed).toEqual(['cinder4_vault', 'lineage:1:vetra']);
});
