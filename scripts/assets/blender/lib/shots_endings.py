# Shots of the two ending films (SPEC-021 §4.4, §5.3): "A Good Run" (stay) and
# "Disconnected" (escape). The stay film closes the loop — a 63rd card, then the
# prologue's first shot again; the escape film unmakes the world it shows into
# clay, UV grids, wireframes and one bust on every card. Times are shot-local.
import math

import bpy
from mathutils import Vector

import common as C
import earth as E
import figures as FG
import film as F
import shots_prologue as P


def clay(name='Clay', color='#9a9a96'):
    return F.mat(name, color, 0.85)


def eden_grove(ctx, beam_color='#9fe3ff'):
    """Eden at dusk: a meadow, a grove, the survey beacon and its beam."""
    P.sky_gradient([(0.0, '#1a2418'), (0.5, '#e8b090'), (0.56, '#9a8ab0'), (0.72, '#3a4a78'), (1.0, '#101a34')], 0.9)
    F.sun((-0.7, 0.9, -0.2), 1.6, '#ffc8a0')
    F.plane('Meadow', 400, 400, P.concrete('Meadow', '#3a5a2a', 0.08, 0.95), (0, 100, 0))
    trunk, leaf = F.mat('Trunk', '#4a3424', 0.9), F.mat('Leaf', '#3d6a35', 0.8)
    for _ in range(70):
        x, y = ctx.rng.uniform(-60, 60), ctx.rng.uniform(15, 160)
        if abs(x) < 9 and y < 45:
            continue
        h = ctx.rng.uniform(4, 9)
        F.obj('Trunk', C.cyl(0.18, 0.12, h * 0.5, n=6), trunk, (x, y, h * 0.25))
        F.obj('Canopy', C.ico(h * 0.28, 1), leaf, (x, y, h * 0.62), scale=(1, 1, 1.25))
    steel = F.mat('BeaconSteel', '#b8c0c8', 0.35, 0.8)
    F.obj('Mast', C.cyl(0.25, 0.15, 7.0, n=12), steel, (0, 30, 3.5))
    F.obj('Dish', C.lathe([(0.0, 0.0), (1.2, 0.35), (1.4, 0.55)], n=24), steel, (0, 30, 7.0))
    beam_m = F.beam('Beam', beam_color, 4.0)
    beam = F.obj('Beam', C.cyl(0.35, 0.35, 400, n=24), beam_m, (0, 30, 207))
    F.obj('BeamHalo', C.cyl(1.6, 1.6, 400, n=32), F.beam('BeamHalo', beam_color, 0.3, 3.0)).parent = beam
    return beam, beam_m


# ------------------------------------------------------------ A Good Run


def uplink(ctx):
    eden_grove(ctx)
    pulse = F.glow('Pulse', '#dff4ff', 5.0)
    for k in range(5):
        ring = F.obj('Pulse', C.torus(1.1, 0.12, n=32, m=6), pulse, (0, 30, 8))
        t0 = 0.4 + k * 1.1
        F.keys(ring, 'location', [(t0, Vector((0, 30, 8))), (t0 + 3.0, Vector((0, 30, 140)))], interp='LINEAR')
        F.keys(ring, 'scale', [(t0 - 0.05, Vector((0, 0, 0))), (t0, Vector((1, 1, 1))), (t0 + 3.0, Vector((0.6, 0.6, 0.6)))])
    # the beacon and the grove stay in the bottom of the frame as the view climbs the beam
    cam, aim = F.camera((-9, -6, 1.5), (0, 30, 6), lens=24, clip=(0.1, 1000.0))
    F.keys(aim, 'location', [(0, Vector((0, 30, 6))), (ctx.duration, Vector((0, 30, 22)))])


def fleet(ctx):
    P.spaceport(ctx, relit=True)
    window = F.emit('Window', '#ffd9a0', 4.0)
    for _ in range(80):
        F.obj('Window', C.box(1.2, 0.2, 0.8), window,
              (ctx.rng.uniform(-380, 380), ctx.rng.uniform(160, 400), ctx.rng.uniform(4, 40)))
    people = C.mat_vcol('People', rough=0.85)
    FG.crowd('C', 90, people, ctx.rng, (0, -34, 0), 16, facing=(0, 0, 10), min_gap=0.7)
    burn = F.glow('Exhaust', '#ffcf8a', 0.0)
    F.keys(F.strength_socket(burn), 'default_value', [(0.2, 0.0), (0.9, 2.6), (ctx.duration, 3.0)], interp='LINEAR')
    for k, x in enumerate((-22.0, 0.0, 22.0)):
        start = Vector((x, 8 * abs(k - 1), 2.5))
        ship = P.tug(ctx, tuple(start), (0, 0, 0), 6.0)
        F.keys(ship, 'location', [(1.0 + 0.4 * k, start), (ctx.duration, Vector((x * 1.2, 20, 70)))])
        for dx in (-0.45, 0.45):
            F.obj('Exhaust', C.cyl(0.16, 0.02, 1.1, n=14), burn, (dx, 0.1, -0.7)).parent = ship
    cam, aim = F.camera((-10, -58, 4.5), (0, 0, 10), lens=28)
    F.keys(aim, 'location', [(0, Vector((0, 0, 10))), (ctx.duration, Vector((0, 10, 44)))])


def earth_full(ctx):
    F.world('#000000', 1.0, stars=1.8)
    home, east, up = E.basis(ctx)
    # from a little south of Shelter Nine, so the north pole lies on the limb and
    # the aurora stands up against space
    a = math.radians(25)
    at, north = home * math.cos(a) - up * math.sin(a), home * math.sin(a) + up * math.cos(a)
    sun = (-at * 0.8 + north * 0.3 + east * 0.5).normalized()
    E.earth(ctx, relight=5, aurora=True, sun_dir=sun)
    F.sun(-sun, 2.4)
    cam, aim = F.camera(tuple(at * 2.75 + north * 0.3), tuple(at * 0.25 + north * 0.62), lens=35)
    F.keys(cam, 'location', [(0, at * 2.75 + north * 0.3), (ctx.duration, at * 2.55 + north * 0.33)])


def wall_63(ctx):
    P.selection_wall(ctx)
    x, z = 2.1, 1.08
    card = C.link(bpy.data.objects.new('Card63', None))
    F.plane('Photo63', 0.3, 0.3, F.textured('Photo63', ctx.asset('portraits/04.webp'), rough=0.6), (0, 0, 0.04), (90, 0, 0)).parent = card
    F.plane('Bar63', 0.3, 0.1, F.mat('Bar63', '#e8e4da', 0.8), (0, 0, -0.17), (90, 0, 0)).parent = card
    F.text('No. 63', 0.05, F.mat('Ink63', '#1a1a1a', 0.8), (0, -0.003, -0.17), (90, 0, 0)).parent = card
    F.obj('Pin63', C.sphere(0.012, 8, 6), F.mat('Pin63', '#b02020', 0.4), (0, -0.015, 0.21)).parent = card
    F.keys(card, 'location', [(0, Vector((x + 1.2, -0.005, z))), (1.5, Vector((x + 1.2, -0.005, z))), (2.3, Vector((x, -0.005, z)))])
    P.stamp([(x, z)], 0, 4.0)
    # the new slot is past the reach of the board's own lamp
    lamp = F.lamp((2.4, -1.5, 2.6), 60, '#ffe2b8', radius=0.3, kind='SPOT')
    lamp.data.spot_size = math.radians(70)
    lamp.rotation_euler = (Vector((x, 0, z)) - lamp.location).to_track_quat('-Z', 'Y').to_euler()
    cam, aim = F.camera((2.5, -1.6, 1.3), (2.3, 0, 1.2), lens=40)
    F.keys(cam, 'location', [(0, Vector((2.5, -1.6, 1.3))), (ctx.duration, Vector((2.1, -1.6, 1.3)))])
    F.keys(aim, 'location', [(0, Vector((2.3, 0, 1.2))), (ctx.duration, Vector((1.9, 0, 1.2)))])


def earth_again(ctx):
    ctx.duration = 8.0   # the prologue shot's own keys, frame for frame; only its first 6 s render
    P.earth_night(ctx)
    F.keys(ctx.scene.view_settings, 'exposure', [(5.0, 0.0), (5.95, -10.0)], interp='LINEAR')


# ------------------------------------------------------------ Disconnected


def exit_door(ctx):
    beam, beam_m = eden_grove(ctx)
    # the beam widens, whitens and comes down to the grass: a doorway of light
    F.keys(beam, 'scale', [(0.5, Vector((1, 1, 1))), (2.5, Vector((7, 7, 1)))])
    F.keys(beam, 'location', [(0.5, Vector((0, 30, 207))), (2.5, Vector((0, 30, 200)))])
    for o in beam.children:   # the halo would swell into a wall of glass
        o.hide_render = True
    F.keys(beam_m.node_tree.nodes['Emission'].inputs['Color'], 'default_value',
           [(0.5, C.lin('#9fe3ff')), (2.5, C.lin('#ffffff'))])
    F.keys(F.strength_socket(beam_m), 'default_value', [(0.5, 3.0), (2.5, 6.0)], interp='LINEAR')
    root = F.import_glb(ctx.asset('models/character.glb'), (0, 18, 0), (0, 0, 180), 1.0)
    F.keys(root, 'location', [(0, Vector((0, 18, 0))), (ctx.duration, Vector((0, 29.2, 0)))], interp='LINEAR')
    arm = next((o for o in F.children(root) if o.type == 'ARMATURE'), None)
    run = bpy.data.actions.get('Run')
    if arm is not None and run is not None:
        try:
            arm.animation_data_create()
            arm.animation_data.action = None
            strip = arm.animation_data.nla_tracks.new().strips.new('Run', 1, run)
            strip.repeat, strip.scale = 12, 1.6
        except Exception as e:  # a pose is enough if the clip will not attach
            print(f'WARN exit_door: walk clip not attached ({e})')
    cam, aim = F.camera((1.5, 8, 1.7), (0, 30, 3), lens=35, clip=(0.1, 1000.0))


def eden_unmade(ctx):
    w = F.world('#000000', 1.0, stars=1.6)
    for n in w.node_tree.nodes:   # the stars snap into a grid
        if n.type == 'TEX_VORONOI':
            F.keys(n.inputs['Randomness'], 'default_value', [(1.0, 1.0), (6.0, 0.0)], interp='LINEAR')
    sun = Vector((0.9, 0.3, 0.2)).normalized()
    p = E.planet(ctx, 'textures/flight/planet_eden.webp', sun_dir=sun, cover=0.0, name='Eden')
    F.sun(-sun, 3.0)
    nt = p.data.materials[0].node_tree
    bsdf = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    tex = next(n for n in nt.nodes if n.type == 'TEX_IMAGE')
    grid = bpy.data.images.new('UVGrid', 1024, 512)
    grid.generated_type = 'UV_GRID'
    tg = nt.nodes.new('ShaderNodeTexImage')
    tg.image = grid
    grey = nt.nodes.new('ShaderNodeHueSaturation')
    grey.inputs['Saturation'].default_value = 0.15
    nt.links.new(tg.outputs['Color'], grey.inputs['Color'])
    mix = nt.nodes.new('ShaderNodeMix')
    mix.data_type = 'RGBA'
    nt.links.new(tex.outputs['Color'], mix.inputs['A'])
    nt.links.new(grey.outputs['Color'], mix.inputs['B'])
    F.keys(mix.inputs['Factor'], 'default_value', [(1.5, 0.0), (5.5, 1.0)], interp='LINEAR')
    nt.links.new(mix.outputs['Result'], bsdf.inputs['Base Color'])
    wire = E._sphere_mesh('WireClouds', 48, 24)
    wire.parent, wire.scale = p, (1.02,) * 3
    wire.modifiers.new('Wire', 'WIREFRAME').thickness = 0.004
    wm = F.emit('Wire', '#dfefff', 0.0)
    wire.data.materials.append(wm)
    F.keys(F.strength_socket(wm), 'default_value', [(2.0, 0.0), (5.0, 1.5)], interp='LINEAR')
    cam, aim = F.camera((0.2, -2.2, 0.5), (0, 0, 0.1), lens=35)
    F.keys(cam, 'location', [(0, Vector((0.2, -2.2, 0.5))), (ctx.duration, Vector((0.4, -4.4, 0.9)))])


def earth_unmade(ctx):
    F.world('#101012', 1.0)
    F.sun((0.4, 0.6, -0.8), 2.2, '#ffffff')
    grey = clay()
    ctx.scene.view_layers[0].material_override = grey
    # beat 1: the skyline as plain boxes
    b = C.Builder(vcol=False)
    for _ in range(300):
        bx, by = ctx.rng.uniform(-700, 700), ctx.rng.uniform(900, 1800)
        h = ctx.rng.uniform(12, 120)
        b.add(C.place(C.box(ctx.rng.uniform(20, 50), ctx.rng.uniform(20, 50), h), (bx, by, h / 2)), smooth=None)
    b.object('ClayCity', [grey])
    F.plane('ClayGround', 8000, 8000, grey, (2500, 1000, 0))   # under beats 1 and 2; beat 3 floats in the void
    # beat 2: the street's machines, eyeless
    for i, x in enumerate((-4.0, -1.5, 1.0, 3.5)):
        FG.machine(f'ClayM{i}', grey, grey, 'stride', (5000 + x, 12, 0), ctx.rng.uniform(-10, 10))
    # beat 3: Earth as a plain sphere under a grid
    ball = C.sphere(50, 48, 24)
    F.obj('ClayEarth', ball, grey, (10000, 0, 0), smooth=True)
    lat = C.sphere(50.6, 24, 12)
    shell = F.obj('ClayGrid', lat, grey, (10000, 0, 0))
    shell.modifiers.new('Wire', 'WIREFRAME').thickness = 0.35
    cam, aim = F.camera((0, 0, 30), (0, 1200, 80), lens=32, clip=(0.5, 8000.0))
    for t, c, a in ((0.0, (0, 0, 30), (0, 1200, 80)), (2.67, (4990, 0.5, 1.6), (4998, 12, 1.7)),
                    (5.33, (10000, -170, 25), (10000, 0, 0))):
        F.key(cam, 'location', t, Vector(c), interp='CONSTANT')
        F.key(aim, 'location', t, Vector(a), interp='CONSTANT')


def wall_same(ctx):
    P.selection_wall(ctx, same=ctx.asset('portraits/05.webp'), blank_62=4.0, desaturate=True)
    cam, aim = F.camera((-0.3, -1.9, 1.4), (-0.5, 0, 1.33), lens=36)
    F.keys(cam, 'location', [(0, Vector((-0.3, -1.9, 1.4))), (ctx.duration, Vector((-1.1, -1.85, 1.38)))])
    F.keys(aim, 'location', [(0, Vector((-0.5, 0, 1.33))), (ctx.duration, Vector((-1.2, 0, 1.33)))])


def point(ctx):
    F.world('#000000', 1.0)
    F.sun((0.3, 0.8, -0.6), 1.6, '#ffffff')
    grey = clay()
    root = C.link(bpy.data.objects.new('Everything', None))
    root.location = (0, 0, 0.8)
    F.obj('Ball', C.sphere(0.8, 32, 16), grey, (0, 0, 0), smooth=True).parent = root
    for k in range(10):
        a = k / 10 * 2 * math.pi
        F.obj('Block', C.box(0.3, 0.3, 0.3 + 0.1 * k), grey, (1.6 * math.cos(a), 1.6 * math.sin(a), 0)).parent = root
    F.keys(root, 'scale', [(0, Vector((1, 1, 1))), (3.0, Vector((0.001, 0.001, 0.001)))])
    spark = F.glow('Point', '#ffffff', 0.0)
    F.obj('Point', C.sphere(0.03, 12, 8), spark, (0, 0, 0.8))
    F.keys(F.strength_socket(spark), 'default_value', [(0.0, 0.0), (2.6, 0.0), (3.0, 8.0), (4.0, 0.0)], interp='LINEAR')
    cam, aim = F.camera((0, -6, 1.6), (0, 0, 0.8), lens=35)
