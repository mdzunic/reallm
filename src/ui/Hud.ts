// The in-scene HUD (SPEC-014 §4.5). Systems write plain fields into `model`;
// `flush()` — driven once per frame from `UiRoot.flush()` — diffs against the
// last rendered copy and touches only the DOM behind the keys that moved
// (AC-61/62). Bars move with `transform: scaleX()`, numbers with `textContent`,
// and an unchanged model writes nothing at all.
//
// Colorblind-safe pairs (AC-68): the HP bar is red *and* carries ♥, shield is
// blue *and* ⛨, the warn banner is amber *and* ▲ — never hue alone.
import {
  cloneHud,
  createHudModel,
  diffHud,
  type HudKey,
  type HudModel,
} from '@/systems/UiHelpers';
import { ITEMS, RESOURCE_IDS, type ResourceId } from '@/data/index';
import { el, testId, type UiRoot } from '@/ui/dom';

export type HudMode = 'surface' | 'flight';

/** AC-63: how long the damage vignette stays up. */
export const DAMAGE_FLASH_MS = 150;
/** AC-64: the low-HP pulse threshold. */
export const LOW_HP_FRACTION = 0.25;

const RESOURCE_GLYPHS: Record<ResourceId, string> = { oil: '🛢', wheat: '🌾', water: '💧', lithium: '⚡' };

function bar(kind: string, glyph: string, label: string): { root: HTMLDivElement; fill: HTMLDivElement; text: HTMLSpanElement } {
  const fill = el('div', `bar-fill bar-${kind}`);
  const text = el('span', 'bar-text');
  const root = el('div', 'bar-row');
  root.setAttribute('aria-label', label);
  const track = el('div', 'bar');
  track.append(fill);
  root.append(el('span', 'glyph', glyph), track, text);
  return { root, fill, text };
}

export class Hud {
  readonly model: HudModel;
  readonly #mode: HudMode;
  readonly #ui: UiRoot;
  readonly #root: HTMLDivElement;
  #last: HudModel;
  #unregister: () => void;
  #flashTimer: ReturnType<typeof setTimeout> | null = null;

  // Cached nodes, written only when their key diffs.
  readonly #hp = bar('hp', '♥', 'Hull points');
  readonly #xp = bar('xp', '', 'Experience');
  readonly #shield = bar('shield', '⛨', 'Shield');
  readonly #hull = bar('hull', '♥', 'Hull');
  readonly #level = el('span', 'hud-level');
  readonly #tokens = el('span', 'hud-tokens');
  readonly #resources = {} as Record<ResourceId, HTMLSpanElement>;
  readonly #resourceRows = {} as Record<ResourceId, HTMLSpanElement>;
  readonly #weather = el('div', 'hud-weather');
  readonly #boss = bar('boss', '', 'Boss');
  readonly #consumable = el('div', 'hud-consumable panel');
  readonly #interact = el('div', 'hud-interact');
  readonly #objective = el('div', 'hud-objective');
  readonly #vignette = el('div', 'hud-vignette');

  constructor(root: UiRoot, mode: HudMode) {
    this.#ui = root;
    this.#mode = mode;
    this.model = createHudModel();
    if (mode === 'flight') {
      this.model.flight = {
        shield: [0, 1],
        hull: [0, 1],
        throttle: 0,
        progress: 0,
        hostiles: 0,
        storm: false,
        holding: false,
      };
    }
    this.#last = cloneHud(this.model);

    this.#root = testId(el('div', `hud hud-${mode}`), 'hud');
    const tl = el('div', 'hud-tl');
    tl.append(this.#hp.root, this.#xp.root, this.#level);
    if (mode === 'flight') tl.append(this.#shield.root, this.#hull.root);

    const tr = el('div', 'hud-tr');
    for (const resource of RESOURCE_IDS) {
      const row = el('span', 'res');
      const count = testId(el('span', 'res-count'), `res-${resource}`);
      row.append(el('span', 'glyph', RESOURCE_GLYPHS[resource]), count);
      this.#resources[resource] = count;
      this.#resourceRows[resource] = row;
      tr.append(row);
    }
    const tokens = el('span', 'res res-tokens');
    tokens.append(el('span', 'glyph', '◈'), this.#tokens);
    tr.append(tokens);

    const tc = el('div', 'hud-tc');
    tc.append(this.#weather, this.#boss.root);
    this.#boss.root.classList.add('is-hidden');

    const bl = el('div', 'hud-bl');
    bl.append(this.#consumable);
    this.#consumable.classList.add('is-hidden');

    const br = el('div', 'hud-br');
    // AC-59: the minimap sits above the touch buttons, surface mode only.
    // SPEC-012 draws into it; the box and its slot in the layout are the HUD's.
    if (mode === 'surface') {
      const minimap = testId(el('canvas', 'minimap'), 'minimap');
      minimap.width = 96;
      minimap.height = 96;
      br.append(minimap);
    }
    br.append(this.#interact);
    this.#interact.classList.add('is-hidden');

    const bc = el('div', 'hud-bc');
    bc.append(this.#objective);
    this.#objective.classList.add('is-hidden');

    this.#root.append(this.#vignette, tl, tr, tc, bl, br, bc);
    root.mount(this.#root, 'hud');
    this.#unregister = root.register(this);
    this.#renderAll();
  }

  /** AC-63: the red edge vignette, 150 ms; a static frame under reduce-motion. */
  damageFlash(): void {
    this.#vignette.classList.add('is-flashing');
    if (this.#flashTimer !== null) clearTimeout(this.#flashTimer);
    this.#flashTimer = setTimeout(() => this.#vignette.classList.remove('is-flashing'), DAMAGE_FLASH_MS);
  }

  /** Diff against the last rendered model; write only what changed (AC-61). */
  flush(): void {
    const changed = diffHud(this.#last, this.model);
    if (changed.size === 0) return;
    for (const key of changed) this.#write(key);
    this.#last = cloneHud(this.model);
  }

  dispose(): void {
    if (this.#flashTimer !== null) clearTimeout(this.#flashTimer);
    this.#unregister();
    this.#ui.unmount(this.#root);
  }

  #renderAll(): void {
    const keys = Object.keys(this.model) as HudKey[];
    for (const key of keys) this.#write(key);
    this.#last = cloneHud(this.model);
  }

  #write(key: HudKey): void {
    const m = this.model;
    switch (key) {
      case 'hp': {
        this.#setBar(this.#hp, m.hp);
        // AC-64: the pulse is a class on the root, so CSS owns the animation
        // and its reduce-motion static form.
        this.#root.classList.toggle('is-low-hp', m.hp[0] / Math.max(1, m.hp[1]) < LOW_HP_FRACTION);
        return;
      }
      case 'xp':
        this.#setBar(this.#xp, m.xp, false);
        return;
      case 'level':
        this.#level.textContent = `Lv ${m.level}`;
        return;
      case 'tokens':
        this.#tokens.textContent = String(m.tokens);
        return;
      case 'resources':
      case 'cargoCap': {
        let anyAtCap = false;
        for (const resource of RESOURCE_IDS) {
          const value = m.resources[resource];
          const atCap = value >= m.cargoCap;
          anyAtCap = anyAtCap || atCap;
          const node = this.#resources[resource];
          const text = String(value);
          if (node.textContent !== text) node.textContent = text; // AC-61
          this.#resourceRows[resource].classList.toggle('at-cap', atCap);
        }
        // AC-65: the cargo-full pulse, static under reduce-motion (CSS).
        this.#root.classList.toggle('is-cargo-full', anyAtCap);
        return;
      }
      case 'objective': {
        this.#objective.classList.toggle('is-hidden', m.objective === null);
        if (m.objective !== null) {
          const { title, line, value, target } = m.objective;
          this.#objective.textContent = target > 1 ? `${title} — ${line} (${value}/${target})` : `${title} — ${line}`;
        }
        return;
      }
      case 'weather': {
        const { warning, active, secondsLeft } = m.weather;
        const text =
          active !== null
            ? `▲ ${label(active)} — ${Math.ceil(secondsLeft)}s`
            : warning !== null
              ? `▲ ${label(warning)} in ${Math.ceil(secondsLeft)}s`
              : '';
        this.#weather.textContent = text;
        this.#weather.classList.toggle('is-hidden', text === '');
        return;
      }
      case 'boss': {
        this.#boss.root.classList.toggle('is-hidden', m.boss === null);
        if (m.boss !== null) {
          this.#setBar(this.#boss, [m.boss.hp, m.boss.max]);
          this.#boss.text.textContent = m.boss.name;
        }
        return;
      }
      case 'consumable': {
        this.#consumable.classList.toggle('is-hidden', m.consumable === null);
        if (m.consumable !== null) {
          this.#consumable.textContent = `${ITEMS[m.consumable.itemId].name} ×${m.consumable.qty}`;
        }
        return;
      }
      case 'interact':
        this.#interact.classList.toggle('is-hidden', m.interact === null);
        if (m.interact !== null) this.#interact.textContent = m.interact;
        return;
      case 'flight': {
        if (m.flight === undefined || this.#mode !== 'flight') return;
        this.#setBar(this.#shield, m.flight.shield);
        this.#setBar(this.#hull, m.flight.hull);
        return;
      }
    }
  }

  /** Bars scale, never re-layout (AC-61); the text is `value/max` when shown. */
  #setBar(target: { fill: HTMLDivElement; text: HTMLSpanElement }, pair: [number, number], withText = true): void {
    const fraction = Math.max(0, Math.min(1, pair[0] / Math.max(1, pair[1])));
    target.fill.style.transform = `scaleX(${fraction})`;
    if (withText) {
      const text = `${Math.round(pair[0])}/${Math.round(pair[1])}`;
      if (target.text.textContent !== text) target.text.textContent = text;
    }
  }
}

/** `spore_storm` → `Spore storm` — the six weather ids are readable as-is. */
function label(id: string): string {
  const text = id.replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}
