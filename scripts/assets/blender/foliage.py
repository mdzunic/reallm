# The foliage atlas (SPEC-052 §3.3, §4.6): textures/foliage/atlas.webp, 512 × 512
# RGBA — a 4 × 4 grid of 128 px cells, row-major from the top-left — which
# SPEC-053 binds at runtime as the map of the trees' `Foliage` material (leaf
# cards on cells 0–5, bark on 15) and of the ground cover.
#   0, 1   jungle broad-leaf clusters    seen from above, any 90° rotation
#   2, 3   temperate leaf clusters       seen from above, any 90° rotation
#   4, 5   fern fronds                   base at the bottom edge, tip at the top
#   6, 7   lush grass; 8 dry grass;      tufts standing on the bottom edge
#   9      meadow flowers in grass
#   10, 11 frost fern, ash frond         fronds, base at the bottom edge
#   12, 13 hive tendrils, moss mound     standing on the bottom edge
#   14     broad-leaf ground plant       a rosette seen from above
#   15     bark                          opaque; fibres run along v, and its
#                                        120 px interior tiles both ways
#
# Nothing is rendered: numpy paints each cell at 4× supersampling (512 px) from
# seeded primitives — ribbons (a polyline spine with a half-width along it:
# leaves, pinnae, blades, stems, tendrils) and blobs (a radius around a centre:
# flower heads, the moss mound) — composited front over back with a soft
# contact shadow, then box-filters it to 128 px. Leaves are signed-distance leaf
# shapes with a midrib, veins and a value gradient; colours are mid-value,
# near-neutral greens and browns, because the runtime tints bring each planet's
# hue. Alpha is coverage; the 4 px gutter's alpha is 0, and the RGB of every
# pixel under alpha 0.5 is dilated, cell by cell, from the cell's own covered
# pixels, so mips never bleed a neighbour's colour or a black fringe.
#
# Every random number and lattice value comes from lib/tex.py's portable
# helpers, seeded by the cell's name (its painter's name), never from numpy's
# generator or the clock. scripts/assets/standin/foliage.mjs is this file in
# Node, painter for painter and draw for draw, for building without Blender.
import math
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'lib'))

import numpy as np  # noqa: E402

import common as C  # noqa: E402
import tex as T  # noqa: E402

ATLAS_SIZE = 512
CELL = 128
GUTTER = 4
SS = 4  # supersampling per axis: a cell is painted at CELL × SS and box-filtered down
QUALITY = 90

# Each planet's `palette.ground` (src/data/planets.ts), for the preview sheet.
GROUNDS = {
    'cinder4': '#c19a5b',
    'vetra': '#dbe9f2',
    'thessaly': '#4f6b39',
    'ferrum': '#3a2f2a',
    'hive': '#3a2f4a',
    'eden': '#6f9f5a',
}

PI = math.pi
TAU = 2 * math.pi
UP = -PI / 2  # screen space: x right, y down, so "up" is −π/2
ss = T.smoothstep


def clip(x, lo, hi):
    return min(max(x, lo), hi)


def lin(hexstr):
    return C.lin(hexstr)[:3]


# ------------------------------------------------------------------ canvas


class Canvas:
    """One cell, supersampled: coverage and premultiplied linear colour, row 0 at the top."""

    def __init__(self, name):
        self.name = name
        self.cell, self.ss, self.gutter = CELL, SS, GUTTER
        self.n = CELL * SS
        self.lo = GUTTER / CELL  # the inner box, in cell units (0..1 across the cell)
        self.hi = 1 - self.lo
        self.px = 1 / CELL  # one output pixel, in cell units
        n = self.n
        self.a = np.zeros((n, n))
        self.r = np.zeros((n, n))
        self.g = np.zeros((n, n))
        self.b = np.zeros((n, n))
        seed = T.name_seed(name)
        g1 = np.asarray(T.pnoise(n, 16, seed + 1), np.float64)
        g2 = np.asarray(T.pnoise(n, 48, seed + 2), np.float64)
        self.grain = 0.6 * g1 + 0.4 * g2


# -------------------------------------------------------------- geometry
# Spines are lists of (x, y) in cell units; widths are functions of the arc
# parameter s (0..1) that take a number or an array.


def arc_params(pts):
    """Arc-length parameter 0..1 at each point of a polyline."""
    s = [0.0]
    total = 0.0
    for i in range(1, len(pts)):
        dx = pts[i][0] - pts[i - 1][0]
        dy = pts[i][1] - pts[i - 1][1]
        total += math.sqrt(dx * dx + dy * dy)
        s.append(total)
    return [d / total if total > 0 else 0.0 for d in s]


def path(x, y, a, length, steps, bend=0.0, curl=0.0, pw=2, kink=0.0, at=2.0):
    """A spine from (x, y) leaving at angle `a`: `steps` equal steps whose heading
    at parameter s is a + bend·s + curl·s^pw, plus `kink` once s passes `at`."""
    pts = [(x, y)]
    step = length / steps
    for i in range(steps):
        s = (i + 0.5) / steps
        h = a + bend * s + curl * s ** pw + (kink if s > at else 0.0)
        x += step * math.cos(h)
        y += step * math.sin(h)
        pts.append((x, y))
    return pts


def point_at(pts, t):
    """The point and heading at arc parameter `t` along a polyline."""
    s = arc_params(pts)
    k = 0
    while k < len(pts) - 2 and s[k + 1] < t:
        k += 1
    span = s[k + 1] - s[k]
    f = clip((t - s[k]) / span, 0.0, 1.0) if span > 0 else 0.0
    dx = pts[k + 1][0] - pts[k][0]
    dy = pts[k + 1][1] - pts[k][1]
    return pts[k][0] + f * dx, pts[k][1] + f * dy, math.atan2(dy, dx)


def fit_scale(pts, wf, lo, hi, free=False):
    """The largest scale ≤ 1 about the spine's first point that keeps every point,
    widened by its half-width, inside [lo, hi]²; `free` lifts the bottom bound for
    things rooted in the bottom gutter."""
    s = arc_params(pts)
    bx, by = pts[0]
    lam = 1.0
    for i in range(len(pts)):
        w = float(wf(s[i]))
        ox = pts[i][0] - bx
        oy = pts[i][1] - by
        if ox + w > 0:
            lam = min(lam, (hi - bx) / (ox + w))
        if ox - w < 0:
            lam = min(lam, (lo - bx) / (ox - w))
        if oy + w > 0 and not free:
            lam = min(lam, (hi - by) / (oy + w))
        if oy - w < 0:
            lam = min(lam, (lo - by) / (oy - w))
    return max(lam, 0.1)


def scaled(pts, lam):
    bx, by = pts[0]
    return [(bx + lam * (x - bx), by + lam * (y - by)) for x, y in pts]


def fitted(cv, pts, wf, margin, free=False):
    """Fit a ribbon into the cell's inner box (less `margin`): its spine and width, both scaled."""
    lam = fit_scale(pts, wf, cv.lo + margin, cv.hi - margin, free)
    return scaled(pts, lam), (lambda s: lam * wf(s)), lam


def shuffle(r, items):
    for i in range(len(items) - 1, 0, -1):
        j = r.integers(0, i + 1)
        items[i], items[j] = items[j], items[i]
    return items


# ------------------------------------------------------------ primitives


def _box(cv, x0, x1, y0, y1, pad):
    n = cv.n
    i0 = max(0, math.floor((x0 - pad) * n))
    i1 = min(n, math.ceil((x1 + pad) * n))
    j0 = max(0, math.floor((y0 - pad) * n))
    j1 = min(n, math.ceil((y1 + pad) * n))
    return i0, i1, j0, j1


def _composite(cv, sl, e, colour_args, colour, halo, reach):
    """A contact shadow under the rim, then the shape over what is there (premultiplied)."""
    if halo > 0 and reach > 0:
        h = 1 - halo * (1 - ss(0.0, reach, e))
        cv.r[sl] = cv.r[sl] * h
        cv.g[sl] = cv.g[sl] * h
        cv.b[sl] = cv.b[sl] * h
    m = np.clip(0.5 - e * cv.n, 0.0, 1.0)
    cr, cg, cb = colour(*colour_args)
    cv.r[sl] = cv.r[sl] * (1 - m) + cr * m
    cv.g[sl] = cv.g[sl] * (1 - m) + cg * m
    cv.b[sl] = cv.b[sl] * (1 - m) + cb * m
    cv.a[sl] = cv.a[sl] * (1 - m) + m


def ribbon(cv, pts, wf, colour, halo=0.0, reach=0.0):
    """Paint a ribbon: every pixel near the spine finds its nearest segment, giving
    s (0..1 along), v (signed distance across, + on the right of the direction of
    travel) and the half-width w(s); the edge distance |v| − w is the SDF. Before
    the ribbon goes on, whatever lies under its rim darkens by `halo` over `reach`.
    colour(s, v, w, x, y, grain) → (r, g, b), linear."""
    n = cv.n
    s = arc_params(pts)
    wmax = max(float(wf(i / 32)) for i in range(33))
    pad = wmax + reach + 2 / n
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    i0, i1, j0, j1 = _box(cv, min(xs), max(xs), min(ys), max(ys), pad)
    if i1 <= i0 or j1 <= j0:
        return
    X = ((np.arange(i0, i1) + 0.5) / n)[None, :]
    Y = ((np.arange(j0, j1) + 0.5) / n)[:, None]
    best = np.full((j1 - j0, i1 - i0), np.inf)
    S = np.zeros((j1 - j0, i1 - i0))
    V = np.zeros((j1 - j0, i1 - i0))
    for k in range(len(pts) - 1):
        ax, ay = pts[k]
        dx = pts[k + 1][0] - ax
        dy = pts[k + 1][1] - ay
        ll = dx * dx + dy * dy
        if ll <= 0:
            continue
        t = np.clip(((X - ax) * dx + (Y - ay) * dy) / ll, 0.0, 1.0)
        qx = X - ax - t * dx
        qy = Y - ay - t * dy
        d = np.sqrt(qx * qx + qy * qy)
        near = d < best
        best = np.where(near, d, best)
        S = np.where(near, s[k] + t * (s[k + 1] - s[k]), S)
        V = np.where(near, np.where(dx * qy - dy * qx < 0, -d, d), V)
    W = wf(S)
    sl = (slice(j0, j1), slice(i0, i1))
    _composite(cv, sl, best - W, (S, V, W, X, Y, cv.grain[sl]), colour, halo, reach)


def blob(cv, cx, cy, rf, colour, halo=0.0, reach=0.0):
    """Paint a blob: radius rf(θ) around (cx, cy). colour(d, θ, rf(θ), x, y, grain) → (r, g, b)."""
    n = cv.n
    rmax = max(float(rf(TAU * i / 64 - PI)) for i in range(64))
    pad = rmax * 1.05 + reach + 2 / n
    i0, i1, j0, j1 = _box(cv, cx, cx, cy, cy, pad)
    if i1 <= i0 or j1 <= j0:
        return
    X = ((np.arange(i0, i1) + 0.5) / n)[None, :]
    Y = ((np.arange(j0, j1) + 0.5) / n)[:, None]
    dx = X - cx
    dy = Y - cy
    d = np.sqrt(dx * dx + dy * dy)
    ang = np.arctan2(dy, dx)
    rad = rf(ang)
    sl = (slice(j0, j1), slice(i0, i1))
    _composite(cv, sl, d - rad, (d, ang, rad, X, Y, cv.grain[sl]), colour, halo, reach)


# ---------------------------------------------------------------- shapes


def leaf_width(W, p, k, tip=0.0, teeth=0, depth=0.0, lobes=0, lobe=0.0, waves=0, wave=0.0):
    """A leaf's half-width along its midrib: W·sin(π·s^p)^k, the tip drawn out by
    `tip`, with optional saw teeth, lobes and a wavy margin."""
    def wf(s):
        q = np.clip(s, 0.0, 1.0)
        w = W * np.maximum(np.sin(PI * q ** p), 0.0) ** k * (1 - tip * ss(0.55, 1.0, q))
        if teeth > 0:
            w = w * (1 - depth * (q * teeth - np.floor(q * teeth)))
        if lobes > 0:
            w = w * (1 - lobe + lobe * np.abs(np.cos(PI * q * lobes)))
        if waves > 0:
            w = w * (1 + wave * np.sin(PI * q * waves))
        return w
    return wf


def blade_width(W, q):
    """A blade: W at the base, tapering to a point."""
    return lambda s: W * (1 - np.clip(s, 0.0, 1.0)) ** q


def stem_width(W, taper):
    """A stem: W at the base, (1 − taper)·W at the end."""
    return lambda s: W * (1 - taper * np.clip(s, 0.0, 1.0))


def tendril_width(W, twist, phase):
    """A twisting ribbon: narrowing to the tip, its width beating as it turns."""
    def wf(s):
        q = np.clip(s, 0.0, 1.0)
        return W * (1 - 0.8 * q) * (0.5 + 0.5 * np.abs(np.cos(PI * twist * q + phase)))
    return wf


# --------------------------------------------------------------- colours


def tint(base, value, hue):
    return (base[0] * (1 + value) * (1 + 0.05 * hue), base[1] * (1 + value), base[2] * (1 + value) * (1 - 0.05 * hue))


def lit_side(a):
    """Which half of a leaf leaving at angle `a` faces the light (from the top-left)."""
    return 1 if -math.sin(a) * -0.6 + math.cos(a) * -0.8 > 0 else -1


def leaf_colour(st, col, light, length, px, ao=None):
    """A leaf: a value gradient from base to tip, a lit and a shaded half, a darker
    rim, pinnate veins sweeping toward the tip, a gloss band on the lit half, a
    paler midrib, grain, and an optional darkening toward a cluster's heart."""
    lw = 0.5 * px * st['veins'] / length  # a 0.5 px vein, in vein-phase units

    def colour(s, v, w, x, y, grain):
        ww = np.maximum(w, 1e-6)
        t = np.abs(v) / ww
        k = st['grad'][0] + (st['grad'][1] - st['grad'][0]) * s
        k = k * (1 + st['side'] * np.clip(v * light / (0.3 * ww), -1.0, 1.0))
        k = k * (1 - st['rim'] * ss(0.72, 1.0, t))
        phi = (s - st['sweep'] * t ** 1.3) * st['veins']
        dphi = np.abs(phi - np.floor(phi + 0.5))
        vl = ((1 - ss(0.5 * lw, 1.5 * lw, dphi)) * ss(0.06, 0.2, t) * (1 - ss(0.75, 0.95, t))
              * ss(0.03, 0.12, s) * (1 - ss(0.85, 0.97, s)))
        k = k * (1 + st['vein'] * vl)
        hl = np.exp(-(((t - 0.42) / 0.2) ** 2)) * ss(0.08, 0.35, s) * (1 - ss(0.7, 0.95, s)) * (v * light > 0)
        k = k * (1 + st['gloss'] * hl)
        if ao is not None:
            ox = x - ao[0]
            oy = y - ao[1]
            k = k * (ao[4] + (1 - ao[4]) * ss(ao[2], ao[3], np.sqrt(ox * ox + oy * oy)))
        k = k * (0.9 + 0.2 * grain)
        mw = st['ribw'] * (1 - 0.75 * s)
        mr = (1 - ss(0.6 * mw, 1.4 * mw, np.abs(v))) * (1 - ss(0.8, 1.0, s))
        out = []
        for c in range(3):
            base = col[c] * k
            out.append(base + (base * st['rib'] - base) * mr)
        return out
    return colour


def blade_colour(col, tip_col, light, side, root, px):
    """A blade or stem: dark at the root, a lit and a shaded half, toward `tip_col` at the end."""
    def colour(s, v, w, x, y, grain):
        ww = np.maximum(w, 0.35 * px)
        k = root + (1 - root) * ss(0.0, 0.45, s)
        k = k * (1 + side * np.clip(v * light / (0.5 * ww), -1.0, 1.0))
        k = k * (0.9 + 0.2 * grain)
        f = ss(0.35, 1.0, s)
        return [(col[c] + (tip_col[c] - col[c]) * f) * k for c in range(3)]
    return colour


def flat_colour(col, k0, k1):
    """Flat colour with grain: twigs, rachises, petioles."""
    def colour(s, v, w, x, y, grain):
        k = (k0 + (k1 - k0) * s) * (0.9 + 0.2 * grain)
        return [col[c] * k for c in range(3)]
    return colour


JUNGLE = {'base': lin('#4d6744'), 'rib': 1.75, 'ribw': 0.011, 'vein': -0.2, 'veins': 9, 'sweep': 0.18, 'side': 0.18,
          'rim': 0.3, 'gloss': 0.6, 'grad': (0.7, 1.05)}
TEMPERATE = {'base': lin('#6e8557'), 'rib': 1.45, 'ribw': 0.006, 'vein': 0.16, 'veins': 7, 'sweep': 0.15, 'side': 0.13,
             'rim': 0.22, 'gloss': 0.12, 'grad': (0.78, 1.06)}
TEMPERATE_B = dict(TEMPERATE, base=lin('#77895a'), veins=6, sweep=0.12)
FERN = {'base': lin('#62784f'), 'rib': 1.3, 'ribw': 0.004, 'vein': 0.12, 'veins': 6, 'sweep': 0.1, 'side': 0.12,
        'rim': 0.18, 'gloss': 0.0, 'grad': (0.85, 1.08)}
FERN_B = dict(FERN, base=lin('#596f4f'))
FROST = {'base': lin('#a3b3ae'), 'rib': 1.25, 'ribw': 0.004, 'vein': 0.1, 'veins': 5, 'sweep': 0.1, 'side': 0.1,
         'rim': -0.35, 'gloss': 0.0, 'grad': (0.88, 1.25)}
ASH = {'base': lin('#4f4945'), 'rib': 1.35, 'ribw': 0.004, 'vein': 0.0, 'veins': 4, 'sweep': 0.1, 'side': 0.12,
       'rim': 0.2, 'gloss': 0.0, 'grad': (0.8, 1.6)}
ROSETTE = {'base': lin('#5b7350'), 'rib': 1.8, 'ribw': 0.009, 'vein': 0.22, 'veins': 8, 'sweep': 0.2, 'side': 0.14,
           'rim': 0.2, 'gloss': 0.18, 'grad': (0.75, 1.05)}

TWIG = lin('#5a5040')
STALK = lin('#5f6a45')
GRASS = lin('#6a8250')
GRASS_TIP = lin('#9aa86c')
DRY = lin('#968a66')
DRY_TIP = lin('#bdb08a')
SEED = lin('#8a7754')
PETALS = (lin('#e6e2d2'), lin('#dccb8e'), lin('#cbbcd2'))
EYE = lin('#9a7a40')
HIVE = lin('#7c6f7a')
HIVE_TIP = lin('#a89aa2')
MOSS = lin('#5d6e45')
MOSS_DEEP = lin('#38432b')
MOSS_TIP = lin('#8d9c60')
CAPSULE = lin('#8e7650')
BARK_DARK = lin('#3b332c')
BARK_LIGHT = lin('#6f665a')
KNOT = lin('#5a4c3f')


# -------------------------------------------------------------- painters


def leaf(cv, x, y, a, length, shape, bend, st, value, hue, ao, margin):
    """A leaf from (x, y) at angle a, fitted into the cell, with its colour and a contact shadow."""
    wf = leaf_width(*shape)
    pts, wf2, lam = fitted(cv, path(x, y, a, length, 14, bend), wf, margin)
    ribbon(cv, pts, wf2, leaf_colour(st, tint(st['base'], value, hue), lit_side(a), length * lam, cv.px, ao),
           0.35, 3 * cv.px)


def jungle_leaf_a(cv, r):
    """0 — jungle broad-leaf cluster A: an umbrella of six or seven broad, glossy leaves on stalks."""
    cx = 0.5 + r.uniform(-0.03, 0.03)
    cy = 0.5 + r.uniform(-0.03, 0.03)
    count = r.integers(6, 8)
    a0 = r.uniform(0, TAU)
    leaves = []
    for i in range(count):
        a = a0 + TAU * i / count + r.uniform(-0.2, 0.2)
        stalk = r.uniform(0.03, 0.07)
        length = r.uniform(0.4, 0.5)
        width = length * r.uniform(0.34, 0.42)
        bend = r.uniform(-0.25, 0.25)
        value = r.uniform(-0.1, 0.1)
        hue = r.uniform(-1, 1)
        leaves.append((a, stalk, length, width, bend, value, hue))
    shuffle(r, leaves)
    for a, stalk, *_ in leaves:
        ribbon(cv, [(cx, cy), (cx + stalk * math.cos(a), cy + stalk * math.sin(a))], stem_width(0.007, 0.3),
               flat_colour(STALK, 0.7, 1), 0.3, 2 * cv.px)
    for a, stalk, length, width, bend, value, hue in leaves:
        bx = cx + stalk * math.cos(a)
        by = cy + stalk * math.sin(a)
        leaf(cv, bx, by, a, length, (width, 0.72, 0.75, 0.45), bend, JUNGLE, value, hue, (cx, cy, 0, 0.32, 0.6),
             1.5 * cv.px)

    def node(d, ang, rad, x, y, grain):
        k = (0.55 + 0.35 * (1 - d / rad)) * (0.9 + 0.2 * grain)
        return [STALK[c] * k for c in range(3)]
    blob(cv, cx, cy, lambda ang: 0.016, node, 0.3, 2 * cv.px)


def jungle_leaf_b(cv, r):
    """1 — jungle broad-leaf cluster B: a twig across the cell with broad leaves alternating along it."""
    sx = r.uniform(0.16, 0.24)
    sy = r.uniform(0.76, 0.84)
    a = -PI / 4 + r.uniform(-0.15, 0.15)
    bend = r.uniform(-0.35, 0.35)
    twig = path(sx, sy, a, 0.72, 16, bend)
    leaves = []
    for i in range(7):
        k = 2 + 2 * i
        side = 1 if i % 2 == 0 else -1
        heading = a + bend * (k / 16)
        la = heading + side * r.uniform(0.75, 1.05)
        length = r.uniform(0.33, 0.42) * (1 - 0.2 * (k / 16))
        width = length * r.uniform(0.38, 0.45)
        lb = r.uniform(-0.3, 0.3)
        value = r.uniform(-0.1, 0.1)
        hue = r.uniform(-1, 1)
        leaves.append((twig[k][0], twig[k][1], la, length, width, lb, value, hue))
    end = twig[16]
    leaves.append((end[0], end[1], a + bend, r.uniform(0.26, 0.3), 0.12, r.uniform(-0.2, 0.2), r.uniform(-0.1, 0.1),
                   r.uniform(-1, 1)))
    ribbon(cv, twig, stem_width(0.009, 0.5), flat_colour(TWIG, 0.75, 1), 0.3, 2 * cv.px)
    for x, y, la, length, width, lb, value, hue in leaves:
        leaf(cv, x, y, la, length, (width, 0.72, 0.75, 0.45), lb, JUNGLE, value, hue, None, 1.5 * cv.px)


def reach_to(cx, cy, a, lo, hi):
    """How far from (cx, cy) along angle a before leaving the box [lo, hi]²."""
    c = math.cos(a)
    s = math.sin(a)
    t = 10.0
    if c > 1e-9:
        t = min(t, (hi - cx) / c)
    if c < -1e-9:
        t = min(t, (lo - cx) / c)
    if s > 1e-9:
        t = min(t, (hi - cy) / s)
    if s < -1e-9:
        t = min(t, (lo - cy) / s)
    return t


def sprays(cv, r, cx, cy, twigs, reach, leaf_len, shape, st, per):
    """Twigs radiating from (cx, cy), each reaching `reach` of the way to the edge of
    the cell (so the ones toward the corners run longer and the cluster fills the
    square), with leaves alternating along it and one at its end."""
    a0 = r.uniform(0, TAU)
    leaves = []
    stems = []
    for i in range(twigs):
        a = a0 + TAU * i / twigs + r.uniform(-0.2, 0.2)
        length = reach_to(cx, cy, a, cv.lo, cv.hi) * r.uniform(reach[0], reach[1])
        bend = r.uniform(-0.4, 0.4)
        twig = path(cx, cy, a, length, 16, bend)
        stems.append(twig)
        for j in range(per):
            k = 3 + math.floor(13 * j / per)
            side = 1 if (i + j) % 2 == 0 else -1
            heading = a + bend * (k / 16)
            la = heading + side * r.uniform(0.6, 1.0)
            ln = r.uniform(leaf_len[0], leaf_len[1])
            lb = r.uniform(-0.3, 0.3)
            leaves.append((twig[k][0], twig[k][1], la, ln, lb, r.uniform(-0.1, 0.1), r.uniform(-1, 1)))
        end = twig[16]
        leaves.append((end[0], end[1], a + bend, r.uniform(leaf_len[0], leaf_len[1]), r.uniform(-0.2, 0.2),
                       r.uniform(-0.1, 0.1), r.uniform(-1, 1)))
    for twig in stems:
        ribbon(cv, twig, stem_width(0.006, 0.5), flat_colour(TWIG, 0.75, 1), 0.3, 2 * cv.px)
    shuffle(r, leaves)
    for x, y, la, ln, lb, value, hue in leaves:
        leaf(cv, x, y, la, ln, (ln * shape[0],) + tuple(shape[1:]), lb, st, value, hue, (cx, cy, 0, 0.3, 0.7),
             1.5 * cv.px)


def temperate_leaf_a(cv, r):
    """2 — temperate leaf cluster A: six leafy twigs radiating from the middle; small, pointed, serrate leaves."""
    cx = 0.5 + r.uniform(-0.03, 0.03)
    cy = 0.5 + r.uniform(-0.03, 0.03)
    sprays(cv, r, cx, cy, 6, (0.6, 0.72), (0.12, 0.16), (0.4, 0.85, 0.95, 0.3, 9, 0.08), TEMPERATE, 5)


def temperate_leaf_b(cv, r):
    """3 — temperate leaf cluster B: seven twigs, rounder leaves, a denser and paler crown."""
    cx = 0.5 + r.uniform(-0.04, 0.04)
    cy = 0.5 + r.uniform(-0.04, 0.04)
    sprays(cv, r, cx, cy, 7, (0.55, 0.68), (0.11, 0.14), (0.52, 0.8, 0.65, 0.1, 7, 0.06), TEMPERATE_B, 4)


def frond(cv, r, f):
    """A frond: a rachis from the bottom gutter to the top of the cell, pinnae in
    (sub)opposite pairs along it — short at the base, longest a third of the way
    up, tapering to the tip — then the rachis drawn over their bases."""
    bx = 0.5 + r.uniform(-0.03, 0.03)
    by = 1 - 0.5 * cv.lo
    lean = r.uniform(-0.06, 0.06)
    bend = f['bend'] * (-1 if r.random() < 0.5 else 1) * r.uniform(0.7, 1)
    length = (by - cv.lo - 2 * cv.px) * 1.02
    kink = f['kink'] * (-1 if r.random() < 0.5 else 1)
    raw = path(bx, by, UP + lean, length, 24, bend, 0.0, 2, kink, 0.5)
    spine, rw, _ = fitted(cv, raw, stem_width(f['rachis'], 0.75), 1.5 * cv.px, True)
    pinnae = []
    for i in range(f['pairs']):
        t = f['start'] + (1 - f['start']) * (i + 0.5) / f['pairs']
        env = max(math.sin(PI * clip((t + 0.12) / 1.1, 0.0, 1.0)), 0.0) ** 0.9
        for side in (-1, 1):
            st = clip(t + side * f['offset'], 0.0, 0.98)
            skip = r.random() < f['skip']
            angle = (f['angle'][0] + (f['angle'][1] - f['angle'][0]) * st) * r.uniform(0.92, 1.08)
            length = f['reach'] * env * r.uniform(0.82, 1)
            value = r.uniform(-0.1, 0.1)
            hue = r.uniform(-1, 1)
            if not skip:
                pinnae.append((st, side, angle, length, value, hue))
    for st, side, angle, length, value, hue in pinnae:
        x, y, heading = point_at(spine, st)
        a = heading + side * angle
        shape = (length * f['shape'][0],) + tuple(f['shape'][1:])
        leaf(cv, x, y, a, length, shape, -side * f['curve'], f['style'], value, hue, None, 1.5 * cv.px)
    ribbon(cv, spine, rw, flat_colour(f['stem'], 0.7, 1.1), 0.25, 2 * cv.px)


def fern_frond_a(cv, r):
    """4 — fern frond A: broad, lanceolate, lobed pinnae curving toward the tip."""
    frond(cv, r, {'pairs': 14, 'start': 0.07, 'offset': 0.008, 'reach': 0.44, 'angle': (1.3, 0.8), 'curve': 0.3,
                  'bend': 0.22, 'kink': 0.0, 'skip': 0.0, 'shape': (0.14, 0.8, 0.85, 0.35, 0, 0, 7, 0.25),
                  'style': FERN, 'stem': lin('#56603f'), 'rachis': 0.009})


def fern_frond_b(cv, r):
    """5 — fern frond B: narrower and longer-lobed, subopposite pinnae, the tip nodding to one side."""
    frond(cv, r, {'pairs': 17, 'start': 0.06, 'offset': 0.025, 'reach': 0.38, 'angle': (1.15, 0.75), 'curve': 0.45,
                  'bend': 0.4, 'kink': 0.0, 'skip': 0.0, 'shape': (0.12, 0.8, 0.95, 0.4, 0, 0, 9, 0.3),
                  'style': FERN_B, 'stem': lin('#535c40'), 'rachis': 0.008})


def frost_fern(cv, r):
    """10 — frost fern (Vetra): straight, pale and crisp; narrow saw-toothed pinnae with bright rims and white tips."""
    frond(cv, r, {'pairs': 12, 'start': 0.08, 'offset': 0.0, 'reach': 0.42, 'angle': (1.05, 0.8), 'curve': 0.05,
                  'bend': 0.06, 'kink': 0.0, 'skip': 0.0, 'shape': (0.13, 0.75, 1.3, 0, 6, 0.35, 0, 0),
                  'style': FROST, 'stem': lin('#8c9a98'), 'rachis': 0.008})


def ash_frond(cv, r):
    """11 — ash frond (Ferrum): a crooked dark rachis, few drooping ragged pinnae, ash-pale tips."""
    frond(cv, r, {'pairs': 9, 'start': 0.12, 'offset': 0.03, 'reach': 0.4, 'angle': (1.45, 1.05), 'curve': -0.35,
                  'bend': 0.12, 'kink': 0.35, 'skip': 0.3, 'shape': (0.13, 0.8, 0.9, 0.2, 5, 0.18, 0, 0),
                  'style': ASH, 'stem': lin('#3e3835'), 'rachis': 0.01})


def tuft(cv, r, g):
    """A tuft: blades rooted in the bottom gutter, fanning out and drooping. `kinks`
    is the chance a blade has snapped and flops over."""
    blades = []
    for _ in range(g['count']):
        bx = r.uniform(g['x'][0], g['x'][1])
        height = r.uniform(g['h'][0], g['h'][1]) * (cv.hi - cv.lo)
        lean = (bx - 0.5) * g['fan'] + r.uniform(-g['jitter'], g['jitter'])
        droop = g['droop'] * r.uniform(0.3, 1) * (-1 if lean < 0 else 1)
        width = r.uniform(g['w'][0], g['w'][1])
        value = r.uniform(-0.12, 0.12)
        hue = r.uniform(-1, 1)
        kink, at = 0.0, 2.0
        if r.random() < g['kinks']:
            kink = (-1 if lean < 0 else 1) * r.uniform(0.6, 1.3)
            at = r.uniform(0.45, 0.8)
        blades.append((bx, height, lean, droop, width, value, hue, kink, at))
    shuffle(r, blades)
    for bx, height, lean, droop, width, value, hue, kink, at in blades:
        raw = path(bx, 1 - 0.5 * cv.lo, UP + lean, height, 12, 0.0, droop, 2, kink, at)
        pts, wf, _ = fitted(cv, raw, blade_width(width, 0.6), 1.5 * cv.px, True)
        colour = blade_colour(tint(g['col'], value, hue), tint(g['tip'], value, hue), lit_side(UP + lean), 0.12,
                              g['root'], cv.px)
        ribbon(cv, pts, wf, colour, 0.25, 2 * cv.px)


def lush_grass_a(cv, r):
    """6 — lush grass A: a full tuft fanning from the middle."""
    tuft(cv, r, {'count': 36, 'x': (0.24, 0.76), 'h': (0.5, 0.95), 'fan': 1.6, 'jitter': 0.18, 'droop': 0.9,
                 'w': (0.011, 0.017), 'kinks': 0.0, 'col': GRASS, 'tip': GRASS_TIP, 'root': 0.45})


def lush_grass_b(cv, r):
    """7 — lush grass B: a wider, shorter, more upright strip of finer blades."""
    tuft(cv, r, {'count': 60, 'x': (0.07, 0.93), 'h': (0.32, 0.72), 'fan': 0.7, 'jitter': 0.16, 'droop': 0.5,
                 'w': (0.008, 0.012), 'kinks': 0.0, 'col': GRASS, 'tip': GRASS_TIP, 'root': 0.5})


def stalks(cv, r, count, x, h, width, col, head):
    """Thin stems from the bottom gutter, each ending in a head painted by head(x, y, angle, i)."""
    made = []
    for _ in range(count):
        bx = r.uniform(x[0], x[1])
        height = r.uniform(h[0], h[1]) * (cv.hi - cv.lo)
        lean = (bx - 0.5) * 0.8 + r.uniform(-0.12, 0.12)
        droop = r.uniform(-0.25, 0.25)
        made.append((bx, height, lean, droop))
    for i, (bx, height, lean, droop) in enumerate(made):
        raw = path(bx, 1 - 0.5 * cv.lo, UP + lean, height, 10, 0.0, droop, 2)
        pts, wf, _ = fitted(cv, raw, stem_width(width, 0.3), 8 * cv.px, True)
        ribbon(cv, pts, wf, flat_colour(col, 0.6, 1), 0.2, 2 * cv.px)
        tip, prev = pts[-1], pts[-2]
        head(tip[0], tip[1], math.atan2(tip[1] - prev[1], tip[0] - prev[0]), i)


def dry_grass(cv, r):
    """8 — dry grass: thin straw blades, some snapped and flopping, and a few seed heads."""
    tuft(cv, r, {'count': 30, 'x': (0.15, 0.85), 'h': (0.5, 0.95), 'fan': 1.2, 'jitter': 0.2, 'droop': 0.6,
                 'w': (0.006, 0.01), 'kinks': 0.3, 'col': DRY, 'tip': DRY_TIP, 'root': 0.5})
    heads = [(r.uniform(0.1, 0.16), r.uniform(-0.3, 0.3), r.uniform(-0.1, 0.1)) for _ in range(5)]
    style = dict(ASH, base=SEED, rim=0.15, grad=(0.85, 1.15))

    def head(x, y, a, i):
        length, bend, value = heads[i]
        leaf(cv, x, y, a, length, (0.013, 0.6, 0.7, 0), bend, style, value, 0, None, 1.5 * cv.px)
    stalks(cv, r, 5, (0.3, 0.7), (0.72, 0.9), 0.004, DRY, head)


def meadow_flowers(cv, r):
    """9 — meadow flowers in grass: short blades, and seven stems ending in round petalled heads."""
    flowers = [(r.uniform(0.04, 0.055), r.integers(5, 9), r.uniform(0, TAU), r.integers(0, 3), r.uniform(-0.08, 0.08))
               for _ in range(7)]

    def head(x, y, a, i):
        rad, petals, phase, kind, value = flowers[i]
        petal = tint(PETALS[kind], value, 0)

        def colour(d, ang, rr, px, py, grain):
            u = d / rad
            eye = 1 - ss(0.26, 0.36, u)
            k = (0.82 + 0.25 * ss(0.3, 0.9, u)) * (0.92 + 0.16 * grain)
            return [(petal[c] + (EYE[c] - petal[c]) * eye) * k for c in range(3)]
        blob(cv, x, y, lambda ang: rad * (0.68 + 0.32 * np.abs(np.cos(petals * ang / 2 + phase)) ** 0.7), colour,
             0.3, 2 * cv.px)
    stalks(cv, r, 7, (0.14, 0.86), (0.45, 0.85), 0.005, lin('#5d7046'), head)
    tuft(cv, r, {'count': 36, 'x': (0.08, 0.92), 'h': (0.22, 0.58), 'fan': 1.0, 'jitter': 0.2, 'droop': 0.7,
                 'w': (0.009, 0.014), 'kinks': 0.0, 'col': GRASS, 'tip': GRASS_TIP, 'root': 0.5})


def hive_tendril(cv, r):
    """12 — hive tendril: five twisting ribbons rising from the root and curling at their tips; ribbed."""
    tendrils = []
    for i in range(5):
        bx = 0.3 + 0.4 * i / 4 + r.uniform(-0.04, 0.04)
        lean = (bx - 0.5) * 1.4 + r.uniform(-0.15, 0.15)
        length = r.uniform(0.85, 1.15)
        sign = -1 if r.random() < 0.5 else 1
        curl = sign * r.uniform(4, 6)
        bend = -sign * r.uniform(0.2, 0.6)
        width = r.uniform(0.032, 0.042)
        twist = r.uniform(1.5, 3)
        phase = r.uniform(0, PI)
        value = r.uniform(-0.1, 0.1)
        tendrils.append((bx, lean, length, curl, bend, width, twist, phase, value))
    shuffle(r, tendrils)
    for bx, lean, length, curl, bend, width, twist, phase, value in tendrils:
        raw = path(bx, 1 - 0.5 * cv.lo, UP + lean, length, 48, bend, curl, 3)
        pts, wf, lam = fitted(cv, raw, tendril_width(width, twist, phase), 1.5 * cv.px, True)
        col = tint(HIVE, value, 0)
        tip = tint(HIVE_TIP, value, 0)
        rings = length * lam / 0.018

        def colour(s, v, w, x, y, grain, col=col, tip=tip, rings=rings):
            t = np.abs(v) / np.maximum(w, 1e-6)
            rib = 0.5 + 0.5 * np.cos(TAU * s * rings)
            k = (0.5 + 0.5 * ss(0.0, 0.3, s)) * (0.82 + 0.22 * rib)
            k = k * (1 + 0.25 * ss(0.6, 1.0, t) - 0.18 * (v < 0))
            k = k * (0.9 + 0.2 * grain)
            f = ss(0.4, 1.0, s)
            return [(col[c] + (tip[c] - col[c]) * f) * k for c in range(3)]
        ribbon(cv, pts, wf, colour, 0.35, 3 * cv.px)


def moss_clump(cv, r):
    """13 — moss clump: a dense low mound of short strands, with a few spore stalks above it."""
    cx = 0.5 + r.uniform(-0.02, 0.02)
    cy = 1 - cv.lo
    ra = r.uniform(0.4, 0.44)
    rb = r.uniform(0.36, 0.42)
    bumps = (r.uniform(0, TAU), r.uniform(0, TAU), r.uniform(0, TAU))

    def dome(ang):
        c = np.cos(ang) / ra
        s = np.sin(ang) / rb
        rr = 1 / np.sqrt(c * c + s * s)
        return rr * (1 + 0.06 * np.sin(5 * ang + bumps[0]) + 0.04 * np.sin(9 * ang + bumps[1])
                     + 0.025 * np.sin(17 * ang + bumps[2]))

    def deep(d, ang, rad, x, y, grain):
        k = (0.6 + 0.4 * ss(0.2, 1.0, d / rad)) * (0.85 + 0.3 * grain)
        return [MOSS_DEEP[c] * k for c in range(3)]
    blob(cv, cx, cy, lambda ang: 0.92 * dome(ang), deep)
    strands = []
    for _ in range(900):
        ang = -PI + PI * r.random()
        depth = math.sqrt(r.random())
        length = r.uniform(0.018, 0.034)
        width = r.uniform(0.003, 0.0048)
        wobble = r.uniform(-0.5, 0.5)
        value = r.uniform(-0.12, 0.12)
        hue = r.uniform(-1, 1)
        strands.append((ang, depth, length, width, wobble, value, hue))
    strands.sort(key=lambda p: p[1])
    for ang, depth, length, width, wobble, value, hue in strands:
        rad = float(dome(ang)) * depth * 0.95
        x = cx + rad * math.cos(ang)
        y = cy + rad * math.sin(ang)
        a = ang + wobble
        pts, wf, _ = fitted(cv, path(x, y, a, length, 4, wobble * 0.5), blade_width(width, 0.5), 1.5 * cv.px, True)
        col = tint(MOSS, value, hue)
        tip = tint(MOSS_TIP, value, hue)
        shade = 0.55 + 0.45 * depth
        ribbon(cv, pts, wf, blade_colour(col, tip, lit_side(a), 0.1, shade, cv.px), 0.2, 1.5 * cv.px)
    style = dict(ASH, base=CAPSULE, rim=0.2, grad=(0.9, 1.15))
    for _ in range(9):
        ang = -PI + PI * r.uniform(0.15, 0.85)
        x = cx + float(dome(ang)) * 0.8 * math.cos(ang)
        y = cy + float(dome(ang)) * 0.8 * math.sin(ang)
        a = UP + r.uniform(-0.35, 0.35)
        length = r.uniform(0.1, 0.18)
        pts, wf, _ = fitted(cv, path(x, y, a, length, 6, r.uniform(-0.4, 0.4)), stem_width(0.0028, 0.2), 6 * cv.px)
        ribbon(cv, pts, wf, flat_colour(lin('#7a6a48'), 0.8, 1.1), 0.0, 0.0)
        end, prev = pts[-1], pts[-2]
        ca = math.atan2(end[1] - prev[1], end[0] - prev[0]) + r.uniform(-0.5, 0.5)
        leaf(cv, end[0], end[1], ca, 0.03, (0.008, 0.6, 0.6, 0), 0.0, style, r.uniform(-0.1, 0.1), 0, None,
             1.5 * cv.px)


def ground_plant(cv, r):
    """14 — broad-leaf ground plant: a rosette seen from above, an outer whorl under a younger inner one."""
    cx = 0.5 + r.uniform(-0.02, 0.02)
    cy = 0.5 + r.uniform(-0.02, 0.02)
    a0 = r.uniform(0, TAU)
    leaves = []
    for count, reach, wr, offset in ((6, 0.44, 0.44, 0.0), (5, 0.3, 0.46, 0.5)):
        for i in range(count):
            a = a0 + TAU * (i + offset) / count + r.uniform(-0.15, 0.15)
            length = reach * r.uniform(0.92, 1.05)
            bend = r.uniform(-0.2, 0.2)
            value = r.uniform(-0.08, 0.08) + (0.08 if offset > 0 else 0.0)
            hue = r.uniform(-1, 1)
            leaves.append((a, length, length * wr, bend, value, hue))
    for a, length, width, bend, value, hue in leaves:
        leaf(cv, cx, cy, a, length, (width, 1.25, 0.6, 0, 0, 0, 0, 0, 6, 0.04), bend, ROSETTE, value, hue,
             (cx, cy, 0, 0.28, 0.55), 1.5 * cv.px)

    def heart(d, ang, rad, x, y, grain):
        k = (0.75 + 0.3 * (1 - d / rad)) * (0.9 + 0.2 * grain)
        return [ROSETTE['base'][c] * 1.2 * k for c in range(3)]
    blob(cv, cx, cy, lambda ang: 0.022, heart, 0.3, 2 * cv.px)


def vnoise_at(u, v, cx, cy, seed):
    """Periodic value noise at tile coordinates (u, v), period 1 both ways, cx × cy lattice cells."""
    tx = u * cx
    ty = v * cy
    x0 = np.floor(tx)
    y0 = np.floor(ty)
    fx = tx - x0
    fy = ty - y0
    fx = fx * fx * fx * (fx * (fx * 6 - 15) + 10)
    fy = fy * fy * fy * (fy * (fy * 6 - 15) + 10)
    ix0 = x0.astype(np.int64) % cx
    iy0 = y0.astype(np.int64) % cy
    ix1 = (ix0 + 1) % cx
    iy1 = (iy0 + 1) % cy
    a = T.lattice(ix0, iy0, seed)
    b = T.lattice(ix1, iy0, seed)
    c = T.lattice(ix0, iy1, seed)
    d = T.lattice(ix1, iy1, seed)
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy


def bark(cv, r):
    """15 — bark: opaque, two tones of grey-brown. Ridged fibres run along v and part
    around three knots with growth rings. Every field is periodic over the 120 px
    interior (the cell's grain is not used), so it tiles both ways and a trunk can
    wrap it with no seam."""
    seed = T.name_seed(cv.name)
    knots = [(r.random(), r.random(), r.uniform(0.035, 0.055), r.uniform(0.07, 0.11)) for _ in range(3)]
    n = cv.n
    inner = cv.gutter * cv.ss
    size = n - 2 * inner
    u = ((np.arange(inner, n - inner) - inner + 0.5) / size)[None, :]
    v = ((np.arange(inner, n - inner) - inner + 0.5) / size)[:, None]
    wu = u + np.zeros((size, 1))
    wv = v + np.zeros((1, size))
    ring = np.zeros((size, size))
    in_knot = np.zeros((size, size))
    for kx, ky, rx, ry in knots:
        dx = u - kx
        dy = v - ky
        dx = dx - np.floor(dx + 0.5)
        dy = dy - np.floor(dy + 0.5)
        q = np.sqrt((dx / rx) ** 2 + (dy / ry) ** 2)
        g = np.exp(-0.5 * ((dx / (2.2 * rx)) ** 2 + (dy / (2.2 * ry)) ** 2))
        wu = wu - 0.85 * dx * g
        wv = wv - 0.3 * dy * g
        inside = 1 - ss(0.85, 1.05, q)
        ring = np.maximum(ring, inside * (0.5 + 0.5 * np.cos(q * 4 * TAU)) * ss(0.12, 0.3, q))
        in_knot = np.maximum(in_knot, inside)
    f1 = vnoise_at(wu, wv, 36, 2, seed + 11)
    f2 = vnoise_at(wu, wv, 96, 5, seed + 12)
    f3 = vnoise_at(u, v, 10, 10, seed + 13)
    tone = 0.62 * f1 + 0.38 * f2
    ridge = ss(0.4, 0.66, tone)
    furrow = 1 - ss(0.2, 0.36, tone)
    f4 = vnoise_at(u, v, 40, 40, seed + 14)
    k = (0.86 + 0.28 * f3) * (1 - 0.55 * furrow) * (0.92 + 0.16 * f4)
    kn = 0.55 + 0.45 * ring
    sl = (slice(inner, n - inner), slice(inner, n - inner))
    for plane, dark, light, knot in ((cv.r, BARK_DARK[0], BARK_LIGHT[0], KNOT[0]),
                                     (cv.g, BARK_DARK[1], BARK_LIGHT[1], KNOT[1]),
                                     (cv.b, BARK_DARK[2], BARK_LIGHT[2], KNOT[2])):
        out = dark + (light - dark) * ridge
        out = out + (knot * kn - out) * in_knot
        plane[sl] = out * k
    cv.a[sl] = 1.0


# The sixteen painters of §3.3, row-major from the top-left; each one's name seeds its cell.
CELLS = [
    jungle_leaf_a, jungle_leaf_b, temperate_leaf_a, temperate_leaf_b,
    fern_frond_a, fern_frond_b, lush_grass_a, lush_grass_b,
    dry_grass, meadow_flowers, frost_fern, ash_frond,
    hive_tendril, moss_clump, ground_plant, bark,
]
OPAQUE = bark


# ---------------------------------------------------------------- finish

NEIGHBOURS = ((-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1))


def dilate(chans, known):
    """Grow colour from the `known` pixels into the rest of a cell, one ring of
    8-neighbours at a time, each new pixel taking the mean of its known neighbours
    — so every pixel ends with the colour of its nearest covered one."""
    size = known.shape[0]
    known = known.copy()
    chans = [np.where(known, ch, 0.0) for ch in chans]
    while True:
        k = np.pad(known.astype(np.float64), 1)
        padded = [np.pad(ch, 1) for ch in chans]
        count = np.zeros((size, size))
        sums = [np.zeros((size, size)) for _ in chans]
        for dy, dx in NEIGHBOURS:
            win = (slice(1 + dy, 1 + dy + size), slice(1 + dx, 1 + dx + size))
            count = count + k[win]
            for c in range(len(chans)):
                sums[c] = sums[c] + padded[c][win]
        grow = ~known & (count > 0)
        if not grow.any():
            break
        safe = np.maximum(count, 1.0)
        chans = [np.where(grow, sums[c] / safe, chans[c]) for c in range(len(chans))]
        known = known | grow
    return chans


def finish(cv, opaque):
    """Box-filter a canvas to the cell, unpremultiply, clear the gutter, dilate. → [r, g, b, a] (linear rgb)."""
    c, k, gut = cv.cell, cv.ss, cv.gutter

    def down(a):
        return a.reshape(c, k, c, k).mean(axis=(1, 3))
    alpha = down(cv.a)
    safe = np.where(alpha > 0, alpha, 1.0)
    chans = [np.where(alpha > 0, down(ch) / safe, 0.0) for ch in (cv.r, cv.g, cv.b)]
    inner = np.zeros((c, c), bool)
    inner[gut:c - gut, gut:c - gut] = True
    alpha = np.where(inner, 1.0 if opaque else np.clip(alpha, 0.0, 1.0), 0.0)
    chans = dilate(chans, alpha >= 0.5)
    return chans + [alpha]


def paint_atlas():
    """The atlas: ATLAS_SIZE² × 4 floats — sRGB colour and straight alpha (coverage) — row 0 at the top."""
    assert ATLAS_SIZE == 4 * CELL
    planes = [np.zeros((ATLAS_SIZE, ATLAS_SIZE)) for _ in range(4)]
    for index, paint in enumerate(CELLS):
        cv = Canvas(paint.__name__)
        paint(cv, T.Rand(T.name_seed(paint.__name__)))
        oy, ox = index // 4 * CELL, index % 4 * CELL
        for plane, values in zip(planes, finish(cv, paint is OPAQUE)):
            plane[oy:oy + CELL, ox:ox + CELL] = values
    r, g, b, a = planes
    return np.stack([C.encode_srgb(r), C.encode_srgb(g), C.encode_srgb(b), a], -1).astype(np.float32)


def preview_sheet(rgba):
    """The atlas over 30 % grey and over each planet's `palette.ground`, then its alpha alone: a 4 × 2 grid."""
    size = rgba.shape[0]
    backs = [(0.3, 0.3, 0.3)] + [C.hex_rgb(h) for h in GROUNDS.values()]
    sheet = np.zeros((2 * size, 4 * size, 3), np.float32)
    alpha = rgba[..., 3:4]
    for tile in range(8):
        oy, ox = tile // 4 * size, tile % 4 * size
        if tile < 7:
            img = rgba[..., :3] * alpha + np.array(backs[tile], np.float32) * (1 - alpha)
        else:
            img = np.repeat(alpha, 3, axis=-1)
        sheet[oy:oy + size, ox:ox + size] = img
    return sheet


def main():
    opts = C.options()
    if not C.wanted(opts, 'atlas'):
        return
    C.reset()
    rgba = paint_atlas()
    size = C.save_webp(os.path.join(opts['out'], 'textures', 'foliage', 'atlas.webp'), rgba, quality=QUALITY)
    print(f'ASSET textures/foliage/atlas.webp {size} bytes')
    if opts['preview']:
        path = os.path.join(opts['preview'], 'sheet_foliage.png')
        C.save_image(path, preview_sheet(rgba), 'PNG')
        print(f'PREVIEW {path}')


if __name__ == '__main__':
    main()
