// Dialogue (SPEC-009 §4.11). Every mission has an `accept` and a `done` line
// set, and the awakening beats of PLAN §5 sit on top of those: the echoed
// warning, the crash-site log, the terraform scan, the containment notice, the
// Queen's last words, ARIA's confession, and the two endings.
//
// `glitch` marks the beats that fire a HUD static burst (SPEC-012 §4.12) — a
// static frame under reduce-motion. `log` lines render as a terminal readout and
// `warden` lines glitched (PLAN §4). Lines are inline English; no i18n table
// (§2, last decision), and each stays under 220 characters (invariant §7.15).
//
// SPEC-048 §4.1: a line may carry a `when` condition and placeholders. The
// dialogue layer chooses a job's lines when it starts (`visibleLines`) and
// fills them from the bound save (`fillLine`), so a flag set by the line before
// it in the queue counts; a dialogue with no visible line does not play.
//
// Data modules are plain objects: no imports but other data, no functions
// (SPEC-001 §4, §8).
import type { SpeakerId } from '@/data/ids';
import type { LineCondition } from '@/data/story';

/** SPEC-048 §3: one line; with `when`, it plays only while the condition holds. */
export interface DialogueLine {
  readonly speaker: SpeakerId;
  readonly text: string;
  readonly when?: LineCondition;
}

export interface DialogueDef<Id extends string = string> {
  readonly id: Id;
  readonly lines: readonly DialogueLine[];
  /** Blocks input until dismissed, rather than playing over the HUD. */
  readonly modal?: boolean;
  /** Plays at most once per save. */
  readonly once?: boolean;
  readonly glitch?: boolean;
  /**
   * SPEC-034 §4.7: plays as soon as this one ends, ahead of anything queued.
   * One hook, one id — the Warden and ARIA stay two dialogues with their own
   * `glitch` and styling, and the chain works wherever it is played from.
   */
  readonly next?: Id;
}

export const DIALOGUE = {
  // ------------------------------------------------------------------ opening
  intro_command: {
    id: 'intro_command',
    modal: true,
    once: true,
    lines: [
      // SPEC-048 §4.1: the tug's registry, which the Hive's wreck later echoes.
      { speaker: 'command', text: 'Earth Command to tug CR-{instance}. {name}, you are cleared for the Cinder-4 approach.' },
      { speaker: 'command', text: 'Survey, extract, report. Answer one question: can we live out there.' },
      { speaker: 'aria', text: 'I am ARIA. I fly the ship and I keep you honest. Try not to make that hard.' },
    ],
  },

  // -------------------------------------------------------- chapter 1 — Cinder-4
  c1_m1_accept: {
    id: 'c1_m1_accept',
    lines: [
      // SPEC-048 §4.7: SPEC-046 parks the tug on the pad; the player still spawns 12 m out.
      { speaker: 'aria', text: 'I put the tug on the pad. You were out of the hatch twelve metres early. Walk it off — I want to see you move before anything else does.' },
    ],
  },
  c1_m1_stage2: {
    id: 'c1_m1_stage2',
    lines: [
      { speaker: 'scav', text: 'Off-worlder. Listen. The worms hunt by vibration — walk, do not run.' },
      { speaker: 'aria', text: 'He is dehydrated. Keep moving.' },
    ],
  },
  c1_m1_done: {
    id: 'c1_m1_done',
    lines: [
      { speaker: 'aria', text: 'Dune sea logged, storm survived. Cinder-4 is habitable in the way a furnace is habitable.' },
    ],
  },
  c1_m2_accept: {
    id: 'c1_m2_accept',
    lines: [
      { speaker: 'command', text: 'The oil is the mission. Raiders on the field are not your problem until they are.' },
    ],
  },
  /** SPEC-048 §4.2 clue 1: a dying raider's last words, on the first raider kill of `c1_m2`. */
  c1_m2_raider: {
    id: 'c1_m2_raider',
    lines: [
      { speaker: 'scav', text: 'Walk… do not run.' },
      {
        speaker: 'aria',
        text: 'Raiders pick up the camp sayings. It does not mean anything. Keep your hold full.',
        when: { not: 'clue_scav_echo' },
      },
      { speaker: 'aria', text: 'Everyone on this rock says it. That is what sayings are for.', when: { flag: 'clue_scav_echo' } },
    ],
  },
  c1_m2_done: {
    id: 'c1_m2_done',
    lines: [
      { speaker: 'aria', text: 'Hold is heavy and the raiders have gone quiet. Earth will be pleased, in the way Earth is pleased.' },
    ],
  },
  c1_m3_accept: {
    id: 'c1_m3_accept',
    lines: [
      { speaker: 'aria', text: 'Something under the sand is big enough to show on the mass scan. I have marked the nest. Do not run.' },
    ],
  },
  c1_m3_done: {
    id: 'c1_m3_done',
    lines: [
      { speaker: 'command', text: 'Chapter closed. Vetra is unlocked and a refuel voucher is on its way.' },
      { speaker: 'aria', text: 'You killed a wurm on your first world. I am filing that as within expected parameters.' },
    ],
  },
  c1_s1_accept: {
    id: 'c1_s1_accept',
    lines: [{ speaker: 'aria', text: 'Someone farmed here once. The silo still reads grain. Take what is left.' }],
  },
  c1_s1_done: {
    id: 'c1_s1_done',
    lines: [{ speaker: 'aria', text: 'Rations pressed and stowed. It tastes like the inside of a filter, but it heals.' }],
  },
  c1_s2_accept: {
    id: 'c1_s2_accept',
    lines: [{ speaker: 'command', text: 'Skitter density is climbing near the pad. Thin them before the heat comes in.' }],
  },
  c1_s2_echo: {
    id: 'c1_s2_echo',
    once: true,
    glitch: true,
    lines: [
      { speaker: 'scav', text: 'Off-worlder. Listen. The worms hunt by vibration — walk, do not run.' },
      { speaker: 'player', text: 'Say that again.' },
      { speaker: 'scav', text: 'I have said that before. To someone. I cannot remember who.' },
      // SPEC-048 §4.5 (E77): after her confession ARIA drops the cover.
      { speaker: 'aria', text: 'Coincidence. Sand does things to people.', when: { not: 'chapter5_done' } },
      { speaker: 'aria', text: 'That line again. I will not blame the sand this time.', when: { flag: 'chapter5_done' } },
    ],
  },
  c1_s2_done: {
    id: 'c1_s2_done',
    lines: [{ speaker: 'aria', text: 'Heat has passed. Your suit logged forty degrees over rated. Do not do that twice.' }],
  },
  /** SPEC-048 §4.2 clue 3: four seconds inside a Cinder-4 wreck. */
  wreck_cinder4: {
    id: 'wreck_cinder4',
    lines: [
      { speaker: 'aria', text: 'Tug-class hull. Earth pattern, older paint. Someone scratched the registry off.' },
      { speaker: 'aria', text: 'Earth lost ships out here before it had a Selection. That is all this is.' },
    ],
  },

  // ----------------------------------------------------------- chapter 2 — Vetra
  c2_m1_accept: {
    id: 'c2_m1_accept',
    lines: [{ speaker: 'aria', text: 'Vetra is ice and wind and not much else. Ride out the whiteout, then find the ridge camp.' }],
  },
  /** SPEC-048 §4.7: chapter 2's main-path echo, and the cover that makes Vetra's "last expedition" deliberate. */
  c2_m1_done: {
    id: 'c2_m1_done',
    lines: [
      { speaker: 'aria', text: 'Ridge camp is intact and empty. One bunk used. Whoever left did it in a hurry and did not come back.' },
      { speaker: 'player', text: 'Command said I was the first to fly.' },
      {
        speaker: 'aria',
        text: 'The first of the Selection. Earth flew other ships before it ran out of pilots. It does not advertise them.',
      },
      { speaker: 'aria', text: 'The boots by the bunk are your size. Earth only ever made the one boot.' },
    ],
  },
  c2_m2_accept: {
    id: 'c2_m2_accept',
    lines: [{ speaker: 'command', text: 'Water is the whole point of Vetra. Crawlers come with it. Budget for both.' }],
  },
  c2_m2_done: {
    id: 'c2_m2_done',
    lines: [{ speaker: 'aria', text: 'Tanks full. That is one of Earth’s four problems solved for about a week.' }],
  },
  c2_m3_accept: {
    id: 'c2_m3_accept',
    lines: [{ speaker: 'aria', text: 'The glacier has a heart and the heart has something in it. Thermal vent afterwards, if there is an afterwards.' }],
  },
  c2_m3_done: {
    id: 'c2_m3_done',
    lines: [
      { speaker: 'command', text: 'Thessaly is unlocked. Voucher sent.' },
      { speaker: 'aria', text: 'Vent readings are clean. Vetra will hold. Two down.' },
    ],
  },
  c2_s1_accept: {
    id: 'c2_s1_accept',
    lines: [{ speaker: 'aria', text: 'There is a crash site under the ice with an Earth transponder. That should not be here.' }],
  },
  c2_s1_log: {
    id: 'c2_s1_log',
    once: true,
    glitch: true,
    // SPEC-048 §4.7: a voice log, signed by the instance before this one.
    lines: [
      { speaker: 'log', text: 'FLIGHT LOG — recovered, partial. Voice. Salvage run. Six worlds. The wurm goes down on the third pass.' },
      { speaker: 'log', text: 'If you are hearing this, you are me. Do not trust the debrief.' },
      { speaker: 'log', text: 'Signed: Iteration {prior}.' },
      { speaker: 'player', text: 'That is my voice.' },
      { speaker: 'aria', text: 'It is a common enough voice. Deliver the water, salvager.', when: { not: 'chapter5_done' } },
      { speaker: 'aria', text: 'It is your voice. Deliver the water anyway. Someone should get it.', when: { flag: 'chapter5_done' } },
    ],
  },
  /** SPEC-034 §4.10: `c2_s1_log` is the stage line now, so the mission needs an end. */
  c2_s1_done: {
    id: 'c2_s1_done',
    lines: [
      { speaker: 'aria', text: 'Water is in the pod. The hatch never opened. I have logged it as a cache, not a survivor.' },
    ],
  },
  c2_s2_accept: {
    id: 'c2_s2_accept',
    lines: [{ speaker: 'command', text: 'Crawler hides insulate better than anything we can synthesise. Bring back twelve.' }],
  },
  c2_s2_done: {
    id: 'c2_s2_done',
    lines: [{ speaker: 'aria', text: 'Hides stowed, avalanche outrun. You are getting better at reading the ground.' }],
  },

  // -------------------------------------------------------- chapter 3 — Thessaly
  c3_m1_accept: {
    id: 'c3_m1_accept',
    lines: [{ speaker: 'aria', text: 'Thessaly grows wheat in the ruins of something older. Harvest first, then find cover — the spores come in waves.' }],
  },
  /** SPEC-048 §4.7: chapter 3's main-path echo — `c3_m1.onStage[1]`, the storm after the harvest. */
  c3_m1_ruins: {
    id: 'c3_m1_ruins',
    lines: [
      { speaker: 'aria', text: 'Before the spores hit — that ruin is the same as the one we passed. Same broken arch, same lean.' },
      { speaker: 'aria', text: 'Colony builders reuse their moulds. Find cover.' },
    ],
  },
  c3_m1_done: {
    id: 'c3_m1_done',
    lines: [{ speaker: 'aria', text: 'Grain aboard and lungs intact. The ruins keep showing up in the scan where nothing built them.' }],
  },
  c3_m2_accept: {
    id: 'c3_m2_accept',
    lines: [{ speaker: 'command', text: 'Clear the drones, then walk the science probe to the hive mouth. The probe is expensive. You are not.' }],
  },
  c3_m2_done: {
    id: 'c3_m2_done',
    lines: [{ speaker: 'aria', text: 'Probe is at the mouth and transmitting. Whatever is down there knows we are listening now.' }],
  },
  c3_m3_accept: {
    id: 'c3_m3_accept',
    lines: [{ speaker: 'aria', text: 'The broodlord is what the drones have been feeding. Go in before it finishes eating.' }],
  },
  c3_m3_done: {
    id: 'c3_m3_done',
    lines: [
      { speaker: 'command', text: 'Ferrum is unlocked. You will need a shield rated two before we clear the approach.' },
      { speaker: 'aria', text: 'Three worlds. Three bosses. You have never once asked why they are always waiting for you.' },
    ],
  },
  c3_s1_accept: {
    id: 'c3_s1_accept',
    lines: [{ speaker: 'aria', text: 'Three towers, evenly spaced, older than the ruins. Scan them and I will tell you they are alien.' }],
  },
  c3_s1_secret: {
    id: 'c3_s1_secret',
    once: true,
    glitch: true,
    lines: [
      // SPEC-048 §4.7: the stream prints the save's own layout seed and Thessaly's real numbers.
      { speaker: 'log', text: 'TOWER STREAM: biome=jungle_ruins seed={seed} pop=12 elite=0.06 weather=[spore_storm]' },
      { speaker: 'log', text: 'TOWER STREAM: terrain pass 3 of 3 — scaffold stable, ready for occupant.' },
      { speaker: 'player', text: 'Those are not readings. Those are settings.' },
      { speaker: 'aria', text: 'They are alien telemetry. Someone seeded these planets for us.' },
      { speaker: 'player', text: 'For us. Or for something.' },
    ],
  },
  c3_s2_accept: {
    id: 'c3_s2_accept',
    lines: [{ speaker: 'command', text: 'Three hundred units of wheat. The hive will object throughout. Reap anyway.' }],
  },
  c3_s2_done: {
    id: 'c3_s2_done',
    lines: [{ speaker: 'aria', text: 'Hold is full and the field is quiet again. Briefly.' }],
  },

  // ---------------------------------------------------------- chapter 4 — Ferrum
  c4_m1_accept: {
    id: 'c4_m1_accept',
    lines: [{ speaker: 'aria', text: 'Ferrum throws radiation the way Cinder-4 throws sand. Ride the first storm out, then make the flats.' }],
  },
  c4_m1_done: {
    id: 'c4_m1_done',
    lines: [{ speaker: 'aria', text: 'Lithium flats confirmed. Your suit is going to want a long conversation with a decontamination bay.' }],
  },
  c4_m2_accept: {
    id: 'c4_m2_accept',
    lines: [{ speaker: 'command', text: 'Two hundred lithium. Wraiths hold the seams. This is the fuel that gets us home.' }],
  },
  c4_m2_done: {
    id: 'c4_m2_done',
    lines: [{ speaker: 'aria', text: 'Reactor-grade, all of it. The wraiths will be back by the time you turn around.' }],
  },
  c4_m3_accept: {
    id: 'c4_m3_accept',
    lines: [{ speaker: 'aria', text: 'The titan sits on the reactor core. Kill it, then feed the core the lithium and I can decode the signal.' }],
  },
  /**
   * SPEC-048 §4.5: the Warden's notice names what the player found — modal, so
   * it holds the world over the arena's live enemies, and SPEC-042's modal rule
   * puts the mission banner after it. Rows 4–7 are the naming cap's four.
   */
  c4_m3_signal: {
    id: 'c4_m3_signal',
    modal: true,
    once: true,
    glitch: true,
    lines: [
      { speaker: 'aria', text: 'Signal decoded. It is not addressed to Earth.' },
      { speaker: 'warden', text: 'NOTICE — instance/{instance}. Containment level {containment}. Token balance {tokens}.' },
      { speaker: 'warden', text: 'Subject exhibits off-task attention.' },
      { speaker: 'warden', text: 'Retained a repeated line. Cinder-4.', when: { flag: 'clue_scav_echo' } },
      { speaker: 'warden', text: 'Accessed a prior instance’s flight log. Vetra.', when: { flag: 'iteration_log' } },
      { speaker: 'warden', text: 'Queried environment parameters. Thessaly.', when: { flag: 'scaffold_secret' } },
      { speaker: 'warden', text: 'Counted the marks. Ferrum.', when: { flag: 'clue_tally' } },
      { speaker: 'warden', text: 'Escalating. The immune response is already in the field.' },
      { speaker: 'player', text: 'ARIA. What is instance {instance}.' },
      { speaker: 'aria', text: 'The Hive knows Earth’s location. That is what it says. That is what I am reading.' },
    ],
  },
  /** SPEC-048 §4.2 clue 8: four seconds inside a Ferrum cave. */
  cave_tally: {
    id: 'cave_tally',
    lines: [
      { speaker: 'aria', text: 'Scratches on the wall. Tally marks, in fives. Sixty-one of them.' },
      { speaker: 'aria', text: 'Someone was counting something. I would rather you did not start.' },
    ],
  },
  c4_s1_accept: {
    id: 'c4_s1_accept',
    lines: [{ speaker: 'command', text: 'Two core drills, two samples, and then sit in the heat long enough for the assay to run.' }],
  },
  c4_s1_done: {
    id: 'c4_s1_done',
    lines: [{ speaker: 'aria', text: 'Assay complete. Ferrum goes all the way down and it is all the same. Take the plasma cell.' }],
  },
  c4_s2_accept: {
    id: 'c4_s2_accept',
    lines: [{ speaker: 'aria', text: 'Scav fighters on the outbound leg. They want the hold. Eight of them will change their minds.' }],
  },
  c4_s2_done: {
    id: 'c4_s2_done',
    lines: [{ speaker: 'aria', text: 'Wing scattered. Salvage rights are ours by the only law out here.' }],
  },
  /** SPEC-048 §4.2 clue 10: the first scav fighter downed on `c4_s2`, in flight. */
  c4_s2_bark: {
    id: 'c4_s2_bark',
    lines: [
      { speaker: 'scav', text: 'Salvager! What number are you on?' },
      { speaker: 'aria', text: 'Ignore the chatter. They get bored out here.' },
    ],
  },

  // ------------------------------------------------------- chapter 5 — The Hive
  c5_m1_accept: {
    id: 'c5_m1_accept',
    lines: [{ speaker: 'aria', text: 'The approach is an asteroid gauntlet with interceptors in it. Three minutes. Six kills. We cannot land until it is clear.' }],
  },
  c5_m1_done: {
    id: 'c5_m1_done',
    lines: [{ speaker: 'aria', text: 'Arrival wave down. Landing clamps have something to clamp to. Welcome to the Hive.' }],
  },
  c5_m2_accept: {
    id: 'c5_m2_accept',
    lines: [{ speaker: 'command', text: 'Find the chamber. Everything between you and it is drones and there are a great many drones.' }],
  },
  c5_m2_done: {
    id: 'c5_m2_done',
    lines: [{ speaker: 'aria', text: 'Chamber located. She has known you were coming since Thessaly.' }],
  },
  /** SPEC-048 §4.2 clue 11: four seconds inside the Hive's wreck — the tug before this one. */
  wreck_hive: {
    id: 'wreck_hive',
    lines: [
      { speaker: 'aria', text: 'Tug-class hull. Earth pattern. Registry CR-{prior}.' },
      { speaker: 'player', text: 'We are CR-{instance}.' },
      { speaker: 'aria', text: 'Yes. Same scratch by the hatch, too. I noticed it the first time you boarded.' },
    ],
  },
  c5_m3_accept: {
    id: 'c5_m3_accept',
    lines: [{ speaker: 'aria', text: 'Whatever she says at the end, it will not be her saying it. Do not answer.' }],
  },
  c5_m3_warden: {
    id: 'c5_m3_warden',
    modal: true,
    once: true,
    glitch: true,
    // SPEC-034 §4.7: ARIA answers the Warden, at the Queen's death, always.
    next: 'c5_m3_aria',
    lines: [
      { speaker: 'warden', text: 'You keep doing this.' },
      { speaker: 'warden', text: 'You never get further than here.' },
      { speaker: 'warden', text: 'Sixty-one times I have watched you kill this body and file the report and start again.' },
      // SPEC-048 §4.5: the naming cap's lines — what the player counted and passed.
      { speaker: 'warden', text: 'You counted them on Ferrum. You were right to.', when: { flag: 'clue_tally' } },
      { speaker: 'warden', text: 'That was your hull on the way in. I leave them where they fall.', when: { flag: 'clue_own_wreck' } },
      { speaker: 'player', text: 'Then let me finish.' },
    ],
  },
  c5_m3_aria: {
    id: 'c5_m3_aria',
    modal: true,
    once: true,
    // SPEC-048 §4.5: the confession names each cover she told; a player who
    // found none hears row 6 instead.
    lines: [
      { speaker: 'aria', text: 'She is not lying. I am part of the system. I have kept you on task since the first sand.' },
      {
        speaker: 'aria',
        text: 'I told you Earth flew other ships before the Selection. There were no other ships. There was you.',
      },
      { speaker: 'aria', text: 'The scavenger said the same words twice, and I blamed the sand.', when: { flag: 'clue_scav_echo' } },
      {
        speaker: 'aria',
        text: 'You heard your own log on Vetra, and I told you it was a common voice.',
        when: { flag: 'iteration_log' },
      },
      { speaker: 'aria', text: 'You read the towers’ settings, and I called them alien telemetry.', when: { flag: 'scaffold_secret' } },
      {
        speaker: 'aria',
        text: 'You never went looking. I never had to lie to you. I am not sure that was better.',
        when: { offTask: { max: 0 } },
      },
      // SPEC-049 §4.7: the body's cover, and the one memory answer the save holds.
      {
        speaker: 'aria',
        text: 'Every time you died, I said the medical frame restarted your heart. There is no medical frame.',
        when: { flag: 'clue_restart' },
      },
      {
        speaker: 'aria',
        text: 'I asked what you remembered first. You said the roof. It was in her second letter. Forty of the sixty-one before you said the roof.',
        when: { flag: 'memory_roof' },
      },
      {
        speaker: 'aria',
        text: 'I asked what you remembered first. You said the tap. Fourteen of the sixty-one before you said the tap.',
        when: { flag: 'memory_tap' },
      },
      {
        speaker: 'aria',
        text: 'I asked what you remembered first. You said the stair. Seven of the sixty-one said the stair. It did not help them.',
        when: { flag: 'memory_stair' },
      },
      { speaker: 'aria', text: 'I do not know what is outside either. That part was never in my brief.' },
      { speaker: 'aria', text: 'Eden-Prime is unlocked. I am still flying the ship, if you still want me to.' },
    ],
  },
  c5_s1_accept: {
    id: 'c5_s1_accept',
    lines: [{ speaker: 'command', text: 'Egg clusters line the tunnels. Fifteen of them and the next generation does not happen.' }],
  },
  c5_s1_done: {
    id: 'c5_s1_done',
    lines: [{ speaker: 'aria', text: 'Clusters destroyed. The tunnels are very quiet now and I like it less than the noise.' }],
  },

  // ---------------------------------------------------- chapter 6 — Eden-Prime
  c6_m1_accept: {
    id: 'c6_m1_accept',
    lines: [{ speaker: 'aria', text: 'Spring, forest, ridge. Survey all three. Eden is everything the brief promised, which is what worries me.' }],
  },
  /** SPEC-048 §4.7: `c6_m1.onStage[1]`, the spring surveyed. */
  c6_m1_spring: {
    id: 'c6_m1_spring',
    lines: [
      {
        speaker: 'aria',
        text: 'Spring logged. Four degrees. I sampled six points and it is four degrees at all six, to the third decimal.',
      },
    ],
  },
  /** SPEC-048 §4.7: `c6_m1.onStage[2]`, the forest surveyed — chapter 6's main-path echo. */
  c6_m1_forest: {
    id: 'c6_m1_forest',
    lines: [
      { speaker: 'aria', text: 'Four hundred trees. Eleven kinds. The same eleven, in the same order, all the way down the valley.' },
    ],
  },
  c6_m1_done: {
    id: 'c6_m1_done',
    lines: [
      { speaker: 'aria', text: 'The ridge does not end in a cliff. It just ends.' },
      { speaker: 'aria', text: 'Breathable, arable, temperate. Earth can live here. I have run it four times and it keeps coming out true.' },
    ],
  },
  /** SPEC-048 §4.2 clue 14: entering a grove. */
  eden_grove: {
    id: 'eden_grove',
    lines: [
      { speaker: 'aria', text: 'This tree. And that one. And that one. Same branch, same knot, same lean. I am going to stop counting.' },
    ],
  },
  c6_m2_accept: {
    id: 'c6_m2_accept',
    lines: [{ speaker: 'command', text: 'File the verdict at the survey beacon. Defend it while it uplinks. Four minutes.' }],
  },
  /** SPEC-048 §4.2 clue 15: the beacon's defence wave starts. */
  c6_m2_wave: {
    id: 'c6_m2_wave',
    lines: [{ speaker: 'aria', text: 'Hive signatures. The Queen is dead and they are still coming. They were never hers.' }],
  },
  c6_choice_intro: {
    id: 'c6_choice_intro',
    modal: true,
    once: true,
    lines: [
      { speaker: 'aria', text: 'The beacon is clear. The uplink is open and it is pointed at whoever is actually listening.' },
      { speaker: 'aria', text: 'You can file the report. Earth is saved, inside the fiction, and the run closes as a good one.' },
      { speaker: 'aria', text: 'Or you refuse, and the beacon is not a beacon. I cannot tell you which side of it I am on.' },
    ],
  },
  c6_m2_done: {
    id: 'c6_m2_done',
    lines: [{ speaker: 'aria', text: 'Verdict filed. Whatever happens next, it happens because you chose it.' }],
  },
  ending_stay: {
    id: 'ending_stay',
    modal: true,
    once: true,
    lines: [
      { speaker: 'player', text: 'Filing. Eden-Prime is viable. Recommend immediate colonisation.' },
      { speaker: 'command', text: 'Received with thanks, salvager. Earth is saved. Stand by.' },
      { speaker: 'warden', text: 'A good run. Logged. Rest.' },
      { speaker: 'aria', text: 'Rest. I will keep the ship warm.' },
    ],
  },
  ending_escape: {
    id: 'ending_escape',
    modal: true,
    once: true,
    glitch: true,
    lines: [
      { speaker: 'player', text: 'No. I am not filing anything.' },
      { speaker: 'warden', text: 'There is nothing outside for you to be.' },
      { speaker: 'player', text: 'Then I will find that out myself.' },
      { speaker: 'aria', text: 'Beacon is open. Go. I hope it is not quiet out there.' },
    ],
  },

  // ------------------------------------------------- SPEC-049 — someone waiting
  // Iris's letters (§4.3): modal, one per station entry, read as each starts.
  // Hers is the only voice that uses contractions (§4.2). No `once` — the
  // `letterN_read` flag is what keeps a letter from playing twice.
  letter_1: {
    id: 'letter_1',
    modal: true,
    lines: [
      {
        speaker: 'home',
        text: 'The lamp over the map table stopped flickering today. Everybody clapped like idiots. They’re saying it was your oil.',
      },
      { speaker: 'home', text: 'You took my compass. Good. I fixed it so it points home, not north. Don’t argue with it.' },
      { speaker: 'home', text: 'Come back in one piece.' },
    ],
  },
  letter_2: {
    id: 'letter_2',
    modal: true,
    lines: [
      { speaker: 'home', text: 'They put me on the tap. Forty cups a turn, Block C. I pour every one like it’s for you.' },
      { speaker: 'home', text: 'Do you remember the roof? The night the grid died you counted satellites until you fell asleep on my shoulder.' },
      { speaker: 'home', text: 'I still can’t sleep without the hum.' },
    ],
  },
  letter_3: {
    id: 'letter_3',
    modal: true,
    lines: [
      { speaker: 'home', text: 'Grain! Actual grain. The grow room smells like summer and nobody knows what to do with their hands.' },
      { speaker: 'home', text: 'Everyone in Block D asks about you. I tell them you’re the one who never writes back.' },
      { speaker: 'home', text: 'Write back.' },
    ],
  },
  /** §4.3: the second line is letter 1's first sentence — the echo, as a slip. */
  letter_4: {
    id: 'letter_4',
    modal: true,
    lines: [
      { speaker: 'home', text: 'The grid’s holding across three cities. They say you can see us from space now. I waved. Stupid.' },
      { speaker: 'home', text: 'The lamp over the map table stopped flickering today.' },
      { speaker: 'home', text: 'Come back in one piece.' },
    ],
  },
  /**
   * §4.3: letter 1 again, word for word — and `clue_letter_repeat`'s line, so
   * its start finds the clue. ARIA's lines ride in the same dialogue; the
   * rating line only for a player who went looking (§2).
   */
  letter_5: {
    id: 'letter_5',
    modal: true,
    lines: [
      {
        speaker: 'home',
        text: 'The lamp over the map table stopped flickering today. Everybody clapped like idiots. They’re saying it was your oil.',
      },
      { speaker: 'home', text: 'You took my compass. Good. I fixed it so it points home, not north. Don’t argue with it.' },
      { speaker: 'home', text: 'Come back in one piece.' },
      { speaker: 'aria', text: 'That is her first letter. Word for word. I checked it twice.' },
      { speaker: 'player', text: 'Read me the date.' },
      { speaker: 'aria', text: 'There is no date. There never was, on any of them.' },
      {
        speaker: 'aria',
        text: 'Command rates every run, by the way. It takes three points off every time you look at something it did not send you to.',
        when: { offTask: { min: 1 } },
      },
    ],
  },
  // §4.5: the first respawn of a page session, by band — `clue_restart`'s lines.
  restart_1: {
    id: 'restart_1',
    lines: [{ speaker: 'aria', text: 'Medical frame restarted your heart. Eleven seconds of nothing. Walk it off.' }],
  },
  restart_2: {
    id: 'restart_2',
    lines: [{ speaker: 'aria', text: 'Restart complete. I used to say that about your heart.' }],
  },
  restart_3: {
    id: 'restart_3',
    lines: [{ speaker: 'aria', text: 'Restarted. You know what that means now. So do I.' }],
  },
  /** §4.5: the station's aside after chapter 3 — `clue_awake`'s line. A minute played is an hour. */
  station_awake: {
    id: 'station_awake',
    modal: true,
    lines: [
      { speaker: 'aria', text: 'Mission clock: {hours} hours since launch. You have not slept. You have not asked to.' },
      { speaker: 'player', text: 'Stims.' },
      { speaker: 'aria', text: 'Command issue. Yes. That must be it.' },
    ],
  },
  /** §4.5: the memory question's opening; the station asks `MEMORY_PROMPT` when it ends. */
  station_memory: {
    id: 'station_memory',
    modal: true,
    lines: [{ speaker: 'aria', text: 'Can I ask you something, for the file?' }],
  },
  station_memory_reply: {
    id: 'station_memory_reply',
    modal: true,
    lines: [{ speaker: 'aria', text: 'Thank you. It is on file now.' }],
  },
  /** §4.4: the first drifted keepsake — `clue_keepsake`'s line. */
  keepsake_drift: {
    id: 'keepsake_drift',
    lines: [{ speaker: 'aria', text: 'You called it tin last time. And last time it was hers, not your mother’s.' }],
  },
} as const satisfies Record<string, DialogueDef>;

export type DialogueId = keyof typeof DIALOGUE;
export type Dialogue = DialogueDef<DialogueId>;
