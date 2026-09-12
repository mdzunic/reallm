// SPEC-019 §4.1 (AC-1 … AC-8) — the pure character state machine: priority
// order, the 0.3 s hit / 0.25 s attack windows, the run threshold, the respawn
// edge that opens no window, and the clip alias resolution.
import { describe, expect, it } from 'vitest';
import {
  CLIP_ALIASES,
  characterState,
  createCharacterPrev,
  pickClip,
  type CharacterFrame,
  type CharacterPrev,
} from '@/core/CharacterState';

function frame(patch: Partial<CharacterFrame> = {}): CharacterFrame {
  return { alive: true, vx: 0, vz: 0, hp: 100, fireCooldown: 0, ...patch };
}

function fresh(patch: Partial<CharacterFrame> = {}): CharacterPrev {
  return createCharacterPrev(frame(patch));
}

describe('characterState (AC-2 … AC-6)', () => {
  it('is idle at rest and run past the 0.3 m/s threshold (AC-5)', () => {
    const prev = fresh();
    expect(characterState(prev, frame(), 0)).toBe('idle');
    expect(characterState(prev, frame({ vx: 0.2, vz: 0.2 }), 0.1)).toBe('idle'); // hypot ≈ 0.28
    expect(characterState(prev, frame({ vx: 0.3, vz: 0.3 }), 0.2)).toBe('run'); // hypot ≈ 0.42
    expect(characterState(prev, frame({ vz: -0.31 }), 0.3)).toBe('run');
  });

  it('an hp drop opens a 0.3 s hit window (AC-3)', () => {
    const prev = fresh();
    expect(characterState(prev, frame({ hp: 90 }), 1)).toBe('hit');
    // Still inside the window, even while moving.
    expect(characterState(prev, frame({ hp: 90, vx: 5 }), 1.29)).toBe('hit');
    // The window closes at exactly time + 0.3.
    expect(characterState(prev, frame({ hp: 90, vx: 5 }), 1.3)).toBe('run');
  });

  it('a fireCooldown rise opens a 0.25 s attack window (AC-4)', () => {
    const prev = fresh();
    expect(characterState(prev, frame({ fireCooldown: 0.4 }), 2)).toBe('attack');
    // Counting down is not a new shot.
    expect(characterState(prev, frame({ fireCooldown: 0.2 }), 2.24)).toBe('attack');
    expect(characterState(prev, frame({ fireCooldown: 0.1 }), 2.25)).toBe('idle');
  });

  it('priority: death over hit over attack over run (AC-2)', () => {
    const prev = fresh();
    // Open both windows at once, moving — hit wins.
    expect(characterState(prev, frame({ hp: 80, fireCooldown: 0.4, vx: 5 }), 0)).toBe('hit');
    // Past the hit window, a fresh shot reopens attack: attack beats run.
    expect(characterState(prev, frame({ hp: 80, fireCooldown: 0.5, vx: 5 }), 0.31)).toBe('attack');
    // Death trumps everything, whatever the windows say.
    expect(characterState(prev, frame({ alive: false, hp: 0, vx: 5 }), 0.1)).toBe('death');
  });

  it('!alive returns death and records no new window (AC-6)', () => {
    const prev = fresh();
    expect(characterState(prev, frame({ alive: false, hp: 0 }), 1)).toBe('death');
    // The hp drop to 0 happened while dead — no hit window was opened.
    expect(prev.hitUntil).toBe(0);
    expect(prev.hp).toBe(0); // prev still resyncs while dead
  });

  it('the respawn edge clears both windows and resyncs prev (AC-7, 19-b)', () => {
    const prev = fresh();
    characterState(prev, frame({ hp: 10, fireCooldown: 0.4 }), 1); // both windows open
    characterState(prev, frame({ alive: false, hp: 0 }), 1.05);
    // Respawn: hp jumps to full while !alive → alive. No window may survive
    // or open — the hp *rise* is not a hit, the stale windows are cleared.
    expect(characterState(prev, frame({ hp: 100 }), 1.1)).toBe('idle');
    expect(prev.hitUntil).toBe(0);
    expect(prev.attackUntil).toBe(0);
    expect(prev.hp).toBe(100);
    expect(prev.fireCooldown).toBe(0);
    expect(prev.alive).toBe(true);
  });

  it('createCharacterPrev snapshots the frame with closed windows (AC-1)', () => {
    const prev = createCharacterPrev(frame({ hp: 55, fireCooldown: 0.2, alive: false }));
    expect(prev).toEqual({ alive: false, hp: 55, fireCooldown: 0.2, attackUntil: 0, hitUntil: 0 });
  });
});

describe('pickClip (AC-8)', () => {
  it('returns the first alias present, exact and case-sensitive', () => {
    expect(pickClip(['Idle', 'Run', 'Attack', 'Hit', 'Death'], 'run')).toBe('Run');
    expect(pickClip(['Walk', 'Running'], 'run')).toBe('Running'); // alias order, not name order
    expect(pickClip(['idle', 'Idle'], 'idle')).toBe('idle');
    expect(pickClip(['IDLE'], 'idle')).toBeNull(); // case matters
    expect(pickClip([], 'death')).toBeNull();
    expect(pickClip(['Sword_Slash'], 'attack')).toBe('Sword_Slash');
  });

  it('every alias table starts with the committed salvager names', () => {
    expect(CLIP_ALIASES.idle).toContain('Idle');
    expect(CLIP_ALIASES.run).toContain('Run');
    expect(CLIP_ALIASES.attack).toContain('Attack');
    expect(CLIP_ALIASES.hit).toContain('Hit');
    expect(CLIP_ALIASES.death).toContain('Death');
  });
});
