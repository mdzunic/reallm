// The puzzles of one planet visit (SPEC-055 §4.1, §4.4–§4.8, §4.10): the
// surface scene's runtime for its relic terminal above, and its vault terminal
// and world puzzle below. The rules are `systems/Puzzles.ts`; this is the
// wiring — which board each site plays, the panel, the plates underfoot and
// the beam, the hints and the bypass, the solve and its claim, and the debug
// hooks — kept beside `Level.ts` so the scene stays a composition root.
//
// A site's board is generated from `layout(planet).fork('puzzle:<site>')` the
// first time the visit uses it and kept for the visit (§4.1, 55-a). A site
// whose cache is in `progress.claimed` is solved: it builds nothing, and its
// terminal prompts `Unlocked` (55-h). Terminal puzzles hold the world through
// the scene's `ui` hold; world puzzles never do (§2, 55-j).
import type * as THREE from 'three';
import type { GameServices } from '@/core/Services';
import type { Save } from '@/core/Save';
import { tipDue, tipKey } from '@/systems/Guidance';
import type { CacheReward } from '@/data/caves';
import {
  HUMAN_LOCK,
  PUZZLE_SITE_IDS,
  PUZZLE_SITES,
  TIPS,
  type CacheId,
  type PlanetDef,
  type PuzzleSiteDef,
  type PuzzleSiteId,
} from '@/data/index';
import type { PlayerEntity } from '@/entities/Player';
import type { Economy } from '@/systems/Economy';
import type { Interactable } from '@/systems/Interactables';
import type { Layout } from '@/systems/Layout';
import {
  applyMove,
  BEAM_CELL,
  beamCellCenter,
  generatePuzzle,
  hintMove,
  isSolved,
  PLATE_RADIUS,
  poweredCells,
  PUZZLE_BYPASS_SECONDS,
  puzzleFork,
  relicSpot,
  solvePuzzle,
  traceBeam,
  vaultTerminalSpot,
  type BeamPuzzle,
  type PlatesPuzzle,
  type Puzzle,
  type PuzzleMove,
  type SequencePuzzle,
  type Side,
} from '@/systems/Puzzles';
import { fillLine, storyContextOf } from '@/systems/StoryContext';
import type { UndergroundLayout } from '@/systems/Underground';
import {
  bypassNote,
  bypassOpen,
  cellLabel,
  plateOrderGlyphs,
  platesPanelLine,
  PUZZLE_SOLVED_TEXT,
  puzzleHintLine,
  puzzleStatus,
  puzzleSubtitle,
  puzzleTitle,
  stonesText,
} from '@/systems/UiHelpers';
import type { LevelId } from '@/scenes/surface/Level';
import { choiceSheet } from '@/ui/ConfirmSheet';
import type { UiRoot } from '@/ui/dom';
import { openPuzzlePanel, type PuzzlePanelView } from '@/ui/PuzzlePanel';
import { PuzzleView, type PlateGlyph, type TerminalSpot } from '@/views/PuzzleView';
import { LANDMARK_FOOTPRINT } from '@/views/SurfaceProps';

// ------------------------------------------------------------- the words

/** §4.1: a terminal's interact circle, and a mirror's (§4.6); the plates' panel takes a terminal's. */
const TERMINAL_RADIUS = 1.5;
const MIRROR_RADIUS = 1.2;
/** §4.4, §4.6, §4.8: the prompts. */
const TERMINAL_TEXT = 'Use terminal';
const UNLOCKED_TEXT = 'Unlocked';
const PANEL_TEXT = 'Read the panel';
const MIRROR_TEXT = 'Turn the mirror';
/** §4.6: the world puzzles' good toasts. */
const PLATES_SOLVED_TEXT = 'Compliance recorded.';
const BEAM_SOLVED_TEXT = 'Lens aligned.';
/** §4.5: the world bypass's question. */
const FORCE_TITLE = 'ARIA: force the lock?';
const FORCE_YES = 'Force it';
const FORCE_NO = 'Not yet';

// ------------------------------------------------------- initial tuning

/** §4.4: `Solved` shows this long before the panel closes. */
const SOLVED_SECONDS = 1;
/** §4.5: ARIA's line holds the status this long after a hint. */
const HINT_LINE_SECONDS = 3;
/** §4.7: the human lock's verdict shows this long. */
const VERDICT_SECONDS = 4;
/** §4.6: the panel's line holds the tip strip this long. */
const PANEL_LINE_MS = 8000;
/** §4.5: a beam's next mirror pulses after every this many seconds in the puzzle room. */
const BEAM_HINT_SECONDS = 45;
/** §4.5: `Not yet` asks again this much later. */
const FORCE_AGAIN_SECONDS = 60;
/** §4.10 (dev): a goto stands this far in front of a terminal, a panel or a mirror. */
const GOTO_STAND = 1;

/** One site's state for the visit — the `Map` of §4.1, plus what the panel and the world need. */
interface SiteState {
  readonly def: PuzzleSiteDef;
  puzzle: Puzzle;
  /** §4.5: seconds open (a panel) or in the puzzle room (a world puzzle), summed over the visit. */
  openSeconds: number;
  hints: number;
  moves: number;
  /** §4.2: a sequence's deals so far — the next wrong pick forks `puzzle:<site>:<deal + 1>`. */
  deal: number;
  /** §4.5: the wrong choices the hints have greyed on this deal. */
  greyed: number[];
  /** §4.5: the cell the last hint outlined, until the next move; −1 with none. */
  hinted: number;
  /** Solved this visit (the claim follows once its panel closes). */
  solved: boolean;
}

/** The open panel. */
interface OpenPanel {
  readonly id: PuzzleSiteId;
  panel: { refresh(): void; close(): void };
  /** ARIA's hint line, while it holds the status. */
  flash: string | null;
  flashLeft: number;
  /** §4.7: the human lock's verdict. */
  verdict: string | null;
  /** Counting down to the close that claims the cache; −1 while the board is open. */
  closeIn: number;
  bypassed: boolean;
  /** The bypass countdown's whole seconds last drawn (0 once open), so it redraws only when they move. */
  shownLeft: number;
}

/** What the scene lends the runtime: its services, its holds and the few writes a solve makes. */
export interface PuzzleHost {
  readonly services: GameServices;
  readonly ui: UiRoot;
  readonly planet: PlanetDef;
  readonly save: Save;
  readonly economy: Economy;
  /** Where the puzzle views hang: the surface view's level root. */
  readonly viewRoot: THREE.Object3D | null;
  /** Takes (`true`) or releases one `ui` hold — the touch layer hides with it. */
  holdUi(on: boolean): void;
  /** Nothing else holds the screen: no hold, no modal line, no beat, no death. */
  free(): boolean;
  /** A line in the tip strip, now, for `ms`. */
  ariaLine(text: string, ms: number): void;
  /** SPEC-054 §4.8's open: `cache:opened`, the toast and the open model below. */
  cacheOpened(cache: CacheId, x: number, z: number, reward: CacheReward): void;
  player(): PlayerEntity | null;
  level(): LevelId;
  /** The flashlight is on below. */
  lightOn(): boolean;
  /** The player to (x, z), clear of obstacles, facing `facing` when given. */
  teleport(x: number, z: number, facing?: number): void;
}

/** A side's direction on XZ, as `player.facing` reads one: N is −z (§4.2's grid). */
function sideAngle(side: Side): number {
  switch (side) {
    case 1:
      return -Math.PI / 2;
    case 2:
      return 0;
    case 4:
      return Math.PI / 2;
    case 8:
      return Math.PI;
  }
}

/** §4.5: the whole seconds the bypass note counts down — 0 once the bypass is open. Allocates nothing. */
function bypassLeft(state: SiteState): number {
  return bypassOpen(state.openSeconds, state.hints) ? 0 : Math.ceil(PUZZLE_BYPASS_SECONDS - state.openSeconds);
}

/** §4.10: `cell:3`, `choice:1`, `plate:0`, `mirror:2`, or `-`. */
function moveText(move: PuzzleMove | null): string {
  if (move === null) return '-';
  if ('cell' in move) return `cell:${move.cell}`;
  if ('choice' in move) return `choice:${move.choice}`;
  if ('plate' in move) return `plate:${move.plate}`;
  return `mirror:${move.mirror}`;
}

export class PuzzleSites {
  readonly #host: PuzzleHost;
  readonly #states = new Map<PuzzleSiteId, SiteState>();
  /** This planet's three sites, by where they stand (the Hive has no relic). */
  readonly #relic: PuzzleSiteDef | null;
  readonly #vault: PuzzleSiteDef | null;
  readonly #world: PuzzleSiteDef | null;
  readonly #relicSpot: { x: number; z: number; facing: number } | null;
  readonly #relicMark: { x: number; z: number; spent: boolean } | null;
  #vaultSpot: { x: number; z: number; facing: number } | null = null;
  #cave: UndergroundLayout | null = null;
  #surfaceView: PuzzleView | null = null;
  #caveView: PuzzleView | null = null;
  #open: OpenPanel | null = null;
  // §4.6 — the plates: who is standing on which, the pulse after a wrong
  // press, and whether the panel has been read (the tracker's row).
  #inside = new Uint8Array(0);
  #platePulse = -1;
  #panelRead = false;
  // §4.5 — the world puzzle's clock in its room, the beam's next pulse, and
  // when ARIA next offers to force it.
  #nextBeamHint = BEAM_HINT_SECONDS;
  /** The room seconds from which ARIA may ask again — `Not yet` pushes it 60 s on. */
  #askAt = 0;
  #asking = false;
  /** The open `ARIA: force the lock?` sheet — the UI root outlives the scene, so dispose answers it. */
  #forceSheet: HTMLElement | null = null;
  #mirrorPulse = -1;
  /** §4.6, §4.10: the beam's last trace — run on a mirror move or a light toggle only. */
  #beamHits = false;
  #lit = false;

  constructor(host: PuzzleHost, layout: Layout) {
    this.#host = host;
    const of = (where: PuzzleSiteDef['where']): PuzzleSiteDef | null => {
      const id = `${host.planet.id}_${where}`;
      return (PUZZLE_SITE_IDS as readonly string[]).includes(id) ? PUZZLE_SITES[id as PuzzleSiteId] : null;
    };
    this.#relic = of('relic');
    this.#vault = of('vault');
    this.#world = of('world');
    // §4.1: the relic terminal stands LANDMARK_FOOTPRINT + 1.5 m from landmark
    // instance 0 toward the pad, inside the landmark's own clearing.
    this.#relicSpot = this.#relic === null ? null : relicSpot(layout, LANDMARK_FOOTPRINT[host.planet.biome]);
    this.#relicMark = this.#relicSpot === null ? null : { x: this.#relicSpot.x, z: this.#relicSpot.z, spent: false };
    if (host.viewRoot !== null) {
      this.#surfaceView = new PuzzleView(host.viewRoot, '#7ee0c3', host.services.assets);
      this.#drawSurface();
    }
  }

  /** §4.1: the surface level's relic terminal, if the planet has one. */
  surfaceInteractables(): Interactable[] {
    const relic = this.#relic;
    const spot = this.#relicSpot;
    if (relic === null || spot === null) return [];
    return [{ kind: 'relic', id: relic.id, x: spot.x, z: spot.z, radius: TERMINAL_RADIUS }];
  }

  /**
   * §4.1, §4.6: the cave's sites, built once at the visit's first descent — the
   * vault terminal outside the vault door, and the world puzzle in the puzzle
   * room (generated now, so it can be drawn) unless its cache is claimed.
   * Returns the interactables they add to the cave's level.
   */
  buildCave(u: UndergroundLayout, beaconColor: string): Interactable[] {
    this.#cave = u;
    const out: Interactable[] = [];
    const vault = this.#vault;
    if (vault !== null) {
      const spot = vaultTerminalSpot(u.vault);
      this.#vaultSpot = spot;
      out.push({ kind: 'vault', id: vault.id, x: spot.x, z: spot.z, radius: TERMINAL_RADIUS });
    }
    const world = this.#world;
    if (world !== null && !this.#claimed(world)) {
      const state = this.#state(world.id);
      if (state !== null) {
        const p = state.puzzle;
        if (p.kind === 'plates') {
          this.#inside = new Uint8Array(p.plates.length);
          out.push({ kind: 'panel', id: world.id, x: p.panel.x, z: p.panel.z, radius: TERMINAL_RADIUS });
        } else if (p.kind === 'beam') {
          p.mirrors.forEach((mirror, i) => {
            const at = beamCellCenter(p, mirror.cell);
            out.push({ kind: 'mirror', id: `${world.id}:${i}`, x: at.x, z: at.z, radius: MIRROR_RADIUS });
          });
          this.#beamHits = traceBeam(p).hits;
        }
      }
    }
    if (this.#host.viewRoot !== null && this.#caveView === null) {
      this.#caveView = new PuzzleView(this.#host.viewRoot, beaconColor, this.#host.services.assets);
      this.#caveView.root.visible = this.#host.level() === 'underground';
    }
    this.#drawCave();
    return out;
  }

  /** §4.4: the views follow the level — the relic above, the cave's pieces below. */
  onLevel(level: LevelId): void {
    if (this.#surfaceView !== null) this.#surfaceView.root.visible = level === 'surface';
    if (this.#caveView !== null) this.#caveView.root.visible = level === 'underground';
    this.#syncBeam();
  }

  /** SPEC-018 §4.10: the planet's lazy set landed — the relic terminal swaps its stand-in for `cave_terminal`. */
  onAssets(): void {
    this.#drawSurface();
  }

  /** §4.6, 55-c: the flashlight switched — the beam draws, or goes, and the step may solve on it. */
  onLight(): void {
    this.#syncBeam();
  }

  /** 55-k: a death resets the plates' progress and nothing else. */
  onDeath(): void {
    const world = this.#world;
    const state = world === null ? undefined : this.#states.get(world.id);
    if (state === undefined || state.solved || state.puzzle.kind !== 'plates') return;
    state.puzzle.progress = 0;
    this.#platePulse = -1;
    this.#inside.fill(0);
    this.#drawPlates(state.puzzle);
  }

  // -------------------------------------------------------------- prompts

  /** §4.4, §4.6: the prompt an interactable of ours raises, or `null` for one that offers nothing. */
  prompt(target: Interactable, out: { text: string; action: boolean }): { text: string; action: boolean } | null {
    switch (target.kind) {
      case 'vault':
      case 'relic': {
        const def = PUZZLE_SITES[target.id as PuzzleSiteId];
        const solved = this.#claimed(def);
        out.text = solved ? UNLOCKED_TEXT : TERMINAL_TEXT;
        out.action = !solved;
        return out;
      }
      case 'panel':
      case 'mirror': {
        const world = this.#world;
        if (world === null || this.#claimed(world) || this.#states.get(world.id)?.solved === true) return null;
        out.text = target.kind === 'panel' ? PANEL_TEXT : MIRROR_TEXT;
        out.action = true;
        return out;
      }
      default:
        return null;
    }
  }

  /** §4.4, §4.6: `interact` at one of ours. */
  interact(target: Interactable): void {
    switch (target.kind) {
      case 'vault':
      case 'relic':
        this.#openPanel(target.id as PuzzleSiteId);
        return;
      case 'panel':
        this.#readPanel();
        return;
      case 'mirror':
        this.#turnMirror(Number(target.id.slice(target.id.lastIndexOf(':') + 1)));
        return;
      default:
        return;
    }
  }

  // -------------------------------------------------------------- the steps

  /**
   * The unheld step (§4.5, §4.6): the plates underfoot, the beam with the light
   * on, and the world puzzle's clock in its room — its hints and the offer to
   * force it. Allocates nothing.
   */
  step(dt: number): void {
    const world = this.#world;
    const p = this.#host.player();
    if (world === null || p === null || this.#host.level() !== 'underground') return;
    const state = this.#states.get(world.id);
    if (state === undefined || state.solved || this.#claimed(world)) return;
    const puzzle = state.puzzle;
    if (puzzle.kind === 'plates' && p.alive) this.#stepPlates(state, puzzle, p);
    if (puzzle.kind === 'beam' && this.#beamHits && this.#host.lightOn()) {
      this.#solveWorld(state, false);
      return;
    }
    const cave = this.#cave;
    const room = cave?.rooms[cave.puzzleRoom];
    if (room === undefined || !p.alive || Math.hypot(p.x - room.x, p.z - room.z) > room.r) return;
    state.openSeconds += dt;
    // §4.5: every 45 s in the room, the beam's next mirror pulses and counts as a hint.
    if (puzzle.kind === 'beam' && state.openSeconds >= this.#nextBeamHint) {
      this.#nextBeamHint += BEAM_HINT_SECONDS;
      const move = hintMove(puzzle);
      if (move !== null && 'mirror' in move) {
        state.hints++;
        this.#mirrorPulse = move.mirror;
        this.#caveView?.setMirrorPulse(move.mirror);
      }
    }
    // §4.5: 90 s in the room or three hints, and ARIA offers to force it.
    if (!this.#asking && bypassOpen(state.openSeconds, state.hints) && state.openSeconds >= this.#askAt && this.#host.free()) {
      this.#askForce(state);
    }
  }

  /** The held step (§4.4, §4.5): the open panel's clocks — time open, ARIA's line, `Solved`, the verdict. */
  heldStep(dt: number): void {
    const open = this.#open;
    if (open === null) return;
    const state = this.#states.get(open.id);
    if (state === undefined) return;
    if (open.closeIn >= 0) {
      open.closeIn -= dt;
      if (open.closeIn <= 0) this.#finishPanel();
      return;
    }
    state.openSeconds += dt;
    let redraw = false;
    if (open.flash !== null) {
      open.flashLeft -= dt;
      if (open.flashLeft <= 0) {
        open.flash = null;
        redraw = true;
      }
    }
    if (state.def.family !== 'human' && bypassLeft(state) !== open.shownLeft) redraw = true;
    if (redraw) open.panel.refresh();
  }

  /** §4.5: the pulses, on the view clock. */
  render(time: number, reduceMotion: boolean): void {
    this.#caveView?.sync(time, reduceMotion);
  }

  // -------------------------------------------------------------- the panel

  /** §4.4: open a terminal's panel — never during another hold, never on a solved site. */
  #openPanel(id: PuzzleSiteId): void {
    const def = PUZZLE_SITES[id];
    if (this.#open !== null || this.#claimed(def) || !this.#host.free()) return;
    const state = this.#state(id);
    if (state === null || state.solved) return;
    this.#host.holdUi(true);
    const handlers = {
      move: (m: PuzzleMove): void => this.#panelMove(m),
      hint: (): void => this.#panelHint(),
      bypass: (): void => this.#panelBypass(),
      close: (): void => this.closePanel(),
    };
    const open: OpenPanel = {
      id,
      panel: { refresh: () => undefined, close: () => undefined },
      flash: null,
      flashLeft: 0,
      verdict: null,
      closeIn: -1,
      bypassed: false,
      shownLeft: -1,
    };
    this.#open = open;
    open.panel = openPuzzlePanel(this.#host.ui, () => this.#view(open, state), handlers);
    // §4.4: the `puzzle` tip at the first open — over the panel, so now.
    this.#tipNow();
  }

  /**
   * Escape, Back, `puzzle-close` and a pause: the panel goes and the site keeps
   * its state (55-a). A solved board waiting out its `Solved` claims now.
   */
  closePanel(): void {
    const open = this.#open;
    if (open === null) return;
    if (open.closeIn >= 0) {
      this.#finishPanel();
      return;
    }
    this.#open = null;
    open.panel.close();
    this.#host.holdUi(false);
  }

  /** The panel's close after a solve, then §4.8's claim. */
  #finishPanel(): void {
    const open = this.#open;
    if (open === null) return;
    this.#open = null;
    open.panel.close();
    this.#host.holdUi(false);
    const state = this.#states.get(open.id);
    if (state !== undefined) this.#claim(state, open.bypassed);
  }

  #view(open: OpenPanel, state: SiteState): PuzzlePanelView {
    const p = state.puzzle;
    const human = state.def.family === 'human';
    const status = open.closeIn >= 0 && open.verdict === null
      ? PUZZLE_SOLVED_TEXT
      : (open.flash ?? (state.moves === 0 && state.hints === 0 ? puzzleSubtitle(p.kind) : puzzleStatus(state.moves, state.hints)));
    const note = human ? null : bypassNote(state.openSeconds, state.hints);
    open.shownLeft = bypassLeft(state);
    const view: PuzzlePanelView = {
      title: puzzleTitle(p.kind, this.#host.planet.chapter, human),
      status,
      hint: !human,
      bypass: human ? 'hidden' : bypassOpen(state.openSeconds, state.hints) && open.closeIn < 0 ? 'enabled' : 'disabled',
      bypassNote: open.closeIn >= 0 ? null : note,
    };
    if (open.verdict !== null) view.verdict = open.verdict;
    if (p.kind === 'conduit') {
      const powered = poweredCells(p);
      view.n = p.n;
      view.cells = Array.from({ length: p.n * p.n }, (_, i) => ({
        label: cellLabel(p, i),
        glyph: (p.pieces[i] ?? 0) === 0 ? '' : `pipe:${p.pieces[i]}:${p.rots[i]}`,
        powered: powered[i] === 1,
        hinted: state.hinted === i,
      }));
    } else if (p.kind === 'calibration') {
      view.n = p.n;
      view.cells = Array.from({ length: p.n * p.n }, (_, i) => ({
        label: cellLabel(p, i),
        glyph: p.lit[i] === 1 ? '◆' : '·',
        powered: false,
        hinted: state.hinted === i,
      }));
    } else if (p.kind === 'sequence') {
      view.tokens = p.shown;
      view.choices = p.choices.map((text, i) => ({ text, hinted: false, disabled: state.greyed.includes(i) }));
    }
    return view;
  }

  /** §4.4: a move on the open board — counted, said, and on a solve `Solved` for 1 s. */
  #panelMove(m: PuzzleMove): void {
    const open = this.#open;
    const state = open === null ? undefined : this.#states.get(open.id);
    if (open === null || state === undefined || open.closeIn >= 0 || state.solved) return;
    const p = state.puzzle;
    const events = this.#host.services.events;
    // §4.7: the human lock takes any answer and says what it made of it.
    if (p.kind === 'sequence' && state.def.family === 'human' && 'choice' in m) {
      const picked = p.choices[m.choice];
      if (picked === undefined) return;
      applyMove(p, m);
      state.moves++;
      state.solved = true;
      events.emit('puzzle:moved', { site: state.def.id, ok: true });
      const line = picked === HUMAN_LOCK.predicted ? HUMAN_LOCK.linePredicted : HUMAN_LOCK.lineSampled;
      open.verdict = fillLine(line, storyContextOf(this.#host.save));
      open.closeIn = VERDICT_SECONDS;
      open.panel.refresh();
      return;
    }
    const result = applyMove(p, m);
    // §4.2, 55-e: an empty cell is not a move.
    if (!result.ok && p.kind !== 'sequence') return;
    state.moves++;
    state.hinted = -1;
    open.flash = null;
    events.emit('puzzle:moved', { site: state.def.id, ok: result.ok });
    if (p.kind === 'sequence' && !result.ok) {
      // §4.2, 55-d: a wrong pick deals a new sequence of the same family.
      state.deal++;
      state.puzzle = this.#generate(state.def, state.deal);
      state.greyed = [];
    }
    if (result.solved || isSolved(state.puzzle)) {
      state.solved = true;
      open.closeIn = SOLVED_SECONDS;
    }
    open.panel.refresh();
  }

  /** §4.5: a free hint — the next move outlined, or one wrong choice greyed — and ARIA's line. */
  #panelHint(): void {
    const open = this.#open;
    const state = open === null ? undefined : this.#states.get(open.id);
    if (open === null || state === undefined || open.closeIn >= 0 || state.def.family === 'human') return;
    const p = state.puzzle;
    const move = hintMove(p);
    if (move === null) return;
    state.hints++;
    if ('cell' in move) state.hinted = move.cell;
    if (p.kind === 'sequence') {
      const wrong = p.choices.findIndex((_, i) => i !== p.answer && !state.greyed.includes(i));
      if (wrong >= 0) state.greyed.push(wrong);
    }
    open.flash = puzzleHintLine(state.hints);
    open.flashLeft = HINT_LINE_SECONDS;
    open.panel.refresh();
  }

  /** §4.5: `ARIA: force the lock` — solved, and the claim keeps back its flawless part. */
  #panelBypass(): void {
    const open = this.#open;
    const state = open === null ? undefined : this.#states.get(open.id);
    if (open === null || state === undefined || open.closeIn >= 0 || state.def.family === 'human') return;
    if (!bypassOpen(state.openSeconds, state.hints)) return;
    this.#solveBoard(state.puzzle);
    state.solved = true;
    open.bypassed = true;
    open.flash = null;
    open.closeIn = SOLVED_SECONDS;
    open.panel.refresh();
  }

  /** §4.4: the `puzzle` tip, shown over the panel at once — the queue waits out every hold. */
  #tipNow(): void {
    const services = this.#host.services;
    if (services.perf === true) return;
    const settings = services.settings;
    const scheme = services.input.state.scheme;
    if (settings.get().guidance !== 'full' || !tipDue(settings.get().tipsSeen, 'puzzle', scheme)) return;
    this.#host.ariaLine(scheme === 'touch' ? TIPS.puzzle.touch : TIPS.puzzle.keyboard, PANEL_LINE_MS);
    settings.set({ tipsSeen: [...settings.get().tipsSeen, tipKey('puzzle', scheme)] });
  }

  // -------------------------------------------------------------- the world

  /** §4.6: the plates' panel reads the order into the tip strip for 8 s, and the tracker keeps it. */
  #readPanel(): void {
    const world = this.#world;
    const state = world === null ? undefined : this.#states.get(world.id);
    if (state === undefined || state.solved || state.puzzle.kind !== 'plates') return;
    this.#panelRead = true;
    this.#host.ariaLine(platesPanelLine(state.puzzle), PANEL_LINE_MS);
  }

  /** §4.6: a plate pressed once per entry — the edge from outside to inside. */
  #stepPlates(state: SiteState, p: PlatesPuzzle, player: PlayerEntity): void {
    const reach = PLATE_RADIUS + player.radius;
    for (let i = 0; i < p.plates.length; i++) {
      const plate = p.plates[i] as PlatesPuzzle['plates'][number];
      const inside = Math.hypot(player.x - plate.x, player.z - plate.z) <= reach ? 1 : 0;
      const was = this.#inside[i];
      this.#inside[i] = inside;
      if (inside === 1 && was === 0) this.#pressPlate(state, p, i);
      if (state.solved) return;
    }
  }

  #pressPlate(state: SiteState, p: PlatesPuzzle, plate: number): void {
    const result = applyMove(p, { plate });
    state.moves++;
    this.#host.services.events.emit('puzzle:moved', { site: state.def.id, ok: result.ok });
    // §4.5: after a wrong press the next plate in the order pulses until it is pressed.
    if (!result.ok) this.#platePulse = p.order[p.progress] ?? -1;
    else if (this.#platePulse === plate) this.#platePulse = -1;
    this.#drawPlates(p);
    if (result.solved) this.#solveWorld(state, false);
  }

  /** §4.6: `interact` at a mirror cycles it; the beam is traced again. */
  #turnMirror(index: number): void {
    const world = this.#world;
    const state = world === null ? undefined : this.#states.get(world.id);
    if (state === undefined || state.solved || state.puzzle.kind !== 'beam') return;
    const p = state.puzzle;
    const result = applyMove(p, { mirror: index });
    if (!result.ok) return;
    state.moves++;
    this.#host.services.events.emit('puzzle:moved', { site: state.def.id, ok: true });
    this.#caveView?.setMirrorState(index, p.mirrors[index]?.state ?? 0);
    if (this.#mirrorPulse === index) {
      this.#mirrorPulse = -1;
      this.#caveView?.setMirrorPulse(-1);
    }
    this.#beamHits = traceBeam(p).hits;
    this.#lit = false;
    this.#syncBeam();
  }

  /** §4.5: `ARIA: force the lock?` — `Force it` solves without the flawless part; `Not yet` asks again in 60 s. */
  #askForce(state: SiteState): void {
    this.#asking = true;
    this.#host.holdUi(true);
    const answered = choiceSheet(this.#host.ui, { title: FORCE_TITLE, confirmText: FORCE_YES, cancelText: FORCE_NO });
    // The sheet mounts as it is asked; the newest one is this one.
    const sheets = this.#host.ui.root.querySelectorAll<HTMLElement>('[data-testid="confirm-sheet"]');
    this.#forceSheet = sheets[sheets.length - 1] ?? null;
    void answered.then((answer) => {
      this.#forceSheet = null;
      this.#asking = false;
      this.#host.holdUi(false);
      if (answer === 'primary' && !state.solved && !this.#claimed(state.def)) {
        this.#solveBoard(state.puzzle);
        this.#solveWorld(state, true);
        return;
      }
      this.#askAt = state.openSeconds + FORCE_AGAIN_SECONDS;
    });
  }

  /** §4.6, §4.8: a world puzzle solved — its toast, then the claim. */
  #solveWorld(state: SiteState, bypassed: boolean): void {
    if (state.solved) return;
    state.solved = true;
    this.#platePulse = -1;
    this.#mirrorPulse = -1;
    if (state.puzzle.kind === 'plates') this.#drawPlates(state.puzzle);
    this.#caveView?.setMirrorPulse(-1);
    this.#host.services.events.emit('ui:toast', { kind: 'good', text: state.puzzle.kind === 'plates' ? PLATES_SOLVED_TEXT : BEAM_SOLVED_TEXT });
    this.#claim(state, bypassed);
  }

  /** Every move `solvePuzzle` names, applied — the bypass and the debug solve. */
  #solveBoard(p: Puzzle): void {
    for (const move of solvePuzzle(p)) applyMove(p, move);
    if (p.kind === 'beam') {
      this.#beamHits = traceBeam(p).hits;
      p.mirrors.forEach((mirror, i) => this.#caveView?.setMirrorState(i, mirror.state));
      this.#lit = false;
      this.#syncBeam();
    }
    if (p.kind === 'plates') this.#drawPlates(p);
  }

  // -------------------------------------------------------------- the claim

  /**
   * §4.8: `puzzle:solved`, then the claim — flawless unless ARIA forced it —
   * which raises SPEC-054's `cache:opened` and toast, and the terminal goes dark.
   */
  #claim(state: SiteState, bypassed: boolean): void {
    state.solved = true;
    const def = state.def;
    this.#host.services.events.emit('puzzle:solved', { site: def.id, hints: state.hints, bypassed });
    const result = this.#host.economy.claimCache(def.cache, { flawless: !bypassed });
    if (result.ok) {
      const at = this.#cacheSpot(def);
      this.#host.cacheOpened(def.cache, at.x, at.z, result.reward);
    }
    this.#drawSurface();
    this.#drawCave();
  }

  /** Where a site's cache opens: the cave's cache for a vault or a world puzzle, the terminal for a relic. */
  #cacheSpot(def: PuzzleSiteDef): { x: number; z: number } {
    const cache = this.#cave?.caches.find((entry) => entry.id === def.cache);
    if (cache !== undefined) return cache;
    return this.#relicSpot ?? this.#vaultSpot ?? { x: 0, z: 0 };
  }

  // -------------------------------------------------------------- the boards

  /** A site is solved exactly when its cache is claimed (SPEC-047). */
  #claimed(def: PuzzleSiteDef): boolean {
    return this.#host.save.progress.claimed.includes(def.cache);
  }

  /** §4.1: the site's state, generated the first time the visit uses it; `null` for a solved site, which builds nothing. */
  #state(id: PuzzleSiteId): SiteState | null {
    const existing = this.#states.get(id);
    if (existing !== undefined) return existing;
    const def = PUZZLE_SITES[id];
    if (this.#claimed(def)) return null;
    if (def.where === 'world' && this.#cave === null) return null;
    const state: SiteState = {
      def,
      puzzle: this.#generate(def, 0),
      openSeconds: 0,
      hints: 0,
      moves: 0,
      deal: 0,
      greyed: [],
      hinted: -1,
      solved: false,
    };
    this.#states.set(id, state);
    return state;
  }

  /** §4.1: `layout(planet).fork('puzzle:<site>')`, or `…:<deal>` for a sequence's later deals. */
  #generate(def: PuzzleSiteDef, deal: number): Puzzle {
    const rng = puzzleFork(this.#host.services.rng.layout(this.#host.planet.id), def.id, deal);
    const cave = this.#cave;
    const room = cave?.rooms[cave.puzzleRoom];
    const panelRoom = cave?.rooms[cave.panelRoom];
    const anchor =
      def.where === 'world' && cave !== null && room !== undefined
        ? { room, ...(panelRoom === undefined ? {} : { panelRoom }), avoid: cave.caches }
        : undefined;
    return generatePuzzle(def.kind, this.#host.planet.chapter, rng, anchor, def.family);
  }

  // -------------------------------------------------------------- drawing

  #drawSurface(): void {
    const view = this.#surfaceView;
    const relic = this.#relic;
    const spot = this.#relicSpot;
    if (view === null) return;
    view.setTerminals(relic === null || spot === null ? [] : [{ ...spot, spent: this.#claimed(relic) }]);
  }

  #drawCave(): void {
    const view = this.#caveView;
    if (view === null) return;
    const terminals: TerminalSpot[] = [];
    const vault = this.#vault;
    if (vault !== null && this.#vaultSpot !== null) terminals.push({ ...this.#vaultSpot, spent: this.#claimed(vault) });
    const world = this.#world;
    const state = world === null ? undefined : this.#states.get(world.id);
    const p = state?.puzzle;
    if (p?.kind === 'plates') {
      // The plates' panel is a terminal too — the order on its screen, dark once solved.
      const facing = this.#panelFacing(p);
      const spent = state?.solved === true;
      terminals.push({ x: p.panel.x, z: p.panel.z, facing, spent });
      view.setPanelGlyphs(spent ? null : { x: p.panel.x, z: p.panel.z, facing }, plateOrderGlyphs(p) as PlateGlyph[]);
    }
    view.setTerminals(terminals);
    if (p?.kind === 'plates') {
      view.setPlates(p.plates);
      this.#drawPlates(p);
    }
    if (p?.kind === 'beam') {
      view.setMirrors(p.mirrors.map((mirror) => ({ ...beamCellCenter(p, mirror.cell), state: mirror.state })));
      view.setEnds(
        { ...beamCellCenter(p, p.lens.cell), facing: sideAngle(p.lens.dir) },
        { ...beamCellCenter(p, p.receiver.cell), facing: sideAngle(p.receiver.dir) + Math.PI },
      );
      this.#lit = false;
      this.#syncBeam();
    }
  }

  /**
   * The way the plates' panel faces: out from its room's centre — or, standing
   * at the centre, toward the puzzle room it reads for.
   */
  #panelFacing(p: PlatesPuzzle): number {
    const cave = this.#cave;
    const room = cave?.rooms[cave.panelRoom];
    if (room !== undefined && Math.hypot(p.panel.x - room.x, p.panel.z - room.z) > 0.5) {
      return Math.atan2(p.panel.z - room.z, p.panel.x - room.x);
    }
    const puzzle = cave?.rooms[cave.puzzleRoom];
    return puzzle === undefined ? 0 : Math.atan2(puzzle.z - p.panel.z, puzzle.x - p.panel.x);
  }

  /** The pressed plates are the order's first `progress`; all of them once solved. */
  #drawPlates(p: PlatesPuzzle): void {
    const view = this.#caveView;
    const world = this.#world;
    if (view === null || world === null) return;
    const solved = this.#states.get(world.id)?.solved === true || p.progress >= p.order.length;
    view.setPressed(p.plates.map((_, i) => solved || p.order.indexOf(i) < p.progress));
    view.setPlatePulse(solved ? -1 : this.#platePulse);
  }

  /** §4.6: the beam draws only while the flashlight is on below; redrawn only when the trace or the light changed. */
  #syncBeam(): void {
    const view = this.#caveView;
    const world = this.#world;
    const state = world === null ? undefined : this.#states.get(world.id);
    if (view === null || state === undefined || state.puzzle.kind !== 'beam') return;
    const on = this.#host.lightOn() && this.#host.level() === 'underground';
    if (on === this.#lit && view.beamDrawn === on) return;
    this.#lit = on;
    view.setBeam(on ? this.#beamPoints(state.puzzle) : null);
  }

  /** §4.6: the beam's path — the lens, every cell it crosses, and its end: the receiver, a closed mirror or the grid's edge. */
  #beamPoints(p: BeamPuzzle): number[] {
    const { cells, hits } = traceBeam(p);
    const points: number[] = [];
    for (const cell of cells) {
      const at = beamCellCenter(p, cell);
      points.push(at.x, at.z);
    }
    const last = cells[cells.length - 1];
    if (!hits && last !== undefined && !p.mirrors.some((mirror) => mirror.cell === last)) {
      // It left the grid: run on to the edge, half a cell further.
      const n = points.length;
      let dx = 0;
      let dz = 0;
      if (n >= 4) {
        dx = (points[n - 2] as number) - (points[n - 4] as number);
        dz = (points[n - 1] as number) - (points[n - 3] as number);
      } else {
        dx = Math.cos(sideAngle(p.lens.dir));
        dz = Math.sin(sideAngle(p.lens.dir));
      }
      const length = Math.hypot(dx, dz) || 1;
      points.push((points[n - 2] as number) + (dx / length) * (BEAM_CELL / 2), (points[n - 1] as number) + (dz / length) * (BEAM_CELL / 2));
    }
    return points;
  }

  // -------------------------------------------------------------- the HUD and the map

  /** §4.6: the tracker's focus row below once the panel is read, until the plates are solved; `null` otherwise. */
  focusText(): string | null {
    const world = this.#world;
    if (!this.#panelRead || world === null || this.#host.level() !== 'underground') return null;
    const state = this.#states.get(world.id);
    if (state === undefined || state.solved || state.puzzle.kind !== 'plates') return null;
    return stonesText(state.puzzle);
  }

  /**
   * §4.1: the relic terminal for the map, and whether it is spent — one object
   * for the visit, written in place, so a repaint allocates nothing (SPEC-026
   * §4.9); `null` on a planet without one.
   */
  relicMark(): { readonly x: number; readonly z: number; readonly spent: boolean } | null {
    const relic = this.#relic;
    const mark = this.#relicMark;
    if (relic === null || mark === null) return null;
    mark.spent = this.#claimed(relic);
    return mark;
  }

  // -------------------------------------------------------------- sceneInfo

  /** §3: `puzzle`, `puzzleHint`, `puzzleMoves` and `puzzlesSolved`. */
  info(info: Record<string, number | string>): void {
    const focus = this.#focus();
    info['puzzle'] = this.#open?.id ?? '-';
    info['puzzleHint'] = focus === null || focus.solved ? '-' : moveText(hintMove(focus.puzzle));
    info['puzzleMoves'] = focus?.moves ?? 0;
    info['puzzleHints'] = focus?.hints ?? 0;
    info['puzzleOpenSeconds'] = Math.floor(focus?.openSeconds ?? 0);
    let solved = 0;
    for (const id of PUZZLE_SITE_IDS) {
      const def = PUZZLE_SITES[id];
      if (def.planet === this.#host.planet.id && this.#claimed(def)) solved++;
    }
    info['puzzlesSolved'] = solved;
    info['puzzleBeam'] = this.#beamHits ? 1 : 0;
  }

  /** The site `sceneInfo` reports on: the open panel's, else the world puzzle's while below. */
  #focus(): SiteState | null {
    const open = this.#open;
    if (open !== null) return this.#states.get(open.id) ?? null;
    const world = this.#world;
    if (world === null || this.#host.level() !== 'underground') return null;
    return this.#states.get(world.id) ?? null;
  }

  // -------------------------------------------------------------- debug (§4.10)

  /**
   * `surface-goto-puzzle`: beside the nearest unsolved site's interactable on
   * the active level — a terminal, the plates' panel or the next mirror. Once
   * the panel has been read, the plates' anchor is the next plate in the
   * order, and the salvager lands on it, so repeated presses walk the order.
   * With every site here solved, it stands at the spent terminal instead.
   */
  debugGoto(): void {
    const p = this.#host.player();
    if (p === null || !p.alive || this.#open !== null) return;
    const below = this.#host.level() === 'underground';
    let best: { x: number; z: number; standX: number; standZ: number; facing: number } | null = null;
    let bestD = Infinity;
    const consider = (x: number, z: number, standX: number, standZ: number, facing: number): void => {
      const d = Math.hypot(x - p.x, z - p.z);
      if (d < bestD) {
        bestD = d;
        best = { x, z, standX, standZ, facing };
      }
    };
    const terminal = (spot: { x: number; z: number; facing: number }): void => {
      const standX = spot.x + Math.cos(spot.facing) * GOTO_STAND;
      const standZ = spot.z + Math.sin(spot.facing) * GOTO_STAND;
      consider(spot.x, spot.z, standX, standZ, spot.facing + Math.PI);
    };
    if (!below) {
      if (this.#relic !== null && this.#relicSpot !== null && !this.#claimed(this.#relic)) terminal(this.#relicSpot);
    } else {
      if (this.#vault !== null && this.#vaultSpot !== null && !this.#claimed(this.#vault)) terminal(this.#vaultSpot);
      const world = this.#world;
      const state = world === null ? undefined : this.#states.get(world.id);
      if (state !== undefined && !state.solved && world !== null && !this.#claimed(world)) {
        const puzzle = state.puzzle;
        if (puzzle.kind === 'plates') {
          const next = puzzle.plates[puzzle.order[puzzle.progress] ?? -1];
          if (this.#panelRead && next !== undefined) consider(next.x, next.z, next.x, next.z, p.facing);
          else terminal({ x: puzzle.panel.x, z: puzzle.panel.z, facing: this.#panelFacing(puzzle) });
        } else if (puzzle.kind === 'beam') {
          const move = hintMove(puzzle);
          const index = move !== null && 'mirror' in move ? move.mirror : 0;
          const mirror = puzzle.mirrors[index];
          if (mirror !== undefined) {
            const at = beamCellCenter(puzzle, mirror.cell);
            consider(at.x, at.z, at.x + GOTO_STAND * 0.7, at.z, Math.PI);
          }
        }
      }
    }
    // With nothing left unsolved here, the spent terminal — so its `Unlocked` can be read.
    if (best === null) {
      if (!below && this.#relicSpot !== null) terminal(this.#relicSpot);
      if (below && this.#vaultSpot !== null) terminal(this.#vaultSpot);
    }
    const target = best as { standX: number; standZ: number; facing: number } | null;
    if (target === null) return;
    this.#host.teleport(target.standX, target.standZ, target.facing);
  }

  /**
   * `surface-solve-puzzle`: `solvePuzzle` applied to the open panel, else the
   * nearest unsolved site on the active level. A beam aligns, and solves on
   * the next step the light is on. Never a bypass: the claim is flawless.
   */
  debugSolve(): void {
    const open = this.#open;
    if (open !== null) {
      const state = this.#states.get(open.id);
      if (state === undefined || open.closeIn >= 0) return;
      const move = solvePuzzle(state.puzzle)[0];
      if (state.def.family === 'human' && move !== undefined) {
        this.#panelMove(move);
        return;
      }
      this.#solveBoard(state.puzzle);
      state.solved = true;
      open.flash = null;
      open.closeIn = SOLVED_SECONDS;
      open.panel.refresh();
      return;
    }
    const p = this.#host.player();
    if (p === null) return;
    const below = this.#host.level() === 'underground';
    const candidates: { def: PuzzleSiteDef; x: number; z: number }[] = [];
    if (!below && this.#relic !== null && this.#relicSpot !== null) candidates.push({ def: this.#relic, ...this.#relicSpot });
    if (below && this.#vault !== null && this.#vaultSpot !== null) candidates.push({ def: this.#vault, ...this.#vaultSpot });
    if (below && this.#world !== null && this.#cave !== null) {
      const room = this.#cave.rooms[this.#cave.puzzleRoom];
      if (room !== undefined) candidates.push({ def: this.#world, x: room.x, z: room.z });
    }
    candidates.sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z));
    for (const { def } of candidates) {
      if (this.#claimed(def)) continue;
      const state = this.#state(def.id);
      if (state === null || state.solved) continue;
      if (def.where === 'world') {
        const puzzle = state.puzzle;
        if (puzzle.kind === 'plates') {
          for (const move of solvePuzzle(puzzle)) {
            if ('plate' in move) this.#pressPlate(state, puzzle, move.plate);
          }
        } else {
          this.#solveBoard(puzzle);
        }
        return;
      }
      if (def.family === 'human') {
        const puzzle = state.puzzle as SequencePuzzle;
        applyMove(puzzle, { choice: puzzle.answer });
      } else {
        this.#solveBoard(state.puzzle);
      }
      this.#claim(state, false);
      return;
    }
  }

  dispose(): void {
    const open = this.#open;
    this.#open = null;
    open?.panel.close();
    // An unanswered offer leaves with the scene, as `Not yet`.
    this.#forceSheet?.querySelector<HTMLElement>('[data-testid="confirm-no"]')?.click();
    this.#forceSheet = null;
    this.#surfaceView?.dispose();
    this.#caveView?.dispose();
    this.#surfaceView = null;
    this.#caveView = null;
  }
}
