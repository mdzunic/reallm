// SPEC-052 §6.2 — the world-art drop in a real browser: the rebuilt,
// meshopt-compressed props load and draw from their models, the trees wait for
// SPEC-053 without breaking the budget, the new pictures, the kit, the atlas
// and the detail normal are served, and the atlas's alpha and the detail
// normal read back the way §3.3 and §4.7 promise.
//
// Every model, texture and constant claim is pinned in node by
// tests/assets/worldArt.test.ts; this file checks what only a browser can see.
import { expect, test, type Page } from '@playwright/test';
import { COLD_START, start } from './start';

async function sceneInfo(page: Page): Promise<Record<string, number | string>> {
  return page.evaluate(() => window.__reallm.stats().sceneInfo ?? {});
}

/** Wait until `count` more frames have been drawn. */
async function afterFrames(page: Page, count: number): Promise<void> {
  const from = (await page.evaluate(() => window.__reallm.stats())).frame;
  await page.waitForFunction((target) => window.__reallm.stats().frame >= target, from + count, { timeout: 60_000 });
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

/** Console errors and page errors that name a model or the compression extension. */
function watchModelErrors(page: Page): string[] {
  const errors: string[] = [];
  const keep = (text: string) => {
    if (/\.glb|EXT_meshopt_compression|meshopt/i.test(text)) errors.push(text);
  };
  page.on('console', (message) => {
    if (message.type() === 'error') keep(message.text());
  });
  page.on('pageerror', (error) => keep(String(error)));
  return errors;
}

// ------------------------------------------------------- 1: rebuilt props load

test('1. Cinder-4’s rebuilt props load from their compressed models, and nothing complains about a GLB', async ({ page }) => {
  const errors = watchModelErrors(page);
  await start(page, '/?debug&scene=surface&planet=cinder4&quality=medium');
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('surface');
  // §6.2: within 2 s of the landing the models have replaced the stand-ins —
  // 2 s on the surface's own clock (sceneInfo.viewTime), which a CPU-starved
  // host slows along with everything else, not on the wall clock it does not.
  let swappedAt = Number.NaN;
  await expect
    .poll(
      async () => {
        const info = await sceneInfo(page);
        if (info['propSource'] === 'glb' && Number.isNaN(swappedAt)) swappedAt = Number(info['viewTime'] ?? Number.NaN);
        return info['propSource'];
      },
      { ...COLD_START, intervals: [50] },
    )
    .toBe('glb');
  expect(swappedAt).toBeLessThanOrEqual(2);
  await dismiss(page);
  await afterFrames(page, 10);
  expect(errors).toEqual([]);
});

// --------------------------------------------------- 2: trees wait for SPEC-053

for (const planet of ['thessaly', 'eden'] as const) {
  test(`2. on ${planet} the tree-contract models hold nothing up and the frame stays within 96 draws and 130 k triangles`, async ({ page }) => {
    test.setTimeout(120_000);
    const errors = watchModelErrors(page);
    // The budget is `medium`'s, so the adaptive governor stays off (SPEC-040 40-g).
    await page.addInitScript(() => localStorage.setItem('reallm:settings', JSON.stringify({ adaptiveQuality: false })));
    await start(page, `/?debug&scene=surface&planet=${planet}&quality=medium`);
    await expect(page.locator('[data-testid="scene-label"]')).toHaveText('surface');
    await dismiss(page);
    // SPEC-046 46-c: a kind whose models are all tree contracts draws procedurally and is not waited for
    await expect.poll(async () => (await sceneInfo(page))['propSource'], COLD_START).toBe('glb');
    await afterFrames(page, 30);
    const stats = await page.evaluate(() => window.__reallm.stats());
    expect(stats.drawCalls).toBeLessThanOrEqual(96);
    expect(stats.triangles).toBeLessThanOrEqual(130_000);
    expect(errors).toEqual([]);
  });
}

// -------------------------------------------------------------- 3: pictures

test('3. the new pictures are served and the manifest lists 33 ids', async ({ page }) => {
  for (const id of ['relic_seeker', 'stim']) {
    const response = await page.request.get(`/assets/items/${id}.webp`);
    expect(response.status(), id).toBe(200);
  }
  const manifest = await page.request.get('/assets/items/manifest.json');
  expect(manifest.status()).toBe(200);
  expect(((await manifest.json()) as { items: string[] }).items).toHaveLength(33);
});

// ------------------------------------------------------------- 4: the kit ships

test('4. the cave kit, the landmarks and the atlas are served', async ({ page }) => {
  for (const url of ['/assets/models/cave/cradle.glb', '/assets/models/props/landmark_temperate.glb', '/assets/textures/foliage/atlas.webp']) {
    const response = await page.request.get(url);
    expect(response.status(), url).toBe(200);
  }
});

// ------------------------------------------------- 5, 6: read back in a canvas

/** Draws a served image to a canvas of its own size and returns its RGBA. */
async function readBack(page: Page, url: string): Promise<{ width: number; height: number; data: number[] }> {
  // Any document on the dev server's origin will do (the image needs no game);
  // an OffscreenCanvas works in the SVG document this one is.
  await page.goto('/favicon.svg');
  return page.evaluate(async (src) => {
    const bitmap = await createImageBitmap(await (await fetch(src)).blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const g = canvas.getContext('2d', { willReadFrequently: true });
    if (g === null) throw new Error('no 2d context');
    g.drawImage(bitmap, 0, 0);
    const { data } = g.getImageData(0, 0, canvas.width, canvas.height);
    return { width: canvas.width, height: canvas.height, data: Array.from(data) };
  }, url);
}

test('5. the atlas reads back with a transparent gutter round every cell and an opaque bark cell', async ({ page }) => {
  const { width, height, data } = await readBack(page, '/assets/textures/foliage/atlas.webp');
  expect([width, height]).toEqual([512, 512]);
  const alpha = (x: number, y: number) => data[(y * width + x) * 4 + 3] ?? -1;
  const CELL = 128;
  const GUTTER = 4;
  for (let cell = 0; cell < 16; cell++) {
    const x0 = (cell % 4) * CELL;
    const y0 = Math.floor(cell / 4) * CELL;
    let gutter = 0;
    let solid = 0;
    let opaqueInside = true;
    for (let y = 0; y < CELL; y++) {
      for (let x = 0; x < CELL; x++) {
        const a = alpha(x0 + x, y0 + y);
        const inGutter = x < GUTTER || y < GUTTER || x >= CELL - GUTTER || y >= CELL - GUTTER;
        if (inGutter) {
          if (a !== 0) gutter++;
        } else {
          if (a > 200) solid++;
          if (a !== 255) opaqueInside = false;
        }
      }
    }
    expect(gutter, `cell ${cell}: gutter pixels with alpha`).toBe(0);
    if (cell === 15) expect(opaqueInside, 'the bark cell is opaque inside its gutter').toBe(true);
    else expect(solid, `cell ${cell}: pixels with alpha above 200`).toBeGreaterThan(0);
  }
});

test('6. detail_nr reads back as unit tangent normals facing out of the surface', async ({ page }) => {
  const { width, height, data } = await readBack(page, '/assets/textures/ground/detail_nr.webp');
  expect([width, height]).toEqual([256, 256]);
  for (let y = 0; y < height; y += 7) {
    for (let x = 0; x < width; x += 7) {
      const i = (y * width + x) * 4;
      const [r, g, b] = [data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0].map((c) => (c / 255) * 2 - 1) as [number, number, number];
      expect(b, `z at ${x},${y}`).toBeGreaterThan(0.5);
      expect(Math.abs(Math.hypot(r, g, b) - 1), `length at ${x},${y}`).toBeLessThanOrEqual(0.1);
    }
  }
});
