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

/**
 * Both keys of a slot filled with something that is not a save (E8, AC-20).
 * Always a slot no save is bound to: a bound one is written back on `pagehide`
 * (§4.5), which would repair the very slot the test is about.
 */
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
  // The character lives in slot 0; slot 1 is the wreck the panel has to offer a
  // way out of.
  const code = await page.evaluate(async (creation) => {
    const save = window.__reallm.save();
    save.create(0, creation);
    return save.exportCode(0);
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

test('a fresh save is the character §3 describes, seeded from ?seed= (AC-1 … AC-10, AC-6)', async ({ page }) => {
  await start(page, '/?seed=424242');
  const fresh = await page.evaluate((creation) => window.__reallm.save().create(0, creation), CREATION);

  expect(fresh.version).toBe(1);
  expect(fresh.meta).toMatchObject({ slot: 0, seed: 424242, iteration: 1, difficulty: 'normal' });
  expect(fresh.player).toMatchObject({ name: 'Vance', classId: 'marine', level: 1, xp: 0, tokens: 0 });
  // hp is maxHp(class, attributes, level), not a constant: it moves with the
  // attributes the creation screen allocated (SPEC-009).
  expect(fresh.player.hp).toBeGreaterThan(0);
  expect(fresh.resources).toEqual({ oil: 60, wheat: 20, water: 20, lithium: 0 });
  expect(fresh.inventory).toEqual([{ itemId: 'wheat_ration', qty: 3 }]);
  expect(fresh.companions).toEqual([{ id: 'aria', level: 1, enabled: true }]);
  expect(fresh.equipped).toEqual({ weapon: 'weapon_kinetic', armor: 'armor_scrap' });
  expect(fresh.ship).toEqual({ engine: 0, hull: 0, shield: 0, cargo: 0, weapon: 0 });
  expect(fresh.progress).toEqual({
    missionsDone: [],
    missionsActive: [],
    flags: [],
    currentPlanet: null,
    location: 'station',
    poisDiscovered: [],
    visits: {},
    endingSeen: false,
  });

  // §3: the slot keys, and a `:bak` of the previous good save under the second
  // write (AC-11, AC-12).
  await page.evaluate(() => window.__reallm.save().flush());
  expect(await slotKeys(page)).toEqual(['reallm:slot:0', 'reallm:slot:0:bak']);
});

test('the summary of a slot is what the menu prints (AC-60, AC-61, AC-62, AC-14)', async ({ page }) => {
  const written: string[] = [];
  page.on('console', (message) => {
    if (message.text().includes('save:written')) written.push(message.text());
  });
  await start(page, '/?debug');

  await page.evaluate((creation) => {
    const save = window.__reallm.save();
    save.create(1, creation); // reason 'new': written there and then (AC-62)
    save.addPlaytime(3725);
    save.flush();
  }, CREATION);

  expect(await page.evaluate(() => window.__reallm.save().list()[1])).toMatchObject({
    slot: 1,
    empty: false,
    name: 'Vance',
    classId: 'marine',
    level: 1,
    planet: null,
    playtimeSec: 3725, // AC-60: accumulated, and stored by the flush
  });
  expect(await page.evaluate(() => window.__reallm.save().list()[1].updatedAt)).toBeGreaterThan(0);
  expect(written.some((line) => line.includes('reason: new'))).toBe(true);
});

test('the main save is unusable and the backup is not (AC-19)', async ({ page }) => {
  await start(page);
  await page.evaluate((creation) => {
    const save = window.__reallm.save();
    save.create(0, creation);
    save.flush(); // now slot 0 and slot 0:bak both hold the character
  }, CREATION);

  const restored = await page.evaluate(() => {
    const good = localStorage.getItem('reallm:slot:0') ?? '';
    localStorage.setItem('reallm:slot:0:bak', good);
    localStorage.setItem('reallm:slot:0', '{"version":1,"pla'); // a torn write
    const result = window.__reallm.save().load(0);
    return { ok: result.ok, source: result.source, name: result.data?.player.name, main: localStorage.getItem('reallm:slot:0') === good };
  });

  expect(restored).toEqual({ ok: true, source: 'bak', name: 'Vance', main: true });
});

test('a save from a newer version is refused with the version it found (AC-21)', async ({ page }) => {
  await start(page);
  await page.evaluate((creation) => {
    const save = window.__reallm.save();
    save.create(1, creation);
    save.flush();
    const stored = JSON.parse(localStorage.getItem('reallm:slot:1') ?? '{}') as { version: number };
    stored.version = 99;
    localStorage.setItem('reallm:slot:1', JSON.stringify(stored));
    localStorage.setItem('reallm:slot:1:bak', JSON.stringify(stored)); // E9: its backup is from the future too
  }, CREATION);

  const refused = await page.evaluate(() => window.__reallm.save().load(1));
  expect(refused.ok).toBe(false);
  expect(refused.reason).toBe('newer_version');
  expect(refused.foundVersion).toBe(99);
  // E9 offers the export rather than a rewrite: the slot is untouched and still
  // exportable, so a player on the older build can carry it away.
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('reallm:slot:1') ?? '{}').version)).toBe(99);
  expect(await page.evaluate(() => window.__reallm.save().exportCode(1))).toMatch(/^RLM1\./);
});

test('a save written by an older build migrates up the chain on load (AC-34)', async ({ page }) => {
  await start(page);
  // The v0 fixture the unit suite migrates, this time through real storage.
  const v0 = {
    version: 0,
    slot: 1,
    seed: 123456,
    createdAt: 1700000000000,
    updatedAt: 1700000600000,
    playtimeSec: 612,
    appVersion: '0.0.0-alpha',
    player: {
      name: 'Kestrel',
      classId: 'scout',
      difficulty: 'casual',
      appearance: { portrait: 2, primary: '#3a8fb7', secondary: '#f0c419' },
      attributes: { might: 2, vigor: 3, agility: 6, tech: 2 },
      level: 4,
      xp: 320,
      tokens: 75,
      hp: 118,
    },
    resources: { oil: 120, wheat: 35, water: 44, lithium: 0 },
    inventory: [
      { itemId: 'wheat_ration', qty: 2 },
      { itemId: 'medkit', qty: 1 },
    ],
    equipped: { weapon: 'weapon_laser', armor: 'armor_scrap' },
    ship: { engine: 1, hull: 1, shield: 0, cargo: 0, weapon: 1 },
    companions: [{ id: 'aria', level: 1, enabled: true }],
    progress: {
      missionsDone: ['c1_m1'],
      missionsActive: [{ id: 'c1_m2', stage: 0, counters: { '0:0': 40 } }],
      flags: ['c1_oil'],
      currentPlanet: 'cinder4',
      location: 'surface',
      poisDiscovered: ['cinder4:dune_sea:0'],
    },
  };

  const loaded = await page.evaluate((fixture) => {
    localStorage.setItem('reallm:slot:1', JSON.stringify(fixture));
    return window.__reallm.save().load(1);
  }, v0);

  expect(loaded.ok).toBe(true);
  expect(loaded.data?.version).toBe(1);
  expect(loaded.data?.player).toMatchObject({ name: 'Kestrel', classId: 'scout', level: 4, tokens: 75 });
  expect(loaded.data?.meta).toMatchObject({ seed: 123456, playtimeSec: 612, difficulty: 'casual' });
  expect(loaded.data?.progress.currentPlanet).toBe('cinder4');
  expect(loaded.data?.progress.missionsActive).toEqual([{ id: 'c1_m2', stage: 0, counters: { '0:0': 40 } }]);
});

test('a write that does not read back is a failure, and a full quota drops the backup (AC-13, AC-15, AC-16)', async ({
  page,
}) => {
  const toasts: string[] = [];
  page.on('console', (message) => {
    if (message.text().includes('ui:toast')) toasts.push(message.text());
  });
  await start(page, '/?debug');

  const result = await page.evaluate((creation) => {
    const save = window.__reallm.save();
    save.create(0, creation);
    save.flush(); // a `:bak` exists from here on
    const out: Record<string, boolean> = {};

    // AC-13: Safari's silent truncation — the write "succeeds", the value read
    // back afterwards is short.
    const realGet = Storage.prototype.getItem;
    const realSet = Storage.prototype.setItem;
    let justWrote = false;
    Storage.prototype.setItem = function (key: string, value: string): void {
      realSet.call(this, key, value);
      if (key === 'reallm:slot:0') justWrote = true;
    };
    Storage.prototype.getItem = function (key: string): string | null {
      const value = realGet.call(this, key);
      if (key === 'reallm:slot:0' && justWrote) {
        justWrote = false;
        return typeof value === 'string' ? value.slice(0, -5) : value;
      }
      return value;
    };
    out['verified'] = save.flush();
    Storage.prototype.getItem = realGet;
    Storage.prototype.setItem = realSet;

    // AC-15: quota on the main key once, with a backup to drop.
    let first = true;
    Storage.prototype.setItem = function (key: string, value: string): void {
      if (key === 'reallm:slot:0' && first) {
        first = false;
        throw new DOMException('quota', 'QuotaExceededError');
      }
      realSet.call(this, key, value);
    };
    out['retried'] = save.flush();
    out['backupDropped'] = localStorage.getItem('reallm:slot:0:bak') === null;

    // AC-16: quota that never clears.
    Storage.prototype.setItem = function (key: string, value: string): void {
      if (key.startsWith('reallm:slot:0')) throw new DOMException('quota', 'QuotaExceededError');
      realSet.call(this, key, value);
    };
    out['hopeless'] = save.flush();
    Storage.prototype.setItem = realSet;
    return out;
  }, CREATION);

  expect(result).toEqual({ verified: false, retried: true, backupDropped: true, hopeless: false });
  await expect
    .poll(() => toasts.some((line) => line.includes('Save failed — export your save code')), { timeout: 5000 })
    .toBe(true);
});

test('two stage requests inside one window are a single write, after the render (AC-43, AC-44, AC-45, AC-46)', async ({
  page,
}) => {
  await start(page);
  const timing = await page.evaluate((creation) => {
    const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
    const save = window.__reallm.save();
    save.create(0, creation);

    const writes: Array<{ at: number; stack: string }> = [];
    const realSet = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string): void {
      if (key === 'reallm:slot:0') writes.push({ at: performance.now(), stack: String(new Error().stack) });
      realSet.call(this, key, value);
    };

    // AC-45: neither of these waits for the debounce.
    let count = writes.length;
    save.request('manual');
    const manual = writes.length - count;
    count = writes.length;
    save.request('pagehide');
    const pagehide = writes.length - count;

    // AC-43/AC-46: two requests, one window, one write.
    count = writes.length;
    const started = performance.now();
    save.request('stage');
    return sleep(120)
      .then(() => {
        save.request('stage');
        return sleep(250); // still inside the 500 ms window
      })
      .then(() => {
        const early = writes.length - count;
        return sleep(450).then(() => ({
          manual,
          pagehide,
          early,
          late: writes.length - count,
          delay: writes.length > count ? writes[count]!.at - started : -1,
          stack: writes.length > count ? writes[count]!.stack : '',
        }));
      })
      .then((out) => {
        Storage.prototype.setItem = realSet;
        return out;
      });
  }, CREATION);

  expect(timing.manual).toBe(1);
  expect(timing.pagehide).toBe(1);
  expect(timing.early).toBe(0);
  expect(timing.late).toBe(1);
  expect(timing.delay).toBeGreaterThanOrEqual(500);
  // AC-44: the write leaves through `tick()`, which `Game` calls after the
  // render — never from a scene's `update()`.
  expect(timing.stack).toContain('tick');
  expect(timing.stack).not.toContain('update');
});

test('a save requested during a scene transition waits for the far side of it (AC-47)', async ({ page }) => {
  await start(page);
  const timing = await page.evaluate((creation) => {
    const save = window.__reallm.save();
    save.create(0, creation);
    const writes: number[] = [];
    const realSet = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string): void {
      if (key === 'reallm:slot:0') writes.push(performance.now());
      realSet.call(this, key, value);
    };
    let entered: number | null = null;
    const poll = window.setInterval(() => {
      if (entered === null && window.__reallm.scene() === 'station') entered = performance.now();
    }, 5);

    const started = performance.now();
    const count = writes.length;
    save.request('stage'); // 07-c: the debounce deadline falls inside the transition
    return window.__reallm
      .go('station', {})
      .then(() => new Promise<void>((resolve) => setTimeout(resolve, 900)))
      .then(() => {
        window.clearInterval(poll);
        Storage.prototype.setItem = realSet;
        return {
          writes: writes.length - count,
          enteredAt: entered === null ? -1 : entered - started,
          writeAt: writes.length > count ? writes[count]! - started : -1,
        };
      });
  }, CREATION);

  expect(await page.evaluate(() => window.__reallm.scene())).toBe('station');
  expect(timing.writes).toBe(1);
  expect(timing.enteredAt).toBeGreaterThan(0);
  // The write is on the far side of the swap, not in the middle of it.
  expect(timing.writeAt).toBeGreaterThanOrEqual(timing.enteredAt);
});

test('the storage probe is written and removed once, at construction (AC-64)', async ({ page }) => {
  await page.addInitScript(() => {
    const ops: string[] = [];
    (window as unknown as { __probeOps: string[] }).__probeOps = ops;
    const realSet = Storage.prototype.setItem;
    const realRemove = Storage.prototype.removeItem;
    Storage.prototype.setItem = function (key: string, value: string): void {
      if (key.includes('probe')) ops.push(`set ${key}`);
      realSet.call(this, key, value);
    };
    Storage.prototype.removeItem = function (key: string): void {
      if (key.includes('probe')) ops.push(`remove ${key}`);
      realRemove.call(this, key);
    };
  });
  await start(page);

  expect(await page.evaluate(() => (window as unknown as { __probeOps: string[] }).__probeOps)).toEqual([
    'set reallm:probe',
    'remove reallm:probe',
  ]);
  // …and never again, however much the slots are used afterwards.
  await page.evaluate((creation) => {
    const save = window.__reallm.save();
    save.create(0, creation);
    save.flush();
    save.list();
    save.load(0);
  }, CREATION);
  expect(await page.evaluate(() => (window as unknown as { __probeOps: string[] }).__probeOps.length)).toBe(2);
  expect(await page.evaluate(() => Object.keys(localStorage).filter((key) => key.includes('probe')))).toEqual([]);
});

test('a second tab writing our slot stops this one autosaving (AC-65)', async ({ page, context }) => {
  const toasts: string[] = [];
  page.on('console', (message) => {
    if (message.text().includes('ui:toast')) toasts.push(message.text());
  });
  await start(page, '/?debug');
  await page.evaluate((creation) => {
    const save = window.__reallm.save();
    save.create(0, creation);
    save.flush();
  }, CREATION);
  expect(await page.evaluate(() => window.__reallm.save().refusingAutosaves)).toBe(false);

  // A real second tab of the same origin: the `storage` event only fires for a
  // write that happened somewhere else.
  const second = await context.newPage();
  try {
    await second.goto('/');
    await second.evaluate(() => {
      const stored = JSON.parse(localStorage.getItem('reallm:slot:0') ?? '{}') as { player: { name: string } };
      stored.player.name = 'TabTwo';
      localStorage.setItem('reallm:slot:0', JSON.stringify(stored));
    });
  } finally {
    await second.close();
  }

  await expect.poll(() => page.evaluate(() => window.__reallm.save().refusingAutosaves), { timeout: 5000 }).toBe(true);
  expect(toasts.some((line) => line.includes('Save changed in another tab'))).toBe(true);

  // 07-a: last write wins, and this tab stops writing until it is reloaded.
  const blocked = await page.evaluate(() => {
    const save = window.__reallm.save();
    const writes: string[] = [];
    const realSet = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string): void {
      if (key.startsWith('reallm:slot:0')) writes.push(key);
      realSet.call(this, key, value);
    };
    save.request('stage');
    save.request('pagehide');
    return new Promise<number>((resolve) =>
      setTimeout(() => {
        Storage.prototype.setItem = realSet;
        resolve(writes.length);
      }, 900),
    );
  });
  expect(blocked).toBe(0);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('reallm:slot:0') ?? '{}').player.name)).toBe(
    'TabTwo',
  );
});

test('iOS Safari outside standalone is told to add to the Home Screen, at most fortnightly (AC-53, AC-54)', async ({
  browser,
}) => {
  // A context-level user agent: `navigator.userAgent` really is Safari's here,
  // which is the whole of what §4.7 sniffs. `display-mode: standalone` (AC-55)
  // is the half no headless Chromium can present.
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  try {
    const phone = await context.newPage();
    const hints: string[] = [];
    phone.on('console', (message) => {
      if (message.text().includes('Add to Home Screen')) hints.push(message.text());
    });
    await start(phone, '/?debug');
    expect(await phone.evaluate(() => matchMedia('(display-mode: standalone)').matches)).toBe(false);

    // The first station save of the session, and two more after it.
    await phone.evaluate((creation) => {
      const save = window.__reallm.save();
      save.create(0, creation);
      save.flush();
      save.flush();
    }, CREATION);
    await expect.poll(() => hints.length, { timeout: 5000 }).toBe(1);
    const shownAt = await phone.evaluate(
      () => JSON.parse(localStorage.getItem('reallm:settings') ?? '{}').installHintShownAt as number,
    );
    expect(shownAt).toBeGreaterThan(0);

    // AC-54: thirteen days is inside the fortnight, fifteen is past it.
    for (const [days, expected] of [
      [13, 1],
      [15, 2],
    ] as const) {
      await phone.evaluate((age) => {
        const settings = JSON.parse(localStorage.getItem('reallm:settings') ?? '{}') as { installHintShownAt: number };
        settings.installHintShownAt = Date.now() - age * 24 * 3600 * 1000;
        localStorage.setItem('reallm:settings', JSON.stringify(settings));
      }, days);
      await start(phone, '/?debug'); // the store reads the settings at construction
      await phone.evaluate((creation) => window.__reallm.save().create(0, creation), CREATION);
      await phone.waitForTimeout(400);
      expect(hints.length, `hint after ${days} days`).toBe(expected);
    }
  } finally {
    await context.close();
  }
});
