// SPEC-034 §4.4 — the autopilot the Gauntlet test flies with.
//
// A deterministic function of `(flight, rng, aim)`, called once per 1/60 s step
// *before* `flight.update`. It is not an AI: it is the floor a competent pilot
// stands on, so a claim about whether a trip can be won is a claim about the
// trip's numbers rather than about who is holding the stick. `aim: 'none'` never
// leads its target — the worst a paying player is expected to do — and
// `aim: 'lead'` fires where the target will be.
import type { Rng } from '@/core/Rng';
import { CONVERGE_DEPTH, RAIL, SHIP_RADIUS, type Flight, type FlightInput, type Hazard } from '@/systems/Flight';

export type PilotAim = 'lead' | 'none';

/** §4.4 step 1: a hazard inside this depth is worth dodging. */
const THREAT_DEPTH = 70;
/** …and counts as a threat within this much of the ship's own circle. */
const THREAT_MARGIN = 0.8;
/** The steer weight a threat contributes, before the clamp to ±1. */
const AVOID_WEIGHT = 3;
/** With nothing to dodge, the pilot drifts back toward the middle. */
const CENTRE_PULL = 0.05;
/** §4.4 step 2: a target below this depth is past saving; pick another. */
const TARGET_MIN_DEPTH = 5;
/** `none` scatters its aim by this much, uniformly, from the seeded stream. */
const NO_LEAD_NOISE = 0.3;

export class Pilot {
  readonly #rng: Rng;
  readonly #aim: PilotAim;
  /** The hazard being shot at, kept until it dies or passes `TARGET_MIN_DEPTH`. */
  #target: Hazard | null = null;

  constructor(rng: Rng, aim: PilotAim) {
    this.#rng = rng;
    this.#aim = aim;
  }

  /** The input for this step. Reads `flight`; mutates nothing but its own state. */
  frame(flight: Flight): FlightInput {
    const ship = flight.ship;
    let steerX = 0;
    let steerY = 0;
    let threats = 0;

    // 1. Dodge: every closing hazard whose predicted position overlaps the ship.
    for (let i = 0; i < flight.hazards.size; i++) {
      const hazard = flight.hazards.at(i);
      // A fighter holds its depth and shoots; its bullets are the threat, not it.
      if (hazard.kind === 'fighter') continue;
      if (hazard.depth <= 0 || hazard.depth > THREAT_DEPTH) continue;
      const eta = Math.max(0.05, (hazard.depth - RAIL.hitDepth) / Math.max(1, -hazard.vDepth));
      const px = hazard.x + hazard.vx * eta;
      const py = hazard.y + hazard.vy * eta;
      const need = hazard.radius + SHIP_RADIUS + THREAT_MARGIN;
      const dx = ship.x - px;
      const dy = ship.y - py;
      const d = Math.hypot(dx, dy);
      if (d >= need) continue;
      threats++;
      const weight = AVOID_WEIGHT * ((need - d) / need + 0.5);
      // Straight away from it; a dead-centre hit breaks the tie sideways.
      const ux = d < 1e-6 ? 1 : dx / d;
      const uy = d < 1e-6 ? 0 : dy / d;
      steerX += ux * weight;
      steerY += uy * weight;
    }
    if (threats === 0) {
      steerX = -CENTRE_PULL * ship.x;
      steerY = -CENTRE_PULL * ship.y;
    }

    // 2. Aim: the deepest ship above `TARGET_MIN_DEPTH`, held until it is gone.
    const target = this.#pickTarget(flight);
    let aimX = 0;
    let aimY = 0;
    if (target !== null) {
      let tx = target.x;
      let ty = target.y;
      let depth = target.depth;
      if (this.#aim === 'lead') {
        // Where it will be when a shot fired now arrives: the closing speeds add.
        const t = depth / Math.max(1, RAIL.laserSpeed - target.vDepth);
        tx += target.vx * t;
        ty += target.vy * t;
        depth += target.vDepth * t;
      }
      // The reticle is a plane position at `CONVERGE_DEPTH`, and a shot leaves
      // the ship's nose, so the projection runs from the ship — the same line
      // `Flight`'s own aim assist takes (§4.7). Projecting from the origin
      // instead puts the aim off by the ship's own offset once it leaves the
      // middle, which at depth 40 is twice that offset on the target.
      const scale = CONVERGE_DEPTH / Math.max(TARGET_MIN_DEPTH, depth);
      aimX = ship.x + (tx - ship.x) * scale;
      aimY = ship.y + (ty - ship.y) * scale;
      if (this.#aim === 'none') {
        aimX += this.#rng.float(-NO_LEAD_NOISE, NO_LEAD_NOISE);
        aimY += this.#rng.float(-NO_LEAD_NOISE, NO_LEAD_NOISE);
      }
    }

    return {
      steerX: clamp1(steerX),
      steerY: clamp1(steerY),
      fire: target !== null,
      aimX,
      aimY,
      // 3. Throttle stays at 1: the trip is flown, not crawled through.
      throttleUp: false,
      throttleDown: false,
    };
  }

  /** The fighter or interceptor with the greatest depth above `TARGET_MIN_DEPTH`. */
  #pickTarget(flight: Flight): Hazard | null {
    const held = this.#target;
    if (held !== null && held.hp > 0 && held.depth > TARGET_MIN_DEPTH && this.#alive(flight, held)) return held;
    let best: Hazard | null = null;
    for (let i = 0; i < flight.hazards.size; i++) {
      const hazard = flight.hazards.at(i);
      if (hazard.kind !== 'fighter' && hazard.kind !== 'interceptor') continue;
      if (hazard.depth <= TARGET_MIN_DEPTH) continue;
      if (best === null || hazard.depth > best.depth) best = hazard;
    }
    this.#target = best;
    return best;
  }

  /** The pool swap-removes, so a kept reference has to be found again. */
  #alive(flight: Flight, hazard: Hazard): boolean {
    for (let i = 0; i < flight.hazards.size; i++) {
      if (flight.hazards.at(i) === hazard) return true;
    }
    return false;
  }
}

function clamp1(v: number): number {
  return Math.max(-1, Math.min(1, v));
}
