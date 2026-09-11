# Ships: models/ship.glb (the salvager's tug — menu and station backdrop; its
# hull map keeps the sRGB colour-map check of e2e/asset-spike.spec.ts), and the
# SPEC-020 §4.3 / SPEC-019 §4.1 set — fighter.glb, interceptor.glb, probe.glb.
#
# Flight ships are instanced and tinted at runtime (SPEC-020 §4.3 bakes a GLB
# into instanced geometry), so they carry light vertex colours (`Body`, COLOR_0)
# plus an emissive `Glow` material, no textures. Noses face −Y (glTF +Z, toward
# the player in flight); origins at the centre, the tug's 0.2 m above its skids.
import math
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'lib'))

import numpy as np  # noqa: E402

import common as C  # noqa: E402
import tex as T  # noqa: E402

box, cyl, sphere, ico, place, torus = C.box, C.cyl, C.sphere, C.ico, C.place, C.torus
L = C.lin


def tug():
    """The player's salvage tug: 2.3 m span, 2.0 m long, skids at z −0.2."""
    rgb = T.panels(256, 8, seed=7)
    rgba = np.concatenate([rgb, np.ones((256, 256, 1), np.float32)], 2)
    hull = C.mat_textured('Hull', C.image_from_array('ShipHull', rgba[::-1], 'sRGB'), rough=0.42, metal=0.35)
    glass = C.mat_flat('Glass', '#0b1520', rough=0.06, metal=0.7)
    glow = C.mat_flat('Glow', '#ffffff', emission='#7fe0ff', strength=1.6)
    b = C.Builder(vcol=False)
    H = dict(uv_scale=1.4)
    b.add(place(box(0.62, 1.45, 0.34, 0.08, 2), (0, 0.05, 0.08)), **H)
    b.add(place(box(0.48, 0.55, 0.24, 0.07, 2), (0, -0.82, 0.02), (10, 0, 0)), **H)
    b.add(place(box(0.30, 0.40, 0.12, 0.03), (0, 0.45, 0.30)), **H)
    b.add(place(sphere(0.22, 16, 10), (0, -0.44, 0.27), scale=(1.0, 1.65, 0.68)), mat=1, smooth=80)
    for side in (-1, 1):
        x = 0.52 * side
        b.add(place(cyl(0.17, 0.15, 0.92, n=14, bevel=0.02), (x, 0.33, 0.05), (90, 0, 0)), **H)
        b.add(place(cyl(0.195, 0.2, 0.09, n=14), (x, 0.80, 0.05), (90, 0, 0)), uv_scale=1.4)
        b.add(place(cyl(0.135, 0.135, 0.02, n=14), (x, 0.846, 0.05), (90, 0, 0)), mat=2, smooth=None)
        b.add(place(cyl(0.12, 0.1, 0.1, n=10), (x, -0.16, 0.05), (90, 0, 0)), mat=2)
        b.add(place(box(0.34, 0.34, 0.1, 0.02), (0.34 * side, 0.30, 0.05)), **H)
        b.add(place(box(0.92, 0.56, 0.055, 0.02), (0.74 * side, 0.26, -0.01), (0, 0, -13 * side)), **H)
        b.add(place(box(0.05, 0.22, 0.14, 0.012), (1.14 * side, 0.36, 0.04), (0, 0, -13 * side)), **H)
        b.add(place(sphere(0.025, 8, 6), (1.16 * side, 0.22, 0.05)), mat=2)
        b.add(place(box(0.06, 0.42, 0.06, 0.015), (0.13 * side, -0.93, -0.12), (0, 0, 6 * side)), **H)
        b.add(place(box(0.05, 0.09, 0.12, 0.01), (0.17 * side, -1.12, -0.16), (25, 0, 0)), **H)
        b.add(place(box(0.05, 0.95, 0.04, 0.012), (0.30 * side, 0.08, -0.18)), **H)
        for y in (-0.25, 0.4):
            b.add(place(box(0.04, 0.04, 0.12, 0.008), (0.30 * side, y, -0.11)), **H)
    b.add(place(cyl(0.008, 0.008, 0.2, n=6), (0.1, 0.6, 0.44)), **H)
    b.add(place(sphere(0.02, 8, 6), (0.1, 0.6, 0.545)), mat=2)
    b.add(place(box(0.24, 0.02, 0.03, 0.005), (0, -1.09, 0.06), (10, 0, 0)), mat=2)
    return b.object('SalvageTug', [hull, glass, glow])


def fighter():
    """Scavenger fighter: forward-swept blades with gun prongs; 3.2 m span, 2.6 m long."""
    body = C.mat_vcol('Body', rough=0.55, metal=0.45)
    glow = C.mat_flat('Glow', '#ffffff', emission='#ff8a4a', strength=2.5)
    b = C.Builder()
    b.add(place(sphere(0.46, 14, 10), (0, 0.12, 0), scale=(1.0, 2.0, 0.78)), color=L(0.78), smooth=70)
    b.add(place(box(0.34, 0.5, 0.12, 0.04), (0, -0.55, 0.26), (8, 0, 0)), color=L(0.12))
    b.add(place(sphere(0.07, 8, 6), (0, -0.82, 0.18)), mat=1)
    for side in (-1, 1):
        b.add(place(box(1.25, 0.62, 0.08, 0.03), (0.86 * side, 0.18, 0.0), (0, 0, 22 * side)), color=L(0.62))
        b.add(place(box(0.9, 0.12, 0.09, 0.02), (0.9 * side, 0.42, 0.02), (0, 0, 22 * side)), color=L(0.2))
        b.add(place(box(0.12, 1.0, 0.14, 0.03), (1.46 * side, -0.32, 0.0)), color=L(0.8))
        b.add(place(cyl(0.035, 0.035, 0.35, n=8), (1.46 * side, -0.95, 0.0), (90, 0, 0)), color=L(0.15))
        b.add(place(box(0.05, 0.55, 0.42, 0.015), (0.22 * side, 0.78, 0.3), (-18, 0, 10 * side)), color=L(0.55))
    b.add(place(cyl(0.3, 0.24, 0.5, n=14, bevel=0.02), (0, 1.02, 0), (90, 0, 0)), color=L(0.35))
    b.add(place(cyl(0.2, 0.2, 0.02, n=14), (0, 1.28, 0), (90, 0, 0)), mat=1, smooth=None)
    return b.object('Fighter', [body, glow])


def interceptor():
    """Hive interceptor: segmented chitin dart with mandibles and wing blades; 3.6 m long."""
    body = C.mat_vcol('Body', rough=0.38, metal=0.2)
    glow = C.mat_flat('Glow', '#ffffff', emission='#d66bff', strength=2.5)
    b = C.Builder()
    for i, (y, r, sy) in enumerate(((-0.75, 0.42, 1.2), (0.25, 0.5, 1.15), (1.15, 0.36, 1.1))):
        seg = place(ico(r, 2), (0, y, 0), scale=(1.0, sy, 0.85))
        C.displace(seg, lambda co, i=i: 0.035 * math.sin(co.y * 22 + i) * math.cos(co.x * 17))
        b.add(seg, color=L(0.82 if i != 1 else 0.7), smooth=50)
        b.add(place(torus(r * 0.93, 0.035, n=18, m=5), (0, y + 0.45 * sy * r, 0), (90, 0, 0), (1.0, 1.0, 0.85)), color=L(0.3))
    for side in (-1, 1):
        prong = C.along(cyl(0.07, 0.015, 0.9, n=8), (0.18 * side, -1.05, 0.0), (0.06 * side, -1.85, -0.08))
        b.add(prong, color=L(0.9))
        for k, (y, rz, ry) in enumerate(((0.05, 35, 12), (0.45, 62, 20))):
            wing = place(box(1.3, 0.34, 0.025, 0.01), (0.72 * side, y, 0.2 + 0.08 * k), (0, ry * side, rz * side * 0.3))
            b.add(wing, color=L(0.66), smooth=None)
            vein = place(box(1.1, 0.03, 0.03, 0.005), (0.7 * side, y, 0.22 + 0.08 * k), (0, ry * side, rz * side * 0.3))
            b.add(vein, mat=1)
    b.add(C.along(cyl(0.12, 0.02, 0.6, n=8), (0, 1.55, 0.05), (0, 2.05, 0.2)), color=L(0.75))
    b.add(place(sphere(0.07, 10, 8), (0, 2.08, 0.21)), mat=1)
    for side in (-1, 1):
        b.add(place(sphere(0.07, 10, 8), (0.2 * side, -1.1, 0.14)), mat=1)
    return b.object('Interceptor', [body, glow])


def probe():
    """The escort science probe (SPEC-019 §4.1): a 1 m hovering sensor drone, eye toward −Y."""
    body = C.mat_vcol('Body', rough=0.4, metal=0.55)
    glow = C.mat_flat('Glow', '#ffffff', emission='#6fe8ff', strength=2.0)
    b = C.Builder()
    b.add(sphere(0.32, 20, 14), color=L(0.86), smooth=80)
    b.add(place(torus(0.42, 0.045, n=28, m=8), (0, 0, 0)), color=L(0.35), smooth=60)
    for a in range(3):
        ang = math.radians(90 + 120 * a)
        b.add(place(box(0.14, 0.05, 0.05, 0.01), (0.37 * math.cos(ang), 0.37 * math.sin(ang), 0), (0, 0, math.degrees(ang))), color=L(0.35))
    b.add(place(cyl(0.14, 0.15, 0.08, n=18), (0, -0.29, 0.02), (90, 0, 0)), color=L(0.2))
    b.add(place(sphere(0.1, 14, 10), (0, -0.33, 0.02), scale=(1, 0.6, 1)), mat=1, smooth=80)
    for side in (-1, 1):
        b.add(place(cyl(0.07, 0.09, 0.12, n=12), (0.5 * side, 0.02, -0.02), (0, 90, 0)), color=L(0.5))
        b.add(place(cyl(0.055, 0.055, 0.01, n=12), (0.565 * side, 0.02, -0.02), (0, 90, 0)), mat=1, smooth=None)
    b.add(place(cyl(0.01, 0.01, 0.34, n=6), (0.08, 0.12, 0.45)), color=L(0.3))
    b.add(place(sphere(0.025, 8, 6), (0.08, 0.12, 0.63)), mat=1)
    b.add(place(sphere(0.12, 12, 8), (0, 0.2, 0.26), scale=(1.0, 1.0, 0.35)), color=L(0.6), smooth=60)
    b.add(place(cyl(0.06, 0.02, 0.18, n=10), (0, 0, -0.38)), color=L(0.3))
    b.add(place(cyl(0.035, 0.035, 0.01, n=10), (0, 0, -0.47)), mat=1, smooth=None)
    return b.object('Probe', [body, glow])


def main():
    opts = C.options()
    made = []
    for name, build in (('ship', tug), ('fighter', fighter), ('interceptor', interceptor), ('probe', probe)):
        if not C.wanted(opts, name):
            continue
        C.reset()
        obj = build()
        path = os.path.join(opts['out'], 'models', f'{name}.glb')
        C.export_glb(path, [obj])
        C.report(path, opts['out'])
        if opts['preview']:
            import preview as P
            made.append(P.render([obj], os.path.join(opts['preview'], f'ship_{name}.png'), azimuth=35, elevation=24))
            made.append(P.render([obj], os.path.join(opts['preview'], f'ship_{name}_top.png'), azimuth=160, elevation=50))
    if opts['preview'] and made:
        import preview as P
        P.sheet(made, os.path.join(opts['preview'], 'sheet_ships.png'), cols=4)


main()
