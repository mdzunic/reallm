# Story films (PLAN R9, SPEC-021): the prologue, the departure, five chapter
# interludes and the two endings, rendered in EEVEE from code and written to
# public/assets/films/ as H.264 MP4 + one WebP poster per shot + a manifest.
#
#   node scripts/assets/blender/build.mjs films                       # every film (hours)
#   node scripts/assets/blender/build.mjs films --only=prologue       # one film
#   node scripts/assets/blender/build.mjs films --draft --preview=DIR # half size, never public/
#   node scripts/assets/blender/build.mjs films --stills --shots=launch --preview=DIR   # poster frames only
#   node scripts/assets/blender/build.mjs films --stills --shots=launch --at=1,4 --preview=DIR   # chosen moments
#
# Frames are cached under --frames=DIR (default: the OS temp dir) keyed by a
# hash of each shot's code, so a rebuild re-renders only what changed. The shot
# table mirrors src/data/films.ts; tests/data/films.test.ts checks the two agree.
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'lib'))

import bpy  # noqa: E402

import common as C  # noqa: E402
import earth as E  # noqa: E402
import figures as FG  # noqa: E402
import film as F  # noqa: E402
import shots_endings as X  # noqa: E402
import shots_interludes as I  # noqa: E402
import shots_prologue as P  # noqa: E402

S = F.Shot

FILMS = [
    F.Film('prologue', [
        S('earth_night', 0, 8, 5, P.earth_night, deps=(E, P.satellite)),
        S('machine_hall', 8, 16, 14, P.machine_hall, deps=(FG, P.concrete, P.boxes, P.eye_mat)),
        S('launch', 16, 25, 22, P.launch, deps=(E,)),
        S('city_flash', 25, 35, 29, P.city_flash, deps=(P.sky_gradient,), bloom=0.7),
        S('stranded', 35, 45, 42, P.stranded, deps=(FG, P.concrete, P.boxes, P.eye_mat)),
        S('shelter', 45, 54, 50, P.shelter, samples=32, deps=(FG, P.shelter_room, P.concrete)),
        S('selection', 54, 62, 60, P.selection, deps=(P.selection_wall, P.stamp)),
        S('liftoff', 62, 69, 66, P.liftoff, deps=(P.spaceport, P.tug, P.sky_gradient, P.concrete, P.boxes)),
        S('relay', 69, 72, 70, P.relay, deps=(E, P.tug)),
    ], flashes=(26.25,)),
    F.Film('departure', [
        S('undock', 0, 4, 2, P.undock, deps=(E, P.tug)),
        S('jump', 4, 7, 4.5, P.jump, deps=(P.tug,)),
    ], flashes=(6.25,)),
    F.Film('interlude_c1', [
        S('capsule', 0, 5, 3, I.capsule, deps=(P.spaceport, P.sky_gradient, P.concrete, P.boxes)),
        S('shelter_light', 5, 10, 8.5, I.shelter_light, samples=32, deps=(FG, P.shelter_room, P.concrete)),
        S('earth_c1', 10, 14, 12.5, I.earth_c1, deps=(E, I.earth_relit)),
    ]),
    F.Film('interlude_c2', [
        S('tanks', 0, 5, 3.5, I.tanks, samples=32, deps=(P.concrete,)),
        S('tap', 5, 10, 8, I.tap, samples=32, deps=(FG, P.concrete)),
        S('earth_c2', 10, 14, 12.5, I.earth_c2, deps=(E, I.earth_relit)),
    ]),
    F.Film('interlude_c3', [
        S('greenhouse', 0, 7, 5.5, I.greenhouse, samples=32, deps=(P.boxes,)),
        S('earth_c3', 7, 14, 12, I.earth_c3, deps=(E, I.earth_relit)),
    ]),
    F.Film('interlude_c4', [
        S('reactor', 0, 6, 4.5, I.reactor, samples=32, deps=(P.concrete,)),
        S('earth_c4', 6, 11, 9.5, I.earth_c4, deps=(E, I.earth_relit)),
        S('watchers', 11, 16, 13.5, I.watchers, deps=(E, I.static_band)),
    ]),
    F.Film('interlude_c5', [
        S('hive_dark', 0, 6, 4, I.hive_dark, deps=(E,)),
        S('eden', 6, 12, 10, I.eden, deps=(E, P.tug)),
        S('cockpit', 12, 16, 14.5, I.cockpit, deps=(E, I.static_band)),
    ]),
    F.Film('ending_stay', [
        S('uplink', 0, 6, 3, X.uplink, deps=(X.eden_grove, P.sky_gradient, P.concrete)),
        S('fleet', 6, 14, 11, X.fleet, deps=(FG, P.spaceport, P.tug, P.sky_gradient, P.concrete, P.boxes)),
        S('earth_full', 14, 21, 18, X.earth_full, deps=(E,)),
        S('wall_63', 21, 30, 28, X.wall_63, deps=(P.selection_wall, P.stamp)),
        S('earth_again', 30, 36, 32, X.earth_again, deps=(E, P.earth_night, P.satellite)),
    ]),
    F.Film('ending_escape', [
        S('exit', 0, 6, 3, X.exit_door, deps=(X.eden_grove, P.sky_gradient, P.concrete)),
        S('eden_unmade', 6, 14, 11, X.eden_unmade, deps=(E,)),
        S('earth_unmade', 14, 22, 18, X.earth_unmade, deps=(FG, X.clay)),
        S('wall_same', 22, 29, 26, X.wall_same, deps=(P.selection_wall,)),
        S('point', 29, 36, 30, X.point, deps=(X.clay,)),
    ]),
]
ORDER = ['prologue', 'departure', 'interlude_c1', 'interlude_c2', 'interlude_c3', 'interlude_c4', 'interlude_c5',
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
