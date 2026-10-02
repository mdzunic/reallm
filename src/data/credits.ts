// The credits a player reads (SPEC-044 §4.9). The menu's Credits panel used to
// print `public/assets/LICENSES.md` verbatim — a maintainer's table that names
// every file, the escape ending's shots among them. These sections say who and
// what made the game in a player's words; the licence file stays one link
// away, and PLAN R12-6's Gemini credit stays visible in the game.
//
// `Version` is filled in at render from `__APP_VERSION__`: data modules are
// plain objects, with no imports but other data and no functions (SPEC-001 §4).

export interface CreditSection {
  readonly title: string;
  readonly lines: readonly string[];
}

/** The line the renderer completes with the build's version. */
export const CREDITS_VERSION_LINE = 'Version';

export const CREDITS: readonly CreditSection[] = [
  {
    title: 'ReaLLM',
    lines: [CREDITS_VERSION_LINE, 'The source code is released under the Apache License 2.0.'],
  },
  {
    title: 'Built with',
    lines: ['three.js · Howler.js · Vite · TypeScript'],
  },
  {
    title: 'Pictures and films',
    lines: [
      "Models, textures, portraits, item pictures and the story films are generated in Blender from scripts in this game's repository. Original work, released under CC0.",
    ],
  },
  {
    title: 'Photographs',
    lines: [
      'The photographic plates in the story films and the Selection cards were generated with Google Gemini for this repository, and are released under CC0.',
    ],
  },
  {
    title: 'Sound',
    lines: [
      "Every sound effect and music loop is synthesised by scripts in this game's repository. Original work, released under CC0.",
    ],
  },
];
