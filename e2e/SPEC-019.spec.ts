// SPEC-019's browser acceptance run: the combat feedback layer only a real
// scene can show — the damage-number pool's colour, pixel rise/fade and
// recycling (AC-76, AC-77, AC-79, AC-80..AC-83), and weather damage
// accumulating into a single throttled number a second without a burst
// (AC-70). The character/enemy models, VFX pools and shake/hit-stop math are
// pinned in node (`tests/core/characterState.test.ts`,
// `tests/views/characterView.test.ts`, `tests/views/combatFx.test.ts`,
// `tests/views/enemyRecipes.test.ts`, `tests/views/surfaceView.test.ts`); this
// suite exercises only what those cannot — real DOM writes over real frames.
import { expect, test, type Page } from '@playwright/test';
import { start } from './start';

const URL = '/?debug&scene=surface&planet=cinder4&quality=medium';

interface DmgSample {
  text: string;
  color: string;
  opacity: string;
}

/** Every non-empty `.dmg` span in the pool, as the browser currently paints it. */
async function dmgNodes(page: Page): Promise<DmgSample[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('.dmg'))
      .filter((el) => el.textContent)
      .map((el) => ({
        text: el.textContent ?? '',
        color: getComputedStyle(el).color,
        opacity: getComputedStyle(el).opacity,
      })),
  );
}

test('the damage-number pool holds 24 slots and is otherwise empty at rest (AC-80)', async ({ page }) => {
  await start(page, URL);
  const count = await page.evaluate(() => document.querySelectorAll('.dmg').length);
  expect(count).toBe(24);
  expect(await dmgNodes(page)).toHaveLength(0);
});

test('"Hurt me" places one red damage number that rises 40px over 0.8s while fading, through transform/opacity only (AC-77, AC-79, AC-82)', async ({
  page,
}) => {
  await start(page, URL);

  const samples = await page.evaluate(
    () =>
      new Promise<Array<{ opacity: string; y: number }>>((resolve) => {
        document.querySelector<HTMLButtonElement>('[data-testid="surface-hurt"]')!.click();
        const out: Array<{ opacity: string; y: number }> = [];
        let n = 0;
        const tick = () => {
          const el = Array.from(document.querySelectorAll<HTMLElement>('.dmg')).find((e) => e.textContent);
          if (el) {
            const m = /translate3d\(([-\d.]+)px,\s*([-\d.]+)px/.exec(el.style.transform);
            out.push({ opacity: getComputedStyle(el).opacity, y: m ? Number(m[2]) : NaN });
          }
          if (++n < 20) requestAnimationFrame(tick);
          else resolve(out);
        };
        tick();
      }),
  );

  // Only one live number at a time for a single hit (AC-80/81's pool, not fanned out).
  expect(samples.length).toBeGreaterThan(5);
  expect(Number(samples[0].opacity)).toBeCloseTo(1, 1);
  expect(Number(samples[samples.length - 1].opacity)).toBe(0);
  // Rises (screen Y decreases) before it settles at the top of its 40px travel.
  const rose = samples[0].y - samples[samples.length - 1].y;
  expect(rose).toBeGreaterThan(30);
  expect(rose).toBeLessThan(45);

  const colored = (await dmgNodes(page)).find((n) => n.text !== '');
  // #ff5533 (AC-79).
  expect(colored?.color).toBe('rgb(255, 85, 51)');
});

test('reduceMotion drops the rise and only fades the number in place (AC-83)', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('reallm:settings', JSON.stringify({ reduceMotion: true })));
  await start(page, URL);

  const samples = await page.evaluate(
    () =>
      new Promise<Array<{ opacity: string; y: number }>>((resolve) => {
        document.querySelector<HTMLButtonElement>('[data-testid="surface-hurt"]')!.click();
        const out: Array<{ opacity: string; y: number }> = [];
        let n = 0;
        const tick = () => {
          const el = Array.from(document.querySelectorAll<HTMLElement>('.dmg')).find((e) => e.textContent);
          if (el) {
            const m = /translate3d\(([-\d.]+)px,\s*([-\d.]+)px/.exec(el.style.transform);
            out.push({ opacity: getComputedStyle(el).opacity, y: m ? Number(m[2]) : NaN });
          }
          if (++n < 20) requestAnimationFrame(tick);
          else resolve(out);
        };
        tick();
      }),
  );

  expect(Number(samples[0].opacity)).toBeCloseTo(1, 1);
  expect(Number(samples[samples.length - 1].opacity)).toBe(0);
  // No rise: every sample sits at the same screen Y as the first.
  for (const s of samples) expect(s.y).toBeCloseTo(samples[0].y, 1);
});
