// The console frame every DOM screen mounts into (SPEC-031 §4.4–§4.10). One
// primitive, not four hand-built layouts: the grid — head / rail / body /
// foot — is why the header and the body can be proven to share a centre, and
// the channel line is where the fiction lives (diegetic, never meta: a header
// may say COMMAND RELAY, never anything about a simulation).
import { el, h, testId } from '@/ui/dom';

export type ScreenId = 'menu' | 'creation' | 'station' | 'starmap' | 'pause';

export interface ScreenTab {
  /** The tab's testid, verbatim — the station passes the ids it already uses. */
  readonly id: string;
  readonly label: string;
  readonly active?: boolean;
  onSelect(): void;
}

export interface ScreenOptions {
  readonly id: ScreenId;
  /** Defaults to `screenTitle(id)`. */
  readonly title?: string;
  /** Defaults to `channelText(id)`. */
  readonly channel?: string;
  /** The star map: `min(1400px, 100%)`, no rail column, the body see-through. */
  readonly wide?: boolean;
}

export interface Screen {
  readonly root: HTMLDivElement;
  readonly body: HTMLDivElement;
  readonly footer: HTMLDivElement;
  setChannel(text: string): void;
  setStatus(node: HTMLElement | null): void;
  setTabs(tabs: readonly ScreenTab[]): void;
  dispose(): void;
}

/** §4.5: the display name over each screen's body. Pure. */
export function screenTitle(id: ScreenId): string {
  switch (id) {
    case 'menu':
      return 'ReaLLM';
    case 'creation':
      return 'New Salvager';
    case 'station':
      return 'Command Relay';
    case 'starmap':
      return 'Star Map';
    case 'pause':
      return 'Paused';
  }
}

/** §4.5: the channel line under the title. Pure, and never meta (PLAN §12). */
export function channelText(id: ScreenId, context?: { containment?: number }): string {
  switch (id) {
    case 'menu':
      return 'EARTH COMMAND · SALVAGE DIVISION';
    case 'creation':
      return 'PERSONNEL FILE · NEW SALVAGER';
    case 'station':
      return `COMMAND RELAY · CONTAINMENT LEVEL ${context?.containment ?? 1}`;
    case 'starmap':
      return 'NAVIGATION · OUTBOUND';
    case 'pause':
      return 'SYSTEM HOLD';
  }
}

/** §4.4: one `div.screen[data-testid="screen"]` — grid, scrim, head, rail, body, foot. */
export function createScreen(options: ScreenOptions): Screen {
  const root = testId(el('div', `screen screen-${options.id}${options.wide === true ? ' is-wide' : ''}`), 'screen');
  const frame = el('div', 'screen-frame');

  const title = h('h1', { class: 'screen-title' }, options.title ?? screenTitle(options.id));
  const channel = el('p', 'screen-channel');
  const headText = el('div', 'screen-head-text');
  headText.append(title, channel);
  const status = el('div', 'screen-status');
  const head = el('header', 'screen-head');
  head.append(headText, status);

  const rail = el('nav', 'screen-rail');
  rail.setAttribute('aria-label', 'Sections');
  const body = el('div', 'screen-body');
  const hint = el('span', 'screen-hint');
  const footer = el('div', 'screen-foot');
  footer.setAttribute('role', 'contentinfo');
  footer.append(hint);

  frame.append(head, rail, body, footer);
  root.append(frame);

  const setChannel = (text: string): void => {
    channel.textContent = text;
    // 31-e: the line clamps to one row; the full text stays reachable.
    channel.title = text;
  };
  setChannel(options.channel ?? channelText(options.id));

  // §4.8: a DOM screen adopts the build label into its footer as the
  // right-hand item; gameplay scenes keep the corner tag, so the pause frame
  // (a layer inside a gameplay scene) leaves it where it is. The five-tap
  // listener lives on the element and survives the move.
  const note = options.id === 'pause' ? null : document.querySelector('[data-testid="version-label"]');
  const noteHome = note?.parentElement ?? null;
  if (note !== null) footer.append(note);

  return {
    root,
    body,
    footer,
    setChannel,
    setStatus(node: HTMLElement | null): void {
      if (node === null) status.replaceChildren();
      else status.replaceChildren(node);
    },
    setTabs(tabs: readonly ScreenTab[]): void {
      root.classList.toggle('has-rail', tabs.length > 0);
      rail.replaceChildren(
        ...tabs.map((tab) =>
          testId(
            h(
              'button',
              {
                class: `ui-btn seg screen-tab${tab.active === true ? ' is-active' : ''}`,
                type: 'button',
                'aria-pressed': String(tab.active === true),
                click: () => tab.onSelect(),
              },
              tab.label,
            ),
            tab.id,
          ),
        ),
      );
    },
    dispose(): void {
      // Give the build label back to the page — unless a newer screen has
      // already adopted it out of this footer.
      if (note !== null && noteHome !== null && note.parentElement === footer) noteHome.append(note);
      root.remove();
    },
  };
}
