// The interactables of a level (SPEC-054 §3, §4.1): the pad terminal, the
// descent and the exit shaft, the caches and the vault, SPEC-055's relic
// terminals, mirrors and panels, and SPEC-058's predecessor's body — each a
// circle the player stands in to act. Pure, so the scene's prompt
// (`#interactHint`) and its `interact` press read the same answer.

export type InteractKind = 'pad' | 'descent' | 'exit' | 'cache' | 'vault' | 'relic' | 'mirror' | 'panel' | 'body';

export interface Interactable {
  kind: InteractKind;
  id: string;
  x: number;
  z: number;
  radius: number;
}

/** §3: the tie-break — the kinds in the order `InteractKind` lists them, lower wins. */
const KIND_ORDER: Readonly<Record<InteractKind, number>> = {
  pad: 0,
  descent: 1,
  exit: 2,
  cache: 3,
  vault: 4,
  relic: 5,
  mirror: 6,
  panel: 7,
  body: 8,
};

/**
 * The interactable whose circle holds `(x, z)` (its rim included), nearest
 * centre first; at the same distance the kind listed first in `InteractKind`
 * wins, then the earlier entry. `null` outside every circle. Never allocates.
 *
 * SPEC-058's body never hides a way: anywhere inside a `descent`'s or an
 * `exit`'s own circle, that wins over a body, however near the body's centre.
 * A predecessor who last died below lies at the descent, and nearest-centre
 * gave about half the descent's circle to "Search the body" (review 2026-10,
 * B-17).
 */
export function nearestInteractable(list: readonly Interactable[], x: number, z: number): Interactable | null {
  let best: Interactable | null = null;
  let bestD = Infinity;
  let way: Interactable | null = null;
  let wayD = Infinity;
  for (let i = 0; i < list.length; i++) {
    const it = list[i] as Interactable;
    const dx = it.x - x;
    const dz = it.z - z;
    const d = dx * dx + dz * dz;
    if (d > it.radius * it.radius) continue;
    if ((it.kind === 'descent' || it.kind === 'exit') && d < wayD) {
      way = it;
      wayD = d;
    }
    if (d < bestD || (d === bestD && best !== null && KIND_ORDER[it.kind] < KIND_ORDER[best.kind])) {
      best = it;
      bestD = d;
    }
  }
  return best !== null && best.kind === 'body' && way !== null ? way : best;
}
