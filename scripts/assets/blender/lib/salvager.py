# The salvager — the player character (SPEC-019 §4.1) and the portrait busts
# (SPEC-020 §4.6). An armoured EVA suit with a glowing visor, big shoulder
# pads and a backpack that read from the 55° surface camera, holding a rifle at
# the hip. Heroic, chunky proportions: at 28 m the silhouette is what reads.
# Rigid skinning: every part is weighted 1.0 to one bone, so joints hide under
# pads and balls rather than blending.
#
# One material, one draw call. Colours come from a 4 × 4 palette texture (each
# part's UVs sit on one cell centre): base colour, metallic-roughness and
# emissive share the layout. The suit and armour cells are light greys so the
# runtime tint (`material.color = appearance.primary`) reads as the suit colour;
# dark cells stay dark; visor and lamps are emissive.
import numpy as np
from mathutils import Vector

import common as C

# name, head, tail, parent — Blender coordinates (Z up, the model faces −Y).
BONES = [
    ('root', (0, 0, 0), (0, 0.15, 0), None),
    ('hips', (0, 0, 0.93), (0, 0, 1.05), 'root'),
    ('spine', (0, 0, 1.05), (0, 0, 1.40), 'hips'),
    ('head', (0, 0, 1.44), (0, 0, 1.74), 'spine'),
    ('upper_arm.R', (-0.25, 0.01, 1.37), (-0.29, -0.05, 1.13), 'spine'),
    ('forearm.R', (-0.29, -0.05, 1.13), (-0.15, -0.29, 1.06), 'upper_arm.R'),
    ('hand.R', (-0.15, -0.29, 1.06), (-0.13, -0.37, 1.05), 'forearm.R'),
    ('upper_arm.L', (0.25, 0.01, 1.37), (0.22, -0.15, 1.14), 'spine'),
    ('forearm.L', (0.22, -0.15, 1.14), (-0.06, -0.49, 1.09), 'upper_arm.L'),
    ('hand.L', (-0.06, -0.49, 1.09), (-0.08, -0.57, 1.09), 'forearm.L'),
    ('thigh.R', (-0.12, 0, 0.92), (-0.13, -0.02, 0.50), 'hips'),
    ('shin.R', (-0.13, -0.02, 0.50), (-0.13, 0.03, 0.10), 'thigh.R'),
    ('foot.R', (-0.13, 0.03, 0.10), (-0.13, -0.15, 0.03), 'shin.R'),
    ('thigh.L', (0.12, 0, 0.92), (0.13, -0.02, 0.50), 'hips'),
    ('shin.L', (0.13, -0.02, 0.50), (0.13, 0.03, 0.10), 'thigh.L'),
    ('foot.L', (0.13, 0.03, 0.10), (0.13, -0.15, 0.03), 'shin.L'),
]
BONE = {name: (head, tail) for name, head, tail, _ in BONES}

# cell index, base colour (sRGB hex or grey), roughness, metalness, emissive (sRGB hex) or None
CELLS = {
    'suit': (0, 0.72, 0.80, 0.00, None),
    'armor': (1, 0.93, 0.40, 0.15, None),
    'under': (2, 0.17, 0.85, 0.00, None),
    'glove': (3, 0.13, 0.70, 0.05, None),
    'metal': (4, 0.26, 0.34, 0.85, None),
    'visor': (5, 0.03, 0.08, 0.60, '#39d7ff'),
    'glow': (6, 0.90, 0.30, 0.00, '#39d7ff'),
    'detail': (7, 0.52, 0.32, 0.60, None),
    'sole': (8, 0.07, 0.90, 0.00, None),
    'glass': (9, 0.05, 0.05, 0.90, None),
    'warm': (10, 0.90, 0.35, 0.00, '#ffae42'),
}


def uv(cell):
    i = CELLS[cell][0]
    return ((i % 4 + 0.5) / 4, (i // 4 + 0.5) / 4)


def palette_material(name='Salvager', overrides=None, strength=3.0):
    """The palette images and the one material. `overrides` swaps cell values (portraits)."""
    cells = dict(CELLS)
    cells.update(overrides or {})
    base = np.zeros((16, 16, 4), np.float32)
    orm = np.zeros_like(base)
    emi = np.zeros_like(base)
    base[..., 3] = orm[..., 3] = emi[..., 3] = 1.0
    orm[..., 0] = 1.0
    for index, colour, rough, metal, glow in cells.values():
        r0, c0 = (index // 4) * 4, (index % 4) * 4  # Blender image rows start at the bottom
        rgb = C.hex_rgb(colour) if isinstance(colour, str) else (colour,) * 3
        base[r0:r0 + 4, c0:c0 + 4, :3] = rgb
        orm[r0:r0 + 4, c0:c0 + 4, 1] = rough
        orm[r0:r0 + 4, c0:c0 + 4, 2] = metal
        if glow:
            emi[r0:r0 + 4, c0:c0 + 4, :3] = C.hex_rgb(glow)
    return C.mat_textured(
        name,
        C.image_from_array(f'{name}_base', base, 'sRGB'),
        C.image_from_array(f'{name}_orm', orm, 'Non-Color'),
        C.image_from_array(f'{name}_emissive', emi, 'sRGB'),
        strength=strength, closest=True)


def _limb(b, bone, r1, r2, cell, n=8, inset=(0.0, 0.0)):
    """A tapered cylinder filling a bone (shortened by `inset` at head/tail)."""
    head, tail = Vector(BONE[bone][0]), Vector(BONE[bone][1])
    d = (tail - head).normalized()
    h, t = head + d * inset[0], tail - d * inset[1]
    b.add(C.along(C.cyl(r1, r2, (t - h).length, n=n), h, t), uv=uv(cell), bone=bone)


def body(b, helmet='crest'):
    """Add every part to Builder `b`. helmet: crest | antenna | goggles | hood."""
    box, cyl, sphere, place = C.box, C.cyl, C.sphere, C.place

    # hips: pelvis, belt, pouches, front plate
    b.add(place(box(0.33, 0.22, 0.15, 0.03), (0, 0, 0.96)), uv=uv('under'), bone='hips')
    b.add(place(box(0.37, 0.26, 0.055), (0, 0, 1.035)), uv=uv('metal'), bone='hips')
    for x in (-0.175, 0.175):
        b.add(place(box(0.075, 0.08, 0.09), (x, -0.07, 1.00)), uv=uv('suit'), bone='hips')
    b.add(place(box(0.11, 0.08, 0.10), (0.07, 0.13, 1.00)), uv=uv('detail'), bone='hips')
    b.add(place(box(0.16, 0.045, 0.13, 0.015), (0, -0.115, 0.94), (-6, 0, 0)), uv=uv('armor'), bone='hips')

    # torso: abdomen, chest, plates, lamps, collar
    b.add(place(cyl(0.145, 0.165, 0.16, n=10), (0, 0, 1.11)), uv=uv('under'), bone='spine')
    b.add(place(box(0.41, 0.27, 0.28, 0.045), (0, 0.0, 1.27)), uv=uv('suit'), bone='spine')
    b.add(place(box(0.34, 0.065, 0.20, 0.025), (0, -0.135, 1.285), (-8, 0, 0)), uv=uv('armor'), bone='spine')
    b.add(place(box(0.065, 0.02, 0.035), (0.095, -0.175, 1.335), (-8, 0, 0)), uv=uv('glow'), bone='spine')
    b.add(place(box(0.035, 0.02, 0.035), (-0.10, -0.172, 1.335), (-8, 0, 0)), uv=uv('warm'), bone='spine')
    b.add(place(C.torus(0.10, 0.034, n=12, m=6), (0, 0, 1.415)), uv=uv('under'), bone='spine')
    # shoulder pads — the silhouette from above
    for side in (-1, 1):
        b.add(place(box(0.20, 0.24, 0.11, 0.045), (0.285 * side, 0.0, 1.41), (0, 16 * side, 0)), uv=uv('armor'), bone='spine')
        b.add(place(box(0.14, 0.18, 0.022), (0.32 * side, 0.0, 1.345), (0, 16 * side, 0)), uv=uv('detail'), bone='spine')
    # backpack: frame, twin tanks, glowing core, light bar, antenna with an amber tip
    b.add(place(box(0.34, 0.15, 0.36, 0.035), (0, 0.185, 1.245)), uv=uv('detail'), bone='spine')
    for x in (-0.105, 0.105):
        b.add(place(cyl(0.058, 0.058, 0.32, n=8), (x, 0.275, 1.25)), uv=uv('armor'), bone='spine')
    b.add(place(cyl(0.034, 0.034, 0.24, n=6), (0, 0.268, 1.25)), uv=uv('glow'), bone='spine', smooth=None)
    b.add(place(box(0.24, 0.04, 0.025), (0, 0.225, 1.435)), uv=uv('glow'), bone='spine')
    b.add(place(cyl(0.009, 0.009, 0.28, n=5), (0.13, 0.235, 1.54)), uv=uv('metal'), bone='spine')
    b.add(place(sphere(0.02, 6, 4), (0.13, 0.235, 1.685)), uv=uv('warm'), bone='spine')

    # head: neck, helmet shell, visor bubble, chin guard, ear pods, style
    b.add(place(cyl(0.065, 0.07, 0.09, n=8), (0, 0, 1.465)), uv=uv('under'), bone='head')
    b.add(place(sphere(0.165, 14, 10), (0, 0.006, 1.605), scale=(1.0, 1.06, 1.0)), uv=uv('armor'), bone='head', smooth=70)
    b.add(place(sphere(0.125, 16, 10), (0, -0.094, 1.597), scale=(1.06, 0.64, 0.8)), uv=uv('visor'), bone='head', smooth=80)
    b.add(place(box(0.18, 0.085, 0.055, 0.02), (0, -0.104, 1.49), (8, 0, 0)), uv=uv('armor'), bone='head')
    for side in (-1, 1):
        b.add(place(cyl(0.05, 0.05, 0.05, n=8), (0.166 * side, 0.0, 1.595), (0, 90, 0)), uv=uv('detail'), bone='head')
    b.add(place(sphere(0.013, 6, 4), (0.196, -0.02, 1.617)), uv=uv('warm'), bone='head')
    if helmet == 'crest':
        b.add(place(box(0.04, 0.29, 0.055, 0.012), (0, 0.012, 1.77)), uv=uv('suit'), bone='head')
    elif helmet == 'antenna':
        for side in (-1, 1):
            b.add(place(cyl(0.007, 0.004, 0.24, n=5), (0.14 * side, 0.05, 1.73), (-20, 18 * side, 0)), uv=uv('metal'), bone='head')
            b.add(place(sphere(0.014, 6, 4), (0.165 * side, 0.09, 1.84)), uv=uv('warm'), bone='head')
    elif helmet == 'goggles':
        for side in (-1, 1):
            b.add(place(cyl(0.038, 0.038, 0.05, n=10), (0.058 * side, -0.15, 1.64), (90, 0, 0)), uv=uv('glass'), bone='head')
        b.add(place(C.torus(0.165, 0.013, n=16, m=4), (0, -0.01, 1.645), scale=(1.0, 1.06, 1.0)), uv=uv('metal'), bone='head')
        b.add(place(sphere(0.022, 6, 4), (0, -0.165, 1.73)), uv=uv('warm'), bone='head')
    elif helmet == 'hood':
        b.add(place(sphere(0.185, 12, 8), (0, 0.035, 1.62), scale=(1.02, 1.1, 1.05)), uv=uv('suit'), bone='head', smooth=70)

    # arms: sleeve, shoulder ball, elbow ball, gauntlet, glove
    for s in ('R', 'L'):
        ua, fa, hd = f'upper_arm.{s}', f'forearm.{s}', f'hand.{s}'
        _limb(b, ua, 0.068, 0.06, 'under', inset=(0.02, 0.0))
        b.add(place(sphere(0.072, 8, 6), BONE[ua][0]), uv=uv('under'), bone=ua, smooth=80)
        b.add(place(sphere(0.066, 8, 6), BONE[fa][0]), uv=uv('under'), bone=fa, smooth=80)
        _limb(b, fa, 0.06, 0.074, 'armor', n=8, inset=(0.04, 0.02))
        head, tail = BONE[hd]
        b.add(C.along(box(0.085, 0.075, 0.11, 0.015), head, tail), uv=uv('glove'), bone=hd)

    # legs: thigh with plate, knee pad, boot shaft, shin guard, boot, sole
    for s, side in (('R', -1), ('L', 1)):
        th, sh, ft = f'thigh.{s}', f'shin.{s}', f'foot.{s}'
        _limb(b, th, 0.10, 0.08, 'suit', inset=(0.0, 0.03))
        h, t = BONE[th]
        plate = C.along(box(0.09, 0.055, 0.27, 0.015), h, t)
        C.place(plate, (0.04 * side, -0.06, -0.03))
        b.add(plate, uv=uv('armor'), bone=th)
        b.add(place(box(0.125, 0.09, 0.11, 0.03), (BONE[sh][0][0], -0.085, 0.50)), uv=uv('armor'), bone=sh)
        _limb(b, sh, 0.082, 0.09, 'glove', inset=(0.05, 0.0))
        h, t = BONE[sh]
        guard = C.along(box(0.095, 0.045, 0.26), h, t)
        C.place(guard, (0, -0.08, 0.02))
        b.add(guard, uv=uv('armor'), bone=sh)
        x = BONE[ft][0][0]
        b.add(place(box(0.135, 0.27, 0.115, 0.03), (x, -0.05, 0.075)), uv=uv('glove'), bone=ft)
        b.add(place(box(0.145, 0.28, 0.035), (x, -0.05, 0.0175)), uv=uv('sole'), bone=ft)

    # rifle in the right hand, held at the hip, muzzle forward (−Y)
    gx = -0.12
    b.add(place(box(0.075, 0.46, 0.115, 0.012), (gx, -0.36, 1.10)), uv=uv('metal'), bone='hand.R')
    b.add(place(box(0.056, 0.22, 0.068), (gx, -0.60, 1.118)), uv=uv('detail'), bone='hand.R')
    b.add(place(cyl(0.019, 0.019, 0.32, n=6), (gx, -0.74, 1.12), (90, 0, 0)), uv=uv('metal'), bone='hand.R')
    b.add(place(cyl(0.029, 0.029, 0.05, n=6), (gx, -0.9, 1.12), (90, 0, 0)), uv=uv('metal'), bone='hand.R')
    b.add(place(box(0.052, 0.20, 0.095), (gx, -0.06, 1.07), (6, 0, 0)), uv=uv('detail'), bone='hand.R')
    b.add(place(box(0.042, 0.075, 0.155), (gx, -0.41, 1.00), (-14, 0, 0)), uv=uv('metal'), bone='hand.R')
    b.add(place(box(0.038, 0.055, 0.105), (gx, -0.27, 1.02), (18, 0, 0)), uv=uv('glove'), bone='hand.R')
    b.add(place(cyl(0.024, 0.024, 0.15, n=8), (gx, -0.34, 1.195), (90, 0, 0)), uv=uv('metal'), bone='hand.R')
    b.add(place(cyl(0.021, 0.021, 0.005, n=8), (gx, -0.418, 1.195), (90, 0, 0)), uv=uv('glass'), bone='hand.R', smooth=None)
    b.add(place(box(0.08, 0.17, 0.016), (gx, -0.45, 1.085)), uv=uv('glow'), bone='hand.R')


def build(helmet='crest', overrides=None, name='Salvager', strength=3.0):
    """Armature + skinned mesh, rest pose holding the rifle. Returns (armature, mesh).
    `strength` is the emissive strength: 3 glows under the game's bloom, a
    close-up render wants about 1."""
    import bpy
    arm_data = bpy.data.armatures.new(f'{name}Rig')
    arm = C.link(bpy.data.objects.new(name, arm_data))
    bpy.context.view_layer.objects.active = arm
    arm.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    for bone_name, head, tail, parent in BONES:
        eb = arm_data.edit_bones.new(bone_name)
        eb.head, eb.tail, eb.roll = head, tail, 0.0
        if parent:
            eb.parent = arm_data.edit_bones[parent]
            eb.use_connect = False
    bpy.ops.object.mode_set(mode='OBJECT')
    arm_data.bones['root'].use_deform = False

    b = C.Builder(vcol=False)
    body(b, helmet)
    mesh = b.object(f'{name}Mesh', [palette_material(f'{name}', overrides, strength)], parent=arm)
    mod = mesh.modifiers.new('Armature', 'ARMATURE')
    mod.object = arm
    return arm, mesh
