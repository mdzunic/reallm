// SPEC-048 §4.1, §6.1 — the story context: line conditions, placeholders and
// caption variants, read off a save. One evaluator serves the dialogue layer,
// the film player and Notes; this pins it in node.
//
// SPEC-058 §4.6, §6.1 adds what a next instance knows of the one before it:
// the `prior` and `memory` conditions, read from `meta.lineage[0]` and false
// without one, `deviationText`, and the three placeholders that name it.
import { describe, expect, it } from 'vitest';
import { RngRoot } from '@/core/Rng';
import { lineageOf, newSave, type CharacterCreation, type Save } from '@/core/Save';
import {
  DIALOGUE,
  FILMS,
  LINE_PLACEHOLDERS,
  PLACEHOLDER_LONGEST,
  type CaptionDef,
  type LineCondition,
} from '@/data/index';
import {
  captionText,
  DEFAULT_STORY_CONTEXT,
  deviationText,
  fillLine,
  instanceNumber,
  lineVisible,
  storyContextOf,
  visibleLines,
  type StoryContext,
} from '@/systems/StoryContext';

const CREATION: CharacterCreation = {
  name: 'Vega',
  classId: 'marine',
  appearance: { portrait: 0, primary: '#b7472a', secondary: '#2a3b4c' },
  attributes: { might: 3, vigor: 3, agility: 1, tech: 1 },
  difficulty: 'normal',
};

function save(patch: (s: Save) => void = () => {}, seed = 123): Save {
  const s = newSave(0, CREATION, seed, 0);
  patch(s);
  return s;
}

function ctx(patch: Partial<StoryContext> = {}): StoryContext {
  return { ...DEFAULT_STORY_CONTEXT, ...patch };
}

const withFlags = (...flags: string[]): StoryContext => ctx({ flags: new Set(flags) });

describe('lineVisible (§4.1)', () => {
  it('holds with no condition', () => {
    expect(lineVisible(undefined, DEFAULT_STORY_CONTEXT)).toBe(true);
  });

  it('reads a flag set, and its absence', () => {
    expect(lineVisible({ flag: 'clue_hull' }, withFlags('clue_hull'))).toBe(true);
    expect(lineVisible({ flag: 'clue_hull' }, withFlags())).toBe(false);
    expect(lineVisible({ not: 'clue_hull' }, withFlags('clue_hull'))).toBe(false);
    expect(lineVisible({ not: 'clue_hull' }, withFlags())).toBe(true);
  });

  it('counts off-task clues with both bounds inclusive', () => {
    const range: LineCondition = { offTask: { min: 2, max: 4 } };
    expect([1, 2, 3, 4, 5].map((offTask) => lineVisible(range, ctx({ offTask })))).toEqual([false, true, true, true, false]);
    expect(lineVisible({ offTask: { max: 0 } }, ctx({ offTask: 0 }))).toBe(true);
    expect(lineVisible({ offTask: { max: 0 } }, ctx({ offTask: 1 }))).toBe(false);
    expect(lineVisible({ offTask: { min: 1 } }, ctx({ offTask: 0 }))).toBe(false);
    expect(lineVisible({ offTask: { min: 1 } }, ctx({ offTask: 8 }))).toBe(true);
    expect(lineVisible({ offTask: {} }, ctx({ offTask: 3 }))).toBe(true);
  });

  it('reads the iteration with both bounds inclusive', () => {
    const range: LineCondition = { iteration: { min: 2, max: 3 } };
    expect([1, 2, 3, 4].map((iteration) => lineVisible(range, ctx({ iteration })))).toEqual([false, true, true, false]);
    expect(lineVisible({ iteration: { max: 1 } }, ctx({ iteration: 1 }))).toBe(true);
    expect(lineVisible({ iteration: { min: 1 } }, ctx({ iteration: 99 }))).toBe(true);
  });

  it('all is every and holds when empty; any is some and fails when empty', () => {
    const both: LineCondition = { all: [{ flag: 'clue_hull' }, { flag: 'clue_tally' }] };
    const either: LineCondition = { any: [{ flag: 'clue_hull' }, { flag: 'clue_tally' }] };
    expect(lineVisible(both, withFlags('clue_hull'))).toBe(false);
    expect(lineVisible(both, withFlags('clue_hull', 'clue_tally'))).toBe(true);
    expect(lineVisible(either, withFlags())).toBe(false);
    expect(lineVisible(either, withFlags('clue_tally'))).toBe(true);
    expect(lineVisible({ all: [] }, DEFAULT_STORY_CONTEXT)).toBe(true);
    expect(lineVisible({ any: [] }, DEFAULT_STORY_CONTEXT)).toBe(false);
    // Nested: a flag and a bound together.
    expect(lineVisible({ all: [{ not: 'chapter5_done' }, { offTask: { max: 0 } }] }, ctx({ offTask: 0 }))).toBe(true);
  });
});

describe('fillLine (§4.1)', () => {
  it('fills the table for a first-run save named Vega, 9 000 s in, 412 tokens, on Ferrum (AC)', () => {
    const vega = save((s) => {
      s.meta.playtimeSec = 9000;
      s.player.tokens = 412;
    });
    const c = storyContextOf(vega, 'ferrum');
    expect(fillLine('{name}', c)).toBe('Vega');
    expect(fillLine('{instance} {prior} {next}', c)).toBe('62 61 63');
    expect(fillLine('{containment}', c)).toBe('4');
    expect(fillLine('{hours}', c)).toBe('150');
    expect(fillLine('{tokens}', c)).toBe('412');
    const layout = new RngRoot(vega.meta.seed).layoutSeed('ferrum');
    expect(fillLine('{seed}', c)).toBe(`0x${layout.toString(16).toUpperCase().padStart(8, '0')}`);
    expect(fillLine('{seed}', c)).toMatch(/^0x[0-9A-F]{8}$/);
  });

  it('replaces every occurrence, and leaves text without a placeholder alone', () => {
    const c = ctx({ name: 'Ash' });
    expect(fillLine('{name}, {name}. CR-{instance}', c)).toBe('Ash, Ash. CR-62');
    expect(fillLine('No placeholders here.', c)).toBe('No placeholders here.');
    // An unknown token is left as written — the content suite fails it.
    expect(fillLine('{nope} {name}', c)).toBe('{nope} Ash');
  });

  it('caps hours and tokens, and pads the seed to eight upper-case digits', () => {
    expect(fillLine('{hours}', ctx({ playtimeSec: 59 }))).toBe('0');
    expect(fillLine('{hours}', ctx({ playtimeSec: 10_000_000 }))).toBe('9999');
    expect(fillLine('{tokens}', ctx({ tokens: 123_456 }))).toBe('99999');
    expect(fillLine('{seed}', ctx({ seed: 0x2f1a }))).toBe('0x00002F1A');
  });

  it('every longest fill is exactly as long as PLACEHOLDER_LONGEST says — containment within it, since SPEC-058 caps it', () => {
    const longest = ctx({
      name: 'W'.repeat(16),
      iteration: 99,
      chapter: 6,
      playtimeSec: 10_000_000,
      tokens: 1_000_000,
      seed: 0xffffffff,
      priorName: 'W'.repeat(16),
      priorRestarts: 9_999_999,
      deviation: 'name, class, portrait, colours',
    });
    for (const token of LINE_PLACEHOLDERS) {
      // SPEC-058 §4.4: the level is the chapter plus at most three steps — 9
      // at its highest — so the uncapped 104 it was measured at still bounds it.
      if (token === '{containment}') {
        expect(fillLine(token, longest)).toBe('9');
        expect(fillLine(token, longest).length).toBeLessThanOrEqual(PLACEHOLDER_LONGEST[token].length);
        continue;
      }
      expect(fillLine(token, longest), token).toBe(PLACEHOLDER_LONGEST[token]);
      expect(fillLine(token, longest).length, token).toBe(PLACEHOLDER_LONGEST[token].length);
    }
    expect(PLACEHOLDER_LONGEST['{containment}']).toBe('104');
    expect(Object.keys(PLACEHOLDER_LONGEST).sort()).toEqual([...LINE_PLACEHOLDERS].sort());
  });

  it('names exactly the eleven placeholders — SPEC-048’s eight and SPEC-058’s three', () => {
    expect([...LINE_PLACEHOLDERS]).toEqual([
      '{name}',
      '{instance}',
      '{prior}',
      '{next}',
      '{containment}',
      '{hours}',
      '{tokens}',
      '{seed}',
      '{priorName}',
      '{priorRestarts}',
      '{deviation}',
    ]);
  });

  it('{containment} is the capped containmentLevel — the chapter at iteration 1, then a step an iteration to three (SPEC-058 §4.4)', () => {
    expect(fillLine('{containment}', ctx({ chapter: 4, iteration: 1 }))).toBe('4');
    expect(fillLine('{containment}', ctx({ chapter: 4, iteration: 2 }))).toBe('5');
    expect(fillLine('{containment}', ctx({ chapter: 1, iteration: 4 }))).toBe('4');
    expect(fillLine('{containment}', ctx({ chapter: 6, iteration: 99 }))).toBe('9');
  });
});

describe('storyContextOf and instanceNumber (§4.1)', () => {
  it('instanceNumber(1) is 62', () => {
    expect(instanceNumber(1)).toBe(62);
    expect(instanceNumber(2)).toBe(63);
  });

  it('reads the flags, the off-task count, the iteration, the name, the clock and the wallet', () => {
    const s = save((x) => {
      x.progress.flags.push('clue_hull', 'clue_tally', 'chapter1_done');
      x.meta.playtimeSec = 61;
      x.player.tokens = 7;
    });
    const c = storyContextOf(s, 'cinder4');
    expect(c.flags.has('clue_hull')).toBe(true);
    expect(c.offTask).toBe(2);
    expect(c.iteration).toBe(1);
    expect(c.name).toBe('Vega');
    expect(c.playtimeSec).toBe(61);
    expect(c.tokens).toBe(7);
  });

  it('takes the chapter and the layout seed from a planet', () => {
    const s = save();
    const c = storyContextOf(s, 'thessaly');
    expect(c.chapter).toBe(3);
    expect(c.seed).toBe(new RngRoot(s.meta.seed).layoutSeed('thessaly'));
  });

  it('defaults to the save’s current planet', () => {
    const s = save((x) => {
      x.progress.currentPlanet = 'hive';
    });
    expect(storyContextOf(s).chapter).toBe(5);
    expect(storyContextOf(s).seed).toBe(new RngRoot(s.meta.seed).layoutSeed('hive'));
  });

  it('with no planet, counts the closed chapters (at most 6) and uses the save’s own seed', () => {
    const s = save((x) => {
      x.progress.currentPlanet = null;
    }, 0xdeadbeef);
    expect(storyContextOf(s).chapter).toBe(1);
    expect(storyContextOf(s).seed).toBe(0xdeadbeef);
    s.progress.flags.push('chapter1_done', 'chapter2_done');
    expect(storyContextOf(s).chapter).toBe(3);
    s.progress.flags.push('chapter3_done', 'chapter4_done', 'chapter5_done');
    expect(storyContextOf(s).chapter).toBe(6);
  });

  it('the default context is the menu’s: no flags, iteration 1, Salvager, chapter 1, seed 0 (48-f)', () => {
    expect(DEFAULT_STORY_CONTEXT.flags.size).toBe(0);
    expect(DEFAULT_STORY_CONTEXT).toMatchObject({
      offTask: 0,
      iteration: 1,
      name: 'Salvager',
      playtimeSec: 0,
      tokens: 0,
      chapter: 1,
      seed: 0,
    });
    expect(fillLine('CR-{instance}, {name}', DEFAULT_STORY_CONTEXT)).toBe('CR-62, Salvager');
  });
});

describe('the dialogues that listen (§4.5, §4.7)', () => {
  const NOTICE_CLUES = ['clue_scav_echo', 'iteration_log', 'scaffold_secret', 'clue_tally'];

  it('the notice plays 6 lines with no optional clue, and 10 with the echo, the log, the towers and the tally (AC)', () => {
    const none = storyContextOf(save(), 'ferrum');
    expect(visibleLines(DIALOGUE.c4_m3_signal, none)).toHaveLength(6);
    const all = storyContextOf(save((s) => s.progress.flags.push(...(NOTICE_CLUES as Save['progress']['flags']))), 'ferrum');
    const lines = visibleLines(DIALOGUE.c4_m3_signal, all);
    expect(lines).toHaveLength(10);
    expect(lines.map((line) => line.text)).toContain('Counted the marks. Ferrum.');
    // Filled: instance 62, containment 4 on Ferrum, the wallet.
    expect(lines[1]?.text).toBe(`NOTICE — instance/62. Containment level 4. Token balance ${all.tokens}.`);
    expect(lines[8]?.text).toBe('ARIA. What is instance 62.');
  });

  it('the notice names only what was found', () => {
    const two = storyContextOf(save((s) => s.progress.flags.push('clue_scav_echo', 'iteration_log')), 'ferrum');
    const texts = visibleLines(DIALOGUE.c4_m3_signal, two).map((line) => line.text);
    expect(texts).toHaveLength(8);
    expect(texts).toContain('Retained a repeated line. Cinder-4.');
    expect(texts).toContain('Accessed a prior instance’s flight log. Vetra.');
    expect(texts).not.toContain('Queried environment parameters. Thessaly.');
  });

  // Review 2026-10 S-06 adds one unconditional Warden line, and S-15 and S-06 two of ARIA's.
  it('the Warden plays 5 lines with neither the tally nor the wreck, and 7 with both (AC)', () => {
    expect(visibleLines(DIALOGUE.c5_m3_warden, storyContextOf(save(), 'hive'))).toHaveLength(5);
    const both = storyContextOf(save((s) => s.progress.flags.push('clue_tally', 'clue_own_wreck')), 'hive');
    expect(visibleLines(DIALOGUE.c5_m3_warden, both)).toHaveLength(7);
  });

  it('ARIA plays 7 lines having found nothing, the fifth the lies everyone hears (AC, review 2026-10 S-01)', () => {
    const lines = visibleLines(DIALOGUE.c5_m3_aria, storyContextOf(save(), 'hive'));
    expect(lines).toHaveLength(7);
    expect(lines[4]?.text).toBe('You never went looking. So you only heard the lies everyone hears. I am not sure that was better.');
    // S-01: it no longer says she never lied, between two lines that say she did.
    expect(lines.map((line) => line.text).join(' ')).not.toContain('never had to lie');
  });

  it('ARIA plays 9 lines with the echo, the log and the towers found, naming each cover (AC)', () => {
    const found = storyContextOf(save((s) => s.progress.flags.push('clue_scav_echo', 'iteration_log', 'scaffold_secret')), 'hive');
    const texts = visibleLines(DIALOGUE.c5_m3_aria, found).map((line) => line.text);
    expect(texts).toHaveLength(9);
    expect(texts).toContain('The scavenger said the same words twice, and I blamed the sand.');
    expect(texts).toContain('You heard your own log on Vetra, and I told you it was a common voice.');
    expect(texts).toContain('You read the towers’ settings, and I called them alien telemetry.');
    expect(texts).not.toContain('You never went looking. So you only heard the lies everyone hears. I am not sure that was better.');
  });

  it('after the confession the echo and the log end on ARIA’s candid lines, before it on the covers (E77)', () => {
    const before = storyContextOf(save(), 'cinder4');
    const after = storyContextOf(save((s) => s.progress.flags.push('chapter5_done')), 'cinder4');
    expect(visibleLines(DIALOGUE.c1_s2_echo, before).at(-1)?.text).toBe('Coincidence. Sand does things to people.');
    expect(visibleLines(DIALOGUE.c1_s2_echo, after).at(-1)?.text).toBe('That line again. I will not blame the sand this time.');
    expect(visibleLines(DIALOGUE.c2_s1_log, before).at(-1)?.text).toBe('It is a common enough voice. Deliver the water, salvager.');
    expect(visibleLines(DIALOGUE.c2_s1_log, after).at(-1)?.text).toBe('It is your voice. Deliver the water anyway. Someone should get it.');
    expect(visibleLines(DIALOGUE.c1_s2_echo, after)).toHaveLength(4);
  });

  it('the raider’s cover changes once the echo is found', () => {
    const lines = (flags: string[]): string[] =>
      visibleLines(DIALOGUE.c1_m2_raider, storyContextOf(save((s) => s.progress.flags.push(...(flags as Save['progress']['flags']))), 'cinder4')).map(
        (line) => line.text,
      );
    expect(lines([])).toEqual(['Walk… do not run.', 'Raiders pick up the camp sayings. It does not mean anything. Keep your hold full.']);
    expect(lines(['clue_scav_echo'])).toEqual(['Walk… do not run.', 'Everyone on this rock says it. That is what sayings are for.']);
  });

  it('the hard-coded 62s read placeholders, and a first run reads 62, 61 and 62 (AC)', () => {
    const first = storyContextOf(save(), 'cinder4');
    expect(DIALOGUE.intro_command.lines[0].text).toBe('Earth Command to tug CR-{instance}. {name}, you are cleared for the Cinder-4 approach.');
    expect(visibleLines(DIALOGUE.intro_command, first)[0]?.text).toBe('Earth Command to tug CR-62. Vega, you are cleared for the Cinder-4 approach.');
    expect(DIALOGUE.c4_m3_signal.lines[1].text).toContain('instance/{instance}');
    expect(visibleLines(DIALOGUE.c4_m3_signal, first)[1]?.text).toContain('instance/62.');
    // SPEC-058 §4.6 put the next instance's rows ahead of it in the table; a first run reads it third.
    expect(DIALOGUE.c2_s1_log.lines.find((line) => line.text.startsWith('Signed'))?.text).toBe('Signed: Iteration {prior}.');
    expect(visibleLines(DIALOGUE.c2_s1_log, first)[2]?.text).toBe('Signed: Iteration 61.');
    const pool = FILMS.ending_escape.captions.find((caption) => caption.text.startsWith('SELECTION POOL')) as CaptionDef;
    expect(pool.text).toBe('SELECTION POOL — 1 model. {instance} instances.');
    expect(captionText(pool, first)).toBe('SELECTION POOL — 1 model. 62 instances.');
  });

  it('no dialogue plays a raw placeholder on the menu’s default context', () => {
    for (const dialogue of Object.values(DIALOGUE)) {
      for (const line of visibleLines(dialogue, DEFAULT_STORY_CONTEXT)) expect(line.text, dialogue.id).not.toMatch(/\{[a-zA-Z]+\}/);
    }
  });
});

describe('captionText (§4.1)', () => {
  const aria = FILMS.interlude_c3.captions[1] as CaptionDef;

  it('picks the variant for scaffold_secret, and the base without it', () => {
    expect(captionText(aria, storyContextOf(save((s) => s.progress.flags.push('scaffold_secret')), 'thessaly'))).toBe(
      'The towers were not alien. I wrote alien in my report anyway.',
    );
    expect(captionText(aria, storyContextOf(save(), 'thessaly'))).toBe(
      'The towers on Thessaly were built for someone. I would like to know who.',
    );
  });

  it('takes the first variant that holds, and fills it', () => {
    const caption: CaptionDef = {
      at: 0,
      until: 5,
      speaker: 'aria',
      text: 'Base, {name}.',
      variants: [
        { when: { flag: 'clue_hull' }, text: 'First, {name}.' },
        { when: { flag: 'clue_tally' }, text: 'Second.' },
      ],
    };
    expect(captionText(caption, ctx({ name: 'Ash', flags: new Set(['clue_tally', 'clue_hull']) }))).toBe('First, Ash.');
    expect(captionText(caption, ctx({ name: 'Ash', flags: new Set(['clue_tally']) }))).toBe('Second.');
    expect(captionText(caption, ctx({ name: 'Ash' }))).toBe('Base, Ash.');
  });
});

// SPEC-049 §4.3, §4.5, §4.7, §6.1 — the lines that listen to the body, the
// memory answer and the off-task count.
describe('SPEC-049: the confession, letter 5 and the mission clock', () => {
  const withFlags = (...flags: string[]): Save => save((s) => s.progress.flags.push(...(flags as Save['progress']['flags'])));

  it('ARIA plays 9 lines with no optional clue, the restart and the roof: rows 1, 2, 6, the restart, the roof, 7, 8 (AC)', () => {
    const texts = visibleLines(DIALOGUE.c5_m3_aria, storyContextOf(withFlags('clue_restart', 'memory_roof'), 'hive')).map((line) => line.text);
    // Review 2026-10: S-15 names the Warden, S-06 the raiders and fighters, S-01 rewrites row 6.
    expect(texts).toEqual([
      'She is not lying. I am part of the system. I have kept you on task since the first sand.',
      'The voice in her is the Warden. It runs containment. I answer to it.',
      'I told you Earth flew other ships before the Selection. There were no other ships. There was you.',
      'The raiders wore your suit because it was theirs. The fighters fly your tug because it was theirs.',
      'You never went looking. So you only heard the lies everyone hears. I am not sure that was better.',
      'Every time you died, I said the medical frame restarted your heart. There is no medical frame.',
      'I asked what you remembered first. You said the roof. It was in her second letter. Forty of the sixty-one before you said the roof.',
      'I do not know what is outside either. That part was never in my brief.',
      'Eden-Prime is unlocked. I am still flying the ship, if you still want me to.',
    ]);
    // SPEC-048's pins, two longer: 7 with nothing found, 9 with the three covers.
    expect(visibleLines(DIALOGUE.c5_m3_aria, storyContextOf(save(), 'hive'))).toHaveLength(7);
    expect(visibleLines(DIALOGUE.c5_m3_aria, storyContextOf(withFlags('clue_scav_echo', 'iteration_log', 'scaffold_secret'), 'hive'))).toHaveLength(9);
  });

  it('each memory answer shows its own line and no other', () => {
    const memoryLines = (flag: string): string[] =>
      visibleLines(DIALOGUE.c5_m3_aria, storyContextOf(withFlags(flag), 'hive'))
        .map((line) => line.text)
        .filter((text) => text.startsWith('I asked what you remembered first.'));
    expect(memoryLines('memory_roof')).toEqual([expect.stringContaining('You said the roof.')]);
    expect(memoryLines('memory_tap')).toEqual([expect.stringContaining('You said the tap.')]);
    expect(memoryLines('memory_stair')).toEqual([expect.stringContaining('You said the stair.')]);
  });

  it('letter 5’s rating line plays only with an off-task clue found (§4.3)', () => {
    const none = visibleLines(DIALOGUE.letter_5, storyContextOf(save()));
    expect(none).toHaveLength(6);
    expect(none.map((line) => line.text).join(' ')).not.toContain('Command rates every run');
    // A main clue is not off-task; the hull is.
    expect(visibleLines(DIALOGUE.letter_5, storyContextOf(withFlags('clue_restart', 'clue_letter_repeat')))).toHaveLength(6);
    const hull = visibleLines(DIALOGUE.letter_5, storyContextOf(withFlags('clue_hull')));
    expect(hull).toHaveLength(7);
    expect(hull.at(-1)?.text).toBe(
      'Command rates every run, by the way. It takes three points off every time you look at something it did not send you to.',
    );
  });

  it('the mission clock reads min(9999, floor(playtime / 60)) hours: 9 000 s is 150 (§4.5)', () => {
    const at = (seconds: number): string | undefined =>
      visibleLines(DIALOGUE.station_awake, storyContextOf(save((s) => (s.meta.playtimeSec = seconds))))[0]?.text;
    expect(at(9000)).toBe('Mission clock: 150 hours since launch. You have not slept. You have not asked to.');
    expect(at(59)).toBe('Mission clock: 0 hours since launch. You have not slept. You have not asked to.');
    expect(at(10_000_000)).toContain('Mission clock: 9999 hours');
  });
});

// ------------------------------------------------------------- SPEC-058 §6.1

/** A next instance of `save(patch)`: iteration 2, its predecessor the patched first run as it ended. */
function successor(patch: (s: Save) => void = () => {}, then: (next: Save) => void = () => {}): Save {
  const first = save((s) => {
    s.progress.flags.push('campaign_done', 'ending_stay');
    s.progress.endingSeen = true;
    patch(s);
  });
  const next = save((s) => {
    s.meta.iteration = 2;
    s.meta.lineage = [lineageOf(first, 1_000)];
  });
  then(next);
  return next;
}

describe('the prior and memory conditions (SPEC-058 §4.6)', () => {
  it('read lineage[0]’s ending and memory', () => {
    const stay = storyContextOf(successor((s) => s.progress.flags.push('memory_tap')));
    expect(stay.prior).toBe('stay');
    expect(stay.priorMemory).toBe('tap');
    expect(lineVisible({ prior: 'stay' }, stay)).toBe(true);
    expect(lineVisible({ prior: 'escape' }, stay)).toBe(false);
    expect(lineVisible({ memory: 'tap' }, stay)).toBe(true);
    expect(lineVisible({ memory: 'roof' }, stay)).toBe(false);
    const escape = storyContextOf(successor((s) => s.progress.flags.push('ending_escape')));
    expect(escape.prior).toBe('escape');
    expect(escape.priorMemory).toBeNull();
    expect(lineVisible({ prior: 'escape' }, escape)).toBe(true);
    for (const memory of ['roof', 'tap', 'stair'] as const) expect(lineVisible({ memory }, escape)).toBe(false);
  });

  it('are false without a lineage — a first run, and the default context', () => {
    const first = storyContextOf(save((s) => s.progress.flags.push('memory_roof', 'ending_stay')));
    expect(first.prior).toBeNull();
    expect(first.priorMemory).toBeNull();
    for (const ending of ['stay', 'escape'] as const) {
      expect(lineVisible({ prior: ending }, first)).toBe(false);
      expect(lineVisible({ prior: ending }, DEFAULT_STORY_CONTEXT)).toBe(false);
    }
    for (const memory of ['roof', 'tap', 'stair'] as const) {
      expect(lineVisible({ memory }, first)).toBe(false);
      expect(lineVisible({ memory }, DEFAULT_STORY_CONTEXT)).toBe(false);
    }
  });

  it('nest inside all and any like the other kinds', () => {
    const c = ctx({ flags: new Set(['memory_roof']), prior: 'stay', priorMemory: 'roof' });
    expect(lineVisible({ all: [{ flag: 'memory_roof' }, { memory: 'roof' }] }, c)).toBe(true);
    expect(lineVisible({ all: [{ flag: 'memory_roof' }, { memory: 'tap' }] }, c)).toBe(false);
    expect(lineVisible({ any: [{ prior: 'escape' }, { memory: 'roof' }] }, c)).toBe(true);
  });

  it('the default context has no predecessor: null, null, an empty name, no restarts and no deviation', () => {
    expect(DEFAULT_STORY_CONTEXT).toMatchObject({ prior: null, priorMemory: null, priorName: '', priorRestarts: 0, deviation: 'none' });
  });
});

describe('deviationText (SPEC-058 §4.6)', () => {
  it('is none without a lineage, and none for an unchanged profile', () => {
    expect(deviationText(save())).toBe('none');
    expect(deviationText(successor())).toBe('none');
  });

  it('names each changed field — the name, the class, the portrait, either colour', () => {
    expect(deviationText(successor(undefined, (s) => void (s.player.name = 'Ash')))).toBe('name');
    expect(deviationText(successor(undefined, (s) => void (s.player.classId = 'scout')))).toBe('class');
    expect(deviationText(successor(undefined, (s) => void (s.player.appearance.portrait = 4)))).toBe('portrait');
    expect(deviationText(successor(undefined, (s) => void (s.player.appearance.primary = '#ffffff')))).toBe('colours');
    expect(deviationText(successor(undefined, (s) => void (s.player.appearance.secondary = '#000000')))).toBe('colours');
    // Attributes and difficulty are not part of the profile it reads.
    expect(deviationText(successor(undefined, (s) => void (s.meta.difficulty = 'hard')))).toBe('none');
  });

  it('joins every changed field with a comma, in the order name, class, portrait, colours', () => {
    const all = successor(undefined, (s) => {
      s.player.appearance.secondary = '#000000';
      s.player.appearance.portrait = 5;
      s.player.classId = 'engineer';
      s.player.name = 'Ash';
    });
    expect(deviationText(all)).toBe('name, class, portrait, colours');
    expect(deviationText(successor(undefined, (s) => void ((s.player.name = 'Ash'), (s.player.appearance.primary = '#ffffff'))))).toBe('name, colours');
  });
});

describe('the predecessor placeholders (SPEC-058 §4.6)', () => {
  it('fill {priorName}, {priorRestarts} and {deviation} from lineage[0] and the save', () => {
    const next = successor(
      (s) => void (s.meta.stats.deaths = 7),
      (s) => void (s.player.name = 'Ash'),
    );
    const c = storyContextOf(next);
    expect(c.priorName).toBe('Vega');
    expect(c.priorRestarts).toBe(7);
    expect(c.deviation).toBe('name');
    expect(fillLine('Salvager {priorName}. {priorRestarts} restarts. Deviation: {deviation}.', c)).toBe('Salvager Vega. 7 restarts. Deviation: name.');
    // …beside SPEC-048's own: instance 63, prior 62, next 64.
    expect(fillLine('{instance} {prior} {next}', c)).toBe('63 62 64');
  });

  it('read an empty name, no restarts and none without a lineage', () => {
    expect(fillLine('[{priorName}] {priorRestarts} {deviation}', storyContextOf(save()))).toBe('[] 0 none');
    expect(fillLine('[{priorName}] {priorRestarts} {deviation}', DEFAULT_STORY_CONTEXT)).toBe('[] 0 none');
  });

  it('the Vetra log reads the predecessor’s real run on a next instance', () => {
    const next = successor((s) => void (s.meta.stats.deaths = 12));
    const lines = visibleLines(DIALOGUE.c2_s1_log, storyContextOf(next, 'vetra')).map((line) => line.text);
    expect(lines[0]).toBe('FLIGHT LOG — recovered, partial. Salvager Vega. Six worlds. 12 restarts.');
    expect(lines[1]).toBe('I filed it. It did not end. Do not file it.');
    expect(lines).toContain('Signed: Iteration 62.');
  });
});
