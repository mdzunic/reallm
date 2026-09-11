# Hub and flight furniture (SPEC-020 §4.3–§4.4): models/station_ring.glb (the
# rotating ring over the station backdrop, lying flat — the scene tilts it),
# dock.glb (the landing pad, centred like the pad it replaces), cockpit.glb
# (camera space: the pilot looks along +Y here, three's −Z), and crate.glb (the
# boot-manifest crate, a 0.6 m cube centred on the origin, as before).
import math
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'lib'))

import bmesh  # noqa: E402
import bpy  # noqa: E402
import numpy as np  # noqa: E402

import bake as B  # noqa: E402
import common as C  # noqa: E402

box, cyl, sphere, place, torus = C.box, C.cyl, C.sphere, C.place, C.torus
L = C.lin


def ring():
    """Ring radius 2.2 m (tube 0.14) with twelve modules, four spokes and a hub."""
    body = C.mat_vcol('Body', rough=0.5, metal=0.6)
    glow = C.mat_flat('Glow', '#ffffff', emission='#8fd8ff', strength=2.0)
    b = C.Builder()
    b.add(torus(2.2, 0.14, n=48, m=8), color=L(0.55), smooth=60)
    b.add(torus(2.2, 0.155, n=48, m=4, arc=360), color=L(0.28), smooth=None)
    for i in range(12):
        a = math.radians(i * 30)
        x, y = 2.2 * math.cos(a), 2.2 * math.sin(a)
        rot = (0, 0, math.degrees(a))
        big = i % 3 == 0
        size = (0.36, 0.52, 0.30) if big else (0.26, 0.36, 0.22)
        b.add(place(box(*size, 0.03), (x, y, 0), rot), color=L(0.72 if big else 0.62))
        b.add(place(box(size[0] + 0.01, size[1] * 0.7, 0.03), (x, y, size[2] / 2), rot), mat=1)
    for i in range(4):
        a = math.radians(45 + i * 90)
        b.add(C.along(cyl(0.05, 0.05, 1.8, n=8), (0.35 * math.cos(a), 0.35 * math.sin(a), 0),
                      (2.08 * math.cos(a), 2.08 * math.sin(a), 0)), color=L(0.4))
    b.add(cyl(0.34, 0.34, 0.36, n=16), color=L(0.66))
    b.add(place(cyl(0.2, 0.26, 0.2, n=16), (0, 0, 0.27)), color=L(0.45))
    b.add(place(torus(0.35, 0.03, n=24, m=4), (0, 0, 0.19)), mat=1)
    b.add(place(cyl(0.02, 0.02, 0.6, n=6), (0, 0, 0.62)), color=L(0.3))
    b.add(place(sphere(0.04, 8, 6), (0, 0, 0.94)), mat=1)
    return b.object('StationRing', [body, glow])


def dock():
    """Octagonal pad, radius 1.1 m, 0.18 m thick, centred; edge lights and clamps."""
    body = C.mat_vcol('Body', rough=0.7, metal=0.4)
    glow = C.mat_flat('Glow', '#ffffff', emission='#ffb347', strength=2.0)
    b = C.Builder()
    b.add(place(cyl(1.1, 1.14, 0.14, n=8, bevel=0.02), (0, 0, -0.02), (0, 0, 22.5)), color=L(0.42), smooth=None)
    b.add(place(cyl(0.98, 0.98, 0.04, n=8), (0, 0, 0.065), (0, 0, 22.5)), color=L(0.22), smooth=None)
    b.add(place(torus(0.55, 0.02, n=32, m=4), (0, 0, 0.087)), mat=1)
    b.add(place(cyl(0.2, 0.2, 0.01, n=24), (0, 0, 0.088)), color=L(0.8), smooth=None)
    for i in range(8):
        a = math.radians(i * 45)
        b.add(place(box(0.08, 0.18, 0.03), (1.06 * math.cos(a), 1.06 * math.sin(a), 0.07), (0, 0, math.degrees(a) + 90)), mat=1)
    for i in range(4):
        a = math.radians(i * 90)
        rot = (0, 0, math.degrees(a))
        b.add(place(box(0.24, 0.12, 0.12, 0.02), (0.86 * math.cos(a), 0.86 * math.sin(a), 0.12), rot), color=L(0.62))
        for k in (-1, 1):
            off = math.radians(i * 90 + 90)
            cx = 0.72 * math.cos(a) + 0.16 * k * math.cos(off)
            cy = 0.72 * math.sin(a) + 0.16 * k * math.sin(off)
            b.add(place(box(0.14, 0.05, 0.012), (cx, cy, 0.087), (0, 0, math.degrees(a) + 30 * k)), color=L(0.85), smooth=None)
    return b.object('Dock', [body, glow])


FRAME, PANEL, TRIM, METAL, RUBBER = range(5)
SCREEN = 5  # slots 5, 6, 7: the three screens, left to right
SCREENS = ((-0.62, 0.34), (0.0, 0.46), (0.62, 0.34))  # (x, width); 0.16 m tall, tilted −25° about X
SCREEN_Y, SCREEN_Z, TILT = 0.925, -0.48, -25.0


def _on_console(part, side, local):
    """Place a part given in a side console's local frame."""
    place(part, local)
    return place(part, (1.05 * side, 0.7, -0.62), (0, -12 * side, 0))


def _screens(p, F):
    """The dashboard screens: radar, navigation, ship status — emissive line
    art on dark glass, drawn in each screen's own (sx, sy) ∈ [0, 1]²."""
    a = math.radians(-TILT)
    front = np.array((0.0, -math.cos(math.radians(TILT)), -math.sin(math.radians(TILT))), np.float32)
    cyan, amber = B.col('#6fd6ff'), B.col('#ffb347')
    for i, (x, w) in enumerate(SCREENS):
        rel = F.P - np.array((x, SCREEN_Y, SCREEN_Z), np.float32)
        lz = rel[..., 1] * math.sin(a) + rel[..., 2] * math.cos(a)
        sx, sy = rel[..., 0] / w + 0.5, lz / 0.16 + 0.5
        on = (F.slot == SCREEN + i)
        face = on & ((F.N @ front) > 0.8)
        p.plain(on, '#05090d', 0.12, 0.0)
        aspect = w / 0.16
        X, Y = (sx - 0.5) * aspect, sy - 0.5
        px = 1.5 / (F.size * 0.02)  # soft line half-width in screen units

        def line(dist, width=0.006):
            return np.exp(-(dist / max(width, px)) ** 2)

        cy = np.zeros_like(sx)
        am = np.zeros_like(sx)
        border = np.minimum(np.minimum(sx, 1 - sx) * aspect, np.minimum(sy, 1 - sy))
        cy += 0.35 * line(border - 0.03)
        if i == 0:  # radar: rings, crosshair, sweep, blips
            r = np.hypot(X, Y)
            inside = r < 0.44
            for R in (0.14, 0.28, 0.42):
                cy += 0.6 * line(r - R)
            cy += 0.35 * (line(X) + line(Y)) * inside
            ang = np.mod(np.arctan2(Y, X) - 0.6, 2 * math.pi)
            cy += 0.45 * np.exp(-ang * 1.4) * inside
            for bx, by, amb in ((0.18, 0.12, 0), (-0.22, 0.2, 0), (0.05, -0.3, 1), (-0.3, -0.12, 0), (0.28, -0.18, 1)):
                blip = np.exp(-((X - bx) ** 2 + (Y - by) ** 2) / 0.0004)
                if amb:
                    am += blip
                else:
                    cy += blip
        elif i == 1:  # navigation: grid, trajectory to the planet, readouts
            grid = line(np.abs(np.mod(X + 0.05, 0.2) - 0.1) - 0.1 + 0.1, 0.004) + line(np.abs(np.mod(Y, 0.2) - 0.1) - 0.1 + 0.1, 0.004)
            cy += 0.18 * np.clip(grid, 0, 1)
            curve = -0.18 + 0.34 * (1 / (1 + np.exp(-(X + 0.2) * 3.2))) - 0.05 * np.sin(X * 5)
            cy += line(Y - curve, 0.008) * (X < 1.05) * (X > -1.3)
            dist = np.hypot(X - 1.12, Y - 0.14)
            cy += 0.8 * line(dist - 0.16) + 0.25 * (dist < 0.16)
            am += np.exp(-((X + 1.25) ** 2 + (Y + 0.17) ** 2) / 0.0006)
            for k in range(3):
                row = 0.34 - k * 0.07
                seg = B.hash01(np.floor((X + 1.4) / 0.09), np.full_like(X, k), seed=5) > 0.3
                cy += 0.5 * (np.abs(Y - row) < 0.012) * (X > -1.35) * (X < -0.45 + 0.2 * k) * seg
        else:  # ship status: four bars, the low one amber, labels
            for k, level in enumerate((0.82, 0.58, 0.92, 0.27)):
                yk = 0.3 - k * 0.19
                inb = (np.abs(Y - yk) < 0.045) & (X > -0.35) & (X < 0.95)
                fill = inb & (X < -0.35 + 1.3 * level)
                glow_k = 0.18 * inb + 0.75 * fill
                if k == 3:
                    am += glow_k
                else:
                    cy += glow_k
                seg = B.hash01(np.floor((X + 1.1) / 0.07), np.full_like(X, k), seed=9) > 0.35
                cy += 0.5 * (np.abs(Y - yk) < 0.014) * (X > -0.95) * (X < -0.48) * seg
        scan = 0.85 + 0.15 * np.cos(sy * 180) ** 2
        light = (cy[..., None] * cyan + am[..., None] * amber) * scan[..., None]
        p.emissive = np.where(face[..., None], np.maximum(p.emissive, np.clip(light, 0, 1.2)), p.emissive)
        p.base = np.where(face[..., None], p.base + 0.15 * light, p.base)


def _boost_screens(obj, factor):
    """Scale every screen face's UVs by `factor` about its centre and repack, so
    the screens the pilot stares at get factor² the texels of the frame."""
    C.select_only([obj])
    bpy.ops.object.mode_set(mode='EDIT')
    bm = bmesh.from_edit_mesh(obj.data)
    uv = bm.loops.layers.uv.active
    tag = bm.loops.layers.float_color.get('Col')
    for f in bm.faces:
        if abs(f.loops[0][tag][1] - B.DECAL_SCREEN) > 0.1:
            continue
        cu = sum(loop[uv].uv.x for loop in f.loops) / len(f.loops)
        cv = sum(loop[uv].uv.y for loop in f.loops) / len(f.loops)
        for loop in f.loops:
            u, v = loop[uv].uv
            loop[uv].uv = (cu + (u - cu) * factor, cv + (v - cv) * factor)
    bmesh.update_edit_mesh(obj.data)
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.pack_islands(rotate=True, margin=0.004, shape_method='CONCAVE')
    bpy.ops.object.mode_set(mode='OBJECT')


def _pilot_view(objs, path):
    """QA: what the flight camera sees — at the origin, looking along +Y, 70° vertical FOV, 16:9."""
    import preview as PV
    scene = bpy.context.scene
    scene.render.engine = 'BLENDER_EEVEE'
    scene.render.resolution_x, scene.render.resolution_y = 960, 540
    scene.render.film_transparent = False
    scene.view_settings.view_transform = 'AgX'
    lights = PV._rig(scene, '#0b1018')
    data = bpy.data.cameras.new('pilot')
    data.sensor_fit = 'VERTICAL'
    data.angle_y = math.radians(70)
    data.clip_start = 0.05
    cam = C.link(bpy.data.objects.new('pilot', data))
    cam.rotation_euler = (math.radians(90), 0, 0)
    scene.camera = cam
    scene.render.filepath = C.ensure_dir(path)
    bpy.ops.render.render(write_still=True)
    for obj in lights + [cam]:
        bpy.data.objects.remove(obj, do_unlink=True)
    scene.view_settings.view_transform = 'Standard'
    print(f'PREVIEW {path}')


def cockpit(preview=None):
    """Canopy arch and pillars, dashboard with three live screens and lamps —
    one baked material. The view looks along +Y here (three's −Z)."""
    b = C.Builder()
    P = B.part
    # the canopy arch frames the view's edges (48° out at 16:9) and stands on two stub pillars
    b.add(place(torus(1.3, 0.055, n=40, m=8, arc=180), (0, 1.16, -0.3), (90, 0, 0)), color=P(FRAME, wear=0.5), smooth=60)
    b.add(place(torus(1.23, 0.02, n=40, m=6, arc=180), (0, 1.1, -0.3), (90, 0, 0)), color=P(METAL, wear=0.3), smooth=60)
    for side in (-1, 1):
        b.add(place(box(0.12, 0.12, 0.36, 0.02), (1.3 * side, 1.16, -0.46)), color=P(FRAME, B.DECAL_MARK, 0.6))
        b.add(place(box(0.5, 0.9, 0.12, 0.02), (1.05 * side, 0.7, -0.62), (0, -12 * side, 0)), color=P(PANEL, wear=0.5))
        b.add(_on_console(box(0.46, 0.07, 0.012, 0.003), side, (0, -0.4, 0.064)), color=P(METAL, B.DECAL_HAZARD, 0.8))
        for k in range(4):
            b.add(_on_console(box(0.045, 0.045, 0.02, 0.005), side, ((k - 1.5) * 0.09, -0.18, 0.066)), color=P(METAL, B.DECAL_LAMP, 0.3))
        b.add(_on_console(box(0.3, 0.22, 0.01, 0.003), side, (0, 0.15, 0.062)), color=P(TRIM, B.DECAL_MARK, 0.4))
    b.add(place(box(2.3, 0.36, 0.34, 0.03), (0, 1.1, -0.74)), color=P(PANEL, wear=0.6))
    b.add(place(box(2.3, 0.2, 0.08, 0.02), (0, 0.98, -0.55), (-25, 0, 0)), color=P(FRAME, wear=0.5))
    for i, (x, w) in enumerate(SCREENS):
        b.add(place(box(w + 0.04, 0.02, 0.2, 0.008), (x, SCREEN_Y + 0.01, SCREEN_Z - 0.005), (TILT, 0, 0)), color=P(FRAME, wear=0.4))
        b.add(place(box(w, 0.012, 0.16), (x, SCREEN_Y, SCREEN_Z), (TILT, 0, 0)), color=P(SCREEN + i, B.DECAL_SCREEN, 0.0), smooth=None)
    for i in range(6):
        b.add(place(box(0.035, 0.035, 0.012), (-0.3 + i * 0.12, 0.86, -0.58), (-25, 0, 0)), color=P(METAL, B.DECAL_LAMP, 0.2))
    obj = b.object('Cockpit', [C.mat_flat('HullBake', '#ffffff')])

    B.unwrap(obj)
    _boost_screens(obj, 3.0)
    F = B.Fields(obj, 1024, seed=19, edge=0.01)
    p = B.Paint(F)
    p.hull(palette=['#2c323a', '#232830', '#b35a1c', '#6a7078', '#15171a', '#05090d', '#05090d', '#05090d'],
           rough=[0.55, 0.62, 0.5, 0.35, 0.8, 0.12, 0.12, 0.12], metal=[0.45, 0.3, 0.1, 0.9, 0.0, 0.0, 0.0, 0.0],
           seed=19, panel=(0.24, 0.16), wear=0.45, grime=0.4)
    p.hazard(F.decal_is(B.DECAL_HAZARD), period=0.05)
    p.decal(F.decal_is(B.DECAL_MARK) & (F.slot == TRIM) & (np.abs(np.mod(F.P[..., 1] * 40, 1) - 0.5) < 0.18), '#6a7078', rough=0.35, metal=0.9)
    lamps = F.decal_is(B.DECAL_LAMP)
    amber = B.hash01(np.floor(F.P[..., 0] * 12), np.floor(F.P[..., 1] * 12), seed=3) > 0.6
    p.glow(lamps & ~amber, '#6fd6ff')
    p.glow(lamps & amber, '#ffb347')
    _screens(p, F)
    obj.data.materials[0] = p.finish('Cockpit', emissive_strength=1.8, small=1)
    if preview:
        B.save_sheet(p, os.path.join(preview, 'maps_cockpit.png'))
        _pilot_view([obj], os.path.join(preview, 'cockpit_pilot.png'))
    return obj


def crate():
    """Salvage crate, 0.6 m, centred: panels, corner guards, stripes, a status lamp."""
    body = C.mat_vcol('Body', rough=0.6, metal=0.3)
    glow = C.mat_flat('Glow', '#ffffff', emission='#7dff9a', strength=2.0)
    b = C.Builder()
    b.add(box(0.56, 0.56, 0.56, 0.02), color=L('#8a6a3c'))
    for axis in range(3):
        for s in (-1, 1):
            size = [0.44, 0.44, 0.44]
            size[axis] = 0.02
            loc = [0, 0, 0]
            loc[axis] = 0.285 * s
            b.add(place(box(*size), tuple(loc)), color=L('#6e5230'), smooth=None)
    for x in (-1, 1):
        for y in (-1, 1):
            for z in (-1, 1):
                b.add(place(box(0.1, 0.1, 0.1, 0.012), (0.26 * x, 0.26 * y, 0.26 * z)), color=L(0.3))
    for z in (-0.12, 0.12):
        b.add(place(box(0.6, 0.6, 0.05), (0, 0, z)), color=L('#d9a521') if z > 0 else L(0.12), smooth=None)
    b.add(place(box(0.08, 0.02, 0.04), (0.18, -0.296, 0.2)), mat=1)
    return b.object('Crate', [body, glow])


def main():
    opts = C.options()
    made = []
    for name, build in (('station_ring', ring), ('dock', dock), ('cockpit', cockpit), ('crate', crate)):
        if not C.wanted(opts, name):
            continue
        C.reset()
        obj = build(opts['preview']) if build is cockpit else build()
        path = os.path.join(opts['out'], 'models', f'{name}.glb')
        C.export_glb(path, [obj])
        C.report(path, opts['out'])
        if opts['preview']:
            import preview as P
            az, el = (200, 20) if name == 'cockpit' else (35, 30)
            made.append(P.render([obj], os.path.join(opts['preview'], f'station_{name}.png'), azimuth=az, elevation=el))
    if opts['preview'] and made:
        import preview as P
        P.sheet(made, os.path.join(opts['preview'], 'sheet_station.png'), cols=4)


main()
