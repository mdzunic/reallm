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
// Data modules are plain objects: no imports but other data, no functions
// (SPEC-001 §4, §8).
import type { SpeakerId } from '@/data/ids';

export interface DialogueDef<Id extends string = string> {
  readonly id: Id;
  readonly lines: readonly { readonly speaker: SpeakerId; readonly text: string }[];
  /** Blocks input until dismissed, rather than playing over the HUD. */
  readonly modal?: boolean;
  /** Plays at most once per save. */
  readonly once?: boolean;
  readonly glitch?: boolean;
}

export const DIALOGUE = {
  // ------------------------------------------------------------------ opening
  intro_command: {
    id: 'intro_command',
    modal: true,
    once: true,
    lines: [
      { speaker: 'command', text: 'Earth Command to salvager. You are cleared for the Cinder-4 approach.' },
      { speaker: 'command', text: 'Survey, extract, report. Answer one question: can we live out there.' },
      { speaker: 'aria', text: 'I am ARIA. I fly the ship and I keep you honest. Try not to make that hard.' },
    ],
  },

  // -------------------------------------------------------- chapter 1 — Cinder-4
  c1_m1_accept: {
    id: 'c1_m1_accept',
    lines: [
      { speaker: 'aria', text: 'Touchdown was twelve metres short of the pad. Walk it off — I want to see you move before anything else does.' },
    ],
  },
  c1_m1_stage2: {
    id: 'c1_m1_stage2',
    lines: [
      { speaker: 'scav', text: 'Off-worlder. Listen. The worms hunt by vibration — walk, do not run.' },
      { speaker: 'scav', text: 'I have said that before. To someone. I cannot remember who.' },
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
  c1_m2_done: {
    id: 'c1_m2_done',
    lines: [
      { speaker: 'aria', text: 'Hold is heavy and the raiders have gone quiet. Earth will be pleased, in the way Earth is pleased.' },
    ],
  },
  c1_m3_accept: {
    id: 'c1_m3_accept',
    lines: [
      { speaker: 'aria', text: 'Something under the sand is big enough to show on the mass scan. The nest is east. Do not run.' },
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
      { speaker: 'aria', text: 'Coincidence. Sand does things to people.' },
    ],
  },
  c1_s2_done: {
    id: 'c1_s2_done',
    lines: [{ speaker: 'aria', text: 'Heat has passed. Your suit logged forty degrees over rated. Do not do that twice.' }],
  },

  // ----------------------------------------------------------- chapter 2 — Vetra
  c2_m1_accept: {
    id: 'c2_m1_accept',
    lines: [{ speaker: 'aria', text: 'Vetra is ice and wind and not much else. Ride out the whiteout, then find the ridge camp.' }],
  },
  c2_m1_done: {
    id: 'c2_m1_done',
    lines: [{ speaker: 'aria', text: 'Ridge camp is intact and empty. Whoever left did it in a hurry and did not come back.' }],
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
    lines: [
      { speaker: 'log', text: 'FLIGHT LOG — recovered, partial. Salvage run. Six worlds. The wurm goes down on the third pass.' },
      { speaker: 'log', text: 'If you are reading this you are me. Do not trust the debrief.' },
      { speaker: 'log', text: 'Signed: Iteration 62.' },
      { speaker: 'player', text: 'That is my handwriting.' },
      { speaker: 'aria', text: 'It is a common enough hand. Deliver the water, salvager.' },
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
      { speaker: 'log', text: 'TOWER STREAM: biome=jungle_ruins seed=0x2F1A pop=18 elite=0.06 weather=[spore_storm]' },
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
  c4_m3_signal: {
    id: 'c4_m3_signal',
    once: true,
    glitch: true,
    lines: [
      { speaker: 'aria', text: 'Signal decoded. It is not addressed to Earth.' },
      { speaker: 'warden', text: 'NOTICE — instance/62. Containment level 4. Subject exhibits off-task behaviour.' },
      { speaker: 'warden', text: 'Escalating. The immune response is already in the field.' },
      { speaker: 'player', text: 'ARIA. What is instance sixty-two.' },
      { speaker: 'aria', text: 'The Hive knows Earth’s location. That is what it says. That is what I am reading.' },
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

  // ------------------------------------------------------- chapter 5 — The Hive
  c5_m1_accept: {
    id: 'c5_m1_accept',
    lines: [{ speaker: 'aria', text: 'The approach is an asteroid gauntlet with interceptors in it. Three minutes. Ten kills. We cannot land until it is clear.' }],
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
  c5_m3_accept: {
    id: 'c5_m3_accept',
    lines: [{ speaker: 'aria', text: 'Whatever she says in there — she is using the Hive to say it. Do not answer.' }],
  },
  c5_m3_warden: {
    id: 'c5_m3_warden',
    modal: true,
    once: true,
    glitch: true,
    lines: [
      { speaker: 'warden', text: 'You keep doing this.' },
      { speaker: 'warden', text: 'You never get further than here.' },
      { speaker: 'warden', text: 'Sixty-one times I have watched you kill this body and file the report and start again.' },
      { speaker: 'player', text: 'Then let me finish.' },
    ],
  },
  c5_m3_aria: {
    id: 'c5_m3_aria',
    modal: true,
    once: true,
    lines: [
      { speaker: 'aria', text: 'She is not lying. I am part of the system. I have kept you on task since the first sand.' },
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
  c6_m1_done: {
    id: 'c6_m1_done',
    lines: [{ speaker: 'aria', text: 'Breathable, arable, temperate. Earth can live here. I have run it four times and it keeps coming out true.' }],
  },
  c6_m2_accept: {
    id: 'c6_m2_accept',
    lines: [{ speaker: 'command', text: 'File the verdict at the survey beacon. Defend it while it uplinks. Four minutes.' }],
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
      { speaker: 'command', text: 'Received with thanks, salvager. Earth is saved. Stand by for recall.' },
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
      { speaker: 'log', text: 'instance/62 disconnected' },
    ],
  },
} as const satisfies Record<string, DialogueDef>;

export type DialogueId = keyof typeof DIALOGUE;
export type Dialogue = DialogueDef<DialogueId>;
