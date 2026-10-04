# The slice of Blender's `mathutils` the geometry generators use (props.py,
# cave.py, lib/common.py), in pure Python, for the stand-in build
# (scripts/assets/README.md §7). Same semantics as Blender's: `Matrix @ Vector`
# transforms a point (w = 1 for a 3-vector under a 4×4), `Vector @ Vector` is
# the dot product, Euler 'XYZ' is R = Rz·Ry·Rx.
import math


class Vector:
    __slots__ = ('_v',)

    def __init__(self, seq=(0.0, 0.0, 0.0)):
        self._v = [float(x) for x in seq]

    # -- sequence protocol
    def __len__(self):
        return len(self._v)

    def __iter__(self):
        return iter(self._v)

    def __getitem__(self, i):
        return self._v[i]

    def __setitem__(self, i, value):
        self._v[i] = float(value)

    def __repr__(self):
        return f'Vector(({", ".join(f"{x:.4f}" for x in self._v)}))'

    def _get(i):  # noqa: N805 — a property factory
        return property(lambda self: self._v[i], lambda self, value: self._v.__setitem__(i, float(value)))

    x, y, z, w = _get(0), _get(1), _get(2), _get(3)

    # -- arithmetic
    def __add__(self, o):
        return Vector(a + b for a, b in zip(self._v, o))

    __radd__ = __add__

    def __sub__(self, o):
        return Vector(a - b for a, b in zip(self._v, o))

    def __rsub__(self, o):
        return Vector(b - a for a, b in zip(self._v, o))

    def __mul__(self, o):
        if isinstance(o, (int, float)):
            return Vector(a * o for a in self._v)
        return Vector(a * b for a, b in zip(self._v, o))  # element-wise, as mathutils does

    __rmul__ = __mul__

    def __truediv__(self, o):
        return Vector(a / o for a in self._v)

    def __neg__(self):
        return Vector(-a for a in self._v)

    def __iadd__(self, o):
        self._v = [a + b for a, b in zip(self._v, o)]
        return self

    def __isub__(self, o):
        self._v = [a - b for a, b in zip(self._v, o)]
        return self

    def __imul__(self, o):
        self._v = [a * o for a in self._v] if isinstance(o, (int, float)) else [a * b for a, b in zip(self._v, o)]
        return self

    def __matmul__(self, o):
        if isinstance(o, Vector):
            return self.dot(o)
        return NotImplemented

    def __eq__(self, o):
        return isinstance(o, (Vector, tuple, list)) and len(o) == len(self._v) and all(a == b for a, b in zip(self._v, o))

    def __hash__(self):
        return hash(tuple(self._v))

    # -- vector maths
    @property
    def length(self):
        return math.sqrt(sum(a * a for a in self._v))

    @property
    def length_squared(self):
        return sum(a * a for a in self._v)

    @property
    def xy(self):
        return Vector(self._v[:2])

    @property
    def xyz(self):
        return Vector(self._v[:3])

    def copy(self):
        return Vector(self._v)

    def dot(self, o):
        return sum(a * b for a, b in zip(self._v, o))

    def cross(self, o):
        a, b = self._v, list(o)
        return Vector((a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]))

    def normalized(self):
        n = self.length
        return Vector(a / n for a in self._v) if n > 0 else Vector(self._v)

    def normalize(self):
        n = self.length
        if n > 0:
            self._v = [a / n for a in self._v]

    def lerp(self, o, t):
        return Vector(a + (b - a) * t for a, b in zip(self._v, o))

    def angle(self, o, fallback=None):
        la, lb = self.length, Vector(o).length
        if la == 0 or lb == 0:
            if fallback is None:
                raise ValueError('angle with a zero-length vector')
            return fallback
        return math.acos(max(-1.0, min(1.0, self.dot(o) / (la * lb))))

    def to_3d(self):
        return Vector((self._v + [0.0, 0.0, 0.0])[:3])

    def to_4d(self):
        return Vector((self._v + [0.0, 0.0, 0.0])[:3] + [1.0])

    def rotation_difference(self, o):
        """The shortest-arc Quaternion turning this direction onto `o`."""
        a, b = self.normalized(), Vector(o).normalized()
        d = a.dot(b)
        if d >= 1.0 - 1e-12:
            return Quaternion()
        if d <= -1.0 + 1e-12:
            axis = Vector((1, 0, 0)).cross(a)
            if axis.length < 1e-6:
                axis = Vector((0, 1, 0)).cross(a)
            return Quaternion(axis.normalized(), math.pi)
        axis = a.cross(b).normalized()
        return Quaternion(axis, math.acos(max(-1.0, min(1.0, d))))


class Quaternion:
    __slots__ = ('w', 'x', 'y', 'z')

    def __init__(self, seq=None, angle=None):
        if seq is None:
            self.w, self.x, self.y, self.z = 1.0, 0.0, 0.0, 0.0
        elif angle is not None:
            axis = Vector(seq).normalized()
            s = math.sin(angle / 2)
            self.w, self.x, self.y, self.z = math.cos(angle / 2), axis.x * s, axis.y * s, axis.z * s
        else:
            self.w, self.x, self.y, self.z = (float(v) for v in seq)

    def __matmul__(self, o):
        if isinstance(o, Quaternion):
            w1, x1, y1, z1 = self.w, self.x, self.y, self.z
            w2, x2, y2, z2 = o.w, o.x, o.y, o.z
            return Quaternion((w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2, w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2,
                               w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2, w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2))
        if isinstance(o, Vector):
            return self.to_matrix() @ o
        return NotImplemented

    def to_matrix(self):
        w, x, y, z = self.w, self.x, self.y, self.z
        return Matrix((
            (1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)),
            (2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)),
            (2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)),
        ))


class Euler:
    __slots__ = ('_v', 'order')

    def __init__(self, seq=(0.0, 0.0, 0.0), order='XYZ'):
        self._v = [float(a) for a in seq]
        self.order = order

    def __iter__(self):
        return iter(self._v)

    def __getitem__(self, i):
        return self._v[i]

    x = property(lambda self: self._v[0])
    y = property(lambda self: self._v[1])
    z = property(lambda self: self._v[2])

    def to_matrix(self):
        if self.order != 'XYZ':
            raise NotImplementedError(f'Euler order {self.order}')
        rx, ry, rz = self._v
        return Matrix.Rotation(rz, 3, 'Z') @ Matrix.Rotation(ry, 3, 'Y') @ Matrix.Rotation(rx, 3, 'X')


class Matrix:
    __slots__ = ('_m',)

    def __init__(self, rows=None):
        if rows is None:
            rows = [[1.0 if i == j else 0.0 for j in range(4)] for i in range(4)]
        self._m = [[float(x) for x in row] for row in rows]

    @property
    def size(self):
        return len(self._m)

    def __getitem__(self, i):
        return self._m[i]

    def __repr__(self):
        return 'Matrix(' + ', '.join(str([round(x, 4) for x in row]) for row in self._m) + ')'

    @staticmethod
    def Identity(n):  # noqa: N802 — Blender's name
        return Matrix([[1.0 if i == j else 0.0 for j in range(n)] for i in range(n)])

    @staticmethod
    def Translation(v):  # noqa: N802
        v = list(v)
        m = Matrix.Identity(4)
        for i in range(3):
            m._m[i][3] = float(v[i])
        return m

    @staticmethod
    def Rotation(angle, size, axis):  # noqa: N802
        c, s = math.cos(angle), math.sin(angle)
        if isinstance(axis, str):
            r = {'X': ((1, 0, 0), (0, c, -s), (0, s, c)),
                 'Y': ((c, 0, s), (0, 1, 0), (-s, 0, c)),
                 'Z': ((c, -s, 0), (s, c, 0), (0, 0, 1))}[axis]
        else:
            x, y, z = Vector(axis).normalized()
            t = 1 - c
            r = ((t * x * x + c, t * x * y - s * z, t * x * z + s * y),
                 (t * x * y + s * z, t * y * y + c, t * y * z - s * x),
                 (t * x * z - s * y, t * y * z + s * x, t * z * z + c))
        m = Matrix(r)
        return m.to_4x4() if size == 4 else m

    @staticmethod
    def Scale(factor, size, axis=None):  # noqa: N802
        if axis is None:
            m = Matrix.Identity(size)
            for i in range(min(size, 3)):
                m._m[i][i] = float(factor)
            return m
        a = Vector(axis).normalized()
        m = Matrix.Identity(size)
        for i in range(3):
            for j in range(3):
                m._m[i][j] += (factor - 1) * a[i] * a[j]
        return m

    @staticmethod
    def LocRotScale(loc, rot, scale):  # noqa: N802
        if rot is None:
            r = Matrix.Identity(3)
        elif isinstance(rot, Matrix):
            r = rot.to_3x3()
        else:
            r = rot.to_matrix()
        m = r.to_4x4()
        s = list(scale) if scale is not None else [1.0, 1.0, 1.0]
        for i in range(3):
            for j in range(3):
                m._m[i][j] *= s[j]
        if loc is not None:
            for i, v in enumerate(loc):
                m._m[i][3] = float(v)
        return m

    def to_4x4(self):
        if self.size == 4:
            return Matrix(self._m)
        m = Matrix.Identity(4)
        for i in range(3):
            for j in range(3):
                m._m[i][j] = self._m[i][j]
        return m

    def to_3x3(self):
        return Matrix([row[:3] for row in self._m[:3]])

    def copy(self):
        return Matrix(self._m)

    def transposed(self):
        n = self.size
        return Matrix([[self._m[j][i] for j in range(n)] for i in range(n)])

    def inverted(self):
        n = self.size
        a = [row[:] + [1.0 if i == j else 0.0 for j in range(n)] for i, row in enumerate(self._m)]
        for col in range(n):
            pivot = max(range(col, n), key=lambda r: abs(a[r][col]))
            if abs(a[pivot][col]) < 1e-15:
                raise ValueError('matrix does not have an inverse')
            a[col], a[pivot] = a[pivot], a[col]
            p = a[col][col]
            a[col] = [x / p for x in a[col]]
            for r in range(n):
                if r != col and a[r][col] != 0:
                    f = a[r][col]
                    a[r] = [x - f * y for x, y in zip(a[r], a[col])]
        return Matrix([row[n:] for row in a])

    def to_translation(self):
        return Vector((self._m[0][3], self._m[1][3], self._m[2][3]))

    def __matmul__(self, o):
        if isinstance(o, Matrix):
            n = self.size
            return Matrix([[sum(self._m[i][k] * o._m[k][j] for k in range(n)) for j in range(n)] for i in range(n)])
        v = list(o)
        if self.size == 4 and len(v) == 3:
            out = [sum(self._m[i][k] * v[k] for k in range(3)) + self._m[i][3] for i in range(3)]
            return Vector(out)
        n = self.size
        return Vector(sum(self._m[i][k] * v[k] for k in range(n)) for i in range(n))


from . import noise  # noqa: E402,F401 — `from mathutils import noise`
