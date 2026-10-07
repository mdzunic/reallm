# Playtest — the lead's own session (P-)

**Build:** `main` at `dfe6f04` (2026-10-07), the dev server, `?debug` only where it says so.

**How it was played.**
- **A new game in the Claude browser pane:** slot 2, a Scout named "Reyes", Normal. It covered the prologue, creation, the station, the star map, the first trip to Cinder-4, the landing and *Dry Land* stage 1.
  - The pane was hidden, so the game drew at 2–9 fps there and the fixed-step loop simulated at about a sixth of real time.
- **Everything else, headless, in Playwright's full Chromium on this Mac's GPU at 60 fps.** Each run used a browser context of its own, so the pane's saves were never touched.
  - All six planets from the pad at 1280 × 720 on `high`.
  - The debug strip's content: raiders, the wreck, a storm, descents, vaults, puzzles, landmarks, groves, packs and bosses, plus a boss seen from range.
  - A phone at 844 × 390, touch, `medium`, and at 390 × 844 portrait.
  - The station from a fresh save.
  - Every film, sampled into contact sheets.

**Severity:** P0 blocks play · P1 hurts most players · P2 noticeable · P3 polish. **Effort:** S ≤ ½ day · M ≤ 2 days · L > 2 days. Where an auditor found the same thing, the row says so.

| ID | Sev | What I saw | Evidence | Fix | Effort |
|---|---|---|---|---|---|
| P-01 | P2 story | The station header says **"Containment level 1"** on the first screen of the game, and the first chapter card says `containment level 1`. That is the twist's own word, shown before the player has a single clue. PLAN §1 makes it deliberate (R2: "the chapter number is the Warden's containment level"), and the review challenges that choice | `src/scenes/StationScene.ts:581`; PLAN §1, §5 | Use a fiction label first ("Threat level N"), and let it **glitch** to "Containment level" when the chapter-4 notice plays. That is a reveal beat which costs one CSS class and one flag. Needs an R-entry | S |
| P-02 | P2 story / visual | The tug's hull reads **RL-07** on both wings. Command calls it **CR-62**, the Hive clue rests on a wreck "registry CR-61", and the "Wreckers" film paints "CR" on the hull | `scripts/assets/blender/ships.py:103`; `src/data/dialogue.ts:57, 450-451`; `src/data/clues.ts:208`; [cinder4-landing](shots/cinder4-landing.jpg) | Paint CR-62 in the generator. Give the Hive wreck a visible CR-61 (a runtime decal that follows `{prior}`), so the clue is *seen* as well as *told* | S / M |
| P-03 | P3 story | The prologue says "Without power, the machines ran down where they stood" over a plate in which every Machine's eyes are **lit red** | prologue at about 56–64 s; [film-prologue](shots/film-prologue.jpg) row 3 | Grade the eyes dark in that plate | S |
| P-04 | P2 visual | The films mix photographic plates with flat Blender shots in grey voids: interlude_c1 opens on an orange dome on flat grey, c2 on a tub of white blobs, c4 on a striped cylinder. The **stay ending**, the payoff, is cartoon cone pines and a block skyline. The escape ending's grey "unmaking" works because it is deliberate. The visual audit (V-13) found the escape ending's last poster is that blockout | [film-interlude-c1](shots/film-interlude-c1.jpg), [c2](shots/film-interlude-c2.jpg), [ending-stay](shots/film-ending-stay.jpg), [ending-escape](shots/film-ending-escape.jpg) | A plate pass (or the plate grade) on the CGI shots that are not deliberate, starting with the first shot of each ending. R21 parked the capsule, tank and reactor retakes under "Not now" | M–L |
| P-05 | P2 story | Card **No. 62** is a white helmet among photographed faces. At 75 s into the prologue it reads as "the robot one". Together with P-01, the twist is announced, not discovered. This is the same question as the visual audit's V-12 | prologue at about 75 s, interlude_c5, both endings | Decide in PLAN whether the clash is the point. If not, use a photographic visor portrait in the style of the other cards, and keep the escape ending's "every card is the same visor" as the reveal | S–M |
| P-06 | P2 UI | The off-screen waypoint arrow lands **on the quick bar** or the tip strip whenever the target lies below the player: 4 of 6 planets at 1280 × 720, and on the phone "12 m" sits inside the tip text. Same as **V-04** | `src/ui/Waypoint.ts`; [cinder4-landing](shots/cinder4-landing.jpg), [vetra-fight](shots/vetra-fight.jpg), [phone](shots/phone-landscape-first-landing.jpg) | Clamp the edge marker to a rectangle that excludes the quick-bar band and the tip strip | S |
| P-07 | P2 mobile | At 844 × 390, the tracker panel, the resource bar and the first tip strip cover most of the top half of the screen, and the tip hides the pad on the first landing | [phone-landscape-first-landing](shots/phone-landscape-first-landing.jpg) | A one-line tracker on short landscape, a narrower and lower tip strip, and tips that fade after the first move | M |
| P-08 | P2 bug | The one-time puzzle tip always says "Arrows move, Enter turns a tile". That is wrong for 4 of the 5 kinds (sequence, plates, beam, calibration), and whichever puzzle comes first uses the tip up | `src/data/hints.ts:189-193`; `src/data/puzzles.ts:64-80`; [vetra-sequence-puzzle](shots/vetra-sequence-puzzle.jpg) | One tip per puzzle kind | S |
| P-09 | P3 UI | Difficulty reads **Story · Normal · Casual · Hard** in creation and in settings | `src/scenes/CreationScene.ts:658`; `src/ui/settingsRows.ts:289`. `DIFFICULTIES` itself is story, casual, normal, hard | Story · Casual · Normal · Hard | S |
| P-10 | P1 visual | From the 22 m camera, about 80 % of every frame is one tiling ground material. Cinder-4 has no dunes, Ferrum is near-black with thin cracks, Vetra is a white sheet, and near the pads Thessaly and Eden are lawns. Landmarks are primitive: Ferrum's arch is two flat orange tubes, and Cinder-4's wreck is a black slab. Eden's grove of GLB trees shows what the game can look like. This expands the visual audit's **V-01 / V-05** | [cinder4-landing](shots/cinder4-landing.jpg), [ferrum-pad](shots/ferrum-pad.jpg), [thessaly-near-pad](shots/thessaly-near-pad.jpg), [ferrum-landmark](shots/ferrum-landmark.jpg), [cinder4-wreck-storm](shots/cinder4-wreck-storm.jpg), [eden-grove](shots/eden-grove.jpg) | Dress each planet *along the walked path*: height and rock outcrops on Cinder-4, emissive lava channels on Ferrum, ridges and sastrugi on Vetra, ruins on Thessaly. Model the landmarks for real | L |
| P-11 | P3 visual | In the underground, dust motes draw as crisp white points over the black void beyond the cave walls, so they read as stars | [ferrum-underground](shots/ferrum-underground.jpg); the Cinder-4 descent and the Eden machine room too | Dim and tint the motes, and fade them outside the light | S |
| P-12 | P2 pacing | The first trip, to Cinder-4, lasts 90 s with `groups: []` and asteroid density 0.2. An idle pilot meets one or two rocks and takes no damage. It cannot be skipped ("Autopilot needs a route — fly this run once"). Same as **G-08 / G-20** | `src/data/waves.ts:116-121`; the star map's confirm dialog | A shorter tutorial trip, or a scripted asteroid lane plus one harmless target | S–M |
| P-13 | P3 polish | "ReaLLM 0.0.0" is printed bottom-left on every screen, the surface HUD included. Same as **D-07** | `package.json`; `src/main.ts:43` | A real version and a short commit hash; hide the label in play | S |
| P-14 | P3 tech | three r185 warns on every load: `PCFSoftShadowMap has been deprecated. Using PCFShadowMap instead` | the console, on `high` | Set `PCFShadowMap` explicitly | S |
| P-15 | P3 UI | The new-game slot picker opens over the menu with no dim and no Cancel | the menu | Add a dim and a Cancel/Back | S |
| P-16 | P3 a11y | Creation's three class cards are unnamed buttons to assistive tech, and the portraits are named "Portrait 1, 2, 3, 10, 11, 12" | the accessibility tree | An `aria-label` with the class name; number the portraits 1–6 | S |

## What works (keep it)

- **The opening.** Boot to the first shot is short. The prologue's photographic plates are strong, and Command's first line names the player.
- **The first landing** ramps, and auto-fire is on by default.
- **Touch, after a real tap:** the joystick, the drag-to-aim, the dash button and the 2 × 3 quick bar.
- **Raiders in the salvager's suit** read as people ([cinder4-raiders](shots/cinder4-raiders.jpg)).
- **Places:**
  - the Vetra body in its ice spike;
  - the Eden grove;
  - the Eden machine-room corridor;
  - the Broodlord's arena ring seen from range ([thessaly-broodlord](shots/thessaly-broodlord.jpg)).
- **The escape ending's card wall,** where every card is the same visor.
- **Performance:** 55–60 fps on `high` on all six planets, at ≤ 74 draws and ≤ 57 k triangles. The one console message is P-14's warning.

## Checked and dropped

- **The flight "skip" hint seemed to stay up in the cockpit.** That was only the hidden pane's one-sixth speed. At 60 fps it hides at 4.5 s, as soon as the launch phase ends.
- **A white blob over the bosses.** It appears only when the debug button spawns a boss on top of the player. Seen from range, both bosses read.
- **The phone HUD at first showed keyboard hints and no touch controls.** That was the harness clicking the start gate with a mouse. A real tap switches the scheme correctly.
