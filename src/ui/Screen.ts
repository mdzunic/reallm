// The console frame every DOM screen mounts into (SPEC-031 §4.4–§4.10). One
// primitive, not four hand-built layouts: the grid — head / rail / body /
// foot — is why the header and the body can be proven to share a centre, and
// the channel line is where the fiction lives (diegetic, never meta: a header
// may say COMMAND RELAY, never anything about a simulation).
//
// SPEC-044 §4.11: the rail's sections are a real tablist — arrow keys between
// them, the panel their tabpanel — and its actions (Star Map, Settings, Quit)
// follow a rule as plain buttons: a tab that navigates away is not a tab.
import { el, h, keepFocus, testId } from '@/ui/dom';

export type ScreenId = 'menu' | 'creation' | 'station' | 'starmap' | 'pause';

export interface ScreenTab {
  /** The tab's testid, verbatim — the station passes the ids it already uses. */
  readonly id: string;
  readonly label: string;
  readonly active?: boolean;
  /** SPEC-044 §4.11: 'section' swaps the body; 'action' acts. Default 'section'. */
  readonly kind?: 'section' | 'action';
  /** SPEC-044 §4.6: an action styled as the screen's next step. */
  readonly primary?: boolean;
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

/**
 * §4.5: the channel line under the title. Pure, and never meta (PLAN §12).
 *
 * SPEC-035 §4.12: the station's line stopped repeating the frame's own head —
 * the title already says `Command Relay` and the header carries exactly one
 * `Containment level N`. It names what the place is *for* instead.
 */
export function channelText(id: ScreenId): string {
  switch (id) {
    case 'menu':
      return 'EARTH COMMAND · SALVAGE DIVISION';
    case 'creation':
      return 'PERSONNEL FILE · NEW SALVAGER';
    case 'station':
      return 'SUPPLY · REFIT · DISPATCH';
    case 'starmap':
      return 'NAVIGATION · OUTBOUND';
    case 'pause':
      return 'SYSTEM HOLD';
  }
}

/** SPEC-044 §4.11: the panel a screen's tablist controls — `station-panel`. */
export function tabPanelId(id: ScreenId): string {
  return `${id}-panel`;
}

/**
 * SPEC-044 §4.11: the rail — the `section` tabs as a `role="tablist"` (roving
 * focus: `tabindex` 0 on the selected tab, −1 on the rest; arrows, Home and End
 * move focus, Enter or Space selects), then a rule, then the `action` entries
 * as plain buttons with no pressed state.
 */
function railChildren(id: ScreenId, tabs: readonly ScreenTab[]): HTMLElement[] {
  const sections = tabs.filter((tab) => (tab.kind ?? 'section') === 'section');
  const actions = tabs.filter((tab) => tab.kind === 'action');
  const out: HTMLElement[] = [];
  if (sections.length > 0) {
    const selected = sections.find((tab) => tab.active === true) ?? sections[0];
    const buttons = sections.map((tab) =>
      testId(
        h(
          'button',
          {
            class: `ui-btn seg screen-tab${tab === selected ? ' is-active' : ''}`,
            type: 'button',
            role: 'tab',
            id: tab.id,
            'aria-selected': String(tab === selected),
            'aria-controls': tabPanelId(id),
            tabindex: tab === selected ? 0 : -1,
            click: () => tab.onSelect(),
          },
          tab.label,
        ),
        tab.id,
      ),
    );
    const list = h('div', { class: 'screen-tabs', role: 'tablist', 'aria-label': id.charAt(0).toUpperCase() + id.slice(1) }, ...buttons);
    list.addEventListener('keydown', (event) => {
      const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (at < 0) return;
      const last = buttons.length - 1;
      let next: number;
      switch (event.key) {
        case 'ArrowUp':
        case 'ArrowLeft':
          next = at === 0 ? last : at - 1;
          break;
        case 'ArrowDown':
        case 'ArrowRight':
          next = at === last ? 0 : at + 1;
          break;
        case 'Home':
          next = 0;
          break;
        case 'End':
          next = last;
          break;
        default:
          return;
      }
      event.preventDefault();
      buttons[next]?.focus();
    });
    out.push(list);
  }
  if (sections.length > 0 && actions.length > 0) out.push(el('hr', 'screen-rail-rule'));
  for (const tab of actions) {
    out.push(
      testId(
        h(
          'button',
          { class: `ui-btn screen-action${tab.primary === true ? ' is-primary' : ''}`, type: 'button', click: () => tab.onSelect() },
          tab.label,
        ),
        tab.id,
      ),
    );
  }
  return out;
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
      // SPEC-044 §4.2: a keyboard selection keeps its focus across the rebuild.
      keepFocus(rail, () => rail.replaceChildren(...railChildren(options.id, tabs)));
    },
    dispose(): void {
      // Give the build label back to the page — unless a newer screen has
      // already adopted it out of this footer.
      if (note !== null && noteHome !== null && note.parentElement === footer) noteHome.append(note);
      root.remove();
    },
  };
}
