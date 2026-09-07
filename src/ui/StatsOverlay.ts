// The dev stats overlay (SPEC-002 §4.6). Thirteen rows and two buttons — the
// complete content of the panel, in this order, each row with a fixed
// `data-testid` and a fixed text format so both the e2e suite and a developer
// squinting at a phone read the same thing.
//
// It supersedes SPEC-003's one-line `DebugOverlay`, and keeps that line's exact
// text (`geo <n> tex <n>`) because `e2e/scene-cycle.spec.ts` measures GPU
// memory stability through it (D-41).
//
// Everything here is pull-based: `Game` hands over a snapshot 4 times a second
// and nothing in this file reads the renderer, so a hidden overlay costs the
// frame nothing (AC-37).
import type { StatsSnapshot, StatsUi } from '@/core/Game';
import { el, testId } from '@/ui/dom';

export const LOSE_CONTEXT_TEXT = 'Simulate context loss';
export const LOSE_CONTEXT_FATAL_TEXT = 'Simulate context loss (no restore)';
/** §4.6.2: at most the last twelve entries, oldest first. */
export const EVENT_LOG_LIMIT = 12;

/** The rows of §4.6.1, in order. */
const ROWS = [
  'debug-fps',
  'debug-frame-ms',
  'debug-updates',
  'debug-dropped',
  'debug-draws',
  'debug-tris',
  'debug-memory',
  'debug-preset',
  'debug-dpr',
  'debug-size',
  'debug-scene',
  'debug-state',
  'debug-events',
] as const;

type RowId = (typeof ROWS)[number];

export interface StatsOverlayOptions {
  /** `null` never restores, so the 5 s reload offer is reachable (§4.7). */
  onLoseContext(restoreAfterMs: number | null): void;
  /** The delay the non-fatal simulator restores after (SPEC-002 §4.7). */
  restoreAfterMs: number;
}

/** `props=3 clip=Idle` — `debugInfo()` pairs in insertion order (AC-31). */
function pairs(info: Record<string, number | string> | null): string {
  if (info === null) return '';
  let out = '';
  for (const [key, value] of Object.entries(info)) {
    const text = typeof value === 'number' && !Number.isInteger(value) ? value.toFixed(2) : String(value);
    out += ` ${key}=${text}`;
  }
  return out;
}

export class StatsOverlay implements StatsUi {
  readonly #parent: HTMLElement;
  readonly #options: StatsOverlayOptions;
  readonly #events: string[] = [];
  readonly #text = new Map<RowId, string>();
  #root: HTMLDivElement | null = null;
  #rows: Map<RowId, HTMLDivElement> | null = null;
  #visible = false;

  constructor(root: HTMLElement, options: StatsOverlayOptions) {
    this.#parent = root;
    this.#options = options;
  }

  get visible(): boolean {
    return this.#visible;
  }

  /** Built on first show and taken out of the DOM again when hidden (AC-27). */
  setVisible(value: boolean): void {
    if (value === this.#visible) return;
    this.#visible = value;
    if (!value) {
      this.#root?.remove();
      return;
    }
    this.#parent.append(this.#build());
    this.#text.clear(); // the rows are blank again, so every one of them is dirty
    this.#writeEvents();
  }

  update(snapshot: StatsSnapshot): void {
    if (!this.#visible) return;
    this.#set('debug-fps', `fps ${Math.round(snapshot.fps)}`);
    this.#set('debug-frame-ms', `ms ${snapshot.frameMs.toFixed(1)}`);
    this.#set('debug-updates', `upd ${snapshot.updates}`);
    this.#set('debug-dropped', `dropped ${snapshot.droppedTime.toFixed(2)}s`);
    this.#set('debug-draws', `draws ${snapshot.drawCalls}`);
    this.#set('debug-tris', `tris ${snapshot.triangles}`);
    this.#set('debug-memory', `geo ${snapshot.geometries} tex ${snapshot.textures}`);
    this.#set('debug-preset', `preset ${snapshot.preset}`);
    this.#set('debug-dpr', `dpr ${snapshot.dpr.toFixed(2)} of ${snapshot.deviceDpr.toFixed(2)}`);
    this.#set('debug-size', `size ${snapshot.width}x${snapshot.height}`);
    this.#set(
      'debug-scene',
      snapshot.scene === null ? 'scene -' : `scene ${snapshot.scene}${pairs(snapshot.sceneInfo)}`,
    );
    this.#set('debug-state', `state ${snapshot.state}`);
  }

  /** One line per entry, oldest first, `<seconds since boot, 2 decimals> <name>`. */
  logEvent(name: string, atSeconds: number): void {
    this.#events.push(`${atSeconds.toFixed(2)} ${name}`);
    if (this.#events.length > EVENT_LOG_LIMIT) this.#events.splice(0, this.#events.length - EVENT_LOG_LIMIT);
    this.#writeEvents();
  }

  dispose(): void {
    this.#root?.remove();
    this.#root = null;
    this.#rows = null;
    this.#visible = false;
  }

  #build(): HTMLDivElement {
    const existing = this.#root;
    if (existing !== null) return existing;
    const root = el('div', 'overlay-debug');
    const rows = new Map<RowId, HTMLDivElement>();
    for (const id of ROWS) {
      const row = testId(el('div', 'debug-row'), id);
      rows.set(id, row);
      root.append(row);
    }
    root.append(
      this.#button('debug-lose-context', LOSE_CONTEXT_TEXT, () =>
        this.#options.onLoseContext(this.#options.restoreAfterMs),
      ),
      this.#button('debug-lose-context-fatal', LOSE_CONTEXT_FATAL_TEXT, () => this.#options.onLoseContext(null)),
    );
    this.#root = root;
    this.#rows = rows;
    return root;
  }

  #button(id: string, text: string, onClick: () => void): HTMLButtonElement {
    const button = testId(el('button', 'debug-button', text), id);
    button.type = 'button';
    button.addEventListener('click', onClick);
    return button;
  }

  /** A row's DOM is written only when its text actually changed (§4.6.1). */
  #set(id: RowId, text: string): void {
    if (this.#text.get(id) === text) return;
    this.#text.set(id, text);
    const row = this.#rows?.get(id);
    if (row) row.textContent = text;
  }

  #writeEvents(): void {
    if (!this.#visible) return;
    this.#set('debug-events', this.#events.join('\n'));
  }
}
