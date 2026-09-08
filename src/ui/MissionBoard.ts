// The mission board (SPEC-014 §4.3, AC-30..36). Rows render from the pure
// helpers — `missionStatus`, `requirementText`, `rewardsText` — and the two
// mission mutations go through `acceptMission`/`abandonMission` with the
// board emitting the events and requesting the autosave, the way SPEC-010's
// Economy does for purchases.
//
// Pinning (AC-33) is session state: the save schema is SPEC-007's and carries
// no pin field, so the pin lives beside the save object and SPEC-012's HUD
// objective reads it through `pinnedMission()`. One pin at a time; pinning a
// second mission unpins the first.
import type { SaveStore, SaveV1 } from '@/core/Save';
import { MISSIONS, PLANET_IDS, PLANETS, type MissionDef, type MissionId } from '@/data/index';
import type { Economy } from '@/systems/Economy';
import type { EventSink } from '@/systems/Progression';
import {
  abandonMission,
  acceptMission,
  missionStatus,
  requirementText,
  rewardsText,
} from '@/systems/UiHelpers';
import { confirmSheet } from '@/ui/ConfirmSheet';
import { el, h, testId, type UiRoot } from '@/ui/dom';

const PINNED = new WeakMap<SaveV1, MissionId | null>();

/** What SPEC-012's objective line will read; `null` until something is pinned. */
export function pinnedMission(data: SaveV1): MissionId | null {
  return PINNED.get(data) ?? null;
}

export interface BoardDeps {
  ui: UiRoot;
  save: SaveStore;
  data: SaveV1;
  economy: Economy;
  events: EventSink;
}

const MISSION_IDS = Object.keys(MISSIONS) as MissionId[];

export class MissionBoard {
  readonly #container: HTMLElement;
  readonly #deps: BoardDeps;
  /** Briefs the player has expanded; survives refreshes, not scenes (AC-31). */
  readonly #openBriefs = new Set<MissionId>();

  constructor(container: HTMLElement, deps: BoardDeps) {
    this.#container = container;
    this.#deps = deps;
    this.refresh();
  }

  refresh(): void {
    const groups: HTMLElement[] = [];
    // AC-30: grouped by unlocked planet, in chapter order.
    for (const planet of PLANET_IDS) {
      if (!this.#deps.economy.isUnlocked(planet)) continue;
      const missions = MISSION_IDS.filter((id) => MISSIONS[id].planet === planet);
      if (missions.length === 0) continue;
      const rows = missions.map((id) => this.#row(MISSIONS[id]));
      groups.push(h('section', { class: 'board-group' }, h('p', { class: 'board-planet' }, PLANETS[planet].name), ...rows));
    }
    const board = testId(el('div', 'board'), 'mission-board');
    board.append(...groups);
    this.#container.replaceChildren(board);
  }

  #row(def: MissionDef): HTMLElement {
    const { data } = this.#deps;
    const status = missionStatus(data, def, 'station');
    const row = testId(el('article', `board-row is-${status}`), `mission-${def.id}`);

    const head = h(
      'button',
      {
        class: 'board-head',
        type: 'button',
        'aria-expanded': String(this.#openBriefs.has(def.id as MissionId)),
        // AC-31: the brief expands on tap.
        click: () => {
          if (!this.#openBriefs.delete(def.id as MissionId)) this.#openBriefs.add(def.id as MissionId);
          this.refresh();
        },
      },
      h('span', { class: 'board-title' }, def.title),
      h('span', { class: `badge badge-${def.type}` }, def.type),
      // AC-36: flight missions say where they happen.
      def.scene === 'flight' ? h('span', { class: 'badge badge-flight' }, `during flight to ${PLANETS[def.planet].name}`) : null,
      pinnedMission(data) === def.id ? h('span', { class: 'badge badge-pin' }, '📌 pinned') : null,
      h('span', { class: 'board-status' }, status),
    );
    row.append(head);

    // AC-31: rewards, always visible; halved and marked on a replay row.
    const rewards = rewardsText(def.rewards, status === 'replayable');
    row.append(h('p', { class: 'board-rewards' }, rewards === '' ? '—' : rewards));

    if (this.#openBriefs.has(def.id as MissionId)) {
      row.append(h('p', { class: 'board-brief' }, def.brief));
    }

    if (status === 'locked') {
      // AC-35: say what is missing, in the data's own order.
      const missing = this.#deps.economy.missingRequirements(def.requires);
      row.append(h('p', { class: 'board-locked' }, missing.map(requirementText).join(' · ')));
      return row;
    }

    const actions = el('div', 'board-actions');
    if (status === 'available') {
      actions.append(
        testId(h('button', { class: 'ui-btn is-primary', type: 'button', click: () => this.#accept(def, false) }, 'Accept'), `mission-${def.id}-accept`),
      );
    } else if (status === 'active') {
      actions.append(
        testId(h('button', { class: 'ui-btn', type: 'button', click: () => this.#abandon(def) }, 'Abandon'), `mission-${def.id}-abandon`),
        this.#pinButton(def),
      );
    } else if (status === 'replayable') {
      // AC-34: the replay pays half, and says so on the button.
      actions.append(
        testId(
          h(
            'button',
            { class: 'ui-btn', type: 'button', click: () => this.#accept(def, true) },
            'Replay ',
            h('span', { class: 'badge badge-replay' }, '50% rewards'),
          ),
          `mission-${def.id}-replay`,
        ),
      );
    }
    if (actions.childElementCount > 0) row.append(actions);
    return row;
  }

  /** AC-33: one pin; a new pin displaces the old one. */
  #pinButton(def: MissionDef): HTMLButtonElement {
    const pinned = pinnedMission(this.#deps.data) === def.id;
    return testId(
      h(
        'button',
        {
          class: `ui-btn${pinned ? ' is-active seg' : ''}`,
          type: 'button',
          'aria-pressed': String(pinned),
          click: () => {
            PINNED.set(this.#deps.data, pinned ? null : (def.id as MissionId));
            this.refresh();
          },
        },
        pinned ? 'Unpin' : 'Pin',
      ),
      `mission-${def.id}-pin`,
    );
  }

  #accept(def: MissionDef, replay: boolean): void {
    if (!acceptMission(this.#deps.data, def)) return;
    this.#deps.events.emit('mission:accepted', { id: def.id as MissionId });
    this.#deps.save.request('mission');
    this.#deps.ui.toast(replay ? `Replaying '${def.title}' — 50% rewards` : `Accepted '${def.title}'`, 'good');
    this.refresh();
  }

  /** Abandoning drops field progress — that earns a sheet, not just a tap. */
  #abandon(def: MissionDef): void {
    void confirmSheet(this.#deps.ui, {
      title: `Abandon '${def.title}'?`,
      body: 'Stage progress is lost; the mission returns to the board.',
      confirmText: 'Abandon',
      danger: true,
    }).then((yes) => {
      if (!yes) return;
      if (!abandonMission(this.#deps.data, def.id as MissionId)) return;
      if (pinnedMission(this.#deps.data) === def.id) PINNED.set(this.#deps.data, null);
      this.#deps.events.emit('mission:abandoned', { id: def.id as MissionId });
      this.#deps.save.request('mission');
      this.refresh();
    });
  }
}
