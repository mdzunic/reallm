// The boss reveal's screen layer (SPEC-023 §4.4). The camera move and the
// simulation hold belong to the surface scene; this owns the letterbox, the
// boss's name and epithet, the one caption, the Skip button and the key
// capture that keeps those keys out of the game while the beat runs.
//
// It mounts directly under `#ui` at z 64 — under the film layer (65), over
// every panel and overlay — because a reveal is a film that happens to be
// played by the engine. Captions wear SPEC-022's own caption styles, so ARIA
// sounds the same here as she does in a film. No `three` (SPEC-001 §4); the
// sound is the scene's, as in the film player.
import type { FilmSpeaker } from '@/data/films';
import { skipAccepted } from '@/systems/StoryBeats';
import { SPEAKER_NAMES } from '@/ui/DialogueUI';
import { el, h, testId } from '@/ui/dom';

/** What the scene hands over when the arena wakes (§4.4, Overlay). */
export interface RevealContent {
  /** `ENEMIES[boss].name`, uppercased by the caller. */
  name: string;
  epithet: string;
  speaker: FilmSpeaker;
  line: string;
  /** `BOSS_REVEALS[boss].glitch` — the Hive Queen's torn title. */
  glitch: boolean;
}

/** The keys the capture listener swallows, as the film player does (SPEC-022 §4.5). */
const PREVENTED_KEYS = ['Escape', 'Enter', 'NumpadEnter', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];

export class RevealOverlay {
  readonly #host: HTMLElement;
  #layer: HTMLDivElement | null = null;
  #title: HTMLDivElement | null = null;
  #caption: HTMLDivElement | null = null;
  #onSkip: (() => void) | null = null;
  /** `performance.now()` at `show()` — the wall clock the skip grace reads. */
  #startedWall = 0;

  constructor(host: HTMLElement) {
    this.#host = host;
  }

  /** The bars slide in; the words wait for `hold()`. */
  show(content: RevealContent, onSkip: () => void): void {
    this.hide();
    this.#onSkip = onSkip;
    this.#startedWall = performance.now();

    const name = el('p', 'reveal-name', content.name);
    if (content.glitch) name.classList.add('is-glitched');
    const title = el('div', 'reveal-title is-hidden');
    title.append(name, el('p', 'reveal-epithet', content.epithet));
    title.setAttribute('aria-live', 'polite');

    const captionText = el('p', 'film-caption-text', content.line);
    const caption = testId(el('div', 'film-caption reveal-caption is-hidden'), 'reveal-caption');
    caption.dataset['speaker'] = content.speaker;
    caption.append(
      el('span', 'film-caption-speaker', content.speaker === 'title' ? '' : SPEAKER_NAMES[content.speaker]),
      captionText,
    );

    const skip = testId(
      h('button', { class: 'ui-btn reveal-skip', type: 'button', click: () => this.#pointerSkip() }, 'Skip ›'),
      'reveal-skip',
    );
    const layer = testId(el('div', 'reveal'), 'boss-reveal');
    layer.append(el('div', 'reveal-bar reveal-bar-top'), el('div', 'reveal-bar reveal-bar-bottom'), title, caption, skip);
    this.#host.append(layer);
    // Commit the bars' start state before the class that slides them in.
    void layer.offsetWidth;
    layer.classList.add('is-open');

    this.#layer = layer;
    this.#title = title;
    this.#caption = caption;
    window.addEventListener('keydown', this.#onKey, true);
  }

  /** §4.4: the hold phase — the name, the epithet and the caption appear. */
  hold(): void {
    this.#title?.classList.remove('is-hidden');
    this.#caption?.classList.remove('is-hidden');
  }

  hide(): void {
    if (this.#layer === null) return;
    window.removeEventListener('keydown', this.#onKey, true);
    this.#layer.remove();
    this.#layer = null;
    this.#title = null;
    this.#caption = null;
    this.#onSkip = null;
  }

  dispose(): void {
    this.hide();
  }

  /**
   * SPEC-022 §4.5: while the layer is up no key reaches the game, and Escape
   * or Enter skip once the key grace has passed — so a key held into the beat
   * cannot throw it away (E33).
   */
  readonly #onKey = (event: KeyboardEvent): void => {
    if (this.#layer === null) return;
    event.stopPropagation();
    if (PREVENTED_KEYS.includes(event.code)) event.preventDefault();
    const elapsed = (performance.now() - this.#startedWall) / 1000;
    if (skipAccepted({ kind: 'key', code: event.code, repeat: event.repeat }, elapsed)) this.#skip();
  };

  #pointerSkip(): void {
    if (this.#layer === null) return;
    const elapsed = (performance.now() - this.#startedWall) / 1000;
    if (skipAccepted({ kind: 'pointer' }, elapsed)) this.#skip();
  }

  /** The scene restores the camera, the input and the simulation; we only ask. */
  #skip(): void {
    const onSkip = this.#onSkip;
    if (onSkip === null) return;
    onSkip();
  }
}
