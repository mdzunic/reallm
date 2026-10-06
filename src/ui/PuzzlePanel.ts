// The puzzle panel (SPEC-055 §4.4, §4.5, §4.7): the terminal overlay for a
// conduit, a calibration board and a sequence — Eden's human lock among them.
// It only draws what the scene's `view()` says and reports what the player did;
// the board, the hints, the bypass and the clock are the scene's.
//
// One root in the `panel` layer, opened as SPEC-044's modal: focus on the
// first cell or choice, Tab kept inside, and a SPEC-036 back-stack entry, so
// Escape and the system Back close it like `puzzle-close` does. The board's
// buttons are built once and written in place on every `refresh()`, so a turn
// by keyboard keeps its focus, and the roving `tabindex` keeps one stop in the
// grid. The arrow keys move it, Enter and Space act on it, and H asks for a
// hint — read here, on the panel, so none of them reaches the game's bindings.
import type { PuzzleMove } from '@/systems/Puzzles';
import { el, h, openModal, testId, type UiRoot } from '@/ui/dom';

/** §3: what the panel draws, rebuilt by the scene on every refresh. */
export interface PuzzlePanelView {
  title: string;
  status: string;
  /** A board's cells, row by row; `glyph` is `pipe:<piece>:<rot>` for a conduit, else the character to show. */
  cells?: readonly { label: string; glyph: string; powered: boolean; hinted: boolean }[];
  /** The board's side, with `cells`. */
  n?: number;
  /** A sequence's terms, `?` last. */
  tokens?: readonly string[];
  choices?: readonly { text: string; hinted: boolean; disabled: boolean }[];
  /** False for the human lock. */
  hint: boolean;
  bypass: 'hidden' | 'disabled' | 'enabled';
  bypassNote: string | null;
  /** The human lock's line. */
  verdict?: string;
}

export interface PuzzlePanelHandlers {
  move(m: PuzzleMove): void;
  hint(): void;
  bypass(): void;
  close(): void;
}

/** §4.5: the bypass button's words. */
export const BYPASS_TEXT = 'ARIA: force the lock';
const SVG_NS = 'http://www.w3.org/2000/svg';
/** Each piece's open sides at rotation 0, as `systems/Puzzles` draws them: N 1, E 2, S 4, W 8. */
const PIECE_MASKS: readonly number[] = [0, 1, 5, 3, 7, 15];
/** Where a side's arm meets the cell's edge, in the 100-unit box. */
const ARM_ENDS: readonly [number, number, number][] = [
  [1, 50, 0],
  [2, 100, 50],
  [4, 50, 100],
  [8, 0, 50],
];

interface CellSlot {
  button: HTMLButtonElement;
  /** The conduit's pipe, kept so a turn animates rather than redraws. */
  svg: SVGSVGElement | null;
  /** What the pipe was drawn for: `piece:powered`, so a turn alone only rotates it. */
  drawn: string;
  /** Quarter turns shown so far, never wrapped — a turn from 3 to 0 still goes clockwise. */
  turns: number;
  rot: number;
}

/**
 * Mounts the panel and returns `refresh` — redraw from `view()` — and an
 * idempotent `close`, which takes the panel, its modal and its back-stack
 * entry down without calling `handlers.close` (the scene's own close does).
 */
export function openPuzzlePanel(
  ui: UiRoot,
  view: () => PuzzlePanelView,
  handlers: PuzzlePanelHandlers,
): { refresh(): void; close(): void } {
  const root = testId(el('div', 'puzzle-panel panel'), 'puzzle-panel');
  const title = testId(el('p', 'puzzle-title'), 'puzzle-title');
  const board = testId(el('div', 'puzzle-board'), 'puzzle-board');
  const status = testId(el('p', 'puzzle-status'), 'puzzle-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const hint = testId(h('button', { class: 'ui-btn puzzle-hint', type: 'button', click: () => handlers.hint() }, 'Hint'), 'puzzle-hint');
  const bypass = testId(
    h('button', { class: 'ui-btn puzzle-bypass', type: 'button', click: () => handlers.bypass() }, BYPASS_TEXT),
    'puzzle-bypass',
  ) as HTMLButtonElement;
  const note = testId(el('p', 'puzzle-bypass-note'), 'puzzle-bypass-note');
  const close = testId(h('button', { class: 'ui-btn puzzle-close', type: 'button', click: () => handlers.close() }, 'Close'), 'puzzle-close');
  const side = el('div', 'puzzle-side');
  side.append(status, hint, bypass, note, close);
  const body = el('div', 'puzzle-body');
  body.append(board, side);
  root.append(title, body);

  // The board's pieces, built for the first view's shape and kept.
  const cells: CellSlot[] = [];
  const tokens: HTMLElement[] = [];
  const choices: HTMLButtonElement[] = [];
  const tokenRow = el('div', 'puzzle-tokens');
  const choiceRow = el('div', 'puzzle-choices');
  /** The roving stop: the index among the cells, or among the choices. */
  let focusAt = 0;
  let open = true;

  const items = (): HTMLButtonElement[] => (cells.length > 0 ? cells.map((slot) => slot.button) : choices);

  const rove = (index: number, take: boolean): void => {
    const list = items();
    if (list.length === 0) return;
    focusAt = Math.max(0, Math.min(list.length - 1, index));
    list.forEach((button, i) => button.setAttribute('tabindex', i === focusAt ? '0' : '-1'));
    if (take) list[focusAt]?.focus({ preventScroll: true });
  };

  const act = (index: number): void => {
    if (!open) return;
    if (cells.length > 0) {
      handlers.move({ cell: index });
    } else {
      const choice = choices[index];
      if (choice === undefined || choice.getAttribute('aria-disabled') === 'true') return;
      handlers.move({ choice: index });
    }
  };

  const buildCells = (n: number, count: number): void => {
    board.classList.add('is-grid');
    board.style.setProperty('--n', String(n));
    root.style.setProperty('--n', String(n));
    for (let i = 0; i < count; i++) {
      const button = testId(h('button', { class: 'puzzle-cell', type: 'button' }), `puzzle-cell-${Math.floor(i / n)}-${i % n}`) as HTMLButtonElement;
      button.addEventListener('click', () => {
        rove(i, false);
        act(i);
      });
      board.append(button);
      cells.push({ button, svg: null, drawn: '', turns: 0, rot: 0 });
    }
  };

  const buildSequence = (tokenCount: number, choiceCount: number): void => {
    board.classList.add('is-sequence');
    for (let i = 0; i < tokenCount; i++) {
      const token = el('span', 'puzzle-token');
      tokens.push(token);
      tokenRow.append(token);
    }
    for (let i = 0; i < choiceCount; i++) {
      const button = testId(h('button', { class: 'ui-btn puzzle-choice', type: 'button' }), `puzzle-choice-${i}`) as HTMLButtonElement;
      button.addEventListener('click', () => {
        rove(i, false);
        act(i);
      });
      choices.push(button);
      choiceRow.append(button);
    }
    board.append(tokenRow, choiceRow);
  };

  const drawPipe = (slot: CellSlot, piece: number, rot: number, powered: boolean): void => {
    const key = `${piece}:${powered ? 1 : 0}`;
    if (slot.svg === null || slot.drawn !== key) {
      const svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('viewBox', '0 0 100 100');
      svg.setAttribute('aria-hidden', 'true');
      svg.classList.add('puzzle-pipe');
      if (powered) svg.classList.add('is-powered');
      const mask = PIECE_MASKS[piece] ?? 0;
      for (const [bit, x, y] of ARM_ENDS) {
        if ((mask & bit) === 0) continue;
        const arm = document.createElementNS(SVG_NS, 'line');
        arm.setAttribute('x1', '50');
        arm.setAttribute('y1', '50');
        arm.setAttribute('x2', String(x));
        arm.setAttribute('y2', String(y));
        svg.append(arm);
      }
      // §4.4: a powered pipe also differs in shape — a dot at its centre.
      if (powered || piece === 1) {
        const dot = document.createElementNS(SVG_NS, 'circle');
        dot.setAttribute('cx', '50');
        dot.setAttribute('cy', '50');
        dot.setAttribute('r', powered ? '11' : '7');
        svg.append(dot);
      }
      slot.button.replaceChildren(svg);
      slot.svg = svg;
      slot.drawn = key;
      slot.turns = rot;
      slot.rot = rot;
      // A redrawn pipe starts where it is: no spin from nothing.
      svg.style.transition = 'none';
      svg.style.transform = `rotate(${slot.turns * 90}deg)`;
      void svg.getBoundingClientRect();
      svg.style.transition = '';
      return;
    }
    if (rot !== slot.rot) {
      slot.turns += (rot - slot.rot + 4) % 4;
      slot.rot = rot;
      slot.svg.style.transform = `rotate(${slot.turns * 90}deg)`;
    }
  };

  const refresh = (): void => {
    if (!open) return;
    const v = view();
    title.textContent = v.title;
    status.textContent = v.verdict ?? v.status;
    status.classList.toggle('is-verdict', v.verdict !== undefined);

    // The board: built for the first view's shape, written in place after.
    if (v.cells !== undefined && v.n !== undefined) {
      if (cells.length !== v.cells.length) {
        board.replaceChildren();
        cells.length = 0;
        buildCells(v.n, v.cells.length);
        rove(focusAt, false);
      }
      v.cells.forEach((cell, i) => {
        const slot = cells[i] as CellSlot;
        slot.button.setAttribute('aria-label', cell.label);
        slot.button.classList.toggle('is-hinted', cell.hinted);
        slot.button.classList.toggle('is-powered', cell.powered);
        const pipe = /^pipe:(\d):(\d)$/.exec(cell.glyph);
        if (pipe !== null) {
          slot.button.classList.add('is-pipe');
          drawPipe(slot, Number(pipe[1]), Number(pipe[2]), cell.powered);
        } else {
          slot.svg = null;
          slot.drawn = '';
          slot.button.classList.toggle('is-lit', cell.glyph === '◆');
          if (slot.button.textContent !== cell.glyph) slot.button.textContent = cell.glyph;
        }
      });
    } else if (v.tokens !== undefined && v.choices !== undefined) {
      if (tokens.length !== v.tokens.length || choices.length !== v.choices.length) {
        board.replaceChildren();
        tokenRow.replaceChildren();
        choiceRow.replaceChildren();
        tokens.length = 0;
        choices.length = 0;
        buildSequence(v.tokens.length, v.choices.length);
        rove(focusAt, false);
      }
      v.tokens.forEach((text, i) => {
        const token = tokens[i] as HTMLElement;
        token.textContent = text;
        token.classList.toggle('is-blank', text === '?');
      });
      tokenRow.setAttribute('aria-label', v.tokens.join(' · '));
      v.choices.forEach((choice, i) => {
        const button = choices[i] as HTMLButtonElement;
        button.textContent = choice.text;
        button.classList.toggle('is-hinted', choice.hinted);
        button.setAttribute('aria-disabled', String(choice.disabled));
      });
    }

    // §4.7: the human lock has no hint and no bypass at all.
    if (v.hint && hint.parentElement === null) side.insertBefore(hint, bypass.parentElement === side ? bypass : note);
    if (!v.hint) hint.remove();
    if (v.bypass === 'hidden') {
      bypass.remove();
      note.remove();
    } else {
      if (bypass.parentElement === null) side.insertBefore(bypass, close);
      if (note.parentElement === null) side.insertBefore(note, close);
      bypass.disabled = v.bypass === 'disabled';
      note.textContent = v.bypassNote ?? '';
      note.hidden = v.bypassNote === null;
    }
  };

  // §4.4 "Keys": the roving stop, acting on it, and the hint. Escape is the
  // back-stack's (main.ts), so it is left to bubble.
  const onKey = (event: KeyboardEvent): void => {
    if (!open || event.repeat || event.altKey || event.ctrlKey || event.metaKey) return;
    const list = items();
    const inBoard = list.includes(event.target as HTMLButtonElement);
    const n = cells.length > 0 ? Math.max(1, Number(board.style.getPropertyValue('--n')) || 1) : 1;
    let to = -1;
    switch (event.code) {
      case 'ArrowLeft':
        to = cells.length > 0 ? (focusAt % n === 0 ? focusAt : focusAt - 1) : focusAt - 1;
        break;
      case 'ArrowRight':
        to = cells.length > 0 ? (focusAt % n === n - 1 ? focusAt : focusAt + 1) : focusAt + 1;
        break;
      case 'ArrowUp':
        to = cells.length > 0 ? focusAt - n : focusAt - 1;
        break;
      case 'ArrowDown':
        to = cells.length > 0 ? focusAt + n : focusAt + 1;
        break;
      case 'Enter':
      case 'Space': {
        const target = event.target as HTMLElement;
        if (!(target instanceof HTMLButtonElement) || !root.contains(target)) return;
        event.preventDefault();
        event.stopPropagation();
        if (inBoard) act(list.indexOf(target));
        else if (!target.disabled) target.click();
        return;
      }
      case 'KeyH':
        event.preventDefault();
        event.stopPropagation();
        if (hint.parentElement !== null) handlers.hint();
        return;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (to >= 0 && to < list.length) rove(to, true);
    else if (!inBoard) rove(focusAt, true);
  };
  root.addEventListener('keydown', onKey);

  refresh();
  ui.mount(root, 'panel');
  const first = items()[0] ?? null;
  rove(0, false);
  const closeModal = openModal(root, { label: view().title, initialFocus: first, onBack: () => handlers.close() });

  return {
    refresh,
    close(): void {
      if (!open) return;
      open = false;
      root.removeEventListener('keydown', onKey);
      closeModal();
      ui.unmount(root);
    },
  };
}
