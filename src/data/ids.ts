// Shared content ids. SPEC-009 lands the full planet table in `data/planets.ts`;
// scene params (SPEC-003 §3) only need the id union, so the ids live here with
// the other cross-cutting ones. Order and spelling follow PLAN §5.
//
// Data modules are plain objects: no imports, no functions (SPEC-001 §4, §8).

export const PLANET_IDS = ['cinder4', 'vetra', 'thessaly', 'ferrum', 'hive', 'eden'] as const;

export type PlanetId = (typeof PLANET_IDS)[number];
