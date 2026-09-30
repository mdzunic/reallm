// SPEC-016 §12.2 — the perf run in a real browser: the stressed surface run and
// what it prints, shows and leaves behind; another scene measured as it
// stands; the row and its copy; an interrupted run; the bridge; and the budget
// marks on `medium`.
//
// The pure half — the flag, the summary, the row, the budgets and the clock —
// is pinned in node (`tests/core/perf.test.ts`, `tests/core/flags.test.ts`).
// Mechanics per D-31: pages open through `gameUrl` and `passGate`, so `low` and
// films off unless the URL says otherwise; the console is collected from before
// `goto`, and a `[perf]` line is one whose text starts with `[perf] `.
import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';
import { COLD_START, gameUrl, passGate, setHidden, type PerfSnapshot } from './start';

/** D-31: the card shows within this long of the gate — 5 s of warm-up, the run, and the scene's own load. */
const CARD_MS = 40_000;
/** Case 2's run: long enough for auto-fire's first kill on a loaded container (see that test). */
const CASE_2_SECONDS = 15;
const PERF_PREFIX = '[perf] ';

const card = (page: Page) => page.locator('[data-testid="perf-result"]');
const row = (page: Page) => page.locator('[data-testid="perf-row"]');
const measure = (page: Page, name: string) => page.locator(`[data-testid="perf-result"] [data-measure="${name}"]`);

/** Every `[perf]` line the page logs, from before `goto` on (D-31). */
function collectPerfLines(page: Page): string[] {
  const lines: string[] = [];
  page.on('console', (message: ConsoleMessage) => {
    const text = message.text();
    if (text.startsWith(PERF_PREFIX)) lines.push(text);
  });
  return lines;
}

function parseLine(line: string): PerfSnapshot {
  return JSON.parse(line.slice(PERF_PREFIX.length)) as PerfSnapshot;
}

const perf = (page: Page): Promise<PerfSnapshot | null> => page.evaluate(() => window.__reallm.perf());
const scene = (page: Page): Promise<string | null> => page.evaluate(() => window.__reallm.scene());

/** What is left of the card's 40 s once the scene is up. */
const cardTimeout = (gateAt: number): number => Math.max(1, gateAt + CARD_MS - Date.now());

async function open(page: Page, url: string): Promise<void> {
  await page.goto(gameUrl(url));
  await passGate(page);
}

test.describe('SPEC-016 §8 — the perf run', () => {
  test('the surface run: the line, the card, the row and the bridge (cases 1, 4, 6)', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const lines = collectPerfLines(page);
    await open(page, '/?perf=5&planet=cinder4');
    const gateAt = Date.now();

    await test.step('case 1: the target is the surface, and nothing has ended yet', async () => {
      await expect.poll(() => scene(page), COLD_START).toBe('surface');
      expect(await perf(page)).toBeNull();
      await expect(card(page)).toBeVisible({ timeout: cardTimeout(gateAt) });
    });

    let result: PerfSnapshot;
    await test.step('case 1: one [perf] line, and the card and the bridge say the same', async () => {
      await expect.poll(() => lines.length).toBe(1);
      result = parseLine(lines[0] as string);
      expect(result).toMatchObject({
        scene: 'surface',
        planet: 'cinder4',
        preset: 'low',
        storm: 'sandstorm',
        interrupted: false,
        seconds: 5,
        // low's 12 live enemies plus the wave ceiling's 8.
        enemyCeiling: 20,
      });
      expect(result.frames).toBeGreaterThan(0);
      expect(result.fps).toBeGreaterThan(0);
      expect(result.drawCalls).toBeGreaterThan(0);
      expect(result.triangles).toBeGreaterThan(0);
      expect(result.enemies).toBeGreaterThanOrEqual(result.enemyCeiling - 2);
      expect(result.enemies).toBeLessThanOrEqual(result.enemyCeiling);
      expect(await perf(page)).toEqual(result);
      await expect(row(page)).toContainText(result.fps.toFixed(1));
      // D-19: the governor held, so the row measured the preset it names.
      expect(await page.evaluate(() => window.__reallm.stats().adaptSteps)).toBe(0);
    });

    await test.step('case 7: on low, no line is judged against a budget', async () => {
      await expect(measure(page, 'draws')).toBeVisible();
      await expect(page.locator('[data-testid="perf-result"] [data-verdict]')).toHaveCount(0);
    });

    await test.step('case 4: the row, and its copy', async () => {
      const text = (await row(page).textContent()) ?? '';
      expect(text.startsWith('| ')).toBe(true);
      expect(text).toContain('surface/cinder4');
      expect(text).toContain('| low |');
      await page.locator('[data-testid="perf-copy"]').click();
      // 16-i: on the clipboard, or — where it is refused — selected on the page.
      await expect
        .poll(async () =>
          page.evaluate(async (want) => {
            const selected = globalThis.getSelection()?.toString() ?? '';
            if (selected === want) return true;
            try {
              return (await navigator.clipboard.readText()) === want;
            } catch {
              return false;
            }
          }, text),
        )
        .toBe(true);
    });

    await test.step('case 6: closing the card leaves the result on the bridge', async () => {
      await page.locator('[data-testid="perf-close"]').click();
      await expect(card(page)).toHaveCount(0);
      expect(await perf(page)).toEqual(result);
      expect(lines).toHaveLength(1);
    });
  });

  // D-31 lets case 2 share case 1's page; it loads its own, with a longer run.
  // The run's seconds are wall-clock (D-17), and on a loaded software-GL
  // container the fixed-step loop falls to a quarter of real time (E23), so
  // case 1's 5 s can end before auto-fire has had the game time to finish its
  // first kill. 15 s leaves it four seconds of game time even there.
  test('alive, firing and unsaved while the stress runs (case 2)', async ({ page }) => {
    await open(page, `/?perf=${CASE_2_SECONDS}&planet=cinder4`);
    const settingsAfterGate = await page.evaluate(() => localStorage.getItem('reallm:settings'));
    const deadline = Date.now() + CARD_MS;

    let killsAtEntry: number | null = null;
    await test.step('never dead, and never moved once the stress holds the player, checked every 500 ms', async () => {
      // §8.2: once the stress has started — it forces the sandstorm, and the
      // first landing holds the ambient cycle calm, so an active storm is the
      // stress's — the player stays where they stood until the run ends. Read
      // in one task, so the card and the position cannot straddle the run's
      // last frame.
      let held: string | null = null;
      for (;;) {
        const now = await page.evaluate(() => {
          const info = window.__reallm.stats().sceneInfo ?? {};
          return {
            scene: window.__reallm.scene(),
            card: document.querySelector('[data-testid="perf-result"]') !== null,
            kills: Number(info['kills'] ?? 0),
            stressed: info['weatherPhase'] === 'active',
            at: `${String(info['px'])},${String(info['pz'])}`,
          };
        });
        if (now.scene === 'surface') killsAtEntry ??= now.kills;
        if (now.card) break;
        if (now.scene === 'surface' && now.stressed) held ??= now.at;
        if (held !== null) expect(now.at, 'the stress never moves the player').toBe(held);
        expect(await page.locator('[data-testid="death-overlay"]').isVisible(), 'the death overlay').toBe(false);
        expect(Date.now(), 'the card within 40 s of the gate').toBeLessThan(deadline);
        await page.waitForTimeout(500);
      }
      expect(killsAtEntry, 'the surface was entered before the card').not.toBeNull();
      expect(held, 'the stress started before the card').not.toBeNull();
      expect(await page.locator('[data-testid="death-overlay"]').isVisible(), 'the death overlay').toBe(false);
    });

    await test.step('auto-fire killed something', async () => {
      const killsAtCard = await page.evaluate(() => Number(window.__reallm.stats().sceneInfo?.['kills'] ?? 0));
      expect(killsAtCard).toBeGreaterThan(killsAtEntry as number);
    });

    await test.step('no save slot, the settings as the gate left them, and no tip recorded', async () => {
      const storage = await page.evaluate(() => {
        const keys: string[] = [];
        for (let i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i) as string);
        return { keys, settings: localStorage.getItem('reallm:settings') };
      });
      expect(storage.keys.filter((key) => key.startsWith('reallm:slot:'))).toEqual([]);
      expect(storage.settings).toBe(settingsAfterGate);
      if (storage.settings !== null) {
        const stored = JSON.parse(storage.settings) as { tipsSeen?: unknown[] };
        expect(stored.tipsSeen ?? []).toEqual([]);
      }
    });
  });

  test('another scene is measured as it stands (case 3)', async ({ page }) => {
    const lines = collectPerfLines(page);
    await open(page, '/?perf=5&scene=station');
    const gateAt = Date.now();
    await expect.poll(() => scene(page), COLD_START).toBe('station');
    await expect(card(page)).toBeVisible({ timeout: cardTimeout(gateAt) });
    const result = await perf(page);
    expect(result).toMatchObject({ scene: 'station', planet: null, enemies: 0, enemyCeiling: 0, storm: null, interrupted: false });
    expect(lines).toHaveLength(1);
    await expect(row(page)).toContainText('| station |');
  });

  test('a hidden page ends the run at once, as interrupted (case 5)', async ({ page }) => {
    const lines = collectPerfLines(page);
    await open(page, '/?perf=30&planet=cinder4');
    await expect.poll(() => scene(page), COLD_START).toBe('surface');
    await page.waitForTimeout(7_000);
    try {
      await setHidden(page, true);
      await expect(card(page)).toContainText('Interrupted — run again', { timeout: 5_000 });
      const result = await perf(page);
      expect(result?.interrupted).toBe(true);
      await expect.poll(() => lines.length).toBe(1);
      const logged = parseLine(lines[0] as string);
      expect(logged.interrupted).toBe(true);
      expect(logged.frames).toBe(0);
      // No medians on the card: the row, the copy and the close are all that is left.
      await expect(page.locator('[data-testid="perf-result"] [data-measure]')).toHaveCount(0);
      await expect(row(page)).toContainText('| interrupted |');
      await expect(page.locator('[data-testid="perf-copy"]')).toBeVisible();
      await expect(page.locator('[data-testid="perf-close"]')).toBeVisible();
    } finally {
      await setHidden(page, false);
    }
  });

  test('on medium the budgeted lines carry their verdict (case 7)', async ({ page }) => {
    await open(page, '/?perf=5&scene=station&quality=medium');
    const gateAt = Date.now();
    await expect.poll(() => scene(page), COLD_START).toBe('station');
    await expect(card(page)).toBeVisible({ timeout: cardTimeout(gateAt) });
    const result = await perf(page);
    // D-19: however slow this machine draws `medium`, the governor never stepped it down.
    expect(result?.preset).toBe('medium');
    expect(await page.evaluate(() => window.__reallm.stats().adaptSteps)).toBe(0);
    for (const name of ['draws', 'triangles', 'render']) {
      const line = measure(page, name);
      await expect(line, name).toHaveAttribute('data-verdict', /^(pass|fail)$/);
      await expect(line, name).toContainText(/[✓✗]/);
    }
    // SPEC-015 §5 budgets no update time on the station.
    await expect(measure(page, 'update')).not.toHaveAttribute('data-verdict');
    // 16-h: a heap is judged only where the browser reports one.
    if (result?.heapMb === null) await expect(measure(page, 'heap')).not.toHaveAttribute('data-verdict');
    else await expect(measure(page, 'heap')).toHaveAttribute('data-verdict', /^(pass|fail)$/);
  });
});
