#!/usr/bin/env node
// The stand-in build (scripts/assets/README.md §7): SPEC-052's world-art drop
// made where Blender 5.2, numpy and PIL are not installed — the factory's
// arm64 containers. It is not a second pipeline; it runs the first one as far
// as it can and stands in only for what it cannot run:
//
//   * props, cave — the generators themselves (scripts/assets/blender/props.py,
//     cave.py) run under plain Python 3, with blender_api/ standing in for
//     `bpy`, `bmesh` and `mathutils`; the builders, their primitives'
//     topology, the exporter's layout and every contract are the generators'
//     own. glb.mjs then does what `export_meshopt_compression_enable` does.
//     The twenty `_a`/`_b` props are not rebuilt from noise this API cannot
//     reproduce: their Blender exports are re-encoded (§4.3 — same builders,
//     same triangles, no TEXCOORD_0, meshopt).
//   * foliage, ground, items — numpy painting, Cycles bakes and EEVEE renders
//     have no Python stand-in, so foliage.mjs, ground.mjs and items.mjs port
//     those generators' SPEC-052 parts step for step, and webp.mjs encodes
//     through Chromium's libwebp. They rebuild only what SPEC-052 changed:
//     the atlas, the four re-authored ground layers and `detail_nr`, and the
//     seven new pictures.
//
// A Blender 5.2 build of the same generators replaces every file this writes
// (52-g: same contracts, not the same bytes), and tests/assets/worldArt.test.ts
// pins the contracts either way.
//
//   node scripts/assets/standin/build.mjs props foliage ground cave items
//   node scripts/assets/standin/build.mjs props --only=jungle_tree_a,landmark_ice
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeLicenses } from '../blender/build.mjs';
import { compressGlb, readGlb } from './glb.mjs';
import { openCodec } from './webp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BLENDER_DIR = resolve(HERE, '..', 'blender');
const OUT = resolve(HERE, '..', '..', '..', 'public', 'assets');

/** The `_a` and `_b` props SPEC-052 §4.3 rebuilds: today's builders, today's shapes. */
const REENCODED = [
  'desert_rock', 'desert_ruin', 'ice_rock', 'ice_spire', 'jungle_ruin',
  'volcanic_rock', 'volcanic_vent', 'hive_spire', 'hive_rock', 'temperate_rock',
].flatMap((kind) => [`${kind}_a`, `${kind}_b`]);

/** What props.py makes that the stand-in runs it for: the trees, the `_c`s and the landmarks. */
const PROPS_NEW = [
  ...['jungle_tree', 'temperate_tree'].flatMap((kind) => ['a', 'b', 'c'].map((v) => `${kind}_${v}`)),
  ...['desert_rock', 'desert_ruin', 'ice_rock', 'ice_spire', 'jungle_ruin', 'volcanic_rock', 'volcanic_vent',
    'hive_spire', 'hive_rock', 'temperate_rock'].map((kind) => `${kind}_c`),
  ...['desert', 'ice', 'jungle', 'volcanic', 'hive', 'temperate'].map((biome) => `landmark_${biome}`),
];

const GENERATORS = ['props', 'foliage', 'ground', 'cave', 'items'];

/** Run a Blender generator under the stand-in API; compress what it asked to. */
function runPython(script, ids, out) {
  const result = spawnSync('python3', [join(HERE, 'blender_api', 'run.py'), join(BLENDER_DIR, script), '--', `--out=${out}`, ...ids], {
    stdio: ['ignore', 'pipe', 'inherit'],
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw new Error(`could not start python3: ${result.error.message}`);
  const lines = (result.stdout ?? '').split('\n');
  if (result.status !== 0) {
    console.error(lines.slice(-40).join('\n'));
    throw new Error(`${script} failed under the stand-in with exit code ${result.status}`);
  }
  for (const line of lines) if (/^(ASSET|WARN|NOTE)/.test(line)) console.log(line);
  return lines.filter((line) => line.startsWith('STANDIN meshopt ')).map((line) => line.slice('STANDIN meshopt '.length));
}

async function compressAll(paths, out) {
  for (const path of paths) {
    const bytes = await compressGlb(readFileSync(path));
    writeFileSync(path, bytes);
    console.log(`NOTE meshopt ${relative(out, path)} ${bytes.length} bytes`);
  }
}

/** §4.3: the Blender export of an `_a`/`_b`, without its UVs and meshopt-compressed (once). */
async function reencode(name, out) {
  const path = join(out, 'models', 'props', `${name}.glb`);
  const bytes = readFileSync(path);
  const { json } = readGlb(bytes);
  if (json.extensionsRequired?.includes('EXT_meshopt_compression')) return;
  const packed = await compressGlb(bytes, { dropTexcoords: true });
  writeFileSync(path, packed);
  console.log(`ASSET models/props/${name}.glb ${packed.length} bytes (was ${bytes.length}), re-encoded`);
}

async function main() {
  const args = process.argv.slice(2);
  const only = args.find((arg) => arg.startsWith('--only='))?.slice('--only='.length).split(',').filter(Boolean) ?? [];
  const out = resolve(args.find((arg) => arg.startsWith('--out='))?.slice('--out='.length) ?? OUT);
  const preview = args.find((arg) => arg.startsWith('--preview='))?.slice('--preview='.length) || null;
  const names = args.filter((arg) => !arg.startsWith('--'));
  const unknown = names.filter((name) => !GENERATORS.includes(name));
  if (unknown.length > 0) throw new Error(`unknown generator(s): ${unknown.join(', ')} — choose from ${GENERATORS.join(', ')}`);
  const wanted = (id) => only.length === 0 || only.includes(id);
  const started = Date.now();
  let codec = null;
  try {
    for (const name of names.length > 0 ? names : GENERATORS) {
      console.log(`\n== ${name} (stand-in) ==`);
      if (name === 'props') {
        const ids = PROPS_NEW.filter(wanted);
        if (ids.length > 0) await compressAll(runPython('props.py', ids, out), out);
        for (const id of REENCODED.filter(wanted)) await reencode(id, out);
      } else if (name === 'cave') {
        await compressAll(runPython('cave.py', only, out), out);
      } else {
        codec ??= await openCodec();
        const module = await import(`./${name}.mjs`);
        await module.build({ out, only, preview, codec });
      }
    }
  } finally {
    await codec?.close();
  }
  if (out === OUT) writeLicenses();
  console.log(`\ndone in ${((Date.now() - started) / 1000).toFixed(1)} s — now run: node scripts/assets/check.mjs`);
}

// Listed so a reader can see the stand-in never touches the rest of the set.
export { GENERATORS, PROPS_NEW, REENCODED };

if (existsSync(OUT) && process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
