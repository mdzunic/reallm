// A three-function shim for the things a test cannot get any other way.
//
// `tests/ui/theme.test.ts` has to read `src/style.css` as text (SPEC-020
// AC-27). Vitest replaces every `.css` import with an empty module — `?raw`
// included, because the rule is keyed to the extension — so Vite's usual
// `import.meta.glob(..., '?raw')` route, which every architecture test uses for
// `.ts` sources, returns `''` for a stylesheet. The suite runs in the `node`
// environment, so `node:fs` is there at runtime; only its types are missing,
// and installing `@types/node` is a dependency change no spec has had business
// making. This declares exactly what is used and nothing else.
//
// SPEC-015 adds the binary overload: `tests/assets/icons.test.ts` reads each
// generated PNG's IHDR header, which is bytes, not text (AC-63, AC-64). It is
// typed as `Uint8Array` rather than `Buffer` so no `@types/node` is implied.
declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function readFileSync(path: string): Uint8Array;
}
