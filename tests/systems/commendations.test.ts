// SPEC-059 §4.4, §6.1 — commendations: what queues each rule, that the grant
// waits for a save write and an open gate, the fight record behind the two
// boss rules, the grades at the stay, and the words the toast and the Records
// panel print. A real bus, a fake settings store and a fake gate.
import { describe, expect, it } from 'vitest';
import { EventBus, type GameEvents } from '@/core/Events';
import { lineageOf, newSave, type CharacterCreation, type Save } from '@/core/Save';
import type { Settings } from '@/core/Settings';
import { COMMENDATION_IDS, COMMENDATIONS, MISSIONS, type CommendationId } from '@/data/index';
import { commandRating, ratingGrade } from '@/systems/Clues';
import {
  bestTimeRows,
  commendationToastText,
  CommendationTracker,
  earnedText,
  recordsRows,
  recordsRowStatus,
  recordsTitle,
  revealed,
} from '@/systems/Commendations';

const CREATION: CharacterCreation = {
  name: 'Vega',
  classId: 'marine',
  appearance: { portrait: 2, primary: '#b7472a', secondary: '#2a3b4c' },
  attributes: { might: 3, vigor: 3, agility: 1, tech: 1 },
  difficulty: 'normal',
};

const NOW = 1_790_000_000_000;

/** Optional clue flags, in `CLUES` order — what `offTaskCount` counts. */
const OPTIONAL = ['clue_scav_echo', 'clue_hull', 'iteration_log', 'scaffold_secret', 'clue_keepsake', 'clue_tally', 'clue_bark', 'clue_own_wreck', 'clue_grove'];

interface Rig {
  readonly events: EventBus<GameEvents>;
  readonly save: Save;
  readonly gate: { open: boolean };
  readonly toasts: string[];
  readonly earned: CommendationId[];
  stored(): Settings['commendations'];
  bind(save: Save | null): void;
  /** `save:written`, the usual grant. */
  write(): void;
  tracker: CommendationTracker;
}

function rig(patch: (s: Save) => void = () => {}, earned: Settings['commendations'] = {}): Rig {
  const events = new EventBus<GameEvents>({ dev: false });
  const toasts: string[] = [];
  const granted: CommendationId[] = [];
  events.on('ui:toast', ({ text, kind }) => toasts.push(`${kind ?? 'info'}: ${text}`));
  events.on('commendation:earned', ({ id }) => granted.push(id));
  const save = newSave(0, CREATION, 62, 1_000);
  patch(save);
  let bound: Save | null = save;
  let stored: Settings['commendations'] = { ...earned };
  const gate = { open: true };
  const tracker = new CommendationTracker({
    events,
    save: () => bound,
    settings: {
      get: () => ({ commendations: stored }),
      set: (patchIn) => {
        stored = patchIn.commendations;
      },
    },
    records: gate,
    now: () => NOW,
  });
  return {
    events,
    save,
    gate,
    toasts,
    earned: granted,
    stored: () => stored,
    bind: (next) => {
      bound = next;
    },
    write: () => events.emit('save:written', { slot: 0, reason: 'checkpoint' }),
    tracker,
  };
}

/** Sets `flag` on the rig's save, then announces it as `Economy.setFlag` does. */
function setFlag(r: Rig, flag: string): void {
  r.save.progress.flags.push(flag as Save['progress']['flags'][number]);
  r.events.emit('flag:set', { flag });
}

describe('the rules queue on their events and grant at the next save write (§4.4.3)', () => {
  it('mission: a first completion of Dry Land, never a replay', () => {
    const r = rig();
    r.events.emit('mission:completed', { id: 'c1_m1', replay: true });
    r.write();
    expect(r.earned).toEqual([]);
    r.events.emit('mission:completed', { id: 'c1_m1', replay: false });
    expect(r.earned).toEqual([]); // queued, not granted, until a write
    r.write();
    expect(r.earned).toEqual(['dry_land']);
    expect(r.stored()).toEqual({ dry_land: NOW });
    expect(r.toasts).toEqual(['good: Commendation — Dry land']);
  });

  it('bonus: an earned bonus of the rule’s mission', () => {
    const r = rig();
    r.events.emit('mission:bonus', { id: 'c1_m3', bonus: 'no_death', earned: false });
    r.events.emit('mission:bonus', { id: 'c1_m2', bonus: 'par', earned: true });
    r.write();
    expect(r.earned).toEqual([]);
    r.events.emit('mission:bonus', { id: 'c2_m3', bonus: 'no_death', earned: true });
    r.events.emit('mission:bonus', { id: 'c1_m3', bonus: 'no_death', earned: true });
    r.write();
    // Table order, not event order.
    expect(r.earned).toEqual(['within_parameters', 'steady_hands']);
  });

  it('contract: any completion run as a contract', () => {
    const r = rig();
    r.events.emit('mission:completed', { id: 'c1_m2', replay: true, contract: 'swarm' });
    r.events.emit('save:failed', { slot: 0, error: 'unavailable' });
    expect(r.earned).toEqual(['under_contract']);
  });

  it('boss: the Dune Wurm spawned and defeated with no dash; the Hive Queen with no hit', () => {
    const r = rig();
    r.events.emit('enemy:spawned', { enemyId: 'dune_wurm', elite: false });
    r.events.emit('player:damaged', { amount: 5, source: { kind: 'enemy', enemyId: 'dune_wurm' }, hp: 90 });
    r.events.emit('boss:defeated', { boss: 'dune_wurm' });
    r.events.emit('enemy:spawned', { enemyId: 'hive_queen', elite: false });
    r.events.emit('player:dashed', { x: 0, z: 0, dirX: 1, dirZ: 0 });
    r.events.emit('player:damaged', { amount: 60, source: { kind: 'fall' }, hp: 30 });
    r.events.emit('boss:defeated', { boss: 'hive_queen' });
    r.write();
    expect(r.earned).toEqual(['walked_not_ran', 'untouched']);
  });

  it('ending: the escape on its flag', () => {
    const r = rig();
    setFlag(r, 'ending_escape');
    r.write();
    expect(r.earned).toEqual(['disconnected']);
  });

  it('flag: on flag:set and on story:clue alike', () => {
    const r = rig();
    setFlag(r, 'signal_decoded');
    r.events.emit('story:clue', { id: 'clue_tally' });
    r.write();
    expect(r.earned).toEqual(['signal_decoded', 'sixty_one_marks']);
  });

  it('offTask: queued by any clue, granted when the save holds enough', () => {
    const r = rig((s) => s.progress.flags.push(...(OPTIONAL.slice(0, 4) as Save['progress']['flags'])));
    r.events.emit('story:clue', { id: 'clue_hull' });
    r.write();
    expect(r.earned).toEqual([]);
    r.save.progress.flags.push('clue_bark');
    r.events.emit('story:clue', { id: 'clue_bark' });
    r.write();
    expect(r.earned).toEqual(['off_task']);
  });

  it('claims: queued by a cache opening, granted on the vaults claimed', () => {
    const r = rig((s) => s.progress.claimed.push('cinder4_loose_a', 'lineage:1:cinder4'));
    r.events.emit('cache:opened', { cache: 'cinder4_loose_a', x: 0, z: 0 });
    r.write();
    expect(r.earned).toEqual([]);
    r.save.progress.claimed.push('vetra_vault');
    r.events.emit('cache:opened', { cache: 'vetra_vault', x: 0, z: 0 });
    r.write();
    expect(r.earned).toEqual(['below']);
  });

  it('claims: Eden’s vault earns verification_failed, and six vaults six_locks', () => {
    const r = rig((s) => s.progress.claimed.push('eden_vault'));
    r.events.emit('cache:opened', { cache: 'eden_vault', x: 0, z: 0 });
    r.write();
    expect(r.earned).toEqual(['below', 'verification_failed']);
    r.save.progress.claimed.push('cinder4_vault', 'vetra_vault', 'thessaly_vault', 'ferrum_vault', 'hive_vault');
    r.events.emit('cache:opened', { cache: 'hive_vault', x: 0, z: 0 });
    r.write();
    expect(r.earned).toEqual(['below', 'verification_failed', 'six_locks']);
  });

  it('recoveries: queued by a recovery, granted at five', () => {
    const r = rig((s) => {
      s.meta.stats.recoveries = 4;
    });
    r.events.emit('remains:recovered', { planet: 'cinder4', resources: { oil: 3 } });
    r.write();
    expect(r.earned).toEqual([]);
    r.save.meta.stats.recoveries = 5;
    r.events.emit('remains:recovered', { planet: 'cinder4', resources: { oil: 3 } });
    r.write();
    expect(r.earned).toEqual(['recycler']);
  });

  it('iteration: ng_notice queues it; instance/65 at iteration 4', () => {
    const r = rig((s) => {
      s.meta.iteration = 4;
    });
    r.events.emit('dialogue:started', { id: 'c1_m1_accept' });
    r.write();
    expect(r.earned).toEqual([]);
    r.events.emit('dialogue:started', { id: 'ng_notice' });
    r.write();
    expect(r.earned).toEqual(['instance_65']);
    expect(r.toasts).toEqual(['good: Evaluation logged — Instance/65']);
  });

  it('iteration: deviation_zero only for a profile unchanged from the predecessor', () => {
    const same = rig((s) => {
      s.meta.iteration = 2;
      s.meta.lineage = [lineageOf(s, 5)];
    });
    same.events.emit('dialogue:started', { id: 'ng_notice' });
    same.write();
    expect(same.earned).toEqual(['deviation_zero']);
    const changed = rig((s) => {
      s.meta.iteration = 2;
      s.meta.lineage = [lineageOf(s, 5)];
      s.player.appearance.secondary = '#ffffff';
    });
    changed.events.emit('dialogue:started', { id: 'ng_notice' });
    changed.write();
    expect(changed.earned).toEqual([]);
  });

  it('also grants at a scene’s entry, for a memory-only session', () => {
    const r = rig();
    r.events.emit('mission:completed', { id: 'c1_m1', replay: false });
    r.events.emit('scene:entered', { id: 'station' });
    expect(r.earned).toEqual(['dry_land']);
  });
});

describe('what the tracker never does (§4.4.3)', () => {
  it('a closed gate queues nothing', () => {
    const r = rig();
    r.gate.open = false;
    r.events.emit('mission:completed', { id: 'c1_m1', replay: false });
    r.gate.open = true;
    r.write();
    expect(r.earned).toEqual([]);
    expect(r.stored()).toEqual({});
  });

  it('a gate that closes before the write grants nothing, and the queue is gone after', () => {
    const r = rig();
    r.events.emit('mission:completed', { id: 'c1_m1', replay: false });
    r.gate.open = false;
    r.write();
    r.gate.open = true;
    r.write();
    expect(r.earned).toEqual([]);
    expect(r.toasts).toEqual([]);
  });

  it('no bound save grants nothing and empties the queue', () => {
    const r = rig();
    r.events.emit('mission:completed', { id: 'c1_m1', replay: false });
    r.bind(null);
    r.write();
    r.bind(r.save);
    r.write();
    expect(r.earned).toEqual([]);
  });

  it('never grants from state alone: a save holding signal_decoded gets nothing without a flag:set (59-i)', () => {
    const r = rig((s) => s.progress.flags.push('signal_decoded', 'chapter5_done', 'ending_stay'));
    r.write();
    r.events.emit('scene:entered', { id: 'station' });
    expect(r.earned).toEqual([]);
  });

  it('never grants an id twice (59-h)', () => {
    const r = rig();
    r.events.emit('mission:completed', { id: 'c1_m1', replay: false });
    r.write();
    r.events.emit('mission:completed', { id: 'c1_m1', replay: false });
    r.write();
    expect(r.earned).toEqual(['dry_land']);
    const already = rig(() => {}, { dry_land: 5 });
    already.events.emit('mission:completed', { id: 'c1_m1', replay: false });
    already.write();
    expect(already.earned).toEqual([]);
    expect(already.stored()).toEqual({ dry_land: 5 });
  });

  it('stops listening once disposed', () => {
    const r = rig();
    r.tracker.dispose();
    r.events.emit('mission:completed', { id: 'c1_m1', replay: false });
    r.write();
    expect(r.earned).toEqual([]);
  });
});

describe('the fight record (§4.4.3)', () => {
  const fight = (r: Rig, between: (r: Rig) => void): void => {
    r.events.emit('enemy:spawned', { enemyId: 'dune_wurm', elite: false });
    between(r);
    r.events.emit('boss:defeated', { boss: 'dune_wurm' });
    r.write();
  };

  it('a Dune Wurm fight with a dash misses walked_not_ran; one without earns it', () => {
    const dashed = rig();
    fight(dashed, (r) => r.events.emit('player:dashed', { x: 0, z: 0, dirX: 0, dirZ: 1 }));
    expect(dashed.earned).toEqual([]);
    const walked = rig();
    fight(walked, (r) => r.events.emit('enemy:spawned', { enemyId: 'dune_wurm', elite: false }));
    expect(walked.earned).toEqual(['walked_not_ran']);
  });

  it('a dash before the boss spawned does not count, and a later spawn keeps the record open', () => {
    const r = rig();
    r.events.emit('player:dashed', { x: 0, z: 0, dirX: 0, dirZ: 1 });
    fight(r, (x) => {
      x.events.emit('player:dashed', { x: 0, z: 0, dirX: 0, dirZ: 1 });
      x.events.emit('enemy:spawned', { enemyId: 'dune_wurm', elite: false });
    });
    expect(r.earned).toEqual([]);
  });

  it('a player:died drops the record, so the defeat after it reads nothing', () => {
    const r = rig();
    fight(r, (x) => x.events.emit('player:died', { cause: { kind: 'enemy', enemyId: 'dune_wurm' }, scene: 'surface' }));
    expect(r.earned).toEqual([]);
    // The respawned boss opens a fresh record.
    fight(r, () => {});
    expect(r.earned).toEqual(['walked_not_ran']);
  });

  it('a recall and a scene entry drop it too', () => {
    for (const drop of [
      (r: Rig): void => r.events.emit('player:recalled', {}),
      (r: Rig): void => r.events.emit('scene:entered', { id: 'surface' }),
    ]) {
      const r = rig();
      fight(r, drop);
      expect(r.earned).toEqual([]);
    }
  });
});

describe('the grade at the stay (§4.4.3)', () => {
  /** The stay, with `n` optional clues found. */
  const stay = (n: number): Rig => {
    const r = rig((s) => s.progress.flags.push(...(OPTIONAL.slice(0, n) as Save['progress']['flags'])));
    setFlag(r, 'ending_stay');
    r.write();
    return r;
  };

  it('reads the rating at that moment: 1.00, 0.88 and 0.73', () => {
    expect(commandRating(new Set(OPTIONAL.slice(0, 0)))).toBe(1);
    expect(commandRating(new Set(OPTIONAL.slice(0, 4)))).toBe(0.88);
    expect(commandRating(new Set(OPTIONAL.slice(0, 9)))).toBe(0.73);
    expect(stay(0).earned).toEqual(['good_run']);
    expect(stay(4).earned).toEqual(['acceptable_run']);
    expect(stay(9).earned).toEqual(['noisy_run']);
  });

  it('every grade a rule names is one ratingGrade returns', () => {
    const grades = new Set([1, 0.88, 0.73].map(ratingGrade));
    for (const id of COMMENDATION_IDS) {
      const rule = COMMENDATIONS[id].rule;
      if (rule.kind === 'ending' && 'grade' in rule) expect(grades.has(rule.grade), id).toBe(true);
    }
  });
});

describe('the toast and the title (§4.4.4, §4.4.6)', () => {
  it('commendationToastText before and after the reveal', () => {
    expect(commendationToastText('dry_land', false)).toBe('Commendation — Dry land');
    expect(commendationToastText('within_parameters', true)).toBe('Evaluation logged — Within expected parameters');
  });

  it('revealed: chapter5_done, or an iteration above 1', () => {
    const s = newSave(0, CREATION, 62, 0);
    expect(revealed(s)).toBe(false);
    s.progress.flags.push('chapter5_done');
    expect(revealed(s)).toBe(true);
    const t = newSave(0, CREATION, 62, 0);
    t.meta.iteration = 2;
    expect(revealed(t)).toBe(true);
  });

  it('a revealed save toasts the evaluation log', () => {
    const r = rig((s) => s.progress.flags.push('chapter5_done'));
    r.events.emit('mission:completed', { id: 'c1_m1', replay: false });
    r.write();
    expect(r.toasts).toEqual(['good: Evaluation logged — Dry land']);
  });

  it('recordsTitle: no saves, a chapter5_done save, an iteration-3 save, and the commendation alone', () => {
    expect(recordsTitle([], {})).toBe('Commendations — Earth Command');
    const plain = newSave(0, CREATION, 62, 0);
    expect(recordsTitle([plain], { dry_land: NOW })).toBe('Commendations — Earth Command');
    const done = newSave(1, CREATION, 62, 0);
    done.progress.flags.push('chapter5_done');
    expect(recordsTitle([plain, done], {})).toBe('Evaluation log — instance/62');
    const third = newSave(2, CREATION, 62, 0);
    third.meta.iteration = 3;
    expect(recordsTitle([plain, done, third], {})).toBe('Evaluation log — instance/64');
    expect(recordsTitle([], { sixty_one_times: NOW })).toBe('Evaluation log — instance/62');
    expect(recordsTitle([third], { sixty_one_times: NOW })).toBe('Evaluation log — instance/64');
  });
});

describe('the Records panel’s rows (§4.4.5)', () => {
  it('lists all 24 in table order; hidden rows read — classified — until earned', () => {
    const rows = recordsRows({ dry_land: NOW, disconnected: NOW });
    expect(rows.map((row) => row.id)).toEqual([...COMMENDATION_IDS]);
    expect(rows).toHaveLength(24);
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get('dry_land')).toEqual({ id: 'dry_land', title: 'Dry land', detail: 'Finish Dry Land, the first survey of Cinder-4.', earnedAt: NOW });
    expect(byId.get('sixty_one_times')).toEqual({ id: 'sixty_one_times', title: '— classified —', detail: 'Not yet on record.', earnedAt: null });
    expect(byId.get('disconnected')?.title).toBe('Disconnected');
    expect(byId.get('untouched')?.title).toBe('Untouched');
    const status = (id: CommendationId): string | null => recordsRowStatus(byId.get(id) as ReturnType<typeof recordsRows>[number]);
    expect(status('dry_land')).toBe('Earned 2026-09-21');
    expect(status('untouched')).toBe('Not yet earned');
    expect(status('sixty_one_times')).toBeNull();
    expect(earnedText(Date.UTC(2026, 0, 2, 23, 59))).toBe('Earned 2026-01-02');
  });

  it('bestTimeRows in MISSIONS order', () => {
    expect(bestTimeRows({})).toEqual([]);
    const rows = bestTimeRows({ c2_m1: 3725, c1_m2: 161 });
    expect(rows).toEqual([
      { id: 'c1_m2', text: `${MISSIONS.c1_m2.title} — 2:41` },
      { id: 'c2_m1', text: 'Whiteout — 1:02:05' },
    ]);
  });
});
