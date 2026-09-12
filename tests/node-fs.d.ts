// A two-function shim for the one thing a test cannot get any other way.
//
// `tests/ui/theme.test.ts` has to read `src/style.css` as text (SPEC-020
// AC-27). Vitest replaces every `.css` import with an empty module — `?raw`
// included, because the rule is keyed to the extension — so Vite's usual
// `import.meta.glob(..., '?raw')` route, which every architecture test uses for
// `.ts` sources, returns `''` for a stylesheet. The suite runs in the `node`
// environment, so `node:fs` is there at runtime; only its types are missing,
// and installing `@types/node` is a dependency change this spec has no business
// making. This declares exactly what is used and nothing else.
declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string;
}
