# Shots of the chapter interludes (SPEC-021 §4.3, §5.3) — "First Light",
# "Meltwater", "Harvest", "Grid" and "Silence". Each delivered resource lights a
# little more of Earth's night side (lib/earth.py `relight`). Times are
# shot-local seconds.
import math

import bpy
from mathutils import Vector, noise

import common as C
import earth as E
import figures as FG
import film as F
import nodes as N
import shots_prologue as P


def earth_relit(ctx, level, push=(3.1, 2.9), pan=0.0, height=0.35):
    """Earth's night side as Shelter Nine's coast lights up to `level`; the new
    patch fades in over the first second. The frame holds the lit coast in its
    lower third and the limb across its top."""
    F.world('#000000', 1.0, stars=1.8)
    home, east, up = E.basis(ctx)
    sun = (-home * 0.85 + up * 0.25 + east * 0.45).normalized()
    E.earth(ctx, relight=level, relight_from=level - 1, fade=(0.4, 1.4), sun_dir=sun)
    F.sun(-sun, 2.4)
    start = home * push[0] + up * height - east * pan
    end = home * push[1] + up * height + east * pan
    cam, aim = F.camera(tuple(start), tuple(up * (height + 0.07)), lens=35)
    F.keys(cam, 'location', [(0, start), (ctx.duration, end)])
    return cam, aim


def static_band(cam, t0, t1, width=1.4, height=0.03):
    """A thin tear of grey static in front of the camera from t0 to t1 (low contrast)."""
    m = bpy.data.materials.new('Static')
    m.use_nodes = True
    m.surface_render_method = 'BLENDED'
    g = N.Graph(m)
    n = g.noise(g.coords('Object'), 160.0, 5, detail=1.0)
    F.keys(n.node.inputs['W'], 'default_value', [(0, 0.0), (t1 + 1, 60.0)], interp='LINEAR')
    gain = g.node('ShaderNodeMath', operation='MULTIPLY')
    g.link(n, gain.inputs[0])
    F.keys(gain.inputs[1], 'default_value', [(0, 0.0), (t0, 0.0), (t0 + 1 / 24, 0.9), (t1, 0.9), (t1 + 1 / 24, 0.0)],
           interp='CONSTANT')
    em = g.node('ShaderNodeEmission')
    g.link(gain.outputs[0], em.inputs['Strength'])
    tr = g.node('ShaderNodeBsdfTransparent')
    add = g.node('ShaderNodeAddShader')
    g.link(tr.outputs[0], add.inputs[0])
    g.link(em.outputs[0], add.inputs[1])
    out = g.node('ShaderNodeOutputMaterial')
    g.link(add.outputs[0], out.inputs['Surface'])
    band = F.plane('Static', width, height, m, (0, -0.08, -1.0), (0, 0, 0))
    band.parent = cam
    return band


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


def shelter_light(ctx):
    P.shelter_room(ctx, lamp_steady_at=1.0, people_pose='look_up')
    strip = F.emit('Strip', '#fff1d8', 0.0)
    for x in (-3.2, 0.0, 3.2):
        F.obj('Strip', C.box(1.6, 0.14, 0.05), strip, (x, 1.2, 3.17))
        lamp = F.lamp((x, 1.2, 3.05), 0.0, '#fff1d8', kind='AREA')
        lamp.data.size = 1.6
        F.keys(lamp.data, 'energy', [(2.0, 0.0), (2.5, 220.0)], interp='LINEAR')
    F.keys(F.strength_socket(strip), 'default_value', [(2.0, 0.0), (2.5, 9.0)], interp='LINEAR')
    cam, aim = F.camera((-3.4, -3.7, 2.2), (0.2, 0.4, 1.3), lens=28)
    F.keys(cam, 'location', [(0, Vector((-3.4, -3.7, 2.2))), (ctx.duration, Vector((-2.9, -3.1, 2.0)))])


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


def tap(ctx):
    F.world('#0c0b0a', 0.3)
    F.lamp((0.6, -0.8, 2.2), 260, '#ffe0b8', radius=0.2)
    F.lamp((-1.5, -2.5, 2.0), 120, '#b8c8ff', radius=0.5)
    F.plane('Wall', 8, 4, P.concrete('TapWall', '#5a5650', 1.2), (0, 0.35, 1.5), (90, 0, 0))
    steel = F.mat('TapSteel', '#9aa0a6', 0.3, 0.9)
    F.obj('Pipe', C.cyl(0.03, 0.03, 0.35, n=12), steel, (0, 0.18, 1.3), (90, 0, 0))
    F.obj('Spout', C.cyl(0.028, 0.022, 0.12, n=12), steel, (0, 0.0, 1.25))
    F.obj('Valve', C.torus(0.05, 0.012, n=16, m=6), F.mat('Valve', '#aa2222', 0.5), (0, 0.18, 1.37))
    water, nt, wb = C._principled('Water')
    water.surface_render_method = 'BLENDED'
    wb.inputs['Base Color'].default_value = C.lin('#cfe8ff')
    wb.inputs['Alpha'].default_value = 0.55
    wb.inputs['Roughness'].default_value = 0.05
    stream = F.obj('Stream', C.cyl(0.012, 0.016, 0.13, n=10), water, (0, 0.0, 1.125))
    F.keys(stream, 'scale', [(k * 0.25, Vector((1 + 0.12 * math.sin(k * 1.7), 1 + 0.12 * math.cos(k * 2.3), 1))) for k in range(21)],
           interp='LINEAR')
    cup = F.mat('Cup', '#c8c2b4', 0.5)
    shape = [(0.035, 0.0), (0.045, 0.02), (0.05, 0.11)]
    # the queue along the wall, a cup each; the first holds hers under the tap
    people = C.mat_vcol('People', rough=0.85)
    for k in range(5):
        x = -0.3 - 0.58 * k
        FG.person(f'Q{k}', k + 3, people, 'hold', (x, -0.02, 0), 90)   # facing +X, the tap (fronts face −Y)
        F.obj('Cup', C.lathe(shape, n=16, cap_bottom=True), cup, (0.0, 0.0, 0.95) if k == 0 else (x + 0.38, -0.02, 1.0))
    cam, aim = F.camera((0.55, -1.5, 1.35), (-0.6, 0.0, 1.15), lens=30)
    F.keys(cam, 'location', [(0, Vector((0.55, -1.5, 1.35))), (ctx.duration, Vector((0.45, -1.3, 1.33)))])
    cam.data.dof.use_dof = True
    cam.data.dof.focus_distance = 1.5
    cam.data.dof.aperture_fstop = 4.0


def earth_c2(ctx):
    earth_relit(ctx, 2, push=(3.2, 3.0))


# ------------------------------------------------------------ Harvest


def greenhouse(ctx):
    F.world('#08060c', 0.3)
    frame_m = F.mat('Rack', '#2a2a30', 0.5, 0.6)
    soil = F.mat('Soil', '#2e2016', 1.0)
    grow = F.emit('Grow', '#b070ff', 6.0)
    wheat, nt, wbsdf = C._principled('Wheat')
    wbsdf.inputs['Roughness'].default_value = 0.7
    F.keys(wbsdf.inputs['Base Color'], 'default_value', [(0, C.lin('#7ab83a')), (ctx.duration, C.lin('#c8b050'))])
    parts = []
    for z in (0.5, 1.3, 2.1):
        for y in (0.0, 1.6):
            parts.append((6.0, 0.8, 0.1, (0, y, z), (0, 0, 0), (1, 1, 1, 1)))
            F.obj('Soil', C.box(5.8, 0.7, 0.08), soil, (0, y, z + 0.09))
            F.obj('GrowBar', C.box(5.6, 0.08, 0.03), grow, (0, y, z + 0.66))
            lamp = F.lamp((0, y, z + 0.62), 60.0, '#b070ff', kind='AREA')
            lamp.data.shape, lamp.data.size, lamp.data.size_y = 'RECTANGLE', 5.6, 0.3
            b = C.Builder(vcol=False)
            for _ in range(170):
                h = ctx.rng.uniform(0.28, 0.45)
                blade = C.cyl(0.008, 0.0, h, n=3)
                C.place(blade, (0, 0, h / 2), (ctx.rng.uniform(-8, 8), ctx.rng.uniform(-8, 8), ctx.rng.uniform(0, 120)))
                b.add(C.place(blade, (ctx.rng.uniform(-2.8, 2.8), ctx.rng.uniform(-0.3, 0.3), 0)), smooth=None)
            tray = b.object('WheatTray', [wheat])
            tray.location = (0, y, z + 0.13)
            F.keys(tray, 'scale', [(0, Vector((1, 1, 0.05))), (ctx.duration - 0.5, Vector((1, 1, 1)))])
            for x in (-3.1, 3.1):
                parts.append((0.08, 0.08, 0.8, (x, y, z + 0.4), (0, 0, 0), (1, 1, 1, 1)))
    P.boxes('Racks', parts, frame_m)
    cam, aim = F.camera((-3.0, -2.2, 1.5), (-1.5, 0.8, 1.2), lens=28)
    F.keys(cam, 'location', [(0, Vector((-3.0, -2.2, 1.5))), (ctx.duration, Vector((1.2, -2.2, 1.6)))])
    F.keys(aim, 'location', [(0, Vector((-1.5, 0.8, 1.2))), (ctx.duration, Vector((1.8, 0.8, 1.3)))])


def earth_c3(ctx):
    earth_relit(ctx, 3, push=(3.1, 2.95), pan=0.12)


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
    earth_relit(ctx, 4, push=(3.3, 3.0), height=0.4)


def watchers(ctx):
    F.world('#000000', 1.0, stars=1.8)
    home, east, up = E.basis(ctx)
    at = Vector((0, 60, 0))
    sun = (-home * 0.6 + east * 0.8).normalized()
    E.earth(ctx, relight=4, loc=tuple(at), sun_dir=sun)
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
    static_band(cam, 4.1, 4.3)


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
    # at first, so the poster has a dead centre ringed by live veins, then fast
    dist = g.vmath('DISTANCE', g.coords('Object'), (1.0, 0.0, 0.0))
    alive = g.node('ShaderNodeMapRange', interpolation_type='SMOOTHSTEP', clamp=True)
    g.link(dist, alive.inputs['Value'])
    F.keys(alive.inputs['From Min'], 'default_value', [(0.5, -0.3), (4.0, 0.45), (5.6, 2.05)], interp='LINEAR')
    F.keys(alive.inputs['From Max'], 'default_value', [(0.5, 0.0), (4.0, 0.75), (5.6, 2.35)], interp='LINEAR')
    g.link(g.math('MULTIPLY', alive.outputs['Result'], 4.0), bsdf.inputs['Emission Strength'])
    out = g.node('ShaderNodeOutputMaterial')
    g.link(bsdf.outputs[0], out.inputs['Surface'])
    shell.data.materials.append(m)
    glow = F.lamp((6, 0, 0), 1500.0, '#8a6aa0', radius=2.0)
    F.keys(glow.data, 'energy', [(0.5, 1500.0), (4.0, 900.0), (5.6, 0.0)], interp='LINEAR')
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


def cockpit(ctx):
    F.world('#000000', 1.0, stars=1.6)
    sun = Vector((0.6, -0.3, 0.5)).normalized()
    F.sun(-sun, 2.5)
    E.planet(ctx, 'textures/flight/planet_eden.webp', radius=9.0, loc=(3, 40, -4), sun_dir=sun, name='EdenFar')
    F.import_glb(ctx.asset('models/cockpit.glb'))
    F.lamp((0, 0.3, 0.2), 6, '#9fc4ff', radius=0.3)
    cam, aim = F.camera((0, 0, 0), (0, 10, -1.2), lens=24, clip=(0.02, 200.0))
    static_band(cam, 0.8, 1.2, width=0.5, height=0.02)
