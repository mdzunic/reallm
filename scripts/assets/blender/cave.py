# The cave kit (SPEC-052 §3.6, §4.5): models/cave/<name>.glb — the eleven
# pieces of the underground (caches, the vault door, the puzzle furniture, the
# shaft head, the machine room's rack and cradle) and a beacon per biome.
# SPEC-054's CAVE_ASSETS loads `models/cave/<name>.glb` as `cave_<name>`;
# SPEC-055 draws the terminal, plate, mirror, lens and receiver.
#
# Authored in metres: base at z 0, origin at the base centre, front toward
# Blender −Y (glTF +Z). Colours are in COLOR_0 (`Body`; the cradle's `Suit` and
# `Trim` are near-white so the save's primary and secondary colours multiply
# cleanly); what lights up is on a flat emissive `Glow`. No UVs, meshopt. The
# two multi-node pieces keep the nodes the runtime moves: vault_door's `Door`
# turns about its hinge line at x = −1.3 and carries `Lock`; mirror's `Head`
# turns about the post. The walls themselves are procedural (SPEC-054).
#
#   node scripts/assets/blender/build.mjs cave [--only=cradle] [--preview=DIR]
#
# Deterministic: no clock, no randomness — every offset below is written out.
import math
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'lib'))

from mathutils import Matrix, Vector, noise  # noqa: E402

import common as C  # noqa: E402

box, cyl, sphere, ico, place, torus, lathe, along, tube = C.box, C.cyl, C.sphere, C.ico, C.place, C.torus, C.lathe, C.along, C.tube

BODY, GLOW, SUIT, TRIM = 0, 1, 2, 3


def tone(base, ground=0.7, height=1.0, seed=0, grain=0.06):
    """Vertex colour: `base` darker toward the floor, with a little grain."""
    c = C.lin(base)

    def fn(co, n):
        k = ground + (1 - ground) * min(max(co.z / (0.6 * height), 0.0), 1.0)
        k *= 1 - grain + grain * (0.5 + 0.5 * noise.noise(Vector(co) * 3.1 + Vector((seed, seed * 0.7, 0))))
        return (c[0] * k, c[1] * k, c[2] * k, 1.0)
    return fn


STEEL = '#6f747a'
DARK = '#34383d'
OLIVE = '#5d6247'
RUST = '#7a5236'
STONE = '#77716a'

# ------------------------------------------------------------------ the kit


def cache(b, opened=False):
    """A closed supply locker, stencilled, a status light on the lid
    (1.2 × 0.8 × 0.9); opened, the lid stands up and the contents show
    (1.2 × 0.8 × 1.5)."""
    shell = tone(OLIVE, height=0.9, seed=1)
    for x in (-0.48, 0.48):
        b.add(place(box(0.12, 0.8, 0.06), (x, 0, 0.03)), color=tone(DARK), smooth=None)          # skids
    if opened:
        b.add(place(box(1.12, 0.72, 0.06), (0, 0, 0.09)), color=shell, smooth=None)             # floor
        for x in (-0.57, 0.57):
            b.add(place(box(0.06, 0.8, 0.66), (x, 0, 0.45)), color=shell, smooth=None)
        for y in (-0.37, 0.37):
            b.add(place(box(1.2, 0.06, 0.66), (0, y, 0.45)), color=shell, smooth=None)
        b.add(place(box(1.2, 0.06, 0.8), (0, 0.37, 1.1)), color=shell, smooth=None)             # the lid, up
        b.add(place(box(0.5, 0.02, 0.22), (0, 0.335, 1.12)), color=tone('#b9b07a'), smooth=None)  # its stencil
        # contents: two cases, a coil, a glowing cell
        b.add(place(box(0.42, 0.5, 0.26, 0.02), (-0.28, 0.0, 0.25)), color=tone(RUST, seed=2), smooth=None)
        b.add(place(box(0.3, 0.3, 0.34, 0.02), (0.22, 0.1, 0.29)), color=tone(STEEL, seed=3), smooth=None)
        b.add(place(torus(0.12, 0.035, n=10, m=4), (0.3, -0.18, 0.2)), color=tone('#9a6a3a'), smooth=40)
        b.add(place(cyl(0.06, 0.06, 0.28, n=8), (-0.05, -0.2, 0.26)), mat=GLOW, smooth=None)
        b.add(place(cyl(0.035, 0.035, 0.04, n=8), (0.45, 0.33, 1.52), (90, 0, 0)), mat=GLOW, smooth=None)  # status light
    else:
        b.add(place(box(1.2, 0.8, 0.68, 0.015), (0, 0, 0.4)), color=shell, smooth=None)
        b.add(place(box(1.24, 0.84, 0.12, 0.015), (0, 0, 0.8)), color=shell, smooth=None)        # lid
        b.add(place(box(0.5, 0.02, 0.22), (0, -0.405, 0.42)), color=tone('#b9b07a'), smooth=None)  # stencil
        b.add(place(box(0.14, 0.02, 0.22), (-0.42, -0.405, 0.42)), color=tone('#b9b07a'), smooth=None)
        b.add(place(cyl(0.04, 0.04, 0.04, n=8), (0.48, 0.25, 0.88)), mat=GLOW, smooth=None)    # status light
    for x in (-0.615, 0.615):
        b.add(place(box(0.06, 0.24, 0.05), (x, 0, 0.55)), color=tone(DARK), smooth=None)        # handles


def cache_open(b):
    cache(b, opened=True)


def vault_door(parts):
    """A round hatch in a rock-cut frame (3.4 × 1.0 × 3.6). `Door` turns about
    its hinge line, x = −1.3, and carries `Lock`."""
    frame, door, lock = parts['Frame'], parts['Door'], parts['Lock']
    rock = tone(STONE, ground=0.75, height=3.6, seed=4)
    ring = lathe([(1.22, -0.5), (1.68, -0.5), (1.68, 0.5), (1.22, 0.5), (1.22, -0.5)], n=16)
    frame.add(place(ring, (0, 0, 1.8), (90, 0, 0)), color=tone(DARK, height=3.6), smooth=None)
    for x, z, sx, sz in ((-1.3, 0.5, 0.4, 0.5), (1.3, 0.5, 0.4, 0.5), (0.0, 3.45, 1.4, 0.15), (-1.35, 3.1, 0.35, 0.5),
                         (1.35, 3.1, 0.35, 0.5)):
        frame.add(place(box(sx * 2, 0.9, sz * 2), (x, 0.05, z)), color=rock, smooth=None)
    frame.add(place(box(3.0, 1.0, 0.12), (0, 0, 0.06)), color=rock, smooth=None)                # sill
    for k in range(8):                                                                           # rivets on the frame
        a = 2 * math.pi * k / 8 + math.pi / 8
        frame.add(place(cyl(0.05, 0.05, 0.06, n=6), (1.45 * math.cos(a), -0.52, 1.8 + 1.45 * math.sin(a)), (90, 0, 0)),
                  color=tone(STEEL), smooth=None)
    # the door, built about its hinge: its centre sits 1.3 to the right of its origin
    hatch = tone(STEEL, height=3.6, seed=5)
    door.add(place(cyl(1.2, 1.2, 0.26, n=16), (1.3, 0, 0), (90, 0, 0)), color=hatch, smooth=None)
    door.add(place(cyl(0.9, 0.9, 0.08, n=16), (1.3, -0.16, 0), (90, 0, 0)), color=tone('#5c6168'), smooth=None)
    for a in (0, 90):
        door.add(place(box(1.9, 0.06, 0.16), (1.3, -0.2, 0), (0, a, 0)), color=tone(DARK), smooth=None)
    for z in (-0.6, 0.6):
        door.add(place(box(0.34, 0.3, 0.2), (0.12, 0.0, z)), color=tone(DARK), smooth=None)        # hinge knuckles
    # the lock wheel, its own node on the door's face
    lock.add(place(torus(0.32, 0.045, n=12, m=4), (0, 0, 0), (90, 0, 0)), mat=0, smooth=None)
    lock.add(place(box(0.6, 0.05, 0.06), (0, 0, 0)), mat=0, smooth=None)
    lock.add(place(box(0.06, 0.05, 0.6), (0, 0, 0)), mat=0, smooth=None)


def terminal(b):
    """A console on a pedestal, its screen facing +z (0.8 × 0.6 × 1.4)."""
    metal = tone(STEEL, height=1.4, seed=6)
    b.add(place(box(0.6, 0.5, 0.06), (0, 0, 0.03)), color=tone(DARK), smooth=None)
    b.add(place(box(0.24, 0.24, 0.86, 0.02), (0, 0.02, 0.48)), color=metal, smooth=None)
    b.add(place(box(0.78, 0.36, 0.44, 0.025), (0, 0.06, 1.14), (-22, 0, 0)), color=metal, smooth=None)
    b.add(place(box(0.6, 0.03, 0.32), (0, -0.14, 1.17), (-22, 0, 0)), mat=GLOW, smooth=None)      # the screen
    b.add(place(box(0.72, 0.28, 0.05, 0.01), (0, -0.16, 0.9), (12, 0, 0)), color=tone(DARK), smooth=None)
    for x in (-0.41, 0.41):
        b.add(place(box(0.04, 0.2, 0.3), (x, 0.06, 1.14), (-22, 0, 0)), color=tone(DARK), smooth=None)


def plate(b):
    """A floor pressure plate with an inset glowing ring (1.6 × 1.6 × 0.12)."""
    b.add(place(cyl(0.8, 0.76, 0.08, n=16), (0, 0, 0.04)), color=tone(DARK, height=0.12), smooth=None)
    b.add(place(cyl(0.56, 0.56, 0.12, n=16), (0, 0, 0.06)), color=tone(STEEL, height=0.12, seed=7), smooth=None)
    b.add(lathe([(0.7, 0.082), (0.62, 0.082)], n=16), mat=GLOW, smooth=None)


def mirror(parts):
    """A mirror on a turntable post (1.0 × 0.8 × 1.7): `Base`, and `Head` whose
    origin is on the post's turn axis."""
    base, head = parts['Base'], parts['Head']
    metal = tone(STEEL, height=1.7, seed=8)
    base.add(place(cyl(0.4, 0.4, 0.1, n=12), (0, 0, 0.05)), color=tone(DARK), smooth=None)
    base.add(place(cyl(0.05, 0.05, 0.86, n=8), (0, 0, 0.53)), color=metal, smooth=None)
    base.add(place(cyl(0.12, 0.12, 0.05, n=12), (0, 0, 0.955)), color=metal, smooth=None)     # the turntable
    # Head, about its origin on the turn axis (1.0 up)
    head.add(place(box(0.08, 0.08, 0.2), (0, 0, 0.1)), color=metal, smooth=None)
    head.add(place(box(0.98, 0.06, 0.04), (0, 0, 0.2)), color=metal, smooth=None)               # the yoke
    head.add(place(box(0.86, 0.04, 0.58), (0, 0, 0.42)), color=tone('#c9d4dc', ground=1.0), smooth=None)  # the glass
    for x in (-0.47, 0.47):
        head.add(place(box(0.04, 0.07, 0.62), (x, 0, 0.42)), mat=GLOW, smooth=None)             # the rim
    for z in (0.12, 0.72):
        head.add(place(box(0.98, 0.07, 0.04), (0, 0, z)), mat=GLOW, smooth=None)


def lens(b):
    """A lens ring on a tripod, the lens glowing (0.9 × 0.9 × 1.5)."""
    metal = tone(STEEL, height=1.5, seed=9)
    hub = Vector((0, 0, 1.0))
    for k in range(3):
        # one foot to the back; a circumradius of 0.53 puts the tripod's box at 0.95 × 0.85
        a = 2 * math.pi * k / 3 + math.pi / 2
        foot = Vector((0.53 * math.cos(a), 0.53 * math.sin(a), 0.0))
        b.add(along(cyl(0.03, 0.025, (hub - foot).length, n=5), foot, hub), color=tone(DARK), smooth=None)
    b.add(place(cyl(0.06, 0.06, 0.24, n=8), (0, 0, 1.08)), color=metal, smooth=None)
    b.add(place(torus(0.25, 0.045, n=16, m=4), (0, 0, 1.21), (90, 0, 0)), color=metal, smooth=None)
    b.add(place(cyl(0.22, 0.22, 0.03, n=16), (0, 0, 1.21), (90, 0, 0)), mat=GLOW, smooth=None)


def receiver(b):
    """A pylon with a receptor dish, the receptor glowing (1.0 × 1.0 × 2.2)."""
    metal = tone(STEEL, height=2.2, seed=10)
    b.add(place(box(1.0, 1.0, 0.16, 0.02), (0, 0, 0.08)), color=tone(DARK), smooth=None)
    b.add(place(cyl(0.18, 0.12, 1.5, n=8), (0, 0, 0.9)), color=metal, smooth=None)
    dish = lathe([(0.0, 0.0), (0.2, 0.02), (0.36, 0.08), (0.46, 0.17)], n=16)
    b.add(place(dish, (0, -0.05, 1.68), (60, 0, 0)), color=tone('#9aa0a6'), smooth=40)
    feed = ((0, -0.05, 1.68), (0, -0.3, 1.86))
    b.add(along(cyl(0.02, 0.02, C.length(*feed), n=4), *feed), color=tone(DARK), smooth=None)
    b.add(place(ico(0.08, 2), (0, -0.33, 1.88)), mat=GLOW, smooth=60)


def shaft(b):
    """A shaft head: a square collar (top at 0.3 m), a ladder going down into a
    black disc at y 0.02, and a hoist frame with a lamp (3.0 × 3.0 × 3.5)."""
    collar = tone('#6e6a62', height=0.3, seed=11)
    for x, y, sx, sy in ((0, 1.25, 3.0, 0.5), (0, -1.25, 3.0, 0.5), (1.25, 0, 0.5, 2.0), (-1.25, 0, 0.5, 2.0)):
        b.add(place(box(sx, sy, 0.3, 0.02), (x, y, 0.15)), color=collar, smooth=None)
    b.add(place(cyl(1.0, 1.0, 0.02, n=20), (0, 0, 0.01)), color=(0.012, 0.012, 0.012, 1.0), smooth=None)
    rail = tone(RUST, height=1.2, seed=12)
    for x in (-0.22, 0.22):
        b.add(place(box(0.05, 0.05, 1.4), (x, -0.9, 0.62), (-12, 0, 0)), color=rail, smooth=None)
    for k in range(5):
        z = 0.15 + 0.25 * k
        b.add(place(box(0.44, 0.03, 0.03), (0, -0.9 + 0.21 * (z - 0.62), z)), color=rail, smooth=None)
    frame = tone(STEEL, height=3.5, seed=13)
    for x, y in ((-1.3, -1.3), (1.3, -1.3), (-1.3, 1.3), (1.3, 1.3)):
        leg = ((x, y, 0.3), (x * 0.25, y * 0.25, 3.32))
        b.add(along(box(0.12, 0.12, C.length(*leg)), *leg), color=frame, smooth=None)
    b.add(place(box(1.0, 0.16, 0.16), (0, 0, 3.4)), color=frame, smooth=None)
    b.add(place(cyl(0.16, 0.16, 0.1, n=10), (0, 0, 3.2), (0, 90, 0)), color=tone(DARK), smooth=None)  # pulley
    b.add(place(cyl(0.012, 0.012, 2.6, n=4), (0, 0, 1.9)), color=tone(DARK), smooth=None)            # rope
    b.add(place(box(0.2, 0.2, 0.12), (0.3, -0.12, 3.25)), color=tone(DARK), smooth=None)             # lamp housing
    b.add(place(sphere(0.08, 8, 5), (0.3, -0.12, 3.15)), mat=GLOW, smooth=60)                         # the lamp


def rack(b):
    """A server rack with a cable tray on top, LED strips glowing (0.8 × 1.2 × 2.2)."""
    shell = tone('#3d4248', height=2.2, seed=14)
    b.add(place(box(0.8, 1.2, 2.0, 0.02), (0, 0, 1.0)), color=shell, smooth=None)
    for k in range(6):
        z = 0.3 + 0.28 * k
        b.add(place(box(0.66, 0.03, 0.22), (0, -0.6, z)), color=tone('#2a2e33'), smooth=None)
        b.add(place(box(0.5, 0.02, 0.025), (0, -0.62, z + 0.06)), mat=GLOW, smooth=None)           # an LED strip
    tray = tone(STEEL, height=2.2)
    b.add(place(box(0.5, 1.2, 0.03), (0, 0, 2.06)), color=tray, smooth=None)
    for x in (-0.25, 0.25):
        b.add(place(box(0.03, 1.2, 0.14), (x, 0, 2.12)), color=tray, smooth=None)
    for x in (-0.1, 0.08):
        b.add(tube([(x, 0.6, 2.1), (x, 0.0, 2.14), (x + 0.02, -0.6, 2.1)], [0.035, 0.035, 0.035], n=4, cap_start=False),
              color=tone('#202326'), smooth=60)


def cradle(b):
    """A suit standing in a maintenance cradle, one static mesh
    (1.2 × 1.0 × 2.4): `Body` the cradle, `Suit` the shell and `Trim` its
    stripes — near-white, for the save's colours — and `Glow` the visor and a
    status light."""
    frame = tone('#4a4f55', height=2.4, seed=15)
    b.add(place(box(1.2, 1.0, 0.12, 0.02), (0, 0, 0.06)), color=frame, smooth=None)                 # deck
    for x in (-0.55, 0.55):
        b.add(place(box(0.1, 0.16, 2.2), (x, 0.3, 1.22)), color=frame, smooth=None)                 # posts
    b.add(place(box(1.2, 0.18, 0.16), (0, 0.3, 2.32)), color=frame, smooth=None)                    # header
    b.add(place(box(0.7, 0.06, 1.3), (0, 0.42, 1.25)), color=tone(DARK), smooth=None)               # back plate
    for x in (-0.45, 0.45):
        b.add(place(box(0.24, 0.1, 0.06), (x * 0.82, 0.24, 1.42)), color=frame, smooth=None)        # clamps
    b.add(place(cyl(0.04, 0.04, 0.03, n=8), (0.55, 0.21, 2.0), (90, 0, 0)), mat=GLOW, smooth=None)  # status light
    shell = (0.92, 0.92, 0.9, 1.0)
    stripe = (0.95, 0.95, 0.95, 1.0)
    # the suit, about 1.85 m, standing at the cradle's front
    b.add(place(box(0.42, 0.26, 0.56, 0.05), (0, 0.0, 1.32)), color=shell, mat=SUIT, smooth=None)   # torso
    b.add(place(box(0.36, 0.24, 0.2, 0.04), (0, 0.0, 0.98)), color=shell, mat=SUIT, smooth=None)    # hips
    b.add(place(sphere(0.15, 8, 6), (0, -0.02, 1.76)), color=shell, mat=SUIT, smooth=50)            # helmet
    b.add(place(box(0.2, 0.05, 0.08), (0, -0.15, 1.77)), mat=GLOW, smooth=None)                     # visor
    for s in (-1, 1):
        for r1, r2, head, tail in ((0.065, 0.055, (0.27 * s, 0, 1.55), (0.3 * s, 0.02, 1.2)),
                                   (0.055, 0.05, (0.3 * s, 0.02, 1.2), (0.3 * s, -0.04, 0.9)),
                                   (0.085, 0.07, (0.11 * s, 0, 0.92), (0.12 * s, 0, 0.5)),
                                   (0.07, 0.06, (0.12 * s, 0, 0.5), (0.12 * s, 0.01, 0.12))):
            b.add(along(cyl(r1, r2, C.length(head, tail), n=6), head, tail), color=shell, mat=SUIT, smooth=None)
        b.add(place(box(0.12, 0.22, 0.08, 0.015), (0.12 * s, -0.03, 0.16)), color=tone(DARK), smooth=None)  # boots
        b.add(place(box(0.035, 0.03, 0.3), (0.3 * s, -0.05, 1.22)), color=stripe, mat=TRIM, smooth=None)    # arm stripes
        b.add(place(box(0.04, 0.03, 0.36), (0.12 * s, -0.08, 0.55)), color=stripe, mat=TRIM, smooth=None)   # leg stripes
    b.add(place(box(0.44, 0.03, 0.06), (0, -0.135, 1.46)), color=stripe, mat=TRIM, smooth=None)            # chest band
    b.add(place(box(0.38, 0.03, 0.05), (0, -0.125, 1.0)), color=stripe, mat=TRIM, smooth=None)             # belt
    b.add(place(box(0.32, 0.12, 0.42, 0.03), (0, 0.18, 1.36)), color=shell, mat=SUIT, smooth=None)        # pack


KIT = {
    'cache': cache, 'cache_open': cache_open, 'vault_door': vault_door, 'terminal': terminal, 'plate': plate,
    'mirror': mirror, 'lens': lens, 'receiver': receiver, 'shaft': shaft, 'rack': rack, 'cradle': cradle,
}
# §3.6: the nodes of the multi-node pieces, (name, parent, origin, materials)
NODES = {
    'vault_door': (('Frame', None, (0.0, 0.0, 0.0), ('Body',)),
                   ('Door', 'Frame', (-1.3, -0.08, 1.8), ('Body',)),
                   ('Lock', 'Door', (1.3, -0.24, 0.0), ('Glow',))),
    'mirror': (('Base', None, (0.0, 0.0, 0.0), ('Body',)),
               ('Head', None, (0.0, 0.0, 0.98), ('Body', 'Glow'))),
}
GLOW_COLOUR = {
    'cache': ('#46c973', 3.0), 'cache_open': ('#46c973', 3.0), 'vault_door': ('#f5a623', 3.0), 'terminal': ('#7fdcff', 2.5),
    'plate': ('#f5a623', 2.5), 'mirror': ('#7fdcff', 2.5), 'lens': ('#9fe8ff', 3.0), 'receiver': ('#f5a623', 3.0),
    'shaft': ('#ffcf7a', 4.0), 'rack': ('#46c973', 2.5), 'cradle': ('#7fdcff', 3.0),
}

# ---------------------------------------------------------------- beacons
# §3.6: one light per biome, ≤ 200 triangles with at least half on `Glow`.


def beacon_desert(b):
    """A caged work lamp on a stake (0.5 × 0.5 × 1.2)."""
    b.add(place(box(0.05, 0.05, 0.86), (0, 0, 0.43)), color=tone(RUST, height=1.2), smooth=None)
    b.add(place(box(0.5, 0.05, 0.04), (0, 0, 0.02)), color=tone(RUST), smooth=None)
    for k in range(3):
        a = 2 * math.pi * k / 3
        b.add(place(box(0.025, 0.025, 0.3), (0.24 * math.cos(a), 0.24 * math.sin(a), 1.02)), color=tone(DARK), smooth=None)
    b.add(place(cyl(0.26, 0.2, 0.06, n=6), (0, 0, 1.17)), color=tone(DARK), smooth=None)
    b.add(place(sphere(0.15, 8, 7), (0, 0, 1.0)), mat=GLOW, smooth=60)


def beacon_ice(b):
    """A blue crystal cluster (0.8 × 0.8 × 0.9)."""
    b.add(place(ico(0.3, 1), (0.05, 0.0, 0.08), scale=(1.2, 1.55, 0.45)), color=tone('#8aa3b5'), smooth=None)
    b.add(place(ico(0.22, 1), (-0.18, 0.14, 0.05), scale=(1.1, 1.0, 0.5)), color=tone('#8aa3b5'), smooth=None)
    for k, (x, y, h, r, tx, ty) in enumerate(((0, 0, 0.9, 0.11, 0, 0), (0.2, 0.08, 0.6, 0.08, 0, 22), (-0.18, 0.15, 0.55, 0.08, -18, -14),
                                              (0.06, -0.22, 0.5, 0.07, 20, 6), (-0.1, -0.12, 0.42, 0.06, 14, -20))):
        b.add(place(cyl(r, 0.012, h, n=6), (x, y, h / 2), (tx, ty, 15 * k)), mat=GLOW, smooth=None)


def beacon_jungle(b):
    """A cluster of bioluminescent fungus (0.8 × 0.8 × 0.6)."""
    for k, (x, y, h, r) in enumerate(((0, 0, 0.5, 0.2), (0.24, 0.16, 0.34, 0.15), (-0.18, 0.24, 0.3, 0.14),
                                      (0.08, -0.24, 0.26, 0.13), (-0.26, -0.14, 0.2, 0.11))):
        b.add(place(cyl(0.035, 0.03, h, n=5), (x, y, h / 2)), color=tone('#d6ccb2', ground=0.8, height=0.6), smooth=None)
        b.add(place(lathe([(r, 0.0), (r * 0.72, r * 0.42), (0.0, r * 0.52)], n=7), (x, y, h - 0.02)), mat=GLOW, smooth=50)


def beacon_volcanic(b):
    """A magma crystal in a basalt cup (0.7 × 0.7 × 0.8)."""
    b.add(lathe([(0.35, 0.0), (0.33, 0.2), (0.26, 0.3), (0.2, 0.22)], n=8), color=tone('#2e2622', height=0.4), smooth=None)
    b.add(place(ico(0.16, 2), (0, 0, 0.3)), mat=GLOW, smooth=None)
    for k, (tx, ty, h) in enumerate(((0, 0, 0.5), (24, 10, 0.34), (-20, 18, 0.3))):
        b.add(place(cyl(0.07, 0.01, h, n=6), (0, 0, 0.3 + h / 2 - 0.04), (tx, ty, 30 * k)), mat=GLOW, smooth=None)


def beacon_hive(b):
    """A pulsing vein nodule (0.8 × 0.8 × 0.7)."""
    b.add(place(sphere(0.3, 10, 7), (0, 0, 0.38), scale=(1.0, 1.0, 1.05)), mat=GLOW, smooth=60)
    for k in range(4):
        a = 2 * math.pi * k / 4 + 0.4
        b.add(tube([(0.2 * math.cos(a), 0.2 * math.sin(a), 0.3), (0.32 * math.cos(a + 0.2), 0.32 * math.sin(a + 0.2), 0.12),
                    (0.4 * math.cos(a), 0.4 * math.sin(a), 0.02)], [0.05, 0.04, 0.03], n=4, cap_start=False),
              color=tone('#4b3a5c', height=0.7), smooth=50)


def beacon_temperate(b):
    """A cable light on a conduit post, for Eden's machine room (0.4 × 0.4 × 1.5)."""
    metal = tone(STEEL, height=1.5, seed=16)
    b.add(place(box(0.4, 0.4, 0.04), (0, 0, 0.02)), color=tone(DARK), smooth=None)
    b.add(place(box(0.08, 0.08, 1.44), (0, 0.06, 0.74)), color=metal, smooth=None)
    b.add(place(cyl(0.03, 0.03, 1.3, n=6), (0.08, 0.1, 0.69)), color=tone('#2a2e33'), smooth=None)
    b.add(place(box(0.2, 0.1, 0.06), (0, -0.02, 1.47)), color=metal, smooth=None)
    b.add(place(sphere(0.09, 8, 6), (0, -0.04, 1.38)), mat=GLOW, smooth=60)
    b.add(place(box(0.02, 0.02, 0.5), (0.0, -0.005, 0.8)), mat=GLOW, smooth=None)


BEACONS = {
    'desert': beacon_desert, 'ice': beacon_ice, 'jungle': beacon_jungle,
    'volcanic': beacon_volcanic, 'hive': beacon_hive, 'temperate': beacon_temperate,
}
BEACON_GLOW = {'desert': ('#ffcf7a', 4.0), 'ice': ('#7fdcff', 3.0), 'jungle': ('#b8ff6a', 3.0),
               'volcanic': ('#ff6a2a', 4.0), 'hive': ('#d66bff', 3.0), 'temperate': ('#dff4ff', 4.0)}


# ------------------------------------------------------------------ build


def materials(names, glow):
    colour, strength = glow
    made = {
        'Body': lambda: C.mat_vcol('Body', rough=0.7, metal=0.2),
        'Suit': lambda: C.mat_vcol('Suit', rough=0.45, metal=0.1),
        'Trim': lambda: C.mat_vcol('Trim', rough=0.4, metal=0.1),
        'Glow': lambda: C.mat_flat('Glow', '#ffffff', emission=colour, strength=strength),
    }
    return [made[n]() for n in names]


def build(name):
    """The objects of one piece, ready to export."""
    C.reset()
    if name in NODES:
        builders = {node: C.Builder() for node, _, _, _ in NODES[name]}
        KIT[name](builders)
        objs = {}
        for node, parent, origin, mats in NODES[name]:
            obj = builders[node].object(node, materials(mats, GLOW_COLOUR[name]), parent=objs.get(parent))
            obj.location = origin
            objs[node] = obj
        return list(objs.values())
    b = C.Builder()
    if name.startswith('beacon_'):
        biome = name[len('beacon_'):]
        BEACONS[biome](b)
        mats = materials(('Body', 'Glow'), BEACON_GLOW[biome])
    else:
        KIT[name](b)
        mats = materials(('Body', 'Glow', 'Suit', 'Trim') if name == 'cradle' else ('Body', 'Glow'), GLOW_COLOUR[name])
    obj = b.object(name, mats)
    z0 = min(v.co.z for v in obj.data.vertices)
    obj.data.transform(Matrix.Translation((0, 0, -z0)))
    return [obj]


def preview_piece(objs, name, preview):
    """§4.5: beside a 1.8 m salvager, on a dark ground, under one warm key from the camera side."""
    import preview as P
    import salvager as S
    ground = C.Builder(vcol=False)
    ground.add(place(box(8.0, 8.0, 0.01), (0, 0, -0.005)), smooth=None)
    floor = ground.object('PreviewGround', [C.mat_flat('PreviewDark', 0.06, rough=0.95)])
    lo = min((o.matrix_world @ v.co).x for o in objs for v in o.data.vertices)
    arm, mesh = S.build(name='Scale')
    arm.location = (lo - 0.6, 0.0, 0.0)
    return P.render(objs + [mesh, floor], os.path.join(preview, f'cave_{name}.png'), azimuth=25, elevation=24, size=256,
                    bg='#0c0e11', lights=(('key', 'SUN', 3.0, '#ffd2a1', (60, 0, 20)),))


def main():
    opts = C.options()
    shots = []
    for name in [*KIT, *(f'beacon_{biome}' for biome in BEACONS)]:
        if not C.wanted(opts, name):
            continue
        objs = build(name)
        path = os.path.join(opts['out'], 'models', 'cave', f'{name}.glb')
        C.export_glb(path, objs, texcoords=False, meshopt=True)
        C.report(path, opts['out'])
        if opts['preview']:
            shots.append(preview_piece(objs, name, opts['preview']))
    if opts['preview'] and shots:
        import preview as P
        P.sheet(shots, os.path.join(opts['preview'], 'sheet_cave.png'), cols=6)


main()
