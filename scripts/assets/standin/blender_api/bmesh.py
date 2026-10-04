# The slice of Blender's `bmesh` the geometry generators use, in pure Python,
# for the stand-in build (scripts/assets/README.md §7). Topology follows
# Blender's operators — create_cube, create_cone (n-gon caps, an apex welded to
# one vertex), create_uvsphere, create_icosphere, a one-segment edge bevel,
# remove_doubles, recalc_face_normals — so a part has the triangle count it has
# in Blender, and `Builder.add`'s loops, layers and sharp edges behave the same.
import math

from mathutils import Matrix, Vector

# ------------------------------------------------------------------ elements


class _UV:
    __slots__ = ('uv',)

    def __init__(self):
        self.uv = Vector((0.0, 0.0))

    def __setattr__(self, name, value):
        object.__setattr__(self, name, Vector(value))


class BMLayer:
    def __init__(self, kind, name):
        self.kind = kind
        self.name = name


class _LayerKind:
    def __init__(self, kind):
        self.kind = kind
        self.items = []

    def new(self, name=''):
        layer = BMLayer(self.kind, name)
        self.items.append(layer)
        return layer

    def get(self, name, default=None):
        return next((layer for layer in self.items if layer.name == name), default)

    @property
    def active(self):
        return self.items[0] if self.items else None

    def __iter__(self):
        return iter(self.items)


class _Layers:
    def __init__(self, kinds):
        for kind in kinds:
            setattr(self, kind, _LayerKind(kind))


class BMVert:
    __slots__ = ('co', 'normal', 'link_edges', 'link_faces', 'index', '_data', 'tag')

    def __init__(self, co):
        self.co = Vector(co)
        self.normal = Vector((0.0, 0.0, 0.0))
        self.link_edges = []
        self.link_faces = []
        self.index = -1
        self._data = {}
        self.tag = False

    def __getitem__(self, layer):
        if layer.kind == 'deform':
            return self._data.setdefault(layer, {})
        return self._data.get(layer)

    def __setitem__(self, layer, value):
        self._data[layer] = value


class BMEdge:
    __slots__ = ('verts', 'link_faces', 'smooth', 'seam', 'index', 'tag')

    def __init__(self, a, b):
        self.verts = (a, b)
        self.link_faces = []
        self.smooth = True
        self.seam = False
        self.index = -1
        self.tag = False

    def other_vert(self, v):
        a, b = self.verts
        return b if v is a else a if v is b else None

    def calc_length(self):
        return (self.verts[0].co - self.verts[1].co).length

    def calc_face_angle(self, fallback=None):
        if len(self.link_faces) != 2:
            if fallback is None:
                raise ValueError('BMEdge.calc_face_angle(): edge has not got 2 faces')
            return fallback
        a, b = self.link_faces
        return a.normal.angle(b.normal, 0.0)


class BMLoop:
    __slots__ = ('vert', 'edge', 'face', '_data')

    def __init__(self, vert, edge, face):
        self.vert = vert
        self.edge = edge
        self.face = face
        self._data = {}

    def __getitem__(self, layer):
        if layer not in self._data:
            self._data[layer] = _UV() if layer.kind == 'uv' else Vector((1.0, 1.0, 1.0, 1.0))
        return self._data[layer]

    def __setitem__(self, layer, value):
        self._data[layer] = Vector(value)

    @property
    def link_loop_next(self):
        loops = self.face.loops
        return loops[(loops.index(self) + 1) % len(loops)]

    @property
    def link_loop_prev(self):
        loops = self.face.loops
        return loops[(loops.index(self) - 1) % len(loops)]

    def calc_angle(self):
        prev, nxt = self.link_loop_prev.vert.co, self.link_loop_next.vert.co
        return (prev - self.vert.co).angle(nxt - self.vert.co, 0.0)


class BMFace:
    __slots__ = ('verts', 'edges', 'loops', 'normal', 'material_index', 'smooth', 'index', 'tag')

    def __init__(self):
        self.verts = []
        self.edges = []
        self.loops = []
        self.normal = Vector((0.0, 0.0, 1.0))
        self.material_index = 0
        self.smooth = False
        self.index = -1
        self.tag = False

    def calc_center_median(self):
        n = len(self.verts)
        return Vector((sum(v.co.x for v in self.verts) / n, sum(v.co.y for v in self.verts) / n,
                       sum(v.co.z for v in self.verts) / n))

    def calc_area(self):
        return 0.5 * _newell(self.verts).length

    def normal_update(self):
        n = _newell(self.verts)
        self.normal = n.normalized() if n.length > 0 else Vector((0.0, 0.0, 1.0))

    def normal_flip(self):
        _reverse(self)


def _newell(verts):
    nx = ny = nz = 0.0
    k = len(verts)
    for i in range(k):
        a, b = verts[i].co, verts[(i + 1) % k].co
        nx += (a.y - b.y) * (a.z + b.z)
        ny += (a.z - b.z) * (a.x + b.x)
        nz += (a.x - b.x) * (a.y + b.y)
    return Vector((nx, ny, nz))


def _walks(face, edge):
    """True when `face` walks `edge` from its first vertex to its second."""
    for loop in face.loops:
        if loop.edge is edge:
            return loop.vert is edge.verts[0]
    return None


def _reverse(face):
    """Flip a face's winding, keeping each loop's data on its vertex."""
    data = {loop.vert: loop._data for loop in face.loops}
    verts = list(reversed(face.verts))
    face.verts = verts
    face.loops = []
    for i, v in enumerate(verts):
        nxt = verts[(i + 1) % len(verts)]
        edge = next(e for e in v.link_edges if e.other_vert(v) is nxt)
        loop = BMLoop(v, edge, face)
        loop._data = data[v]
        face.loops.append(loop)
    face.edges = [loop.edge for loop in face.loops]
    face.normal = -face.normal


# --------------------------------------------------------------- sequences


class _Seq:
    def __init__(self, bm, layer_kinds=()):
        self._bm = bm
        self._items = []
        self.layers = _Layers(layer_kinds)

    def __iter__(self):
        return iter(list(self._items))

    def __len__(self):
        return len(self._items)

    def __getitem__(self, i):
        return self._items[i]

    def ensure_lookup_table(self):
        pass

    def index_update(self):
        for i, item in enumerate(self._items):
            item.index = i


class _Verts(_Seq):
    def __init__(self, bm):
        super().__init__(bm, ('deform',))

    def new(self, co=(0.0, 0.0, 0.0), example=None):
        v = BMVert(co)
        self._items.append(v)
        return v

    def remove(self, v):
        for f in list(v.link_faces):
            self._bm.faces.remove(f)
        for e in list(v.link_edges):
            self._bm.edges.remove(e)
        self._items.remove(v)


class _Edges(_Seq):
    def new(self, verts):
        a, b = verts
        if _edge_between(a, b) is not None:
            raise ValueError('edges.new(): this edge exists')
        return self._make(a, b)

    def _make(self, a, b):
        e = BMEdge(a, b)
        a.link_edges.append(e)
        b.link_edges.append(e)
        self._items.append(e)
        return e

    def get(self, verts, fallback=None):
        return _edge_between(*verts) or fallback

    def remove(self, e):
        for f in list(e.link_faces):
            self._bm.faces.remove(f)
        for v in e.verts:
            v.link_edges.remove(e)
        self._items.remove(e)


class _Faces(_Seq):
    def new(self, verts, example=None):
        verts = list(verts)
        if len(verts) < 3 or len(set(map(id, verts))) != len(verts):
            raise ValueError('faces.new(verts): need at least 3 unique verts')
        key = frozenset(map(id, verts))
        for f in verts[0].link_faces:
            if frozenset(map(id, f.verts)) == key:
                raise ValueError('faces.new(verts): face already exists')
        f = BMFace()
        f.verts = verts
        for i, v in enumerate(verts):
            nxt = verts[(i + 1) % len(verts)]
            edge = _edge_between(v, nxt) or self._bm.edges._make(v, nxt)
            edge.link_faces.append(f)
            f.edges.append(edge)
            f.loops.append(BMLoop(v, edge, f))
            v.link_faces.append(f)
        f.normal_update()
        if example is not None:
            f.material_index, f.smooth = example.material_index, example.smooth
        self._items.append(f)
        return f

    def remove(self, f):
        for e in f.edges:
            if f in e.link_faces:
                e.link_faces.remove(f)
        for v in f.verts:
            if f in v.link_faces:
                v.link_faces.remove(f)
        self._items.remove(f)


def _edge_between(a, b):
    for e in a.link_edges:
        if e.other_vert(a) is b:
            return e
    return None


class _Loops:
    def __init__(self):
        self.layers = _Layers(('uv', 'float_color', 'color'))


class BMesh:
    def __init__(self):
        self.verts = _Verts(self)
        self.edges = _Edges(self)
        self.faces = _Faces(self)
        self.loops = _Loops()

    def normal_update(self):
        for f in self.faces:
            f.normal_update()
        for v in self.verts:
            total = Vector((0.0, 0.0, 0.0))
            for f in v.link_faces:
                loop = next(lp for lp in f.loops if lp.vert is v)
                total += f.normal * loop.calc_angle()
            v.normal = total.normalized() if total.length > 0 else Vector((0.0, 0.0, 1.0))

    def free(self):
        pass

    def to_mesh(self, mesh):
        mesh._from_bmesh(self)

    def copy(self):
        bm = BMesh()
        vmap = {v: bm.verts.new(v.co) for v in self.verts}
        for f in self.faces:
            nf = bm.faces.new([vmap[v] for v in f.verts])
            nf.material_index, nf.smooth = f.material_index, f.smooth
        return bm


def new():
    return BMesh()


# --------------------------------------------------------------- operators


class _Ops:
    """bmesh.ops: the operators the generators call."""

    @staticmethod
    def transform(bm, matrix, verts, space=None):
        for v in verts:
            v.co = matrix @ v.co

    @staticmethod
    def scale(bm, vec, verts, space=None):
        for v in verts:
            v.co = Vector((v.co.x * vec[0], v.co.y * vec[1], v.co.z * vec[2]))

    @staticmethod
    def translate(bm, vec, verts, space=None):
        for v in verts:
            v.co = v.co + Vector(vec)

    @staticmethod
    def rotate(bm, cent=(0, 0, 0), matrix=None, verts=(), space=None):
        c = Vector(cent)
        for v in verts:
            v.co = matrix @ (v.co - c) + c

    @staticmethod
    def create_cube(bm, size=1.0, matrix=None):
        h = size / 2
        vs = [bm.verts.new((x * h, y * h, z * h)) for x in (-1, 1) for y in (-1, 1) for z in (-1, 1)]

        def at(x, y, z):
            return vs[(x > 0) * 4 + (y > 0) * 2 + (z > 0)]

        quads = [
            [at(-1, -1, -1), at(-1, -1, 1), at(-1, 1, 1), at(-1, 1, -1)],  # −X
            [at(1, -1, -1), at(1, 1, -1), at(1, 1, 1), at(1, -1, 1)],      # +X
            [at(-1, -1, -1), at(1, -1, -1), at(1, -1, 1), at(-1, -1, 1)],  # −Y
            [at(-1, 1, -1), at(-1, 1, 1), at(1, 1, 1), at(1, 1, -1)],      # +Y
            [at(-1, -1, -1), at(-1, 1, -1), at(1, 1, -1), at(1, -1, -1)],  # −Z
            [at(-1, -1, 1), at(1, -1, 1), at(1, 1, 1), at(-1, 1, 1)],      # +Z
        ]
        for q in quads:
            bm.faces.new(q)
        return {'verts': vs}

    @staticmethod
    def create_cone(bm, cap_ends=True, cap_tris=False, segments=8, radius1=1.0, radius2=1.0, depth=1.0, matrix=None):
        if cap_tris:
            raise NotImplementedError('create_cone(cap_tris=True)')
        h = depth / 2
        low, high = [], []
        for a in range(segments):
            phi = 2 * math.pi * a / segments
            low.append(bm.verts.new((radius1 * math.sin(phi), radius1 * math.cos(phi), -h)))
            high.append(bm.verts.new((radius2 * math.sin(phi), radius2 * math.cos(phi), h)))
        for a in range(segments):
            b = (a + 1) % segments
            bm.faces.new([low[a], low[b], high[b], high[a]])
        if cap_ends:
            if radius1 > 0:
                bm.faces.new(list(reversed(low)))
            if radius2 > 0:
                bm.faces.new(high)
        # create_cone welds a zero radius into an apex, as Blender's does
        _Ops.remove_doubles(bm, verts=list(bm.verts), dist=1e-6)
        _Ops.recalc_face_normals(bm, faces=list(bm.faces))
        return {'verts': list(bm.verts)}

    @staticmethod
    def create_uvsphere(bm, u_segments=12, v_segments=8, radius=1.0, matrix=None):
        top = bm.verts.new((0.0, 0.0, radius))
        bottom = bm.verts.new((0.0, 0.0, -radius))
        rings = []
        for j in range(1, v_segments):
            theta = math.pi * j / v_segments
            z, r = radius * math.cos(theta), radius * math.sin(theta)
            rings.append([bm.verts.new((r * math.cos(2 * math.pi * i / u_segments), r * math.sin(2 * math.pi * i / u_segments), z))
                          for i in range(u_segments)])
        for i in range(u_segments):
            k = (i + 1) % u_segments
            bm.faces.new([top, rings[0][i], rings[0][k]])
            for j in range(len(rings) - 1):
                bm.faces.new([rings[j][i], rings[j + 1][i], rings[j + 1][k], rings[j][k]])
            bm.faces.new([rings[-1][i], bottom, rings[-1][k]])
        _Ops.recalc_face_normals(bm, faces=list(bm.faces))
        return {'verts': list(bm.verts)}

    @staticmethod
    def create_icosphere(bm, subdivisions=1, radius=1.0, matrix=None):
        # Blender's icovert table (z poles), on the unit sphere
        r, z = 2 / math.sqrt(5), 1 / math.sqrt(5)
        pts = [Vector((0, 0, -1))]
        for k in range(5):
            a = math.radians(36 + 72 * k)  # the lower ring, at odd multiples of 36°
            pts.append(Vector((math.cos(a) * r, math.sin(a) * r, -z)))
        for k in range(5):
            a = math.radians(72 * k)  # the upper ring, at multiples of 72°
            pts.append(Vector((math.cos(a) * r, math.sin(a) * r, z)))
        pts.append(Vector((0, 0, 1)))
        tris = []
        for k in range(5):
            k1 = (k + 1) % 5
            tris.append((0, 1 + k1, 1 + k))
            tris.append((1 + k, 1 + k1, 6 + k1))
            tris.append((1 + k, 6 + k1, 6 + k))
            tris.append((6 + k, 6 + k1, 11))
        for _ in range(subdivisions - 1):
            mid = {}
            out = []

            def m(i, j):
                key = (min(i, j), max(i, j))
                if key not in mid:
                    mid[key] = len(pts)
                    pts.append(((pts[i] + pts[j]) / 2).normalized())
                return mid[key]

            for a, b, c in tris:
                ab, bc, ca = m(a, b), m(b, c), m(c, a)
                out += [(a, ab, ca), (ab, b, bc), (ca, bc, c), (ab, bc, ca)]
            tris = out
        vs = [bm.verts.new(p * radius) for p in pts]
        for a, b, c in tris:
            bm.faces.new([vs[a], vs[b], vs[c]])
        _Ops.recalc_face_normals(bm, faces=list(bm.faces))
        return {'verts': vs}

    @staticmethod
    def remove_doubles(bm, verts, dist=1e-6):
        verts = list(verts)
        keep = {}
        cell = max(dist, 1e-9) * 4
        grid = {}
        for v in verts:
            key = tuple(math.floor(c / cell) for c in v.co)
            hit = None
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    for dz in (-1, 0, 1):
                        for w in grid.get((key[0] + dx, key[1] + dy, key[2] + dz), ()):
                            if (w.co - v.co).length <= dist:
                                hit = w
                                break
                        if hit:
                            break
                    if hit:
                        break
                if hit:
                    break
            if hit is None:
                grid.setdefault(key, []).append(v)
            else:
                keep[v] = hit
        if not keep:
            return {}
        faces = []
        for f in list(bm.faces):
            if any(v in keep for v in f.verts):
                vs, data = [], []
                for loop in f.loops:
                    w = keep.get(loop.vert, loop.vert)
                    if vs and vs[-1] is w:
                        continue
                    vs.append(w)
                    data.append(loop._data)
                if len(vs) > 1 and vs[0] is vs[-1]:
                    vs.pop()
                    data.pop()
                faces.append((f, vs, data))
        for f, _, _ in faces:
            bm.faces.remove(f)
        for v in keep:
            for e in list(v.link_edges):
                bm.edges.remove(e)
            bm.verts._items.remove(v)
        for old, vs, data in faces:
            if len(vs) < 3:
                continue
            try:
                nf = bm.faces.new(vs)
            except ValueError:
                continue
            nf.material_index, nf.smooth = old.material_index, old.smooth
            for loop, d in zip(nf.loops, data):
                loop._data = d
        # edges left without faces by the weld go too (Blender's weld kills them)
        for e in list(bm.edges):
            if not e.link_faces:
                bm.edges.remove(e)
        return {}

    @staticmethod
    def recalc_face_normals(bm, faces):
        faces = list(faces)
        todo = set(map(id, faces))
        by_id = {id(f): f for f in faces}
        for f in faces:
            f.normal_update()
        while todo:
            seed = by_id[todo.pop()]
            island = [seed]
            stack = [seed]
            while stack:
                f = stack.pop()
                for loop in f.loops:
                    e = loop.edge
                    for g in e.link_faces:
                        if g is f or id(g) not in todo:
                            continue
                        # a consistent neighbour walks the shared edge the other way
                        same_way = _walks(f, e) == _walks(g, e)
                        if same_way:
                            _reverse(g)
                        todo.discard(id(g))
                        island.append(g)
                        stack.append(g)
            area = sum(f.calc_area() for f in island) or 1.0
            centre = Vector((0.0, 0.0, 0.0))
            for f in island:
                centre += f.calc_center_median() * (f.calc_area() / area)
            far = max(island, key=lambda f: (f.calc_center_median() - centre).length)
            if far.normal.dot(far.calc_center_median() - centre) < 0:
                for f in island:
                    _reverse(f)
            for f in island:
                f.normal_update()
        return {}

    @staticmethod
    def bevel(bm, geom, offset=0.0, segments=1, profile=0.5, affect='EDGES', clamp_overlap=True, **_):
        """A one-segment bevel of every edge of a closed mesh whose vertices
        each join three faces (a box): each face insets by `offset`, each edge
        becomes a quad, each corner a triangle — Blender's result."""
        if segments != 1 or affect != 'EDGES':
            raise NotImplementedError('bevel: one segment over edges only')
        edges = [g for g in geom if isinstance(g, BMEdge)]
        if len(edges) != len(bm.edges) or any(len(v.link_faces) != 3 for v in bm.verts):
            raise NotImplementedError('bevel: only every edge of a box-like solid')
        if clamp_overlap:
            offset = min(offset, 0.5 * min(e.calc_length() for e in bm.edges) * 0.999)
        faces = list(bm.faces)
        for f in faces:
            f.normal_update()
        corner = {}
        for f in faces:
            k = len(f.verts)
            for i, v in enumerate(f.verts):
                a = (f.verts[i - 1].co - v.co).normalized()
                b = (f.verts[(i + 1) % k].co - v.co).normalized()
                s = math.sin(a.angle(b, math.pi / 2)) or 1.0
                corner[(id(f), id(v))] = v.co + (a + b) * (offset / s)
        out = BMesh()
        made = {key: out.verts.new(co) for key, co in corner.items()}
        for f in faces:
            out.faces.new([made[(id(f), id(v))] for v in f.verts])
        for e in list(bm.edges):
            fa, fb = e.link_faces
            v1, v2 = e.verts
            quad = [made[(id(fa), id(v1))], made[(id(fa), id(v2))], made[(id(fb), id(v2))], made[(id(fb), id(v1))]]
            nf = out.faces.new(quad)
            if nf.normal.dot(fa.normal + fb.normal) < 0:
                _reverse(nf)
        for v in list(bm.verts):
            ring = [made[(id(f), id(v))] for f in v.link_faces]
            nf = out.faces.new(ring)
            outward = Vector((0.0, 0.0, 0.0))
            for f in v.link_faces:
                outward += f.normal
            if nf.normal.dot(outward) < 0:
                _reverse(nf)
        # swap the result in place
        bm.verts, bm.edges, bm.faces = out.verts, out.edges, out.faces
        for seq in (bm.verts, bm.edges, bm.faces):
            seq._bm = bm
        return {'faces': list(bm.faces)}


ops = _Ops()

__all__ = ['new', 'ops', 'BMesh', 'BMVert', 'BMEdge', 'BMFace', 'BMLoop', 'Matrix']
