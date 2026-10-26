# PLAN R30 — the Refit: before and after

Every DOM screen and both HUDs, captured headless in full Chromium on the Mac's GPU (`--use-angle=metal`, `medium` preset, `films=off`, `seed=123`). The same script drove both sets, so each pair shows the same state:

- `before/`: `main` at 759fe78, 2026-10-26.
- `after/`: `feat/ui-redesign` (PLAN R30, SPEC-073).

Desktop is 1440 × 900 at 1×. The phone is a Pixel 5 profile on its side, 844 × 390 at 2×, with touch.

| Screen | Desktop | Phone |
|---|---|---|
| Boot card | `desktop-01-boot.jpg` | `phone-01-boot.jpg` |
| Main menu | `desktop-02-menu.jpg` | `phone-02-menu.jpg` |
| Settings over the menu | `desktop-03-settings.jpg` | `phone-03-settings.jpg` |
| Creation | `desktop-04-creation.jpg` | `phone-04-creation.jpg` |
| Station: Missions, Shop, Character, Depot, Comms log | `desktop-05-station-*.jpg` | `phone-05-station-*.jpg` |
| Star map | `desktop-06-starmap.jpg` | `phone-06-starmap.jpg` |
| Surface HUD | `desktop-07-surface-hud.jpg` | `phone-07-surface-hud.jpg` |
| Toasts in play | `desktop-08-toasts.jpg` | `phone-08-toasts.jpg` |
| Dialogue | `desktop-09-dialogue.jpg` | `phone-09-dialogue.jpg` |
| Pause | `desktop-10-pause.jpg` | `phone-10-pause.jpg` |
| Flight HUD (two moments) | `desktop-11/12-flight-hud*.jpg` | `phone-11/12-flight-hud*.jpg` |
| Death (`?debug`, so the stats strip shows) | `desktop-13-death.jpg` | `phone-13-death.jpg` |

The design these implement is in Claude Design: the system "ReaLLM" (https://claude.ai/artifact/Rf4B6fo2AuE4hNssJzfYVV) and the screens (https://claude.ai/artifact/6CzdDyX3gqKeHerEkAzU9s).
