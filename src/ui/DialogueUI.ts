// Dialogue presentation (SPEC-014 §4.6). Non-modal by default — lines type out
// over the HUD and never block combat; only `choice` prompts and dialogues the
// data marks `modal` dim the screen and take the input away (AC-77). The prose
// itself is SPEC-009's data; this file owns pacing, queueing and style.
//
// Queue rules (AC-73..76): up to QUEUE_MAX dialogues including the one playing,
// a sixth is dropped silently, the whole queue clears on `scene:transition`,
// and `dialogue:started`/`dialogue:ended` bracket each one that actually runs.
import type { EmitArgs, GameEvents } from '@/core/Events';
import type { Unsubscribe } from '@/core/Events';
import { DIALOGUE, type DialogueDef, type DialogueId, type SpeakerId } from '@/data/index';
import { el, h, testId, uiLayers, type UiRoot } from '@/ui/dom';

// The schema-typed view of the table: on the `as const` literal types an absent
// optional — a dialogue with no `modal` — is not a property at all (the same
// pattern `systems/UiHelpers.ts` uses for `CLASSES` and `ITEMS`).
const DIALOGUE_TABLE: Readonly<Record<DialogueId, DialogueDef>> = DIALOGUE;

/** §4.6: 40 chars/s. */
export const TYPE_CHARS_PER_SEC = 40;
/** §4.6: a fully shown non-modal line advances itself after this long. */
export const AUTO_ADVANCE_MS = 6000;
/** §4.6: the queue cap, playing dialogue included. */
export const QUEUE_MAX = 5;

/** The slice of the bus this layer uses; structural, like every other port. */
export interface DialogueEvents {
  emit<K extends keyof GameEvents>(name: K, ...args: EmitArgs<K>): void;
  on<K extends keyof GameEvents>(name: K, handler: (payload: GameEvents[K]) => void, owner: object): Unsubscribe;
}

/** SPEC-005's `Input.setEnabled` — all a modal dialogue needs from input. */
export interface DialogueInput {
  setEnabled(enabled: boolean): void;
}

/** Exported for the film player's captions (SPEC-022 §4.3). */
export const SPEAKER_NAMES: Record<SpeakerId, string> = {
  aria: 'ARIA',
  command: 'Earth Command',
  scav: 'Scav',
  log: 'LOG',
  player: 'You',
  warden: '???',
};

interface Job {
  id: DialogueId;
  modal: boolean;
  onChoice?: (index: number) => void;
  choices?: readonly string[];
  resolve: () => void;
}

/**
 * Dialogues marked `once` play at most once per bound save *per session*: the
 * save schema is SPEC-007's and carries no seen-set, so the WeakMap forgets on
 * reload. Keyed by the save object, not the slot, so a New Game replays them.
 */
const SEEN = new WeakMap<object, Set<DialogueId>>();

const INSTANCES = new WeakMap<HTMLElement, DialogueUI>();

/**
 * The shared dialogue layer for a `#ui` element — the `uiLayers()` pattern:
 * scenes reach one page-lifetime instance instead of mounting rivals, the
 * queue survives the caller (a creation scene that has already been disposed
 * still gets its intro line out), and `scene:transition` keeps clearing it.
 * The first caller's options win; every later call reuses the instance.
 */
export function dialogueLayer(
  root: HTMLElement,
  events: DialogueEvents,
  options: { input?: DialogueInput; saveKey?: () => object | null } = {},
): DialogueUI {
  let instance = INSTANCES.get(root);
  if (instance === undefined) {
    instance = new DialogueUI(uiLayers(root), events, options);
    INSTANCES.set(root, instance);
  }
  return instance;
}

export class DialogueUI {
  readonly #ui: UiRoot;
  readonly #events: DialogueEvents;
  readonly #input: DialogueInput | null;
  readonly #saveKey: (() => object | null) | null;
  readonly #releases: Unsubscribe[] = [];

  readonly #root: HTMLDivElement;
  readonly #speaker: HTMLSpanElement;
  readonly #text: HTMLParagraphElement;
  readonly #choices: HTMLDivElement;
  readonly #dim: HTMLDivElement;

  #queue: Job[] = [];
  #active: Job | null = null;
  #lineIndex = 0;
  #shown = 0;
  #lineDone = false;
  #typeTimer: ReturnType<typeof setInterval> | null = null;
  #advanceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    ui: UiRoot,
    events: DialogueEvents,
    options: { input?: DialogueInput; saveKey?: () => object | null } = {},
  ) {
    this.#ui = ui;
    this.#events = events;
    this.#input = options.input ?? null;
    this.#saveKey = options.saveKey ?? null;

    this.#dim = el('div', 'dialogue-dim');
    this.#speaker = el('span', 'dialogue-speaker');
    this.#text = el('p', 'dialogue-text');
    this.#choices = el('div', 'dialogue-choices');
    this.#root = testId(el('div', 'dialogue panel'), 'dialogue');
    this.#root.setAttribute('role', 'log');
    this.#root.append(this.#speaker, this.#text, this.#choices);
    // A tap fills the line; a second tap advances (AC-72).
    this.#root.addEventListener('click', () => this.skip());
    this.#root.classList.add('is-hidden');
    ui.mount(this.#dim, 'panel');
    ui.mount(this.#root, 'panel');

    // 14-d: whatever was queued dies with the scene that queued it.
    this.#releases.push(events.on('scene:transition', () => this.#clear(), this));
    document.addEventListener('keydown', this.#onKey);
  }

  get busy(): boolean {
    return this.#active !== null || this.#queue.length > 0;
  }

  /**
   * Queue `id`. Resolves when this dialogue ends — immediately when the queue
   * is full (dropped silently, §2) or when a `once` dialogue has already
   * played for this save.
   */
  play(id: DialogueId, opts: { modal?: boolean; onChoice?: (index: number) => void } = {}): Promise<void> {
    const def = DIALOGUE_TABLE[id];
    let seen: Set<DialogueId> | null = null;
    if (def.once === true) {
      const key = this.#saveKey?.() ?? null;
      if (key !== null) {
        let set = SEEN.get(key);
        if (set === undefined) {
          set = new Set();
          SEEN.set(key, set);
        }
        if (set.has(id)) return Promise.resolve();
        seen = set;
      }
    }
    return new Promise((resolve) => {
      if (this.#queue.length + (this.#active === null ? 0 : 1) >= QUEUE_MAX) {
        resolve(); // AC-74: the sixth is dropped, silently
        return;
      }
      // Only a queued `once` counts as played: one dropped for a full queue
      // must stay eligible for its next trigger.
      seen?.add(id);
      this.#queue.push({ id, modal: opts.modal ?? def.modal === true, onChoice: opts.onChoice, resolve });
      if (this.#active === null) this.#next();
    });
  }

  /**
   * The ending decision and mission `choice` objectives (AC-77): a modal
   * prompt over a dimmed screen, options on buttons and on keys 1–9. Resolves
   * with the chosen index. Not queued behind the cap — a choice is never
   * droppable.
   */
  playChoice(prompt: string, options: readonly string[]): Promise<number> {
    return new Promise((resolve) => {
      this.#clear();
      this.#setStyle('aria');
      this.#speaker.textContent = '';
      this.#text.textContent = prompt;
      this.#root.classList.remove('is-hidden');
      this.#dim.classList.add('is-visible');
      this.#input?.setEnabled(false);
      this.#active = {
        id: 'intro_command', // placeholder id; a choice job never reads it
        modal: true,
        choices: options,
        onChoice: (index) => resolve(index),
        resolve: () => {},
      };
      this.#choices.replaceChildren(
        ...options.map((option, index) =>
          testId(
            h('button', { class: 'ui-btn dialogue-choice', type: 'button', click: () => this.#choose(index) }, `${index + 1}. ${option}`),
            `dialogue-choice-${index}`,
          ),
        ),
      );
    });
  }

  /** First call fills the current line; the next advances (AC-72). */
  skip(): void {
    if (this.#active === null || this.#active.choices !== undefined) return;
    if (!this.#lineDone) {
      this.#finishLine();
      return;
    }
    this.#advanceLine();
  }

  dispose(): void {
    this.#clear();
    for (const release of this.#releases.splice(0)) release();
    document.removeEventListener('keydown', this.#onKey);
    this.#ui.unmount(this.#root);
    this.#ui.unmount(this.#dim);
  }

  // ---------------------------------------------------------------- playback

  #next(): void {
    const job = this.#queue.shift() ?? null;
    this.#active = job;
    if (job === null) {
      this.#root.classList.add('is-hidden');
      this.#dim.classList.remove('is-visible');
      return;
    }
    this.#events.emit('dialogue:started', { id: job.id });
    this.#root.classList.remove('is-hidden');
    this.#dim.classList.toggle('is-visible', job.modal);
    if (job.modal) this.#input?.setEnabled(false);
    this.#lineIndex = -1;
    this.#advanceLine();
  }

  #advanceLine(): void {
    const job = this.#active;
    if (job === null) return;
    this.#stopTimers();
    this.#lineIndex++;
    const line = DIALOGUE_TABLE[job.id].lines[this.#lineIndex];
    if (line === undefined) {
      this.#end(job);
      return;
    }
    this.#setStyle(line.speaker);
    this.#speaker.textContent = SPEAKER_NAMES[line.speaker];
    this.#shown = 0;
    this.#lineDone = false;
    this.#text.textContent = '';
    // 40 chars/s (AC-72); one interval per line, cleared on skip and dispose.
    this.#typeTimer = setInterval(() => {
      this.#shown++;
      this.#text.textContent = line.text.slice(0, this.#shown);
      if (this.#shown >= line.text.length) this.#finishLine();
    }, 1000 / TYPE_CHARS_PER_SEC);
    // AC-73: a non-modal line moves on by itself; a modal one waits for the tap.
    if (!job.modal) {
      this.#advanceTimer = setTimeout(() => this.#advanceLine(), AUTO_ADVANCE_MS);
    }
  }

  #finishLine(): void {
    const job = this.#active;
    if (job === null) return;
    if (this.#typeTimer !== null) clearInterval(this.#typeTimer);
    this.#typeTimer = null;
    const line = DIALOGUE_TABLE[job.id].lines[this.#lineIndex];
    if (line !== undefined) this.#text.textContent = line.text;
    this.#lineDone = true;
  }

  #end(job: Job): void {
    this.#stopTimers();
    if (job.modal) this.#input?.setEnabled(true);
    this.#events.emit('dialogue:ended', { id: job.id });
    job.resolve();
    this.#active = null;
    this.#next();
  }

  #choose(index: number): void {
    const job = this.#active;
    if (job === null || job.choices === undefined) return;
    this.#choices.replaceChildren();
    this.#dim.classList.remove('is-visible');
    this.#root.classList.add('is-hidden');
    this.#input?.setEnabled(true);
    this.#active = null;
    job.onChoice?.(index);
    this.#next();
  }

  readonly #onKey = (event: KeyboardEvent): void => {
    const job = this.#active;
    if (job?.choices === undefined) return;
    const index = Number(event.key) - 1;
    if (Number.isInteger(index) && index >= 0 && index < job.choices.length) this.#choose(index);
  };

  #setStyle(speaker: SpeakerId): void {
    this.#root.classList.toggle('dialogue-log', speaker === 'log');
    this.#root.classList.toggle('dialogue-warden', speaker === 'warden');
    this.#root.dataset['speaker'] = speaker;
  }

  #stopTimers(): void {
    if (this.#typeTimer !== null) clearInterval(this.#typeTimer);
    if (this.#advanceTimer !== null) clearTimeout(this.#advanceTimer);
    this.#typeTimer = null;
    this.#advanceTimer = null;
  }

  /** 14-d: drop everything, resolve every waiter, restore the input. */
  #clear(): void {
    const active = this.#active;
    this.#stopTimers();
    if (active !== null) {
      if (active.modal) this.#input?.setEnabled(true);
      if (active.choices === undefined) this.#events.emit('dialogue:ended', { id: active.id });
      active.resolve();
    }
    for (const job of this.#queue.splice(0)) job.resolve();
    this.#active = null;
    this.#choices.replaceChildren();
    this.#root.classList.add('is-hidden');
    this.#dim.classList.remove('is-visible');
  }
}
