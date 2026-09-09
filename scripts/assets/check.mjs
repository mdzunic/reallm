#!/usr/bin/env node
// Validates `public/assets/` against the SPEC-001 §10 budgets and the
// LICENSES.md convention (PLAN R6-3, scripts/assets/README.md). Pure Node, no
// dependencies. Exit code 1 on any failure so it can gate a PR.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'assets');
const MB = 1024 * 1024;

/** Byte budgets per top-level folder (SPEC-001 §10; portraits from SPEC-020 §4.6). */
const BUDGETS = {
  models: 4 * MB,
  audio: 12 * MB,
  textures: 6 * MB,
  portraits: 0.5 * MB,
};
const TOTAL_BUDGET = 25 * MB;
const ALLOWED = new Set(['.glb', '.webm', '.mp3', '.png', '.webp', '.json', '.md']);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && entry.name !== '.gitkeep') out.push(full);
  }
  return out;
}

function fmt(bytes) {
  return `${(bytes / MB).toFixed(2)} MB`;
}

const files = walk(ROOT);
const licenses = readFileSync(join(ROOT, 'LICENSES.md'), 'utf8');
const failures = [];
const perFolder = new Map();
let total = 0;

for (const file of files) {
  const rel = relative(ROOT, file).split(sep).join('/');
  const size = statSync(file).size;
  total += size;
  const folder = rel.includes('/') ? rel.slice(0, rel.indexOf('/')) : '';
  perFolder.set(folder, (perFolder.get(folder) ?? 0) + size);

  const ext = rel.slice(rel.lastIndexOf('.')).toLowerCase();
  if (!ALLOWED.has(ext)) failures.push(`${rel}: extension ${ext} is not one the specs allow (${[...ALLOWED].join(' ')})`);

  if (rel === 'LICENSES.md') continue;
  if (!licenses.includes(`\`${rel}\``)) failures.push(`${rel}: no row in LICENSES.md (expected a backticked path \`${rel}\`)`);
}

for (const [folder, bytes] of perFolder) {
  const budget = BUDGETS[folder];
  const line = `${(folder || '(root)').padEnd(10)} ${fmt(bytes).padStart(10)}${budget ? ` of ${fmt(budget)}` : ''}`;
  console.log(line);
  if (budget !== undefined && bytes > budget) failures.push(`${folder}/ is ${fmt(bytes)}, over its ${fmt(budget)} budget`);
}
console.log(`${'total'.padEnd(10)} ${fmt(total).padStart(10)} of ${fmt(TOTAL_BUDGET)}`);
if (total > TOTAL_BUDGET) failures.push(`public/assets is ${fmt(total)}, over the ${fmt(TOTAL_BUDGET)} precache budget`);

if (failures.length > 0) {
  console.error(`\n${failures.length} problem(s):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`\nOK — ${files.length} files, every one listed in LICENSES.md, every budget met.`);
