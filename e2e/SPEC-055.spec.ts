// SPEC-055 §6.2 — the puzzles in a real browser: the relic beside Cinder-4's
// landmark, Escape out of a vault panel, the conduit vault solved by its hints
// with the flawless medkit, the bypass after three hints without it, the
// plates walked in the panel's order, the beam that waits for the light, Eden's
// human-verification lock answered both ways, a solved relic after a reload,
// and the panel's keys. The rules are pinned in node — tests/systems/puzzles,
// underground, economy, tests/ui/helpers, controls and tests/data/content.
import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';
import { COLD_START, frames, start } from './start';

const CREATION = {
  name: 'Vance',
  classId: 'marine',
  appearance: { portrait: 1, primary: '#b7472a', secondary: '#2a3b4c' },
  attributes: { might: 6, vigor: 5, agility: 1, tech: 1 },
  difficulty: 'normal',
} as const;

/** The game runs at a fraction of the wall clock on a GPU-less container. */
const SLOW = { timeout: 90_000 } as const;
/** Review 2026-10 P-08: the relic is a sequence, so its first open shows the sequence's own tip. */
const TIP_KEYBOARD = 'Arrows pick an answer, Enter chooses it. A wrong pick deals a new sequence. H asks ARIA for a hint — hints are free.';
const STONES_LINE = 'Step on the stones in this order. Do not deviate.';

async function info(page: Page): Promise<Record<string, number | string>> {
  return page.evaluate(() => window.__reallm.stats().sceneInfo ?? {});
}

/** A debug-strip button, clicked from script so no overlay can take the pointer. */
async function tap(page: Page, id: string): Promise<void> {
  await page.evaluate((testid) => (document.querySelector(`[data-testid="${testid}"]`) as HTMLElement).click(), id);
}

/** One key press held across a few rendered frames, so a fixed step reads its edge. */
async function press(page: Page, code: string): Promise<void> {
  await page.keyboard.down(code);
  await frames(page, 4);
  await page.keyboard.up(code);
  await frames(page, 2);
}

async function untilInfo(page: Page, key: string, value: number | string, options = SLOW): Promise<void> {
  await page.waitForFunction(
    ({ name, want }) => window.__reallm.stats().sceneInfo?.[name] === want,
    { name: key, want: value },
    { polling: 'raf', ...options },
  );
}

/** Click through any open dialogue, as the other surface suites do. */
async function dismiss(page: Page): Promise<void> {
  const dialogue = page.locator('[data-testid="dialogue"]');
  const advance = page.locator('[data-testid="dialogue-advance"]');
  for (let i = 0; i < 25; i++) {
    if (!(await dialogue.isVisible().catch(() => false))) return;
    if (await advance.isVisible().catch(() => false)) await advance.click({ force: true, timeout: 2_000 }).catch(() => undefined);
    else await dialogue.click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(120);
  }
}

/** A slot-0 save on seed 123 with `c1_m1` done, then a landing through the scene machine. */
async function land(page: Page, planet: string): Promise<void> {
  await page.evaluate((creation) => {
    const bridge = window.__reallm.save();
    bridge.create(0, creation, 123);
    const save = bridge.current;
    if (save === null) throw new Error('no save bound');
    save.progress.missionsDone.push('c1_m1');
  }, CREATION);
  await page.evaluate((id) => window.__reallm.go('surface', { planet: id }, { force: true }), planet);
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('surface', COLD_START);
  await expect(page.locator('[data-testid="transition-fade"]')).toHaveCSS('pointer-events', 'none', COLD_START);
  await dismiss(page);
}

async function descend(page: Page): Promise<void> {
  await tap(page, 'surface-descend');
  await untilInfo(page, 'level', 'underground');
  await untilInfo(page, 'held', 0);
}

/**
 * The packs within reach, one smite each. A cave's packs stand in its far
 * rooms — the vault's among them — and on a loaded machine a hit can knock the
 * salvager off a terminal or a mirror between a goto and the press.
 */
async function clearPacks(page: Page): Promise<void> {
  for (let i = 0; i < 20 && Number((await info(page))['caveEnemies']) > 0; i++) {
    await tap(page, 'surface-smite');
    await frames(page, 2);
  }
}

/** The vault room's door side, then the nearest puzzle — the vault terminal outside the door — and its panel. */
async function openVault(page: Page): Promise<void> {
  const panel = page.locator('[data-testid="puzzle-panel"]');
  for (let attempt = 1; ; attempt++) {
    await tap(page, 'surface-goto-vault');
    await frames(page, 4);
    await clearPacks(page);
    await tap(page, 'surface-goto-puzzle');
    await expect(page.locator('[data-testid="hud-interact"]')).toContainText('Use terminal', SLOW);
    await press(page, 'KeyE');
    // A press that did not land is tried again from a fresh goto.
    const opened = await panel.waitFor({ state: 'visible', timeout: 20_000 }).then(
      () => true,
      () => false,
    );
    if (opened || (await panel.isVisible())) break;
    if (attempt === 3) await expect(panel).toBeVisible(SLOW);
  }
  await untilInfo(page, 'held', 1);
}

async function claimed(page: Page): Promise<string[]> {
  return page.evaluate(() => (window.__reallm.save().current?.progress as { claimed?: string[] } | undefined)?.claimed ?? []);
}

async function untilClaimed(page: Page, cache: string): Promise<void> {
  await page.waitForFunction(
    (id) => ((window.__reallm.save().current?.progress as { claimed?: string[] } | undefined)?.claimed ?? []).includes(id),
    cache,
    { polling: 'raf', ...SLOW },
  );
}

async function medkits(page: Page): Promise<number> {
  return page.evaluate(() =>
    (window.__reallm.save().current?.inventory ?? []).filter((slot) => slot.itemId === 'medkit').reduce((sum, slot) => sum + slot.qty, 0),
  );
}

/** The bus's log lines (`?debug` prints every event), with the payload read back as JSON. */
function recordEvents(page: Page): { of(name: string): Promise<Record<string, unknown>[]>; texts(name: string): string[] } {
  const messages: ConsoleMessage[] = [];
  page.on('console', (message) => {
    if (message.type() === 'debug' && message.text().startsWith('[events] ')) messages.push(message);
  });
  const named = (name: string): ConsoleMessage[] => messages.filter((m) => m.text().startsWith(`[events] ${name}`));
  return {
    async of(name) {
      const out: Record<string, unknown>[] = [];
      for (const message of named(name)) {
        const payload = await message.args()[2]?.jsonValue().catch(() => null);
        if (payload !== null && typeof payload === 'object') out.push(payload as Record<string, unknown>);
      }
      return out;
    },
    texts: (name) => named(name).map((m) => m.text()),
  };
}

/** Clicks the cells `puzzleHint` names until the panel's board is solved. */
async function solveByHints(page: Page): Promise<void> {
  const n = Math.round(Math.sqrt(await page.locator('[data-testid^="puzzle-cell-"]').count()));
  for (let i = 0; i < 80; i++) {
    const hint = String((await info(page))['puzzleHint']);
    if (!hint.startsWith('cell:')) return;
    const cell = Number(hint.slice('cell:'.length));
    await page.locator(`[data-testid="puzzle-cell-${Math.floor(cell / n)}-${cell % n}"]`).click();
    await frames(page, 2);
  }
}

test.describe('SPEC-055 puzzles', () => {
  test.setTimeout(240_000);

  test('1: the relic — the panel holds the world, a hint greys a choice, the right one solves and claims', async ({ page }) => {
    const events = recordEvents(page);
    await start(page, '/?debug');
    await land(page, 'cinder4');
    expect((await info(page))['relicMark']).toBe('-');
    await tap(page, 'surface-goto-puzzle');
    await expect(page.locator('[data-testid="hud-interact"]')).toContainText('Use terminal', SLOW);
    // §4.1: beside it, landmark 0 is discovered, and the relic joins the map.
    await untilInfo(page, 'relicMark', 'relic');
    await press(page, 'KeyE');
    const panel = page.locator('[data-testid="puzzle-panel"]');
    await expect(panel).toBeVisible(SLOW);
    await untilInfo(page, 'held', 1);
    expect((await info(page))['puzzle']).toBe('cinder4_relic');
    await expect(page.locator('[data-testid="puzzle-title"]')).toHaveText('COMPLETE THE SEQUENCE');
    await expect(page.locator('[data-testid="aria-hint"]')).toHaveText(TIP_KEYBOARD);
    // SPEC-036: the panel is on the back-stack.
    expect(await page.evaluate(() => window.__reallm.backDepth())).toBeGreaterThan(0);
    await expect(page.locator('[data-testid="puzzle-board"] .puzzle-token')).toHaveCount(6);
    await expect(page.locator('[data-testid^="puzzle-choice-"]')).toHaveCount(4);

    await page.locator('[data-testid="puzzle-hint"]').click();
    await expect(page.locator('[data-testid^="puzzle-choice-"][aria-disabled="true"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="puzzle-status"]')).toHaveText('ARIA: try this one.');
    const hint = String((await info(page))['puzzleHint']);
    expect(hint).toMatch(/^choice:\d$/);
    await page.locator(`[data-testid="puzzle-choice-${hint.slice('choice:'.length)}"]`).click();
    await expect(page.locator('[data-testid="puzzle-status"]')).toHaveText('Solved');
    await untilClaimed(page, 'cinder4_relic');
    await expect(panel).toBeHidden();
    await untilInfo(page, 'held', 0);
    const solved = await events.of('puzzle:solved');
    expect(solved).toContainEqual({ site: 'cinder4_relic', hints: 1, bypassed: false });
    expect(events.texts('cache:opened').some((line) => line.includes('cinder4_relic'))).toBe(true);
    expect((await info(page))['puzzlesSolved']).toBe(1);
    // §4.8: spent — the terminal prompts Unlocked, and E opens nothing; the map's icon goes hollow.
    await expect(page.locator('[data-testid="hud-interact"]')).toContainText('Unlocked', SLOW);
    expect((await info(page))['relicMark']).toBe('spent');
    await press(page, 'KeyE');
    await frames(page, 10);
    await expect(panel).toHaveCount(0);
  });

  test('2: Escape closes a vault panel, releases the hold and leaves the site unsolved', async ({ page }) => {
    await start(page, '/?debug');
    await land(page, 'cinder4');
    await descend(page);
    await openVault(page);
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="puzzle-panel"]')).toHaveCount(0);
    await untilInfo(page, 'held', 0);
    expect(await claimed(page)).not.toContain('cinder4_vault');
    // …and the board is kept: open again, the same title, nothing solved.
    await press(page, 'KeyE');
    await expect(page.locator('[data-testid="puzzle-title"]')).toHaveText('ROUTE POWER', SLOW);
    await page.locator('[data-testid="puzzle-close"]').click();
    await untilInfo(page, 'held', 0);
    expect(await claimed(page)).not.toContain('cinder4_vault');
  });

  test('3: the conduit vault — ROUTE POWER, the hinted cells route it, and the cache pays its medkit', async ({ page }) => {
    const events = recordEvents(page);
    await start(page, '/?debug');
    await land(page, 'cinder4');
    await descend(page);
    const before = await medkits(page);
    await openVault(page);
    await expect(page.locator('[data-testid="puzzle-title"]')).toHaveText('ROUTE POWER');
    await expect(page.locator('[data-testid^="puzzle-cell-"]')).toHaveCount(16);
    const label = await page.locator('[data-testid="puzzle-cell-0-0"]').getAttribute('aria-label');
    expect(label).toMatch(/^Tile 1, 1: /);
    await solveByHints(page);
    await untilClaimed(page, 'cinder4_vault');
    await untilInfo(page, 'held', 0);
    expect(events.texts('cache:opened').some((line) => line.includes('cinder4_vault'))).toBe(true);
    expect(await events.of('puzzle:solved')).toContainEqual({ site: 'cinder4_vault', hints: 0, bypassed: false });
    expect(await medkits(page)).toBe(before + 1);
  });

  test('4: the bypass — three hints enable it, and it solves the lock without the flawless medkit', async ({ page }) => {
    const events = recordEvents(page);
    await start(page, '/?debug');
    await land(page, 'vetra');
    await descend(page);
    const before = await medkits(page);
    await openVault(page);
    await expect(page.locator('[data-testid="puzzle-title"]')).toHaveText('CALIBRATE ARRAY');
    const bypass = page.locator('[data-testid="puzzle-bypass"]');
    await expect(bypass).toBeDisabled();
    await expect(bypass).toHaveText('ARIA: force the lock');
    await expect(page.locator('[data-testid="puzzle-bypass-note"]')).toHaveText(/^ARIA can force it in \d+ s$/);
    for (let i = 0; i < 3; i++) await press(page, 'KeyH');
    await untilInfo(page, 'puzzleHints', 3);
    await expect(bypass).toBeEnabled();
    await bypass.click();
    await untilClaimed(page, 'vetra_vault');
    await untilInfo(page, 'held', 0);
    expect(await events.of('puzzle:solved')).toContainEqual({ site: 'vetra_vault', hints: 3, bypassed: true });
    expect(await medkits(page)).toBe(before);
  });

  test('5: plates — the panel reads the stones, and the goto walks the order to the cache', async ({ page }) => {
    const events = recordEvents(page);
    await start(page, '/?debug');
    await land(page, 'cinder4');
    await descend(page);
    // The vault first, so the plates are the nearest unsolved puzzle wherever the cave puts them.
    await openVault(page);
    await tap(page, 'surface-solve-puzzle');
    await untilClaimed(page, 'cinder4_vault');
    await untilInfo(page, 'held', 0);

    await tap(page, 'surface-goto-puzzle');
    await expect(page.locator('[data-testid="hud-interact"]')).toContainText('Read the panel', SLOW);
    await press(page, 'KeyE');
    await expect(page.locator('[data-testid="aria-hint"]')).toContainText(STONES_LINE, SLOW);
    const line = (await page.locator('[data-testid="aria-hint"]').textContent()) ?? '';
    const glyphs = line.slice(STONES_LINE.length).trim().split(', ');
    expect(glyphs.length).toBe(3);
    await expect(page.locator('.hud-objective')).toHaveText(`Stones: ${glyphs.join(' · ')}`, SLOW);
    // A world puzzle never holds the world.
    expect((await info(page))['held']).toBe(0);

    for (let i = 0; i < 3; i++) {
      await tap(page, 'surface-goto-puzzle');
      await page.waitForFunction((want) => Number(window.__reallm.stats().sceneInfo?.['puzzleMoves']) >= want, i + 1, SLOW);
    }
    await untilClaimed(page, 'cinder4_loose_b');
    const moved = await events.of('puzzle:moved');
    expect(moved.filter((m) => m['site'] === 'cinder4_world')).toEqual([
      { site: 'cinder4_world', ok: true },
      { site: 'cinder4_world', ok: true },
      { site: 'cinder4_world', ok: true },
    ]);
    expect(await events.of('puzzle:solved')).toContainEqual({ site: 'cinder4_world', hints: 0, bypassed: false });
    expect(events.texts('cache:opened').some((text) => text.includes('cinder4_loose_b'))).toBe(true);
    await expect(page.locator('.hud-objective')).not.toContainText('Stones:', SLOW);
  });

  test('6: the beam — aligned in the dark solves nothing, and the light solves it', async ({ page }) => {
    const events = recordEvents(page);
    await start(page, '/?debug');
    await land(page, 'vetra');
    await descend(page);
    await openVault(page);
    await tap(page, 'surface-solve-puzzle');
    await untilClaimed(page, 'vetra_vault');
    await untilInfo(page, 'held', 0);

    await tap(page, 'surface-goto-puzzle');
    await clearPacks(page);
    await press(page, 'KeyL');
    await untilInfo(page, 'light', 0);
    for (let i = 0; i < 24; i++) {
      const hint = String((await info(page))['puzzleHint']);
      if (!hint.startsWith('mirror:')) break;
      await tap(page, 'surface-goto-puzzle');
      await expect(page.locator('[data-testid="hud-interact"]')).toContainText('Turn the mirror', SLOW);
      const moves = Number((await info(page))['puzzleMoves']);
      await press(page, 'KeyE');
      // A turn that did not land is tried again from a fresh goto.
      await page
        .waitForFunction((want) => Number(window.__reallm.stats().sceneInfo?.['puzzleMoves']) > want, moves, { timeout: 20_000 })
        .catch(() => undefined);
    }
    await untilInfo(page, 'puzzleBeam', 1);
    await frames(page, 20);
    expect((await events.of('puzzle:solved')).some((e) => e['site'] === 'vetra_world')).toBe(false);
    expect(await claimed(page)).not.toContain('vetra_loose_b');

    await press(page, 'KeyL');
    await untilClaimed(page, 'vetra_loose_b');
    expect(await events.of('puzzle:solved')).toContainEqual({ site: 'vetra_world', hints: 0, bypassed: false });
  });

  for (const [answer, choice, line] of [
    ['run', 1, 'Verification failed: response predicted. Welcome back, instance/62.'],
    ['stop', 0, 'Verification failed: response sampled. Welcome back, instance/62.'],
  ] as const) {
    test(`${answer === 'run' ? 7 : 8}: the human lock — ${answer} is ${answer === 'run' ? 'predicted' : 'sampled'}, and the vault opens flawless`, async ({ page }) => {
      const events = recordEvents(page);
      await start(page, '/?debug');
      await land(page, 'eden');
      await descend(page);
      const before = await medkits(page);
      await openVault(page);
      await expect(page.locator('[data-testid="puzzle-title"]')).toHaveText('HUMAN VERIFICATION — complete the sentence');
      await expect(page.locator('[data-testid="puzzle-board"] .puzzle-token')).toHaveText(['walk', 'do', 'not', '?']);
      await expect(page.locator('[data-testid^="puzzle-choice-"]')).toHaveText(['stop', 'run', 'look', 'wake']);
      await expect(page.locator('[data-testid="puzzle-hint"]')).toHaveCount(0);
      await expect(page.locator('[data-testid="puzzle-bypass"]')).toHaveCount(0);
      await page.locator(`[data-testid="puzzle-choice-${choice}"]`).click();
      await expect(page.locator('[data-testid="puzzle-status"]')).toHaveText(line);
      await untilClaimed(page, 'eden_vault');
      await expect(page.locator('[data-testid="puzzle-panel"]')).toHaveCount(0);
      await untilInfo(page, 'held', 0);
      expect(await events.of('puzzle:solved')).toContainEqual({ site: 'eden_vault', hints: 0, bypassed: false });
      expect(await medkits(page)).toBe(before + 1);
    });
  }

  test('9: a solved relic stays solved after a reload — Unlocked, and E opens nothing', async ({ page }) => {
    await start(page, '/?debug');
    await land(page, 'cinder4');
    await tap(page, 'surface-goto-puzzle');
    await expect(page.locator('[data-testid="hud-interact"]')).toContainText('Use terminal', SLOW);
    await press(page, 'KeyE');
    await expect(page.locator('[data-testid="puzzle-panel"]')).toBeVisible(SLOW);
    await tap(page, 'surface-solve-puzzle');
    await untilClaimed(page, 'cinder4_relic');
    await untilInfo(page, 'held', 0);
    await page.evaluate(() => window.__reallm.save().flush());

    await start(page, '/?debug');
    // The slot read back and bound as the live save, as Continue does.
    const loaded = await page.evaluate(() => {
      const store = window.__reallm.save();
      const result = store.load(0);
      if (result.ok && result.data !== undefined) (store as unknown as { bind(data: unknown): void }).bind(result.data);
      return result;
    });
    expect(loaded.ok).toBe(true);
    expect((loaded.data?.progress as { claimed?: string[] } | undefined)?.claimed ?? []).toContain('cinder4_relic');
    await page.evaluate(() => window.__reallm.go('surface', { planet: 'cinder4' }, { force: true }));
    await expect(page.locator('[data-testid="scene-label"]')).toHaveText('surface', COLD_START);
    await expect(page.locator('[data-testid="transition-fade"]')).toHaveCSS('pointer-events', 'none', COLD_START);
    await dismiss(page);
    expect(await claimed(page)).toContain('cinder4_relic');
    // With nothing unsolved above, the goto stands at the spent terminal.
    await tap(page, 'surface-goto-puzzle');
    await expect(page.locator('[data-testid="hud-interact"]')).toContainText('Unlocked', SLOW);
    await press(page, 'KeyE');
    await frames(page, 10);
    await expect(page.locator('[data-testid="puzzle-panel"]')).toHaveCount(0);
    expect((await info(page))['held']).toBe(0);
    expect((await info(page))['puzzle']).toBe('-');
  });

  // §4.10: a world puzzle's pieces stay inside SPEC-054's budget below on medium
  // — the plates and their glyphs on Cinder-4, the mirrors, lens, receiver and
  // a lit beam on Vetra and in Eden's machine room — with the vault terminal
  // standing by its door.
  for (const planet of ['cinder4', 'vetra', 'eden'] as const) {
    test(`§4.10: ${planet} below on medium, its world puzzle drawn, stays in SPEC-054's budget`, async ({ page }) => {
      await start(page, `/?scene=surface&planet=${planet}&debug&quality=medium`);
      await dismiss(page);
      await descend(page);
      await frames(page, 30);
      const stats = await page.evaluate(() => window.__reallm.stats());
      expect(stats.drawCalls).toBeLessThanOrEqual(96);
      expect(stats.triangles).toBeLessThanOrEqual(130_000);
      expect(String((await info(page))['puzzleHint'])).toMatch(planet === 'cinder4' ? /^plate:\d$/ : /^mirror:\d$/);
    });
  }

  test('10: the keys — the arrows move the roving focus, Enter turns the focused cell', async ({ page }) => {
    await start(page, '/?debug');
    await land(page, 'cinder4');
    await descend(page);
    await openVault(page);
    const focused = (): Promise<string | null> => page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? null);
    expect(await focused()).toBe('puzzle-cell-0-0');
    await page.keyboard.press('ArrowRight');
    expect(await focused()).toBe('puzzle-cell-0-1');
    await page.keyboard.press('ArrowLeft');
    expect(await focused()).toBe('puzzle-cell-0-0');
    const hint = String((await info(page))['puzzleHint']);
    expect(hint).toMatch(/^cell:\d+$/);
    const cell = Number(hint.slice('cell:'.length));
    for (let r = 0; r < Math.floor(cell / 4); r++) await page.keyboard.press('ArrowDown');
    for (let c = 0; c < cell % 4; c++) await page.keyboard.press('ArrowRight');
    expect(await focused()).toBe(`puzzle-cell-${Math.floor(cell / 4)}-${cell % 4}`);
    expect((await info(page))['puzzleMoves']).toBe(0);
    await page.keyboard.press('Enter');
    await untilInfo(page, 'puzzleMoves', 1);
    expect(await focused()).toBe(`puzzle-cell-${Math.floor(cell / 4)}-${cell % 4}`);
    // H asks for a hint: one outlined cell.
    await page.keyboard.press('KeyH');
    await untilInfo(page, 'puzzleHints', 1);
    await expect(page.locator('[data-testid^="puzzle-cell-"].is-hinted')).toHaveCount(1);
  });
});
