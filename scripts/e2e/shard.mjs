#!/usr/bin/env node
// CI's e2e parts, balanced by time (.github/workflows/check.yml).
//
// `--shard` splits the suite by test count, never by time. With 534 tests on
// four parts that left a part of SPEC-042's scene tests at ten minutes beside
// one at eight, and the budget had to grow every few specs (#57, #60, #66,
// #67). This plans the parts from what each test took on CI instead:
//
//   node scripts/e2e/shard.mjs --part 2/5 --out part.txt [--workers 2] [--budget-ms 780000]
//
// lists the suite (`playwright test --list`), packs it onto the parts so the
// longest one runs as short as it can — modelling how Playwright hands a
// part's groups to its workers (`partSeconds`) — and writes this part's tests
// in the format `playwright test --test-list` reads. Every part computes the whole plan from
// the same commit, so the parts agree without talking to each other, and each
// test is in exactly one of them (checked before anything is written).
//
// A test runs where its group runs. A project with `fullyParallel: false` and a
// file with `test.describe.configure({ mode: 'default' | 'serial' })` keep their
// tests in one worker, in order, so those move as one unit, and the unit's
// time is the sum of its tests.
//
// The times are `scripts/e2e/timings.json`, written by `timings.mjs` from the
// JSON reports CI uploads. A test it does not know yet — every new spec's —
// is planned at the median of its file's known tests, else of the whole suite,
// so a stale file degrades the balance slowly and never drops a test.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const TIMINGS = join(REPO, 'scripts', 'e2e', 'timings.json');

/** `[project] › file › title › …` — the line `--test-list` matches, and the timings key. */
export function testKey(project, file, titles) {
  return [`[${project}]`, file, ...titles].join(' › ');
}

/**
 * The tests of a Playwright JSON report (`--list` or a run), in report order:
 * `{ project, file, titles, line, durations }`, `durations` in seconds, one
 * per attempt (empty for `--list`). `file` is relative to the config's
 * rootDir, as `--test-list` wants it.
 */
export function reportTests(report) {
  const out = [];
  const walk = (suite, titles) => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        out.push({
          project: test.projectName,
          file: spec.file,
          titles: [...titles, spec.title],
          line: spec.line,
          durations: (test.results ?? []).map((result) => result.duration / 1000),
        });
      }
    }
    for (const child of suite.suites ?? []) walk(child, [...titles, child.title]);
  };
  // A file's own suite is titled with the file; its specs start a title path.
  for (const file of report.suites ?? []) walk(file, []);
  return out;
}

const median = (values) => {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/**
 * Groups `tests` into the units a worker runs whole, each with its planned
 * seconds and its `rank` in Playwright's queue: `projects` is the config's
 * project order, and within a project the report's file and test order
 * stands. `serialProjects` and `serialFiles` (file names relative to the
 * rootDir) are the groups that stay in one worker.
 */
export function planUnits(tests, timings, { projects = [], serialProjects = new Set(), serialFiles = new Set() } = {}) {
  const project = (name) => (projects.includes(name) ? projects.indexOf(name) : projects.length);
  const queue = tests.map((test, index) => ({ test, index }));
  queue.sort((a, b) => project(a.test.project) - project(b.test.project) || a.index - b.index);
  const rank = new Map(queue.map(({ test }, i) => [test, i]));

  const known = new Map();
  for (const test of tests) {
    const seconds = timings[testKey(test.project, test.file, test.titles)];
    if (seconds === undefined) continue;
    const file = `${test.project} ${test.file}`;
    if (!known.has(file)) known.set(file, []);
    known.get(file).push(seconds);
  }
  const fallback = median([...known.values()].flat()) ?? 10;

  const units = new Map();
  let unknown = 0;
  for (const test of tests) {
    const whole = serialProjects.has(test.project) || serialFiles.has(test.file);
    const key = whole ? testKey(test.project, test.file, []) : testKey(test.project, test.file, test.titles);
    let seconds = timings[testKey(test.project, test.file, test.titles)];
    if (seconds === undefined) {
      unknown++;
      seconds = median(known.get(`${test.project} ${test.file}`) ?? []) ?? fallback;
    }
    const unit = units.get(key) ?? { key, seconds: 0, tests: 0, rank: rank.get(test) };
    unit.seconds += seconds;
    unit.tests++;
    units.set(key, unit);
  }
  return { units: [...units.values()], unknown };
}

/**
 * How long a part runs: Playwright hands its groups to the first free worker
 * strictly in queue order — config project order, then file, then test — so a
 * long unit queued last starts late and runs alone. `units` must be in that
 * order (`rank`).
 */
export function partSeconds(units, workers) {
  const free = Array.from({ length: workers }, () => 0);
  for (const unit of units) {
    let soonest = 0;
    for (let i = 1; i < workers; i++) if (free[i] < free[soonest]) soonest = i;
    free[soonest] += unit.seconds;
  }
  return Math.max(...free);
}

const byKey = (a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/**
 * Fills `parts` parts in Playwright's queue order without letting any run past
 * `limit` seconds: each unit goes to the part it fills most tightly — the
 * latest finish that still fits, then the lowest part. Packing the early
 * units tightly leaves whole parts free for the long serial groups queued
 * last, which then run side by side instead of each alone at the end of a
 * full part. Answers the parts' units, or null when something does not fit.
 */
function fillParts(queue, parts, workers, limit) {
  const plan = Array.from({ length: parts }, () => ({ units: [], free: Array.from({ length: workers }, () => 0) }));
  for (const unit of queue) {
    let best;
    let bestEnd = -Infinity;
    for (const part of plan) {
      const end = Math.min(...part.free) + unit.seconds;
      if (end <= limit + 1e-9 && end > bestEnd + 1e-9) {
        best = part;
        bestEnd = end;
      }
    }
    if (!best) return null;
    best.free[best.free.indexOf(Math.min(...best.free))] = bestEnd;
    best.units.push(unit);
  }
  return plan.map((part) => part.units);
}

/**
 * Packs the units onto `parts` parts of `workers` workers so the longest part
 * runs (`partSeconds`, in queue order) as short as it can. Each unit carries
 * `rank`, its place in Playwright's queue. Nothing here depends on anything
 * but the units, so every part computes the same plan. Answers each part's
 * keys, tests, planned seconds and work (summed worker-seconds).
 */
export function packParts(units, parts, workers) {
  const byRank = (a, b) => a.rank - b.rank || byKey(a, b);
  const queue = [...units].sort(byRank);
  const total = queue.reduce((n, unit) => n + unit.seconds, 0);

  // The shortest limit `fillParts` meets, to the second.
  let low = Math.max(total / (parts * workers), ...queue.map((unit) => unit.seconds));
  let high = total;
  let filled = fillParts(queue, parts, workers, high);
  while (high - low > 1) {
    const mid = (low + high) / 2;
    const attempt = fillParts(queue, parts, workers, mid);
    if (attempt) [high, filled] = [mid, attempt];
    else low = mid;
  }
  const work = (list) => list.reduce((n, u) => n + u.seconds, 0);
  const plan = filled.map((list) => ({ units: list, seconds: partSeconds(list, workers), work: work(list) }));

  // Polish: move a unit, or swap two long ones, between two parts whenever
  // that shortens the longer of the two. The longest part never grows, and
  // every step strictly shrinks a pair, so this ends; the order of tries is
  // fixed, so it is deterministic.
  const LONG = 30;
  const tryChange = (x, y, fromX, fromY) => {
    const nextX = [...x.units.filter((u) => !fromX.includes(u)), ...fromY].sort(byRank);
    const nextY = [...y.units.filter((u) => !fromY.includes(u)), ...fromX].sort(byRank);
    const sx = partSeconds(nextX, workers);
    const sy = partSeconds(nextY, workers);
    if (Math.max(sx, sy) >= Math.max(x.seconds, y.seconds) - 1e-9) return false;
    Object.assign(x, { units: nextX, seconds: sx, work: work(nextX) });
    Object.assign(y, { units: nextY, seconds: sy, work: work(nextY) });
    return true;
  };
  for (let changed = true, rounds = 0; changed && rounds < 200; rounds++) {
    changed = false;
    for (const x of plan) {
      for (const y of plan) {
        if (x === y || x.seconds < y.seconds) continue;
        for (const u of x.units) if (x.units.includes(u) && tryChange(x, y, [u], [])) changed = true;
        for (const u of x.units.filter((v) => v.seconds >= LONG))
          for (const v of y.units.filter((w) => w.seconds >= LONG && w.seconds < u.seconds))
            if (x.units.includes(u) && y.units.includes(v) && tryChange(x, y, [u], [v])) changed = true;
      }
    }
  }

  return plan.map((part) => ({
    keys: part.units.map((unit) => unit.key).sort(),
    seconds: part.seconds,
    work: part.work,
    tests: part.units.reduce((n, unit) => n + unit.tests, 0),
  }));
}

/** Files whose tests a `describe.configure` keeps in one worker, relative to `testDir`. */
export function serialFilesIn(testDir, files) {
  const serial = new Set();
  for (const file of files) {
    const source = readFileSync(join(testDir, file), 'utf8');
    if (/describe\.configure\(\s*\{[^}]*mode:\s*['"](?:default|serial)['"]/.test(source)) serial.add(file);
  }
  return serial;
}

function parseArgs(argv) {
  const args = { workers: 2, budgetMs: undefined, part: undefined, out: undefined };
  for (let i = 0; i < argv.length; i++) {
    const [name, value] = [argv[i], argv[i + 1]];
    if (name === '--part') args.part = value;
    else if (name === '--out') args.out = value;
    else if (name === '--workers') args.workers = Number(value);
    else if (name === '--budget-ms') args.budgetMs = Number(value);
    else throw new Error(`unknown argument ${name}`);
    i++;
  }
  const match = /^(\d+)\/(\d+)$/.exec(args.part ?? '');
  if (!match || !args.out) throw new Error('usage: shard.mjs --part N/M --out FILE [--workers 2] [--budget-ms MS]');
  args.index = Number(match[1]);
  args.parts = Number(match[2]);
  if (args.index < 1 || args.index > args.parts) throw new Error(`--part ${args.part}: no such part`);
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const listed = spawnSync('npx', ['playwright', 'test', '--list', '--reporter=json'], {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (listed.status !== 0) throw new Error(`playwright test --list failed:\n${listed.stderr}`);
  const report = JSON.parse(listed.stdout);
  const tests = reportTests(report);

  const config = (await import(pathToFileURL(join(REPO, 'playwright.config.ts')).href)).default;
  const serialProjects = new Set(
    config.projects.filter((p) => (p.fullyParallel ?? config.fullyParallel) === false).map((p) => p.name),
  );
  const serialFiles = serialFilesIn(report.config.rootDir, new Set(tests.map((t) => t.file)));
  const timings = JSON.parse(readFileSync(TIMINGS, 'utf8')).tests;

  const projects = config.projects.map((p) => p.name);
  const { units, unknown } = planUnits(tests, timings, { projects, serialProjects, serialFiles });
  const plan = packParts(units, args.parts, args.workers);

  // Every test in exactly one part, before a part runs a subset of a subset.
  const assigned = plan.reduce((n, part) => n + part.tests, 0);
  if (assigned !== tests.length) throw new Error(`planned ${assigned} tests of ${tests.length}`);

  const part = plan[args.index - 1];
  writeFileSync(args.out, `${part.keys.join('\n')}\n`);

  const minutes = (s) => (s / 60).toFixed(1);
  console.log(`${tests.length} tests, ${unknown} without a timing; ${args.parts} parts × ${args.workers} workers:`);
  plan.forEach((p, i) =>
    console.log(
      `  ${i + 1 === args.index ? '>' : ' '} part ${i + 1}/${args.parts}: ${String(p.tests).padStart(3)} tests, ~${minutes(p.seconds)} min (${minutes(p.work)} worker-min)`,
    ),
  );
  // Visible on the run, early: the plan is drifting toward the budget, or the
  // timings are too old to plan with. Neither fails the part.
  const longest = Math.max(...plan.map((p) => p.seconds));
  if (args.budgetMs && longest * 1000 > 0.75 * args.budgetMs)
    console.log(`::warning::the longest e2e part plans at ~${minutes(longest)} min of a ${minutes(args.budgetMs / 1000)} min budget`);
  if (unknown > 0.2 * tests.length)
    console.log(`::warning::${unknown} of ${tests.length} e2e tests have no timing; refresh scripts/e2e/timings.json (scripts/e2e/timings.mjs)`);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
