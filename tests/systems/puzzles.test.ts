// SPEC-055 §6.1 — the puzzle module's pure half (§4.1–§4.5). Every board is
// generated from a solved state or a constructed path, and these suites are
// the proof that it is solvable, over hundreds of seeds per difficulty row and
// each against a checker of the test's own: conduit (500 seeds per row, an
// independent flood), calibration (500 per row, a brute force of the least
// press count), sequence (1,000 per family, a rule check from the shown terms
// alone), plates and the beam (100 real caves per planet); then the hints,
// determinism, the moves that are refused, and the terminals' spots.
import { describe, expect, it } from 'vitest';
import { Rng, RngRoot } from '@/core/Rng';
import {
  HUMAN_LOCK,
  PLANETS,
  PLANET_IDS,
  PUZZLE_DIFFICULTY,
  PUZZLE_SITES,
  SEQUENCE_PHRASES,
  UNDERGROUND,
  type PlanetId,
  type PuzzleSiteId,
  type SequenceFamily,
} from '@/data/index';
import { ObstacleGrid, isReachable } from '@/systems/Layout';
import {
  BEAM_CELL,
  GLYPHS,
  PIECE_NAMES,
  PLATE_RADIUS,
  PLATE_SPACING,
  PUZZLE_BYPASS_HINTS,
  PUZZLE_BYPASS_SECONDS,
  RELIC_CLEARANCE,
  VAULT_TERMINAL_OFFSET,
  applyMove,
  beamCellCenter,
  conduitMask,
  generatePuzzle,
  hintMove,
  isSolved,
  poweredCells,
  puzzleFork,
  relicSpot,
  solveLightsOut,
  solvePuzzle,
  traceBeam,
  vaultTerminalSpot,
  type BeamPuzzle,
  type CalibrationPuzzle,
  type ConduitPuzzle,
  type PlatesPuzzle,
  type Puzzle,
  type PuzzleAnchor,
  type PuzzleKind,
  type PuzzleMove,
  type SequencePuzzle,
} from '@/systems/Puzzles';
import { generateUnderground, type UndergroundLayout } from '@/systems/Underground';

type Point = { x: number; z: number };
type Room = UndergroundLayout['rooms'][number];

const gap = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.z - b.z);

/** A site's deal on a save — the scene's `puzzleFork(layout(planet), site, deal)` (§4.1). */
const dealFor = (site: PuzzleSiteId, seed: number, deal = 0): Rng =>
  puzzleFork(new RngRoot(seed).layout(PUZZLE_SITES[site].planet), site, deal);

/** SPEC-054 §4.3: the cave a save's descent leads to. */
const caveFor = (planet: PlanetId, seed: number): UndergroundLayout =>
  generateUnderground(UNDERGROUND[planet], PLANETS[planet].chapter, new RngRoot(seed).layout(planet).fork('underground'));

/** §4.1: what the scene hands a world puzzle — the puzzle room, the panel room and the caches. */
const anchorOf = (u: UndergroundLayout): PuzzleAnchor => ({
  room: u.rooms[u.puzzleRoom] as Room,
  panelRoom: u.rooms[u.panelRoom] as Room,
  avoid: u.caches,
});

/** Every move in order; each one's result. */
const play = (p: Puzzle, moves: readonly PuzzleMove[]): { ok: boolean; solved: boolean }[] => moves.map((m) => applyMove(p, m));

const rowOf = (cell: number, n: number): number => Math.floor(cell / n);
const colOf = (cell: number, n: number): number => cell % n;
const adjacent = (a: number, b: number, n: number): boolean =>
  Math.abs(rowOf(a, n) - rowOf(b, n)) + Math.abs(colOf(a, n) - colOf(b, n)) === 1;

describe('the puzzle constants (§3, §4.5)', () => {
  it('pins the bypass, the plates, the beam grid and the terminals', () => {
    expect(PUZZLE_BYPASS_SECONDS).toBe(90);
    expect(PUZZLE_BYPASS_HINTS).toBe(3);
    expect(PLATE_RADIUS).toBe(0.9);
    expect(PLATE_SPACING).toBe(3);
    expect(BEAM_CELL).toBe(2);
    expect(RELIC_CLEARANCE).toBe(1.5);
    expect(VAULT_TERMINAL_OFFSET).toBe(1.5);
    expect(PIECE_NAMES).toEqual(['empty', 'end', 'straight', 'elbow', 'tee', 'cross']);
    expect(GLYPHS).toEqual(['circle', 'triangle', 'square', 'diamond', 'star']);
  });

  it('puzzleFork is layout.fork(puzzle:<site>), then puzzle:<site>:<n> for the n-th re-deal', () => {
    const layout = new RngRoot(77).layout('vetra');
    expect(puzzleFork(layout, 'vetra_relic', 0).seed).toBe(layout.fork('puzzle:vetra_relic').seed);
    expect(puzzleFork(layout, 'vetra_relic', 1).seed).toBe(layout.fork('puzzle:vetra_relic:1').seed);
    expect(puzzleFork(layout, 'vetra_relic', 4).seed).toBe(layout.fork('puzzle:vetra_relic:4').seed);
    // A fork never moves the stream it came from.
    const control = new RngRoot(77).layout('vetra');
    expect(layout.next()).toBe(control.next());
  });
});

// ------------------------------------------------------------------ conduit

/** The test's own rest masks (N 1, E 2, S 4, W 8) and clockwise turn — not `conduitMask`. */
const REST_MASKS = [0, 1, 5, 3, 7, 15];
function sidesOf(piece: number, rot: number): number {
  let m = REST_MASKS[piece] as number;
  for (let i = 0; i < rot % 4; i++) m = ((m << 1) | (m >> 3)) & 15;
  return m;
}

/** The test's own flood: through sides open on both cells, from a source open on W to every sink open on E. */
function floodSolved(p: ConduitPuzzle): boolean {
  const n = p.n;
  const open = (cell: number): number => sidesOf(p.pieces[cell] as number, p.rots[cell] as number);
  if ((open(p.source.cell) & 8) === 0) return false;
  const seen = new Set([p.source.cell]);
  const queue = [p.source.cell];
  const steps: [number, number, number, number][] = [
    [1, -1, 0, 4],
    [2, 0, 1, 8],
    [4, 1, 0, 1],
    [8, 0, -1, 2],
  ];
  while (queue.length > 0) {
    const at = queue.shift() as number;
    for (const [side, dr, dc, back] of steps) {
      const r = rowOf(at, n) + dr;
      const c = colOf(at, n) + dc;
      if ((open(at) & side) === 0 || r < 0 || c < 0 || r >= n || c >= n) continue;
      const next = r * n + c;
      if (seen.has(next) || (open(next) & back) === 0) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return p.sinks.every((s) => seen.has(s.cell) && (open(s.cell) & 2) !== 0);
}

/** The board with every path cell at its recorded rotation. */
function withSolution(p: ConduitPuzzle): ConduitPuzzle {
  const solved = structuredClone(p);
  solved.path.forEach((cell, k) => {
    solved.rots[cell] = solved.solution[k] as number;
  });
  return solved;
}

describe('conduit (§4.2)', () => {
  it('conduitMask: the rest masks, turned clockwise N → E → S → W', () => {
    expect([0, 1, 2, 3, 4, 5].map((piece) => conduitMask(piece, 0))).toEqual([0, 1, 5, 3, 7, 15]);
    expect([0, 1, 2, 3].map((rot) => conduitMask(1, rot))).toEqual([1, 2, 4, 8]);
    expect([0, 1, 2, 3].map((rot) => conduitMask(2, rot))).toEqual([5, 10, 5, 10]);
    expect([0, 1, 2, 3].map((rot) => conduitMask(3, rot))).toEqual([3, 6, 12, 9]);
    expect([0, 1, 2, 3].map((rot) => conduitMask(4, rot))).toEqual([7, 14, 13, 11]);
    expect(conduitMask(5, 3)).toBe(15);
    expect(conduitMask(3, 5)).toBe(conduitMask(3, 1));
  });

  const ROWS = [
    [1, 'cinder4_vault'],
    [3, 'thessaly_vault'],
    [5, 'hive_vault'],
  ] as const;
  for (const [chapter, site] of ROWS) {
    it(`chapter ${chapter} (${site}), 500 seeds: a constructed path in its band, scrambled, solved by its solution and by solvePuzzle`, () => {
      const row = PUZZLE_DIFFICULTY.conduit[chapter] as NonNullable<(typeof PUZZLE_DIFFICULTY.conduit)[number]>;
      const [lo, hi] = row.path;
      let emptyTaps = 0;
      for (let seed = 0; seed < 500; seed++) {
        const at = `${site} seed ${seed}`;
        const p = generatePuzzle('conduit', chapter, dealFor(site, seed)) as ConduitPuzzle;
        const n = p.n;
        expect(p.kind, at).toBe('conduit');
        expect(n, at).toBe(row.n);
        expect(p.pieces.length, at).toBe(n * n);
        expect(p.rots.length, at).toBe(n * n);

        // The path: inside the band, self-avoiding, source first on the west column, sinks on the east.
        expect(p.path.length, at).toBeGreaterThanOrEqual(lo);
        expect(p.path.length, at).toBeLessThanOrEqual(hi);
        expect(p.solution.length, at).toBe(p.path.length);
        expect(new Set(p.path).size, at).toBe(p.path.length);
        expect(p.source, at).toEqual({ cell: p.path[0], side: 8 });
        expect(colOf(p.source.cell, n), at).toBe(0);
        expect(p.sinks.length, at).toBe(row.sinks);
        for (const sink of p.sinks) {
          expect(sink.side, at).toBe(2);
          expect(colOf(sink.cell, n), at).toBe(n - 1);
        }
        // The main path runs cell to cell from the source to the first sink; a branch leaves a
        // main-path cell that is neither end and runs cell to cell to the second sink.
        const mainEnd = p.path.indexOf((p.sinks[0] as ConduitPuzzle['sinks'][number]).cell);
        if (row.sinks === 1) expect(mainEnd, at).toBe(p.path.length - 1);
        else expect(mainEnd, at).toBeLessThan(p.path.length - 1);
        for (let k = 1; k <= mainEnd; k++) expect(adjacent(p.path[k - 1] as number, p.path[k] as number, n), at).toBe(true);
        if (row.sinks === 2) {
          expect(p.path[p.path.length - 1], at).toBe((p.sinks[1] as ConduitPuzzle['sinks'][number]).cell);
          const main = Array.from(p.path.slice(0, mainEnd + 1));
          const first = p.path[mainEnd + 1] as number;
          expect(main.slice(1, -1).some((cell) => adjacent(cell, first, n)), at).toBe(true);
          for (let k = mainEnd + 2; k < p.path.length; k++) expect(adjacent(p.path[k - 1] as number, p.path[k] as number, n), at).toBe(true);
        }
        // Path cells hold a piece; free cells are empty or a decoy straight or elbow.
        const onPath = new Set(p.path);
        for (let cell = 0; cell < n * n; cell++) {
          const piece = p.pieces[cell] as number;
          if (onPath.has(cell)) expect(piece, `${at} cell ${cell}`).toBeGreaterThan(0);
          else expect([0, 2, 3], `${at} cell ${cell}`).toContain(piece);
        }

        // Scrambled: unsolved, by isSolved and by the test's own flood.
        expect(isSolved(p), at).toBe(false);
        expect(floodSolved(p), at).toBe(false);

        // The recorded solution solves it, every path cell powered.
        const solved = withSolution(p);
        expect(isSolved(solved), at).toBe(true);
        expect(floodSolved(solved), at).toBe(true);
        const powered = poweredCells(solved);
        for (const cell of p.path) expect(powered[cell], `${at} cell ${cell}`).toBe(1);
        expect(solvePuzzle(solved), at).toEqual([]);

        // solvePuzzle: at most 3 turns a path cell, every one accepted, the last one solving.
        const moves = solvePuzzle(p);
        expect(moves.length, at).toBeGreaterThan(0);
        expect(moves.length, at).toBeLessThanOrEqual(3 * p.path.length);
        const played = structuredClone(p);
        const results = play(played, moves);
        expect(results.every((r) => r.ok), at).toBe(true);
        expect(results[results.length - 1], at).toEqual({ ok: true, solved: true });
        expect(floodSolved(played), at).toBe(true);

        // Two outputs: with either sink turned off its edge the board is unsolved, the other still powered.
        if (row.sinks === 2) {
          p.sinks.forEach((sink, i) => {
            const broken = structuredClone(solved);
            const piece = broken.pieces[sink.cell] as number;
            const rot = [0, 1, 2, 3].find((r) => (sidesOf(piece, r) & 2) === 0) as number;
            broken.rots[sink.cell] = rot;
            expect(isSolved(broken), `${at} sink ${i}`).toBe(false);
            const other = p.sinks[1 - i] as ConduitPuzzle['sinks'][number];
            expect(poweredCells(broken)[other.cell], `${at} sink ${i}`).toBe(1);
          });
        }

        // 55-e: an empty cell is not a move.
        const empty = p.pieces.indexOf(0);
        if (empty >= 0) {
          emptyTaps++;
          const before = structuredClone(p);
          expect(applyMove(p, { cell: empty }), at).toEqual({ ok: false, solved: false });
          expect(p, at).toEqual(before);
        }
      }
      expect(emptyTaps).toBeGreaterThan(100);
    });
  }

  it('a tap turns one tile a quarter clockwise; poweredCells is all 0 while the source is shut on W', () => {
    const p = generatePuzzle('conduit', 1, dealFor('cinder4_vault', 9)) as ConduitPuzzle;
    const cell = p.path[1] as number;
    const before = p.rots[cell] as number;
    const result = applyMove(p, { cell });
    expect(result.ok).toBe(true);
    expect(p.rots[cell]).toBe((before + 1) % 4);
    const shut = withSolution(p);
    const source = p.source.cell;
    const piece = shut.pieces[source] as number;
    shut.rots[source] = [0, 1, 2, 3].find((r) => (sidesOf(piece, r) & 8) === 0) as number;
    expect(Array.from(poweredCells(shut))).toEqual(new Array<number>(p.n * p.n).fill(0));
    expect(isSolved(shut)).toBe(false);
  });

  it('55-f: a cross turns nothing and is not a move; a board solved off its recorded solution is solved', () => {
    const p = withSolution(generatePuzzle('conduit', 3, dealFor('thessaly_vault', 4)) as ConduitPuzzle);
    // A straight half a turn round is the same tile: still solved, and solvePuzzle asks nothing.
    const straightAt = Array.from(p.path).findIndex((cell) => p.pieces[cell] === 2);
    if (straightAt >= 0) {
      const cell = p.path[straightAt] as number;
      p.rots[cell] = ((p.rots[cell] as number) + 2) % 4;
      expect(isSolved(p)).toBe(true);
      expect(solvePuzzle(p)).toEqual([]);
      expect(hintMove(p)).toBeNull();
    }
    const free = p.pieces.findIndex((piece, cell) => piece === 0 && !p.path.includes(cell));
    if (free >= 0) {
      p.pieces[free] = 5;
      const before = structuredClone(p);
      expect(applyMove(p, { cell: free }).ok).toBe(false);
      expect(p).toEqual(before);
    }
  });
});

// -------------------------------------------------------------- calibration

/** The test's own press model: cell i flips itself and its in-bounds neighbours, as an m-bit mask. */
function pressColumns(n: number): number[] {
  const columns: number[] = [];
  for (let i = 0; i < n * n; i++) {
    const r = rowOf(i, n);
    const c = colOf(i, n);
    let mask = 1 << i;
    if (r > 0) mask |= 1 << (i - n);
    if (r < n - 1) mask |= 1 << (i + n);
    if (c > 0) mask |= 1 << (i - 1);
    if (c < n - 1) mask |= 1 << (i + 1);
    columns.push(mask);
  }
  return columns;
}

/**
 * The least press count that makes each board, by brute force over every one
 * of the 2^(n²) press sets in Gray-code order (−1 for a board none makes).
 */
function leastPresses(n: number): Int8Array {
  const m = n * n;
  const columns = pressColumns(n);
  const least = new Int8Array(1 << m).fill(-1);
  let board = 0;
  for (let i = 0; i < 1 << m; i++) {
    if (i > 0) board ^= columns[31 - Math.clz32(i & -i)] as number;
    const set = i ^ (i >> 1);
    let weight = 0;
    for (let x = set; x !== 0; x &= x - 1) weight++;
    if (least[board] === -1 || weight < (least[board] as number)) least[board] = weight;
  }
  return least;
}

const maskOf = (lit: Uint8Array): number => lit.reduce((mask, v, i) => (v === 1 ? mask | (1 << i) : mask), 0);
const weightOf = (presses: Uint8Array): number => presses.reduce((sum, v) => sum + v, 0);

describe('calibration (§4.2)', () => {
  const least = { 3: leastPresses(3), 4: leastPresses(4) } as const;

  it('solveLightsOut matches the brute force on every 3 × 3 board and every solvable 4 × 4 one', () => {
    for (const n of [3, 4] as const) {
      const table = least[n];
      const columns = pressColumns(n);
      let solvable = 0;
      for (let board = 0; board < table.length; board++) {
        const lit = Uint8Array.from({ length: n * n }, (_, i) => (board >> i) & 1);
        const presses = solveLightsOut(n, lit);
        if (table[board] === -1) {
          // 4 × 4's press matrix has rank 12: no press set makes 15 boards in 16, and the solver presses nothing.
          expect(weightOf(presses), `${n} board ${board}`).toBe(0);
          continue;
        }
        solvable++;
        let made = 0;
        presses.forEach((v, i) => {
          if (v === 1) made ^= columns[i] as number;
        });
        expect(made, `${n} board ${board}`).toBe(board);
        expect(weightOf(presses), `${n} board ${board}`).toBe(table[board]);
      }
      // 3 × 3's press matrix is invertible; 4 × 4's has rank 12.
      expect(solvable).toBe(n === 3 ? 512 : 4096);
    }
  });

  const ROWS = [
    [2, 'vetra_vault'],
    [4, 'ferrum_vault'],
  ] as const;
  for (const [chapter, site] of ROWS) {
    it(`chapter ${chapter} (${site}), 500 seeds: never solved, cleared by at most k presses, the least there are`, () => {
      const row = PUZZLE_DIFFICULTY.calibration[chapter] as NonNullable<(typeof PUZZLE_DIFFICULTY.calibration)[number]>;
      const table = least[row.n as 3 | 4];
      for (let seed = 0; seed < 500; seed++) {
        const at = `${site} seed ${seed}`;
        const p = generatePuzzle('calibration', chapter, dealFor(site, seed)) as CalibrationPuzzle;
        expect(p.kind, at).toBe('calibration');
        expect(p.n, at).toBe(row.n);
        expect(p.presses, at).toBe(row.presses);
        expect(p.lit.length, at).toBe(p.n * p.n);
        expect(p.lit.some((v) => v === 1), at).toBe(true);
        expect(isSolved(p), at).toBe(false);

        const presses = solveLightsOut(p.n, p.lit);
        expect(weightOf(presses), at).toBeLessThanOrEqual(row.presses);
        expect(weightOf(presses), at).toBe(table[maskOf(p.lit)]);
        const moves = solvePuzzle(p);
        expect(moves, at).toEqual(Array.from(presses).flatMap((v, cell) => (v === 1 ? [{ cell }] : [])));
        const results = play(p, moves);
        expect(results.every((r) => r.ok), at).toBe(true);
        expect(results[results.length - 1], at).toEqual({ ok: true, solved: true });
        expect(isSolved(p), at).toBe(true);
        expect(solvePuzzle(p), at).toEqual([]);
      }
    });
  }

  it('55-e: a press that undoes a press is a move; a 5 × 5 board clears too', () => {
    const p = generatePuzzle('calibration', 2, dealFor('vetra_vault', 3)) as CalibrationPuzzle;
    const before = Array.from(p.lit);
    expect(applyMove(p, { cell: 4 })).toEqual({ ok: true, solved: isSolved(p) });
    expect(applyMove(p, { cell: 4 }).ok).toBe(true);
    expect(Array.from(p.lit)).toEqual(before);
    // The rows stop at 4 × 4, but the solver handles n up to 5.
    const rng = new Rng(55);
    const lit = new Uint8Array(25);
    const columns = pressColumns(5);
    for (let k = 0; k < 6; k++) {
      const column = columns[rng.int(0, 24)] as number;
      for (let i = 0; i < 25; i++) if ((column >> i) & 1) lit[i] = (lit[i] as number) ^ 1;
    }
    const presses = solveLightsOut(5, lit);
    expect(weightOf(presses)).toBeLessThanOrEqual(6);
    let made = 0;
    presses.forEach((v, i) => {
      if (v === 1) made ^= columns[i] as number;
    });
    expect(made).toBe(maskOf(lit));
  });
});

// ----------------------------------------------------------------- sequence

/** The test's own rule check, from the shown terms alone: does `choice` complete them? */
function completes(family: SequenceFamily, shown: readonly string[], choice: string): boolean {
  if (family === 'words') {
    const phrase = SEQUENCE_PHRASES.find((ph) => ph.shown.every((word, i) => shown[i] === word));
    return phrase !== undefined && choice === phrase.answer;
  }
  const t = shown.slice(0, 5).map(Number) as [number, number, number, number, number];
  const next =
    family === 'arithmetic' || family === 'alternating'
      ? t[4] + (t[1] - t[0])
      : family === 'fibonacci'
        ? t[4] + t[3]
        : t[3] + (t[3] - t[1]);
  return Number(choice) === next;
}

describe('sequence (§4.2, §4.7)', () => {
  const FAMILIES = [
    ['arithmetic', 'cinder4_relic', 1],
    ['alternating', 'vetra_relic', 2],
    ['fibonacci', 'thessaly_relic', 3],
    ['interleaved', 'ferrum_relic', 4],
    ['words', 'eden_relic', 6],
  ] as const;
  for (const [family, site, chapter] of FAMILIES) {
    it(`${family} (${site}), 1,000 seeds: exactly one choice completes it; a wrong pick changes nothing and the next deal is ${family} again`, () => {
      expect(PUZZLE_SITES[site].family).toBe(family);
      expect(PUZZLE_DIFFICULTY.sequence[chapter]?.family).toBe(family);
      let redealt = 0;
      for (let seed = 0; seed < 1000; seed++) {
        const at = `${site} seed ${seed}`;
        const p = generatePuzzle('sequence', chapter, dealFor(site, seed), undefined, family) as SequencePuzzle;
        expect(p.kind, at).toBe('sequence');
        expect(p.family, at).toBe(family);
        expect(p.shown.length, at).toBe(family === 'words' ? 4 : 6);
        expect(p.shown[p.shown.length - 1], at).toBe('?');
        expect(p.choices.length, at).toBe(4);
        expect(new Set(p.choices).size, at).toBe(4);
        if (family !== 'words') {
          for (const term of [...p.shown.slice(0, 5), ...p.choices]) expect(term, at).toMatch(/^[1-9][0-9]*$/);
        }
        const passing = p.choices.flatMap((choice, i) => (completes(family, p.shown, choice) ? [i] : []));
        expect(passing, at).toEqual([p.answer]);
        expect(solvePuzzle(p), at).toEqual([{ choice: p.answer }]);

        // 55-d: a wrong pick is refused and leaves the board as it was.
        const before = structuredClone(p);
        expect(applyMove(p, { choice: (p.answer + 1) % 4 }), at).toEqual({ ok: false, solved: false });
        expect(p, at).toEqual(before);
        expect(isSolved(p), at).toBe(false);
        // …and the scene deals the next fork: the same family, a different board.
        const next = generatePuzzle('sequence', chapter, dealFor(site, seed, 1), undefined, family) as SequencePuzzle;
        expect(next.family, at).toBe(family);
        if (JSON.stringify(next) !== JSON.stringify(p)) redealt++;

        // The right pick fills the `?` and solves it; nothing moves a solved board.
        expect(applyMove(p, { choice: p.answer }), at).toEqual({ ok: true, solved: true });
        expect(p.shown[p.shown.length - 1], at).toBe(p.choices[p.answer]);
        expect(isSolved(p), at).toBe(true);
        expect(applyMove(p, { choice: p.answer }), at).toEqual({ ok: false, solved: true });
        expect(solvePuzzle(p), at).toEqual([]);
      }
      expect(redealt).toBeGreaterThan(950);
    });
  }

  it('the chapter names the family when none is given', () => {
    const families = [1, 2, 3, 4, 6].map((chapter) => (generatePuzzle('sequence', chapter, new Rng(chapter)) as SequencePuzzle).family);
    expect(families).toEqual(['arithmetic', 'alternating', 'fibonacci', 'interleaved', 'words']);
  });

  it('§4.7 the human lock: fixed tokens and choices, and every answer solves it', () => {
    for (let seed = 0; seed < 20; seed++) {
      const fresh = (): SequencePuzzle =>
        generatePuzzle('sequence', 6, dealFor('eden_vault', seed), undefined, PUZZLE_SITES.eden_vault.family) as SequencePuzzle;
      const p = fresh();
      expect(p.family).toBe('human');
      expect(p.shown).toEqual(['walk', 'do', 'not', '?']);
      expect(p.choices).toEqual(['stop', 'run', 'look', 'wake']);
      expect(p.choices[p.answer]).toBe(HUMAN_LOCK.predicted);
      expect(hintMove(p)).toEqual({ choice: 1 });
      for (let choice = 0; choice < 4; choice++) {
        const board = fresh();
        expect(applyMove(board, { choice }), `seed ${seed} choice ${choice}`).toEqual({ ok: true, solved: true });
        expect(board.shown).toEqual(['walk', 'do', 'not', p.choices[choice]]);
        expect(isSolved(board)).toBe(true);
        expect(applyMove(board, { choice: 1 }).ok).toBe(false);
      }
    }
  });
});

// ------------------------------------------------------------------- plates

describe('plates (§4.2, §4.6) on real caves', () => {
  const PLANETS_WITH_PLATES = ['cinder4', 'thessaly', 'hive'] as const;
  for (const planet of PLANETS_WITH_PLATES) {
    it(`${planet}, 100 seeds: spaced, inside the puzzle room, reachable; the panel in another room; the order walks and resets`, () => {
      const chapter = PLANETS[planet].chapter;
      const count = (PUZZLE_DIFFICULTY.plates[chapter] as NonNullable<(typeof PUZZLE_DIFFICULTY.plates)[number]>).plates;
      expect(PUZZLE_SITES[`${planet}_world`].kind).toBe('plates');
      for (let seed = 0; seed < 100; seed++) {
        const at = `${planet} seed ${seed}`;
        const u = caveFor(planet, seed);
        const room = u.rooms[u.puzzleRoom] as Room;
        const panelRoom = u.rooms[u.panelRoom] as Room;
        const p = generatePuzzle('plates', chapter, dealFor(`${planet}_world`, seed), anchorOf(u)) as PlatesPuzzle;
        expect(p.kind, at).toBe('plates');
        expect(p.plates.length, at).toBe(count);
        expect(p.progress, at).toBe(0);
        p.plates.forEach((plate, i) => {
          expect(gap(plate, room), `${at} plate ${i}`).toBeLessThanOrEqual(room.r - 2 + 1e-9);
          expect(isReachable(u, plate), `${at} plate ${i}`).toBe(true);
          for (const cache of u.caches) expect(gap(plate, cache), `${at} plate ${i} ${cache.id}`).toBeGreaterThanOrEqual(2);
          for (let j = i + 1; j < p.plates.length; j++) {
            expect(gap(plate, p.plates[j] as Point), `${at} plates ${i}, ${j}`).toBeGreaterThanOrEqual(PLATE_SPACING);
          }
        });
        const glyphs = p.plates.map((plate) => plate.glyph);
        expect(new Set(glyphs).size, at).toBe(count);
        for (const glyph of glyphs) expect(GLYPHS, at).toContain(glyph);
        expect([...p.order].sort((a, b) => a - b), at).toEqual(Array.from({ length: count }, (_, i) => i));

        // The panel stands in the panel room — never the puzzle room — and off every cache.
        expect(u.panelRoom, at).not.toBe(u.puzzleRoom);
        expect(gap(p.panel, panelRoom), at).toBeLessThan(panelRoom.r);
        // The panel's and every cache's 1.5 m interact circles never meet.
        for (const cache of u.caches) expect(gap(p.panel, cache), `${at} ${cache.id}`).toBeGreaterThan(3);

        // Walking the order solves it, every step accepted; nothing presses a solved board.
        const walked = structuredClone(p);
        const steps = play(walked, p.order.map((plate) => ({ plate })));
        expect(steps.slice(0, -1).every((s) => s.ok && !s.solved), at).toBe(true);
        expect(steps[steps.length - 1], at).toEqual({ ok: true, solved: true });
        expect(applyMove(walked, { plate: p.order[0] as number }), at).toEqual({ ok: false, solved: true });
        expect(solvePuzzle(walked), at).toEqual([]);

        // A wrong plate resets the order: to 1 when it is the order's first, else to 0.
        for (let progress = 0; progress < count; progress++) {
          for (let plate = 0; plate < count; plate++) {
            if (plate === p.order[progress]) continue;
            const board = structuredClone(p);
            play(board, p.order.slice(0, progress).map((q) => ({ plate: q })));
            expect(board.progress, at).toBe(progress);
            expect(applyMove(board, { plate }), `${at} at ${progress}, plate ${plate}`).toEqual({ ok: false, solved: false });
            expect(board.progress, `${at} at ${progress}, plate ${plate}`).toBe(plate === p.order[0] ? 1 : 0);
          }
        }
      }
    });
  }

  it('a room too small for rejection falls back to a regular ring that keeps the spacing', () => {
    // Five plates within 3.2 m of the centre fit only near a regular pentagon, which
    // rejection never finds: they stand on the ring at 0.85 × 3.2 m, 3.2 m apart.
    const room = { x: 4, z: -3, r: 5.2 };
    for (let seed = 0; seed < 5; seed++) {
      const p = generatePuzzle('plates', 5, new Rng(seed), { room, panelRoom: { x: 30, z: 0, r: 8 } }) as PlatesPuzzle;
      expect(p.plates.length).toBe(5);
      for (let i = 0; i < 5; i++) {
        const a = p.plates[i] as Point;
        expect(gap(a, room)).toBeCloseTo(0.85 * (room.r - 2), 9);
        for (let j = i + 1; j < 5; j++) expect(gap(a, p.plates[j] as Point)).toBeGreaterThanOrEqual(PLATE_SPACING);
      }
      expect(new Set(p.plates.map((plate) => plate.glyph)).size).toBe(5);
      expect(p.panel).toEqual({ x: 30, z: 0 });
    }
  });

  it('a cache within 3.2 m of the panel room centre moves the panel 3.5 m off it, toward the centre — past both 1.5 m circles', () => {
    const room = { x: 0, z: 0, r: 8 };
    const panelRoom = { x: 30, z: 10, r: 7 };
    const on = generatePuzzle('plates', 1, new Rng(1), { room, panelRoom, avoid: [{ x: 30, z: 10 }] }) as PlatesPuzzle;
    expect(gap(on.panel, { x: 30, z: 10 })).toBeCloseTo(3.5, 9);
    // A loose_a 2 m off its room's centre.
    const near = generatePuzzle('plates', 1, new Rng(1), { room, panelRoom, avoid: [{ x: 32, z: 10 }] }) as PlatesPuzzle;
    expect(near.panel.x).toBeCloseTo(28.5, 9);
    expect(near.panel.z).toBeCloseTo(10, 9);
    const clear = generatePuzzle('plates', 1, new Rng(1), { room, panelRoom, avoid: [{ x: 33.3, z: 10 }] }) as PlatesPuzzle;
    expect(clear.panel).toEqual({ x: 30, z: 10 });
  });
});

// --------------------------------------------------------------------- beam

describe('beam (§4.2, §4.6) on real caves', () => {
  const PLANETS_WITH_BEAMS = ['vetra', 'ferrum', 'eden'] as const;
  for (const planet of PLANETS_WITH_BEAMS) {
    it(`${planet}, 100 seeds: the solution's beam hits, the scrambled one misses, the light decides, every piece reachable`, () => {
      const chapter = PLANETS[planet].chapter;
      const mirrors = (PUZZLE_DIFFICULTY.beam[chapter] as NonNullable<(typeof PUZZLE_DIFFICULTY.beam)[number]>).mirrors;
      expect(PUZZLE_SITES[`${planet}_world`].kind).toBe('beam');
      for (let seed = 0; seed < 100; seed++) {
        const at = `${planet} seed ${seed}`;
        const u = caveFor(planet, seed);
        const room = u.rooms[u.puzzleRoom] as Room;
        const p = generatePuzzle('beam', chapter, dealFor(`${planet}_world`, seed), anchorOf(u)) as BeamPuzzle;
        const n = p.n;
        expect(p.kind, at).toBe('beam');
        expect(n, at).toBe(Math.floor((room.r * Math.SQRT2) / 2));
        expect(p.mirrors.length, at).toBe(mirrors);
        expect(p.solution.length, at).toBe(mirrors);

        // The grid: n × n cells of 2 m, centred on the room, its corners inside the room's disc.
        expect(p.origin.x, at).toBeCloseTo(room.x - n, 9);
        expect(p.origin.z, at).toBeCloseTo(room.z - n, 9);
        for (const corner of [p.origin, { x: p.origin.x + 2 * n, z: p.origin.z + 2 * n }, { x: p.origin.x, z: p.origin.z + 2 * n }, { x: p.origin.x + 2 * n, z: p.origin.z }]) {
          expect(gap(corner, room), at).toBeLessThanOrEqual(room.r + 1e-9);
        }
        // The lens on the west column shining east; the receiver on the east column.
        expect(colOf(p.lens.cell, n), at).toBe(0);
        expect(p.lens.dir, at).toBe(2);
        expect(colOf(p.receiver.cell, n), at).toBe(n - 1);
        const pieces = [p.lens.cell, ...p.mirrors.map((m) => m.cell), p.receiver.cell];
        expect(new Set(pieces).size, at).toBe(pieces.length);
        for (const cell of pieces) {
          const centre = beamCellCenter(p, cell);
          expect(centre.x, at).toBeCloseTo(p.origin.x + (colOf(cell, n) + 0.5) * BEAM_CELL, 9);
          expect(centre.z, at).toBeCloseTo(p.origin.z + (rowOf(cell, n) + 0.5) * BEAM_CELL, 9);
          expect(gap(centre, room), `${at} cell ${cell}`).toBeLessThan(room.r);
          expect(isReachable(u, centre), `${at} cell ${cell}`).toBe(true);
          for (const cache of u.caches) expect(gap(centre, cache), `${at} cell ${cell} ${cache.id}`).toBeGreaterThanOrEqual(1.5);
        }

        // Scrambled: the beam misses, so not even the light solves it.
        expect(traceBeam(p).hits, at).toBe(false);
        expect(isSolved(p, true), at).toBe(false);

        // The recorded solution: the beam runs cell to cell from the lens into the receiver —
        // and only the light makes that a solve (55-c).
        const aligned = structuredClone(p);
        aligned.mirrors.forEach((m, i) => {
          m.state = aligned.solution[i] as 0 | 1 | 2 | 3;
        });
        const beam = traceBeam(aligned);
        expect(beam.hits, at).toBe(true);
        expect(beam.cells[0], at).toBe(p.lens.cell);
        expect(beam.cells[beam.cells.length - 1], at).toBe(p.receiver.cell);
        for (let k = 1; k < beam.cells.length; k++) expect(adjacent(beam.cells[k - 1] as number, beam.cells[k] as number, n), at).toBe(true);
        for (const m of p.mirrors) expect(beam.cells, at).toContain(m.cell);
        expect(isSolved(aligned, true), at).toBe(true);
        expect(isSolved(aligned, false), at).toBe(false);
        expect(isSolved(aligned), at).toBe(false);
        expect(solvePuzzle(aligned), at).toEqual([]);

        // solvePuzzle cycles each mirror to its state; a turn never reads solved without the light.
        const results = play(p, solvePuzzle(p));
        expect(results.every((r) => r.ok && !r.solved), at).toBe(true);
        expect(traceBeam(p).hits, at).toBe(true);
        expect(isSolved(p, true), at).toBe(true);
      }
    });
  }

  it('traceBeam: turns at `/` and `\\`, stops at a closed mirror, a wall or the lens', () => {
    // A 4 × 4 grid: the lens at (1, 0) east, `/` at (1, 2) up to `/` at (0, 2), east into (0, 3).
    const p: BeamPuzzle = {
      kind: 'beam',
      n: 4,
      origin: { x: 0, z: 0 },
      lens: { cell: 4, dir: 2 },
      receiver: { cell: 3, dir: 2 },
      mirrors: [
        { cell: 6, state: 0 },
        { cell: 2, state: 0 },
      ],
      solution: Uint8Array.from([0, 0]),
    };
    expect(traceBeam(p)).toEqual({ cells: [4, 5, 6, 2, 3], hits: true });
    expect(beamCellCenter(p, 6)).toEqual({ x: 5, z: 3 });
    // `\` sends the eastbound beam south, off the board's bottom row.
    p.mirrors[0] = { cell: 6, state: 1 };
    expect(traceBeam(p)).toEqual({ cells: [4, 5, 6, 10, 14], hits: false });
    // Closed: the beam reaches the mirror and stops.
    p.mirrors[0] = { cell: 6, state: 2 };
    expect(traceBeam(p)).toEqual({ cells: [4, 5, 6], hits: false });
    p.mirrors[0] = { cell: 6, state: 3 };
    expect(traceBeam(p).hits).toBe(false);
    // A beam turned back into the lens's cell misses: `/` sends it north, `\` at (0, 2) west, `/` at (0, 0) south.
    const loop: BeamPuzzle = { ...p, mirrors: [{ cell: 6, state: 0 }, { cell: 2, state: 1 }, { cell: 0, state: 0 }], receiver: { cell: 15, dir: 2 } };
    expect(traceBeam(loop)).toEqual({ cells: [4, 5, 6, 2, 1, 0, 4], hits: false });
    // A mirror turn is always a move, and never a solve on its own.
    const solved = { ...p, mirrors: [{ cell: 6, state: 0 as const }, { cell: 2, state: 3 as const }] };
    expect(applyMove(solved, { mirror: 1 })).toEqual({ ok: true, solved: false });
    expect(solved.mirrors[1]?.state).toBe(0);
    expect(isSolved(solved, true)).toBe(true);
  });
});

// -------------------------------------------------------------------- hints

/** A handful of each kind on default anchors, `extra` random moves past their scramble (55-g). */
function boardsOf(kind: PuzzleKind, seeds: number, extra: number): Puzzle[] {
  const chapters: Record<PuzzleKind, readonly number[]> = {
    conduit: [1, 3, 5],
    calibration: [2, 4],
    sequence: [1, 2, 3, 4, 6],
    plates: [1, 3, 5],
    beam: [2, 4, 6],
  };
  const boards: Puzzle[] = [];
  for (const chapter of chapters[kind]) {
    for (let seed = 0; seed < seeds; seed++) {
      const p = generatePuzzle(kind, chapter, new Rng(10_000 * chapter + seed));
      const rng = new Rng(seed + 1);
      for (let k = 0; k < extra; k++) {
        if (p.kind === 'conduit') applyMove(p, { cell: rng.int(0, p.n * p.n - 1) });
        else if (p.kind === 'calibration') applyMove(p, { cell: rng.int(0, p.n * p.n - 1) });
        else if (p.kind === 'plates') applyMove(p, { plate: rng.int(0, p.plates.length - 1) });
        else if (p.kind === 'beam') applyMove(p, { mirror: rng.int(0, p.mirrors.length - 1) });
      }
      boards.push(p);
    }
  }
  return boards;
}

describe('hints (§4.2, §4.5)', () => {
  const KINDS: readonly PuzzleKind[] = ['conduit', 'calibration', 'sequence', 'plates', 'beam'];
  for (const kind of KINDS) {
    it(`${kind}: hintMove is solvePuzzle's first move, and following hints solves every board, scrambled further or not`, () => {
      const boards = [...boardsOf(kind, 20, 0), ...boardsOf(kind, 20, 12)];
      for (const [i, p] of boards.entries()) {
        const at = `${kind} board ${i}`;
        let steps = 0;
        for (;;) {
          const hint = hintMove(p);
          expect(hint, at).toEqual(solvePuzzle(p)[0] ?? null);
          if (hint === null) break;
          applyMove(p, hint);
          steps++;
          expect(steps, at).toBeLessThanOrEqual(100);
        }
        expect(isSolved(p, true), at).toBe(true);
        expect(hintMove(p), at).toBeNull();
      }
    });
  }

  it('a solved board has no hint', () => {
    const p = generatePuzzle('plates', 1, new Rng(3)) as PlatesPuzzle;
    play(p, p.order.map((plate) => ({ plate })));
    expect(isSolved(p)).toBe(true);
    expect(hintMove(p)).toBeNull();
    const c = generatePuzzle('calibration', 2, new Rng(3)) as CalibrationPuzzle;
    c.lit.fill(0);
    expect(hintMove(c)).toBeNull();
  });
});

// ------------------------------------------------------- the framework rules

describe('generatePuzzle and applyMove (§4.1–§4.3)', () => {
  it('determinism: the same fork deals the same board of every kind', () => {
    const u = caveFor('ferrum', 12);
    const anchor = anchorOf(u);
    const cases: [PuzzleKind, number, PuzzleSiteId][] = [
      ['conduit', 5, 'hive_vault'],
      ['calibration', 4, 'ferrum_vault'],
      ['sequence', 4, 'ferrum_relic'],
      ['plates', 3, 'thessaly_world'],
      ['beam', 4, 'ferrum_world'],
    ];
    for (const [kind, chapter, site] of cases) {
      for (const seed of [1, 2, 3]) {
        const a = generatePuzzle(kind, chapter, dealFor(site, seed), anchor);
        const b = generatePuzzle(kind, chapter, dealFor(site, seed), anchor);
        expect(b, `${kind} seed ${seed}`).toEqual(a);
        expect(generatePuzzle(kind, chapter, dealFor(site, seed + 100), anchor), `${kind} seed ${seed}`).not.toEqual(a);
      }
    }
  });

  it('a chapter without a row reads the nearest row below it, else the first', () => {
    const conduit = (chapter: number): ConduitPuzzle => generatePuzzle('conduit', chapter, new Rng(chapter)) as ConduitPuzzle;
    expect([conduit(2).n, conduit(2).sinks.length]).toEqual([4, 1]);
    expect([conduit(4).n, conduit(4).sinks.length]).toEqual([5, 1]);
    expect([conduit(6).n, conduit(6).sinks.length]).toEqual([5, 2]);
    expect([conduit(0).n, conduit(0).sinks.length]).toEqual([4, 1]);
    expect((generatePuzzle('calibration', 1, new Rng(1)) as CalibrationPuzzle).n).toBe(3);
    expect((generatePuzzle('calibration', 6, new Rng(1)) as CalibrationPuzzle).n).toBe(4);
    expect((generatePuzzle('sequence', 5, new Rng(1)) as SequencePuzzle).family).toBe('interleaved');
    expect((generatePuzzle('plates', 6, new Rng(1)) as PlatesPuzzle).plates.length).toBe(5);
    expect((generatePuzzle('beam', 1, new Rng(1)) as BeamPuzzle).mirrors.length).toBe(2);
  });

  it('without an anchor a world puzzle stands in a default room, its panel in another', () => {
    const plates = generatePuzzle('plates', 5, new Rng(8)) as PlatesPuzzle;
    for (const plate of plates.plates) expect(Math.hypot(plate.x, plate.z)).toBeLessThanOrEqual(6 + 1e-9);
    expect(plates.panel).toEqual({ x: 20, z: 0 });
    const beam = generatePuzzle('beam', 2, new Rng(8)) as BeamPuzzle;
    expect(beam.n).toBe(5);
    expect(beam.origin).toEqual({ x: -5, z: -5 });
  });

  it('a move of the wrong shape, or off the board, is refused and changes nothing', () => {
    const boards: Puzzle[] = [
      generatePuzzle('conduit', 1, new Rng(2)),
      generatePuzzle('calibration', 2, new Rng(2)),
      generatePuzzle('sequence', 1, new Rng(2)),
      generatePuzzle('plates', 1, new Rng(2)),
      generatePuzzle('beam', 2, new Rng(2)),
    ];
    const wrongShape: Record<PuzzleKind, PuzzleMove> = {
      conduit: { choice: 0 },
      calibration: { plate: 0 },
      sequence: { cell: 0 },
      plates: { mirror: 0 },
      beam: { cell: 0 },
    };
    const keyOf: Record<PuzzleKind, 'cell' | 'choice' | 'plate' | 'mirror'> = {
      conduit: 'cell',
      calibration: 'cell',
      sequence: 'choice',
      plates: 'plate',
      beam: 'mirror',
    };
    for (const p of boards) {
      const before = structuredClone(p);
      const key = keyOf[p.kind];
      const offBoard = [-1, 1.5, 999].map((i) => ({ [key]: i }) as PuzzleMove);
      for (const m of [wrongShape[p.kind], ...offBoard]) {
        expect(applyMove(p, m), `${p.kind} ${JSON.stringify(m)}`).toEqual({ ok: false, solved: false });
        expect(p, `${p.kind} ${JSON.stringify(m)}`).toEqual(before);
      }
    }
  });
});

// -------------------------------------------------------------- the terminals

describe('the terminals’ spots (§4.1)', () => {
  it('relicSpot: footprint + 1.5 m from landmark instance 0 toward the pad, facing the pad; null without one', () => {
    const layout = {
      pad: { x: 0, z: 0 },
      pois: [
        { kind: 'scan', instance: 0, x: 5, z: 5 },
        { kind: 'landmark', instance: 1, x: 100, z: 0 },
        { kind: 'landmark', instance: 0, x: 0, z: 60 },
      ],
    };
    const spot = relicSpot(layout, 4) as { x: number; z: number; facing: number };
    expect(spot.x).toBeCloseTo(0, 9);
    expect(spot.z).toBeCloseTo(54.5, 9);
    expect(spot.facing).toBeCloseTo(-Math.PI / 2, 9);
    const diagonal = relicSpot({ pad: { x: 10, z: 10 }, pois: [{ kind: 'landmark', instance: 0, x: 40, z: 50 }] }, 3.5) as Point;
    // 5 m along (−30, −40) / 50 from (40, 50).
    expect(diagonal.x).toBeCloseTo(37, 9);
    expect(diagonal.z).toBeCloseTo(46, 9);
    expect(relicSpot({ pad: { x: 0, z: 0 }, pois: [{ kind: 'landmark', instance: 1, x: 9, z: 9 }] }, 4)).toBeNull();
  });

  it('vaultTerminalSpot: 1.5 m from the door along its facing, looking back at the door', () => {
    const east = vaultTerminalSpot({ doorX: 10, doorZ: -4, doorFacing: 0 });
    expect(east.x).toBeCloseTo(11.5, 9);
    expect(east.z).toBeCloseTo(-4, 9);
    expect(east.facing).toBeCloseTo(Math.PI, 9);
    const south = vaultTerminalSpot({ doorX: 0, doorZ: 0, doorFacing: Math.PI / 2 });
    expect(south.x).toBeCloseTo(0, 9);
    expect(south.z).toBeCloseTo(1.5, 9);
    expect(Math.cos(south.facing)).toBeCloseTo(0, 9);
    expect(Math.sin(south.facing)).toBeCloseTo(-1, 9);
  });

  it('on real caves the vault terminal stands in the vault’s corridor, clear (0.9 m) and reachable', () => {
    for (const planet of PLANET_IDS) {
      for (let seed = 0; seed < 50; seed++) {
        const at = `${planet} seed ${seed}`;
        const u = caveFor(planet, seed);
        const spot = vaultTerminalSpot(u.vault);
        const vault = u.rooms[u.vault.room] as Room;
        expect(gap(spot, vault), at).toBeCloseTo(vault.r + 1.5, 9);
        expect(new ObstacleGrid(u).hitsCircle(spot.x, spot.z, 0.9), at).toBe(false);
        expect(isReachable(u, spot), at).toBe(true);
      }
    }
  });
});
