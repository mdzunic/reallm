# Shots of the prologue "Blackout" and the departure "Outbound" (SPEC-021
# §4.1, §4.2, §5.3). Each function builds one shot into the empty scene
# film.render_shot() hands it; times are shot-local seconds.
import math

import bmesh
import bpy
from mathutils import Vector, noise

import common as C
import earth as E
import figures as FG
import film as F
import nodes as N
import plate as PL

EYE = '#ff3b30'
CITY = '#ffcc88'


# ------------------------------------------------------------ small helpers


def sky_gradient(stops, strength=1.0):
    """A world whose colour follows the view direction's height (Generated Z)."""
    w = bpy.data.worlds.new('Sky')
    w.use_nodes = True
    g = N.Graph(w)
    z = g.xyz(g.vmath('NORMALIZE', g.coords('Generated')))[2]
    ramp = g.node('ShaderNodeValToRGB')
    els = ramp.color_ramp.elements
    for i, (pos, col) in enumerate(stops):
        e = els[i] if i < len(els) else els.new(pos)
        e.position, e.color = pos, C.lin(col)
    g.link(g.math('ADD', g.math('MULTIPLY', z, 0.5), 0.5), ramp.inputs['Fac'])
    back = g.node('ShaderNodeBackground')
    g.link(ramp.outputs['Color'], back.inputs['Color'])
    back.inputs['Strength'].default_value = strength
    out = g.node('ShaderNodeOutputWorld')
    g.link(back.outputs[0], out.inputs['Surface'])
    bpy.context.scene.world = w
    return back.inputs['Strength']


def eye_mat(i, strength=0.0):
    return F.emit(f'Eye{i}', EYE, strength)


def concrete(name, color='#4a4744', scale=3.0, rough=0.85):
    m, nt, bsdf = C._principled(name)
    g = N.Graph.__new__(N.Graph)
    g.nt = nt
    n = g.noise(g.coords('Object'), scale, 7, detail=6)
    ramp = g.node('ShaderNodeValToRGB')
    ramp.color_ramp.elements[0].color = C.lin(color)
    ramp.color_ramp.elements[1].color = C.lin(color, 1)[:3] + (1,)
    lo = C.lin(color)
    ramp.color_ramp.elements[0].color = (lo[0] * 0.55, lo[1] * 0.55, lo[2] * 0.55, 1)
    g.link(n, ramp.inputs['Fac'])
    g.link(ramp.outputs['Color'], bsdf.inputs['Base Color'])
    bsdf.inputs['Roughness'].default_value = rough
    return m


def boxes(name, parts, material, vcol=False):
    """Merge [(sx, sy, sz, loc, rot, color)] boxes into one object."""
    b = C.Builder(vcol=vcol)
    for sx, sy, sz, loc, rot, col in parts:
        b.add(C.place(C.box(sx, sy, sz), loc, rot), color=col, smooth=None)
    return b.object(name, [material])


def satellite(loc):
    body = F.obj('Sat', C.box(0.005, 0.004, 0.004), F.mat('SatBody', '#9a9ea6', 0.4, 0.7), loc)
    for s in (-1, 1):
        F.obj('SatWing', C.box(0.012, 0.0005, 0.004), F.mat('SatPanel', '#1d2a5a', 0.3, 0.2), (0.009 * s, 0, 0)).parent = body
    blink = F.emit('SatBlink', '#9fe3ff', 0.0)
    F.obj('SatLamp', C.sphere(0.0012, 6, 4), blink, (0, 0, 0.003)).parent = body
    return body, F.strength_socket(blink)


# ------------------------------------------------------------ prologue


def earth_night(ctx):
    F.world('#000000', 1.0, stars=2.0)
    home, east, up = E.basis(ctx)
    sun = (-home * 0.8 + up * 0.28 + east * 0.52).normalized()
    E.earth(ctx, prewar=True, sun_dir=sun)
    F.sun(-sun, 2.6)
    cam, aim = F.camera(tuple(home * 2.4 + up * 0.22), tuple(home * 0.5 + up * 0.58), lens=35)
    F.keys(cam, 'location', [(0, home * 2.4 + up * 0.22), (ctx.duration, home * 2.22 + up * 0.2)])
    sat, blink = satellite(tuple(home * 1.45 + up * 0.95 - east * 0.6))
    F.keys(sat, 'location', [(0, home * 1.45 + up * 0.95 - east * 0.6), (ctx.duration, home * 1.5 + up * 0.9 + east * 0.6)],
           interp='LINEAR')
    for k in range(16):
        F.key(blink, 'default_value', k * 0.5, 30.0 if k % 2 == 0 else 0.0, interp='CONSTANT')


def machine_hall(ctx):
    F.world('#0a0e16', 0.35)
    floor = concrete('Floor', '#2a2c30', 0.6, 0.5)
    F.plane('Floor', 30, 60, floor, (0, 22, 0))
    rack = F.mat('Rack', '#15181d', 0.45, 0.6)
    parts, leds = [], C.Builder(vcol=False)
    for side in (-1, 1):
        for i in range(26):
            y = 1.0 + i * 1.25
            parts.append((0.9, 1.1, 2.4, (3.6 * side, y, 1.2), (0, 0, 0), (1, 1, 1, 1)))
            for r in range(9):
                leds.add(C.place(C.box(0.02, 0.5, 0.03), (3.6 * side - 0.46 * side, y, 0.4 + r * 0.22)), smooth=None)
    boxes('Racks', parts, rack)
    led = bpy.data.materials.new('Leds')
    led.use_nodes = True
    g = N.Graph(led)
    tw = g.noise(g.coords('Object'), 9.0, 3, detail=2)
    wnode = tw.node
    F.key(wnode.inputs['W'], 'default_value', 0, 0.0, interp='LINEAR')
    F.key(wnode.inputs['W'], 'default_value', ctx.duration, 6.0, interp='LINEAR')
    on = g.math('GREATER_THAN', tw, 0.5)
    em = g.node('ShaderNodeEmission')
    em.inputs['Color'].default_value = C.lin('#4ad8ff')
    g.link(g.math('MULTIPLY', g.math('ADD', 0.25, on), 3.0), em.inputs['Strength'])
    out = g.node('ShaderNodeOutputMaterial')
    g.link(em.outputs[0], out.inputs['Surface'])
    leds.object('Leds', [led])
    body = F.mat('Machine', '#3a4048', 0.45, 0.7)
    cradle = F.mat('Cradle', '#20242a', 0.5, 0.6)
    frame_parts = []
    for side in (-1, 1):
        for i in range(12):
            y = 2.0 + i * 2.4
            order = 11 - i
            eye = eye_mat(f'{side}_{i}')
            FG.machine(f'M{side}_{i}', body, eye, 'stand', (1.75 * side, y, 0), -90 * side)
            t = 0.8 + order * 0.24
            s = F.strength_socket(eye)
            F.key(s, 'default_value', t, 0.0, interp='LINEAR')
            F.key(s, 'default_value', t + 0.12, 14.0, interp='LINEAR')
            for dy in (-0.45, 0.45):
                frame_parts.append((0.12, 0.12, 2.5, (2.35 * side, y + dy, 1.25), (0, 0, 0), (1, 1, 1, 1)))
            frame_parts.append((0.12, 1.02, 0.12, (2.35 * side, y, 2.46), (0, 0, 0), (1, 1, 1, 1)))
    boxes('Cradles', frame_parts, cradle)
    for i in range(5):
        F.lamp((0, 4 + i * 7, 3.6), 160, '#9fc4ff', radius=0.6, kind='POINT')
    cam, aim = F.camera((0, -3.0, 1.25), (0, 32, 1.6), lens=24)
    F.keys(cam, 'location', [(0, Vector((0, -3.0, 1.25))), (ctx.duration, Vector((0, 3.0, 1.2)))])


def launch(ctx):
    F.world('#000000', 1.0, stars=1.6)
    home, east, up = E.basis(ctx)
    sun = (-home * 0.9 + up * 0.4).normalized()
    E.earth(ctx, prewar=True, sun_dir=sun)
    F.sun(-sun, 1.6)
    trail = F.emit('Trail', '#ffd9a0', 3.0)
    for i in range(36):
        a, b = ctx.rng.uniform(-9, 9), ctx.rng.uniform(-6, 6)
        p0 = home.copy()
        p0 = (p0 + east * math.tan(math.radians(a)) + up * math.tan(math.radians(b))).normalized()
        heading = (up * 0.8 + east * ctx.rng.uniform(-0.6, 0.6)).normalized()
        p1 = (p0 + heading * math.tan(math.radians(ctx.rng.uniform(14, 24)))).normalized()
        cu = bpy.data.curves.new('Trail', 'CURVE')
        cu.dimensions = '3D'
        cu.bevel_depth = 0.0007
        cu.bevel_resolution = 1
        cu.bevel_factor_mapping_end = 'SPLINE'
        sp = cu.splines.new('POLY')
        n = 28
        sp.points.add(n - 1)
        for k in range(n):
            s = k / (n - 1)
            d = p0.slerp(p1, s * 0.7) if hasattr(p0, 'slerp') else (p0 * (1 - s) + p1 * s).normalized()
            r = 1.004 + 0.13 * (1 - (1 - s) ** 2)
            v = d.normalized() * r
            sp.points[k].co = (v.x, v.y, v.z, 1)
        cu.materials.append(trail)
        C.link(bpy.data.objects.new('Trail', cu))
        t0 = 0.4 + i * 0.12 + ctx.rng.uniform(0, 0.4)
        F.key(cu, 'bevel_factor_end', 0, 0.0, interp='CONSTANT')
        F.key(cu, 'bevel_factor_end', t0, 0.0, interp='LINEAR')
        F.key(cu, 'bevel_factor_end', t0 + 3.6, 1.0, interp='LINEAR')
    cam, aim = F.camera(tuple(home * 1.5 - up * 0.3), tuple(home * 0.92 + up * 0.62), lens=30)
    F.keys(aim, 'location', [(0, home * 0.92 + up * 0.62), (ctx.duration, home * 0.95 + up * 0.85)])


def stranded(ctx):
    F.world('#4a505a', 1.25)
    F.sun((0.3, 0.6, -1.0), 2.0, '#c8ccd4', angle=0.6)
    ground = concrete('Street', '#3a3834', 0.3)
    F.plane('Street', 60, 140, ground, (0, 40, 0))
    facade = concrete('Facade', '#34322f', 0.15, 0.9)
    parts = []
    for side in (-1, 1):
        y = -10.0
        while y < 90:
            w = ctx.rng.uniform(7, 13)
            h = ctx.rng.uniform(9, 26)
            parts.append((8, w - 0.6, h, (side * (10 + 4), y + w / 2, h / 2), (0, 0, 0), (1, 1, 1, 1)))
            for _ in range(3):
                parts.append((ctx.rng.uniform(1, 3), ctx.rng.uniform(1, 3), ctx.rng.uniform(1, 4),
                              (side * ctx.rng.uniform(10, 14), y + ctx.rng.uniform(0, w), h + ctx.rng.uniform(0, 1.5)),
                              (ctx.rng.uniform(-20, 20), ctx.rng.uniform(-20, 20), 0), (1, 1, 1, 1)))
            y += w
    for _ in range(260):
        s = ctx.rng.uniform(0.15, 0.9)
        parts.append((s, s * ctx.rng.uniform(0.6, 1.4), s * 0.6, (ctx.rng.uniform(-9, 9), ctx.rng.uniform(0, 70), s * 0.25),
                      (ctx.rng.uniform(-30, 30), ctx.rng.uniform(-30, 30), ctx.rng.uniform(0, 90)), (1, 1, 1, 1)))
    boxes('Ruins', parts, facade)
    body = F.mat('Machine', '#3a4048', 0.5, 0.7)
    xs = [-7.5, -5.6, -3.8, -1.8, 0.2, 2.1, 4.0, 6.1, 8.0]
    for i, x in enumerate(xs):
        eye = eye_mat(i, 12.0)
        FG.machine(f'M{i}', body, eye, 'stride', (x, 12 + ctx.rng.uniform(-1.2, 1.2), 0), ctx.rng.uniform(-12, 12),
                   head_tilt=ctx.rng.uniform(-6, 10))
        t = (2.5, 5.0, 7.5)[i // 3]
        s = F.strength_socket(eye)
        F.keys(s, 'default_value', [(t - 0.2, 12.0), (t - 0.16, 4.0), (t - 0.12, 12.0), (t, 12.0), (t + 0.9, 0.0)],
               interp='LINEAR')
    flake = F.obj('Flake', C.box(0.04, 0.04, 0.002), F.mat('Ash', '#8a8a86', 1.0), (0, 0, -50))
    em = F.plane('AshSky', 40, 60, None, (0, 25, 16))
    ps = em.modifiers.new('Ash', 'PARTICLE_SYSTEM').particle_system
    st = ps.settings
    st.count, st.frame_start, st.frame_end, st.lifetime = 2600, -400, 240, 700
    st.normal_factor = 0.0
    st.effector_weights.gravity = 0.012
    st.brownian_factor = 0.35
    st.render_type, st.instance_object = 'OBJECT', flake
    st.particle_size, st.size_random = 1.0, 0.7
    st.use_rotations, st.rotation_factor_random = True, 1.0
    em.show_instancer_for_render = False
    cam, aim = F.camera((-9, 0.5, 1.6), (-5, 12, 1.7), lens=30)   # from x = −9: the facades begin at ±10
    F.keys(cam, 'location', [(0, Vector((-9, 0.5, 1.6))), (ctx.duration, Vector((5, 0.5, 1.6)))], interp='LINEAR')
    F.keys(aim, 'location', [(0, Vector((-5, 12, 1.7))), (ctx.duration, Vector((9, 12, 1.7)))], interp='LINEAR')


def selection_wall(ctx, same=None, blank_62=None, desaturate=False):
    """The Selection board (shared with the endings). `same` = one image path for
    every card; `blank_62` = when card 62 fades to white; `desaturate` greys the photos."""
    F.world('#0c0b0a', 0.3)
    F.plane('Board', 5.0, 2.6, F.mat('Cork', '#6a4a30', 0.95), (0, 0.01, 1.3), (90, 0, 0))
    F.plane('WallBack', 12, 6, F.mat('WallPaint', '#2a2826', 0.9), (0, 0.05, 2.0), (90, 0, 0))
    bar = F.mat('Bar', '#e8e4da', 0.8)
    ink = F.mat('Ink', '#1a1a1a', 0.8)
    pin = F.mat('Pin', '#b02020', 0.4)
    slots = []
    for row, z in enumerate((1.62, 1.08)):
        for col in range(6):
            slots.append((-1.5 + col * 0.6, z))
    cards = []
    for i, (x, z) in enumerate(slots[:12]):
        number = CARD_NUMBERS[i]
        # the second row shows the same six shifted by three, so no two cards pair up
        path = same or PL.face((i + 3 * (i // 6)) % 6 + 1)
        photo = F.textured(f'Photo{i}', path, rough=0.6)
        if desaturate:
            nt = photo.node_tree
            tex = next(n for n in nt.nodes if n.type == 'TEX_IMAGE')
            hs = nt.nodes.new('ShaderNodeHueSaturation')
            hs.inputs['Saturation'].default_value = 0.0
            nt.links.new(tex.outputs['Color'], hs.inputs['Color'])
            nt.links.new(hs.outputs['Color'], next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED').inputs['Base Color'])
        if blank_62 is not None and number == 62:
            nt = photo.node_tree
            bsdf = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
            bsdf.inputs['Emission Color'].default_value = (1, 1, 1, 1)
            F.keys(bsdf.inputs['Emission Strength'], 'default_value', [(blank_62, 0.0), (blank_62 + 1.5, 4.0)], interp='LINEAR')
        F.plane(f'Photo{i}', 0.3, 0.3, photo, (x, -0.005, z + 0.04), (90, 0, 0))
        F.plane(f'Bar{i}', 0.3, 0.1, bar, (x, -0.005, z - 0.17), (90, 0, 0))
        F.text(f'No. {number:02d}', 0.05, ink, (x, -0.008, z - 0.17), (90, 0, 0))
        F.obj(f'Pin{i}', C.sphere(0.012, 8, 6), pin, (x, -0.02, z + 0.21))
        cards.append((x, z))
    lamp = F.lamp((-1.4, -1.6, 2.6), 60, '#ffe2b8', radius=0.3, kind='SPOT')
    lamp.data.spot_size = math.radians(80)
    lamp.rotation_euler = (Vector((0.2, 1.6, -1.6))).to_track_quat('-Z', 'Y').to_euler()
    return cards


def stamp(cards, index, t, name='Stamp'):
    x, z = cards[index]
    red = F.mat('StampInk', '#b3261e', 0.7, 0.0, '#b3261e', 0.25)
    s = F.text('SELECTED', 0.055, red, (x, -0.012, z + 0.04), (90, -14, 0))
    F.keys(s, 'scale', [(t - 1 / 24, Vector((0, 0, 0))), (t, Vector((1.3, 1.3, 1.3))), (t + 2 / 24, Vector((1, 1, 1)))],
           interp='LINEAR')
    return s


def selection(ctx):
    cards = selection_wall(ctx)
    for k, idx in enumerate(STAMP_ORDER):
        stamp(cards, idx, 1.6 + k * 1.6)
    cam, aim = F.camera((-0.6, -1.75, 1.4), (-0.8, 0, 1.33), lens=40)
    F.keys(cam, 'location', [(0, Vector((-0.6, -1.75, 1.4))), (ctx.duration, Vector((-1.0, -1.7, 1.38)))])
    F.keys(aim, 'location', [(0, Vector((-0.8, 0, 1.33))), (ctx.duration, Vector((-1.0, 0, 1.33)))])


def gantry(ctx, swing=None, at=(14.0, 2.0), height=34.0):
    """The launch gantry beside the pad: a braced lattice tower on a concrete plinth,
    a red top deck with floodlights and a slow red beacon, and a service arm that
    reaches for the ship and swings back over `swing` = (t0, t1) s (back already if None)."""
    x0, y0 = at
    w, base = 1.7, 1.0
    steel = F.mat('GantrySteel', '#62666c', 0.5, 0.75)
    red = F.mat('GantryRed', '#8a3a28', 0.6, 0.3)
    F.obj('Plinth', C.box(2 * w + 2.4, 2 * w + 2.4, base), concrete('Plinth', '#5a5854', 0.4), (x0, y0, base / 2))
    corners = [(x0 - w, y0 - w), (x0 + w, y0 - w), (x0 + w, y0 + w), (x0 - w, y0 + w)]
    b = C.Builder(vcol=False)
    for cx, cy in corners:
        b.add(C.place(C.box(0.34, 0.34, height), (cx, cy, base + height / 2)), smooth=None)
    levels = 11
    for i in range(levels + 1):
        z = base + i * height / levels
        z1 = base + (i + 1) * height / levels
        for j in range(4):
            (ax, ay), (bx, by) = corners[j], corners[(j + 1) % 4]
            b.add(C.along(C.box(0.18, 0.18, C.length((ax, ay, z), (bx, by, z))), (ax, ay, z), (bx, by, z)), smooth=None)
            if i < levels:   # X-bracing on every face of every level
                for u, v in (((ax, ay, z), (bx, by, z1)), ((bx, by, z), (ax, ay, z1))):
                    b.add(C.along(C.cyl(0.05, 0.05, C.length(u, v), n=6), u, v), smooth=None)
    b.object('Gantry', [steel])
    top = base + height
    F.obj('Deck', C.box(2 * w + 1.0, 2 * w + 1.0, 0.3), red, (x0, y0, top + 0.15))
    for dx, dy, sx, sy in ((0, -w - 0.5, 2 * w + 1.0, 0.06), (0, w + 0.5, 2 * w + 1.0, 0.06),
                           (-w - 0.5, 0, 0.06, 2 * w + 1.0), (w + 0.5, 0, 0.06, 2 * w + 1.0)):
        F.obj('Rail', C.box(sx, sy, 0.06), steel, (x0 + dx, y0 + dy, top + 1.1))
    F.obj('Mast', C.cyl(0.09, 0.05, 7.0, n=8), steel, (x0 + 1.0, y0 + 1.0, top + 3.8))
    beacon = F.emit('Beacon', '#ff3020', 0.0)
    F.obj('Beacon', C.sphere(0.22, 10, 8), beacon, (x0 + 1.0, y0 + 1.0, top + 7.4))
    for s in range(int(ctx.duration) + 1):   # one second on, one off
        F.key(F.strength_socket(beacon), 'default_value', float(s), 8.0 if s % 2 == 0 else 0.4, interp='CONSTANT')
    flood = F.emit('Flood', '#fff2d8', 8.0)
    for dy in (-1.1, 1.1):
        F.obj('Flood', C.box(0.3, 0.55, 0.4), flood, (x0 - w - 0.3, y0 + dy, top + 0.6))
    # the service arm: a truss from the tower's pad side toward the ship, hinged at the tower
    pivot = C.link(bpy.data.objects.new('ArmPivot', None))
    pivot.location = (x0 - w, y0, 5.0)
    arm, reach = C.Builder(vcol=False), 8.5
    for dy in (-0.35, 0.35):
        for dz in (-0.35, 0.35):
            arm.add(C.place(C.box(reach, 0.12, 0.12), (-reach / 2, dy, dz)), smooth=None)
    for i in range(10):
        xx = -0.4 - i * (reach - 0.8) / 9
        for u, v in (((xx, -0.35, -0.35), (xx, 0.35, 0.35)), ((xx, 0.35, -0.35), (xx, -0.35, 0.35))):
            arm.add(C.along(C.cyl(0.04, 0.04, C.length(u, v), n=6), u, v), smooth=None)
    arm.object('ServiceArm', [red]).parent = pivot
    back = math.radians(-75)   # swung toward +Y, behind the tower and out of the ship's way
    if swing is None:
        pivot.rotation_euler = (0, 0, back)
    else:
        F.keys(pivot, 'rotation_euler', [(swing[0], Vector((0, 0, 0))), (swing[1], Vector((0, 0, back)))])


def spaceport(ctx, relit=False, swing=None):
    """The launch field (shared with `capsule` and the stay ending's `fleet`); `swing`
    times the gantry's service arm (see `gantry`)."""
    stops = [(0.0, '#2a2420'), (0.5, '#ffb070'), (0.55, '#c07060'), (0.7, '#6a6a80'), (1.0, '#3a4458')]
    sky_gradient(stops, 1.0 if relit else 0.8)
    F.sun((-0.6, 1.0, -0.25), 2.2, '#ffc890')
    F.plane('Field', 600, 600, concrete('Pad', '#3c3a36', 0.05), (0, 100, 0))
    F.obj('PadRing', C.lathe([(9.0, 0.01), (10.0, 0.01)], n=48), F.mat('Hazard', '#c8a020', 0.6), (0, 0, 0))
    gantry(ctx, swing)
    ruins = []
    for i in range(70):
        x = ctx.rng.uniform(-400, 400)
        y = ctx.rng.uniform(160, 420)
        h = ctx.rng.uniform(8, 60)
        ruins.append((ctx.rng.uniform(10, 30), ctx.rng.uniform(10, 30), h, (x, y, h / 2), (0, 0, ctx.rng.uniform(0, 30)), (1, 1, 1, 1)))
    boxes('Ruins', ruins, F.mat('RuinDark', '#1e1c1c', 0.95))
    smoke = ctx.asset('textures/sprites/smoke.webp')
    ash = F.textured('AshCard', smoke, alpha=True, rough=1.0, tint='#6a6460')
    for i in range(26):
        x, y, z = ctx.rng.uniform(-260, 260), ctx.rng.uniform(120, 360), ctx.rng.uniform(40, 150)
        s = ctx.rng.uniform(60, 140)
        F.plane('Ash', s, s * 0.6, ash, (x, y, z), (90, 0, ctx.rng.uniform(-10, 10)))


def tug(ctx, loc, rot=(0, 0, 0), scale=2.5, engines=None):
    ship = F.import_glb(ctx.asset('models/ship.glb'), loc, rot, scale)
    return ship


def liftoff(ctx):
    spaceport(ctx, swing=(0.15, 0.9))   # the arm clears just as the engines light
    ship = tug(ctx, (0, 0, 2.5), (0, 0, 0), 6.0)
    F.keys(ship, 'location', [(0.8, Vector((0, 0, 2.5))), (ctx.duration, Vector((0, 8, 48)))])
    F.keys(ship, 'rotation_euler', [(0.8, Vector((0, 0, 0))), (ctx.duration, Vector((math.radians(14), 0, 0)))])
    burn = F.glow('Exhaust', '#ffcf8a', 0.0)
    for dx in (-0.45, 0.45):
        cone = F.obj('Exhaust', C.cyl(0.16, 0.02, 1.1, n=14), burn, (dx, 0.1, -0.7))
        cone.parent = ship
    F.keys(F.strength_socket(burn), 'default_value', [(0.3, 0.0), (0.8, 2.6), (ctx.duration, 3.0)], interp='LINEAR')
    heat = F.lamp((0, 0, -1.5), 0.0, '#ff9a4a', radius=1.0)
    heat.parent = ship
    F.keys(heat.data, 'energy', [(0.3, 0.0), (0.8, 40000.0), (ctx.duration, 60000.0)], interp='LINEAR')
    smoke = F.textured('Plume', ctx.asset('textures/sprites/smoke.webp'), alpha=True, rough=1.0, tint='#bdb2a8')
    for i in range(12):
        a = i / 12 * 2 * math.pi
        p = F.plane('Plume', 6, 6, smoke, (math.cos(a) * 5, math.sin(a) * 5, 2.0), (90, 0, math.degrees(a)))
        F.keys(p, 'scale', [(0.8, Vector((0.3, 0.3, 0.3))), (ctx.duration, Vector((3.2, 3.2, 3.2)))])
        F.keys(p, 'location', [(0.8, Vector(p.location)), (ctx.duration, Vector((math.cos(a) * 16, math.sin(a) * 16, 9.0)))])
    cam, aim = F.camera((-16, -24, 2.5), (0, 0, 4), lens=30)
    F.keys(aim, 'location', [(0, Vector((0, 0, 4))), (0.8, Vector((0, 0, 4))), (ctx.duration, Vector((0, 6, 42)))])


def relay(ctx):
    F.world('#000000', 1.0, stars=1.4)
    sun = Vector((0.15, 1.0, -0.06)).normalized()   # low ahead: the tug and the relay in rim light
    F.sun(-sun, 3.0)
    # the Earth keeps its own terminator (gate): that sun would light the ground ahead grey
    planet = E.earth(ctx, relight=0, sun_dir=(0.0, 0.3, -1.0), gate=True, radius=900.0, loc=(0, 0, -913), atmosphere=False,
                     rim=1.6, cloud_layer=False, segments=(512, 256))
    ring = F.import_glb(ctx.asset('models/station_ring.glb'), (9, 34, 3.0), (70, 0, 20), 1.6)
    F.import_glb(ctx.asset('models/dock.glb'), (9, 34, 3.0), (70, 0, 20), 1.6)
    F.keys(ring, 'rotation_euler', [(0, Vector((math.radians(70), 0, math.radians(20)))),
                                     (ctx.duration, Vector((math.radians(70), 0, math.radians(26))))], interp='LINEAR')
    ship = tug(ctx, (-7, 14, 0.6), (0, 0, -70), 0.9)
    F.keys(ship, 'location', [(0, Vector((-7, 14, 0.6))), (ctx.duration, Vector((3, 22, 1.4)))], interp='LINEAR')
    cam, aim = F.camera((0, 0, 1.2), (2, 30, 0.8), lens=35, clip=(0.05, 4000.0))
    F.keys(ctx.scene.view_settings, 'exposure', [(2.0, 0.0), (2.95, -10.0)], interp='LINEAR')
    return planet


# ------------------------------------------------------------ departure


def undock(ctx):
    F.world('#000000', 1.0, stars=1.2)
    sun = Vector((-1.0, 0.25, 0.12)).normalized()   # low from the side: the station lit
    F.sun(-sun, 3.4)
    E.earth(ctx, relight=0, sun_dir=(0.0, 0.3, -1.0), gate=True, radius=900.0, loc=(0, 60, -930), atmosphere=False, rim=1.6,
            cloud_layer=False, segments=(512, 256))   # the Earth below keeps its own night (gate)
    F.import_glb(ctx.asset('models/station_ring.glb'), (0, 6, 0), (0, 0, 0), 2.2)
    F.import_glb(ctx.asset('models/dock.glb'), (0, 6, 0), (0, 0, 0), 2.2)
    ship = tug(ctx, (0, 4.2, 0.4), (0, 0, 180), 1.0)
    F.keys(ship, 'location', [(0.3, Vector((0, 4.2, 0.4))), (ctx.duration, Vector((0.4, -2.6, 0.9)))])
    puff = F.glow('Puff', '#cfe8ff', 0.0)
    for dx in (-0.5, 0.5):
        p = F.obj('Puff', C.sphere(0.25, 10, 8), puff, (dx, 0.9, 0))
        p.parent = ship
    F.keys(F.strength_socket(puff), 'default_value', [(0.25, 0.0), (0.35, 1.2), (1.2, 0.0)], interp='LINEAR')
    cam, aim = F.camera((6.5, -9.0, 2.6), (0, 3.0, 0.4), lens=35, clip=(0.05, 4000.0))
    F.keys(aim, 'location', [(0, Vector((0, 3.0, 0.4))), (ctx.duration, Vector((0.3, -1.0, 0.8)))])


def jump(ctx):
    F.world('#000000', 1.0, stars=1.0)
    sun = Vector((-0.5, -0.6, 0.6)).normalized()
    F.sun(-sun, 3.0)
    ship = tug(ctx, (0, 0, 0), (0, 0, 180), 1.0)
    glow = F.glow('Engine', '#9fe3ff', 0.0)
    for dx in (-0.45, 0.45):
        g = F.obj('Engine', C.sphere(0.12, 12, 8), glow, (dx, 1.25, 0.05), scale=(1, 1.6, 1))
        g.parent = ship
    F.keys(F.strength_socket(glow), 'default_value', [(0.0, 1.0), (0.8, 4.0)], interp='LINEAR')
    streak = F.emit('Streak', '#dfefff', 3.0)
    sb = C.Builder(vcol=False)
    for i in range(420):
        x, z = ctx.rng.uniform(-40, 40), ctx.rng.uniform(-25, 25)
        if abs(x) < 3 and abs(z) < 2:
            continue
        sb.add(C.place(C.box(0.06, 1.0, 0.06), (x, ctx.rng.uniform(-60, 200), z)), smooth=None)
    streaks = sb.object('Streaks', [streak])
    F.keys(streaks, 'scale', [(0.6, Vector((1, 0.05, 1))), (2.0, Vector((1, 26, 1)))])
    F.keys(streaks, 'location', [(0.6, Vector((0, 0, 0))), (2.2, Vector((0, -120, 0)))])
    flash = F.glow('JumpFlash', '#cfe8ff', 0.0)
    F.obj('JumpFlash', C.sphere(1.0, 24, 12), flash, (0, 9, 0), scale=(30, 1, 30))
    t_peak = 2.25
    F.keys(F.strength_socket(flash), 'default_value', [(t_peak - 6 / 24, 0.0), (t_peak, 40.0), (t_peak + 12 / 24, 0.0)],
           interp='LINEAR')
    cam, aim = F.camera((1.5, -4.6, 0.9), (0, 4, 0), lens=30)
    F.keys(ctx.scene.view_settings, 'exposure', [(t_peak + 10 / 24, 0.0), (t_peak + 13 / 24, -10.0)], interp='LINEAR')
