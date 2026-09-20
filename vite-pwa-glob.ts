// The glob half of the PWA plugin (`vite-pwa.ts`), split out because it is the
// one piece of that file with no `node:` imports: it is pure, so it is unit
// tested in node like every other pure module in this repository
// (SPEC-001 §4). A mistake here is silent — a pattern that stops matching
// `index.html` does not fail a build, it ships an app that cannot start
// offline — which is exactly the kind of rule that earns a test.
//
// The syntax supported is the whole of what SPEC-015 §10's patterns use:
// `**` (any depth, including none), `*` (one path segment), `?` (one
// character) and `{a,b,c}` alternation.

const escape = (char: string): string => char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** One glob as an anchored `RegExp` over a `/`-separated, relative path. */
export function globToRegExp(pattern: string): RegExp {
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i] as string;
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          // `**/` crosses directory boundaries and also matches none of them,
          // so `**/*.js` matches `index.js` as well as `a/b/index.js`.
          source += '(?:[^/]*/)*';
          i += 2;
        } else {
          source += '.*';
          i += 1;
        }
      } else source += '[^/]*';
    } else if (char === '?') source += '[^/]';
    else if (char === '{') {
      const close = pattern.indexOf('}', i);
      if (close === -1) source += '\\{';
      else {
        source += `(?:${pattern
          .slice(i + 1, close)
          .split(',')
          .map(escape)
          .join('|')})`;
        i = close;
      }
    } else source += escape(char);
  }
  return new RegExp(`^${source}$`);
}

/** True when `path` matches any of `patterns` (an empty list matches nothing). */
export function matchesAny(patterns: readonly RegExp[], path: string): boolean {
  return patterns.some((pattern) => pattern.test(path));
}
