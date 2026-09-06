# Asset licenses

Every file under `public/assets/` is listed here with its source, license and
modifications (SPEC-001 §10). Everything shipped is **CC0** (public domain).
Budget: precached assets ≤ 25 MB in total, models ≤ 4 MB, audio ≤ 12 MB,
textures ≤ 6 MB.

| File | Source | License | Modifications |
| --- | --- | --- | --- |
| `models/crate.glb` | Original to this repository — a unit box generated with `three`'s `GLTFExporter` | CC0 | — |
| `textures/grid.png` | Original to this repository — 64×64 panel grid, generated procedurally | CC0 | — |
| `textures/noise.png` | Original to this repository — 64×64 value-noise mask (non-colour data), generated procedurally | CC0 | — |

The three files above are the manifest's first entries (SPEC-003 §4.3): they
exist so boot loads something real. The Kenney packs land with the scenes that
need them.

Outside this folder: `public/favicon.svg` is original to this repository, CC0.
