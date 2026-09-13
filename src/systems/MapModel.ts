// The map projection and the icon table (SPEC-026 §4.1, §4.2). Pure: no DOM,
// no `three`, no canvas — the two painters (`ui/Minimap.ts` and
// `ui/MapScreen.ts`) only stroke what these functions and this table decide,
// which is what keeps the orientation and the legend testable in node.
//
// The one idea behind the whole file: the camera looks down at a fixed 45° yaw
// (SPEC-012 §4.3), so a north-up map and the view never agree. Both maps
// therefore turn with the camera — map-up *is* screen-up, and that is what the
// game calls north.
import type { PoiDef, ResourceId } from '@/data/index';

/** The camera's yaw, as the rotation both maps apply (§4.1). */
export const MAP_YAW = Math.PI / 4;
/** Metres from the minimap's centre to its rim (initial tuning). */
export const MINIMAP_RANGE = 70;

/** The POI kinds a planet places; `poiIcon` maps each to an icon of its own. */
export type PoiKind = PoiDef['kind'];

export type MapIconKind =
  | 'landing_pad'
  | 'scan'
  | 'reach'
  | 'deliver'
  | 'arena'
  | 'defend'
  | 'escort_start'
  | 'landmark'
  | 'node_oil'
  | 'node_wheat'
  | 'node_water'
  | 'node_lithium'
  | 'enemy'
  | 'elite'
  | 'boss'
  | 'objective'
  | 'player'
  | 'target'
  // The last two are reserved for SPEC-030's shelters; they have their shape
  // and their legend row here so the table is closed, and nothing emits them yet.
  | 'shelter_cave'
  | 'shelter_wreck';

export type MapShape =
  | 'pad'
  | 'dish'
  | 'flag'
  | 'crate'
  | 'skull'
  | 'shield'
  | 'probe'
  | 'diamond'
  | 'drop'
  | 'dot'
  | 'ring'
  | 'arrow'
  | 'cross'
  | 'arch'
  | 'hull';

export interface MapIcon {
  readonly shape: MapShape;
  readonly color: string;
  /** Painted size in CSS px at 1× device pixel ratio (§4.2, initial tuning). */
  readonly size: number;
  readonly label: string;
}

/**
 * §4.2 — shapes first, colours second (SPEC-014 §4.10): every kind is told
 * apart by its outline at 8 px, and no two kinds share both a shape and a
 * colour, so a colour-blind player never has to read hue alone. The four node
 * kinds are the one place a shape repeats, and the full map writes each
 * resource's initial next to it.
 */
export const MAP_ICONS: Readonly<Record<MapIconKind, MapIcon>> = {
  landing_pad: { shape: 'pad', color: '#4fe0ff', size: 12, label: 'Landing pad — terminal, return to ship' },
  scan: { shape: 'dish', color: '#8fd3a8', size: 10, label: 'Scan site' },
  reach: { shape: 'flag', color: '#c9b6ff', size: 10, label: 'Waypoint' },
  deliver: { shape: 'crate', color: '#f0b36a', size: 10, label: 'Delivery point' },
  arena: { shape: 'skull', color: '#ff5a4a', size: 11, label: 'Boss arena' },
  defend: { shape: 'shield', color: '#6fb0ff', size: 11, label: 'Defend point' },
  escort_start: { shape: 'probe', color: '#5fd7c3', size: 10, label: 'Escort start' },
  landmark: { shape: 'diamond', color: '#9aa6b2', size: 7, label: 'Landmark' },
  node_oil: { shape: 'drop', color: '#ffb347', size: 8, label: 'Oil node' },
  node_wheat: { shape: 'drop', color: '#f2d55c', size: 8, label: 'Wheat node' },
  node_water: { shape: 'drop', color: '#59b8ff', size: 8, label: 'Water node' },
  node_lithium: { shape: 'drop', color: '#c58cff', size: 8, label: 'Lithium node' },
  enemy: { shape: 'dot', color: '#ff4d4d', size: 5, label: 'Enemy' },
  elite: { shape: 'dot', color: '#ffcc4d', size: 7, label: 'Elite' },
  boss: { shape: 'skull', color: '#ff2d2d', size: 14, label: 'Boss' },
  objective: { shape: 'ring', color: '#ffc857', size: 6, label: 'Objective' },
  player: { shape: 'arrow', color: '#ffffff', size: 12, label: 'You' },
  target: { shape: 'cross', color: '#ffc857', size: 10, label: 'Current target' },
  shelter_cave: { shape: 'arch', color: '#c8a27a', size: 10, label: 'Cave shelter' },
  shelter_wreck: { shape: 'hull', color: '#a9b8c8', size: 10, label: 'Wreck shelter' },
};

/** Every icon kind, in table order — the legend and the uniqueness test iterate it. */
export const MAP_ICON_KINDS = Object.keys(MAP_ICONS) as MapIconKind[];

export interface MapPoint {
  /** Canvas px from the view centre, x right. */
  x: number;
  /** Canvas px from the view centre, y down. */
  y: number;
  /** False when the point was clamped to `rimPx` (an edge arrow). */
  inside: boolean;
  /** The canvas bearing of the point, `atan2(y, x)` — what an arrow rotates by. */
  angle: number;
}

/**
 * §4.1 — a world offset `(dx, dz)` from the view centre → canvas px from the
 * centre. This is the canvas transform `rotate(+π/4)` applied to world
 * `(x = dx, y = dz)`, which is why the layers can be drawn with exactly that
 * transform and land on the same pixels as the icons.
 *
 * A step of input "up" is world `(−1, −1)/√2` and gives `(0, −1)` — straight up
 * the map. Points past `rimPx` are clamped to the rim circle, keeping their
 * bearing, which is what makes an off-window objective an edge arrow.
 */
export function mapProject(dx: number, dz: number, pxPerMetre: number, rimPx: number, out: MapPoint): MapPoint {
  const u = (dx - dz) * Math.SQRT1_2;
  const v = (dx + dz) * Math.SQRT1_2;
  let x = u * pxPerMetre;
  let y = v * pxPerMetre;
  const distance = Math.hypot(x, y);
  out.angle = Math.atan2(y, x);
  out.inside = distance <= rimPx;
  if (!out.inside && distance > 0) {
    const scale = rimPx / distance;
    x *= scale;
    y *= scale;
  }
  out.x = x;
  out.y = y;
  return out;
}

/**
 * §4.1 with the clamp always on: the bearing of a world offset, put on the rim
 * circle whatever its distance. `mapProject` only clamps what falls outside the
 * window, so a mark that must read as an edge arrow even from inside it —
 * SPEC-027's kill quarry, which is within 60 m of a 70 m rim by definition —
 * needs its own projection rather than a painter that lies about `inside`.
 *
 * The zero offset has no bearing; it lands at angle 0 rather than NaN.
 */
export function mapRimPoint(dx: number, dz: number, rimPx: number, out: MapPoint): MapPoint {
  const u = (dx - dz) * Math.SQRT1_2;
  const v = (dx + dz) * Math.SQRT1_2;
  const angle = Math.atan2(v, u);
  out.angle = angle;
  out.inside = false;
  out.x = Math.cos(angle) * rimPx;
  out.y = Math.sin(angle) * rimPx;
  return out;
}

/** §4.1: a world facing `θ` points along `θ + π/4` on the canvas. */
export function mapAngle(worldAngle: number): number {
  return worldAngle + MAP_YAW;
}

/**
 * §4.2: each POI kind draws as the icon of the same name. A table rather than a
 * cast, so the compiler — not a comment — is what guarantees every kind a
 * planet can place has an icon.
 */
const POI_ICONS: Readonly<Record<PoiKind, MapIconKind>> = {
  landing_pad: 'landing_pad',
  scan: 'scan',
  reach: 'reach',
  deliver: 'deliver',
  arena: 'arena',
  defend: 'defend',
  escort_start: 'escort_start',
  landmark: 'landmark',
};

export function poiIcon(kind: PoiKind): MapIconKind {
  return POI_ICONS[kind];
}

/** §4.2: `node_<resource>` — one shape, four colours, plus an initial on the full map. */
const NODE_ICONS: Readonly<Record<ResourceId, MapIconKind>> = {
  oil: 'node_oil',
  wheat: 'node_wheat',
  water: 'node_water',
  lithium: 'node_lithium',
};

export function nodeIcon(resource: ResourceId): MapIconKind {
  return NODE_ICONS[resource];
}

/**
 * §4.2: the initial the full map writes beside a node — O, W, H, L — so a
 * resource never rides on hue alone. `''` for everything that is not a node,
 * which is also what makes it the node test the painters use.
 */
const NODE_INITIALS: Readonly<Partial<Record<MapIconKind, string>>> = {
  node_oil: 'O',
  node_wheat: 'W',
  node_water: 'H',
  node_lithium: 'L',
};

export function nodeInitial(kind: MapIconKind): string {
  return NODE_INITIALS[kind] ?? '';
}

/** True for the four resource icons — the painters count and label them apart. */
export function isNodeIcon(kind: MapIconKind): boolean {
  return nodeInitial(kind) !== '';
}
