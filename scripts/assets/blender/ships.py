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

import bmesh  # noqa: E402
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
# SPEC-072: CR-62 rebuilt as an armoured salvage gunship inside the old tug's
# bounding box — an angular keel under three bands of dorsal armour, a
# slit-windowed armoured cockpit, a dorsal twin turret, the missile rack's two
# pods (SPEC-070), recessed engine bells, a folded grapple boom, and detail
# small enough to give it scale. Starboard is −X (the pilot looks along −Y).

HULL, GUNMETAL, ORANGE, STEEL, RUBBER, GLASS, CAP = range(7)

# the keel's stations, nose last: y, half-width, bottom, top, bottom chamfer, top chamfer
KEEL = ((0.80, 0.27, -0.04, 0.21, 0.07, 0.04),
        (0.56, 0.33, -0.10, 0.24, 0.08, 0.05),
        (-0.40, 0.33, -0.10, 0.24, 0.08, 0.05),
        (-0.82, 0.24, -0.06, 0.16, 0.07, 0.04),
        (-1.10, 0.12, 0.00, 0.075, 0.035, 0.02))
# the cockpit's stations: y, then _hexa's bottom, flank and roof widths and heights
COCKPIT = ((-0.26, (0.22, 0.20, 0.215, 0.32, 0.145, 0.372)),
           (-0.50, (0.22, 0.20, 0.215, 0.32, 0.145, 0.372)),
           (-0.71, (0.205, 0.14, 0.195, 0.235, 0.125, 0.262)),
           (-0.79, (0.19, 0.12, 0.18, 0.19, 0.11, 0.205)))
NACELLE_X, NACELLE_Z = 0.30, 0.08     # the two engines (each side); the centre one is on x 0
NACELLE = ((0.05, 0.075), (0.15, 0.125), (0.68, 0.135), (0.74, 0.128))   # y, octagon radius
OCTAGON = [(math.cos(math.radians(22.5 + 45 * k)), math.sin(math.radians(22.5 + 45 * k))) for k in range(8)]  # flat on top
CENTRE_Z = 0.06
TURRET_Y = -0.08
WING_Z = 0.03
WING_ROOT, WING_TIP = 0.30, 1.14      # x of the stub's root and tip ribs
SWEEP = math.radians(15)
FACET = 10.0                          # the big lofts' sharp angle: every facet stays a facet


def _loft(rings, bevel=0.0, angle=25.0):
    """A capped solid bridged through closed rings of points (the same count,
    walked the same way round). Edges sharper than `angle`° get `bevel`, so
    the bake catches them and the flats stay flat."""
    bm = bmesh.new()
    vs = [[bm.verts.new(p) for p in ring] for ring in rings]
    n = len(vs[0])
    for a, b in zip(vs, vs[1:]):
        for k in range(n):
            bm.faces.new((a[k], a[(k + 1) % n], b[(k + 1) % n], b[k]))
    bm.faces.new(vs[0])
    bm.faces.new(vs[-1][::-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    if bevel > 0:
        bm.normal_update()
        limit = math.radians(angle)
        sharp = [e for e in bm.edges if len(e.link_faces) == 2 and e.calc_face_angle(0.0) > limit]
        bmesh.ops.bevel(bm, geom=sharp, offset=bevel, segments=1, profile=0.5, affect='EDGES', clamp_overlap=True)
    return bm


def _along_y(stations, x0=0.0, side=1):
    """_loft rings from [(y, [(x, z), …]), …], mirrored to −X for side −1."""
    return [[(x0 + x * side, y, z) for x, z in pts] for y, pts in stations]


def _octagon(hw, zb, zt, cb, ct):
    """The keel's section (x, z): a chamfered underside (cb) and top (ct)."""
    return [(-hw + cb, zb), (hw - cb, zb), (hw, zb + cb), (hw, zt - ct), (hw - ct, zt), (-hw + ct, zt),
            (-hw, zt - ct), (-hw, zb + cb)]


def _hexa(hb, zb, hs, zs, ht, zt):
    """A faceted section (x, z): flat bottom ±hb at zb, flanks to ±hs at zs,
    a chamfer to the flat roof ±ht at zt."""
    return [(-hb, zb), (hb, zb), (hs, zs), (ht, zt), (-ht, zt), (-hs, zs)]


def _plate(hw, z0, z1, ch):
    """An armour plate's section (x, z): a chamfered top edge of `ch`."""
    return [(-hw, z0), (hw, z0), (hw, z1 - ch * 0.5), (hw - ch, z1), (-hw + ch, z1), (-hw, z1 - ch * 0.5)]


def _keel_at(y):
    """The keel's (half-width, bottom, top, bottom chamfer, top chamfer) at y."""
    if y >= KEEL[0][0]:
        return KEEL[0][1:]
    for a, b in zip(KEEL, KEEL[1:]):
        if b[0] <= y <= a[0]:
            t = (a[0] - y) / (a[0] - b[0])
            return tuple(a[k] + (b[k] - a[k]) * t for k in range(1, 6))
    return KEEL[-1][1:]


def _ring(profile, n=16, spin=0.0):
    """A closed lathe profile [(r, t), …] turned round +Y (t along +Y from 0)."""
    return place(C.lathe(profile + [profile[0]], n=n), rot=(0, 0, spin))


def _disc(radius, n=12):
    """One flat n-gon facing +Z — a glow disc that spends no faces on sides nobody sees."""
    bm = bmesh.new()
    bm.faces.new([bm.verts.new((radius * math.cos(2 * math.pi * k / n), radius * math.sin(2 * math.pi * k / n), 0.0))
                  for k in range(n)])
    return bm


def _on_y(bm, loc):
    """Stand a part built round +Z on the +Y axis, then move it to `loc`."""
    return place(bm, loc, (-90, 0, 0))


def _inside(stations, x, y, z, margin):
    """Is (x, y, z) deeper than `margin` inside the convex loft through
    [(y, [(x, z), …]), …]?"""
    for (y0, a), (y1, b) in zip(stations, stations[1:]):
        if min(y0, y1) < y < max(y0, y1):
            t = (y - y0) / (y1 - y0)
            pts = [(pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t) for pa, pb in zip(a, b)]
            break
    else:
        return False
    sign = 0
    for (x0, z0), (x1, z1) in zip(pts, pts[1:] + pts[:1]):
        ex, ez = x1 - x0, z1 - z0
        d = (ex * (z - z0) - ez * (x - x0)) / (math.hypot(ex, ez) or 1.0)
        if abs(d) < margin or (sign and (d > 0) != (sign > 0)):
            return False
        sign = sign or (1 if d > 0 else -1)
    return True


def _solids():
    """The tug's big convex volumes — keel, cockpit, a nacelle (|x|) — whose
    insides nobody sees."""
    return ([(y, _octagon(*k)) for y, *k in KEEL],
            [(y, _hexa(*h)) for y, h in COCKPIT],
            [(y, [(NACELLE_X + r * c, NACELLE_Z + r * s) for c, s in OCTAGON]) for y, r in NACELLE])


def _bury(bm, solids, margin=0.003):
    """Drop the faces of a part that lie wholly inside the tug's big volumes:
    they cost triangles and atlas space and are never seen."""
    dead = [f for f in bm.faces
            if any(all(_inside(s, abs(v.co.x), v.co.y, v.co.z, margin) for v in f.verts) for s in solids)]
    if dead:
        bmesh.ops.delete(bm, geom=dead, context='FACES')
    return bm


def tug(preview=None):
    """The player's salvage tug CR-62 (SPEC-072 §2): 2.4 m span, 2.0 m long,
    skids at z −0.2, nose toward −Y."""
    glow = C.mat_flat('Glow', '#ffffff', emission='#7fe0ff', strength=1.6)
    b = C.Builder()
    solids = _solids()

    def add(part, **kw):
        b.add(_bury(part, solids), **kw)

    # --- the keel: a long armoured wedge with a chamfered underside
    b.add(_loft(_along_y([(y, _octagon(*k)) for y, *k in KEEL]), bevel=0.016), color=P(HULL, B.DECAL_MARK, 0.5), smooth=FACET)
    # the prow plate ahead of the cockpit, and three dorsal bands, each a few mm proud of the one ahead
    prow = []
    for y in (-0.80, -1.075):
        hw, _, zt, _, ct = _keel_at(y)
        prow.append((y, _plate(hw - ct - 0.012, zt - 0.012, zt + 0.011, 0.014)))
    add(_loft(_along_y(prow), bevel=0.006), color=P(HULL, B.DECAL_MARK, 0.7), smooth=FACET)
    for y0, y1, lift, slot in ((-0.30, 0.06, 0.012, HULL), (0.02, 0.44, 0.021, GUNMETAL), (0.40, 0.79, 0.030, HULL)):
        rings = []
        for y in [y0] + [k[0] for k in reversed(KEEL) if y0 < k[0] < y1] + [y1]:
            hw, _, zt, _, ct = _keel_at(y)
            rings.append((y, _plate(hw - ct - 0.012, zt - 0.008, zt + lift, 0.014)))
        add(_loft(_along_y(rings), bevel=0.005), color=P(slot, B.DECAL_MARK, 0.55), smooth=FACET)
    # a rear bumper plate under the engines
    add(place(box(0.40, 0.05, 0.06, 0.012), (0, 0.79, -0.035)), color=P(GUNMETAL, wear=0.8))

    # --- side skirts along the forward flanks, a strip of hull lamps on each
    for side in (-1, 1):
        rings = []
        for y in (0.10, -0.40, -0.66):
            ox = _keel_at(y)[0] - 0.33
            rings.append((y, [(x + ox, z) for x, z in ((0.322, -0.035), (0.362, -0.035), (0.382, -0.005),
                                                       (0.368, 0.185), (0.345, 0.205), (0.322, 0.205))]))
        add(_loft(_along_y(rings, side=side), bevel=0.008), color=P(GUNMETAL, B.DECAL_MARK, 0.6), smooth=FACET)
        for y in (-0.60, -0.48, -0.18, -0.04):
            ox = _keel_at(y)[0] - 0.33
            add(place(box(0.012, 0.026, 0.012), ((0.372 + ox) * side, y, 0.15)), mat=1, smooth=None)

    # --- the armoured cockpit: faceted block, a band of four slit windows under a visor brow
    add(_loft(_along_y([(y, _hexa(*h)) for y, h in COCKPIT]), bevel=0.012), color=P(HULL, B.DECAL_MARK, 0.5), smooth=FACET)
    (_, h0), (_, h1) = COCKPIT[1], COCKPIT[2]
    ya, yb, za, zb = COCKPIT[1][0], COCKPIT[2][0], h0[5], h1[5]
    rake = math.degrees(math.atan2(za - zb, ya - yb))       # the screen facet's slope
    t = 0.55
    sy, sz = yb + (ya - yb) * t, zb + (za - zb) * t
    ny, nz = -math.sin(math.radians(rake)), math.cos(math.radians(rake))
    add(place(box(0.27, 0.052, 0.01), (0, sy + ny * 0.003, sz + nz * 0.003), (rake, 0, 0)), color=P(GUNMETAL, wear=0.3))
    for x in (-0.096, -0.032, 0.032, 0.096):
        add(place(box(0.052, 0.03, 0.008), (x, sy + ny * 0.006, sz + nz * 0.006), (rake, 0, 0)), color=P(GLASS))
    add(place(box(0.31, 0.09, 0.016, 0.005), (0, ya - 0.035, za + 0.009), (-4, 0, 0)), color=P(GUNMETAL, wear=0.7))
    hs, zs, ht, zt = h0[2], h0[3], h0[4], h0[5]
    tilt = math.degrees(math.atan2(zt - zs, hs - ht))         # the cheek chamfer's lean from level
    cx, cz = (hs + ht) / 2, (zs + zt) / 2
    nx, nzc = math.sin(math.radians(tilt)), math.cos(math.radians(tilt))
    for side in (-1, 1):
        add(place(box(0.032, 0.17, 0.008), ((cx + nx * 0.003) * side, -0.385, cz + nzc * 0.003), (0, tilt * side, 0)),
            color=P(GUNMETAL, wear=0.3))
        for y in (-0.34, -0.43):
            add(place(box(0.022, 0.07, 0.008), ((cx + nx * 0.006) * side, y, cz + nzc * 0.006), (0, tilt * side, 0)),
                color=P(GLASS))
    # a roof hatch, and a handrail along the port roof edge
    add(place(box(0.12, 0.10, 0.012), (0, -0.39, zt + 0.004)), color=P(GUNMETAL, wear=0.6))
    add(C.tube([(0.155, -0.30, zt + 0.024), (0.155, -0.48, zt + 0.024)], [0.006, 0.006], n=6, cap_start=True), color=P(STEEL, wear=0.4))
    for y in (-0.32, -0.46):
        add(place(box(0.01, 0.01, 0.026), (0.155, y, zt + 0.011)), color=P(STEEL, wear=0.4))

    # --- the dorsal turret: a squat ring, a faceted housing, twin barrels forward over the cockpit
    tz = 0.25
    add(place(cyl(0.12, 0.11, 0.07, n=12, bevel=0.008), (0, TURRET_Y, tz + 0.035)), color=P(GUNMETAL, wear=0.6))
    add(_loft(_along_y([(0.07, _hexa(0.105, tz + 0.06, 0.105, tz + 0.15, 0.07, tz + 0.195)),
                        (-0.12, _hexa(0.10, tz + 0.06, 0.10, tz + 0.14, 0.065, tz + 0.18)),
                        (-0.17, _hexa(0.08, tz + 0.07, 0.08, tz + 0.115, 0.05, tz + 0.13))]), bevel=0.008),
        color=P(GUNMETAL, B.DECAL_MARK, 0.5), smooth=FACET)
    bz = tz + 0.157
    add(place(box(0.12, 0.04, 0.05, 0.008), (0, -0.17, bz)), color=P(STEEL, wear=0.6))
    for x in (-0.035, 0.035):
        add(_on_y(cyl(0.0125, 0.0125, 0.29, n=8), (x, -0.335, bz)), color=P(STEEL, wear=0.5))
        add(_on_y(cyl(0.019, 0.019, 0.07, n=8), (x, -0.215, bz)), color=P(GUNMETAL, wear=0.5))
        add(_on_y(cyl(0.017, 0.017, 0.035, n=8), (x, -0.46, bz)), color=P(GUNMETAL, wear=0.7))
    add(place(box(0.035, 0.05, 0.03, 0.006), (0.055, -0.02, tz + 0.21)), color=P(STEEL, wear=0.4))
    add(place(box(0.022, 0.006, 0.016), (0.055, -0.046, tz + 0.21)), mat=1, smooth=None)

    # --- engines: two nacelles sunk into the rear quarters, a smaller centre engine between them
    def engine(x, z, y0, r, n_shroud):
        add(_on_y(_ring([(r * 0.86, 0.0), (r, 0.0), (r, 0.10), (r * 0.86, 0.10)], n=n_shroud, spin=22.5), (x, y0, z)),
            color=P(GUNMETAL, wear=0.7))
        add(_on_y(_ring([(r * 0.85, 0.0), (r * 1.05, 0.0), (r * 1.05, 0.012), (r * 0.98, 0.025), (r * 0.85, 0.025)],
                        n=n_shroud, spin=22.5), (x, y0 + 0.10, z)), color=P(STEEL, wear=0.9))
        # the bell, recessed in its shroud: a deep throat round a small glowing core
        add(_on_y(_ring([(r * 0.54, 0.0), (r * 0.74, 0.0), (r * 0.84, 0.085), (r * 0.80, 0.09), (r * 0.54, 0.045)], n=12),
                  (x, y0 + 0.005, z)), color=P(STEEL, wear=0.8))
        add(_on_y(_disc(r * 0.55, 12), (x, y0 + 0.05, z)), mat=1, smooth=None)

    for side in (-1, 1):
        x = NACELLE_X * side
        rings = [[(x + r * c, y, NACELLE_Z + r * s) for c, s in OCTAGON] for y, r in NACELLE]
        add(_loft(rings, bevel=0.01), color=P(GUNMETAL, B.DECAL_MARK, 0.6), smooth=FACET)
        engine(x, NACELLE_Z, 0.73, 0.148, 8)
        # an armour cap over each nacelle, and a vent grille in it
        top = NACELLE_Z + 0.135 * math.cos(math.radians(22.5))
        add(_loft(_along_y([(0.20, _plate(0.07, top - 0.01, top + 0.012, 0.01)), (0.64, _plate(0.07, top - 0.01, top + 0.012, 0.01))],
                           x0=x), bevel=0.004), color=P(HULL, B.DECAL_MARK, 0.6))
        add(place(box(0.09, 0.16, 0.006), (x, 0.47, top + 0.013)), color=P(RUBBER, wear=0.2))
        for k in range(6):
            add(place(box(0.084, 0.01, 0.008), (x, 0.40 + 0.028 * k, top + 0.016), (30, 0, 0)), color=P(STEEL, wear=0.3))
        # an armour plate on the nacelle's upper outboard facet
        f = 0.135 * math.cos(math.radians(22.5)) + 0.004
        add(place(box(0.085, 0.40, 0.012, 0.003), (x + f * math.cos(math.radians(45)) * side, 0.47, NACELLE_Z + f * math.sin(math.radians(45))),
                  (0, 45 * side, 0)), color=P(HULL, B.DECAL_MARK, 0.7))
        # an intake grille on the nacelle's outer flank, above the wing
        flank = (0.125 + 0.12 / 0.53 * 0.01) * math.cos(math.radians(22.5))     # the flat side at y 0.27
        add(place(box(0.006, 0.12, 0.042), (x + (flank + 0.002) * side, 0.27, NACELLE_Z + 0.02)), color=P(RUBBER, wear=0.2))
        for k in range(4):
            add(place(box(0.008, 0.012, 0.038), (x + (flank + 0.005) * side, 0.225 + 0.03 * k, NACELLE_Z + 0.02)), color=P(STEEL, wear=0.3))
    engine(0.0, CENTRE_Z, 0.78, 0.085, 8)

    # --- wing stubs: short, thick, swept back 15°, an armoured leading edge, a doubler plate
    # over the root, hazard tips and a lamp at each tip
    def wing_at(x):
        f = (x - WING_ROOT) / (WING_TIP - WING_ROOT)
        le = -0.12 + (x - WING_ROOT) * math.tan(SWEEP)
        return le, 0.52 - 0.035 * f, 0.05 - 0.015 * f, 0.07 - 0.02 * f     # leading, trailing edge, half-thickness, LE chamfer

    def leading(co, n):
        return P(GUNMETAL, wear=0.9) if n.y < -0.45 else P(HULL, B.DECAL_MARK, 0.55)

    for side in (-1, 1):
        rings = []
        for x in (WING_ROOT, 0.46, WING_TIP):
            le, te, th, c1 = wing_at(x)
            rings.append([(x * side, y, z) for y, z in ((le, WING_Z), (le + c1, WING_Z + th), (te, WING_Z + th),
                                                        (te, WING_Z - th), (le + c1, WING_Z - th))])
        add(_loft(rings, bevel=0.01), color=leading, smooth=FACET)
        rings = []
        for x in (0.35, 0.53):
            le, te, th, c1 = wing_at(x)
            y0, y1, top = le + c1 + 0.012, te - 0.025, WING_Z + th
            rings.append([(x * side, y, z) for y, z in ((y0, top - 0.006), (y1, top - 0.006), (y1, top + 0.008),
                                                        (y1 - 0.01, top + 0.013), (y0 + 0.01, top + 0.013), (y0, top + 0.008))])
        add(_loft(rings, bevel=0.004), color=P(HULL, B.DECAL_MARK, 0.6), smooth=FACET)
        add(place(box(0.06, 0.40, 0.10, 0.012), (1.165 * side, 0.305, WING_Z)), color=P(ORANGE, B.DECAL_HAZARD, 0.8))
        add(place(box(0.036, 0.022, 0.032), (1.165 * side, 0.095, WING_Z)), mat=1, smooth=None)
        add(place(box(0.03, 0.016, 0.02), (1.165 * side, 0.51, WING_Z + 0.02)), mat=1, smooth=None)
        # the missile rack's pod under the wing root (SPEC-070): two tubes, red caps
        px = 0.56 * side
        add(place(box(0.04, 0.20, 0.04), (px, 0.12, WING_Z - 0.055)), color=P(GUNMETAL, wear=0.6))
        add(place(box(0.15, 0.38, 0.075, 0.012), (px, 0.13, -0.068)), color=P(GUNMETAL, B.DECAL_MARK, 0.7))
        add(place(box(0.158, 0.025, 0.083), (px, 0.04, -0.068)), color=P(STEEL, wear=0.6))
        add(place(box(0.158, 0.025, 0.083), (px, 0.24, -0.068)), color=P(STEEL, wear=0.6))
        for dx in (-0.036, 0.036):
            add(_on_y(cyl(0.029, 0.029, 0.05, n=10), (px + dx, -0.08, -0.068)), color=P(STEEL, wear=0.7))
            add(_on_y(cyl(0.025, 0.025, 0.01, n=8), (px + dx, -0.105, -0.068)), color=P(CAP, wear=0.4))

    # --- salvage gear: a folded grapple boom on the starboard flank, the winch behind the turret
    s = -1
    p0, p1, p2 = (0.395 * s, 0.06, 0.19), (0.395 * s, -0.62, 0.19), (0.30 * s, -0.94, 0.09)
    add(place(cyl(0.04, 0.04, 0.08, n=10), p0, (0, 90, 0)), color=P(STEEL, wear=0.7))
    add(place(box(0.06, 0.09, 0.08, 0.008), (0.39 * s, 0.09, 0.14)), color=P(GUNMETAL, wear=0.7))
    add(C.along(box(0.056, 0.062, C.length(p0, p1), 0.01), p0, p1), color=P(ORANGE, B.DECAL_MARK, 0.7))
    add(C.along(cyl(0.014, 0.014, 0.5, n=8), (0.40 * s, -0.02, 0.235), (0.40 * s, -0.52, 0.235)), color=P(STEEL, wear=0.4))
    add(C.along(cyl(0.02, 0.02, 0.12, n=8), (0.40 * s, 0.04, 0.235), (0.40 * s, -0.08, 0.235)), color=P(GUNMETAL, wear=0.6))
    add(place(cyl(0.036, 0.036, 0.075, n=10), p1, (0, 90, 0)), color=P(STEEL, wear=0.7))
    add(C.along(box(0.05, 0.056, C.length(p1, p2), 0.009), p1, p2), color=P(ORANGE, B.DECAL_HAZARD, 0.8))
    for y in (-0.12, -0.50):
        ox = _keel_at(y)[0] - 0.33
        inner = (0.368 + ox)
        add(place(box(0.395 - inner, 0.035, 0.035), ((inner + 0.395) / 2 * s, y, 0.17)), color=P(GUNMETAL, wear=0.6))
    # the claw: a hub and three two-jointed fingers, pointing forward
    add(_on_y(cyl(0.034, 0.044, 0.06, n=8), p2), color=P(GUNMETAL, wear=0.7))
    hub = (p2[0], p2[1] - 0.03, p2[2])
    for k in range(3):
        a = math.radians(90 + 120 * k)
        d = (math.cos(a), math.sin(a))
        f0 = (hub[0] + 0.028 * d[0], hub[1], hub[2] + 0.028 * d[1])
        f1 = (hub[0] + 0.075 * d[0], hub[1] - 0.06, hub[2] + 0.075 * d[1])
        f2 = (hub[0] + 0.024 * d[0], hub[1] - 0.125, hub[2] + 0.024 * d[1])
        spin = math.degrees(a)
        add(C.along(box(0.024, 0.016, C.length(f0, f1) + 0.016), f0, f1, spin), color=P(STEEL, wear=0.8))
        add(C.along(box(0.018, 0.013, C.length(f1, f2) + 0.01), f1, f2, spin), color=P(STEEL, wear=0.9))
    # winch drum on the middle band, its cable run through guides to the boom's pivot
    wz = 0.261 + 0.058
    for x in (-0.095, 0.095):
        add(place(box(0.022, 0.08, 0.075), (x, 0.25, 0.29)), color=P(GUNMETAL, wear=0.6))
    add(place(cyl(0.045, 0.045, 0.15, n=12), (0, 0.25, wz), (0, 90, 0)), color=P(RUBBER, wear=0.3))
    for x in (-0.072, 0.072):
        add(place(cyl(0.06, 0.06, 0.012, n=12), (x, 0.25, wz), (0, 90, 0)), color=P(ORANGE, wear=0.8))
    add(C.tube([(-0.075, 0.25, wz - 0.03), (-0.20, 0.22, 0.282), (-0.30, 0.15, 0.25), (-0.38, 0.08, 0.215)],
               [0.0065] * 4, n=6, cap_start=True), color=P(RUBBER, wear=0.2))
    for gx, gy, gz in ((-0.20, 0.22, 0.272), (-0.30, 0.15, 0.24)):
        add(place(box(0.026, 0.022, 0.03), (gx, gy, gz)), color=P(STEEL, wear=0.6))

    # --- greebles: a ladder up the port skirt, deck louvres, antennas and the sensor mast
    lean = math.atan2(0.014, 0.19)                            # the skirt's outer face leans in
    for y in (-0.385, -0.275):
        add(place(box(0.012, 0.012, 0.24), (0.383, y, 0.08), (0, -math.degrees(lean), 0)), color=P(STEEL, wear=0.5))
    for z in (-0.02, 0.03, 0.08, 0.13, 0.18):
        add(_on_y(cyl(0.0055, 0.0055, 0.11, n=6), (0.389 - (z - 0.08) * math.tan(lean), -0.33, z)), color=P(STEEL, wear=0.6))
    add(C.tube([(0.352, -0.44, 0.232), (0.352, -0.22, 0.232)], [0.006, 0.006], n=6, cap_start=True), color=P(STEEL, wear=0.4))
    for y in (-0.42, -0.24):
        add(place(box(0.01, 0.01, 0.03), (0.352, y, 0.215)), color=P(STEEL, wear=0.4))
    for x in (-0.13, 0.13):
        add(place(box(0.09, 0.12, 0.006), (x, 0.50, 0.273)), color=P(RUBBER, wear=0.2))
        for k in range(4):
            add(place(box(0.084, 0.012, 0.009), (x, 0.455 + 0.03 * k, 0.278), (25, 0, 0)), color=P(STEEL, wear=0.3))
    # whip antenna (port), dish (starboard), sensor mast with its beacon
    add(place(cyl(0.016, 0.012, 0.03, n=8), (0.20, 0.62, 0.265)), color=P(GUNMETAL, wear=0.5))
    add(place(cyl(0.0045, 0.0028, 0.31, n=6), (0.20, 0.62, 0.43)), color=P(STEEL, wear=0.3))
    add(place(cyl(0.008, 0.008, 0.07, n=6), (-0.17, 0.60, 0.30)), color=P(STEEL, wear=0.4))
    dish = C.lathe([(0.006, 0.0), (0.035, 0.008), (0.062, 0.026), (0.058, 0.030), (0.032, 0.013), (0.006, 0.006), (0.006, 0.0)], n=10)
    add(place(dish, (-0.17, 0.60, 0.335), (-35, 0, -25)), color=P(HULL, wear=0.4))
    add(place(cyl(0.008, 0.004, 0.04, n=6), (-0.17, 0.588, 0.36), (-35, 0, -25)), color=P(STEEL, wear=0.4))
    add(place(cyl(0.012, 0.009, 0.14, n=8), (0.0, 0.50, 0.34)), color=P(STEEL, wear=0.4))
    add(place(box(0.06, 0.035, 0.03, 0.006), (0.0, 0.50, 0.415)), color=P(GUNMETAL, wear=0.5))
    add(place(cyl(0.011, 0.011, 0.02, n=8), (0.0, 0.50, 0.44)), mat=1)

    # --- skids: two shoes with upturned toes, struts and dampers; contact at z −0.2
    for side in (-1, 1):
        x = 0.22 * side
        add(place(box(0.05, 1.0, 0.03, 0.01), (x, -0.08, -0.177)), color=P(STEEL, wear=0.8))
        add(place(box(0.05, 0.10, 0.03, 0.008), (x, -0.615, -0.155), (-28, 0, 0)), color=P(STEEL, B.DECAL_HAZARD, 0.9))
        add(place(box(0.054, 0.96, 0.01), (x, -0.08, -0.195)), color=P(RUBBER, wear=0.9))
        for y in (-0.40, 0.25):
            add(C.along(box(0.03, 0.03, 0.12), (0.18 * side, y, -0.07), (x, y, -0.172)), color=P(GUNMETAL, wear=0.7))
            add(C.along(cyl(0.009, 0.009, 0.13, n=6), (0.12 * side, y + 0.07, -0.08), (x, y + 0.01, -0.168)), color=P(STEEL, wear=0.5))
            add(place(box(0.06, 0.07, 0.014), (x, y, -0.163)), color=P(GUNMETAL, wear=0.7))
    obj = b.object('SalvageTug', [_bake_slot(), glow])

    B.unwrap(obj)
    F = B.Fields(obj, 1024, seed=7)
    p = B.Paint(F)
    p.hull(palette=['#d8d2c4', '#3b4148', '#d4621c', '#7d8288', '#1e2024', '#0b1a26', '#9c2219'],
           rough=[0.5, 0.45, 0.5, 0.34, 0.8, 0.05, 0.5], metal=[0.08, 0.35, 0.08, 0.9, 0.0, 0.2, 0.05],
           seed=7, panel=(0.12, 0.08), seam_dark=0.3, wear=0.6, grime=0.65)
    # the structural plates over the fine panelling: deeper, darker seams and a tone per plate
    big = B.panels(F, 0.36, 0.24, seed=19, seam=0.006)
    p.base = p.base * ((1 - 0.32 * big['seam']) * (1 + 0.1 * (big['tone'] - 0.5)))[..., None]
    p.height = p.height - 0.0014 * big['seam']
    pos, nrm = F.P, F.N
    x, y, z = pos[..., 0], pos[..., 1], pos[..., 2]
    hull = F.slot == HULL
    up = nrm[..., 2] > 0.7
    # twin orange stripes along the spine, a hazard band across the prow
    deck = (hull | (F.slot == GUNMETAL)) & up & (z > 0.24)
    for sx in (-0.2, 0.2):
        p.decal(deck & (np.abs(x - sx) < 0.02) & (y > -0.29) & (y < 0.78), '#d4621c')
    # rows of small access panels: a dark outline sunk a little, in the painter's plane coordinates
    pn = p.pn

    def hatches(mask, ax, rects, mirror=False):
        on = mask & (pn['ax'] == ax)
        a, c = pn['A'], pn['B']
        m = np.zeros(on.shape, bool)
        for a0, a1, c0, c1 in rects + ([(-a1, -a0, c0, c1) for a0, a1, c0, c1 in rects] if mirror else []):
            d = np.minimum(np.minimum(a - a0, a1 - a), np.minimum(c - c0, c1 - c))
            m |= on & (d > 0) & (d < 0.0045)
        p.base = p.base * (1 - 0.45 * m)[..., None]
        p.height = p.height - 0.0012 * m

    painted = hull | (F.slot == GUNMETAL)
    hatches(painted, 0, [(-0.94, -0.885, 0.03, 0.085), (-0.865, -0.795, 0.03, 0.10), (-0.775, -0.70, 0.03, 0.11),
                         (-0.48, -0.40, 0.215, 0.30), (-0.56, -0.50, 0.0, 0.11), (-0.16, -0.08, 0.0, 0.11)])
    hatches(painted, 2, [(0.115, 0.17, 0.07, 0.17), (0.03, 0.15, 0.68, 0.76), (0.245, 0.355, 0.22, 0.33),
                         (0.245, 0.355, 0.57, 0.63), (0.0, 0.07, -0.95, -0.86)], mirror=True)
    p.hazard(hull & (y < -0.985) & (nrm[..., 1] < 0.5), period=0.05)
    p.hazard(F.decal_is(B.DECAL_HAZARD) & (F.slot != ORANGE), period=0.05)
    p.hazard(F.decal_is(B.DECAL_HAZARD) & (F.slot == ORANGE) & (nrm[..., 2] > 0.5), period=0.05)
    # an orange band round each nacelle, an orange bar across each wing near the tip
    nac = (np.hypot(np.abs(x) - NACELLE_X, z - NACELLE_Z) < 0.15) & (F.slot == GUNMETAL)
    p.decal(nac & (np.abs(y - 0.17) < 0.025), '#d4621c')
    p.decal(hull & up & (np.abs(np.abs(x) - 1.03) < 0.025) & (np.abs(z - WING_Z) < 0.06), '#d4621c')
    # keep clear: hazard stripes round the turret ring, NO STEP by it
    ring = np.hypot(x, y - TURRET_Y)
    p.hazard(hull & up & (ring > 0.125) & (ring < 0.15) & (z > 0.24), period=0.035)
    tall = 0.026
    width = 41 * tall / 7
    p.decal(B.text(F, 'NO STEP', (-width / 2, -0.255 + tall / 2, 0.252), (1, 0, 0), (0, 1, 0), tall, axis=2, sign=1)
            * hull, '#1d2126', rough=0.4)
    # heat-tinted rings at the bells, soot behind every bell
    hot = (F.slot == STEEL) & (y > 0.75)
    p.decal(hot * np.clip((y - 0.75) / 0.12, 0, 1) * 0.8, '#4d4766', rough=0.4)
    for bx, bz, r in ((-NACELLE_X, NACELLE_Z, 0.32), (NACELLE_X, NACELLE_Z, 0.32), (0.0, CENTRE_Z, 0.22)):
        p.soot((bx, 0.88, bz), r)
    for side in (-1, 1):
        # registration on the wing tops, upright to a viewer ahead of the nose:
        # CR-62, the tug Command hails on the first run (review 2026-10 P-02;
        # the dialogue's CR-{instance} moves on with the run, the paint does not)
        # (along the stub's mid-chord line, which runs back 0.095 m over the span)
        slope = 0.095 / (WING_TIP - WING_ROOT)
        ang = math.atan(slope) * side
        right = np.array((math.cos(ang), math.sin(ang), 0.0))
        upv = np.array((-math.sin(ang), math.cos(ang), 0.0))
        tall = 0.095
        width = 29 * tall / 7
        mid = 0.74
        origin = np.array((mid * side, 0.20 + (mid - WING_ROOT) * slope, WING_Z + 0.042)) - right * width / 2 + upv * tall / 2
        p.decal(B.text(F, 'CR-62', origin, right, upv, tall, axis=2, sign=1) * hull, '#1d2126', rough=0.4)
        # the hull number stencilled on each cockpit cheek, read from that side
        tall = 0.05
        width = 11 * tall / 7
        rgt = np.array((0.0, side, 0.0))
        origin = np.array((0.218 * side, -0.31, 0.27)) - rgt * width / 2 + np.array((0, 0, tall / 2))
        p.decal(B.text(F, '62', origin, rgt, (0, 0, 1), tall, axis=0, sign=side) * hull, '#1d2126', rough=0.4)
    p.glass(F.slot == GLASS, (0, -0.55, 0.33))
    obj.data.materials[0] = p.finish('Hull', emissive_strength=1.6)
    _sheet(p, preview, 'ship')
    return obj


# ---------------------------------------------------------------- the fighter

RUST, OLIVE, SOOT, GUNSTEEL, RED, VISOR = range(6)


FIGHTER_K = 1.15            # SPEC-063 §4.3: the tug's parts at 1.15 × its size
REGISTRY_PLATE = (0.37, -0.42, 0.1)   # x (each side), y, z of the ground-bare plate's centre


def fighter(preview=None):
    """Scavenger fighter (SPEC-063 §4.3): a tug rebuilt for war, 3.1 m span, 2.6 m
    long. The tug's hull, nose, canopy and engine pods at 1.15 ×, its cargo wings,
    fins, skids, antenna and lamp bar cut away; the old fighter's swept blades and
    gun prongs bolted under the pods and its booster between them, its nozzle disc
    at (0, 1.28, 0) where FlightView's glow expects it. Rust and olive plating,
    patches, red paint across the nose, the registry plate ground to bare steel."""
    k = FIGHTER_K

    def at(x, y, z):
        return (x * k, y * k, z * k)

    glow = C.mat_flat('Glow', '#ffffff', emission='#ff8a4a', strength=2.5)
    b = C.Builder()
    # the tug: hull, nose block, spine plate, canopy and its ring
    b.add(place(box(0.62 * k, 1.45 * k, 0.34 * k, 0.08, 2), at(0, 0.05, 0.08)), color=P(RUST, B.DECAL_MARK, 0.8))
    b.add(place(box(0.48 * k, 0.55 * k, 0.24 * k, 0.07, 2), at(0, -0.82, 0.02), (10, 0, 0)), color=P(RUST, B.DECAL_MARK, 0.9))
    b.add(place(box(0.30 * k, 0.40 * k, 0.12 * k, 0.03), at(0, 0.45, 0.30)), color=P(GUNSTEEL, wear=0.7))
    b.add(place(sphere(0.22 * k, 20, 12), at(0, -0.44, 0.27), scale=(1.0, 1.65, 0.68)), color=P(VISOR), smooth=80)
    b.add(place(torus(0.2 * k, 0.018 * k, n=24, m=5), at(0, -0.44, 0.255), scale=(1.1, 1.75, 1.0)), color=P(GUNSTEEL, wear=0.9))
    for side in (-1, 1):
        x = 0.52 * side
        # the tug's engine pods, front intake and rear discs still glowing — orange now
        b.add(place(cyl(0.17 * k, 0.15 * k, 0.92 * k, n=16, bevel=0.02), at(x, 0.33, 0.05), (90, 0, 0)),
              color=P(OLIVE, B.DECAL_MARK, 0.9))
        b.add(place(cyl(0.195 * k, 0.2 * k, 0.09 * k, n=16), at(x, 0.80, 0.05), (90, 0, 0)), color=P(GUNSTEEL, wear=1.0))
        b.add(place(cyl(0.135 * k, 0.135 * k, 0.02 * k, n=16), at(x, 0.846, 0.05), (90, 0, 0)), mat=1, smooth=None)
        b.add(place(cyl(0.12 * k, 0.1 * k, 0.1 * k, n=12), at(x, -0.16, 0.05), (90, 0, 0)), color=P(SOOT, wear=0.8))
        b.add(place(box(0.34 * k, 0.34 * k, 0.1 * k, 0.02), at(0.34 * side, 0.30, 0.05)), color=P(GUNSTEEL, wear=0.8))
        # the old fighter's swept blade, bolted under the pod, with its gun prong
        b.add(place(box(1.25, 0.62, 0.08, 0.03), (0.86 * side, 0.18, -0.1), (0, 0, 22 * side)), color=P(OLIVE, B.DECAL_MARK, 0.85))
        b.add(place(box(0.9, 0.12, 0.09, 0.02), (0.9 * side, 0.42, -0.08), (0, 0, 22 * side)), color=P(SOOT, wear=0.6))
        b.add(place(box(0.12, 1.0, 0.14, 0.03), (1.46 * side, -0.32, -0.1)), color=P(GUNSTEEL, B.DECAL_HAZARD, 1.0))
        b.add(place(cyl(0.035, 0.035, 0.35, n=8), (1.46 * side, -0.95, -0.1), (90, 0, 0)), color=P(SOOT, wear=0.9))
        # weld brackets where the blade meets the pod
        for y in (0.05, 0.45):
            b.add(place(box(0.1, 0.06, 0.12, 0.01), (0.62 * side, y, -0.06)), color=P(SOOT, wear=1.0))
        # the registry plate on the hull's flank, ground to bare steel
        rx, ry, rz = REGISTRY_PLATE
        b.add(place(box(0.02, 0.32, 0.12, 0.004), (rx * side, ry, rz)), color=P(GUNSTEEL, wear=1.0))
    # patch plates riveted over the hull, the nose and a pod
    for size, loc, rot, slot in (((0.26, 0.30, 0.02), (-0.13, -0.02, 0.33), (0, 0, 6), OLIVE),
                                 ((0.28, 0.20, 0.02), (0.05, -0.97, 0.19), (12, 0, -8), OLIVE),
                                 ((0.02, 0.34, 0.18), (0.37, 0.32, 0.09), (0, 0, 0), SOOT),
                                 ((0.16, 0.30, 0.02), (-0.6, 0.36, 0.27), (0, 0, -4), RUST)):
        b.add(place(box(*size, 0.005), loc, rot), color=P(slot, wear=0.9))
    # the old fighter's booster between the pods; its disc is the exhaust FlightView lights
    b.add(place(cyl(0.3, 0.24, 0.5, n=16, bevel=0.02), (0, 1.02, 0), (90, 0, 0)), color=P(GUNSTEEL, wear=1.0))
    b.add(place(cyl(0.2, 0.2, 0.02, n=16), (0, 1.28, 0), (90, 0, 0)), mat=1, smooth=None)
    obj = b.object('Fighter', [_bake_slot(), glow])

    B.unwrap(obj)
    F = B.Fields(obj, 512, seed=11, edge=0.015)
    p = B.Paint(F)
    pn = p.hull(palette=['#8e4a26', '#5f5d52', '#252321', '#6f7276', '#8f2418', '#140c08'],
                rough=[0.6, 0.62, 0.7, 0.4, 0.55, 0.05], metal=[0.25, 0.2, 0.1, 0.85, 0.1, 0.2],
                seed=11, panel=(0.32, 0.22), tone=0.1, seam_dark=0.4, wear=0.85, grime=0.85)
    pos, nrm = F.P, F.N
    # scavenged patches: a few panels in the other plating colour
    patch = pn['tone'] > 0.86
    p.decal(patch & (F.slot == RUST), '#5f5d52')
    p.decal(patch & (F.slot == OLIVE), '#8e4a26')
    # red war paint: bands across the blade tops (not the pods), stripes across the nose
    ax = np.abs(pos[..., 0])
    blade = (F.slot == OLIVE) & (np.abs(nrm[..., 2]) > 0.7) & (ax > 0.85)
    p.decal(blade & (np.mod(ax - 0.85, 0.36) < 0.11), '#8f2418')
    nose = (F.slot == RUST) & (nrm[..., 2] > 0.5) & (pos[..., 1] < -0.6)
    for y in (-0.72, -0.9):
        p.decal(nose & (np.abs(pos[..., 1] - y) < 0.045), '#8f2418')
    # the registry plate: bare steel scored by the grinder, with no letters left on it
    rx, ry, rz = REGISTRY_PLATE
    plate = ((F.slot == GUNSTEEL) & (np.abs(ax - rx) < 0.02) & (np.abs(pos[..., 1] - ry) < 0.16)
             & (np.abs(pos[..., 2] - rz) < 0.06))
    p.decal(plate, '#a7aaad', rough=0.3)
    p.decal(plate & (np.mod(pos[..., 1] * 31 + pos[..., 2] * 13, 1.0) < 0.35), '#c8cacc', rough=0.22)
    p.hazard(F.decal_is(B.DECAL_HAZARD), period=0.06)
    p.soot((0, 1.3, 0), 0.55, strength=0.9)
    for side in (-1, 1):
        p.soot((1.46 * side, -1.1, -0.1), 0.3)
        p.soot((0.52 * k * side, 0.97, 0.06), 0.35)
    p.glass(F.slot == VISOR, (0, -0.44 * k, 0.27 * k), tint='#1a0e08', sky='#ff9a5a', level=0.35)
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
