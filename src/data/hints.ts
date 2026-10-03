// Tip and hint text (SPEC-027 §4.5, §4.8). Two kinds of line, both plain data:
//
// - **tips** teach the controls once per device. Each id has a keyboard and a
//   touch wording, because "press E" means nothing on a phone.
// - **hints** answer "I am lost" for one objective kind, and carry live values
//   through `{…}` placeholders that `fillHint` (systems/Guidance.ts) fills from
//   the focus row and its target. `MISSION_HINTS` replaces a kind's `nudge` for
//   one stage of one mission — chapter 1 is the tutorial, so it says more.
//
// Nothing here names a compass direction: POIs are placed at random angles
// (SPEC-012 §4.2), so a fixed bearing is wrong on most seeds. `{dir}` is
// computed per frame from the map's own north instead, and
// `tests/data/content.test.ts` forbids the four words in briefs and dialogue.
//
// Data modules are plain objects: no imports but other data, no functions
// (SPEC-001 §4, §8).
import type { MissionId, Objective } from '@/data/missions';

/** §3 — the tip universe; SPEC-029 appends its own ids. */
export const TIP_IDS = [
  'move',
  'map',
  'track',
  'pad',
  'scan',
  'harvest',
  'deliver',
  'storm',
  'boss',
  'death',
  // SPEC-028 §4.8: the quick bar, ten seconds after the move tip.
  'quickbar',
  // SPEC-029 §4.9: the first lock, the first heavy weapon, the first explosive.
  'overheat',
  'heavy',
  'explosives',
  // SPEC-030 §4.11: the first entry into any shelter.
  'shelter',
  // SPEC-035 §4.8: the first hit an enemy lands, and the two the first flight
  // needs — the reviewer died twice in four minutes and the rail explained
  // nothing at all.
  'combat',
  'flight_steer',
  'flight_throttle',
  // SPEC-036 §4.12: shown with the zone ghosts of the first touch landings.
  'zones',
  // SPEC-038 §4.9: the first telegraph drawn near the player teaches the dash.
  'dash',
  // SPEC-050 §4.7: the first in-combat sprint, and the Wurm's first burrow.
  'sprint',
  'wurm',
] as const;

export type TipId = (typeof TIP_IDS)[number];

/** §4.8 — every token a hint template may carry; the content test pins it. */
export const HINT_PLACEHOLDERS = ['{label}', '{dir}', '{dist}', '{resource}', '{amount}', '{need}', '{enemy}'] as const;

export type HintPlaceholder = (typeof HINT_PLACEHOLDERS)[number];

export interface TipText {
  readonly keyboard: string;
  readonly touch: string;
}

/** §4.5 — one line per trigger, ≤ 160 characters (content test). */
export const TIPS: Readonly<Record<TipId, TipText>> = {
  move: {
    keyboard: 'WASD moves, the mouse aims, Space or a click fires.',
    touch: 'Drag on the left to move. Drag on the right to aim — or let auto-fire do it.',
  },
  map: {
    keyboard: 'M opens the map. Ground you have walked stays lit.',
    touch: 'Tap the map in the corner to open it.',
  },
  track: {
    keyboard: 'T switches the mission the tracker follows.',
    touch: 'Tap the tracker to switch missions.',
  },
  pad: {
    keyboard: 'The pad terminal takes new missions and flies you home — press E.',
    touch: 'Tap USE on the pad for missions and the flight home.',
  },
  scan: {
    keyboard: 'Hold still inside the ring — a scan takes three seconds.',
    touch: 'Hold still inside the ring — a scan takes three seconds.',
  },
  harvest: {
    keyboard: 'Stand beside a node and it pumps into your hold on its own.',
    touch: 'Stand beside a node and it pumps into your hold on its own.',
  },
  deliver: {
    keyboard: 'A delivery needs the full amount in your hold. Nodes refill slowly.',
    touch: 'A delivery needs the full amount in your hold. Nodes refill slowly.',
  },
  // SPEC-030 §4.11 (D-10): shelters are the storm answer now.
  storm: {
    keyboard: 'A storm is ten seconds out. Caves and wrecks keep it off you — or heal with Q and push through.',
    // SPEC-037 §4.10: the touch layout has no ITEM button; the heal is its slot.
    touch: 'A storm is ten seconds out. Caves and wrecks keep it off you — or tap the heal slot on the bar and push through.',
  },
  boss: {
    keyboard: 'The boss arena is marked in red. Stock up on medkits before you step in.',
    touch: 'The boss arena is marked in red. Stock up on medkits before you step in.',
  },
  death: {
    keyboard: 'You respawn at the pad. Timed objectives restart; your counts are kept.',
    touch: 'You respawn at the pad. Timed objectives restart; your counts are kept.',
  },
  quickbar: {
    keyboard: '1, 2 and 3 switch weapons. Q heals, G throws, C uses gadgets — the bar shows what is left.',
    touch: 'Tap a weapon on the bar to switch. Tap a pack to use it; hold it to choose what goes there.',
  },
  overheat: {
    keyboard: 'The chaingun overheated. Switch to the pistol with 1 while it cools.',
    touch: 'The chaingun overheated — the pistol covers you while it cools.',
  },
  // SPEC-036 §4.6: on touch a tap on the launcher's slot fires one charge.
  heavy: {
    keyboard: 'Launchers recharge while holstered: 3 to fire, then back to work.',
    touch: "Tap the launcher's slot to fire it at the nearest enemy — it recharges by itself.",
  },
  explosives: {
    keyboard: 'G throws grenades at the cursor and plants mines at your feet.',
    touch: 'Tap the explosive slot to throw at the nearest enemy or plant a mine.',
  },
  // SPEC-030 §4.11: shown once, on the first entry into any shelter.
  shelter: {
    keyboard: "Inside, the storm can't touch you, and anything outside loses your trail — until you fire.",
    touch: "Inside, the storm can't touch you, and anything outside loses your trail — until you fire.",
  },
  // SPEC-035 §4.8: shown at the first enemy hit. SPEC-038 §4.7 turned auto-fire
  // on for every scheme, so it teaches what the gun does and how to overrule it.
  combat: {
    keyboard: 'Your gun fires on its own at the nearest enemy. Hold the left mouse button to pick the target yourself.',
    touch: 'Your gun fires on its own at the nearest enemy. Drag on the right to pick the target yourself.',
  },
  // SPEC-035 §4.8: shown when the first flight's launch shot ends…
  flight_steer: {
    keyboard: 'WASD or the mouse steers. Space or a click fires the nose guns.',
    touch: 'Drag to steer — the guns fire on their own.',
  },
  // …and 12 s later, on the same trip. SPEC-036 §4.11: on touch the throttle
  // is the + − pair — a drag on the right is the fire zone, not a throttle.
  // SPEC-045 §4.6: the buttons read + and − (U+2212), since ▲ means a warning.
  flight_throttle: {
    keyboard: 'Shift speeds up and X slows down — the wheel does both.',
    touch: 'Tap + or − to change speed.',
  },
  // SPEC-036 §4.12: taught with the zone ghosts; only the touch wording ever
  // shows, and showing it also records the touch `move` tip it replaces.
  zones: {
    keyboard: 'WASD moves and the mouse aims. Space or a click fires.',
    touch: 'Left thumb moves, right thumb aims — auto-fire shoots for you.',
  },
  // SPEC-038 §4.9: the first `enemy:windup` that draws a telegraph within 25 m.
  dash: {
    keyboard: 'A red lane or ring marks what is about to land. Right-click or V to dash through it — nothing touches you mid-dash.',
    touch: 'A red lane or ring marks what is about to land. Tap DASH to slip through it — nothing touches you mid-dash.',
  },
  // SPEC-050 §4.7: the first in-combat sprint — the run's two prices.
  sprint: {
    keyboard: 'Shift runs. Running is loud and holsters your gun — walk when you want to shoot.',
    touch: 'Push the stick past its ring to run. Running is loud and holsters your gun.',
  },
  // SPEC-050 §4.7: the first `enemy:windup` of kind `burrow` — one wording for both.
  wurm: {
    keyboard: 'It hunts by vibration: walk out of the ring — running pulls it after you.',
    touch: 'It hunts by vibration: walk out of the ring — running pulls it after you.',
  },
};

/**
 * SPEC-042 §4.5 — the death overlay's one tip, by id. `deathTip`
 * (systems/UiHelpers.ts) picks the first row that applies to the cause; the
 * wording pairs like the tips above, ≤ 160 characters (content test).
 */
export type DeathTipId = 'shelter' | 'autofire' | 'heal' | 'craft';

export const DEATH_TIPS: Readonly<Record<DeathTipId, TipText>> = {
  shelter: {
    keyboard: 'Storms cannot reach you in caves and wrecks.',
    touch: 'Storms cannot reach you in caves and wrecks.',
  },
  autofire: {
    keyboard: 'Auto-fire is off — hold Space or the left button to fire, or turn it on in Settings.',
    touch: 'Auto-fire is off — turn it on in Settings.',
  },
  heal: {
    keyboard: 'Heal with Q before the bar turns red.',
    touch: 'Tap the heal slot before the bar turns red.',
  },
  craft: {
    keyboard: 'Craft medkits at the station: wheat and water.',
    touch: 'Craft medkits at the station: wheat and water.',
  },
};

export interface HintText {
  /** Shown at stuck level 2; may carry placeholders. */
  readonly nudge: string;
  /** Used when `nudge`'s placeholders cannot all be filled (D-13). */
  readonly fallback?: string;
  /** SPEC-036 §4.11: the wording on the touch scheme, where it differs. */
  readonly touch?: string;
}

/**
 * §4.8 — the escalation line per objective kind (*initial tuning*), plus the
 * three the scene raises itself: `death` after a second death on one stage,
 * `none` when no mission is running, and `no_work` when none is running and
 * the pad has nothing to give either (PLAN R16, SPEC-012 12-k).
 */
export const HINTS: Readonly<Record<Objective['kind'] | 'death' | 'none' | 'no_work', HintText>> = {
  reach: { nudge: '{label} is {dist} {dir} of you. Follow the gold marker.' },
  scan: { nudge: '{label} is {dist} {dir}. Stand inside its ring for three seconds.' },
  collect: {
    nudge: 'The nearest {resource} node is {dist} {dir}. Stand beside it to pump.',
    fallback: 'No {resource} left in the ground nearby — enemies drop it, and nodes refill.',
  },
  kill: {
    nudge: 'The nearest {enemy} is {dist} {dir}.',
    fallback: 'No {enemy} in sight. They roam — sweep away from the pad.',
  },
  boss: { nudge: 'The arena is {dist} {dir}. Step into the ring to wake it.' },
  // SPEC-030 §4.11 (D-8, D-9): the nudge walks to cover; the fallback keeps
  // its wording for a survive stage with no shelter in reach.
  survive: {
    nudge: "Find cover — {label} is {dist} {dir}. Inside, the storm can't reach you.",
    fallback: 'Stay alive {need} more seconds. Keep moving, and heal when you drop low.',
  },
  defend: { nudge: 'Stay by {label} and kill whatever reaches it.' },
  deliver: { nudge: '{label} is {dist} {dir}. You need {need} more {resource}.' },
  escort: { nudge: 'The probe follows you — lead it to {label}, {dist} {dir}.' },
  choice: { nudge: 'A call is waiting on you — open the prompt and choose.' },
  // SPEC-036 §4.11: Q means nothing on a phone. SPEC-037 §4.10: nor does ITEM,
  // which the touch layout no longer draws. SPEC-048 §4.7: armour, spelt as
  // the game spells it, and casual difficulty — a setting since SPEC-038.
  death: {
    nudge: 'Dying twice here? Q heals, armour helps, and casual difficulty is in Settings.',
    touch: 'Dying twice here? Tap the heal slot on the bar, and armour helps.',
  },
  none: {
    nudge: 'No mission running. The pad terminal has work — {dist} {dir}.',
    fallback: 'No mission running. The pad terminal has work.',
  },
  // The pad is empty: the planet's work starts with a flight mission (The
  // Hive), or the campaign is over. Sending the player there again would be a
  // lie, so the line names the board instead.
  no_work: { nudge: "Nothing to accept at the pad. The station board carries this planet's remaining work." },
};

/**
 * §4.8 — a per-stage replacement for `HINTS[kind].nudge`. Stage keys are
 * 0-based stage indices, matching `MissionState.stage` (D-20); the content test
 * checks every mission exists and every stage is inside its stage count.
 */
export const MISSION_HINTS: Readonly<Partial<Record<MissionId, Readonly<Record<number, string>>>>> = {
  c1_m1: {
    0: 'The pad is {dist} {dir}. Walk to it.',
    1: '{label} is {dist} {dir}. Stand in its ring until the scan completes.',
    2: 'Sixty seconds of sand. Stay alive — heal when it bites.',
  },
  c1_m2: {
    0: 'Stand beside the oil derricks until your hold fills. Raiders keep their distance — close in.',
  },
  c1_m3: {
    // SPEC-050 §4.4: walking out of the ring is the answer, and running is not.
    0: 'The nest is {dist} {dir}, marked in red. When the ground shakes, walk out of the ring — running pulls it after you.',
    1: 'Carry {amount} oil to {label}, {dist} {dir}.',
  },
  c1_s1: {
    0: 'Wheat grows at the yellow nodes; {label} is {dist} {dir}.',
  },
  c1_s2: {
    0: 'Skitters swarm near the pad — thin them there.',
    1: 'Survive the heat — it bites harder without armour.',
  },
};
