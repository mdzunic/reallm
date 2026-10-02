// CI's e2e parts are planned by time (scripts/e2e/shard.mjs): every part of a
// run computes the same plan on its own, so what is pinned here is that the
// plan covers each test exactly once, keeps serial groups whole, is the same
// on every call, and balances by time rather than by count.
//
// The planner is plain `.mjs`, run by node in CI, so its shapes are declared
// here, as `tests/assets/icons.test.ts` does for the icon generator.
import { describe, expect, it } from 'vitest';
// @ts-expect-error — a plain-JS CI script, deliberately untyped (see above).
import * as shardModule from '../../scripts/e2e/shard.mjs';
// @ts-expect-error — as above.
import * as timingsModule from '../../scripts/e2e/timings.mjs';

interface ListedTest {
  project: string;
  file: string;
  titles: string[];
  line: number;
  durations: number[];
}
interface Unit {
  key: string;
  seconds: number;
  tests: number;
  rank: number;
}
interface Part {
  keys: string[];
  seconds: number;
  work: number;
  tests: number;
}

const shard = shardModule as {
  testKey(project: string, file: string, titles: string[]): string;
  reportTests(report: unknown): ListedTest[];
  planUnits(
    tests: ListedTest[],
    timings: Record<string, number>,
    options?: { projects?: string[]; serialProjects?: Set<string>; serialFiles?: Set<string> },
  ): { units: Unit[]; unknown: number };
  partSeconds(units: Unit[], workers: number): number;
  packParts(units: Unit[], parts: number, workers: number): Part[];
};
const timings = timingsModule as {
  timingsFrom(reports: unknown[]): Record<string, number>;
  mergeTimings(old: Record<string, number>, fresh: Record<string, number>, listed: string[]): Record<string, number>;
};

/** A Playwright JSON report: `files[file] = [[titles, projects, durations?]]`. */
function report(files: Record<string, Array<[string[], string[], number[]?]>>): unknown {
  return {
    suites: Object.entries(files).map(([file, specs]) => {
      // Nest describes the way the JSON reporter does: one suite per title.
      const root = { title: file, file, specs: [] as unknown[], suites: [] as unknown[] };
      for (const [titles, projects, durations = []] of specs) {
        let suite = root;
        for (const describe of titles.slice(0, -1)) {
          let child = (suite.suites as Array<typeof root>).find((s) => s.title === describe);
          if (!child) {
            child = { title: describe, file, specs: [], suites: [] };
            suite.suites.push(child);
          }
          suite = child;
        }
        suite.specs.push({
          title: titles.at(-1),
          file,
          line: 1,
          tests: projects.map((projectName) => ({
            projectName,
            results: durations.map((seconds) => ({ duration: seconds * 1000 })),
          })),
        });
      }
      return root;
    }),
  };
}

const unit = (key: string, seconds: number, rank: number): Unit => ({ key, seconds, tests: 1, rank });

describe('the e2e part planner (scripts/e2e/shard.mjs)', () => {
  it('keys a test the way `playwright test --test-list` reads it', () => {
    expect(shard.testKey('chromium', 'SPEC-040.spec.ts', ['the governor (E68)', '3. steps down'])).toBe(
      '[chromium] › SPEC-040.spec.ts › the governor (E68) › 3. steps down',
    );
    expect(shard.testKey('mobile', 'SPEC-015.spec.ts', [])).toBe('[mobile] › SPEC-015.spec.ts');
  });

  it('reads describes, projects and attempts out of a JSON report', () => {
    const tests = shard.reportTests(
      report({ 'a.spec.ts': [[['group', 'one'], ['chromium', 'mobile'], [3, 2]], [['two'], ['chromium']]] }),
    );
    expect(tests.map((t) => [t.project, t.file, t.titles, t.durations])).toEqual([
      ['chromium', 'a.spec.ts', ['two'], []],
      ['chromium', 'a.spec.ts', ['group', 'one'], [3, 2]],
      ['mobile', 'a.spec.ts', ['group', 'one'], [3, 2]],
    ]);
  });

  it('keeps a serial project or file in one unit, and plans an untimed test at its file’s median', () => {
    const tests = shard.reportTests(
      report({
        'p.spec.ts': [[['a'], ['chromium']], [['b'], ['chromium']], [['c'], ['chromium']], [['d'], ['chromium']]],
        's.spec.ts': [[['x'], ['chromium']], [['y'], ['chromium']]],
        'm.spec.ts': [[['z'], ['mobile']], [['w'], ['mobile']]],
      }),
    );
    const times: Record<string, number> = {
      '[chromium] › p.spec.ts › a': 10,
      '[chromium] › p.spec.ts › b': 20,
      '[chromium] › p.spec.ts › c': 60,
      '[chromium] › s.spec.ts › x': 5,
      '[chromium] › s.spec.ts › y': 7,
      '[mobile] › m.spec.ts › z': 4,
    };
    const { units, unknown } = shard.planUnits(tests, times, {
      projects: ['chromium', 'mobile'],
      serialProjects: new Set(['mobile']),
      serialFiles: new Set(['s.spec.ts']),
    });
    expect(unknown).toBe(2);
    expect(Object.fromEntries(units.map((u) => [u.key, [u.seconds, u.tests]]))).toEqual({
      '[chromium] › p.spec.ts › a': [10, 1],
      '[chromium] › p.spec.ts › b': [20, 1],
      '[chromium] › p.spec.ts › c': [60, 1],
      '[chromium] › p.spec.ts › d': [20, 1], // the median of 10, 20, 60
      '[chromium] › s.spec.ts': [12, 2],
      '[mobile] › m.spec.ts': [8, 2], // z, and w at the file's median of 4
    });
    // Playwright queues the config's projects in order, whatever the file order.
    const mobile = units.find((u) => u.key.startsWith('[mobile]'));
    expect(Math.min(...units.filter((u) => u.key.startsWith('[chromium]')).map((u) => u.rank))).toBeLessThan(
      mobile?.rank ?? -1,
    );
    expect(Math.max(...units.filter((u) => u.key.startsWith('[chromium]')).map((u) => u.rank))).toBeLessThan(
      mobile?.rank ?? -1,
    );
  });

  it('runs a part the way the dispatcher does: in queue order, to the first free worker', () => {
    // A long unit queued last runs alone at the end.
    expect(shard.partSeconds([unit('a', 10, 0), unit('b', 10, 1), unit('c', 30, 2)], 2)).toBe(40);
    // Queued first, it overlaps the rest.
    expect(shard.partSeconds([unit('c', 30, 0), unit('a', 10, 1), unit('b', 10, 2)], 2)).toBe(30);
  });

  it('balances by time, covers every unit once and plans the same on every call', () => {
    // 40 short tests and 4 long ones: by count, a part could get every long one.
    const units = [
      ...Array.from({ length: 40 }, (_, i) => unit(`short ${String(i).padStart(2, '0')}`, 6, i)),
      ...Array.from({ length: 4 }, (_, i) => unit(`long ${i}`, 120, 40 + i)),
    ];
    const plan = shard.packParts(units, 4, 2);
    const keys = plan.flatMap((p) => p.keys);
    expect(keys.length).toBe(units.length);
    expect(new Set(keys).size).toBe(units.length);
    // 720 s of work on 8 workers is 90 s, but the long units are queued last:
    // a part holding one behind its share of the short ones would run 150 s.
    // Two to a part, side by side, the plan holds at the 120 s a long one takes.
    expect(Math.max(...plan.map((p) => p.seconds))).toBe(120);
    expect(shard.packParts([...units].reverse(), 4, 2)).toEqual(plan);
  });

  it('puts two units queued last in one part, side by side, rather than each alone at the end of its own', () => {
    const units = [
      ...Array.from({ length: 20 }, (_, i) => unit(`chromium ${String(i).padStart(2, '0')}`, 10, i)),
      unit('[phone] one', 100, 20),
      unit('[phone] two', 90, 21),
    ];
    const plan = shard.packParts(units, 2, 2);
    const phones = plan.find((p) => p.keys.includes('[phone] one'));
    expect(phones?.keys).toContain('[phone] two');
    // 390 s of work on 4 workers is ~98 s; each phone file alone at the end of
    // its part would have made both parts 150 s.
    expect(Math.max(...plan.map((p) => p.seconds))).toBeLessThanOrEqual(110);
  });
});

describe('the timings refresh (scripts/e2e/timings.mjs)', () => {
  it('takes each test’s fastest attempt, to the tenth of a second', () => {
    const fresh = timings.timingsFrom([
      report({ 'a.spec.ts': [[['one'], ['chromium'], [30.04, 12.31]]] }),
      report({ 'a.spec.ts': [[['one'], ['chromium'], [12.26]], [['two'], ['chromium']]] }),
    ]);
    expect(fresh).toEqual({ '[chromium] › a.spec.ts › one': 12.3 });
  });

  it('overlays fresh times on the old, keeps an unrun test’s, and drops a test no longer listed', () => {
    expect(timings.mergeTimings({ kept: 4, gone: 9, old: 1 }, { old: 2, new: 3 }, ['new', 'old', 'kept', 'untimed'])).toEqual({
      kept: 4,
      new: 3,
      old: 2,
    });
  });
});
