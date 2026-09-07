// The pure half of the audio layer (SPEC-006 §3, §4.2). Voice limiting, rate
// limiting, distance attenuation, pitch variation and the ramp curve live here
// so they are unit-testable in node: nothing in this file imports `howler`, or
// touches a browser API, or reads a clock — `now` is always passed in
// (SPEC-006 AC-56).
//
// `core/Audio.ts` is the only caller. It owns the Howler side and hands these
// helpers the numbers they work on.
import type { SoundId } from '@/data/assets';

/** Concurrent SFX voices (§4.2). The 25th steals or is refused. */
export const VOICE_LIMIT = 24;
/** Per-`SoundId` cooldown when `opts.minIntervalMs` is omitted (§4.2). */
export const DEFAULT_MIN_INTERVAL_MS = 50;
/** A positioned sound at or beyond this many metres is not played (§4.2, AC-35). */
export const MAX_AUDIBLE_DISTANCE = 45;
/** Pitch variation is `1 ± PITCH_SPREAD` (§4.2). */
export const PITCH_SPREAD = 0.06;

/** Inside this radius a sound is at full gain (§4.2). */
export const ATTENUATION_NEAR = 8;
/** Metres from full gain to the floor. */
export const ATTENUATION_RANGE = 32;
/** Never silent, so a distant swarm is still legible as pressure. */
export const ATTENUATION_FLOOR = 0.15;

/** `0` ambient/looped, `1` the default, `2` high (§4.2). */
export type Priority = 0 | 1 | 2;

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/**
 * `clamp(1 - (d - 8) / 32, 0.15, 1)` (§4.2, AC-34): 1 out to 8 m, then a linear
 * fall to the 0.15 floor at 40 m. Callers drop the sound entirely at
 * `d >= MAX_AUDIBLE_DISTANCE` before ever asking for a gain (AC-35).
 */
export function attenuation(d: number): number {
  return clamp(1 - (d - ATTENUATION_NEAR) / ATTENUATION_RANGE, ATTENUATION_FLOOR, 1);
}

/** Distance on the XZ plane gameplay runs on (SPEC-001 §7). */
export function distanceXZ(ax: number, az: number, bx: number, bz: number): number {
  return Math.hypot(ax - bx, az - bz);
}

/**
 * `1 ± PITCH_SPREAD` from a `[0, 1)` draw, so forty skitters dying at once do
 * not phase into one flat tone (§4.2, AC-37). The draw comes from an `Rng`
 * stream; `Math.random` is banned (SPEC-001 §7).
 */
export function pitchFor(draw: number): number {
  return 1 + (clamp(draw, 0, 1) * 2 - 1) * PITCH_SPREAD;
}

/**
 * The sounds that get pitch variation when the caller passes no explicit
 * `rate` (§4.2) — the ones that fire in bursts.
 */
export const PITCH_VARIED: ReadonlySet<SoundId> = new Set<SoundId>([
  'bug_pop',
  'raider_death',
  'wraith_death',
  'elite_death',
  'enemy_death_generic',
  'hit_player',
  'ship_hit_shield',
  'ship_hit_hull',
]);

/**
 * Linear interpolation from `from` to `to` over `durationMs`, clamped at both
 * ends. The one ramp curve in the audio layer: crossfades, duck and un-duck all
 * use it, so a duck applied mid-crossfade composes with the fade instead of
 * fighting it (the reason `Howl.fade` — which writes an absolute volume — is
 * not used for either).
 */
export function rampValue(from: number, to: number, elapsedMs: number, durationMs: number): number {
  if (!(durationMs > 0)) return to;
  return from + (to - from) * clamp(elapsedMs / durationMs, 0, 1);
}

/** One admitted voice, in admission order. `id` is the caller's voice key. */
export interface VoiceRecord {
  readonly id: string;
  readonly priority: Priority;
  readonly startedAt: number;
}

/**
 * The 24-voice cap of §4.2 as pure bookkeeping: no timers, no Howler, and `now`
 * passed in so tests drive the clock.
 *
 * At the limit a new sound steals the **oldest** voice of **strictly lower**
 * priority — 2 steals 1 or 0, 1 steals 0, 0 steals nothing — and is refused
 * when there is no such voice (AC-30, AC-31). "Strictly lower" is what keeps a
 * swarm of same-priority pops from cannibalising itself.
 */
export class VoiceLimiter {
  /** Insertion-ordered, which is admission order — the tie-break for `startedAt`. */
  readonly #voices = new Map<string, VoiceRecord>();
  readonly #limit: number;

  constructor(limit: number = VOICE_LIMIT) {
    this.#limit = Math.max(0, Math.floor(limit));
  }

  get size(): number {
    return this.#voices.size;
  }

  /** The keys currently held, oldest first. */
  keys(): string[] {
    return [...this.#voices.keys()];
  }

  /**
   * Reserve a slot for `id`. `{ evict: null }` means there was room,
   * `{ evict: key }` means the caller must stop `key` first, and `false` means
   * refuse the sound. A returned `evict` is already released here, so the
   * caller never has to `release` it as well.
   */
  admit(id: string, priority: Priority, now: number): { evict: string | null } | false {
    if (this.#voices.size < this.#limit) {
      this.#voices.set(id, { id, priority, startedAt: now });
      return { evict: null };
    }
    const victim = this.#oldestBelow(priority);
    if (victim === null) return false;
    this.#voices.delete(victim);
    this.#voices.set(id, { id, priority, startedAt: now });
    return { evict: victim };
  }

  /** Frees a slot. Unknown keys are ignored, so a double release is harmless. */
  release(key: string): void {
    this.#voices.delete(key);
  }

  releaseAll(): void {
    this.#voices.clear();
  }

  /** The oldest voice below `priority`, or `null` when every voice is at or above it. */
  #oldestBelow(priority: Priority): string | null {
    let victim: VoiceRecord | null = null;
    for (const record of this.#voices.values()) {
      if (record.priority >= priority) continue;
      // Strictly earlier only, so equal timestamps fall back to admission order.
      if (victim === null || record.startedAt < victim.startedAt) victim = record;
    }
    return victim?.id ?? null;
  }
}

/**
 * The per-`SoundId` cooldown of §4.2 (AC-33). Independent per id: a burst of
 * `bug_pop` never silences the `ui_blip` fired in the same frame. A refused
 * call does not restart the window, so a sound held down at 60 Hz still fires
 * every `minIntervalMs`.
 */
export class RateLimiter {
  readonly #last = new Map<string, number>();

  allow(id: string, now: number, minIntervalMs: number = DEFAULT_MIN_INTERVAL_MS): boolean {
    const last = this.#last.get(id);
    if (last !== undefined && now - last < minIntervalMs) return false;
    this.#last.set(id, now);
    return true;
  }

  clear(): void {
    this.#last.clear();
  }
}
