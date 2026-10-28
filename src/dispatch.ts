/**
 * Autopilot loop and one-round dispatch, deliberately free of host wiring.
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
import { findLeads } from './lead.ts'
import { boardSummary, claimableTasks, planDispatch, wakeMessage } from './select.ts'
import type { DispatchPlan } from './select.ts'
import { planReclaim } from './reclaim.ts'
import {
  createBreaker,
  evaluate,
  recordError,
  recordSuccess,
  resolveBudget,
} from './breaker.ts'
import type { Breaker, BreakerConfig, BreakerState } from './breaker.ts'
import { createAutopilotState, teamState } from './state.ts'
import type { AutopilotState, TeamState } from './state.ts'

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
 * Exponential backoff for consecutive loop failures, capped at 30s.
 * @param failures - consecutive failure count, at least 1.
 * @returns the pause duration in milliseconds.
 */
function backoffMs(failures: number): number {
  return Math.min(2_000 * 2 ** Math.min(failures - 1, 4), 30_000)
}

/** One team's armed change-wait. */
interface TeamWaiter {
  /** The Lead this wait is bound to; a replaced Lead invalidates the wait. */
  readonly lead: Agent
  /** Settles when the team reports a change, or when the wait fails. */
  readonly promise: Promise<void>
}

/**
 * Record one wake in the team's diagnostics.
 *
 * Re-waking the *same* member for the *same* task does **not** start a new
 * record: doing so would throw away the outcome the previous round just
 * resolved, so a task that is woken every round would forever read
 * "not checked yet" and the loop would stay invisible. The repeat is counted
 * instead, which is the number that actually exposes it.
 * @param team - the team's state bucket.
 * @param plan - the hand-off that was performed.
 * @param now - epoch milliseconds of the wake.
 * @param sent - whether a message actually left the process.
 */
function recordDispatch(team: TeamState, plan: DispatchPlan, now: number, sent: boolean): void {
  const last = team.lastDispatch
  if (last !== undefined && last.taskId === plan.taskId && last.memberName === plan.memberName) {
    last.at = now
    last.repeats += 1
    last.sent = sent
  } else {
    team.lastDispatch = {
      taskId: plan.taskId,
      memberName: plan.memberName,
      at: now,
      repeats: 1,
      sent,
    }
  }
  // This wake has not been judged yet; the next board read decides it.
  team.lastDispatchPending = true
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
 *
 * The board is always re-read in full because `waitForChange` reports only
 * that *something* changed, never what.
 *
 * Every number this writes goes into the team's own bucket, so one team can
 * never overwrite another team's snapshot and the totals stay derivable.
 * @param ctx - host context.
 * @param lead - live Team Lead used as the authority credential.
 * @param config - resolved plugin configuration.
 * @param state - autopilot state to update.
 * @param teamKey - stable identity of the team being served.
 * @param lastWake - per-task suppression timestamps, keyed by task id.
 * @param stalled - per-task stamps of when a task was first seen stalled.
 * @param breaker - current circuit-breaker state for this team.
 * @param signal - cancellation signal.
 * @returns the next breaker state for this team.
 */
export async function tick(
  ctx: Context,
  lead: Agent,
  config: Required<Config>,
  state: AutopilotState,
  teamKey: string,
  lastWake: Map<string, number>,
  stalled: Map<string, number>,
  breaker: Breaker,
  signal: AbortSignal,
): Promise<Breaker> {
  const bcfg: BreakerConfig = {
    errorThreshold: config.errorThreshold,
    openCooldownMs: config.openCooldownMs,
    halfOpenProbe: config.halfOpenProbe,
  }

  const team = teamState(state, teamKey)

  // Circuit breaker: skip dispatch entirely while open.
  const verdict = evaluate(breaker, Date.now(), bcfg)
  breaker = verdict.breaker
  team.breaker = breaker.state
  if (!verdict.canDispatch) {
    team.breakerBlocked += 1
    return breaker
  }

  let tasks: TeamTaskView[] = ctx.agentTeams.listTasks(lead)
  let members: TeamMemberView[] = ctx.agentTeams.listMembers(lead)

  // Resolve the previous wake *before* this round moves anything. A wake that
  // nobody answers is indistinguishable from a successful one at the moment it
  // is sent — only the next board read can tell them apart. Repeated misses
  // are the signature of a member that never claims: it keeps occupying the
  // dispatch channel while the task sits in the pool.
  //
  // Judged once per wake, not once per round: a task left in the pool is
  // re-observed every round, and counting each of those rounds would report
  // the team, not the wake.
  const previous = team.lastDispatch
  if (previous !== undefined && team.lastDispatchPending) {
    team.lastDispatchPending = false
    const woken = tasks.find(entry => String(entry.id) === previous.taskId)
    // Completed work is a success even if the owner has since been cleared.
    const owned = woken === undefined
      || woken.status === 'completed'
      || woken.ownerName != null
    previous.claimed = owned
    if (owned) {
      // The task moved on, so this member's turn on it is settled: any
      // earlier refusal no longer says anything about the current situation.
      team.declined.delete(previous.taskId)
    } else {
      team.unclaimed += 1
      // Remember the refusal so the next round offers the task to somebody
      // else. Without this the member keeps its roster position and takes
      // the dispatch channel round after round while a colleague idles.
      const declined = team.declined.get(previous.taskId)
      if (declined === undefined) team.declined.set(previous.taskId, new Set([previous.memberName]))
      else declined.add(previous.memberName)
    }
  }

  // Budget is keyed by the real Team identity (root-Session-backed TeamId),
  // not the Lead's display name: names are mutable, TeamId is stable.
  const budget = resolveBudget(teamKey, config.teamBudgets, config.maxConcurrent)

  // Reclaim before dispatch: a released task frees its slot and its write
  // scopes, so this very round can hand it out again instead of leaving it
  // parked until the next change edge happens to arrive.
  const reclaim = planReclaim({
    tasks,
    members,
    now: Date.now(),
    reclaimAfterMs: config.reclaimAfterMs,
    reclaimOnFailed: config.reclaimOnFailed,
    stalled,
  })
  stalled.clear()
  for (const [taskId, at] of reclaim.stalled) stalled.set(taskId, at)

  let released = 0
  for (const target of reclaim.releases) {
    let applied = false
    if (!config.dryRun) {
      try {
        await ctx.agentTeams.updateTask(lead, {
          taskId: target.taskId,
          action: 'reassign',
          expectedRevision: target.revision,
        })
        applied = true
      } catch (error: unknown) {
        // A stale revision just means the task moved on; the next round
        // re-reads it. Reclaim never trips the breaker: a failing reclaim
        // must not stop a team from being handed the work it can still take.
        state.lastError = describe(error)
        continue
      }
    }
    released += 1
    // Recorded even under dryRun, where `applied` stays false: the point of
    // the record is to show what the autopilot decided and about which task.
    team.lastReclaim = {
      taskId: String(target.taskId),
      reason: target.reason,
      previousOwner: target.previousOwner,
      at: Date.now(),
      applied,
    }
  }
  if (released > 0) {
    team.reclaimed += released
    tasks = ctx.agentTeams.listTasks(lead)
    members = ctx.agentTeams.listMembers(lead)
  }
  // Two different situations both mean "this member already had its turn on
  // this task", so they travel down one channel:
  //  - it was reclaimed from that member this very round, and the point of a
  //    reclaim is to give somebody else a turn;
  //  - it was woken for that member in an earlier round and never claimed
  //    (recorded in `team.declined`). Without this, a member that ignores
  //    every wake keeps its roster position and holds the dispatch channel
  //    forever while an idle colleague never gets a chance.
  const avoid = new Map<string, Set<string>>()
  const addAvoid = (taskId: string, memberName: string): void => {
    const existing = avoid.get(taskId)
    if (existing === undefined) avoid.set(taskId, new Set([memberName]))
    else existing.add(memberName)
  }
  for (const target of reclaim.releases) {
    const taskId = String(target.taskId)
    addAvoid(taskId, target.previousOwner)
    // A reclaim means the task changed hands, so earlier refusals from other
    // members were formed under different circumstances — clear that slate
    // rather than carrying a stale grudge into the new situation.
    team.declined.delete(taskId)
  }
  // Forget refusals for tasks that are no longer up for grabs: an owned or
  // finished task has nothing left to decide, and a refusal recorded against
  // it would otherwise linger and mis-fire if the id were ever reused. This
  // also keeps the map bounded by the tasks actually in play.
  const upForGrabs = new Set(claimableTasks(tasks).map(entry => String(entry.id)))
  for (const taskId of [...team.declined.keys()]) {
    if (!upForGrabs.has(taskId)) team.declined.delete(taskId)
  }
  for (const [taskId, names] of team.declined) {
    for (const name of names) addAvoid(taskId, name)
  }

  // `planDispatch` and `boardSummary` share one in-flight rule, so the
  // reported numbers always describe the decision that was actually made.
  const { plans, blocked } = planDispatch({
    tasks,
    members,
    maxConcurrent: budget,
    avoid,
  })
  const summary = boardSummary(tasks, members, budget)

  // Diagnostics: capture what this round actually saw, so the status tool can
  // explain "why nothing dispatched" without guesswork.
  team.ticks += 1
  team.tasks = summary.tasks
  team.inFlight = summary.inFlight
  team.claimable = summary.claimable
  team.idle = summary.idle
  team.slots = summary.slots
  // Cumulative, like every other counter here: "how many skip decisions has
  // this team produced" is the number worth watching, and the split says
  // which of the two opposite fixes applies — widen the scopes, or add a
  // member. One task blocked for five rounds counts five times, on purpose.
  team.skipped += blocked.length
  for (const entry of blocked) {
    if (entry.kind === 'scope') team.skippedScope += 1
    else if (entry.kind === 'declined') team.skippedDeclined += 1
    else team.skippedNoMember += 1
  }
  team.lastTickAt = Date.now()
  state.rounds += 1

  const now = Date.now()
  for (const plan of plans) {
    // Half-open probe allowance is capped per trial.
    if (breaker.state === 'halfOpen' && breaker.halfOpenRemaining <= 0) {
      team.breakerBlocked += 1
      continue
    }
    const previous = lastWake.get(plan.taskId)
    if (previous !== undefined && now - previous < config.wakeCooldownMs) {
      team.suppressed += 1
      continue
    }
    if (config.dryRun) {
      team.dispatched += 1
      lastWake.set(plan.taskId, now)
      recordDispatch(team, plan, now, false)
      breaker = recordSuccess(breaker)
      team.breaker = breaker.state
      continue
    }
    try {
      await sendWake(ctx, lead, plan, signal)
      team.dispatched += 1
      lastWake.set(plan.taskId, now)
      recordDispatch(team, plan, now, true)
      breaker = recordSuccess(breaker)
      team.breaker = breaker.state
    } catch (error: unknown) {
      state.lastError = describe(error)
      breaker = recordError(breaker, Date.now(), bcfg)
      team.breaker = breaker.state
      if (breaker.state === 'open') team.breakerTrips += 1
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
 * history. Consecutive wait/tick failures back off exponentially (capped at
 * 30s) so a persistently broken host cannot spin the loop at full speed.
 *
 * The desktop host keeps several sessions (Teams) alive at once. Each round
 * serves *every* live Lead, so a autopilot can never bind to the first-registered
 * Team and ignore the rest. Per-team state (suppression stamps and the circuit
 * breaker) is keyed by the Team identity resolved from each Lead, so one team's
 * cooldown or breaker never bleeds into another's.
 *
 * Every team carries its own armed waiter, and the round wakes on the first
 * one to fire. Awaiting the teams one after another instead would make the
 * dispatch latency grow with the number of live teams: a change in the first
 * team would still wait for the last team's timeout to expire.
 * @param ctx - host context.
 * @param config - resolved configuration.
 * @param state - autopilot state to update.
 * @param signal - cancellation signal.
 */
export async function loop(
  ctx: Context,
  config: Required<Config>,
  state: AutopilotState,
  signal: AbortSignal,
): Promise<void> {
  // Per-team runtime state, keyed by the TeamId resolved from each Lead.
  const teamWake = new Map<string, Map<string, number>>()
  const teamBreaker = new Map<string, Breaker>()
  const teamStalled = new Map<string, Map<string, number>>()
  const teamFailures = new Map<string, number>()
  // One armed change-wait per team. A team's waiter is re-armed the moment it
  // fires, so no team is ever left unobserved and no edge slips through.
  const waiters = new Map<string, TeamWaiter>()
  let failures = 0

  const teamKeyFor = (lead: Agent): string => {
    const membership = ctx.agentTeams.tryMembership(lead)
    return membership === undefined ? 'default' : String(membership.id)
  }

  /**
   * Arm a change-wait for one team and keep it armed.
   *
   * The waiter is re-armed as soon as it settles — before the round reads any
   * board — so a change that lands while the round is running is still
   * observed by the next round.
   * @param lead - the live Lead to wait on.
   * @param teamKey - stable identity of the team.
   */
  const arm = (lead: Agent, teamKey: string): void => {
    if (signal.aborted) return
    let failed = false
    const promise = ctx.agentTeams.waitForChange(lead, config.tickTimeoutMs, signal).then(
      () => undefined,
      (error: unknown) => {
        failed = true
        if (!signal.aborted) state.lastError = describe(error)
      },
    )
    const waiter: TeamWaiter = { lead, promise }
    waiters.set(teamKey, waiter)
    void promise.then(() => {
      // Only the waiter that is still registered may re-arm itself; a waiter
      // replaced by a fresher Lead must not resurrect the stale one.
      if (waiters.get(teamKey) !== waiter) return
      waiters.delete(teamKey)
      // A failed wait is not re-armed here: the team may be gone, and the
      // round below re-arms every live team from the current Lead.
      if (!failed) arm(lead, teamKey)
    })
  }

  // Drop suppression stamps that can no longer suppress anything, so the map
  // stays bounded by the number of tasks actually woken within one cooldown.
  const prune = (): void => {
    const cutoff = Date.now() - config.wakeCooldownMs
    for (const wake of teamWake.values()) {
      for (const [taskId, at] of wake) if (at < cutoff) wake.delete(taskId)
    }
  }

  while (!signal.aborted) {
    const leads = findLeads(ctx)
    if (leads.length === 0) {
      waiters.clear()
      await pause(2_000, signal)
      continue
    }

    // Arm a waiter for every live team that has none, and replace any waiter
    // bound to a Lead that has since been replaced. Every waiter is armed
    // before any board read, so no edge can be missed.
    for (const lead of leads) {
      const teamKey = teamKeyFor(lead)
      const current = waiters.get(teamKey)
      if (current === undefined || current.lead !== lead) {
        waiters.delete(teamKey)
        arm(lead, teamKey)
      }
    }
    // Forget teams that no longer exist.
    for (const teamKey of [...waiters.keys()]) {
      if (!leads.some(lead => teamKeyFor(lead) === teamKey)) waiters.delete(teamKey)
    }

    // Wake on the first team to report a change (or to time out), instead of
    // waiting for every team's turn in turn.
    await Promise.race([...waiters.values()].map(waiter => waiter.promise))
    if (signal.aborted) return

    state.rounds += 1

    for (const lead of leads) {
      if (signal.aborted) return
      const teamKey = teamKeyFor(lead)
      const wake = teamWake.get(teamKey) ?? new Map<string, number>()
      teamWake.set(teamKey, wake)
      const stalled = teamStalled.get(teamKey) ?? new Map<string, number>()
      teamStalled.set(teamKey, stalled)
      let breaker = teamBreaker.get(teamKey) ?? createBreaker()

      try {
        breaker = await tick(ctx, lead, config, state, teamKey, wake, stalled, breaker, signal)
        teamFailures.set(teamKey, 0)
        failures = 0
      } catch (error: unknown) {
        if (signal.aborted) return
        state.lastError = describe(error)
        const teamFail = (teamFailures.get(teamKey) ?? 0) + 1
        teamFailures.set(teamKey, teamFail)
        failures += 1
        await pause(backoffMs(failures), signal)
        if (signal.aborted) return
        continue
      }
      teamBreaker.set(teamKey, breaker)
    }
    prune()
  }
}
