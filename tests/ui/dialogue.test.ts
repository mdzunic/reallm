// SPEC-034 §4.7 — `DialogueDef.next`. The line ledger of §4.10 is tested with
// the rest of `StoryBeats`, in `tests/systems/storyBeats.test.ts`.
//
// The layer itself is DOM (SPEC-001 §4 keeps the node suites off `document`), so
// the queue rule is read off its source the way `tests/core/reduceMotion.test.ts`
// reads the typewriter's, and driven for real by `e2e/SPEC-034.spec.ts` case 3.
import { describe, expect, it } from 'vitest';
import { DIALOGUE, MISSIONS } from '@/data/index';
import {
  ADVANCE_KEYS,
  advanceAccepted,
  DIALOGUE_SPEED_FACTOR,
  HOLD_BASE_MS,
  HOLD_MIN_MS,
  HOLD_PER_CHAR_MS,
  holdMs,
  LINE_KEY_GRACE,
  MODAL_ADVANCE_KEYS,
  SPEAKER_NAMES,
  speakerLabel,
  WARDEN_NAMED,
} from '@/ui/DialogueUI';
import { stripComments } from '../architecture/source';

const RAW = import.meta.glob<string>('../../src/**/*.ts', { query: '?raw', import: 'default', eager: true });
const SOURCES: Record<string, string> = Object.fromEntries(
  Object.entries(RAW).map(([file, source]) => [file, stripComments(source)]),
);

describe('DialogueDef.next (SPEC-034 §4.7)', () => {
  it('chains the Warden to ARIA, and c5_m3 plays it on completion', () => {
    expect(DIALOGUE.c5_m3_warden.next).toBe('c5_m3_aria');
    // Both stay modal and once, with the Warden's static burst on `glitch`.
    expect(DIALOGUE.c5_m3_warden.modal).toBe(true);
    expect(DIALOGUE.c5_m3_warden.once).toBe(true);
    expect(DIALOGUE.c5_m3_warden.glitch).toBe(true);
    expect(DIALOGUE.c5_m3_aria.modal).toBe(true);
    // §4.7: the Queen's death is the moment, so it hangs off `onComplete` and
    // the mission has no stage-0 line for the pad terminal to fire early.
    expect(MISSIONS.c5_m3.dialogue).toEqual({ onAccept: 'c5_m3_accept', onComplete: 'c5_m3_warden' });
  });

  it('plays a `next` ahead of anything queued, as its own job', () => {
    const source = SOURCES['../../src/ui/DialogueUI.ts'] as string;
    // `#end` consults the ended dialogue's `next` …
    expect(source).toContain('const next = DIALOGUE_TABLE[job.id].next as DialogueId | undefined;');
    // … and it goes to the *front* of the queue (34-e), not the back.
    expect(source).toMatch(/#playNext\(id: DialogueId\): void \{/);
    expect(source).toContain("this.#queue.unshift({ id, modal: def.modal === true, resolve: () => {} });");
    // A `once` chain link is still only played once per save.
    expect(source).toMatch(/#playNext[\s\S]*?if \(set\.has\(id\)\) return;/);
  });
});

describe('the banner\'s hold (SPEC-042 §4.1)', () => {
  // The layer is DOM, so the rule is read off its source, as the queue rule
  // above is; `e2e/SPEC-042.spec.ts` case 1 drives it for real.
  const source = SOURCES['../../src/ui/DialogueUI.ts'] as string;

  it('#next() starts no queued job while held', () => {
    expect(source).toMatch(/#next\(\): void \{\s*const job = this\.#held \? null : \(this\.#queue\.shift\(\) \?\? null\);/);
  });

  it('setHeld(false) starts the next job at once — unless one is still on screen', () => {
    expect(source).toMatch(/setHeld\(held: boolean\): void \{[\s\S]*?this\.#held = held;\s*if \(!held && this\.#active === null\) this\.#next\(\);/);
  });

  it('a scene change lets the hold go with the queue', () => {
    expect(source).toMatch(/'scene:transition',\s*\(\) => \{\s*this\.#held = false;\s*this\.#clear\(\);/);
  });

  it('the banner holds from its push and lets go when its last queued banner has gone', () => {
    const banner = SOURCES['../../src/ui/MissionBanner.ts'] as string;
    expect(banner).toMatch(/push\(lines: CompletionLines\): void \{[\s\S]*?this\.#holdDialogue\(true\);/);
    expect(banner).toMatch(/#finish\(\): void \{[\s\S]*?if \(this\.#queue\.length > 0\) return;[\s\S]*?this\.#holdDialogue\(false\);/);
    expect(banner).toContain('export const BANNER_SECONDS = 4.0;');
    expect(banner).toContain('export const BANNER_FADE_MS = 150;');
  });
});

describe('advanceAccepted (SPEC-044 §4.1)', () => {
  const LATE = 1;

  it('names the keys: Enter on any line, Space, E and F on a modal one too', () => {
    expect(LINE_KEY_GRACE).toBe(0.3);
    expect(MODAL_ADVANCE_KEYS).toEqual(['Enter', 'NumpadEnter', 'Space', 'KeyE', 'KeyF']);
    expect(ADVANCE_KEYS).toEqual(['Enter', 'NumpadEnter']);
  });

  it('a modal line takes each of its keys', () => {
    for (const code of ['Enter', 'NumpadEnter', 'Space', 'KeyE', 'KeyF']) {
      expect(advanceAccepted(code, false, true, LATE), code).toBe(true);
    }
  });

  it('a non-modal line takes Enter only — Space fires and E opens the terminal (44-b)', () => {
    expect(advanceAccepted('Enter', false, false, LATE)).toBe(true);
    expect(advanceAccepted('NumpadEnter', false, false, LATE)).toBe(true);
    for (const code of ['Space', 'KeyE', 'KeyF']) {
      expect(advanceAccepted(code, false, false, LATE), code).toBe(false);
    }
  });

  it('no other key advances either kind of line', () => {
    for (const code of ['KeyW', 'Digit1', 'Escape', 'Tab', 'KeyQ', 'ArrowDown']) {
      expect(advanceAccepted(code, false, true, LATE), code).toBe(false);
      expect(advanceAccepted(code, false, false, LATE), code).toBe(false);
    }
  });

  it('an auto-repeat never counts — a key held into a line cannot throw it away (44-a)', () => {
    for (const modal of [true, false]) {
      expect(advanceAccepted('Enter', true, modal, LATE)).toBe(false);
    }
    expect(advanceAccepted('Space', true, true, LATE)).toBe(false);
  });

  it('a press at 0.29 s is too early; at 0.3 s it counts', () => {
    for (const modal of [true, false]) {
      expect(advanceAccepted('Enter', false, modal, 0.29)).toBe(false);
      expect(advanceAccepted('Enter', false, modal, 0.3)).toBe(true);
    }
    expect(advanceAccepted('KeyE', false, true, 0.29)).toBe(false);
    expect(advanceAccepted('KeyE', false, true, 0.3)).toBe(true);
  });
});

describe('the dialogue keys in the layer (SPEC-044 §4.1)', () => {
  // The layer is DOM, so the wiring is read off its source, as the rules above
  // are; `e2e/SPEC-044.spec.ts` cases 1 and 2 drive it for real.
  const source = SOURCES['../../src/ui/DialogueUI.ts'] as string;

  it('an accepted press is the line\'s: skip(), and its default and gameplay meaning stopped', () => {
    expect(source).toMatch(
      /if \(!advanceAccepted\(event\.code, event\.repeat, job\.modal, since\)\) return;[\s\S]*?event\.preventDefault\(\);[\s\S]*?event\.stopPropagation\(\);[\s\S]*?this\.skip\(\);/,
    );
  });

  it('a modal above the line keeps the keys: the press is judged only while no other modal is on top', () => {
    expect(source).toMatch(
      /if \(ownedElsewhere\(event\.target, this\.#root\)\) return;[\s\S]*?const top = topModal\(\);\s*if \(top !== null && top !== this\.#root\) return;\s*[\s\S]*?event\.preventDefault\(\);/,
    );
  });

  it('a choice keeps its digits and ignores the advance keys', () => {
    expect(source).toMatch(/if \(job\.choices !== undefined\) \{[\s\S]*?this\.#choose\(index\);\s*return;\s*\}/);
  });

  it('the cue shows on a complete modal line only, in the scheme\'s words', () => {
    expect(source).toMatch(/#finishLine\(\): void \{[\s\S]*?if \(job\.modal\) \{[\s\S]*?this\.#cue\.hidden = false;/);
    expect(source).toContain("return scheme === 'touch' ? '▸ Tap' : '▸ Enter';");
  });

  it('a modal job and a choice open as modals; the end gives focus back', () => {
    expect(source).toContain('if (job.modal) this.#openModal(this.#root);');
    expect(source).toContain("openModal(this.#root, { label: 'Transmission', initialFocus })");
    expect(source).toMatch(/this\.#openModal\(this\.#choices\.querySelector<HTMLElement>\('\[data-testid="dialogue-choice-0"\]'\)\);/);
    expect(source).toMatch(/#end\(job: Job\): void \{[\s\S]*?this\.#releaseModal\(\);/);
  });
});

describe('the hold (SPEC-045 §4.1)', () => {
  const line = (length: number): string => 'x'.repeat(length);

  it('holds a whole line by its length: 20 characters 3.0 s, 79 5.15 s, 121 7.25 s at Normal', () => {
    expect([HOLD_MIN_MS, HOLD_BASE_MS, HOLD_PER_CHAR_MS]).toEqual([3000, 1200, 50]);
    expect(holdMs(line(20), 'normal')).toBe(3000);
    expect(holdMs(line(79), 'normal')).toBe(5150);
    expect(holdMs(line(121), 'normal')).toBe(7250);
  });

  it('scales by the speed: Slow 1.5, Fast 0.75, and Manual has no timer', () => {
    expect(DIALOGUE_SPEED_FACTOR).toEqual({ slow: 1.5, normal: 1, fast: 0.75 });
    expect(holdMs(line(20), 'slow')).toBe(4500);
    expect(holdMs(line(79), 'slow')).toBe(7725);
    expect(holdMs(line(121), 'slow')).toBe(10875);
    expect(holdMs(line(20), 'fast')).toBe(2250);
    expect(holdMs(line(79), 'fast')).toBe(3863); // 3862.5, rounded
    expect(holdMs(line(121), 'fast')).toBe(5438); // 5437.5, rounded
    for (const length of [20, 79, 121]) expect(holdMs(line(length), 'manual')).toBeNull();
  });

  // The layer is DOM, so the rule is read off its source, as the queue rule
  // above is; `e2e/SPEC-045.spec.ts` cases 1 and 2 drive it for real.
  const source = SOURCES['../../src/ui/DialogueUI.ts'] as string;

  it('arms the hold in #finishLine — whenever the line is whole — and never in #advanceLine', () => {
    const finish = /#finishLine\(\): void \{[\s\S]*?\n {2}\}/.exec(source)?.[0] ?? '';
    expect(finish).toContain('holdMs(line.text, this.#speed?.()');
    expect(finish).toMatch(/setTimeout\(\(\) => this\.#advanceLine\(\), hold\)/);
    // A modal job never arms one.
    expect(finish).toMatch(/job\.modal \|\| line === undefined \? null : holdMs/);
    const advance = /#advanceLine\(\): void \{[\s\S]*?\n {2}\}/.exec(source)?.[0] ?? '';
    expect(advance).not.toContain('setTimeout');
    expect(source).not.toContain('AUTO_ADVANCE_MS');
  });

  it('shows the continue cue on a whole line that waits — a modal one, or any under Manual', () => {
    const finish = /#finishLine\(\): void \{[\s\S]*?\n {2}\}/.exec(source)?.[0] ?? '';
    expect(finish).toMatch(/\} else if \(hold === null && line !== undefined\) \{[\s\S]*?this\.#cue\.hidden = false;/);
  });

  it('logs each line as it is shown, and clears the log when the main menu is entered', () => {
    const advance = /#advanceLine\(\): void \{[\s\S]*?\n {2}\}/.exec(source)?.[0] ?? '';
    // Review 2026-10 S-15: with the label it showed, so a named Warden is named in the log too.
    expect(advance).toContain('this.log.push(line.speaker, line.text, name);');
    // Before any typing: the push comes before the reveal.
    expect(advance.indexOf('this.log.push(')).toBeLessThan(advance.indexOf('lineReveal('));
    expect(source).toMatch(/'scene:transition',\s*\(\{ to \}\) => \{\s*if \(to === 'menu'\) this\.log\.clear\(\);/);
    // A choice prompt is not logged.
    const choice = /playChoice\(prompt: string[\s\S]*?\n {2}\}/.exec(source)?.[0] ?? '';
    expect(choice).not.toContain('this.log.push');
  });
});

describe('lines chosen as a job starts (SPEC-048 §4.1)', () => {
  // The layer is DOM, so the rule is read off its source, as the queue rule
  // above is; `tests/systems/storyContext.test.ts` pins the evaluator and
  // `e2e/SPEC-048.spec.ts` drives the layer for real.
  const source = SOURCES['../../src/ui/DialogueUI.ts'] as string;
  const next = /#next\(\): void \{[\s\S]*?\n {2}\}/.exec(source)?.[0] ?? '';

  it('#next() chooses and fills the lines from the bound save’s context, or the default with none', () => {
    expect(next).toContain('const ctx = this.#storyContext();');
    expect(next).toContain('visibleLines(DIALOGUE_TABLE[job.id], ctx)');
    // Review 2026-10 S-15: the labels read the same flags, taken with the lines.
    expect(next).toContain('job.flags = ctx.flags;');
    expect(source).toMatch(/#storyContext\(\): StoryContext \{[\s\S]*?save === null \? DEFAULT_STORY_CONTEXT : storyContextOf\(save\)/);
    expect(source).toContain('saveKey?: () => Save | null;');
  });

  it('a job with no visible line ends before dialogue:started, unspends its once and starts the next', () => {
    const empty = /if \(lines\.length === 0\) \{[\s\S]*?\n {4}\}/.exec(next)?.[0] ?? '';
    expect(empty).toContain('this.#forget(job.id);');
    expect(empty).toContain('job.resolve();');
    expect(empty).toContain('this.#next();');
    expect(empty).not.toContain('dialogue:started');
    expect(next.indexOf('if (lines.length === 0)')).toBeLessThan(next.indexOf("this.#events.emit('dialogue:started'"));
    expect(source).toMatch(/#forget\(id: DialogueId\): void \{[\s\S]*?SEEN\.get\(key\)\?\.delete\(id\);/);
  });

  it('the line shown, typed, held and logged is the job’s own filled line', () => {
    const advance = /#advanceLine\(\): void \{[\s\S]*?\n {2}\}/.exec(source)?.[0] ?? '';
    const finish = /#finishLine\(\): void \{[\s\S]*?\n {2}\}/.exec(source)?.[0] ?? '';
    expect(advance).toContain('const line = job.lines?.[this.#lineIndex];');
    expect(finish).toContain('const line = job.lines?.[this.#lineIndex];');
    expect(source).not.toMatch(/DIALOGUE_TABLE\[job\.id\]\.lines\[/);
  });
});

// SPEC-049 §4.1 — Iris speaks in her letters: named, and on paper. The panel
// is DOM, driven for real by `e2e/SPEC-049.spec.ts` case 2.
describe('the home speaker (SPEC-049 §4.1)', () => {
  it('names every speaker, and home is Iris', () => {
    expect(SPEAKER_NAMES.home).toBe('Iris');
    expect(Object.keys(SPEAKER_NAMES)).toEqual(['aria', 'command', 'scav', 'log', 'player', 'warden', 'home']);
  });

  it('the Warden is ??? until chapter5_done, then WARDEN; no one else changes (review 2026-10 S-15)', () => {
    expect(SPEAKER_NAMES.warden).toBe('???');
    expect(WARDEN_NAMED).toBe('WARDEN');
    expect(speakerLabel('warden', new Set())).toBe('???');
    expect(speakerLabel('warden', new Set(['signal_decoded', 'chapter4_done']))).toBe('???');
    expect(speakerLabel('warden', new Set(['chapter5_done']))).toBe('WARDEN');
    for (const speaker of Object.keys(SPEAKER_NAMES) as (keyof typeof SPEAKER_NAMES)[]) {
      if (speaker === 'warden') continue;
      expect(speakerLabel(speaker, new Set(['chapter5_done'])), speaker).toBe(SPEAKER_NAMES[speaker]);
    }
    // The line on screen and its log entry read the label, not the cast table.
    const layer = SOURCES['../../src/ui/DialogueUI.ts'] as string;
    expect(layer).toContain('const name = speakerLabel(line.speaker, job.flags ?? DEFAULT_STORY_CONTEXT.flags);');
    expect(layer).toContain('this.#speaker.textContent = name;');
  });

  it('#setStyle puts dialogue-letter on a home line and takes it off every other', () => {
    const layer = SOURCES['../../src/ui/DialogueUI.ts'] as string;
    const style = layer.slice(layer.indexOf('#setStyle(speaker: SpeakerId): void {'));
    expect(style).toMatch(/classList\.toggle\('dialogue-letter', speaker === 'home'\)/);
    // A choice resets the style to ARIA's, so a letter's paper never carries over.
    expect(layer).toMatch(/playChoice\([^)]*\)[^{]*\{[\s\S]*?this\.#setStyle\('aria'\)/);
  });

  it('a choice\'s click stops at its button, so the box never skips the reply the answer starts', () => {
    // §4.5: `station_memory_reply` is on screen before the click would bubble
    // to the box's `skip()`, which ends a whole line (Typewriter text off).
    const layer = SOURCES['../../src/ui/DialogueUI.ts'] as string;
    const choice = /playChoice\(prompt: string[\s\S]*?\n {2}\}/.exec(layer)?.[0] ?? '';
    expect(choice).toMatch(/const choose = \(index: number\) => \(event: Event\) => \{\s*event\.stopPropagation\(\);\s*this\.#choose\(index\);\s*\};/);
    expect(choice).toContain("h('button', { class: 'ui-btn dialogue-choice', type: 'button', click: choose(index) }");
  });
});
