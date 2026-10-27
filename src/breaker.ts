/**
 * Error-rate circuit breaker for the dispatch loop.
 *
 * The native Agent Teams surface never intercepts dispatch failures, so a
 * stuck or rejecting teammate would keep getting woken every cooldown window
 * forever. This breaker trips after `errorThreshold` consecutive sendMessage
 * failures, opens the circuit for `openCooldownMs`, then half-opens to probe
 * with `halfOpenProbe` dispatches before fully closing again.
 *
 * Pure state machine: every transition returns a new Breaker, so it can be
 * unit-tested without a host. No external imports, so it also runs under
 * Node type-stripping with no node_modules.
 */

/** The three phases of the breaker. */
export type BreakerState = 'closed' | 'open' | 'halfOpen'

/** Breaker tuning, resolved from plugin configuration. */
export interface BreakerConfig {
  /** Consecutive sendMessage failures that trip the breaker. */
  readonly errorThreshold: number
  /** How long the circuit stays open before a half-open probe. */
  readonly openCooldownMs: number
  /** Dispatches allowed during one half-open trial. */
  readonly halfOpenProbe: number
}

/** Mutable-by-copy breaker snapshot. */
export interface Breaker {
  readonly state: BreakerState
  readonly consecutiveErrors: number
  /** Timestamp (ms) the circuit last opened, or undefined. */
  readonly openedAt: number | undefined
  /** Remaining dispatches allowed in the current half-open trial. */
  readonly halfOpenRemaining: number
}

/** Fresh closed breaker. */
export function createBreaker(): Breaker {
  return { state: 'closed', consecutiveErrors: 0, openedAt: undefined, halfOpenRemaining: 0 }
}

/**
 * Resolve the effective concurrency budget for one team.
 * @param teamKey - stable identifier of the resolved team.
 * @param teamBudgets - optional per-team overrides.
 * @param fallback - default budget (global maxConcurrent).
 * @returns the budget to use this round.
 */
export function resolveBudget(
  teamKey: string,
  teamBudgets: Readonly<Record<string, number>> | undefined,
  fallback: number,
): number {
  const override = teamBudgets?.[teamKey]
  return override === undefined ? fallback : override
}

/**
 * Decide whether the loop may dispatch this round, advancing the breaker.
 * @param breaker - current breaker.
 * @param now - current time in ms.
 * @param config - breaker tuning.
 * @returns the (possibly advanced) breaker and whether dispatch is allowed.
 */
export function evaluate(
  breaker: Breaker,
  now: number,
  config: BreakerConfig,
): { breaker: Breaker; canDispatch: boolean } {
  if (breaker.state === 'open') {
    if (breaker.openedAt !== undefined && now - breaker.openedAt >= config.openCooldownMs) {
      const halfOpen: Breaker = {
        state: 'halfOpen',
        consecutiveErrors: 0,
        openedAt: undefined,
        halfOpenRemaining: config.halfOpenProbe,
      }
      return { breaker: halfOpen, canDispatch: config.halfOpenProbe > 0 }
    }
    return { breaker, canDispatch: false }
  }
  if (breaker.state === 'halfOpen') {
    return { breaker, canDispatch: breaker.halfOpenRemaining > 0 }
  }
  return { breaker, canDispatch: true }
}

/**
 * Record one successful dispatch, advancing the breaker.
 * @param breaker - current breaker.
 * @returns the next breaker.
 */
export function recordSuccess(breaker: Breaker): Breaker {
  if (breaker.state === 'halfOpen') {
    const remaining = breaker.halfOpenRemaining - 1
    if (remaining <= 0) {
      return { state: 'closed', consecutiveErrors: 0, openedAt: undefined, halfOpenRemaining: 0 }
    }
    return { ...breaker, halfOpenRemaining: remaining }
  }
  if (breaker.state === 'closed') {
    return { ...breaker, consecutiveErrors: 0 }
  }
  return breaker
}

/**
 * Record one failed dispatch, advancing the breaker.
 * @param breaker - current breaker.
 * @param now - current time in ms (used to stamp the open transition).
 * @param config - breaker tuning.
 * @returns the next breaker.
 */
export function recordError(breaker: Breaker, now: number, config: BreakerConfig): Breaker {
  const consecutiveErrors = breaker.consecutiveErrors + 1
  if (breaker.state === 'halfOpen') {
    // Any failure during a probe re-opens immediately.
    return { state: 'open', consecutiveErrors, openedAt: now, halfOpenRemaining: 0 }
  }
  if (breaker.state === 'closed' && consecutiveErrors >= config.errorThreshold) {
    return { state: 'open', consecutiveErrors, openedAt: now, halfOpenRemaining: 0 }
  }
  return { ...breaker, consecutiveErrors }
}
