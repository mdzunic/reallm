# numpy texture helpers for the Blender generators: periodic (seamless) value
# noise and fBm, FFT blur, normals from height, and the ship's hull panels.
# Arrays are H×W (row 0 = top); every function is deterministic per seed.
import numpy as np


def rng(seed):
    return np.random.default_rng(seed)


def value_noise(size, cells, seed):
    """Seamless value noise in [0, 1] with `cells` lattice cells per side."""
    g = rng(seed).random((cells, cells)).astype(np.float32)
    t = np.arange(size, dtype=np.float32) * cells / size
    i0 = np.floor(t).astype(np.int64)
    f = t - i0
    i1 = (i0 + 1) % cells
    i0 = i0 % cells
    f = f * f * f * (f * (f * 6 - 15) + 10)
    fx, fy = f[None, :], f[:, None]
    a, b = g[i0][:, i0], g[i0][:, i1]
    c, d = g[i1][:, i0], g[i1][:, i1]
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy


def fbm(size, cells, octaves, seed, gain=0.5):
    total = np.zeros((size, size), np.float32)
    amp, norm = 1.0, 0.0
    for o in range(octaves):
        total += amp * value_noise(size, cells * 2 ** o, seed + 101 * o)
        norm += amp
        amp *= gain
    return total / norm


def blur(a, sigma):
    """Periodic gaussian blur through the FFT (sigma in pixels)."""
    n, m = a.shape
    ky, kx = np.fft.fftfreq(n), np.fft.fftfreq(m)
    g = np.exp(-2 * (np.pi * sigma) ** 2 * (ky[:, None] ** 2 + kx[None, :] ** 2))
    return np.real(np.fft.ifft2(np.fft.fft2(a) * g)).astype(np.float32)


def normals(height, strength):
    """Tangent-space normals (OpenGL, +Y up in texture space) from a periodic height."""
    dx = (np.roll(height, -1, 1) - np.roll(height, 1, 1)) * 0.5
    dy = (np.roll(height, 1, 0) - np.roll(height, -1, 0)) * 0.5  # row 0 is the top: +v points up
    n = np.stack([-dx * strength, -dy * strength, np.ones_like(height)], -1)
    return n / np.linalg.norm(n, axis=-1, keepdims=True)


def radial(size, cx=0.5, cy=0.5, sx=1.0, sy=1.0):
    """Distance from the centre in units of the half-size (1 at the edge)."""
    y, x = np.mgrid[0:size, 0:size].astype(np.float32)
    u = ((x + 0.5) / size - cx) * 2 / sx
    v = ((y + 0.5) / size - cy) * 2 / sy
    return np.sqrt(u * u + v * v), u, v


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def panels(size=256, grid=8, seed=7, accent=(0.85, 0.47, 0.17)):
    """Seamless hull panels: tones, dark seams, rivets, grime, a few accent and
    hazard-striped panels. Returns H×W×3 sRGB-encoded design values."""
    r = rng(seed)
    cell = size // grid
    tone = np.zeros((size, size), np.float32)
    seam = np.zeros((size, size), np.float32)
    colour = np.ones((size, size, 3), np.float32)
    stripes = np.zeros((size, size), np.float32)
    y, x = np.mgrid[0:size, 0:size]
    for gy in range(grid):
        gx = 0
        while gx < grid:
            w = int(min(r.integers(1, 4), grid - gx))
            ys, xs = gy * cell, gx * cell
            block = (slice(ys, ys + cell), slice(xs, xs + w * cell))
            tone[block] = r.choice([0.60, 0.67, 0.74, 0.80])
            roll = r.random()
            if roll < 0.10:
                colour[block] = accent
            elif roll < 0.16:
                stripes[block] = 1.0
            seam[ys, xs:xs + w * cell] = 1.0
            seam[ys:ys + cell, xs] = 1.0
            for ry, rx in ((ys + 3, xs + 3), (ys + 3, xs + w * cell - 4), (ys + cell - 4, xs + 3), (ys + cell - 4, xs + w * cell - 4)):
                seam[ry % size, rx % size] = 0.6
            gx += w
    grime = fbm(size, 4, 4, seed + 1)
    speck = value_noise(size, 64, seed + 2)
    base = tone * (0.82 + 0.28 * grime) * (0.94 + 0.08 * speck)
    rgb = colour * base[..., None]
    hazard = ((x + y) // 6) % 2 == 0
    stripe_rgb = np.where(hazard[..., None], np.array([0.86, 0.66, 0.12], np.float32), np.array([0.09, 0.09, 0.1], np.float32))
    rgb = np.where(stripes[..., None] > 0, stripe_rgb * (0.85 + 0.2 * grime[..., None]), rgb)
    seam_soft = np.maximum(seam, blur(seam, 0.8) * 0.6)
    rgb = rgb * (1 - 0.62 * np.clip(seam_soft, 0, 1))[..., None]
    return np.clip(rgb, 0, 1).astype(np.float32)
