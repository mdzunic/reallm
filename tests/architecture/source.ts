// Shared reader for the source-scanning architecture tests (`noMathRandom`,
// `visitCount`): a rule that bans a shape in `src/` must not also ban writing
// that shape down in a comment, so every scanner blanks comments first.
// Not a `.test.ts` file — it holds no suites, only the helper they share.

/**
 * `source` with its line and block comments blanked out. Strings and template
 * literals are tracked, so a `//` inside `'https://…'` does not swallow the rest
 * of the line. Regex literals are not: a `//` inside one would be read as a
 * comment start, which can only ever hide banned code written after a regex
 * on the same line — a trade this helper makes knowingly, in exchange for having
 * no parser in it.
 */
export function stripComments(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        // Keep the newlines so reported positions and line counts survive.
        if (source[i] === '\n') out += '\n';
        i++;
      }
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      out += ch;
      i++;
      while (i < source.length && source[i] !== ch) {
        if (source[i] === '\\') {
          out += source[i] as string;
          i++;
        }
        if (i < source.length) {
          out += source[i] as string;
          i++;
        }
      }
      out += source[i] ?? '';
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}
