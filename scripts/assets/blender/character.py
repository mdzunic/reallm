# models/character.glb — the rigged salvager with its five clips (SPEC-019 §4.1).
# Clip names match SPEC-019's aliases; `Idle` is written first because the menu's
# asset spike plays animations[0] and e2e/asset-spike.spec.ts pins its name.
import math
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'lib'))

import bpy  # noqa: E402
from mathutils import Euler, Vector  # noqa: E402

import common as C  # noqa: E402
import salvager as S  # noqa: E402

CLIP_ORDER = ['Idle', 'Run', 'Attack', 'Hit', 'Death']


def key(arm, frame, rots, locs=None):
    """Pose every bone: `rots` are XYZ degrees about armature-space axes at the
    bone's head (relative to its parent), `locs` armature-space offsets."""
    locs = locs or {}
    for pb in arm.pose.bones:
        rest = pb.bone.matrix_local.to_quaternion()
        r = Euler([math.radians(a) for a in rots.get(pb.name, (0, 0, 0))], 'XYZ').to_quaternion()
        pb.rotation_mode = 'QUATERNION'
        pb.rotation_quaternion = rest.inverted() @ r @ rest
        pb.location = rest.inverted() @ Vector(locs.get(pb.name, (0, 0, 0)))
        pb.keyframe_insert('rotation_quaternion', frame=frame)
        pb.keyframe_insert('location', frame=frame)


def clip(arm, name, frames, pose):
    act = bpy.data.actions.new(name)
    act.use_fake_user = True
    arm.animation_data_create()
    arm.animation_data.action = act
    for f in frames:
        rots, locs = pose(f)
        key(arm, f, rots, locs)
    return act


def both(rot, mirror_z=False):
    x, y, z = rot
    return {'R': (x, y, -z if mirror_z else z), 'L': (x, y, z)}


def idle(f):
    s = math.sin(2 * math.pi * f / 60)
    c = math.sin(2 * math.pi * f / 60 + 1.2)
    arms = (1.4 * s, 0, 0)
    return ({'spine': (1.6 * s, 0, 1.2 * c), 'head': (-1.2 * s, 0, 3.5 * c),
             'upper_arm.R': arms, 'upper_arm.L': arms},
            {'hips': (0, 0, -0.005 * (1 + s))})


def _leg(phi):
    thigh = -30 * math.sin(phi)
    shin = 14 + 52 * max(0.0, math.cos(phi)) ** 1.5
    foot = -0.55 * (thigh + shin) + 8
    return thigh, shin, foot


def run(f):
    phi = 2 * math.pi * f / 24
    tl, sl, fl = _leg(phi)
    tr, sr, fr = _leg(phi + math.pi)
    bob = 0.5 + 0.5 * math.cos(2 * phi)
    arms = (2.5 * math.sin(2 * phi) - 4, 0, 0)
    return ({'thigh.L': (tl, 0, 0), 'shin.L': (sl, 0, 0), 'foot.L': (fl, 0, 0),
             'thigh.R': (tr, 0, 0), 'shin.R': (sr, 0, 0), 'foot.R': (fr, 0, 0),
             'hips': (0, 0, 7 * math.sin(phi)), 'spine': (9, 0, -8 * math.sin(phi)),
             'head': (-6, 0, 6 * math.sin(phi)), 'upper_arm.R': arms, 'upper_arm.L': arms},
            {'hips': (0, 0, -0.045 * bob)})


def attack(f):
    k = f / 2 if f <= 2 else math.exp(-(f - 2) / 2.6)
    arms = (-9 * k, 0, 0)
    return ({'spine': (-6 * k, 0, 2 * k), 'head': (4 * k, 0, 0), 'upper_arm.R': arms, 'upper_arm.L': arms},
            {'hips': (0, 0.025 * k, 0)})


def hit(f):
    h = f / 2 if f <= 2 else max(0.0, 1 - (f - 2) / 10) ** 2
    arms = (14 * h, 0, 0)
    return ({'spine': (-16 * h, 0, 9 * h), 'head': (-12 * h, 0, -7 * h), 'upper_arm.R': arms, 'upper_arm.L': arms,
             'thigh.L': (-8 * h, 0, 0), 'shin.L': (12 * h, 0, 0)},
            {'hips': (0, 0.05 * h, -0.03 * h)})


DEATH = {
    0: ({}, {}),
    8: ({'hips': (-10, 0, 0), 'spine': (22, 0, 0), 'head': (16, 0, 0),
         'thigh.L': (-42, 0, 6), 'thigh.R': (-38, 0, -6), 'shin.L': (72, 0, 0), 'shin.R': (68, 0, 0),
         'foot.L': (-28, 0, 0), 'foot.R': (-28, 0, 0), 'upper_arm.R': (24, 0, -8), 'upper_arm.L': (26, 0, 10)},
        {'hips': (0, 0.05, -0.30)}),
    18: ({'hips': (-58, 0, 8), 'spine': (-10, 0, 0), 'head': (-16, 0, 0),
          'thigh.L': (-22, 0, 10), 'thigh.R': (-18, 0, -8), 'shin.L': (36, 0, 0), 'shin.R': (30, 0, 0),
          'upper_arm.R': (30, 0, -25), 'upper_arm.L': (34, 0, 28)},
         {'hips': (0, 0.42, -0.58)}),
    26: ({'hips': (-86, 0, 10), 'spine': (-5, 0, 0), 'head': (-18, 0, 16),
          'thigh.L': (-4, 0, 12), 'thigh.R': (-2, 0, -9), 'shin.L': (6, 0, 0), 'shin.R': (8, 0, 0),
          'foot.L': (12, 0, 0), 'foot.R': (10, 0, 0), 'upper_arm.R': (42, 0, -36), 'upper_arm.L': (38, 0, 42),
          'forearm.R': (-22, 0, 0), 'forearm.L': (-18, 0, 0)},
         {'hips': (0, 0.60, -0.66)}),
}
DEATH[30] = (dict(DEATH[26][0], hips=(-88, 0, 10)), {'hips': (0, 0.61, -0.67)})
DEATH[36] = DEATH[30]


def main():
    opts = C.options()
    C.reset()
    arm, mesh = S.build()
    clip(arm, 'Idle', range(0, 61, 3), idle)
    clip(arm, 'Run', range(0, 25), run)
    clip(arm, 'Attack', range(0, 16), attack)
    clip(arm, 'Hit', range(0, 13), hit)
    clip(arm, 'Death', sorted(DEATH), lambda f: DEATH[f])
    arm.animation_data.action = bpy.data.actions['Idle']

    path = os.path.join(opts['out'], 'models', 'character.glb')
    C.export_glb(path, [arm, mesh], animations=True)
    C.glb_rewrite(path, lambda g: g['animations'].sort(
        key=lambda a: CLIP_ORDER.index(a['name']) if a.get('name') in CLIP_ORDER else 99))
    C.report(path, opts['out'])

    if opts['preview']:
        import preview as P
        shots = []
        for name, frame, az in (('Idle', 0, 30), ('Run', 6, 60), ('Attack', 2, 40), ('Hit', 3, 30), ('Death', 36, 50), ('Idle', 0, 200)):
            arm.animation_data.action = bpy.data.actions[name]
            bpy.context.scene.frame_set(frame)
            focus = (Vector((-0.6, -1.1, 0.0)), Vector((0.6, 0.9, 1.8)))
            shots.append(P.render([mesh], os.path.join(opts['preview'], f'character_{name}_{frame}_{az}.png'), azimuth=az, focus=focus))
        # the game's own angle: 55° pitch from the south-east
        arm.animation_data.action = bpy.data.actions['Run']
        bpy.context.scene.frame_set(4)
        shots.append(P.render([mesh], os.path.join(opts['preview'], 'character_game_angle.png'), azimuth=135, elevation=55, focus=focus))
        P.sheet(shots, os.path.join(opts['preview'], 'sheet_character.png'), cols=4)


main()
