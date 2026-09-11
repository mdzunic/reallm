// SPEC-011's browser acceptance run on Cinder-4, now against the real surface
// scene (`scenes/Surface.ts`, SPEC-012) — the combat demo harness it used to
// drive was replaced wholesale, as that harness's own header promised. The
// archetype mechanics, the damage formulas, the loot streams and the spatial
// hash stay pinned in node (`tests/systems/`); what this suite proves is the
// wiring only a browser shows — enemies actually spawn and engage on a real
// planet, elites arrive at the planet's rate, the wurm's burrow really makes
// it untouchable, the die → respawn round trip closes *and* the brains
// re-acquire the player afterwards, and the surface scene still starts (and
// ducks) its own music bed. The QA shortcuts moved to the real scene's
// `?debug` strip (`surface-hurt`, `surface-spawn-boss`, …); the spawn/elite/
// kill counters moved into `debugInfo()`.
import { expect, test, type Page } from '@playwright/test';
import { gameUrl, passGate, start } from './start';

const info = async (page: Page): Promise<Record<string, number | string>> =>
  (await page.evaluate(() => window.__reallm.stats())).sceneInfo ?? {};

/** Auto-fire on, so combat runs hands-free while an observation poll waits. */
const autoFire = async (page: Page): Promise<void> => {
  await page.addInitScript(() => localStorage.setItem('reallm:settings', JSON.stringify({ autoFire: 'on' })));
};

/**
 * Walk toward the nearest enemy until `done` reads true (or the budget runs
 * out). Enemies wander near their §4.5 spawn ring, 25–40 m out and past a
 * skitter's 18 m aggro, so an idle pilot sees no combat — the patrol closes
 * the distance and auto-fire does the rest. Movement is camera-relative
 * (§4.3): each of WASD covers exactly one world quadrant, so steering is a
 * sign check on the offset `debugInfo()` reports.
 */
async function hunt(page: Page, seconds: number, done: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < seconds && !(await done()); i++) {
    const s = await info(page);
    const dx = Number(s['nearDx'] ?? 0);
    const dz = Number(s['nearDz'] ?? 0);
    const key = dx >= 0 ? (dz >= 0 ? 'KeyS' : 'KeyD') : (dz >= 0 ? 'KeyA' : 'KeyW');
    await page.keyboard.down(key);
    await page.waitForTimeout(700);
    await page.keyboard.up(key);
    await page.waitForTimeout(300);
  }
}

test('enemies spawn and engage on Cinder-4 (AC-36, AC-37, AC-38)', async ({ page }) => {
  test.setTimeout(150_000);
  await autoFire(page);
  // Named on purpose: how many enemies the director may put on the field is a
  // `QUALITY` row (`maxEnemies`, 12 on `low` and 20 on `medium`), and the
  // spawn counts below are written against the preset the game defaults to.
  // Every other suite takes `e2e/start.ts`'s cheap default; this one cannot.
  await start(page, '/?debug&quality=medium&scene=surface&planet=cinder4');
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('surface');

  // Landing HP: marine stand-in pilot at full (the §6 pin, 184). `hud-hp` is
  // the shared SPEC-014 HUD's ♥ bar, fed the world's live numbers.
  await expect(page.locator('[data-testid="hud-hp"]')).toContainText('184/184');

  // The spawn director fills the field toward the population target.
  await expect.poll(async () => Number((await info(page))['enemies'] ?? 0), { timeout: 20_000 }).toBeGreaterThan(4);
  await expect.poll(async () => Number((await info(page))['spawned'] ?? 0), { timeout: 20_000 }).toBeGreaterThan(8);

  // They close in and fight: hunt the field with auto-fire on until both
  // sides have landed hits — kills climb AND the melee swarm has drawn blood.
  const engaged = async (): Promise<boolean> => {
    const kills = Number((await info(page))['kills'] ?? 0);
    const hp = (await page.locator('[data-testid="hud-hp"]').textContent()) ?? '';
    return kills > 2 && !hp.includes('184/184');
  };
  await hunt(page, 120, engaged);
  expect(await engaged()).toBe(true);
});

/**
 * QA caught the merged scene showing two HP readouts and nav buttons covering
 * the resource column. The real scene keeps the guarantee: one shared HUD,
 * nothing over its corners (SPEC-014 AC-58).
 */
test('the surface scene wears one HUD: a single HP readout, resources uncovered', async ({ page }) => {
  await start(page, '/?debug&scene=surface&planet=cinder4');
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('surface');

  await expect(page.locator('[data-testid="hud-hp"]')).toHaveCount(1);
  await expect(page.locator('[data-testid="hud-hp"]')).toContainText('184/184');

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
  await autoFire(page);
  await start(page, '/?debug&scene=surface&planet=cinder4');

  // The director only spawns below the population target, so an idle field
  // stalls at ~9 spawns — the pilot hunts to churn it. The first wait is a
  // positive signal: it ends as soon as the first elite rolls, and the budget
  // covers well over a hundred spawns at cinder4's eliteChance of 0.05. The
  // scene respawns a dead pilot by itself after 2.5 s, so no revive clicks.
  await hunt(page, 300, async () => Number((await info(page))['elites'] ?? 0) >= 1);
  expect(Number((await info(page))['elites'] ?? 0)).toBeGreaterThanOrEqual(1);

  // The other half of "about 1 in 20": common enemies stay common.
  await hunt(page, 150, async () => Number((await info(page))['spawned'] ?? 0) >= 40);
  const seen = await info(page);
  expect(Number(seen['spawned'])).toBeGreaterThanOrEqual(40);
  expect(Number(seen['elites']) / Number(seen['spawned'])).toBeLessThan(0.25);
});

test('the player dies into SIGNAL LOST, respawns, and the brains re-acquire them (AC-41, SPEC-012 §4.8)', async ({ page }) => {
  test.setTimeout(90_000);
  await autoFire(page);
  await start(page, '/?debug&scene=surface&planet=cinder4');
  await expect(page.locator('[data-testid="hud-hp"]')).toContainText('184/184');

  // 60 a click against 184 HP; clicks are spaced past the 0.3 s i-frames.
  for (let i = 0; i < 4; i++) {
    await page.locator('[data-testid="surface-hurt"]').click();
    await page.waitForTimeout(400);
  }
  // The shared SPEC-014 overlay is the scene's one death surface (§4.8).
  await expect(page.locator('[data-testid="death-overlay"]')).toBeVisible();
  await expect(page.locator('[data-testid="death-overlay"]')).toContainText('SIGNAL LOST');

  // §4.8 step 2/3: after 2.5 s the scene respawns by itself, at full HP.
  await expect(page.locator('[data-testid="death-overlay"]')).toBeHidden({ timeout: 10_000 });
  await expect(page.locator('[data-testid="hud-hp"]')).toContainText('184/184');

  // §4.5's "player dead → wander" is sticky, so the interesting half is what
  // happens *after*: kills climbing again proves the brains came back. The
  // respawned pilot hunts the field again (spawns sit past aggro range).
  const after = Number((await info(page))['kills'] ?? 0);
  await hunt(page, 60, async () => Number((await info(page))['kills'] ?? 0) > after);
  expect(Number((await info(page))['kills'] ?? 0)).toBeGreaterThan(after);
});

test('the dune wurm burrows into phase 2 and is untouchable while under (AC-39)', async ({ page }) => {
  test.setTimeout(90_000);
  await start(page, '/?debug&scene=surface&planet=cinder4');

  // The real scene spawns the wurm for a boss mission stage; the debug strip's
  // Wake button covers the mission-less acceptance run.
  await page.locator('[data-testid="surface-spawn-boss"]').click();
  await expect.poll(async () => String((await info(page))['boss'] ?? ''), { timeout: 15_000 }).toMatch(/^p1 /);

  // Into the nest: the boss aggroes and the shared HUD's bar appears.
  await page.locator('[data-testid="surface-goto-boss"]').click();
  await expect(page.locator('[data-testid="hud-boss"]')).toBeVisible({ timeout: 15_000 });

  // Three 25 % wounds cross the 0.4 threshold and the wurm burrows.
  for (let i = 0; i < 3; i++) {
    await page.locator('[data-testid="surface-wound-boss"]').click();
    await page.waitForTimeout(300);
  }
  await expect.poll(async () => String((await info(page))['boss'] ?? ''), { timeout: 15_000 }).toMatch(/^p2 /);

  // Under the sand it is invulnerable (§4.5, edge 11-f): the same shortcut that
  // just took a quarter of its health off does nothing for the next ~3 s.
  const buried = String((await info(page))['boss'] ?? '');
  for (let i = 0; i < 4; i++) {
    await page.locator('[data-testid="surface-wound-boss"]').click();
    await page.waitForTimeout(300);
  }
  expect(String((await info(page))['boss'] ?? '')).toBe(buried);

  // And it resurfaces: once the burrow ends the wounds land again.
  await expect
    .poll(
      async () => {
        await page.locator('[data-testid="surface-wound-boss"]').click();
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
 * Dropping the placeholder's `music: 'surface_calm'` once already broke
 * SPEC-006 AC-51/AC-54. This guards the contract from this side too: the bed
 * starts on Cinder-4, the pause menu ducks it, and resuming lets it go.
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
  await page.goto(gameUrl('/?debug&scene=surface&planet=cinder4'));
  await passGate(page);
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('surface');
  // …and until the scene is actually drawing, for the reason `startWithAudio`
  // in `e2e/SPEC-006.spec.ts` does the same: the scene label goes up when the
  // scene is built, but the *first rendered frame* after it compiles every GPU
  // program the scene needs, and on this container's software rasteriser that
  // is a synchronous stall of ≈ 0.9 s — several times that when the other
  // workers in this file are saturating the CPUs. The bed's fade is driven by
  // `performance.now()` on a `setInterval` (`core/Audio.ts` §4.4), so the stall
  // blocks the ramp's ticker and this poll's `evaluate` alike, and the window
  // below ends up measuring the compile instead of the fade. Waiting for the
  // frames first puts the stall outside the window. No assertion changed; this
  // is the flake that made the test fail in parallel and pass on its own.
  await page.waitForFunction(() => window.__reallm.stats().frame > 5, undefined, { timeout: 60_000 });

  const bed = (): Promise<number | null> => page.evaluate(() => (window as unknown as BedProbe).__bedGain());

  await expect.poll(bed, { timeout: 20_000 }).toBeCloseTo(MUSIC_FULL, 2);

  await page.keyboard.press('Escape');
  await expect(page.locator('[data-testid="pause-menu"]')).toBeVisible();
  await expect.poll(bed, { timeout: 10_000 }).toBeCloseTo(MUSIC_DUCKED, 2);

  await page.locator('[data-testid="pause-resume"]').click();
  await expect(page.locator('[data-testid="pause-menu"]')).not.toBeVisible();
  await expect.poll(bed, { timeout: 10_000 }).toBeCloseTo(MUSIC_FULL, 2);
});
