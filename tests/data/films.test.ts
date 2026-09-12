// The story films' script (PLAN R9, SPEC-021 §8): ten checks that keep the data
// in src/data/films.ts, the rendered files and their manifest in step. The
// pictures are rendered by scripts/assets/blender/films.py; captions and cues
// live here and change without a re-render, shot timing does not.
import { describe, expect, it } from 'vitest';
import {
  ASSETS,
  BOSS_REVEALS,
  CHAPTER_CARDS,
  ENEMIES,
  FILMS,
  FILM_FPS,
  INTERLUDES,
  PLANETS,
  PLANET_IDS,
  SPEAKERS,
  STORY_FLAGS,
  type FilmDef,
  type Enemy,
} from '@/data/index';
import { newSave, validateSave } from '@/core/Save';

const films: readonly FilmDef[] = Object.values(FILMS);
const duration = (film: FilmDef): number => film.shots[film.shots.length - 1]?.end ?? 0;
const onGrid = (seconds: number): boolean => Math.abs(seconds * FILM_FPS - Math.round(seconds * FILM_FPS)) < 1e-6;
const MB = 1024 * 1024;

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

describe('story films (SPEC-021 §8)', () => {
  it('1. names the nine films, each under its own id', () => {
    expect(Object.keys(FILMS)).toEqual([
      'prologue', 'departure', 'interlude_c1', 'interlude_c2', 'interlude_c3', 'interlude_c4', 'interlude_c5',
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
      prologue: 72, departure: 7, interlude_c1: 14, interlude_c2: 14, interlude_c3: 14, interlude_c4: 16, interlude_c5: 16,
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
        expect(caption.text.length, where).toBeGreaterThan(0);
        expect(caption.text.length, where).toBeLessThanOrEqual(140);
        expect(caption.until - caption.at, where).toBeGreaterThanOrEqual(1.5 + caption.text.length / 40 - 1e-9);
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
