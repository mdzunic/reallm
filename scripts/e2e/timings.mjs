#!/usr/bin/env node
// Refreshes `scripts/e2e/timings.json`, the per-test times `shard.mjs` plans
// CI's e2e parts with, from the JSON reports CI uploads with every run
// (`e2e-report-*` artifacts, .github/workflows/check.yml):
//
//   gh run download <run-id> -p 'e2e-report-*' -D /tmp/e2e-reports
//   node scripts/e2e/timings.mjs /tmp/e2e-reports/*/*.json
//
// Take a run of main — every part of it, so the times come from one set of
// runners. A test's time is its fastest attempt: a retry is noise around the
// test, not the test. Times from these reports replace the ones on file;
// tests the suite no longer lists are dropped; tests the reports did not run
// keep their old time.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TIMINGS, listSuite, reportTests, testKey } from './shard.mjs';

/** `{ key: seconds }` from Playwright JSON run reports, fastest attempt, 0.1 s. */
export function timingsFrom(reports) {
  const times = {};
  for (const report of reports) {
    for (const test of reportTests(report)) {
      if (test.durations.length === 0) continue;
      const key = testKey(test.project, test.file, test.titles);
      times[key] = Math.min(times[key] ?? Infinity, ...test.durations);
    }
  }
  for (const key of Object.keys(times)) times[key] = Math.round(times[key] * 10) / 10;
  return times;
}

/** Old times overlaid with new ones, limited to `listed` keys, sorted for a readable diff. */
export function mergeTimings(old, fresh, listed) {
  const merged = {};
  for (const key of [...listed].sort()) {
    const seconds = fresh[key] ?? old[key];
    if (seconds !== undefined) merged[key] = seconds;
  }
  return merged;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error('usage: timings.mjs <playwright-json-report>...');
    process.exit(1);
  }
  const fresh = timingsFrom(files.map((file) => JSON.parse(readFileSync(file, 'utf8'))));
  const keys = reportTests(listSuite()).map((t) => testKey(t.project, t.file, t.titles));
  const old = JSON.parse(readFileSync(TIMINGS, 'utf8')).tests;
  const tests = mergeTimings(old, fresh, keys);
  writeFileSync(TIMINGS, `${JSON.stringify({ tests }, null, 2)}\n`);
  const missing = keys.length - Object.keys(tests).length;
  console.log(`${Object.keys(fresh).length} times from ${files.length} report(s); ${Object.keys(tests).length} on file, ${missing} listed test(s) without one`);
}
