# Portraits (SPEC-020 §4.6): portraits/01.webp … 12.webp — 256² busts of the
# salvager rendered with EEVEE in class-themed helmets and colours — plus
# portraits/manifest.json listing the file numbers present. Portrait index i
# (0-based, the creation screen's glyph order) is file i + 1: 1–3 marine,
# 4–6 engineer, 7–9 scout, 10–12 shared (characters.ts `portraits`).
import json
import math
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'lib'))

import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Vector  # noqa: E402

import common as C  # noqa: E402
import salvager as S  # noqa: E402
import tex as T  # noqa: E402

SIZE = 256
# helmet, suit colour, visor/lamp colour, backdrop colour
VARIANTS = [
    ('crest', '#b7472a', '#ffae42', '#4a1a12'),
    ('crest', '#7a7a7a', '#39d7ff', '#1c2a36'),
    ('antenna', '#3e8e4f', '#b8ff6a', '#16301c'),
    ('goggles', '#b7972a', '#39d7ff', '#3a2e10'),
    ('goggles', '#20b2aa', '#ffae42', '#0f3130'),
    ('antenna', '#a0522d', '#39d7ff', '#34180c'),
    ('hood', '#2a6db7', '#39d7ff', '#10223a'),
    ('hood', '#8e3e8e', '#ff6bd6', '#2c1230'),
    ('antenna', '#c9a36b', '#7dff9a', '#33291a'),
    ('crest', '#d9d9d9', '#ff4a3a', '#2a2a30'),
    ('goggles', '#3d3d3d', '#39d7ff', '#121820'),
    ('hood', '#552a2a', '#ffd06a', '#241010'),
]


def lighten(value, t):
    r, g, b = C.hex_rgb(value)
    return '#%02x%02x%02x' % tuple(int(255 * (x + (1 - x) * t)) for x in (r, g, b))


def overrides(suit, visor):
    return {
        'suit': (0, suit, 0.75, 0.0, None),
        'armor': (1, lighten(suit, 0.45), 0.4, 0.15, None),
        'visor': (5, 0.03, 0.08, 0.6, visor),
        'glow': (6, 0.9, 0.3, 0.0, visor),
    }


def render_bust(path, rim):
    scene = bpy.context.scene
    scene.render.engine = 'BLENDER_EEVEE'
    scene.render.resolution_x = scene.render.resolution_y = SIZE
    scene.render.film_transparent = True
    scene.view_settings.view_transform = 'AgX'
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'RGBA'
    world = bpy.data.worlds.new('PortraitWorld')
    world.use_nodes = True
    back = next(n for n in world.node_tree.nodes if n.type == 'BACKGROUND')
    back.inputs['Color'].default_value = C.lin('#1a222c')
    back.inputs['Strength'].default_value = 0.7
    scene.world = world
    for name, energy, colour, rot in (('key', 3.5, '#fff0dc', (55, 0, -30)), ('rim', 4.0, rim, (70, 0, 160)), ('fill', 0.8, '#ffffff', (80, 0, 70))):
        light = bpy.data.lights.new(name, 'SUN')
        light.energy = energy
        light.color = C.lin(colour)[:3]
        obj = C.link(bpy.data.objects.new(name, light))
        obj.rotation_euler = [math.radians(a) for a in rot]
    cam_data = bpy.data.cameras.new('bust')
    cam_data.lens = 85
    cam = C.link(bpy.data.objects.new('bust', cam_data))
    centre = Vector((0.0, 0.0, 1.5))
    az, el, dist = math.radians(24), math.radians(6), 1.75
    cam.location = centre + Vector((math.sin(az) * math.cos(el), -math.cos(az) * math.cos(el), math.sin(el))) * dist
    cam.rotation_euler = (centre - cam.location).to_track_quat('-Z', 'Y').to_euler()
    scene.camera = cam
    scene.render.filepath = C.ensure_dir(path)
    bpy.ops.render.render(write_still=True)


def composite(render_png, backdrop):
    img = bpy.data.images.load(render_png)
    img.colorspace_settings.name = 'Non-Color'
    fg = np.array(img.pixels[:], dtype=np.float32).reshape(SIZE, SIZE, 4)[::-1]
    bpy.data.images.remove(img)
    r, u, v = T.radial(SIZE, cy=0.42)
    centre = np.array(C.hex_rgb(lighten(backdrop, 0.25)), np.float32)
    edge = np.array(C.hex_rgb(backdrop), np.float32) * 0.45
    t = (1 - T.smoothstep(0.0, 1.25, r))[..., None]
    bg = edge + (centre - edge) * t
    bg = bg * (0.95 + 0.1 * T.fbm(SIZE, 6, 3, 7))[..., None]
    a = fg[..., 3:4]
    out = fg[..., :3] * a + bg * (1 - a)
    return np.clip(out, 0, 1)


def main():
    opts = C.options()
    tmp = os.path.join(opts['preview'] or os.path.join(opts['out'], '..', '..', '.portraits-tmp'), 'portrait_renders')
    tiles, present = [], []
    for i, (helmet, suit, visor, backdrop) in enumerate(VARIANTS):
        number = i + 1
        if not C.wanted(opts, f'{number:02d}'):
            continue
        C.reset()
        S.build(helmet=helmet, overrides=overrides(suit, visor), name=f'Portrait{number:02d}', strength=0.9)
        raw = os.path.join(tmp, f'raw_{number:02d}.png')
        render_bust(raw, visor)
        pic = composite(raw, backdrop)
        size = C.save_webp(os.path.join(opts['out'], 'portraits', f'{number:02d}.webp'), pic, quality=88)
        print(f'ASSET portraits/{number:02d}.webp {size} bytes')
        tiles.append(pic)
        present.append(number)
    if len(present) == len(VARIANTS):
        with open(C.ensure_dir(os.path.join(opts['out'], 'portraits', 'manifest.json')), 'w') as fh:
            json.dump(present, fh)
            fh.write('\n')
        print('ASSET portraits/manifest.json')
    if opts['preview'] and tiles:
        cols = 6
        rows = math.ceil(len(tiles) / cols)
        grid = np.zeros((rows * SIZE, cols * SIZE, 3), np.float32)
        for k, t in enumerate(tiles):
            rr, cc = divmod(k, cols)
            grid[rr * SIZE:(rr + 1) * SIZE, cc * SIZE:(cc + 1) * SIZE] = t
        path = os.path.join(opts['preview'], 'sheet_portraits.png')
        C.save_image(path, grid, 'PNG')
        print(f'PREVIEW {path}')
    elif not opts['preview']:
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)


main()
