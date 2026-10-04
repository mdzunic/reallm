#!/usr/bin/env node
// Builds the Blender-generated assets (PLAN R7, R8): every model, ground
// texture, VFX sprite, portrait, flight map, foliage atlas and cave piece under
// public/assets/ that is not audio. Each generator is a Python script run by
// Blender headless; nothing is downloaded.
//
//   node scripts/assets/blender/build.mjs                    # everything
//   node scripts/assets/blender/build.mjs character ships    # some generators
//   node scripts/assets/blender/build.mjs props --only=desert_rock_a
//   node scripts/assets/blender/build.mjs props foliage ground cave items   # SPEC-052's world-art drop
//   node scripts/assets/blender/build.mjs --preview=/tmp/p   # also render QA previews
//
// Blender is found through $BLENDER, then the usual install paths, then PATH.
// Written against Blender 5.2 LTS; `--python-exit-code 1` turns a Python error
// into a failed build instead of a silent success.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, '..', '..', '..', 'public', 'assets');
const GENERATORS = ['character', 'ships', 'station', 'props', 'ground', 'sprites', 'portraits', 'items', 'flight', 'foliage', 'cave'];
// Opt-in: a full film build takes hours, so `build.mjs` alone never starts one
// (PLAN R9, SPEC-021 §5.1). `--frames=DIR`, `--draft`, `--stills`,
// `--shots=a,b` and `--at=s,s` pass through to it.
const OPT_IN = ['films'];
const PASS = (arg) =>
  arg.startsWith('--frames=') || arg.startsWith('--shots=') || arg.startsWith('--at=') || arg === '--draft' || arg === '--stills';

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

// Run as a script, not when the stand-in build (scripts/assets/standin/) imports
// writeLicenses below.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();

function main() {
  const args = process.argv.slice(2);
  const preview = args.find((arg) => arg.startsWith('--preview='));
  const only = args.find((arg) => arg.startsWith('--only='))?.slice('--only='.length).split(',').filter(Boolean) ?? [];
  const names = args.filter((arg) => !arg.startsWith('--'));
  const unknown = names.filter((name) => !GENERATORS.includes(name) && !OPT_IN.includes(name));
  if (unknown.length > 0) {
    console.error(`unknown generator(s): ${unknown.join(', ')} — choose from ${[...GENERATORS, ...OPT_IN].join(', ')}`);
    process.exit(2);
  }

  const blender = findBlender();
  const started = Date.now();
  for (const name of names.length > 0 ? names : GENERATORS) {
    const script = join(HERE, `${name}.py`);
    console.log(`\n== ${name} ==`);
    const result = spawnSync(
      blender,
      ['--background', '--factory-startup', '--python-exit-code', '1', '--python', script, '--', `--out=${OUT}`, ...(preview ? [preview] : []), ...args.filter(PASS), ...only],
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
  writeLicenses({ ran: new Set((names.length > 0 ? names : GENERATORS).map((name) => `${name}.py`)) });
  console.log(`\ndone in ${((Date.now() - started) / 1000).toFixed(1)} s — now run: node scripts/assets/check.mjs`);
}

// ---------------------------------------------------------------- LICENSES.md
// The rows for generated files live between two markers and are rewritten from
// what is on disk, so the table cannot drift from the build.
//
// SPEC-052: a file the stand-in build wrote (scripts/assets/standin/, a machine
// without Blender) says so in its row — `standIn` maps each path it wrote to
// 'built' or 'reencoded' — and keeps saying so until Blender re-runs the
// generator that owns it (`ran`, the scripts this build ran; all by default).
export function writeLicenses({ ran = null, standIn = new Map() } = {}) {
  const GENERATED = [
    [/^models\/character\.glb$/, 'character.py', 'rigged salvager, clips Idle · Run · Attack · Hit · Death'],
    [/^models\/(ship|fighter|interceptor|probe)\.glb$/, 'ships.py', 'modelled from code, hull maps baked in Cycles'],
    [/^models\/cockpit\.glb$/, 'station.py', 'modelled from code, hull and screen maps baked in Cycles'],
    [/^models\/(station_ring|dock|crate)\.glb$/, 'station.py', 'modelled from code'],
    [/^models\/asteroid\.glb$/, 'flight.py', 'two rocks, normals baked from a displaced high-poly'],
    [/^textures\/flight\/sky_.+\.webp$/, 'flight.py', 'sky window baked from Noise/Voronoi fields'],
    [/^textures\/flight\/clouds\.webp$/, 'flight.py', 'cloud cover baked from Noise fields'],
    [/^textures\/flight\/planet_.+\.webp$/, 'flight.py', 'planet map baked from Noise/Voronoi fields'],
    // SPEC-052: the trees and the landmarks are props.py's too, under their own contracts
    [/^models\/props\/(jungle|temperate)_tree_[abc]\.glb$/, 'props.py', 'tree under the SPEC-052 contract: bark and leaf cards on the foliage atlas, LOD1 inside'],
    [/^models\/props\/landmark_.+\.glb$/, 'props.py', 'landmark set piece authored in metres, colours in vertex colours (SPEC-052)'],
    [/^models\/props\/.+\.glb$/, 'props.py', 'unit prop, biome colours in vertex colours'],
    [/^models\/cave\/.+\.glb$/, 'cave.py', 'cave kit modelled from code (SPEC-052)'],
    [/^textures\/ground\/.+\.webp$/, 'ground.py', 'baked seamless 4D noise/Voronoi fields, packed with numpy'],
    [/^textures\/foliage\/.+\.webp$/, 'foliage.py', 'leaf, grass and bark atlas painted from code (SPEC-052)'],
    [/^textures\/sprites\/.+\.webp$/, 'sprites.py', 'numpy radial and noise fields'],
    [/^portraits\/.+\.(webp|json)$/, 'portraits.py', 'EEVEE bust of the salvager'],
    [/^items\/(relic_[a-z_]+|flare|stim)\.webp$/, 'items.py', 'item picture built from primitives, rendered on transparent (SPEC-052 §4.8)'],
    [/^items\/.+\.(webp|json)$/, 'items.py', 'item picture built from primitives, rendered in EEVEE on transparent (SPEC-031)'],
    // R11, R12, SPEC-051 §4.9: some shots are photographic plates, so their film and poster say so
    [/^films\/(prologue|interlude_c1|interlude_c2|interlude_c3|interlude_c5|ending_stay|ending_escape)\.mp4$/, 'films.py', 'story film rendered in EEVEE from code over the photographic plates listed under Plates above (PLAN R9, R11, R12)'],
    [/^films\/posters\/(prologue_(curfew|sabotage|reprisal|city_flash|stranded|shelter|selection|liftoff)|interlude_c1_shelter_light|interlude_c2_tap|interlude_c3_greenhouse|interlude_c5_board|ending_(stay_wall_63|escape_wall_same|escape_earth_unmade))\.webp$/, 'films.py', 'story film poster, a frame of a plate shot (PLAN R11, R12)'],
    [/^films\/[^/]+\.mp4$/, 'films.py', 'story film rendered in EEVEE from code (PLAN R9)'],
    [/^films\/posters\/.+\.webp$/, 'films.py', 'story film poster, a frame of its shot (PLAN R9)'],
    [/^films\/manifest\.json$/, 'films.py', 'story film manifest (PLAN R9)'],
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
  const path = join(OUT, 'LICENSES.md');
  const text = readFileSync(path, 'utf8');
  const start = '<!-- blender:start -->';
  const end = '<!-- blender:end -->';
  const i = text.indexOf(start);
  const j = text.indexOf(end);
  const STAND_IN = 'the stand-in build without Blender (`scripts/assets/standin/`, SPEC-052)';
  const previous = new Map();
  if (i >= 0 && j > i) {
    for (const line of text.slice(i, j).split('\n')) {
      const m = /^\| `([^`]+)` \|/.exec(line);
      if (m) previous.set(m[1], line);
    }
  }
  const rows = files
    .map((rel) => [rel, GENERATED.find(([pattern]) => pattern.test(rel))])
    .filter(([, match]) => match)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([rel, [, script, what]]) => {
      const source = `scripts/assets/blender/${script}`;
      const how = standIn.get(rel);
      if (how === 'built') return `| \`${rel}\` | Original to this repository — ${what}; generated from \`${source}\` by ${STAND_IN} | CC0 | — |`;
      if (how === 'reencoded') return `| \`${rel}\` | Original to this repository — ${what}; generated in Blender by \`${source}\`, meshopt-compressed without UVs by ${STAND_IN} | CC0 | — |`;
      const kept = previous.get(rel);
      if (kept?.includes('stand-in build') && ran !== null && !ran.has(script)) return kept;
      return `| \`${rel}\` | Original to this repository — ${what}; generated in Blender by \`${source}\` | CC0 | — |`;
    });
  if (i < 0 || j < i) {
    console.warn('WARN LICENSES.md has no blender markers; rows not written');
    return;
  }
  const table = ['', '| File | Source | License | Modifications |', '| --- | --- | --- | --- |', ...rows, ''].join('\n');
  writeFileSync(path, text.slice(0, i + start.length) + table + text.slice(j));
  console.log(`NOTE LICENSES.md: ${rows.length} generated files listed`);
}
