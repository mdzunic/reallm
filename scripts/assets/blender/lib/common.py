# Shared helpers for the Blender asset generators (PLAN R7). Every generator
# runs headless — `Blender --background --factory-startup --python <gen>.py --
# --out=<public/assets> [--preview=<dir>]` — through `scripts/assets/blender/
# build.mjs`, builds its meshes from code (no downloads, no hand-made files),
# and writes GLB / WebP straight into `public/assets/`. Everything here is
# deterministic: a rebuild with the same Blender version writes the same files.
#
# Conventions (restated in scripts/assets/README.md):
#   * Blender is Z-up and a model's front faces −Y; the glTF exporter turns that
#     into three's Y-up with the front facing +Z.
#   * Metres; origin at the base centre unless a consumer needs otherwise.
#   * Meshes are built part by part in one bmesh with a UV layer, a float colour
#     layer `Col` (linear) and a deform layer, then turned into one object.
import json
import math
import os
import struct
import sys

import bmesh
import bpy
import numpy as np
from mathutils import Euler, Matrix, Vector

# ------------------------------------------------------------------ arguments


def options():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    opts = {'out': None, 'preview': None, 'only': []}
    for arg in argv:
        if arg.startswith('--out='):
            opts['out'] = arg[len('--out='):]
        elif arg.startswith('--preview='):
            opts['preview'] = arg[len('--preview='):] or None
        else:
            opts['only'].append(arg)
    if not opts['out']:
        raise SystemExit('pass --out=<public/assets>')
    return opts


def wanted(opts, name):
    return not opts['only'] or name in opts['only']


def ensure_dir(path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    return path


# ---------------------------------------------------------------------- scene


def reset():
    """An empty scene at 30 fps, Standard view transform (bakes and renders agree)."""
    bpy.ops.wm.read_homefile(use_empty=True)
    scene = bpy.context.scene
    scene.render.fps = 30
    scene.view_settings.view_transform = 'Standard'
    scene.view_settings.look = 'None'
    return scene


def link(obj):
    bpy.context.scene.collection.objects.link(obj)
    return obj


# --------------------------------------------------------------------- colour


def _lin(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def _srgb(c):
    c = min(max(c, 0.0), 1.0)
    return c * 12.92 if c <= 0.0031308 else 1.055 * c ** (1 / 2.4) - 0.055


def hex_rgb(value):
    value = value.lstrip('#')
    return tuple(int(value[i:i + 2], 16) / 255 for i in (0, 2, 4))


def lin(value, alpha=1.0):
    """'#rrggbb' (sRGB) or a 0..1 grey → linear RGBA, what Blender stores."""
    if isinstance(value, str):
        r, g, b = hex_rgb(value)
    else:
        r = g = b = float(value)
    return (_lin(r), _lin(g), _lin(b), alpha)


def encode_srgb(array):
    """Linear float array → sRGB-encoded 0..1 (vectorised)."""
    a = np.clip(array, 0.0, 1.0)
    return np.where(a <= 0.0031308, a * 12.92, 1.055 * np.power(a, 1 / 2.4) - 0.055)


# -------------------------------------------------------------------- parts
# A part is a small bmesh built at the origin, then placed. Builder.add copies
# it into the model's bmesh with its colour, UV, bone and material.


def mat4(loc=(0, 0, 0), rot=(0, 0, 0), scale=(1, 1, 1)):
    return Matrix.LocRotScale(Vector(loc), Euler([math.radians(a) for a in rot], 'XYZ'), Vector(scale))


def place(bm, loc=(0, 0, 0), rot=(0, 0, 0), scale=(1, 1, 1)):
    bmesh.ops.transform(bm, matrix=mat4(loc, rot, scale), verts=bm.verts)
    return bm


def along(bm, head, tail, spin=0.0):
    """Stand a part built along +Z between two points (its midpoint on theirs)."""
    h, t = Vector(head), Vector(tail)
    q = Vector((0, 0, 1)).rotation_difference((t - h).normalized())
    m = Matrix.Translation((h + t) / 2) @ q.to_matrix().to_4x4() @ Matrix.Rotation(math.radians(spin), 4, 'Z')
    bmesh.ops.transform(bm, matrix=m, verts=bm.verts)
    return bm


def length(head, tail):
    return (Vector(tail) - Vector(head)).length


def box(sx, sy, sz, bevel=0.0, seg=1):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=(sx, sy, sz), verts=bm.verts)
    if bevel > 0:
        bmesh.ops.bevel(bm, geom=list(bm.edges), offset=bevel, segments=seg, profile=0.5,
                        affect='EDGES', clamp_overlap=True)
    return bm


def cyl(r1, r2, depth, n=10, caps=True, bevel=0.0):
    """A cone/cylinder along Z, centred at the origin."""
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=caps, cap_tris=False, segments=n,
                          radius1=r1, radius2=r2, depth=depth)
    if bevel > 0 and caps:
        rims = [e for e in bm.edges if len(e.link_faces) == 2 and abs(e.calc_face_angle(0)) > 0.9]
        bmesh.ops.bevel(bm, geom=rims, offset=bevel, segments=1, profile=0.5, affect='EDGES', clamp_overlap=True)
    return bm


def sphere(radius, segs=12, rings=8):
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=segs, v_segments=rings, radius=radius)
    return bm


def ico(radius, subdiv=1):
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=subdiv, radius=radius)
    return bm


def lathe(profile, n=16, cap_bottom=False, cap_top=False, arc=360.0):
    """Revolve [(r, z), …] around Z. `arc` < 360 leaves the ring open."""
    bm = bmesh.new()
    full = arc >= 359.9
    steps = n if full else n + 1
    rings = []
    for i in range(steps):
        a = math.radians(arc) * i / n
        ca, sa = math.cos(a), math.sin(a)
        rings.append([bm.verts.new((r * ca, r * sa, z)) for r, z in profile])
    for i in range(n):
        a, b = rings[i], rings[(i + 1) % steps]
        for j in range(len(profile) - 1):
            quad = [a[j], b[j], b[j + 1], a[j + 1]]
            if len(set(quad)) == 4:
                try:
                    bm.faces.new(quad)
                except ValueError:
                    pass
    if full and cap_bottom and profile[0][0] > 1e-6:
        bm.faces.new([ring[0] for ring in reversed(rings)])
    if full and cap_top and profile[-1][0] > 1e-6:
        bm.faces.new([ring[-1] for ring in rings])
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return bm


def torus(major, minor, n=24, m=8, arc=360.0):
    profile = [(major + minor * math.cos(2 * math.pi * k / m), minor * math.sin(2 * math.pi * k / m)) for k in range(m + 1)]
    return lathe(profile, n=n, arc=arc)


def displace(bm, fn):
    """Move every vertex along its normal by fn(co) (co is a Vector)."""
    bm.normal_update()
    moves = [(v, v.normal.copy() * fn(v.co.copy())) for v in bm.verts]
    for v, d in moves:
        v.co += d
    bm.normal_update()
    return bm


# ------------------------------------------------------------------- builder


class Builder:
    """Accumulates parts into one bmesh with UV, linear colour and bone weights."""

    def __init__(self, vcol=True):
        self.bm = bmesh.new()
        self.uv = self.bm.loops.layers.uv.new('UVMap')
        self.col = self.bm.loops.layers.float_color.new('Col') if vcol else None
        self.deform = self.bm.verts.layers.deform.new()
        self.groups = []

    def group(self, name):
        if name not in self.groups:
            self.groups.append(name)
        return self.groups.index(name)

    def add(self, part, color=(1, 1, 1, 1), uv=None, bone=None, mat=0, smooth=35.0, uv_scale=None):
        """Copy `part` in. `smooth`: sharp above this angle (deg); None → flat."""
        part.normal_update()
        vmap = {}
        g = self.group(bone) if bone else None
        for v in part.verts:
            nv = self.bm.verts.new(v.co)
            if g is not None:
                nv[self.deform][g] = 1.0
            vmap[v] = nv
        for f in part.faces:
            try:
                nf = self.bm.faces.new([vmap[v] for v in f.verts])
            except ValueError:
                continue
            n = f.normal
            nf.material_index = mat(f.calc_center_median(), n) if callable(mat) else mat
            nf.smooth = smooth is not None
            for loop in nf.loops:
                if self.col is not None:
                    loop[self.col] = color(loop.vert.co, n) if callable(color) else color
                if uv is not None:
                    loop[self.uv].uv = uv
                elif uv_scale is not None:
                    co = loop.vert.co
                    ax = max(range(3), key=lambda k: abs(n[k]))
                    a, b = [(1, 2), (0, 2), (0, 1)][ax]
                    loop[self.uv].uv = (co[a] * uv_scale, co[b] * uv_scale)
        if smooth is not None:
            limit = math.radians(smooth)
            self.bm.normal_update()
            for v in vmap.values():
                for e in v.link_edges:
                    if len(e.link_faces) == 2 and e.calc_face_angle(0.0) > limit:
                        e.smooth = False
        part.free()

    def object(self, name, materials=(), parent=None):
        mesh = bpy.data.meshes.new(name)
        self.bm.to_mesh(mesh)
        self.bm.free()
        obj = link(bpy.data.objects.new(name, mesh))
        for m in materials:
            mesh.materials.append(m)
        for gname in self.groups:
            obj.vertex_groups.new(name=gname)
        if parent is not None:
            obj.parent = parent
        return obj


# ------------------------------------------------------------------ materials


def _principled(name):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    return mat, nt, bsdf


def mat_vcol(name, rough=0.8, metal=0.0, emission=None, strength=0.0):
    """Base colour from the `Col` attribute (exported as COLOR_0)."""
    mat, nt, bsdf = _principled(name)
    attr = nt.nodes.new('ShaderNodeVertexColor')
    attr.layer_name = 'Col'
    nt.links.new(attr.outputs['Color'], bsdf.inputs['Base Color'])
    bsdf.inputs['Roughness'].default_value = rough
    bsdf.inputs['Metallic'].default_value = metal
    if emission is not None:
        bsdf.inputs['Emission Color'].default_value = lin(emission)
        bsdf.inputs['Emission Strength'].default_value = strength
    return mat


def mat_flat(name, color, rough=0.5, metal=0.0, emission=None, strength=0.0):
    mat, nt, bsdf = _principled(name)
    bsdf.inputs['Base Color'].default_value = lin(color)
    bsdf.inputs['Roughness'].default_value = rough
    bsdf.inputs['Metallic'].default_value = metal
    if emission is not None:
        bsdf.inputs['Emission Color'].default_value = lin(emission)
        bsdf.inputs['Emission Strength'].default_value = strength
    return mat


def image_from_array(name, rgba, colorspace):
    """A byte image holding already-encoded values (no conversion on save)."""
    h, w = rgba.shape[:2]
    img = bpy.data.images.new(name, w, h, alpha=True, float_buffer=False)
    img.colorspace_settings.name = colorspace
    img.pixels.foreach_set(np.ascontiguousarray(rgba, dtype=np.float32).ravel())
    img.pack()
    return img


def mat_textured(name, base_img, orm_img=None, emissive_img=None, strength=0.0, rough=0.6, metal=0.0, closest=False):
    """baseColor / metallicRoughness (G rough, B metal) / emissive maps, glTF-ready."""
    mat, nt, bsdf = _principled(name)
    interp = 'Closest' if closest else 'Linear'
    tb = nt.nodes.new('ShaderNodeTexImage')
    tb.image, tb.interpolation = base_img, interp
    nt.links.new(tb.outputs['Color'], bsdf.inputs['Base Color'])
    if orm_img is not None:
        to = nt.nodes.new('ShaderNodeTexImage')
        to.image, to.interpolation = orm_img, interp
        sep = nt.nodes.new('ShaderNodeSeparateColor')
        nt.links.new(to.outputs['Color'], sep.inputs['Color'])
        nt.links.new(sep.outputs['Green'], bsdf.inputs['Roughness'])
        nt.links.new(sep.outputs['Blue'], bsdf.inputs['Metallic'])
    else:
        bsdf.inputs['Roughness'].default_value = rough
        bsdf.inputs['Metallic'].default_value = metal
    if emissive_img is not None:
        te = nt.nodes.new('ShaderNodeTexImage')
        te.image, te.interpolation = emissive_img, interp
        nt.links.new(te.outputs['Color'], bsdf.inputs['Emission Color'])
        bsdf.inputs['Emission Strength'].default_value = strength
    return mat


# ------------------------------------------------------------------- images


def save_webp(path, rgba, quality=85):
    """Write an H×W×4 (or ×3) array of encoded 0..1 values as WebP. Row 0 = top."""
    return save_image(path, rgba, 'WEBP', quality)


def save_image(path, rgba, fmt='WEBP', quality=85):
    """Write an H×W×4 (or ×3) array of encoded 0..1 values. Row 0 = top."""
    arr = np.asarray(rgba, dtype=np.float32)
    if arr.shape[2] == 3:
        arr = np.concatenate([arr, np.ones(arr.shape[:2] + (1,), np.float32)], axis=2)
    h, w = arr.shape[:2]
    img = bpy.data.images.new(os.path.basename(path), w, h, alpha=True, float_buffer=False)
    img.colorspace_settings.name = 'Non-Color'
    img.pixels.foreach_set(np.ascontiguousarray(arr[::-1]).ravel())  # Blender rows start at the bottom
    img.filepath_raw = ensure_dir(path)
    img.file_format = fmt
    img.save(filepath=path, quality=quality)
    bpy.data.images.remove(img)
    return os.path.getsize(path)


# ------------------------------------------------------------------- export


def select_only(objs):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]


def export_glb(path, objs, animations=False):
    select_only(objs)
    bpy.ops.export_scene.gltf(
        filepath=ensure_dir(path), export_format='GLB', use_selection=True, export_apply=True,
        export_yup=True, export_texcoords=True, export_normals=True, export_tangents=False,
        export_materials='EXPORT', export_vertex_color='MATERIAL', export_all_vertex_colors=False,
        export_active_vertex_color_when_no_material=False, export_image_format='WEBP', export_image_quality=88,
        export_cameras=False, export_lights=False, export_extras=False,
        export_animations=animations, export_skins=animations, export_animation_mode='ACTIONS',
        export_anim_slide_to_zero=True, export_optimize_animation_size=True, export_def_bones=True,
        export_leaf_bone=False, export_reset_pose_bones=True, export_rest_position_armature=True)
    return os.path.getsize(path)


def glb_json(path):
    with open(path, 'rb') as fh:
        data = fh.read()
    length = struct.unpack_from('<I', data, 12)[0]
    return json.loads(data[20:20 + length]), data


def glb_rewrite(path, fix):
    """Parse a GLB, let fix(gltf) edit its JSON, write it back (BIN chunk untouched)."""
    gltf, data = glb_json(path)
    json_len = struct.unpack_from('<I', data, 12)[0]
    rest = data[20 + json_len:]
    fix(gltf)
    blob = json.dumps(gltf, separators=(',', ':')).encode('utf8')
    blob += b' ' * ((4 - len(blob) % 4) % 4)
    total = 12 + 8 + len(blob) + len(rest)
    with open(path, 'wb') as fh:
        fh.write(struct.pack('<III', 0x46546C67, 2, total))
        fh.write(struct.pack('<II', len(blob), 0x4E4F534A))
        fh.write(blob)
        fh.write(rest)


def report(path, root):
    gltf, _ = glb_json(path)
    tris = 0
    for mesh in gltf.get('meshes', []):
        for prim in mesh['primitives']:
            if 'indices' in prim:
                tris += gltf['accessors'][prim['indices']]['count'] // 3
    anims = [a.get('name') for a in gltf.get('animations', [])]
    rel = os.path.relpath(path, root)
    print(f"ASSET {rel} {os.path.getsize(path)} bytes, {tris} tris" + (f", clips {anims}" if anims else ''))
