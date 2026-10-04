# Photographic plates (PLAN R11, R12; SPEC-021 §5.7): a shot whose picture is
# one committed image under scripts/assets/blender/plates/ instead of built
# geometry. The plate is emitted from a plane under an orthographic camera and
# fitted to cover the frame, so the frame *is* the image, at any aspect and
# never stretched; a slow push, pull-out or drift gives the shot the motion the
# geometry shot had, and the film's bloom, vignette and motion blur still run
# over it. A plate carries its own grade, so it renders through the Standard
# view transform rather than the AgX every other shot uses. `plates/selection/`
# holds the six faces the Selection wall pins to its cards, and the salvager's
# own card: the suit, visor down (SPEC-051 §4.1).
#
# SPEC-051 adds three things a plate can do: unmake (the picture turns into a
# posterised grey under a UV grid, keeping its mean luminance — §4.3), carry
# overlays (emissive discs keyed by group: the Machines' eyes — §4.2), and stand
# behind a perspective camera as a backdrop, so a model can stand in front of
# the photograph (§4.6).
#
# The frame cache keys on the image bytes as well as on the code (Shot.plates,
# film.shot_hash), so dropping a new image in re-renders its shot.
import math
import os

import bpy
import numpy as np
from mathutils import Vector

import common as C
import film as F
import nodes as N

DIR = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'plates'))
ASPECT = F.WIDTH / F.HEIGHT
DIST = 2.0                 # the camera's distance from the plate: ortho, so only the sign matters
SPAN = 2.0                 # the width of the widest frame; the plate is cut to cover it
# SPEC-051 §4.1: card 62's ID photograph — the suit in the tug's flight helmet, visor
# down — and the same frame with the visor clear onto an empty helmet
VISOR = os.path.join(DIR, 'selection', 'visor.webp')
VISOR_EMPTY = os.path.join(DIR, 'selection', 'visor_empty.webp')
LEVELS = 4                 # unmake: the grey's posterisation
GRID = 1024                # unmake: the side of Blender's generated UV grid
GRID_OPACITY = 0.35        # unmake: how far the grid's lines darken the grey
UNMAKE_TOLERANCE = 0.02    # unmake: the grey's mean luminance against the picture's (a fifth of a flash swing)
EYE = '#ff3b30'            # an overlay disc lit
EYE_STRENGTH = 6.0
EYE_FLICKER = 4.0          # the strength of the one frame a group dips to before it goes out
EYE_OUT = 0.5              # seconds an overlay takes to go out


def path(name):
    """The committed plate `name` — at least 960 × 540; any aspect, cropped to fill."""
    return os.path.join(DIR, f'{name}.jpg')


def face(n):
    """A Selection card's photograph — plates/selection/NN.webp (PLAN R12), cut
    from one sheet of six survivors; the wall shows each of them twice."""
    return os.path.join(DIR, 'selection', f'{n:02d}.webp')


FACES = tuple(face(n) for n in range(1, 7))


# ------------------------------------------------------------ the pictures


def _pixels(plate, step=1):
    """The plate's pixels as H×W×3 sRGB-encoded floats, row 0 at the top; `step` thins them."""
    img = bpy.data.images.load(plate, check_existing=False)
    img.colorspace_settings.name = 'Non-Color'
    w, h = img.size
    px = np.empty(w * h * 4, np.float32)
    img.pixels.foreach_get(px)
    bpy.data.images.remove(img)
    return px.reshape(h, w, 4)[::-1, :, :3][::step, ::step], w / h


def _linear(a):
    return np.where(a <= 0.04045, a / 12.92, ((a + 0.055) / 1.055) ** 2.4)


def _luma(lin):
    return 0.2126 * lin[..., 0] + 0.7152 * lin[..., 1] + 0.0722 * lin[..., 2]


def _saturated(lin, saturation):
    """What Blender's Hue/Saturation node makes of linear `lin`: HSV value kept, saturation scaled."""
    v = lin.max(-1, keepdims=True)
    return v - saturation * (v - lin)


def mean(plate, saturation=1.0):
    """The plate's mean relative luminance as it is emitted at exposure 1 (linear)."""
    a, _ = _pixels(plate, 4)
    return float(_luma(_saturated(_linear(a), saturation)).mean())


def uv_grid():
    """Blender's generated UV test grid (GRID²), shared by every unmade plate in the scene."""
    img = bpy.data.images.get('PlateGrid')
    if img is None:
        img = bpy.data.images.new('PlateGrid', GRID, GRID)
        img.generated_type = 'UV_GRID'
    return img


def unmade_stats(plate, saturation=1.0):
    """§4.3: `(ref, gain, picture mean, grey mean)` for unmaking `plate`. The grey is
    the picture's HSV value — what saturation 0 leaves — over `ref` (its 99th
    percentile), posterised to LEVELS in display space, times the UV grid at
    GRID_OPACITY; `gain` scales it so its mean luminance is the picture's, so a
    picture turning grey is never a flash (E35)."""
    a, aspect = _pixels(plate, 4)
    lin = _linear(a)
    picture = float(_luma(_saturated(lin, saturation)).mean())
    v = lin.max(-1)
    ref = float(np.percentile(v, 99)) or 1.0
    level = np.power(np.round(np.power(np.minimum(v / ref, 1.0), 1 / 2.2) * (LEVELS - 1)) / (LEVELS - 1), 2.2)
    # the grid as the plane samples it: UV × (aspect, 1), repeated; rows from the bottom
    img = uv_grid()
    gw, gh = img.size
    gpx = np.empty(gw * gh * 4, np.float32)
    img.pixels.foreach_get(gpx)
    grid = _linear(gpx.reshape(gh, gw, 4)[..., :3])
    h, w = v.shape
    gx = (np.floor(((np.arange(w) + 0.5) / w * aspect) % 1.0 * gw)).astype(int) % gw
    gy = np.clip(((1 - (np.arange(h) + 0.5) / h) * gh).astype(int), 0, gh - 1)
    lines = 1 - GRID_OPACITY + GRID_OPACITY * grid[gy[:, None], gx[None, :]]
    grey = float((level * _luma(lines)).mean())
    gain = picture / grey if grey > 1e-6 else 1.0
    return ref, gain, picture, grey * gain


def _grey(g, tex, aspect, ref, gain):
    """§4.3's grey as nodes: the picture's value over `ref`, four levels in display
    space, the UV grid multiplied in at GRID_OPACITY, then `gain`."""
    hs = g.node('ShaderNodeHueSaturation')
    hs.inputs['Saturation'].default_value = 0.0      # saturation 0 keeps the HSV value: the brightest channel
    g.link(tex.outputs['Color'], hs.inputs['Color'])
    v = g.math('POWER', g.math('MINIMUM', g.math('DIVIDE', g.channel(hs.outputs['Color'], 'Red'), ref), 1.0), 1 / 2.2)
    v = g.math('POWER', g.math('DIVIDE', g.math('ROUND', g.math('MULTIPLY', v, LEVELS - 1)), LEVELS - 1), 2.2)
    grid = g.node('ShaderNodeTexImage', image=uv_grid(), extension='REPEAT')
    place = g.node('ShaderNodeMapping')
    place.inputs['Scale'].default_value = (aspect, 1.0, 1.0)   # square cells on any plate
    g.link(g.coords('UV'), place.inputs['Vector'])
    g.link(place.outputs['Vector'], grid.inputs['Vector'])
    lines = g.node('ShaderNodeMix', data_type='RGBA', blend_type='MULTIPLY')
    lines.inputs['Factor'].default_value = GRID_OPACITY
    g.link(g.combine(v, v, v), lines.inputs['A'])
    g.link(grid.outputs['Color'], lines.inputs['B'])
    scaled = g.node('ShaderNodeMix', data_type='RGBA', blend_type='MULTIPLY')
    scaled.inputs['Factor'].default_value = 1.0
    g.link(lines.outputs['Result'], scaled.inputs['A'])
    scaled.inputs['B'].default_value = (gain, gain, gain, 1.0)
    return scaled.outputs['Result']


def material(plate, exposure, saturation, unmake=None, start=0.0):
    """The plate as light: an emission shader, so no lamp or world can touch it.
    `unmake=(t0, t1)` blends it into §4.3's grey between those times (shot-local,
    after `start`)."""
    m = bpy.data.materials.new('Plate')
    m.use_nodes = True
    g = N.Graph(m)
    tex = g.node('ShaderNodeTexImage', image=F.image(plate), extension='EXTEND')
    aspect = tex.image.size[0] / tex.image.size[1]
    col = tex.outputs['Color']
    if saturation != 1.0:
        hs = g.node('ShaderNodeHueSaturation')
        hs.inputs['Saturation'].default_value = saturation
        g.link(col, hs.inputs['Color'])
        col = hs.outputs['Color']
    if unmake is not None:
        ref, gain, picture, grey = unmade_stats(plate, saturation)
        if abs(grey - picture) > UNMAKE_TOLERANCE:
            raise ValueError(f'{plate}: the unmade grey averages {grey:.3f} against the picture\'s {picture:.3f}')
        print(f'NOTE unmake {os.path.basename(plate)}: mean {picture:.3f}, grey {grey:.3f} (gain {gain:.2f})')
        mix = g.node('ShaderNodeMix', data_type='RGBA')
        g.link(col, mix.inputs['A'])
        g.link(_grey(g, tex, aspect, ref, gain), mix.inputs['B'])
        t0, t1 = unmake
        F.keys(mix.inputs['Factor'], 'default_value', [(start + t0, 0.0), (start + t1, 1.0)], interp='LINEAR')
        col = mix.outputs['Result']
    emit = g.node('ShaderNodeEmission')
    g.link(col, emit.inputs['Color'])
    emit.inputs['Strength'].default_value = exposure
    out = g.node('ShaderNodeOutputMaterial')
    g.link(emit.outputs['Emission'], out.inputs['Surface'])
    return m, emit, aspect


# ------------------------------------------------------------ overlays


def overlay_keys(groups):
    """{group: (t_off, flicker_frames)}: each group's eyes are lit from 0, flicker
    once, and go out at t_off. `groups` holds each group's t_off, group 0 first."""
    return {g: (t, 1) for g, t in enumerate(groups)}


def glints(plate, groups=3, count=(7, 9)):
    """The lit red slits on `plate` — the Machines' eyes of prologue_stranded.jpg —
    as ((u, v, radius, group), …) in plate space (u right, v up, radius in plate
    widths), numbered into `groups` from left to right. The build measures them
    so while `shots_prologue.STRANDED_EYES` is empty, and prints them to pin there."""
    a, _ = _pixels(plate)
    h, w = a.shape[:2]
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    todo = set(zip(*(i.tolist() for i in np.nonzero((r >= 0.5) & (r >= 1.8 * g) & (r >= 1.8 * b)))))
    blobs = []
    while todo:   # 8-connected blobs by flood fill; Blender's Python has no scipy
        stack = [todo.pop()]
        pts = []
        while stack:
            y, x = stack.pop()
            pts.append((y, x))
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    if (y + dy, x + dx) in todo:
                        todo.remove((y + dy, x + dx))
                        stack.append((y + dy, x + dx))
        if 4 <= len(pts) <= 0.002 * h * w:   # a slit, not a fire or a red sky
            blobs.append(np.array(pts, np.float32))
    blobs = sorted(blobs, key=len, reverse=True)[:count[1]]
    if len(blobs) < count[0]:
        raise ValueError(f'{plate}: {len(blobs)} lit eye slits found, want {count[0]}–{count[1]}; '
                         'measure them by hand into shots_prologue.STRANDED_EYES')
    eyes = []
    for pts in blobs:
        cy, cx = pts.mean(0)
        reach = max(float(np.ptp(pts[:, 0])), float(np.ptp(pts[:, 1]))) / 2 + 1.5
        eyes.append(((cx + 0.5) / w, 1 - (cy + 0.5) / h, reach / w))
    eyes.sort()
    out = tuple((round(u, 4), round(v, 4), round(rad, 4), i * groups // len(eyes)) for i, (u, v, rad) in enumerate(eyes))
    print(f'NOTE {os.path.basename(plate)} eyes: {out}')
    return out


def _eye(plate, w, h, at, exposure, key):
    """One group's disc material: lit, the eye's red at EYE_STRENGTH; out, the plate
    under the disc with its red taken away — (G, G, B) — so the slit goes dark."""
    m = bpy.data.materials.new('Eye')
    m.use_nodes = True
    g = N.Graph(m)
    x, _, z = g.xyz(g.geometry('Position'))
    uv = g.combine(g.math('ADD', g.math('DIVIDE', g.math('SUBTRACT', x, at[0]), w), 0.5),
                   g.math('ADD', g.math('DIVIDE', g.math('SUBTRACT', z, at[2]), h), 0.5), 0.0)
    tex = g.node('ShaderNodeTexImage', image=F.image(plate), extension='EXTEND')
    g.link(uv, tex.inputs['Vector'])
    sep = g.node('ShaderNodeSeparateColor')
    g.link(tex.outputs['Color'], sep.inputs['Color'])
    unlit = g.node('ShaderNodeCombineColor')
    g.link(sep.outputs['Green'], unlit.inputs['Red'])
    g.link(sep.outputs['Green'], unlit.inputs['Green'])
    g.link(sep.outputs['Blue'], unlit.inputs['Blue'])
    dark = g.node('ShaderNodeEmission')
    g.link(unlit.outputs['Color'], dark.inputs['Color'])
    dark.inputs['Strength'].default_value = exposure
    lit = g.node('ShaderNodeEmission')
    lit.inputs['Color'].default_value = C.lin(EYE)
    lit.inputs['Strength'].default_value = EYE_STRENGTH
    mix = g.node('ShaderNodeMixShader')
    mix.inputs[0].default_value = 1.0
    g.link(dark.outputs[0], mix.inputs[1])
    g.link(lit.outputs[0], mix.inputs[2])
    out = g.node('ShaderNodeOutputMaterial')
    g.link(mix.outputs[0], out.inputs['Surface'])
    if key is not None:
        t_off, flicker = key
        f = 1 / F.FPS
        fac = mix.inputs[0]
        F.key(fac, 'default_value', 0.0, 1.0, interp='CONSTANT')
        F.key(fac, 'default_value', t_off - (flicker + 2) * f, EYE_FLICKER / EYE_STRENGTH, interp='CONSTANT')
        F.key(fac, 'default_value', t_off - 2 * f, 1.0, interp='CONSTANT')
        F.key(fac, 'default_value', t_off, 1.0, interp='LINEAR')
        F.key(fac, 'default_value', t_off + EYE_OUT, 0.0, interp='CONSTANT')
    return m


def _overlays(plate, discs, off, w, h, at, exposure, start):
    keys = {g: (start + t, n) for g, (t, n) in overlay_keys(off).items()}
    mats = {}
    for u, v, r, group in discs:
        if group not in mats:
            mats[group] = _eye(plate, w, h, at, exposure, keys.get(group))
        loc = (at[0] + (u - 0.5) * w, at[1] - 0.01, at[2] + (v - 0.5) * h)   # just in front of the plate
        F.obj(f'Eye{group}', C.cyl(r * w, r * w, 0.002, n=20), mats[group], loc, (90, 0, 0))
    print(f'NOTE overlays: {len(discs)} discs in {len(mats)} groups')


# ------------------------------------------------------------ shots


def shot(plate, push=0.07, drift=(0.0, 0.0), exposure=1.0, saturation=1.0, flicker=0.0, rate=7.0, flash=None,
         lift=None, unmake=None, overlays=(), overlay_off=(), fade_in=None):
    """A build function that fills the frame with `plate`.

    `push` is how far the frame closes in over the shot (0.07 = 7 % tighter at
    the end; negative pulls out instead, starting tight and opening onto the
    whole frame), `drift` where the tighter end of the move sits as a fraction
    of the frame, and `flicker` the depth of a lamp wobble (`rate` times a
    second) over the plate's light. `flash` is `(t, gain)`: one authored flare
    of that light at shot-local `t`, up over 4 frames and down over 12 (PLAN
    E35), so a still can carry a detonation. `lift` is `(t, gain, rise)`: the
    light moves to `gain` over `rise` seconds at `t` and stays there — the
    power coming back, or with a gain below 1 the light dimming (SPEC-051
    §4.2) — and any `flicker` stops where it starts. A shot takes a `flash` or
    a `lift`, never both. `exposure` and `saturation` trim the plate into the
    film.

    SPEC-051: `unmake=(t0, t1)`: the picture blends to posterised grey under a
    UV grid, keeping its mean luminance (§4.3). `overlays`: ((u, v, radius,
    group), …) emissive discs in plate space (0–1), keyed by group through
    `overlay_keys(overlay_off)`; or a function of the plate that measures them
    (`glints`). `fade_in=(frames, gain)`: the light climbs from `gain` × to
    full over the first `frames` — a cut that would otherwise swing (51-c).

    The build function also takes `at` (where the plate stands), `start` and
    `length` (its window on the shot clock) and `alone=False` (another builder
    owns the scene's world and view), so one shot can cut between plates.
    """
    dx, dz = drift
    if flash is not None and (flicker > 0 or lift is not None):
        raise ValueError(f'{plate}: a flash owns the plate\'s light; it takes no flicker and no lift')
    if fade_in is not None and (flash is not None or lift is not None or flicker > 0):
        raise ValueError(f'{plate}: a fade-in owns the plate\'s first frames; it takes no flash, lift or flicker')

    def build(ctx, at=(0.0, 0.0, 0.0), start=0.0, length=None, alone=True):
        length = ctx.duration if length is None else length
        if alone:
            ctx.scene.view_settings.view_transform = 'Standard'   # the plate is graded already
            F.world('#000000', 0.0)
        m, emit, aspect = material(plate, exposure, saturation, unmake, start)
        # cover, never stretch: the plate fills the frame on both axes and the rest is cropped
        w = SPAN * max(1.0, aspect / ASPECT)
        h = w / aspect
        F.plane('Plate', w, h, m, at, (90, 0, 0))
        tight = SPAN / (1 + abs(push))                    # the frame at its tightest
        cx, cz = dx * SPAN, dz * SPAN / ASPECT            # where that tighter end sits
        # push in: start on the whole plate and close on the drift. Pull out: the reverse.
        ends = [(SPAN, 0.0, 0.0), (tight, cx, cz)] if push >= 0 else [(tight, cx, cz), (SPAN, 0.0, 0.0)]
        for scale, ox, oz in ends:
            if abs(ox) > w / 2 - scale / 2 + 1e-9 or abs(oz) > h / 2 - scale / (2 * ASPECT) + 1e-9:
                raise ValueError(f'{plate}: a drift of {drift} with push {push} walks the frame off the plate')
        data = bpy.data.cameras.new('Cam')
        data.type = 'ORTHO'
        cam = C.link(bpy.data.objects.new('Cam', data))
        cam.rotation_euler = (math.radians(90), 0, 0)         # ortho, looking along +Y at the plate
        if alone:
            ctx.scene.camera = cam
        end = start + length
        F.keys(data, 'ortho_scale', [(start, ends[0][0]), (end, ends[1][0])])
        F.keys(cam, 'location', [(start, Vector((at[0] + ends[0][1], at[1] - DIST, at[2] + ends[0][2]))),
                                 (end, Vector((at[0] + ends[1][1], at[1] - DIST, at[2] + ends[1][2])))])
        # one series for the plate's light: a flicker that stops where the lights come on,
        # then either a flash that spikes or a lift that climbs (or dims) and holds
        pairs = []
        if flicker > 0:
            until = lift[0] if lift is not None else length
            pairs += [(start + t, exposure * (1 - flicker * ctx.rng.random()))
                      for t in (i / rate for i in range(int(until * rate) + 1)) if t < until]
        if lift is not None:
            t, gain, rise = lift
            pairs += [(start + t, exposure), (start + t + rise, exposure * gain), (end, exposure * gain)]
        if flash is not None:
            t, gain = flash
            pairs += [(start, exposure), (start + t - 4 / F.FPS, exposure), (start + t, exposure * gain),
                      (start + t + 12 / F.FPS, exposure)]
        if fade_in is not None:
            frames, gain = fade_in
            pairs += [(start, exposure * gain), (start + frames / F.FPS, exposure)]
        if pairs:
            F.keys(emit.inputs['Strength'], 'default_value', sorted(pairs), interp='LINEAR')
        discs = overlays(plate) if callable(overlays) else overlays
        if discs:
            _overlays(plate, discs, overlay_off, w, h, at, exposure, start)
        return cam

    return build


def backdrop(plate, cam, distance, exposure=1.0, saturation=1.0):
    """The plate as an emission plane that exactly fills a *perspective* camera's
    frustum at `distance`, so modelled objects can stand in front of it (the
    liftoff composite, SPEC-051 §4.6). The plane rides on the camera, so the
    photograph holds its place in the frame; keep the camera still, or the model
    slides over the picture. Cover, never stretch, as `shot` does."""
    bpy.context.scene.view_settings.view_transform = 'Standard'   # the plate is graded already
    m, _, aspect = material(plate, exposure, saturation)
    data = cam.data
    width = distance * data.sensor_width / data.lens     # sensor fit AUTO on a landscape frame: the width fits
    w = max(width, width / ASPECT * aspect)
    plane = F.plane('Backdrop', w, w / aspect, m, (0, 0, -distance))
    plane.parent = cam
    return plane
