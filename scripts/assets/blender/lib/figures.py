# Figures for the story films (PLAN R9, SPEC-021 §5.2): the Machines — 2.1 m
# chassis in the salvager's bevelled low-poly style with a red eye strip that
# can be keyed per machine — and people: faceless low-poly men and women in
# twelve variants of hair, build, skin and coat. Rigid parts posed by joint
# positions; no armatures. Fronts face −Y, like every model here.
import math
import random

from mathutils import Vector

import common as C

GUNMETAL = '#3a4048'
SKINS = ('#5c3a21', '#8d5524', '#c68642', '#e0ac69', '#f1c27d', '#ffdbac')
HAIRS = ('#1c1410', '#2e1e12', '#4a2a16', '#6a4a2a', '#8a8a86', '#241c1c')
COATS = ('#5a4636', '#44484e', '#6b5b45', '#3c4a3c', '#7a3a30', '#50525a', '#6a5a4a', '#38383c')


def _limb(b, head, tail, r1, r2, mat=0, color=(1, 1, 1, 1), n=8):
    b.add(C.along(C.cyl(r1, r2, max((Vector(tail) - Vector(head)).length, 1e-3), n=n), head, tail), mat=mat, color=color)


def _ball(b, at, r, mat=0, color=(1, 1, 1, 1)):
    b.add(C.place(C.sphere(r, 8, 6), at), mat=mat, color=color, smooth=80)


def _pose_joints(pose):
    """Shoulder/elbow/wrist and hip/knee/ankle per side for a 2 m frame."""
    j = {}
    for s in (-1, 1):
        j[s] = dict(sh=(0.33 * s, 0, 1.6), el=(0.37 * s, 0.02, 1.24), wr=(0.39 * s, -0.02, 0.92),
                    hip=(0.14 * s, 0, 1.0), kn=(0.15 * s, -0.02, 0.56), an=(0.15 * s, 0.02, 0.12))
    if pose == 'stride':
        j[1].update(kn=(0.15, -0.2, 0.57), an=(0.15, -0.34, 0.14), el=(0.36, 0.14, 1.25), wr=(0.37, 0.24, 0.95))
        j[-1].update(kn=(-0.15, 0.13, 0.55), an=(-0.15, 0.32, 0.18), el=(-0.36, -0.12, 1.26), wr=(-0.37, -0.26, 0.98))
    elif pose == 'slump':
        for s in (-1, 1):
            j[s].update(el=(0.36 * s, -0.05, 1.22), wr=(0.34 * s, -0.16, 0.95))
    return j


def machine(name, material, eye_material, pose='stand', loc=(0, 0, 0), rot=0.0, scale=1.0, head_tilt=0.0):
    """A Machine. `eye_material` should be its own copy when its eyes are keyed alone."""
    b = C.Builder(vcol=False)
    j = _pose_joints(pose)
    box, place = C.box, C.place
    b.add(place(box(0.36, 0.22, 0.18, 0.03), (0, 0, 1.03)))
    b.add(place(C.cyl(0.13, 0.15, 0.22, n=10), (0, 0, 1.22)))
    b.add(place(box(0.54, 0.32, 0.4, 0.05), (0, 0.01, 1.46), (-6, 0, 0)))
    b.add(place(box(0.2, 0.08, 0.14, 0.02), (0, -0.17, 1.44), (-6, 0, 0)))
    b.add(place(box(0.3, 0.16, 0.3, 0.03), (0, 0.22, 1.44)))
    for s in (-1, 1):
        b.add(place(box(0.2, 0.28, 0.14, 0.04), (0.33 * s, 0, 1.64), (0, 12 * s, 0)))
    b.add(place(C.cyl(0.06, 0.07, 0.12, n=8), (0, 0, 1.72)))
    head = C.box(0.25, 0.28, 0.27, 0.05)
    C.place(head, (0, 0, 0.13), (head_tilt, 0, 0))
    C.place(head, (0, 0, 1.74))
    b.add(head)
    visor = C.box(0.21, 0.03, 0.04)
    C.place(visor, (0, -0.14, 0.15), (head_tilt, 0, 0))
    C.place(visor, (0, 0, 1.74))
    b.add(visor, mat=1)
    for s in (-1, 1):
        q = j[s]
        _ball(b, q['sh'], 0.08)
        _limb(b, q['sh'], q['el'], 0.065, 0.055)
        _ball(b, q['el'], 0.065)
        _limb(b, q['el'], q['wr'], 0.06, 0.07)
        b.add(C.along(box(0.09, 0.07, 0.12, 0.015), q['wr'], (q['wr'][0], q['wr'][1] - 0.02, q['wr'][2] - 0.12)))
        _ball(b, q['hip'], 0.09)
        _limb(b, q['hip'], q['kn'], 0.095, 0.075)
        _ball(b, q['kn'], 0.08)
        _limb(b, q['kn'], q['an'], 0.075, 0.085)
        ax, ay, az = q['an']
        b.add(place(box(0.13, 0.26, 0.1, 0.02), (ax, ay - 0.05, max(az - 0.07, 0.05))))
    o = b.object(name, [material, eye_material])
    o.location = loc
    o.rotation_euler = (0, 0, math.radians(rot))
    o.scale = (scale,) * 3
    for p in o.data.polygons:
        p.use_smooth = False
    return o


def person(name, variant, material, pose='stand', loc=(0, 0, 0), rot=0.0):
    """A faceless figure. variant 0…11: even = broad build, odd = narrow shoulders and
    wider hips; hair, skin and coat vary with the variant. Uses a mat_vcol material."""
    rnd = random.Random(1000 + variant)
    narrow = variant % 2 == 1
    height = (1.62 + 0.14 * rnd.random()) if narrow else (1.72 + 0.14 * rnd.random())
    k = height / 1.8
    skin = C.lin(SKINS[(variant * 5) % len(SKINS)])
    hair = C.lin(HAIRS[(variant * 7 + 1) % len(HAIRS)])
    coat = C.lin(COATS[variant % len(COATS)])
    trousers = C.lin(('#2a2a2e', '#34302a', '#2c3238')[variant % 3])
    boots = C.lin('#1a1612')
    style = ('long', 'short', 'tied', 'crop', 'cap', 'long', 'bun', 'short', 'crop', 'tied', 'cap', 'bun')[variant % 12]
    sh = 0.19 if narrow else 0.23
    hp = 0.16 if narrow else 0.14
    b = C.Builder(vcol=True)
    S = lambda v: tuple(x * k for x in v)  # noqa: E731
    lean = pose in ('lean', 'hold')
    for s in (-1, 1):
        hip, knee, ank = S((0.09 * s, 0, 0.92)), S((0.1 * s, -0.02, 0.5)), S((0.1 * s, 0, 0.08))
        _limb(b, hip, knee, 0.075 * k, 0.06 * k, color=trousers)
        _limb(b, knee, ank, 0.06 * k, 0.05 * k, color=trousers)
        b.add(C.place(C.box(0.1 * k, 0.24 * k, 0.09 * k, 0.02), (ank[0], ank[1] - 0.05 * k, 0.045 * k)), color=boots)
    b.add(C.place(C.box(2 * hp * k, 0.2 * k, 0.2 * k, 0.03), S((0, 0, 0.96))), color=coat)
    b.add(C.place(C.cyl(hp * k, sh * k, 0.5 * k, n=10), S((0, 0, 1.3)), scale=(1, 0.62, 1)), color=coat)
    b.add(C.place(C.cyl(0.05 * k, 0.05 * k, 0.1 * k, n=8), S((0, 0, 1.58))), color=skin)
    tilt = 25 if pose == 'look_up' else (-12 if lean else 0)
    head_at = Vector(S((0, 0, 1.68)))
    b.add(C.place(C.sphere(0.105 * k, 12, 8), head_at, (tilt, 0, 0), (0.92, 1.0, 1.1)), color=skin, smooth=70)
    hr = 0.112 * k
    if style == 'cap':
        b.add(C.place(C.sphere(hr, 12, 6), head_at + Vector((0, 0.01, 0.03 * k)), (tilt, 0, 0), (1, 1.05, 0.7)), color=C.lin('#4a4a3a'), smooth=70)
        b.add(C.place(C.box(0.16 * k, 0.1 * k, 0.015 * k), head_at + Vector((0, -0.1 * k, 0.06 * k)), (tilt, 0, 0)), color=C.lin('#4a4a3a'))
    else:
        top = C.sphere(hr, 12, 8)
        C.place(top, (0, 0.012 * k, 0.025 * k), (0, 0, 0), (1.0, 1.02, 0.85))
        b.add(C.place(top, head_at, (tilt, 0, 0)), color=hair, smooth=70)
        if style == 'long':
            b.add(C.place(C.box(0.2 * k, 0.1 * k, 0.26 * k, 0.03), head_at + Vector((0, 0.06 * k, -0.1 * k))), color=hair)
        elif style in ('tied', 'bun'):
            b.add(C.place(C.sphere(0.05 * k, 8, 6), head_at + Vector((0, 0.11 * k, 0.03 * k if style == 'bun' else -0.06 * k))), color=hair)
    for s in (-1, 1):
        shoulder = Vector(S((sh * s, 0, 1.5)))
        if lean:
            elbow = Vector(S(((sh + 0.02) * s, -0.14, 1.2)))
            wrist = Vector(S((0.12 * s, -0.36, 1.12)))
        elif pose == 'look_up':
            elbow, wrist = Vector(S(((sh + 0.05) * s, 0.02, 1.2))), Vector(S(((sh + 0.03) * s, -0.02, 0.92)))
        else:
            elbow, wrist = Vector(S(((sh + 0.04) * s, 0.03, 1.2))), Vector(S(((sh + 0.02) * s, 0.0, 0.9)))
        _limb(b, shoulder, elbow, 0.055 * k, 0.048 * k, color=coat)
        _limb(b, elbow, wrist, 0.048 * k, 0.04 * k, color=coat)
        _ball(b, wrist + Vector((0, -0.03 * k, -0.03 * k)), 0.045 * k, color=skin)
    o = b.object(name, [material])
    o.location = loc
    o.rotation_euler = (0, 0, math.radians(rot))
    return o


def crowd(prefix, n, material, rng, centre, radius, facing=None, pose='stand', min_gap=0.55):
    """n people scattered in a disc, turned toward `facing` (a point) or at random."""
    placed, made = [], []
    tries = 0
    while len(made) < n and tries < n * 40:
        tries += 1
        a, r = rng.uniform(0, 2 * math.pi), radius * math.sqrt(rng.random())
        p = Vector((centre[0] + r * math.cos(a), centre[1] + r * math.sin(a), centre[2]))
        if any((p - q).length < min_gap for q in placed):
            continue
        placed.append(p)
        if facing is not None:
            to = Vector(facing) - p
            rot = math.degrees(math.atan2(to.x, -to.y)) + rng.uniform(-20, 20)
        else:
            rot = rng.uniform(0, 360)
        made.append(person(f'{prefix}{len(made)}', rng.randrange(12), material, pose, tuple(p), rot))
    return made
