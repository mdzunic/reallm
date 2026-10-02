// The mission banner (SPEC-042 §4.1): what a finished mission paid, on screen
// for 4 s. Not a modal (E20) and not a toast — a toast is the wrong size for
// the payoff of a mission, and it docks with the refusal chatter. It is the
// last row of the HUD's top-centre stack and takes no pointer, so a pause, a
// sheet and the dialogue all sit above it.
//
// Its clock is the scene's step: `tick` runs from `update`, so a banner that
// went up just before the pause menu opened is still there when play resumes
// (42-b). Banners queue and show one at a time, in completion order (42-a).
//
// Two texts at once halve both, so while a banner is up the dialogue layer
// starts nothing new (`DialogueUI.setHeld`): the line already on screen
// finishes, and a mission's non-modal `onComplete` line plays once the banner
// has gone. The hold is taken from the push, so a line queued right behind the
// banner waits, and it lasts until the last queued banner has gone — through a
// boss reveal too, whose caption is text enough. Only a beat that speaks, the
// ending with its own lines, has the layer let go while it runs; the banner
// shows once the beat is over either way.
//
// SPEC-043 §4.6: up to three optional rows sit under the rewards line — the
// bonus (earned or missed), the contract, and the run's time — each hidden
// when `completionLines` left it null. The rewards and the three share a body,
// which a short touch screen runs together as one line.
import type { CompletionLines } from '@/systems/UiHelpers';
import type { DialogueUI } from '@/ui/DialogueUI';
import { el, SHORT_SCREEN_QUERY, testId, type UiRoot } from '@/ui/dom';

/** §4.1: how long a banner stays up, in scene seconds (*initial tuning*). */
export const BANNER_SECONDS = 4.0;
/** §4.1: the fade out; none under reduce motion. */
export const BANNER_FADE_MS = 150;

export interface MissionBannerDeps {
  dialogue: Pick<DialogueUI, 'setHeld'>;
  reduceMotion: () => boolean;
  /**
   * Whether the toast rack should stay held when the last banner goes — a
   * dialogue line still up, or about to start, keeps SPEC-037's hold of its
   * own. The scene answers from the dialogue layer; absent, the rack is let go.
   */
  keepToasts?: () => boolean;
  /**
   * Whether the beat holding the screen plays dialogue of its own — the
   * ending's lines — so the hold lets the layer go while it runs; a banner
   * waiting under it would otherwise wait on lines that wait on it. A reveal
   * speaks through its own caption. Absent, no beat speaks.
   */
  beatSpeaks?: () => boolean;
}

export class MissionBanner {
  readonly #ui: UiRoot;
  readonly #dialogue: Pick<DialogueUI, 'setHeld'>;
  readonly #reduceMotion: () => boolean;
  readonly #keepToasts: () => boolean;
  readonly #beatSpeaks: () => boolean;
  readonly #root: HTMLDivElement;
  readonly #title: HTMLParagraphElement;
  readonly #rewards: HTMLParagraphElement;
  /** SPEC-043 §4.6: the bonus, contract and time rows. */
  readonly #bonus: HTMLParagraphElement;
  readonly #contract: HTMLParagraphElement;
  readonly #time: HTMLParagraphElement;
  readonly #next: HTMLParagraphElement;
  readonly #queue: CompletionLines[] = [];
  /** The banner on screen, or `null`. */
  #shown: CompletionLines | null = null;
  /** Scene seconds the shown banner has left before it fades. */
  #left = 0;
  /** Scene seconds of fade left; > 0 only while fading. */
  #fading = 0;
  #dialogueHeld = false;
  #toastsHeld = false;
  /** Whether a beat had the screen on the last tick — the banner hides under it. */
  #beat = false;
  /** `(max-height: 500px)`, kept from its `change` event so `tick` reads no DOM. */
  #short = false;
  readonly #media: MediaQueryList | null;

  constructor(ui: UiRoot, deps: MissionBannerDeps) {
    this.#ui = ui;
    this.#dialogue = deps.dialogue;
    this.#reduceMotion = deps.reduceMotion;
    this.#keepToasts = deps.keepToasts ?? ((): boolean => false);
    this.#beatSpeaks = deps.beatSpeaks ?? ((): boolean => false);
    this.#title = testId(el('p', 'mission-banner-title'), 'mission-complete-title');
    this.#rewards = testId(el('p', 'mission-banner-rewards'), 'mission-complete-rewards');
    this.#bonus = testId(el('p', 'mission-banner-extra mission-banner-bonus is-hidden'), 'mission-complete-bonus');
    this.#contract = testId(el('p', 'mission-banner-extra mission-banner-contract is-hidden'), 'mission-complete-contract');
    this.#time = testId(el('p', 'mission-banner-extra mission-banner-time is-hidden'), 'mission-complete-time');
    this.#next = testId(el('p', 'mission-banner-next'), 'mission-complete-next');
    this.#root = testId(el('div', 'mission-banner panel is-hidden'), 'mission-complete');
    this.#root.setAttribute('role', 'status');
    const body = el('div', 'mission-banner-body');
    body.append(this.#rewards, this.#bonus, this.#contract, this.#time);
    this.#root.append(el('p', 'mission-banner-head', 'Mission complete'), this.#title, body, this.#next);
    // §4.1: the last row of the top-centre stack, so `--hud-tc-h` counts it and
    // the short-screen dialogue docks under it. Looked up once, here.
    const stack = ui.root.querySelector<HTMLElement>('.hud .hud-tc');
    if (stack !== null) stack.append(this.#root);
    else ui.mount(this.#root, 'hud');
    this.#media = typeof globalThis.matchMedia === 'function' ? globalThis.matchMedia(SHORT_SCREEN_QUERY) : null;
    this.#short = this.#media?.matches === true;
    this.#media?.addEventListener('change', this.#onMedia);
  }

  /** True while a banner is queued, up or fading. */
  get busy(): boolean {
    return this.#shown !== null || this.#queue.length > 0;
  }

  /** True while this banner holds the toast rack (a short screen, §4.1). */
  get holdingToasts(): boolean {
    return this.#toastsHeld;
  }

  /** §4.1: queue a banner. It shows from the next tick that no beat holds. */
  push(lines: CompletionLines): void {
    this.#queue.push(lines);
    // From the push, so the `onComplete` line queued right behind waits (§4.1)
    // — unless the beat on screen is one that speaks.
    if (!this.#beat || !this.#beatSpeaks()) this.#holdDialogue(true);
  }

  /**
   * Called from the scene's step. While `held` — a film, a reveal or the
   * ending has the screen — nothing starts, nothing counts, and the banner on
   * screen hides until the beat is over (§4.1, 42-c). Writes classes and text
   * only; reads nothing from the DOM.
   */
  tick(dt: number, held: boolean): void {
    if (held !== this.#beat) {
      this.#beat = held;
      this.#root.classList.toggle('is-held', held);
    }
    if (!this.busy) return;
    if (held) {
      // The ending needs the dialogue layer for lines of its own; under a
      // reveal, what waits behind the banner keeps waiting.
      this.#holdDialogue(!this.#beatSpeaks());
      return;
    }
    this.#holdDialogue(true);
    if (this.#shown === null) {
      this.#show(this.#queue.shift() as CompletionLines);
      return;
    }
    if (this.#fading > 0) {
      this.#fading -= dt;
      if (this.#fading <= 0) this.#finish();
      return;
    }
    this.#left -= dt;
    if (this.#left > 0) return;
    const fade = this.#reduceMotion() ? 0 : BANNER_FADE_MS / 1000;
    this.#root.classList.add('is-fading');
    if (fade <= 0) this.#finish();
    else this.#fading = fade;
  }

  dispose(): void {
    this.#media?.removeEventListener('change', this.#onMedia);
    this.#queue.length = 0;
    this.#shown = null;
    this.#releaseToasts();
    this.#holdDialogue(false);
    this.#root.remove();
  }

  #show(lines: CompletionLines): void {
    this.#shown = lines;
    this.#left = BANNER_SECONDS;
    this.#fading = 0;
    this.#title.textContent = lines.title;
    this.#rewards.textContent = lines.rewards;
    setRow(this.#bonus, lines.bonus ?? null);
    setRow(this.#contract, lines.contract ?? null);
    setRow(this.#time, lines.time ?? null);
    this.#next.textContent = lines.next ?? '';
    this.#next.classList.toggle('is-hidden', lines.next === null);
    this.#root.classList.remove('is-hidden', 'is-fading');
    // §4.1: on a short screen the banner meets the right-hand rack, so the
    // toasts wait for it, as they wait for a docked dialogue line (SPEC-037).
    if (this.#short && !this.#toastsHeld) {
      this.#toastsHeld = true;
      this.#ui.holdToasts(true);
    }
  }

  /** The faded banner goes; the next queued one shows on the next tick, or every hold is let go. */
  #finish(): void {
    this.#shown = null;
    this.#fading = 0;
    this.#root.classList.add('is-hidden');
    this.#root.classList.remove('is-fading');
    if (this.#queue.length > 0) return;
    // The rack first: a line the released dialogue starts holds it again on its
    // own `dialogue:started`, which would otherwise be undone right after.
    this.#releaseToasts();
    this.#holdDialogue(false);
  }

  #releaseToasts(): void {
    if (!this.#toastsHeld) return;
    this.#toastsHeld = false;
    if (!this.#keepToasts()) this.#ui.holdToasts(false);
  }

  #holdDialogue(on: boolean): void {
    if (on === this.#dialogueHeld) return;
    this.#dialogueHeld = on;
    this.#dialogue.setHeld(on);
  }

  readonly #onMedia = (event: MediaQueryListEvent): void => {
    this.#short = event.matches;
  };
}

/** SPEC-043 §4.6: an optional row shows its text, or hides when there is none. */
function setRow(row: HTMLParagraphElement, text: string | null): void {
  row.textContent = text ?? '';
  row.classList.toggle('is-hidden', text === null);
}
