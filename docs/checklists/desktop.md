# Desktop checklist

Desktop Chrome with a mouse and a keyboard, plus Firefox and Safari for the shell and the films. Every shared group is played with that input; the surface is Cinder-4 unless an item names another planet.

Copy this list into the milestone's section of [`docs/playtest-log.md`](../playtest-log.md) and tick it there; a failed item becomes a [`docs/BUGS.md`](../BUGS.md) entry with its severity (SPEC-016 §6).

## Shell and lifecycle

- [ ] Cold load with the network throttled: the bar moves, the percentage reads, the game starts only on its button, and the first tap plays the UI blip [SPEC-031 §7, SPEC-006 §7]
- [ ] Menu → station → star map → station twenty times: `geo` and `tex` in the overlay stay within ±2 [SPEC-003 §7]
- [ ] Hide the page mid-flight and mid-surface (tab switch, or lock the phone for 30 s): no burst on return, the pause menu is up, and play resumes only on a tap or a key [SPEC-002 §7, SPEC-003 §7]
- [ ] Create each class, play, and reload to restore; delete a slot; an export code pasted into another browser restores the character [SPEC-007 §7, SPEC-014 §7]
- [ ] Volume sliders act live and survive a reload; music crossfades from the menu to the station without a gap [SPEC-006 §7]
- [ ] Every screen shows one frame in portrait and landscape, with nothing stray in a corner and text legible over the brightest backdrop [SPEC-031 §7]

## Surface

- [ ] All five Cinder-4 missions complete; the overlay's layout hash is the same after a reload; going to the station and back keeps mission state [SPEC-012 §7, SPEC-008 §7]
- [ ] The sandstorm is telegraphed and survivable; inside a cave or a wreck the roof lifts and the storm stops biting [SPEC-012 §7, SPEC-030 §7]
- [ ] Skitters swarm and hop, raiders keep their distance and telegraph, wurmlings rush, elites appear about one in twenty, and the dune wurm burrows and resurfaces [SPEC-011 §7]
- [ ] Death, then respawn with the resource loss shown; telegraphs read at 30 fps [SPEC-011 §7, SPEC-012 §7]
- [ ] Walking up the screen moves the minimap arrow straight up; the pad, the dune sea, the beacon, the nest and a landmark are told apart without the legend; walked ground stays lit after a return; the full map opens and closes and holds a swarm still [SPEC-026 §7]
- [ ] A first-time player finishes `c1_m1`–`c1_m3` from the tracker, the marker and the hints alone; where they hesitated is noted [SPEC-027 §7]
- [ ] Weapons switch by key, wheel and tap; the medkit count reads mid-fight; a ration refills the heal slot [SPEC-028 §7]
- [ ] A rocket, the chaingun until it locks, and the pistol while it cools clear a swarm; mines in front of the nest catch the wurm; a grenade clears raiders behind a rock; no explosive hurts the player; the frame rate holds with six mines armed [SPEC-029 §7]
- [ ] Every edge is a wall with no open ground past it; raiders who lose sight inside a wreck give up [SPEC-030 §7]
- [ ] At each preset, the light, the soft shadows (high), the glow (medium and high), the vignette, the ground detail and the scatter look as specified, including at 21:9 [SPEC-017 §7, SPEC-018 §7, SPEC-019 §7]

## Flight

- [ ] Station → star map → Cinder-4: steering, shooting, an asteroid hit, shield regen, and the landing cutscene into the surface [SPEC-013 §7]
- [ ] Crashing on purpose recalls the ship: the station shows the recalled banner, and the fuel was charged once [SPEC-013 §7]
- [ ] Ferrum with `?ship.shield=2` shows an ion storm, and the sky tints [SPEC-013 §7, SPEC-020 §7]
- [ ] The launch is one continuous move from outside the tug into the cockpit; a flown route's next run can be skipped and lands where a flown run lands; a run carrying a flight mission refuses the skip with a reason [SPEC-032 §7]

## Station, star map and menus

- [ ] Buying every ship tier (each with its confirm sheet), a companion level and a craft batch keeps the balance readable; something out of reach refuses [SPEC-014 §7, SPEC-031 §7]
- [ ] The star map gives the right reason for every locked planet; with 0 oil, the subsidy still lets the ship depart to Cinder-4 [SPEC-014 §7, SPEC-010 §8]
- [ ] The credits list the licenses [SPEC-014 §7]
- [ ] The service code (`asdf`, or a 3 s press on the build label) shows the badge everywhere; the Service section in settings turns it off [SPEC-032 §7]

## Story

- [ ] New Game plays the prologue with music and cues; the captions read at arm's length; Skip and Escape work; with reduce motion the posters appear without motion [SPEC-022 §7]
- [ ] Chapter 1 plays in order: the departure, the card over the launch, the reveal at the nest, the fight, the return, "First Light", the debrief; a replay of `c1_m3` plays nothing new [SPEC-023 §7]
- [ ] From one save copy, finish the campaign both ways: the intro reads in full; dialogue, film and overlay play in order; stay returns to a quiet Eden and escape lands on the menu; killing the tab during the film brings the ending back on the next Continue [SPEC-024 §7]
- [ ] A v1 slot saved before R10 loads with its character, missions and resources intact (once) [SPEC-025 §7]

## Performance

- [ ] `?perf&quality=medium` on the surface, then with `&scene=flight`, `&scene=station` and `&scene=menu`: the four `perf-row`s are pasted into the milestone's section; a row over its budget is a P1 [SPEC-015 §5, SPEC-016 §8]

## Desktop only

- [ ] Resizing the window never stretches the picture [SPEC-002 §7]
- [ ] Alt-tab mid-move releases every key [SPEC-005 §7]
- [ ] The debug overlay's context-loss button shows the overlay, and the scene recovers [SPEC-002 §7]
- [ ] Every film plays with sound in Chrome and Safari; captions sit on their pictures, cues land on their frames, and nothing strobes [SPEC-021 §9, SPEC-022 §7]
- [ ] With storage denied, the storage-unavailable banner appears [SPEC-014 §7]
