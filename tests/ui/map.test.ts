// SPEC-026 §6.1 — the map's pure half: the projection both maps share and the
// icon table the legend reads. The painters in `ui/` only stroke what these
// decide, so this is where the orientation is pinned (SPEC-001 §4 keeps tests
// on pure code).
import { describe, expect, it } from 'vitest';
import { PLANETS, RESOURCE_IDS, type PlanetId, type PoiDef } from '@/data/index';
import {
  MAP_ICONS,
  MAP_ICON_KINDS,
  MAP_YAW,
  MINIMAP_RANGE,
  isNodeIcon,
  mapAngle,
  mapProject,
  mapRimPoint,
  nodeIcon,
  nodeInitial,
  poiIcon,
  type MapPoint,
} from '@/systems/MapModel';
import { GROUND_SHADE, MapLayers, OBSTACLE_SHADE, OPEN_VOID_COLOR, shade, type MapOpen, type TerrainLayout } from '@/ui/MapLayers';

const point = (): MapPoint => ({ x: 0, y: 0, inside: true, angle: 0 });
const PLANET_IDS = Object.keys(PLANETS) as PlanetId[];
/** Screen-up in world axes, the step a player's "forward" takes (SPEC-012 §4.3). */
const UP = { x: -Math.SQRT1_2, z: -Math.SQRT1_2 };
const RIGHT = { x: Math.SQRT1_2, z: -Math.SQRT1_2 };

describe('mapProject (§4.1)', () => {
  it('is the camera yaw: screen-up projects straight up the map', () => {
    const p = mapProject(UP.x, UP.z, 4, 100, point());
    expect(p.x).toBeCloseTo(0, 10);
    expect(p.y).toBeCloseTo(-4, 10);
    expect(p.inside).toBe(true);
  });

  it('projects the other three screen directions the same way', () => {
    const right = mapProject(RIGHT.x, RIGHT.z, 4, 100, point());
    expect([Math.round(right.x * 1e6) / 1e6, Math.round(right.y * 1e6) / 1e6]).toEqual([4, 0]);
    const down = mapProject(-UP.x, -UP.z, 4, 100, point());
    expect(down.x).toBeCloseTo(0, 10);
    expect(down.y).toBeCloseTo(4, 10);
    const left = mapProject(-RIGHT.x, -RIGHT.z, 4, 100, point());
    expect(left.x).toBeCloseTo(-4, 10);
    expect(left.y).toBeCloseTo(0, 10);
  });

  it('the centre is the centre, and a world axis reads diagonally', () => {
    expect(mapProject(0, 0, 2, 50, point())).toMatchObject({ x: 0, y: 0, inside: true });
    // World +x is screen right-and-down at a 45° yaw, in equal parts.
    const east = mapProject(10, 0, 1, 50, point());
    expect(east.x).toBeCloseTo(10 * Math.SQRT1_2, 10);
    expect(east.y).toBeCloseTo(10 * Math.SQRT1_2, 10);
  });

  it('clamps an off-rim mark to the rim, keeping its bearing', () => {
    const far = mapProject(UP.x * 400, UP.z * 400, 1, 60, point());
    expect(far.inside).toBe(false);
    expect(Math.hypot(far.x, far.y)).toBeCloseTo(60, 10);
    expect(far.angle).toBeCloseTo(-Math.PI / 2, 10);

    const diagonal = mapProject(120, 0, 1, 60, point());
    expect(diagonal.inside).toBe(false);
    expect(Math.hypot(diagonal.x, diagonal.y)).toBeCloseTo(60, 10);
    // The bearing survives the clamp: still 45° down-right on the canvas.
    expect(diagonal.angle).toBeCloseTo(Math.PI / 4, 10);
  });

  it('a mark exactly on the rim is still inside', () => {
    // Measure the mark's distance with a rim it cannot reach, then use that
    // distance as the rim: the boundary case is inclusive, to the last bit.
    const probe = mapProject(30, -10, 1.5, 1e9, point());
    const rim = Math.hypot(probe.x, probe.y);
    const edge = mapProject(30, -10, 1.5, rim, point());
    expect(edge.inside).toBe(true);
    expect([edge.x, edge.y]).toEqual([probe.x, probe.y]);
  });

  it('pins the projection constants', () => {
    expect(MAP_YAW).toBeCloseTo(Math.PI / 4, 12);
    expect(MINIMAP_RANGE).toBe(70);
  });
});

describe('mapRimPoint (SPEC-027 AC-39)', () => {
  it('puts a mark on the rim however near it is, and never calls it inside', () => {
    // 30 m of a 70 m window: `mapProject` would place this comfortably inside,
    // which is exactly why the quarry needs its own projection.
    const near = mapRimPoint(UP.x * 30, UP.z * 30, 60, point());
    expect(near.inside).toBe(false);
    expect(Math.hypot(near.x, near.y)).toBeCloseTo(60, 10);
    expect(near.angle).toBeCloseTo(-Math.PI / 2, 10);
  });

  it('agrees with the clamped projection on bearing, near or far', () => {
    for (const metres of [1, 25, 59, 400]) {
      const rim = mapRimPoint(metres, 0, 60, point());
      expect(rim.angle).toBeCloseTo(Math.PI / 4, 10);
      expect(Math.hypot(rim.x, rim.y)).toBeCloseTo(60, 10);
    }
    // The same offset past the rim: the two agree where both apply.
    const clamped = mapProject(400, 0, 1, 60, point());
    const rim = mapRimPoint(400, 0, 60, point());
    expect(rim.x).toBeCloseTo(clamped.x, 10);
    expect(rim.y).toBeCloseTo(clamped.y, 10);
  });

  it('reads the four screen directions the way the map turns', () => {
    const up = mapRimPoint(UP.x, UP.z, 10, point());
    expect([Math.round(up.x * 1e6) / 1e6, Math.round(up.y * 1e6) / 1e6]).toEqual([0, -10]);
    const right = mapRimPoint(RIGHT.x, RIGHT.z, 10, point());
    expect([Math.round(right.x * 1e6) / 1e6, Math.round(right.y * 1e6) / 1e6]).toEqual([10, 0]);
    const down = mapRimPoint(-UP.x, -UP.z, 10, point());
    expect([Math.round(down.x * 1e6) / 1e6, Math.round(down.y * 1e6) / 1e6]).toEqual([0, 10]);
    const left = mapRimPoint(-RIGHT.x, -RIGHT.z, 10, point());
    expect([Math.round(left.x * 1e6) / 1e6, Math.round(left.y * 1e6) / 1e6]).toEqual([-10, 0]);
  });

  it('an enemy standing on the player has a bearing rather than a NaN', () => {
    const zero = mapRimPoint(0, 0, 60, point());
    expect(zero.angle).toBe(0);
    expect([zero.x, zero.y]).toEqual([60, 0]);
    expect(zero.inside).toBe(false);
  });
});

describe('mapAngle (§4.1)', () => {
  it('turns a world facing into its canvas angle', () => {
    expect(mapAngle(0)).toBeCloseTo(Math.PI / 4, 12);
    expect(mapAngle(Math.PI / 2)).toBeCloseTo((3 * Math.PI) / 4, 12);
    // Facing along screen-up — world atan2(−1, −1) — points straight up (−π/2).
    expect(mapAngle(Math.atan2(UP.z, UP.x))).toBeCloseTo(-Math.PI / 2, 12);
  });
});

describe('MAP_ICONS (§4.2)', () => {
  it('gives every kind a shape, a colour and a legend label', () => {
    // SPEC-054 §4.10: +4 — descent, cache, vault, relic. SPEC-057 §4.5: +1 — remains.
    expect(MAP_ICON_KINDS.length).toBe(25);
    for (const kind of MAP_ICON_KINDS) {
      const icon = MAP_ICONS[kind];
      expect(icon.shape, kind).toBeTruthy();
      expect(icon.color, kind).toMatch(/^#[0-9a-f]{6}$/);
      expect(icon.size, kind).toBeGreaterThan(0);
      expect(icon.label.length, kind).toBeGreaterThan(2);
    }
  });

  it('no two kinds share both a shape and a colour', () => {
    const seen = new Map<string, string>();
    for (const kind of MAP_ICON_KINDS) {
      const icon = MAP_ICONS[kind];
      const key = `${icon.shape}/${icon.color}`;
      expect(seen.get(key), `${kind} collides with ${seen.get(key) ?? ''}`).toBeUndefined();
      seen.set(key, kind);
    }
  });

  it('the pad shape belongs to the landing pad alone', () => {
    const pads = MAP_ICON_KINDS.filter((kind) => MAP_ICONS[kind].shape === 'pad');
    expect(pads).toEqual(['landing_pad']);
  });

  it('the four node kinds share one shape and differ by colour and initial', () => {
    const nodes = MAP_ICON_KINDS.filter(isNodeIcon);
    expect(nodes).toHaveLength(4);
    expect(new Set(nodes.map((kind) => MAP_ICONS[kind].shape))).toEqual(new Set(['drop']));
    expect(new Set(nodes.map(nodeInitial))).toEqual(new Set(['O', 'W', 'H', 'L']));
    expect(isNodeIcon('landing_pad')).toBe(false);
  });
});

describe('poiIcon / nodeIcon (§4.2)', () => {
  it('maps every POI kind the six planets place', () => {
    const kinds = new Set<PoiDef['kind']>();
    for (const id of PLANET_IDS) {
      for (const poi of PLANETS[id].surface.pois) kinds.add(poi.kind);
    }
    expect(kinds.size).toBeGreaterThanOrEqual(6);
    for (const kind of kinds) {
      const icon = poiIcon(kind);
      expect(MAP_ICONS[icon], kind).toBeDefined();
      // Each POI kind draws as the icon of the same name (§4.2).
      expect(icon).toBe(kind);
    }
  });

  it('maps every resource to its node icon', () => {
    for (const resource of RESOURCE_IDS) {
      const icon = nodeIcon(resource);
      expect(icon).toBe(`node_${resource}`);
      expect(MAP_ICONS[icon], resource).toBeDefined();
      expect(isNodeIcon(icon)).toBe(true);
    }
  });
});

describe('the underground icons (SPEC-054 §4.10)', () => {
  it('pins each new kind to its shape and colour', () => {
    expect(MAP_ICONS.descent).toMatchObject({ shape: 'shaft', color: '#e0c088' });
    expect(MAP_ICONS.cache).toMatchObject({ shape: 'chest', color: '#ffd166' });
    expect(MAP_ICONS.vault).toMatchObject({ shape: 'lock', color: '#ff9f43' });
    expect(MAP_ICONS.relic).toMatchObject({ shape: 'tablet', color: '#7ee0c3' });
  });

  it('is the only four kinds MAP_ICON_KINDS gained (and SPEC-057 the remains after them)', () => {
    const before = new Set<string>([
      'landing_pad', 'scan', 'reach', 'deliver', 'arena', 'defend', 'escort_start', 'landmark',
      'node_oil', 'node_wheat', 'node_water', 'node_lithium', 'enemy', 'elite', 'boss', 'objective',
      'player', 'target', 'shelter_cave', 'shelter_wreck',
    ]);
    const added = MAP_ICON_KINDS.filter((kind) => !before.has(kind));
    expect(added).toEqual(['descent', 'cache', 'vault', 'relic', 'remains']);
  });
});

describe('the remains icon (SPEC-057 §4.5)', () => {
  it('is a 10 px bag in #f2efe6, listed as Your remains', () => {
    expect(MAP_ICONS.remains).toEqual({ shape: 'bag', color: '#f2efe6', size: 10, label: 'Your remains' });
  });

  it('the bag shape is the remains’ alone, so no other kind shares its shape and colour', () => {
    expect(MAP_ICON_KINDS.filter((kind) => MAP_ICONS[kind].shape === 'bag')).toEqual(['remains']);
    expect(MAP_ICON_KINDS.filter((kind) => MAP_ICONS[kind].color === '#f2efe6')).toEqual(['remains']);
  });
});

describe('MapLayers with `open` (SPEC-054 §4.10)', () => {
  // `MapLayers` paints through `document.createElement('canvas')`, and this
  // suite runs in vitest's plain `node` environment (SPEC-001 §4: no `three`,
  // and here no DOM either) — so this is just enough of the 2D canvas API for
  // `#buildOpenTerrain` to run, recording what was drawn in painter's-algorithm
  // order. `colorAt` then answers the same question a real `getImageData`
  // would: the last shape covering a point decides its colour.
  interface FakeOp {
    test: (x: number, y: number) => boolean;
    style: string;
  }

  class FakeContext {
    fillStyle = '';
    strokeStyle = '';
    lineWidth = 1;
    lineCap = 'butt';
    readonly #ops: FakeOp[] = [];
    #circles: { cx: number; cy: number; r: number }[] = [];
    #segments: { x0: number; y0: number; x1: number; y1: number }[] = [];
    #cur = { x: 0, y: 0 };

    beginPath(): void {
      this.#circles = [];
      this.#segments = [];
    }

    moveTo(x: number, y: number): void {
      this.#cur = { x, y };
    }

    lineTo(x: number, y: number): void {
      this.#segments.push({ x0: this.#cur.x, y0: this.#cur.y, x1: x, y1: y });
      this.#cur = { x, y };
    }

    arc(cx: number, cy: number, r: number): void {
      this.#circles.push({ cx, cy, r });
    }

    fillRect(x: number, y: number, w: number, h: number): void {
      const style = this.fillStyle;
      this.#ops.push({ test: (px, py) => px >= x && px < x + w && py >= y && py < y + h, style });
    }

    /** The fog canvas's first clear; this suite never reads the fog layer. */
    clearRect(): void {}

    fill(): void {
      const style = this.fillStyle;
      for (const { cx, cy, r } of this.#circles) {
        this.#ops.push({ test: (px, py) => Math.hypot(px - cx, py - cy) <= r, style });
      }
    }

    stroke(): void {
      const style = this.strokeStyle;
      const half = this.lineWidth / 2;
      for (const { x0, y0, x1, y1 } of this.#segments) {
        this.#ops.push({
          test: (px, py) => {
            const dx = x1 - x0;
            const dy = y1 - y0;
            const lenSq = dx * dx + dy * dy;
            if (lenSq === 0) return Math.hypot(px - x0, py - y0) <= half;
            const t = ((px - x0) * dx + (py - y0) * dy) / lenSq;
            if (t < 0 || t > 1) return false;
            return Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy)) <= half;
          },
          style,
        });
      }
    }

    /** Painter's algorithm: the last op covering `(x, y)` wins, or `undefined` if none do. */
    colorAt(x: number, y: number): string | undefined {
      let found: string | undefined;
      for (const op of this.#ops) if (op.test(x, y)) found = op.style;
      return found;
    }
  }

  function fakeCanvas(): { width: number; height: number; getContext: () => FakeContext } {
    const ctx = new FakeContext();
    return { width: 0, height: 0, getContext: () => ctx };
  }

  /** `MapLayers` is the only thing in this suite that touches `document`. */
  function withFakeDocument<T>(run: () => T): T {
    (globalThis as { document?: unknown }).document = {
      createElement: (tag: string) => {
        if (tag !== 'canvas') throw new Error(`the stub only makes canvases, not ${tag}`);
        return fakeCanvas();
      },
    };
    try {
      return run();
    } finally {
      delete (globalThis as { document?: unknown }).document;
    }
  }

  it('paints black outside the rooms, the ground colour inside one, and the walls darker on top', () => {
    withFakeDocument(() => {
      const palette = { ground: '#336644', accent: '#ffaa00' };
      const half = 48;
      const layout: TerrainLayout = {
        halfSize: half,
        obstacles: [{ x: -20, z: 0, radius: 2, kind: 'cave_wall' }],
        pois: [],
        shelters: [],
      };
      const open: MapOpen = {
        rooms: [
          { x: -20, z: 0, r: 8 },
          { x: 20, z: 0, r: 8 },
        ],
        corridors: [{ a: 0, b: 1 }],
        width: 4.5,
      };
      const layers = new MapLayers(layout, palette, open);
      const ctx = layers.terrain.getContext('2d') as unknown as FakeContext;

      const ground = shade(palette.ground, GROUND_SHADE);
      const obstacle = shade(palette.ground, OBSTACLE_SHADE);

      // Outside every room, and outside the corridor's 2.25 m half-width either
      // along or across it: black.
      expect(ctx.colorAt(half + 40, half + 40)).toBe(OPEN_VOID_COLOR);
      expect(ctx.colorAt(half + 0, half + 20)).toBe(OPEN_VOID_COLOR);
      expect(ctx.colorAt(half + 0, half + 3)).toBe(OPEN_VOID_COLOR);

      // Inside room A, clear of the wall: the ground colour.
      expect(ctx.colorAt(half - 15, half + 0)).toBe(ground);
      // On the corridor's centreline, between the two rooms: the ground colour.
      expect(ctx.colorAt(half + 0, half + 0)).toBe(ground);
      // The wall sits on room A's centre and paints over it, darker, on top.
      expect(ctx.colorAt(half - 20, half + 0)).toBe(obstacle);

      // §4.8: the open path still counts as exactly one terrain build.
      expect(layers.terrainBuilds).toBe(1);
    });
  });
});
