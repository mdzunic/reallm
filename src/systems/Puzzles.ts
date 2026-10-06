// The puzzles (SPEC-055 §3, §4.1–§4.5): five kinds of lock — conduit routing,
// lights-out calibration and sequence completion on a terminal, pressure
// plates and a mirror beam on the cave floor — with the rules that play them,
// solvers that work from any state, and hints that are a solver's first move.
// Pure: no `three`, no DOM, no clock, so the panel, the world puzzles, the
// debug strip and the tests all read one answer.
//
// Every board is built from a solved state or a constructed path and then
// scrambled (§2): solvability is a property of the generator, which
// `tests/systems/puzzles.test.ts` proves over hundreds of seeds per row,
// rather than a hope a slow solver checks at run time.
//
// A site's board comes from `puzzleFork(layout(planet), site, 0)` (§4.1). A
// fork derives from the layout seed and never moves the stream it came from,
// so the same save plays the same board on every visit and no layout pin
// moves; a wrong sequence pick deals the next fork (§4.2). Boards change in
// place — `applyMove` mutates the board it is handed — and the scene keeps one
// per site for the visit (55-a).
//
// Grids are row-major, `cell = row × n + col`: row 0 is north (−z), column 0
// west (−x). A side is a bit — N 1, E 2, S 4, W 8 — so a cell's open sides are
// one mask, and a clockwise quarter turn (N → E → S → W) shifts it left by one.
import type { Rng } from '@/core/Rng';
import {
  HUMAN_LOCK,
  PUZZLE_DIFFICULTY,
  SEQUENCE_PHRASES,
  type PuzzleKind,
  type SequenceFamily,
  type SequencePhrase,
} from '@/data/index';

export type { PuzzleKind, SequenceFamily } from '@/data/puzzles';

// ------------------------------------------------------------- the boards (§3)

/** §3: a cell's side as a bit — N 1 (−z), E 2 (+x), S 4 (+z), W 8 (−x). */
export type Side = 1 | 2 | 4 | 8;
/** §3: a conduit tile — empty, end, straight, elbow, tee, cross. */
export type Piece = 0 | 1 | 2 | 3 | 4 | 5;
/** The pieces' names by `Piece`, which a cell's label reads (§4.4). */
export const PIECE_NAMES = ['empty', 'end', 'straight', 'elbow', 'tee', 'cross'] as const;
/** §4.2: the mark a plate carries. */
export type Glyph = 'circle' | 'triangle' | 'square' | 'diamond' | 'star';
/** §4.2: every glyph, in the order a plate board shuffles. */
export const GLYPHS: readonly Glyph[] = ['circle', 'triangle', 'square', 'diamond', 'star'];

/** §4.2: tiles to turn until power entering at `source` reaches every sink. */
export interface ConduitPuzzle {
  kind: 'conduit';
  n: number;
  /** Per cell (`row × n + col`), a `Piece`. */
  pieces: Uint8Array;
  /** Per cell, quarter turns clockwise from the piece's rest (0–3). */
  rots: Uint8Array;
  /** On the west column; power enters across the board's edge on W. */
  source: { cell: number; side: Side };
  /** On the east column, each opening on the edge on E. */
  sinks: { cell: number; side: Side }[];
  /** The recorded rotation of each path cell, aligned with `path`: `solution[k]` is `path[k]`'s. */
  solution: Uint8Array;
  /** The path cells, source first — the main path to the first sink, then a second sink's branch. */
  path: Int16Array;
}

/** §4.2: lights-out — `lit[i]` 1 is a misaligned cell; `presses` is the k of the row that scrambled it. */
export interface CalibrationPuzzle {
  kind: 'calibration';
  n: number;
  lit: Uint8Array;
  presses: number;
}

/** §4.2: tokens with a trailing `?`, four choices, and the index of the one that completes them. */
export interface SequencePuzzle {
  kind: 'sequence';
  family: SequenceFamily;
  shown: string[];
  choices: string[];
  answer: number;
}

/** §4.2: plates to step on in `order` (indices into `plates`), and the panel that reads it out. */
export interface PlatesPuzzle {
  kind: 'plates';
  plates: { x: number; z: number; glyph: Glyph }[];
  order: number[];
  /** How many of `order` have been pressed in a row. */
  progress: number;
  panel: { x: number; z: number };
}

/** A mirror's state: 0 `/`, 1 `\`, 2 and 3 closed. */
type MirrorState = 0 | 1 | 2 | 3;

/**
 * §4.2: an n × n grid of `BEAM_CELL` m cells centred on the puzzle room;
 * `origin` is its min-x, min-z corner. The lens shines along `lens.dir`;
 * `receiver.dir` is the way the solved beam travels as it enters.
 */
export interface BeamPuzzle {
  kind: 'beam';
  n: number;
  origin: { x: number; z: number };
  lens: { cell: number; dir: Side };
  receiver: { cell: number; dir: Side };
  /** 0 `/` joins a cell's south-west and north-east corners, 1 `\` the other two; 2 and 3 block. */
  mirrors: { cell: number; state: 0 | 1 | 2 | 3 }[];
  /** The solving state of each mirror, aligned with `mirrors`. */
  solution: Uint8Array;
}

export type Puzzle = ConduitPuzzle | CalibrationPuzzle | SequencePuzzle | PlatesPuzzle | BeamPuzzle;

/** §3: a tap on a cell, a choice, a plate stepped on, or a mirror turned. */
export type PuzzleMove = { readonly cell: number } | { readonly choice: number } | { readonly plate: number } | { readonly mirror: number };

/** §4.1: where a world puzzle stands — SPEC-054's puzzle room, the panel room, and the caches to keep clear of. */
export interface PuzzleAnchor {
  room: { x: number; z: number; r: number };
  panelRoom?: { x: number; z: number; r: number };
  /** Points (caches) the plates, the panel and the beam's pieces keep clear of. */
  avoid?: readonly { x: number; z: number }[];
}

// ----------------------------------------------------------- tunables (§4.3)

/** §4.5: ARIA can force a lock after this much open time, summed over the visit… */
export const PUZZLE_BYPASS_SECONDS = 90;
/** …or after this many hints. */
export const PUZZLE_BYPASS_HINTS = 3;
/** §4.2 (*initial tuning*): a plate's radius, in metres. */
export const PLATE_RADIUS = 0.9;
/** §4.2 (*initial tuning*): plates stand at least this far apart, centre to centre. */
export const PLATE_SPACING = 3;
/** §4.2 (*initial tuning*): a beam grid cell's side, in metres. */
export const BEAM_CELL = 2;
/** §4.1: a relic terminal stands this far beyond `LANDMARK_FOOTPRINT` from its landmark. */
export const RELIC_CLEARANCE = 1.5;
/** §4.1: a vault terminal stands this far from the vault door, out in its corridor. */
export const VAULT_TERMINAL_OFFSET = 1.5;

const N: Side = 1;
const E: Side = 2;
const S: Side = 4;
const W: Side = 8;
const SIDES: readonly Side[] = [N, E, S, W];

/** The open sides of each piece at rotation 0: end N, straight N|S, elbow N|E, tee N|E|S, cross all four. */
const PIECE_MASKS = [0, N, N | S, N | E, N | E | S, 15] as const;
const EMPTY = 0;
const STRAIGHT = 2;
const ELBOW = 3;
const CROSS = 5;

/** §4.2: deterministic tries at a conduit path… */
const CONDUIT_TRIES = 200;
/** …each one capped at this many depth-first steps, main path and branch together. */
const CONDUIT_EXPANSIONS = 4000;
/** §4.2: the share of the free cells that take a decoy straight or elbow. */
const CONDUIT_FILL = 0.6;

/** §4.2: plates stand within the room's radius less this… */
const PLATE_ROOM_MARGIN = 2;
/** …this far from every cache… */
const PLATE_AVOID = 2;
/** …placed by up to this many rejection tries in all… */
const PLATE_TRIES = 600;
/** …starting over after this many misses in a row, which only a jammed layout in a small room reaches… */
const PLATE_JAM = 60;
/** …and, should every try fail, as a regular ring at this share of that reach. */
const PLATE_FALLBACK_RING = 0.85;
/** The ring's turns tried, per gap between two plates, for one that clears the caches. */
const PLATE_RING_TURNS = 24;
/** §4.2: a panel whose room centre lies this close to a cache… */
const PANEL_AVOID = 1.6;
/** …stands this far from that cache instead, on the centre's side. */
const PANEL_SHIFT = 2.5;

/** §4.2: a beam layout is re-drawn up to this many times… */
const BEAM_TRIES = 50;
/** …while its lens, a mirror or its receiver stands this close to a cache. */
const BEAM_AVOID = 1.5;

/** Where a world puzzle stands when the caller names no room — robustness only; the scene always passes SPEC-054's. */
const DEFAULT_ANCHOR: PuzzleAnchor = { room: { x: 0, z: 0, r: 8 }, panelRoom: { x: 20, z: 0, r: 8 } };

/** One row of a kind's difficulty table. */
type ConduitRow = NonNullable<(typeof PUZZLE_DIFFICULTY.conduit)[number]>;
type CalibrationRow = NonNullable<(typeof PUZZLE_DIFFICULTY.calibration)[number]>;
type PlatesRow = NonNullable<(typeof PUZZLE_DIFFICULTY.plates)[number]>;
type BeamRow = NonNullable<(typeof PUZZLE_DIFFICULTY.beam)[number]>;

// ------------------------------------------------------------ grid helpers

/** The cell across `side` from `cell` on an n × n grid, or −1 off the board. */
function neighbour(n: number, cell: number, side: number): number {
  const row = Math.floor(cell / n);
  const col = cell - row * n;
  if (side === N) return row > 0 ? cell - n : -1;
  if (side === E) return col < n - 1 ? cell + 1 : -1;
  if (side === S) return row < n - 1 ? cell + n : -1;
  if (side === W) return col > 0 ? cell - 1 : -1;
  return -1;
}

/** N ↔ S, E ↔ W. */
function opposite(side: number): number {
  return ((side << 2) | (side >> 2)) & 15;
}

/** The side of `a` that faces its neighbour `b`. */
function sideToward(n: number, a: number, b: number): Side {
  if (b === a - n) return N;
  if (b === a + n) return S;
  return b === a + 1 ? E : W;
}

/** Grid steps between two cells. */
function manhattan(n: number, a: number, b: number): number {
  return Math.abs(Math.floor(a / n) - Math.floor(b / n)) + Math.abs((a % n) - (b % n));
}

/** True for an integer index in [0, length). */
function inRange(i: number, length: number): boolean {
  return Number.isInteger(i) && i >= 0 && i < length;
}

/**
 * §4.3: a kind's row for `chapter` — the nearest defined row below it when the
 * chapter has none, else the first row (robustness only: callers pass the
 * chapters the table names).
 */
function rowFor<T>(rows: Readonly<Partial<Record<number, T>>>, chapter: number): T {
  const exact = rows[chapter];
  if (exact !== undefined) return exact;
  const chapters = Object.keys(rows)
    .map(Number)
    .sort((a, b) => a - b);
  let pick = chapters[0] as number;
  for (const c of chapters) if (c <= chapter) pick = c;
  return rows[pick] as T;
}

// ---------------------------------------------------------------- conduit

/** §4.2: the open sides of `piece` after `rot` clockwise quarter turns. */
export function conduitMask(piece: number, rot: number): number {
  let mask: number = PIECE_MASKS[piece] ?? 0;
  const turns = ((rot % 4) + 4) % 4;
  for (let i = 0; i < turns; i++) mask = ((mask << 1) | (mask >> 3)) & 15;
  return mask;
}

/** The piece and the least rotation whose open sides are exactly `mask`. */
function pieceFor(mask: number): { piece: Piece; rot: number } {
  for (let piece = 1; piece <= CROSS; piece++) {
    for (let rot = 0; rot < 4; rot++) if (conduitMask(piece, rot) === mask) return { piece: piece as Piece, rot };
  }
  return { piece: EMPTY, rot: 0 };
}

/** One cell's open sides as the board stands. */
function cellMask(p: ConduitPuzzle, cell: number): number {
  return conduitMask(p.pieces[cell] ?? EMPTY, p.rots[cell] ?? 0);
}

/**
 * §4.2: 1 for every cell the source's flood reaches — through sides open on
 * both cells, on the board — and 0 everywhere when the source cell is not
 * open on its outer side.
 */
export function poweredCells(p: ConduitPuzzle): Uint8Array {
  const out = new Uint8Array(p.n * p.n);
  const start = p.source.cell;
  if (!inRange(start, out.length) || (cellMask(p, start) & p.source.side) === 0) return out;
  out[start] = 1;
  const stack = [start];
  while (stack.length > 0) {
    const at = stack.pop() as number;
    const mask = cellMask(p, at);
    for (const side of SIDES) {
      if ((mask & side) === 0) continue;
      const next = neighbour(p.n, at, side);
      if (next < 0 || out[next] === 1 || (cellMask(p, next) & opposite(side)) === 0) continue;
      out[next] = 1;
      stack.push(next);
    }
  }
  return out;
}

/** §4.2: the source open on its edge, and every sink powered and open on its own. */
function conduitSolved(p: ConduitPuzzle): boolean {
  const powered = poweredCells(p);
  if (powered[p.source.cell] !== 1) return false;
  return p.sinks.every((sink) => powered[sink.cell] === 1 && (cellMask(p, sink.cell) & sink.side) !== 0);
}

/** A conduit route: the main path, a second sink's branch (empty with one sink), and the main-path index it leaves from. */
interface ConduitRoute {
  main: number[];
  branch: number[];
  branchAt: number;
}

/**
 * §4.2: a seeded depth-first walk with backtracking — neighbour order shuffled
 * at every cell — for a self-avoiding path from `from` to `to` of `lo`…`hi`
 * cells, both ends included, never entering `blocked`. A step is pruned when
 * the cells so far plus the steps still needed to reach `to` exceed `hi`, and
 * the walk gives up when `budget` runs out.
 */
function walk(
  n: number,
  from: number,
  to: number,
  lo: number,
  hi: number,
  blocked: Uint8Array | null,
  rng: Rng,
  budget: { left: number },
): number[] | null {
  if (from === to) return lo <= 1 && hi >= 1 ? [from] : null;
  if (manhattan(n, from, to) + 1 > hi) return null;
  const onPath = new Uint8Array(n * n);
  const path = [from];
  const orders: Side[][] = [rng.shuffle([N, E, S, W])];
  const tried = [0];
  onPath[from] = 1;
  while (path.length > 0) {
    const depth = path.length - 1;
    const at = path[depth] as number;
    const i = tried[depth] as number;
    if (i >= 4) {
      onPath[at] = 0;
      path.pop();
      orders.pop();
      tried.pop();
      continue;
    }
    tried[depth] = i + 1;
    const next = neighbour(n, at, (orders[depth] as Side[])[i] as Side);
    if (next < 0 || onPath[next] === 1 || (blocked !== null && blocked[next] === 1)) continue;
    const length = path.length + 1;
    if (next === to) {
      if (length < lo || length > hi) continue;
      path.push(next);
      return path;
    }
    if (length + manhattan(n, next, to) > hi) continue;
    if (--budget.left < 0) return null;
    onPath[next] = 1;
    path.push(next);
    orders.push(rng.shuffle([N, E, S, W]));
    tried.push(0);
  }
  return null;
}

/**
 * §4.2: one try at a route. Random source and sink rows, then a walk between
 * them inside the row's band. With two sinks the main path keeps to
 * `[n, hi − 1]` cells, the second sink takes a free east-column row, and a
 * second walk leaves a main-path cell (neither the source nor the first sink)
 * through a free neighbour, avoiding the main path, so the whole route keeps
 * to the band.
 */
function conduitRoute(n: number, sinks: 1 | 2, lo: number, hi: number, rng: Rng): ConduitRoute | null {
  const budget = { left: CONDUIT_EXPANSIONS };
  const from = rng.int(0, n - 1) * n;
  const to = rng.int(0, n - 1) * n + n - 1;
  const main = walk(n, from, to, sinks === 2 ? n : lo, sinks === 2 ? hi - 1 : hi, null, rng, budget);
  if (main === null) return null;
  if (sinks === 1) return { main, branch: [], branchAt: -1 };

  const taken = new Uint8Array(n * n);
  for (const cell of main) taken[cell] = 1;
  const ends: number[] = [];
  for (let row = 0; row < n; row++) if (taken[row * n + n - 1] === 0) ends.push(row * n + n - 1);
  const least = Math.max(1, lo - main.length);
  const most = hi - main.length;
  if (ends.length === 0 || most < least) return null;
  const end = rng.pick(ends);
  const starts: { at: number; cell: number }[] = [];
  for (let k = 1; k < main.length - 1; k++) {
    for (const side of SIDES) {
      const cell = neighbour(n, main[k] as number, side);
      if (cell >= 0 && taken[cell] === 0) starts.push({ at: k, cell });
    }
  }
  rng.shuffle(starts);
  for (const start of starts) {
    const branch = walk(n, start.cell, end, least, most, taken, rng, budget);
    if (branch !== null) return { main, branch, branchAt: start.at };
    if (budget.left < 0) return null;
  }
  return null;
}

/**
 * The route a row falls back on if all `CONDUIT_TRIES` fail — never for the
 * shipped rows, which the tests prove. Row 0 straight across, and a second
 * sink's branch dropping from the cell before the end to row 1: always a
 * valid board, if not one inside the band.
 */
function fallbackRoute(n: number, sinks: 1 | 2): ConduitRoute {
  const main: number[] = [];
  for (let col = 0; col < n; col++) main.push(col);
  return sinks === 1 ? { main, branch: [], branchAt: -1 } : { main, branch: [2 * n - 2, 2 * n - 1], branchAt: n - 2 };
}

/**
 * §4.2: the route, each path cell the piece and least rotation its sides imply
 * (the source opens W, the sinks E) — recorded as `solution` — then decoys on
 * 60 % of the free cells, then every path cell turned 1–3 quarter turns, and
 * the source once more while the board is still solved.
 */
function generateConduit(row: ConduitRow, rng: Rng): ConduitPuzzle {
  // At least 3, so the fallback's branch leaves a cell that is not the source — robustness only: the rows say 4 and 5.
  const n = Math.max(3, row.n);
  const [lo, hi] = row.path;
  let route: ConduitRoute | null = null;
  for (let attempt = 0; attempt < CONDUIT_TRIES && route === null; attempt++) route = conduitRoute(n, row.sinks, lo, hi, rng);
  route ??= fallbackRoute(n, row.sinks);
  const { main, branch, branchAt } = route;

  const cells = n * n;
  const open = new Uint8Array(cells);
  const link = (a: number, b: number): void => {
    open[a] = (open[a] as number) | sideToward(n, a, b);
    open[b] = (open[b] as number) | sideToward(n, b, a);
  };
  for (let k = 0; k + 1 < main.length; k++) link(main[k] as number, main[k + 1] as number);
  if (branch.length > 0) link(main[branchAt] as number, branch[0] as number);
  for (let k = 0; k + 1 < branch.length; k++) link(branch[k] as number, branch[k + 1] as number);
  const source = main[0] as number;
  const sinkCells = branch.length > 0 ? [main[main.length - 1] as number, branch[branch.length - 1] as number] : [main[main.length - 1] as number];
  open[source] = (open[source] as number) | W;
  for (const cell of sinkCells) open[cell] = (open[cell] as number) | E;

  const path = Int16Array.from([...main, ...branch]);
  const pieces = new Uint8Array(cells);
  const rots = new Uint8Array(cells);
  const solution = new Uint8Array(path.length);
  const onPath = new Uint8Array(cells);
  path.forEach((cell, k) => {
    const fit = pieceFor(open[cell] as number);
    pieces[cell] = fit.piece;
    solution[k] = fit.rot;
    onPath[cell] = 1;
  });
  for (let cell = 0; cell < cells; cell++) {
    if (onPath[cell] === 1 || !rng.chance(CONDUIT_FILL)) continue;
    pieces[cell] = rng.chance(0.5) ? STRAIGHT : ELBOW;
    rots[cell] = rng.int(0, 3);
  }
  path.forEach((cell, k) => {
    rots[cell] = ((solution[k] as number) + rng.int(1, 3)) % 4;
  });

  const p: ConduitPuzzle = {
    kind: 'conduit',
    n,
    pieces,
    rots,
    source: { cell: source, side: W },
    sinks: sinkCells.map((cell) => ({ cell, side: E })),
    solution,
    path,
  };
  // A straight turned twice reads as it was, so the scramble can leave the board solved;
  // the source, a straight or an elbow, shuts its W side within two more turns.
  for (let i = 0; i < 4 && conduitSolved(p); i++) rots[source] = ((rots[source] as number) + 1) % 4;
  return p;
}

// ------------------------------------------------------------ calibration

/** §4.2: flips `cell` and its four neighbours. */
function press(n: number, lit: Uint8Array, cell: number): void {
  lit[cell] = (lit[cell] as number) ^ 1;
  for (const side of SIDES) {
    const next = neighbour(n, cell, side);
    if (next >= 0) lit[next] = (lit[next] as number) ^ 1;
  }
}

/** §4.2: from all aligned, the row's k distinct presses, chosen by a seeded shuffle. */
function generateCalibration(row: CalibrationRow, rng: Rng): CalibrationPuzzle {
  const n = row.n;
  const order = rng.shuffle(Array.from({ length: n * n }, (_, i) => i));
  const lit = new Uint8Array(n * n);
  const k = Math.min(row.presses, n * n);
  for (let i = 0; i < k; i++) press(n, lit, order[i] as number);
  return { kind: 'calibration', n, lit, presses: k };
}

function popcount(v: number): number {
  let count = 0;
  for (let x = v; x !== 0; x &= x - 1) count++;
  return count;
}

/**
 * §4.2: the presses that clear `lit`, of the least weight. Gauss–Jordan
 * elimination over GF(2) with one bitmask per row — n ≤ 5, so a row and its
 * right-hand side fit 26 bits — gives a particular solution with every free
 * press 0; each free press gives a kernel vector (a quiet pattern), and every
 * combination of them is tried, the first of the least weight kept. A board
 * no press set clears — which no generated board or move can make — returns
 * no presses.
 */
export function solveLightsOut(n: number, lit: Uint8Array): Uint8Array {
  const m = n * n;
  const rhs = 1 << m;
  const rows: number[] = [];
  for (let i = 0; i < m; i++) {
    let row = 1 << i;
    for (const side of SIDES) {
      const next = neighbour(n, i, side);
      if (next >= 0) row |= 1 << next;
    }
    rows.push(lit[i] === 1 ? row | rhs : row);
  }
  const pivots: number[] = [];
  for (let col = 0; col < m; col++) {
    const rank = pivots.length;
    let pick = -1;
    for (let r = rank; r < m && pick < 0; r++) if (((rows[r] as number) & (1 << col)) !== 0) pick = r;
    if (pick < 0) continue;
    const pivot = rows[pick] as number;
    rows[pick] = rows[rank] as number;
    rows[rank] = pivot;
    for (let r = 0; r < m; r++) if (r !== rank && ((rows[r] as number) & (1 << col)) !== 0) rows[r] = (rows[r] as number) ^ pivot;
    pivots.push(col);
  }
  const none = new Uint8Array(m);
  for (let r = pivots.length; r < m; r++) if (((rows[r] as number) & rhs) !== 0) return none;

  let particular = 0;
  const isPivot = new Uint8Array(m);
  pivots.forEach((col, r) => {
    isPivot[col] = 1;
    if (((rows[r] as number) & rhs) !== 0) particular |= 1 << col;
  });
  const kernel: number[] = [];
  for (let free = 0; free < m; free++) {
    if (isPivot[free] === 1) continue;
    let v = 1 << free;
    pivots.forEach((col, r) => {
      if (((rows[r] as number) & (1 << free)) !== 0) v |= 1 << col;
    });
    kernel.push(v);
  }
  let best = particular;
  let bestWeight = popcount(particular);
  for (let combo = 1; combo < 1 << kernel.length; combo++) {
    let x = particular;
    for (let b = 0; b < kernel.length; b++) if ((combo & (1 << b)) !== 0) x ^= kernel[b] as number;
    const weight = popcount(x);
    if (weight < bestWeight) {
      best = x;
      bestWeight = weight;
    }
  }
  const out = new Uint8Array(m);
  for (let i = 0; i < m; i++) out[i] = (best >> i) & 1;
  return out;
}

// --------------------------------------------------------------- sequence

type NumericFamily = Exclude<SequenceFamily, 'words' | 'human'>;

/** Five terms, the sixth (the answer), the step a distractor adds, and the interleaved family's other next term. */
interface NumericDeal {
  terms: number[];
  answer: number;
  step: number;
  other: number | null;
}

/** §4.2 (*initial tuning*): one numeric family's terms. */
function numericDeal(family: NumericFamily, rng: Rng): NumericDeal {
  switch (family) {
    case 'arithmetic': {
      const a = rng.int(1, 9);
      const d = rng.int(2, 7);
      return { terms: [0, 1, 2, 3, 4].map((k) => a + k * d), answer: a + 5 * d, step: d, other: null };
    }
    case 'alternating': {
      const a = rng.int(1, 9);
      const d1 = rng.int(1, 6);
      let d2 = rng.int(1, 6);
      while (d2 === d1) d2 = rng.int(1, 6);
      const terms = [a, a + d1, a + d1 + d2, a + 2 * d1 + d2, a + 2 * d1 + 2 * d2];
      return { terms, answer: a + 3 * d1 + 2 * d2, step: d2, other: null };
    }
    case 'fibonacci': {
      const t = [rng.int(1, 5), rng.int(1, 5)];
      while (t.length < 6) t.push((t[t.length - 1] as number) + (t[t.length - 2] as number));
      // The answer plus this step is the term after it.
      return { terms: t.slice(0, 5), answer: t[5] as number, step: t[4] as number, other: null };
    }
    case 'interleaved': {
      const a = rng.int(1, 9);
      const dA = rng.int(2, 7);
      const b = rng.int(1, 9);
      const dB = rng.int(2, 7);
      // Even positions run a, odd b; the sixth term is b's third.
      return { terms: [a, b, a + dA, b + dB, a + 2 * dA], answer: b + 2 * dB, step: dB, other: a + 3 * dA };
    }
  }
}

/**
 * §4.2: three wrong answers — the answer − 1, + 1, plus one step, then the
 * other interleaved sequence's next term — dropping a repeat or a value below
 * 1, keeping the first three; short of three, fixed fallbacks under the same
 * rule. (An interleaved answer is at least 5 and its step at least 2, so its
 * first three always stand and the other term only backs them up.)
 */
function distractors(deal: NumericDeal): number[] {
  const { answer, step } = deal;
  const kept: number[] = [];
  const offer = (v: number): void => {
    if (kept.length < 3 && v > 0 && v !== answer && !kept.includes(v)) kept.push(v);
  };
  offer(answer - 1);
  offer(answer + 1);
  offer(answer + step);
  if (deal.other !== null) offer(deal.other);
  offer(answer + 2);
  offer(answer - 2);
  offer(answer + 3);
  offer(answer + 2 * step);
  for (let k = 4; kept.length < 3; k++) offer(answer + k);
  return kept;
}

/**
 * §4.2, §4.7: numeric families show five terms and `?`; `words` a phrase's
 * three words and `?`; `human` Eden's lock, whose choices keep their order.
 * Everything else shuffles its choices.
 */
function generateSequence(family: SequenceFamily, rng: Rng): SequencePuzzle {
  if (family === 'human') {
    const choices: string[] = [...HUMAN_LOCK.choices];
    return { kind: 'sequence', family, shown: [...HUMAN_LOCK.shown], choices, answer: choices.indexOf(HUMAN_LOCK.predicted) };
  }
  if (family === 'words') {
    const phrase = SEQUENCE_PHRASES[rng.int(0, SEQUENCE_PHRASES.length - 1)] as SequencePhrase;
    const choices = rng.shuffle([phrase.answer, ...phrase.others]);
    return { kind: 'sequence', family, shown: [...phrase.shown, '?'], choices, answer: choices.indexOf(phrase.answer) };
  }
  const deal = numericDeal(family, rng);
  const choices = rng.shuffle([deal.answer, ...distractors(deal)]).map(String);
  return { kind: 'sequence', family, shown: [...deal.terms.map(String), '?'], choices, answer: choices.indexOf(String(deal.answer)) };
}

// ----------------------------------------------------------------- plates

/** The distance from (x, z) to the nearest of `points` (∞ with none). */
function clearance(points: readonly { x: number; z: number }[], x: number, z: number): number {
  let best = Infinity;
  for (const p of points) best = Math.min(best, Math.hypot(p.x - x, p.z - z));
  return best;
}

/**
 * The plates' last resort: `count` at even angles on a ring of
 * `PLATE_FALLBACK_RING × reach`, turned to the first of `PLATE_RING_TURNS`
 * offsets that keeps every plate `PLATE_AVOID` from the caches (else the
 * clearest). For a cave room (r ≥ 6) the ring's radius is at least 3.4 m, so
 * five plates stand 4 m apart, and a cache 2 m off the centre blocks less than
 * one gap.
 */
function ringSpots(room: { x: number; z: number }, reach: number, count: number, avoid: readonly { x: number; z: number }[]): { x: number; z: number }[] {
  const ring = reach * PLATE_FALLBACK_RING;
  const gap = (Math.PI * 2) / count;
  let best: { x: number; z: number }[] = [];
  let bestClear = -Infinity;
  for (let j = 0; j < PLATE_RING_TURNS; j++) {
    const spots: { x: number; z: number }[] = [];
    let clear = Infinity;
    for (let i = 0; i < count; i++) {
      const a = (j / PLATE_RING_TURNS + i) * gap;
      const spot = { x: room.x + Math.cos(a) * ring, z: room.z + Math.sin(a) * ring };
      clear = Math.min(clear, clearance(avoid, spot.x, spot.z));
      spots.push(spot);
    }
    if (clear >= PLATE_AVOID) return spots;
    if (clear > bestClear) {
      best = spots;
      bestClear = clear;
    }
  }
  return best;
}

/**
 * §4.2: plates by seeded rejection within `r − 2` of the puzzle room's centre,
 * `PLATE_SPACING` apart and 2 m from every cache; a seeded shuffle of the
 * glyphs; a seeded order; and the panel at the panel room's centre — or, when
 * a cache stands within 1.6 m of it, 2.5 m from that cache on the centre's
 * side (along a seeded bearing if the two coincide). An anchor without a panel
 * room puts the panel at the puzzle room's centre (robustness only).
 *
 * In a 6 m room five plates can jam — the first four leaving no spot for the
 * fifth — so `PLATE_JAM` misses in a row start the layout over, and if the
 * tries run out regardless the plates stand as `ringSpots`. A layout that
 * never misses `PLATE_JAM` times in a row is the plain rejection's.
 */
function generatePlates(row: PlatesRow, anchor: PuzzleAnchor, rng: Rng): PlatesPuzzle {
  const count = row.plates;
  const room = anchor.room;
  const avoid = anchor.avoid ?? [];
  const reach = Math.max(0, room.r - PLATE_ROOM_MARGIN);
  let spots: { x: number; z: number }[] = [];
  let misses = 0;
  for (let attempt = 0; attempt < PLATE_TRIES && spots.length < count; attempt++) {
    const at = rng.inDisc(reach);
    const x = room.x + at.x;
    const z = room.z + at.z;
    if (clearance(spots, x, z) < PLATE_SPACING || clearance(avoid, x, z) < PLATE_AVOID) {
      misses++;
      if (misses >= PLATE_JAM) {
        spots = [];
        misses = 0;
      }
      continue;
    }
    spots.push({ x, z });
    misses = 0;
  }
  if (spots.length < count) spots = ringSpots(room, reach, count, avoid);
  const glyphs = rng.shuffle([...GLYPHS]);
  const plates = spots.map((s, i) => ({ x: s.x, z: s.z, glyph: glyphs[i % glyphs.length] as Glyph }));
  const order = rng.shuffle(plates.map((_, i) => i));

  const centre = anchor.panelRoom ?? room;
  let panel = { x: centre.x, z: centre.z };
  const near = avoid.find((a) => Math.hypot(a.x - centre.x, a.z - centre.z) < PANEL_AVOID);
  if (near !== undefined) {
    const d = Math.hypot(centre.x - near.x, centre.z - near.z);
    const bearing = d > 1e-9 ? Math.atan2(centre.z - near.z, centre.x - near.x) : rng.angle();
    panel = { x: near.x + Math.cos(bearing) * PANEL_SHIFT, z: near.z + Math.sin(bearing) * PANEL_SHIFT };
  }
  return { kind: 'plates', plates, order, progress: 0, panel };
}

// ------------------------------------------------------------------- beam

/** §4.2: where a mirror sends a beam travelling `dir` — `/` swaps E ↔ N and W ↔ S, `\` E ↔ S and W ↔ N. */
function reflect(state: number, dir: number): number {
  if (state === 0) return dir === E ? N : dir === N ? E : dir === W ? S : W;
  return dir === E ? S : dir === S ? E : dir === W ? N : W;
}

/** A mirror state moved on by `by` steps of the 0 → 1 → 2 → 3 → 0 cycle. */
function cycled(state: number, by: number): MirrorState {
  return ((((state + by) % 4) + 4) % 4) as MirrorState;
}

/** The centre of a cell of an n × n beam grid whose min corner is `origin`. */
function gridCentre(n: number, origin: { x: number; z: number }, cell: number): { x: number; z: number } {
  const row = Math.floor(cell / n);
  const col = cell - row * n;
  return { x: origin.x + (col + 0.5) * BEAM_CELL, z: origin.z + (row + 0.5) * BEAM_CELL };
}

/** §4.6: a beam cell's centre on the cave floor. */
export function beamCellCenter(p: BeamPuzzle, cell: number): { x: number; z: number } {
  return gridCentre(p.n, p.origin, cell);
}

/**
 * §4.2: the beam from the lens, cell by cell — `cells` starts at the lens and
 * ends where the beam stops. It hits on entering the receiver's cell from any
 * side; it misses on leaving the grid, or on reaching the lens's cell again or
 * a closed mirror, whose cell ends `cells`. A cap of 4n² steps ends a loop as
 * a miss.
 */
export function traceBeam(p: BeamPuzzle): { cells: number[]; hits: boolean } {
  const cells = [p.lens.cell];
  let at = p.lens.cell;
  let dir: number = p.lens.dir;
  for (let step = 0; step < 4 * p.n * p.n; step++) {
    at = neighbour(p.n, at, dir);
    if (at < 0) return { cells, hits: false };
    cells.push(at);
    if (at === p.receiver.cell) return { cells, hits: true };
    if (at === p.lens.cell) return { cells, hits: false };
    const mirror = p.mirrors.find((m) => m.cell === at);
    if (mirror === undefined) continue;
    if (mirror.state >= 2) return { cells, hits: false };
    dir = reflect(mirror.state, dir);
  }
  return { cells, hits: false };
}

/** The solved layout of a beam board: lens, mirrors in their solving states, receiver. */
interface BeamRoute {
  lens: { cell: number; dir: Side };
  receiver: { cell: number; dir: Side };
  cells: number[];
  states: MirrorState[];
}

/**
 * §4.2: the lens on the west column at row r0, shining east; mirror 0 at
 * (r0, c1) turns the beam up or down column c1 to mirror 1 at (r1, c1), which
 * sends it east. With 2 mirrors the receiver takes the beam at (r1, n − 1).
 * With 3, mirror 2 at (r1, n − 1) turns it along the east column to the
 * receiver at (r2, n − 1) — a beam that must leave eastward needs an even
 * number of turns, so the third mirror sends it down the column instead.
 */
function beamRoute(n: number, mirrors: 2 | 3, rng: Rng): BeamRoute {
  const r0 = rng.int(0, n - 1);
  const c1 = rng.int(1, n - 2);
  const r1 = (r0 + rng.int(1, n - 1)) % n;
  // `/` sends an eastbound beam north and takes a northbound one east; `\` the same southward.
  const turn: MirrorState = r1 < r0 ? 0 : 1;
  const route: BeamRoute = {
    lens: { cell: r0 * n, dir: E },
    receiver: { cell: r1 * n + n - 1, dir: E },
    cells: [r0 * n + c1, r1 * n + c1],
    states: [turn, turn],
  };
  if (mirrors === 3) {
    const r2 = (r1 + rng.int(1, n - 1)) % n;
    route.cells.push(r1 * n + n - 1);
    route.states.push(r2 < r1 ? 0 : 1);
    route.receiver = { cell: r2 * n + n - 1, dir: r2 < r1 ? N : S };
  }
  return route;
}

/**
 * §4.2: an n × n grid, n = ⌊r√2 / 2⌋, centred on the puzzle room, so its
 * corners stay inside the room's disc. A route is re-drawn while a piece
 * stands within 1.5 m of a cache (the last try stands regardless); the
 * mirrors are placed solved and recorded, then each moves on 1–3 states, and
 * mirror 0 — the first the lens meets — once more while the beam still hits.
 */
function generateBeam(row: BeamRow, anchor: PuzzleAnchor, rng: Rng): BeamPuzzle {
  const room = anchor.room;
  const avoid = anchor.avoid ?? [];
  // At least 3 so mirror 0 has an inner column — robustness only: a cave room's r ≥ 6 gives 4.
  const n = Math.max(3, Math.floor((room.r * Math.SQRT2) / 2));
  const origin = { x: room.x - (n * BEAM_CELL) / 2, z: room.z - (n * BEAM_CELL) / 2 };
  const crowds = (route: BeamRoute): boolean =>
    [route.lens.cell, ...route.cells, route.receiver.cell].some((cell) => {
      const c = gridCentre(n, origin, cell);
      return avoid.some((a) => Math.hypot(a.x - c.x, a.z - c.z) < BEAM_AVOID);
    });
  let route = beamRoute(n, row.mirrors, rng);
  for (let attempt = 1; attempt < BEAM_TRIES && crowds(route); attempt++) route = beamRoute(n, row.mirrors, rng);

  const p: BeamPuzzle = {
    kind: 'beam',
    n,
    origin,
    lens: route.lens,
    receiver: route.receiver,
    mirrors: route.cells.map((cell, i) => ({ cell, state: route.states[i] as MirrorState })),
    solution: Uint8Array.from(route.states),
  };
  for (const mirror of p.mirrors) mirror.state = cycled(mirror.state, rng.int(1, 3));
  const first = p.mirrors[0];
  for (let i = 0; i < 4 && first !== undefined && traceBeam(p).hits; i++) first.state = cycled(first.state, 1);
  return p;
}

// -------------------------------------------------------------- the framework

/**
 * §4.1–§4.3: a board of `kind` at `chapter`'s difficulty from `rng` — a site's
 * `puzzleFork`. World puzzles stand in `anchor` (a default room without one);
 * a sequence asks `family`, else the chapter's.
 */
export function generatePuzzle(kind: PuzzleKind, chapter: number, rng: Rng, anchor?: PuzzleAnchor, family?: SequenceFamily): Puzzle {
  switch (kind) {
    case 'conduit':
      return generateConduit(rowFor(PUZZLE_DIFFICULTY.conduit, chapter), rng);
    case 'calibration':
      return generateCalibration(rowFor(PUZZLE_DIFFICULTY.calibration, chapter), rng);
    case 'sequence':
      return generateSequence(family ?? rowFor(PUZZLE_DIFFICULTY.sequence, chapter).family, rng);
    case 'plates':
      return generatePlates(rowFor(PUZZLE_DIFFICULTY.plates, chapter), anchor ?? DEFAULT_ANCHOR, rng);
    case 'beam':
      return generateBeam(rowFor(PUZZLE_DIFFICULTY.beam, chapter), anchor ?? DEFAULT_ANCHOR, rng);
  }
}

/** A move that changes nothing: the wrong shape for the board, an index off it, or not a move here. */
function refused(p: Puzzle): { ok: boolean; solved: boolean } {
  return { ok: false, solved: isSolved(p) };
}

/**
 * §4.2: applies one move to `p` in place. `ok` is false for a move that
 * changes nothing — the wrong shape, an index off the board, a tile that does
 * not turn (empty, or a cross, which looks the same every way), anything on a
 * solved sequence or plate board — and for a wrong pick or a wrong plate.
 * A wrong pick leaves the board as it was: the scene deals the next fork.
 * `solved` is `isSolved(p)`, so a beam never reads solved here — only the
 * light can solve it.
 */
export function applyMove(p: Puzzle, m: PuzzleMove): { ok: boolean; solved: boolean } {
  switch (p.kind) {
    case 'conduit': {
      if (!('cell' in m) || !inRange(m.cell, p.n * p.n)) return refused(p);
      const piece = p.pieces[m.cell] as number;
      if (piece === EMPTY || piece === CROSS) return refused(p);
      p.rots[m.cell] = ((p.rots[m.cell] as number) + 1) % 4;
      return { ok: true, solved: conduitSolved(p) };
    }
    case 'calibration': {
      if (!('cell' in m) || !inRange(m.cell, p.n * p.n)) return refused(p);
      press(p.n, p.lit, m.cell);
      return { ok: true, solved: isSolved(p) };
    }
    case 'sequence': {
      if (!('choice' in m) || !inRange(m.choice, p.choices.length) || isSolved(p)) return refused(p);
      // Eden's lock takes any answer (§4.7); every other board only its own.
      if (p.family !== 'human' && m.choice !== p.answer) return { ok: false, solved: false };
      p.shown[p.shown.length - 1] = p.choices[m.choice] as string;
      return { ok: true, solved: true };
    }
    case 'plates': {
      if (!('plate' in m) || !inRange(m.plate, p.plates.length) || isSolved(p)) return refused(p);
      if (m.plate === p.order[p.progress]) {
        p.progress++;
        return { ok: true, solved: isSolved(p) };
      }
      // §4.6: a wrong plate resets the order, keeping one step when it is the order's first.
      p.progress = m.plate === p.order[0] ? 1 : 0;
      return { ok: false, solved: false };
    }
    case 'beam': {
      if (!('mirror' in m) || !inRange(m.mirror, p.mirrors.length)) return refused(p);
      const mirror = p.mirrors[m.mirror] as BeamPuzzle['mirrors'][number];
      mirror.state = cycled(mirror.state, 1);
      return { ok: true, solved: isSolved(p) };
    }
  }
}

/** §4.2: whether `p` is solved as it stands; a beam only with the flashlight on (55-c). */
export function isSolved(p: Puzzle, lightOn?: boolean): boolean {
  switch (p.kind) {
    case 'conduit':
      return conduitSolved(p);
    case 'calibration':
      return p.lit.every((v) => v === 0);
    case 'sequence':
      return p.shown[p.shown.length - 1] !== '?';
    case 'plates':
      return p.progress >= p.order.length;
    case 'beam':
      return lightOn === true && traceBeam(p).hits;
  }
}

/**
 * §4.2: the moves that solve `p` from its current state (55-g); none when it
 * is solved (a beam: when its beam already hits). Conduit: each path cell's
 * quarter turns to its recorded rotation, in path order (mod 2 for a straight,
 * none for a cross), at most 3 × the path. Calibration: the presses of
 * `solveLightsOut`, ascending. Sequence: the answer. Plates: the rest of the
 * order. Beam: each mirror's steps to its solving state, in order.
 */
export function solvePuzzle(p: Puzzle): readonly PuzzleMove[] {
  const moves: PuzzleMove[] = [];
  switch (p.kind) {
    case 'conduit': {
      if (conduitSolved(p)) return moves;
      p.path.forEach((cell, k) => {
        const piece = p.pieces[cell] as number;
        let turns = ((((p.solution[k] as number) - (p.rots[cell] as number)) % 4) + 4) % 4;
        if (piece === STRAIGHT) turns %= 2;
        else if (piece === EMPTY || piece === CROSS) turns = 0;
        for (let t = 0; t < turns; t++) moves.push({ cell });
      });
      return moves;
    }
    case 'calibration': {
      if (isSolved(p)) return moves;
      solveLightsOut(p.n, p.lit).forEach((on, cell) => {
        if (on === 1) moves.push({ cell });
      });
      return moves;
    }
    case 'sequence':
      return isSolved(p) ? moves : [{ choice: p.answer }];
    case 'plates':
      for (let k = p.progress; k < p.order.length; k++) moves.push({ plate: p.order[k] as number });
      return moves;
    case 'beam': {
      if (traceBeam(p).hits) return moves;
      p.mirrors.forEach((mirror, i) => {
        const steps = ((((p.solution[i] ?? mirror.state) - mirror.state) % 4) + 4) % 4;
        for (let t = 0; t < steps; t++) moves.push({ mirror: i });
      });
      return moves;
    }
  }
}

/** §4.5: the next move toward a solution — `solvePuzzle(p)[0]` — or null when there is none. */
export function hintMove(p: Puzzle): PuzzleMove | null {
  return solvePuzzle(p)[0] ?? null;
}

// --------------------------------------------------------------- the sites

/**
 * §4.1: a site's stream — `layout.fork('puzzle:<site>')` for the visit's first
 * deal, `puzzle:<site>:<n>` for the n-th re-deal after a wrong sequence pick.
 */
export function puzzleFork(layout: Rng, site: string, deal: number): Rng {
  return layout.fork(deal > 0 ? `puzzle:${site}:${deal}` : `puzzle:${site}`);
}

/**
 * §4.1: a relic terminal's spot — `footprint + RELIC_CLEARANCE` m from the
 * planet's landmark instance 0 toward the pad, so it clears the landmark's
 * model and stands in its clearing, facing the pad. Null with no landmark.
 */
export function relicSpot(
  layout: { pad: { x: number; z: number }; pois: readonly { kind: string; instance: number; x: number; z: number }[] },
  footprint: number,
): { x: number; z: number; facing: number } | null {
  const landmark = layout.pois.find((poi) => poi.kind === 'landmark' && poi.instance === 0);
  if (landmark === undefined) return null;
  const dx = layout.pad.x - landmark.x;
  const dz = layout.pad.z - landmark.z;
  const d = Math.hypot(dx, dz);
  const reach = footprint + RELIC_CLEARANCE;
  const x = landmark.x + (d > 0 ? dx / d : 1) * reach;
  const z = landmark.z + (d > 0 ? dz / d : 0) * reach;
  return { x, z, facing: Math.atan2(layout.pad.z - z, layout.pad.x - x) };
}

/**
 * §4.1: a vault terminal's spot — `VAULT_TERMINAL_OFFSET` m from the door
 * along `doorFacing` (which looks from the vault into its corridor), facing
 * back at the door.
 */
export function vaultTerminalSpot(vault: { doorX: number; doorZ: number; doorFacing: number }): { x: number; z: number; facing: number } {
  return {
    x: vault.doorX + Math.cos(vault.doorFacing) * VAULT_TERMINAL_OFFSET,
    z: vault.doorZ + Math.sin(vault.doorFacing) * VAULT_TERMINAL_OFFSET,
    facing: vault.doorFacing + Math.PI,
  };
}
