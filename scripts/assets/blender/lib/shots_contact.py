# Shots of the contact film "Wreckers" (SPEC-063 §4.1, §4.2): the scavengers'
# hulk in Vetra's lane, a registry ground off a tug, and three rebuilt tugs
# dropping out to meet the salvager's jump. Each function builds one shot into
# the empty scene film.render_shot() hands it; times are shot-local seconds.
#
# No faces, plates or photographs: the hulls are the committed ship.glb and
# fighter.glb, the rock is asteroid.glb, Vetra is its flight map, and the one
# figure is the salvager's own suit in the scavenger bodies' tint (SPEC-048 §4.8),
# seen from behind with an opaque visor.
import math

import bmesh
import bpy
from mathutils import Quaternion, Vector

import common as C
import film as F
import salvager as S

SCALE = 2.5                 # ship.glb at the films' tug scale (shots_prologue.tug)
FIGHTER_SCALE = 1.6         # fighter.glb smaller (1.25 m tall), so three pass the bay's mouth in 1.45 m lanes
ROCK_SCALE = 6.5            # asteroid.glb's 2.8 m rock → about 18 m
HULL_DISTANCE = 10.5        # hull centres from the rock's centre: noses buried, tails out
# (azimuth°, elevation°, roll°) of each hull lashed nose-in around the rock
HULLS = ((0, 18, 10), (32, -10, 80), (64, 30, 200), (95, 4, 140), (128, -26, 30), (160, 14, 260),
         (196, -8, 110), (228, 26, 300), (262, -20, 60), (296, 8, 170), (318, -40, 230), (345, 40, 20))
PORTS = (0, 3, 6, 10)       # hulls with an amber port lit
AMBER = '#ffb060'
BAY = Vector((0.0, -13.0, -2.0))   # the bay's mouth, on the rock's −Y face
SCAV = {   # SPEC-048 §4.8 SCAV_BODY_TINT: primary #4f4a3d over the suit's greys, secondary black on the visor
    'suit': (0, '#3b382f', 0.85, 0.0, None),
    'armor': (1, '#4f4a3d', 0.5, 0.15, None),
    'visor': (5, 0.015, 0.12, 0.6, None),
    'glow': (6, 0.12, 0.6, 0.0, None),
    'warm': (10, 0.2, 0.6, 0.0, None),
}


# ------------------------------------------------------------ pieces


def _remove(obj):
    for o in F.children(obj):
        bpy.data.objects.remove(o, do_unlink=True)
    bpy.data.objects.remove(obj, do_unlink=True)


def rock(ctx, loc=(0, 0, 0)):
    """asteroid.glb's first rock at ROCK_SCALE; the second is dropped."""
    root = F.import_glb(ctx.asset('models/asteroid.glb'), loc, (0, 0, 0), ROCK_SCALE)
    for o in list(root.children):
        if o.name.startswith('AsteroidB'):
            _remove(o)
        else:
            o.location = (0, 0, 0)
    return root


def planet(ctx, loc, radius, name='Vetra'):
    """A UV sphere wearing the flight's Vetra map, toned down to sit behind the
    hulk, lit by the scene's suns."""
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=192, v_segments=96, radius=radius, calc_uvs=True)
    m = F.textured(name, ctx.asset('textures/flight/planet_vetra.webp'), rough=0.6, tint='#6f819c')
    return F.obj(name, bm, m, loc, (0, 0, 35), smooth=True)


def cables(points, radius=0.06, name='Cables'):
    b = C.Builder(vcol=False)
    for head, tail in points:
        b.add(C.along(C.cyl(radius, radius, C.length(head, tail), n=6), head, tail), smooth=None)
    return b.object(name, [F.mat('Cable', '#2a2a2c', rough=0.5, metal=0.8)])


def hulk(ctx):
    """The rock with twelve tug hulls lashed nose-in, cables between their tails,
    four amber ports and an open bay on the −Y face. Returns the root empty."""
    root = C.link(bpy.data.objects.new('Hulk', None))
    stone = rock(ctx)
    stone.parent = root
    amber = F.emit('Port', AMBER, 3.0)
    tails = []
    for i, (az, el, roll) in enumerate(HULLS):
        a, e = math.radians(az), math.radians(el)
        d = Vector((math.cos(e) * math.sin(a), -math.cos(e) * math.cos(a), math.sin(e)))
        # local +Y (the tail) out along d, so the nose is buried; then rolled about that axis
        q = d.to_track_quat('Y', 'Z') @ Quaternion((0, 1, 0), math.radians(roll))
        tug = F.import_glb(ctx.asset('models/ship.glb'), tuple(d * HULL_DISTANCE), (0, 0, 0), SCALE)
        tug.rotation_mode = 'QUATERNION'
        tug.rotation_quaternion = q
        tug.parent = root
        tails.append(d * (HULL_DISTANCE + 2.2))
        if i in PORTS:
            side = q @ Vector((0.78, 0.4, 0.15))
            F.obj('Port', C.sphere(0.14, 10, 6), amber, tuple(d * HULL_DISTANCE + side)).parent = root
    links = [(tails[i], tails[(i + 1) % len(tails)]) for i in range(len(tails))]
    links += [(t, t * 0.78) for t in tails[::2]]
    cables(links).parent = root
    # the bay: four welded plates round an open mouth on the −Y face, lit amber inside
    plate = F.mat('BayPlate', '#3a3631', rough=0.65, metal=0.6)
    b = C.Builder(vcol=False)
    for size, loc in (((7.0, 5.0, 0.25), (0, -10.5, 0.4)), ((7.0, 5.0, 0.25), (0, -10.5, -4.4)),
                      ((0.25, 5.0, 5.0), (-3.5, -10.5, -2.0)), ((0.25, 5.0, 5.0), (3.5, -10.5, -2.0))):
        b.add(C.place(C.box(*size, 0.04), loc), smooth=None)
    for x in (-2.4, -0.8, 0.8, 2.4):   # ribs across the roof
        b.add(C.place(C.box(0.2, 5.2, 0.3), (x, -10.5, 0.6)), smooth=None)
    b.add(C.place(C.box(7.4, 0.3, 0.4), (0, -13.0, 0.35)), smooth=None)   # the lintel over the mouth
    b.object('Bay', [plate]).parent = root
    F.lamp((0, -9.5, -1.5), 900.0, AMBER, radius=1.2).parent = root
    F.obj('BayGlow', C.box(6.6, 0.1, 4.4), F.emit('BayBack', '#2a1a0c', 0.5), (0, -8.1, -2.0)).parent = root
    return root


def dust(ctx, centre, extent, n=260, name='Dust'):
    """Ice motes for parallax: tiny pale chips scattered in a box."""
    b = C.Builder(vcol=False)
    for _ in range(n):
        p = Vector(centre) + Vector([ctx.rng.uniform(-s, s) for s in extent])
        b.add(C.place(C.ico(ctx.rng.uniform(0.02, 0.07), 0), tuple(p)), smooth=None)
    return b.object(name, [F.emit('Mote', '#cfe2ff', 0.6)])


def scavenger(loc, yaw):
    """The salvager's suit in the scavengers' tint, hands empty; faces −Y before `yaw`."""
    arm, mesh = S.build(helmet='hood', overrides=SCAV, name='Scav', strength=1.0, rifle=False)
    arm.location = loc
    arm.rotation_euler = (0, 0, math.radians(yaw))
    return arm


# ------------------------------------------------------------ shots


def hulk_shot(ctx):
    """`hulk` (0–4 s, pan in): the hulk in Vetra's lane, Vetra low on the left, out
    of the black the departure's jump cut to."""
    F.world('#000000', 1.0, stars=1.2)
    F.sun((-0.5, 0.6, -0.6), 3.2, '#e8f0ff')            # the key, high on the right
    F.sun((0.7, -0.15, 0.55), 0.7, '#8fb6ff')           # Vetra's light from below left
    planet(ctx, (256, 1928, -914), 650.0)
    root = hulk(ctx)
    F.keys(root, 'rotation_euler', [(0, Vector((0, 0, 0))), (ctx.duration, Vector((0.03, 0.0, math.radians(6))))],
           interp='LINEAR')
    dust(ctx, (-14, -34, 4), (26, 22, 14))
    cam, aim = F.camera((-30, -52, 10), (-1, -2, -1), lens=35, clip=(0.1, 6000.0))
    F.keys(cam, 'location', [(0, Vector((-30, -52, 10))), (ctx.duration, Vector((-18, -33, 6)))])
    F.keys(ctx.scene.view_settings, 'exposure', [(0.0, -8.0), (0.6, 0.0)], interp='LINEAR')


def cutting(ctx):
    """`cutting` (4–8.5 s, pan right): in the bay, a figure grinds the registry off
    a tug's nose; the camera tracks right along the hull to the welded blades."""
    F.world('#000000', 1.0, stars=0.8)
    # the bay: grated floor, back wall, the open mouth behind the tug
    floor = F.mat('Floor', '#24221f', rough=0.8, metal=0.5)
    wall = F.mat('Wall', '#34302a', rough=0.7, metal=0.55)
    b = C.Builder(vcol=False)
    b.add(C.place(C.box(16, 12, 0.2), (0, 0, -0.1)), smooth=None)
    for x in range(-7, 8):
        b.add(C.place(C.box(0.05, 12, 0.03), (x, 0, 0.015)), smooth=None)
    b.object('Floor', [floor])
    w = C.Builder(vcol=False)
    w.add(C.place(C.box(0.3, 12, 7), (-8, 0, 3.5)), smooth=None)
    w.add(C.place(C.box(16, 12, 0.3), (0, 0, 7.0)), smooth=None)
    for x in (-6, -3, 0, 3, 6):
        w.add(C.place(C.box(0.3, 12, 0.5), (x, 0, 6.7)), smooth=None)
    w.object('Walls', [wall])
    planet(ctx, (300, 1600, -500), 700.0)
    F.sun((-0.4, 0.8, -0.45), 1.2, '#cfe0ff')
    # the tug on its cradle, nose toward −X; its flank faces the camera
    tug = F.import_glb(ctx.asset('models/ship.glb'), (0, 0.4, 1.1), (0, 0, -90), SCALE)
    cradle = F.mat('Cradle', '#5a4a2a', rough=0.6, metal=0.4)
    for x in (-1.2, 1.2):
        F.obj('Cradle', C.box(0.4, 1.6, 0.7), cradle, (x, 0.4, 0.35))
    # the registry plate on the nose block: CR- left, the rest ground bare
    nose_x, flank_y, plate_z = -1.95, -0.21, 1.17
    F.obj('Plate', C.box(0.9, 0.03, 0.32, 0.01), F.mat('PlatePaint', '#2a2d31', rough=0.5, metal=0.6),
          (nose_x, flank_y - 0.02, plate_z))
    F.obj('Ground', C.box(0.5, 0.034, 0.28), F.mat('Bare', '#c9ccce', rough=0.18, metal=1.0),
          (nose_x + 0.17, flank_y - 0.02, plate_z))
    F.text('CR-', 0.2, F.mat('Letters', '#d8d2c4', rough=0.5), (nose_x - 0.24, flank_y - 0.04, plate_z), rot=(90, 0, 0))
    # the scavenger, back to the camera, hands at the plate; the grinder between them
    who = scavenger((nose_x + 0.02, flank_y - 0.62, 0.0), 180)
    grinder = C.link(bpy.data.objects.new('Grinder', None))
    grinder.location = (nose_x - 0.06, flank_y - 0.17, 1.08)
    body = F.mat('GrinderBody', '#2b2b2b', rough=0.5, metal=0.3)
    F.obj('GrinderBody', C.cyl(0.045, 0.045, 0.28, n=12), body, (0.0, -0.06, 0.0), (0, 90, 0)).parent = grinder
    F.obj('GrinderDisc', C.cyl(0.075, 0.075, 0.006, n=20), F.emit('Disc', '#ffb46a', 1.6), (0.1, 0.0, 0.0), (90, 0, 0)).parent = grinder
    for t, dx in ((0, 0.0), (ctx.duration, 0.12)):
        F.key(who, 'location', t, Vector((nose_x + 0.02 + dx, flank_y - 0.62, 0.0)))
        F.key(grinder, 'location', t, Vector((nose_x - 0.06 + dx, flank_y - 0.17, 1.08)))
    sparks(ctx, grinder)
    # the blades waiting by the tail, hung on chains from the roof
    olive = F.mat('Blade', '#5f5d52', rough=0.62, metal=0.2)
    red = F.mat('War', '#8f2418', rough=0.55, metal=0.1)
    for i, x in enumerate((3.4, 4.3)):
        y = -1.4 - 0.35 * i
        F.obj('Blade', C.box(0.16, 0.8, 2.4, 0.03), olive, (x, y, 1.9), (0, 8 - 16 * i, 6))
        F.obj('War', C.box(0.17, 0.82, 0.22), red, (x, y, 2.5), (0, 8 - 16 * i, 6))
        F.obj('Chain', C.cyl(0.02, 0.02, 3.9, n=6), F.mat('Chain', '#2a2a2c', rough=0.4, metal=0.9), (x, y, 5.05))
    # light: a cold work lamp over the plate, the grinder's warm spill, amber ports
    F.lamp((nose_x - 0.5, -2.0, 4.0), 600.0, '#dfe8ff', radius=0.4)
    spill = F.lamp((nose_x - 0.05, flank_y - 0.4, 1.05), 40.0, '#ff9a4a', radius=0.05)
    F.keys(spill.data, 'energy', [(i * 0.25, 40.0 + 10.0 * ((i * 7) % 3 - 1)) for i in range(int(ctx.duration * 4) + 1)])
    for x in (-5.5, 0.5, 5.5):
        F.obj('Port', C.sphere(0.12, 10, 6), F.emit('Port', AMBER, 3.0), (x, 2.0, 5.2))
    F.lamp((2.0, 1.5, 4.5), 300.0, AMBER, radius=1.0)
    cam, aim = F.camera((-3.6, -5.2, 1.4), (-1.9, -0.3, 1.15), lens=35, clip=(0.05, 6000.0))
    F.keys(cam, 'location', [(0, Vector((-3.6, -5.2, 1.4))), (ctx.duration, Vector((0.4, -6.6, 1.7)))])
    F.keys(aim, 'location', [(0, Vector((-1.9, -0.3, 1.15))), (ctx.duration, Vector((2.6, -0.6, 1.9)))])
    return tug


def sparks(ctx, grinder):
    """Streaks thrown off the disc: five born a frame, each living 5–8 frames on a
    straight path, keyed visible only while alive. Small, so never a flash."""
    mesh = C.box(0.006, 0.006, 0.07)
    mat = F.emit('Spark', '#ffc27a', 12.0)
    base = bpy.data.meshes.new('Spark')
    mesh.to_mesh(base)
    mesh.free()
    base.materials.append(mat)
    frames = F.frame(ctx.duration)
    origin = grinder.location
    for f in range(1, frames + 1):
        for _ in range(5):
            life = ctx.rng.randint(5, 8)
            d = Vector((ctx.rng.uniform(-0.2, 0.6), ctx.rng.uniform(-1.0, -0.4), ctx.rng.uniform(-0.9, 0.1))).normalized()
            speed = ctx.rng.uniform(2.0, 4.0)
            o = C.link(bpy.data.objects.new('Spark', base))
            start = Vector(origin) + Vector((0.1, -0.03, -0.03))
            o.rotation_euler = d.to_track_quat('Z', 'Y').to_euler()
            t0, t1 = (f - 1) / F.FPS, (f - 1 + life) / F.FPS
            F.key(o, 'location', t0, start)
            F.key(o, 'location', t1, start + d * speed * (t1 - t0))
            F.key(o, 'scale', max(t0 - 1 / F.FPS, 0), Vector((0, 0, 0)), interp='CONSTANT')
            F.key(o, 'scale', t0, Vector((1, 1, 1)), interp='CONSTANT')
            F.key(o, 'scale', t1, Vector((0, 0, 0)), interp='CONSTANT')


def sortie(ctx):
    """`sortie` (8.5–12 s): three rebuilt tugs drop from the bay and bank right
    toward a far blue-white point — the salvager's jump, arriving at 1.1 s."""
    F.world('#000000', 1.0, stars=1.2)
    F.sun((0.9, 0.3, -0.55), 3.2, '#e8f0ff')            # from behind the camera: the hulls' tops lit
    F.sun((-0.6, -0.3, 0.6), 0.5, '#8fb6ff')
    planet(ctx, (1740, 1060, -1030), 650.0)
    hulk(ctx)
    burn = F.glow('Burn', '#ff8a4a', 0.0)
    size = FIGHTER_SCALE
    for i, t0 in enumerate((0.0, 0.6, 1.2)):
        # inside the bay, behind its near wall, until it moves; out of the mouth, down, then away to the right
        ship = F.import_glb(ctx.asset('models/fighter.glb'), (0, 0, 0), (0, 0, 0), size)
        lane = 1.2 - 1.45 * i   # one above the other through the 4.8 m mouth, so they never touch
        start = BAY + Vector((0.0, 3.5, lane))
        mouth = BAY + Vector((0.0, -2.5, lane))
        drop = mouth + Vector((3.0 + 2.5 * i, -5.0 - 1.5 * i, -3.0))
        out = drop + Vector((16.0 + 6 * i, -10.0 + 5 * i, 3.0 - 2.5 * i))
        F.keys(ship, 'location', [(0.0, start), (t0, start), (t0 + 0.6, mouth), (t0 + 1.4, drop),
                                  (max(ctx.duration, t0 + 2.6), out)])
        F.keys(ship, 'rotation_euler', [(t0 + 0.6, Vector((0, 0, 0))), (t0 + 1.0, Vector((math.radians(-8), 0, 0))),
                                        (t0 + 1.8, Vector((0, math.radians(30), math.radians(55)))),
                                        (max(ctx.duration, t0 + 2.6), Vector((0, math.radians(18), math.radians(70))))])
        g = F.obj('Burn', C.sphere(0.1, 12, 8), burn, (0, 1.32, 0), scale=(1, 1.8, 1))
        g.parent = ship   # parent space: the nozzle at model (0, 1.28, 0), scaled with the ship
    F.keys(F.strength_socket(burn), 'default_value', [(0.0, 0.3), (0.6, 3.0), (ctx.duration, 3.5)], interp='LINEAR')
    # the salvager's jump: a point, never more than 1.5 % of the frame wide
    flare = F.glow('Arrival', '#cfe8ff', 0.0)
    F.obj('Arrival', C.sphere(6.0, 16, 10), flare, (1458, -340, -205))
    F.keys(F.strength_socket(flare), 'default_value', [(1.0, 0.0), (1.1, 40.0), (1.7, 8.0), (ctx.duration, 4.0)],
           interp='LINEAR')
    cam, aim = F.camera((-12.0, -22.0, 1.0), (4.0, -20.0, -3.0), lens=30, clip=(0.1, 6000.0))
    F.keys(cam, 'location', [(0, Vector((-12.0, -22.0, 1.0))), (ctx.duration, Vector((-11.4, -22.6, 0.8)))],
           interp='LINEAR')
