// The mission board (SPEC-014 §4.3, AC-30..36). Rows render from the pure
// helpers — `missionStatus`, `requirementText`, `rewardsText` — and the two
// mission mutations go through `acceptMission`/`abandonMission` with the
// board emitting the events and requesting the autosave, the way SPEC-010's
// Economy does for purchases.
//
// Pinning (AC-33) moves the mission to the front of `progress.missionsActive`
// (SPEC-034 §4.15) — the order the runtime already pins by — so the pin
// persists across a reload with no save field, and the badge follows the front
// entry among the planet's active missions rather than a WeakMap the board
// alone could see.
import type { Save, SaveStore } from '@/core/Save';
import { MISSIONS, PLANET_IDS, PLANETS, type MissionDef, type MissionId } from '@/data/index';
import type { Economy } from '@/systems/Economy';
import type { EventSink } from '@/systems/Progression';
import {
  abandonMission,
  acceptMission,
  bossDropText,
  missionStatus,
  pinMission,
  pinnedMission,
  requirementText,
  rewardsText,
  type MissionStatus,
} from '@/systems/UiHelpers';
import { confirmSheet } from '@/ui/ConfirmSheet';
import { el, h, testId, type UiRoot } from '@/ui/dom';

export { pinnedMission } from '@/systems/UiHelpers';

export interface BoardDeps {
  ui: UiRoot;
  save: SaveStore;
  data: Save;
  economy: Economy;
  events: EventSink;
}

const MISSION_IDS = Object.keys(MISSIONS) as MissionId[];

/**
 * SPEC-035 §4.12 — the row order inside a planet. A replay sorting above new
 * work was the review's complaint; `done` rides with `replayable` because the
 * station is the only place a finished mission reads as either.
 */
const STATUS_ORDER: Readonly<Record<MissionStatus, number>> = {
  active: 0,
  available: 1,
  locked: 2,
  replayable: 3,
  done: 3,
};

export class MissionBoard {
  readonly #container: HTMLElement;
  readonly #deps: BoardDeps;
  /**
   * Rows whose fold state the player has flipped away from its default
   * (AC-31); survives refreshes, not scenes. SPEC-035 §4.12 opens `available`
   * and `active` briefs by default, so this is the *override* set rather than
   * the open set — a tap still folds an open row and unfolds a closed one.
   */
  readonly #toggled = new Set<MissionId>();

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
      // SPEC-035 §4.12: what there is to do first, what there is to do next,
      // what is not open yet, and only then what has already been done.
      const ordered = missions
        .map((id, index) => ({ id, index, status: missionStatus(this.#deps.data, MISSIONS[id], 'station') }))
        .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.index - b.index);
      const rows = ordered.map((entry) => this.#row(MISSIONS[entry.id]));
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
        'aria-expanded': String(this.#briefOpen(def, status)),
        // AC-31: the brief folds on tap — SPEC-035 §4.12 only changed which way
        // it starts.
        click: () => {
          if (!this.#toggled.delete(def.id as MissionId)) this.#toggled.add(def.id as MissionId);
          this.refresh();
        },
      },
      h('span', { class: 'board-title' }, def.title),
      h('span', { class: `badge badge-${def.type}` }, def.type),
      // AC-36: flight missions say where they happen.
      def.scene === 'flight' ? h('span', { class: 'badge badge-flight' }, `during flight to ${PLANETS[def.planet].name}`) : null,
      pinnedMission(data, def.planet) === def.id ? h('span', { class: 'badge badge-pin' }, '📌 pinned') : null,
      h('span', { class: 'board-status' }, status),
    );
    row.append(head);

    // AC-31: rewards, always visible; halved and marked on a replay row.
    const rewards = rewardsText(def.rewards, status === 'replayable');
    row.append(h('p', { class: 'board-rewards' }, rewards === '' ? '—' : rewards));
    // SPEC-039 §4.6: a boss mission says what its boss drops — the piece on a
    // first kill the save does not own, else the lithium in its place.
    const drop = bossDropText(data, def);
    if (drop !== null) row.append(testId(h('p', { class: 'board-drop' }, drop), `mission-${def.id}-drop`));

    if (this.#briefOpen(def, status)) {
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
      // SPEC-035 §4.12: `Abandon` sits at the far end of the row, away from
      // where `Accept` was, so the two are never the same tap target.
      actions.append(
        this.#pinButton(def),
        testId(
          h('button', { class: 'ui-btn board-abandon', type: 'button', click: () => this.#abandon(def) }, 'Abandon'),
          `mission-${def.id}-abandon`,
        ),
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

  /**
   * SPEC-035 §4.12: an `available` or `active` row shows its brief without a
   * tap — the board knew what the mission was and folded it shut. Any row the
   * player has tapped keeps the opposite of its default.
   */
  #briefOpen(def: MissionDef, status: MissionStatus): boolean {
    const open = status === 'available' || status === 'active';
    return this.#toggled.has(def.id as MissionId) ? !open : open;
  }

  /**
   * AC-33: one pin per planet; SPEC-034 §4.15 makes it the front entry of
   * `progress.missionsActive`, which the runtime reads on the next landing.
   * There is nothing to un-pin — something is always at the front — so a pinned
   * row's button simply reads as pressed.
   */
  #pinButton(def: MissionDef): HTMLButtonElement {
    const pinned = pinnedMission(this.#deps.data, def.planet) === def.id;
    return testId(
      h(
        'button',
        {
          class: `ui-btn${pinned ? ' is-active seg' : ''}`,
          type: 'button',
          'aria-pressed': String(pinned),
          click: () => {
            if (!pinMission(this.#deps.data, def.id as MissionId)) return;
            this.#deps.save.request('mission');
            this.refresh();
          },
        },
        'Pin',
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
      this.#deps.events.emit('mission:abandoned', { id: def.id as MissionId });
      this.#deps.save.request('mission');
      this.refresh();
    });
  }
}
