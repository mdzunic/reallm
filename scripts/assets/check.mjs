#!/usr/bin/env node
// Validates the shipped asset set against the SPEC-001 §10 budgets and the
// LICENSES.md convention (PLAN R6-3, scripts/assets/README.md). Pure Node, no
// dependencies. Exit code 1 on any failure so it can gate a PR.
//
// SPEC-015 D-11 widened the 25 MB total from `public/assets/` to the whole
// *precachable* set, because that is the number the service worker actually
// has to download on a first visit: `public/assets/`, plus `public/icons/` and
// `public/favicon.svg`, plus — when a `dist/` is present — the built output the
// workbox `globPatterns` of §10 match. No new npm script: SPEC-001 pins the
// list, so this stays `node scripts/assets/check.mjs`.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ROOT = join(REPO, 'public', 'assets');
const ICONS = join(REPO, 'public', 'icons');
const FAVICON = join(REPO, 'public', 'favicon.svg');
const DIST = join(REPO, 'dist');
const MB = 1024 * 1024;

/** Byte budgets per top-level folder (SPEC-001 §10; portraits from SPEC-020 §4.6; films from PLAN R9). */
const BUDGETS = {
  models: 4 * MB,
  audio: 12 * MB,
  textures: 6 * MB,
  portraits: 0.5 * MB,
  items: 1 * MB,
  films: 12 * MB,
};
const TOTAL_BUDGET = 25 * MB;
const ALLOWED = new Set(['.glb', '.webm', '.mp3', '.mp4', '.png', '.webp', '.json', '.md', '.svg']);

/** SPEC-015 §10's `globPatterns`, as extensions — what the worker precaches. */
const PRECACHE_EXTENSIONS = new Set([
  '.js',
  '.css',
  '.html',
  '.glb',
  '.webm',
  '.mp3',
  '.mp4',
  '.png',
  '.webp',
  '.svg',
  '.json',
]);

/** SPEC-015 §10.1: the three app icons and the pixel size each one promises. */
const ICON_SIZES = {
  'icon-192.png': 192,
  'icon-512.png': 512,
  'apple-touch-icon-180.png': 180,
};

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

function ext(path) {
  const at = path.lastIndexOf('.');
  return at < 0 ? '' : path.slice(at).toLowerCase();
}

/** Width and height out of a PNG's IHDR — the first chunk, always (AC-64). */
function pngSize(file) {
  const bytes = readFileSync(file);
  if (bytes.length < 24) return null;
  if (bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return null;
  if (bytes.subarray(12, 16).toString('ascii') !== 'IHDR') return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
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

  if (!ALLOWED.has(ext(rel))) {
    failures.push(`${rel}: extension ${ext(rel)} is not one the specs allow (${[...ALLOWED].join(' ')})`);
  }

  if (rel === 'LICENSES.md') continue;
  if (!licenses.includes(`\`${rel}\``)) failures.push(`${rel}: no row in LICENSES.md (expected a backticked path \`${rel}\`)`);
}

for (const [folder, bytes] of perFolder) {
  const budget = BUDGETS[folder];
  const line = `${(folder || '(root)').padEnd(10)} ${fmt(bytes).padStart(10)}${budget ? ` of ${fmt(budget)}` : ''}`;
  console.log(line);
  if (budget !== undefined && bytes > budget) failures.push(`${folder}/ is ${fmt(bytes)}, over its ${fmt(budget)} budget`);
}

// ------------------------------------------------ SPEC-015 §10.1: the icons

let iconBytes = 0;
if (!existsSync(ICONS)) {
  failures.push('public/icons/ is missing — run `node scripts/assets/icons.mjs` (SPEC-015 §10.1)');
} else {
  const iconFiles = walk(ICONS);
  for (const file of iconFiles) {
    const name = relative(ICONS, file).split(sep).join('/');
    const rel = `icons/${name}`;
    iconBytes += statSync(file).size;
    if (!ALLOWED.has(ext(name))) failures.push(`${rel}: extension ${ext(name)} is not one the specs allow`);
    if (!licenses.includes(`\`${rel}\``)) failures.push(`${rel}: no row in LICENSES.md (expected a backticked path \`${rel}\`)`);
  }
  for (const [name, expected] of Object.entries(ICON_SIZES)) {
    const file = join(ICONS, name);
    if (!existsSync(file)) {
      failures.push(`icons/${name} is missing — run \`node scripts/assets/icons.mjs\``);
      continue;
    }
    const size = pngSize(file);
    if (size === null) failures.push(`icons/${name} is not a readable PNG`);
    else if (size.width !== expected || size.height !== expected) {
      failures.push(`icons/${name} is ${size.width}×${size.height}, not ${expected}×${expected}`);
    }
  }
  console.log(`${'icons'.padEnd(10)} ${fmt(iconBytes).padStart(10)}`);
}

let faviconBytes = 0;
if (existsSync(FAVICON)) faviconBytes = statSync(FAVICON).size;
else failures.push('public/favicon.svg is missing — index.html and the app icons both come from it');

// ------------------------------------- SPEC-015 D-11: the precache total

/** Everything a first visit downloads, in bytes, and where it came from. */
let precache = total + iconBytes + faviconBytes;
let distBytes = 0;
let distCount = 0;
if (existsSync(DIST)) {
  // A built tree already contains a copy of `public/`, so it replaces the
  // source total rather than adding to it — otherwise every asset is counted
  // twice and the budget reads double.
  for (const file of walk(DIST)) {
    if (!PRECACHE_EXTENSIONS.has(ext(file))) continue;
    distBytes += statSync(file).size;
    distCount++;
  }
  precache = distBytes;
  console.log(`${'dist'.padEnd(10)} ${fmt(distBytes).padStart(10)} (${distCount} precachable files)`);
}

console.log(`${'total'.padEnd(10)} ${fmt(total).padStart(10)} of ${fmt(TOTAL_BUDGET)} (public/assets)`);
console.log(`${'precache'.padEnd(10)} ${fmt(precache).padStart(10)} of ${fmt(TOTAL_BUDGET)} (${existsSync(DIST) ? 'dist/' : 'public/'})`);
if (precache > TOTAL_BUDGET) {
  failures.push(`the precachable set is ${fmt(precache)}, over the ${fmt(TOTAL_BUDGET)} budget (SPEC-015 AC-53)`);
}

if (failures.length > 0) {
  console.error(`\n${failures.length} problem(s):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`\nOK — ${files.length} asset files, every one listed in LICENSES.md, every budget met.`);
