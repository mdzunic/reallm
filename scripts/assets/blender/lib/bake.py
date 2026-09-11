# Hull maps for modelled assets (PLAN R8). A model built with the Builder gets
# a unique UV layout over its textured faces (smart project, then packed);
# Cycles bakes geometric fields through those UVs — object position and normal,
# ambient occlusion, a crevice term, a Bevel edge mask, the `Col` part masks and
# object-space noise — and numpy paints the glTF maps from them: base colour
# (sRGB, AO folded in), ORM (G roughness, B metalness), a tangent-space normal
# map (OpenGL convention, from a height field differentiated in UV space) and an
# emissive map. Only the maps ship: the final material never reads `Col`, so the
# exporter drops the vertex colours.
#
# `Col` part masks (linear RGBA written by Builder.add(color=part(...))):
#   R  paint slot / 8 (the scheme's palette index)
#   G  decal: 0 none · 0.25 hazard stripes · 0.5 markings allowed · 0.75 lamp · 1 screen
#   B  wear, 0 (pristine) … 1 (battered)
import math

import bmesh
import bpy
import numpy as np

import common as C
import nodes as N
import tex as T

DECAL_NONE, DECAL_HAZARD, DECAL_MARK, DECAL_LAMP, DECAL_SCREEN = 0.0, 0.25, 0.5, 0.75, 1.0


def part(slot, decal=DECAL_NONE, wear=0.5):
    """The `Col` value that tags a part for the painter (see the header)."""
    return (slot / 8.0, decal, wear, 1.0)


# ------------------------------------------------------------------- unwrap


def unwrap(obj, slots=(0,), margin=0.004, angle=66.0):
    """Smart-project the faces whose material index is in `slots` and pack them;
    every other face collapses to (0, 0), so it paints no texel."""
    C.select_only([obj])
    bpy.context.scene.tool_settings.use_uv_select_sync = True
    bpy.ops.object.mode_set(mode='EDIT')
    bm = bmesh.from_edit_mesh(obj.data)
    uv = bm.loops.layers.uv.active
    for f in bm.faces:
        keep = f.material_index in slots
        f.select_set(keep)
        if not keep:
            for loop in f.loops:
                loop[uv].uv = (0.0, 0.0)
    bm.select_flush_mode()
    bmesh.update_edit_mesh(obj.data)
    bpy.ops.uv.smart_project(angle_limit=math.radians(angle), island_margin=margin, area_weight=0.0,
                             correct_aspect=True, scale_to_bounds=False)
    bpy.ops.uv.pack_islands(rotate=True, margin=margin, shape_method='CONCAVE')
    bpy.ops.object.mode_set(mode='OBJECT')


# ------------------------------------------------------------------- fields


def bounds(obj):
    co = np.zeros(len(obj.data.vertices) * 3, np.float32)
    obj.data.vertices.foreach_get('co', co)
    co = co.reshape(-1, 3)
    return co.min(0) - 1e-3, co.max(0) + 1e-3


class Fields:
    """Per-texel fields of one model, H×W (row 0 = top): `cover`, `P` and `N`
    (object space), `ao`, `crevice`, `edge`, `slot`, `decal`, `wear`, three
    noises `n1…n3`, and `texel` (metres per texel)."""

    def __init__(self, obj, size, samples=24, ao=0.3, crevice=0.04, edge=0.012, noise=(3.0, 18.0, 0.8), seed=0):
        lo, hi = bounds(obj)
        span = hi - lo
        self.size = size

        def pos(g):
            return [g.math('DIVIDE', g.math('SUBTRACT', c, float(lo[i])), float(span[i]))
                    for i, c in enumerate(g.xyz(g.coords('Object')))]

        a = N.bake_emit(obj, pos, size, samples=4, name='pos')
        self.cover = a[..., 3] > 0.5
        self.P = lo + a[..., :3] * span

        def nrm(g):
            return [g.math('ADD', g.math('MULTIPLY', c, 0.5), 0.5) for c in g.xyz(g.geometry('Normal'))]

        n = N.bake_emit(obj, nrm, size, samples=4, name='nrm')[..., :3] * 2 - 1
        self.N = n / np.maximum(np.linalg.norm(n, axis=-1, keepdims=True), 1e-6)

        occ = N.bake_emit(obj, lambda g: (g.ao(ao, 16), g.ao(crevice, 8), g.edge(edge, 8)), size, samples=samples, name='occ')
        self.ao, self.crevice, self.edge = occ[..., 0], occ[..., 1], occ[..., 2]

        col = N.bake_emit(obj, lambda g: [g.channel(g.attribute('Col'), k) for k in ('Red', 'Green', 'Blue')], size, samples=1, name='col')
        self.slot = np.rint(col[..., 0] * 8).astype(np.int32)
        self.decal = col[..., 1]
        self.wear = col[..., 2]

        def noises(g):
            p = g.coords('Object')
            streak = g.vmath('MULTIPLY', p, (1.0, 1.0, 9.0))
            return (g.noise(p, noise[0], seed + 1, detail=6), g.noise(streak, noise[1], seed + 2, detail=4),
                    g.noise(p, noise[2], seed + 3, detail=3))

        nz = N.bake_emit(obj, noises, size, samples=4, name='noise')
        self.n1, self.n2, self.n3 = nz[..., 0], nz[..., 1], nz[..., 2]
        self.texel = texel_size(self.P, self.cover)

    def decal_is(self, value):
        return np.abs(self.decal - value) < 0.1


def _neighbours(a, axis, up):
    """(next, previous) along image x (axis 1) or image up (axis 0: row − 1)."""
    if axis == 1:
        return np.roll(a, -1, 1), np.roll(a, 1, 1)
    return np.roll(a, 1, 0), np.roll(a, -1, 0)


def _stencil(field, P, cover, axis):
    fn, fp = _neighbours(field, axis, True)
    pn, pp = _neighbours(P, axis, True)
    cn, cp = _neighbours(cover, axis, True)
    both = cn & cp
    dh = np.where(both, (fn - fp) * 0.5, np.where(cn, fn - field, np.where(cp, field - fp, 0.0)))
    b3, n3, p3 = both[..., None], cn[..., None], cp[..., None]
    dp = np.where(b3, (pn - pp) * 0.5, np.where(n3, pn - P, np.where(p3, P - pp, 0.0)))
    return dh, np.linalg.norm(dp, axis=-1)


def texel_size(P, cover):
    _, du = _stencil(np.zeros(P.shape[:2], np.float32), P, cover, 1)
    _, dv = _stencil(np.zeros(P.shape[:2], np.float32), P, cover, 0)
    t = np.where(cover, 0.5 * (du + dv), 0.0)
    fallback = float(np.median(t[cover])) if cover.any() else 1.0
    return np.where(t > 0, t, fallback).astype(np.float32)


def height_normal(height, F, strength=1.0):
    """Tangent-space normal (OpenGL: +X along +u, +Y along +v = image up) of a
    height field in metres, differentiated in UV space against the baked
    positions, one-sided at island borders."""
    dhu, du = _stencil(height, F.P, F.cover, 1)
    dhv, dv = _stencil(height, F.P, F.cover, 0)
    su = np.where(du > 1e-7, dhu / np.maximum(du, 1e-7), 0.0)
    sv = np.where(dv > 1e-7, dhv / np.maximum(dv, 1e-7), 0.0)
    n = np.stack([-su * strength, -sv * strength, np.ones_like(su)], -1)
    return n / np.linalg.norm(n, axis=-1, keepdims=True)


def dilate(a, cover, px=8):
    """Grow covered texels outward `px` times (mean of covered 4-neighbours), so
    mipmaps never pull in the empty background."""
    a = a.copy()
    cov = cover.copy()
    for _ in range(px):
        acc = np.zeros_like(a, dtype=np.float32)
        cnt = np.zeros(cov.shape, np.float32)
        for axis, shift in ((0, 1), (0, -1), (1, 1), (1, -1)):
            c = np.roll(cov, shift, axis)
            acc += np.roll(a, shift, axis) * (c[..., None] if a.ndim == 3 else c)
            cnt += c
        grow = (~cov) & (cnt > 0)
        mean = acc / np.maximum(cnt, 1)[..., None] if a.ndim == 3 else acc / np.maximum(cnt, 1)
        a[grow] = mean[grow]
        cov = cov | grow
    return a


# ----------------------------------------------------------------- patterns


def hash01(*parts, seed=0):
    """A stable per-integer-tuple hash in [0, 1) (vectorised)."""
    h = np.full(np.shape(parts[0]), (seed * 2654435761 + 97) & 0xFFFFFFFF, np.uint64)
    for p in parts:
        v = np.asarray(p).astype(np.int64).astype(np.uint64) & np.uint64(0xFFFFFFFF)
        h = ((h ^ v) * np.uint64(0x9E3779B1)) & np.uint64(0xFFFFFFFF)
        h ^= h >> np.uint64(15)
    h = (h * np.uint64(0x85EBCA77)) & np.uint64(0xFFFFFFFF)
    h ^= h >> np.uint64(13)
    return (h & np.uint64(0xFFFFFF)).astype(np.float32) / float(0x1000000)


def planar(F):
    """Triplanar plane coordinates: the dominant normal axis picks (A, B)."""
    ax = np.argmax(np.abs(F.N), -1)
    P = F.P
    A = np.choose(ax, [P[..., 1], P[..., 0], P[..., 0]])
    B = np.choose(ax, [P[..., 2], P[..., 2], P[..., 1]])
    return ax, A, B


def panels(F, w=0.3, h=0.2, seed=1, seam=0.004, rivet=0.0035, pitch=0.05, inset=0.013, split=0.35):
    """Hull plating: rows of offset panels (a third split at mid-height) with
    seams, rivet rows along the row seams, and a random tone per panel."""
    ax, A, B = planar(F)
    t = F.texel
    row = np.floor(B / h)
    fb = B / h - row
    off = hash01(row, ax, seed=seed) * w
    col = np.floor((A + off) / w)
    fa = (A + off) / w - col
    split_it = hash01(row, col, ax, seed=seed + 1) < split
    half = np.floor(fb * 2)
    fb2 = np.where(split_it, fb * 2 - half, fb)
    hb = np.where(split_it, h / 2, h)
    db = np.minimum(fb2, 1 - fb2) * hb
    da = np.minimum(fa, 1 - fa) * w
    d = np.minimum(da, db)
    seam_mask = 1 - T.smoothstep(seam * 0.5, seam * 0.5 + t, d)
    ra = np.mod(A + off, pitch) - pitch / 2
    rd = np.hypot(ra, db - inset)
    dome = np.clip(1 - (rd / rivet) ** 2, 0, 1)
    riv = (1 - T.smoothstep(rivet - t, rivet + t, rd)) * (da > inset * 1.5)
    tone = hash01(row, col, ax, np.where(split_it, half, 0), seed=seed + 2)
    return {'seam': seam_mask, 'rivet': riv, 'dome': np.sqrt(dome) * (da > inset * 1.5), 'tone': tone, 'dist': d,
            'A': A, 'B': B, 'ax': ax}


def stripes(A, B, period=0.07, t=0.002):
    s = np.mod((A + B) / period, 1.0)
    return T.smoothstep(0.5 - t / period, 0.5 + t / period, s) * (1 - T.smoothstep(1 - t / period, 1.0, s))


FONT = {  # 5 × 7, row 0 = top
    '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
    '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
    '2': ['01110', '10001', '00001', '00110', '01000', '10000', '11111'],
    '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
    '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
    '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
    '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
    '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
    '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
    '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
    'A': ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
    'C': ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
    'E': ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
    'G': ['01110', '10001', '10000', '10111', '10001', '10001', '01111'],
    'L': ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
    'M': ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
    'N': ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
    'O': ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
    'P': ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
    'R': ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
    'S': ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
    'T': ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
    'V': ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
    'X': ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
    '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
    ' ': ['00000'] * 7,
}


def text(F, string, origin, right, up, height, axis=None, sign=None):
    """A mask of `string` in the 5×7 font on the plane through `origin` spanned
    by unit vectors `right`/`up` (object space), characters `height` metres tall.
    Only texels facing along ±axis (sign) and within 2 cm of the plane draw."""
    o, r, u = (np.asarray(v, np.float32) for v in (origin, right, up))
    rel = F.P - o
    x = rel @ r / (height / 7.0)
    y = -(rel @ u) / (height / 7.0)  # glyph rows run downward
    normal = np.cross(r, u)
    near = np.abs(rel @ normal) < 0.02
    if axis is not None:
        near &= np.sign(F.N[..., axis]) == sign
        near &= np.abs(F.N[..., axis]) > 0.7
    mask = np.zeros(F.cover.shape, np.float32)
    for i, ch in enumerate(string):
        glyph = np.array([[c == '1' for c in rowbits] for rowbits in FONT[ch]], bool)
        gx = x - i * 6.0
        inside = near & (gx >= 0) & (gx < 5) & (y >= 0) & (y < 7)
        ix = np.clip(gx.astype(np.int32), 0, 4)
        iy = np.clip(y.astype(np.int32), 0, 6)
        mask = np.maximum(mask, (inside & glyph[iy, ix]).astype(np.float32))
    return mask


# --------------------------------------------------------------- the painter


def col(hexstr):
    return np.array(C.lin(hexstr)[:3], np.float32)


def mix(a, b, t):
    """Lerp; a per-texel `t` (H×W) broadcasts over colours ((3,) or H×W×3)."""
    t = np.clip(np.asarray(t, np.float32), 0, 1)
    a = np.asarray(a, np.float32)
    b = np.asarray(b, np.float32)
    if t.ndim == 2 and (a.ndim in (1, 3) or b.ndim in (1, 3)):
        t = t[..., None]
    return a * (1 - t) + b * t


class Paint:
    """Mutable per-texel maps (linear): base (H×W×3), rough, metal, height (m),
    emissive (H×W×3). A scheme fills them; `finish` turns them into images."""

    def __init__(self, F):
        shape = F.cover.shape
        self.F = F
        self.base = np.zeros(shape + (3,), np.float32)
        self.rough = np.full(shape, 0.5, np.float32)
        self.metal = np.zeros(shape, np.float32)
        self.height = np.zeros(shape, np.float32)
        self.emissive = np.zeros(shape + (3,), np.float32)
        self.chip = np.zeros(shape, np.float32)
        self.pn = None

    def hull(self, palette, rough, metal, seed=1, panel=(0.3, 0.2), tone=0.07, seam_depth=0.0016, seam_dark=0.55,
             rivets=True, wear=0.55, grime=0.5, bare='#8e9297', dirt='#241d16', edge_gain=10.0):
        """The shared look: slot paint, panel tones and seams, rivets, worn
        edges down to bare metal, grime in cavities."""
        F = self.F
        slot = np.clip(F.slot, 0, len(palette) - 1)
        pal = np.array([col(c) for c in palette], np.float32)
        base = pal[slot]
        rgh = np.asarray(rough, np.float32)[slot]
        mtl = np.asarray(metal, np.float32)[slot]
        pn = panels(F, *panel, seed=seed)
        self.pn = pn
        base = base * (1 + tone * (pn['tone'][..., None] * 2 - 1))
        base = base * (0.94 + 0.12 * F.n3[..., None])
        # seams: dark lines, rougher; rivets: a touch lighter, metallic
        base = base * (1 - seam_dark * pn['seam'][..., None])
        rgh = rgh + 0.2 * pn['seam']
        if rivets:
            base = mix(base, base * 1.25 + 0.03, pn['rivet'] * 0.6)
            mtl = np.maximum(mtl, 0.6 * pn['rivet'])
        # worn edges: the Bevel mask, broken up by streaky noise, scaled by the part's wear
        e = np.clip(F.edge * edge_gain, 0, 1)
        chip = T.smoothstep(0.35, 0.65, e * (0.55 + 0.9 * F.n2) * (0.4 + F.wear)) * wear
        chip = np.maximum(chip, T.smoothstep(0.78, 0.9, F.n2) * F.wear * wear * 0.5)
        base = mix(base, col(bare) * (0.85 + 0.3 * F.n1[..., None]), chip)
        rgh = mix(rgh, 0.32, chip)
        mtl = mix(mtl, 1.0, chip)
        self.chip = chip
        # grime: cavities and occlusion, patchy by noise
        cav = np.clip((1 - F.crevice) * 1.6, 0, 1)
        dirty = np.clip((0.55 * (1 - F.ao) + 0.7 * cav) * (0.5 + F.n1) * grime * (0.5 + F.wear), 0, 1)
        base = mix(base, col(dirt), dirty * 0.85)
        rgh = mix(rgh, 0.85, dirty)
        mtl = mix(mtl, 0.0, dirty * 0.8)
        self.base, self.rough, self.metal = base, rgh, mtl
        self.height = (-seam_depth * pn['seam'] + (0.0012 * pn['dome'] if rivets else 0)
                       + 0.0005 * (pn['tone'] - 0.5) - 0.00025 * chip + 0.00012 * F.n2)
        return pn

    def decal(self, mask, color, rough=None, metal=None, height=0.0, over_wear=True):
        """Paint `mask` (0..1) in `color` (hex or linear RGB array); worn chips show through."""
        m = np.clip(np.asarray(mask, np.float32), 0, 1)
        if over_wear:
            m = m * (1 - self.chip)
        c = col(color) if isinstance(color, str) else color
        self.base = mix(self.base, c * (0.92 + 0.12 * self.F.n3[..., None]), m)
        if rough is not None:
            self.rough = mix(self.rough, rough, m)
        if metal is not None:
            self.metal = mix(self.metal, metal, m)
        self.height = self.height + height * m

    def plain(self, mask, color, rough, metal):
        """Overwrite `mask` with one flat material: no seams, rivets, wear or grime."""
        m = np.asarray(mask, bool)
        c = col(color) if isinstance(color, str) else np.asarray(color, np.float32)
        self.base[m] = c * (0.96 + 0.08 * self.F.n3[m][:, None])
        self.rough[m] = rough
        self.metal[m] = metal
        self.height[m] = 0.0
        self.chip[m] = 0.0

    def glass(self, mask, center, tint='#0b1a26', sky='#6fb4e0', level=0.4):
        """Tinted glass with a faked sky reflection — a soft band on the upward
        faces and one diagonal glint — so it reads as glass without an
        environment map."""
        self.plain(mask, tint, 0.05, 0.2)
        nz = self.F.N[..., 2]
        rel = self.F.P - np.asarray(center, np.float32)
        band = T.smoothstep(0.45, 0.95, nz) * 0.55 + np.exp(-((nz - 0.25) / 0.12) ** 2) * 0.2
        glint = np.exp(-((rel[..., 0] * 0.8 + rel[..., 1] * 0.6 + 0.04) / 0.018) ** 2) * (nz > 0.35)
        self.glow(np.asarray(mask, np.float32) * np.clip(band + 1.2 * glint, 0, 1.4), sky, level)

    def hazard(self, mask, a='#e3b21f', b='#161618', period=0.07):
        pn = self.pn
        s = stripes(pn['A'], pn['B'], period, self.F.texel)
        self.decal(mask, mix(col(b)[None, None], col(a)[None, None], s), rough=0.55, metal=0.05)

    def glow(self, mask, color, level=1.0):
        c = col(color) if isinstance(color, str) else color
        self.emissive = np.maximum(self.emissive, np.clip(np.asarray(mask, np.float32), 0, 1)[..., None] * c * level)

    def soot(self, center, radius, strength=0.8, color='#16120f'):
        d = np.linalg.norm(self.F.P - np.asarray(center, np.float32), axis=-1) / radius
        m = np.clip(1 - d, 0, 1) ** 1.5 * (0.6 + 0.6 * self.F.n1) * strength
        self.base = mix(self.base, col(color), m)
        self.rough = mix(self.rough, 0.9, m)
        self.metal = mix(self.metal, 0.0, m)

    def finish(self, name, ao=0.55, normal_strength=1.0, emissive_strength=1.0, dilate_px=8, small=2):
        """Fold AO into the base colour, dilate, encode, and return the glTF
        material. ORM and emissive are written at 1/`small` resolution."""
        F = self.F
        base = self.base * (1 - ao * (1 - F.ao))[..., None]
        nrm = height_normal(self.height, F, normal_strength) * 0.5 + 0.5
        cover = F.cover
        base = dilate(C.encode_srgb(np.clip(base, 0, 1)), cover, dilate_px)
        nrm = dilate(nrm, cover, dilate_px)
        nrm[~_grown(cover, dilate_px)] = (0.5, 0.5, 1.0)
        orm = np.stack([np.ones_like(self.rough), np.clip(self.rough, 0.04, 1), np.clip(self.metal, 0, 1)], -1)
        orm = dilate(orm, cover, dilate_px)
        emi = dilate(C.encode_srgb(np.clip(self.emissive, 0, 1)), cover, dilate_px)
        if small > 1:
            orm = downsample(orm, small)
            emi = downsample(emi, small)
        self.images = {'base': base, 'orm': orm, 'normal': nrm, 'emissive': emi}
        has_glow = float(self.emissive.max()) > 0.0
        return material(name, base, orm, nrm, emi if has_glow else None, emissive_strength)


def _grown(cover, px):
    cov = cover.copy()
    for _ in range(px):
        cov = cov | np.roll(cov, 1, 0) | np.roll(cov, -1, 0) | np.roll(cov, 1, 1) | np.roll(cov, -1, 1)
    return cov


def downsample(a, k):
    h, w = a.shape[:2]
    return a.reshape(h // k, k, w // k, k, -1).mean(axis=(1, 3))


def rgba(a):
    a = np.asarray(a, np.float32)
    if a.shape[2] == 3:
        a = np.concatenate([a, np.ones(a.shape[:2] + (1,), np.float32)], -1)
    return a


def material(name, base, orm, normal, emissive=None, strength=1.0):
    """Principled BSDF over packed images the glTF exporter turns into
    baseColor / metallicRoughness / normal / emissive textures."""
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')

    def image(key, arr, space):
        node = nt.nodes.new('ShaderNodeTexImage')
        node.image = C.image_from_array(f'{name}_{key}', rgba(arr)[::-1], space)
        return node

    tb = image('base', base, 'sRGB')
    nt.links.new(tb.outputs['Color'], bsdf.inputs['Base Color'])
    to = image('orm', orm, 'Non-Color')
    sep = nt.nodes.new('ShaderNodeSeparateColor')
    nt.links.new(to.outputs['Color'], sep.inputs['Color'])
    nt.links.new(sep.outputs['Green'], bsdf.inputs['Roughness'])
    nt.links.new(sep.outputs['Blue'], bsdf.inputs['Metallic'])
    tn = image('normal', normal, 'Non-Color')
    nm = nt.nodes.new('ShaderNodeNormalMap')
    nt.links.new(tn.outputs['Color'], nm.inputs['Color'])
    nt.links.new(nm.outputs['Normal'], bsdf.inputs['Normal'])
    if emissive is not None:
        te = image('emissive', emissive, 'sRGB')
        nt.links.new(te.outputs['Color'], bsdf.inputs['Emission Color'])
        bsdf.inputs['Emission Strength'].default_value = strength
    return mat


def save_sheet(paint, path):
    """QA: base | normal | roughness | emissive side by side (never shipped)."""
    im = paint.images
    s = im['base'].shape[0]
    up = lambda a: np.repeat(np.repeat(a, s // a.shape[0], 0), s // a.shape[1], 1)  # noqa: E731
    rough = up(np.repeat(im['orm'][..., 1:2], 3, -1))
    grid = np.concatenate([im['base'], im['normal'], rough, up(im['emissive'])], 1)
    C.save_image(path, grid[::2, ::2], 'PNG')
    print(f'PREVIEW {path}')
