/**
 * Scheduler loop and one-round dispatch, deliberately free of host wiring.
 *
 * Keeping this module free of `dsh-tools` / Cordis value imports makes the
 * dispatch logic runnable in headless integration tests without a full host.
 * Everything here talks only to the public `ctx.agentTeams` / `ctx.agents`
 * surface, and reads types from the kernel packages.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { TeamMemberView, TeamTaskView } from '@deepseek-ai/dsh-experimental-agent-team'
import type { Config } from './index.ts'
import { findLead } from './lead.ts'
import { availableMembers, claimableTasks, planDispatch, wakeMessage } from './select.ts'
import type { DispatchPlan } from './select.ts'
import {
  createBreaker,
  evaluate,
  recordError,
  recordSuccess,
  resolveBudget,
} from './breaker.ts'
import type { Breaker, BreakerConfig, BreakerState } from './breaker.ts'

/** Observable scheduler counters, surfaced through the status tool. */
export interface SchedulerState {
  rounds: number
  dispatched: number
  suppressed: number
  lastBlocked: number
  lastTickAt: number | undefined
  lastError: string | undefined
  breaker: BreakerState
  breakerTrips: number
  breakerBlocked: number
  /** Diagnostics: what the last round actually saw on the board. */
  team: string
  tasks: number
  inFlight: number
  claimable: number
  idle: number
  slots: number
}

/**
 * Interruptible pause.
 * @param ms - duration in milliseconds.
 * @param signal - cancellation signal.
 * @returns a promise settled when the timer elapses or the signal aborts.
 */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>(resolve => {
    if (signal.aborted) {
      resolve()
      return
    }
    let timer: ReturnType<typeof setTimeout>
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }
    timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Readable message for an unknown thrown value.
 * @param error - thrown value.
 * @returns its message.
 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Send one wake message to one teammate.
 * @param ctx - host context.
 * @param lead - live Team Lead.
 * @param plan - planned hand-off.
 * @param signal - cancellation signal.
 */
async function sendWake(
  ctx: Context,
  lead: Agent,
  plan: DispatchPlan,
  signal: AbortSignal,
): Promise<void> {
  await ctx.agentTeams.sendMessage(lead, {
    target: plan.memberName,
    content: [{ type: 'text', text: wakeMessage(plan) }],
    signal,
  })
}

/**
 * One dispatch round: read the whole board, decide, then wake.
 * The board is always re-read in full because `waitForChange` reports only
 * that *something* changed, never what.
 * @param ctx - host context.
 * @param lead - live Team Lead used as the authority credential.
 * @param config - resolved plugin configuration.
 * @param state - mutable counters.
 * @param lastWake - per-task suppression timestamps, keyed by task id.
 * @param breaker - current circuit-breaker state.
 * @param signal - cancellation signal.
 * @returns the next breaker state.
 */
export async function tick(
  ctx: Context,
  lead: Agent,
  config: Required<Config>,
  state: SchedulerState,
  lastWake: Map<string, number>,
  breaker: Breaker,
  signal: AbortSignal,
): Promise<Breaker> {
  const bcfg: BreakerConfig = {
    errorThreshold: config.errorThreshold,
    openCooldownMs: config.openCooldownMs,
    halfOpenProbe: config.halfOpenProbe,
  }

  // Circuit breaker: skip dispatch entirely while open.
  const verdict = evaluate(breaker, Date.now(), bcfg)
  breaker = verdict.breaker
  state.breaker = breaker.state
  if (!verdict.canDispatch) {
    state.breakerBlocked += 1
    return breaker
  }

  const tasks: TeamTaskView[] = ctx.agentTeams.listTasks(lead)
  const members: TeamMemberView[] = ctx.agentTeams.listMembers(lead)

  // Budget is keyed by the real Team identity (root-Session-backed TeamId),
  // not the Lead's display name: names are mutable, TeamId is stable.
  const membership = ctx.agentTeams.tryMembership(lead)
  const teamKey = membership === undefined ? 'default' : String(membership.id)
  const budget = resolveBudget(teamKey, config.teamBudgets, config.maxConcurrent)

  // Diagnostics: capture what this round actually saw, so the status tool can
  // explain "why nothing dispatched" without guesswork.
  const inFlight = tasks.filter(task => task.status === 'in_progress').length
  state.team = teamKey
  state.tasks = tasks.length
  state.inFlight = inFlight
  state.claimable = claimableTasks(tasks).length
  state.idle = availableMembers(members, tasks).length
  state.slots = Math.max(0, budget - inFlight)

  const { plans, blocked } = planDispatch({ tasks, members, maxConcurrent: budget })

  state.rounds += 1
  state.lastBlocked = blocked.length
  state.lastTickAt = Date.now()

  const now = Date.now()
  for (const plan of plans) {
    // Half-open probe allowance is capped per trial.
    if (breaker.state === 'halfOpen' && breaker.halfOpenRemaining <= 0) {
      state.breakerBlocked += 1
      continue
    }
    const previous = lastWake.get(plan.taskId)
    if (previous !== undefined && now - previous < config.wakeCooldownMs) {
      state.suppressed += 1
      continue
    }
    if (config.dryRun) {
      state.dispatched += 1
      lastWake.set(plan.taskId, now)
      breaker = recordSuccess(breaker)
      state.breaker = breaker.state
      continue
    }
    try {
      await sendWake(ctx, lead, plan, signal)
      state.dispatched += 1
      lastWake.set(plan.taskId, now)
      breaker = recordSuccess(breaker)
      state.breaker = breaker.state
    } catch (error: unknown) {
      state.lastError = describe(error)
      breaker = recordError(breaker, Date.now(), bcfg)
      state.breaker = breaker.state
      if (breaker.state === 'open') state.breakerTrips += 1
      break
    }
  }
  return breaker
}

/**
 * Main loop: wait for one edge, then re-read and dispatch.
 *
 * Ordering matters. The waiter is registered *before* the board is read, so a
 * change landing during the round cannot be missed — `waitForChange` keeps no
 * history. The loop also treats a disposed service as fatal: it returns
 * `{ timedOut: false }` in that case, which would otherwise look like activity.
 * @param ctx - host context.
 * @param config - resolved configuration.
 * @param state - mutable counters.
 * @param lastWake - per-task suppression timestamps.
 * @param signal - cancellation signal.
 */
export async function loop(
  ctx: Context,
  config: Required<Config>,
  state: SchedulerState,
  lastWake: Map<string, number>,
  signal: AbortSignal,
): Promise<void> {
  let breaker = createBreaker()
  while (!signal.aborted) {
    const lead = findLead(ctx)
    if (lead === undefined) {
      await pause(2_000, signal)
      continue
    }

    try {
      await ctx.agentTeams.waitForChange(lead, config.tickTimeoutMs, signal)
    } catch (error: unknown) {
      if (signal.aborted) return
      state.lastError = describe(error)
    }
    if (signal.aborted) return

    try {
      breaker = await tick(ctx, lead, config, state, lastWake, breaker, signal)
    } catch (error: unknown) {
      if (signal.aborted) return
      state.lastError = describe(error)
    }
  }
}
