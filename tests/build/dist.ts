// SPEC-016 §11 — is `dist/` the build of this tree?
//
// The emitted-build tests of `pwa.test.ts` read `dist/`, and must never judge
// a build older than the tree: they skip unless `dist/index.html` is newer than
// every build input, and say why when they do (16-l, 16-m). `vite build`
// rewrites `dist/index.html` on every build, so a fresh build is always newer
// than what it was built from, and a test run straight after one reads this
// commit's output — the order §11 gives `npm run check`.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export type DistFreshness = { ok: true } | { ok: false; reason: 'missing' | 'stale'; newer?: string };

/** The files a build reads besides `src/` and `public/`, in the order they are checked (D-29). */
export const BUILD_INPUT_FILES: readonly string[] = ['index.html', 'vite.config.ts', 'package.json', 'package-lock.json', 'tsconfig.json'];
/** The folders every file of which is a build input, walked in this order. */
export const BUILD_INPUT_DIRS: readonly string[] = ['src', 'public'];

/** Every file under `dir`, root-relative with `/`, depth-first with entries sorted by name. */
function filesUnder(root: string, dir: string): string[] {
  const out: string[] = [];
  const entries = readdirSync(join(root, dir), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...filesUnder(root, rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

/**
 * `missing` when `root/dist/index.html` is absent; `stale`, naming the first
 * input found, when a build input was modified after it; `ok` otherwise. An
 * input that does not exist is skipped, and one with the same modification
 * time as the build is not newer than it.
 */
export function distFreshness(root: string): DistFreshness {
  const built = join(root, 'dist', 'index.html');
  if (!existsSync(built)) return { ok: false, reason: 'missing' };
  const builtAt = statSync(built).mtimeMs;

  const inputs: string[] = [];
  for (const file of BUILD_INPUT_FILES) if (existsSync(join(root, file))) inputs.push(file);
  for (const dir of BUILD_INPUT_DIRS) if (existsSync(join(root, dir))) inputs.push(...filesUnder(root, dir));

  for (const input of inputs) {
    if (statSync(join(root, input)).mtimeMs > builtAt) return { ok: false, reason: 'stale', newer: input };
  }
  return { ok: true };
}

/** The suffix the emitted-build describe carries when it skips, and none when it runs. */
export function skipNote(freshness: DistFreshness): string {
  if (freshness.ok) return '';
  return freshness.reason === 'missing'
    ? ' (skipped: dist/index.html is missing)'
    : ` (skipped: ${freshness.newer ?? 'a build input'} is newer than dist/)`;
}
