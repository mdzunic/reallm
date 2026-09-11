# Ground layers (SPEC-018 §4.5, §4.10): textures/ground/<layer>_albedo.webp
# (RGB albedo sRGB, A height — or the emissive crack/vein mask for lava_rock
# and flesh, which are always slot B) and <layer>_nr.webp (RGB OpenGL normal,
# A roughness), 512² each and seamless.
#
# Blender makes the fields: 4D Noise/Voronoi evaluated on a Clifford torus
# (UV → (cos 2πu, sin 2πu, cos 2πv, sin 2πv)/2π), so every field tiles exactly
# and a node's Scale is features per tile. Cycles bakes three fields per pass
# into a float image; numpy then shapes height, colours, cavity shading,
# roughness and normals, and packs the pair.
import math
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'lib'))

import bpy  # noqa: E402
import numpy as np  # noqa: E402

import common as C  # noqa: E402
import tex as T  # noqa: E402

SIZE = 512
TAU = 2 * math.pi


# ---------------------------------------------------------------- field bake


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

    def math(self, op, a, b=None):
        n = self.node('ShaderNodeMath', operation=op)
        for i, x in enumerate((a, b)):
            if x is None:
                continue
            if isinstance(x, (int, float)):
                n.inputs[i].default_value = x
            else:
                self.link(x, n.inputs[i])
        return n.outputs[0]

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


def bake_fields(specs):
    """specs: [(kind, scale, seed, extra kwargs)] → list of H×W arrays (row 0 = top)."""
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = 12
    scene.render.bake.margin = 0
    plane = bpy.data.objects.get('BakePlane')
    if plane is None:
        bpy.ops.mesh.primitive_plane_add(size=1)
        plane = bpy.context.active_object
        plane.name = 'BakePlane'
    out = []
    for start in range(0, len(specs), 3):
        group = specs[start:start + 3]
        mat = bpy.data.materials.new(f'fields{start}')
        mat.use_nodes = True
        g = Graph(mat)
        vec, w = g.torus()
        comb = g.node('ShaderNodeCombineColor')
        for i, (kind, scale, seed, kw) in enumerate(group):
            g.link(g.field(vec, w, kind, scale, seed, **kw), comb.inputs[i])
        emit = g.node('ShaderNodeEmission')
        g.link(comb.outputs[0], emit.inputs['Color'])
        outn = g.node('ShaderNodeOutputMaterial')
        g.link(emit.outputs[0], outn.inputs['Surface'])
        img = bpy.data.images.new(f'bake{start}', SIZE, SIZE, float_buffer=True)
        img.colorspace_settings.name = 'Non-Color'
        tn = g.node('ShaderNodeTexImage')
        tn.image = img
        g.nt.nodes.active = tn
        plane.data.materials.clear()
        plane.data.materials.append(mat)
        C.select_only([plane])
        bpy.ops.object.bake(type='EMIT')
        a = np.array(img.pixels[:], dtype=np.float32).reshape(SIZE, SIZE, 4)[::-1]
        out.extend(a[..., i].copy() for i in range(len(group)))
        bpy.data.images.remove(img)
    return out


# ------------------------------------------------------------------ recipes


def ramp(t, stops):
    t = np.clip(t, 0, 1)
    pos = np.array([p for p, _ in stops], np.float32)
    cols = np.array([C.lin(c)[:3] for _, c in stops], np.float32)
    return np.stack([np.interp(t, pos, cols[:, k]) for k in range(3)], -1).astype(np.float32)


def mixc(a, b, t):
    t = np.clip(t, 0, 1)[..., None]
    return a * (1 - t) + b * t


def col(hexstr):
    return np.array(C.lin(hexstr)[:3], np.float32)


ss = T.smoothstep
V = (np.arange(SIZE, dtype=np.float32)[:, None] + 0.5) / SIZE * np.ones((1, SIZE), np.float32)


def sand(f):
    f1, f2, f3 = f
    rip = 0.5 + 0.5 * np.sin(TAU * (7 * V + 1.4 * f3 + 0.6 * f1))
    h = 0.55 * rip + 0.3 * f1 + 0.15 * f2
    alb = ramp(h, [(0, '#a87a45'), (0.55, '#c9a068'), (1, '#e3c690')]) * (0.93 + 0.14 * f2)[..., None]
    return alb, h, 0.82 + 0.1 * (1 - h), None, 5.0


def cracked_earth(f):
    e, c, n = f
    crack = 1 - ss(0.012, 0.05, e)
    plate = ss(0.02, 0.2, e)
    h = np.clip(0.25 + 0.6 * plate * (0.85 + 0.15 * n) - 0.25 * crack, 0, 1)
    alb = ramp(0.35 + 0.4 * c + 0.25 * n, [(0, '#8f6a43'), (0.5, '#b58c5c'), (1, '#caa576')])
    return mixc(alb, col('#3b2716'), crack), h, 0.9 - 0.05 * n, None, 7.0


def rock(f):
    n, g, e = f
    ridge = 1 - np.abs(2 * n - 1)
    h = np.clip(0.55 * n + 0.3 * ridge + 0.15 * g - 0.2 * (1 - ss(0.0, 0.08, e)), 0, 1)
    alb = ramp(h, [(0, '#4f4843'), (0.5, '#7d746b'), (1, '#a69d92')]) * (0.9 + 0.2 * g)[..., None]
    return alb, h, 0.88 - 0.1 * g, None, 8.0


def snow(f):
    n, g, _ = f
    h = 0.7 * n + 0.3 * g
    alb = ramp(h, [(0, '#b9cde0'), (0.5, '#e4edf5'), (1, '#f8fbff')])
    return alb, h, 0.45 - 0.15 * g, None, 3.0


def ice(f):
    e, c, n = f
    crack = 1 - ss(0.0, 0.022, e)
    h = np.clip(0.5 + 0.2 * c + 0.15 * n - 0.3 * crack, 0, 1)
    alb = mixc(ramp(0.3 + 0.5 * c + 0.2 * n, [(0, '#8fbcd9'), (1, '#cfe8f6')]), col('#eef8ff'), crack * 0.8)
    return alb, h, 0.1 + 0.35 * crack + 0.05 * n, None, 4.0


def moss(f):
    n, g, s = f
    clump = ss(0.3, 0.7, 1 - s * 2.5)
    h = 0.5 * n + 0.3 * clump + 0.2 * g
    return ramp(h, [(0, '#2c4520'), (0.5, '#4d7030'), (1, '#7a9c45')]), h, 0.85 - 0.1 * clump, None, 6.0


def jungle_floor(f):
    e, c, n = f
    leaf = ss(0.0, 0.05, e)
    leaves = ramp(c, [(0, '#6b5a2a'), (0.4, '#4f6b39'), (0.7, '#7a4a24'), (1, '#5d6a2e')])
    h = 0.35 + 0.4 * leaf + 0.25 * n
    return mixc(col('#2e2418'), leaves, leaf) * (0.85 + 0.3 * n)[..., None], h, 0.7 + 0.1 * (1 - leaf), None, 6.0


def basalt(f):
    e, c, n = f
    plate = ss(0.01, 0.08, e)
    h = 0.2 + 0.65 * plate * (0.9 + 0.1 * c) + 0.15 * n
    alb = ramp(0.3 + 0.4 * c + 0.3 * n, [(0, '#221d1b'), (1, '#3c3430')]) * (0.6 + 0.4 * plate)[..., None]
    return alb, h, 0.85, None, 8.0


def lava_rock(f):
    n, e, g = f
    ridge = 1 - np.abs(2 * n - 1)
    crack = 1 - ss(0.0, 0.03 + 0.02 * g, e)
    h = np.clip(0.6 * ridge + 0.4 * g - 0.4 * crack, 0, 1)
    alb = mixc(ramp(h, [(0, '#16120f'), (1, '#3a2f2a')]), col('#5a1a08'), crack)
    return alb, h, 0.8 - 0.3 * crack, crack, 8.0


def chitin(f):
    d1, c, e = f
    rings = 0.5 + 0.5 * np.sin(d1 * 60)
    plate = ss(0.0, 0.06, e)
    h = np.clip(0.3 + 0.5 * plate * (1 - 0.6 * d1) + 0.1 * rings, 0, 1)
    alb = ramp(0.3 + 0.5 * c + 0.2 * rings, [(0, '#2e2140'), (0.5, '#4a3566'), (1, '#6d5090')]) * (0.55 + 0.45 * plate)[..., None]
    return alb, h, 0.3 + 0.3 * (1 - plate), None, 6.0


def flesh(f):
    n, e, g = f
    vein = 1 - ss(0.0, 0.03, e)
    h = 0.5 * n + 0.3 * g + 0.2 * vein
    alb = mixc(ramp(n, [(0, '#5a2e4c'), (1, '#8a4e72')]), col('#2a1026'), vein * 0.8)
    return alb, h, 0.3 + 0.2 * g, vein, 4.0


def grass(f):
    n, g, s = f
    blades = ss(0.0, 0.2, s)
    h = 0.5 * n + 0.3 * g + 0.2 * blades
    alb = ramp(n, [(0, '#355f25'), (0.5, '#4f8a36'), (1, '#7fb04f')])
    alb = mixc(alb, col('#a39a5a'), 0.6 * ss(0.62, 0.78, g))
    return alb, h, 0.72, None, 5.0


def soil(f):
    n, p, g = f
    pebble = 1 - ss(0.05, 0.15, p)
    h = 0.5 * n + 0.35 * pebble + 0.15 * g
    alb = mixc(ramp(n, [(0, '#4a3526'), (1, '#7a5a40')]), col('#8a8178'), pebble * 0.6)
    return alb, h, 0.9 - 0.2 * pebble, None, 7.0


FBM = 'fbm'
LAYERS = {
    'sand': ([(FBM, 3, 1, {}), (FBM, 18, 2, {'detail': 3}), (FBM, 6, 3, {'detail': 6, 'distortion': 0.5})], sand),
    'cracked_earth': ([('edge', 6, 4, {}), ('cell', 6, 4, {}), (FBM, 10, 5, {'detail': 6})], cracked_earth),
    'rock': ([(FBM, 4, 6, {'detail': 8, 'rough': 0.6}), (FBM, 12, 7, {}), ('edge', 3, 8, {})], rock),
    'snow': ([(FBM, 3, 9, {'detail': 5}), (FBM, 24, 10, {'detail': 2}), (FBM, 1, 11, {})], snow),
    'ice': ([('edge', 5, 12, {}), ('cell', 5, 12, {}), (FBM, 8, 13, {'detail': 5})], ice),
    'moss': ([(FBM, 10, 14, {'detail': 6, 'rough': 0.65}), (FBM, 3, 15, {}), ('smooth', 16, 16, {})], moss),
    'jungle_floor': ([('edge', 9, 17, {}), ('cell', 9, 17, {}), (FBM, 6, 18, {'detail': 6})], jungle_floor),
    'basalt': ([('edge', 5, 19, {}), ('cell', 5, 19, {}), (FBM, 12, 20, {'detail': 5})], basalt),
    'lava_rock': ([(FBM, 5, 21, {'detail': 7}), ('edge', 4, 22, {}), (FBM, 16, 23, {})], lava_rock),
    'chitin': ([('f1', 4, 24, {}), ('cell', 4, 24, {}), ('edge', 4, 24, {})], chitin),
    'flesh': ([(FBM, 3, 25, {}), ('edge', 6, 26, {}), (FBM, 14, 27, {})], flesh),
    'grass': ([(FBM, 40, 28, {'detail': 3}), (FBM, 4, 29, {}), ('edge', 30, 30, {})], grass),
    'soil': ([(FBM, 5, 31, {'detail': 6}), ('smooth', 20, 32, {}), (FBM, 20, 33, {})], soil),
}


def build_layer(name, out_root):
    specs, recipe = LAYERS[name]
    fields = bake_fields(specs)
    albedo, height, rough, mask, strength = recipe(fields)
    height = np.clip(height, 0, 1).astype(np.float32)
    rough = np.broadcast_to(np.asarray(rough, np.float32), height.shape)
    cavity = np.clip((T.blur(height, 3.0) - height) * 4.0, 0, 1)
    albedo = albedo * (1 - 0.35 * cavity)[..., None] * (0.86 + 0.14 * height)[..., None]
    alpha = height if mask is None else np.clip(mask, 0, 1)
    rgba = np.concatenate([C.encode_srgb(albedo), alpha[..., None]], -1)
    normal = T.normals(height, strength) * 0.5 + 0.5
    nr = np.concatenate([normal, np.clip(rough, 0.02, 1)[..., None]], -1)
    base = os.path.join(out_root, 'textures', 'ground', name)
    a = C.save_webp(base + '_albedo.webp', rgba, quality=84)
    b = C.save_webp(base + '_nr.webp', nr, quality=92)
    print(f'ASSET textures/ground/{name}_albedo.webp {a} bytes; {name}_nr.webp {b} bytes')
    return C.encode_srgb(albedo), normal


def main():
    opts = C.options()
    C.reset()
    tiles = []
    for name in LAYERS:
        if C.wanted(opts, name):
            alb, nrm = build_layer(name, opts['out'])
            # QA: rolled by half, so a broken seam would cross the middle
            tiles.append(np.roll(np.roll(alb, SIZE // 2, 0), SIZE // 2, 1)[::2, ::2])
            tiles.append(np.roll(np.roll(nrm, SIZE // 2, 0), SIZE // 2, 1)[::2, ::2])
    if opts['preview'] and tiles:
        cols = 6
        rows = math.ceil(len(tiles) / cols)
        h = SIZE // 2
        grid = np.zeros((rows * h, cols * h, 3), np.float32)
        for i, t in enumerate(tiles):
            r, c = divmod(i, cols)
            grid[r * h:(r + 1) * h, c * h:(c + 1) * h] = t
        path = os.path.join(opts['preview'], 'sheet_ground.png')
        C.save_image(path, grid, 'PNG')
        print(f'PREVIEW {path}')


main()
