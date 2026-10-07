// SPEC-059 §6.2 — coming back and showing others, in a real browser. The pure
// halves are node-tested (`tests/systems/resume.test.ts`, `records.test.ts`,
// `commendations.test.ts`, `share.test.ts`, `tests/ui/manifest.test.ts`);
// what only a browser shows is the path: a Save & Quit on a planet resumed by
// Continue after a reload, the "previously" card after a day, the station
// clearing the point, the last slot, the story difficulty, a commendation and
// the sessions that may not earn one, the Records panel, the Selection card
// shared and saved, the install button and the link previews.
//
// Pages run on the dev server. A case that needs the debug strip loads
// `?debug&records` — a dev build's way to keep records open on a `?debug`
// page (§4.3.3) — and binds its save through the save bridge.
import { expect, test, type Page } from '@playwright/test';
import { COLD_START, frames, start, type SaveSnapshot } from './start';

const URL = '/?debug&records&seed=123';
const SHARE_URL = 'https://mdzunic.github.io/reallm/';

const CREATION = {
  name: 'Vance',
  classId: 'marine',
  appearance: { portrait: 1, primary: '#b7472a', secondary: '#2a3b4c' },
  attributes: { might: 6, vigor: 5, agility: 1, tech: 1 },
  difficulty: 'normal',
} as const;

/** What `prepare` writes into the fresh slot-0 save before anything is entered. */
interface Prep {
  active?: string[];
  done?: string[];
  flags?: string[];
  oil?: number;
  difficulty?: string;
  resume?: { planet: string; at: number } | null;
  currentPlanet?: string | null;
  endingSeen?: boolean;
}

/**
 * Chapter 1 finished, its interlude already watched and Iris's first letter
 * read (SPEC-049 §4.3) — Vetra open, nothing modal on a station entry.
 */
const CHAPTER_ONE_DONE: Prep = {
  done: ['c1_m1', 'c1_m2', 'c1_m3'],
  flags: ['c1_oil', 'chapter1_done', 'interlude1_seen', 'letter1_read'],
  oil: 200,
};

/** A run that filed its verdict: every chapter, film, letter and aside behind it. */
const CAMPAIGN_FLAGS = [
  'chapter1_done',
  'chapter2_done',
  'chapter3_done',
  'chapter4_done',
  'chapter5_done',
  'interlude1_seen',
  'interlude2_seen',
  'interlude3_seen',
  'interlude4_seen',
  'interlude5_seen',
  'letter1_read',
  'letter2_read',
  'letter3_read',
  'letter4_read',
  'letter5_read',
  'clue_awake',
  'memory_roof',
  'campaign_done',
];

/** A fresh slot-0 save, edited by `prep`, bound and written to disk. */
async function prepare(page: Page, prep: Prep = {}, slot = 0): Promise<void> {
  await page.evaluate(
    ({ creation, prep, slot }) => {
      const bridge = window.__reallm.save();
      bridge.create(slot, creation, 123);
      const save = bridge.current;
      if (save === null) throw new Error('no save bound');
      if (prep.done !== undefined) save.progress.missionsDone = [...prep.done];
      if (prep.flags !== undefined) save.progress.flags = [...prep.flags];
      if (prep.active !== undefined) save.progress.missionsActive = prep.active.map((id) => ({ id, stage: 0, counters: {} }));
      if (prep.oil !== undefined) save.resources['oil'] = prep.oil;
      if (prep.difficulty !== undefined) save.meta.difficulty = prep.difficulty;
      if (prep.resume !== undefined) save.progress.resume = prep.resume;
      if (prep.currentPlanet !== undefined) {
        save.progress.currentPlanet = prep.currentPlanet;
        save.progress.location = prep.currentPlanet === null ? 'station' : 'surface';
      }
      if (prep.endingSeen !== undefined) save.progress.endingSeen = prep.endingSeen;
      bridge.request('manual');
      bridge.flush();
    },
    { creation: CREATION, prep, slot },
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
  for (let i = 0; i < 40; i++) {
    if (!(await dialogue.isVisible().catch(() => false))) return;
    if (await advance.isVisible().catch(() => false)) await advance.click({ force: true, timeout: 2_000 }).catch(() => undefined);
    else await dialogue.click({ force: true, timeout: 2_000 }).catch(() => undefined);
    await page.waitForTimeout(150);
  }
}

/** The bound save onto `planet`, the way the suites land (SPEC-044's `land`). */
async function land(page: Page, planet = 'cinder4'): Promise<void> {
  await page.evaluate((id) => window.__reallm.go('surface', { planet: id, firstLanding: false }, { force: true }), planet);
  await settle(page, 'surface');
  await dismiss(page);
}

/** A debug-strip control, clicked from the page so a held beat or an overlay cannot eat it. */
async function press(page: Page, id: string): Promise<void> {
  await page.evaluate((testId) => {
    const button = document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
    if (button === null) throw new Error(`no ${testId} on the debug strip`);
    button.click();
  }, id);
}

const current = (page: Page): Promise<SaveSnapshot | null> => page.evaluate(() => window.__reallm.save().current);

/** Slot `slot` as it is on disk, parsed (no binding, no rewrite). */
const stored = (page: Page, slot = 0): Promise<(SaveSnapshot & { progress: SaveSnapshot['progress'] }) | null> =>
  page.evaluate((n) => JSON.parse(localStorage.getItem(`reallm:slot:${n}`) ?? 'null'), slot);

/** The stored settings, parsed. */
const storedSettings = (page: Page): Promise<Record<string, unknown>> =>
  page.evaluate(() => JSON.parse(localStorage.getItem('reallm:settings') ?? '{}') as Record<string, unknown>);

const sceneInfo = async (page: Page): Promise<Record<string, number | string>> =>
  (await page.evaluate(() => window.__reallm.stats())).sceneInfo ?? {};

/** Every toast the rack shows from here on — a toast lives 5 s, which a starved host can spend between two assertions. */
async function recordToasts(page: Page): Promise<void> {
  await page.evaluate(() => {
    const rack = document.querySelector('[data-testid="toasts"]');
    if (rack === null) throw new Error('no toast rack');
    const shown: string[] = [];
    Object.assign(window, { __shownToasts: shown });
    new MutationObserver(() => {
      for (const node of Array.from(rack.children)) {
        let text = '';
        for (const child of Array.from(node.childNodes)) if (child.nodeType === Node.TEXT_NODE) text += child.textContent ?? '';
        if (!shown.includes(text)) shown.push(text);
      }
    }).observe(rack, { childList: true });
  });
}

const toastsShown = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as unknown as { __shownToasts?: string[] }).__shownToasts ?? []);

/**
 * A stored slot-0 save that stood on Vetra's pad `hoursAgo` hours ago, `c2_m1`
 * tracked at its first stage — then a fresh page with nothing bound. The
 * stamps are rewritten on a page where no save is bound, because a bound
 * one's `pagehide` write would stamp `updatedAt` again on the way out.
 */
async function storeVetraResume(page: Page, hoursAgo: number): Promise<void> {
  await prepare(page, { ...CHAPTER_ONE_DONE, active: ['c2_m1'], resume: { planet: 'vetra', at: Date.now() }, currentPlanet: 'vetra' });
  await start(page, URL);
  await page.evaluate((ms) => {
    const save = JSON.parse(localStorage.getItem('reallm:slot:0') ?? '{}') as { meta: { updatedAt: number }; progress: { resume: { at: number } | null } };
    const at = Date.now() - ms;
    save.meta.updatedAt = at;
    if (save.progress.resume !== null) save.progress.resume.at = at;
    localStorage.setItem('reallm:slot:0', JSON.stringify(save));
  }, hoursAgo * 60 * 60 * 1000);
  await start(page, URL);
}

// ---------------------------------------------------------- 1: resume, a day

test('1. resume within a day: Save & Quit on Vetra, a reload, and Continue lands on its pad', async ({ page }) => {
  test.setTimeout(150_000);
  await start(page, URL);
  await prepare(page, { ...CHAPTER_ONE_DONE, active: ['c2_m1'] });
  await land(page, 'vetra');
  const oil = (await current(page))?.resources['oil'];
  expect(oil).toBe(200);

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('pause-menu')).toBeVisible();
  await page.getByTestId('pause-quit').click();
  await page.getByTestId('confirm-yes').click();
  await settle(page, 'menu');
  expect((await stored(page))?.progress.resume?.planet).toBe('vetra');

  // A reload: nothing bound, only the slot — and Continue.
  await start(page, URL);
  await recordToasts(page);
  await page.getByTestId('go-station').click();
  await settle(page, 'surface');
  expect((await sceneInfo(page))['resumed']).toBe(1);
  expect((await current(page))?.progress.currentPlanet).toBe('vetra');
  expect((await current(page))?.resources['oil']).toBe(oil);
  await expect.poll(() => toastsShown(page), { timeout: 10_000 }).toContain('Resumed at the Vetra landing pad. Timed objectives restart.');
});

// ----------------------------------------------------- 2: the card after 24 h

test('2. after a day away Continue shows the previously card first; Back loads nothing', async ({ page }) => {
  test.setTimeout(120_000);
  await start(page, URL);
  await storeVetraResume(page, 25);

  await page.getByTestId('go-station').click();
  const card = page.getByTestId('resume-card');
  await expect(card).toBeVisible();
  await expect(card).toContainText('Chapter 2 — Water, under a mile of ice.');
  await expect(card).toContainText('Resuming at the Vetra landing pad');
  await expect(card).toContainText('Whiteout — Stage 1/2 · Tracked');
  await expect(card).toContainText("Next: continue 'Whiteout' — Stage 1/2");
  await expect.poll(() => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset['testid'] ?? null)).toBe('resume-continue');

  await page.getByTestId('resume-back').click();
  await expect(card).toHaveCount(0);
  await expect(page.getByTestId('scene-label')).toHaveText('menu');
  expect(await current(page)).toBeNull();

  // Escape closes it the same way (SPEC-036's back-stack).
  await page.getByTestId('go-station').click();
  await expect(card).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(card).toHaveCount(0);
  expect(await current(page)).toBeNull();

  await page.getByTestId('go-station').click();
  await page.getByTestId('resume-continue').click();
  await settle(page, 'surface');
  expect((await sceneInfo(page))['resumed']).toBe(1);
});

// ---------------------------------------------------- 3: the station clears it

test('3. the station clears the point, and the next Continue enters the station', async ({ page }) => {
  test.setTimeout(120_000);
  await start(page, URL);
  await storeVetraResume(page, 0);
  await page.getByTestId('go-station').click();
  await settle(page, 'surface');
  expect((await sceneInfo(page))['resumed']).toBe(1);
  await dismiss(page);

  expect(await page.evaluate(() => window.__reallm.go('station', {}))).toBe(true);
  await settle(page, 'station');
  await expect
    .poll(
      async () => {
        const save = await stored(page);
        return save === null ? 'no stored save' : save.progress.resume;
      },
      { timeout: 10_000 },
    )
    .toBeNull();

  await start(page, URL);
  await page.getByTestId('go-station').click();
  await settle(page, 'station');
});

// ------------------------------------------------------- 4: an owed ending

test('4. an owed ending resumes at the station, where it replays (59-a)', async ({ page }) => {
  await start(page, URL);
  await prepare(page, {
    flags: [...CAMPAIGN_FLAGS, 'ending_stay'],
    done: ['c6_m1', 'c6_m2'],
    resume: { planet: 'eden', at: Date.now() },
    currentPlanet: 'eden',
    endingSeen: false,
  });
  await start(page, URL);
  await page.getByTestId('go-station').click();
  await settle(page, 'station');
  await expect(page.getByTestId('ending-stay')).toBeVisible({ timeout: 20_000 });
});

// ----------------------------------------------------------- 5: the quit note

test('5. Save & Quit on Ferrum says the run resumes at its pad', async ({ page }) => {
  await start(page, URL);
  await prepare(page, {});
  await land(page, 'ferrum');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('pause-menu')).toBeVisible();
  await page.getByTestId('pause-quit').click();
  await expect(page.getByTestId('confirm-sheet')).toContainText('You will resume at the Ferrum landing pad');
  await expect(page.getByTestId('confirm-sheet')).toContainText('Timed objectives restart.');
});

// ---------------------------------------------------------- 6: the last slot

test('6. Continue enters the slot last loaded, even when another was written later (E-12, 59-r)', async ({ page }) => {
  test.setTimeout(120_000);
  await start(page, URL);
  await prepare(page, {}, 2);
  await prepare(page, {}, 0);
  await start(page, URL);
  await page.getByTestId('menu-load').click();
  await page.getByTestId('load-slot-2').click();
  await settle(page, 'station');
  expect((await current(page))?.meta.slot).toBe(2);

  await page.evaluate(() => {
    const save = JSON.parse(localStorage.getItem('reallm:slot:0') ?? '{}') as { meta: { updatedAt: number } };
    save.meta.updatedAt = Date.now() + 60_000;
    localStorage.setItem('reallm:slot:0', JSON.stringify(save));
  });
  await start(page, URL);
  await page.getByTestId('go-station').click();
  await settle(page, 'station');
  expect((await current(page))?.meta.slot).toBe(2);
  expect((await storedSettings(page))['lastSlot']).toBe(2);
});

// --------------------------------------------------------------- 7: story

test('7. story: Settings sets it, hits and storms take nothing, and creation offers it', async ({ page }) => {
  test.setTimeout(150_000);
  await start(page, URL);
  await prepare(page, { done: ['c1_m1'] });
  await land(page, 'cinder4');
  expect((await sceneInfo(page))['difficulty']).toBe('normal');

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('pause-menu')).toBeVisible();
  await page.getByTestId('pause-settings').click();
  const story = page.getByTestId('settings-difficulty-story');
  await expect(story).toHaveText('Story');
  await story.click();
  await expect(story).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('settings-difficulty-line')).toHaveText(
    'Story — hostiles and storms cannot hurt you; the fights still happen. Records are off.',
  );
  expect((await current(page))?.meta.difficulty).toBe('story');
  expect((await sceneInfo(page))['difficulty']).toBe('story');
  await page.getByTestId('settings-close').click();
  await page.getByTestId('pause-resume').click();
  await expect(page.getByTestId('pause-menu')).toBeHidden();

  const hp = (await current(page))?.player.hp;
  await press(page, 'surface-hurt-from');
  await frames(page, 10);
  expect((await current(page))?.player.hp).toBe(hp);
  await expect(page.locator('.hud-hit-dir')).toHaveCount(0);

  await press(page, 'surface-storm');
  await page.waitForTimeout(5_000);
  expect((await current(page))?.player.hp).toBe(hp);

  await start(page, '/?debug&records&seed=123&scene=creation');
  await settle(page, 'creation');
  const choice = page.getByTestId('difficulty-story');
  await expect(choice).toBeVisible();
  await choice.click();
  await expect(page.locator('.creation-difficulty .settings-note')).toHaveText(
    'Story — hostiles and storms cannot hurt you; the fights still happen. Records are off.',
  );
});

// ---------------------------------------------------- 8, 9: a commendation

/**
 * Case 8's run: `c1_m1` accepted, a landing on Cinder-4, and the strip's
 * finish until the mission is done; then a moment for its save to write.
 */
async function dryLand(page: Page, url: string, prep: Prep = {}): Promise<void> {
  await start(page, url);
  await prepare(page, { active: ['c1_m1'], ...prep });
  await land(page, 'cinder4');
  await recordToasts(page);
  const done = (): Promise<boolean> =>
    page.evaluate(() => window.__reallm.save().current?.progress.missionsDone.includes('c1_m1') === true);
  for (let i = 0; i < 8 && !(await done()); i++) {
    await press(page, 'surface-finish-stage');
    await page.waitForTimeout(300);
    await dismiss(page);
  }
  await expect.poll(done, { timeout: 20_000 }).toBe(true);
}

test('8. a commendation: Dry Land finished earns Dry land, its toast and a best time', async ({ page }) => {
  test.setTimeout(150_000);
  await dryLand(page, URL);
  await expect.poll(() => toastsShown(page), { timeout: 15_000 }).toContain('Commendation — Dry land');
  await expect.poll(async () => ((await storedSettings(page))['commendations'] as Record<string, unknown> | undefined)?.['dry_land']).toEqual(
    expect.any(Number),
  );
  expect(((await storedSettings(page))['bestTimes'] as Record<string, unknown> | undefined)?.['c1_m1']).toEqual(expect.any(Number));
});

test.describe('9. records closed: no commendation and no best time', () => {
  /** After the run, a save written since: nothing recorded. */
  async function nothingRecorded(page: Page): Promise<void> {
    await page.evaluate(() => {
      window.__reallm.save().request('manual');
      window.__reallm.save().flush();
    });
    await page.waitForTimeout(1_000);
    expect((await toastsShown(page)).filter((text) => text.startsWith('Commendation'))).toEqual([]);
    const settings = await storedSettings(page);
    expect(settings['commendations'] ?? {}).toEqual({});
    expect(settings['bestTimes'] ?? {}).toEqual({});
  }

  test('with ?debug alone', async ({ page }) => {
    test.setTimeout(150_000);
    await dryLand(page, '/?debug&seed=123');
    await nothingRecorded(page);
  });

  test('with ?debug&records and the story difficulty', async ({ page }) => {
    test.setTimeout(150_000);
    await dryLand(page, URL, { difficulty: 'story' });
    await nothingRecorded(page);
  });

  test('with ?debug&records and service mode on', async ({ page }) => {
    test.setTimeout(150_000);
    await page.addInitScript(() => {
      const raw = JSON.parse(localStorage.getItem('reallm:settings') ?? '{}') as Record<string, unknown>;
      localStorage.setItem('reallm:settings', JSON.stringify({ ...raw, version: 1, serviceMode: true }));
    });
    await dryLand(page, URL);
    await nothingRecorded(page);
  });
});

// ------------------------------------------------------- 10: the panel

test('10. the Records panel: the title, the count, an earned row, a classified one, and the reveal', async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('seeded') !== null) return;
    sessionStorage.setItem('seeded', '1');
    localStorage.setItem('reallm:settings', JSON.stringify({ version: 1, commendations: { dry_land: 1790000000000 } }));
  });
  await start(page, URL);
  await page.getByTestId('menu-records').click();
  const panel = page.getByTestId('records-panel');
  await expect(panel).toBeVisible();
  await expect(page.getByTestId('records-title')).toHaveText('Commendations — Earth Command');
  await expect(page.getByTestId('records-count')).toHaveText('1 of 24');
  await expect(page.getByTestId('records-dry_land')).toContainText('Earned 2026-09-21');
  await expect(page.getByTestId('records-sixty_one_times')).toContainText('— classified —');
  await expect(page.getByTestId('records-untouched')).toContainText('Not yet earned');
  // Review 2026-10 S-08: the clue rows are classified, and the grades read Command's words.
  await expect(page.getByTestId('records-off_task')).toContainText('— classified —');
  await expect(page.getByTestId('records-good_run')).toContainText('File the Eden survey.');
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);

  // A slot whose save has heard the Warden re-titles the list.
  await prepare(page, { flags: ['chapter5_done'] });
  await start(page, URL);
  await page.getByTestId('menu-records').click();
  await expect(page.getByTestId('records-title')).toHaveText('Evaluation log — instance/62');
  await expect(page.getByTestId('records-good_run')).toContainText('command rating of 0.94 or better');
});

// ----------------------------------------------- 11–13: the Selection card

/** Web Share for files, stubbed: `canShare` says yes and `share` records what it got. */
async function stubShare(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const calls: { files: number; type: string; name: string; size: number; ihdr: number[]; text: string }[] = [];
    Object.assign(window, { __shared: calls });
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true });
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: async (data: { files: File[]; text: string }) => {
        const file = data.files[0] as File;
        const bytes = new Uint8Array(await file.arrayBuffer());
        calls.push({ files: data.files.length, type: file.type, name: file.name, size: file.size, ihdr: [...bytes.slice(12, 24)], text: data.text });
      },
    });
  });
}

type Shared = { files: number; type: string; name: string; size: number; ihdr: number[]; text: string };
const shared = (page: Page): Promise<Shared[]> => page.evaluate(() => (window as unknown as { __shared: Shared[] }).__shared);

/** The station for the bound save, its Character tab open and its card ready. */
async function characterTab(page: Page): Promise<void> {
  expect(await page.evaluate(() => window.__reallm.go('station', {}))).toBe(true);
  await settle(page, 'station');
  await dismiss(page);
  await page.getByTestId('station-tab-character').click();
  await expect(page.getByTestId('char-share')).toBeEnabled({ timeout: 20_000 });
}

/** `[width, height]` out of the IHDR bytes 12…23 a share recorded. */
function ihdrSize(ihdr: number[]): [number, number] {
  const word = (at: number): number => (((ihdr[at] ?? 0) << 24) | ((ihdr[at + 1] ?? 0) << 16) | ((ihdr[at + 2] ?? 0) << 8) | (ihdr[at + 3] ?? 0)) >>> 0;
  return [word(4), word(8)];
}

test('11. the card, shared: one 1200 × 630 PNG and the text, through navigator.share', async ({ page }) => {
  test.setTimeout(120_000);
  await stubShare(page);
  await start(page, URL);
  await prepare(page, {});
  await characterTab(page);
  await page.getByTestId('char-share').click();
  await expect.poll(async () => (await shared(page)).length, { timeout: 10_000 }).toBe(1);
  const [call] = await shared(page);
  expect(call?.files).toBe(1);
  expect(call?.type).toBe('image/png');
  expect(call?.name).toBe('reallm-selection-card.png');
  expect(call?.size).toBeGreaterThan(20 * 1024);
  expect(String.fromCharCode(...(call?.ihdr ?? []).slice(0, 4))).toBe('IHDR');
  expect(ihdrSize(call?.ihdr ?? [])).toEqual([1200, 630]);
  expect(call?.text).toContain('Selection card 62 — chapter 1 of 6');
  expect(call?.text.endsWith(SHARE_URL)).toBe(true);
});

test.describe('12. the fallback', () => {
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

  test('with no Web Share for files, the card downloads and the text is copied', async ({ page }) => {
    test.setTimeout(120_000);
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'canShare', { configurable: true, value: undefined });
      Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
    });
    await start(page, URL);
    await prepare(page, {});
    await characterTab(page);
    await recordToasts(page);
    const download = page.waitForEvent('download');
    await page.getByTestId('char-share').click();
    expect((await download).suggestedFilename()).toBe('reallm-selection-card.png');
    await expect.poll(() => toastsShown(page), { timeout: 10_000 }).toContain('Card saved. The link is on your clipboard.');
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toContain('Selection card 62 — chapter 1 of 6');
    expect(copied.endsWith(SHARE_URL)).toBe(true);
  });
});

test('13. a card made on story says so before the URL', async ({ page }) => {
  test.setTimeout(120_000);
  await stubShare(page);
  await start(page, URL);
  await prepare(page, { difficulty: 'story' });
  await characterTab(page);
  await page.getByTestId('char-share').click();
  await expect.poll(async () => (await shared(page)).length, { timeout: 10_000 }).toBe(1);
  expect((await shared(page))[0]?.text).toContain(` (story mode) ${SHARE_URL}`);
});

// --------------------------------------------------- 14: after an interlude

test('14. after an interlude settles, interlude-share sits in the station head', async ({ page }) => {
  test.setTimeout(150_000);
  await page.route('**/assets/films/*.mp4', (route) => route.abort());
  await start(page, '/?films=on&debug&records&seed=123');
  await prepare(page, { done: ['c1_m1', 'c1_m2', 'c1_m3'], flags: ['c1_oil', 'chapter1_done', 'letter1_read'], oil: 200 });
  await start(page, '/?films=on&debug&records&seed=123');
  await page.getByTestId('go-station').click();
  await settle(page, 'station');
  const film = page.getByTestId('film');
  await expect(film).toHaveAttribute('data-film', 'interlude_c1', { timeout: 20_000 });
  await expect(page.getByTestId('interlude-share')).toHaveCount(0);
  await page.waitForTimeout(500);
  await page.getByTestId('film-skip').click();
  await expect(film).toHaveCount(0);
  const share = page.getByTestId('interlude-share');
  await expect(share).toBeVisible({ timeout: 20_000 });
  await expect(share).toBeEnabled({ timeout: 20_000 });
});

// ------------------------------------------------------------- 15: install

test('15. install: a kept prompt shows the button, a press spends it, and appinstalled hides it', async ({ page }) => {
  await start(page, URL);
  const install = page.getByTestId('menu-install');
  await expect(install).toHaveCount(0);
  const offer = (): Promise<void> =>
    page.evaluate(() => {
      const event = new Event('beforeinstallprompt', { cancelable: true });
      const w = window as unknown as { __prompts?: number };
      Object.assign(event, {
        prompt: () => {
          w.__prompts = (w.__prompts ?? 0) + 1;
          return Promise.resolve();
        },
        userChoice: Promise.resolve({ outcome: 'dismissed', platform: 'web' }),
      });
      window.dispatchEvent(event);
    });
  await offer();
  await expect(install).toBeVisible();
  await install.click();
  await expect(install).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __prompts?: number }).__prompts)).toBe(1);

  await offer();
  await expect(install).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('appinstalled')));
  await expect(install).toHaveCount(0);
  expect((await storedSettings(page))['installed']).toBe(true);
});

// ------------------------------------------------------- 16: link previews

test('16. link previews: the served page names og.png and the canonical URL, and og.png is served', async ({ page }) => {
  await start(page, '/');
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute('content', `${SHARE_URL}og.png`);
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', SHARE_URL);
  const response = await page.request.get('/og.png');
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toContain('image/png');
});
