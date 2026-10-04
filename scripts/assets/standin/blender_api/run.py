# Runs one of scripts/assets/blender/<generator>.py without Blender: the
# modules beside this file stand in for `bpy`, `bmesh`, `mathutils` (and an
# empty `numpy`), so the generator's own builders make the geometry and
# gltf.py writes it. scripts/assets/standin/build.mjs is the entry point:
#
#   python3 run.py <generator.py> -- --out=<public/assets> [only…]
import os
import runpy
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
script = os.path.abspath(sys.argv[1])
# What Blender's argv looks like, so common.options() finds the `--`.
sys.argv = ['blender', '--background', '--python', script] + sys.argv[2:]
runpy.run_path(script, run_name='__main__')
