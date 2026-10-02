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
//
// SPEC-043: a row with a bonus says what it asks and pays; a replay that the
// next landing would run as a contract says so on its button and in a badge;
// and a mission with a best time on this device shows it beside its status.
//
// SPEC-044 §4.6, §4.11: the board speaks plain words (`In progress`, `Main`,
// `Tracked`, `Needs: …`), an active row names its next step and carries the
// Star Map button that takes it, and finished work folds away per planet —
// except a contract, which is an offer and stays in the list.
import type { Save, SaveStore } from '@/core/Save';
import type { BestTimes } from '@/core/Settings';
import { CONTRACTS, MISSIONS, PLANET_IDS, PLANETS, type ContractId, type MissionDef, type MissionId, type PlanetId } from '@/data/index';
import type { Economy } from '@/systems/Economy';
import { contractFor } from '@/systems/Missions';
import type { EventSink } from '@/systems/Progression';
import {
  abandonMission,
  acceptedText,
  acceptMission,
  bonusLine,
  bossDropText,
  contractLabel,
  missionStatus,
  needsLine,
  pinMission,
  pinnedMission,
  rewardsText,
  STATUS_LABELS,
  timeText,
  type MissionStatus,
} from '@/systems/UiHelpers';
import { confirmSheet } from '@/ui/ConfirmSheet';
import { el, h, keepFocus, testId, type UiRoot } from '@/ui/dom';

export { pinnedMission } from '@/systems/UiHelpers';

export interface BoardDeps {
  ui: UiRoot;
  save: SaveStore;
  data: Save;
  economy: Economy;
  events: EventSink;
  /** SPEC-043 §4.5: this device's best times (`settings.bestTimes`); absent reads none. */
  bestTimes?: () => Readonly<BestTimes>;
  /** SPEC-044 §4.6: an active row's `Star Map` — the map, with the mission's planet selected. */
  goStarMap?(planet: PlanetId): void;
  /** After an accept, abandon or pin: the station re-renders its rail. */
  onChanged?(): void;
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
  /** SPEC-044 §4.11: the planets whose `Completed` fold is open; survives refreshes. */
  readonly #openFolds = new Set<PlanetId>();

  constructor(container: HTMLElement, deps: BoardDeps) {
    this.#container = container;
    this.#deps = deps;
    this.refresh();
  }

  /** SPEC-044 §4.2: through `keepFocus` — an accept by keyboard keeps its place. */
  refresh(): void {
    keepFocus(this.#container, () => this.#render());
  }

  #render(): void {
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
      // SPEC-044 §4.11: done rows and plain replays go, in that order, into the
      // planet's `Completed` fold; a contract replay is an offer and stays in
      // the list, where the sort puts it — after the locked rows (44-k).
      const rows: HTMLElement[] = [];
      const done: HTMLElement[] = [];
      for (const entry of ordered) {
        const def = MISSIONS[entry.id];
        const row = this.#row(def);
        if (entry.status === 'done' || (entry.status === 'replayable' && this.#contract(def) === null)) done.push(row);
        else rows.push(row);
      }
      groups.push(
        h(
          'section',
          { class: 'board-group' },
          h('p', { class: 'board-planet' }, PLANETS[planet].name),
          ...rows,
          done.length === 0 ? null : this.#fold(planet, done),
        ),
      );
    }
    const board = testId(el('div', 'board'), 'mission-board');
    board.append(...groups);
    this.#container.replaceChildren(board);
  }

  /** SPEC-044 §4.11: `Completed (<n>)`, closed by default; the player's open state persists. */
  #fold(planet: PlanetId, rows: readonly HTMLElement[]): HTMLElement {
    const fold = testId(h('details', { class: 'board-done', open: this.#openFolds.has(planet) }), `board-done-${planet}`);
    fold.append(h('summary', { class: 'board-done-summary' }, `Completed (${rows.length})`), ...rows);
    fold.addEventListener('toggle', () => {
      if (fold.open) this.#openFolds.add(planet);
      else this.#openFolds.delete(planet);
    });
    return fold;
  }

  /**
   * SPEC-043 §4.3: what the next landing would run this replay as — the board
   * reads `visits + 1`, the landing the surface will count on entry.
   */
  #contract(def: MissionDef): ContractId | null {
    return contractFor(this.#deps.data, def, this.#nextLanding(def));
  }

  #row(def: MissionDef): HTMLElement {
    const { data } = this.#deps;
    const status = missionStatus(data, def, 'station');
    const row = testId(el('article', `board-row is-${status}`), `mission-${def.id}`);
    const contract = status === 'replayable' ? this.#contract(def) : null;
    const best = this.#deps.bestTimes?.()[def.id as MissionId];

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
      // SPEC-044 §4.11: the type in words — `Main` or `Side`.
      h('span', { class: `badge badge-${def.type}` }, def.type === 'main' ? 'Main' : 'Side'),
      // AC-36: flight missions say where they happen.
      def.scene === 'flight' ? h('span', { class: 'badge badge-flight' }, `Flight · during the trip to ${PLANETS[def.planet].name}`) : null,
      // SPEC-043 §4.3: the contract's name, its blurb on hover.
      contract === null
        ? null
        : testId(
            h('span', { class: 'badge badge-contract', title: CONTRACTS[contract].blurb }, CONTRACTS[contract].name),
            `mission-${def.id}-contract`,
          ),
      pinnedMission(data, def.planet) === def.id ? h('span', { class: 'badge badge-pin' }, 'Tracked') : null,
      // SPEC-043 §4.5: this device's record, beside the status.
      best === undefined ? null : testId(h('span', { class: 'board-best' }, `Best ${timeText(best)}`), `mission-${def.id}-best`),
      // SPEC-044 §4.11: words, never the status id. A contract row is done
      // work offered again on SPEC-043's own terms, which its button states.
      h('span', { class: 'board-status' }, contract === null ? STATUS_LABELS[status] : STATUS_LABELS.done),
    );
    row.append(head);

    // AC-31: rewards, always visible; halved and marked on a replay row, and
    // a contract's own payout on a contract (SPEC-043 §4.3).
    const rewards = rewardsText(def.rewards, status === 'replayable', contract !== null);
    row.append(h('p', { class: 'board-rewards' }, rewards === '' ? '—' : rewards));
    // SPEC-043 §4.2: the bonus — what it asks and what it pays — on every row that has one.
    if (def.bonus !== undefined) {
      row.append(testId(h('p', { class: 'board-bonus' }, bonusLine(def.bonus)), `mission-${def.id}-bonus`));
    }
    // SPEC-039 §4.6: a boss mission says what its boss drops — the piece on a
    // first kill the save does not own, else the lithium in its place.
    const drop = bossDropText(data, def);
    if (drop !== null) row.append(testId(h('p', { class: 'board-drop' }, drop), `mission-${def.id}-drop`));

    if (this.#briefOpen(def, status)) {
      row.append(h('p', { class: 'board-brief' }, def.brief));
    }

    if (status === 'locked') {
      // AC-35: say what is missing, in the data's own order — SPEC-044 §4.11:
      // in one grammar, `Needs: Complete 'Black Gold' · Level 3`.
      const missing = this.#deps.economy.missingRequirements(def.requires);
      row.append(h('p', { class: 'board-locked' }, needsLine(missing)));
      return row;
    }

    if (status === 'active') {
      // SPEC-044 §4.6: the next step, named — and a flight mission says where it runs.
      const where = PLANETS[def.planet].name;
      const next = `Next: Star Map → depart for ${where}${def.scene === 'flight' ? '; the mission runs during the flight' : ''}`;
      row.append(testId(h('p', { class: 'board-next' }, next), 'board-next'));
    }

    const actions = el('div', 'board-actions');
    if (status === 'available') {
      actions.append(
        testId(h('button', { class: 'ui-btn is-primary', type: 'button', click: () => this.#accept(def, false) }, 'Accept'), `mission-${def.id}-accept`),
      );
    } else if (status === 'active') {
      // SPEC-035 §4.12: `Abandon` sits at the far end of the row, away from
      // where `Accept` was, so the two are never the same tap target.
      // SPEC-044 §4.6: the step itself comes first — the star map, with this
      // mission's planet selected.
      actions.append(
        testId(
          h('button', { class: 'ui-btn is-primary', type: 'button', click: () => this.#deps.goStarMap?.(def.planet) }, 'Star Map'),
          `mission-${def.id}-go`,
        ),
        this.#pinButton(def),
        testId(
          h('button', { class: 'ui-btn board-abandon', type: 'button', click: () => this.#abandon(def) }, 'Abandon'),
          `mission-${def.id}-abandon`,
        ),
      );
    } else if (status === 'replayable') {
      // AC-34: the replay pays half, and says so on the button. SPEC-043 §4.3:
      // a contract's button carries its label instead. SPEC-044 §4.11: the
      // badge reads `50 % rewards`, the status line's own number.
      const label = contract === null ? null : contractLabel(data, def, this.#nextLanding(def));
      actions.append(
        testId(
          label === null
            ? h(
                'button',
                { class: 'ui-btn', type: 'button', click: () => this.#accept(def, true) },
                'Replay ',
                h('span', { class: 'badge badge-replay' }, '50 % rewards'),
              )
            : h('button', { class: 'ui-btn board-contract', type: 'button', click: () => this.#accept(def, true, contract) }, label),
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
            this.#deps.onChanged?.();
          },
        },
        'Pin',
      ),
      `mission-${def.id}-pin`,
    );
  }

  /** SPEC-043 §4.3: the landing a departure now would make on `def`'s planet. */
  #nextLanding(def: MissionDef): number {
    return (this.#deps.data.progress.visits[def.planet] ?? 0) + 1;
  }

  #accept(def: MissionDef, replay: boolean, contract: ContractId | null = null): void {
    if (!acceptMission(this.#deps.data, def)) return;
    this.#deps.events.emit('mission:accepted', { id: def.id as MissionId });
    this.#deps.save.request('mission');
    this.#deps.ui.toast(acceptedText(def.title, replay, contract === null ? null : CONTRACTS[contract].name), 'good');
    this.refresh();
    this.#deps.onChanged?.();
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
      this.#deps.onChanged?.();
    });
  }
}
