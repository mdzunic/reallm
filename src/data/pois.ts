// Points of interest (SPEC-009 §4.5). The *definitions* — kind, count, band,
// radius — belong to the planet that places them, because the same landing pad
// is a different band on every world. What lives here is the id universe and
// the one thing that is genuinely per-id rather than per-planet: the label the
// HUD and the mission log print.
//
// Keeping the labels here rather than inline in `planets.ts` means the name of
// a POI is written once, and `PoiId` has a table to be `keyof typeof` of (§3).
//
// Data modules are plain objects: no imports, no functions (SPEC-001 §4, §8).

export const POI_LABELS = {
  /** Every planet has exactly one, at band [0, 0] (invariant §7.10). */
  landing_pad: 'Landing Pad',

  // Cinder-4
  dune_sea: 'Dune Sea',
  beacon: 'Survey Beacon',
  silo_ruin: 'Grain Silo',
  wurm_nest: 'Wurm Nest',
  ruin: 'Buried Ruin',

  // Vetra
  ridge_camp: 'Ridge Camp',
  thermal_vent: 'Thermal Vent',
  crash_site: 'Crash Site',
  survivor_pod: 'Survivor Pod',
  glacier_heart: 'Glacier Heart',
  ice_spire: 'Ice Spire',

  // Thessaly
  probe_site: 'Probe Site',
  hive_mouth: 'Hive Mouth',
  terraform_tower: 'Terraform Tower',
  overgrown_ruin: 'Overgrown Ruin',

  // Ferrum
  lithium_flats: 'Lithium Flats',
  reactor_core: 'Reactor Core',
  core_drill: 'Core Drill',
  lava_vent: 'Lava Vent',

  // The Hive
  queen_chamber: 'Queen Chamber',
  egg_cluster: 'Egg Cluster',

  // Eden-Prime
  eden_spring: 'Spring',
  eden_forest: 'Old Forest',
  eden_ridge: 'High Ridge',
  survey_beacon: 'Survey Beacon',
  grove: 'Grove',
} as const;

export type PoiId = keyof typeof POI_LABELS;
