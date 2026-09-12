// SPEC-020 §4.5–§4.9 — the parts of the dressing pass a browser is the only
// witness to: the dark sci-fi theme's eight tokens actually reaching the
// panels, the contrast of real glyphs over the new translucent glass, the
// touch/font floors the restyle promised not to move, and the portrait images
// with their glyph fallback.
//
// The flight half of the spec (the budget, the storm tint, the art-missing
// fallback) lives in `e2e/flight-env.spec.ts`; this suite deliberately does not
// repeat it.
import { expect, test, type Page } from '@playwright/test';
import { start } from './start';

/** The eight tokens SPEC-020 AC-22 adds to `:root`. */
const TOKENS = [
  '--panel-glass',
  '--edge-glow',
  '--accent',
  '--accent-2',
  '--bar-hp',
  '--bar-shield',
  '--bar-xp',
  '--text-glow',
] as const;

const CREATION = {
  name: 'Vance',
  classId: 'marine',
  appearance: { portrait: 1, primary: '#b7472a', secondary: '#2a3b4c' },
  attributes: { might: 6, vigor: 5, agility: 1, tech: 1 },
  difficulty: 'normal',
} as const;

/** Every rule text of every same-origin stylesheet, concatenated. */
async function styleSheetText(page: Page): Promise<string> {
  return page.evaluate(() => {
    let css = '';
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        for (const rule of Array.from(sheet.cssRules)) css += `${rule.cssText}\n`;
      } catch {
        // a cross-origin sheet the game never loads; nothing to read
      }
    }
    return css;
  });
}

/**
 * The WCAG contrast of the brightest pixel in `box` (the glyph core) against
 * the median pixel of the same box (the panel showing through behind it).
 * Measured from the composited frame, so the 3D scene behind the glass counts.
 */
async function measuredContrast(page: Page, box: { x: number; y: number; width: number; height: number }): Promise<number> {
  const png = (await page.screenshot({ clip: box, type: 'png' })).toString('base64');
  return page.evaluate(async (data) => {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = `data:image/png;base64,${data}`;
    });
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
    ctx.drawImage(img, 0, 0);
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const channel = (value: number): number => {
      const v = value / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    const luminances: number[] = [];
    for (let i = 0; i < pixels.length; i += 4) {
      luminances.push(
        0.2126 * channel(pixels[i] as number) + 0.7152 * channel(pixels[i + 1] as number) + 0.0722 * channel(pixels[i + 2] as number),
      );
    }
    luminances.sort((a, b) => a - b);
    const text = luminances[luminances.length - 1] as number;
    const background = luminances[Math.floor(luminances.length * 0.4)] as number;
    return (Math.max(text, background) + 0.05) / (Math.min(text, background) + 0.05);
  }, png);
}

/**
 * Walks to the station with a real save, past the arrival dialogue. The preset
 * is pinned: `html.quality-low` deliberately swaps the glass for the opaque
 * `--panel` (§4.6, 20-a), so a machine that benchmarks into `low` would measure
 * a different panel than the one AC-23 and AC-24 are about.
 */
async function stationWithSave(page: Page, quality = 'medium'): Promise<void> {
  await start(page, `/?debug&scene=station&quality=${quality}`);
  await page.evaluate((creation) => window.__reallm.save().create(0, creation), CREATION);
  await page.evaluate(() => window.__reallm.go('station', {}, { force: true }));
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('station');
  // The arrival dialogue covers the tabs; click it away if it is up.
  for (let i = 0; i < 12; i++) {
    if ((await page.locator('.dialogue-dim.is-visible').count()) === 0) break;
    await page.locator('.dialogue-dim.is-visible').click({ force: true });
    await page.waitForTimeout(150);
  }
}

test('the eight theme tokens are declared once on :root and each one is used (AC-22, AC-27)', async ({ page }) => {
  await start(page, '/?debug&scene=station');
  const css = await styleSheetText(page);
  for (const token of TOKENS) {
    const declarations = css.match(new RegExp(`\\${token}\\s*:`, 'g')) ?? [];
    const references = css.match(new RegExp(`var\\(\\s*\\${token}`, 'g')) ?? [];
    expect(declarations, `${token} is declared exactly once`).toHaveLength(1);
    expect(references.length, `${token} is referenced at least once`).toBeGreaterThan(0);
    const value = await page.evaluate((name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim(), token);
    expect(value, `${token} resolves on :root`).not.toBe('');
  }
});

test('the panels and buttons wear the new tokens (AC-23)', async ({ page }) => {
  await stationWithSave(page);
  const styled = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const glass = root.getPropertyValue('--panel-glass').trim().replace(/\s+/g, '');
    const accent = root.getPropertyValue('--accent').trim();
    const panel = document.querySelector('.station-panel') as HTMLElement | null;
    const button = document.querySelector('.ui-btn') as HTMLElement | null;
    const hex = (value: string): string => {
      const m = value.match(/#([0-9a-f]{6})/i);
      if (!m) return value;
      const n = parseInt(m[1] as string, 16);
      return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
    };
    const panelStyle = panel ? getComputedStyle(panel) : null;
    const buttonStyle = button ? getComputedStyle(button) : null;
    return {
      panelBackground: panelStyle ? panelStyle.backgroundColor.replace(/\s+/g, '') : null,
      glass,
      panelShadow: panelStyle ? panelStyle.boxShadow : null,
      buttonText: buttonStyle ? buttonStyle.color : null,
      buttonBorder: buttonStyle ? buttonStyle.borderTopColor : null,
      accentRgb: hex(accent),
      edgeGlowRgb: root.getPropertyValue('--edge-glow').trim(),
      buttonMinHeight: buttonStyle ? buttonStyle.minHeight : null,
    };
  });
  // the panel is the glass token itself, not an opaque colour of its own
  expect(styled.panelBackground).toBe(styled.glass);
  // and it carries the edge glow the theme promised
  expect(styled.panelShadow).toContain(styled.edgeGlowRgb);
  // the buttons are accent-tinted, and no smaller than they were
  expect(styled.buttonBorder).toBe(styled.accentRgb);
  expect(styled.buttonMinHeight).toBe('44px');

  // On `low` the same panel keeps the theme but drops the blur for the opaque
  // token, which is the documented 20-a fallback rather than a missed restyle.
  await stationWithSave(page, 'low');
  const lowPanel = await page.evaluate(() => {
    const panel = document.querySelector('.station-panel') as HTMLElement;
    const style = getComputedStyle(panel);
    return {
      background: style.backgroundColor.replace(/\s+/g, ''),
      opaque: getComputedStyle(document.documentElement).getPropertyValue('--panel').trim(),
      shadow: style.boxShadow,
      classed: document.documentElement.classList.contains('quality-low'),
    };
  });
  expect(lowPanel.classed).toBe(true);
  expect(lowPanel.background).toBe('rgb(17,24,32)');
  expect(lowPanel.opaque).toBe('#111820');
  expect(lowPanel.shadow).toContain(styled.edgeGlowRgb);
});

test('body text keeps 4.5:1 against the glass it is drawn on (AC-24)', async ({ page }) => {
  await stationWithSave(page);
  await page.getByTestId('station-tab-character').click();
  await expect(page.locator('img.portrait-img, .portrait')).not.toHaveCount(0);
  // Every text line the character panel renders, measured from the frame.
  const boxes = await page.evaluate(() => {
    const panel = document.querySelector('.panel') as HTMLElement;
    const out: Array<{ text: string; x: number; y: number; width: number; height: number }> = [];
    for (const el of Array.from(panel.querySelectorAll('*'))) {
      const own = Array.from(el.childNodes)
        .filter((n) => n.nodeType === 3)
        .map((n) => (n.textContent ?? '').trim())
        .join('');
      if (own.length < 4) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 16 || r.height < 10 || r.y < 0 || r.y + r.height > window.innerHeight) continue;
      out.push({ text: own.slice(0, 24), x: Math.round(r.x), y: Math.round(r.y), width: Math.round(Math.min(r.width, 360)), height: Math.round(r.height) });
    }
    return out.slice(0, 8);
  });
  expect(boxes.length).toBeGreaterThan(3);
  for (const box of boxes) {
    const ratio = await measuredContrast(page, { x: box.x, y: box.y, width: box.width, height: box.height });
    expect(ratio, `"${box.text}" against its panel`).toBeGreaterThanOrEqual(4.5);
  }
});

test('the touch targets, the font floor and the no-webfont rule are unchanged (AC-25, AC-26)', async ({ page }) => {
  await stationWithSave(page);
  const ui = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button')).filter(
      (b) => !/context loss/i.test(b.textContent ?? '') && b.getBoundingClientRect().height > 0,
    );
    const fonts = Array.from(document.querySelectorAll('.panel *, .ui-btn, .hud *'))
      .map((el) => parseFloat(getComputedStyle(el).fontSize))
      .filter((v) => v > 0);
    return {
      minButtonHeight: Math.min(...buttons.map((b) => Math.round(b.getBoundingClientRect().height))),
      minFont: Math.min(...fonts),
      loadedFonts: document.fonts.size,
      fontLinks: Array.from(document.querySelectorAll('link')).filter((l) => /font/i.test(l.href)).length,
      bodyFont: getComputedStyle(document.body).fontFamily,
    };
  });
  expect(ui.minButtonHeight).toBeGreaterThanOrEqual(44);
  expect(ui.minFont).toBeGreaterThanOrEqual(14);
  // AC-26: nothing downloads a typeface; the system stack does the work.
  expect(ui.loadedFonts).toBe(0);
  expect(ui.fontLinks).toBe(0);
  expect(ui.bodyFont).toContain('system-ui');
  const css = await styleSheetText(page);
  expect(css).not.toContain('@font-face');
  expect(css).toContain('user-select: none');
  expect(css).toContain('env(safe-area-inset');
  expect(css).toContain('min-height: 56px'); // the gameplay targets
  // Reduce motion still arrives as the `html.reduce-motion` contract the theme
  // reads (SPEC-014 AC-110); the restyle did not move it into a media query.
  expect(css).toContain('.reduce-motion');
});

test('the hub scenes keep their pinned props counts (AC-17)', async ({ page }) => {
  for (const [scene, props] of [
    ['station', 3],
    ['menu', 1],
    ['creation', 1],
  ] as const) {
    await start(page, `/?debug&scene=${scene}`);
    await expect(page.locator('[data-testid="scene-label"]')).toHaveText(scene);
    await expect(page.locator('[data-testid="debug-scene"]')).toContainText(`scene ${scene} props=${props}`);
  }
});

test('creation shows portrait images, and falls back to the glyphs when they are missing (AC-28)', async ({ page }) => {
  await start(page, '/?debug&scene=creation');
  const shown = await page.evaluate(() =>
    Array.from(document.querySelectorAll('img.portrait-img')).map((img) => ({
      src: img.getAttribute('src') ?? '',
      width: (img as HTMLImageElement).naturalWidth,
    })),
  );
  expect(shown.length).toBeGreaterThan(0);
  for (const img of shown) {
    expect(img.src).toMatch(/assets\/portraits\/\d{2}\.webp$/);
    expect(img.width, `${img.src} decoded`).toBeGreaterThan(0);
  }

  // With the manifest gone, the same screen keeps the glyph portraits of today.
  await page.route('**/assets/portraits/**', (route) => route.abort());
  await start(page, '/?debug&scene=creation');
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('creation');
  await expect(page.locator('.portrait')).not.toHaveCount(0);
  await expect(page.locator('img.portrait-img')).toHaveCount(0);
});
