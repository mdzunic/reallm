// The M1 acceptance run of SPEC-007 §7, in a real browser: create a save, play,
// reload and find the character; delete a slot and find both its keys gone;
// paste an export code into another browser and get the character back.
//
// The unit suite proves the same rules against an injected `Storage` fake. What
// only a browser can prove is that they hold against the real `localStorage`,
// the real `CompressionStream` and a real page reload.
import { expect, test } from '@playwright/test';
import { start } from './start';

const CREATION = {
  name: 'Vance',
  classId: 'marine',
  appearance: { portrait: 1, primary: '#b7472a', secondary: '#2a3b4c' },
  attributes: { might: 6, vigor: 5, agility: 1, tech: 1 },
  difficulty: 'normal',
} as const;

/** The slot keys of §3 that are actually in `localStorage` right now. */
async function slotKeys(page: import('@playwright/test').Page): Promise<string[]> {
  return page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith('reallm:slot:')).sort());
}

test('a created save survives a reload, character and all (AC-57)', async ({ page }) => {
  await start(page);
  await page.evaluate((creation) => {
    const save = window.__reallm.save();
    const data = save.create(0, creation);
    data.player.tokens = 64;
    data.progress.flags.push('c1_oil');
    save.flush();
  }, CREATION);

  // The reload: a fresh document, a fresh store, nothing but localStorage
  // carried across.
  await start(page);

  expect(await page.evaluate(() => window.__reallm.save().list()[0])).toMatchObject({
    slot: 0,
    empty: false,
    name: 'Vance',
    classId: 'marine',
    level: 1,
  });
  const loaded = await page.evaluate(() => window.__reallm.save().load(0));
  expect(loaded.ok).toBe(true);
  expect(loaded.source).toBe('main');
  expect(loaded.data?.player.tokens).toBe(64);
  expect(loaded.data?.progress.flags).toContain('c1_oil');
});

test('deleting a slot removes the save and its backup (AC-58)', async ({ page }) => {
  await start(page);
  await page.evaluate((creation) => {
    const save = window.__reallm.save();
    save.create(0, creation);
    save.flush(); // the second write is what produces the :bak
  }, CREATION);
  expect(await slotKeys(page)).toEqual(['reallm:slot:0', 'reallm:slot:0:bak']);

  await page.evaluate(() => window.__reallm.save().delete(0));
  expect(await slotKeys(page)).toEqual([]);
  expect(await page.evaluate(() => window.__reallm.save().list()[0])).toEqual({ slot: 0, empty: true });
});

test('an export code pasted into another browser restores the character (AC-59)', async ({ page, browser }) => {
  await start(page);
  const code = await page.evaluate(async (creation) => {
    const save = window.__reallm.save();
    const data = save.create(0, creation);
    data.player.tokens = 64;
    save.flush();
    return save.exportCode(0);
  }, CREATION);
  expect(code).toMatch(/^RLM1\.[A-Za-z0-9_-]+\.[0-9a-z]+$/);

  // Another browser: a second context shares no storage and no page state, so
  // the code is the only thing that crosses.
  const context = await browser.newContext();
  try {
    const other = await context.newPage();
    await start(other);
    expect(await other.evaluate(() => window.__reallm.save().list()[1])).toEqual({ slot: 1, empty: true });

    // …and it survives the trip through a chat window (07-g).
    const wrapped = `\n  ${code.slice(0, 24)}\n${code.slice(24)}  \n`;
    const imported = await other.evaluate((text) => window.__reallm.save().importCode(text, 1), wrapped);
    expect(imported.ok).toBe(true);

    const loaded = await other.evaluate(() => window.__reallm.save().load(1));
    expect(loaded.ok).toBe(true);
    expect(loaded.data?.player.name).toBe('Vance');
    expect(loaded.data?.player.tokens).toBe(64);
    expect(loaded.data?.meta.slot).toBe(1);
  } finally {
    await context.close();
  }
});

test('a damaged code is refused rather than written (AC-37, AC-40)', async ({ page }) => {
  await start(page);
  const code = await page.evaluate(async (creation) => {
    const save = window.__reallm.save();
    save.create(0, creation);
    return save.exportCode(0);
  }, CREATION);

  const result = await page.evaluate((text) => {
    // One character of the payload flipped: the crc no longer matches.
    const parts = text.split('.');
    const payload = parts[1] as string;
    const flipped = `${payload.slice(0, 4)}${payload[4] === 'A' ? 'B' : 'A'}${payload.slice(5)}`;
    return window.__reallm.save().importCode(`${parts[0]}.${flipped}.${parts[2]}`, 2);
  }, code);

  expect(result.ok).toBe(false);
  expect(await slotKeys(page)).toEqual(['reallm:slot:0']);
});

test('persistent storage is requested after the first save (AC-52, AC-56)', async ({ page }) => {
  await start(page, '/?debug');
  await page.evaluate((creation) => window.__reallm.save().create(0, creation), CREATION);

  // The request is asynchronous, and the overlay row follows the setting.
  await expect
    .poll(async () => page.evaluate(() => window.__reallm.stats().persistGranted), { timeout: 5000 })
    .not.toBeNull();
  await expect(page.locator('[data-testid="debug-persist"]')).toHaveText(/^persist (?:granted|denied)$/);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('reallm:settings') ?? '{}'))).toHaveProperty(
    'persistGranted',
  );
});
