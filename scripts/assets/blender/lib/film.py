# Story films (PLAN R9, SPEC-021 §5): the shared machinery behind films.py —
# shots and films, render settings and the compositor, the resumable frame
# cache, the flash check (WCAG 2.3.1), the sequencer encode to H.264, posters
# and the manifest — plus the small scene helpers every shot uses.
#
# Shots are built from scratch in their own scene, rendered to PNG frames in a
# cache outside the repository (keyed by a hash of the shot's code), and cut
# together back to back by the sequencer. Timing lives in src/data/films.ts;
# tests/data/films.test.ts compares it with the manifest this writes.
import hashlib
import inspect
import json
import math
import os
import random
import shutil
import sys
import tempfile
import time

import bpy
import numpy as np
from mathutils import Vector

import common as C

FPS = 24
WIDTH, HEIGHT = 960, 540
LOOK_VERSION = 2           # bump when the shared look changes: every shot re-renders
RATE_CAP = 44 * 1024       # bytes per second of film (SPEC-021 §5.4)
CRFS = (26, 29)
POSTER_QUALITY = 75


# ---------------------------------------------------------------- options


def options():
    """C.options() plus --frames=<dir>, --draft, --stills, --shots=<id,…> and
    --at=<s,…> (shot-local seconds a still renders instead of the poster)."""
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    opts = {'out': None, 'preview': None, 'frames': None, 'draft': False, 'stills': False, 'shots': [], 'only': [], 'at': []}
    for arg in argv:
        if arg.startswith('--out='):
            opts['out'] = arg[len('--out='):]
        elif arg.startswith('--preview='):
            opts['preview'] = arg[len('--preview='):] or None
        elif arg.startswith('--frames='):
            opts['frames'] = arg[len('--frames='):] or None
        elif arg == '--draft':
            opts['draft'] = True
        elif arg == '--stills':
            opts['stills'] = True
        elif arg.startswith('--shots='):
            opts['shots'].extend(a for a in arg[len('--shots='):].split(',') if a)
        elif arg.startswith('--at='):
            opts['at'].extend(float(a) for a in arg[len('--at='):].split(',') if a)
        elif not arg.startswith('--'):
            opts['only'].extend(a for a in arg.split(',') if a)
    if not opts['out']:
        raise SystemExit('pass --out=<public/assets>')
    if not opts['frames']:
        opts['frames'] = os.path.join(tempfile.gettempdir(), 'reallm-films')
    return opts


# ------------------------------------------------------------ shots, films


class Shot:
    def __init__(self, id, start, end, poster, build, samples=16, deps=(), bloom=0.5, vignette=0.14):
        self.id, self.start, self.end, self.poster = id, start, end, poster
        self.build, self.samples, self.deps = build, samples, tuple(deps)
        self.bloom, self.vignette = bloom, vignette

    @property
    def frames(self):
        return round((self.end - self.start) * FPS)


class Film:
    def __init__(self, id, shots, flashes=()):
        self.id, self.shots, self.flashes = id, shots, tuple(flashes)

    @property
    def frames(self):
        return sum(s.frames for s in self.shots)


class Ctx:
    """What a shot's build function gets: the scene, its timing and helpers."""

    def __init__(self, scene, film, shot, opts):
        self.scene, self.film, self.shot, self.opts = scene, film, shot, opts
        self.duration = shot.end - shot.start
        self.rng = random.Random(f'{film.id}/{shot.id}')
        self.draft = opts['draft']

    def asset(self, rel):
        return os.path.join(self.opts['out'], rel)


def frame(t):
    """Shot-local seconds → frame number (frames start at 1)."""
    return 1 + int(round(t * FPS))


# ------------------------------------------------------------ keyframes


def key(target, path, t, value, interp=None):
    """Set target.path = value and key it at shot time t (seconds). `interp`
    ('LINEAR', 'CONSTANT', …) is set on the new keys themselves: Blender 5
    ignores the new-keyframe preference for keys inserted from Python."""
    f = frame(t)
    setattr(target, path, value)
    target.keyframe_insert(data_path=path, frame=f)
    if not interp:
        return
    from bpy_extras import anim_utils
    ad = target.id_data.animation_data
    bag = anim_utils.action_get_channelbag_for_slot(ad.action, ad.action_slot)
    full = target.path_from_id(path)
    for fc in bag.fcurves if bag else ():
        if fc.data_path == full:
            for kp in fc.keyframe_points:
                if abs(kp.co.x - f) < 0.5:
                    kp.interpolation = interp


def keys(target, path, pairs, interp=None):
    for t, v in pairs:
        key(target, path, t, v, interp)


# ------------------------------------------------------------ scene helpers


def smoothstep(e0, e1, x):
    t = min(max((x - e0) / (e1 - e0), 0.0), 1.0)
    return t * t * (3 - 2 * t)


def camera(loc, target, lens=35.0, clip=(0.05, 500.0)):
    """A camera tracking an empty. Animate either; returns (camera, target)."""
    data = bpy.data.cameras.new('Cam')
    data.lens = lens
    data.clip_start, data.clip_end = clip
    cam = C.link(bpy.data.objects.new('Cam', data))
    cam.location = loc
    aim = C.link(bpy.data.objects.new('Aim', None))
    aim.location = target
    con = cam.constraints.new('TRACK_TO')
    con.target = aim
    con.track_axis, con.up_axis = 'TRACK_NEGATIVE_Z', 'UP_Y'
    bpy.context.scene.camera = cam
    return cam, aim


def sun(direction, energy=3.0, color='#fff1dc', angle=0.02):
    """A sun shining along `direction` (the way the light travels)."""
    light = bpy.data.lights.new('Sun', 'SUN')
    light.energy, light.color, light.angle = energy, C.lin(color)[:3], angle
    obj = C.link(bpy.data.objects.new('Sun', light))
    obj.rotation_euler = Vector(direction).normalized().to_track_quat('-Z', 'Y').to_euler()
    return obj


def lamp(loc, energy, color='#ffffff', radius=0.1, kind='POINT', shadow=True):
    light = bpy.data.lights.new('Lamp', kind)
    light.energy, light.color = energy, C.lin(color)[:3]
    if kind in ('POINT', 'SPOT'):
        light.shadow_soft_size = radius
    light.use_shadow = shadow
    obj = C.link(bpy.data.objects.new('Lamp', light))
    obj.location = loc
    return obj


def world(color='#000000', strength=1.0, stars=0.0, star_scale=160.0, star_width=0.09, seed=5):
    """A flat world colour, optionally with a procedural star field."""
    import nodes as N
    w = bpy.data.worlds.new('World')
    w.use_nodes = True
    g = N.Graph(w)
    back = g.node('ShaderNodeBackground')
    out = g.node('ShaderNodeOutputWorld')
    g.link(back.outputs[0], out.inputs['Surface'])
    base = C.lin(color)
    if stars > 0:
        d = g.vmath('NORMALIZE', g.coords('Generated'))
        f1 = g.voronoi(d, star_scale, seed)
        pt = g.math('EXPONENT', g.math('MULTIPLY', g.math('POWER', g.math('DIVIDE', f1, star_width), 2.0), -1.0))
        cell = g.channel(g.voronoi(d, star_scale, seed, out='Color'), 'Red')
        bright = g.math('MULTIPLY', pt, g.math('MULTIPLY', g.math('POWER', cell, 3.0), stars))
        col = g.node('ShaderNodeMix', data_type='RGBA', blend_type='ADD')
        col.inputs['Factor'].default_value = 1.0
        col.inputs['A'].default_value = base
        g.link(g.combine(bright, bright, bright), col.inputs['B'])
        g.link(col.outputs['Result'], back.inputs['Color'])
    else:
        back.inputs['Color'].default_value = base
    back.inputs['Strength'].default_value = strength
    bpy.context.scene.world = w
    return w


def mat(name, color, rough=0.6, metal=0.0, emission=None, strength=0.0):
    return C.mat_flat(name, color, rough, metal, emission, strength)


def emit(name, color, strength=4.0):
    """An emission-only material; animate `.node_tree.nodes['Emission'].inputs[1]`."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    e = nt.nodes.new('ShaderNodeEmission')
    e.name = 'Emission'
    e.inputs['Color'].default_value = C.lin(color)
    e.inputs['Strength'].default_value = strength
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    nt.links.new(e.outputs[0], out.inputs['Surface'])
    return m


def strength_socket(m):
    """The animatable strength of an emit() material or a mat_flat emission."""
    nt = m.node_tree
    if 'Emission' in nt.nodes:
        return nt.nodes['Emission'].inputs['Strength']
    return next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED').inputs['Emission Strength']


def glow(name, color, strength=2.0, opacity=1.0):
    """Additive light (transparent + emission) for beams, halos, exhaust."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    m.surface_render_method = 'BLENDED'
    nt = m.node_tree
    nt.nodes.clear()
    e = nt.nodes.new('ShaderNodeEmission')
    e.name = 'Emission'
    e.inputs['Color'].default_value = C.lin(color)
    e.inputs['Strength'].default_value = strength * opacity
    tr = nt.nodes.new('ShaderNodeBsdfTransparent')
    add = nt.nodes.new('ShaderNodeAddShader')
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    nt.links.new(tr.outputs[0], add.inputs[0])
    nt.links.new(e.outputs[0], add.inputs[1])
    nt.links.new(add.outputs[0], out.inputs['Surface'])
    return m


def beam(name, color, strength=2.0, power=1.5):
    """glow() with soft edges: full strength where the surface faces the camera,
    nothing at its silhouette — light shafts without the hard edge of a tube."""
    m = glow(name, color, strength)
    nt = m.node_tree
    add = next(n for n in nt.nodes if n.type == 'ADD_SHADER')
    out = next(n for n in nt.nodes if n.type == 'OUTPUT_MATERIAL')
    lw = nt.nodes.new('ShaderNodeLayerWeight')
    lw.inputs['Blend'].default_value = 0.5
    facing = nt.nodes.new('ShaderNodeMath')
    facing.operation = 'SUBTRACT'
    facing.inputs[0].default_value = 1.0
    nt.links.new(lw.outputs['Facing'], facing.inputs[1])
    soft = nt.nodes.new('ShaderNodeMath')
    soft.operation = 'POWER'
    soft.inputs[1].default_value = power
    nt.links.new(facing.outputs[0], soft.inputs[0])
    mix = nt.nodes.new('ShaderNodeMixShader')   # clear, plus fac × the light: still purely additive
    nt.links.new(soft.outputs[0], mix.inputs[0])
    nt.links.new(nt.nodes.new('ShaderNodeBsdfTransparent').outputs[0], mix.inputs[1])
    nt.links.new(add.outputs[0], mix.inputs[2])
    nt.links.new(mix.outputs[0], out.inputs['Surface'])
    return m


def image(path, colorspace='sRGB'):
    img = bpy.data.images.load(path, check_existing=True)
    img.colorspace_settings.name = colorspace
    return img


def textured(name, path, emission=0.0, alpha=False, rough=0.7, tint=None):
    """An image-mapped material (UVs); alpha from the image when asked."""
    m, nt, bsdf = C._principled(name)
    tn = nt.nodes.new('ShaderNodeTexImage')
    tn.image = image(path)
    col = tn.outputs['Color']
    if tint is not None:
        mix = nt.nodes.new('ShaderNodeMix')
        mix.data_type, mix.blend_type = 'RGBA', 'MULTIPLY'
        mix.inputs['Factor'].default_value = 1.0
        nt.links.new(col, mix.inputs['A'])
        mix.inputs['B'].default_value = C.lin(tint)
        col = mix.outputs['Result']
    nt.links.new(col, bsdf.inputs['Base Color'])
    bsdf.inputs['Roughness'].default_value = rough
    if emission > 0:
        nt.links.new(col, bsdf.inputs['Emission Color'])
        bsdf.inputs['Emission Strength'].default_value = emission
    if alpha:
        m.surface_render_method = 'BLENDED'
        nt.links.new(tn.outputs['Alpha'], bsdf.inputs['Alpha'])
    return m


def obj(name, bm, material=None, loc=(0, 0, 0), rot=(0, 0, 0), scale=(1, 1, 1), smooth=False):
    """A bmesh part → a linked object with one material."""
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    if smooth:
        for p in mesh.polygons:
            p.use_smooth = True
    o = C.link(bpy.data.objects.new(name, mesh))
    if material is not None:
        mesh.materials.append(material)
    o.location = loc
    o.rotation_euler = [math.radians(a) for a in rot]
    o.scale = scale
    return o


def plane(name, sx, sy, material=None, loc=(0, 0, 0), rot=(0, 0, 0)):
    import bmesh
    bm = bmesh.new()
    uv = bm.loops.layers.uv.new('UVMap')
    vs = [bm.verts.new((x * sx / 2, y * sy / 2, 0)) for x, y in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
    f = bm.faces.new(vs)
    for loop, (u, v) in zip(f.loops, ((0, 0), (1, 0), (1, 1), (0, 1))):
        loop[uv].uv = (u, v)
    return obj(name, bm, material, loc, rot)


def text(body, size, material, loc=(0, 0, 0), rot=(90, 0, 0), extrude=0.0, align='CENTER'):
    cu = bpy.data.curves.new('Text', 'FONT')
    cu.body, cu.size, cu.extrude = body, size, extrude
    cu.align_x, cu.align_y = align, 'CENTER'
    o = C.link(bpy.data.objects.new('Text', cu))
    o.data.materials.append(material)
    o.location = loc
    o.rotation_euler = [math.radians(a) for a in rot]
    return o


def import_glb(path, loc=(0, 0, 0), rot=(0, 0, 0), scale=1.0):
    """Import a committed GLB under one empty; returns the empty."""
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    new = [o for o in bpy.data.objects if o not in before]
    root = C.link(bpy.data.objects.new(os.path.basename(path), None))
    for o in new:
        if o.parent is None:
            o.parent = root
    root.location = loc
    root.rotation_euler = [math.radians(a) for a in rot]
    root.scale = (scale,) * 3
    return root


def children(root):
    out = []
    stack = list(root.children)
    while stack:
        o = stack.pop()
        out.append(o)
        stack.extend(o.children)
    return out


# ------------------------------------------------------------ render setup


def compositor(scene, bloom, vignette):
    ng = bpy.data.node_groups.new('FilmComp', 'CompositorNodeTree')
    ng.interface.new_socket('Image', in_out='OUTPUT', socket_type='NodeSocketColor')
    rl = ng.nodes.new('CompositorNodeRLayers')
    img = rl.outputs['Image']
    if bloom > 0:
        glare = ng.nodes.new('CompositorNodeGlare')
        glare.inputs['Type'].default_value = 'Bloom'
        glare.inputs['Quality'].default_value = 'High'
        glare.inputs['Threshold'].default_value = 0.9
        glare.inputs['Strength'].default_value = bloom
        glare.inputs['Size'].default_value = 0.6
        ng.links.new(img, glare.inputs['Image'])
        img = glare.outputs['Image']
    if vignette > 0:
        mask = ng.nodes.new('CompositorNodeEllipseMask')
        mask.inputs['Size'].default_value = (1.15, 1.25)
        blur = ng.nodes.new('CompositorNodeBlur')
        blur.inputs['Size'].default_value = (160, 160)
        ng.links.new(mask.outputs['Mask'], blur.inputs['Image'])
        lift = ng.nodes.new('ShaderNodeMix')
        lift.data_type = 'FLOAT'
        lift.inputs['A'].default_value = 1.0 - vignette
        lift.inputs['B'].default_value = 1.0
        ng.links.new(blur.outputs['Image'], lift.inputs['Factor'])
        mul = ng.nodes.new('ShaderNodeMix')
        mul.data_type, mul.blend_type = 'RGBA', 'MULTIPLY'
        mul.inputs['Factor'].default_value = 1.0
        ng.links.new(img, mul.inputs['A'])
        ng.links.new(lift.outputs['Result'], mul.inputs['B'])
        img = mul.outputs['Result']
    out = ng.nodes.new('NodeGroupOutput')
    ng.links.new(img, out.inputs[0])
    scene.compositing_node_group = ng
    scene.render.use_compositing = True


def setup(scene, shot, draft):
    r = scene.render
    r.engine = 'BLENDER_EEVEE'
    r.resolution_x, r.resolution_y = WIDTH, HEIGHT
    r.resolution_percentage = 50 if draft else 100
    r.fps = FPS
    scene.frame_start, scene.frame_end = 1, shot.frames
    scene.eevee.taa_render_samples = 8 if draft else shot.samples
    scene.view_settings.view_transform = 'AgX'
    scene.view_settings.look = 'None'
    r.use_motion_blur = not draft
    r.motion_blur_shutter = 0.5
    r.film_transparent = False
    r.image_settings.media_type = 'IMAGE'
    r.image_settings.file_format = 'PNG'
    r.image_settings.color_mode = 'RGB'
    r.image_settings.color_depth = '8'
    r.use_overwrite = False
    r.use_placeholder = False
    compositor(scene, shot.bloom, shot.vignette)


# ------------------------------------------------------------ frame cache


def shot_dir(opts, film, shot):
    return os.path.join(opts['frames'], 'draft' if opts['draft'] else 'full', film.id, shot.id)


def frame_path(d, i):
    return os.path.join(d, f'f_{i:04d}.png')


def shot_hash(shot, draft):
    h = hashlib.sha1()
    h.update(inspect.getsource(shot.build).encode())
    for mod in shot.deps:
        h.update(inspect.getsource(mod).encode())
    h.update(repr((shot.start, shot.end, shot.samples, shot.bloom, shot.vignette, WIDTH, HEIGHT, LOOK_VERSION, draft,
                   bpy.app.version_string)).encode())
    return h.hexdigest()


def render_shot(film, shot, opts):
    d = shot_dir(opts, film, shot)
    os.makedirs(d, exist_ok=True)
    digest = shot_hash(shot, opts['draft'])
    stamp = os.path.join(d, 'hash.txt')
    if not os.path.exists(stamp) or open(stamp).read() != digest:
        for f in os.listdir(d):
            os.remove(os.path.join(d, f))
    missing = [i for i in range(1, shot.frames + 1) if not os.path.exists(frame_path(d, i))]
    if not missing:
        return d
    scene = C.reset()
    setup(scene, shot, opts['draft'])
    shot.build(Ctx(scene, film, shot, opts))
    scene.render.filepath = os.path.join(d, 'f_')
    started = time.time()
    bpy.ops.render.render(animation=True)
    with open(stamp, 'w') as fh:
        fh.write(digest)
    took = time.time() - started
    print(f'NOTE {film.id}/{shot.id}: {len(missing)} frames in {took:.0f} s ({took / max(len(missing), 1):.2f} s/frame)')
    return d


# ------------------------------------------------------------ flash check


def _load(path):
    img = bpy.data.images.load(path)
    img.colorspace_settings.name = 'Non-Color'
    w, h = img.size
    px = np.empty(w * h * 4, np.float32)
    img.pixels.foreach_get(px)
    bpy.data.images.remove(img)
    return px.reshape(h, w, 4)[::-1, :, :3]


def luminance(d, frames):
    """Per frame: (mean relative luminance, saturated-red area) on a 96 × 54 grid."""
    cache = os.path.join(d, 'lum.npy')
    if os.path.exists(cache):
        a = np.load(cache)
        if len(a) == frames:
            return a
    out = []
    for i in range(1, frames + 1):
        a = _load(frame_path(d, i))
        h, w = a.shape[:2]
        fy, fx = h // 54, w // 96
        a = a[:54 * fy, :96 * fx].reshape(54, fy, 96, fx, 3).mean((1, 3))
        lin = np.where(a <= 0.04045, a / 12.92, ((a + 0.055) / 1.055) ** 2.4)
        y = 0.2126 * lin[..., 0] + 0.7152 * lin[..., 1] + 0.0722 * lin[..., 2]
        red = ((lin[..., 0] >= 0.8 * lin.sum(-1)) & (lin[..., 0] >= 0.3)).mean()
        out.append((float(y.mean()), float(red)))
    a = np.array(out, np.float32)
    np.save(cache, a)
    return a


def pivots(series, h=0.10):
    """Turning points of `series` with hysteresis h (a zig-zag)."""
    pts, trend = [], 0
    start_i, ext_i = 0, 0
    for i, v in enumerate(series):
        if trend == 0:
            if abs(v - series[start_i]) >= h:
                pts.append(start_i)
                trend, ext_i = (1 if v > series[start_i] else -1), i
        elif (trend == 1 and v > series[ext_i]) or (trend == -1 and v < series[ext_i]):
            ext_i = i
        elif abs(series[ext_i] - v) >= h:
            pts.append(ext_i)
            trend, ext_i = -trend, i
    if trend != 0:
        pts.append(ext_i)
    return pts


def flash_check(film, lum):
    """WCAG general flash: pairs of opposing ≥ 0.10 swings whose darker end is
    < 0.80; at most three in any 24 frames. Red: no ≥ 25 % jump in saturated red."""
    y, red = lum[:, 0], lum[:, 1]
    p = pivots(list(y))
    flashes = []
    for k in range(0, len(p) - 2, 2):
        a, b, c = y[p[k]], y[p[k + 1]], y[p[k + 2]]
        if min(a, b, c) < 0.80:
            flashes.append(p[k + 1])
    worst = 0
    for f0 in flashes:
        worst = max(worst, sum(1 for f in flashes if f0 <= f < f0 + FPS))
    jumps = np.nonzero(np.abs(np.diff(red)) >= 0.25)[0]
    print(f'NOTE {film.id} flashes: {len(flashes)} (max {worst} in a second) at frames {[f + 1 for f in flashes][:8]}')
    problems = []
    if worst > 3:
        problems.append(f'{film.id}: {worst} flashes within 24 frames')
    if len(jumps):
        problems.append(f'{film.id}: saturated-red transitions at frames {[int(j) + 1 for j in jumps[:8]]}')
    return problems


# ------------------------------------------------------------ encode


def encode(film, dirs, path, crf, draft):
    scene = bpy.data.scenes.new(f'{film.id}__edit')
    r = scene.render
    r.resolution_x, r.resolution_y = (WIDTH // 2, HEIGHT // 2) if draft else (WIDTH, HEIGHT)
    r.resolution_percentage = 100
    r.fps = FPS
    scene.frame_start, scene.frame_end = 1, film.frames
    scene.view_settings.view_transform = 'Standard'
    scene.view_settings.look = 'None'
    scene.sequencer_colorspace_settings.name = 'sRGB'
    sed = scene.sequence_editor_create()
    at = 1
    for shot, d in zip(film.shots, dirs):
        strip = sed.strips.new_image(shot.id, frame_path(d, 1), 1, at)
        for i in range(2, shot.frames + 1):
            strip.elements.append(os.path.basename(frame_path(d, i)))
        at += shot.frames
    r.use_sequencer = True
    r.use_compositing = False
    r.image_settings.media_type = 'VIDEO'
    r.image_settings.file_format = 'FFMPEG'
    ff = r.ffmpeg
    ff.format, ff.codec = 'MPEG4', 'H264'
    ff.constant_rate_factor = 'CUSTOM'
    ff.custom_constant_rate_factor = crf
    ff.ffmpeg_preset = 'GOOD'
    ff.gopsize = 48
    ff.use_max_b_frames, ff.max_b_frames = True, 2
    ff.audio_codec = 'NONE'
    ff.use_autosplit = False
    tmp = tempfile.mkdtemp(prefix='reallm-encode-')
    r.filepath = os.path.join(tmp, f'{film.id}_')
    r.use_file_extension = True
    bpy.ops.render.render(animation=True, scene=scene.name)
    made = [f for f in os.listdir(tmp) if f.endswith('.mp4')]
    if len(made) != 1:
        raise RuntimeError(f'{film.id}: encoder wrote {made}')
    shutil.move(os.path.join(tmp, made[0]), C.ensure_dir(path))
    shutil.rmtree(tmp, ignore_errors=True)
    bpy.data.scenes.remove(scene)
    return os.path.getsize(path)


def verify(film, path, draft):
    clip = bpy.data.movieclips.load(path)
    frames, size = clip.frame_duration, tuple(clip.size)
    bpy.data.movieclips.remove(clip)
    want = (WIDTH // 2, HEIGHT // 2) if draft else (WIDTH, HEIGHT)
    if frames != film.frames or size != want:
        raise RuntimeError(f'{film.id}: {path} has {frames} frames at {size}, want {film.frames} at {want}')


# ------------------------------------------------------------ posters, manifest


def poster(film, shot, d, out_root):
    i = min(max(int(round((shot.poster - shot.start) * FPS)) + 1, 1), shot.frames)
    rgb = _load(frame_path(d, i))
    rel = f'films/posters/{film.id}_{shot.id}.webp'
    size = C.save_image(os.path.join(out_root, rel), rgb, 'WEBP', POSTER_QUALITY)
    return rel, size, frame_path(d, i)


def write_manifest(out_root, entries, order):
    path = os.path.join(out_root, 'films', 'manifest.json')
    films = {}
    if os.path.exists(path):
        with open(path) as fh:
            films = json.load(fh).get('films', {})
    films.update(entries)
    films = {k: films[k] for k in order if k in films and os.path.exists(os.path.join(out_root, films[k]['file']))}
    data = {'version': 1, 'fps': FPS, 'width': WIDTH, 'height': HEIGHT, 'films': films}
    with open(C.ensure_dir(path), 'w') as fh:
        json.dump(data, fh, indent=2)
        fh.write('\n')
    print('ASSET films/manifest.json')


def build_film(film, opts):
    """Render (or reuse) every shot, check flashes, encode, poster, verify."""
    dirs = [render_shot(film, shot, opts) for shot in film.shots]
    lum = np.concatenate([luminance(d, s.frames) for s, d in zip(film.shots, dirs)])
    problems = flash_check(film, lum)
    if problems and not opts['draft']:
        raise RuntimeError('; '.join(problems))
    C.reset()
    draft = opts['draft']
    if draft:
        path = os.path.join(opts['preview'] or opts['frames'], f'draft_{film.id}.mp4')
        size = encode(film, dirs, path, CRFS[0], True)
        verify(film, path, True)
        print(f'PREVIEW {path} {size} bytes')
        return None, dirs
    rel = f'films/{film.id}.mp4'
    path = os.path.join(opts['out'], rel)
    duration = film.frames / FPS
    for crf in CRFS:
        size = encode(film, dirs, path, crf, False)
        if size / duration <= RATE_CAP:
            break
    else:
        raise RuntimeError(f'{film.id}: {size / duration / 1024:.1f} KB/s at CRF {crf}, over the 44 KB/s cap')
    verify(film, path, False)
    print(f'ASSET {rel} {size} bytes, {size / duration / 1024:.1f} KB/s, CRF {crf}')
    shots, at = [], 0
    for shot, d in zip(film.shots, dirs):
        prel, psize, _ = poster(film, shot, d, opts['out'])
        shots.append({'id': shot.id, 'start': at, 'end': at + shot.frames, 'poster': prel, 'posterBytes': psize})
        at += shot.frames
    return {'file': rel, 'frames': film.frames, 'bytes': size, 'crf': crf, 'shots': shots}, dirs


def sheet(film, dirs, out):
    import preview as PV
    paths = []
    for shot, d in zip(film.shots, dirs):
        i = min(max(int(round((shot.poster - shot.start) * FPS)) + 1, 1), shot.frames)
        paths.append(frame_path(d, i))
    return PV.sheet(paths, out, cols=3)
