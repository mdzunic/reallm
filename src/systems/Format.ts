// The one formatter (SPEC-045 §4.7): the numbers a player reads, in one style —
// a percentage or a unit spaced (`15 %`, `48 s`), a rate attached (`3/s`), and
// a negative with a real minus sign. Passives, gear stats, the shop, the star
// map, the HUD's timers and the tracker all print through it, so `+15%` beside
// `+15 %` cannot come back. Pure: no DOM, no `three`, no state.
//
// Every function returns its 0-valued text for a non-finite input — `0 %`,
// `+0 %`, `0 s`, `0:00`, `0/s`, `Stage 0/0`, `0.0×` — so a NaN that slips
// through a model never reaches the screen.
//
// Each call stands where a template literal stood and builds the one string it
// built, so nothing allocates where it did not before (SPEC-001 §7).

/** U+2212, the minus sign — never the hyphen-minus. */
export const MINUS = '−';

/** `value`, or 0 when it is not a finite number. */
function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

/** An integer with a real minus sign; `-0` reads `0`. */
function signed(value: number): string {
  return value < 0 ? `${MINUS}${-value}` : String(value);
}

/** `value` to at most `digits` places, trailing zeros trimmed, with a real minus sign. */
function trimmed(value: number, digits: number): string {
  const magnitude = Number(Math.abs(value).toFixed(digits));
  return value < 0 && magnitude !== 0 ? `${MINUS}${magnitude}` : String(magnitude);
}

/** `0.15` → `15 %`: a fraction as a whole percentage. */
export function percent(fraction: number): string {
  return `${signed(Math.round(finite(fraction) * 100))} %`;
}

/**
 * `1.15` → `+15 %`, `0.85` → `−15 %`: a multiplier as the change it makes,
 * signed. No change, or a change that rounds to none, reads `+0 %`.
 */
export function multPercent(mult: number): string {
  const delta = Number.isFinite(mult) ? Math.round((mult - 1) * 100) : 0;
  return `${delta < 0 ? MINUS : '+'}${Math.abs(delta)} %`;
}

/**
 * `(1, 1.15)` → `+15 %`: `to` against `from`. A `from` of 0 or less has no
 * ratio to print, so it reads as the two values, `0 → 5`.
 */
export function percentChange(from: number, to: number): string {
  if (!Number.isFinite(from) || !Number.isFinite(to)) return multPercent(1);
  return from > 0 ? multPercent(to / from) : `${trimmed(from, 3)} → ${trimmed(to, 3)}`;
}

/** `47.2` → `48 s`: the whole seconds left, rounded up — a timer reads `1 s` until it is done (45-s). */
export function seconds(value: number): string {
  return `${Math.max(0, Math.ceil(finite(value)))} s`;
}

/**
 * Whole seconds as a length of time: `42 s`; `12 min`, or `1 min 30 s` when
 * it is not a whole minute; from an hour `1 h 04 min`, where the seconds no
 * longer matter.
 */
export function duration(value: number): string {
  const total = Math.max(0, Math.floor(finite(value)));
  if (total < 60) return `${total} s`;
  if (total < 3600) {
    const rest = total % 60;
    const minutes = (total - rest) / 60;
    return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
  }
  const minutes = Math.floor((total % 3600) / 60);
  return `${Math.floor(total / 3600)} h ${minutes < 10 ? '0' : ''}${minutes} min`;
}

/** `161` → `2:41`, and from an hour `1:02:05`: whole seconds as a stopwatch reads them. */
export function clock(value: number): string {
  const total = Math.max(0, Math.floor(finite(value)));
  const ss = String(total % 60).padStart(2, '0');
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}:${ss}`;
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${ss}`;
}

/** `3` → `3/s`, `2.5` → `2.5/s`: to two places with the trailing zeros trimmed, `/s` attached. */
export function rate(perSecond: number): string {
  return `${trimmed(finite(perSecond), 2)}/s`;
}

/** `(2, 3)` → `Stage 2/3`. */
export function stage(n: number, count: number): string {
  return `Stage ${finite(n)}/${finite(count)}`;
}

/** `1` → `1.0×`: a multiplier to one place, as the flight's throttle reads. */
export function multiplier(value: number): string {
  const text = Math.abs(finite(value)).toFixed(1);
  return value < 0 && Number(text) !== 0 ? `${MINUS}${text}×` : `${text}×`;
}
