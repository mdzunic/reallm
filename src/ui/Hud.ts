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
//
// SPEC-042 adds the moments the HUD used to let pass in silence: the running
// effects as chips in the `Lv N` row, a static red edge below a quarter of HP
// (or of hull, in flight), the level glow and the XP bar's numbers, the wave
// line, and two frames in the top centre — the boss's own bar, which never
// reads as the player's, and the last enemy the player hit.
import type { Scheme } from '@/core/Input';
import type { JoystickSide } from '@/core/Settings';
import {
  copyHudInto,
  createHudModel,
  diffHudInto,
  flashGate,
  type DamageFlashMode,
  type EffectKind,
  type HudKey,
  type HudModel,
} from '@/systems/UiHelpers';
import { GLYPHS } from '@/data/glossary';
import { RESOURCE_IDS, type ResourceId } from '@/data/index';
import { multiplier, seconds } from '@/systems/Format';
import { el, testId, type UiRoot } from '@/ui/dom';
import { RESOURCE_GLYPHS } from '@/ui/glyphs';
import { EFFECT_GLYPHS } from '@/ui/icons';
import { QuickBar, type QuickBarHandlers } from '@/ui/QuickBar';
import { Tracker } from '@/ui/Tracker';

export type HudMode = 'surface' | 'flight';

/** AC-63: how long the damage vignette stays up. */
export const DAMAGE_FLASH_MS = 150;
/**
 * AC-64: the low-HP pulse threshold. SPEC-042 §4.4: also the red edge's, and
 * in flight the hull's.
 */
export const LOW_HP_FRACTION = 0.25;
/** SPEC-042 §4.7: how long the level label glows after a level-up. */
export const LEVEL_GLOW_MS = 2000;
/** SPEC-042 §4.9: how long `Phase N` stays up after a boss turns. */
export const BOSS_PHASE_MS = 2000;
/** SPEC-042 §4.3: the chips' order in the `Lv N` row, and their screen-reader words. */
const EFFECT_KINDS: readonly EffectKind[] = ['heal', 'damage_boost', 'hazard_immunity'];
const EFFECT_WORDS: Readonly<Record<EffectKind, string>> = {
  heal: 'Healing',
  damage_boost: 'Damage boost',
  hazard_immunity: 'Hazard immunity',
};
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

  // Cached nodes, written only when their key diffs. SPEC-045 §4.6: the
  // salvager's bar is announced as Health; Hull and Shield are the ship's.
  readonly #hp = bar('hp', GLYPHS.health, 'Health');
  readonly #xp = bar('xp', '', 'Experience');
  readonly #shield = bar('shield', GLYPHS.shield, 'Shield');
  /** SPEC-035 §4.9: the ship's hull has its own glyph — two hearts read as one bar. */
  readonly #hull = bar('hull', GLYPHS.hull, 'Hull');
  readonly #level = el('span', 'hud-level');
  readonly #tokens = el('span', 'hud-tokens');
  readonly #resources = {} as Record<ResourceId, HTMLSpanElement>;
  readonly #resourceRows = {} as Record<ResourceId, HTMLSpanElement>;
  /** SPEC-037 §4.2: the wallet strip heading the top centre; `null` in flight mode. */
  #wallet: HTMLDivElement | null = null;
  readonly #weather = testId(el('div', 'hud-weather'), 'hud-weather');
  /** SPEC-030 D-11: always in the DOM, hidden while `shelter === 'none'`. */
  readonly #shelter = testId(el('div', 'hud-shelter is-hidden'), 'sheltered');
  /** SPEC-042 §4.6: `▲ Wave incoming`, on the weather banner's pill, under the shelter chip. */
  readonly #wave = testId(el('div', 'hud-wave is-hidden', `${GLYPHS.warn} Wave incoming`), 'hud-wave');
  /**
   * SPEC-042 §4.9: the boss frame — the name over its own `--bar-boss` bar,
   * a tick at each later phase, and `Phase N` for 2 s at a turn. It took the
   * place of SPEC-037's boss row, which was the player's red bar moved up.
   */
  readonly #boss = testId(el('div', 'boss-frame is-hidden'), 'hud-boss');
  readonly #bossName = testId(el('p', 'boss-frame-name'), 'hud-boss-name');
  readonly #bossTrack = el('div', 'boss-frame-track');
  readonly #bossFill = el('div', 'boss-frame-fill');
  readonly #bossPhase = testId(el('span', 'boss-frame-phase is-hidden'), 'hud-boss-phase');
  /** The marks the ticks were last built from — one cached array per boss id. */
  #bossMarks: readonly number[] | null = null;
  readonly #bossTicks: HTMLSpanElement[] = [];
  #bossNameShown = '';
  /** The phase last seen, 0 with no boss; a rise shows `Phase N`. */
  #bossPhaseSeen = 0;
  #bossPhaseTimer: ReturnType<typeof setTimeout> | null = null;
  /** SPEC-042 §4.9: the target frame — the last enemy the player hit inside 3 s. */
  readonly #target = testId(el('div', 'target-frame is-hidden'), 'hud-target');
  readonly #targetName = testId(el('span', 'target-frame-name'), 'hud-target-name');
  readonly #targetElite = testId(el('span', 'target-frame-elite is-hidden', 'Elite'), 'hud-target-elite');
  readonly #targetAffixes = testId(el('p', 'target-frame-affixes is-hidden'), 'hud-target-affixes');
  readonly #targetFill = el('div', 'target-frame-fill');
  #targetNameShown = '';
  #targetAffixesShown = '';
  /** SPEC-042 §4.3: one chip per effect kind in the `Lv N` row, reused; the whole second last written. */
  readonly #effects = {} as Record<EffectKind, { node: HTMLSpanElement; seconds: number }>;
  /** SPEC-042 §4.4: the static red edge below a quarter of HP — never animated. */
  readonly #lowHp = testId(el('div', 'hud-lowhp'), 'hud-lowhp');
  /**
   * SPEC-042 §4.7: the level the label last showed, primed on the first flush
   * so a landing never glows; a rise after that wears `is-levelled` for 2 s.
   */
  #levelSeen: number | null = null;
  #levelTimer: ReturnType<typeof setTimeout> | null = null;
  /** False through the constructor's first render of the zeroed model. */
  #primed = false;
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
  /** SPEC-041 §4.7: where a shot fired now meets the cone target — hidden until shown. */
  readonly #leadPip = testId(el('div', 'hud-lead-pip is-hidden'), 'lead-pip');
  #leadPipShown = false;
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
    // SPEC-042 §4.3: the running effects sit in the `Lv N` row after the
    // level, one chip per kind — the row never wraps, so the column is no
    // taller with every effect running and the tracker keeps its place.
    const effects = el('span', 'hud-effects');
    for (const kind of EFFECT_KINDS) {
      const node = testId(el('span', 'hud-effect is-hidden'), `hud-effect-${kind}`);
      effects.append(node);
      this.#effects[kind] = { node, seconds: -1 };
    }
    const levelRow = el('div', 'hud-level-row');
    levelRow.append(this.#level, effects);
    // `hud-hp` is the scene's one HP readout (AC-58); the SPEC-011 e2e reads it.
    tl.append(testId(this.#hp.root, 'hud-hp'), this.#xp.root, levelRow);
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
      tokens.append(el('span', 'glyph', GLYPHS.tokens), this.#tokens);
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
    // SPEC-037 §4.2: the boss row is an in-flow row after both, which is what
    // lets `--hud-tc-h` count it (37-c). SPEC-042 §4.6, §4.9: the wave line
    // under the chip, then the boss frame, then the target frame; the mission
    // banner mounts itself after all of them, as the stack's last row.
    this.#bossTrack.append(this.#bossFill);
    this.#boss.append(this.#bossName, this.#bossTrack, this.#bossPhase);
    const targetHead = el('p', 'target-frame-head');
    targetHead.append(this.#targetName, this.#targetElite);
    const targetTrack = el('div', 'target-frame-track');
    targetTrack.append(this.#targetFill);
    this.#target.append(targetHead, this.#targetAffixes, targetTrack);
    tc.append(this.#weather, this.#shelter, this.#wave, this.#boss, this.#target);
    // SPEC-013 §4.10: trip progress with wave markers, the hostiles counter,
    // the storm warning + static, the holding banner, and the reticle.
    if (mode === 'flight') {
      this.#progress.append(this.#progressFill, this.#markers);
      this.#progress.setAttribute('aria-label', 'Trip progress');
      this.#storm.textContent = `${GLYPHS.warn} Ion storm`;
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

    // SPEC-042 §4.4: the low-HP edge is a full-screen layer under the HUD's
    // boxes, like the damage vignette — it takes no touch, so SPEC-037's box
    // checks leave it out.
    this.#root.append(this.#lowHp, this.#vignette, this.#static, this.#hitDirLayer, tl, this.#tr, tc, bl, this.#br, this.#bc, this.#interact);
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
    if (mode === 'flight') this.#root.append(this.#ion, this.#leadPip, this.#reticle);
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
   * SPEC-041 §4.7: show the lead pip — a hollow diamond — at NDC (y up),
   * placed like the reticle. The scene calls it every frame ARIA is enabled
   * and a ship sits in the assist cone, on every input scheme.
   */
  setLeadPip(ndcX: number, ndcY: number): void {
    const pip = this.#leadPip;
    pip.style.left = `${(ndcX * 0.5 + 0.5) * 100}%`;
    pip.style.top = `${(-ndcY * 0.5 + 0.5) * 100}%`;
    if (this.#leadPipShown) return;
    this.#leadPipShown = true;
    pip.classList.remove('is-hidden');
  }

  /** SPEC-041 §4.7, 41-k: no cone target, or ARIA disabled — no pip. Writes nothing once hidden. */
  hideLeadPip(): void {
    if (!this.#leadPipShown) return;
    this.#leadPipShown = false;
    this.#leadPip.classList.add('is-hidden');
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
    if (!this.#primed) {
      // SPEC-042 §4.7: the first flush takes the level as it stands, so a
      // landing never glows; the scenes write `model.level` before it.
      this.#primed = true;
      this.#levelSeen = this.model.level;
    }
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
    if (this.#levelTimer !== null) clearTimeout(this.#levelTimer);
    if (this.#bossPhaseTimer !== null) clearTimeout(this.#bossPhaseTimer);
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
        // SPEC-042 §4.4: in flight the hull is what is at stake, so `is-low-hp`
        // follows it there (the `flight` key), and the salvager's HP here.
        if (this.#mode !== 'surface' || !this.#primed) return;
        // AC-64: the pulse is a class on the root, so CSS owns the animation
        // and its reduce-motion static form. SPEC-042 §4.4: the same class
        // shows the static red edge, and asks the heal slot to be used.
        const low = m.hp[0] / Math.max(1, m.hp[1]) < LOW_HP_FRACTION;
        this.#root.classList.toggle('is-low-hp', low);
        this.#quickBar?.setUrgent(low);
        return;
      }
      case 'xp': {
        this.#setBar(this.#xp, m.xp, false);
        // SPEC-042 §4.7: the numbers the 6 px bar has no room to print.
        const text = `XP ${Math.round(m.xp[0])} / ${Math.round(m.xp[1])}`;
        this.#xp.root.title = text;
        this.#xp.root.setAttribute('aria-label', text);
        return;
      }
      case 'level': {
        this.#level.textContent = `Lv ${m.level}`;
        // SPEC-042 §4.7: a level gained glows gold for 2 s; the first render never does.
        const seen = this.#levelSeen;
        if (this.#primed) this.#levelSeen = m.level;
        if (seen === null || !this.#primed || m.level <= seen) return;
        this.#level.classList.add('is-levelled');
        if (this.#levelTimer !== null) clearTimeout(this.#levelTimer);
        this.#levelTimer = setTimeout(() => {
          this.#levelTimer = null;
          this.#level.classList.remove('is-levelled');
        }, LEVEL_GLOW_MS);
        return;
      }
      case 'effects':
        this.#writeEffects();
        return;
      case 'wave':
        this.#wave.classList.toggle('is-hidden', !m.wave);
        return;
      case 'target':
        this.#writeTarget();
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
        // SPEC-045 §4.7: `▲ Heatwave — 10 s`, `▲ Heatwave in 10 s`.
        const { warning, active, secondsLeft } = m.weather;
        const text =
          active !== null
            ? `${GLYPHS.warn} ${label(active)} — ${seconds(secondsLeft)}`
            : warning !== null
              ? `${GLYPHS.warn} ${label(warning)} in ${seconds(secondsLeft)}`
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
      case 'boss':
        this.#writeBoss();
        return;
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
      case 'stamina':
        // SPEC-050 §4.6: the scene draws the ring beside the salvager's head
        // in `render()`, off this field, as it does the scan ring.
        return;
      case 'holstered':
        // SPEC-050 §4.6: the weapon slots dim while the gun is holstered.
        this.#quickBar?.setHolstered(m.holstered);
        return;
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
        // SPEC-045 §4.7: the word, not `THR` — `Throttle 1.0×`.
        const throttle = `Throttle ${multiplier(m.flight.throttle)}`;
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
        // SPEC-042 §4.4: one signal for "you are about to die", whatever you
        // are flying — the red edge follows the hull in flight.
        if (this.#primed) {
          this.#root.classList.toggle('is-low-hp', m.flight.hull[0] / Math.max(1, m.flight.hull[1]) < LOW_HP_FRACTION);
        }
        return;
      }
    }
  }

  /**
   * SPEC-042 §4.3: each chip shows while its effect runs, with the effect's
   * glyph and `<n> s`; its text and label are written only when the whole
   * second changes. At most three entries, so the lookup is a short scan.
   */
  #writeEffects(): void {
    const effects = this.model.effects;
    for (const kind of EFFECT_KINDS) {
      const chip = this.#effects[kind];
      let left = -1;
      for (let i = 0; i < effects.length; i++) {
        const effect = effects[i];
        if (effect !== undefined && effect.kind === kind) left = Math.max(0, effect.seconds);
      }
      if (left === chip.seconds) continue;
      chip.node.classList.toggle('is-hidden', left < 0);
      if (left >= 0) {
        chip.node.textContent = `${EFFECT_GLYPHS[kind]} ${seconds(left)}`;
        chip.node.setAttribute('aria-label', `${EFFECT_WORDS[kind]}, ${left} seconds`);
      }
      chip.seconds = left;
    }
  }

  /**
   * SPEC-042 §4.9: the boss frame from `m.boss` — the fill by `scaleX`, the
   * `aria-label` with the bar, the ticks rebuilt only for a new boss's marks,
   * and `Phase N` for 2 s when the phase rises (never for the first sight).
   */
  #writeBoss(): void {
    const boss = this.model.boss;
    this.#boss.classList.toggle('is-hidden', boss === null);
    if (boss === null) {
      this.#bossPhaseSeen = 0;
      return;
    }
    const fraction = Math.max(0, Math.min(1, boss.hp / Math.max(1, boss.max)));
    this.#bossFill.style.transform = `scaleX(${fraction})`;
    this.#boss.setAttribute('aria-label', `${boss.name}, ${Math.round(boss.hp)} of ${Math.round(boss.max)} HP`);
    if (this.#bossNameShown !== boss.name) {
      this.#bossNameShown = boss.name;
      this.#bossName.textContent = boss.name;
    }
    if (boss.marks !== this.#bossMarks) {
      this.#bossMarks = boss.marks;
      for (const tick of this.#bossTicks.splice(0)) tick.remove();
      for (const mark of boss.marks) {
        const tick = el('span', 'boss-frame-tick');
        tick.style.left = `${Math.round(mark * 1000) / 10}%`;
        this.#bossTrack.append(tick);
        this.#bossTicks.push(tick);
      }
    }
    const seen = this.#bossPhaseSeen;
    this.#bossPhaseSeen = boss.phase;
    if (seen === 0 || boss.phase <= seen) return;
    this.#bossPhase.textContent = `Phase ${boss.phase}`;
    this.#bossPhase.classList.remove('is-hidden');
    if (this.#bossPhaseTimer !== null) clearTimeout(this.#bossPhaseTimer);
    this.#bossPhaseTimer = setTimeout(() => {
      this.#bossPhaseTimer = null;
      this.#bossPhase.classList.add('is-hidden');
    }, BOSS_PHASE_MS);
  }

  /** SPEC-042 §4.9: the target frame from `m.target` — written only where a field moved. */
  #writeTarget(): void {
    const target = this.model.target;
    this.#target.classList.toggle('is-hidden', target === null);
    if (target === null) return;
    if (this.#targetNameShown !== target.name) {
      this.#targetNameShown = target.name;
      this.#targetName.textContent = target.name;
    }
    this.#targetElite.classList.toggle('is-hidden', !target.elite);
    if (this.#targetAffixesShown !== target.affixes) {
      this.#targetAffixesShown = target.affixes;
      this.#targetAffixes.textContent = target.affixes;
    }
    this.#targetAffixes.classList.toggle('is-hidden', target.affixes === '');
    const fraction = Math.max(0, Math.min(1, target.hp / Math.max(1, target.max)));
    this.#targetFill.style.transform = `scaleX(${fraction})`;
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
