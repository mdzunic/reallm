// The chapter card (SPEC-023 §4.2): four lines over the launch of the first
// flight to a world — the chapter number, the world's name, its one line, and
// the containment level the station prints on its header (SPEC-014 AC-27).
//
// It is text over the scene and nothing else: the layer sits at z 54, below
// the toasts, is `pointer-events: none`, and the flight never waits for it.
// The card owns its own life — `CARD.show` on screen, then the `CARD.fade`
// fade-out — and the returned `remove()` takes it away at once, which is what
// the scene's `Disposer` calls when the trip ends first.
import type { ChapterCardDef } from '@/data/films';
import { CARD } from '@/systems/StoryBeats';
import { el, testId } from '@/ui/dom';

/**
 * Mounts the card on `host` (the `#ui` root), fades it in, and takes it away
 * again `CARD.show + CARD.fade` later. The returned `remove()` removes it now;
 * calling it twice, or after the card has already gone, is harmless.
 *
 * Under reduce motion the card appears and disappears without fading, and the
 * containment line does not glitch (§4.2, Motion).
 */
export function showChapterCard(
  host: HTMLElement,
  card: Pick<ChapterCardDef, 'chapter' | 'title' | 'line'>,
  reduceMotion: boolean,
): () => void {
  const layer = testId(el('div', 'chapter-card'), 'chapter-card');
  layer.setAttribute('aria-live', 'polite');
  if (reduceMotion) layer.classList.add('is-static');
  layer.style.setProperty('--card-fade', `${CARD.fade}s`);
  layer.append(
    el('p', 'chapter-card-chapter', `CHAPTER ${card.chapter}`),
    el('p', 'chapter-card-title', card.title),
    el('p', 'chapter-card-line', card.line),
    el('p', 'chapter-card-containment', `containment level ${card.chapter}`),
  );
  host.append(layer);
  // The class flips after the initial state has committed, so the opacity
  // transition actually runs instead of starting settled (`EndingOverlay`'s
  // pattern).
  void layer.offsetWidth;
  layer.classList.add('is-visible');

  const timers: ReturnType<typeof setTimeout>[] = [];
  const remove = (): void => {
    for (const timer of timers) clearTimeout(timer);
    timers.length = 0;
    layer.remove();
  };
  if (reduceMotion) {
    timers.push(setTimeout(remove, CARD.show * 1000));
    return remove;
  }
  timers.push(
    setTimeout(() => layer.classList.remove('is-visible'), CARD.show * 1000),
    setTimeout(remove, (CARD.show + CARD.fade) * 1000),
  );
  return remove;
}
