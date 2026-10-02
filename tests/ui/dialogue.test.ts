// SPEC-034 §4.7 — `DialogueDef.next`. The line ledger of §4.10 is tested with
// the rest of `StoryBeats`, in `tests/systems/storyBeats.test.ts`.
//
// The layer itself is DOM (SPEC-001 §4 keeps the node suites off `document`), so
// the queue rule is read off its source the way `tests/core/reduceMotion.test.ts`
// reads the typewriter's, and driven for real by `e2e/SPEC-034.spec.ts` case 3.
import { describe, expect, it } from 'vitest';
import { DIALOGUE, MISSIONS } from '@/data/index';
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
