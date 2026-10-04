# The two visor cards of SPEC-051 §4.1: plates/selection/visor.webp and
# visor_empty.webp, 320² ID photographs of the salvager — the suit of the
# creation portraits and the `exit` shot (lib/salvager.py) — head and shoulders
# against a concrete wall under a warm key, framed and graded like faces 01–06.
#   visor        the visor down and mirrored, no face;
#   visor_empty  the same helmet, framing and light, the visor clear and the
#                helmet empty: the wall behind shows through it.
# Not a build generator: the plates are committed inputs to `films`, rendered
# once and kept (scripts/assets/blender/plates/, never public/).
#
#   blender -b --factory-startup --python-exit-code 1 -P visor_cards.py -- --out=<dir>
#
# `--out` is the directory the two WebPs are written to (the plates' own
# selection/ when omitted is NOT assumed: pass it), `--preview=<dir>` keeps the
# raw renders there.
import math
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, 'lib'))

import bmesh  # noqa: E402
import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Vector  # noqa: E402

import common as C  # noqa: E402
import salvager as S  # noqa: E402

SIZE = 320
SAMPLES = 256
# The helmet's two spheres (lib/salvager.py body): the shell, and the visor
# bubble set on its front — centre and semi-axes.
SHELL = (Vector((0.0, 0.006, 1.605)), 0.165)
VISOR = (Vector((0.0, -0.094, 1.597)), Vector((0.125 * 1.06, 0.125 * 0.64, 0.125 * 0.8)))


def cell_of(uv):
    for name, (index, *_rest) in S.CELLS.items():
        cu, cv = S.uv(name)
        if abs(uv[0] - cu) < 0.06 and abs(uv[1] - cv) < 0.06:
            return name
    return None


def inside_visor(p, grow=1.0):
    c, r = VISOR
    d = p - c
    return (d.x / r.x) ** 2 + (d.y / r.y) ** 2 + (d.z / r.z) ** 2 < grow


def visor_material(empty):
    m = bpy.data.materials.new('VisorEmpty' if empty else 'VisorMirror')
    m.use_nodes = True
    nt = m.node_tree
    out = next(n for n in nt.nodes if n.type == 'OUTPUT_MATERIAL')
    bsdf = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    if not empty:
        # Mirrored: a dark metal at a polish, so the key and the room read in it.
        bsdf.inputs['Base Color'].default_value = C.lin('#262a30')
        bsdf.inputs['Metallic'].default_value = 1.0
        bsdf.inputs['Roughness'].default_value = 0.14
        return m
    # Clear: glass you see straight through, a faint reflection at the rim.
    clear = nt.nodes.new('ShaderNodeBsdfTransparent')
    gloss = nt.nodes.new('ShaderNodeBsdfGlossy')
    gloss.inputs['Roughness'].default_value = 0.05
    fres = nt.nodes.new('ShaderNodeLayerWeight')
    fres.inputs['Blend'].default_value = 0.12
    mix = nt.nodes.new('ShaderNodeMixShader')
    nt.links.new(fres.outputs['Fresnel'], mix.inputs['Fac'])
    nt.links.new(clear.outputs['BSDF'], mix.inputs[1])
    nt.links.new(gloss.outputs['BSDF'], mix.inputs[2])
    nt.links.new(mix.outputs['Shader'], out.inputs['Surface'])
    return m


def hollow(material):
    """Back faces see-through: every part is closed, so the only back faces a
    camera can meet are the inside of the opened helmet — and the wall shows."""
    nt = material.node_tree
    out = next(n for n in nt.nodes if n.type == 'OUTPUT_MATERIAL')
    front = out.inputs['Surface'].links[0].from_socket
    geo = nt.nodes.new('ShaderNodeNewGeometry')
    clear = nt.nodes.new('ShaderNodeBsdfTransparent')
    mix = nt.nodes.new('ShaderNodeMixShader')
    nt.links.new(geo.outputs['Backfacing'], mix.inputs['Fac'])
    nt.links.new(front, mix.inputs[1])
    nt.links.new(clear.outputs['BSDF'], mix.inputs[2])
    nt.links.new(mix.outputs['Shader'], out.inputs['Surface'])


def suit(empty):
    """The salvager in the crest helmet, its visor faces on a material of their
    own; `empty` opens the shell behind the visor and takes the neck out."""
    # The suit's light greys a step down, so the photograph's key models them
    # instead of clipping: the creation screen tints them, a photograph does not.
    tone = {'suit': (0, 0.58, 0.80, 0.0, None), 'armor': (1, 0.74, 0.45, 0.15, None)}
    _arm, mesh = S.build(helmet='crest', overrides=tone, name='Salvager', strength=0.6)
    mesh.data.materials.append(visor_material(empty))
    bm = bmesh.new()
    bm.from_mesh(mesh.data)
    uvl = bm.loops.layers.uv.active
    doomed = []
    for f in bm.faces:
        name = cell_of(f.loops[0][uvl].uv)
        c = f.calc_center_median()
        if name == 'visor':
            f.material_index = 1
        elif empty and name == 'armor' and abs((c - SHELL[0]).length - SHELL[1]) < 0.03 and inside_visor(c, 1.25):
            doomed.append(f)   # the shell under the visor: the helmet's open face
        elif empty and name == 'under' and 1.40 < c.z < 1.53 and math.hypot(c.x, c.y) < 0.08:
            doomed.append(f)   # the neck: nobody inside
    bmesh.ops.delete(bm, geom=doomed, context='FACES')
    bm.to_mesh(mesh.data)
    bm.free()
    if empty:
        hollow(mesh.data.materials[0])
    return mesh


def wall():
    """Bare concrete a metre behind, warm grey, pitted — the faces' wall, soft in the lens."""
    m = bpy.data.materials.new('Concrete')
    m.use_nodes = True
    nt = m.node_tree
    bsdf = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    noise = nt.nodes.new('ShaderNodeTexNoise')
    noise.inputs['Scale'].default_value = 3.0
    noise.inputs['Detail'].default_value = 12.0
    noise.inputs['Roughness'].default_value = 0.65
    ramp = nt.nodes.new('ShaderNodeValToRGB')
    ramp.color_ramp.elements[0].position = 0.3
    ramp.color_ramp.elements[0].color = C.lin('#22231f')
    ramp.color_ramp.elements[1].position = 0.75
    ramp.color_ramp.elements[1].color = C.lin('#55554e')
    nt.links.new(noise.outputs['Fac'], ramp.inputs['Fac'])
    nt.links.new(ramp.outputs['Color'], bsdf.inputs['Base Color'])
    bsdf.inputs['Roughness'].default_value = 0.92
    pits = nt.nodes.new('ShaderNodeTexVoronoi')
    pits.inputs['Scale'].default_value = 28.0
    bump = nt.nodes.new('ShaderNodeBump')
    bump.inputs['Strength'].default_value = 0.6
    nt.links.new(pits.outputs['Distance'], bump.inputs['Height'])
    nt.links.new(bump.outputs['Normal'], bsdf.inputs['Normal'])
    bpy.ops.mesh.primitive_plane_add(size=6.0, location=(0.0, 1.0, 1.5), rotation=(math.radians(90), 0.0, 0.0))
    bpy.context.active_object.data.materials.append(m)


def light(name, loc, aim, energy, colour, size, glossy=True):
    """An area light; `glossy` False keeps it out of the visor's reflection, so
    the mirror carries one highlight — two read as a pair of eyes."""
    data = bpy.data.lights.new(name, 'AREA')
    data.energy, data.size = energy, size
    data.color = C.lin(colour)[:3]
    obj = C.link(bpy.data.objects.new(name, data))
    obj.location = loc
    obj.rotation_euler = (Vector(aim) - Vector(loc)).to_track_quat('-Z', 'Y').to_euler()
    obj.visible_glossy = glossy


def stage():
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.cycles.samples = SAMPLES
    scene.cycles.use_denoising = True
    scene.render.resolution_x = scene.render.resolution_y = SIZE
    scene.view_settings.view_transform = 'AgX'
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'RGB'
    world = bpy.data.worlds.new('Room')
    world.use_nodes = True
    back = next(n for n in world.node_tree.nodes if n.type == 'BACKGROUND')
    back.inputs['Color'].default_value = C.lin('#1c1b19')
    back.inputs['Strength'].default_value = 0.25
    scene.world = world
    scene.view_settings.exposure = -0.25
    head = (0.0, -0.05, 1.58)
    light('Key', (-1.3, -1.4, 2.3), head, 150.0, '#ffd2a6', 1.6)    # warm, high and left, like the faces
    light('Fill', (1.3, -1.3, 1.5), head, 14.0, '#c8d4ff', 1.4, glossy=False)
    light('Rim', (0.5, 0.8, 2.3), head, 40.0, '#ffe2c4', 0.6, glossy=False)
    wall()
    cam_data = bpy.data.cameras.new('ID')
    cam_data.lens = 85
    cam = C.link(bpy.data.objects.new('ID', cam_data))
    centre = Vector((0.0, -0.02, 1.53))
    az, el, dist = math.radians(14), math.radians(3), 1.8
    cam.location = centre + Vector((math.sin(az) * math.cos(el), -math.cos(az) * math.cos(el), math.sin(el))) * dist
    cam.rotation_euler = (centre - cam.location).to_track_quat('-Z', 'Y').to_euler()
    cam_data.dof.use_dof = True
    cam_data.dof.focus_distance = (Vector((0.0, -0.17, 1.6)) - cam.location).length
    cam_data.dof.aperture_fstop = 2.8
    scene.camera = cam
    return scene


def grade(png):
    """The faces' grade: a little less saturation, lifted blacks, a warm cast."""
    img = bpy.data.images.load(png)
    img.colorspace_settings.name = 'Non-Color'
    a = np.array(img.pixels[:], dtype=np.float32).reshape(SIZE, SIZE, 4)[::-1, :, :3]
    bpy.data.images.remove(img)
    grey = a.mean(axis=2, keepdims=True)
    a = grey + (a - grey) * 0.85
    a = 0.025 + a * 0.97
    a = a * np.array([1.03, 1.0, 0.95], np.float32)
    return np.clip(a, 0.0, 1.0)


def main():
    opts = C.options()
    tmp = opts['preview'] or os.path.join(opts['out'], '.visor-tmp')
    for empty, name in ((False, 'visor'), (True, 'visor_empty')):
        C.reset()
        scene = stage()
        suit(empty)
        raw = os.path.join(tmp, f'raw_{name}.png')
        scene.render.filepath = C.ensure_dir(raw)
        bpy.ops.render.render(write_still=True)
        size = C.save_webp(os.path.join(opts['out'], f'{name}.webp'), grade(raw), quality=90)
        print(f'PLATE selection/{name}.webp {size} bytes')
    if not opts['preview']:
        shutil.rmtree(tmp, ignore_errors=True)


main()
