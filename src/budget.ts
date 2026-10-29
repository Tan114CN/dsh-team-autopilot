/**
 * The wake budget: how many model turns this plugin may start per rolling
 * hour, per team.
 *
 * A wake is the only thing the autopilot spends money on. Everything else it
 * does (reading the board, reclaiming, observing) is free, which is the whole
 * promise of the plugin. But nothing stopped a big board from turning into a
 * lot of small bills: `wakeCooldownMs` bounds re-waking *one* task and
 * `reclaimRetryLimit` bounds one task's retry loop, while twenty ready tasks
 * against five idle members will happily start twenty turns, and do it again
 * the next hour.
 *
 * This module is the missing rate limit. It keeps the output side honest the
 * same way the reclaim table keeps the input side honest: the budget is
 * expressed in the unit the user pays in.
 *
 * The unit is a plain list of timestamps rather than a counter with a window
 * start, because a counter quietly under-reports whenever traffic is bursty
 * around the window edge ("59 wakes at 12:59, 59 more at 13:01"). The list is
 * bounded by the budget itself: once the allowance runs out no new stamp is
 * added, so it can never grow past the configured cap.
 */

/** Length of the rolling window the budget is measured over: one hour. */
export const WAKE_WINDOW_MS = 3_600_000

/**
 * Drop the stamps that have aged out of the window.
 *
 * Returns a new list so callers cannot accidentally share the array with the
 * state snapshot they are about to serialize.
 * @param stamps - wake timestamps, oldest first by convention.
 * @param now - current clock reading, milliseconds.
 * @param windowMs - length of the window, defaulting to one hour.
 * @returns the stamps still inside the window.
 */
export function pruneWakeStamps(
  stamps: readonly number[],
  now: number,
  windowMs: number = WAKE_WINDOW_MS,
): number[] {
  return stamps.filter((at) => now - at < windowMs)
}

/**
 * How many wakes the team may still start inside the current window.
 *
 * `0` disables the budget and reports `Infinity`, so an unset budget behaves
 * exactly like the plugin did before the field existed.
 * @param budget - configured wakes per window (`0` = unlimited).
 * @param stamps - wake timestamps, current values.
 * @param now - current clock reading, milliseconds.
 * @param windowMs - length of the window, defaulting to one hour.
 * @returns remaining wakes, clamped at zero.
 */
export function wakeAllowance(
  budget: number,
  stamps: readonly number[],
  now: number,
  windowMs: number = WAKE_WINDOW_MS,
): number {
  if (budget <= 0) return Number.POSITIVE_INFINITY
  const used = stamps.filter((at) => now - at < windowMs).length
  return Math.max(0, budget - used)
}
