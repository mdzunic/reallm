# Hub and flight furniture (SPEC-020 §4.3–§4.4): models/station_ring.glb (the
# rotating ring over the station backdrop, lying flat — the scene tilts it),
# dock.glb (the landing pad, centred like the pad it replaces), cockpit.glb
# (camera space: the pilot looks along +Y here, three's −Z), and crate.glb (the
# boot-manifest crate, a 0.6 m cube centred on the origin, as before).
import math
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'lib'))

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


def cockpit():
    """Canopy arch, side struts, dashboard with screens — the view looks along +Y."""
    body = C.mat_vcol('Body', rough=0.75, metal=0.35)
    glow = C.mat_flat('Glow', '#ffffff', emission='#6fd6ff', strength=1.8)
    warm = C.mat_flat('Warm', '#ffffff', emission='#ffb347', strength=1.8)
    b = C.Builder()
    arch = place(torus(1.18, 0.05, n=24, m=6, arc=180), (0, 1.16, -0.25), (90, 0, 0))
    b.add(arch, color=L(0.14), smooth=60)
    for side in (-1, 1):
        b.add(place(box(0.1, 0.07, 1.45, 0.015), (0.86 * side, 1.12, 0.02), (0, 20 * side, 0)), color=L(0.18))
        b.add(place(box(0.5, 0.9, 0.12, 0.02), (1.05 * side, 0.7, -0.62), (0, -12 * side, 0)), color=L(0.2))
    b.add(place(box(2.3, 0.36, 0.34, 0.03), (0, 1.1, -0.74)), color=L(0.16))
    b.add(place(box(2.3, 0.2, 0.08, 0.02), (0, 0.98, -0.55), (-25, 0, 0)), color=L(0.24))
    for x, w in ((-0.62, 0.34), (0.0, 0.46), (0.62, 0.34)):
        b.add(place(box(w, 0.012, 0.16), (x, 0.93, -0.48), (-25, 0, 0)), mat=1)
    for i in range(6):
        b.add(place(box(0.035, 0.035, 0.012), (-0.3 + i * 0.12, 0.86, -0.58), (-25, 0, 0)), mat=2 if i % 2 else 1)
    b.add(place(box(1.9, 0.08, 0.06, 0.015), (0, 1.14, 0.93)), color=L(0.14))
    return b.object('Cockpit', [body, glow, warm])


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
        obj = build()
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
