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
  storm: {
    keyboard: 'A storm is ten seconds out. It hurts and slows you — Q heals, a coolant pack blocks it.',
    touch: 'A storm is ten seconds out. It hurts and slows you — ITEM heals, a coolant pack blocks it.',
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
  heavy: {
    keyboard: 'Launchers recharge while holstered: 3 to fire, then back to work.',
    touch: 'Tap the launcher to fire; it hands back and recharges by itself.',
  },
  explosives: {
    keyboard: 'G throws grenades at the cursor and plants mines at your feet.',
    touch: 'Tap the explosive slot to throw at the nearest enemy or plant a mine.',
  },
};

export interface HintText {
  /** Shown at stuck level 2; may carry placeholders. */
  readonly nudge: string;
  /** Used when `nudge`'s placeholders cannot all be filled (D-13). */
  readonly fallback?: string;
}

/**
 * §4.8 — the escalation line per objective kind (*initial tuning*), plus the
 * two the scene raises itself: `death` after a second death on one stage, and
 * `none` when no mission is running.
 */
export const HINTS: Readonly<Record<Objective['kind'] | 'death' | 'none', HintText>> = {
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
  survive: {
    nudge: 'Stay alive {need} more seconds. Keep moving, and heal when you drop low.',
    fallback: 'Stay alive {need} more seconds. Keep moving, and heal when you drop low.',
  },
  defend: { nudge: 'Stay by {label} and kill whatever reaches it.' },
  deliver: { nudge: '{label} is {dist} {dir}. You need {need} more {resource}.' },
  escort: { nudge: 'The probe follows you — lead it to {label}, {dist} {dir}.' },
  choice: { nudge: 'A call is waiting on you — open the prompt and choose.' },
  death: { nudge: 'Dying twice here? Q heals, armor helps, and casual difficulty is in Settings.' },
  none: {
    nudge: 'No mission running. The pad terminal has work — {dist} {dir}.',
    fallback: 'No mission running. The pad terminal has work.',
  },
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
    0: 'The nest is {dist} {dir}, marked in red. The wurm burrows — move when the ground shakes.',
    1: 'Carry {amount} oil to {label}, {dist} {dir}.',
  },
  c1_s1: {
    0: 'Wheat grows at the yellow nodes; {label} is {dist} {dir}.',
  },
  c1_s2: {
    0: 'Skitters swarm near the pad — thin them there.',
    1: 'Survive the heat — it bites harder without armor.',
  },
};
