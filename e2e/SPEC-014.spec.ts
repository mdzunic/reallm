// SPEC-014 §4.4: the star map's touch targets are DOM buttons projected over
// the Three spheres. The projection runs in `onEnter()`, *before* the scene's
// first render — a stale `camera.matrixWorldInverse` once put every button
// thousands of pixels off-screen while the spheres drew correctly underneath,
// so this suite pins the part no other test touches: the buttons land inside
// the viewport immediately on entry, and clicking one actually selects it
// (AC-50, AC-52, AC-53).
import { expect, test, type Page } from '@playwright/test';
import { start } from './start';

const PLANETS = ['cinder4', 'vetra', 'thessaly', 'ferrum', 'hive', 'eden'];

const CREATION = {
  name: 'Vance',
  classId: 'marine',
  appearance: { portrait: 1, primary: '#b7472a', secondary: '#2a3b4c' },
  attributes: { might: 6, vigor: 5, agility: 1, tech: 1 },
  difficulty: 'normal',
} as const;

/** One transition, plus the frame that actually draws the scene we landed in. */
async function go(page: Page, id: string, params: unknown = {}): Promise<boolean> {
  return page.evaluate(
    async ({ id, params }) => {
      const ok = await window.__reallm.go(id, params);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      return ok;
    },
    { id, params },
  );
}

test.describe('star map nodes', () => {
  // 0 ms fades (D-16); node placement is JS projection, not CSS motion.
  test.use({ reducedMotion: 'reduce' });

  test('all six node buttons land inside the viewport on entry (AC-50, AC-52)', async ({ page }) => {
    await start(page);
    expect(await go(page, 'station', {})).toBe(true);
    expect(await go(page, 'starmap', undefined)).toBe(true);

    const viewport = page.viewportSize();
    if (!viewport) throw new Error('viewport size unavailable');
    for (const planet of PLANETS) {
      const node = page.locator(`[data-testid="map-node-${planet}"]`);
      await expect(node).toBeVisible();
      const box = await node.boundingBox();
      if (!box) throw new Error(`map-node-${planet} has no box`);
      // Inside the viewport — not at the projection of a stale view matrix.
      expect(box.x, `${planet} left`).toBeGreaterThanOrEqual(0);
      expect(box.y, `${planet} top`).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, `${planet} right`).toBeLessThanOrEqual(viewport.width);
      expect(box.y + box.height, `${planet} bottom`).toBeLessThanOrEqual(viewport.height);
    }
  });

  test('tapping a node selects it and the info panel follows (AC-52, AC-53)', async ({ page }) => {
    await start(page);
    expect(await go(page, 'station', {})).toBe(true);
    expect(await go(page, 'starmap', undefined)).toBe(true);

    // Cinder-4 is the default selection; Vetra is a click away.
    await expect(page.locator('[data-testid="map-node-cinder4"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-testid="starmap-info-name"]')).toHaveText('Cinder-4');

    await page.locator('[data-testid="map-node-vetra"]').click();
    await expect(page.locator('[data-testid="map-node-vetra"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-testid="map-node-cinder4"]')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('[data-testid="starmap-info-name"]')).toHaveText('Vetra');
  });
});

test.describe('depart confirm sheet', () => {
  test.use({ reducedMotion: 'reduce' });

  test('a triple-tap on the sheet charges fuel exactly once (AC-56)', async ({ page }) => {
    await start(page);
    await page.evaluate((creation) => {
      const data = window.__reallm.save().create(0, creation);
      // A fresh save's 60 oil covers one trip; the bug needs room for three.
      data.resources['oil'] = 200;
    }, CREATION);
    expect(await go(page, 'station', {})).toBe(true);
    expect(await go(page, 'starmap', undefined)).toBe(true);

    // Fuel and oil exactly as the info panel states them (AC-53).
    const fuelLine = await page.locator('[data-testid="starmap-fuel"]').textContent();
    const stated = /Fuel: (\d+) oil \(have (\d+)\)/.exec(fuelLine ?? '');
    if (!stated) throw new Error(`unexpected fuel line: ${fuelLine ?? 'null'}`);
    const fuel = Number(stated[1]);
    const oil = Number(stated[2]);
    expect(fuel).toBeGreaterThan(0);
    expect(oil).toBeGreaterThanOrEqual(3 * fuel); // the bug needs room to triple-charge

    await page.locator('[data-testid="starmap-depart"]').click();
    await expect(page.locator('[data-testid="confirm-yes"]')).toBeVisible();
    // Three synchronous taps on the same button. The second and third land on a
    // detached-but-listening node — exactly how a fast double-tap once re-ran
    // `payFuel` through the sheet's confirm callback and drained oil 3×.
    await page.evaluate(() => {
      const yes = document.querySelector('[data-testid="confirm-yes"]');
      if (!(yes instanceof HTMLButtonElement)) throw new Error('confirm button missing');
      yes.click();
      yes.click();
      yes.click();
    });

    await expect(page.locator('[data-testid="scene-label"]')).toHaveText('flight');
    const after = await page.evaluate(() => window.__reallm.save().current?.resources['oil']);
    expect(after).toBe(oil - fuel);
  });
});

test.describe('the toast layer', () => {
  // The rack is the one piece of UI every system talks to, and the only path a
  // browser has to two of its four kinds is the DEV bridge (SPEC-014 §4.6).
  test.use({ reducedMotion: 'reduce' });

  test('all four kinds render, and warn carries the ▲ of its colourblind pair (AC-68, AC-79)', async ({
    page,
  }) => {
    await start(page);
    // Long-lived so the assertions are not racing the 2.5 s default.
    await page.evaluate(() => {
      window.__reallm.toast('Cargo full', 'warn', 60_000);
      window.__reallm.toast('Level up', 'good', 60_000);
      window.__reallm.toast('Not enough tokens', 'error', 60_000);
    });
    const rack = page.locator('.toast-rack');
    await expect(rack.locator('.toast')).toHaveCount(3);

    const warn = rack.locator('.toast-warn');
    // Amber alone is the thing AC-68 forbids: the glyph is the other half.
    await expect(warn.locator('.glyph')).toHaveText('▲');
    await expect(warn).toHaveCSS('border-color', 'rgb(245, 166, 35)');
    await expect(rack.locator('.toast-good')).toHaveCSS('border-color', 'rgb(70, 201, 115)');
    await expect(rack.locator('.toast-error')).toHaveCSS('border-color', 'rgb(229, 72, 77)');

    // The fourth kind, and the cap: a fourth toast evicts the oldest (AC-78).
    await page.evaluate(() => window.__reallm.toast('Docking subsidy logged', 'info', 60_000));
    await expect(rack.locator('.toast')).toHaveCount(3);
    await expect(rack.locator('.toast-info')).toHaveCount(1);
    await expect(rack.locator('.toast-warn')).toHaveCount(0); // the oldest went
  });

  test('identical text inside the window coalesces behind a counter (AC-80)', async ({ page }) => {
    await start(page);
    const rack = page.locator('.toast-rack');
    // One raise per assertion so the coalescing window is never the variable.
    await page.evaluate(() => window.__reallm.toast('Cargo full', 'warn', 60_000));
    await expect(rack.locator('.toast')).toHaveCount(1);
    await expect(rack.locator('.toast-warn')).toHaveText('▲Cargo full');

    await page.evaluate(() => window.__reallm.toast('Cargo full', 'warn', 60_000));
    await expect(rack.locator('.toast')).toHaveCount(1);
    await expect(rack.locator('.toast-warn')).toHaveText('▲Cargo full×2');

    await page.evaluate(() => window.__reallm.toast('Cargo full', 'warn', 60_000));
    await expect(rack.locator('.toast')).toHaveCount(1);
    await expect(rack.locator('.toast-warn')).toHaveText('▲Cargo full×3');

    // A different text is a different toast, not a fourth tick of the counter.
    await page.evaluate(() => window.__reallm.toast('Hold is heavy', 'warn', 60_000));
    await expect(rack.locator('.toast')).toHaveCount(2);
  });
});

test.describe('the purchase confirm sheet', () => {
  test.use({ reducedMotion: 'reduce' });

  test('re-validates on confirm and stays open when the tokens have gone (AC-43, AC-44)', async ({
    page,
  }) => {
    await start(page);
    await page.evaluate((creation) => {
      const data = window.__reallm.save().create(0, creation);
      data.player.tokens = 500;
    }, CREATION);
    expect(await go(page, 'station', {})).toBe(true);
    await page.locator('[data-testid="station-tab-shop"]').click();

    await page.locator('[data-testid="shop-ship-hull-buy"]').click();
    const sheet = page.locator('.sheet-backdrop');
    // The AC's own shape: what, which tier, and what it costs (AC-43).
    await expect(sheet).toContainText(/Buy Hull Tier 1 for \d+ tokens\?/);
    await expect(page.locator('[data-testid="confirm-no"]')).toBeVisible();

    // The tokens leave while the sheet is open — the case a stale render misses.
    await page.evaluate(() => {
      const data = window.__reallm.save().current;
      if (!data) throw new Error('no save bound');
      data.player.tokens = 1;
    });
    await page.locator('[data-testid="confirm-yes"]').click();

    await expect(page.locator('.toast-error')).toHaveText('Not enough tokens');
    await expect(sheet).toBeVisible(); // it does not close on a refusal
    expect(await page.evaluate(() => window.__reallm.save().current?.ship['hull'])).toBe(0);

    // With the tokens back, the same sheet completes the purchase.
    await page.evaluate(() => {
      const data = window.__reallm.save().current;
      if (!data) throw new Error('no save bound');
      data.player.tokens = 500;
    });
    await page.locator('[data-testid="confirm-yes"]').click();
    await expect(sheet).toBeHidden();
    expect(await page.evaluate(() => window.__reallm.save().current?.ship['hull'])).toBe(1);
  });
});

test.describe('the pause menu', () => {
  test.use({ reducedMotion: 'reduce' });

  test('Escape and P both raise the same four entries (AC-81, AC-82)', async ({ page }) => {
    await start(page);
    await page.evaluate((creation) => window.__reallm.save().create(0, creation), CREATION);
    // The graph runs menu → station ↔ starmap → flight → surface (SPEC-003 §3).
    expect(await go(page, 'station', {})).toBe(true);
    expect(await go(page, 'starmap', undefined)).toBe(true);
    expect(await go(page, 'flight', { destination: 'cinder4' })).toBe(true);
    expect(await go(page, 'surface', { planet: 'cinder4' })).toBe(true);

    const pause = page.locator('.overlay-pause');
    await expect(pause).toBeHidden();

    await page.keyboard.press('Escape');
    await expect(pause).toBeVisible();
    for (const id of ['pause-resume', 'pause-settings', 'pause-controls', 'pause-quit']) {
      const entry = page.locator(`[data-testid="${id}"]`);
      await expect(entry).toBeVisible();
      const box = await entry.boundingBox();
      if (!box) throw new Error(`${id} has no box`);
      expect(box.height, `${id} touch target`).toBeGreaterThanOrEqual(44); // AC-108
    }

    await page.keyboard.press('Escape');
    await expect(pause).toBeHidden();
    await page.keyboard.press('p');
    await expect(pause).toBeVisible();
  });
});

test.describe('the batched HUD', () => {
  test.use({ reducedMotion: 'reduce' });

  test('an unchanged model writes nothing to the DOM (AC-61, AC-62)', async ({ page }) => {
    await start(page);
    await page.evaluate((creation) => window.__reallm.save().create(0, creation), CREATION);
    // The flight placeholder holds a still HUD: nothing feeds the model, so
    // every flush of it must diff to the empty set. Reached the way the graph
    // allows — menu → station → starmap → flight (SPEC-003 §3).
    expect(await go(page, 'station', {})).toBe(true);
    expect(await go(page, 'starmap', undefined)).toBe(true);
    expect(await go(page, 'flight', { destination: 'cinder4' })).toBe(true);
    await expect(page.locator('.hud-tl')).toBeVisible();

    // Bars are scaled, never re-laid-out: a width write would show up here as a
    // changing computed width instead of a changing matrix (AC-61).
    const bar = page.locator('.hud-tl .bar-hp');
    await expect(bar).toHaveCSS('transform', /^matrix\(/);

    const mutations = await page.evaluate(async () => {
      const root = document.querySelector('.hud-tl');
      if (!root) throw new Error('no HUD');
      let count = 0;
      const observer = new MutationObserver((records) => {
        count += records.length;
      });
      observer.observe(root, { subtree: true, attributes: true, characterData: true, childList: true });
      const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
      // The scene's own first paint is a write; under load it can land after the
      // entry await. Let the HUD settle first, then hold it to the contract.
      for (let i = 0; i < 25 && count > 0; i++) {
        count = 0;
        await sleep(200);
      }
      count = 0;
      await sleep(1000); // ~60 flushes of an unchanged model
      observer.disconnect();
      return count;
    });
    expect(mutations).toBe(0);
  });
});

test.describe('reduce motion', () => {
  test('the in-app toggle drives html.reduce-motion both ways (AC-88, AC-110)', async ({ page }) => {
    await start(page);
    // Playwright's default is no OS preference, so the setting starts off.
    await expect(page.locator('html')).not.toHaveClass(/reduce-motion/);

    await page.locator('[data-testid="menu-settings"]').click();
    const toggle = page.locator('[data-testid="settings-reduce-motion"]');
    await expect(toggle).not.toBeChecked();
    await toggle.check();
    await expect(page.locator('html')).toHaveClass(/reduce-motion/);

    // Not just a class: an animated affordance actually goes static (AC-66).
    await page.evaluate(() => {
      const probe = document.createElement('div');
      probe.className = 'toast toast-info';
      probe.dataset['testid'] = 'motion-probe';
      probe.textContent = 'probe';
      document.getElementById('ui')?.append(probe);
    });
    const animation = await page.evaluate(
      () => getComputedStyle(document.querySelector('[data-testid="motion-probe"]')!).animationName,
    );
    expect(animation).toBe('none');

    await toggle.uncheck();
    await expect(page.locator('html')).not.toHaveClass(/reduce-motion/);
  });

  test.describe('with the OS preference set', () => {
    test.use({ reducedMotion: 'reduce' });

    test('prefers-reduced-motion arrives through the same class (AC-110)', async ({ page }) => {
      await start(page);
      await expect(page.locator('html')).toHaveClass(/reduce-motion/);
    });
  });
});
