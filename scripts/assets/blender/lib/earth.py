# The Earth of the story films (PLAN R9, SPEC-021 §5.2). One planet serves
# every orbital shot: continents from baked 4D noise, city lights from Voronoi
# points along the coasts, and a `relight` mask that grows the same clusters
# from interlude to interlude — 0 dark, 1 Shelter Nine's coast, 2 one inland
# city, 3 the coastline, 4 a continental grid, 5 everything. `prewar` lights
# every city. Maps are baked once per run (and cached with the frames); they
# are never shipped.
import math
import os

import bmesh
import bpy
import numpy as np
from mathutils import Vector

import common as C
import nodes as N

SIZE = (2048, 1024)
SEED = 83
SEA = 0.55
_MEM = {}


def _sphere_mesh(name, wseg=256, hseg=128):
    """Unit sphere with three's SphereGeometry UVs, built in three's axes (Y up)."""
    bm = bmesh.new()
    uvl = bm.loops.layers.uv.new('UVMap')
    grid = []
    for iy in range(hseg + 1):
        th = math.pi * iy / hseg
        row = []
        for ix in range(wseg + 1):
            ph = 2 * math.pi * ix / wseg
            co = (-math.cos(ph) * math.sin(th), math.cos(th), math.sin(ph) * math.sin(th))
            row.append((bm.verts.new(co), (ix / wseg, 1 - iy / hseg)))
        grid.append(row)
    for iy in range(hseg):
        for ix in range(wseg):
            quad = [grid[iy][ix], grid[iy + 1][ix], grid[iy + 1][ix + 1], grid[iy][ix + 1]]
            try:
                f = bm.faces.new([q[0] for q in quad])
            except ValueError:
                continue
            for loop, q in zip(f.loops, quad):
                loop[uvl].uv = q[1]
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-7)
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    for p in mesh.polygons:
        p.use_smooth = True
    return C.link(bpy.data.objects.new(name, mesh))


def _directions(w, h):
    u = (np.arange(w, dtype=np.float32) + 0.5) / w
    v = (np.arange(h, dtype=np.float32) + 0.5) / h
    ph = 2 * np.pi * u[None, :]
    th = np.pi * v[:, None]
    d = np.stack(np.broadcast_arrays(-np.cos(ph) * np.sin(th), np.cos(th) + 0 * ph, np.sin(ph) * np.sin(th)), -1)
    return d.astype(np.float32), th + 0 * ph


def _norm01(x, lo=2.0, hi=98.0):
    a, b = np.percentile(x, (lo, hi))
    return np.clip((x - a) / max(b - a, 1e-6), 0, 1).astype(np.float32)


def _ss(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def _col(h):
    return np.array(C.lin(h)[:3], np.float32)


def _blur(a, sigma):
    """Gaussian blur, periodic across longitude, clamped at the poles."""
    r = int(math.ceil(sigma * 3))
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2)
    k /= k.sum()
    across = np.zeros_like(a)
    for i, kv in enumerate(k):
        across += kv * np.roll(a, i - r, axis=1)
    padded = np.pad(across, ((r, r), (0, 0)), mode='edge')
    out = np.zeros_like(a)
    for i, kv in enumerate(k):
        out += kv * padded[i:i + a.shape[0]]
    return out


def _ramp(t, stops):
    t = np.clip(t, 0, 1)
    pos = np.array([p for p, _ in stops], np.float32)
    cols = np.array([_col(c) for _, c in stops], np.float32)
    return np.stack([np.interp(t, pos, cols[:, k]) for k in range(3)], -1).astype(np.float32)


def _fields(cache_dir):
    path = os.path.join(cache_dir, f'earth_fields_{SEED}_{SIZE[0]}.npz')
    if path in _MEM:
        return _MEM[path]
    if os.path.exists(path):
        _MEM[path] = dict(np.load(path))
        return _MEM[path]
    scene = bpy.context.scene
    engine = scene.render.engine
    ob = _sphere_mesh('EarthBake')

    def shape(g):
        d = g.direction()
        return (g.noise(d, 1.05, SEED, detail=12, rough=0.58, distortion=0.45),
                g.noise(d, 4.5, SEED + 1, detail=8, rough=0.55),
                g.noise(d, 1.9, SEED + 2, detail=6))

    def cities(g):
        d = g.direction()
        return (g.voronoi(d, 34.0, SEED + 3), g.voronoi(d, 95.0, SEED + 4),
                g.channel(g.voronoi(d, 34.0, SEED + 3, out='Color'), 'Red'))

    a = N.bake_emit(ob, shape, SIZE, samples=4, name='earth_shape')[..., :3]
    b = N.bake_emit(ob, cities, SIZE, samples=1, name='earth_cities')[..., :3]
    bpy.data.objects.remove(ob, do_unlink=True)
    scene.render.engine = engine
    f = {'c': a[..., 0], 'fine': a[..., 1], 'big': a[..., 2], 'f1': b[..., 0], 'f1s': b[..., 1], 'rand': b[..., 2]}
    os.makedirs(cache_dir, exist_ok=True)
    np.savez_compressed(path, **f)
    _MEM[path] = f
    return f


def _cap(d, centre, radius_deg, soft=0.35):
    """1 inside an angular cap around `centre` (a unit 3-vector), soft edge."""
    ang = np.degrees(np.arccos(np.clip(d @ np.asarray(centre, np.float32), -1, 1)))
    return 1 - _ss(radius_deg * (1 - soft), radius_deg, ang)


def _maps(cache_dir):
    key = ('maps', cache_dir)
    if key in _MEM:
        return _MEM[key]
    f = _fields(cache_dir)
    d, th = _directions(*SIZE)
    lat = np.abs(np.pi / 2 - th)
    c, fine, big = _norm01(f['c']), _norm01(f['fine']), _norm01(f['big'])
    h = _norm01(0.82 * c + 0.18 * fine)
    land = _ss(SEA - 0.004, SEA + 0.004, h)
    coast = np.exp(-((h - SEA) / 0.035) ** 2)
    ocean = _ramp(h / SEA, [(0.0, '#040d22'), (0.75, '#07183a'), (0.97, '#12325c'), (1.0, '#1f4a6e')])
    lt = np.clip((h - SEA) / (1 - SEA), 0, 1)
    ground = _ramp(lt, [(0.0, '#4a5a32'), (0.2, '#3a5228'), (0.5, '#5a5a38'), (0.8, '#7a6a4a'), (1.0, '#9a8a6a')])
    desert = _ss(0.55, 0.75, big) * _ss(0.95, 0.35, lat)
    ground = ground * (1 - desert[..., None] * 0.5) + _col('#b89a62') * desert[..., None] * 0.5
    alb = ocean * (1 - land[..., None]) + ground * land[..., None]
    ice = _ss(1.18, 1.3, lat + 0.08 * fine)
    alb = alb * (1 - ice[..., None]) + _col('#e6edf2') * ice[..., None]
    # city lights: cities on a 34-cell lattice, towns on 95 and a thin glow that
    # traces the coasts — denser toward the sea
    pts = np.exp(-(f['f1'] / 0.17) ** 2) * _ss(0.25, 0.45, f['rand'])
    towns = np.exp(-(f['f1s'] / 0.22) ** 2) * 0.55
    shore = _ss(0.35, 0.9, coast) * 0.35
    density = np.clip(0.08 + 2.2 * coast + 0.35 * big, 0, 1.8)
    lights = _blur(((pts + towns) * density + shore) * land * (1 - ice), 1.2)
    # pick Shelter Nine's coast: a coastal land texel near a fixed preference
    pref = np.array([0.55, 0.52, -0.66], np.float32)
    pref /= np.linalg.norm(pref)
    score = (d @ pref) + 0.6 * (coast * land > 0.45) + 0.4 * (np.degrees(lat) < 50)
    iy, ix = np.unravel_index(np.argmax(score), score.shape)
    home = d[iy, ix].copy()
    inland_score = (d @ home) * (land > 0.9) * (coast < 0.1) - (np.degrees(np.arccos(np.clip(d @ home, -1, 1))) < 5)
    jy, jx = np.unravel_index(np.argmax(inland_score - 0.02 * np.abs(np.degrees(np.arccos(np.clip(d @ home, -1, 1))) - 8)), score.shape)
    inland = d[jy, jx].copy()
    m = {'albedo': alb, 'lights': lights.astype(np.float32), 'land': land, 'coast': coast, 'd': d,
         'home': home, 'inland': inland}
    _MEM[key] = m
    return m


def relight_mask(m, level):
    d, home, inland = m['d'], m['home'], m['inland']
    if level >= 5:
        return np.ones(d.shape[:2], np.float32)
    mask = np.zeros(d.shape[:2], np.float32)
    if level >= 1:
        mask = np.maximum(mask, _cap(d, home, 2.6))
    if level >= 2:
        mask = np.maximum(mask, _cap(d, inland, 2.4))
    if level >= 3:
        mask = np.maximum(mask, _cap(d, home, 14.0) * _ss(0.25, 0.6, m['coast']))
    if level >= 4:
        mask = np.maximum(mask, _cap(d, home, 28.0, soft=0.5))
    return mask


def _to_world(v):
    """Mesh space (three's axes, Y up) → world (Z up): the object turns +90° on X."""
    return Vector((float(v[0]), -float(v[2]), float(v[1]))).normalized()


def planet(ctx, albedo, emissive=None, radius=1.0, loc=(0, 0, 0), sun_dir=(1, 0, 0), atmo='#7ab8ff', cover=0.8,
           em_strength=2.0, name='Planet'):
    """A committed flight planet map (R8) on a sphere, with a cloud layer and an
    atmosphere band like Earth's. Returns the sphere; animate its emission through
    `sphere.data.materials[0]`."""
    sun_dir = Vector(sun_dir).normalized()
    ob = _sphere_mesh(name, 192, 96)
    ob.rotation_euler = (math.radians(90), 0, 0)
    ob.location, ob.scale = loc, (radius,) * 3
    mat, nt, bsdf = C._principled(name)
    ta = nt.nodes.new('ShaderNodeTexImage')
    ta.image = bpy.data.images.load(ctx.asset(albedo), check_existing=True)
    nt.links.new(ta.outputs['Color'], bsdf.inputs['Base Color'])
    bsdf.inputs['Roughness'].default_value = 0.8
    if emissive is not None:
        te = nt.nodes.new('ShaderNodeTexImage')
        te.image = bpy.data.images.load(ctx.asset(emissive), check_existing=True)
        nt.links.new(te.outputs['Color'], bsdf.inputs['Emission Color'])
        bsdf.inputs['Emission Strength'].default_value = em_strength
    ob.data.materials.append(mat)
    if cover > 0:
        cl = _sphere_mesh(f'{name}Clouds', 192, 96)
        cl.parent, cl.scale = ob, (1.012,) * 3
        cm, cnt, cb = C._principled(f'{name}Clouds')
        cm.surface_render_method = 'BLENDED'
        tc = cnt.nodes.new('ShaderNodeTexImage')
        tc.image = bpy.data.images.load(ctx.asset('textures/flight/clouds.webp'), check_existing=True)
        tc.image.colorspace_settings.name = 'Non-Color'
        sep = cnt.nodes.new('ShaderNodeSeparateColor')
        cnt.links.new(tc.outputs['Color'], sep.inputs[0])
        mul = cnt.nodes.new('ShaderNodeMath')
        mul.operation = 'MULTIPLY'
        mul.inputs[1].default_value = cover
        cnt.links.new(sep.outputs['Red'], mul.inputs[0])
        cnt.links.new(mul.outputs[0], cb.inputs['Alpha'])
        cb.inputs['Base Color'].default_value = (0.92, 0.94, 0.96, 1)
        cb.inputs['Roughness'].default_value = 1.0
        cl.data.materials.append(cm)
    at = _sphere_mesh(f'{name}Air', 128, 64)
    at.parent, at.scale = ob, (1.03,) * 3
    am = bpy.data.materials.new(f'{name}Air')
    am.use_nodes = True
    am.surface_render_method = 'BLENDED'
    ag = N.Graph(am)
    lw = ag.node('ShaderNodeLayerWeight')
    lw.inputs['Blend'].default_value = 0.5
    rise = ag.node('ShaderNodeMapRange', interpolation_type='SMOOTHSTEP', clamp=True)
    ag.link(lw.outputs['Facing'], rise.inputs['Value'])
    rise.inputs['From Min'].default_value, rise.inputs['From Max'].default_value = 0.5, 0.95
    fall = ag.node('ShaderNodeMapRange', interpolation_type='SMOOTHSTEP', clamp=True)
    ag.link(lw.outputs['Facing'], fall.inputs['Value'])
    fall.inputs['From Min'].default_value, fall.inputs['From Max'].default_value = 0.965, 1.0
    fall.inputs['To Min'].default_value, fall.inputs['To Max'].default_value = 1.0, 0.0
    lit = ag.math('ADD', 0.18, ag.math('MAXIMUM', 0.0, ag.vmath('DOT_PRODUCT', ag.geometry('Normal'), tuple(sun_dir))))
    em = ag.node('ShaderNodeEmission')
    em.inputs['Color'].default_value = C.lin(atmo)
    ag.link(ag.math('MULTIPLY', ag.math('MULTIPLY', ag.math('MULTIPLY', rise.outputs['Result'], fall.outputs['Result']), lit), 1.8),
            em.inputs['Strength'])
    tr = ag.node('ShaderNodeBsdfTransparent')
    add = ag.node('ShaderNodeAddShader')
    ag.link(tr.outputs[0], add.inputs[0])
    ag.link(em.outputs[0], add.inputs[1])
    out = ag.node('ShaderNodeOutputMaterial')
    ag.link(add.outputs[0], out.inputs['Surface'])
    at.data.materials.append(am)
    return ob


def basis(ctx):
    """(home, east, up) in world space — Shelter Nine's coast and its local frame —
    so a shot can place the camera and the sun before building the planet."""
    m = _maps(os.path.join(ctx.opts['frames'], '_earth'))
    home = _to_world(m['home'])
    east = Vector((0, 0, 1)).cross(home).normalized()
    up = home.cross(east).normalized()
    return home, east, up


class EarthRig:
    def __init__(self, obj, home, inland, radius):
        self.obj, self.home, self.inland, self.radius = obj, home, inland, radius

    def around(self, right_deg, up_deg):
        """A unit direction turned from home: right (east-ish) then up (north-ish)."""
        north = Vector((0, 0, 1))
        east = north.cross(self.home).normalized()
        up = self.home.cross(east).normalized()
        v = self.home.copy()
        a, b = math.radians(right_deg), math.radians(up_deg)
        v = (v * math.cos(a) + east * math.sin(a)).normalized()
        return (v * math.cos(b) + up * math.sin(b)).normalized()


def earth(ctx, relight=0, prewar=False, aurora=False, radius=1.0, loc=(0, 0, 0), sun_dir=None, lights=14.0,
          atmosphere=True, rim=0.0, cloud_layer=True, segments=(192, 96), relight_from=None, fade=None, gate=False):
    """Earth at `loc`; `sun_dir` points toward the sun (world). Returns an EarthRig.
    Low-orbit shots (the camera within a few % of the radius) turn the
    atmosphere shell off and light the limb with `rim` instead, and `gate` them:
    the terminator then comes from `sun_dir` alone, so the sun lamp that lights
    the shot's ships cannot light the night side below."""
    cache = os.path.join(ctx.opts['frames'], '_earth')
    m = _maps(cache)
    mask = np.ones_like(m['lights']) if prewar else relight_mask(m, relight)
    em = np.clip(m['lights'] * mask, 0, 1.6)
    tag = 'pre' if prewar else f'r{relight}'
    alb = np.concatenate([C.encode_srgb(m['albedo']), np.ones(m['albedo'].shape[:2] + (1,), np.float32)], -1)[::-1]
    emi = np.repeat(np.clip(em / 1.6, 0, 1)[..., None], 3, -1)
    emi = np.concatenate([emi, np.ones(emi.shape[:2] + (1,), np.float32)], -1)[::-1]
    img_a = C.image_from_array('EarthAlbedo', alb, 'sRGB')
    img_e = C.image_from_array(f'EarthLights_{tag}', emi, 'Non-Color')
    ob = _sphere_mesh('Earth', *segments)
    ob.rotation_euler = (math.radians(90), 0, 0)
    ob.location, ob.scale = loc, (radius,) * 3
    home, inland = _to_world(m['home']), _to_world(m['inland'])
    if sun_dir is None:
        sun_dir = (-home * 0.35 + Vector((0, 0, 1)).cross(home).normalized() * 0.94).normalized()
    sun_dir = Vector(sun_dir).normalized()
    mat = bpy.data.materials.new('Earth')
    mat.use_nodes = True
    g = N.Graph(mat)
    ta = g.node('ShaderNodeTexImage', image=img_a)
    te = g.node('ShaderNodeTexImage', image=img_e)
    bsdf = g.node('ShaderNodeBsdfPrincipled')
    g.link(ta.outputs['Color'], bsdf.inputs['Base Color'])
    bsdf.inputs['Roughness'].default_value = 0.62
    bsdf.inputs['Specular IOR Level'].default_value = 0.2   # a grazing sun would otherwise grey the night side
    # lights only on the night side: smoothstep on N·L
    ndl = g.vmath('DOT_PRODUCT', g.geometry('Normal'), tuple(sun_dir))
    night = g.node('ShaderNodeMapRange', clamp=True)
    g.link(ndl, night.inputs['Value'])
    night.inputs['From Min'].default_value, night.inputs['From Max'].default_value = 0.08, -0.18
    if gate:
        day = g.node('ShaderNodeMapRange', interpolation_type='SMOOTHSTEP', clamp=True)
        g.link(ndl, day.inputs['Value'])
        day.inputs['From Min'].default_value, day.inputs['From Max'].default_value = -0.05, 0.12
        shade = g.node('ShaderNodeMix', data_type='RGBA', blend_type='MULTIPLY')
        shade.inputs['Factor'].default_value = 1.0
        g.link(ta.outputs['Color'], shade.inputs['A'])
        g.link(g.combine(day.outputs['Result'], day.outputs['Result'], day.outputs['Result']), shade.inputs['B'])
        g.link(shade.outputs['Result'], bsdf.inputs['Base Color'])
        g.link(g.math('MULTIPLY', day.outputs['Result'], 0.2), bsdf.inputs['Specular IOR Level'])
    warm = g.node('ShaderNodeMix', data_type='RGBA', blend_type='MULTIPLY')
    warm.inputs['Factor'].default_value = 1.0
    lights_col = te.outputs['Color']
    if relight_from is not None and fade is not None:
        # the new cluster fades in: blend from the previous level's lights to this one's
        em0 = np.clip(m['lights'] * relight_mask(m, relight_from), 0, 1.6)
        e0 = np.repeat(np.clip(em0 / 1.6, 0, 1)[..., None], 3, -1)
        e0 = np.concatenate([e0, np.ones(e0.shape[:2] + (1,), np.float32)], -1)[::-1]
        te0 = g.node('ShaderNodeTexImage', image=C.image_from_array(f'EarthLights_r{relight_from}', e0, 'Non-Color'))
        blend = g.node('ShaderNodeMix', data_type='RGBA')
        g.link(te0.outputs['Color'], blend.inputs['A'])
        g.link(te.outputs['Color'], blend.inputs['B'])
        import film as F
        F.keys(blend.inputs['Factor'], 'default_value', [(fade[0], 0.0), (fade[1], 1.0)], interp='LINEAR')
        lights_col = blend.outputs['Result']
    g.link(lights_col, warm.inputs['A'])
    warm.inputs['B'].default_value = C.lin('#ffcc88')
    g.link(warm.outputs['Result'], bsdf.inputs['Emission Color'])
    strength = g.math('MULTIPLY', night.outputs['Result'], lights)
    g.link(strength, bsdf.inputs['Emission Strength'])
    shader = bsdf.outputs[0]
    if rim > 0:
        lwr = g.node('ShaderNodeLayerWeight')
        lwr.inputs['Blend'].default_value = 0.2
        edge = g.node('ShaderNodeEmission')
        edge.inputs['Color'].default_value = C.lin('#4d8dff')
        g.link(g.math('MULTIPLY', g.math('POWER', lwr.outputs['Facing'], 6.0), rim), edge.inputs['Strength'])
        both = g.node('ShaderNodeAddShader')
        g.link(shader, both.inputs[0])
        g.link(edge.outputs[0], both.inputs[1])
        shader = both.outputs[0]
    out = g.node('ShaderNodeOutputMaterial')
    g.link(shader, out.inputs['Surface'])
    ob.data.materials.append(mat)
    # clouds and atmosphere ride on the planet
    clouds = _sphere_mesh('Clouds', 192, 96)
    clouds.parent, clouds.scale = ob, (1.012,) * 3
    cm = bpy.data.materials.new('Clouds')
    cm.use_nodes = True
    cm.surface_render_method = 'BLENDED'
    cg = N.Graph(cm)
    tc = cg.node('ShaderNodeTexImage', image=bpy.data.images.load(ctx.asset('textures/flight/clouds.webp'), check_existing=True))
    tc.image.colorspace_settings.name = 'Non-Color'
    cb = cg.node('ShaderNodeBsdfPrincipled')
    cb.inputs['Base Color'].default_value = (0.9, 0.92, 0.95, 1)
    cb.inputs['Roughness'].default_value = 1.0
    cg.link(cg.math('MULTIPLY', cg.channel(tc.outputs['Color'], 'Red'), 0.85), cb.inputs['Alpha'])
    co = cg.node('ShaderNodeOutputMaterial')
    cg.link(cb.outputs[0], co.inputs['Surface'])
    clouds.data.materials.append(cm)
    if not cloud_layer:
        bpy.data.objects.remove(clouds, do_unlink=True)
    atmo = _sphere_mesh('Atmosphere', 128, 64)
    atmo.parent, atmo.scale = ob, (1.03,) * 3
    am = bpy.data.materials.new('Atmosphere')
    am.use_nodes = True
    am.surface_render_method = 'BLENDED'
    ag = N.Graph(am)
    lw = ag.node('ShaderNodeLayerWeight')
    lw.inputs['Blend'].default_value = 0.5
    # a soft band: rises toward the limb, fades out before the shell's own edge
    rise = ag.node('ShaderNodeMapRange', interpolation_type='SMOOTHSTEP', clamp=True)
    ag.link(lw.outputs['Facing'], rise.inputs['Value'])
    rise.inputs['From Min'].default_value, rise.inputs['From Max'].default_value = 0.5, 0.95
    fall = ag.node('ShaderNodeMapRange', interpolation_type='SMOOTHSTEP', clamp=True)
    ag.link(lw.outputs['Facing'], fall.inputs['Value'])
    fall.inputs['From Min'].default_value, fall.inputs['From Max'].default_value = 0.965, 1.0
    fall.inputs['To Min'].default_value, fall.inputs['To Max'].default_value = 1.0, 0.0
    rim = ag.math('MULTIPLY', rise.outputs['Result'], fall.outputs['Result'])
    lit = ag.math('ADD', 0.18, ag.math('MAXIMUM', 0.0, ag.vmath('DOT_PRODUCT', ag.geometry('Normal'), tuple(sun_dir))))
    em_n = ag.node('ShaderNodeEmission')
    em_n.inputs['Color'].default_value = C.lin('#4d8dff')
    ag.link(ag.math('MULTIPLY', ag.math('MULTIPLY', rim, lit), 2.2), em_n.inputs['Strength'])
    tr = ag.node('ShaderNodeBsdfTransparent')
    add = ag.node('ShaderNodeAddShader')
    ag.link(tr.outputs[0], add.inputs[0])
    ag.link(em_n.outputs[0], add.inputs[1])
    ao = ag.node('ShaderNodeOutputMaterial')
    ag.link(add.outputs[0], ao.inputs['Surface'])
    atmo.data.materials.append(am)
    if not atmosphere:
        bpy.data.objects.remove(atmo, do_unlink=True)
    if aurora:
        # a curtain standing on the auroral oval: rays that change along the oval
        # but not with height, green at the foot, fading upward into red
        import film as F
        lat = math.radians(67.0)
        band = C.link(bpy.data.objects.new('Aurora', bpy.data.meshes.new('Aurora')))
        bm = C.lathe([(math.cos(lat) * r, math.sin(lat) * r) for r in (1.006, 1.02, 1.04, 1.06, 1.08)], n=256)
        bm.to_mesh(band.data)
        bm.free()
        band.parent = ob
        band.rotation_euler = (math.radians(-90), 0, 0)
        um = bpy.data.materials.new('Aurora')
        um.use_nodes = True
        um.surface_render_method = 'BLENDED'
        ug = N.Graph(um)
        p = ug.coords('Object')
        x, y, _ = ug.xyz(p)
        foot = ug.node('ShaderNodeMapRange', interpolation_type='SMOOTHSTEP', clamp=True)
        ug.link(ug.vmath('DISTANCE', p, (0.0, 0.0, 0.0)), foot.inputs['Value'])
        foot.inputs['From Min'].default_value, foot.inputs['From Max'].default_value = 1.008, 1.08
        foot.inputs['To Min'].default_value, foot.inputs['To Max'].default_value = 1.0, 0.0
        around = ug.vmath('NORMALIZE', ug.combine(x, y, 0.0))   # the unit circle: seamless and height-free
        rays = ug.noise(around, 7.0, 3, detail=3.0)
        F.keys(rays.node.inputs['W'], 'default_value', [(0, 0.0), (ctx.duration, 0.8)], interp='LINEAR')
        level = ug.node('ShaderNodeMapRange', clamp=True)
        ug.link(rays, level.inputs['Value'])
        level.inputs['From Min'].default_value, level.inputs['From Max'].default_value = 0.35, 0.7
        level.inputs['To Min'].default_value = 0.15
        tint = ug.node('ShaderNodeMix', data_type='RGBA')
        ug.link(foot.outputs['Result'], tint.inputs['Factor'])
        tint.inputs['A'].default_value = C.lin('#ff4f8b')
        tint.inputs['B'].default_value = C.lin('#5dff9a')
        ue = ug.node('ShaderNodeEmission')
        ug.link(tint.outputs['Result'], ue.inputs['Color'])
        ug.link(ug.math('MULTIPLY', ug.math('MULTIPLY', ug.math('POWER', foot.outputs['Result'], 1.3), level.outputs['Result']), 2.2),
                ue.inputs['Strength'])
        ut = ug.node('ShaderNodeBsdfTransparent')
        ua = ug.node('ShaderNodeAddShader')
        ug.link(ut.outputs[0], ua.inputs[0])
        ug.link(ue.outputs[0], ua.inputs[1])
        uo = ug.node('ShaderNodeOutputMaterial')
        ug.link(ua.outputs[0], uo.inputs['Surface'])
        band.data.materials.append(um)
    return EarthRig(ob, home, inland, radius)
