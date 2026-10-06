// Resume where you were (SPEC-059 §4.1). Pure: no DOM, no `three`, no clock
// of its own. A save that was interrupted on a planet carries
// `progress.resume` (SPEC-047's field, written by the surface on entry and at
// every pause); this decides where Continue and the Load list land it — the
// planet's pad, or the station — how long the player has been away, and what
// the "previously" card says after a day away.
import type { Save } from '@/core/Save';
import { CHAPTER_CARDS, MISSIONS, PLANET_IDS, PLANETS, type MissionDef, type MissionId, type PlanetId } from '@/data/index';
import { missingRequirements } from '@/systems/Economy';
import { stage } from '@/systems/Format';
import { endingPending } from '@/systems/StoryBeats';
import { storyContextOf } from '@/systems/StoryContext';
import { missionStatus, padEmptyText, pinnedMission } from '@/systems/UiHelpers';

/** §4.1.3: away this long, and Continue or Load shows the "previously" card first. */
export const RESUME_WINDOW_MS = 86_400_000; // 24 h

export type ResumeTarget = { readonly scene: 'station' } | { readonly scene: 'surface'; readonly planet: PlanetId };

/** The schema-typed view of the mission table, for the loops below. */
const MISSION_TABLE: Readonly<Record<MissionId, MissionDef>> = MISSIONS;

/** The card's mission list: at most this many lines, then `+<k> more`. */
const CARD_MISSIONS = 3;

/**
 * §4.1.2: the planet's pad when the save carries a resume point — unless an
 * owed ending must replay at the station (E29), or the planet is locked to
 * this save outside service mode (59-c). The station otherwise, as before.
 */
export function resumeTarget(save: Save, serviceMode: boolean): ResumeTarget {
  const resume = save.progress.resume;
  if (resume === null) return { scene: 'station' };
  if (endingPending(new Set(save.progress.flags), save.progress.endingSeen) !== null) return { scene: 'station' };
  if (!serviceMode && missingRequirements(save, PLANETS[resume.planet].unlock).length > 0) return { scene: 'station' };
  return { scene: 'surface', planet: resume.planet };
}

/**
 * §4.1.2: now − the later of the last write and the resume point, never below
 * 0 — a clock that went backwards, or a stamp in the future, reads 0 (59-d).
 */
export function awayMs(save: Save, now: number): number {
  const since = Math.max(save.meta.updatedAt, save.progress.resume?.at ?? 0);
  return Math.max(0, now - since);
}

/** §4.1.4: the "previously" card's four parts, top to bottom. */
export interface PreviouslyCard {
  /** `Chapter 2 — Water, under a mile of ice.` */
  readonly chapter: string;
  /** `Resuming at the Vetra landing pad`, or `Resuming at Command Relay`. */
  readonly where: string;
  /** `Whiteout — Stage 1/2 · Tracked`, …; at most three, then `+<k> more`. */
  readonly missions: readonly string[];
  /** `Next: …` */
  readonly next: string;
}

/** `Chapter <n> — <line>`, with the chapter card's line of the planet whose chapter is `n`. */
function chapterLine(save: Save): string {
  const chapter = storyContextOf(save).chapter;
  const planet = PLANET_IDS.find((id) => CHAPTER_CARDS[id].chapter === chapter);
  return planet === undefined ? `Chapter ${chapter}` : `Chapter ${chapter} — ${CHAPTER_CARDS[planet].line}`;
}

/** One active entry: `<title> — Stage n/m`, the stage counted from 1. */
function stageLine(def: MissionDef, entryStage: number): string {
  return `${def.title} — ${stage(entryStage + 1, def.stages.length)}`;
}

/** §4.1.4: the card for `save`, landing at `target`. */
export function previouslyCard(save: Save, target: ResumeTarget): PreviouslyCard {
  const active = save.progress.missionsActive;
  const tracked = pinnedMission(save);
  const missions: string[] = [];
  for (const entry of active.slice(0, CARD_MISSIONS)) {
    const line = stageLine(MISSION_TABLE[entry.id], entry.stage);
    missions.push(entry.id === tracked ? `${line} · Tracked` : line);
  }
  if (active.length > CARD_MISSIONS) missions.push(`+${active.length - CARD_MISSIONS} more`);
  if (active.length === 0) missions.push('No mission in progress');
  return {
    chapter: chapterLine(save),
    where: target.scene === 'surface' ? `Resuming at the ${PLANETS[target.planet].name} landing pad` : 'Resuming at Command Relay',
    missions,
    next: nextStepText(save, target),
  };
}

/**
 * §4.1.4: the next step, the first that applies — on a surface target, the
 * planet's first active surface mission, else the first surface mission its
 * pad offers (SPEC-035's line), else R16's empty-pad sentence; at the
 * station, SPEC-044's way to the tracked mission, else the board.
 */
export function nextStepText(save: Save, target: ResumeTarget): string {
  if (target.scene === 'surface') {
    const planet = target.planet;
    for (const entry of save.progress.missionsActive) {
      const def = MISSION_TABLE[entry.id];
      if (def.planet !== planet || def.scene !== 'surface') continue;
      return `Next: continue '${def.title}' — ${stage(entry.stage + 1, def.stages.length)}`;
    }
    for (const def of Object.values(MISSION_TABLE)) {
      if (def.planet !== planet || def.scene !== 'surface') continue;
      if (missionStatus(save, def, 'surface') === 'available') return `Next: ${def.title} — at the pad terminal`;
    }
    return padEmptyText(save, planet);
  }
  const tracked = pinnedMission(save);
  if (tracked === null) return 'Next: accept a mission on the board';
  const def = MISSION_TABLE[tracked];
  return `Next: Star Map → depart for ${PLANETS[def.planet].name}${def.scene === 'flight' ? '; the mission runs during the flight' : ''}`;
}
