// The in-scene HUD (SPEC-014 §4.5). Systems write plain fields into `model`;
// `flush()` — driven once per frame from `UiRoot.flush()` — diffs against the
// last rendered copy and touches only the DOM behind the keys that moved
// (AC-61/62). Bars move with `transform: scaleX()`, numbers with `textContent`,
// and an unchanged model writes nothing at all.
//
// Colorblind-safe pairs (AC-68): the HP bar is red *and* carries ♥, shield is
// blue *and* ⛨, the warn banner is amber *and* ▲ — never hue alone.
//
// SPEC-037 lays the whole thing out once for both schemes: a top-left column
// on the HUD plate, a top-centre stack headed by the wallet strip, the minimap
// in the top-right cluster on touch and the bottom-right corner on keyboard,
// and the quick bar in the bottom centre on keyboard or in the thumb arc on
// touch — the same bar, moved, so no slot loses its state (37-a).
import type { Scheme } from '@/core/Input';
import type { JoystickSide } from '@/core/Settings';
import {
  copyHudInto,
  createHudModel,
  diffHudInto,
  flashGate,
  type DamageFlashMode,
  type HudKey,
  type HudModel,
} from '@/systems/UiHelpers';
import { RESOURCE_IDS, type ResourceId } from '@/data/index';
import { el, testId, type UiRoot } from '@/ui/dom';
import { RESOURCE_GLYPHS, TOKEN_GLYPH } from '@/ui/glyphs';
import { QuickBar, type QuickBarHandlers } from '@/ui/QuickBar';
import { Tracker } from '@/ui/Tracker';

export type HudMode = 'surface' | 'flight';

/** AC-63: how long the damage vignette stays up. */
export const DAMAGE_FLASH_MS = 150;
/** AC-64: the low-HP pulse threshold. */
export const LOW_HP_FRACTION = 0.25;
/** SPEC-035 §4.6: how long a hit-direction wedge stays up. */
export const HIT_DIR_MS = 1000;
/** §4.6: at most three at once — a fourth replaces the oldest (35-d). */
export const HIT_DIR_MAX = 3;
/** SPEC-013 §4.1: the two things a holding pattern can be waiting on. */
const HOLD_HOSTILES = 'Holding pattern — clear the hostiles';
const HOLD_OBJECTIVE = 'Holding pattern — the objective is not done';

/** SPEC-037 §4.1: the thumb arc's three cells, as `hud.arc` exposes them. */
export interface ThumbArc {
  /** The corner cell — SPEC-038's DASH; it takes no pointer events while it is empty. */
  readonly primary: HTMLElement;
  /** Where the touch layer mounts USE (`TouchControls.mountButton`). */
  readonly action: HTMLElement;
  /** Where the quick bar lays out on the touch scheme. */
  readonly slots: HTMLElement;
}

/** SPEC-037 §4.2: a key's cap, drawn on the keyboard scheme only; screen readers skip it. */
export function keycap(key: string): HTMLElement {
  const cap = el('kbd', 'keycap', key);
  cap.setAttribute('aria-hidden', 'true');
  return cap;
}

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
  /**
   * The last rendered model, built once and then copied into in place
   * (SPEC-040 §4.4) — never a fresh deep clone on a frame that changed.
   */
  readonly #last: HudModel;
  /** SPEC-040 §4.4: the one scratch set every `flush()` diffs into. */
  readonly #changed = new Set<HudKey>();
  #unregister: () => void;
  #flashTimer: ReturnType<typeof setTimeout> | null = null;
  /** SPEC-037 §4.6: `performance.now()` seconds of the flash's last rising edge. */
  #lastEdgeAt = -Infinity;
  #flashMode: DamageFlashMode = 'full';

  // Cached nodes, written only when their key diffs.
  readonly #hp = bar('hp', '♥', 'Hull points');
  readonly #xp = bar('xp', '', 'Experience');
  readonly #shield = bar('shield', '⛨', 'Shield');
  /** SPEC-035 §4.9: the ship's hull has its own glyph — two hearts read as one bar. */
  readonly #hull = bar('hull', '⛭', 'Hull');
  readonly #level = el('span', 'hud-level');
  readonly #tokens = el('span', 'hud-tokens');
  readonly #resources = {} as Record<ResourceId, HTMLSpanElement>;
  readonly #resourceRows = {} as Record<ResourceId, HTMLSpanElement>;
  /** SPEC-037 §4.2: the wallet strip heading the top centre; `null` in flight mode. */
  #wallet: HTMLDivElement | null = null;
  readonly #weather = testId(el('div', 'hud-weather'), 'hud-weather');
  /** SPEC-030 D-11: always in the DOM, hidden while `shelter === 'none'`. */
  readonly #shelter = testId(el('div', 'hud-shelter is-hidden'), 'sheltered');
  readonly #boss = bar('boss', '', 'Boss');
  /** SPEC-037 §4.3: on the HUD root, on the plate; the keyboard's E prompt, or a touch shortfall. */
  readonly #interact = testId(el('div', 'hud-interact'), 'hud-interact');
  readonly #objective = el('div', 'hud-objective');
  /** SPEC-027 §4.2: the surface's objective tracker; `null` in flight mode. */
  #tracker: Tracker | null = null;
  /** SPEC-028 §4.5: the quick bar in the bottom centre; surface mode only. */
  #quickBar: QuickBar | null = null;
  /** SPEC-037 §4.1: the thumb arc and its cells; `null` in flight mode. */
  readonly arc: ThumbArc | null = null;
  /** The two homes the scheme moves things between (SPEC-037 §4.1, §4.2). */
  readonly #tr: HTMLDivElement;
  readonly #br: HTMLDivElement;
  readonly #bc: HTMLDivElement;
  /** SPEC-037 §4.2: keeps `--hud-tc-h` on `#ui` for the short-screen dialogue dock. */
  #tcObserver: ResizeObserver | null = null;
  /** The scheme the key hints and the touch sizing follow (SPEC-028 §4.5). */
  #scheme: Scheme = 'keyboard';
  readonly #vignette = el('div', 'hud-vignette');
  /** SPEC-035 §4.6: the layer the red edge wedges live in, and the live ones. */
  readonly #hitDirLayer = el('div', 'hud-hit-dirs');
  readonly #hitDirs: { node: HTMLDivElement; timer: ReturnType<typeof setTimeout> }[] = [];
  /** SPEC-034 §4.11: the awakening burst, shown by `.hud.is-static`. */
  readonly #static = el('div', 'hud-static');
  /** SPEC-034 §4.11: the flight ion-storm scanline sheet — its own class now. */
  readonly #ion = el('div', 'hud-ion');
  #minimap: HTMLCanvasElement | null = null;
  #staticTimer: ReturnType<typeof setTimeout> | null = null;

  // Flight instruments (SPEC-013 §4.10); built only in flight mode.
  readonly #reticle = testId(el('div', 'hud-reticle'), 'reticle');
  readonly #throttle = testId(el('span', 'hud-throttle'), 'hud-throttle');
  readonly #progress = testId(el('div', 'hud-progress'), 'hud-progress');
  readonly #progressFill = el('div', 'hud-progress-fill');
  readonly #markers = el('div', 'hud-progress-markers');
  readonly #hostiles = testId(el('div', 'hud-hostiles'), 'hud-hostiles');
  /** SPEC-034 §4.11: the warning *pill*, not the surface's storm vignette. */
  readonly #storm = testId(el('div', 'hud-storm-warn'), 'storm-warning');
  readonly #holding = testId(el('div', 'hud-holding'), 'holding-banner');

  /**
   * `onCycleMission` is SPEC-027 AC-22: a tap on the tracker cycles the tracked
   * mission, the same thing `KeyT` does. Only surface mode builds a tracker, so
   * flight never passes one.
   */
  constructor(root: UiRoot, mode: HudMode, onCycleMission?: () => void, quickHandlers?: QuickBarHandlers) {
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
    this.#last = copyHudInto(createHudModel(), this.model);

    this.#root = testId(el('div', `hud hud-${mode}`), 'hud');
    this.#root.dataset['side'] = 'left';
    this.#root.dataset['flash'] = 'full';
    const tl = el('div', 'hud-tl');
    // `hud-hp` is the scene's one HP readout (AC-58); the SPEC-011 e2e reads it.
    tl.append(testId(this.#hp.root, 'hud-hp'), this.#xp.root, this.#level);
    if (mode === 'flight') {
      // SPEC-035 §4.9: in flight the salvager's own HP is not what is at stake —
      // the hull is. The bar stays in the DOM (the SPEC-011 selector resolves)
      // and is hidden, so the two identical hearts are gone.
      this.#hp.root.classList.add('is-hidden');
      tl.append(this.#shield.root, testId(this.#hull.root, 'hud-hull'), this.#throttle);
    }
    // SPEC-027 §4.2: the tracker sits under the level/XP row, in the same corner.
    if (mode === 'surface') this.#tracker = new Tracker(tl, onCycleMission ?? ((): void => undefined));

    // SPEC-037 §4.2: the top-right resource column is gone. On touch in the
    // surface this is the minimap's corner, left of the pause button; on the
    // keyboard scheme, and in flight, it stays empty.
    this.#tr = el('div', 'hud-tr');

    const tc = el('div', 'hud-tc');
    if (mode === 'surface') {
      // SPEC-037 §4.2: the wallet strip heads the top centre — tokens, then the
      // four resources, each a glyph and its count, keeping the `res-<id>` ids.
      const wallet = testId(el('div', 'hud-wallet'), 'hud-wallet');
      wallet.setAttribute('aria-label', 'Wallet');
      const tokens = el('span', 'res res-tokens');
      tokens.append(el('span', 'glyph', TOKEN_GLYPH), this.#tokens);
      wallet.append(tokens);
      for (const resource of RESOURCE_IDS) {
        const row = el('span', 'res');
        const count = testId(el('span', 'res-count'), `res-${resource}`);
        row.append(el('span', 'glyph', RESOURCE_GLYPHS[resource]), count);
        this.#resources[resource] = count;
        this.#resourceRows[resource] = row;
        wallet.append(row);
      }
      this.#wallet = wallet;
      tc.append(wallet);
    }
    // SPEC-030 D-11: the shelter chip sits directly under the weather banner.
    // SPEC-037 §4.2: the boss bar is an in-flow row after both, which is what
    // lets `--hud-tc-h` count it (37-c).
    this.#boss.root.classList.add('hud-boss-bar');
    tc.append(this.#weather, this.#shelter, testId(this.#boss.root, 'hud-boss'));
    this.#boss.root.classList.add('is-hidden');
    // SPEC-013 §4.10: trip progress with wave markers, the hostiles counter,
    // the storm warning + static, the holding banner, and the reticle.
    if (mode === 'flight') {
      this.#progress.append(this.#progressFill, this.#markers);
      this.#progress.setAttribute('aria-label', 'Trip progress');
      this.#storm.textContent = '▲ Ion storm';
      this.#holding.textContent = HOLD_HOSTILES;
      this.#hostiles.classList.add('is-hidden');
      this.#storm.classList.add('is-hidden');
      this.#ion.classList.add('is-hidden');
      this.#holding.classList.add('is-hidden');
      tc.append(this.#progress, this.#hostiles, this.#storm, this.#holding);
    }

    // SPEC-028 AC: the old bottom-left consumable box is gone; the quick bar
    // in the bottom centre carries the counts now.
    const bl = el('div', 'hud-bl');

    // SPEC-037 §4.2: the keyboard corner — the minimap sits here at the
    // bottom right on the keyboard scheme, with its `M` on the rim.
    this.#br = el('div', 'hud-br');
    // AC-59: surface mode only. SPEC-012 draws into it; the box and its slot in
    // the layout are the HUD's.
    if (mode === 'surface') {
      const minimap = testId(el('canvas', 'minimap'), 'minimap');
      minimap.width = 96;
      minimap.height = 96;
      this.#br.append(minimap, keycap('M'));
      this.#minimap = minimap;
    }
    this.#interact.classList.add('is-hidden');

    // SPEC-027 AC-17 / D-4: on the surface the tracker's focus row *is* the
    // objective line, so this corner builds no second `.hud-objective` — the
    // strict e2e selectors still resolve to exactly one node. Flight keeps its
    // line where SPEC-013 §4.8 put it.
    this.#bc = el('div', 'hud-bc');
    if (mode === 'flight') {
      this.#bc.append(this.#objective);
      this.#objective.classList.add('is-hidden');
    }
    // SPEC-028 §4.5: the quick bar takes the bottom centre SPEC-027 freed.
    if (mode === 'surface') {
      this.#quickBar = new QuickBar(this.#bc, quickHandlers ?? { slot: () => undefined, pick: () => undefined });
    }

    this.#root.append(this.#vignette, this.#static, this.#hitDirLayer, tl, this.#tr, tc, bl, this.#br, this.#bc, this.#interact);
    if (mode === 'surface') {
      // SPEC-037 §4.1: the thumb arc — built always, shown on the touch scheme
      // only. `arc-primary` is SPEC-038's DASH cell; the touch layer mounts it.
      const primary = testId(el('div', 'arc-primary'), 'arc-primary');
      const action = testId(el('div', 'arc-action'), 'arc-action');
      const slots = testId(el('div', 'arc-slots'), 'arc-slots');
      const thumbArc = testId(el('div', 'thumb-arc'), 'thumb-arc');
      thumbArc.append(slots, action, primary);
      this.#root.append(thumbArc);
      this.arc = { primary, action, slots };
    }
    if (mode === 'flight') this.#root.append(this.#ion, this.#reticle);
    root.mount(this.#root, 'hud');
    this.#unregister = root.register(this);
    // SPEC-037 §4.2: the top centre's height, for the dialogue and the tip strip
    // that dock under it on a short screen. A ResizeObserver callback is an
    // event, not the loop (SPEC-001 §7), so this is no DOM read in `update()`.
    if (typeof ResizeObserver === 'function') {
      const host = root.root;
      this.#tcObserver = new ResizeObserver((entries) => {
        const entry = entries[entries.length - 1];
        if (entry === undefined) return;
        const height = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
        host.style.setProperty('--hud-tc-h', `${Math.round(height)}px`);
      });
      this.#tcObserver.observe(tc);
    }
    this.#renderAll();
  }

  /** The box SPEC-012 draws its minimap into; `null` in flight mode. */
  get minimapCanvas(): HTMLCanvasElement | null {
    return this.#minimap;
  }

  /** SPEC-012 §4.12: the glitch dialogue static burst; CSS owns the look. */
  staticBurst(ms: number): void {
    this.#root.classList.add('is-static');
    if (this.#staticTimer !== null) clearTimeout(this.#staticTimer);
    this.#staticTimer = setTimeout(() => this.#root.classList.remove('is-static'), ms);
  }

  /**
   * The wave markers on the trip bar (SPEC-013 §4.10): one tick per scheduled
   * group, at its trip fraction. Set once on enter — the schedule never moves.
   */
  setWaveMarkers(fractions: readonly number[]): void {
    this.#markers.replaceChildren(
      ...fractions.map((fraction) => {
        const tick = el('span', 'hud-progress-marker');
        tick.style.left = `${Math.round(fraction * 100)}%`;
        return tick;
      }),
    );
  }

  /**
   * The reticle, in NDC (y up). Written directly rather than through the diff —
   * it moves every frame the pointer does, and a transform write is the cheap
   * path the bars already use.
   */
  setReticle(ndcX: number, ndcY: number): void {
    this.#reticle.style.left = `${(ndcX * 0.5 + 0.5) * 100}%`;
    this.#reticle.style.top = `${(-ndcY * 0.5 + 0.5) * 100}%`;
  }

  /**
   * AC-63: the red edge vignette, 150 ms; a static frame under reduce-motion.
   * SPEC-037 §4.6: gated so it never strobes (E71) — a hit inside
   * `FLASH_MIN_GAP` of the last rising edge keeps a lit flash on for another
   * 150 ms rather than restarting it, and adds no edge to one that has already
   * gone out. A no-op under `'off'`.
   */
  damageFlash(): void {
    if (this.#flashMode === 'off') return;
    const now = performance.now() / 1000;
    const lit = this.#vignette.classList.contains('is-flashing');
    if (flashGate(this.#lastEdgeAt, now) === 'edge') {
      this.#lastEdgeAt = now;
      if (!lit) this.#vignette.classList.add('is-flashing');
    } else if (!lit) {
      return;
    }
    if (this.#flashTimer !== null) clearTimeout(this.#flashTimer);
    this.#flashTimer = setTimeout(() => {
      this.#flashTimer = null;
      this.#vignette.classList.remove('is-flashing');
    }, DAMAGE_FLASH_MS);
  }

  /** SPEC-037 §4.6: `data-flash` on the root; CSS owns the peak, and `'off'` never flashes. */
  setDamageFlash(mode: DamageFlashMode): void {
    this.#flashMode = mode;
    this.#root.dataset['flash'] = mode;
    if (mode !== 'off') return;
    if (this.#flashTimer !== null) clearTimeout(this.#flashTimer);
    this.#flashTimer = null;
    this.#vignette.classList.remove('is-flashing');
  }

  /** SPEC-037 §4.1: `data-side` on the root mirrors the thumb arc at once (37-b). */
  setSide(side: JoystickSide): void {
    this.#root.dataset['side'] = side;
  }

  /**
   * SPEC-035 §4.6 — a red wedge at the screen edge, pointing at where the hit
   * came from. `angle` is clockwise from screen-up, which is what the scene's
   * map transform produces; the wedge fades over `HIT_DIR_MS` and a fourth
   * replaces the oldest (35-d). Under reduce motion it does not pulse (35-j).
   */
  showHitDirection(angle: number, reduceMotion = false): void {
    while (this.#hitDirs.length >= HIT_DIR_MAX) this.#dropHitDirection(0);
    const node = testId(el('div', 'hud-hit-dir'), 'hud-hit-dir');
    if (reduceMotion) node.classList.add('is-static');
    node.style.transform = `rotate(${((angle * 180) / Math.PI).toFixed(1)}deg)`;
    this.#hitDirLayer.append(node);
    const entry = { node, timer: setTimeout(() => this.#dropHitDirection(this.#hitDirs.indexOf(entry)), HIT_DIR_MS) };
    this.#hitDirs.push(entry);
  }

  /** How many wedges are up — the count §4.6 caps at three. */
  get hitDirections(): number {
    return this.#hitDirs.length;
  }

  #dropHitDirection(index: number): void {
    if (index < 0) return;
    const [entry] = this.#hitDirs.splice(index, 1);
    if (entry === undefined) return;
    clearTimeout(entry.timer);
    entry.node.remove();
  }

  /**
   * Diff against the last rendered model; write only what changed (AC-61).
   * SPEC-040 §4.4: through one scratch set and an in-place copy, so a fight's
   * every frame allocates only when a nested value changes shape.
   */
  flush(): void {
    const changed = diffHudInto(this.#last, this.model, this.#changed);
    if (changed.size === 0) return;
    for (const key of changed) this.#write(key);
    copyHudInto(this.#last, this.model);
  }

  /**
   * SPEC-028 §4.5: the scene forwards `input:schemeChanged` here — the touch
   * sizing is a root class CSS reads, and the key hints re-render.
   */
  setScheme(scheme: Scheme): void {
    if (scheme === this.#scheme) return;
    this.#scheme = scheme;
    const touch = scheme === 'touch';
    this.#root.classList.toggle('is-touch', touch);
    // SPEC-037 §4.1, §4.2 (37-a): the bar moves between the bottom centre and
    // the arc, and the minimap between the keyboard corner and the top-right
    // cluster. Both are moved, not rebuilt, so every slot keeps its state; the
    // scene re-measures the minimap after the move.
    if (this.arc !== null) this.#quickBar?.moveTo(touch ? this.arc.slots : this.#bc, touch);
    if (this.#minimap !== null) {
      if (touch) this.#tr.append(this.#minimap);
      else this.#br.prepend(this.#minimap);
    }
    this.#quickBar?.render(this.model.loadout, this.model.quick, scheme);
  }

  dispose(): void {
    this.#tcObserver?.disconnect();
    this.#tcObserver = null;
    this.#ui.root.style.removeProperty('--hud-tc-h');
    if (this.#flashTimer !== null) clearTimeout(this.#flashTimer);
    if (this.#staticTimer !== null) clearTimeout(this.#staticTimer);
    while (this.#hitDirs.length > 0) this.#dropHitDirection(0);
    this.#tracker?.dispose();
    this.#tracker = null;
    this.#quickBar?.dispose();
    this.#quickBar = null;
    this.#unregister();
    this.#ui.unmount(this.#root);
  }

  #renderAll(): void {
    const keys = Object.keys(this.model) as HudKey[];
    for (const key of keys) this.#write(key);
    copyHudInto(this.#last, this.model);
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
        if (this.#wallet !== null) this.#tokens.textContent = String(m.tokens);
        return;
      case 'resources':
      case 'cargoCap': {
        // SPEC-037 §4.2: the flight builds no wallet, so there is nothing to count.
        if (this.#wallet === null) return;
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
      case 'walletLit':
        // SPEC-037 §4.2: full opacity while lit, 0.6 otherwise (CSS).
        this.#wallet?.classList.toggle('is-lit', m.walletLit);
        return;
      case 'tracker': {
        // SPEC-027 §4.2: the whole panel, from the model the scene wrote.
        if (m.tracker !== null) this.#tracker?.set(m.tracker);
        return;
      }
      case 'objective': {
        if (this.#mode !== 'flight') return; // SPEC-027 AC-17: no line here
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
      case 'shelter': {
        // SPEC-030 D-11: `⌂` is decorative; tests assert the word.
        this.#shelter.textContent = m.shelter === 'hidden' ? '⌂ HIDDEN' : '⌂ SHELTERED';
        this.#shelter.classList.toggle('is-hidden', m.shelter === 'none');
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
      case 'loadout':
      case 'quick': {
        // SPEC-028 §4.5: one renderer for both halves of the bar; it touches
        // only elements whose text, class or custom property changed.
        this.#quickBar?.render(m.loadout, m.quick, this.#scheme);
        return;
      }
      case 'dash': {
        // SPEC-038 §4.1: one ring, drawn on both controls — the keyboard's
        // `qb-dash` and the arc's corner cell, whose DASH button inherits it.
        this.#quickBar?.setDash(m.dash);
        const primary = this.arc?.primary;
        if (primary !== undefined) {
          primary.style.setProperty('--cd', Math.max(0, Math.min(1, m.dash)).toFixed(3));
          primary.classList.toggle('is-cooling', m.dash > 0);
        }
        return;
      }
      case 'interact':
      case 'interactAction': {
        // SPEC-037 §4.3: an actionable prompt leads with its `E` keycap on the
        // keyboard; on touch CSS hides it, because USE in the arc says it. A
        // shortfall (`Need 20 more oil`) is words only, on both schemes.
        this.#interact.classList.toggle('is-hidden', m.interact === null);
        this.#interact.classList.toggle('is-action', m.interactAction);
        if (m.interact === null) return;
        if (m.interactAction) this.#interact.replaceChildren(keycap('E'), ` ${m.interact}`);
        else this.#interact.textContent = m.interact;
        return;
      }
      case 'flight': {
        if (m.flight === undefined || this.#mode !== 'flight') return;
        this.#setBar(this.#shield, m.flight.shield);
        this.#setBar(this.#hull, m.flight.hull);
        const throttle = `THR ${m.flight.throttle.toFixed(1)}×`;
        if (this.#throttle.textContent !== throttle) this.#throttle.textContent = throttle;
        this.#progressFill.style.transform = `scaleX(${Math.max(0, Math.min(1, m.flight.progress))})`;
        const hostiles = m.flight.hostiles > 0 ? `Hostiles: ${m.flight.hostiles}` : '';
        if (this.#hostiles.textContent !== hostiles) this.#hostiles.textContent = hostiles;
        this.#hostiles.classList.toggle('is-hidden', m.flight.hostiles === 0);
        this.#storm.classList.toggle('is-hidden', !m.flight.storm);
        this.#ion.classList.toggle('is-hidden', !m.flight.storm);
        // SPEC-013 §4.1 (E12, PLAN R16): the hold has two reasons — hostiles on
        // the tail, or a main flight objective still open — and an empty sky
        // must not be captioned "clear the hostiles".
        const hold = m.flight.hostiles > 0 ? HOLD_HOSTILES : HOLD_OBJECTIVE;
        if (this.#holding.textContent !== hold) this.#holding.textContent = hold;
        this.#holding.classList.toggle('is-hidden', !m.flight.holding);
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
