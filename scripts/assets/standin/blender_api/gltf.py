# The stand-in's glTF writer: what Blender's exporter writes for the props and
# the cave kit (export_yup, normals, optional TEXCOORD_0, COLOR_0 for a mesh
# whose material reads the `Col` attribute, one primitive per material, the
# Principled values as pbrMetallicRoughness, emission as emissiveFactor plus
# KHR_materials_emissive_strength), as an uncompressed GLB. Normals are
# Blender's split normals — a flat face's own, a smooth face's angle-weighted
# fan average that stops at sharp edges — unless the mesh has custom ones.
# `export_meshopt_compression_enable` is honoured by the Node half of the
# stand-in (scripts/assets/standin/glb.mjs), which this asks to compress the
# file by printing a `STANDIN meshopt <path>` line.
import json
import os
import struct

from mathutils import Vector

GENERATOR = 'ReaLLM stand-in for Khronos glTF Blender I/O (scripts/assets/standin)'


def polygon_normal(cos):
    nx = ny = nz = 0.0
    k = len(cos)
    for i in range(k):
        a, b = cos[i], cos[(i + 1) % k]
        nx += (a.y - b.y) * (a.z + b.z)
        ny += (a.z - b.z) * (a.x + b.x)
        nz += (a.x - b.x) * (a.y + b.y)
    n = Vector((nx, ny, nz))
    return n.normalized() if n.length > 0 else Vector((0.0, 0.0, 1.0))


def _corner_angle(prev, at, nxt):
    return (prev - at).angle(nxt - at, 0.0)


def split_normals(mesh):
    """One normal per loop, as Blender computes them for export."""
    cos = [v.co for v in mesh.vertices]
    face_n = [polygon_normal([cos[i] for i in p.vertices]) for p in mesh.polygons]
    edge_faces = {}
    for p in mesh.polygons:
        vs = p.vertices
        for k in range(len(vs)):
            a, b = vs[k], vs[(k + 1) % len(vs)]
            edge_faces.setdefault((min(a, b), max(a, b)), []).append(p.index)

    def smooth_edge(a, b):
        key = (min(a, b), max(a, b))
        faces = edge_faces.get(key, ())
        return (len(faces) == 2 and key not in mesh.sharp
                and mesh.polygons[faces[0]].use_smooth and mesh.polygons[faces[1]].use_smooth)

    normals = [None] * len(mesh.loops)
    corners = {}
    for p in mesh.polygons:
        vs = p.vertices
        k = len(vs)
        for j in range(k):
            li = p.loop_start + j
            if not p.use_smooth:
                normals[li] = face_n[p.index]
                continue
            corners.setdefault(vs[j], []).append((p.index, li, vs[j - 1], vs[(j + 1) % k]))
    for vi, cs in corners.items():
        parent = list(range(len(cs)))

        def find(i):
            while parent[i] != i:
                parent[i] = parent[parent[i]]
                i = parent[i]
            return i

        by_edge = {}
        for ci, (_, _, prev, nxt) in enumerate(cs):
            for w in (prev, nxt):
                if smooth_edge(vi, w):
                    by_edge.setdefault(w, []).append(ci)
        for members in by_edge.values():
            for ci in members[1:]:
                parent[find(ci)] = find(members[0])
        fans = {}
        for ci, (pi, li, prev, nxt) in enumerate(cs):
            weight = _corner_angle(cos[prev], cos[vi], cos[nxt])
            fans.setdefault(find(ci), Vector((0.0, 0.0, 0.0)))
            fans[find(ci)] += face_n[pi] * weight
        for ci, (pi, li, _, _) in enumerate(cs):
            n = fans[find(ci)]
            normals[li] = n.normalized() if n.length > 0 else face_n[pi]
    return normals


def _uses_vertex_colour(mat):
    if mat is None or mat.node_tree is None:
        return False
    bsdf = next((n for n in mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
    base = bsdf.inputs['Base Color'] if bsdf is not None else None
    return base is not None and any(s.node.type in ('VERTEX_COLOR', 'ATTRIBUTE') for s in base.links_from)


def _material_json(mat, used):
    bsdf = next(n for n in mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    out = {'doubleSided': not mat.use_backface_culling, 'name': mat.name}
    pbr = {}
    if not _uses_vertex_colour(mat):
        base = [float(c) for c in bsdf.inputs['Base Color'].default_value]
        if base != [1.0, 1.0, 1.0, 1.0]:
            pbr['baseColorFactor'] = base
    pbr['metallicFactor'] = float(bsdf.inputs['Metallic'].default_value)
    pbr['roughnessFactor'] = float(bsdf.inputs['Roughness'].default_value)
    out['pbrMetallicRoughness'] = pbr
    colour = [float(c) for c in list(bsdf.inputs['Emission Color'].default_value)[:3]]
    strength = float(bsdf.inputs['Emission Strength'].default_value)
    emissive = [c * strength for c in colour]
    peak = max(emissive) if emissive else 0.0
    if peak > 0:
        if peak > 1.0:
            out['emissiveFactor'] = [c / peak for c in emissive]
            out['extensions'] = {'KHR_materials_emissive_strength': {'emissiveStrength': peak}}
            used.add('KHR_materials_emissive_strength')
        else:
            out['emissiveFactor'] = emissive
    return out


class _Bin:
    def __init__(self):
        self.data = bytearray()
        self.views = []
        self.accessors = []

    def add(self, fmt, items, comps, ctype, target, gl_type, minmax=False):
        while len(self.data) % 4:
            self.data.append(0)
        offset = len(self.data)
        flat = [x for item in items for x in item] if comps > 1 else list(items)
        self.data += struct.pack(f'<{len(flat)}{fmt}', *flat)
        self.views.append({'buffer': 0, 'byteLength': len(self.data) - offset, 'byteOffset': offset, 'target': target})
        acc = {'bufferView': len(self.views) - 1, 'componentType': ctype, 'count': len(items), 'type': gl_type}
        if minmax:
            acc['min'] = [min(item[k] for item in items) for k in range(comps)]
            acc['max'] = [max(item[k] for item in items) for k in range(comps)]
        self.accessors.append(acc)
        return len(self.accessors) - 1


def _f32(x):
    return struct.unpack('<f', struct.pack('<f', x))[0]


def _yup(v):
    return (_f32(v[0]), _f32(v[2]), _f32(-v[1]))


def _mesh_json(obj, binary, materials, mat_index, kw):
    mesh = obj.data
    normals = mesh.custom_normals if mesh.custom_normals is not None else split_normals(mesh)
    texcoords = kw.get('export_texcoords', True) and mesh.has_uv
    colours = mesh.has_color and any(_uses_vertex_colour(m) for m in mesh.materials)
    groups = {}
    for p in mesh.polygons:
        groups.setdefault(p.material_index, []).append(p)
    prims = []
    for mi in sorted(groups):
        lookup = {}
        pos, nor, uv, col, idx = [], [], [], [], []
        for p in groups[mi]:
            corner = []
            for j, vi in enumerate(p.vertices):
                li = p.loop_start + j
                key = (_yup(mesh.vertices[vi].co), _yup(normals[li]))
                if texcoords:
                    u, v = mesh.uv[li]
                    key += ((_f32(u), _f32(1.0 - v)),)
                if colours:
                    key += (tuple(_f32(c) for c in mesh.color[li][:3]),)
                at = lookup.get(key)
                if at is None:
                    at = lookup[key] = len(pos)
                    pos.append(key[0])
                    nor.append(key[1])
                    if texcoords:
                        uv.append(key[2])
                    if colours:
                        col.append(key[-1])
                corner.append(at)
            for j in range(1, len(corner) - 1):
                idx.append((corner[0], corner[j], corner[j + 1]))
        attrs = {'POSITION': binary.add('f', pos, 3, 5126, 34962, 'VEC3', minmax=True),
                 'NORMAL': binary.add('f', nor, 3, 5126, 34962, 'VEC3')}
        if texcoords:
            attrs['TEXCOORD_0'] = binary.add('f', uv, 2, 5126, 34962, 'VEC2')
        if colours:
            attrs['COLOR_0'] = binary.add('f', col, 3, 5126, 34962, 'VEC3')
        flat = [i for tri in idx for i in tri]
        big = len(pos) > 65535
        indices = binary.add('I' if big else 'H', flat, 1, 5125 if big else 5123, 34963, 'SCALAR')
        prim = {'attributes': attrs, 'indices': indices}
        mat = mesh.materials[mi] if mi < len(mesh.materials) else None
        if mat is not None:
            prim['material'] = mat_index(mat)
        prims.append(prim)
    return {'name': mesh.name, 'primitives': prims}


def export(kw, objs):
    if kw.get('export_animations') or kw.get('export_skins'):
        raise NotImplementedError('the stand-in exports static meshes only')
    path = kw['filepath']
    binary = _Bin()
    used = set()
    materials, mat_ids = [], {}

    def mat_index(mat):
        if id(mat) not in mat_ids:
            mat_ids[id(mat)] = len(materials)
            materials.append(_material_json(mat, used))
        return mat_ids[id(mat)]

    chosen = set(map(id, objs))
    nodes, meshes, node_of = [], [], {}

    def node_for(obj):
        if id(obj) in node_of:
            return node_of[id(obj)]
        if any(abs(a) > 1e-9 for a in obj.rotation_euler) or any(abs(s - 1) > 1e-9 for s in obj.scale):
            raise NotImplementedError(f'{obj.name}: the stand-in exports a node with a translation only')
        node = {'name': obj.name}
        if obj.type == 'MESH':
            meshes.append(_mesh_json(obj, binary, materials, mat_index, kw))
            node['mesh'] = len(meshes) - 1
        if any(abs(c) > 1e-9 for c in obj.location):
            node['translation'] = list(_yup(obj.location))
        nodes.append(node)
        node_of[id(obj)] = len(nodes) - 1
        kids = [o for o in objs if o.parent is obj]
        if kids:
            node['children'] = [node_for(k) for k in kids]
        return node_of[id(obj)]

    roots = [node_for(o) for o in objs if o.parent is None or id(o.parent) not in chosen]
    gltf = {'asset': {'generator': GENERATOR, 'version': '2.0'}}
    if used:
        gltf['extensionsUsed'] = sorted(used)
    gltf.update({'scene': 0, 'scenes': [{'name': 'Scene', 'nodes': roots}], 'nodes': nodes, 'materials': materials,
                 'meshes': meshes, 'accessors': binary.accessors, 'bufferViews': binary.views,
                 'buffers': [{'byteLength': len(binary.data)}]})
    while len(binary.data) % 4:
        binary.data.append(0)
    gltf['buffers'][0]['byteLength'] = len(binary.data)
    blob = json.dumps(gltf, separators=(',', ':')).encode('utf8')
    blob += b' ' * ((4 - len(blob) % 4) % 4)
    total = 12 + 8 + len(blob) + 8 + len(binary.data)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'wb') as fh:
        fh.write(struct.pack('<III', 0x46546C67, 2, total))
        fh.write(struct.pack('<II', len(blob), 0x4E4F534A))
        fh.write(blob)
        fh.write(struct.pack('<II', len(binary.data), 0x004E4942))
        fh.write(bytes(binary.data))
    if kw.get('export_meshopt_compression_enable'):
        print(f'STANDIN meshopt {os.path.abspath(path)}')
