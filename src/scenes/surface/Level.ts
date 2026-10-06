// The level abstraction (SPEC-054 §3, §4.1). The surface scene holds one level
// per layout — the planet's surface, and the cave below it once a visit has
// gone down — and every read of the layout, the POIs, the shelters, the nodes,
// the pad terminal, the explored mask, the map layers and the clamp goes
// through the active one. So the cave can share the scene (one visit, one
// landing, one world) without a cave position ever reaching a surface POI's
// objective or the pad terminal (§1, Why).
import type { ExploreMask } from '@/systems/Exploration';
import type { Interactable } from '@/systems/Interactables';
import type { Layout, LayoutPoi, LayoutShelter, ObstacleGrid } from '@/systems/Layout';
import type { Nodes } from '@/systems/Pickups';
import type { UndergroundLayout } from '@/systems/Underground';
import type { MapLayers } from '@/ui/MapLayers';

export type LevelId = 'surface' | 'underground';

/** SPEC-012 §4.12: one POI's runtime state — discovery, the edge of its radius, the scan. */
export interface PoiState {
  poi: LayoutPoi;
  discovered: boolean;
  inside: boolean;
  /** Seconds accumulated toward the hands-free scan. */
  scanFor: number;
  scanned: boolean;
}

export interface Level {
  readonly id: LevelId;
  readonly layout: Layout | UndergroundLayout;
  /** The combat world's grid on this level (the surface's carries the parked tug, SPEC-046 §4.8). */
  readonly grid: ObstacleGrid;
  /** `halfSize − WALL_INSET`: the player clamp and `CombatWorld.bounds`. */
  readonly bounds: number;
  /** POI runtime states; [] below. */
  readonly pois: PoiState[];
  readonly shelters: readonly LayoutShelter[]; // [] below
  readonly nodes: Nodes | null; // null below
  /** The pad terminal's circle; null below. */
  readonly terminal: { x: number; z: number; radius: number } | null;
  readonly interactables: Interactable[];
  readonly mask: ExploreMask;
  readonly layers: MapLayers;
  /** The landing pad's POI, and the boss arena's; both null below. */
  readonly pad: LayoutPoi | null;
  readonly arena: LayoutPoi | null;
}
