# Surface props (SPEC-018 §4.7, the `PROP_MODELS` seam; SPEC-052 §4.2–§4.4):
# models/props/<biome>_<kind>_<a|b|c>.glb for the twelve biome × obstacle-kind
# pairs of systems/Layout.ts, and models/props/landmark_<biome>.glb.
#
# * The ten non-tree kinds are unit props — footprint radius 1, base at z 0,
#   origin at the base centre — because SurfaceView scales an obstacle by its
#   radius. Biome colours are baked into vertex colours (`Body`, COLOR_0) with
#   dust/snow/moss on top faces and darkening toward the ground; emissive parts
#   (ice cores, lava, hive veins, spores) use a second `Glow` material. `_a` and
#   `_b` are SPEC-018's shapes, unchanged; `_c` is SPEC-052 §3.4's dressing.
# * The two tree kinds are built by the tree builder under SPEC-052 §3.2's
#   contract: `Bark`, `Leaf`, `Bark_LOD1`, `Leaf_LOD1` (+ `Glow`) on one
#   `Foliage` material whose UVs sample the foliage atlas (foliage.py).
# * The landmarks are set pieces authored in metres (§3.5).
#
# Every model is meshopt-compressed (EXT_meshopt_compression), and only the
# trees carry TEXCOORD_0 (§4.2, §4.3). Deterministic: noise is seeded from the
# model, random draws come from tex.Rand seeded by its name.
import math
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'lib'))

import bmesh  # noqa: E402
import bpy  # noqa: E402
from mathutils import Matrix, Vector, noise  # noqa: E402

import common as C  # noqa: E402
import tex as T  # noqa: E402

box, cyl, sphere, ico, place, torus, lathe, along = C.box, C.cyl, C.sphere, C.ico, C.place, C.torus, C.lathe, C.along


def nz(co, seed, scale=1.0, octaves=3):
    p = Vector(co) * scale + Vector((seed * 7.31, seed * 3.17, seed * 5.53))
    return noise.fractal(p, 0.8, 2.0, octaves, noise_basis='PERLIN_ORIGINAL')


def mix(a, b, t):
    t = min(max(t, 0.0), 1.0)
    return tuple(x + (y - x) * t for x, y in zip(a, b))


def shade(base, top=None, seed=0, top_from=0.55, ground=0.62, height=1.0):
    """Vertex colour: base → top on up-facing faces, darker toward the ground, ±8 % noise."""
    lb = C.lin(base)
    lt = C.lin(top) if top else lb

    def fn(co, n):
        c = mix(lb, lt, (n.z - top_from) / 0.3) if top else lb
        k = ground + (1 - ground) * min(max(co.z / (0.6 * height), 0.0), 1.0)
        k *= 0.92 + 0.08 * nz(co, seed + 3, 3.0, 2)
        return (c[0] * k, c[1] * k, c[2] * k, 1.0)
    return fn


def boulder(seed, subdiv=3, squat=0.8, rough=0.28, ridge=0.0, flat_top=None):
    # bmesh counts the bare icosahedron as subdivision 1: 3 → 320 triangles
    part = ico(1.0, subdiv)
    C.displace(part, lambda co: rough * nz(co, seed, 1.2) + ridge * (0.5 - abs(nz(co, seed + 11, 2.4))))
    place(part, scale=(1.0, 0.9, squat))
    for v in part.verts:
        v.co.z = max(v.co.z, -0.12)
        if flat_top is not None:
            v.co.z = min(v.co.z, flat_top)
    return part


# -------------------------------------------------------------- per biome kind


def desert_rock(b, seed, variant):
    if variant == 2:
        return desert_rock_c(b, seed)
    b.add(boulder(seed, squat=0.72, ridge=0.12, flat_top=0.5 + 0.1 * variant),
          color=shade('#a8703f', '#d9b07a', seed), smooth=38, uv_scale=0.6)
    if variant:
        b.add(place(boulder(seed + 5, subdiv=2, squat=0.8), (0.95, -0.35, 0), scale=(0.35, 0.35, 0.35)),
              color=shade('#a8703f', '#d9b07a', seed + 5), smooth=38, uv_scale=0.6)


def desert_ruin(b, seed, variant):
    if variant == 2:
        return desert_ruin_c(b, seed)
    stone = shade('#c49a62', '#dcc08a', seed, height=1.6)
    heights = (1.6, 1.1) if variant else (1.3, 0.8, 1.5)
    for i, h in enumerate(heights):
        x = -0.55 + i * (1.1 / max(1, len(heights) - 1))
        col = place(box(0.36, 0.36, h, 0.03), (x, 0.1 * (i % 2), h / 2))
        C.displace(col, lambda co, i=i: 0.03 * nz(co, seed + i, 5.0) if co.z > h - 0.25 else 0.0)
        b.add(col, color=stone, smooth=35, uv_scale=0.8)
        b.add(place(box(0.46, 0.46, 0.12, 0.02), (x, 0.1 * (i % 2), 0.06)), color=shade('#8a6a44', seed=seed), uv_scale=0.8)
    b.add(place(box(1.3, 0.3, 0.26, 0.03), (0.1, -0.55, 0.13), (0, 0, 12)), color=stone, uv_scale=0.8)
    b.add(place(box(0.34, 0.9, 0.3, 0.03), (0.45, 0.55, 0.15), (0, 70, 25)), color=stone, uv_scale=0.8)


def ice_rock(b, seed, variant):
    if variant == 2:
        return ice_rock_c(b, seed)
    b.add(boulder(seed, subdiv=2, squat=0.85, rough=0.22, ridge=0.2), color=shade('#7f98ab', '#f1f7fb', seed, top_from=0.35),
          smooth=None, uv_scale=0.6)


def ice_spire(b, seed, variant):
    if variant == 2:
        return ice_spire_c(b, seed)
    ice = shade('#a9dcf2', '#e8f8ff', seed, top_from=0.9, ground=0.8, height=2.6)
    shards = ((0, 0, 2.6, 0.34, 0), (0.42, 0.2, 1.7, 0.24, 14), (-0.35, 0.3, 1.9, 0.26, -12), (0.1, -0.45, 1.3, 0.2, 18))
    for i, (x, y, h, r, tilt) in enumerate(shards[: 3 + variant]):
        shard = cyl(r, 0.02, h, n=6)
        place(shard, (x, y, h / 2 - 0.05), (tilt * 0.6, tilt, i * 20))
        b.add(shard, color=ice, smooth=None, uv_scale=0.6)
    b.add(place(cyl(0.12, 0.03, 1.8, n=6), (0, 0, 0.9)), mat=1, smooth=None)
    b.add(boulder(seed + 3, subdiv=2, squat=0.3, rough=0.15), color=shade('#8aa3b5', '#eef6fb', seed + 3), smooth=None)


def jungle_ruin(b, seed, variant):
    if variant == 2:
        return jungle_ruin_c(b, seed)
    stone = shade('#7a8074', '#56863a', seed, top_from=0.5, height=1.4)
    arch_h = 1.4
    for x in (-0.6, 0.6):
        b.add(place(box(0.34, 0.4, arch_h, 0.03), (x, 0, arch_h / 2)), color=stone, uv_scale=0.8)
    if variant:
        b.add(place(box(1.6, 0.44, 0.28, 0.03), (0, 0, arch_h + 0.14), (0, 4, 0)), color=stone, uv_scale=0.8)
    else:
        b.add(place(box(1.1, 0.4, 0.26, 0.03), (0.55, 0.5, 0.13), (0, 0, 30)), color=stone, uv_scale=0.8)
    for i in range(5):
        a = i * 1.3 + seed
        vine = along(cyl(0.025, 0.02, 1.2, n=5), (-0.6 + 0.3 * math.sin(a), -0.21, 1.35), (-0.5 + 0.35 * math.cos(a), -0.24, 0.1))
        b.add(vine, color=shade('#3f6e2a', seed=seed + i), smooth=60)
    b.add(boulder(seed + 7, subdiv=2, squat=0.25, rough=0.2), color=shade('#4f6b39', '#6f9a4a', seed), smooth=40)


def volcanic_rock(b, seed, variant):
    if variant == 2:
        return volcanic_rock_c(b, seed)
    b.add(boulder(seed, squat=0.78, rough=0.3, ridge=0.18), color=shade('#3a302b', '#4a3d36', seed, ground=0.7),
          mat=lambda c, n: 1 if abs(nz(c, seed + 5, 2.2, 2)) < 0.05 else 0, smooth=None, uv_scale=0.6)


def volcanic_vent(b, seed, variant):
    if variant == 2:
        return volcanic_vent_c(b, seed)
    rock = shade('#3b322d', '#51453c', seed, ground=0.75, height=1.1)
    cone = lathe([(1.0, 0.0), (0.82, 0.35), (0.55, 0.9), (0.42, 1.05), (0.34, 0.95), (0.3, 0.7)], n=14)
    C.displace(cone, lambda co: 0.06 * nz(co, seed, 2.5))
    b.add(cone, color=rock, mat=lambda c, n: 1 if c.z < 0.55 and abs(nz(c, seed + 9, 3.0, 2)) < 0.07 else 0, smooth=45)
    b.add(place(cyl(0.34, 0.3, 0.04, n=12), (0, 0, 0.74)), mat=1, smooth=None)
    for i in range(2 + variant):
        a = math.radians(i * 140 + seed * 30)
        b.add(place(boulder(seed + i, subdiv=2, squat=0.7), (0.95 * math.cos(a), 0.95 * math.sin(a), 0), scale=(0.28, 0.28, 0.28)),
              color=rock, smooth=None)


def hive_spire(b, seed, variant):
    if variant == 2:
        return hive_spire_c(b, seed)
    chitin = shade('#5b4078', '#7a5a9a', seed, top_from=0.6, ground=0.6, height=2.6)
    h = 2.6
    tower = lathe([(0.55, 0.0), (0.42, 0.4), (0.36, 1.0), (0.28, 1.6), (0.18, 2.2), (0.05, h), (0.0, h + 0.05)], n=12)
    C.displace(tower, lambda co: 0.06 * math.sin(co.z * 9 + seed) + 0.04 * nz(co, seed, 3.0))
    b.add(tower, color=chitin, smooth=50)
    for z, r in ((0.55, 0.43), (1.25, 0.34), (1.9, 0.24)):
        b.add(place(torus(r, 0.03, n=16, m=4), (0, 0, z)), mat=1, smooth=None)
    for i in range(3 + variant):
        a = math.radians(i * 100 + seed * 20)
        spike = along(cyl(0.09, 0.01, 0.8, n=6), (0.3 * math.cos(a), 0.3 * math.sin(a), 0.6 + 0.3 * i),
                      (0.85 * math.cos(a), 0.85 * math.sin(a), 1.0 + 0.35 * i))
        b.add(spike, color=shade('#3a2a4d', seed=seed + i), smooth=None)


def hive_rock(b, seed, variant):
    if variant == 2:
        return hive_rock_c(b, seed)
    b.add(boulder(seed, squat=0.7, rough=0.22), color=shade('#4b3a5c', '#6a5480', seed, top_from=0.5),
          mat=lambda c, n: 1 if n.z > 0.2 and nz(c, seed + 4, 3.5, 1) > 0.42 else 0, smooth=45)


def temperate_rock(b, seed, variant):
    if variant == 2:
        return temperate_rock_c(b, seed)
    b.add(boulder(seed, squat=0.75, rough=0.25), color=shade('#8c8a82', '#6b9a52', seed, top_from=0.6), smooth=40, uv_scale=0.6)


# --------------------------------------------------------------------- trees
# SPEC-052 §3.2, §4.2: the tree contract. A tree is five nodes — `Bark`,
# `Leaf`, `Bark_LOD1`, `Leaf_LOD1` on one `Foliage` material (the foliage atlas
# is bound at runtime, SPEC-053) and an optional `Glow` — each its own object
# with an identity transform. The canopy is the unit: `Leaf` reaches 1.00 from
# the trunk axis and the trunk is 0.14 at y 0.30–0.34, so SPEC-053 scales a
# tree by `radius / 0.14`. Leaf cards stay within 50° of horizontal, because
# the camera looks down at 55° and a vertical card is a line from above.

ATLAS = 512
GUTTER = 4
BARK_CELL = 15
CARD_TILT = 40.0   # degrees from horizontal, the most any Leaf card leans (§3.2: 50, less the height fit)
TRUNK_RADIUS = 0.14
TRUNK_BAND = 0.32  # the middle of §3.2's 0.30–0.34 band
FOLIAGE_GLOW = '#b8ff6a'

# §3.2's table: the height of `Leaf`'s top, and the tree's two leaf cells.
TREES = {
    'jungle_tree_a': {'height': 2.40, 'cells': (0, 1)},
    'jungle_tree_b': {'height': 2.20, 'cells': (0, 1)},
    'jungle_tree_c': {'height': 1.80, 'cells': (4, 5)},
    'temperate_tree_a': {'height': 2.10, 'cells': (2, 3)},
    'temperate_tree_b': {'height': 2.20, 'cells': (2, 3)},
    'temperate_tree_c': {'height': 1.70, 'cells': (2, 3)},
}


def cell_rect(cell, inset=0.0):
    """Atlas cell `cell` (§3.3: row-major from the top-left) as a Blender UV
    rectangle (u0, v0, u1, v1) — v runs up in Blender and down in glTF, which
    the exporter flips — shrunk by `inset` on every side."""
    col, row = cell % 4, cell // 4
    return (col / 4 + inset, 1 - (row + 1) / 4 + inset, (col + 1) / 4 - inset, 1 - row / 4 - inset)


BARK_UV = cell_rect(BARK_CELL, (GUTTER + 2) / ATLAS)   # clear of the gutter by two more texels


class TreeParts:
    """The contract's nodes, each built into its own Builder."""

    def __init__(self, name):
        spec = TREES[name]
        self.name = name
        self.height = spec['height']
        self.cells = spec['cells']
        self.rand = T.Rand(T.name_seed(name))
        self.bark = C.Builder()
        self.leaf = C.Builder()
        self.bark1 = C.Builder()
        self.leaf1 = C.Builder()
        self.glow = C.Builder(vcol=False)
        self.pods = 0
        self.clusters = []     # (centre, radius) of every leaf cluster, for LOD1
        self.base_tint = (0.9, 0.95, 0.86)

    def uniform(self, lo, hi):
        return self.rand.uniform(lo, hi)


def hue_shift(rgb, degrees):
    """Rotate an RGB colour about the grey axis (a hue turn that keeps its value)."""
    a = math.radians(degrees)
    c, s = math.cos(a), math.sin(a)
    k = (1 - c) / 3
    q = math.sqrt(1 / 3) * s
    r, g, b = rgb
    return (r * (c + k) + g * (k - q) + b * (k + q),
            r * (k + q) + g * (c + k) + b * (k - q),
            r * (k - q) + g * (k + q) + b * (c + k))


def bezier(a, b, c, steps):
    a, b, c = Vector(a), Vector(b), Vector(c)
    return [a * (1 - t) ** 2 + b * 2 * (1 - t) * t + c * t * t for t in (i / steps for i in range(steps + 1))]


def card(centre, normal, half, spin, cell, turn):
    """One leaf card: a square of side 2·half through `centre`, facing `normal`,
    turned `spin` about it, its UVs the whole of atlas `cell` turned by `turn`
    quarter turns (§4.2 step 4)."""
    n = Vector(normal).normalized()
    ref = Vector((0, 0, 1)) if abs(n.z) < 0.95 else Vector((1, 0, 0))
    u = ref.cross(n).normalized()
    u = Matrix.Rotation(spin, 3, n) @ u
    v = n.cross(u)
    bm = bmesh.new()
    layer = bm.loops.layers.uv.new('UVMap')
    c = Vector(centre)
    corners = [c - u * half - v * half, c + u * half - v * half, c + u * half + v * half, c - u * half + v * half]
    face = bm.faces.new([bm.verts.new(p) for p in corners])
    u0, v0, u1, v1 = cell_rect(cell)
    square = [(u0, v0), (u1, v0), (u1, v1), (u0, v1)]
    for k, loop in enumerate(face.loops):
        loop[layer].uv = square[(k + turn) % 4]
    return bm


def strip(points, widths, sides, cell, flip):
    """A frond: quads along `points`, `widths[i]` across at point i along the
    horizontal `sides[i]`, mapped down the length of atlas `cell` (flipped end
    for end when `flip`)."""
    bm = bmesh.new()
    layer = bm.loops.layers.uv.new('UVMap')
    left = [bm.verts.new(Vector(p) - Vector(s) * (w / 2)) for p, w, s in zip(points, widths, sides)]
    right = [bm.verts.new(Vector(p) + Vector(s) * (w / 2)) for p, w, s in zip(points, widths, sides)]
    u0, v0, u1, v1 = cell_rect(cell)
    last = len(points) - 1
    for i in range(last):
        face = bm.faces.new([left[i], right[i], right[i + 1], left[i + 1]])
        ts = (i / last, i / last, (i + 1) / last, (i + 1) / last)
        us = (0.0, 1.0, 1.0, 0.0)
        for loop, t, s in zip(face.loops, ts, us):
            t = 1 - t if flip else t
            loop[layer].uv = (u0 + (u1 - u0) * s, v0 + (v1 - v0) * t)
    return bm


def cluster(t, centre, radius, count, half, droop=1.0, turn=None):
    """§4.2 step 4: `count` cards around `centre` within `radius`, each tilted at
    most CARD_TILT from horizontal and leaning out of the cluster, spun by a
    seeded angle, on one of the tree's leaf cells with one of four UV turns.
    The cluster takes one hue (±4°), each card its own value (±10 %). `turn`
    (a rotation about z) turns the finished cluster — the orchard tree's
    quadrants."""
    c = Vector(centre)
    turn = turn if turn is not None else Matrix.Identity(3)
    hue = t.uniform(-4.0, 4.0)
    tint = hue_shift(t.base_tint, hue)
    for _ in range(count):
        a = t.uniform(0, 2 * math.pi)
        rr = radius * math.sqrt(t.uniform(0.0, 1.0))
        dz = radius * 0.5 * t.uniform(-1.0, 1.0) * (1 - 0.5 * rr / radius)
        p = c + Vector((math.cos(a) * rr, math.sin(a) * rr, dz))
        out = Vector((p.x - c.x, p.y - c.y, 0.0))
        out = out.normalized() if out.length > 1e-6 else Vector((math.cos(a), math.sin(a), 0.0))
        tilt = math.radians(min(CARD_TILT, (8 + 30 * rr / radius) * droop + t.uniform(0, 6)))
        normal = Vector((0, 0, math.cos(tilt))) + out * math.sin(tilt)
        value = t.uniform(0.9, 1.1)
        colour = tuple(min(1.0, ch * value) for ch in tint) + (1.0,)
        part = card(turn @ p, turn @ normal, half * t.uniform(0.85, 1.15), t.uniform(0, 2 * math.pi),
                    t.cells[t.rand.integers(0, 2)], t.rand.integers(0, 4))
        t.leaf.add(part, color=colour, smooth=180)
    t.clusters.append((turn @ c, radius + half))


def pods(t, anchors):
    """Glowing seed pods hanging under the jungle trees' clusters (4–7, §3.2)."""
    for p in anchors:
        pod = C.place(ico(1.0, 1), Vector(p) - Vector((0, 0, 0.09)), scale=(0.055, 0.055, 0.085))
        t.glow.add(pod, smooth=60)
        t.pods += 1


def bark_colour(height):
    """§3.2: bark darker toward the base."""
    def fn(co, n):
        k = 0.55 + 0.45 * min(max(co.z / (0.5 * height), 0.0), 1.0)
        return (0.92 * k, 0.88 * k, 0.84 * k, 1.0)
    return fn


def spine_points(t, top, lean=0.0, lean_dir=0.0, bend=0.04, start=0.45):
    """The trunk's spine: straight and on the axis to `start` (so the 0.30–0.34
    band is the trunk alone), then bending gently, leaning `lean` degrees
    toward `lean_dir` at the top."""
    pts = []
    bx, by = math.cos(lean_dir + 1.3), math.sin(lean_dir + 1.3)
    lx, ly = math.cos(lean_dir), math.sin(lean_dir)
    for z in [0.0, 0.12] + [start + (top - start) * k / 3 for k in range(4)]:
        f = max(0.0, (z - start) / max(top - start, 1e-6))
        off = math.tan(math.radians(lean)) * (z - start) * f
        sway = bend * math.sin(math.pi * f)
        pts.append(Vector((lx * off + bx * sway, ly * off + by * sway, z)))
    return pts


def trunk_radius(z, top, base=0.19, tip=0.065):
    """The trunk's lathe profile: a flared foot, the contract's 0.14 from y 0.25
    to 0.45, then a taper to `tip` at the spine's top."""
    if z <= 0.25:
        return base + (TRUNK_RADIUS - base) * min(z / 0.25, 1.0) ** 0.6
    if z <= 0.45:
        return TRUNK_RADIUS
    return TRUNK_RADIUS + (tip - TRUNK_RADIUS) * min((z - 0.45) / max(top - 0.45, 1e-6), 1.0)


def trunk(t, spine, n=8, lod_n=6, scale=1.0, noise_amp=0.012, symmetric=False, base=0.19, tip=0.065):
    """Bark and Bark_LOD1 trunks along `spine` (§4.2 step 1): the profile swept
    up the spine, its radii at the canopy's build scale, seeded noise ≤ 0.012."""
    top = spine[-1].z
    radii = [trunk_radius(p.z / scale, top / scale, base, tip) * scale for p in spine]
    part = C.tube(spine, radii, n=n, cap_end=True, uv_rect=BARK_UV)
    if not symmetric:
        C.displace(part, lambda co: noise_amp * scale * nz(co, len(t.name), 4.0, 2))
        for v in part.verts:
            v.co.z = max(v.co.z, 0.0)
    t.bark.add(part, color=bark_colour(t.height), smooth=60)
    keep = [0, next(i for i, p in enumerate(spine) if p.z > 0.2 * scale), len(spine) - 1]
    lod = C.tube([spine[i] for i in keep], [radii[i] for i in keep], n=lod_n, cap_end=True, uv_rect=BARK_UV)
    t.bark1.add(lod, color=bark_colour(t.height), smooth=60)


def limb(t, start, control, end, r0, r1, n=5, steps=3):
    """§4.2 step 3: a tapered limb along a spline from its fork."""
    pts = bezier(start, control, end, steps)
    radii = [r0 + (r1 - r0) * i / steps for i in range(steps + 1)]
    t.bark.add(C.tube(pts, radii, n=n, cap_end=True, uv_rect=BARK_UV), color=bark_colour(t.height), smooth=60)


def roots(t, count, reach, top, scale):
    """§3.2: buttress roots — flattened fins below y 0.25 (`top` is already in
    build units), reaching `reach` from the axis."""
    for i in range(count):
        a = 2 * math.pi * i / count + t.uniform(-0.25, 0.25)
        d = Vector((math.cos(a), math.sin(a), 0.0))
        s = Vector((-d.y, d.x, 0.0)) * (0.025 * scale)
        inner, outer = d * (0.06 * scale), d * (reach * t.uniform(0.85, 1.1) * scale)
        bm = bmesh.new()
        layer = bm.loops.layers.uv.new('UVMap')
        v = [bm.verts.new(p) for p in (inner - s, outer - s, inner - s + Vector((0, 0, top)),
                                       inner + s, outer + s, inner + s + Vector((0, 0, top)))]
        faces = [bm.faces.new([v[0], v[1], v[2]]), bm.faces.new([v[3], v[5], v[4]]), bm.faces.new([v[1], v[4], v[5], v[2]])]
        u0, v0, u1, v1 = BARK_UV
        for f in faces:
            for loop in f.loops:
                co = loop.vert.co
                loop[layer].uv = (u0 + (u1 - u0) * min(1.0, (co - inner).length / (reach * 1.2 * scale)),
                                  v0 + (v1 - v0) * 0.2 * co.z / max(top, 1e-6))
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        t.bark.add(bm, color=bark_colour(t.height), smooth=None)


def lod_cards(t, count=6, tilt=12.0):
    """§3.2 LOD1: four to six large, nearly horizontal cards over the crown's
    clusters, sized to them (the orchard tree takes one per quadrant)."""
    clusters = sorted(t.clusters, key=lambda c: -(c[1] + 0.3 * Vector((c[0].x, c[0].y, 0)).length))[:count]
    for i, (c, r) in enumerate(clusters):
        out = Vector((c.x, c.y, 0.0))
        out = out.normalized() if out.length > 1e-6 else Vector((1, 0, 0))
        normal = Vector((0, 0, math.cos(math.radians(tilt)))) + out * math.sin(math.radians(tilt))
        part = card(c + Vector((0, 0, 0.05)), normal, r * 0.95, math.atan2(out.y, out.x) + math.pi / 4,
                    t.cells[i % 2], i % 4)
        t.leaf1.add(part, color=t.base_tint + (1.0,), smooth=180)


def leaf_extent(builder):
    return max(math.hypot(v.co.x, v.co.y) for v in builder.bm.verts)


def bend_normals(obj, centre, amount=0.7):
    """§3.2: each card's normals bent toward normalize(p − crownCentre) by `amount`."""
    mesh = obj.data
    normals = [None] * len(mesh.loops)
    for poly in mesh.polygons:
        n = Vector(poly.normal)
        if n.z < 0:
            n = -n
        for li in poly.loop_indices:
            p = mesh.vertices[mesh.loops[li].vertex_index].co
            radial = (p - centre).normalized()
            normals[li] = (n * (1 - amount) + radial * amount).normalized()
    mesh.normals_split_custom_set(normals)


def finish_tree(t, build_bark, lod1=6):
    """§4.2 steps 5–7: the bark is built at the canopy's own scale (so the trunk
    lands on 0.14 once the canopy is 1), the model is scaled so `Leaf`'s widest
    extent is 1, its lowest vertex sits on 0 and `Leaf`'s top is §3.2's height,
    LOD1's cards are fitted to the canopy and the leaf normals are bent."""
    extent = leaf_extent(t.leaf)
    top = max(v.co.z for v in t.leaf.bm.verts) / extent
    stretch = t.height / top
    # where the band's ring must be built so it lands on y 0.32 after both scalings
    build_bark(t, extent, TRUNK_BAND * extent / stretch)
    lod_cards(t, count=lod1)
    foliage = C.mat_vcol('Foliage', rough=0.8)
    objs = [t.bark.object('Bark', [foliage]), t.leaf.object('Leaf', [foliage]),
            t.bark1.object('Bark_LOD1', [foliage]), t.leaf1.object('Leaf_LOD1', [foliage])]
    if t.pods:
        objs.append(t.glow.object('Glow', [C.mat_flat('Glow', '#ffffff', emission=FOLIAGE_GLOW, strength=2.0)]))
    for obj in objs:
        obj.data.transform(Matrix.Scale(1 / extent, 4))
    z0 = min(v.co.z for obj in objs for v in obj.data.vertices)
    for obj in objs:
        obj.data.transform(Matrix.Translation((0, 0, -z0)))
    top = max(v.co.z for v in objs[1].data.vertices)
    for obj in objs:
        obj.data.transform(Matrix.Scale(t.height / top, 4, (0, 0, 1)))
    # LOD1's canopy within 0.90–1.05 of the axis: fitted to 0.97
    leaf1 = objs[3]
    r1 = max(math.hypot(v.co.x, v.co.y) for v in leaf1.data.vertices)
    leaf1.data.transform(Matrix.Scale(0.97 / r1, 4, (1, 0, 0)) @ Matrix.Scale(0.97 / r1, 4, (0, 1, 0)))
    vs = objs[1].data.vertices
    centre = Vector((0.0, 0.0, sum(v.co.z for v in vs) / len(vs)))
    bend_normals(objs[1], centre)
    bend_normals(leaf1, centre)
    return objs


# ---- the six trees (§3.2's table)


def spine_with_band(spine, band):
    """The spine with a ring exactly at `band` — where y 0.32 lands once the
    model is scaled — so the contract's band always holds a trunk ring."""
    pts = [p for p in spine if p.z < band - 0.04 or p.z > band + 0.06]
    pts.append(Vector((0.0, 0.0, band)))
    return sorted(pts, key=lambda p: p.z)


def hanging(t, count):
    """Pod anchors: under the clusters, outermost first."""
    ranked = sorted(t.clusters, key=lambda c: -Vector((c[0].x, c[0].y, 0.0)).length)
    anchors = []
    for i in range(count):
        c, r = ranked[i % len(ranked)]
        side = Vector((0.0, 0.0, 0.0)) if i < len(ranked) else Vector((r * 0.35, -r * 0.3, 0.0))
        anchors.append(c + side - Vector((0.0, 0.0, r * 0.45)))
    return anchors


def broadleaf_jungle(t, limbs, lean, lopsided, pod_count, buttress):
    """jungle_tree_a and _b: a trunk up to 0.75 of the height, limbs curving out
    from 0.55–0.75 of it, a broad-leaf cluster on each and one over the crown,
    and glowing seed pods hanging under them."""
    h = t.height
    lean_dir = t.uniform(0, 2 * math.pi)
    spine = spine_points(t, h * 0.75, lean=lean, lean_dir=lean_dir, bend=0.05)
    forks = [p for p in spine if h * 0.55 <= p.z <= h * 0.75 + 1e-6]
    crown = spine[-1]
    ends = []
    phase = t.uniform(0, 2 * math.pi)
    for i in range(limbs):
        a = phase + 2 * math.pi * i / limbs + t.uniform(-0.3, 0.3)
        if lopsided:
            a = lean_dir + math.remainder(a - lean_dir, 2 * math.pi) * 0.5
        start = forks[i % len(forks)]
        reach = t.uniform(0.46, 0.6)
        end = Vector((crown.x + math.cos(a) * reach, crown.y + math.sin(a) * reach, start.z + t.uniform(0.12, 0.3)))
        ends.append((start, end))
        cluster(t, end + Vector((0, 0, 0.1)), t.uniform(0.34, 0.4), t.rand.integers(21, 25) if limbs < 5 else t.rand.integers(19, 23), 0.2)
    cluster(t, crown + Vector((0, 0, 0.3)), 0.38, 24, 0.2)
    if limbs < 5:
        a = lean_dir if lopsided else phase + math.pi / limbs
        cluster(t, crown + Vector((math.cos(a) * 0.36, math.sin(a) * 0.36, 0.18)), 0.34, 22, 0.19)
    pods(t, hanging(t, pod_count))

    def build_bark(t, s, band):
        trunk(t, spine_with_band(spine, band), scale=s)
        for start, end in ends:
            limb(t, start, (start + end) / 2 + Vector((0, 0, 0.16)), end, 0.07 * s, 0.028 * s)
        if buttress:
            roots(t, buttress, 0.36, band * 0.62, s)
    return finish_tree(t, build_bark)


def fern_tree(t):
    """jungle_tree_c: one slender curved stem and a crown of twelve long fronds
    radiating and drooping (cells 4 and 5), five young ones at its heart."""
    h = t.height
    lean_dir = t.uniform(0, 2 * math.pi)
    spine = spine_points(t, h * 0.9, lean=4.0, lean_dir=lean_dir, bend=0.09, start=0.45)
    crown = spine[-1]
    phase = t.uniform(0, 2 * math.pi)
    for i in range(12):
        a = phase + 2 * math.pi * i / 12 + t.uniform(-0.12, 0.12)
        d = Vector((math.cos(a), math.sin(a), 0.0))
        side = Vector((-d.y, d.x, 0.0))
        length = t.uniform(0.9, 1.0)
        p = crown + d * 0.04 + Vector((0, 0, 0.02))
        pts = [p]
        for pitch in (26, 10, -14, -34):
            pr = math.radians(pitch + t.uniform(-3, 3))
            p = p + (d * math.cos(pr) + Vector((0, 0, math.sin(pr)))) * (length / 4)
            pts.append(p)
        value = t.uniform(0.9, 1.1)
        colour = tuple(min(1.0, c * value) for c in hue_shift(t.base_tint, t.uniform(-4, 4))) + (1.0,)
        t.leaf.add(strip(pts, [0.05, 0.2, 0.24, 0.18, 0.05], [side] * 5, t.cells[i % 2], t.rand.integers(0, 2) == 1),
                   color=colour, smooth=180)
        if i % 2 == 0:
            t.clusters.append((crown + d * 0.55 + Vector((0, 0, 0.02)), 0.3))
    for i in range(5):
        a = phase + 2 * math.pi * (i + 0.5) / 5
        d = Vector((math.cos(a), math.sin(a), 0.0))
        p = crown + Vector((0, 0, 0.03))
        pts = [p]
        for pitch in (38, 24, 6):
            pr = math.radians(pitch)
            p = p + (d * math.cos(pr) + Vector((0, 0, math.sin(pr)))) * 0.14
            pts.append(p)
        t.leaf.add(strip(pts, [0.04, 0.12, 0.12, 0.03], [Vector((-d.y, d.x, 0.0))] * 4, t.cells[i % 2], False),
                   color=t.base_tint + (1.0,), smooth=180)

    def build_bark(t, s, band):
        trunk(t, spine_with_band(spine, band), n=7, scale=s, base=0.17, tip=0.06)
    return finish_tree(t, build_bark)


def broadleaf_temperate(t, limbs, leader, quadrants=False):
    """temperate_tree_a (a fork at 0.45 of the height into four limbs and a
    rounded crown), temperate_tree_b (a narrower, taller crown on a single
    leader) and, with `quadrants`, temperate_tree_c — Eden's orchard tree: a
    straight trunk to 0.7 of its height, four limbs at exact 90° steps, and one
    quadrant of clusters turned by 90°, 180° and 270° with the same draws, so
    it is exactly four-fold symmetric, colours included (§4.2)."""
    h = t.height
    ends = []
    if quadrants:
        fork = h * 0.7
        spine = [Vector((0, 0, z)) for z in (0.0, 0.12, 0.45, fork * 0.8, fork)]
        quarter = [(Vector((0.5, 0.0, fork + 0.3)), 0.32, 16, 0.16),
                   (Vector((0.4, 0.4, fork + 0.42)), 0.29, 14, 0.16),
                   (Vector((0.15, 0.06, fork + 0.6)), 0.22, 9, 0.15)]
        for q in range(4):
            turn = Matrix.Rotation(q * math.pi / 2, 3, 'Z')
            t.rand = T.Rand(T.name_seed(f'{t.name}/quadrant'))   # every quadrant draws the same numbers
            for centre, radius, count, half in quarter:
                cluster(t, centre, radius, count, half, turn=turn)
        t.rand = T.Rand(T.name_seed(t.name))
        ends.append((spine[-1], Vector((0.48, 0.0, fork + 0.22))))
    elif leader:
        spine = spine_points(t, h * 0.82, bend=0.03, start=0.45)
        phase = t.uniform(0, 2 * math.pi)
        for i, (f, reach, rad) in enumerate(((0.42, 0.6, 0.33), (0.52, 0.58, 0.33), (0.62, 0.54, 0.31),
                                             (0.71, 0.46, 0.29), (0.8, 0.34, 0.27))):
            a = phase + i * 2.4 + t.uniform(-0.2, 0.2)
            start = min(spine, key=lambda p: abs(p.z - h * f))
            end = start + Vector((math.cos(a) * reach, math.sin(a) * reach, 0.14))
            ends.append((start, end))
            cluster(t, end + Vector((0, 0, 0.06)), rad, t.rand.integers(19, 23), 0.15)
        cluster(t, spine[-1] + Vector((0, 0, 0.22)), 0.3, 22, 0.15)
        cluster(t, spine[-1] + Vector((0.08, -0.1, -0.36)), 0.34, 20, 0.15)
    else:
        spine = spine_points(t, h * 0.45, bend=0.03, start=0.42)
        phase = t.uniform(0, 2 * math.pi)
        for i in range(limbs):
            a = phase + 2 * math.pi * i / limbs + t.uniform(-0.25, 0.25)
            reach = t.uniform(0.42, 0.56)
            end = spine[-1] + Vector((math.cos(a) * reach, math.sin(a) * reach, h * t.uniform(0.27, 0.35)))
            ends.append((spine[-1], end))
            cluster(t, end + Vector((0, 0, 0.1)), t.uniform(0.32, 0.38), t.rand.integers(24, 29), 0.15)
        cluster(t, spine[-1] + Vector((0.05, 0.0, h * 0.48)), 0.36, 28, 0.15)
        a = phase + math.pi / limbs
        cluster(t, spine[-1] + Vector((math.cos(a) * 0.3, math.sin(a) * 0.3, h * 0.4)), 0.32, 22, 0.15)

    def build_bark(t, s, band):
        trunk(t, spine_with_band(spine, band), scale=s, symmetric=quadrants)
        for start, end in ends:
            mid = (start + end) / 2 + Vector((0, 0, 0.12))
            if quadrants:
                for q in range(4):   # one limb, turned: the four are identical
                    part = C.place(C.tube(bezier(start, mid, end, 3), [0.065 * s, 0.05 * s, 0.04 * s, 0.03 * s],
                                          n=4, cap_end=True, uv_rect=BARK_UV), rot=(0, 0, 90 * q))
                    t.bark.add(part, color=bark_colour(t.height), smooth=60)
            else:
                limb(t, start, mid, end, 0.06 * s, 0.026 * s)
    return finish_tree(t, build_bark, lod1=4 if quadrants else 6)


def jungle_tree(t, seed, variant):
    """The jungle tree kind (§3.2): `a` buttress-rooted with five limbs, `b`
    three limbs, a 6° lean and a lopsided crown, `c` a fern tree."""
    if variant == 0:
        t.base_tint = (0.86, 0.95, 0.82)
        return broadleaf_jungle(t, limbs=5, lean=0.0, lopsided=False, pod_count=5, buttress=5)
    if variant == 1:
        t.base_tint = (0.9, 0.96, 0.8)
        return broadleaf_jungle(t, limbs=3, lean=6.0, lopsided=True, pod_count=4, buttress=4)
    t.base_tint = (0.88, 0.97, 0.86)
    return fern_tree(t)


def temperate_tree(t, seed, variant):
    """The temperate tree kind (§3.2): `a` forks at 0.45 into four limbs, `b` is
    a narrower crown on a single leader, `c` is Eden's orchard tree."""
    if variant == 0:
        t.base_tint = (0.94, 0.96, 0.86)
        return broadleaf_temperate(t, limbs=4, leader=False)
    if variant == 1:
        t.base_tint = (0.9, 0.95, 0.88)
        return broadleaf_temperate(t, limbs=0, leader=True)
    t.base_tint = (0.92, 0.97, 0.88)
    return broadleaf_temperate(t, limbs=4, leader=False, quadrants=True)


# ---------------------------------------------------------- dressing (_c)
# SPEC-052 §3.4: a third, mid-scale shape per kind — the `_c` — so the walk
# between objectives is not an empty plane. Unit props like the `a` and `b`
# (unit_footprint scales them), ≤ 350 triangles each; heights are §3.4's.


def desert_rock_c(b, seed):
    """A wind-cut rock stack in layered bands, 1.6 tall."""
    bands = ((0.0, 0.42, 0.95), (0.38, 0.38, 0.62), (0.7, 0.42, 0.86), (1.08, 0.5, 0.58))
    for i, (z, h, r) in enumerate(bands):
        tone = ('#a8703f', '#c08a54', '#b47a46', '#cf9d64')[i]
        part = boulder(seed + i, subdiv=2, squat=1.0, rough=0.12, ridge=0.08)
        C.place(part, (0.05 * math.sin(i * 2.1), 0.06 * math.cos(i * 1.7), z + h * 0.45), scale=(r, r * 0.9, h * 0.62))
        b.add(part, color=shade(tone, '#e0bb85', seed + i, top_from=0.7, height=1.6), smooth=None)


def desert_ruin_c(b, seed):
    """A half-buried wurm rib cage: five ribs arching out of a sand mound, 1.2 tall."""
    b.add(lathe([(1.0, 0.0), (0.85, 0.1), (0.55, 0.2), (0.0, 0.26)], n=12),
          color=shade('#c9a068', '#e3c690', seed, top_from=0.3, height=0.4), smooth=40)
    bone = shade('#cdbf9f', '#ebe2c8', seed + 1, top_from=0.6, ground=0.75, height=1.2)
    for i in range(5):
        x = -0.62 + 0.31 * i
        h = 1.2 - 0.16 * abs(i - 1.2)
        span = 0.62 - 0.05 * abs(i - 2)
        pts = [Vector((x + 0.04 * math.sin(k), span * math.cos(math.pi * k / 5), 0.05 + h * math.sin(math.pi * k / 5)))
               for k in range(6)]
        r = 0.05 - 0.004 * abs(i - 2)
        b.add(C.tube(pts, [r * 1.3, r * 1.1, r * 0.9, r * 0.9, r * 1.1, r * 1.3], n=5, cap_start=False, cap_end=False),
              color=bone, smooth=60)


def ice_rock_c(b, seed):
    """A survey cairn: stacked stones, a pole and a tattered red flag, 1.4 tall."""
    stone = shade('#7f98ab', '#f1f7fb', seed, top_from=0.4, height=1.0)
    stack = ((0.0, 0.0, 0.0, 0.55, 2), (0.42, 0.3, 0.0, 0.38, 2), (-0.36, 0.34, 0.0, 0.34, 2),
             (0.05, 0.05, 0.38, 0.38, 1), (0.0, 0.0, 0.66, 0.28, 1), (0.02, -0.02, 0.86, 0.2, 1))
    for i, (x, y, z, r, sub) in enumerate(stack):
        part = boulder(seed + i, subdiv=sub, squat=0.7, rough=0.18)
        b.add(C.place(part, (x, y, z + r * 0.45), scale=(r, r, r)), color=stone, smooth=None)
    b.add(C.place(cyl(0.025, 0.02, 1.0, n=6), (0.0, 0.0, 0.9)), color=shade('#4a3b2c', seed=seed + 7), smooth=None)
    flag = bmesh.new()
    pts = [(0.0, 0.0, 1.38), (0.0, 0.0, 1.16), (0.17, 0.02, 1.37), (0.15, 0.05, 1.18), (0.3, 0.0, 1.33), (0.27, 0.07, 1.22)]
    vs = [flag.verts.new(p) for p in pts]
    for quad in ((0, 1, 3, 2), (2, 3, 5, 4)):
        flag.faces.new([vs[k] for k in quad])
    b.add(flag, color=C.lin('#b8322a'), smooth=None)


def ice_spire_c(b, seed):
    """A cluster of 5–7 shards around a tall one, 2.2 tall; a faint core on Glow."""
    ice = shade('#a9dcf2', '#e8f8ff', seed, top_from=0.9, ground=0.8, height=2.2)
    b.add(C.place(cyl(0.3, 0.02, 2.2, n=6), (0, 0, 1.08)), color=ice, smooth=None)
    for i in range(6):
        a = math.radians(i * 60 + 17 * (i % 3))
        h = 0.9 + 0.5 * ((i * 37) % 10) / 10
        x, y = 0.42 * math.cos(a), 0.42 * math.sin(a)
        b.add(C.place(cyl(0.2, 0.02, h, n=6), (x, y, h / 2 - 0.04), (-18 * math.sin(a), 18 * math.cos(a), i * 23)),
              color=ice, smooth=None)
    b.add(C.place(cyl(0.11, 0.03, 1.7, n=6), (0, 0, 0.85)), mat=1, smooth=None)
    b.add(boulder(seed + 3, subdiv=2, squat=0.25, rough=0.12), color=shade('#8aa3b5', '#eef6fb', seed + 3), smooth=None)


def jungle_ruin_c(b, seed):
    """A broken column wrapped in roots, its capital fallen beside it, 1.6 tall."""
    stone = shade('#7a8074', '#56863a', seed, top_from=0.55, height=1.6)
    col = cyl(0.26, 0.24, 1.45, n=10)
    C.displace(col, lambda co: 0.05 * nz(co, seed, 5.0) if co.z > 0.6 else 0.0)
    b.add(C.place(col, (0, 0, 0.88)), color=stone, smooth=30)
    b.add(C.place(box(0.72, 0.72, 0.16, 0.03), (0, 0, 0.08)), color=shade('#6b7066', '#56863a', seed + 1), smooth=None)
    b.add(C.place(box(0.62, 0.62, 0.22, 0.03), (0.78, 0.38, 0.24), (8, 74, 31)), color=stone, smooth=None)
    root = shade('#4a3a28', '#5d6a2e', seed + 2, height=1.6)
    for i in range(4):
        a0 = i * math.pi / 2 + 0.3
        pts = []
        for k in range(6):
            a = a0 + k * 0.55
            r = 0.29 + (0.3 * (1 - k / 3) if k < 2 else 0.0)
            pts.append((r * math.cos(a), r * math.sin(a), 1.25 - k * 0.24))
        b.add(C.tube(pts, [0.04, 0.045, 0.05, 0.055, 0.06, 0.07], n=4, cap_start=False), color=root, smooth=60)


def volcanic_rock_c(b, seed):
    """A basalt column cluster: 7–9 hexagonal prisms in steps, 1.4 tall; hairline lava on Glow."""
    rock = shade('#3a302b', '#4e423a', seed, ground=0.7, height=1.4)
    cols = ((0.0, 0.0, 1.4), (0.36, 0.1, 1.15), (-0.32, 0.2, 1.0), (0.1, 0.38, 0.85), (0.12, -0.38, 0.95),
            (-0.3, -0.28, 0.7), (0.62, -0.2, 0.55), (-0.62, -0.05, 0.45))
    for i, (x, y, h) in enumerate(cols):
        b.add(C.place(cyl(0.2, 0.2, h, n=6), (x, y, h / 2), (0, 0, 9 * i)), color=rock, smooth=None)
    for i, (x, y, a) in enumerate(((0.18, 0.05, 15), (-0.16, 0.1, 70), (0.12, -0.19, 120), (-0.15, -0.13, 40))):
        b.add(C.place(box(0.32, 0.018, 0.02), (x, y, 0.012 + 0.002 * i), (0, 0, a)), mat=1, smooth=None)


def volcanic_vent_c(b, seed):
    """A slag heap with a derelict ore cart on it; cooling slag on Glow."""
    slag = shade('#2e2622', '#463a33', seed, ground=0.75, height=0.8)
    heap = boulder(seed, subdiv=2, squat=0.45, rough=0.22, ridge=0.1)
    b.add(C.place(heap, (0, 0, 0), scale=(1.0, 0.85, 1.0)), color=slag,
          mat=lambda c, n: 1 if c.z < 0.22 and abs(nz(c, seed + 9, 3.0, 2)) < 0.08 else 0, smooth=None)
    for i, (x, y) in enumerate(((0.7, -0.45), (-0.62, 0.5), (0.2, 0.75))):
        b.add(C.place(ico(0.16, 1), (x, y, 0.08)), mat=1 if i == 0 else 0, color=slag, smooth=None)
    metal = shade('#5a4b3c', '#7a6650', seed + 4, ground=0.8, height=0.9)
    cart = (0.0, 0.0, 0.5)
    b.add(C.place(box(0.62, 0.42, 0.3, 0.025), (cart[0], cart[1], cart[2] + 0.2), (0, -14, 20)), color=metal, smooth=None)
    for sx in (-1, 1):
        for sy in (-1, 1):
            b.add(C.place(cyl(0.1, 0.1, 0.05, n=6), (sx * 0.22, sy * 0.24, cart[2] - 0.0 + 0.04 * sx), (90, 0, 20)),
                  color=shade('#3a3430', seed=seed + 5), smooth=None)


def hive_spire_c(b, seed):
    """A chitin rib arch of three ribs meeting overhead, 2.0 tall; vein rings on Glow."""
    chitin = shade('#5b4078', '#7a5a9a', seed, top_from=0.6, ground=0.6, height=2.0)
    for i in range(3):
        a = math.radians(i * 120 + 10)
        foot = Vector((0.88 * math.cos(a), 0.88 * math.sin(a), 0.0))
        pts = [foot.lerp(Vector((0, 0, 0)), k / 6) + Vector((0, 0, 2.0 * math.sin(math.pi / 2 * k / 6)))
               for k in range(7)]
        pts[-1] = Vector((0, 0, 1.92))
        b.add(C.tube(pts, [0.12, 0.11, 0.1, 0.09, 0.08, 0.07, 0.07], n=5, cap_start=False), color=chitin, smooth=55)
        # a vein ring round the rib, a third of the way up
        b.add(C.along(torus(0.115, 0.03, n=8, m=3), pts[2] - (pts[3] - pts[1]) * 0.08, pts[2] + (pts[3] - pts[1]) * 0.08),
              mat=1, smooth=None)


def hive_rock_c(b, seed):
    """An egg cluster: 5–7 eggs in a chitin cup; the eggs on Glow."""
    b.add(lathe([(0.58, 0.0), (0.92, 0.18), (1.0, 0.42), (0.86, 0.5), (0.74, 0.32)], n=12),
          color=shade('#4b3a5c', '#6a5480', seed, top_from=0.5, height=0.6), smooth=45)
    for i in range(6):
        a = math.radians(i * 60 + 12)
        r = 0.42 if i else 0.0
        h = 0.4 + 0.08 * (i % 3)
        egg = sphere(1.0, 6, 4)
        b.add(C.place(egg, (r * math.cos(a), r * math.sin(a), 0.22 + h * 0.5), (12 * math.sin(a), 12 * math.cos(a), 0),
                      (0.22, 0.22, h * 0.5)), mat=1, smooth=70)


def temperate_rock_c(b, seed):
    """A dry-stone wall segment with a stile, 0.9 tall."""
    rows = ((0.0, 0.3, 7), (0.3, 0.28, 7), (0.58, 0.24, 6))
    for r, (z, h, n) in enumerate(rows):
        length = 1.9 - 0.1 * r
        for k in range(n):
            w = length / n
            x = -length / 2 + w * (k + 0.5) + (0.04 if r % 2 else -0.04)
            tone = ('#8c8a82', '#9a978c', '#7e7c74')[(k + r) % 3]
            stone = box(w * 0.94, 0.36 - 0.05 * r, h * 0.92)
            C.place(stone, (x, 0.0, z + h / 2), (0, 2 * ((k * 7 + r) % 3 - 1), 3 * ((k * 5 + r) % 3 - 1)))
            b.add(stone, color=shade(tone, '#6b9a52', seed + k, top_from=0.75, height=0.9), smooth=None)
    for i in range(3):
        b.add(C.place(box(0.34, 0.14, 0.06), (0.25, 0.25, 0.2 + 0.24 * i), (0, 0, 0)),
              color=shade('#8c8a82', '#6b9a52', seed + 20 + i, top_from=0.75, height=0.9), smooth=None)
        b.add(C.place(box(0.34, 0.14, 0.06), (0.25, -0.25, 0.2 + 0.24 * i), (0, 0, 0)),
              color=shade('#8c8a82', '#6b9a52', seed + 30 + i, top_from=0.75, height=0.9), smooth=None)


# ---------------------------------------------------------------- landmarks
# SPEC-052 §3.5, §4.4: one set piece per biome, authored in metres (not a unit
# prop — never through unit_footprint), base at 0, origin at the base centre,
# ≤ 900 triangles, `Body` in vertex colours plus `Glow` where it glows.


def landmark_desert(b):
    """Buried Ruin: the top storey of a buried pre-war building — a doorframe, a
    row of windows, a leaning slab of wall, sand drifted against it. 5 m."""
    wall = shade('#b9a58a', '#d7c6a6', 41, top_from=0.7, ground=0.7, height=4.0)
    dark = shade('#8a7a63', seed=42, height=4.0)
    b.add(C.place(box(6.0, 0.45, 1.1), (0, 0, 0.55)), color=wall, smooth=None)            # sill band
    b.add(C.place(box(6.0, 0.45, 0.7), (0, 0, 3.15)), color=wall, smooth=None)            # lintel band
    for x in (-2.85, -1.55, -0.3, 1.3, 2.85):                                              # piers
        b.add(C.place(box(0.3 if abs(x) > 2.8 else 0.45, 0.45, 1.7), (x, 0, 1.95)), color=wall, smooth=None)
    for x in (-2.2, -0.95, 0.5):                                                           # window reveals
        b.add(C.place(box(0.95, 0.12, 1.7), (x, 0.2, 1.95)), color=dark, smooth=None)
    b.add(C.place(box(0.25, 0.6, 2.6), (1.75, 0.0, 1.3)), color=wall, smooth=None)       # doorframe
    b.add(C.place(box(0.25, 0.6, 2.6), (2.55, 0.0, 1.3)), color=wall, smooth=None)
    b.add(C.place(box(1.05, 0.6, 0.3), (2.15, 0.0, 2.7)), color=wall, smooth=None)
    b.add(C.place(box(2.6, 0.35, 4.2), (-1.4, -0.9, 2.0), (-14, 0, 6)), color=wall, smooth=None)  # leaning slab
    b.add(C.place(box(1.4, 0.45, 1.5), (-2.3, 0.0, 4.25)), color=wall, smooth=None)       # a parapet stub
    for x, y, r, h in ((-1.5, 1.0, 1.7, 1.4), (1.4, 0.9, 1.5, 1.1), (0.2, -1.3, 1.6, 0.9), (2.3, -0.8, 1.0, 0.8)):
        drift = boulder(43 + int(x * 10), subdiv=2, squat=1.0, rough=0.06)
        b.add(C.place(drift, (x, y, 0), scale=(r, r * 0.8, h)), color=shade('#c9a068', '#e3c690', 44, top_from=0.4,
                                                                              height=1.5), smooth=40)


def landmark_ice(b):
    """Ice Spire: a spire of fused shards with a frozen dark core, and a ring of
    fallen shards; the core faintly glowing. 7 m."""
    ice = shade('#a9dcf2', '#eaf8ff', 51, top_from=0.9, ground=0.8, height=7.0)
    for i, (x, y, h, r, tilt) in enumerate(((0, 0, 7.0, 0.9, 0), (0.6, 0.3, 5.2, 0.6, 7), (-0.55, 0.4, 5.8, 0.65, -6),
                                            (0.1, -0.7, 4.6, 0.55, 8), (-0.3, -0.5, 3.6, 0.5, -9), (0.7, -0.4, 3.0, 0.45, 10),
                                            (-0.8, -0.1, 2.6, 0.45, -11))):
        b.add(C.place(cyl(r, 0.05, h, n=6), (x, y, h / 2 - 0.1), (tilt * 0.7, tilt, i * 21)), color=ice, smooth=None)
    b.add(C.place(cyl(0.32, 0.08, 5.6, n=6), (0, 0, 2.8)), mat=1, smooth=None)
    for i in range(8):
        a = math.radians(i * 45 + 13)
        r = 2.35 + 0.3 * (i % 3) / 2
        h = 0.9 + 0.4 * ((i * 3) % 4) / 3
        b.add(C.place(cyl(0.22, 0.04, h, n=6), (r * math.cos(a), r * math.sin(a), 0.16), (78, 0, math.degrees(a) + 90 + 20 * (i % 2))),
              color=ice, smooth=None)
    b.add(C.place(boulder(52, subdiv=2, squat=0.18, rough=0.12), scale=(2.0, 2.0, 2.0)),
          color=shade('#8aa3b5', '#eef6fb', 53, top_from=0.3, height=1.0), smooth=None)


def landmark_jungle(b):
    """Overgrown Ruin: a ruined gate of two piers and a lintel, with roots and
    hanging vines. 6 m."""
    stone = shade('#7a8074', '#56863a', 61, top_from=0.55, height=6.0)
    for x in (-1.9, 1.9):
        b.add(C.place(box(1.1, 1.1, 5.0, 0.06), (x, 0, 2.6)), color=stone, smooth=None)
        b.add(C.place(box(1.5, 1.5, 0.4, 0.05), (x, 0, 0.2)), color=shade('#6b7066', '#56863a', 62), smooth=None)
    b.add(C.place(box(5.2, 1.2, 0.85, 0.06), (0.0, 0.0, 5.5), (0, 2.5, 0)), color=stone, smooth=None)
    b.add(C.place(box(1.3, 1.0, 0.6, 0.05), (2.6, 1.2, 0.3), (12, 6, 34)), color=stone, smooth=None)
    root = shade('#4a3a28', '#5d6a2e', 63, height=6.0)
    for i, x in enumerate((-1.9, -1.9, 1.9, 1.9)):
        side = 1 if i % 2 else -1
        pts = [(x + 0.3 * side, 0.55 * side, 5.95), (x + 0.5 * side, 0.6 * side, 4.4), (x + 0.62 * side, 0.4 * side, 2.8),
               (x + 0.6 * side, 0.62 * side, 1.3), (x + 0.95 * side, 1.1 * side, 0.02)]
        b.add(C.tube(pts, [0.09, 0.12, 0.14, 0.16, 0.2], n=5, cap_start=False), color=root, smooth=60)
    vine = shade('#3f6e2a', '#56863a', 64, height=6.0)
    for i in range(8):
        x = -1.2 + 0.34 * i
        drop = 1.2 + 1.6 * ((i * 5) % 7) / 7
        pts = [(x, -0.62, 5.15), (x + 0.05, -0.68, 5.15 - drop * 0.5), (x - 0.04, -0.66, 5.15 - drop)]
        b.add(C.tube(pts, [0.04, 0.035, 0.025], n=4, cap_start=False), color=vine, smooth=60)
    b.add(C.place(boulder(65, subdiv=2, squat=0.2, rough=0.2), scale=(3.0, 2.2, 2.0)),
          color=shade('#4f6b39', '#6f9a4a', 66), smooth=40)


def on_profile(profile, r):
    """The height of a lathe profile [(r, z)…] (r falling) at radius r."""
    for (r0, z0), (r1, z1) in zip(profile, profile[1:]):
        if r1 <= r <= r0:
            return z0 + (z1 - z0) * (r0 - r) / (r0 - r1)
    return profile[-1][1] if r < profile[-1][0] else profile[0][1]


def landmark_volcanic(b):
    """Lava Vent: a cinder cone with a glowing throat and two lava runnels down
    its flank. 4 m."""
    profile = [(4.2, 0.0), (3.5, 0.6), (2.4, 2.0), (1.4, 3.6), (1.0, 4.0), (0.7, 3.7), (0.55, 3.0)]
    cone = lathe(profile, n=16)
    C.displace(cone, lambda co: 0.14 * nz(co, 71, 0.6))
    for v in cone.verts:
        v.co.z = max(v.co.z, 0.0)   # the rim stays on the ground
    b.add(cone, color=shade('#2e2622', '#4a3d35', 72, ground=0.7, height=4.0), smooth=45)
    b.add(C.place(cyl(0.62, 0.62, 0.1, n=12), (0, 0, 3.15)), mat=1, smooth=None)
    for i, a0 in enumerate((0.6, 2.4)):
        pts = []
        for k in range(8):
            f = k / 7
            r = 1.15 + 2.85 * f
            a = a0 + 0.25 * math.sin(f * 4 + i)
            pts.append((r * math.cos(a), r * math.sin(a), on_profile(profile[:5], r) + 0.06))
        b.add(C.tube(pts, [0.22, 0.24, 0.26, 0.28, 0.3, 0.3, 0.32, 0.34], n=4, cap_start=False), mat=1, smooth=None)
    for i in range(4):
        a = math.radians(i * 90 + 30)
        b.add(C.place(ico(0.45, 1), (3.9 * math.cos(a), 3.6 * math.sin(a), 0.2)),
              color=shade('#3a302b', '#4a3d36', 73 + i), smooth=None)


def landmark_hive(b):
    """Egg Cluster: a chitin mound ringed by seven eggs, the eggs glowing. 4 m."""
    mound = lathe([(2.2, 0.0), (2.0, 1.1), (1.5, 2.4), (0.9, 3.4), (0.35, 3.95), (0.0, 4.0)], n=14)
    C.displace(mound, lambda co: 0.12 * math.sin(co.z * 4.5) + 0.1 * nz(co, 81, 1.2))
    b.add(mound, color=shade('#4b3a5c', '#6a5480', 82, top_from=0.5, height=4.0), smooth=50)
    for i in range(7):
        a = math.radians(i * 360 / 7 + 9)
        h = 1.1 + 0.25 * (i % 3)
        b.add(C.place(sphere(1.0, 8, 6), (3.0 * math.cos(a), 3.0 * math.sin(a), h * 0.5),
                      (10 * math.sin(a), -10 * math.cos(a), 0), (0.55, 0.55, h * 0.5)), mat=1, smooth=70)


def landmark_temperate(b):
    """Grove: five identical clipped trees — straight trunks, perfectly
    spherical crowns — in a 3 m circle around a round stone basin. 5 m."""
    trunk_col = shade('#6b4a32', seed=91, ground=0.8, height=3.0)
    crown_col = shade('#5f8f45', '#7fb35a', 92, top_from=0.2, ground=1.0, height=5.0)
    for i in range(5):
        a = math.radians(i * 72 + 18)
        x, y = 3.0 * math.cos(a), 3.0 * math.sin(a)
        b.add(C.place(cyl(0.16, 0.13, 2.9, n=6), (x, y, 1.45)), color=trunk_col, smooth=None)
        b.add(C.place(sphere(1.15, 10, 7), (x, y, 3.85)), color=crown_col, smooth=80)
    b.add(lathe([(1.1, 0.0), (1.2, 0.5), (1.0, 0.55), (0.9, 0.35), (0.0, 0.35)], n=16),
          color=shade('#8c8a82', '#a5a297', 93, top_from=0.5, height=0.6), smooth=40)


# ------------------------------------------------------------------ tables

KINDS = {
    'desert_rock': desert_rock, 'desert_ruin': desert_ruin,
    'ice_rock': ice_rock, 'ice_spire': ice_spire,
    'jungle_tree': jungle_tree, 'jungle_ruin': jungle_ruin,
    'volcanic_rock': volcanic_rock, 'volcanic_vent': volcanic_vent,
    'hive_spire': hive_spire, 'hive_rock': hive_rock,
    'temperate_tree': temperate_tree, 'temperate_rock': temperate_rock,
}
# Built through the tree builder (§4.2) — every variant, `_c` included.
TREE_KINDS = ('jungle_tree', 'temperate_tree')
LANDMARKS = {
    'desert': landmark_desert, 'ice': landmark_ice, 'jungle': landmark_jungle,
    'volcanic': landmark_volcanic, 'hive': landmark_hive, 'temperate': landmark_temperate,
}
GLOW = {'ice': '#7fdcff', 'jungle': '#b8ff6a', 'volcanic': '#ff6a2a', 'hive': '#d66bff'}
# §3.5: the ice landmark's core glows faintly
LANDMARK_GLOW = {'ice': ('#7fdcff', 0.8), 'volcanic': ('#ff6a2a', 3.0), 'hive': ('#d66bff', 2.0)}
VARIANTS = (('a', 11), ('b', 23), ('c', 37))


def unit_footprint(obj):
    """Scale so the widest horizontal extent is radius 1 and the base sits on z 0."""
    vs = obj.data.vertices
    r = max(math.hypot(v.co.x, v.co.y) for v in vs)
    z0 = min(v.co.z for v in vs)
    obj.data.transform(Matrix.Scale(1 / r, 4) @ Matrix.Translation((0, 0, -z0)))


def base_on_ground(obj):
    """A landmark keeps its metres; only its lowest vertex moves to z 0."""
    z0 = min(v.co.z for v in obj.data.vertices)
    obj.data.transform(Matrix.Translation((0, 0, -z0)))


# --------------------------------------------------------------- previews
# Not shipped (§4.1): `--preview=DIR` writes the contact sheets the drop is
# judged from.


def preview_atlas_material(out_root):
    """The trees' preview look: Foliage with the committed atlas bound, alpha-clipped."""
    path = os.path.join(out_root, 'textures', 'foliage', 'atlas.webp')
    mat = bpy.data.materials.new('FoliagePreview')
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    tex = nt.nodes.new('ShaderNodeTexImage')
    tex.image = bpy.data.images.load(path)
    col = nt.nodes.new('ShaderNodeVertexColor')
    col.layer_name = 'Col'
    mul = nt.nodes.new('ShaderNodeMix')
    mul.data_type = 'RGBA'
    mul.blend_type = 'MULTIPLY'
    mul.inputs['Factor'].default_value = 1.0
    nt.links.new(tex.outputs['Color'], mul.inputs['A'])
    nt.links.new(col.outputs['Color'], mul.inputs['B'])
    nt.links.new(mul.outputs['Result'], bsdf.inputs['Base Color'])
    clip = nt.nodes.new('ShaderNodeMath')
    clip.operation = 'GREATER_THAN'
    clip.inputs[1].default_value = 0.5
    nt.links.new(tex.outputs['Alpha'], clip.inputs[0])
    nt.links.new(clip.outputs[0], bsdf.inputs['Alpha'])
    bsdf.inputs['Roughness'].default_value = 0.8
    mat.surface_render_method = 'DITHERED'
    return mat


def preview_ground(size, grey=0.3):
    """A 30 % grey ground under a preview."""
    plane = C.Builder(vcol=False)
    plane.add(C.place(box(size, size, 0.01), (0, 0, -0.005)), smooth=None)
    return plane.object('PreviewGround', [C.mat_flat('PreviewGrey', grey, rough=0.9)])


def preview_trees(objs, name, out_root, preview):
    """§4.2: each tree at LOD0 and at LOD1 with the atlas, on 30 % grey, from
    azimuth 35° and elevation 35°."""
    import preview as P
    mat = preview_atlas_material(out_root)
    for obj in objs:
        if obj.name != 'Glow':
            obj.data.materials[0] = mat
    ground = preview_ground(4.0)
    shots = []
    for lod, keep in (('lod0', ('Bark', 'Leaf', 'Glow')), ('lod1', ('Bark_LOD1', 'Leaf_LOD1'))):
        shown = [o for o in objs if o.name in keep]
        for o in objs:
            o.hide_render = o not in shown
        shots.append(P.render(shown + [ground], os.path.join(preview, f'tree_{name}_{lod}.png'),
                              azimuth=35, elevation=35, size=256, bg='#4d4d4d', focus=None))
    return shots


def preview_with_figure(objs, path, size=256, bg='#1a2029'):
    """§4.4: a landmark (or a cave piece) beside a 1.8 m salvager, for scale."""
    import preview as P
    import salvager as S
    lo = min(v.co.x for o in objs for v in o.data.vertices)
    arm, mesh = S.build(name='Scale')
    arm.location = (lo - 0.8, 0.0, 0.0)
    return P.render(objs + [mesh], path, azimuth=35, elevation=22, size=size, bg=bg)


# -------------------------------------------------------------------- main


def build_unit_prop(key, variant, seed, name):
    biome = key.split('_')[0]
    C.reset()
    mats = [C.mat_vcol('Body', rough=0.85 if biome != 'ice' else 0.25, metal=0.0)]
    mats.append(C.mat_flat('Glow', '#ffffff', emission=GLOW.get(biome, '#ffffff'), strength=2.0))
    b = C.Builder()
    KINDS[key](b, seed + len(key), variant)
    obj = b.object(name, mats)
    unit_footprint(obj)
    return [obj]


def build_tree(key, variant, seed, name):
    C.reset()
    t = TreeParts(name)
    return KINDS[key](t, seed + len(key), variant)


def build_landmark(biome, name):
    C.reset()
    glow, strength = LANDMARK_GLOW.get(biome, ('#ffffff', 2.0))
    mats = [C.mat_vcol('Body', rough=0.85 if biome != 'ice' else 0.3), C.mat_flat('Glow', '#ffffff', emission=glow, strength=strength)]
    b = C.Builder()
    LANDMARKS[biome](b)
    obj = b.object(name, mats)
    base_on_ground(obj)
    return [obj]


def main():
    opts = C.options()
    out = opts['out']
    shots = {'props': [], 'trees': [], 'landmarks': []}
    for key in KINDS:
        for index, (letter, seed) in enumerate(VARIANTS):
            name = f'{key}_{letter}'
            if not C.wanted(opts, name):
                continue
            tree = key in TREE_KINDS
            objs = build_tree(key, index, seed, name) if tree else build_unit_prop(key, index, seed, name)
            path = os.path.join(out, 'models', 'props', f'{name}.glb')
            # §4.2, §4.3: meshopt on every model; UVs on the trees alone
            C.export_glb(path, objs, texcoords=tree, meshopt=True)
            C.report(path, out)
            if opts['preview']:
                if tree:
                    shots['trees'] += preview_trees(objs, name, out, opts['preview'])
                else:
                    import preview as P
                    shots['props'].append(P.render(objs, os.path.join(opts['preview'], f'prop_{name}.png'),
                                                   azimuth=35, elevation=28, size=256))
    for biome in LANDMARKS:
        name = f'landmark_{biome}'
        if not C.wanted(opts, name):
            continue
        objs = build_landmark(biome, name)
        path = os.path.join(out, 'models', 'props', f'{name}.glb')
        C.export_glb(path, objs, texcoords=False, meshopt=True)
        C.report(path, out)
        if opts['preview']:
            shots['landmarks'].append(preview_with_figure(objs, os.path.join(opts['preview'], f'{name}.png')))
    if opts['preview']:
        import preview as P
        for sheet, cols in (('props', 6), ('trees', 4), ('landmarks', 3)):
            if shots[sheet]:
                P.sheet(shots[sheet], os.path.join(opts['preview'], f'sheet_{sheet}.png'), cols=cols)


main()
