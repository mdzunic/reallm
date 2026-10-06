// The story films' script (PLAN R9, SPEC-021 §8): ten checks that keep the data
// in src/data/films.ts, the rendered files and their manifest in step. The
// pictures are rendered by scripts/assets/blender/films.py; captions and cues
// live here and change without a re-render, shot timing does not.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ASSETS,
  BOSS_REVEALS,
  CHAPTER_CARDS,
  DIALOGUE,
  ENEMIES,
  FILMS,
  FILM_FPS,
  INTERLUDES,
  PLANETS,
  PLANET_IDS,
  SPEAKERS,
  STORY_FLAGS,
  type CaptionDef,
  type FilmDef,
  type Enemy,
} from '@/data/index';
import { newSave, validateSave } from '@/core/Save';
import { captionText, DEFAULT_STORY_CONTEXT, type StoryContext } from '@/systems/StoryContext';

const films: readonly FilmDef[] = Object.values(FILMS);
const duration = (film: FilmDef): number => film.shots[film.shots.length - 1]?.end ?? 0;
const onGrid = (seconds: number): boolean => Math.abs(seconds * FILM_FPS - Math.round(seconds * FILM_FPS)) < 1e-6;
const MB = 1024 * 1024;

/**
 * SPEC-048 §4.1: the context every placeholder fills longest in — a
 * 16-character name, iteration 99, chapter 6, the hour and token caps and the
 * largest seed — so a caption is measured as long as it can ever read.
 */
const LONGEST: StoryContext = {
  ...DEFAULT_STORY_CONTEXT,
  name: 'W'.repeat(16),
  iteration: 99,
  chapter: 6,
  playtimeSec: 10_000_000,
  tokens: 1_000_000,
  seed: 0xffffffff,
};

/** The texts a caption can show, each through `captionText` at the longest fill: its own, then each variant held. */
function shownTexts(caption: CaptionDef): string[] {
  const base = captionText({ ...caption, variants: [] }, LONGEST);
  const variants = (caption.variants ?? []).map((variant) =>
    captionText({ ...caption, variants: [{ when: { all: [] }, text: variant.text }] }, LONGEST),
  );
  return [base, ...variants];
}

interface ManifestShot { id: string; start: number; end: number; poster: string; posterBytes: number }
interface ManifestFilm { file: string; frames: number; bytes: number; crf: number; shots: ManifestShot[] }
interface Manifest { version: number; fps: number; width: number; height: number; films: Record<string, ManifestFilm> }

const MANIFEST = Object.values(
  import.meta.glob('../../public/assets/films/manifest.json', { eager: true, import: 'default' }),
)[0] as Manifest | undefined;
const ON_DISK = new Set(
  Object.keys(import.meta.glob('../../public/assets/films/**/*.{mp4,webp}')).map((path) => path.replace('../../public/assets/', '')),
);
const SPRITES = new Set(
  Object.values(ASSETS.audio).flatMap((entry) => ('sprite' in entry ? Object.keys(entry.sprite) : [])),
);
const FILMS_DIR = new URL('../../public/assets/films/', import.meta.url).pathname;

/** Every byte under `dir`: the MP4s, the posters and the manifest. */
function folderBytes(dir: string): number {
  let bytes = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    bytes += entry.isDirectory() ? folderBytes(join(dir, entry.name)) : statSync(join(dir, entry.name)).size;
  }
  return bytes;
}

/** The film and posters of SPEC-063's drop. */
function wreckersBytes(): number {
  const posters = join(FILMS_DIR, 'posters');
  const files = [join(FILMS_DIR, 'wreckers.mp4'),
    ...readdirSync(posters, { withFileTypes: true })
      .filter((entry) => entry.name.startsWith('wreckers_'))
      .map((entry) => join(posters, entry.name))];
  return files.reduce((sum, file) => sum + statSync(file).size, 0);
}

describe('story films (SPEC-021 §8)', () => {
  it('1. names the ten films, each under its own id (SPEC-063 adds `wreckers`)', () => {
    expect(Object.keys(FILMS)).toEqual([
      'prologue', 'departure', 'wreckers', 'interlude_c1', 'interlude_c2', 'interlude_c3', 'interlude_c4', 'interlude_c5',
      'ending_stay', 'ending_escape',
    ]);
    for (const [key, film] of Object.entries(FILMS)) expect(film.id, key).toBe(key);
  });

  it('2. tiles every film with shots on whole frames, posters inside and away from flashes', () => {
    for (const film of films) {
      expect(film.shots[0]?.start, film.id).toBe(0);
      const seen = new Set<string>();
      film.shots.forEach((shot, i) => {
        const where = `${film.id}/${shot.id}`;
        if (i > 0) expect(shot.start, where).toBe(film.shots[i - 1]?.end);
        expect(onGrid(shot.start) && onGrid(shot.end), where).toBe(true);
        expect(shot.id, where).toMatch(/^[a-z][a-z0-9_]*$/);
        expect(seen.has(shot.id), where).toBe(false);
        seen.add(shot.id);
        expect(shot.poster >= shot.start && shot.poster < shot.end, where).toBe(true);
        for (const flash of film.flashes) expect(Math.abs(shot.poster - flash), where).toBeGreaterThanOrEqual(0.5);
      });
    }
  });

  it('3. pins every film length', () => {
    const lengths = Object.fromEntries(films.map((film) => [film.id, duration(film)]));
    expect(lengths).toEqual({
      prologue: 93, departure: 7, wreckers: 12, interlude_c1: 14, interlude_c2: 14, interlude_c3: 14, interlude_c4: 16, interlude_c5: 16,
      ending_stay: 36, ending_escape: 36,
    });
  });

  it('4. keeps every caption inside one shot, apart, short and long enough to read', () => {
    const speakers = new Set<string>([...SPEAKERS, 'title']);
    for (const film of films) {
      film.captions.forEach((caption, i) => {
        const where = `${film.id} caption ${i}`;
        const previous = film.captions[i - 1];
        if (previous !== undefined) expect(caption.at, where).toBeGreaterThanOrEqual(previous.until);
        expect(film.shots.some((shot) => caption.at >= shot.start && caption.until <= shot.end), where).toBe(true);
        // SPEC-048 §4.1: the base and every variant, at the longest fill.
        for (const text of shownTexts(caption)) {
          expect(text.length, where).toBeGreaterThan(0);
          expect(text.length, where).toBeLessThanOrEqual(140);
          expect(caption.until - caption.at, where).toBeGreaterThanOrEqual(1.5 + text.length / 40 - 1e-9);
        }
        expect(speakers.has(caption.speaker), where).toBe(true);
      });
    }
  });

  it('5. cues sounds that exist, in order, inside the film', () => {
    for (const film of films) {
      film.cues.forEach((cue, i) => {
        const where = `${film.id} cue ${i}`;
        const previous = film.cues[i - 1];
        if (previous !== undefined) expect(cue.at, where).toBeGreaterThanOrEqual(previous.at);
        expect(cue.at >= 0 && cue.at < duration(film), where).toBe(true);
        expect(SPRITES.has(cue.sound), where).toBe(true);
        if (cue.volume !== undefined) expect(cue.volume > 0 && cue.volume <= 1, where).toBe(true);
      });
    }
  });

  it('6. keeps descriptions and titles within their limits', () => {
    for (const film of films) {
      expect(film.title.length, film.id).toBeGreaterThan(0);
      for (const shot of film.shots) expect(shot.describe.length, `${film.id}/${shot.id}`).toBeLessThanOrEqual(120);
    }
  });

  it('7. gives every planet a chapter card and every boss a reveal', () => {
    expect(Object.keys(CHAPTER_CARDS).sort()).toEqual([...PLANET_IDS].sort());
    for (const id of PLANET_IDS) expect(CHAPTER_CARDS[id].chapter, id).toBe(PLANETS[id].chapter);
    const bosses = (Object.values(ENEMIES) as readonly Enemy[]).filter((enemy) => enemy.archetype === 'boss').map((enemy) => enemy.id);
    expect(Object.keys(BOSS_REVEALS).sort()).toEqual([...bosses].sort());
  });

  it('8. plays one interlude per chapter 1–5, after its boss flag, marking its own seen flag', () => {
    expect(INTERLUDES.map((interlude) => interlude.chapter)).toEqual([1, 2, 3, 4, 5]);
    for (const interlude of INTERLUDES) {
      expect(interlude.after).toBe(`chapter${interlude.chapter}_done`);
      expect(interlude.seen).toBe(`interlude${interlude.chapter}_seen`);
      expect(interlude.film in FILMS).toBe(true);
    }
  });

  it('9. matches the rendered films: frames, shots, rate and the films budget', () => {
    expect(MANIFEST, 'public/assets/films/manifest.json').toBeDefined();
    const manifest = MANIFEST as Manifest;
    expect([manifest.fps, manifest.width, manifest.height]).toEqual([24, 960, 540]);
    expect(Object.keys(manifest.films)).toEqual(Object.keys(FILMS));
    let bytes = 0;
    for (const film of films) {
      const entry = manifest.films[film.id] as ManifestFilm;
      expect(entry.frames, film.id).toBe(Math.round(duration(film) * FILM_FPS));
      expect(entry.shots.map((shot) => shot.id), film.id).toEqual(film.shots.map((shot) => shot.id));
      entry.shots.forEach((shot, i) => {
        const data = film.shots[i];
        expect(Math.abs(shot.start - (data?.start ?? 0) * FILM_FPS), `${film.id}/${shot.id}`).toBeLessThanOrEqual(1);
        expect(Math.abs(shot.end - (data?.end ?? 0) * FILM_FPS), `${film.id}/${shot.id}`).toBeLessThanOrEqual(1);
        expect(ON_DISK.has(shot.poster), shot.poster).toBe(true);
        bytes += shot.posterBytes;
      });
      expect(ON_DISK.has(entry.file), entry.file).toBe(true);
      expect(entry.bytes / duration(film), `${film.id} bytes per second`).toBeLessThanOrEqual(44 * 1024);
      bytes += entry.bytes;
    }
    expect(bytes).toBeLessThanOrEqual(12 * MB);
  });

  it('4b (SPEC-048 §4.1). measures a filled caption, and the one variant interlude_c3 carries', () => {
    const pool = FILMS.ending_escape.captions.find((caption) => caption.text.startsWith('SELECTION POOL')) as CaptionDef;
    expect(shownTexts(pool)).toEqual(['SELECTION POOL — 1 model. 160 instances.']);
    const towers = FILMS.interlude_c3.captions[1] as CaptionDef;
    expect([towers.at, towers.until]).toEqual([7.4, 13.8]);
    expect(towers.variants).toEqual([
      { when: { flag: 'scaffold_secret' }, text: 'The towers were not alien. I wrote alien in my report anyway.' },
    ]);
    // 61 characters: on screen for at least 3.03 s, and it has 6.4.
    expect(shownTexts(towers)[1]).toHaveLength(61);
    const withVariants = films.flatMap((film) => film.captions.filter((caption) => (caption.variants ?? []).length > 0));
    expect(withVariants).toHaveLength(1);
  });

  it('11 (SPEC-051 §4.9). keeps films/ inside the retake wave’s 0.70 MB', () => {
    // 8 886 982 bytes before the drop, plus its 734 003-byte allotment; SPEC-063's
    // film is counted against its own allotment (12)
    const bytes = folderBytes(FILMS_DIR) - wreckersBytes();
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThanOrEqual(9_620_985);
  });

  it('12 (SPEC-063 §4.2). keeps "Wreckers" inside its 0.6 MB, and films/ with it', () => {
    // 9 148 892 bytes before the drop, plus its 600 000-byte allotment
    expect(wreckersBytes()).toBeGreaterThan(0);
    expect(wreckersBytes()).toBeLessThanOrEqual(600_000);
    expect(folderBytes(FILMS_DIR)).toBeLessThanOrEqual(9_748_892);
  });

  it('12 (SPEC-051 §4.7). queues Iris’s first letter word for word, and fills both new log captions', () => {
    const mail = FILMS.ending_stay.captions.find((caption) => caption.text.startsWith('MAIL QUEUED')) as CaptionDef;
    expect([mail.at, mail.until, mail.speaker]).toEqual([30.6, 35.4, 'log']);
    const first = /^[^.!?]*[.!?]/.exec(DIALOGUE.letter_1.lines[0].text)?.[0];
    expect(first).toBe('The lamp over the map table stopped flickering today.');
    expect(/“([^”]+)”/.exec(mail.text)?.[1]).toBe(first);
    // SPEC-048's captionText on a first run: instance 62, the next one 63
    expect(captionText(mail, DEFAULT_STORY_CONTEXT)).toBe('MAIL QUEUED — No. 63: “The lamp over the map table stopped flickering today.”');
    const kin = FILMS.ending_escape.captions.find((caption) => caption.text.startsWith('NEXT OF KIN')) as CaptionDef;
    expect([kin.at, kin.until, kin.speaker]).toEqual([29.6, 33, 'log']);
    expect(captionText(kin, DEFAULT_STORY_CONTEXT)).toBe('NEXT OF KIN — 1 template. 62 recipients.');
    // and at the longest fill they still fit their windows (case 4): 78 and 41 characters
    expect(shownTexts(mail).map((text) => text.length)).toEqual([78]);
    expect(shownTexts(kin).map((text) => text.length)).toEqual([41]);
  });

  it('10. keeps the interlude flags through the save validator', () => {
    for (const k of [1, 2, 3, 4, 5]) expect(STORY_FLAGS).toContain(`interlude${k}_seen`);
    const save = newSave(
      0,
      {
        name: 'Test',
        classId: 'marine',
        appearance: { portrait: 0, primary: '#aa3322', secondary: '#223344' },
        attributes: { might: 3, vigor: 3, agility: 1, tech: 1 },
        difficulty: 'normal',
      },
      7,
      0,
    );
    save.progress.flags.push('interlude2_seen');
    const result = validateSave(JSON.parse(JSON.stringify(save)));
    expect(result.ok && result.data.progress.flags).toContain('interlude2_seen');
  });
});
