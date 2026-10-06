// What the salvager wears (SPEC-014 §4.2, SPEC-056 §4.6): the eight base
// swatches of each part and the shared portraits that creation offers — the
// Locker offers the same — and the six suit swatches the
// caves hold. A swatch is a primary and a secondary colour pair; opening the
// cache that names one adds its id to `settings.unlocks` — per device, so the
// machine remembers what the instance forgets — and from then on creation's
// rows and the Locker's offer its colours after the base eight
// (`availableSwatches` in `systems/UiHelpers.ts`).
//
// Data modules are plain objects: no imports but other data, no functions
// (SPEC-001 §4, §8).

/** SPEC-014 AC-16: eight primary swatches. Hex the save schema stores verbatim. */
export const PRIMARY_SWATCHES = ['#b7472a', '#2a6db7', '#3e8e4f', '#8e3e8e', '#b7972a', '#7a7a7a', '#a0522d', '#20b2aa'] as const;
/** SPEC-014 AC-16: eight secondary swatches. */
export const SECONDARY_SWATCHES = ['#2a3b4c', '#4c2a3b', '#3b4c2a', '#24243a', '#4c3b2a', '#2e4c4a', '#3d3d3d', '#552a2a'] as const;
/** SPEC-014 AC-15: the three portraits every class may wear, after its own three. */
export const SHARED_PORTRAITS = [9, 10, 11] as const;

/** SPEC-056 §3: one suit swatch — a name of at most 16 characters and two lower-case `#rrggbb` colours. */
export interface SwatchDef<Id extends string = string> {
  readonly id: Id;
  readonly name: string;
  readonly primary: string;
  readonly secondary: string;
}

/**
 * SPEC-056 §4.6 (*initial tuning*): the six swatches, each named by exactly
 * one cache's reward — the five surface relic terminals and Eden's vault.
 */
export const SWATCHES = {
  cinder4_relic: { id: 'cinder4_relic', name: 'Dune Rust', primary: '#c2703d', secondary: '#3a1f0e' },
  vetra_relic: { id: 'vetra_relic', name: 'Glacier', primary: '#9fd3e6', secondary: '#1d3b4a' },
  thessaly_relic: { id: 'thessaly_relic', name: 'Canopy', primary: '#4f7a3a', secondary: '#1f2e12' },
  ferrum_relic: { id: 'ferrum_relic', name: 'Slag', primary: '#5c5a58', secondary: '#4a1c08' },
  eden_relic: { id: 'eden_relic', name: 'Orchard', primary: '#e8e4d4', secondary: '#2f4a22' },
  eden_vault: { id: 'eden_vault', name: 'Checkpoint', primary: '#e6e9ec', secondary: '#3f4852' },
} as const satisfies Record<string, SwatchDef>;

export type SwatchId = keyof typeof SWATCHES;
export type Swatch = SwatchDef<SwatchId>;

/** §4.6: the table's order — the order unlocked colours follow the base eight in. */
export const SWATCH_IDS = ['cinder4_relic', 'vetra_relic', 'thessaly_relic', 'ferrum_relic', 'eden_relic', 'eden_vault'] as const satisfies readonly SwatchId[];
