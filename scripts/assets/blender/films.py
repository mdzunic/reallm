# Story films (PLAN R9, SPEC-021): the prologue, the departure, the contact film
# "Wreckers" (PLAN R24, SPEC-063), five chapter interludes and the two endings, rendered in EEVEE from code and written to
# public/assets/films/ as H.264 MP4 + one WebP poster per shot + a manifest.
#
#   node scripts/assets/blender/build.mjs films                       # every film (hours)
#   node scripts/assets/blender/build.mjs films --only=prologue       # one film
#   node scripts/assets/blender/build.mjs films --draft --preview=DIR # half size, never public/
#   node scripts/assets/blender/build.mjs films --stills --shots=launch --preview=DIR   # poster frames only
#   node scripts/assets/blender/build.mjs films --stills --shots=launch --at=1,4 --preview=DIR   # chosen moments
#
# Frames are cached under --frames=DIR (default: the OS temp dir) keyed by a hash
# of each shot's code and of any plate it shows, so a rebuild re-renders only what
# changed. The shot table mirrors src/data/films.ts; tests/data/films.test.ts
# checks the two agree. A shot's `checks` (SPEC-051) hold its rendered frames to
# their rule — the lit box, the black run, a cut's swing — and fail the build.
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'lib'))

import bpy  # noqa: E402

import common as C  # noqa: E402
import earth as E  # noqa: E402
import figures as FG  # noqa: E402
import film as F  # noqa: E402
import plate as PL  # noqa: E402
import salvager as SV  # noqa: E402
import shots_contact as K  # noqa: E402
import shots_endings as X  # noqa: E402
import shots_interludes as I  # noqa: E402
import shots_prologue as P  # noqa: E402

S = F.Shot
# Photographic plates (PLAN R11, R12; SPEC-051): the shots that show people, the
# strike, the street and Iris
CURFEW_PLATE = PL.path('prologue_curfew')
SABOTAGE_PLATE = PL.path('prologue_sabotage')
REPRISAL_PLATE = PL.path('prologue_reprisal')
CITY_PLATE = PL.path('prologue_city_flash')
STRANDED_PLATE = PL.path('prologue_stranded')
SHELTER_PLATE = PL.path('prologue_shelter')
TAP_PLATE = PL.path('interlude_c2_tap')
GREENHOUSE_PLATE = PL.path('interlude_c3_greenhouse')
# SPEC-051 §4.1: what the Selection wall pins — the six faces and the salvager's visor
CARDS = PL.FACES + (PL.VISOR,)
GROVE = (X.eden_grove, X.broadleaf, X.conifer, X.bush, X.tufts, X._tone, X._leaves, P.sky_gradient, P.concrete)

FILMS = [
    F.Film('prologue', [
        S('earth_night', 0, 8, 5, P.earth_night, deps=(E, P.satellite)),
        S('machine_hall', 8, 16, 14, P.machine_hall, deps=(FG, P.concrete, P.boxes, P.eye_mat)),
        S('curfew', 16, 23, 20, PL.shot(CURFEW_PLATE, push=0.02, drift=(0.12, 0.0), exposure=0.80, saturation=0.95),
          samples=8, deps=(PL,), plates=(CURFEW_PLATE,)),
        S('sabotage', 23, 30, 25, PL.shot(SABOTAGE_PLATE, push=0.08, drift=(0.0, -0.01), exposure=0.95, saturation=0.95, flash=(6.2, 3.0)),
          samples=8, deps=(PL,), plates=(SABOTAGE_PLATE,)),
        S('reprisal', 30, 37, 34, PL.shot(REPRISAL_PLATE, push=-0.07, drift=(0.02, 0.0), exposure=0.76, saturation=0.95),
          samples=8, deps=(PL,), plates=(REPRISAL_PLATE,)),
        S('launch', 37, 46, 43, P.launch, deps=(E,)),
        S('city_flash', 46, 56, 50, PL.shot(CITY_PLATE, push=-0.05, exposure=0.92, saturation=0.95, flash=(1.25, 1.9)),
          samples=8, deps=(PL,), plates=(CITY_PLATE,), bloom=0.7),
        S('stranded', 56, 66, 63, PL.shot(STRANDED_PLATE, push=-0.04, drift=(0.02, 0.0), exposure=0.8, saturation=0.9,
                                          lift=(0.0, 0.85, 10.0), overlays=P.STRANDED_EYES or PL.glints,
                                          overlay_off=P.STRANDED_OFF),
          samples=8, deps=(PL,), plates=(STRANDED_PLATE,)),
        S('shelter', 66, 75, 71, PL.shot(SHELTER_PLATE, push=0.07, drift=(0.006, -0.008), exposure=0.75, saturation=0.92, flicker=0.06),
          samples=8, deps=(PL,), plates=(SHELTER_PLATE,)),
        S('selection', 75, 83, 81, P.selection, deps=(P.selection_wall, P.stamp), plates=CARDS),
        S('liftoff', 83, 90, 87, P.liftoff, samples=16, deps=(PL, P.tug, P.sky_gradient), plates=(P.LIFTOFF_PLATE,)),
        S('relay', 90, 93, 91, P.relay, deps=(E, P.tug)),
    ], flashes=(29.2, 47.25)),
    F.Film('departure', [
        S('undock', 0, 4, 2, P.undock, deps=(E, P.tug)),
        S('jump', 4, 7, 4.5, P.jump, deps=(P.tug,)),
    ], flashes=(6.25,)),
    F.Film('wreckers', [   # SPEC-063 §4.1, §4.2
        S('hulk', 0, 4, 2, K.hulk_shot, deps=(K,)),
        S('cutting', 4, 8.5, 6.5, K.cutting, deps=(K, SV)),
        S('sortie', 8.5, 12, 10.5, K.sortie, deps=(K,)),
    ]),
    F.Film('interlude_c1', [
        S('capsule', 0, 5, 3, I.capsule, deps=(P.spaceport, P.gantry, P.sky_gradient, P.concrete, P.boxes)),
        S('shelter_light', 5, 10, 8.5, PL.shot(SHELTER_PLATE, push=0.06, drift=(-0.006, 0.004), exposure=0.55,
                                             saturation=0.92, flicker=0.05, lift=(2.0, 1.55, 0.5)),
          samples=8, deps=(PL,), plates=(SHELTER_PLATE,)),
        S('earth_c1', 10, 14, 12.5, I.earth_c1, deps=(E, I.earth_relit), checks=(F.lit_box_check,)),
    ]),
    F.Film('interlude_c2', [
        S('tanks', 0, 5, 3.5, I.tanks, samples=32, deps=(P.concrete,)),
        S('tap', 5, 10, 8, PL.shot(TAP_PLATE, push=0.05, drift=(0.012, -0.004), exposure=0.95, saturation=0.95),
          samples=8, deps=(PL,), plates=(TAP_PLATE,)),
        S('earth_c2', 10, 14, 12.5, I.earth_c2, deps=(E, I.earth_relit), checks=(F.lit_box_check,)),
    ]),
    F.Film('interlude_c3', [
        S('greenhouse', 0, 7, 5.5, PL.shot(GREENHOUSE_PLATE, push=0.06, drift=(0.01, 0.0), exposure=0.85, saturation=0.95,
                                           lift=(0.5, 1.2, 5.0)),
          samples=8, deps=(PL,), plates=(GREENHOUSE_PLATE,), checks=(F.mean_check(0.007, 0.138),)),
        S('earth_c3', 7, 14, 12, I.earth_c3, deps=(E, I.earth_relit, I._lattice), checks=(F.lit_box_check,)),
    ]),
    F.Film('interlude_c4', [
        S('reactor', 0, 6, 4.5, I.reactor, samples=32, deps=(P.concrete,)),
        S('earth_c4', 6, 11, 9.5, I.earth_c4, deps=(E, I.earth_relit)),
        S('watchers', 11, 16, 13.5, I.watchers, deps=(E, I.tear, X.clay), checks=(F.swing_check(4.1, 4.35),)),
    ]),
    F.Film('interlude_c5', [
        S('hive_dark', 0, 6, 4, I.hive_dark, deps=(E,), checks=(F.black_run_check,)),
        S('eden', 6, 12, 10, I.eden, deps=(E, P.tug)),
        S('board', 12, 16, 14.5, I.board, deps=(P.selection_wall, P.stamp), plates=CARDS),
    ]),
    F.Film('ending_stay', [
        S('uplink', 0, 6, 3, X.uplink, deps=GROVE),
        S('fleet', 6, 14, 11, X.fleet, deps=(FG, P.spaceport, P.gantry, P.tug, P.sky_gradient, P.concrete, P.boxes)),
        S('earth_full', 14, 21, 18, X.earth_full, deps=(E,)),
        S('wall_63', 21, 30, 28, X.wall_63, deps=(P.selection_wall, P.stamp), plates=CARDS),
        S('earth_again', 30, 36, 32, X.earth_again, deps=(E, P.earth_night, P.satellite)),
    ]),
    F.Film('ending_escape', [
        S('exit', 0, 6, 3, X.exit_door, deps=GROVE),
        S('eden_unmade', 6, 14, 11, X.eden_unmade, deps=(E,)),
        S('earth_unmade', 14, 22, 18, X.earth_unmade, deps=(PL, X.clay), plates=(CITY_PLATE, STRANDED_PLATE, SHELTER_PLATE),
          checks=(F.unmake_check(X.UNMAKE),)),
        S('wall_same', 22, 29, 26, X.wall_same, deps=(P.selection_wall,), plates=CARDS + (PL.VISOR_EMPTY,)),
        S('point', 29, 36, 32, X.point, deps=(X.clay,)),   # review 2026-10 V-13: the point of light, not the blockout
    ]),
]
ORDER = ['prologue', 'departure', 'wreckers', 'interlude_c1', 'interlude_c2', 'interlude_c3', 'interlude_c4', 'interlude_c5',
         'ending_stay', 'ending_escape']


def wanted(opts, film):
    return not opts['only'] or film.id in opts['only']


def still(film, shot, opts):
    """Render one shot's poster frame, or its shot-local times in --at (look
    development; nothing is written to public/)."""
    scene = C.reset()
    F.setup(scene, shot, opts['draft'])
    shot.build(F.Ctx(scene, film, shot, opts))
    for at in opts['at'] or [None]:
        scene.frame_set(F.frame(shot.poster - shot.start if at is None else at))
        name = f'still_{film.id}_{shot.id}' + ('' if at is None else f'_t{at:g}')
        path = os.path.join(opts['preview'] or opts['frames'], name + '.png')
        scene.render.filepath = C.ensure_dir(path)
        bpy.ops.render.render(write_still=True)
        print(f'PREVIEW {path}')
        if at is None and F.lit_box_check in shot.checks:   # SPEC-051 §4.4: the coast framed from a still
            for problem in F.lit_box_problems(f'{film.id}/{shot.id}', F._load(path)):
                print(f'WARN {problem}')


def main():
    opts = F.options()
    entries = {}
    for film in FILMS:
        if not wanted(opts, film):
            continue
        if opts['stills']:
            for shot in film.shots:
                if not opts['shots'] or shot.id in opts['shots']:
                    try:
                        still(film, shot, opts)
                    except Exception:  # look development: report and keep going
                        import traceback
                        traceback.print_exc()
                        print(f'WARN still {film.id}/{shot.id} failed')
            continue
        entry, dirs = F.build_film(film, opts)
        if entry is not None:
            entries[film.id] = entry
        if opts['preview']:
            F.sheet(film, dirs, os.path.join(opts['preview'], f'sheet_film_{film.id}.png'))
    if entries:
        F.write_manifest(opts['out'], entries, ORDER)


main()
