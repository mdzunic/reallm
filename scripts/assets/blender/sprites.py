# VFX sprites (SPEC-019 §4.4, SPEC-020 §4.3): textures/sprites/*.webp, 256²
# (streak 256 × 64), white-to-grey RGB with straight alpha so the runtime
# instance colour tints them. Shapes come from numpy radial fields and seamless
# noise (lib/tex.py); nothing is rendered, so the files are exact and tiny.
import math
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'lib'))

import numpy as np  # noqa: E402

import common as C  # noqa: E402
import tex as T  # noqa: E402

N = 256
ss = T.smoothstep


def rgba(alpha, grey=1.0):
    a = np.clip(alpha, 0, 1).astype(np.float32)
    g = np.broadcast_to(np.clip(grey, 0, 1), a.shape).astype(np.float32)
    return np.stack([g, g, g, a], -1)


def smoke():
    r, u, v = T.radial(N)
    n = T.fbm(N, 4, 5, 101)
    d = r * (0.75 + 0.5 * n)
    return rgba((1 - ss(0.3, 1.0, d)) * (0.45 + 0.55 * T.fbm(N, 8, 4, 102)), 0.78 + 0.22 * n)


def dirt():
    r, u, v = T.radial(N)
    n = T.fbm(N, 6, 5, 111)
    clumps = ss(0.42, 0.62, n + 0.35 * (1 - r))
    return rgba(clumps * (1 - ss(0.7, 1.0, r)), 0.7 + 0.3 * T.fbm(N, 16, 3, 112))


def flare():
    r, u, v = T.radial(N)
    rays = np.exp(-np.abs(u) * 30) * np.exp(-np.abs(v) * 2.2) + np.exp(-np.abs(v) * 30) * np.exp(-np.abs(u) * 2.2)
    diag = np.exp(-np.abs(u + v) * 42) * np.exp(-np.abs(u - v) * 3.5) + np.exp(-np.abs(u - v) * 42) * np.exp(-np.abs(u + v) * 3.5)
    a = np.exp(-r * r * 60) + 0.45 * np.exp(-r * r * 5) + 0.7 * rays + 0.3 * diag
    return rgba(a * (1 - ss(0.85, 1.0, r)))


def spark():
    r, u, v = T.radial(N)
    a = np.exp(-(u / 0.85) ** 2 * 2.5 - (v / 0.07) ** 2)
    return rgba(a * (1 - ss(0.9, 1.0, np.abs(u))))


def ember():
    r, u, v = T.radial(N)
    return rgba(np.exp(-r * r * 70) + 0.35 * np.exp(-r * r * 7) * (1 - ss(0.8, 1.0, r)))


def muzzle():
    r, u, v = T.radial(N)
    theta = np.arctan2(v, u)
    petals = np.abs(np.cos(2.5 * theta)) ** 6
    a = np.exp(-r / (0.12 + 0.55 * petals)) * (1 - ss(0.85, 1.0, r))
    return rgba(np.clip(a * 1.6, 0, 1))


def ring():
    r, u, v = T.radial(N)
    band = np.exp(-((r - 0.78) / 0.07) ** 2)
    inner = 0.25 * ss(0.2, 0.78, r) * (r < 0.78)
    return rgba(band + inner)


def magic():
    r, u, v = T.radial(N)
    theta = np.arctan2(v, u)
    swirl = 0.5 + 0.5 * np.sin(5 * theta + 9 * r)
    band = np.exp(-((r - 0.62) / 0.13) ** 2) * (0.55 + 0.45 * swirl)
    core = 0.5 * np.exp(-r * r * 9)
    return rgba((band + core) * (1 - ss(0.9, 1.0, r)))


def flake():
    r, u, v = T.radial(N)
    theta = np.arctan2(v, u)
    arms = np.abs(np.cos(3 * theta)) ** 40 * (1 - ss(0.55, 0.9, r))
    twigs = np.abs(np.cos(3 * theta + 0.52)) ** 60 * ss(0.3, 0.45, r) * (1 - ss(0.5, 0.65, r))
    return rgba(np.clip(arms + twigs + np.exp(-r * r * 40), 0, 1))


def streak():
    y, x = np.mgrid[0:64, 0:N].astype(np.float32)
    u = (x + 0.5) / N * 2 - 1
    v = (y + 0.5) / 64 * 2 - 1
    along = np.clip(1 - np.abs(u), 0, 1) ** 1.5
    a = np.exp(-(v / 0.35) ** 2) * along
    return rgba(a)


SPRITES = {'smoke': smoke, 'dirt': dirt, 'flare': flare, 'spark': spark, 'ember': ember, 'muzzle': muzzle,
           'ring': ring, 'magic': magic, 'flake': flake, 'streak': streak}


def main():
    opts = C.options()
    C.reset()
    shown = []
    for name, fn in SPRITES.items():
        if not C.wanted(opts, name):
            continue
        img = fn()
        size = C.save_webp(os.path.join(opts['out'], 'textures', 'sprites', f'{name}.webp'), img, quality=90)
        print(f'ASSET textures/sprites/{name}.webp {size} bytes')
        tile = np.zeros((N, N, 3), np.float32) + 0.08
        h = img.shape[0]
        tile[(N - h) // 2:(N - h) // 2 + h] = 0.08 + img[..., :3] * img[..., 3:4]
        shown.append(tile)
    if opts['preview'] and shown:
        cols = 5
        rows = math.ceil(len(shown) / cols)
        grid = np.zeros((rows * N, cols * N, 3), np.float32)
        for i, t in enumerate(shown):
            r, c = divmod(i, cols)
            grid[r * N:(r + 1) * N, c * N:(c + 1) * N] = t
        path = os.path.join(opts['preview'], 'sheet_sprites.png')
        C.save_image(path, grid, 'PNG')
        print(f'PREVIEW {path}')


main()
