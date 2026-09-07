// The M1 acceptance run of SPEC-007 §7, in a real browser: create a save, play,
// reload and find the character; delete a slot and find both its keys gone;
// paste an export code into another browser and get the character back.
//
// The unit suite proves the same rules against an injected `Storage` fake. What
// only a browser can prove is that they hold against the real `localStorage`,
// the real `CompressionStream` and a real page reload — and that the two halves
// of E8 the player actually sees are on screen: the memory-only banner (AC-17)
// and the Import/Delete actions of a corrupt slot (AC-20). `src/ui/` may not be
// imported by the node suite (SPEC-001 §4), so this file is where that panel is
// tested at all.
import { expect, test, type Page } from '@playwright/test';
import { start } from './start';

const CREATION = {
  name: 'Vance',
  classId: 'marine',
  appearance: { portrait: 1, primary: '#b7472a', secondary: '#2a3b4c' },
  attributes: { might: 6, vigor: 5, agility: 1, tech: 1 },
  difficulty: 'normal',
} as const;

/** The slot keys of §3 that are actually in `localStorage` right now. */
async function slotKeys(page: Page): Promise<string[]> {
  return page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith('reallm:slot:')).sort());
}

/**
 * Real `localStorage`, refusing our keys: what the probe of §3 meets in a
 * browser where site storage is blocked. Installed before the page scripts run,
 * so the store sees it at construction (E8).
 */
async function denyStorage(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string): void {
      if (key.startsWith('reallm:')) throw new DOMException('storage is not available', 'SecurityError');
      setItem.call(this, key, value);
    };
  });
}

/** Both keys of a slot filled with something that is not a save (E8, AC-20). */
async function corruptSlot(page: Page, slot: number): Promise<void> {
  await page.evaluate((n) => {
    localStorage.setItem(`reallm:slot:${n}`, '{"version":1,"player":'); // a torn write
    localStorage.setItem(`reallm:slot:${n}:bak`, 'not a save at all');
  }, slot);
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

test('storage that refuses every write leaves a playable memory-only session (AC-17, AC-18)', async ({ page }) => {
  const crashes: string[] = [];
  page.on('pageerror', (error) => crashes.push(error.message));
  await denyStorage(page);
  await start(page);

  // E8: the banner is the half that is still on screen a minute later — the
  // toast the store emits at construction is gone in eight seconds.
  const banner = page.locator('[data-testid="storage-banner"]');
  await expect(banner).toBeVisible();
  await expect(banner).toHaveText(/^Storage is unavailable/);
  expect(await page.evaluate(() => window.__reallm.save().available)).toBe(false);

  // The run itself is playable, it just cannot be written…
  expect(
    await page.evaluate((creation) => {
      const save = window.__reallm.save();
      save.create(0, creation);
      return save.flush();
    }, CREATION),
  ).toBe(false);
  expect(await slotKeys(page)).toEqual([]);
  // …and the one way out, the export code, still works from memory (E8).
  expect(await page.evaluate(() => window.__reallm.save().exportCode(0))).toMatch(/^RLM1\./);

  await page.locator('[data-testid="go-station"]').click();
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('station');
  expect(crashes).toEqual([]);
});

test('a slot with neither a readable save nor a readable backup offers Import (AC-20)', async ({ page }) => {
  await start(page);
  const code = await page.evaluate(async (creation) => {
    const save = window.__reallm.save();
    save.create(1, creation);
    return save.exportCode(1);
  }, CREATION);
  await corruptSlot(page, 1);
  await start(page); // a reload: the menu builds its rows from what is in storage

  const row = page.locator('[data-testid="slot-1"]');
  await expect(row).toContainText('Corrupt');
  await expect(page.locator('[data-testid="slot-1-delete"]')).toBeVisible();
  // E8: the wreckage is still exportable as an RLM1 code, for support.
  expect(await page.evaluate(() => window.__reallm.save().exportCode(1))).toMatch(/^RLM1\./);

  // Import: a code out of a chat window (07-g) puts a character back in the slot.
  await page.locator('[data-testid="slot-1-import"]').click();
  await page.locator('[data-testid="slot-1-code"]').fill(`\n  ${code}\n`);
  await page.locator('[data-testid="slot-1-restore"]').click();
  await expect(row).toContainText('Vance');
  await expect(row).not.toContainText('Corrupt');
  expect(await page.evaluate(() => window.__reallm.save().load(1).ok)).toBe(true);
});

test('a corrupt slot can be deleted from the menu, backup and all (AC-20, AC-58)', async ({ page }) => {
  await start(page);
  await page.evaluate((creation) => window.__reallm.save().create(2, creation), CREATION);
  await corruptSlot(page, 2);
  await start(page);

  const row = page.locator('[data-testid="slot-2"]');
  await expect(row).toContainText('Corrupt');
  await page.locator('[data-testid="slot-2-delete"]').click();
  await expect(row).toContainText('Empty');
  expect(await slotKeys(page)).toEqual([]);
});

test('a browser without CompressionStream offers Delete but not Import (AC-20, AC-42)', async ({ page }) => {
  await page.addInitScript(() => {
    delete (window as { CompressionStream?: unknown }).CompressionStream;
    delete (window as { DecompressionStream?: unknown }).DecompressionStream;
  });
  await start(page);
  await page.evaluate((creation) => window.__reallm.save().create(0, creation), CREATION);
  await corruptSlot(page, 0);
  await start(page);

  // 07-f: the entry point is not offered at all rather than failing on the click.
  await expect(page.locator('[data-testid="slot-0"]')).toContainText('Corrupt');
  await expect(page.locator('[data-testid="slot-0-delete"]')).toBeVisible();
  await expect(page.locator('[data-testid="slot-0-import"]')).toHaveCount(0);
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
