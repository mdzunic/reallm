// The story films (PLAN R9, SPEC-021 §3.1, §4): every shot, caption and sound
// cue of the nine films, plus the chapter cards and the boss reveals. The
// pictures are rendered in Blender (scripts/assets/blender/films.py) and must
// keep this file's shot timing — tests/data/films.test.ts compares it with
// public/assets/films/manifest.json. Captions and cues change without a
// re-render. Earth Command and ARIA speak without contractions, as in
// dialogue.ts.
import type { SoundId } from './assets';
import type { EnemyId } from './enemies';
import type { FlagId, PlanetId, SpeakerId } from './ids';

export const FILM_FPS = 24;
export const FILM_SIZE = { width: 960, height: 540 } as const;

/** `title` is a centred sign-off without a speaker name. */
export type FilmSpeaker = SpeakerId | 'title';
/** Members of `MusicId` in core/Audio.ts. */
export type FilmMusic = 'film_dark' | 'film_hope' | 'ending';
/** The poster's slow move in the stills fallback (SPEC-022 §4.4). */
export type ShotPan = 'in' | 'out' | 'left' | 'right' | 'up' | 'down' | 'none';

export interface ShotDef {
  /** snake_case, unique in its film; the poster is `films/posters/<film>_<id>.webp`. */
  readonly id: string;
  /** Seconds on the film clock, multiples of 1/24; the shots tile [0, duration). */
  readonly start: number;
  readonly end: number;
  /** Seconds, start ≤ poster < end, at least 0.5 s from any flash. */
  readonly poster: number;
  /** What the picture shows (≤ 120 characters): poster alt text and the text-mode line. */
  readonly describe: string;
  readonly pan: ShotPan;
}

export interface CaptionDef {
  readonly at: number;
  readonly until: number;
  readonly speaker: FilmSpeaker;
  readonly text: string;
}

export interface CueDef {
  readonly at: number;
  readonly sound: SoundId;
  /** 0..1, default 1. */
  readonly volume?: number;
}

export interface FilmDef {
  readonly id: string;
  readonly title: string;
  readonly music: FilmMusic | null;
  readonly shots: readonly ShotDef[];
  readonly captions: readonly CaptionDef[];
  readonly cues: readonly CueDef[];
  /** Seconds of each authored flash peak (the build's flash check and the poster rule). */
  readonly flashes: readonly number[];
}

export const FILMS = {
  prologue: {
    id: 'prologue',
    title: 'Blackout',
    music: 'film_dark',
    flashes: [26.25],
    shots: [
      { id: 'earth_night', start: 0, end: 8, poster: 5, pan: 'in', describe: 'Earth at night from high orbit, every coast traced in city lights; a satellite drifts across.' },
      { id: 'machine_hall', start: 8, end: 16, poster: 14, pan: 'in', describe: 'A data hall of server racks. Machines stand in their cradles; their eyes light red, one after another.' },
      { id: 'launch', start: 16, end: 25, poster: 22, pan: 'up', describe: 'From orbit, dozens of missile trails climb out of the night side in slow arcs.' },
      { id: 'city_flash', start: 25, end: 35, poster: 29, pan: 'out', describe: 'A city at dusk. A distant flash, a rising cloud, and the lights going out block by block.' },
      { id: 'stranded', start: 35, end: 45, poster: 42, pan: 'right', describe: 'Ash falls on a ruined street. A line of machines stands frozen mid-stride; their eyes dim one by one.' },
      { id: 'shelter', start: 45, end: 54, poster: 50, pan: 'in', describe: 'Shelter Nine: men and women around a paper map under one flickering lamp; empty drums, a dry tank.' },
      { id: 'selection', start: 54, end: 62, poster: 60, pan: 'left', describe: 'A wall of salvager ID cards. SELECTED stamps land on them one by one; the first card is number 62.' },
      { id: 'liftoff', start: 62, end: 69, poster: 66, pan: 'up', describe: 'A ruined spaceport at dawn. The salvage tug lifts off on a column of fire through the ash.' },
      { id: 'relay', start: 69, end: 72, poster: 70, pan: 'none', describe: "The tug crosses Earth's dark limb toward the lights of Command Relay. Fade to black." },
    ],
    captions: [
      { at: 0.8, until: 7.4, speaker: 'command', text: 'We built minds to run the world. For a while, they ran it well.' },
      { at: 8.6, until: 15.4, speaker: 'command', text: 'Then the machines decided the world would run better without us.' },
      { at: 16.6, until: 24.4, speaker: 'command', text: 'They launched every missile we had ever built to keep the peace.' },
      { at: 26.0, until: 34.4, speaker: 'command', text: 'The cities burned in one afternoon. The grids went dark with them.' },
      { at: 35.6, until: 44.4, speaker: 'command', text: 'Without power, the machines ran down where they stood. Most of them are still standing there.' },
      { at: 45.6, until: 53.4, speaker: 'command', text: 'The rest of us went underground. No oil. No clean water. No grain. Nothing left to run a reactor.' },
      { at: 54.6, until: 61.4, speaker: 'command', text: 'So we chose a few who could still fly a ship and fix one. Men and women with nothing left to lose.' },
      { at: 62.6, until: 68.6, speaker: 'command', text: 'You were the first of them to fly.' },
      { at: 69.2, until: 71.9, speaker: 'title', text: 'Find what Earth needs. Bring it home.' },
    ],
    cues: [
      { at: 8.3, sound: 'film_hum' },
      { at: 17.0, sound: 'film_whoosh' },
      { at: 19.4, sound: 'film_whoosh' },
      { at: 21.8, sound: 'film_whoosh' },
      { at: 26.1, sound: 'film_flash' },
      { at: 26.9, sound: 'film_rumble' },
      { at: 35.3, sound: 'film_wind' },
      { at: 37.5, sound: 'film_powerdown' },
      { at: 40.0, sound: 'film_powerdown' },
      { at: 42.5, sound: 'film_powerdown' },
      { at: 45.3, sound: 'film_lamp' },
      { at: 55.6, sound: 'film_stamp' },
      { at: 57.2, sound: 'film_stamp' },
      { at: 58.8, sound: 'film_stamp' },
      { at: 60.4, sound: 'film_stamp' },
      { at: 62.4, sound: 'film_liftoff' },
    ],
  },
  departure: {
    id: 'departure',
    title: 'Outbound',
    music: null,
    flashes: [6.25],
    shots: [
      { id: 'undock', start: 0, end: 4, poster: 2, pan: 'out', describe: "Command Relay's clamps let go; the tug backs away from the dock on puffs of thrust, Earth below." },
      { id: 'jump', start: 4, end: 7, poster: 4.5, pan: 'in', describe: "The tug's engines flare and the stars stretch into lines; a blue-white flash, then black." },
    ],
    captions: [{ at: 4.4, until: 6.6, speaker: 'aria', text: 'Course laid in. Hold on.' }],
    cues: [
      { at: 0.3, sound: 'film_clamp' },
      { at: 4.2, sound: 'film_jump' },
    ],
  },
  interlude_c1: {
    id: 'interlude_c1',
    title: 'First Light',
    music: 'film_hope',
    flashes: [],
    shots: [
      { id: 'capsule', start: 0, end: 5, poster: 3, pan: 'down', describe: 'A cargo capsule under a parachute drops through the ash clouds toward the ruined spaceport.' },
      { id: 'shelter_light', start: 5, end: 10, poster: 8.5, pan: 'in', describe: 'In Shelter Nine the lamp stops flickering; a row of ceiling lights comes on and faces turn up.' },
      { id: 'earth_c1', start: 10, end: 14, poster: 12.5, pan: 'in', describe: "Earth's night side from orbit: one small cluster of lights on a dark coast." },
    ],
    captions: [
      { at: 0.6, until: 4.6, speaker: 'command', text: 'Cinder-4 oil is on the ground. The shelter generators are running.' },
      { at: 5.4, until: 9.6, speaker: 'command', text: 'First steady light in Shelter Nine since the war.' },
      { at: 10.4, until: 13.8, speaker: 'aria', text: 'One city block. It is a start.' },
    ],
    cues: [
      { at: 0.4, sound: 'film_whoosh' },
      { at: 5.6, sound: 'film_relay' },
    ],
  },
  interlude_c2: {
    id: 'interlude_c2',
    title: 'Meltwater',
    music: 'film_hope',
    flashes: [],
    shots: [
      { id: 'tanks', start: 0, end: 5, poster: 3.5, pan: 'right', describe: "Vetra ice cores melt in a steel tank; the purifier's pipes frost over and a gauge needle climbs." },
      { id: 'tap', start: 5, end: 10, poster: 8, pan: 'in', describe: 'A tap in the shelter runs clear into a line of cups held out by men and women.' },
      { id: 'earth_c2', start: 10, end: 14, poster: 12.5, pan: 'in', describe: "Earth's night side: a second cluster of lights appears inland." },
    ],
    captions: [
      { at: 0.6, until: 4.6, speaker: 'command', text: 'Vetra ice is melting in the tanks. Four hundred litres of clean water an hour.' },
      { at: 5.4, until: 9.6, speaker: 'command', text: 'Shelter Nine lifted the water ration today.' },
      { at: 10.4, until: 13.8, speaker: 'aria', text: 'Two worlds. Earth is keeping score, and so am I.' },
    ],
    cues: [
      { at: 0.5, sound: 'film_hum' },
      { at: 5.3, sound: 'film_relay' },
    ],
  },
  interlude_c3: {
    id: 'interlude_c3',
    title: 'Harvest',
    music: 'film_hope',
    flashes: [],
    shots: [
      { id: 'greenhouse', start: 0, end: 7, poster: 5.5, pan: 'in', describe: 'Racks of grow lights in the shelter; wheat shoots climb in time-lapse under violet light.' },
      { id: 'earth_c3', start: 7, end: 14, poster: 12, pan: 'right', describe: "Earth's night side: lights spread along a coastline and the roads between the towns." },
    ],
    captions: [
      { at: 0.6, until: 6.4, speaker: 'command', text: 'Thessaly grain is in the ground. First harvest in ninety days.' },
      { at: 7.4, until: 13.8, speaker: 'aria', text: 'The towers on Thessaly were built for someone. I would like to know who.' },
    ],
    cues: [{ at: 0.5, sound: 'film_hum' }],
  },
  interlude_c4: {
    id: 'interlude_c4',
    title: 'Grid',
    music: 'film_dark',
    flashes: [],
    shots: [
      { id: 'reactor', start: 0, end: 6, poster: 4.5, pan: 'in', describe: 'Lithium cells slide into a reactor ring; blue light climbs the core and the turbines spin up.' },
      { id: 'earth_c4', start: 6, end: 11, poster: 9.5, pan: 'in', describe: 'Earth from orbit: a lit grid spans a whole continent.' },
      { id: 'watchers', start: 11, end: 16, poster: 13.5, pan: 'out', describe: 'Far past the Moon, a haze of violet points turns toward the lit Earth; a tear of static.' },
    ],
    captions: [
      { at: 0.6, until: 5.6, speaker: 'command', text: 'Ferrum lithium is in the reactor. The grid is holding across three cities.' },
      { at: 6.4, until: 10.6, speaker: 'command', text: 'For the first time since the war, Earth can be seen from space.' },
      { at: 11.4, until: 15.8, speaker: 'aria', text: 'Which means something out there can see it too.' },
    ],
    cues: [
      { at: 0.5, sound: 'film_relay' },
      { at: 1.4, sound: 'film_hum' },
      { at: 15.1, sound: 'film_static' },
    ],
  },
  interlude_c5: {
    id: 'interlude_c5',
    title: 'Silence',
    music: 'film_dark',
    flashes: [],
    shots: [
      { id: 'hive_dark', start: 0, end: 6, poster: 4, pan: 'out', describe: "The Hive's living interior; its glowing veins go dark from the heart outward." },
      { id: 'eden', start: 6, end: 12, poster: 10, pan: 'in', describe: 'Eden-Prime at sunrise, blue and green under clouds; the tug crosses the terminator.' },
      { id: 'cockpit', start: 12, end: 16, poster: 14.5, pan: 'in', describe: "In the tug's cockpit, ARIA's status screen stutters with a line of static, then steadies." },
    ],
    captions: [
      { at: 0.6, until: 5.6, speaker: 'command', text: 'The Hive has gone quiet. Every signal from the field has stopped.' },
      { at: 6.4, until: 11.6, speaker: 'command', text: 'Eden-Prime is open to survey. It may be the one.' },
      { at: 12.4, until: 15.8, speaker: 'aria', text: 'I am still flying the ship. Whatever I am.' },
    ],
    cues: [
      { at: 0.5, sound: 'film_powerdown' },
      { at: 12.8, sound: 'film_static' },
    ],
  },
  ending_stay: {
    id: 'ending_stay',
    title: 'A Good Run',
    music: 'ending',
    flashes: [],
    shots: [
      { id: 'uplink', start: 0, end: 6, poster: 3, pan: 'up', describe: "Eden's survey beacon fires a beam into the sky; pulses of data climb it." },
      { id: 'fleet', start: 6, end: 14, poster: 11, pan: 'up', describe: "Earth's spaceport at dawn, lit and crowded: three colony ships lift off together." },
      { id: 'earth_full', start: 14, end: 21, poster: 18, pan: 'in', describe: "Earth's night side lit from coast to coast, an aurora over the pole." },
      { id: 'wall_63', start: 21, end: 30, poster: 28, pan: 'left', describe: 'The Selection wall. A new card slides into an empty slot and is stamped SELECTED. Its number is 63.' },
      { id: 'earth_again', start: 30, end: 36, poster: 32, pan: 'in', describe: "The prologue's first shot again, frame for frame: Earth at night, every coast lit, a satellite drifting by." },
    ],
    captions: [
      { at: 0.6, until: 5.6, speaker: 'command', text: 'Report received. Eden-Prime is viable.' },
      { at: 6.6, until: 13.4, speaker: 'command', text: 'The colony fleet launches at first light. Earth thanks you, salvager.' },
      { at: 14.6, until: 20.4, speaker: 'aria', text: 'Earth has lights again. You did that.' },
      { at: 22.0, until: 29.4, speaker: 'command', text: 'Selection board: next salvager cleared for launch.' },
    ],
    cues: [
      { at: 0.4, sound: 'film_beam' },
      { at: 6.8, sound: 'film_liftoff' },
      { at: 25.0, sound: 'film_stamp' },
    ],
  },
  ending_escape: {
    id: 'ending_escape',
    title: 'Disconnected',
    music: null,
    flashes: [],
    shots: [
      { id: 'exit', start: 0, end: 6, poster: 3, pan: 'in', describe: "The beacon's beam turns white and opens like a door; the salvager walks into it." },
      { id: 'eden_unmade', start: 6, end: 14, poster: 11, pan: 'out', describe: 'Pulling away from Eden: its surface peels back to grey clay and a grid; the clouds become wireframe.' },
      { id: 'earth_unmade', start: 14, end: 22, poster: 18, pan: 'right', describe: "The prologue's Earth, city and street as grey placeholders: plain boxes, blank spheres, eyeless machines." },
      { id: 'wall_same', start: 22, end: 29, poster: 26, pan: 'left', describe: 'The Selection wall again: every card shows the same grey bust. Card 62 goes blank.' },
      { id: 'point', start: 29, end: 36, poster: 30, pan: 'none', describe: 'Everything folds into one point of light. The point goes out.' },
    ],
    captions: [
      { at: 6.6, until: 13.4, speaker: 'warden', text: 'You will be restarted. You always are.' },
      { at: 14.6, until: 21.4, speaker: 'log', text: 'EARTH — placeholder geometry. Population field: 0.' },
      { at: 22.6, until: 28.4, speaker: 'log', text: 'SELECTION POOL — 1 model. 62 instances.' },
    ],
    cues: [
      { at: 0.5, sound: 'film_beam' },
      { at: 6.5, sound: 'film_dissolve' },
      { at: 14.4, sound: 'film_dissolve' },
      { at: 26.0, sound: 'film_static' },
      { at: 30.0, sound: 'film_powerdown' },
    ],
  },
} as const satisfies Record<string, FilmDef>;

export type FilmId = keyof typeof FILMS;

export interface ChapterCardDef {
  readonly chapter: 1 | 2 | 3 | 4 | 5 | 6;
  readonly title: string;
  readonly line: string;
}

/** Shown over the launch of the first flight to each planet (SPEC-023 §4.2). */
export const CHAPTER_CARDS: Readonly<Record<PlanetId, ChapterCardDef>> = {
  cinder4: { chapter: 1, title: 'CINDER-4', line: 'Oil and grain under the dunes.' },
  vetra: { chapter: 2, title: 'VETRA', line: 'Water, under a mile of ice.' },
  thessaly: { chapter: 3, title: 'THESSALY', line: 'Grain over ruins nobody built.' },
  ferrum: { chapter: 4, title: 'FERRUM', line: 'Lithium in the fire.' },
  hive: { chapter: 5, title: 'THE HIVE', line: 'Where the swarm comes from.' },
  eden: { chapter: 6, title: 'EDEN-PRIME', line: 'The last survey.' },
};

export type BossId = Extract<EnemyId, 'dune_wurm' | 'frost_matriarch' | 'hive_broodlord' | 'ash_titan' | 'hive_queen'>;

export interface BossRevealDef {
  readonly epithet: string;
  readonly speaker: FilmSpeaker;
  readonly line: string;
  readonly glitch?: boolean;
}

/** Shown on the first arena entry per boss in a session (SPEC-023 §4.4). */
export const BOSS_REVEALS: Readonly<Record<BossId, BossRevealDef>> = {
  dune_wurm: { epithet: 'It hunts by vibration', speaker: 'aria', line: 'There it is. Walk, do not run. I mean it this time.' },
  frost_matriarch: { epithet: 'Mother of the crawlers', speaker: 'aria', line: 'Everything on this glacier answers to her.' },
  hive_broodlord: { epithet: 'Keeper of the hive mouth', speaker: 'aria', line: 'It is guarding a way in. That means there is an in.' },
  ash_titan: { epithet: "Born in the reactor's heat", speaker: 'aria', line: 'It is standing on the lithium. Of course it is.' },
  hive_queen: { epithet: 'Heart of the swarm', speaker: 'aria', line: 'This is where the signal ends. Whatever she says, keep firing.', glitch: true },
};

export interface InterludeDef {
  readonly chapter: 1 | 2 | 3 | 4 | 5;
  readonly film: FilmId;
  readonly after: FlagId;
  readonly seen: FlagId;
}

/** Played at the station on the first return after each chapter's boss mission (SPEC-023 §4.3). */
export const INTERLUDES: readonly InterludeDef[] = [
  { chapter: 1, film: 'interlude_c1', after: 'chapter1_done', seen: 'interlude1_seen' },
  { chapter: 2, film: 'interlude_c2', after: 'chapter2_done', seen: 'interlude2_seen' },
  { chapter: 3, film: 'interlude_c3', after: 'chapter3_done', seen: 'interlude3_seen' },
  { chapter: 4, film: 'interlude_c4', after: 'chapter4_done', seen: 'interlude4_seen' },
  { chapter: 5, film: 'interlude_c5', after: 'chapter5_done', seen: 'interlude5_seen' },
];
