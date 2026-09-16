# Photographic plates (PLAN R11, R12; SPEC-021 §5.7): a shot whose picture is
# one committed image under scripts/assets/blender/plates/ instead of built
# geometry. The plate is emitted from a plane under an orthographic camera and
# fitted to cover the frame, so the frame *is* the image, at any aspect and
# never stretched; a slow push, pull-out or drift gives the shot the motion the
# geometry shot had, and the film's bloom, vignette and motion blur still run
# over it. A plate carries its own grade, so it renders through the Standard
# view transform rather than the AgX every other shot uses. `plates/selection/`
# holds the six faces the Selection wall pins to its cards.
#
# The frame cache keys on the image bytes as well as on the code (Shot.plates,
# film.shot_hash), so dropping a new image in re-renders its shot.
import math
import os

import bpy
from mathutils import Vector

import common as C
import film as F

DIR = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'plates'))
ASPECT = F.WIDTH / F.HEIGHT
DIST = 2.0                 # the camera's distance from the plate: ortho, so only the sign matters
SPAN = 2.0                 # the width of the widest frame; the plate is cut to cover it


def path(name):
    """The committed plate `name` — at least 960 × 540; any aspect, cropped to fill."""
    return os.path.join(DIR, f'{name}.jpg')


def face(n):
    """A Selection card's photograph — plates/selection/NN.webp (PLAN R12), cut
    from one sheet of six survivors; the wall shows each of them twice."""
    return os.path.join(DIR, 'selection', f'{n:02d}.webp')


FACES = tuple(face(n) for n in range(1, 7))


def material(plate, exposure, saturation):
    """The plate as light: an emission shader, so no lamp or world can touch it."""
    m = bpy.data.materials.new('Plate')
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    tex = nt.nodes.new('ShaderNodeTexImage')
    tex.image = F.image(plate)
    tex.extension = 'EXTEND'
    col = tex.outputs['Color']
    if saturation != 1.0:
        hs = nt.nodes.new('ShaderNodeHueSaturation')
        hs.inputs['Saturation'].default_value = saturation
        nt.links.new(col, hs.inputs['Color'])
        col = hs.outputs['Color']
    emit = nt.nodes.new('ShaderNodeEmission')
    nt.links.new(col, emit.inputs['Color'])
    emit.inputs['Strength'].default_value = exposure
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    nt.links.new(emit.outputs['Emission'], out.inputs['Surface'])
    return m, emit, tex.image.size[0] / tex.image.size[1]


def shot(plate, push=0.07, drift=(0.0, 0.0), exposure=1.0, saturation=1.0, flicker=0.0, rate=7.0, flash=None,
         lift=None):
    """A build function that fills the frame with `plate`.

    `push` is how far the frame closes in over the shot (0.07 = 7 % tighter at
    the end; negative pulls out instead, starting tight and opening onto the
    whole frame), `drift` where the tighter end of the move sits as a fraction
    of the frame, and `flicker` the depth of a lamp wobble (`rate` times a
    second) over the plate's light. `flash` is `(t, gain)`: one authored flare
    of that light at shot-local `t`, up over 4 frames and down over 12 (PLAN
    E35), so a still can carry a detonation. `lift` is `(t, gain, rise)`: the
    light climbs to `gain` over `rise` seconds at `t` and stays there — the
    power coming back — and any `flicker` stops where it starts. A shot takes
    a `flash` or a `lift`, never both. `exposure` and `saturation` trim the
    plate into the film.
    """
    dx, dz = drift
    if flash is not None and (flicker > 0 or lift is not None):
        raise ValueError(f'{plate}: a flash owns the plate\'s light; it takes no flicker and no lift')

    def build(ctx):
        ctx.scene.view_settings.view_transform = 'Standard'   # the plate is graded already
        F.world('#000000', 0.0)
        m, emit, aspect = material(plate, exposure, saturation)
        # cover, never stretch: the plate fills the frame on both axes and the rest is cropped
        w = SPAN * max(1.0, aspect / ASPECT)
        h = w / aspect
        F.plane('Plate', w, h, m, (0, 0, 0), (90, 0, 0))
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
        ctx.scene.camera = cam
        F.keys(data, 'ortho_scale', [(0, ends[0][0]), (ctx.duration, ends[1][0])])
        F.keys(cam, 'location', [(0, Vector((ends[0][1], -DIST, ends[0][2]))),
                                 (ctx.duration, Vector((ends[1][1], -DIST, ends[1][2])))])
        # one series for the plate's light: a flicker that stops where the lights come on,
        # then either a flash that spikes or a lift that climbs and holds
        pairs = []
        if flicker > 0:
            until = lift[0] if lift is not None else ctx.duration
            pairs += [(t, exposure * (1 - flicker * ctx.rng.random()))
                      for t in (i / rate for i in range(int(until * rate) + 1)) if t < until]
        if lift is not None:
            at, gain, rise = lift
            pairs += [(at, exposure), (at + rise, exposure * gain), (ctx.duration, exposure * gain)]
        if flash is not None:
            at, gain = flash
            pairs += [(0, exposure), (at - 4 / F.FPS, exposure), (at, exposure * gain), (at + 12 / F.FPS, exposure)]
        if pairs:
            F.keys(emit.inputs['Strength'], 'default_value', sorted(pairs), interp='LINEAR')
        return cam

    return build
