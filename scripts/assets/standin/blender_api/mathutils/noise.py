# `mathutils.noise` for the stand-in build: signed gradient noise and the
# fBm `fractal`, with Blender's signatures. The lattice is improved Perlin
# noise over a permutation shuffled by mulberry32, so it is deterministic; it is
# not Blender's own table, so a model's noise (never its topology or its
# contract) differs from a Blender build — SPEC-052 52-g already allows that.
import math

_M32 = 0xFFFFFFFF


def _mulberry(seed):
    a = seed & _M32
    while True:
        a = (a + 0x6D2B79F5) & _M32
        t = ((a ^ (a >> 15)) * (1 | a)) & _M32
        t = (((t + (((t ^ (t >> 7)) * (61 | t)) & _M32)) & _M32) ^ t) & _M32
        yield ((t ^ (t >> 14)) & _M32) / 4294967296.0


def _permutation():
    rand = _mulberry(0x52454C4C)  # 'RELL'
    p = list(range(256))
    for i in range(255, 0, -1):
        j = int(next(rand) * (i + 1))
        p[i], p[j] = p[j], p[i]
    return p + p


_P = _permutation()


def _fade(t):
    return t * t * t * (t * (t * 6 - 15) + 10)


def _grad(h, x, y, z):
    h &= 15
    u = x if h < 8 else y
    v = y if h < 4 else (x if h in (12, 14) else z)
    return (u if h & 1 == 0 else -u) + (v if h & 2 == 0 else -v)


def _perlin(x, y, z):
    xi, yi, zi = math.floor(x), math.floor(y), math.floor(z)
    x, y, z = x - xi, y - yi, z - zi
    xi, yi, zi = xi & 255, yi & 255, zi & 255
    u, v, w = _fade(x), _fade(y), _fade(z)
    p = _P
    a = p[xi] + yi
    aa, ab = p[a] + zi, p[a + 1] + zi
    b = p[xi + 1] + yi
    ba, bb = p[b] + zi, p[b + 1] + zi

    def lerp(t, a, b):
        return a + t * (b - a)

    return lerp(w,
                lerp(v, lerp(u, _grad(p[aa], x, y, z), _grad(p[ba], x - 1, y, z)),
                     lerp(u, _grad(p[ab], x, y - 1, z), _grad(p[bb], x - 1, y - 1, z))),
                lerp(v, lerp(u, _grad(p[aa + 1], x, y, z - 1), _grad(p[ba + 1], x - 1, y, z - 1)),
                     lerp(u, _grad(p[ab + 1], x, y - 1, z - 1), _grad(p[bb + 1], x - 1, y - 1, z - 1))))


def noise(position, noise_basis='PERLIN_ORIGINAL'):
    """Signed noise in about [-1, 1] at `position`."""
    x, y, z = (float(c) for c in list(position)[:3])
    return _perlin(x, y, z)


def fractal(position, H, lacunarity, octaves, noise_basis='PERLIN_ORIGINAL'):
    """fBm as BLI_noise_mg_fbm sums it: octave amplitude lacunarity^(−H·i)."""
    x, y, z = (float(c) for c in list(position)[:3])
    value, pwr, pw_hl = 0.0, 1.0, lacunarity ** -H
    whole = int(octaves)
    for _ in range(whole):
        value += _perlin(x, y, z) * pwr
        pwr *= pw_hl
        x, y, z = x * lacunarity, y * lacunarity, z * lacunarity
    rmd = octaves - math.floor(octaves)
    if rmd != 0.0:
        value += rmd * _perlin(x, y, z) * pwr
    return value
