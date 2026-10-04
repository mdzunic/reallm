# The container has no numpy. The geometry generators import it (through
# lib/common.py) but only use it for images, which the stand-in paints in Node
# instead (scripts/assets/standin/*.mjs) — so any use of it here is a mistake.


def __getattr__(name):
    raise AttributeError(f'numpy.{name}: numpy is not available to the stand-in build (scripts/assets/README.md §7)')
