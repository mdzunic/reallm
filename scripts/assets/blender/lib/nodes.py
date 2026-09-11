# Shader-node fields for Cycles bakes (PLAN R7, R8). Blender evaluates the
# fields — Noise, Voronoi, ambient occlusion, the Bevel edge mask, attributes —
# and the EMIT pass bakes up to three of them per pass into a float image,
# which numpy then shapes into textures. `Graph` wraps one material's node
# tree; `bake_emit` bakes onto any UV-mapped object (a plane for the ground
# layers, a sphere for the planets, a model for its hull maps).
import math

import bpy
import numpy as np

import common as C

TAU = 2 * math.pi


class Graph:
    def __init__(self, mat):
        self.nt = mat.node_tree
        self.nt.nodes.clear()

    def node(self, kind, **props):
        n = self.nt.nodes.new(kind)
        for k, v in props.items():
            setattr(n, k, v)
        return n

    def link(self, a, b):
        self.nt.links.new(a, b)

    def _feed(self, socket, value):
        if isinstance(value, (int, float)):
            socket.default_value = value
        elif isinstance(value, tuple):
            socket.default_value = value
        else:
            self.link(value, socket)

    def math(self, op, a, b=None):
        n = self.node('ShaderNodeMath', operation=op)
        for i, x in enumerate((a, b)):
            if x is not None:
                self._feed(n.inputs[i], x)
        return n.outputs[0]

    def vmath(self, op, a, b=None):
        """Vector math; DOT_PRODUCT / LENGTH answer on the Value output."""
        n = self.node('ShaderNodeVectorMath', operation=op)
        for i, x in enumerate((a, b)):
            if x is not None:
                self._feed(n.inputs[i], x)
        return n.outputs['Value'] if op in ('DOT_PRODUCT', 'LENGTH', 'DISTANCE') else n.outputs['Vector']

    def xyz(self, vec):
        sep = self.node('ShaderNodeSeparateXYZ')
        self.link(vec, sep.inputs[0])
        return sep.outputs['X'], sep.outputs['Y'], sep.outputs['Z']

    def combine(self, a, b, c):
        comb = self.node('ShaderNodeCombineXYZ')
        for i, x in enumerate((a, b, c)):
            self._feed(comb.inputs[i], x)
        return comb.outputs[0]

    def coords(self, output='Object'):
        return self.node('ShaderNodeTexCoord').outputs[output]

    def geometry(self, output='Position'):
        return self.node('ShaderNodeNewGeometry').outputs[output]

    def direction(self):
        """The unit vector from the object's origin to the shading point."""
        return self.vmath('NORMALIZE', self.coords('Object'))

    def noise(self, vec, scale, seed, detail=4.0, rough=0.55, distortion=0.0, lacunarity=2.0, out='Fac'):
        """fBm Noise in 4D (W carries the seed, so seeds never shift the domain)."""
        n = self.node('ShaderNodeTexNoise', noise_dimensions='4D', noise_type='FBM', normalize=True)
        n.inputs['Scale'].default_value = scale
        n.inputs['Detail'].default_value = detail
        n.inputs['Roughness'].default_value = rough
        n.inputs['Lacunarity'].default_value = lacunarity
        n.inputs['Distortion'].default_value = distortion
        n.inputs['W'].default_value = seed * 1.37
        self.link(vec, n.inputs['Vector'])
        return n.outputs[out]

    def voronoi(self, vec, scale, seed, feature='F1', out='Distance', randomness=1.0):
        n = self.node('ShaderNodeTexVoronoi', voronoi_dimensions='4D', feature=feature)
        n.inputs['Scale'].default_value = scale
        n.inputs['Randomness'].default_value = randomness
        n.inputs['W'].default_value = seed * 1.37
        self.link(vec, n.inputs['Vector'])
        return n.outputs[out]

    def channel(self, color, index):
        sep = self.node('ShaderNodeSeparateColor')
        self.link(color, sep.inputs[0])
        return sep.outputs[index]

    def ao(self, distance, samples=16, local=False):
        """Occlusion within `distance`; `local` sees only the baked object itself."""
        n = self.node('ShaderNodeAmbientOcclusion', samples=samples, only_local=local)
        n.inputs['Distance'].default_value = distance
        return n.outputs['AO']

    def edge(self, radius, samples=8):
        """1 − cos(angle) between the Bevel-rounded and the true normal: bright on edges."""
        bev = self.node('ShaderNodeBevel', samples=samples)
        bev.inputs['Radius'].default_value = radius
        return self.math('SUBTRACT', 1.0, self.vmath('DOT_PRODUCT', bev.outputs['Normal'], self.geometry('Normal')))

    def attribute(self, name, out='Color'):
        return self.node('ShaderNodeAttribute', attribute_name=name).outputs[out]

    # -- the seamless 4D mapping of the ground layers (ground.py) ------------

    def torus(self):
        tc = self.node('ShaderNodeTexCoord')
        sep = self.node('ShaderNodeSeparateXYZ')
        self.link(tc.outputs['UV'], sep.inputs[0])
        r = 1 / TAU
        u, v = self.math('MULTIPLY', sep.outputs['X'], TAU), self.math('MULTIPLY', sep.outputs['Y'], TAU)
        comb = self.node('ShaderNodeCombineXYZ')
        self.link(self.math('MULTIPLY', self.math('COSINE', u), r), comb.inputs[0])
        self.link(self.math('MULTIPLY', self.math('SINE', u), r), comb.inputs[1])
        self.link(self.math('MULTIPLY', self.math('COSINE', v), r), comb.inputs[2])
        return comb.outputs[0], self.math('MULTIPLY', self.math('SINE', v), r)

    def field(self, vec, w, kind, scale, seed, detail=4.0, rough=0.55, distortion=0.0):
        off = self.node('ShaderNodeVectorMath', operation='ADD')
        self.link(vec, off.inputs[0])
        off.inputs[1].default_value = (seed * 3.13, seed * 1.71, seed * 2.37)
        ws = self.math('ADD', w, seed * 1.37)
        if kind == 'fbm':
            n = self.node('ShaderNodeTexNoise', noise_dimensions='4D', noise_type='FBM', normalize=True)
            n.inputs['Scale'].default_value = scale
            n.inputs['Detail'].default_value = detail
            n.inputs['Roughness'].default_value = rough
            n.inputs['Distortion'].default_value = distortion
            out = n.outputs['Fac']
        else:
            feature = {'edge': 'DISTANCE_TO_EDGE', 'f1': 'F1', 'smooth': 'SMOOTH_F1', 'cell': 'F1'}[kind]
            n = self.node('ShaderNodeTexVoronoi', voronoi_dimensions='4D', feature=feature)
            n.inputs['Scale'].default_value = scale
            if kind == 'cell':
                sep = self.node('ShaderNodeSeparateColor')
                self.link(n.outputs['Color'], sep.inputs[0])
                out = sep.outputs['Red']
            else:
                out = n.outputs['Distance']
        self.link(off.outputs[0], n.inputs['Vector'])
        self.link(ws, n.inputs['W'])
        return out


def cycles(samples=16, margin=0):
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = samples
    scene.cycles.use_denoising = False
    scene.render.bake.margin = margin
    scene.render.bake.use_clear = True
    return scene


def bake_emit(obj, build, size, samples=16, name='fields'):
    """Bake `build(g) → (a, b, c)` (sockets or numbers) onto `obj` through its
    UVs. Returns H×W×4 float (row 0 = top); alpha is 1 where a face covers the
    texel and 0 elsewhere (margin 0 — callers dilate). `size` is n or (w, h)."""
    w, h = (size, size) if isinstance(size, int) else size
    cycles(samples)
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    g = Graph(mat)
    comb = g.node('ShaderNodeCombineColor')
    for i, x in enumerate(build(g)):
        if x is not None:
            g._feed(comb.inputs[i], x)
    emit = g.node('ShaderNodeEmission')
    g.link(comb.outputs[0], emit.inputs['Color'])
    out = g.node('ShaderNodeOutputMaterial')
    g.link(emit.outputs[0], out.inputs['Surface'])
    img = bpy.data.images.new(name, w, h, alpha=True, float_buffer=True)
    img.colorspace_settings.name = 'Non-Color'
    img.pixels.foreach_set(np.zeros(w * h * 4, np.float32))
    tn = g.node('ShaderNodeTexImage')
    tn.image = img
    g.nt.nodes.active = tn
    slots = obj.data.materials
    saved = list(slots)
    if not saved:
        slots.append(mat)
    for i in range(len(slots)):
        slots[i] = mat
    C.select_only([obj])
    bpy.ops.object.bake(type='EMIT', use_clear=False)
    a = np.array(img.pixels[:], dtype=np.float32).reshape(h, w, 4)[::-1].copy()
    for i, m in enumerate(saved):
        slots[i] = m
    if not saved:
        slots.clear()
    bpy.data.images.remove(img)
    bpy.data.materials.remove(mat)
    return a
