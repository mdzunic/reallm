// The minimap painter (SPEC-026 §4.3, replacing SPEC-012 §4.12's square grey
// one). The HUD owns the canvas and its corner slot; this class owns what
// appears on it and, since the box is now sized in CSS, the backing store it
// measures from that box.
//
// It is round, it turns with the camera, and it shows a fixed 70 m radius, so
// it reads the same at every resolution. All the projection maths is
// `systems/MapModel` — pure and unit-tested; this file strokes pixels, and
// exports the two shape painters the full map and its legend share.
import { MINIMAP_ENEMY_RANGE } from '@/systems/UiHelpers';
import {
  MAP_ICONS,
  MINIMAP_RANGE,
  isNodeIcon,
  mapAngle,
  mapProject,
  type MapIconKind,
  type MapPoint,
  type MapShape,
} from '@/systems/MapModel';
import { drawMapLayers, type MapLayers } from '@/ui/MapLayers';

/** One thing on a map: a POI, a node, a shelter — whatever carries an icon. */
export interface MapMark {
  x: number;
  z: number;
  icon: MapIconKind;
  /** True while a current objective points at it: ring inside, arrow outside. */
  objective: boolean;
  /** The full map's label; `null` for landmarks and nodes. */
  label: string | null;
  /** Arena ring radius in metres, 0 for everything else. */
  ring: number;
}

export interface MinimapFrame {
  playerX: number;
  playerZ: number;
  /** World facing, `atan2(dz, dx)` — the player arrow's heading. */
  facing: number;
  /** POIs (discovered or objective), nodes, shelters — everything with an icon. */
  marks: readonly MapMark[];
  enemies: readonly { x: number; z: number; kind: 'enemy' | 'elite' | 'boss' }[];
  /** SPEC-027's guidance marks; null until then. */
  target: { x: number; z: number } | null;
  route: Float32Array | null;
  routeLength: number;
}

const COLORS = {
  background: 'rgba(8, 12, 18, 0.72)',
  rim: 'rgba(150, 180, 210, 0.45)',
  north: 'rgba(220, 235, 250, 0.9)',
  arena: 'rgba(255, 85, 51, 0.8)',
  outline: 'rgba(4, 6, 10, 0.85)',
  route: 'rgba(255, 200, 87, 0.7)',
} as const;

/** §4.3: the rim inset, in CSS px, that keeps an edge arrow off the border. */
const RIM_INSET = 6;
/** The fog edge reads soft at this blur, where the browser can blur at all. */
const FOG_BLUR = 1;
const TAU = Math.PI * 2;

/** The device scale a canvas is backed at: `round(css × min(dpr, 2))`. */
export function backingFor(cssSize: number): number {
  const dpr = typeof globalThis.devicePixelRatio === 'number' ? globalThis.devicePixelRatio : 1;
  return Math.max(1, Math.round(cssSize * Math.min(dpr, 2)));
}

/**
 * One icon, upright, centred on `(x, y)` (§4.1: icons never rotate with the
 * map). `scale` turns the table's CSS px into backing px, so an icon is the
 * same size on a phone's 3× screen as on a laptop's 1×.
 */
export function drawMapIcon(ctx: CanvasRenderingContext2D, kind: MapIconKind, x: number, y: number, scale: number): void {
  const icon = MAP_ICONS[kind];
  const s = icon.size * scale;
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = icon.color;
  ctx.strokeStyle = icon.color;
  ctx.lineWidth = Math.max(1, scale);
  drawShape(ctx, icon.shape, s, scale);
  ctx.restore();
}

/** The player arrow (§4.3 step 10): white, dark-outlined, at `facing + π/4`. */
export function drawPlayerArrow(ctx: CanvasRenderingContext2D, x: number, y: number, facing: number, scale: number): void {
  const icon = MAP_ICONS.player;
  const s = icon.size * scale;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(mapAngle(facing));
  ctx.beginPath();
  ctx.moveTo(s * 0.5, 0);
  ctx.lineTo(-s * 0.35, s * 0.34);
  ctx.lineTo(-s * 0.18, 0);
  ctx.lineTo(-s * 0.35, -s * 0.34);
  ctx.closePath();
  ctx.fillStyle = icon.color;
  ctx.fill();
  ctx.lineWidth = Math.max(1, scale);
  ctx.strokeStyle = COLORS.outline;
  ctx.stroke();
  ctx.restore();
}

/** An edge arrow at an off-rim mark's bearing (§4.3 step 7). */
export function drawRimArrow(ctx: CanvasRenderingContext2D, p: MapPoint, color: string, scale: number): void {
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(p.angle);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(5 * scale, 0);
  ctx.lineTo(-2 * scale, 4 * scale);
  ctx.lineTo(-2 * scale, -4 * scale);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/** The objective ring, `size + 6` around whatever icon it marks (§4.2). */
export function drawObjectiveRing(ctx: CanvasRenderingContext2D, kind: MapIconKind, x: number, y: number, scale: number): void {
  const radius = ((MAP_ICONS[kind].size + MAP_ICONS.objective.size) / 2) * scale;
  ctx.save();
  ctx.strokeStyle = MAP_ICONS.objective.color;
  ctx.lineWidth = Math.max(1, 1.5 * scale);
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, TAU);
  ctx.stroke();
  ctx.restore();
}

/** The fifteen shapes of §4.2, each drawn around the origin at size `s`. */
function drawShape(ctx: CanvasRenderingContext2D, shape: MapShape, s: number, scale: number): void {
  const h = s / 2;
  switch (shape) {
    case 'pad': {
      // Double ring with a centre chevron — the one shape the pad owns.
      ctx.beginPath();
      ctx.arc(0, 0, h, 0, TAU);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, 0, h * 0.6, 0, TAU);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-h * 0.35, h * 0.2);
      ctx.lineTo(0, -h * 0.3);
      ctx.lineTo(h * 0.35, h * 0.2);
      ctx.stroke();
      return;
    }
    case 'dish': {
      ctx.beginPath();
      ctx.arc(0, 0, h * 0.45, 0, TAU);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(0, 0, h, Math.PI * 1.15, Math.PI * 1.85);
      ctx.stroke();
      return;
    }
    case 'flag': {
      ctx.beginPath();
      ctx.moveTo(-h * 0.35, h);
      ctx.lineTo(-h * 0.35, -h);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-h * 0.35, -h);
      ctx.lineTo(h * 0.75, -h * 0.55);
      ctx.lineTo(-h * 0.35, -h * 0.1);
      ctx.closePath();
      ctx.fill();
      return;
    }
    case 'crate': {
      ctx.strokeRect(-h, -h, s, s);
      ctx.beginPath();
      ctx.moveTo(-h, -h);
      ctx.lineTo(h, h);
      ctx.moveTo(h, -h);
      ctx.lineTo(-h, h);
      ctx.stroke();
      return;
    }
    case 'skull': {
      ctx.beginPath();
      ctx.arc(0, -h * 0.15, h * 0.75, 0, TAU);
      ctx.fill();
      ctx.fillRect(-h * 0.4, h * 0.35, s * 0.4, h * 0.5);
      // Two dark eyes. Painted over the dome rather than erased out of it: a
      // composite hole would take the ground under the icon with it.
      ctx.fillStyle = COLORS.outline;
      ctx.beginPath();
      ctx.arc(-h * 0.32, -h * 0.2, Math.max(0.8, h * 0.22), 0, TAU);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(h * 0.32, -h * 0.2, Math.max(0.8, h * 0.22), 0, TAU);
      ctx.fill();
      return;
    }
    case 'shield': {
      ctx.beginPath();
      ctx.moveTo(0, -h);
      ctx.lineTo(h, -h * 0.5);
      ctx.lineTo(h * 0.7, h * 0.7);
      ctx.lineTo(0, h);
      ctx.lineTo(-h * 0.7, h * 0.7);
      ctx.lineTo(-h, -h * 0.5);
      ctx.closePath();
      ctx.stroke();
      return;
    }
    case 'probe': {
      ctx.beginPath();
      ctx.moveTo(0, -h);
      ctx.lineTo(h, 0);
      ctx.lineTo(0, h);
      ctx.lineTo(-h, 0);
      ctx.closePath();
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, 0, Math.max(1, h * 0.3), 0, TAU);
      ctx.fill();
      return;
    }
    case 'diamond': {
      ctx.beginPath();
      ctx.moveTo(0, -h);
      ctx.lineTo(h, 0);
      ctx.lineTo(0, h);
      ctx.lineTo(-h, 0);
      ctx.closePath();
      ctx.fill();
      return;
    }
    case 'drop': {
      ctx.beginPath();
      ctx.moveTo(0, -h);
      ctx.quadraticCurveTo(h, 0, 0, h);
      ctx.quadraticCurveTo(-h, 0, 0, -h);
      ctx.closePath();
      ctx.fill();
      return;
    }
    case 'dot': {
      ctx.beginPath();
      ctx.arc(0, 0, h, 0, TAU);
      ctx.fill();
      return;
    }
    case 'ring': {
      ctx.lineWidth = Math.max(1, 1.5 * scale);
      ctx.beginPath();
      ctx.arc(0, 0, h, 0, TAU);
      ctx.stroke();
      return;
    }
    case 'arrow': {
      ctx.beginPath();
      ctx.moveTo(h, 0);
      ctx.lineTo(-h * 0.7, h * 0.68);
      ctx.lineTo(-h * 0.36, 0);
      ctx.lineTo(-h * 0.7, -h * 0.68);
      ctx.closePath();
      ctx.fill();
      return;
    }
    case 'cross': {
      ctx.lineWidth = Math.max(1, 1.5 * scale);
      ctx.beginPath();
      ctx.moveTo(-h, 0);
      ctx.lineTo(h, 0);
      ctx.moveTo(0, -h);
      ctx.lineTo(0, h);
      ctx.stroke();
      return;
    }
    case 'arch': {
      ctx.beginPath();
      ctx.arc(0, h * 0.3, h * 0.8, Math.PI, 0);
      ctx.lineTo(h * 0.8, h * 0.8);
      ctx.lineTo(-h * 0.8, h * 0.8);
      ctx.closePath();
      ctx.stroke();
      return;
    }
    case 'hull': {
      ctx.beginPath();
      ctx.moveTo(-h, -h * 0.4);
      ctx.lineTo(h, -h * 0.4);
      ctx.lineTo(h * 0.5, h * 0.7);
      ctx.lineTo(-h * 0.5, h * 0.7);
      ctx.closePath();
      ctx.stroke();
      return;
    }
  }
}

/** The `elite` ring that tells an elite from a plain enemy dot (§4.2). */
function drawEliteRing(ctx: CanvasRenderingContext2D, x: number, y: number, scale: number): void {
  ctx.save();
  ctx.strokeStyle = MAP_ICONS.elite.color;
  ctx.lineWidth = Math.max(1, scale);
  ctx.beginPath();
  ctx.arc(x, y, MAP_ICONS.elite.size * scale * 0.75, 0, TAU);
  ctx.stroke();
  ctx.restore();
}

export class Minimap {
  readonly #canvas: HTMLCanvasElement;
  readonly #ctx: CanvasRenderingContext2D | null;
  readonly #layers: MapLayers;
  readonly #point: MapPoint = { x: 0, y: 0, inside: true, angle: 0 };
  /** CSS px of the box, re-measured on `renderer:resized` (§4.3). */
  #cssSize = 0;

  /**
   * What the last `draw()` actually put on the canvas — the scene's
   * `debugInfo()` reports these, so the acceptance run can see through the
   * canvas. One object, mutated in place (SPEC-012 AC-55..AC-59).
   */
  readonly lastDrawn = { pois: 0, objectives: 0, arrows: 0, nodes: 0, enemies: 0 };

  constructor(canvas: HTMLCanvasElement, layers: MapLayers) {
    this.#canvas = canvas;
    this.#layers = layers;
    this.#ctx = canvas.getContext('2d');
    this.measure();
  }

  get canvas(): HTMLCanvasElement {
    return this.#canvas;
  }

  /** §4.3: the backing store is `round(css × min(dpr, 2))` of the CSS box. */
  measure(): void {
    const box = this.#canvas.getBoundingClientRect();
    const css = box.width > 0 ? box.width : this.#canvas.clientWidth;
    if (!(css > 0)) return;
    this.#cssSize = css;
    const backing = backingFor(css);
    if (this.#canvas.width === backing && this.#canvas.height === backing) return;
    this.#canvas.width = backing;
    this.#canvas.height = backing;
  }

  draw(frame: MinimapFrame): void {
    const ctx = this.#ctx;
    if (ctx === null) return;
    const drawn = this.lastDrawn;
    drawn.pois = 0;
    drawn.objectives = 0;
    drawn.arrows = 0;
    drawn.nodes = 0;
    drawn.enemies = 0;

    const size = this.#canvas.width;
    if (size <= 0) return;
    const half = size / 2;
    // Backing px per CSS px: icons and the rim inset are written in CSS px.
    const scale = this.#cssSize > 0 ? size / this.#cssSize : 1;
    const rimPx = half - RIM_INSET * scale;
    const pxPerMetre = rimPx / MINIMAP_RANGE;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, size, size);
    ctx.save();
    // 1. clip to the circle — everything below stays inside the rim.
    ctx.beginPath();
    ctx.arc(half, half, half, 0, TAU);
    ctx.clip();
    ctx.fillStyle = COLORS.background;
    ctx.fillRect(0, 0, size, size);

    // 2/3. the explored ground and the fog over it; the arena wall line is
    // painted into the terrain layer (§4.4), so it arrives with them.
    drawMapLayers(ctx, this.#layers, {
      centreX: frame.playerX,
      centreZ: frame.playerZ,
      cx: half,
      cy: half,
      pxPerMetre,
      blur: FOG_BLUR * scale,
    });

    ctx.translate(half, half);

    // 4. arena rings.
    ctx.strokeStyle = COLORS.arena;
    ctx.lineWidth = Math.max(1, scale);
    for (const mark of frame.marks) {
      if (mark.ring <= 0) continue;
      const p = this.#at(frame, mark.x, mark.z, pxPerMetre, rimPx);
      if (!p.inside) continue;
      ctx.beginPath();
      ctx.arc(p.x, p.y, mark.ring * pxPerMetre, 0, TAU);
      ctx.stroke();
    }

    // 5. nodes, 6. discovered POIs, 7. objective rings and rim arrows.
    for (const mark of frame.marks) {
      if (!isNodeIcon(mark.icon)) continue;
      const p = this.#at(frame, mark.x, mark.z, pxPerMetre, rimPx);
      if (!p.inside) continue;
      drawMapIcon(ctx, mark.icon, p.x, p.y, scale);
      drawn.nodes++;
    }
    for (const mark of frame.marks) {
      if (mark.objective || isNodeIcon(mark.icon)) continue;
      const p = this.#at(frame, mark.x, mark.z, pxPerMetre, rimPx);
      if (!p.inside) continue;
      drawMapIcon(ctx, mark.icon, p.x, p.y, scale);
      drawn.pois++;
    }
    for (const mark of frame.marks) {
      if (!mark.objective) continue;
      const p = this.#at(frame, mark.x, mark.z, pxPerMetre, rimPx);
      if (p.inside) {
        drawMapIcon(ctx, mark.icon, p.x, p.y, scale);
        drawObjectiveRing(ctx, mark.icon, p.x, p.y, scale);
        drawn.objectives++;
      } else {
        drawRimArrow(ctx, p, MAP_ICONS.objective.color, scale);
        drawn.arrows++;
      }
    }

    // 8. enemies within 25 m; a boss shows anywhere inside the rim.
    for (const enemy of frame.enemies) {
      const distance = Math.hypot(enemy.x - frame.playerX, enemy.z - frame.playerZ);
      if (distance > MINIMAP_ENEMY_RANGE && enemy.kind !== 'boss') continue;
      const p = this.#at(frame, enemy.x, enemy.z, pxPerMetre, rimPx);
      if (!p.inside) continue;
      drawMapIcon(ctx, enemy.kind, p.x, p.y, scale);
      if (enemy.kind === 'elite') drawEliteRing(ctx, p.x, p.y, scale);
      drawn.enemies++;
    }

    // 9. the route and the target, when the frame carries them (SPEC-027).
    this.#drawGuidance(ctx, frame, pxPerMetre, rimPx, scale);

    // 10. the player, always at the centre.
    drawPlayerArrow(ctx, 0, 0, frame.facing, scale);
    ctx.restore();

    // 11. the north tick and the rim ring, outside the clip.
    ctx.save();
    ctx.strokeStyle = COLORS.north;
    ctx.lineWidth = Math.max(1, scale);
    ctx.beginPath();
    ctx.moveTo(half, half - rimPx);
    ctx.lineTo(half, half - rimPx + 5 * scale);
    ctx.stroke();
    ctx.fillStyle = COLORS.north;
    ctx.font = `${Math.round(9 * scale)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText('N', half, half - rimPx + 6 * scale);
    ctx.strokeStyle = COLORS.rim;
    ctx.beginPath();
    ctx.arc(half, half, half - Math.max(0.5, scale / 2), 0, TAU);
    ctx.stroke();
    ctx.restore();
  }

  /** A mark's canvas point, measured from the player at the centre (§4.1). */
  #at(frame: MinimapFrame, x: number, z: number, pxPerMetre: number, rimPx: number): MapPoint {
    return mapProject(x - frame.playerX, z - frame.playerZ, pxPerMetre, rimPx, this.#point);
  }

  /** SPEC-027's route and target; both are null until it lands (§4.3 step 9). */
  #drawGuidance(
    ctx: CanvasRenderingContext2D,
    frame: MinimapFrame,
    pxPerMetre: number,
    rimPx: number,
    scale: number,
  ): void {
    const route = frame.route;
    if (route !== null && frame.routeLength >= 2) {
      ctx.save();
      ctx.strokeStyle = COLORS.route;
      ctx.lineWidth = Math.max(1, 2 * scale);
      // SPEC-027 AC-65: dashed, so the route reads as a suggestion rather than
      // as another of the map's boundaries.
      ctx.setLineDash([4 * scale, 3 * scale]);
      ctx.beginPath();
      for (let i = 0; i < frame.routeLength; i++) {
        const p = this.#at(frame, route[i * 2] as number, route[i * 2 + 1] as number, pxPerMetre, rimPx);
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
      ctx.restore();
    }
    const target = frame.target;
    if (target === null) return;
    const p = this.#at(frame, target.x, target.z, pxPerMetre, rimPx);
    if (p.inside) drawMapIcon(ctx, 'target', p.x, p.y, scale);
    else drawRimArrow(ctx, p, MAP_ICONS.target.color, scale);
  }
}
