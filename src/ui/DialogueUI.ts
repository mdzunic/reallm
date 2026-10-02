// Dialogue presentation (SPEC-014 §4.6). Non-modal by default — lines type out
// over the HUD and never block combat; only `choice` prompts and dialogues the
// data marks `modal` dim the screen and take the input away (AC-77). The prose
// itself is SPEC-009's data; this file owns pacing, queueing and style.
//
// Queue rules (AC-73..76): up to QUEUE_MAX dialogues including the one playing,
// a sixth is dropped silently, the whole queue clears on `scene:transition`,
// and `dialogue:started`/`dialogue:ended` bracket each one that actually runs.
//
// SPEC-037 §4.3: a non-modal line is pass-through — over the salvager and
// across both thumbs it was a tap target that skipped story lines — with one
// 44 × 44 `›` (`dialogue-advance`) at its right edge that fills the line and
// then advances it. A modal line keeps its dim and the whole-box tap.
//
// SPEC-044 §4.1: the keys. Enter advances any line the same way a tap does;
// Space, E and F advance only a modal one, whose input is disabled, so they
// are free — during a non-modal line the player is playing, and they keep
// their gameplay meaning. A modal line takes focus as a dialog and gives it
// back when it ends, and a complete one says what it waits for (`dialogue-next`).
import type { EmitArgs, GameEvents } from '@/core/Events';
import type { Unsubscribe } from '@/core/Events';
import type { Scheme } from '@/core/Input';
import type { DialogueSpeed } from '@/core/Settings';
import { DIALOGUE, type DialogueDef, type DialogueId, type SpeakerId } from '@/data/index';
import { el, h, openModal, testId, topModal, uiLayers, type UiRoot } from '@/ui/dom';

// The schema-typed view of the table: on the `as const` literal types an absent
// optional — a dialogue with no `modal` — is not a property at all (the same
// pattern `systems/UiHelpers.ts` uses for `CLASSES` and `ITEMS`).
const DIALOGUE_TABLE: Readonly<Record<DialogueId, DialogueDef>> = DIALOGUE;

/** §4.6: 40 chars/s. */
export const TYPE_CHARS_PER_SEC = 40;

/**
 * SPEC-015 AC-44: how the next line is revealed. With `instant` — SPEC-045
 * §4.3's Typewriter text off, which reduce motion seeds — the whole line lands
 * on the first frame and no interval is started at all: `intervalMs: null` is
 * the absence of a typewriter, not a fast one.
 */
export function lineReveal(text: string, instant: boolean): { chars: number; intervalMs: number | null } {
  if (instant) return { chars: text.length, intervalMs: null };
  return { chars: 0, intervalMs: 1000 / TYPE_CHARS_PER_SEC };
}

/** SPEC-045 §4.1: no whole non-modal line holds for less than this, in ms (*initial tuning*). */
export const HOLD_MIN_MS = 3000;
/** SPEC-045 §4.1: the time to look up at a line, in ms (*initial tuning*). */
export const HOLD_BASE_MS = 1200;
/** SPEC-045 §4.1: reading time per character, in ms — about 20 a second (*initial tuning*). */
export const HOLD_PER_CHAR_MS = 50;
/** SPEC-045 §4.1: each timed speed's multiplier on the hold. */
export const DIALOGUE_SPEED_FACTOR: Readonly<Record<Exclude<DialogueSpeed, 'manual'>, number>> = {
  slow: 1.5,
  normal: 1,
  fast: 0.75,
};

/**
 * SPEC-045 §4.1: how long a whole non-modal line holds before it moves on —
 * counted from the moment it is whole, sized by its length. `null` under
 * Manual: no timer, the line waits for Enter or `›`. At Normal a 121-character
 * line holds 7.25 s.
 */
export function holdMs(text: string, speed: DialogueSpeed): number | null {
  if (speed === 'manual') return null;
  return Math.round(Math.max(HOLD_MIN_MS, HOLD_BASE_MS + HOLD_PER_CHAR_MS * text.length) * DIALOGUE_SPEED_FACTOR[speed]);
}
/** §4.6: the queue cap, playing dialogue included. */
export const QUEUE_MAX = 5;

/**
 * SPEC-044 §4.1: a key counts only this long after its line opened — the guard
 * a film's Skip uses (E33), so a key held into a line cannot throw it away.
 */
export const LINE_KEY_GRACE = 0.3; // seconds
/** SPEC-044 §4.1: what advances a modal line — its input is disabled, so these are free. */
export const MODAL_ADVANCE_KEYS: readonly string[] = ['Enter', 'NumpadEnter', 'Space', 'KeyE', 'KeyF'];
/** SPEC-044 §4.1: what advances a non-modal line; Space and E stay the player's. */
export const ADVANCE_KEYS: readonly string[] = ['Enter', 'NumpadEnter'];

/**
 * SPEC-044 §4.1, pure: whether a keydown advances the line — a fresh press
 * (44-a: not an auto-repeat), at least `LINE_KEY_GRACE` after the line opened,
 * of a key the line's kind accepts.
 */
export function advanceAccepted(code: string, repeat: boolean, modal: boolean, sinceOpenSeconds: number): boolean {
  if (repeat || sinceOpenSeconds < LINE_KEY_GRACE) return false;
  return (modal ? MODAL_ADVANCE_KEYS : ADVANCE_KEYS).includes(code);
}

/** SPEC-044 §4.1: what the continue cue says on each scheme; the gamepad reads the keyboard's. */
function cueText(scheme: Scheme): string {
  return scheme === 'touch' ? '▸ Tap' : '▸ Enter';
}

/**
 * A key aimed at a control outside the dialogue — a focused button on a panel,
 * a field — is that control's: Enter on the pad terminal's Accept accepts, it
 * does not read a line (SPEC-044 §4.3). The HUD's own buttons are the play
 * surface, not a form; a line still reads over them.
 */
function ownedElsewhere(target: EventTarget | null, panel: HTMLElement): boolean {
  if (!(target instanceof Element) || panel.contains(target)) return false;
  if (target.closest('input, select, textarea, [contenteditable="true"]') !== null) return true;
  if (target.closest('button, a[href], summary, [role="tab"]') === null) return false;
  return target.closest('.ui-layer-hud') === null;
}

/** The slice of the bus this layer uses; structural, like every other port. */
export interface DialogueEvents {
  emit<K extends keyof GameEvents>(name: K, ...args: EmitArgs<K>): void;
  on<K extends keyof GameEvents>(name: K, handler: (payload: GameEvents[K]) => void, owner: object): Unsubscribe;
}

/**
 * SPEC-005's `Input.setEnabled` — what a modal dialogue needs from input — and,
 * since SPEC-044 §4.1, the scheme the continue cue speaks to.
 */
export interface DialogueInput {
  setEnabled(enabled: boolean): void;
  readonly state: { readonly scheme: Scheme };
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

/**
 * `saveKey`, `typewriter` and `speed` are read through, not captured: `dialogueLayer`
 * hands back one page-lifetime instance and the first caller's options win, so
 * a setting the player changes mid-session has to reach an instance that was
 * built by an earlier scene.
 */
export interface DialogueOptions {
  input?: DialogueInput;
  saveKey?: () => object | null;
  /**
   * SPEC-045 §4.3: `settings.typewriter`, live — replaces SPEC-015's
   * `reduceMotion`. Off, a line lands whole on its first frame.
   */
  typewriter?: () => boolean;
  /** SPEC-045 §4.1: `settings.dialogueSpeed`, live — how long a whole non-modal line holds. */
  speed?: () => DialogueSpeed;
}

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
  options: DialogueOptions = {},
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
  readonly #typewriter: (() => boolean) | null;
  readonly #speed: (() => DialogueSpeed) | null;
  readonly #releases: Unsubscribe[] = [];

  readonly #root: HTMLDivElement;
  readonly #speaker: HTMLSpanElement;
  readonly #text: HTMLParagraphElement;
  readonly #choices: HTMLDivElement;
  readonly #dim: HTMLDivElement;
  /** SPEC-037 §4.3: the one control a non-modal line takes a pointer on. */
  readonly #advance: HTMLButtonElement;
  /** SPEC-044 §4.1: the continue cue of a complete modal line. */
  readonly #cue: HTMLSpanElement;

  #queue: Job[] = [];
  #active: Job | null = null;
  /** SPEC-042 §4.1: a mission banner is up — no queued job starts until it goes. */
  #held = false;
  #lineIndex = 0;
  #shown = 0;
  #lineDone = false;
  #typeTimer: ReturnType<typeof setInterval> | null = null;
  #advanceTimer: ReturnType<typeof setTimeout> | null = null;
  /** SPEC-044 §4.1: when the current line was shown, `performance.now()` ms. */
  #lineShownAt = 0;
  /** SPEC-044 §4.3: the open modal's close — it gives focus back — or `null`. */
  #closeModal: (() => void) | null = null;

  constructor(ui: UiRoot, events: DialogueEvents, options: DialogueOptions = {}) {
    this.#ui = ui;
    this.#events = events;
    this.#input = options.input ?? null;
    this.#saveKey = options.saveKey ?? null;
    this.#typewriter = options.typewriter ?? null;
    this.#speed = options.speed ?? null;

    this.#dim = el('div', 'dialogue-dim');
    this.#speaker = el('span', 'dialogue-speaker');
    this.#text = el('p', 'dialogue-text');
    this.#choices = el('div', 'dialogue-choices');
    this.#root = testId(el('div', 'dialogue panel'), 'dialogue');
    this.#root.setAttribute('role', 'log');
    this.#advance = testId(el('button', 'dialogue-advance', '›'), 'dialogue-advance');
    this.#advance.type = 'button';
    this.#advance.setAttribute('aria-label', 'Next line');
    // SPEC-037 §4.3: the first press fills the line, the second advances it —
    // the same `skip()` the modal box's tap runs, and only once per press.
    this.#advance.addEventListener('click', (event) => {
      event.stopPropagation();
      this.skip();
    });
    // SPEC-044 §4.1: a label, not an animation — shown on a complete modal line.
    this.#cue = testId(el('span', 'dialogue-next'), 'dialogue-next');
    this.#cue.setAttribute('aria-hidden', 'true');
    this.#cue.hidden = true;
    this.#root.append(this.#speaker, this.#text, this.#choices, this.#advance, this.#cue);
    // A tap fills the line; a second tap advances (AC-72). SPEC-037 §4.3: only
    // a modal line takes a pointer on the whole box — a non-modal one is
    // `pointer-events: none` and answers `dialogue-advance` alone.
    this.#root.addEventListener('click', () => this.skip());
    this.#root.classList.add('is-hidden');
    ui.mount(this.#dim, 'panel');
    ui.mount(this.#root, 'panel');

    // 14-d: whatever was queued dies with the scene that queued it — and so
    // does a banner's hold (SPEC-042 §4.1), which the scene's banner releases
    // on dispose anyway; this layer outlives every scene.
    this.#releases.push(
      events.on(
        'scene:transition',
        () => {
          this.#held = false;
          this.#clear();
        },
        this,
      ),
      // 44-m: the cue follows the scheme of the last press, even while it shows.
      events.on(
        'input:schemeChanged',
        ({ scheme }) => {
          if (!this.#cue.hidden) this.#cue.textContent = cueText(scheme);
        },
        this,
      ),
    );
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
      this.#root.classList.add('is-modal');
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
      // SPEC-044 §4.1: a choice takes focus on its first option.
      this.#openModal(this.#choices.querySelector<HTMLElement>('[data-testid="dialogue-choice-0"]'));
    });
  }

  /**
   * SPEC-042 §4.1: while held, `#next()` starts no queued job — the one on
   * screen plays on to its end, and what was queued behind it waits. Releasing
   * the hold starts the next job at once, unless one is still on screen.
   */
  setHeld(held: boolean): void {
    if (held === this.#held) return;
    this.#held = held;
    if (!held && this.#active === null) this.#next();
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

  /** SPEC-044 §4.3: the panel takes focus as a modal dialog; `#closeModal` gives it back. */
  #openModal(initialFocus: HTMLElement | null): void {
    this.#closeModal?.();
    this.#closeModal = openModal(this.#root, { label: 'Transmission', initialFocus });
  }

  #releaseModal(): void {
    const close = this.#closeModal;
    this.#closeModal = null;
    close?.();
  }

  // ---------------------------------------------------------------- playback

  #next(): void {
    // SPEC-042 §4.1: a banner holds the queue; `setHeld(false)` comes back here.
    const job = this.#held ? null : (this.#queue.shift() ?? null);
    this.#active = job;
    if (job === null) {
      this.#root.classList.add('is-hidden');
      this.#dim.classList.remove('is-visible');
      return;
    }
    this.#events.emit('dialogue:started', { id: job.id });
    this.#root.classList.remove('is-hidden');
    // SPEC-037 §4.3: the root says which kind of line this is; CSS gives a
    // non-modal one no pointer events and a modal one no advance control.
    this.#root.classList.toggle('is-modal', job.modal);
    this.#dim.classList.toggle('is-visible', job.modal);
    if (job.modal) this.#input?.setEnabled(false);
    // SPEC-044 §4.1: a modal job takes focus on the panel itself; a non-modal
    // one keeps `role="log"` and leaves focus where the player has it.
    if (job.modal) this.#openModal(this.#root);
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
    const reveal = lineReveal(line.text, this.#typewriter?.() === false);
    this.#shown = reveal.chars;
    this.#lineDone = false;
    this.#lineShownAt = performance.now();
    this.#cue.hidden = true;
    this.#text.textContent = line.text.slice(0, reveal.chars);
    if (reveal.intervalMs === null) {
      // SPEC-015 AC-44: no typewriter — the line is already whole, so there is
      // nothing to animate and no interval to clear.
      this.#finishLine();
    } else {
      // 40 chars/s (AC-72); one interval per line, cleared on skip and dispose.
      this.#typeTimer = setInterval(() => {
        this.#shown++;
        this.#text.textContent = line.text.slice(0, this.#shown);
        if (this.#shown >= line.text.length) this.#finishLine();
      }, reveal.intervalMs);
    }
    // SPEC-045 §4.1: no advance timer here — `#finishLine` arms the hold once
    // the line is whole, whichever way it got there.
  }

  #finishLine(): void {
    const job = this.#active;
    if (job === null) return;
    if (this.#typeTimer !== null) clearInterval(this.#typeTimer);
    this.#typeTimer = null;
    const line = DIALOGUE_TABLE[job.id].lines[this.#lineIndex];
    if (line !== undefined) this.#text.textContent = line.text;
    this.#lineDone = true;
    // SPEC-045 §4.1: the hold starts now that the line is whole — typed out,
    // filled by a press, or shown at once — and lasts by its length (AC-73:
    // a non-modal line moves on by itself; a modal one waits for the press).
    // Under Manual there is no timer: Enter or `›` moves it on.
    const hold = job.modal || line === undefined ? null : holdMs(line.text, this.#speed?.() ?? 'normal');
    if (this.#advanceTimer !== null) clearTimeout(this.#advanceTimer);
    this.#advanceTimer = hold === null ? null : setTimeout(() => this.#advanceLine(), hold);
    // SPEC-044 §4.1: a complete modal line says what it waits for, in the
    // words of the scheme the player is on now — and so, under Manual, does a
    // whole non-modal one (SPEC-045 §4.1), which waits just the same.
    if (job.modal || (line !== undefined && hold === null)) {
      this.#cue.textContent = cueText(this.#input?.state.scheme ?? 'keyboard');
      this.#cue.hidden = false;
    }
  }

  #end(job: Job): void {
    this.#stopTimers();
    this.#cue.hidden = true;
    // SPEC-044 §4.1: focus goes back where it was before the next job starts.
    this.#releaseModal();
    if (job.modal) this.#input?.setEnabled(true);
    this.#events.emit('dialogue:ended', { id: job.id });
    job.resolve();
    this.#active = null;
    // SPEC-034 §4.7: a dialogue's `next` goes ahead of anything queued (34-e).
    // It is a job of its own, with its own `modal`, `once` and `glitch`, so the
    // Warden's line and ARIA's answer stay two dialogues and the chain works
    // wherever it is played from.
    const next = DIALOGUE_TABLE[job.id].next as DialogueId | undefined;
    if (next !== undefined) this.#playNext(next);
    this.#next();
  }

  /** Queues `id` at the front, honouring `once` and the queue cap (§4.7). */
  #playNext(id: DialogueId): void {
    const def = DIALOGUE_TABLE[id];
    if (def.once === true) {
      const key = this.#saveKey?.() ?? null;
      if (key !== null) {
        let set = SEEN.get(key);
        if (set === undefined) {
          set = new Set();
          SEEN.set(key, set);
        }
        if (set.has(id)) return;
        set.add(id);
      }
    }
    if (this.#queue.length >= QUEUE_MAX) return; // AC-74: the overflow drops
    this.#queue.unshift({ id, modal: def.modal === true, resolve: () => {} });
  }

  #choose(index: number): void {
    const job = this.#active;
    if (job === null || job.choices === undefined) return;
    this.#choices.replaceChildren();
    this.#dim.classList.remove('is-visible');
    this.#root.classList.add('is-hidden');
    this.#releaseModal();
    this.#input?.setEnabled(true);
    this.#active = null;
    job.onChoice?.(index);
    this.#next();
  }

  readonly #onKey = (event: KeyboardEvent): void => {
    const job = this.#active;
    if (job === null) return;
    if (job.choices !== undefined) {
      const index = Number(event.key) - 1;
      if (Number.isInteger(index) && index >= 0 && index < job.choices.length) this.#choose(index);
      return;
    }
    // SPEC-044 §4.1: Enter on any line, Space / E / F on a modal one — fresh,
    // and only once the line has been up for the grace.
    const since = (performance.now() - this.#lineShownAt) / 1000;
    if (!advanceAccepted(event.code, event.repeat, job.modal, since)) return;
    if (ownedElsewhere(event.target, this.#root)) return;
    // §4.3: a modal above the line — the pause menu over a transmission, the
    // pad terminal over a scav's remark — has the keys, wherever its focus sits.
    const top = topModal();
    if (top !== null && top !== this.#root) return;
    event.preventDefault();
    // The press is the line's: it must not also reach the gameplay keys behind
    // it once a last modal line hands the input back (E at the pad would open
    // the terminal on the same press that closed the transmission).
    event.stopPropagation();
    this.skip();
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
    this.#cue.hidden = true;
    this.#releaseModal();
    this.#root.classList.add('is-hidden');
    this.#dim.classList.remove('is-visible');
  }
}
