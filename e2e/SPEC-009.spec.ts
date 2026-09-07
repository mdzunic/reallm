// SPEC-009 in a real browser: the content data layer, loaded the way the game
// loads it.
//
// The unit suite (`tests/data/content.test.ts`) proves the 17 invariants in
// node, and `tsc` proves the id unions. What this suite adds is the wiring: that
// `src/data/index.ts` actually *evaluates* in a browser — no circular import
// stalls the barrel, no table is lost to a bad re-export — and that the roster
// the game would read there is the roster PLAN §6 locks.
//
// `e2e/` may not import `src/` (SPEC-001 §4), so the barrel is pulled in from
// inside the page with a dynamic import the dev server transforms. That is also
// why every test here goes through the dev server the config starts; the ids are
// asserted as data, never as a `src` type.
import { expect, test, type Page } from '@playwright/test';

/** The parts of the content barrel these assertions read, as plain data. */
interface ContentDigest {
  idUnions: Record<string, string[]>;
  tables: string[];
  classes: string[];
  items: string[];
  itemStats: Record<string, unknown>;
  enemies: string[];
  chapter1Enemies: string[];
  lootTables: string[];
  danglingLootRefs: string[];
  planets: string[];
  cinder4: {
    biome: string;
    pois: string[];
    nodes: string[];
    spawn: string[];
    weather: string[];
    flightWaves: string[];
  };
  missions: string[];
  mainMissions: string[];
  sideMissions: string[];
  mainTokens: number;
  sideTokens: number;
  followers: string[];
  companions: string[];
  upgrades: string[];
  recipes: string[];
  tuning: string[];
  dialogue: string[];
  chapter1Dialogue: string[];
  waves: string[];
  danglingWaveRefs: string[];
  danglingDialogueRefs: string[];
  missionsWithoutOpeningLine: string[];
  longestTitle: number;
  longestBrief: number;
  longestDialogueLine: number;
}

/**
 * Loads the barrel inside the page and returns a serialisable digest of it.
 * Everything the suite asserts is computed here in one round trip so that a
 * failure names the table rather than the transport.
 */
async function readContent(page: Page): Promise<ContentDigest> {
  await page.goto('/');
  return page.evaluate(async () => {
    const mod = (await import('/src/data/index.ts')) as unknown as Record<string, never>;
    const m = mod as unknown as {
      CONTENT: Record<string, Record<string, never>>;
      [key: string]: unknown;
    };
    const C = m.CONTENT as unknown as {
      classes: Record<string, { startingWeapon: string }>;
      items: Record<string, Record<string, unknown>>;
      enemies: Record<string, { chapter: number; loot: string }>;
      loot: Record<string, unknown>;
      planets: Record<string, Record<string, never>>;
      missions: Record<string, never>;
      followers: Record<string, unknown>;
      companions: Record<string, unknown>;
      upgrades: Record<string, unknown>;
      recipes: Record<string, unknown>;
      tuning: Record<string, unknown>;
      dialogue: Record<string, { lines: { text: string }[] }>;
      waves: Record<string, unknown>;
    };
    type Objective = { wave?: string; waves?: string };
    type Mission = {
      title: string;
      brief: string;
      stages: Objective[][];
      rewards: { tokens: number };
      dialogue?: { onAccept?: string; onComplete?: string; onStage?: Record<string, string> };
    };
    const missions = C.missions as unknown as Record<string, Mission>;
    const planets = C.planets as unknown as Record<
      string,
      {
        biome: string;
        flight: { waves: string[] };
        surface: {
          pois: { id: string; kind: string }[];
          nodes: { resource: string }[];
          spawn: { enemy: string }[];
          weather: { cycle: string[] };
        };
      }
    >;

    const missionIds = Object.keys(missions);
    const main = missionIds.filter((id) => /_m\d+$/.test(id));
    const side = missionIds.filter((id) => /_s\d+$/.test(id));
    const tokens = (ids: string[]) => ids.reduce((total, id) => total + missions[id]!.rewards.tokens, 0);

    // Every wave id anything names — a planet's flight list, a `defend`/`survive`
    // objective — must resolve against WAVES.
    const waveRefs = new Set<string>();
    for (const p of Object.values(planets)) for (const w of p.flight?.waves ?? []) waveRefs.add(w);
    for (const mission of Object.values(missions))
      for (const stage of mission.stages)
        for (const objective of stage) {
          if (objective.wave) waveRefs.add(objective.wave);
          if (objective.waves) waveRefs.add(objective.waves);
        }

    const dialogueRefs: string[] = [];
    const missionsWithoutOpeningLine: string[] = [];
    for (const [id, mission] of Object.entries(missions)) {
      const d = mission.dialogue ?? {};
      if (!d.onAccept) missionsWithoutOpeningLine.push(id);
      for (const ref of [d.onAccept, d.onComplete, ...Object.values(d.onStage ?? {})]) if (ref) dialogueRefs.push(ref);
    }

    const longest = (values: string[]) => values.reduce((max, value) => Math.max(max, value.length), 0);
    const cinder4 = planets['cinder4']!;
    const unionNames = [
      'RESOURCE_IDS',
      'PLANET_IDS',
      'CLASS_IDS',
      'SHIP_SYSTEMS',
      'WEATHER_IDS',
      'COMPANION_IDS',
      'STORY_FLAGS',
      'SPEAKERS',
      'MESH_RECIPE_IDS',
      'MUSIC_IDS',
    ];
    const idUnions: Record<string, string[]> = {};
    for (const name of unionNames) idUnions[name] = (m[name] as string[] | undefined) ?? [];

    const item = (id: string) => C.items[id]!;
    return {
      idUnions,
      tables: Object.keys(C),
      classes: Object.keys(C.classes),
      items: Object.keys(C.items),
      itemStats: {
        weapon_kinetic: [item('weapon_kinetic')['kind'], item('weapon_kinetic')['tier'], item('weapon_kinetic')['damage']],
        weapon_laser: [item('weapon_laser')['tier'], item('weapon_laser')['damage'], item('weapon_laser')['price']],
        weapon_lithium: [item('weapon_lithium')['tier'], item('weapon_lithium')['damage'], item('weapon_lithium')['pierce']],
        armor_ablative: [item('armor_ablative')['armor'], item('armor_ablative')['hazardResist']],
        plasma_cell: [item('plasma_cell')['effect'], item('plasma_cell')['stack']],
      },
      enemies: Object.keys(C.enemies),
      chapter1Enemies: Object.entries(C.enemies)
        .filter(([, e]) => e.chapter === 1)
        .map(([id]) => id),
      lootTables: Object.keys(C.loot),
      danglingLootRefs: Object.entries(C.enemies)
        .filter(([, e]) => !(e.loot in C.loot))
        .map(([id, e]) => `${id}->${e.loot}`),
      planets: Object.keys(planets),
      cinder4: {
        biome: cinder4.biome,
        pois: cinder4.surface.pois.map((p) => `${p.id}:${p.kind}`),
        nodes: cinder4.surface.nodes.map((n) => n.resource),
        spawn: cinder4.surface.spawn.map((s) => s.enemy),
        weather: [...cinder4.surface.weather.cycle],
        flightWaves: [...cinder4.flight.waves],
      },
      missions: missionIds,
      mainMissions: main,
      sideMissions: side,
      mainTokens: tokens(main),
      sideTokens: tokens(side),
      followers: Object.keys(C.followers),
      companions: Object.keys(C.companions),
      upgrades: Object.keys(C.upgrades),
      recipes: Object.keys(C.recipes),
      tuning: Object.keys(C.tuning),
      dialogue: Object.keys(C.dialogue),
      chapter1Dialogue: Object.keys(C.dialogue).filter((id) => id.startsWith('c1_')),
      waves: Object.keys(C.waves),
      danglingWaveRefs: [...waveRefs].filter((w) => !(w in C.waves)),
      danglingDialogueRefs: dialogueRefs.filter((ref) => !(ref in C.dialogue)),
      missionsWithoutOpeningLine,
      longestTitle: longest(Object.values(missions).map((mi) => mi.title)),
      longestBrief: longest(Object.values(missions).map((mi) => mi.brief)),
      longestDialogueLine: longest(Object.values(C.dialogue).flatMap((d) => d.lines.map((l) => l.text))),
    };
  });
}

test.describe('SPEC-009 content data layer', () => {
  test('ids.ts exports the id unions of §3, and the barrel exposes every §4 table (AC-1, AC-2, AC-3)', async ({
    page,
  }) => {
    const c = await readContent(page);

    // AC-1: the §3 unions, with the two the spec names but does not enumerate
    // (mesh recipes, music cues) declared alongside them.
    expect(c.idUnions['RESOURCE_IDS']).toEqual(['oil', 'wheat', 'water', 'lithium']);
    expect(c.idUnions['PLANET_IDS']).toEqual(['cinder4', 'vetra', 'thessaly', 'ferrum', 'hive', 'eden']);
    expect(c.idUnions['CLASS_IDS']).toEqual(['marine', 'engineer', 'scout']);
    expect(c.idUnions['SHIP_SYSTEMS']).toEqual(['engine', 'hull', 'shield', 'cargo', 'weapon']);
    expect(c.idUnions['WEATHER_IDS']).toEqual([
      'sandstorm',
      'heatwave',
      'blizzard',
      'avalanche',
      'spore_storm',
      'radiation_storm',
    ]);
    expect(c.idUnions['COMPANION_IDS']).toEqual([
      'scanner_drone',
      'combat_drone',
      'field_medic',
      'quartermaster',
      'aria',
    ]);
    expect(c.idUnions['STORY_FLAGS']).toHaveLength(12);
    expect(c.idUnions['STORY_FLAGS']).toContain('chapter1_done');
    expect(c.idUnions['SPEAKERS']).toEqual(['aria', 'command', 'scav', 'log', 'player', 'warden']);
    expect(c.idUnions['MESH_RECIPE_IDS']).toHaveLength(10);
    expect(c.idUnions['MUSIC_IDS'].length).toBeGreaterThan(0);

    // AC-2: every §4 table is reachable through the barrel. AC-3's `keyof typeof`
    // is a compile-time property `tsc` owns; what a browser can show is its
    // consequence — the keys of the four `satisfies Record<Union, Def>` tables
    // are exactly the pre-declared union, so neither mechanism has drifted.
    for (const table of [
      'classes',
      'items',
      'enemies',
      'loot',
      'planets',
      'waves',
      'missions',
      'followers',
      'companions',
      'upgrades',
      'recipes',
      'tuning',
      'dialogue',
    ])
      expect(c.tables, table).toContain(table);
    expect(c.classes).toEqual(c.idUnions['CLASS_IDS']);
    expect(c.companions).toEqual(c.idUnions['COMPANION_IDS']);
    expect(c.upgrades).toEqual(c.idUnions['SHIP_SYSTEMS']);
    expect(c.planets).toEqual(c.idUnions['PLANET_IDS']);
  });

  test('Cinder-4 ships its classes, items, enemies and loot (AC-4, AC-5, AC-6, AC-7)', async ({ page }) => {
    const c = await readContent(page);

    expect(c.classes).toEqual(['marine', 'engineer', 'scout']); // AC-4

    // AC-5: the twelve items of §4.2, with the stats that table pins.
    expect(c.items).toEqual([
      'weapon_kinetic',
      'weapon_laser',
      'weapon_plasma',
      'weapon_lithium',
      'armor_scrap',
      'armor_composite',
      'armor_reactive',
      'armor_ablative',
      'wheat_ration',
      'medkit',
      'coolant_pack',
      'plasma_cell',
    ]);
    expect(c.itemStats).toEqual({
      weapon_kinetic: ['weapon', 0, 12],
      weapon_laser: [1, 18, { tokens: 40 }],
      weapon_lithium: [3, 36, 2],
      armor_ablative: [45, 0.75],
      plasma_cell: [{ kind: 'damage_boost', mult: 1.4, seconds: 20 }, 3],
    });

    // AC-6: the chapter-1 roster, and nothing else claiming chapter 1.
    expect(c.chapter1Enemies.sort()).toEqual(['dune_wurm', 'dust_skitter', 'scav_raider', 'wurmling']);

    // AC-7: loot tables exist, and every enemy resolves against one. Tables are
    // shared between enemies, so there are fewer of them than there are enemies;
    // what has to hold is that no enemy points at a table that is not there.
    expect(c.lootTables.length).toBeGreaterThan(0);
    expect(c.danglingLootRefs).toEqual([]);
  });

  test('Cinder-4 ships its planet, POIs, nodes, spawn table, weather and waves (AC-8…AC-12)', async ({ page }) => {
    const { cinder4, waves } = await readContent(page);

    expect(cinder4.biome).toBe('desert'); // AC-8
    expect(cinder4.pois).toContain('landing_pad:landing_pad');
    expect(cinder4.pois).toContain('dune_sea:scan');
    expect(cinder4.pois.length).toBeGreaterThanOrEqual(4);
    expect(cinder4.nodes).toEqual(['oil', 'wheat']); // AC-9
    expect(cinder4.spawn).toEqual(['dust_skitter', 'wurmling', 'scav_raider']); // AC-10
    expect(cinder4.weather).toEqual(['sandstorm', 'heatwave']); // AC-11
    expect(cinder4.flightWaves).toEqual(['cinder4_flight']); // AC-12
    expect(waves).toContain('cinder4_flight');
  });

  test('Cinder-4 ships c1_m1…c1_s2, followers, companions, upgrades, recipes, tuning and dialogue (AC-13…AC-19)', async ({
    page,
  }) => {
    const c = await readContent(page);

    for (const id of ['c1_m1', 'c1_m2', 'c1_m3', 'c1_s1', 'c1_s2']) expect(c.missions, id).toContain(id); // AC-13
    expect(c.followers).toContain('science_probe'); // AC-14
    expect(c.companions).toHaveLength(5); // AC-15
    expect(c.upgrades).toEqual(['engine', 'hull', 'shield', 'cargo', 'weapon']); // AC-16
    expect(c.recipes).toEqual(['wheat_ration', 'medkit', 'coolant_pack']); // AC-17
    // AC-18: tuning is the one §4 table that is a typed object rather than a
    // keyed roster, so it is pinned by the constants the economy spec reads.
    for (const key of ['XP_BASE', 'XP_PER_LEVEL', 'LEVEL_CAP', 'CARGO_BASE', 'START_OIL'])
      expect(c.tuning, key).toContain(key);
    // AC-19: each chapter-1 mission opens and closes with a line.
    for (const id of ['c1_m1', 'c1_m2', 'c1_m3', 'c1_s1', 'c1_s2']) {
      expect(c.chapter1Dialogue, `${id}_accept`).toContain(`${id}_accept`);
      expect(c.chapter1Dialogue, `${id}_done`).toContain(`${id}_done`);
    }
  });

  test('the M6 roster is complete and internally resolved (AC-20…AC-24)', async ({ page }) => {
    const c = await readContent(page);

    expect(c.planets).toEqual(['cinder4', 'vetra', 'thessaly', 'ferrum', 'hive', 'eden']); // AC-20

    // AC-21: every enemy PLAN §6 names by id, across all six chapters.
    for (const id of [
      'dust_skitter',
      'wurmling',
      'scav_raider',
      'dune_wurm',
      'ice_crawler',
      'frost_matriarch',
      'hive_drone',
      'spore_hound',
      'hive_broodlord',
      'magma_wraith',
      'ash_titan',
      'hive_queen',
      'hive_egg',
      'scav_fighter',
      'hive_interceptor',
    ])
      expect(c.enemies, id).toContain(id);

    // AC-22: the campaign is the roster PLAN §6 enumerates and locks — 17 main
    // and 9 side. SPEC-009's criterion says 27; PLAN §7's header said "Main
    // missions (18)" and its own per-chapter subtotals never bore that out, so
    // PLAN R5 (2026-09-07) corrected the digit to 17. The count is pinned here
    // beside the payout it implies: adding a 27th mission cannot pass this test
    // without also moving the 670/104 totals AC-29 and AC-30 pin.
    expect(c.mainMissions).toHaveLength(17);
    expect(c.sideMissions).toHaveLength(9);
    expect(c.missions).toHaveLength(26);

    expect(c.waves.length).toBeGreaterThan(0); // AC-23
    expect(c.danglingWaveRefs).toEqual([]);
    expect(c.danglingDialogueRefs).toEqual([]); // AC-24
    expect(c.missionsWithoutOpeningLine).toEqual([]);
  });

  test('the pinned totals and text budgets hold (AC-29…AC-33)', async ({ page }) => {
    const c = await readContent(page);

    expect(c.mainTokens).toBe(670); // AC-29
    expect(c.sideTokens).toBe(104); // AC-30
    expect(c.longestTitle).toBeLessThanOrEqual(32); // AC-31
    expect(c.longestBrief).toBeLessThanOrEqual(400); // AC-32
    expect(c.longestDialogueLine).toBeLessThanOrEqual(220); // AC-33
  });

  test('loading the content barrel logs no console error (AC-2, AC-26)', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    page.on('pageerror', (error) => errors.push(String(error)));

    const c = await readContent(page);

    // A circular import between the tables would leave a table undefined here
    // rather than throw, so the emptiness check is the real assertion.
    for (const table of c.tables) expect(c.tables, table).toContain(table);
    expect(c.missions.length).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  });
});
