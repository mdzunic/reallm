// The contact card (SPEC-063 §4.5): three lines over the live flight the first
// time a flight enemy's group comes in — `CONTACT`, the enemy's name and its
// epithet — beside the comms line that answers who flies it.
//
// It is the chapter card's kind of layer: directly under `#ui` at z 54,
// `pointer-events: none`, and nothing in the flight waits for it. The card
// owns its own life — it fades in over `CONTACT.fade`, holds until
// `CONTACT.show`, then fades out over `CONTACT.fade` — and the returned
// `remove()` takes it away at once, which is what the scene's `Disposer`
// calls when the trip ends first.
import { CONTACT } from '@/systems/StoryBeats';
import { el, testId } from '@/ui/dom';

/**
 * Mounts the card on `host`, fades it in, and takes it away again
 * `CONTACT.show + CONTACT.fade` later. The returned `remove()` removes it now;
 * calling it twice, or after the card has already gone, is harmless.
 *
 * `card.enemy` is the card's `data-enemy`. Under reduce motion the card
 * appears and disappears without fading, `CONTACT.show` after it went up.
 */
export function showContactCard(
  host: HTMLElement,
  card: { enemy: string; name: string; epithet: string },
  reduceMotion: boolean,
): () => void {
  const layer = testId(el('div', 'contact-card'), 'contact-card');
  layer.dataset['enemy'] = card.enemy;
  layer.setAttribute('aria-live', 'polite');
  if (reduceMotion) layer.classList.add('is-static');
  layer.style.setProperty('--card-fade', `${CONTACT.fade}s`);
  layer.append(
    el('p', 'contact-card-kicker', 'CONTACT'),
    el('p', 'contact-card-name', card.name),
    el('p', 'contact-card-epithet', card.epithet),
  );
  host.append(layer);
  // The class flips after the initial state has committed, so the opacity
  // transition actually runs instead of starting settled (`ChapterCard`'s
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
    timers.push(setTimeout(remove, CONTACT.show * 1000));
    return remove;
  }
  timers.push(
    setTimeout(() => layer.classList.remove('is-visible'), CONTACT.show * 1000),
    setTimeout(remove, (CONTACT.show + CONTACT.fade) * 1000),
  );
  return remove;
}
