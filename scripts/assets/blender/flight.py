# Flight art (PLAN R8): what the trip to a planet wears (SPEC-020 §4.1–§4.3).
#
#   textures/flight/sky_<planet>.webp        the forward sky window — nebula,
#       dust lanes, galactic band, stars — for a partial sphere: three's
#       SphereGeometry(r, …, φ π…2π, θ π/8…7π/8), i.e. ±90° × ±67.5° around −Z,
#       everything the flight camera can see (roll, pitch and the landing
#       dive included), at twice the texel density of a full panorama;
#   textures/flight/planet_<planet>.webp     the destination, equirect for
#       SphereGeometry UVs (u = φ/2π, v = 1 − θ/π), sRGB albedo;
#   textures/flight/planet_<planet>_nr.webp  relief normals (OpenGL, half size);
#   textures/flight/planet_<planet>_em.webp  emissive lava / veins (Ferrum, Hive);
#   textures/flight/clouds.webp              one shared cloud layer (grey = cover);
#   textures/flight/sky_station.webp         a neutral window for the hub scenes;
#   models/asteroid.glb                      two baked rocks (normals from a
#       displaced high-poly), mean radius 1, for the instanced field.
#
# Blender bakes Noise/Voronoi fields on the unit direction through meshes laid
# out exactly like three's sphere UVs; numpy shapes colour, relief and glow.
import math
import os
import random
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'lib'))

import bmesh  # noqa: E402
import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Vector, noise  # noqa: E402

import bake as B  # noqa: E402
import common as C  # noqa: E402
import nodes as N  # noqa: E402
import tex as T  # noqa: E402

ss = T.smoothstep
mix = B.mix
SKY = dict(phi0=math.pi, dphi=math.pi, th0=math.pi / 8, dth=3 * math.pi / 4)
FULL = dict(phi0=0.0, dphi=2 * math.pi, th0=0.0, dth=math.pi)

PLANETS = ('cinder4', 'vetra', 'thessaly', 'ferrum', 'hive', 'eden')


def col(h):
    return np.array(C.lin(h)[:3], np.float32)


def ramp(t, stops):
    t = np.clip(t, 0, 1)
    pos = np.array([p for p, _ in stops], np.float32)
    cols = np.array([col(c) for _, c in stops], np.float32)
    return np.stack([np.interp(t, pos, cols[:, k]) for k in range(3)], -1).astype(np.float32)


def norm01(x, lo=2.0, hi=98.0):
    """Stretch a baked field to its own 2nd…98th percentiles: Blender's
    normalised fBm clusters near 0.5, so fixed thresholds would drift by seed."""
    a, b = np.percentile(x, (lo, hi))
    return np.clip((x - a) / max(b - a, 1e-6), 0, 1).astype(np.float32)


# ------------------------------------------------------------ sphere layouts


def sphere_mesh(name, phi0, dphi, th0, dth, wseg, hseg):
    """A unit (partial) sphere whose UVs match three's SphereGeometry exactly,
    built in three's axes (the fields only need direction ↔ UV to agree)."""
    bm = bmesh.new()
    uvl = bm.loops.layers.uv.new('UVMap')
    grid = []
    for iy in range(hseg + 1):
        v = iy / hseg
        th = th0 + v * dth
        row = []
        for ix in range(wseg + 1):
            u = ix / wseg
            ph = phi0 + u * dphi
            co = (-math.cos(ph) * math.sin(th), math.cos(th), math.sin(ph) * math.sin(th))
            row.append((bm.verts.new(co), (u, 1 - v)))
        grid.append(row)
    for iy in range(hseg):
        for ix in range(wseg):
            quad = [grid[iy][ix], grid[iy + 1][ix], grid[iy + 1][ix + 1], grid[iy][ix + 1]]
            f = bm.faces.new([q[0] for q in quad])
            for loop, q in zip(f.loops, quad):
                loop[uvl].uv = q[1]
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    return C.link(bpy.data.objects.new(name, mesh))


def directions(w, h, phi0, dphi, th0, dth):
    """Per-texel unit directions (row 0 = top), the numpy twin of sphere_mesh."""
    u = (np.arange(w, dtype=np.float32) + 0.5) / w
    v = (np.arange(h, dtype=np.float32) + 0.5) / h
    ph = phi0 + u[None, :] * dphi
    th = th0 + v[:, None] * dth
    d = np.stack(np.broadcast_arrays(-np.cos(ph) * np.sin(th), np.cos(th) + 0 * ph, np.sin(ph) * np.sin(th)), -1)
    return d.astype(np.float32), th + 0 * ph


def gauss_blur(a, sigma):
    """Separable gaussian (edges clamped) — for non-periodic images."""
    r = int(math.ceil(sigma * 3))
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2)
    k /= k.sum()
    out = a
    for axis in (0, 1):
        pad = [(0, 0)] * a.ndim
        pad[axis] = (r, r)
        p = np.pad(out, pad, mode='edge')
        acc = np.zeros_like(out)
        for i, kv in enumerate(k):
            sl = [slice(None)] * a.ndim
            sl[axis] = slice(i, i + out.shape[axis])
            acc += kv * p[tuple(sl)]
        out = acc
    return out


# ---------------------------------------------------------------------- sky

SKIES = {
    'cinder4': dict(a='#ff9a3c', b='#c0482a', space='#120906', seed=3, tilt=24, glow=1.0),
    'vetra': dict(a='#6fd0ff', b='#3a5ccc', space='#05090f', seed=5, tilt=-32, glow=0.9),
    'thessaly': dict(a='#8ee07a', b='#e0c060', space='#060d08', seed=7, tilt=14, glow=0.8),
    'ferrum': dict(a='#ff4a1a', b='#9a1034', space='#100404', seed=9, tilt=-18, glow=1.05),
    'hive': dict(a='#c04ad0', b='#4a1a8a', space='#0a0510', seed=11, tilt=38, glow=1.0),
    'eden': dict(a='#7ab8ff', b='#ff9ad0', space='#050910', seed=13, tilt=-10, glow=0.85),
    # the hub scenes' neutral sky (SPEC-020 §4.4 registers it)
    'station': dict(a='#6f8fb8', b='#8a6fb0', space='#05070c', seed=17, tilt=18, glow=0.7),
}
SKY_SIZE = (2048, 1536)
# (scale, width) per star layer: cells of 5.5 / 15 / 47 px, radii ≈ 0.7 / 0.75 / 1 px
STAR_LAYERS = ((120.0, 0.12), (45.0, 0.05), (14.0, 0.022))


def star_layer(g, d, scale, width, seed):
    """exp(−(F1 / width)²): only feature points near the sphere light up, so
    brightness comes out random for free."""
    f1 = g.voronoi(d, scale, seed)
    return g.math('EXPONENT', g.math('MULTIPLY', g.math('POWER', g.math('DIVIDE', f1, width), 2.0), -1.0))


def sky(name, spec, out_root):
    obj = sphere_mesh('SkyWindow', wseg=192, hseg=144, **SKY)
    s = spec['seed']

    def nebula(g):
        d = g.direction()
        return (g.noise(d, 1.5, s, detail=12, rough=0.62, distortion=0.2),
                g.noise(d, 3.4, s + 1, detail=10, rough=0.58, distortion=0.3),
                g.noise(d, 2.6, s + 2, detail=12, rough=0.66, distortion=0.15))

    def stars(g):
        d = g.direction()
        return tuple(star_layer(g, d, sc, wd, s + 3 + k) for k, (sc, wd) in enumerate(STAR_LAYERS))

    def temps(g):
        d = g.direction()
        return tuple(g.channel(g.voronoi(d, sc, s + 3 + k, out='Color'), 'Green') for k, (sc, _) in enumerate(STAR_LAYERS))

    n1, n2, n3 = (norm01(x) for x in N.bake_emit(obj, nebula, SKY_SIZE, samples=4, name='nebula')[..., :3].transpose(2, 0, 1))
    st = N.bake_emit(obj, stars, SKY_SIZE, samples=16, name='stars')[..., :3]
    tp = N.bake_emit(obj, temps, SKY_SIZE, samples=1, name='temps')[..., :3]
    bpy.data.objects.remove(obj, do_unlink=True)

    d, _ = directions(*SKY_SIZE, **SKY)
    t = math.radians(spec['tilt'])
    band = np.exp(-((d @ np.array((-math.sin(t), math.cos(t), 0.0), np.float32)) / 0.24) ** 2)
    # the flight camera looks down −Z: keep some nebula where it looks
    focus = np.exp(-(np.arccos(np.clip(-d[..., 2], -1.0, 1.0)) / 0.6) ** 2)
    zone = np.maximum(band, 0.75 * focus)
    a, b = col(spec['a']), col(spec['b'])
    cloud = ss(0.48, 0.92, n1 + 0.15 * (n2 - 0.5) + 0.14 * focus) * (0.12 + 0.88 * zone)
    fil = (1 - np.abs(2 * n2 - 1)) ** 10 * ss(0.5, 0.8, n1) * zone
    tint = mix(a, b, ss(0.3, 0.7, n2 * 0.6 + n3 * 0.4))
    dust = ss(0.55, 0.78, n3) * (0.3 + 0.7 * band)
    neb = tint * (cloud * 0.5 + fil * 0.45)[..., None] * spec['glow']
    neb = neb * (1 - 0.85 * dust)[..., None]
    glow = gauss_blur(cloud * zone, 18.0)[..., None] * tint * 0.25
    space = col(spec['space']) * (0.6 + 0.8 * band)[..., None]
    # stars: denser in the band, dimmed behind dust, tinted by temperature
    faint = st[..., 0] * (0.25 + 1.2 * band) * 1.2
    med = st[..., 1] * 3.0
    bright = st[..., 2] * 9.0
    warm, cool = col('#ffd2a0'), col('#b8d4ff')

    def tone(k):
        return mix(cool, warm, tp[..., k])

    starc = (tone(0) * faint[..., None] + tone(1) * med[..., None]) * (1 - 0.7 * dust)[..., None] + tone(2) * bright[..., None]
    halo = gauss_blur(bright, 3.0)[..., None] * tone(2) * 1.6
    radiance = space + neb + glow + starc + halo
    rgb = C.encode_srgb(1 - np.exp(-radiance * 1.25))
    path = os.path.join(out_root, 'textures', 'flight', f'sky_{name}.webp')
    size = C.save_webp(path, rgb, quality=82)
    print(f'ASSET textures/flight/sky_{name}.webp {size} bytes')
    return rgb


# ------------------------------------------------------------------ planets

PLANET_SIZE = (2048, 1024)


def planet_fields(seed):
    obj = sphere_mesh('PlanetSphere', wseg=256, hseg=128, **FULL)

    def shape(g):
        d = g.direction()
        return (g.noise(d, 1.25, seed, detail=12, rough=0.56, distortion=0.35),
                g.noise(d, 3.1, seed + 1, detail=10, rough=0.52),
                g.noise(d, 9.0, seed + 2, detail=8, rough=0.6))

    def cells(g):
        # a noise-warped domain: canyons, cracks and lava rivers meander
        # instead of drawing straight Voronoi polygons across the disc
        d = g.direction()
        wobble = g.vmath('SUBTRACT', g.noise(d, 2.6, seed + 9, detail=4, out='Color'), (0.5, 0.5, 0.5))
        w = g.vmath('ADD', d, g.vmath('MULTIPLY', wobble, (0.16, 0.16, 0.16)))
        return (g.voronoi(w, 6.0, seed + 3), g.voronoi(w, 4.0, seed + 4, feature='DISTANCE_TO_EDGE'),
                g.channel(g.voronoi(w, 4.0, seed + 4, out='Color'), 'Red'))

    def extra(g):
        d = g.direction()
        return (g.noise(d, 2.2, seed + 5, detail=6), g.noise(d, 0.8, seed + 6, detail=4),
                g.noise(d, 26.0, seed + 7, detail=4))

    f = {}
    for key, fn in (('shape', shape), ('cells', cells), ('extra', extra)):
        f[key] = N.bake_emit(obj, fn, PLANET_SIZE, samples=4, name=key)[..., :3].transpose(2, 0, 1)
    bpy.data.objects.remove(obj, do_unlink=True)
    c, m, fine = (norm01(x) for x in f['shape'])
    vf1, ve, vc = f['cells']
    t, big, grain = (norm01(x) for x in f['extra'])
    d, th = directions(*PLANET_SIZE, **FULL)
    lat = np.abs(np.pi / 2 - th)  # 0 at the equator, π/2 at the poles
    return dict(c=c, ridge=1 - np.abs(2 * m - 1), fine=fine, vf1=vf1, ve=ve, vc=vc, t=t, big=big, grain=grain,
                lat=lat, d=d)


def cinder4(f):
    """Desert furnace: dune seas, rust highlands, salt pans, black oil lakes, canyons."""
    c, r, fine, big = f['c'], f['ridge'], f['fine'], f['big']
    h = norm01(0.62 * c + 0.25 * r + 0.13 * fine)
    alb = ramp(h, [(0.0, '#3a200f'), (0.2, '#6e4222'), (0.38, '#a8783f'), (0.52, '#c9a060'), (0.66, '#dcb97c'),
                   (0.8, '#9a6a3a'), (1.0, '#5c3a22')])
    alb = alb * mix(np.ones(3, np.float32), col('#f0c8a0'), ss(0.35, 0.8, big))
    dunes = (1 - np.abs(2 * fine - 1)) ** 3 * ss(0.4, 0.55, h) * (1 - ss(0.66, 0.76, h))
    alb = alb * (0.94 + 0.14 * dunes)[..., None]
    salt = ss(0.2, 0.14, h) * ss(0.45, 0.65, big)
    alb = mix(alb, col('#d9c7a2'), salt * 0.6)
    oil = ss(0.16, 0.1, h) * ss(0.55, 0.7, f['t'])
    alb = mix(alb, col('#120d0a'), oil)
    canyon = (1 - ss(0.0, 0.02, f['ve'])) * ss(0.62, 0.72, h)
    alb = mix(alb, col('#3a2012'), canyon * 0.85)
    return alb, h - 0.3 * canyon, None


def vetra(f):
    """Ice world: snowfields, blue glaciers, cracked frozen seas, dark ridges, big caps."""
    c, r, fine, lat, t = f['c'], f['ridge'], f['fine'], f['lat'], f['t']
    h = norm01(0.55 * c + 0.3 * r + 0.15 * fine)
    sea = ss(0.3, 0.24, h)
    alb = ramp(h, [(0.0, '#7f9fb8'), (0.28, '#a9cce0'), (0.42, '#dbe9f2'), (0.62, '#f2f7fa'), (0.8, '#8a9aa6'), (1.0, '#4a5a66')])
    crack = (1 - ss(0.0, 0.016, f['ve'])) * sea
    alb = mix(alb, col('#eaf6ff'), crack * 0.9)
    glacier = ss(0.45, 0.33, h) * (1 - sea) * ss(0.45, 0.75, t)
    alb = mix(alb, col('#7fb0d4'), glacier * 0.6)
    alb = mix(alb, col('#f7fbff'), ss(1.05, 1.2, lat + 0.1 * fine))
    return alb, h + 0.1 * crack, None


def thessaly(f):
    """Jungle world: teal seas, rainforest, grassland, wheat over the lowlands, heavy cloud."""
    c, r, fine, lat, t = f['c'], f['ridge'], f['fine'], f['lat'], f['t']
    h = norm01(0.8 * c + 0.12 * r * ss(0.5, 0.6, c) + 0.08 * fine)
    sea_level = 0.46
    ocean = ramp(h / sea_level, [(0.0, '#0b2630'), (0.7, '#123a44'), (0.93, '#1f5a5a'), (1.0, '#2f7a6a')])
    land_t = np.clip((h - sea_level) / (1 - sea_level), 0, 1)
    land = ramp(land_t, [(0.0, '#4a6e36'), (0.15, '#2f5a2a'), (0.5, '#3d6b30'), (0.75, '#4f5a34'), (0.9, '#5e5a40'), (1.0, '#7a7462')])
    # wheat in lowland patches, not as a rim along every coast
    wheat = ss(0.62, 0.78, t) * ss(0.35, 0.12, land_t) * ss(0.45, 0.65, f['big']) * ss(0.02, 0.08, land_t)
    land = mix(land, col('#c2b870'), wheat * 0.85)
    land = mix(land, col('#8fae72'), ss(0.35, 0.55, f['big']) * ss(0.3, 0.1, land_t) * 0.6)
    land = land * (0.9 + 0.15 * fine)[..., None]
    alb = np.where((h < sea_level)[..., None], ocean, land)
    alb = mix(alb, col('#e8eef0'), ss(1.3, 1.45, lat + 0.06 * fine))
    return alb, np.maximum(h, sea_level), None


def ferrum(f):
    """Volcanic world: basalt and ash, glowing lava rivers, seas and calderas."""
    c, r, fine, ve, vf1 = f['c'], f['ridge'], f['fine'], f['ve'], f['vf1']
    h = norm01(0.5 * c + 0.36 * r + 0.14 * fine)
    alb = ramp(h, [(0.0, '#2a0e06'), (0.18, '#1c1714'), (0.45, '#3a2f2a'), (0.7, '#4a3e36'), (1.0, '#5e5048')])
    river = (1 - ss(0.0, 0.022, ve)) * ss(0.55, 0.35, h)
    sea = ss(0.16, 0.08, h)
    caldera = (1 - ss(0.05, 0.09, vf1)) * ss(0.55, 0.7, f['vc'])
    hot = np.clip(np.maximum(np.maximum(river, sea * (0.55 + 0.45 * f['grain'])), caldera), 0, 1)
    hot = hot * (1 - 0.8 * ss(0.55, 0.75, fine) * sea)
    alb = mix(alb, col('#3a1206'), hot)
    em = mix(col('#ff5a1a'), col('#ffc060'), ss(0.6, 1.0, hot)) * hot[..., None]
    return alb, h - 0.25 * river, em


def hive(f):
    """The Hive: chitin plates over flesh, glowing veins, egg-pit clusters."""
    c, fine, ve, vf1, vc = f['c'], f['fine'], f['ve'], f['vf1'], f['vc']
    plate = ss(0.0, 0.05, ve)
    h = norm01(0.45 * c + 0.35 * plate * (0.6 + 0.4 * vc) + 0.2 * fine)
    shell = ramp(0.3 + 0.5 * vc + 0.2 * fine, [(0.0, '#2a1f38'), (0.5, '#4a3566'), (1.0, '#6d5090')]) * (0.55 + 0.45 * plate)[..., None]
    flesh = ramp(c, [(0.0, '#3a1830'), (1.0, '#6a3456')])
    alb = mix(flesh, shell, ss(0.45, 0.55, c + 0.2 * (vc - 0.5)))
    vein = (1 - ss(0.0, 0.014, ve)) * ss(0.35, 0.55, f['t'])
    pits = (1 - ss(0.03, 0.06, vf1)) * ss(0.6, 0.75, f['big'])
    alb = mix(alb, col('#12081a'), np.maximum(vein * 0.7, pits))
    em = col('#c04ad0')[None, None] * (vein * 0.9 + pits * 0.35)[..., None]
    return alb, h - 0.2 * vein, em


def eden(f):
    """Eden-Prime: blue oceans, green continents, dry belts, snowy peaks, white caps."""
    c, r, fine, lat, t = f['c'], f['ridge'], f['fine'], f['lat'], f['t']
    h = norm01(0.78 * c + 0.14 * r * ss(0.52, 0.62, c) + 0.08 * fine)
    sea_level = 0.56
    ocean = ramp(h / sea_level, [(0.0, '#0a2250'), (0.7, '#10306a'), (0.93, '#2a6fa8'), (1.0, '#48a8b8')])
    land_t = np.clip((h - sea_level) / (1 - sea_level), 0, 1)
    land = ramp(land_t, [(0.0, '#8fb06a'), (0.12, '#6f9f5a'), (0.4, '#3d6a35'), (0.65, '#6a6a48'), (0.8, '#7a7060'),
                         (0.9, '#e8ecef'), (1.0, '#ffffff')])
    dry = ss(0.55, 0.7, t) * ss(0.9, 0.3, lat) * ss(0.45, 0.15, land_t)
    land = mix(land, col('#b8a878'), dry * 0.8)
    land = land * (0.92 + 0.12 * fine)[..., None]
    alb = np.where((h < sea_level)[..., None], ocean, land)
    alb = mix(alb, col('#f0f4f8'), ss(1.2, 1.32, lat + 0.07 * fine))
    return alb, np.maximum(h, sea_level), None


RECIPES = {'cinder4': (cinder4, 41), 'vetra': (vetra, 43), 'thessaly': (thessaly, 47), 'ferrum': (ferrum, 53),
           'hive': (hive, 59), 'eden': (eden, 61)}


def planet(name, out_root):
    fn, seed = RECIPES[name]
    f = planet_fields(seed)
    alb, h, em = fn(f)
    h = np.clip(h, 0, 1).astype(np.float32)
    # relief shading baked lightly into the albedo keeps detail on the lit side
    cav = np.clip((gauss_blur(h, 2.0) - h) * 6, 0, 1)
    alb = alb * (1 - 0.35 * cav)[..., None]
    base = os.path.join(out_root, 'textures', 'flight', f'planet_{name}')
    rgb = C.encode_srgb(np.clip(alb, 0, 1))
    a = C.save_webp(base + '.webp', rgb, quality=85)
    # normals at half size: d/du along the parallel (scaled by sin θ), d/dv toward north
    hs = B.downsample(h[..., None], 2)[..., 0]
    hh, ww = hs.shape
    _, th = directions(ww, hh, **FULL)
    relief = 0.012
    du = (np.roll(hs, -1, 1) - np.roll(hs, 1, 1)) * 0.5 * relief / (2 * math.pi / ww * np.maximum(np.sin(th), 0.08))
    up = np.vstack([hs[:1], hs[:-1]])
    down = np.vstack([hs[1:], hs[-1:]])
    dv = (up - down) * 0.5 * relief / (math.pi / hh)
    n = np.stack([-du, -dv, np.ones_like(du)], -1)
    n = n / np.linalg.norm(n, axis=-1, keepdims=True)
    b = C.save_webp(base + '_nr.webp', n * 0.5 + 0.5, quality=90)
    line = f'ASSET textures/flight/planet_{name}.webp {a} bytes; _nr {b} bytes'
    if em is not None:
        e = C.save_webp(base + '_em.webp', C.encode_srgb(np.clip(B.downsample(em, 2), 0, 1)), quality=85)
        line += f'; _em {e} bytes'
    print(line)
    return rgb


def clouds(out_root):
    obj = sphere_mesh('CloudSphere', wseg=256, hseg=128, **FULL)

    def fields(g):
        d = g.direction()
        banded = g.vmath('MULTIPLY', d, (1.0, 3.0, 1.0))
        return (g.noise(d, 1.5, 101, detail=9, rough=0.6, distortion=1.0), g.noise(d, 4.5, 102, detail=8, distortion=0.5),
                g.noise(banded, 1.2, 103, detail=6, distortion=0.4))

    c1, c2, c3 = (norm01(x) for x in N.bake_emit(obj, fields, PLANET_SIZE, samples=4, name='clouds')[..., :3].transpose(2, 0, 1))
    bpy.data.objects.remove(obj, do_unlink=True)
    cover = ss(0.5, 0.78, 0.55 * c1 + 0.25 * c2 + 0.2 * c3) ** 1.2
    wisps = ss(0.55, 0.7, c2) * ss(0.4, 0.55, c1) * 0.35
    grey = np.clip(np.maximum(cover, wisps), 0, 1)
    path = os.path.join(out_root, 'textures', 'flight', 'clouds.webp')
    size = C.save_webp(path, np.repeat(grey[..., None], 3, -1), quality=82)
    print(f'ASSET textures/flight/clouds.webp {size} bytes')
    return grey


# ---------------------------------------------------------------- asteroids


def rock_height(seed, fine):
    rnd = random.Random(seed)
    off = Vector((rnd.uniform(-40, 40), rnd.uniform(-40, 40), rnd.uniform(-40, 40)))
    craters = []
    for _ in range(16):
        v = Vector((rnd.gauss(0, 1), rnd.gauss(0, 1), rnd.gauss(0, 1))).normalized()
        craters.append((v, rnd.uniform(0.12, 0.42)))

    def height(d):
        h = 0.2 * noise.fractal(d * 1.2 + off, 1.0, 2.0, 3)
        for c, r in craters:
            t = d.angle(c) / r
            if t < 1.8:
                h += r * (-0.25 * max(0.0, 1 - t * t) + 0.09 * math.exp(-((t - 1) / 0.22) ** 2))
        if fine:
            h += 0.03 * noise.fractal(d * 6.5 + off, 0.7, 2.0, 5) + 0.01 * noise.noise(d * 24 + off)
        return h

    return height


def rock_mesh(name, seed, subdiv, fine, stretch):
    height = rock_height(seed, fine)
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=subdiv, radius=1.0)
    for v in bm.verts:
        d = v.co.normalized()
        r = 1.0 + height(d)
        v.co = Vector((d.x * r * stretch[0], d.y * r * stretch[1], d.z * r * stretch[2]))
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    for poly in mesh.polygons:
        poly.use_smooth = True
    return C.link(bpy.data.objects.new(name, mesh))


def asteroid(label, seed, stretch, preview):
    """A 320-triangle rock wearing the normals of a 20 k-triangle one."""
    high = rock_mesh(f'{label}High', seed, 6, True, stretch)
    low = rock_mesh(label, seed, 3, False, stretch)
    low.data.uv_layers.new(name='UVMap')
    low.data.materials.append(C.mat_flat('RockBake', '#ffffff'))
    B.unwrap(low, margin=0.01)
    size = 512
    N.cycles(samples=16, margin=8)
    img = bpy.data.images.new(f'{label}_normal', size, size, float_buffer=True)
    img.colorspace_settings.name = 'Non-Color'
    nt = low.data.materials[0].node_tree
    node = nt.nodes.new('ShaderNodeTexImage')
    node.image = img
    nt.nodes.active = node
    C.select_only([high, low])
    bpy.context.view_layer.objects.active = low
    bpy.ops.object.bake(type='NORMAL', use_selected_to_active=True, cage_extrusion=0.12, normal_space='TANGENT', margin=8)
    nrm = np.array(img.pixels[:], np.float32).reshape(size, size, 4)[::-1, :, :3].copy()
    nt.nodes.remove(node)
    bpy.data.images.remove(img)
    bpy.data.objects.remove(high, do_unlink=True)

    def fields(g):
        p = g.coords('Object')
        return (g.noise(p, 1.6, seed, detail=8), g.noise(p, 7.0, seed + 1, detail=6), g.voronoi(p, 9.0, seed + 2))

    fl = N.bake_emit(low, fields, size, samples=4, name='rockfields')
    occ = N.bake_emit(low, lambda g: (g.ao(0.8, 16, local=True), g.ao(0.15, 8, local=True), None), size, samples=16, name='rockocc')
    cover = fl[..., 3] > 0.5
    n1, n2, spec = (B.dilate(fl[..., k], cover, 8) for k in range(3))
    ao = B.dilate(0.6 * occ[..., 0] + 0.4 * occ[..., 1], cover, 8)
    alb = ramp(0.35 + 0.45 * n1 + 0.2 * n2, [(0.0, '#3e3833'), (0.45, '#645c53'), (0.75, '#7e7466'), (1.0, '#958a7a')])
    ore = (1 - ss(0.04, 0.07, spec)) * ss(0.55, 0.7, n2)
    alb = mix(alb, col('#7d8fa3'), ore * 0.8)
    alb = alb * (0.45 + 0.55 * ao)[..., None]
    rough = 0.92 - 0.3 * ore
    metal = 0.6 * ore
    orm = np.stack([np.ones_like(rough), rough, metal], -1)
    base = C.encode_srgb(np.clip(alb, 0, 1))
    if preview:
        dbg = np.concatenate([base, nrm, np.repeat(ao[..., None], 3, -1)], 1)
        C.save_image(os.path.join(preview, f'maps_{label}.png'), dbg, 'PNG')
    low.data.materials[0] = B.material(f'{label}Rock', base, B.downsample(orm, 2), nrm)
    # scale to the mean radius 1 the view multiplies by
    co = np.zeros(len(low.data.vertices) * 3, np.float32)
    low.data.vertices.foreach_get('co', co)
    mean = float(np.linalg.norm(co.reshape(-1, 3), axis=1).mean())
    low.scale = (1 / mean,) * 3
    C.select_only([low])
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return low


# --------------------------------------------------------------------- main


def main():
    opts = C.options()
    out = opts['out']
    tiles = []
    for name in SKIES:
        if C.wanted(opts, f'sky_{name}') or C.wanted(opts, name):
            C.reset()
            tiles.append(('sky', sky(name, SKIES[name], out)))
    for name in PLANETS:
        if C.wanted(opts, f'planet_{name}') or C.wanted(opts, name):
            C.reset()
            tiles.append(('planet', planet(name, out)))
    if C.wanted(opts, 'clouds'):
        C.reset()
        tiles.append(('clouds', np.repeat(clouds(out)[..., None], 3, -1)))
    if C.wanted(opts, 'asteroid'):
        C.reset()
        rocks = [asteroid('AsteroidA', 71, (1.0, 1.0, 1.0), opts['preview']),
                 asteroid('AsteroidB', 73, (1.35, 0.85, 0.9), opts['preview'])]
        path = os.path.join(out, 'models', 'asteroid.glb')
        C.export_glb(path, rocks)
        C.report(path, out)
        if opts['preview']:
            import preview as PV
            rocks[1].location.x = 2.8
            PV.render(rocks, os.path.join(opts['preview'], 'flight_asteroids.png'), azimuth=30, elevation=20, size=512)
    if opts['preview'] and tiles:
        # QA sheet: skies (the flight camera's view boxed), planets, clouds
        w = 512
        rows = []
        for kind, img in tiles:
            step = max(1, img.shape[1] // w)
            small = img[::step, ::step][:, :w].copy()
            if kind == 'sky':
                hs, ws = small.shape[:2]
                x0, x1 = int(ws * (0.5 - 35 / 180)), int(ws * (0.5 + 35 / 180))
                y0, y1 = int(hs * (0.5 - 20 / 135)), int(hs * (0.5 + 20 / 135))
                small[y0, x0:x1] = small[y1, x0:x1] = 1.0
                small[y0:y1, x0] = small[y0:y1, x1] = 1.0
            pad = np.zeros((384, w, 3), np.float32)
            pad[:min(384, small.shape[0]), :small.shape[1]] = small[:384]
            rows.append(pad)
        cols = 3
        while len(rows) % cols:
            rows.append(np.zeros_like(rows[0]))
        grid = np.vstack([np.hstack(rows[i:i + cols]) for i in range(0, len(rows), cols)])
        path = os.path.join(opts['preview'], 'sheet_flight.png')
        C.save_image(path, grid, 'PNG')
        print(f'PREVIEW {path}')


main()
