# Shots of the chapter interludes (SPEC-021 §4.3, §5.3) — "First Light",
# "Meltwater", "Harvest", "Grid" and "Silence". Each delivered resource lights a
# little more of Earth's night side (lib/earth.py `relight`). Times are
# shot-local seconds. SPEC-051 §4.4–§4.5 plants one clue per interlude: the
# coast lights up on a too-perfect grid in chapter 3, chapter 4's tear shows a
# grey Earth, and chapter 5 ends on the Selection board with a blank No. 63.
import math
import os

import bpy
import numpy as np
from mathutils import Vector, noise

import common as C
import earth as E
import film as F
import nodes as N
import plate as PL
import shots_endings as X
import shots_prologue as P

LATTICE_POINT = 0.2   # SPEC-051 §4.4: a lattice light's radius, degrees
LATTICE_LIGHT = 1.2   # … and its brightness on the lights map's scale (0–1.6)


# SPEC-051 §4.4's framing per level, 51-d's "move the camera, not the threshold".
# One framing for all three failed the first render (2026-10-04, push 2.05 → 1.9,
# the whole disc in frame): level 1's coast drew a lit box 73 px wide against the
# 240 asked, and level 3's lattice, four times wider, already reached the bottom
# edge — no single distance makes the first 240 px wide and keeps the third 32 px
# clear. So each level is framed for its own patch: the camera south of the coast
# and below the old height, looking north, so the coast fills the lower part of the
# frame and the limb crosses the top third. `push`, `height` and `look` as below,
# and `side`, a sideways shift of camera and aim together (east +): level 2 lights a
# second town west of the coast. Level 3's lattice runs far south of the coast, so
# from the south its rows reach the bottom edge at any tilt; it is framed from the
# north, looking south, where they fall away toward the limb. A caller that passes
# its own framing (earth_c4) keeps it, world-Z roll included. Poster lit boxes at
# these values (960 × 540, Blender 5.2.1, M4 Pro): level 1 351,326–620,449;
# level 2 150,335–769,461; level 3 232,209–749,393.
RELIT_FRAMING = {
    1: {'push': (1.13, 1.10), 'height': -0.23, 'look': (1.0, 0.077), 'side': 0.0},
    2: {'push': (1.16, 1.13), 'height': -0.244, 'look': (1.0, 0.080), 'side': -0.05},
    3: {'push': (1.37, 1.34), 'height': 0.42, 'look': (1.0, -0.082), 'side': 0.0},
}


def earth_relit(ctx, level, push=None, pan=0.0, height=None, lattice=None, look=None):
    """Earth's night side as Shelter Nine's coast lights up to `level`; the new
    patch fades in over 0.4–1.4 s. SPEC-051 §4.4 frames it for phones (initial
    tuning): the camera about two radii out, aimed at `home × look[0] + up ×
    look[1]`, so the coast fills the lower part of the frame; films.py's lit-box
    check holds it there. `lattice=(t_in, t_resolve, t_done, spacing_deg)`: the
    new level's lights come in as a lattice, then resolve (`_lattice`)."""
    framing = RELIT_FRAMING.get(level, RELIT_FRAMING[1])
    own = push is not None or height is not None or look is not None
    push = framing['push'] if push is None else push
    height = framing['height'] if height is None else height
    look = framing['look'] if look is None else look
    side = 0.0 if own else framing['side']
    F.world('#000000', 1.0, stars=1.8)
    home, east, up = E.basis(ctx)
    sun = (-home * 0.85 + up * 0.25 + east * 0.45).normalized()
    rig = E.earth(ctx, relight=level, relight_from=level - 1, fade=(0.4, lattice[0] if lattice else 1.4), sun_dir=sun)
    if lattice is not None:
        _lattice(ctx, rig, level, lattice)
    F.sun(-sun, 2.4)
    start = home * push[0] + up * height + east * (side - pan)
    end = home * push[1] + up * height + east * (side + pan)
    cam, aim = F.camera(tuple(start), tuple(home * look[0] + up * look[1] + east * side), lens=35)
    if not own:
        # Up is away from the planet, not world Z: the limb stays level across the
        # top whichever side of the coast the camera stands (level 3 looks south).
        aim.rotation_euler = home.to_track_quat('Z', 'Y').to_euler()
        cam.constraints[-1].use_target_z = True
    F.keys(cam, 'location', [(0, start), (ctx.duration, end)])
    return cam, aim


def _lattice(ctx, rig, level, lattice):
    """SPEC-051 §4.4: the new level's lights load like a texture streaming in — a
    placeholder grid of points LATTICE_POINT° across at every `spacing`° of
    latitude and longitude, on the land where relight_mask(level) −
    relight_mask(level − 1) is above 0.5 — then resolve from t_resolve to t_done
    into the organic map every later shot keeps. lib/earth.py is untouched, so no
    other shot re-renders."""
    t_in, t_resolve, t_done, spacing = lattice
    m = E._maps(os.path.join(ctx.opts['frames'], '_earth'))
    before = E.relight_mask(m, level - 1)
    new = (E.relight_mask(m, level) - before > 0.5) & (m['land'] > 0.5)
    d = m['d']
    lat = np.degrees(np.arcsin(np.clip(d[..., 1], -1.0, 1.0)))   # mesh space: Y is north
    lon = np.degrees(np.arctan2(d[..., 2], -d[..., 0]))
    off = np.hypot(lat - np.round(lat / spacing) * spacing,
                   (lon - np.round(lon / spacing) * spacing) * np.cos(np.radians(lat)))
    points = 1 - E._ss(LATTICE_POINT * 0.5, LATTICE_POINT, off)
    em = np.maximum(np.clip(m['lights'] * before, 0, 1.6), points * new * LATTICE_LIGHT)
    e = np.repeat(np.clip(em / 1.6, 0, 1)[..., None], 3, -1)
    e = np.concatenate([e, np.ones(e.shape[:2] + (1,), np.float32)], -1)[::-1]
    # earth() fades the previous level's lights into this level's through one Mix
    # feeding the warm tint: the lattice becomes that fade's target, and a second
    # Mix resolves it into the organic map
    nt = rig.obj.data.materials[0].node_tree
    fade = next(n for n in nt.nodes if n.type == 'MIX' and n.blend_type == 'MIX')
    warm = next(n for n in nt.nodes if n.type == 'MIX' and n.blend_type == 'MULTIPLY')
    organic = next(link.from_socket for link in nt.links if link.to_node == fade and link.to_socket.name == 'B')
    grid = nt.nodes.new('ShaderNodeTexImage')
    grid.image = C.image_from_array(f'EarthLights_lattice{level}', e.astype(np.float32), 'Non-Color')
    nt.links.new(grid.outputs['Color'], fade.inputs['B'])
    settle = nt.nodes.new('ShaderNodeMix')
    settle.data_type = 'RGBA'
    nt.links.new(fade.outputs['Result'], settle.inputs['A'])
    nt.links.new(organic, settle.inputs['B'])
    nt.links.new(settle.outputs['Result'], warm.inputs['A'])
    F.keys(settle.inputs['Factor'], 'default_value', [(t_resolve, 0.0), (t_done, 1.0)], interp='LINEAR')
    print(f'NOTE earth lattice: level {level}, {int((points * new > 0.5).sum())} texels lit')


def tear(rig, t0, t1):
    """SPEC-051 §4.5: chapter 4's clue — from t0 to t1 Earth is a placeholder at its
    own place and size: the clay grey under Blender's UV grid (X.clay), inside a
    wireframe shell at 1.01 radii. The planet, its clouds and its air are hidden
    meanwhile; everything else stays."""
    grid = bpy.data.images.new('TearGrid', 1024, 512)
    grid.generated_type = 'UV_GRID'
    clay = X.clay('TearClay')
    nt = clay.node_tree
    bsdf = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    tex = nt.nodes.new('ShaderNodeTexImage')
    tex.image = grid
    under = nt.nodes.new('ShaderNodeMix')
    under.data_type, under.blend_type = 'RGBA', 'MULTIPLY'
    under.inputs['Factor'].default_value = 0.6
    under.inputs['A'].default_value = bsdf.inputs['Base Color'].default_value[:]
    nt.links.new(tex.outputs['Color'], under.inputs['B'])
    nt.links.new(under.outputs['Result'], bsdf.inputs['Base Color'])
    ball = E._sphere_mesh('TearEarth', 192, 96)
    ball.rotation_euler = (math.radians(90), 0, 0)   # Earth's own UV layout, so the grid wraps it as the map did
    ball.location, ball.scale = rig.obj.location, (rig.radius,) * 3
    ball.data.materials.append(clay)
    shell = E._sphere_mesh('TearShell', 48, 24)
    shell.parent, shell.scale = ball, (1.01,) * 3
    shell.modifiers.new('Wire', 'WIREFRAME').thickness = 0.004
    shell.data.materials.append(F.emit('TearWire', '#dfefff', 1.0))
    for o in [rig.obj] + F.children(rig.obj):
        F.keys(o, 'hide_render', [(0, False), (t0, True), (t1, False)])
    for o in (ball, shell):
        F.keys(o, 'hide_render', [(0, True), (t0, False), (t1, True)])


# ------------------------------------------------------------ First Light


def capsule(ctx):
    P.spaceport(ctx)
    hull = F.mat('CapsuleHull', '#d8d4cc', 0.5, 0.3)
    cap = F.obj('Capsule', C.lathe([(0.0, 0.0), (1.4, 0.2), (1.6, 1.2), (1.2, 2.4), (0.4, 2.9), (0.0, 3.0)], n=24),
                hull, (0, 0, 150), smooth=True)
    F.obj('Band', C.torus(1.56, 0.09, n=24, m=6), F.mat('Band', '#d0661e', 0.5), (0, 0, 0.9)).parent = cap
    F.obj('Chute', C.lathe([(0.05, 10.0), (3.0, 9.6), (5.5, 8.2), (6.4, 6.8)], n=24), F.mat('Chute', '#e07a2e', 0.9)).parent = cap
    cord = F.mat('Cord', '#d8d4cc', 0.8)
    for k in range(8):
        a = k / 8 * 2 * math.pi
        head, tail = (0, 0, 3.0), (6.3 * math.cos(a), 6.3 * math.sin(a), 6.8)
        F.obj('Cord', C.along(C.cyl(0.03, 0.03, C.length(head, tail), n=4), head, tail), cord).parent = cap
    F.keys(cap, 'location', [(0, Vector((0, 0, 150))), (ctx.duration, Vector((5, 3, 38)))], interp='LINEAR')
    F.keys(cap, 'rotation_euler', [(0, Vector((0.06, -0.04, 0))), (2.5, Vector((-0.05, 0.05, 0.2))),
                                   (ctx.duration, Vector((0.04, -0.02, 0.4)))])
    cam, aim = F.camera((-26, -44, 2.2), (0, 0, 154), lens=70)
    # the aim rides 4 m above the capsule's base, so capsule and canopy stay framed
    F.keys(aim, 'location', [(0, Vector((0, 0, 154))), (ctx.duration, Vector((5, 3, 42)))], interp='LINEAR')


def earth_c1(ctx):
    earth_relit(ctx, 1)


# ------------------------------------------------------------ Meltwater


def tanks(ctx):
    F.world('#0b1016', 0.45)
    F.sun((0.4, 0.8, -0.9), 1.4, '#cfe4ff')
    F.lamp((-2.5, -1.5, 3.0), 180, '#ffd0a0', radius=0.3)
    F.plane('Floor', 14, 12, P.concrete('TankFloor', '#3a3a3c', 0.8), (0, 0, 0))
    F.plane('Wall', 14, 5, P.concrete('TankWall', '#4a4c50', 0.8), (0, 3.2, 2.5), (90, 0, 0))
    steel = F.mat('Steel', '#8a9096', 0.35, 0.8)
    F.obj('Tank', C.lathe([(1.6, 0.0), (1.6, 1.5), (1.68, 1.55), (1.68, 1.6)], n=40), steel)
    F.obj('Water', C.cyl(1.58, 1.58, 0.02, n=40), F.mat('Water', '#0a3040', 0.06), (0, 0, 1.28))
    ice = F.mat('Ice', '#cfe8f4', 0.2)
    for k in range(6):
        a = k / 6 * 2 * math.pi + 0.3
        bm = C.ico(0.35 + 0.08 * (k % 3), 2)
        C.displace(bm, lambda co, s=k: 0.05 * noise.noise(co * 6 + Vector((s, 0, 0))))
        piece = F.obj(f'Ice{k}', bm, ice, (0.85 * math.cos(a), 0.85 * math.sin(a), 1.3), scale=(1, 1, 0.7))
        F.keys(piece, 'scale', [(0, Vector((1, 1, 0.7))), (ctx.duration, Vector((0.45, 0.45, 0.3)))], interp='LINEAR')
    pipe, nt, bsdf = C._principled('Pipe')
    bsdf.inputs['Metallic'].default_value = 0.7
    F.keys(bsdf.inputs['Base Color'], 'default_value', [(0, C.lin('#6a7076')), (ctx.duration, C.lin('#dfeef6'))])
    F.keys(bsdf.inputs['Roughness'], 'default_value', [(0, 0.35), (ctx.duration, 0.85)])
    for z in (1.9, 2.4):
        F.obj('Pipe', C.cyl(0.09, 0.09, 9.0, n=12), pipe, (0, 3.05, z), (0, 90, 0))
    F.obj('Gauge', C.cyl(0.22, 0.22, 0.03, n=24), F.mat('GaugeFace', '#e8e4d8', 0.5), (2.2, 3.12, 1.6), (90, 0, 0))
    needle = F.obj('Needle', C.place(C.box(0.012, 0.012, 0.18), (0, 0, 0.07)), F.mat('Needle', '#aa2222', 0.5), (2.2, 3.09, 1.6))
    F.keys(needle, 'rotation_euler', [(0, Vector((0, math.radians(60), 0))), (ctx.duration, Vector((0, math.radians(-60), 0)))])
    cam, aim = F.camera((-2.8, -3.4, 2.5), (0, 0.4, 1.3), lens=30)
    F.keys(cam, 'location', [(0, Vector((-2.8, -3.4, 2.5))), (ctx.duration, Vector((-1.3, -3.6, 2.4)))])
    F.keys(aim, 'location', [(0, Vector((0, 0.4, 1.3))), (ctx.duration, Vector((0.9, 0.6, 1.3)))])


def earth_c2(ctx):
    earth_relit(ctx, 2)


# ------------------------------------------------------------ Harvest


def earth_c3(ctx):
    """SPEC-051 §4.4: the coast lights up on a lattice 1.2° apart (1.4–5.6 s, the
    poster at 5.0 s shows it whole), then settles into towns and roads by 6.6 s."""
    earth_relit(ctx, 3, pan=0.05, lattice=(1.4, 5.6, 6.6, 1.2))


# ------------------------------------------------------------ Grid


def reactor(ctx):
    F.world('#05070b', 0.35)
    F.plane('Floor', 24, 24, P.concrete('ReactorFloor', '#2a2c30', 0.5))
    steel = F.mat('ReactorSteel', '#5a6068', 0.35, 0.8)
    F.obj('Ring', C.torus(3.0, 0.45, n=48, m=12), steel, (0, 0, 1.4))
    core = F.emit('Core', '#4ab8ff', 0.2)
    g = N.Graph.__new__(N.Graph)   # bands up the core, so it reads as a machine and not a lamp
    g.nt = core.node_tree
    z = g.xyz(g.coords('Object'))[2]
    bands = g.math('ADD', 0.55, g.math('MULTIPLY', 0.45, g.math('SINE', g.math('MULTIPLY', z, 22.0))))
    tint = g.node('ShaderNodeMix', data_type='RGBA', blend_type='MULTIPLY')
    tint.inputs['Factor'].default_value = 1.0
    tint.inputs['A'].default_value = C.lin('#4ab8ff')
    g.link(g.combine(bands, bands, bands), tint.inputs['B'])
    g.link(tint.outputs['Result'], core.node_tree.nodes['Emission'].inputs['Color'])
    F.obj('Core', C.cyl(0.6, 0.6, 4.0, n=32), core, (0, 0, 2.0))
    F.keys(F.strength_socket(core), 'default_value', [(1.5, 0.2), (3.5, 1.8)], interp='LINEAR')
    blue = F.lamp((0, 0, 2.0), 0.0, '#4ab8ff', radius=0.6)
    F.keys(blue.data, 'energy', [(1.5, 0.0), (3.5, 350.0)], interp='LINEAR')
    cell = F.mat('Cell', '#b8c4d0', 0.3, 0.8, '#4ab8ff', 1.5)
    for k in range(4):
        a = k / 4 * 2 * math.pi + math.pi / 4
        slot = Vector((3.0 * math.cos(a), 3.0 * math.sin(a), 1.4))
        outer = Vector((5.2 * math.cos(a), 5.2 * math.sin(a), 1.4))
        c = F.obj(f'Cell{k}', C.box(0.35, 0.35, 0.9, 0.03), cell, tuple(outer))
        t0 = 0.3 + 0.5 * k
        F.keys(c, 'location', [(t0, outer), (t0 + 0.8, slot)])
    tb = C.Builder(vcol=False)
    tb.add(C.place(C.cyl(0.4, 0.4, 0.5, n=16), (0, 0, 0), (90, 0, 0)))
    for k in range(8):
        blade = C.place(C.box(0.3, 0.06, 1.6), (0, 0, 0.95))
        tb.add(C.place(blade, (0, 0, 0), (0, k * 45, 0)), smooth=None)
    turbine = tb.object('Turbine', [steel])
    turbine.location = (0, 6.5, 2.4)
    F.keys(turbine, 'rotation_euler', [(0, Vector((0, 0, 0))), (3.0, Vector((0, math.tau, 0))), (ctx.duration, Vector((0, 6 * math.tau, 0)))],
           interp='LINEAR')
    F.lamp((-4, -3, 4), 300, '#c8d8ff', radius=1.0)
    cam, aim = F.camera((6.0, -6.5, 3.4), (0, 0.5, 1.6), lens=30)
    F.keys(cam, 'location', [(0, Vector((6.0, -6.5, 3.4))), (ctx.duration, Vector((5.0, -5.4, 3.0)))])


def earth_c4(ctx):
    earth_relit(ctx, 4, push=(3.3, 3.0), height=0.4, look=(0.0, 0.47))   # its framing before SPEC-051: the same pictures


def watchers(ctx):
    F.world('#000000', 1.0, stars=1.8)
    home, east, up = E.basis(ctx)
    at = Vector((0, 60, 0))
    sun = (-home * 0.6 + east * 0.8).normalized()
    rig = E.earth(ctx, relight=4, loc=tuple(at), sun_dir=sun)
    F.sun(-sun, 2.4)
    moon = F.mat('Moon', '#8a8a86', 0.9)
    bm = C.sphere(0.27, 48, 32)
    C.displace(bm, lambda co: 0.006 * noise.noise(co * 18))
    F.obj('Moon', bm, moon, tuple(at + home * 9 + east * 1.2 + up * 0.3), smooth=True)
    # the watchers: violet points around the camera's path (never on it), which
    # the camera backs through; the haze turns slowly about the line to Earth
    haze = C.link(bpy.data.objects.new('Haze', None))
    haze.location = at + home * 13
    violet = F.emit('Watcher', '#a07ad0', 3.5)
    b = C.Builder(vcol=False)
    placed = 0
    while placed < 260:   # clear of the lens: nothing within 1.6 of the camera's line
        sx, sy = ctx.rng.gauss(0, 2.4), ctx.rng.gauss(0, 2.4)
        if math.hypot(sx, sy) < 1.6:
            continue
        p = home * ctx.rng.gauss(0, 3.5) + east * sx + up * sy
        b.add(C.place(C.sphere(ctx.rng.uniform(0.02, 0.045), 6, 4), tuple(p)), smooth=None)
        placed += 1
    points = b.object('Watchers', [violet])
    points.parent = haze
    haze.rotation_mode = 'AXIS_ANGLE'
    F.keys(haze, 'rotation_axis_angle', [(0, (0.0, *home)), (ctx.duration, (math.radians(25), *home))])
    start, end = at + home * 3.2 + up * 0.15, at + home * 24 + up * 0.6
    cam, aim = F.camera(tuple(start), tuple(at), lens=35, clip=(0.05, 200.0))
    F.keys(cam, 'location', [(0, start), (ctx.duration, end)])
    tear(rig, 4.1, 4.35)   # six frames: the film's static cue at 15.1 s


# ------------------------------------------------------------ Silence


def hive_dark(ctx):
    F.world('#000000', 1.0)
    shell = E._sphere_mesh('HiveShell', 192, 96)
    shell.scale = (20, 20, 20)
    m = bpy.data.materials.new('HiveInside')
    m.use_nodes = True
    g = N.Graph(m)
    ta = g.node('ShaderNodeTexImage', image=bpy.data.images.load(ctx.asset('textures/flight/planet_hive.webp'), check_existing=True))
    te = g.node('ShaderNodeTexImage', image=bpy.data.images.load(ctx.asset('textures/flight/planet_hive_em.webp'), check_existing=True))
    bsdf = g.node('ShaderNodeBsdfPrincipled')
    g.link(ta.outputs['Color'], bsdf.inputs['Base Color'])
    bsdf.inputs['Roughness'].default_value = 0.7
    g.link(te.outputs['Color'], bsdf.inputs['Emission Color'])
    # the dark spreads from the heart (+x, where the camera looks) outward: slow
    # at first, so the poster has a dead centre ringed by live veins, then fast,
    # reaching the edge at 5.9 s (SPEC-051 §4.5: no more than 6 black frames).
    # Through the field of view the front slows from 4.5 to 5.8 s, and only the
    # last 0.1 s takes the rest: keyed straight from 4.5 to 5.9 it crossed every
    # visible vein by 4.75 s, and the first full render held 31 frames below
    # 0.002 (mean 0.012 at 4.5 s, 0.0011 at 4.75 s, ~0 from 5.0 s).
    dist = g.vmath('DISTANCE', g.coords('Object'), (1.0, 0.0, 0.0))
    alive = g.node('ShaderNodeMapRange', interpolation_type='SMOOTHSTEP', clamp=True)
    g.link(dist, alive.inputs['Value'])
    F.keys(alive.inputs['From Min'], 'default_value', [(0.5, -0.3), (4.5, 0.45), (5.8, 0.62), (5.9, 2.05)], interp='LINEAR')
    F.keys(alive.inputs['From Max'], 'default_value', [(0.5, 0.0), (4.5, 0.75), (5.8, 0.92), (5.9, 2.35)], interp='LINEAR')
    g.link(g.math('MULTIPLY', alive.outputs['Result'], 4.0), bsdf.inputs['Emission Strength'])
    out = g.node('ShaderNodeOutputMaterial')
    g.link(bsdf.outputs[0], out.inputs['Surface'])
    shell.data.materials.append(m)
    glow = F.lamp((6, 0, 0), 1500.0, '#8a6aa0', radius=2.0)
    F.keys(glow.data, 'energy', [(0.5, 1500.0), (4.5, 900.0), (5.8, 250.0), (5.9, 0.0)], interp='LINEAR')
    cam, aim = F.camera((4, 0, 0.5), (20, 0, 0), lens=24, clip=(0.05, 100.0))
    F.keys(cam, 'location', [(0, Vector((4, 0, 0.5))), (ctx.duration, Vector((-10, 0, 1.5)))])


def eden(ctx):
    F.world('#000000', 1.0, stars=1.5)
    sun = Vector((0.9, 0.3, 0.2)).normalized()
    E.planet(ctx, 'textures/flight/planet_eden.webp', sun_dir=sun, atmo='#7ab8ff', cover=0.8, name='Eden')
    F.sun(-sun, 3.0)
    ship = P.tug(ctx, (0.55, -1.35, 0.25), (0, 0, -100), 0.012)
    F.keys(ship, 'location', [(0, Vector((0.55, -1.35, 0.25))), (ctx.duration, Vector((-0.35, -1.3, 0.3)))], interp='LINEAR')
    cam, aim = F.camera((0.2, -2.6, 0.55), (0, 0, 0.25), lens=35)
    F.keys(cam, 'location', [(0, Vector((0.2, -2.6, 0.55))), (ctx.duration, Vector((0.15, -2.35, 0.5)))])


def board(ctx):
    """SPEC-051 §4.5: chapter 5's clue, where the cockpit was — the Selection wall,
    card 62 stamped SELECTED from the first frame, and pinned to its left a new card
    numbered 63: a pale panel with no photograph and no stamp. The build fails
    unless both photos sit inside the inner 88 % of the frame at the poster (2.5 s)."""
    cards = P.selection_wall(ctx, card62=PL.VISOR)
    P.stamp(cards, P.CARD_NUMBERS.index(62), None)
    x, z = -2.1, 1.62
    blank = F.plane('Blank63', 0.3, 0.3, F.mat('Blank63', '#d8d4cc', 0.8), (x, -0.005, z + 0.04), (90, 0, 0))
    F.plane('BlankBar63', 0.3, 0.1, F.mat('BlankBar63', '#e8e4da', 0.8), (x, -0.005, z - 0.17), (90, 0, 0))
    F.text('No. 63', 0.05, F.mat('BlankInk63', '#1a1a1a', 0.8), (x, -0.008, z - 0.17), (90, 0, 0))
    F.obj('BlankPin63', C.sphere(0.012, 8, 6), F.mat('BlankPin63', '#b02020', 0.4), (x, -0.02, z + 0.21))
    cam, aim = F.camera((-1.55, -1.65, 1.64), (-1.7, 0, 1.62), lens=40)
    F.keys(cam, 'location', [(0, Vector((-1.55, -1.65, 1.64))), (ctx.duration, Vector((-1.75, -1.5, 1.63)))])
    F.require_framed(ctx, [P.photo(P.CARD_NUMBERS.index(62)), blank], cam, [F.frame(2.5)])
