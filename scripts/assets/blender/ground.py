# Ground layers (SPEC-018 §4.5, §4.10; SPEC-052 §4.7): textures/ground/
# <layer>_albedo.webp (RGB albedo sRGB, A height — or the emissive crack/vein
# mask for lava_rock and flesh, which are always slot B) and <layer>_nr.webp
# (RGB OpenGL normal, A roughness), 512² each and seamless; and
# textures/ground/detail_nr.webp, a 256² micro normal (RGB OpenGL normal, A a
# roughness offset around 0.5) that SPEC-053 repeats every 1.2 m.
#
# Blender makes the fields: 4D Noise/Voronoi evaluated on a Clifford torus
# (UV → (cos 2πu, sin 2πu, cos 2πv, sin 2πv)/2π), so every field tiles exactly
# and a node's Scale is features per tile. Cycles bakes three fields per pass
# into a float image; numpy then shapes height, colours, cavity shading,
# roughness and normals, and packs the pair.
#
# SPEC-052 rewrote four recipes off the Voronoi cell field, which made the
# jungle floor a stained-glass patio, grass cobbles and chitin agate:
# jungle_floor is leaf litter (seeded leaf and twig stamps over fbm soil),
# grass is blades (fbm smeared 8× along a drifting direction, clover patches),
# moss is cushions (smoothed fbm thresholds, domed) and chitin is plates
# (smoothed fbm terracing, lit rims, pores). Their scatter draws from tex.Rand
# and every stamp and sample wraps round the tile, so the layers still tile
# exactly, and scripts/assets/standin/ground.mjs — the same recipes in Node,
# for a machine without Blender — puts the same leaves in the same places.
# Albedo is saved at ALBEDO_QUALITY, the four smooth layers' at
# SMOOTH_QUALITY, every normal map at NR_QUALITY.
import math
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'lib'))

import bpy  # noqa: E402
import numpy as np  # noqa: E402

import common as C  # noqa: E402
import tex as T  # noqa: E402
from nodes import Graph  # noqa: E402

SIZE = 512
DETAIL_SIZE = 256
ALBEDO_QUALITY = 90
SMOOTH_QUALITY = 92                    # snow, soil, moss, flesh
NR_QUALITY = 92
SMOOTH = {'snow', 'soil', 'moss', 'flesh'}
TAU = 2 * math.pi


# ---------------------------------------------------------------- field bake


def bake_fields(specs, size=SIZE):
    """specs: [(kind, scale, seed, extra kwargs)] → list of size×size arrays (row 0 = top)."""
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = 12
    scene.render.bake.margin = 0
    plane = bpy.data.objects.get('BakePlane')
    if plane is None:
        bpy.ops.mesh.primitive_plane_add(size=1)
        plane = bpy.context.active_object
        plane.name = 'BakePlane'
    out = []
    for start in range(0, len(specs), 3):
        group = specs[start:start + 3]
        mat = bpy.data.materials.new(f'fields{start}')
        mat.use_nodes = True
        g = Graph(mat)
        vec, w = g.torus()
        comb = g.node('ShaderNodeCombineColor')
        for i, (kind, scale, seed, kw) in enumerate(group):
            g.link(g.field(vec, w, kind, scale, seed, **kw), comb.inputs[i])
        emit = g.node('ShaderNodeEmission')
        g.link(comb.outputs[0], emit.inputs['Color'])
        outn = g.node('ShaderNodeOutputMaterial')
        g.link(emit.outputs[0], outn.inputs['Surface'])
        img = bpy.data.images.new(f'bake{start}', size, size, float_buffer=True)
        img.colorspace_settings.name = 'Non-Color'
        tn = g.node('ShaderNodeTexImage')
        tn.image = img
        g.nt.nodes.active = tn
        plane.data.materials.clear()
        plane.data.materials.append(mat)
        C.select_only([plane])
        bpy.ops.object.bake(type='EMIT')
        a = np.array(img.pixels[:], dtype=np.float32).reshape(size, size, 4)[::-1]
        out.extend(a[..., i].copy() for i in range(len(group)))
        bpy.data.images.remove(img)
    return out


# ------------------------------------------------------------------ recipes


def ramp(t, stops):
    t = np.clip(t, 0, 1)
    pos = np.array([p for p, _ in stops], np.float32)
    cols = np.array([C.lin(c)[:3] for _, c in stops], np.float32)
    return np.stack([np.interp(t, pos, cols[:, k]) for k in range(3)], -1).astype(np.float32)


def mixc(a, b, t):
    t = np.clip(t, 0, 1)[..., None]
    return a * (1 - t) + b * t


def col(hexstr):
    return np.array(C.lin(hexstr)[:3], np.float32)


ss = T.smoothstep
V = (np.arange(SIZE, dtype=np.float32)[:, None] + 0.5) / SIZE * np.ones((1, SIZE), np.float32)


# SPEC-052's recipes threshold their fields in standard deviations (norm), so
# a bake whose noise differs in detail still cuts the same share of the tile,
# and they stamp and sample through windows wrapped round the tile.


def norm(f):
    """A field in standard deviations about its mean."""
    return (f - f.mean()) / f.std()


def window(cx, cy, reach, size=SIZE):
    """The texels within `reach` of (cx, cy), wrapped round the tile: their
    index, and their offsets from the centre (dx a row vector, dy a column)."""
    xs = np.arange(math.floor(cx - reach), math.ceil(cx + reach) + 1)
    ys = np.arange(math.floor(cy - reach), math.ceil(cy + reach) + 1)
    return np.ix_(ys % size, xs % size), (xs - cx)[None, :], (ys - cy)[:, None]


def over(alb, idx, colour, k, cov):
    """Composite colour × k over the albedo at idx, with coverage cov."""
    alb[idx] = alb[idx] * (1 - cov)[..., None] + colour * (k * cov)[..., None]


def sample(f, x, y):
    """f at texel coordinates (x a column, y a row), bilinear, wrapped."""
    n, m = f.shape
    x0, y0 = np.floor(x), np.floor(y)
    fx, fy = x - x0, y - y0
    xa, ya = x0.astype(np.int64) % m, y0.astype(np.int64) % n
    xb, yb = (xa + 1) % m, (ya + 1) % n
    return (f[ya, xa] * (1 - fx) + f[ya, xb] * fx) * (1 - fy) + (f[yb, xa] * (1 - fx) + f[yb, xb] * fx) * fy


def sand(f):
    f1, f2, f3 = f
    rip = 0.5 + 0.5 * np.sin(TAU * (7 * V + 1.4 * f3 + 0.6 * f1))
    h = 0.55 * rip + 0.3 * f1 + 0.15 * f2
    alb = ramp(h, [(0, '#a87a45'), (0.55, '#c9a068'), (1, '#e3c690')]) * (0.93 + 0.14 * f2)[..., None]
    return alb, h, 0.82 + 0.1 * (1 - h), None, 5.0


def cracked_earth(f):
    e, c, n = f
    crack = 1 - ss(0.012, 0.05, e)
    plate = ss(0.02, 0.2, e)
    h = np.clip(0.25 + 0.6 * plate * (0.85 + 0.15 * n) - 0.25 * crack, 0, 1)
    alb = ramp(0.35 + 0.4 * c + 0.25 * n, [(0, '#8f6a43'), (0.5, '#b58c5c'), (1, '#caa576')])
    return mixc(alb, col('#3b2716'), crack), h, 0.9 - 0.05 * n, None, 7.0


def snow(f):
    n, g, _ = f
    h = 0.7 * n + 0.3 * g
    alb = ramp(h, [(0, '#b9cde0'), (0.5, '#e4edf5'), (1, '#f8fbff')])
    return alb, h, 0.45 - 0.15 * g, None, 3.0


def ice(f):
    e, c, n = f
    crack = 1 - ss(0.0, 0.022, e)
    h = np.clip(0.5 + 0.2 * c + 0.15 * n - 0.3 * crack, 0, 1)
    alb = mixc(ramp(0.3 + 0.5 * c + 0.2 * n, [(0, '#8fbcd9'), (1, '#cfe8f6')]), col('#eef8ff'), crack * 0.8)
    return alb, h, 0.1 + 0.35 * crack + 0.05 * n, None, 4.0


def moss(f):
    """Cushions: each of two layers of clumps is a smoothed threshold of its
    field; pressed together the higher dome wins, so neighbours meet in a
    crease, and the gaps where neither rises are dark crevices."""
    fa, fb, fibre, tone = f
    dome = np.maximum(ss(-0.9, 1.6, norm(fa)), ss(-0.9, 1.6, norm(fb)))
    crevice = 1 - ss(0, 0.2, dome)
    alb = ramp(0.15 + 0.75 * dome + 0.3 * (fibre - 0.5) + 0.3 * (tone - 0.5),
               [(0, '#263d1b'), (0.45, '#4b6e2e'), (0.8, '#6f9238'), (1, '#93ac4c')])
    alb = mixc(alb, col('#131d0c'), 0.6 * crevice)
    return alb, 0.25 + 0.22 * dome, 0.86, None, 20.0


LITTER = 1150                          # leaves and twigs on the jungle floor
TWIG_SHARE = 0.06


def leaf(r, alb, h, cover, hues):
    """A leaf: pointed at the tip, broadest toward the stalk, a lighter midrib,
    darker toward its edges. It lies 0.1 above whatever it covers — hard-edged
    in the height (the stack), antialiased in the colour."""
    cx, cy = r.uniform(0, SIZE), r.uniform(0, SIZE)
    ang = r.uniform(0, TAU)
    length = r.uniform(26, 56)
    width = length * r.uniform(0.32, 0.48)
    pick = r.random()
    hue = hues[0 if pick < 0.45 else 1 if pick < 0.8 else 2]
    val = r.uniform(0.7, 1.12)
    ca, sa = math.cos(ang), math.sin(ang)
    half = length / 2
    idx, dx, dy = window(cx, cy, half + 1)
    s = (dx * ca + dy * sa) / half
    b = np.abs(-dx * sa + dy * ca)
    hw = width / 2 * np.clip(1 - s * s, 0, 1) ** 0.7 * (1.1 - 0.3 * s)
    cov = np.where(np.abs(s) < 1, np.clip(hw - b + 0.5, 0, 1), 0)
    across = np.minimum(b / np.maximum(hw, 1e-3), 1)
    rib = np.where(s < 0.8, np.clip(1 - b / 0.8, 0, 1), 0)
    over(alb, idx, hue, val * (1 - 0.3 * across * across) * (1 + 0.2 * rib) * (0.92 + 0.12 * s), cov)
    top = cov >= 0.5
    h[idx] += np.where(top, 0.1, 0)
    cover[idx] = np.where(top, 1, cover[idx])


def twig(r, alb, h, cover, bark):
    """A twig: three bent segments, round in section."""
    x, y = r.uniform(0, SIZE), r.uniform(0, SIZE)
    ang = r.uniform(0, TAU)
    seg = r.uniform(8, 20)
    half = r.uniform(0.7, 1.2)
    val = r.uniform(0.8, 1.2)
    pts = [(x, y)]
    for _ in range(3):
        ang += r.uniform(-0.35, 0.35)
        x, y = x + seg * math.cos(ang), y + seg * math.sin(ang)
        pts.append((x, y))
    cx, cy = (pts[0][0] + pts[3][0]) / 2, (pts[0][1] + pts[3][1]) / 2
    reach = max(math.hypot(px - cx, py - cy) for px, py in pts) + half + 1
    idx, dx, dy = window(cx, cy, reach)
    d = np.full(np.broadcast(dx, dy).shape, np.inf)
    for k in range(3):
        ax, ay = pts[k][0] - cx, pts[k][1] - cy
        ex, ey = pts[k + 1][0] - pts[k][0], pts[k + 1][1] - pts[k][1]
        t = np.clip(((dx - ax) * ex + (dy - ay) * ey) / (ex * ex + ey * ey), 0, 1)
        d = np.minimum(d, np.hypot(dx - ax - t * ex, dy - ay - t * ey))
    cov = np.clip(half - d + 0.5, 0, 1)
    rnd = np.sqrt(np.clip(1 - (d / half) ** 2, 0, None))
    over(alb, idx, bark, val * (0.75 + 0.35 * rnd), cov)
    h[idx] += cov * (0.1 + 0.06 * rnd)
    cover[idx] = np.where(cov >= 0.5, 1, cover[idx])


def jungle_floor(f):
    """Leaf litter: leaves in three hues and twigs, scattered at seeded
    positions and turns over dark fbm soil; the height is the leaf stack."""
    soil, tone, grain = f
    alb = ramp(soil, [(0, '#1a120b'), (1, '#36261a')])
    h = np.zeros((SIZE, SIZE), np.float32)
    cover = np.zeros((SIZE, SIZE), np.float32)
    hues = [col('#6f4526'), col('#7d6436'), col('#4f6034')]
    bark = col('#4f3f2e')
    r = T.Rand(T.name_seed('ground/jungle_floor'))
    for _ in range(LITTER):
        if r.random() < TWIG_SHARE:
            twig(r, alb, h, cover, bark)
        else:
            leaf(r, alb, h, cover, hues)
    alb = alb * ((0.86 + 0.28 * tone) * (0.95 + 0.1 * grain))[..., None]
    return alb, 0.06 + h, 0.86 - 0.24 * cover, None, 4.0


def basalt(f):
    e, c, n = f
    plate = ss(0.01, 0.08, e)
    h = 0.2 + 0.65 * plate * (0.9 + 0.1 * c) + 0.15 * n
    alb = ramp(0.3 + 0.4 * c + 0.3 * n, [(0, '#221d1b'), (1, '#3c3430')]) * (0.6 + 0.4 * plate)[..., None]
    return alb, h, 0.85, None, 8.0


def lava_rock(f):
    n, e, g = f
    ridge = 1 - np.abs(2 * n - 1)
    crack = 1 - ss(0.0, 0.03 + 0.02 * g, e)
    h = np.clip(0.6 * ridge + 0.4 * g - 0.4 * crack, 0, 1)
    alb = mixc(ramp(h, [(0, '#16120f'), (1, '#3a2f2a')]), col('#5a1a08'), crack)
    return alb, h, 0.8 - 0.3 * crack, crack, 8.0


PLATE_STEPS = (0.26, 0.2, 0.14)        # the height each field's terrace step adds
PORES = 360


def step_distance(f):
    """Signed distance in texels to the field's mean level, + above it."""
    gx = (np.roll(f, -1, 1) - np.roll(f, 1, 1)) * 0.5
    gy = (np.roll(f, -1, 0) - np.roll(f, 1, 0)) * 0.5
    return (f - f.mean()) / (np.hypot(gx, gy) + 1e-3 * f.std())


def chitin(f):
    """Plates: each of three fields is terraced once, at its mean, into a
    smoothed step 2.4 texels wide; the plates are the regions the steps cut
    the tile into, each at its own height and tone, lit along the upper edge
    of a step and shaded below it, with pores. No cell edges, no rings."""
    pa, pb, pc, grain, tone = f
    sd = [step_distance(p) for p in (pa, pb, pc)]
    height = 0.25 + sum(w * ss(-1.2, 1.2, d) for w, d in zip(PLATE_STEPS, sd))
    rim = np.max([np.where(d > 0, 1 - ss(0.5, 4, d), 0) for d in sd], axis=0)
    shadow = np.max([np.where(d > 0, 0, 1 - ss(0, 5, -d)) for d in sd], axis=0)
    near = np.min([np.abs(d) for d in sd], axis=0)
    plate = T.lattice(np.arange(8), 5, 11)[sum((d > 0) * (4 >> k) for k, d in enumerate(sd))]
    alb = ramp(0.08 + 0.4 * plate + 0.4 * ss(0, 18, near) + 0.2 * (tone - 0.5) + 0.12 * (grain - 0.5),
               [(0, '#2e2140'), (0.5, '#4a3566'), (1, '#6d5090')])
    alb = mixc(alb, col('#8d73b6'), 0.5 * rim)
    alb = mixc(alb, col('#150c1e'), 0.85 * shadow)
    r = T.Rand(T.name_seed('ground/chitin'))
    for _ in range(PORES):
        cx, cy = r.uniform(0, SIZE), r.uniform(0, SIZE)
        rad = r.uniform(1.0, 2.2)
        idx, dx, dy = window(cx, cy, rad + 1)
        cov = np.clip(rad - np.hypot(dx, dy) + 0.5, 0, 1)
        alb[idx] = alb[idx] * (1 - 0.75 * cov)[..., None]
        height[idx] -= np.where(cov >= 0.5, 0.06, 0)
    return alb, height, np.where(shadow > 0.5, 0.55, 0.3), None, 6.0


def flesh(f):
    n, e, g = f
    vein = 1 - ss(0.0, 0.03, e)
    h = 0.5 * n + 0.3 * g + 0.2 * vein
    alb = mixc(ramp(n, [(0, '#5a2e4c'), (1, '#8a4e72')]), col('#2a1026'), vein * 0.8)
    return alb, h, 0.3 + 0.2 * g, vein, 4.0


STREAK_TAPS = 12                       # each side of a texel
STREAK_STEP = 1.2                      # texels between taps: ±14, 8× the blade fbm's width


def grass(f):
    """Blades: the blade fbm averaged along a line through each texel, whose
    direction drifts with a slow field, so it streaks 8× longer than wide; two
    tiers of blades (hard steps in the height, antialiased in the colour), dry
    tips where the tone field is high, and clover trefoils in small patches."""
    blade, drift, patch, tone = f
    th = 0.7 + 0.3 * norm(drift)
    ex, ey = np.cos(th) * STREAK_STEP, np.sin(th) * STREAK_STEP
    y, x = np.mgrid[0:SIZE, 0:SIZE].astype(np.float32)
    streak = np.zeros((SIZE, SIZE), np.float32)
    wsum = 0.0
    for k in range(-STREAK_TAPS, STREAK_TAPS + 1):
        w = 1 - abs(k) / (STREAK_TAPS + 1)
        streak += w * sample(blade, x + k * ex, y + k * ey)
        wsum += w
    z = norm(streak / wsum)
    lo, hi = ss(0.15, 0.35, z), ss(0.8, 1.0, z)
    alb = ramp(0.4 * (0.5 + 0.2 * z) + 0.6 * (0.15 + 0.4 * lo + 0.45 * hi), [(0, '#1f3d17'), (0.5, '#3d7529'), (1, '#79ad4a')])
    alb = mixc(alb, col('#9c9550'), 0.55 * ss(0.8, 2.2, norm(tone)) * lo)
    height = 0.25 + 0.25 * (z > 0.25) + 0.25 * (z > 0.9)
    rough = np.full((SIZE, SIZE), 0.74, np.float32)
    # clover: trefoils scattered over the whole tile, kept where the patch field is high
    clover = ss(0.95, 1.4, norm(patch))
    leaf_col = col('#5f9a5c')
    r = T.Rand(T.name_seed('ground/grass'))
    for _ in range(5000):
        cx, cy = r.uniform(0, SIZE), r.uniform(0, SIZE)
        ang = r.uniform(0, TAU)
        rad = r.uniform(2.2, 3.4)
        val = r.uniform(0.8, 1.15)
        if clover[math.floor(cy) % SIZE, math.floor(cx) % SIZE] < 0.5:
            continue
        for j in range(3):
            lx = cx + math.cos(ang + j * TAU / 3) * rad * 0.95
            ly = cy + math.sin(ang + j * TAU / 3) * rad * 0.95
            idx, dx, dy = window(lx, ly, rad + 1)
            d = np.hypot(dx, dy)
            cov = np.clip(rad - d + 0.5, 0, 1)
            over(alb, idx, leaf_col, val * (1.08 - 0.3 * (d / rad) ** 2), cov)
            top = cov >= 0.5
            height[idx] = np.where(top, 0.9, height[idx])
            rough[idx] = np.where(top, 0.6, rough[idx])
    return alb, height, rough, None, 3.0


def soil(f):
    n, p, g = f
    pebble = 1 - ss(0.05, 0.15, p)
    h = 0.5 * n + 0.35 * pebble + 0.15 * g
    alb = mixc(ramp(n, [(0, '#4a3526'), (1, '#7a5a40')]), col('#8a8178'), pebble * 0.6)
    return alb, h, 0.9 - 0.2 * pebble, None, 7.0


FBM = 'fbm'
LAYERS = {
    'sand': ([(FBM, 3, 1, {}), (FBM, 18, 2, {'detail': 3}), (FBM, 6, 3, {'detail': 6, 'distortion': 0.5})], sand),
    'cracked_earth': ([('edge', 6, 4, {}), ('cell', 6, 4, {}), (FBM, 10, 5, {'detail': 6})], cracked_earth),
    'snow': ([(FBM, 3, 9, {'detail': 5}), (FBM, 24, 10, {'detail': 2}), (FBM, 1, 11, {})], snow),
    'ice': ([('edge', 5, 12, {}), ('cell', 5, 12, {}), (FBM, 8, 13, {'detail': 5})], ice),
    'moss': ([(FBM, 14, 14, {'detail': 1}), (FBM, 14, 15, {'detail': 1}), (FBM, 96, 16, {'detail': 1}), (FBM, 3, 17, {'detail': 2})], moss),
    'jungle_floor': ([(FBM, 6, 18, {'detail': 6}), (FBM, 3, 19, {'detail': 2}), (FBM, 40, 20, {'detail': 2})], jungle_floor),
    'basalt': ([('edge', 5, 19, {}), ('cell', 5, 19, {}), (FBM, 12, 20, {'detail': 5})], basalt),
    'lava_rock': ([(FBM, 5, 21, {'detail': 7}), ('edge', 4, 22, {}), (FBM, 16, 23, {})], lava_rock),
    'chitin': ([(FBM, 5, 24, {'detail': 1, 'distortion': 0.3}), (FBM, 6, 25, {'detail': 1, 'distortion': 0.3}), (FBM, 7, 26, {'detail': 1, 'distortion': 0.3}), (FBM, 48, 27, {'detail': 2}), (FBM, 3, 34, {})], chitin),
    'flesh': ([(FBM, 3, 25, {}), ('edge', 6, 26, {}), (FBM, 14, 27, {})], flesh),
    'grass': ([(FBM, 72, 28, {'detail': 1}), (FBM, 2, 29, {'detail': 2}), (FBM, 6, 30, {'detail': 3}), (FBM, 3, 35, {'detail': 3})], grass),
    'soil': ([(FBM, 5, 31, {'detail': 6}), ('smooth', 20, 32, {}), (FBM, 20, 33, {})], soil),
}


def build_layer(name, out_root):
    specs, recipe = LAYERS[name]
    fields = bake_fields(specs)
    albedo, height, rough, mask, strength = recipe(fields)
    height = np.clip(height, 0, 1).astype(np.float32)
    rough = np.broadcast_to(np.asarray(rough, np.float32), height.shape)
    cavity = np.clip((T.blur(height, 3.0) - height) * 4.0, 0, 1)
    albedo = albedo * (1 - 0.35 * cavity)[..., None] * (0.86 + 0.14 * height)[..., None]
    alpha = height if mask is None else np.clip(mask, 0, 1)
    rgba = np.concatenate([C.encode_srgb(albedo), alpha[..., None]], -1)
    normal = T.normals(height, strength) * 0.5 + 0.5
    nr = np.concatenate([normal, np.clip(rough, 0.02, 1)[..., None]], -1)
    base = os.path.join(out_root, 'textures', 'ground', name)
    a = C.save_webp(base + '_albedo.webp', rgba, quality=SMOOTH_QUALITY if name in SMOOTH else ALBEDO_QUALITY)
    b = C.save_webp(base + '_nr.webp', nr, quality=NR_QUALITY)
    print(f'ASSET textures/ground/{name}_albedo.webp {a} bytes; {name}_nr.webp {b} bytes')
    return C.encode_srgb(albedo), normal


# ---------------------------------------------------------------- detail_nr

PEBBLES = 30
DETAIL = [(FBM, 24, 41, {'detail': 1}), (FBM, 64, 42, {'detail': 0})]


def detail_height(f):
    """Fine grit — fbm bands at scales 24 and 64 — and a sparse field of low
    pebbles: (grit, height) at DETAIL_SIZE²."""
    band24, band64 = f
    grit = 0.75 * band24 + 0.25 * band64
    pebble = np.zeros((DETAIL_SIZE, DETAIL_SIZE), np.float32)
    r = T.Rand(T.name_seed('ground/detail_nr'))
    for _ in range(PEBBLES):
        cx, cy = r.uniform(0, DETAIL_SIZE), r.uniform(0, DETAIL_SIZE)
        rad = r.uniform(4.5, 8)
        squash = r.uniform(0.6, 1.0)
        ang = r.uniform(0, TAU)
        tall = r.uniform(0.15, 0.25)
        ca, sa = math.cos(ang), math.sin(ang)
        idx, dx, dy = window(cx, cy, rad + 1, DETAIL_SIZE)
        a = (dx * ca + dy * sa) / rad
        b = (-dx * sa + dy * ca) / (rad * squash)
        q = np.clip(1 - (a * a + b * b), 0, None)
        pebble[idx] = np.maximum(pebble[idx], tall * q * q)
    return grit, 0.5 + 0.5 * (grit - 0.5) + pebble


def build_detail(out_root):
    """detail_nr: the height as an OpenGL tangent normal at strength 3, and
    A = 0.5 + 0.25 × (grit − 0.5), a roughness offset around 0.5."""
    grit, height = detail_height(bake_fields(DETAIL, DETAIL_SIZE))
    normal = T.normals(height, 3.0) * 0.5 + 0.5
    rgba = np.concatenate([normal, (0.5 + 0.25 * (grit - 0.5))[..., None]], -1)
    n = C.save_webp(os.path.join(out_root, 'textures', 'ground', 'detail_nr.webp'), rgba, quality=NR_QUALITY)
    print(f'ASSET textures/ground/detail_nr.webp {n} bytes')
    return normal


def main():
    opts = C.options()
    C.reset()
    tiles = []
    for name in LAYERS:
        if C.wanted(opts, name):
            alb, nrm = build_layer(name, opts['out'])
            # QA: rolled by half, so a broken seam would cross the middle
            tiles.append(np.roll(np.roll(alb, SIZE // 2, 0), SIZE // 2, 1)[::2, ::2])
            tiles.append(np.roll(np.roll(nrm, SIZE // 2, 0), SIZE // 2, 1)[::2, ::2])
    if C.wanted(opts, 'detail_nr'):
        nrm = build_detail(opts['out'])
        step = max(1, DETAIL_SIZE // (SIZE // 2))
        tiles.append(np.roll(np.roll(nrm, DETAIL_SIZE // 2, 0), DETAIL_SIZE // 2, 1)[::step, ::step])
    if opts['preview'] and tiles:
        cols = 6
        rows = math.ceil(len(tiles) / cols)
        h = SIZE // 2
        grid = np.zeros((rows * h, cols * h, 3), np.float32)
        for i, t in enumerate(tiles):
            r, c = divmod(i, cols)
            grid[r * h:(r + 1) * h, c * h:(c + 1) * h] = t
        path = os.path.join(opts['preview'], 'sheet_ground.png')
        C.save_image(path, grid, 'PNG')
        print(f'PREVIEW {path}')


main()
