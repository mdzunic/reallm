// The full-screen map (SPEC-026 §4.5). It mounts into the `panel` layer over
// the frozen frame, shows the whole arena in the minimap's orientation, and
// carries the legend, the explored percentage and the active missions beside
// it. The scene holds the simulation while it is open (§4.6) — this class only
// knows how to draw and how to ask to be closed.
//
// Nothing moves while it is up, so it paints on open, on zoom and on track,
// and never per frame.
import type { MissionId } from '@/data/index';
import type { Layout } from '@/systems/Layout';
import {
  MAP_ICONS,
  MAP_ICON_KINDS,
  isNodeIcon,
  mapProject,
  nodeIcon,
  nodeInitial,
  poiIcon,
  type MapIconKind,
  type MapPoint,
} from '@/systems/MapModel';
import type { PlanetDef } from '@/data/index';
import { drawMapLayers, type MapLayers } from '@/ui/MapLayers';
import { el, h, testId, type UiRoot } from '@/ui/dom';
import {
  backingFor,
  drawMapIcon,
  drawObjectiveRing,
  drawPlayerArrow,
  type MinimapFrame,
} from '@/ui/Minimap';

/** One active mission as the side panel prints it. */
export interface MapMissionRow {
  id: MissionId;
  title: string;
  /** `Stage 2/5` — the panel prints it as given. */
  stage: string;
  line: string;
  tracked: boolean;
}

export interface MapScreenDeps {
  ui: UiRoot;
  layers: MapLayers;
  layout: Layout;
  planet: PlanetDef;
  missions: () => readonly MapMissionRow[];
  track: (id: MissionId) => void;
  close: () => void;
}

/** §4.5: the canvas keeps 12 px of margin around the arena's diamond. */
const FIT_MARGIN = 12;
/** …and never gets smaller than this, however cramped the viewport is. */
const MIN_CANVAS = 160;
/** The viewport height the canvas leaves for the frame around it. */
const VIEWPORT_INSET = 32;
/** Labels and node initials (§4.5), in CSS px. */
const LABEL_PX = 14;
const FOG_BLUR = 1;
const TAU = Math.PI * 2;

const COLORS = {
  label: '#e8f2ff',
  halo: 'rgba(4, 6, 10, 0.9)',
  north: 'rgba(220, 235, 250, 0.9)',
  arena: 'rgba(255, 85, 51, 0.8)',
  route: 'rgba(255, 200, 87, 0.7)',
} as const;

export class MapScreen {
  readonly #deps: MapScreenDeps;
  readonly #root: HTMLDivElement;
  readonly #canvas: HTMLCanvasElement;
  readonly #wrap: HTMLDivElement;
  readonly #panel: HTMLElement;
  readonly #explored: HTMLParagraphElement;
  readonly #missionList: HTMLDivElement;
  readonly #zoom: HTMLButtonElement;
  readonly #point: MapPoint = { x: 0, y: 0, inside: true, angle: 0 };
  readonly #onKey: (event: KeyboardEvent) => void;
  /** The last frame and percentage drawn, so a zoom can repaint without one. */
  #lastFrame: MinimapFrame | null = null;
  #lastExplored = 0;
  #zoomed = false;
  #open = false;
  #disposed = false;

  constructor(deps: MapScreenDeps) {
    this.#deps = deps;
    this.#canvas = testId(el('canvas', 'map-canvas'), 'map-canvas');
    this.#wrap = el('div', 'map-canvas-wrap');
    this.#wrap.append(this.#canvas);

    this.#explored = testId(el('p', 'map-explored', 'Explored 0 %'), 'map-explored');
    this.#missionList = testId(el('div', 'map-missions'), 'map-missions');
    this.#zoom = testId(
      h('button', { class: 'ui-btn', type: 'button', click: () => this.#toggleZoom() }, 'Zoom 2×'),
      'map-zoom',
    );
    const close = testId(
      h('button', { class: 'ui-btn', type: 'button', click: () => this.#deps.close() }, 'Close'),
      'map-close',
    );

    this.#panel = testId(el('aside', 'map-panel panel'), 'map-panel');
    this.#panel.append(
      el('p', 'map-title', deps.planet.name),
      this.#explored,
      this.#legend(),
      this.#missionList,
      h('div', { class: 'map-actions' }, this.#zoom, close),
    );

    this.#root = testId(el('div', 'map-screen'), 'map-screen');
    this.#root.setAttribute('role', 'dialog');
    this.#root.setAttribute('aria-label', 'Surface map');
    this.#root.append(this.#wrap, this.#panel);
    // §4.5, Touch: a tap that lands on neither the map nor the panel closes.
    this.#root.addEventListener('pointerdown', (event) => {
      const target = event.target;
      if (target instanceof Node && (this.#wrap.contains(target) || this.#panel.contains(target))) return;
      this.#deps.close();
    });

    // §4.5, Keys: Escape closes the map and stops there, so `main.ts` never
    // opens the pause menu behind it; `+` and `−` toggle the zoom.
    this.#onKey = (event: KeyboardEvent): void => {
      if (!this.#open) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        this.#deps.close();
        return;
      }
      if (event.code === 'Equal' || event.code === 'NumpadAdd' || event.code === 'Minus' || event.code === 'NumpadSubtract') {
        event.preventDefault();
        this.#toggleZoom();
      }
    };
    globalThis.addEventListener('keydown', this.#onKey, true);
  }

  get isOpen(): boolean {
    return this.#open;
  }

  /** Mount over the frozen frame and paint it once. */
  open(frame: MinimapFrame, explored: number): void {
    if (this.#open || this.#disposed) return;
    this.#open = true;
    this.#zoomed = false;
    this.#zoom.textContent = 'Zoom 2×';
    this.#deps.ui.mount(this.#root, 'panel');
    this.redraw(frame, explored);
  }

  /** §4.5: on open, on zoom and on track — nothing moves in between. */
  redraw(frame: MinimapFrame, explored: number): void {
    if (!this.#open) return;
    this.#lastFrame = frame;
    this.#lastExplored = explored;
    this.#explored.textContent = `Explored ${Math.round(explored * 100)} %`;
    this.#renderMissions();
    this.#paint(frame);
  }

  close(): void {
    if (!this.#open) return;
    this.#open = false;
    this.#deps.ui.unmount(this.#root);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.close();
    globalThis.removeEventListener('keydown', this.#onKey, true);
  }

  // ------------------------------------------------------------------ panel

  /**
   * §4.5: one row per icon kind this planet can show — its POI kinds and its
   * resources — plus the player, the objective ring and the enemy, which are
   * listed wherever the player is (26-h: Eden lists the enemy it does not have).
   */
  #legend(): HTMLElement {
    const present = new Set<MapIconKind>(['player', 'objective', 'enemy']);
    for (const poi of this.#deps.planet.surface.pois) present.add(poiIcon(poi.kind));
    for (const node of this.#deps.planet.surface.nodes) present.add(nodeIcon(node.resource));
    const legend = testId(el('div', 'map-legend'), 'map-legend');
    for (const kind of MAP_ICON_KINDS) {
      if (!present.has(kind)) continue;
      const icon = MAP_ICONS[kind];
      const swatch = el('canvas', 'map-legend-icon');
      const css = 20;
      swatch.width = backingFor(css);
      swatch.height = swatch.width;
      const scale = swatch.width / css;
      const ctx = swatch.getContext('2d');
      if (ctx !== null) {
        const centre = swatch.width / 2;
        if (kind === 'player') drawPlayerArrow(ctx, centre, centre, -Math.PI / 4, scale);
        else drawMapIcon(ctx, kind, centre, centre, scale);
      }
      legend.append(h('div', { class: 'map-legend-row' }, swatch, el('span', 'map-legend-label', icon.label)));
    }
    return legend;
  }

  /** The active missions, each with the Track button of §4.5. */
  #renderMissions(): void {
    const rows = this.#deps.missions();
    if (rows.length === 0) {
      this.#missionList.replaceChildren(el('p', 'map-mission-empty', 'No active missions'));
      return;
    }
    this.#missionList.replaceChildren(
      ...rows.map((row) => {
        const entry = el('div', `map-mission${row.tracked ? ' is-tracked' : ''}`);
        entry.append(
          el('span', 'map-mission-title', `${row.title} — ${row.stage}`),
          el('span', 'map-mission-line', row.line),
          testId(
            h(
              'button',
              { class: 'ui-btn', type: 'button', click: () => this.#deps.track(row.id) },
              row.tracked ? 'Tracked' : 'Track',
            ),
            `map-track-${row.id}`,
          ),
        );
        return entry;
      }),
    );
  }

  /** §4.5: fit ↔ 2×. Nothing moved, so the last frame is redrawn as it stands. */
  #toggleZoom(): void {
    this.#zoomed = !this.#zoomed;
    this.#zoom.textContent = this.#zoomed ? 'Fit' : 'Zoom 2×';
    if (this.#lastFrame !== null) this.redraw(this.#lastFrame, this.#lastExplored);
  }

  // ----------------------------------------------------------------- canvas

  #paint(frame: MinimapFrame): void {
    const canvas = this.#canvas;
    const cssSize = this.#sizeCanvas();
    const ctx = canvas.getContext('2d');
    if (ctx === null || cssSize <= 0) return;
    const size = canvas.width;
    const scale = size / cssSize;
    const half = this.#deps.layout.halfSize;

    // §4.5: the arena's diamond fits the canvas with 12 px margins; 2× is
    // twice that, centred on the player and clamped to the arena.
    const fit = (cssSize - 2 * FIT_MARGIN) / (2 * half * Math.SQRT2);
    const pxPerMetre = (this.#zoomed ? fit * 2 : fit) * scale;
    let centreX = 0;
    let centreZ = 0;
    if (this.#zoomed) {
      // Half the canvas in metres reaches this far along a world axis once the
      // view is turned 45°; keeping the centre inside it keeps the arena filled.
      const reach = Math.max(0, half - ((size / 2) / pxPerMetre) * Math.SQRT2);
      centreX = Math.max(-reach, Math.min(reach, frame.playerX));
      centreZ = Math.max(-reach, Math.min(reach, frame.playerZ));
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, size, size);
    const cx = size / 2;
    const cy = size / 2;
    drawMapLayers(ctx, this.#deps.layers, { centreX, centreZ, cx, cy, pxPerMetre, blur: FOG_BLUR * scale });

    ctx.save();
    ctx.translate(cx, cy);
    // No radius clip on the full map: `rimPx` is past the corner, so nothing
    // is ever clamped into an edge arrow here (§4.5).
    const rim = size;
    const project = (x: number, z: number): MapPoint =>
      mapProject(x - centreX, z - centreZ, pxPerMetre, rim, this.#point);

    ctx.strokeStyle = COLORS.arena;
    ctx.lineWidth = Math.max(1, scale);
    for (const mark of frame.marks) {
      if (mark.ring <= 0) continue;
      const p = project(mark.x, mark.z);
      ctx.beginPath();
      ctx.arc(p.x, p.y, mark.ring * pxPerMetre, 0, TAU);
      ctx.stroke();
    }

    ctx.font = `${Math.round(LABEL_PX * scale)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const mark of frame.marks) {
      const p = project(mark.x, mark.z);
      drawMapIcon(ctx, mark.icon, p.x, p.y, scale);
      if (mark.objective) drawObjectiveRing(ctx, mark.icon, p.x, p.y, scale);
      if (isNodeIcon(mark.icon)) {
        // §4.2: the resource's initial, so a node never rides on hue alone.
        this.#text(ctx, nodeInitial(mark.icon), p.x + 9 * scale, p.y, scale);
      } else if (mark.label !== null) {
        this.#text(ctx, mark.label, p.x, p.y + (MAP_ICONS[mark.icon].size * 0.5 + 10) * scale, scale);
      }
    }

    // The guidance marks of SPEC-027, when the frame carries them.
    const route = frame.route;
    if (route !== null && frame.routeLength >= 2) {
      ctx.save();
      ctx.strokeStyle = COLORS.route;
      ctx.lineWidth = Math.max(1, 2 * scale);
      ctx.beginPath();
      for (let i = 0; i < frame.routeLength; i++) {
        const p = project(route[i * 2] as number, route[i * 2 + 1] as number);
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
      ctx.restore();
    }
    if (frame.target !== null) {
      const p = project(frame.target.x, frame.target.z);
      drawMapIcon(ctx, 'target', p.x, p.y, scale);
    }

    const player = project(frame.playerX, frame.playerZ);
    drawPlayerArrow(ctx, player.x, player.y, frame.facing, scale);
    ctx.restore();

    // The compass, at the top edge: map-up is north (§4.1).
    ctx.save();
    ctx.fillStyle = COLORS.north;
    ctx.strokeStyle = COLORS.north;
    ctx.lineWidth = Math.max(1, scale);
    ctx.beginPath();
    ctx.moveTo(cx, 6 * scale);
    ctx.lineTo(cx, 14 * scale);
    ctx.stroke();
    ctx.font = `${Math.round(LABEL_PX * scale)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText('N', cx, 16 * scale);
    ctx.restore();
  }

  /** Map text with a dark halo, so a label stays readable over lit ground (§4.5). */
  #text(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, scale: number): void {
    ctx.lineWidth = Math.max(2, 3 * scale);
    ctx.strokeStyle = COLORS.halo;
    ctx.strokeText(text, x, y);
    ctx.fillStyle = COLORS.label;
    ctx.fillText(text, x, y);
  }

  /**
   * §4.5: square, `min(available width, 100dvh − 32px)`, backed at
   * `× min(dpr, 2)`. Measured here rather than in CSS so the backing store and
   * the box can never disagree.
   */
  #sizeCanvas(): number {
    const available = this.#wrap.getBoundingClientRect().width;
    const height = globalThis.innerHeight > 0 ? globalThis.innerHeight : 0;
    const css = Math.max(MIN_CANVAS, Math.min(available > 0 ? available : MIN_CANVAS, height - VIEWPORT_INSET));
    this.#canvas.style.width = `${css}px`;
    this.#canvas.style.height = `${css}px`;
    const backing = backingFor(css);
    if (this.#canvas.width !== backing) this.#canvas.width = backing;
    if (this.#canvas.height !== backing) this.#canvas.height = backing;
    return css;
  }
}
