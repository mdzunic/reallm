# Item and companion pictures (SPEC-031 §4.13, SPEC-035 §4.15): items/<id>.webp
# — 384² renders for every key of ITEMS and COMPANIONS — plus
# items/manifest.json listing the ids actually written, so a partial run
# degrades to glyphs for the rest (31-r). Everything is built from primitives
# by the SUBJECTS table below, through lib/common.py's bevel and the shared
# palette, lit by the portrait rig, each subject auto-fitted to 86% of the frame
# so a pistol and a launcher carry the same visual weight in a row of keys.
#
# SPEC-035 §4.15 fixed the camera, which framed every item from behind: a
# weapon is recognised by its profile, so weapons are shot side-on with the
# muzzle to the right of the frame (azimuth 90°, elevation 8°); a pack, an
# armour or a drone is recognised by its face, so everything else is shot from
# the front three-quarter on the side the builders face (+Y — azimuth 145°,
# elevation 12°). The rim light is half again as strong and a faint radial
# backdrop sits behind the subject, so gunmetal reads against the navy UI at
# 28–40 px.
#
#   node scripts/assets/blender/build.mjs items
#   node scripts/assets/blender/build.mjs items --preview=DIR   # + a contact sheet
#
# Deterministic: no randomness anywhere (PLAN R7).
import json
import math
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'lib'))

import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Vector  # noqa: E402

import common as C  # noqa: E402
import tex as T  # noqa: E402

SIZE = 384
FILL = 0.86
MAX_BYTES = 36 * 1024

# SPEC-035 §4.15 — the camera per item kind: (azimuth°, elevation°). Azimuth 0
# looks the subject in the face from -Y; 90° puts the camera on +X, where the
# screen's right is world +Y and every builder's barrel points.
FRAMING = {
    # Handguns, rifles, machine guns and launchers: side-on, muzzle right.
    'weapon': (90.0, 8.0),
    # Armour, consumables, explosives, the coolant pack, the plasma cell and the
    # companions: the front three-quarter from the side the builders face.
    'other': (145.0, 12.0),
}

# §4.15: the faint halo behind the subject. Alpha 0.18 in the middle, nothing at
# the edge, so the navy UI still shows through and no tile reads as a card.
BACKDROP_COLOUR = '#9fb6d4'
BACKDROP_ALPHA = 0.18

# The shared palette: gunmetal bodies, worn steel, the accent cells.
GUNMETAL = '#3a4450'
STEEL = '#6a7480'
DARK = '#242b33'
GRIP = '#2e2620'
ACCENT = '#4c9aff'
AMBER = '#f5a623'
GREEN = '#46c973'
RED = '#e5484d'
DRONE = '#8a97a3'


def mat(name, colour, rough=0.55, metal=0.6, emissive=None, strength=0.0):
    return C.mat_flat(name, colour, rough=rough, metal=metal, emission=emissive, strength=strength)


def add(bm, name, colour, rough=0.55, metal=0.6, emissive=None, strength=0.0):
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    obj = C.link(bpy.data.objects.new(name, mesh))
    obj.data.materials.append(mat(f'{name}_mat', colour, rough, metal, emissive, strength))
    return obj


# ------------------------------------------------------------------ builders
# Every builder works in metres-ish units around the origin, +Y forward
# (the barrel), +Z up. The camera auto-fits, so absolute scale is free.


def weapon(body_len=0.9, body_h=0.16, barrel_len=0.5, barrel_r=0.035, grip_back=0.25,
           magazine=True, drum=False, shroud=False, tube=False, sight=False, cell=None,
           stock=False, twin=False):
    parts = []
    parts.append(add(C.place(C.box(0.09, body_len, body_h, bevel=0.012), (0, 0, 0.1)), 'body', GUNMETAL))
    barrels = [(0.0, 0.1)] if not twin else [(-0.028, 0.1), (0.028, 0.1)]
    for i, (bx, bz) in enumerate(barrels):
        parts.append(add(C.place(C.cyl(barrel_r, barrel_r, barrel_len, n=12, bevel=0.004),
                                 (bx, body_len / 2 + barrel_len / 2, bz), (90, 0, 0)), f'barrel{i}', STEEL))
    parts.append(add(C.place(C.box(0.07, 0.09, 0.22, bevel=0.01), (0, -body_len / 2 + grip_back, -0.06), (-18, 0, 0)), 'grip', GRIP, rough=0.8, metal=0.0))
    if magazine:
        parts.append(add(C.place(C.box(0.06, 0.12, 0.2, bevel=0.008), (0, 0.05, -0.08), (8, 0, 0)), 'magazine', DARK))
    if drum:
        parts.append(add(C.place(C.cyl(0.12, 0.12, 0.1, n=16, bevel=0.008), (0, -0.05, -0.05), (0, 90, 0)), 'drum', DARK))
    if shroud:
        parts.append(add(C.place(C.cyl(0.06, 0.06, barrel_len * 0.7, n=10, caps=False), (0, body_len / 2 + barrel_len * 0.3, 0.1), (90, 0, 0)), 'shroud', DARK, rough=0.7))
    if tube:
        parts.append(add(C.place(C.cyl(0.075, 0.085, body_len * 1.1, n=12, bevel=0.006), (0, 0.1, 0.12), (90, 0, 0)), 'tube', GUNMETAL))
    if sight:
        parts.append(add(C.place(C.box(0.03, 0.12, 0.07, bevel=0.006), (0, 0.1, 0.22), (0, 0, 0)), 'sight', DARK))
    if stock:
        parts.append(add(C.place(C.box(0.07, 0.24, 0.12, bevel=0.01), (0, -body_len / 2 - 0.1, 0.06), (6, 0, 0)), 'stock', GRIP, rough=0.8, metal=0.0))
    if cell is not None:
        parts.append(add(C.place(C.box(0.1, 0.16, 0.08, bevel=0.008), (0, 0.12, 0.16), (0, 0, 0)), 'cell', cell, rough=0.3, metal=0.1, emissive=cell, strength=3.0))
    return parts


def armor(plates=2, accent=None):
    parts = []
    # A chest plate on a low stand (§4.13).
    parts.append(add(C.place(C.box(0.5, 0.16, 0.62, bevel=0.03), (0, 0, 0.32)), 'chest', GUNMETAL, rough=0.45))
    for i in range(plates):
        z = 0.18 + i * 0.16
        parts.append(add(C.place(C.box(0.42 - i * 0.06, 0.1, 0.12, bevel=0.02), (0, 0.08, z)), f'plate{i}', STEEL, rough=0.4))
    parts.append(add(C.place(C.box(0.2, 0.06, 0.05, bevel=0.01), (0, 0.13, 0.52)), 'collar', accent or DARK, rough=0.3, emissive=accent, strength=(2.0 if accent else 0.0)))
    parts.append(add(C.place(C.cyl(0.16, 0.22, 0.08, n=16, bevel=0.01), (0, 0, 0.0)), 'stand', DARK, rough=0.8))
    return parts


def pouch(marking):
    parts = []
    parts.append(add(C.place(C.box(0.34, 0.2, 0.4, bevel=0.05), (0, 0, 0.2)), 'pouch', '#4a4136', rough=0.85, metal=0.0))
    parts.append(add(C.place(C.box(0.36, 0.22, 0.1, bevel=0.03), (0, 0, 0.4)), 'flap', '#3a332b', rough=0.85, metal=0.0))
    parts.append(add(C.place(C.box(0.14, 0.02, 0.14, bevel=0.01), (0, 0.115, 0.22)), 'mark', marking, rough=0.4, metal=0.0, emissive=marking, strength=1.2))
    return parts


def canister(colour):
    parts = []
    parts.append(add(C.place(C.cyl(0.15, 0.15, 0.5, n=16, bevel=0.02), (0, 0, 0.25)), 'tank', STEEL, rough=0.35))
    parts.append(add(C.place(C.cyl(0.05, 0.05, 0.1, n=10), (0, 0, 0.55)), 'valve', DARK))
    parts.append(add(C.place(C.box(0.32, 0.02, 0.14, bevel=0.01), (0, 0.15, 0.25)), 'band', colour, rough=0.3, emissive=colour, strength=1.5))
    return parts


def cellblock(colour):
    parts = []
    parts.append(add(C.place(C.box(0.24, 0.24, 0.46, bevel=0.03), (0, 0, 0.23)), 'block', DARK, rough=0.4))
    parts.append(add(C.place(C.cyl(0.09, 0.09, 0.5, n=12), (0, 0, 0.25)), 'core', colour, rough=0.2, metal=0.0, emissive=colour, strength=4.0))
    return parts


def sphere_charge(colour, spikes=0):
    parts = []
    parts.append(add(C.sphere(0.24, segs=20, rings=14), 'shell', GUNMETAL, rough=0.4))
    parts.append(add(C.place(C.torus(0.245, 0.02, n=24, m=8), (0, 0, 0), (90, 0, 0)), 'seam', colour, rough=0.3, emissive=colour, strength=2.0))
    parts.append(add(C.place(C.cyl(0.04, 0.04, 0.1, n=8), (0, 0, 0.27)), 'fuse', DARK))
    for i in range(spikes):
        angle = (i / spikes) * math.pi * 2
        parts.append(add(C.place(C.cyl(0.02, 0.005, 0.1, n=6), (math.cos(angle) * 0.25, math.sin(angle) * 0.25, 0),
                                 (0, 90, math.degrees(angle))), f'spike{i}', STEEL))
    return parts


def mine(colour):
    parts = []
    parts.append(add(C.place(C.cyl(0.28, 0.24, 0.12, n=20, bevel=0.02), (0, 0, 0.06)), 'disc', GUNMETAL, rough=0.5))
    parts.append(add(C.place(C.cyl(0.08, 0.06, 0.06, n=12), (0, 0, 0.15)), 'sensor', colour, rough=0.2, emissive=colour, strength=3.0))
    for i in range(3):
        angle = (i / 3) * math.pi * 2
        parts.append(add(C.place(C.box(0.05, 0.12, 0.03, bevel=0.008), (math.cos(angle) * 0.24, math.sin(angle) * 0.24, 0.03), (0, 0, math.degrees(angle))), f'clamp{i}', DARK))
    return parts


def charge_block(colour):
    parts = []
    parts.append(add(C.place(C.box(0.4, 0.22, 0.26, bevel=0.02), (0, 0, 0.13)), 'block', '#5a5346', rough=0.8, metal=0.0))
    parts.append(add(C.place(C.box(0.18, 0.1, 0.08, bevel=0.01), (0, 0, 0.3)), 'timer', DARK, rough=0.3))
    parts.append(add(C.place(C.box(0.12, 0.02, 0.04, bevel=0.005), (0, 0.06, 0.3)), 'readout', colour, rough=0.2, emissive=colour, strength=3.0))
    return parts


def drone(kind):
    parts = []
    if kind == 'scanner':
        parts.append(add(C.place(C.sphere(0.2, segs=20, rings=14), (0, 0, 0.3)), 'hull', DRONE, rough=0.35))
        parts.append(add(C.place(C.cyl(0.08, 0.08, 0.06, n=12), (0, 0.18, 0.3), (90, 0, 0)), 'lens', ACCENT, rough=0.1, emissive=ACCENT, strength=3.0))
        for side in (-1, 1):
            parts.append(add(C.place(C.cyl(0.01, 0.01, 0.3, n=6), (side * 0.12, 0, 0.5)), f'antenna{side}', DARK))
    elif kind == 'combat':
        parts.append(add(C.place(C.box(0.4, 0.5, 0.14, bevel=0.03), (0, 0, 0.3)), 'hull', GUNMETAL, rough=0.4))
        for side in (-1, 1):
            parts.append(add(C.place(C.cyl(0.025, 0.025, 0.3, n=10), (side * 0.12, 0.3, 0.26), (90, 0, 0)), f'gun{side}', STEEL))
            parts.append(add(C.place(C.cyl(0.16, 0.16, 0.02, n=16), (side * 0.26, -0.1, 0.38)), f'rotor{side}', DARK, rough=0.3))
    elif kind == 'medic':
        parts.append(add(C.place(C.box(0.34, 0.34, 0.3, bevel=0.04), (0, 0, 0.3)), 'hull', '#e6edf3', rough=0.5, metal=0.1))
        parts.append(add(C.place(C.box(0.22, 0.06, 0.06, bevel=0.005), (0, 0.175, 0.3)), 'cross_h', GREEN, rough=0.3, emissive=GREEN, strength=2.0))
        parts.append(add(C.place(C.box(0.06, 0.06, 0.22, bevel=0.005), (0, 0.175, 0.3)), 'cross_v', GREEN, rough=0.3, emissive=GREEN, strength=2.0))
        for side in (-1, 1):
            parts.append(add(C.place(C.cyl(0.14, 0.14, 0.02, n=16), (side * 0.26, 0, 0.48)), f'rotor{side}', DARK, rough=0.3))
    elif kind == 'quartermaster':
        parts.append(add(C.place(C.box(0.44, 0.34, 0.34, bevel=0.03), (0, 0, 0.3)), 'crate', '#6b5a3a', rough=0.7, metal=0.1))
        parts.append(add(C.place(C.box(0.46, 0.36, 0.06, bevel=0.01), (0, 0, 0.5)), 'lid', '#5a4a2e', rough=0.7, metal=0.1))
        parts.append(add(C.place(C.cyl(0.05, 0.05, 0.16, n=10), (0.2, 0.2, 0.58)), 'scanner', AMBER, rough=0.2, emissive=AMBER, strength=2.0))
    else:  # aria — the flight companion core
        parts.append(add(C.place(C.torus(0.26, 0.045, n=28, m=10), (0, 0, 0.3), (60, 0, 0)), 'ring', STEEL, rough=0.3))
        parts.append(add(C.place(C.sphere(0.14, segs=20, rings=14), (0, 0, 0.3)), 'core', ACCENT, rough=0.1, emissive=ACCENT, strength=5.0))
    return parts


# ------------------------------------------------------------------ subjects
# Every key of ITEMS and COMPANIONS (src/data/items.ts, companions.ts). The
# content test guarantees a glyph for any id missing here; this table aims to
# cover all of them so no surface ships a fallback.
# SPEC-035 §4.15: the first element is the framing key of `FRAMING` — a weapon
# is read from its profile, everything else from its face.
SUBJECTS = {
    # Handguns
    'pistol_service': ('weapon', lambda: weapon(body_len=0.5, barrel_len=0.24, body_h=0.13, magazine=False)),
    'pistol_magnum': ('weapon', lambda: weapon(body_len=0.58, barrel_len=0.34, barrel_r=0.045, body_h=0.15, magazine=False, sight=True)),
    # Rifles
    'weapon_kinetic': ('weapon', lambda: weapon(stock=True)),
    'weapon_laser': ('weapon', lambda: weapon(stock=True, sight=True, cell=RED)),
    'weapon_plasma': ('weapon', lambda: weapon(stock=True, sight=True, cell=ACCENT, barrel_r=0.05)),
    'weapon_lithium': ('weapon', lambda: weapon(stock=True, sight=True, cell=AMBER, barrel_r=0.055, twin=True)),
    # Machine guns
    'mg_scrap': ('weapon', lambda: weapon(body_len=1.0, barrel_len=0.55, drum=True, shroud=True, magazine=False)),
    'mg_rotary': ('weapon', lambda: weapon(body_len=1.0, barrel_len=0.6, drum=True, shroud=True, magazine=False, twin=True, stock=True)),
    # Launchers
    'launcher_rocket': ('weapon', lambda: weapon(body_len=0.8, barrel_len=0.0, tube=True, sight=True, magazine=False)),
    'launcher_grenade': ('weapon', lambda: weapon(body_len=0.7, barrel_len=0.0, tube=True, sight=True, drum=True, magazine=False)),
    # Armor
    'armor_scrap': ('other', lambda: armor(plates=1)),
    'armor_composite': ('other', lambda: armor(plates=2)),
    'armor_reactive': ('other', lambda: armor(plates=2, accent=ACCENT)),
    'armor_ablative': ('other', lambda: armor(plates=3, accent=AMBER)),
    # Consumables
    'wheat_ration': ('other', lambda: pouch(AMBER)),
    'medkit': ('other', lambda: pouch(GREEN)),
    'coolant_pack': ('other', lambda: canister(ACCENT)),
    'plasma_cell': ('other', lambda: cellblock(ACCENT)),
    'frag_grenade': ('other', lambda: sphere_charge(RED)),
    'landmine': ('other', lambda: mine(RED)),
    'demo_charge': ('other', lambda: charge_block(RED)),
    # Companions
    'scanner_drone': ('other', lambda: drone('scanner')),
    'combat_drone': ('other', lambda: drone('combat')),
    'field_medic': ('other', lambda: drone('medic')),
    'quartermaster': ('other', lambda: drone('quartermaster')),
    'aria': ('other', lambda: drone('aria')),
}


# ------------------------------------------------------------------- render

def rig():
    """The portrait rig (§4.13): key #fff0dc, rim, fill; AgX; transparent film."""
    scene = bpy.context.scene
    scene.render.engine = 'BLENDER_EEVEE'
    scene.render.resolution_x = scene.render.resolution_y = SIZE
    scene.render.film_transparent = True
    scene.view_settings.view_transform = 'AgX'
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'RGBA'
    world = bpy.data.worlds.new('ItemWorld')
    world.use_nodes = True
    back = next(n for n in world.node_tree.nodes if n.type == 'BACKGROUND')
    back.inputs['Color'].default_value = C.lin('#1a222c')
    back.inputs['Strength'].default_value = 0.5
    scene.world = world
    for name, energy, colour, rot in (
        ('key', 3.2, '#fff0dc', (55, 0, -30)),
        # SPEC-035 §4.15: the rim rises 50% — it is what separates a gunmetal
        # silhouette from the navy panel behind it.
        ('rim', 5.4, '#9cc4ff', (70, 0, 160)),
        ('fill', 0.9, '#ffffff', (80, 0, 70)),
    ):
        light = bpy.data.lights.new(name, 'SUN')
        light.energy = energy
        light.color = C.lin(colour)[:3]
        obj = C.link(bpy.data.objects.new(name, light))
        obj.rotation_euler = [math.radians(a) for a in rot]


def fit_camera(objs, kind):
    """SPEC-035 §4.15 — one orthographic camera, framed by the item's kind:
    a weapon side-on with its muzzle to the right of the frame (azimuth 90°,
    elevation 8°), everything else from the front three-quarter on the side the
    builders face (azimuth 145°, elevation 12°). The subject fills FILL of the
    frame either way, so a pistol and a launcher carry the same weight."""
    scene = bpy.context.scene
    cam_data = bpy.data.cameras.new('item')
    cam_data.type = 'ORTHO'
    cam = C.link(bpy.data.objects.new('item', cam_data))
    azimuth, elevation = FRAMING[kind]
    az, el = math.radians(azimuth), math.radians(elevation)
    direction = Vector((math.sin(az) * math.cos(el), -math.cos(az) * math.cos(el), math.sin(el)))
    # The subject's world-space bounds.
    lo = Vector((1e9, 1e9, 1e9))
    hi = Vector((-1e9, -1e9, -1e9))
    for obj in objs:
        for corner in obj.bound_box:
            world = obj.matrix_world @ Vector(corner)
            lo = Vector(map(min, lo, world))
            hi = Vector(map(max, hi, world))
    centre = (lo + hi) / 2
    cam.location = centre + direction * 6.0
    cam.rotation_euler = (centre - cam.location).to_track_quat('-Z', 'Y').to_euler()
    scene.camera = cam
    bpy.context.view_layer.update()
    # Project the corners into camera space to find the tight ortho scale.
    inv = cam.matrix_world.inverted()
    span = 0.0
    for obj in objs:
        for corner in obj.bound_box:
            local = inv @ (obj.matrix_world @ Vector(corner))
            span = max(span, abs(local.x) * 2, abs(local.y) * 2)
    cam_data.ortho_scale = max(span, 1e-3) / FILL


def render_png(path):
    scene = bpy.context.scene
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    img = bpy.data.images.load(path)
    img.colorspace_settings.name = 'Non-Color'
    pixels = np.array(img.pixels[:], dtype=np.float32).reshape(SIZE, SIZE, 4)[::-1]
    bpy.data.images.remove(img)
    return pixels


def with_backdrop(rgba):
    """SPEC-035 §4.15 — a faint radial halo behind the subject: `BACKDROP_ALPHA`
    in the middle, nothing at the edge. The tile stays translucent, so the navy
    panel still shows through and nothing reads as a card."""
    r, _u, _v = T.radial(SIZE)
    halo = ((1 - T.smoothstep(0.1, 1.0, r)) * BACKDROP_ALPHA).astype(np.float32)
    back = np.array(C.hex_rgb(BACKDROP_COLOUR), np.float32)
    fg_a = rgba[..., 3:4]
    bg_a = halo[..., None]
    out_a = fg_a + bg_a * (1 - fg_a)
    safe = np.maximum(out_a, 1e-5)
    rgb = (rgba[..., :3] * fg_a + back * bg_a * (1 - fg_a)) / safe
    return np.clip(np.concatenate([rgb, out_a], axis=-1), 0, 1)


def save_budgeted(path, rgba):
    """WebP under the 36 KB ceiling: step the quality down until it fits."""
    for quality in (82, 72, 60, 48, 36):
        size = C.save_webp(path, rgba, quality=quality)
        if size <= MAX_BYTES:
            return size
    return size


def main():
    opts = C.options()
    tmp = os.path.join(opts['preview'] or os.path.join(opts['out'], '..', '..', '.items-tmp'), 'item_renders')
    written = []
    tiles = []
    for item_id, (kind, build) in SUBJECTS.items():
        if not C.wanted(opts, item_id):
            continue
        C.reset()
        rig()
        objs = build()
        fit_camera(objs, kind)
        raw = os.path.join(C.ensure_dir(os.path.join(tmp, f'{item_id}.png')))
        rgba = with_backdrop(render_png(raw))
        size = save_budgeted(os.path.join(opts['out'], 'items', f'{item_id}.webp'), rgba)
        print(f'ASSET items/{item_id}.webp {size} bytes')
        written.append(item_id)
        tiles.append(rgba)
    # §4.13: the manifest names the files actually rendered, so a partial run
    # degrades to glyphs for the rest.
    if written:
        with open(C.ensure_dir(os.path.join(opts['out'], 'items', 'manifest.json')), 'w') as fh:
            json.dump({'items': written}, fh)
            fh.write('\n')
        print('ASSET items/manifest.json')
    # SPEC-035 §4.15: `--preview=DIR` writes the contact sheet the review reads,
    # on the navy the tiles are actually seen against.
    if opts['preview'] and tiles:
        cols = 6
        rows = math.ceil(len(tiles) / cols)
        grid = np.zeros((rows * SIZE, cols * SIZE, 3), np.float32)
        grid[:] = np.array(C.hex_rgb('#101720'), np.float32)
        for k, tile in enumerate(tiles):
            rr, cc = divmod(k, cols)
            a = tile[..., 3:4]
            cell = grid[rr * SIZE:(rr + 1) * SIZE, cc * SIZE:(cc + 1) * SIZE]
            grid[rr * SIZE:(rr + 1) * SIZE, cc * SIZE:(cc + 1) * SIZE] = tile[..., :3] * a + cell * (1 - a)
        path = os.path.join(opts['preview'], 'sheet_items.png')
        C.save_image(path, grid, 'PNG')
        print(f'PREVIEW {path}')
    elif not opts['preview']:
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)


main()
