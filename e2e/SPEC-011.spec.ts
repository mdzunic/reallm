// SPEC-011's browser acceptance run on Cinder-4, against the combat demo
// harness (`scenes/SurfaceCombatDemo.ts`). The archetype mechanics, the damage
// formulas, the loot streams and the spatial hash are pinned in node
// (`tests/systems/`); what this suite proves is the wiring only a browser
// shows — enemies actually spawn and engage on a real planet, elites arrive at
// the planet's rate, the wurm's burrow really makes it untouchable, the die →
// respawn round trip closes *and* the brains re-acquire the player afterwards,
// and the surface scene still starts (and ducks) its own music bed.
import { expect, test, type Page } from '@playwright/test';
import { passGate, start } from './start';

const info = async (page: Page): Promise<Record<string, number | string>> =>
  (await page.evaluate(() => window.__reallm.stats())).sceneInfo ?? {};

const counters = async (page: Page): Promise<{ spawned: number; elites: number; kills: number }> => {
  const text = (await page.locator('[data-testid="hud-counters"]').textContent()) ?? '';
  const read = (key: string): number => Number((text.match(new RegExp(`${key} (\\d+)`)) ?? ['', '0'])[1]);
  return { spawned: read('spawned'), elites: read('elites'), kills: read('kills') };
};

/** The demo lets the pilot die while a long observation runs; put them back up. */
const reviveIfDead = async (page: Page): Promise<void> => {
  const death = page.locator('[data-testid="hud-death"]');
  if (await death.evaluate((el) => el.classList.contains('is-visible'))) {
    await page.locator('[data-testid="demo-respawn"]').click();
  }
};

test('enemies spawn and engage on Cinder-4 (AC-36, AC-37, AC-38)', async ({ page }) => {
  await start(page, '/?debug&scene=surface&planet=cinder4');
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('surface');

  // Landing HP: marine demo pilot at full (the §6 pin, 184). `hud-hp` is the
  // shared SPEC-014 HUD's ♥ bar — the scene feeds it its live numbers rather
  // than painting a rival readout.
  await expect(page.locator('[data-testid="hud-hp"]')).toContainText('184/184');

  // The spawn director fills the field (plus the boss in its nest).
  await expect.poll(async () => Number((await info(page))['enemies'] ?? 0), { timeout: 20_000 }).toBeGreaterThan(4);
  await expect.poll(async () => Number((await info(page))['spawned'] ?? 0), { timeout: 20_000 }).toBeGreaterThan(8);
  await expect(page.locator('[data-testid="hud-counters"]')).toContainText('spawned');

  // They close in and fight: with auto-fire on and skitters spawning 14 m out,
  // both sides land hits without any input from the player.
  await expect.poll(async () => (await counters(page)).kills, { timeout: 30_000 }).toBeGreaterThan(2);
  await expect
    .poll(async () => (await page.locator('[data-testid="hud-hp"]').textContent()) ?? '', { timeout: 30_000 })
    .not.toContain('184/184');
});

/**
 * The merge put SPEC-014's HUD and SPEC-011's combat chrome in one scene, and
 * QA caught them colliding twice: two HP readouts disagreeing mid-fight, and
 * the placeholder nav buttons sitting on the HUD's resource column. Both are
 * composition defects only this merged tree can show (SPEC-014 AC-58).
 */
test('the merged scene wears one HUD: a single HP readout, resources uncovered', async ({ page }) => {
  await start(page, '/?debug&scene=surface&planet=cinder4');
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('surface');

  // One HP readout on the whole page — the shared HUD's, at the world's live
  // numbers even with no save slot bound (never the model's 0/1 default).
  await expect(page.locator('[data-testid="hud-hp"]')).toHaveCount(1);
  await expect(page.locator('[data-testid="hud-hp"]')).toContainText('184/184');

  // QA's occlusion probe: the hit at the oil counter's centre resolves inside
  // no nav button (the nav lives mid-left now, off the HUD's corners).
  expect(
    await page.evaluate(() => {
      const oil = document.querySelector('[data-testid="res-oil"]');
      if (oil === null) return 'res-oil missing';
      const box = oil.getBoundingClientRect();
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return hit !== null && hit.closest('.scene-nav') !== null ? 'covered by scene-nav' : null;
    }),
  ).toBeNull();
});

test('elites arrive at roughly the planet rate of 1 in 20 (AC-40)', async ({ page }) => {
  test.setTimeout(480_000);
  await start(page, '/?debug&scene=surface&planet=cinder4');

  // The wait is a positive signal, so it ends as soon as the first elite rolls
  // — a minute or so at cinder4's eliteChance of 0.05 and ~0.3 spawns/s. The
  // budget is long enough that never seeing one means the roll is broken, not
  // that the run was unlucky: it covers well over a hundred spawns.
  await expect
    .poll(
      async () => {
        await reviveIfDead(page);
        return (await counters(page)).elites;
      },
      { timeout: 300_000, intervals: [1000] },
    )
    .toBeGreaterThanOrEqual(1);

  // The other half of "about 1 in 20": common enemies stay common. Measured
  // once the run is long enough for the ratio to mean anything.
  await expect
    .poll(
      async () => {
        await reviveIfDead(page);
        return (await counters(page)).spawned;
      },
      { timeout: 150_000, intervals: [1000] },
    )
    .toBeGreaterThanOrEqual(40);
  const seen = await counters(page);
  expect(seen.elites / seen.spawned).toBeLessThan(0.25);
});

test('the player dies, respawns, and the brains re-acquire them (AC-41)', async ({ page }) => {
  test.setTimeout(90_000);
  await start(page, '/?debug&scene=surface&planet=cinder4');
  await expect(page.locator('[data-testid="hud-hp"]')).toContainText('184/184');

  // 60 a click against 184 HP; clicks are spaced past the 0.3 s i-frames.
  for (let i = 0; i < 4; i++) {
    await page.locator('[data-testid="demo-hurt"]').click();
    await page.waitForTimeout(400);
  }
  await expect(page.locator('[data-testid="hud-death"]')).toBeVisible();
  await expect(page.locator('[data-testid="hud-death"]')).toContainText('Cause: fall');

  // The demo's panel is the only death surface in this scene: the shared
  // SPEC-014 overlay stays unmounted here, because at z 30 over the combat
  // HUD's z 11 it would cover the Respawn button that the next line clicks.
  await expect(page.locator('[data-testid="death-overlay"]')).toHaveCount(0);
  await page.locator('[data-testid="demo-respawn"]').click();
  await expect(page.locator('[data-testid="hud-death"]')).toBeHidden();
  await expect(page.locator('[data-testid="hud-hp"]')).toContainText('184/184');

  // §4.5's "player dead → wander" is sticky, so the interesting half is what
  // happens *after*: the enemies must come back for the respawned player rather
  // than wander for ever. Kills climbing again is that proof.
  const after = await counters(page);
  await expect.poll(async () => (await counters(page)).kills, { timeout: 45_000 }).toBeGreaterThan(after.kills);
});

test('the dune wurm burrows into phase 2 and is untouchable while under (AC-39)', async ({ page }) => {
  test.setTimeout(90_000);
  await start(page, '/?debug&scene=surface&planet=cinder4');
  await expect.poll(async () => String((await info(page))['boss'] ?? ''), { timeout: 15_000 }).toMatch(/^p1 /);

  // Into the nest: the boss aggroes (its bar appears) and the arena arms.
  await page.locator('[data-testid="demo-goto-boss"]').click();
  await expect(page.locator('[data-testid="hud-boss"]')).toBeVisible({ timeout: 15_000 });

  // Three 25 % wounds cross the 0.4 threshold and the wurm burrows.
  for (let i = 0; i < 3; i++) {
    await page.locator('[data-testid="demo-wound-boss"]').click();
    await page.waitForTimeout(300);
  }
  await expect.poll(async () => String((await info(page))['boss'] ?? ''), { timeout: 15_000 }).toMatch(/^p2 /);

  // Under the sand it is invulnerable (§4.5, edge 11-f): the same shortcut that
  // just took a quarter of its health off does nothing for the next ~3 s.
  const buried = String((await info(page))['boss'] ?? '');
  for (let i = 0; i < 4; i++) {
    await page.locator('[data-testid="demo-wound-boss"]').click();
    await page.waitForTimeout(300);
  }
  expect(String((await info(page))['boss'] ?? '')).toBe(buried);

  // And it resurfaces: once the burrow ends the wounds land again.
  await expect
    .poll(
      async () => {
        await page.locator('[data-testid="demo-wound-boss"]').click();
        return String((await info(page))['boss'] ?? '');
      },
      { timeout: 20_000, intervals: [400] },
    )
    .not.toBe(buried);
});

// ------------------------------------------------------------------ the bed

/**
 * 20 s of a quiet sine as a PCM WAV. Chromium decodes by sniffing the
 * container, not the extension, so this answers the `.webm` URL Howler picks.
 */
function wav(seconds = 20, rate = 8000): Buffer {
  const samples = seconds * rate;
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    data.writeInt16LE(Math.round(Math.sin((i / rate) * 220 * 2 * Math.PI) * 2000), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
const STAND_IN = wav();

interface BedProbe {
  __bedGain(): number | null;
}

/**
 * The surface scene is SPEC-011's own file, and dropping the placeholder's
 * `music: 'surface_calm'` from it once already broke SPEC-006 AC-51/AC-54. This
 * guards the contract from this side too: the bed starts on Cinder-4, the pause
 * menu ducks it, and resuming lets it go.
 */
test('entering Cinder-4 starts the surface bed, and the pause menu ducks it', async ({ page }) => {
  const MUSIC_FULL = 0.7;
  const MUSIC_DUCKED = 0.21;
  await page.route('**/assets/audio/**', (route) =>
    route.fulfill({ status: 200, contentType: 'audio/wav', body: STAND_IN }),
  );
  await page.addInitScript(() => {
    (window as unknown as BedProbe).__bedGain = () => {
      const howler = (window as unknown as { Howler?: unknown }).Howler as
        | {
            _howls: Array<{
              _src: string;
              _sounds: Array<{ _paused: boolean; _ended: boolean; _node: { gain: { value: number } } }>;
            }>;
          }
        | undefined;
      const bed = (howler?._howls ?? []).find((h) => (h._src.split('/').pop() ?? '').startsWith('surface_calm'));
      const live = (bed?._sounds ?? []).filter((s) => !s._paused && !s._ended);
      const first = live[0];
      return first === undefined ? null : Number(first._node.gain.value.toFixed(4));
    };
  });
  await page.goto('/?debug&scene=surface&planet=cinder4');
  await passGate(page);
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('surface');

  const bed = (): Promise<number | null> => page.evaluate(() => (window as unknown as BedProbe).__bedGain());

  await expect.poll(bed, { timeout: 20_000 }).toBeCloseTo(MUSIC_FULL, 2);

  await page.keyboard.press('Escape');
  await expect(page.locator('[data-testid="pause-menu"]')).toBeVisible();
  await expect.poll(bed, { timeout: 10_000 }).toBeCloseTo(MUSIC_DUCKED, 2);

  await page.locator('[data-testid="pause-resume"]').click();
  await expect(page.locator('[data-testid="pause-menu"]')).not.toBeVisible();
  await expect.poll(bed, { timeout: 10_000 }).toBeCloseTo(MUSIC_FULL, 2);
});
