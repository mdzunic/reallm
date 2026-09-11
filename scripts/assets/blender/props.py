# Surface props (SPEC-018 §4.7, the `PROP_MODELS` seam): models/props/
# <biome>_<kind>_<a|b>.glb for the twelve biome × obstacle-kind pairs of
# systems/Layout.ts. Each is a unit prop — footprint radius 1, base at z 0,
# origin at the base centre — because SurfaceView scales an obstacle by its
# radius. Biome colours are baked into vertex colours (`Body`, COLOR_0) with
# dust/snow/moss on top faces and darkening toward the ground; emissive parts
# (ice cores, lava, hive veins, spores) use a second `Glow` material.
import math
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'lib'))

from mathutils import Matrix, Vector, noise  # noqa: E402

import common as C  # noqa: E402

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


VAR = [0]  # 0 for the `a` variant, 1 for `b` — set by main() before each build


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


def desert_rock(b, seed):
    b.add(boulder(seed, squat=0.72, ridge=0.12, flat_top=0.5 + 0.1 * (VAR[0])),
          color=shade('#a8703f', '#d9b07a', seed), smooth=38, uv_scale=0.6)
    if VAR[0]:
        b.add(place(boulder(seed + 5, subdiv=2, squat=0.8), (0.95, -0.35, 0), scale=(0.35, 0.35, 0.35)),
              color=shade('#a8703f', '#d9b07a', seed + 5), smooth=38, uv_scale=0.6)


def desert_ruin(b, seed):
    stone = shade('#c49a62', '#dcc08a', seed, height=1.6)
    heights = (1.6, 1.1) if VAR[0] else (1.3, 0.8, 1.5)
    for i, h in enumerate(heights):
        x = -0.55 + i * (1.1 / max(1, len(heights) - 1))
        col = place(box(0.36, 0.36, h, 0.03), (x, 0.1 * (i % 2), h / 2))
        C.displace(col, lambda co, i=i: 0.03 * nz(co, seed + i, 5.0) if co.z > h - 0.25 else 0.0)
        b.add(col, color=stone, smooth=35, uv_scale=0.8)
        b.add(place(box(0.46, 0.46, 0.12, 0.02), (x, 0.1 * (i % 2), 0.06)), color=shade('#8a6a44', seed=seed), uv_scale=0.8)
    b.add(place(box(1.3, 0.3, 0.26, 0.03), (0.1, -0.55, 0.13), (0, 0, 12)), color=stone, uv_scale=0.8)
    b.add(place(box(0.34, 0.9, 0.3, 0.03), (0.45, 0.55, 0.15), (0, 70, 25)), color=stone, uv_scale=0.8)


def ice_rock(b, seed):
    b.add(boulder(seed, subdiv=2, squat=0.85, rough=0.22, ridge=0.2), color=shade('#7f98ab', '#f1f7fb', seed, top_from=0.35),
          smooth=None, uv_scale=0.6)


def ice_spire(b, seed):
    ice = shade('#a9dcf2', '#e8f8ff', seed, top_from=0.9, ground=0.8, height=2.6)
    shards = ((0, 0, 2.6, 0.34, 0), (0.42, 0.2, 1.7, 0.24, 14), (-0.35, 0.3, 1.9, 0.26, -12), (0.1, -0.45, 1.3, 0.2, 18))
    for i, (x, y, h, r, tilt) in enumerate(shards[: 3 + VAR[0]]):
        shard = cyl(r, 0.02, h, n=6)
        place(shard, (x, y, h / 2 - 0.05), (tilt * 0.6, tilt, i * 20))
        b.add(shard, color=ice, smooth=None, uv_scale=0.6)
    b.add(place(cyl(0.12, 0.03, 1.8, n=6), (0, 0, 0.9)), mat=1, smooth=None)
    b.add(boulder(seed + 3, subdiv=2, squat=0.3, rough=0.15), color=shade('#8aa3b5', '#eef6fb', seed + 3), smooth=None)


def jungle_tree(b, seed):
    """A giant bioluminescent mushroom."""
    h = 2.4 + 0.4 * (VAR[0])
    stem = lathe([(0.32, 0.0), (0.22, 0.3), (0.16, h * 0.6), (0.2, h - 0.2), (0.0, h - 0.1)], n=10)
    C.displace(stem, lambda co: 0.02 * nz(co, seed, 4.0))
    b.add(stem, color=shade('#d6ccb2', seed=seed, ground=0.7, height=h), smooth=60)
    cap = lathe([(0.0, h + 0.55), (0.6, h + 0.45), (1.0, h + 0.15), (1.1, h - 0.05), (0.9, h - 0.1), (0.25, h - 0.05)], n=16)
    C.displace(cap, lambda co: 0.05 * nz(co, seed + 2, 2.0))
    b.add(cap, color=shade('#2f6d78', '#3f8a95', seed + 2, top_from=0.4, ground=1.0, height=h), smooth=55)
    for i in range(7):
        a = math.radians(i * 51 + seed * 13)
        r = 0.45 + 0.35 * ((i * 37) % 10) / 10
        b.add(place(sphere(0.07, 6, 4), (r * math.cos(a), r * math.sin(a), h + 0.5 - 0.35 * r), scale=(1, 1, 0.5)), mat=1)
    b.add(place(torus(0.62, 0.05, n=16, m=4), (0, 0, h - 0.07)), mat=1, smooth=None)


def jungle_ruin(b, seed):
    stone = shade('#7a8074', '#56863a', seed, top_from=0.5, height=1.4)
    arch_h = 1.4
    for x in (-0.6, 0.6):
        b.add(place(box(0.34, 0.4, arch_h, 0.03), (x, 0, arch_h / 2)), color=stone, uv_scale=0.8)
    if VAR[0]:
        b.add(place(box(1.6, 0.44, 0.28, 0.03), (0, 0, arch_h + 0.14), (0, 4, 0)), color=stone, uv_scale=0.8)
    else:
        b.add(place(box(1.1, 0.4, 0.26, 0.03), (0.55, 0.5, 0.13), (0, 0, 30)), color=stone, uv_scale=0.8)
    for i in range(5):
        a = i * 1.3 + seed
        vine = along(cyl(0.025, 0.02, 1.2, n=5), (-0.6 + 0.3 * math.sin(a), -0.21, 1.35), (-0.5 + 0.35 * math.cos(a), -0.24, 0.1))
        b.add(vine, color=shade('#3f6e2a', seed=seed + i), smooth=60)
    b.add(boulder(seed + 7, subdiv=2, squat=0.25, rough=0.2), color=shade('#4f6b39', '#6f9a4a', seed), smooth=40)


def volcanic_rock(b, seed):
    b.add(boulder(seed, squat=0.78, rough=0.3, ridge=0.18), color=shade('#3a302b', '#4a3d36', seed, ground=0.7),
          mat=lambda c, n: 1 if abs(nz(c, seed + 5, 2.2, 2)) < 0.05 else 0, smooth=None, uv_scale=0.6)


def volcanic_vent(b, seed):
    rock = shade('#3b322d', '#51453c', seed, ground=0.75, height=1.1)
    cone = lathe([(1.0, 0.0), (0.82, 0.35), (0.55, 0.9), (0.42, 1.05), (0.34, 0.95), (0.3, 0.7)], n=14)
    C.displace(cone, lambda co: 0.06 * nz(co, seed, 2.5))
    b.add(cone, color=rock, mat=lambda c, n: 1 if c.z < 0.55 and abs(nz(c, seed + 9, 3.0, 2)) < 0.07 else 0, smooth=45)
    b.add(place(cyl(0.34, 0.3, 0.04, n=12), (0, 0, 0.74)), mat=1, smooth=None)
    for i in range(2 + VAR[0]):
        a = math.radians(i * 140 + seed * 30)
        b.add(place(boulder(seed + i, subdiv=2, squat=0.7), (0.95 * math.cos(a), 0.95 * math.sin(a), 0), scale=(0.28, 0.28, 0.28)),
              color=rock, smooth=None)


def hive_spire(b, seed):
    chitin = shade('#5b4078', '#7a5a9a', seed, top_from=0.6, ground=0.6, height=2.6)
    h = 2.6
    tower = lathe([(0.55, 0.0), (0.42, 0.4), (0.36, 1.0), (0.28, 1.6), (0.18, 2.2), (0.05, h), (0.0, h + 0.05)], n=12)
    C.displace(tower, lambda co: 0.06 * math.sin(co.z * 9 + seed) + 0.04 * nz(co, seed, 3.0))
    b.add(tower, color=chitin, smooth=50)
    for z, r in ((0.55, 0.43), (1.25, 0.34), (1.9, 0.24)):
        b.add(place(torus(r, 0.03, n=16, m=4), (0, 0, z)), mat=1, smooth=None)
    for i in range(3 + VAR[0]):
        a = math.radians(i * 100 + seed * 20)
        spike = along(cyl(0.09, 0.01, 0.8, n=6), (0.3 * math.cos(a), 0.3 * math.sin(a), 0.6 + 0.3 * i),
                      (0.85 * math.cos(a), 0.85 * math.sin(a), 1.0 + 0.35 * i))
        b.add(spike, color=shade('#3a2a4d', seed=seed + i), smooth=None)


def hive_rock(b, seed):
    b.add(boulder(seed, squat=0.7, rough=0.22), color=shade('#4b3a5c', '#6a5480', seed, top_from=0.5),
          mat=lambda c, n: 1 if n.z > 0.2 and nz(c, seed + 4, 3.5, 1) > 0.42 else 0, smooth=45)


def temperate_tree(b, seed):
    h = 1.6 + 0.3 * (VAR[0])
    trunk = lathe([(0.26, 0.0), (0.16, 0.25), (0.12, h * 0.7), (0.1, h), (0.0, h + 0.05)], n=8)
    C.displace(trunk, lambda co: 0.015 * nz(co, seed, 5.0))
    b.add(trunk, color=shade('#6b4a32', seed=seed, ground=0.75, height=h), smooth=60)
    leaves = shade('#4f8a3a', '#7fb35a', seed + 1, top_from=0.3, ground=1.0, height=h + 1.5)
    for i, (x, y, z, r) in enumerate(((0, 0, h + 0.55, 0.85), (0.5, 0.25, h + 0.15, 0.6), (-0.45, 0.3, h + 0.25, 0.62), (0.05, -0.5, h + 0.2, 0.58))):
        blob = place(ico(r, 2), (x, y, z), scale=(1, 1, 0.82))
        C.displace(blob, lambda co, i=i: 0.1 * nz(co, seed + i, 1.8))
        b.add(blob, color=leaves, smooth=None, uv_scale=0.6)


def temperate_rock(b, seed):
    b.add(boulder(seed, squat=0.75, rough=0.25), color=shade('#8c8a82', '#6b9a52', seed, top_from=0.6), smooth=40, uv_scale=0.6)


KINDS = {
    'desert_rock': desert_rock, 'desert_ruin': desert_ruin,
    'ice_rock': ice_rock, 'ice_spire': ice_spire,
    'jungle_tree': jungle_tree, 'jungle_ruin': jungle_ruin,
    'volcanic_rock': volcanic_rock, 'volcanic_vent': volcanic_vent,
    'hive_spire': hive_spire, 'hive_rock': hive_rock,
    'temperate_tree': temperate_tree, 'temperate_rock': temperate_rock,
}
GLOW = {'ice': '#7fdcff', 'jungle': '#b8ff6a', 'volcanic': '#ff6a2a', 'hive': '#d66bff'}


def unit_footprint(obj):
    """Scale so the widest horizontal extent is radius 1 and the base sits on z 0."""
    vs = obj.data.vertices
    r = max(math.hypot(v.co.x, v.co.y) for v in vs)
    z0 = min(v.co.z for v in vs)
    obj.data.transform(Matrix.Scale(1 / r, 4) @ Matrix.Translation((0, 0, -z0)))


def main():
    opts = C.options()
    made = []
    for key, build in KINDS.items():
        biome = key.split('_')[0]
        for index, (variant, seed) in enumerate((('a', 11), ('b', 23))):
            name = f'{key}_{variant}'
            if not C.wanted(opts, name):
                continue
            VAR[0] = index
            C.reset()
            mats = [C.mat_vcol('Body', rough=0.85 if biome != 'ice' else 0.25, metal=0.0)]
            mats.append(C.mat_flat('Glow', '#ffffff', emission=GLOW.get(biome, '#ffffff'), strength=2.0))
            b = C.Builder()
            build(b, seed + len(key))
            obj = b.object(name, mats)
            unit_footprint(obj)
            path = os.path.join(opts['out'], 'models', 'props', f'{name}.glb')
            C.export_glb(path, [obj])
            C.report(path, opts['out'])
            if opts['preview']:
                import preview as P
                made.append(P.render([obj], os.path.join(opts['preview'], f'prop_{name}.png'), azimuth=35, elevation=28, size=256))
    if opts['preview'] and made:
        import preview as P
        P.sheet(made, os.path.join(opts['preview'], 'sheet_props.png'), cols=6)


main()
