# QA renders (not shipped): a lit 3/4 view of any objects, and contact sheets.
# `--preview=<dir>` on build.mjs turns them on; the art is judged from these.
import math
import os

import bpy
import numpy as np
from mathutils import Vector

import common as C


def _bounds(objs):
    deps = bpy.context.evaluated_depsgraph_get()
    lo = Vector((1e9, 1e9, 1e9))
    hi = -lo
    for obj in objs:
        if obj.type != 'MESH':
            continue
        ev = obj.evaluated_get(deps)
        mesh = ev.to_mesh()
        for v in mesh.vertices:
            w = ev.matrix_world @ v.co
            lo = Vector(map(min, lo, w))
            hi = Vector(map(max, hi, w))
        ev.to_mesh_clear()
    return lo, hi


def _rig(scene, bg):
    world = bpy.data.worlds.new('PreviewWorld')
    world.use_nodes = True
    back = next(n for n in world.node_tree.nodes if n.type == 'BACKGROUND')
    back.inputs['Color'].default_value = C.lin(bg)
    back.inputs['Strength'].default_value = 1.0
    scene.world = world
    made = []
    for name, kind, energy, colour, rot in (
        ('key', 'SUN', 3.2, '#fff1dc', (50, 0, -35)),
        ('rim', 'SUN', 2.2, '#8fb4ff', (60, 0, 150)),
        ('fill', 'SUN', 0.7, '#ffffff', (70, 0, 60)),
    ):
        light = bpy.data.lights.new(name, kind)
        light.energy = energy
        light.color = C.lin(colour)[:3]
        obj = C.link(bpy.data.objects.new(name, light))
        obj.rotation_euler = [math.radians(a) for a in rot]
        made.append(obj)
    return made


def render(objs, path, azimuth=35.0, elevation=16.0, size=384, bg='#1a2029', margin=1.12, focus=None):
    """Frame `objs` (or the box `focus`) from azimuth/elevation (deg, 0 = front, −Y)."""
    scene = bpy.context.scene
    scene.render.engine = 'BLENDER_EEVEE'
    scene.render.resolution_x = scene.render.resolution_y = size
    scene.render.image_settings.file_format = 'PNG'
    scene.render.film_transparent = False
    scene.view_settings.view_transform = 'AgX'
    lights = _rig(scene, bg)
    lo, hi = focus if focus is not None else _bounds(objs)
    centre = (lo + hi) / 2
    radius = max((hi - lo).length / 2, 0.05)
    cam_data = bpy.data.cameras.new('preview')
    cam_data.lens = 60
    cam = C.link(bpy.data.objects.new('preview', cam_data))
    fov = 2 * math.atan(18 / cam_data.lens)
    dist = radius * margin / math.sin(fov / 2)
    az, el = math.radians(azimuth), math.radians(elevation)
    cam.location = centre + Vector((math.sin(az) * math.cos(el), -math.cos(az) * math.cos(el), math.sin(el))) * dist
    cam.rotation_euler = (centre - cam.location).to_track_quat('-Z', 'Y').to_euler()
    cam_data.clip_end = dist * 4
    scene.camera = cam
    scene.render.filepath = C.ensure_dir(path)
    bpy.ops.render.render(write_still=True)
    for obj in lights + [cam]:
        bpy.data.objects.remove(obj, do_unlink=True)
    scene.view_settings.view_transform = 'Standard'
    print(f'PREVIEW {path}')
    return path


def sheet(paths, out, cols=4, label_bg=(0.1, 0.12, 0.15)):
    """Tile PNG renders into one sheet (row-major, top-left first)."""
    tiles = []
    for p in paths:
        img = bpy.data.images.load(p)
        img.colorspace_settings.name = 'Non-Color'
        w, h = img.size
        a = np.array(img.pixels[:], dtype=np.float32).reshape(h, w, 4)[::-1]
        tiles.append(a)
        bpy.data.images.remove(img)
    h, w = tiles[0].shape[:2]
    rows = math.ceil(len(tiles) / cols)
    grid = np.zeros((rows * h, cols * w, 4), np.float32)
    grid[..., :3] = label_bg
    grid[..., 3] = 1
    for i, t in enumerate(tiles):
        r, c = divmod(i, cols)
        grid[r * h:(r + 1) * h, c * w:(c + 1) * w] = t[:h, :w]
    img = bpy.data.images.new(os.path.basename(out), grid.shape[1], grid.shape[0], alpha=True)
    img.colorspace_settings.name = 'Non-Color'
    img.pixels.foreach_set(np.ascontiguousarray(grid[::-1]).ravel())
    img.filepath_raw = C.ensure_dir(out)
    img.file_format = 'PNG'
    img.save()
    print(f'PREVIEW {out}')
    return out
