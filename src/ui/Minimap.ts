// The minimap painter (SPEC-012 §4.12, AC-55..AC-59). The HUD owns the canvas
// and its slot in the layout; this class owns what appears on it: the player
// arrow, discovered POIs, objective POIs (edge arrows when off-window), nodes
// behind the `nodeRadar` gate, enemies within 25 m, and arena rings. All the
// projection math is `minimapProject` in `systems/UiHelpers` — pure and
// unit-tested; this file only strokes pixels.
import {
  MINIMAP_ENEMY_RANGE,
  MINIMAP_SIZE,
  minimapProject,
  type MinimapPoint,
} from '@/systems/UiHelpers';

export interface MinimapPoi {
  x: number;
  z: number;
  discovered: boolean;
  objective: boolean;
  /** Arena POIs draw their ring at this radius; 0 for everything else. */
  arenaRadius: number;
}

export interface MinimapFrame {
  playerX: number;
  playerZ: number;
  /** World facing, `atan2(dz, dx)` convention — the player arrow's heading. */
  facing: number;
  pois: readonly MinimapPoi[];
  /** `null` while the save has no node radar (scanner drone L2+ or scout). */
  nodes: readonly { x: number; z: number }[] | null;
  enemies: readonly { x: number; z: number }[];
}

const COLORS = {
  background: 'rgba(8, 12, 18, 0.72)',
  frame: 'rgba(150, 180, 210, 0.35)',
  player: '#e8f2ff',
  poi: '#9fb4cc',
  objective: '#ffc857',
  node: '#6fd6c2',
  enemy: '#ff6650',
  arena: 'rgba(255, 85, 51, 0.8)',
} as const;

export class Minimap {
  readonly #canvas: HTMLCanvasElement;
  readonly #ctx: CanvasRenderingContext2D | null;
  readonly #point: MinimapPoint = { x: 0, y: 0, inside: true, angle: 0 };

  /**
   * What the last `draw()` actually put on the canvas (AC-55..AC-59) — the
   * scene's `debugInfo()` reports these so the acceptance run can see through
   * the canvas. One object, mutated in place.
   */
  readonly lastDrawn = { pois: 0, objectives: 0, arrows: 0, nodes: 0, enemies: 0 };

  constructor(canvas: HTMLCanvasElement) {
    this.#canvas = canvas;
    // §4.12: 160 px backing at 1 px = 1 m; the HUD's CSS box scales it down.
    canvas.width = MINIMAP_SIZE;
    canvas.height = MINIMAP_SIZE;
    this.#ctx = canvas.getContext('2d');
  }

  get canvas(): HTMLCanvasElement {
    return this.#canvas;
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
    const size = MINIMAP_SIZE;
    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = COLORS.background;
    ctx.fillRect(0, 0, size, size);
    ctx.strokeStyle = COLORS.frame;
    ctx.strokeRect(0.5, 0.5, size - 1, size - 1);

    // POIs: discovered ones as squares, objectives always — edge arrows when
    // off-window — and arena rings around their POI.
    for (const poi of frame.pois) {
      if (!poi.discovered && !poi.objective) continue;
      const p = minimapProject(frame.playerX, frame.playerZ, poi.x, poi.z, this.#point);
      if (poi.arenaRadius > 0 && p.inside) {
        ctx.strokeStyle = COLORS.arena;
        ctx.beginPath();
        ctx.arc(p.x, p.y, poi.arenaRadius, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (poi.objective) {
        if (p.inside) {
          ctx.fillStyle = COLORS.objective;
          ctx.fillRect(p.x - 3, p.y - 3, 6, 6);
          drawn.objectives++;
        } else {
          this.#arrow(ctx, p, COLORS.objective);
          drawn.arrows++;
        }
      } else if (p.inside) {
        ctx.fillStyle = COLORS.poi;
        ctx.fillRect(p.x - 2, p.y - 2, 4, 4);
        drawn.pois++;
      }
    }

    if (frame.nodes !== null) {
      ctx.fillStyle = COLORS.node;
      for (const node of frame.nodes) {
        const p = minimapProject(frame.playerX, frame.playerZ, node.x, node.z, this.#point);
        if (p.inside) {
          ctx.fillRect(p.x - 1.5, p.y - 1.5, 3, 3);
          drawn.nodes++;
        }
      }
    }

    ctx.fillStyle = COLORS.enemy;
    for (const enemy of frame.enemies) {
      if (Math.hypot(enemy.x - frame.playerX, enemy.z - frame.playerZ) > MINIMAP_ENEMY_RANGE) continue;
      const p = minimapProject(frame.playerX, frame.playerZ, enemy.x, enemy.z, this.#point);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2, 0, Math.PI * 2);
      ctx.fill();
      drawn.enemies++;
    }

    // The player: a heading triangle at the centre.
    const half = size / 2;
    ctx.save();
    ctx.translate(half, half);
    ctx.rotate(frame.facing);
    ctx.fillStyle = COLORS.player;
    ctx.beginPath();
    ctx.moveTo(5, 0);
    ctx.lineTo(-3, 3.5);
    ctx.lineTo(-3, -3.5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  #arrow(ctx: CanvasRenderingContext2D, p: MinimapPoint, color: string): void {
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.angle);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(5, 0);
    ctx.lineTo(-2, 4);
    ctx.lineTo(-2, -4);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}
