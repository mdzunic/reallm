#!/usr/bin/env node
// Builds the Blender-generated assets (PLAN R7): every model, ground texture,
// VFX sprite and portrait under public/assets/ that is not audio. Each
// generator is a Python script run by Blender headless; nothing is downloaded.
//
//   node scripts/assets/blender/build.mjs                    # everything
//   node scripts/assets/blender/build.mjs character ships    # some generators
//   node scripts/assets/blender/build.mjs props --only=desert_rock_a
//   node scripts/assets/blender/build.mjs --preview=/tmp/p   # also render QA previews
//
// Blender is found through $BLENDER, then the usual install paths, then PATH.
// Written against Blender 5.2 LTS; `--python-exit-code 1` turns a Python error
// into a failed build instead of a silent success.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, '..', '..', '..', 'public', 'assets');
const GENERATORS = ['character', 'ships', 'station', 'props', 'ground', 'sprites', 'portraits'];

function findBlender() {
  if (process.env.BLENDER) return process.env.BLENDER;
  const candidates = [
    '/Applications/Blender.app/Contents/MacOS/Blender',
    '/usr/bin/blender',
    '/snap/bin/blender',
    'C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe',
  ];
  return candidates.find((path) => existsSync(path)) ?? 'blender';
}

const args = process.argv.slice(2);
const preview = args.find((arg) => arg.startsWith('--preview='));
const only = args.find((arg) => arg.startsWith('--only='))?.slice('--only='.length).split(',').filter(Boolean) ?? [];
const names = args.filter((arg) => !arg.startsWith('--'));
const unknown = names.filter((name) => !GENERATORS.includes(name));
if (unknown.length > 0) {
  console.error(`unknown generator(s): ${unknown.join(', ')} — choose from ${GENERATORS.join(', ')}`);
  process.exit(2);
}

const blender = findBlender();
const started = Date.now();
for (const name of names.length > 0 ? names : GENERATORS) {
  const script = join(HERE, `${name}.py`);
  console.log(`\n== ${name} ==`);
  const result = spawnSync(
    blender,
    ['--background', '--factory-startup', '--python-exit-code', '1', '--python', script, '--', `--out=${OUT}`, ...(preview ? [preview] : []), ...only],
    { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  // Blender is chatty; keep our own lines (ASSET/PREVIEW/WARN) and any traceback.
  const lines = (result.stdout ?? '').split('\n');
  const keep = lines.filter((line) => /^(ASSET|PREVIEW|WARN|NOTE)|Traceback|Error|^\s+File /.test(line));
  if (keep.length > 0) console.log(keep.join('\n'));
  if (result.error) {
    console.error(`could not start Blender (${blender}): ${result.error.message}\nset $BLENDER to the Blender 5.2 executable`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(lines.slice(-40).join('\n'));
    console.error(`${name}.py failed with exit code ${result.status}`);
    process.exit(1);
  }
}
writeLicenses();
console.log(`\ndone in ${((Date.now() - started) / 1000).toFixed(1)} s — now run: node scripts/assets/check.mjs`);

// ---------------------------------------------------------------- LICENSES.md
// The rows for generated files live between two markers and are rewritten from
// what is on disk, so the table cannot drift from the build.
function writeLicenses() {
  const GENERATED = [
    [/^models\/character\.glb$/, 'character.py', 'rigged salvager, clips Idle · Run · Attack · Hit · Death'],
    [/^models\/(ship|fighter|interceptor|probe)\.glb$/, 'ships.py', 'modelled from code'],
    [/^models\/(station_ring|dock|cockpit|crate)\.glb$/, 'station.py', 'modelled from code'],
    [/^models\/props\/.+\.glb$/, 'props.py', 'unit prop, biome colours in vertex colours'],
    [/^textures\/ground\/.+\.webp$/, 'ground.py', 'baked seamless 4D noise/Voronoi fields, packed with numpy'],
    [/^textures\/sprites\/.+\.webp$/, 'sprites.py', 'numpy radial and noise fields'],
    [/^portraits\/.+\.(webp|json)$/, 'portraits.py', 'EEVEE bust of the salvager'],
  ];
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(full.slice(OUT.length + 1).split('\\').join('/'));
    }
  };
  walk(OUT);
  const rows = files
    .map((rel) => [rel, GENERATED.find(([pattern]) => pattern.test(rel))])
    .filter(([, match]) => match)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([rel, [, script, what]]) => `| \`${rel}\` | Original to this repository — ${what}; generated in Blender by \`scripts/assets/blender/${script}\` | CC0 | — |`);
  const path = join(OUT, 'LICENSES.md');
  const text = readFileSync(path, 'utf8');
  const start = '<!-- blender:start -->';
  const end = '<!-- blender:end -->';
  const i = text.indexOf(start);
  const j = text.indexOf(end);
  if (i < 0 || j < i) {
    console.warn('WARN LICENSES.md has no blender markers; rows not written');
    return;
  }
  const table = ['', '| File | Source | License | Modifications |', '| --- | --- | --- | --- |', ...rows, ''].join('\n');
  writeFileSync(path, text.slice(0, i + start.length) + table + text.slice(j));
  console.log(`NOTE LICENSES.md: ${rows.length} generated files listed`);
}
