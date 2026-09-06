# Playtest log

One section per milestone (SPEC-016 §3): the devices it was verified on, the
build, measured fps and draw calls, the checklist results, and the bugs found.
A milestone tag (`m0`…`m7`) requires `npm run check` green, the checklists
ticked here for desktop and one phone, zero open P0, and spec statuses updated
(SPEC-001 §11, SPEC-016 §6).

## M0 — bootstrap

- **Build:** _commit / tag_
- **Devices:** desktop _(browser, OS)_ · phone _(model, OS, browser)_
- **Measurements:** fps _—_ · draw calls _—_ · update ms _—_ · render ms _—_
- **Checklist (SPEC-001):**
  - [ ] `npm ci && npm run check` green on a clean clone
  - [ ] `npm run e2e` green headless
  - [ ] `npm run dev` serves `ReaLLM` on 5173, canvas and `#ui` overlay present, opens on a phone over LAN
  - [ ] architecture tests pass (import boundaries, `Math.random` ban)
- **Checklist (SPEC-002, once merged):** rotating test object on desktop and phone; tab hide/show and context loss recover cleanly
- **Bugs:** _P0 / P1 / P2 with links_
- **Notes:**
