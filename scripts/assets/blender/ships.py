# Ships: models/ship.glb (the salvager's tug — menu and station backdrop; its
# hull map keeps the sRGB colour-map check of e2e/asset-spike.spec.ts), and the
# SPEC-020 §4.3 / SPEC-019 §4.1 set — fighter.glb, interceptor.glb, probe.glb.
#
# Every ship carries one baked `Hull` material (PLAN R8, lib/bake.py): base
# colour, ORM, normal and emissive maps painted from Cycles-baked fields —
# panel seams, rivets, worn edges, grime, markings — plus the flat `Glow`
# material for engines and lamps. The flight scene instances the two
# materials as they are. Noses face −Y (glTF +Z, toward the player in flight);
# origins at the centre, the tug's 0.2 m above its skids.
import math
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'lib'))

import numpy as np  # noqa: E402

import bake as B  # noqa: E402
import common as C  # noqa: E402
import nodes as N  # noqa: E402
import tex as T  # noqa: E402

box, cyl, sphere, ico, place, torus = C.box, C.cyl, C.sphere, C.ico, C.place, C.torus
P = B.part


def _bake_slot():
    return C.mat_flat('HullBake', '#ffffff')


def _sheet(paint, preview, name):
    if preview:
        B.save_sheet(paint, os.path.join(preview, f'maps_{name}.png'))


# ------------------------------------------------------------------- the tug

HULL, GUNMETAL, ORANGE, STEEL, RUBBER, GLASS = range(6)


def tug(preview=None):
    """The player's salvage tug: 2.3 m span, 2.0 m long, skids at z −0.2."""
    glow = C.mat_flat('Glow', '#ffffff', emission='#7fe0ff', strength=1.6)
    b = C.Builder()
    b.add(place(box(0.62, 1.45, 0.34, 0.08, 2), (0, 0.05, 0.08)), color=P(HULL, B.DECAL_MARK, 0.45))
    b.add(place(box(0.48, 0.55, 0.24, 0.07, 2), (0, -0.82, 0.02), (10, 0, 0)), color=P(HULL, B.DECAL_MARK, 0.8))
    b.add(place(box(0.30, 0.40, 0.12, 0.03), (0, 0.45, 0.30)), color=P(GUNMETAL, wear=0.4))
    for y in (0.34, 0.45, 0.56):
        b.add(place(box(0.24, 0.035, 0.02, 0.006), (0, y, 0.365)), color=P(STEEL, wear=0.3))
    b.add(place(sphere(0.22, 20, 12), (0, -0.44, 0.27), scale=(1.0, 1.65, 0.68)), color=P(GLASS), smooth=80)
    b.add(place(torus(0.2, 0.018, n=24, m=5), (0, -0.44, 0.255), scale=(1.1, 1.75, 1.0)), color=P(GUNMETAL, wear=0.7))
    for side in (-1, 1):
        x = 0.52 * side
        b.add(place(cyl(0.17, 0.15, 0.92, n=16, bevel=0.02), (x, 0.33, 0.05), (90, 0, 0)), color=P(GUNMETAL, wear=0.6))
        b.add(place(cyl(0.195, 0.2, 0.09, n=16), (x, 0.80, 0.05), (90, 0, 0)), color=P(STEEL, wear=0.9))
        b.add(place(cyl(0.135, 0.135, 0.02, n=16), (x, 0.846, 0.05), (90, 0, 0)), mat=1, smooth=None)
        b.add(place(cyl(0.12, 0.1, 0.1, n=12), (x, -0.16, 0.05), (90, 0, 0)), mat=1)
        b.add(place(torus(0.125, 0.018, n=16, m=5), (x, -0.19, 0.05), (90, 0, 0)), color=P(STEEL, wear=0.8))
        for k in range(3):
            b.add(place(box(0.02, 0.1, 0.05, 0.005), (x + 0.17 * side, 0.48 + 0.12 * k, 0.05)), color=P(STEEL, wear=0.5))
        b.add(place(box(0.34, 0.34, 0.1, 0.02), (0.34 * side, 0.30, 0.05)), color=P(GUNMETAL, wear=0.5))
        b.add(place(box(0.92, 0.56, 0.055, 0.02), (0.74 * side, 0.26, -0.01), (0, 0, -13 * side)), color=P(HULL, B.DECAL_MARK, 0.55))
        b.add(place(box(0.05, 0.22, 0.14, 0.012), (1.14 * side, 0.36, 0.04), (0, 0, -13 * side)), color=P(ORANGE, B.DECAL_HAZARD, 0.8))
        b.add(place(sphere(0.025, 8, 6), (1.16 * side, 0.22, 0.05)), mat=1)
        b.add(place(box(0.06, 0.42, 0.06, 0.015), (0.13 * side, -0.93, -0.12), (0, 0, 6 * side)), color=P(STEEL, B.DECAL_HAZARD, 0.9))
        b.add(place(box(0.05, 0.09, 0.12, 0.01), (0.17 * side, -1.12, -0.16), (25, 0, 0)), color=P(STEEL, B.DECAL_HAZARD, 1.0))
        b.add(place(box(0.05, 0.95, 0.04, 0.012), (0.30 * side, 0.08, -0.18)), color=P(RUBBER, wear=0.9))
        for y in (-0.25, 0.4):
            b.add(place(box(0.04, 0.04, 0.12, 0.008), (0.30 * side, y, -0.11)), color=P(STEEL, wear=0.7))
        for k in range(3):
            b.add(place(box(0.012, 0.05, 0.025, 0.004), (0.315 * side, -0.25 + 0.14 * k, 0.12)), color=P(STEEL, B.DECAL_LAMP, 0.2))
    b.add(place(cyl(0.008, 0.008, 0.2, n=6), (0.1, 0.6, 0.44)), color=P(STEEL, wear=0.3))
    b.add(place(sphere(0.02, 8, 6), (0.1, 0.6, 0.545)), mat=1)
    b.add(place(box(0.24, 0.02, 0.03, 0.005), (0, -1.09, 0.06), (10, 0, 0)), mat=1)
    obj = b.object('SalvageTug', [_bake_slot(), glow])

    B.unwrap(obj)
    F = B.Fields(obj, 1024, seed=7)
    p = B.Paint(F)
    p.hull(palette=['#d8d2c4', '#3b4148', '#d4621c', '#7d8288', '#1e2024', '#0b1a26'],
           rough=[0.5, 0.45, 0.5, 0.34, 0.8, 0.05], metal=[0.08, 0.35, 0.08, 0.9, 0.0, 0.2],
           seed=7, panel=(0.26, 0.17), wear=0.6, grime=0.55)
    pos, nrm = F.P, F.N
    hull = F.slot == HULL
    # orange racing stripes along the spine, a hazard band across the nose face
    for sx in (-0.19, 0.19):
        p.decal(hull & (nrm[..., 2] > 0.7) & (np.abs(pos[..., 0] - sx) < 0.028) & (np.abs(pos[..., 1] + 0.02) < 0.62), '#d4621c')
    p.hazard(hull & (nrm[..., 1] < -0.7) & (pos[..., 1] < -1.0))
    p.hazard(F.decal_is(B.DECAL_HAZARD) & (F.slot != ORANGE))
    p.hazard(F.decal_is(B.DECAL_HAZARD) & (F.slot == ORANGE) & (nrm[..., 2] > 0.5), period=0.05)
    # an orange band round each nacelle, soot at the exhausts
    nac = (np.hypot(np.abs(pos[..., 0]) - 0.52, pos[..., 2] - 0.05) < 0.21) & (F.slot == GUNMETAL)
    p.decal(nac & (np.abs(pos[..., 1] - 0.02) < 0.06), '#d4621c')
    for side in (-1, 1):
        p.soot((0.52 * side, 0.9, 0.05), 0.42)
        # registration on the wing tops, upright to a viewer ahead of the nose
        ang = math.radians(-13 * side)
        right = np.array((math.cos(ang), math.sin(ang), 0.0))
        up = np.array((-math.sin(ang), math.cos(ang), 0.0))
        width, tall = 29 * 0.1 / 7, 0.1
        origin = np.array((0.74 * side, 0.26, 0.0175)) - right * width / 2 + up * tall / 2
        p.decal(B.text(F, 'RL-07', origin, right, up, tall, axis=2, sign=1) * hull, '#1d2126', rough=0.4)
    p.glow(F.decal_is(B.DECAL_LAMP), '#7fe0ff')
    p.glass(F.slot == GLASS, (0, -0.44, 0.27))
    obj.data.materials[0] = p.finish('Hull', emissive_strength=1.6)
    _sheet(p, preview, 'ship')
    return obj


# ---------------------------------------------------------------- the fighter

RUST, OLIVE, SOOT, GUNSTEEL, RED, VISOR = range(6)


def fighter(preview=None):
    """Scavenger fighter: forward-swept blades with gun prongs; 3.2 m span, 2.6 m
    long. Rust and olive plating, patched panels, red war paint, heavy wear."""
    glow = C.mat_flat('Glow', '#ffffff', emission='#ff8a4a', strength=2.5)
    b = C.Builder()
    b.add(place(sphere(0.46, 18, 12), (0, 0.12, 0), scale=(1.0, 2.0, 0.78)), color=P(RUST, B.DECAL_MARK, 0.8), smooth=70)
    b.add(place(box(0.34, 0.5, 0.12, 0.04), (0, -0.55, 0.26), (8, 0, 0)), color=P(VISOR))
    b.add(place(sphere(0.07, 8, 6), (0, -0.82, 0.18)), mat=1)
    for side in (-1, 1):
        b.add(place(box(1.25, 0.62, 0.08, 0.03), (0.86 * side, 0.18, 0.0), (0, 0, 22 * side)), color=P(OLIVE, B.DECAL_MARK, 0.85))
        b.add(place(box(0.9, 0.12, 0.09, 0.02), (0.9 * side, 0.42, 0.02), (0, 0, 22 * side)), color=P(SOOT, wear=0.6))
        b.add(place(box(0.12, 1.0, 0.14, 0.03), (1.46 * side, -0.32, 0.0)), color=P(GUNSTEEL, B.DECAL_HAZARD, 1.0))
        b.add(place(cyl(0.035, 0.035, 0.35, n=8), (1.46 * side, -0.95, 0.0), (90, 0, 0)), color=P(SOOT, wear=0.9))
        b.add(place(box(0.05, 0.55, 0.42, 0.015), (0.22 * side, 0.78, 0.3), (-18, 0, 10 * side)), color=P(RUST, B.DECAL_MARK, 0.9))
    b.add(place(cyl(0.3, 0.24, 0.5, n=16, bevel=0.02), (0, 1.02, 0), (90, 0, 0)), color=P(GUNSTEEL, wear=1.0))
    b.add(place(cyl(0.2, 0.2, 0.02, n=16), (0, 1.28, 0), (90, 0, 0)), mat=1, smooth=None)
    obj = b.object('Fighter', [_bake_slot(), glow])

    B.unwrap(obj)
    F = B.Fields(obj, 512, seed=11, edge=0.015)
    p = B.Paint(F)
    pn = p.hull(palette=['#8e4a26', '#5f5d52', '#252321', '#6f7276', '#8f2418', '#140c08'],
                rough=[0.6, 0.62, 0.7, 0.4, 0.55, 0.05], metal=[0.25, 0.2, 0.1, 0.85, 0.1, 0.2],
                seed=11, panel=(0.32, 0.22), tone=0.1, seam_dark=0.4, wear=0.85, grime=0.85)
    pos = F.P
    # scavenged patches: a few panels in the other plating colour
    patch = pn['tone'] > 0.86
    p.decal(patch & (F.slot == RUST), '#5f5d52')
    p.decal(patch & (F.slot == OLIVE), '#8e4a26')
    # red war paint: bands across the wing tops, the fin tops
    ax = np.abs(pos[..., 0])
    wing = (F.slot == OLIVE) & (np.abs(F.N[..., 2]) > 0.7) & (ax > 0.55)
    p.decal(wing & (np.mod(ax - 0.55, 0.42) < 0.12), '#8f2418')
    p.decal((F.slot == RUST) & (ax > 0.15) & (pos[..., 1] > 0.5) & (pos[..., 2] > 0.36), '#8f2418')
    p.hazard(F.decal_is(B.DECAL_HAZARD), period=0.06)
    p.soot((0, 1.3, 0), 0.55, strength=0.9)
    for side in (-1, 1):
        p.soot((1.46 * side, -1.1, 0), 0.3)
    p.glass(F.slot == VISOR, (0, -0.55, 0.26), tint='#1a0e08', sky='#ff9a5a', level=0.35)
    obj.data.materials[0] = p.finish('Hull', emissive_strength=2.0)
    _sheet(p, preview, 'fighter')
    return obj


# ------------------------------------------------------------ the interceptor

CHITIN, MEMBRANE, BONE = range(3)


def interceptor(preview=None):
    """Hive interceptor: segmented chitin dart with mandibles and wing blades;
    3.6 m long. Voronoi plates with glowing veins, glossy, no rivets."""
    glow = C.mat_flat('Glow', '#ffffff', emission='#d66bff', strength=2.5)
    b = C.Builder()
    for i, (y, r, sy) in enumerate(((-0.75, 0.42, 1.2), (0.25, 0.5, 1.15), (1.15, 0.36, 1.1))):
        seg = place(ico(r, 3), (0, y, 0), scale=(1.0, sy, 0.85))
        C.displace(seg, lambda co, i=i: 0.035 * math.sin(co.y * 22 + i) * math.cos(co.x * 17))
        b.add(seg, color=P(CHITIN, wear=0.3), smooth=50)
        b.add(place(torus(r * 0.93, 0.035, n=18, m=5), (0, y + 0.45 * sy * r, 0), (90, 0, 0), (1.0, 1.0, 0.85)), color=P(BONE, wear=0.4))
    for side in (-1, 1):
        prong = C.along(cyl(0.07, 0.015, 0.9, n=8), (0.18 * side, -1.05, 0.0), (0.06 * side, -1.85, -0.08))
        b.add(prong, color=P(BONE, wear=0.6))
        for k, (y, rz, ry) in enumerate(((0.05, 35, 12), (0.45, 62, 20))):
            wing = place(box(1.3, 0.34, 0.025, 0.01), (0.72 * side, y, 0.2 + 0.08 * k), (0, ry * side, rz * side * 0.3))
            b.add(wing, color=P(MEMBRANE, wear=0.2), smooth=None)
            vein = place(box(1.1, 0.03, 0.03, 0.005), (0.7 * side, y, 0.22 + 0.08 * k), (0, ry * side, rz * side * 0.3))
            b.add(vein, mat=1)
    b.add(C.along(cyl(0.12, 0.02, 0.6, n=8), (0, 1.55, 0.05), (0, 2.05, 0.2)), color=P(BONE, wear=0.5))
    b.add(place(sphere(0.07, 10, 8), (0, 2.08, 0.21)), mat=1)
    for side in (-1, 1):
        b.add(place(sphere(0.07, 10, 8), (0.2 * side, -1.1, 0.14)), mat=1)
    obj = b.object('Interceptor', [_bake_slot(), glow])

    B.unwrap(obj)
    F = B.Fields(obj, 512, seed=23)

    def plates(g):
        p = g.coords('Object')
        return (g.voronoi(p, 5.5, 23, feature='DISTANCE_TO_EDGE'), g.channel(g.voronoi(p, 5.5, 23, out='Color'), 'Red'),
                g.voronoi(p, 14.0, 29, feature='DISTANCE_TO_EDGE'))

    vor = N.bake_emit(obj, plates, 512, samples=4, name='plates')
    edge, cell, fine = vor[..., 0], vor[..., 1], vor[..., 2]
    p = B.Paint(F)
    chitin, membrane, bone = F.slot == CHITIN, F.slot == MEMBRANE, F.slot == BONE
    plate = T.smoothstep(0.0, 0.06, edge)
    shell = B.mix(B.col('#1f1429'), B.col('#583a74'), 0.25 + 0.5 * cell + 0.25 * F.n1) * (0.5 + 0.5 * plate)[..., None]
    shell = B.mix(shell, B.col('#2f6a70'), T.smoothstep(0.55, 0.9, F.n3) * 0.3 * plate)
    web = T.smoothstep(0.0, 0.04, fine)
    wingc = B.mix(B.col('#3d2656'), B.col('#8a62b4'), 0.4 + 0.4 * F.n1) * (0.55 + 0.45 * web)[..., None]
    bonec = B.mix(B.col('#bfb294'), B.col('#6e6452'), np.clip((1 - F.crevice) * 1.5 + 0.3 * F.n2, 0, 1))
    p.base = np.where(chitin[..., None], shell, np.where(membrane[..., None], wingc, bonec))
    p.rough = np.where(chitin, 0.26 + 0.3 * (1 - plate), np.where(membrane, 0.42, 0.55)).astype(np.float32)
    p.metal = np.where(chitin, 0.25, 0.05).astype(np.float32)
    p.height = np.where(chitin, 0.004 * plate - 0.002, np.where(membrane, 0.0015 * web, 0.0003 * F.n2)).astype(np.float32)
    vein = (1 - T.smoothstep(0.0, 0.014, edge)) * T.smoothstep(0.42, 0.58, F.n1) * chitin
    p.glow(vein, '#d66bff', 0.9)
    p.glow((1 - T.smoothstep(0.0, 0.01, fine)) * membrane * 0.35, '#d66bff', 0.6)
    obj.data.materials[0] = p.finish('Hull', emissive_strength=2.0)
    _sheet(p, preview, 'interceptor')
    return obj


# ------------------------------------------------------------------ the probe

WHITE, DARK, BLUE, PROBESTEEL = range(4)


def probe(preview=None):
    """The escort science probe (SPEC-019 §4.1): a 1 m hovering sensor drone,
    eye toward −Y. Clean white shell with blue survey stripes."""
    glow = C.mat_flat('Glow', '#ffffff', emission='#6fe8ff', strength=2.0)
    b = C.Builder()
    b.add(sphere(0.32, 24, 16), color=P(WHITE, B.DECAL_MARK, 0.3), smooth=80)
    b.add(place(torus(0.42, 0.045, n=32, m=8), (0, 0, 0)), color=P(DARK, wear=0.5), smooth=60)
    for a in range(3):
        ang = math.radians(90 + 120 * a)
        b.add(place(box(0.14, 0.05, 0.05, 0.01), (0.37 * math.cos(ang), 0.37 * math.sin(ang), 0), (0, 0, math.degrees(ang))),
              color=P(PROBESTEEL, wear=0.6))
    b.add(place(cyl(0.14, 0.15, 0.08, n=18), (0, -0.29, 0.02), (90, 0, 0)), color=P(DARK, wear=0.4))
    b.add(place(sphere(0.1, 14, 10), (0, -0.33, 0.02), scale=(1, 0.6, 1)), mat=1, smooth=80)
    for side in (-1, 1):
        b.add(place(cyl(0.07, 0.09, 0.12, n=12), (0.5 * side, 0.02, -0.02), (0, 90, 0)), color=P(BLUE, wear=0.4))
        b.add(place(cyl(0.055, 0.055, 0.01, n=12), (0.565 * side, 0.02, -0.02), (0, 90, 0)), mat=1, smooth=None)
    b.add(place(cyl(0.01, 0.01, 0.34, n=6), (0.08, 0.12, 0.45)), color=P(PROBESTEEL, wear=0.3))
    b.add(place(sphere(0.025, 8, 6), (0.08, 0.12, 0.63)), mat=1)
    b.add(place(sphere(0.12, 14, 10), (0, 0.2, 0.26), scale=(1.0, 1.0, 0.35)), color=P(BLUE, wear=0.3), smooth=60)
    b.add(place(cyl(0.06, 0.02, 0.18, n=10), (0, 0, -0.38)), color=P(DARK, wear=0.5))
    b.add(place(cyl(0.035, 0.035, 0.01, n=10), (0, 0, -0.47)), mat=1, smooth=None)
    obj = b.object('Probe', [_bake_slot(), glow])

    B.unwrap(obj)
    F = B.Fields(obj, 512, seed=31, edge=0.01)
    p = B.Paint(F)
    p.hull(palette=['#e3e5e8', '#30353c', '#2f6fd0', '#80858c'], rough=[0.36, 0.5, 0.4, 0.3],
           metal=[0.05, 0.3, 0.1, 0.9], seed=31, panel=(0.24, 0.18), tone=0.03, seam_dark=0.25, rivets=False,
           wear=0.35, grime=0.35)
    pos = F.P
    white = F.slot == WHITE
    p.decal(white & (np.abs(pos[..., 2]) < 0.035), '#2f6fd0')
    p.decal(white & (np.abs(pos[..., 2] - 0.2) < 0.012), '#2f6fd0')
    obj.data.materials[0] = p.finish('Hull', emissive_strength=2.0)
    _sheet(p, preview, 'probe')
    return obj


def main():
    opts = C.options()
    made = []
    for name, build in (('ship', tug), ('fighter', fighter), ('interceptor', interceptor), ('probe', probe)):
        if not C.wanted(opts, name):
            continue
        C.reset()
        obj = build(opts['preview'])
        path = os.path.join(opts['out'], 'models', f'{name}.glb')
        C.export_glb(path, [obj])
        C.report(path, opts['out'])
        if opts['preview']:
            import preview as PV
            for tag, az, el in (('', 35, 24), ('_top', 160, 50), ('_front', -20, 55)):
                made.append(PV.render([obj], os.path.join(opts['preview'], f'ship_{name}{tag}.png'), azimuth=az, elevation=el))
    if opts['preview'] and made:
        import preview as PV
        PV.sheet(made, os.path.join(opts['preview'], 'sheet_ships.png'), cols=3)


main()
