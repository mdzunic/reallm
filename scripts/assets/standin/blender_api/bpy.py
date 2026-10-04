# The slice of Blender's `bpy` the geometry generators touch (props.py,
# cave.py, lib/common.py), in pure Python, for the stand-in build
# (scripts/assets/README.md §7): data-blocks (meshes, objects, materials with
# a Principled node tree), the scene, selection, and `export_scene.gltf`,
# which writes the GLB through gltf.py the way Blender's exporter lays one out.
# Anything a generator only does for its QA preview (lights, cameras, EEVEE)
# raises, because the stand-in never renders.
import math

from mathutils import Euler, Matrix, Vector

import gltf as _gltf

# ------------------------------------------------------------ node trees


class _Socket:
    def __init__(self, node, name, default=None):
        self.node = node
        self.name = name
        self.default_value = default
        self.links_from = []

    @property
    def is_linked(self):
        return bool(self.links_from)


class _Sockets(dict):
    def __getitem__(self, key):
        if isinstance(key, int):
            return list(self.values())[key]
        return dict.__getitem__(self, key)


_PRINCIPLED = {
    'Base Color': (0.8, 0.8, 0.8, 1.0), 'Metallic': 0.0, 'Roughness': 0.5, 'IOR': 1.5, 'Alpha': 1.0,
    'Normal': None, 'Emission Color': (1.0, 1.0, 1.0, 1.0), 'Emission Strength': 0.0,
}


class _Node:
    def __init__(self, kind):
        self.bl_idname = kind
        self.type = {'ShaderNodeBsdfPrincipled': 'BSDF_PRINCIPLED', 'ShaderNodeOutputMaterial': 'OUTPUT_MATERIAL',
                     'ShaderNodeVertexColor': 'VERTEX_COLOR', 'ShaderNodeAttribute': 'ATTRIBUTE'}.get(kind, kind)
        self.inputs = _Sockets()
        self.outputs = _Sockets()
        if kind == 'ShaderNodeBsdfPrincipled':
            for name, default in _PRINCIPLED.items():
                self.inputs[name] = _Socket(self, name, default)
            self.outputs['BSDF'] = _Socket(self, 'BSDF')
        elif kind == 'ShaderNodeOutputMaterial':
            self.inputs['Surface'] = _Socket(self, 'Surface')
        elif kind in ('ShaderNodeVertexColor', 'ShaderNodeAttribute'):
            self.layer_name = ''
            self.attribute_name = ''
            self.outputs['Color'] = _Socket(self, 'Color')
            self.outputs['Alpha'] = _Socket(self, 'Alpha')
        else:
            raise NotImplementedError(f'the stand-in has no shader node {kind}')


class _Nodes(list):
    def new(self, kind):
        node = _Node(kind)
        self.append(node)
        return node


class _Links(list):
    def new(self, a, b):
        b.links_from.append(a)
        self.append((a, b))
        return (a, b)


class _NodeTree:
    def __init__(self):
        self.nodes = _Nodes()
        self.links = _Links()
        bsdf = self.nodes.new('ShaderNodeBsdfPrincipled')
        out = self.nodes.new('ShaderNodeOutputMaterial')
        self.links.new(bsdf.outputs['BSDF'], out.inputs['Surface'])


class Material:
    def __init__(self, name):
        self.name = name
        self.node_tree = None
        self.use_backface_culling = False

    @property
    def use_nodes(self):
        return self.node_tree is not None

    @use_nodes.setter
    def use_nodes(self, value):
        if value and self.node_tree is None:
            self.node_tree = _NodeTree()


# ----------------------------------------------------------------- meshes


class _MVert:
    __slots__ = ('co', 'index')

    def __init__(self, co, index):
        self.co = Vector(co)
        self.index = index


class _MLoop:
    __slots__ = ('vertex_index', 'index')

    def __init__(self, vertex_index, index):
        self.vertex_index = vertex_index
        self.index = index


class _MPoly:
    __slots__ = ('vertices', 'loop_start', 'loop_total', 'material_index', 'use_smooth', 'index', '_mesh')

    def __init__(self, mesh, index, vertices, loop_start, material_index, smooth):
        self._mesh = mesh
        self.index = index
        self.vertices = vertices
        self.loop_start = loop_start
        self.loop_total = len(vertices)
        self.material_index = material_index
        self.use_smooth = smooth

    @property
    def loop_indices(self):
        return range(self.loop_start, self.loop_start + self.loop_total)

    @property
    def normal(self):
        return _gltf.polygon_normal([self._mesh.vertices[i].co for i in self.vertices])

    @property
    def center(self):
        cos = [self._mesh.vertices[i].co for i in self.vertices]
        return sum(cos, Vector((0.0, 0.0, 0.0))) / len(cos)


class _Materials(list):
    pass


class Mesh:
    def __init__(self, name):
        self.name = name
        self.materials = _Materials()
        self.vertices = []
        self.loops = []
        self.polygons = []
        self.uv = []            # per loop (u, v), Blender convention
        self.color = []         # per loop (r, g, b, a), linear
        self.has_uv = False
        self.has_color = False
        self.sharp = set()      # (i, j) vertex pairs, i < j
        self.custom_normals = None

    def _from_bmesh(self, bm):
        verts = list(bm.verts)
        index = {id(v): i for i, v in enumerate(verts)}
        self.vertices = [_MVert(v.co, i) for i, v in enumerate(verts)]
        self.loops, self.polygons, self.uv, self.color = [], [], [], []
        uv_layer = bm.loops.layers.uv.active
        col_layer = bm.loops.layers.float_color.active
        self.has_uv = uv_layer is not None
        self.has_color = col_layer is not None
        for f in bm.faces:
            start = len(self.loops)
            vs = []
            for loop in f.loops:
                vi = index[id(loop.vert)]
                vs.append(vi)
                self.loops.append(_MLoop(vi, len(self.loops)))
                self.uv.append(tuple(loop[uv_layer].uv) if uv_layer is not None else (0.0, 0.0))
                self.color.append(tuple(loop[col_layer]) if col_layer is not None else (1.0, 1.0, 1.0, 1.0))
            self.polygons.append(_MPoly(self, len(self.polygons), vs, start, f.material_index, f.smooth))
        self.sharp = set()
        for e in bm.edges:
            if not e.smooth:
                a, b = index[id(e.verts[0])], index[id(e.verts[1])]
                self.sharp.add((min(a, b), max(a, b)))
        self.custom_normals = None

    def transform(self, matrix):
        for v in self.vertices:
            v.co = matrix @ v.co
        if self.custom_normals is not None:
            n3 = matrix.to_3x3().inverted().transposed()
            self.custom_normals = [(n3 @ Vector(n)).normalized() for n in self.custom_normals]

    def normals_split_custom_set(self, normals):
        normals = [Vector(n).normalized() for n in normals]
        if len(normals) != len(self.loops):
            raise ValueError(f'normals_split_custom_set: {len(normals)} normals for {len(self.loops)} loops')
        self.custom_normals = normals

    def normals_split_custom_set_from_vertices(self, normals):
        normals = [Vector(n).normalized() for n in normals]
        self.custom_normals = [normals[loop.vertex_index] for loop in self.loops]

    def update(self):
        pass


# ---------------------------------------------------------------- objects


class _VertexGroups(list):
    def new(self, name=''):
        self.append(name)
        return name


class Object:
    def __init__(self, name, data):
        self.name = name
        self.data = data
        self.type = 'MESH' if isinstance(data, Mesh) else 'EMPTY'
        self.parent = None
        self.location = Vector((0.0, 0.0, 0.0))
        self.rotation_euler = Euler((0.0, 0.0, 0.0), 'XYZ')
        self.scale = Vector((1.0, 1.0, 1.0))
        self.vertex_groups = _VertexGroups()
        self._selected = False

    def __setattr__(self, name, value):
        if name in ('location', 'scale') and not isinstance(value, Vector):
            value = Vector(value)
        if name == 'rotation_euler' and not isinstance(value, Euler):
            value = Euler(value, 'XYZ')
        object.__setattr__(self, name, value)

    @property
    def matrix_basis(self):
        return Matrix.LocRotScale(self.location, self.rotation_euler, self.scale)

    @property
    def matrix_world(self):
        m = self.matrix_basis
        return self.parent.matrix_world @ m if self.parent is not None else m

    def select_set(self, state):
        self._selected = bool(state)

    def select_get(self):
        return self._selected


# ------------------------------------------------------------- data, scene


class _Collection(list):
    def __init__(self, factory=None):
        super().__init__()
        self._factory = factory

    def new(self, name, *args):
        if self._factory is None:
            raise NotImplementedError('the stand-in cannot make this data-block (previews need Blender)')
        item = self._factory(name, *args)
        self.append(item)
        return item

    def remove(self, item, do_unlink=True):
        if item in self:
            list.remove(self, item)
        for obj in list(context.scene.collection.objects):
            if obj is item:
                context.scene.collection.objects.remove(obj)

    def get(self, name, default=None):
        return next((item for item in self if item.name == name), default)


class _Data:
    def __init__(self):
        self.reset()

    def reset(self):
        self.meshes = _Collection(Mesh)
        self.objects = _Collection(Object)
        self.materials = _Collection(Material)
        self.images = _Collection()
        self.lights = _Collection()
        self.cameras = _Collection()
        self.worlds = _Collection()


class _Objects(list):
    def link(self, obj):
        if obj not in self:
            self.append(obj)

    def unlink(self, obj):
        if obj in self:
            self.remove(obj)


class _SceneCollection:
    def __init__(self):
        self.objects = _Objects()


class _Bag:
    """An attribute bag for settings the stand-in ignores (render, view settings)."""

    def __init__(self, **kw):
        self.__dict__.update(kw)


class Scene:
    def __init__(self):
        self.collection = _SceneCollection()
        self.render = _Bag(fps=24, engine='BLENDER_EEVEE', resolution_x=1920, resolution_y=1080,
                           film_transparent=False, filepath='', image_settings=_Bag(file_format='PNG'))
        self.view_settings = _Bag(view_transform='Standard', look='None')
        self.world = None
        self.camera = None

    @property
    def objects(self):
        return self.collection.objects


class _ViewLayerObjects:
    def __init__(self):
        self.active = None


class _ViewLayer:
    def __init__(self):
        self.objects = _ViewLayerObjects()

    def update(self):
        pass


class _Context:
    def __init__(self):
        self.scene = Scene()
        self.view_layer = _ViewLayer()

    @property
    def active_object(self):
        return self.view_layer.objects.active


data = _Data()
context = _Context()


# -------------------------------------------------------------------- ops


class _WM:
    @staticmethod
    def read_homefile(use_empty=True, **_):
        data.reset()
        context.scene = Scene()
        context.view_layer = _ViewLayer()
        return {'FINISHED'}


class _ObjectOps:
    @staticmethod
    def select_all(action='DESELECT'):
        for obj in context.scene.collection.objects:
            obj.select_set(action == 'SELECT')
        return {'FINISHED'}


class _ExportScene:
    @staticmethod
    def gltf(**kw):
        objs = [o for o in context.scene.collection.objects if o.select_get()] if kw.get('use_selection') else \
            list(context.scene.collection.objects)
        _gltf.export(kw, objs)
        return {'FINISHED'}


class _Ops:
    wm = _WM()
    object = _ObjectOps()
    export_scene = _ExportScene()


ops = _Ops()

app = _Bag(version=(5, 2, 1), version_string='5.2.1 (stand-in)')

__all__ = ['data', 'context', 'ops', 'app', 'math']
