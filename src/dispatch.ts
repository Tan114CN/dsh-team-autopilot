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
import { boardSummary, claimableTasks, isInFlight, planDispatch, wakeMessage } from './select.ts'
import type { DispatchPlan } from './select.ts'
import { planReclaim } from './reclaim.ts'
import { planStallWatch } from './stall.ts'
import {
  createBreaker,
  evaluate,
  recordError,
  recordSuccess,
  resolveBudget,
} from './breaker.ts'
import type { Breaker, BreakerConfig, BreakerState } from './breaker.ts'
import { createAutopilotState, teamState } from './state.ts'
import type { AutopilotState, ParkRecord, TeamState } from './state.ts'
import { pruneWakeStamps, wakeAllowance } from './budget.ts'
import type { Liveness } from './liveness.ts'
import { appendStatusLine, startupLine, statusLine, statusSignature } from './observe.ts'

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
 * Floor on how often a round may run.
 *
 * Not a cadence 鈥?the cadence is the change-wait timeout. This only stops a
 * wait that settles for the wrong reason from spinning the loop, and it is
 * capped by the configured interval so it can never become the cadence itself.
 */
const MIN_ROUND_SPACING_MS = 1_000

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
  // This wake leaves an entry behind; a later board read settles it. A wake
  // that was never sent (`dryRun`) is marked instead of judged: see
  // `PendingWake.simulated`.
  team.pendingWakes.set(
    plan.taskId,
    sent
      ? { memberName: plan.memberName, at: now }
      : { memberName: plan.memberName, at: now, simulated: true },
  )
}

/**
 * Charge one started wake to the team's hourly budget.
 * @param team - the team's bucket.
 * @param at - when the wake was started, in milliseconds.
 */
function recordWakeStamp(team: TeamState, at: number): void {
  team.wakeStamps.push(at)
  team.wakesThisHour = team.wakeStamps.length
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
 * Append this round's status line, when a file is configured.
 *
 * Every exit from a round goes through here: a round that ends early because
 * the breaker is open still has news worth writing down.
 *
 * A round that found nothing to do is not written at all. The loop ticks once
 * per interval per team whether or not anything happened, so writing every
 * round buries the rounds that matter under a wall of identical lines 鈥?on a
 * real two-team host that was 2.8 MB a day, which pushed the file past its
 * ceiling every hour and left barely half an hour of history to read. Instead
 * the line is written the moment it differs from the last one, plus a heartbeat
 * so a quiet autopilot is still visibly alive. `statusHeartbeatMs: 0` restores
 * one line per round.
 * @param config - resolved configuration.
 * @param team - the team bucket, already updated for this round.
 * @param lastError - the loop's most recent error, surfaced in the line.
 */
async function recordStatus(config: Required<Config>, team: TeamState, lastError?: string): Promise<void> {
  if (config.statusFile === '') return
  const now = Date.now()
  const line = statusLine(team, now, lastError)
  const signature = statusSignature(line)
  const quietFor = team.lastStatusAt === undefined ? Infinity : now - team.lastStatusAt
  if (signature === team.lastStatusSignature && quietFor < config.statusHeartbeatMs) return
  team.lastStatusSignature = signature
  team.lastStatusAt = now
  // Observation is a convenience and must never be able to stall the loop:
  // a status file on a slow network volume or under a stuck antivirus scan can
  // make one append hang forever, and this is on the tick critical path. A
  // bounded race drops the line instead of dropping the dispatch round.
  //
  // The outcome is remembered instead of discarded. A `statusFile` pointing at
  // a directory nobody created, or at a path this process may not write, fails
  // the same way on every round and used to leave no trace anywhere: the one
  // channel a headless user reads simply stayed empty, which is
  // indistinguishable from "nothing happened all day". The status tool now says
  // so, and the flag clears itself the moment a write lands again.
  const wrote = await Promise.race<boolean>([
    appendStatusLine(config.statusFile, line),
    new Promise<boolean>(resolve => {
      setTimeout(() => resolve(false), STATUS_WRITE_TIMEOUT_MS)
    }),
  ])
  team.statusWriteFailed = !wrote
}

/**
 * How long one status append may take before the round moves on without it.
 *
 * Not configurable on purpose: this is a guard on a convenience, and a value a
 * user could tune would invite a wrong value that reintroduces the hang.
 */
const STATUS_WRITE_TIMEOUT_MS = 2_000

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
 * @param liveness - observed turn boundaries, when the host is tracking them.
 *   Omitting it leaves every wait to the configured durations, which is the
 *   behaviour this function had before turn boundaries were observable.
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
  liveness?: Liveness,
): Promise<Breaker> {
  const bcfg: BreakerConfig = {
    errorThreshold: config.errorThreshold,
    openCooldownMs: config.openCooldownMs,
    halfOpenProbe: config.halfOpenProbe,
  }

  const team = teamState(state, teamKey)

  // This round's events start empty: the arrays below are drained into the
  // status line at the end of the round, so a previous round's events must not
  // leak into this one.
  team.reclaimsThisRound = []
  team.parksThisRound = []
  team.unparksThisRound = []
  team.stallsThisRound = []

  // Circuit breaker: an open breaker skips *dispatch*, and nothing else. It is
  // tempting to return here 鈥?the round cannot send a wake, so why do the rest?
  // Because the rest is not sending: settling answers, reclaiming stale owners
  // and watching for stalls all work on the local board and only touch the Team
  // service through `updateTask`/`interrupt`, whose failures are already handled
  // per call and never trip this breaker. Skipping them costs a full extra
  // recovery cycle: the breaker closes, then the stale owners still hold every
  // slot, so nothing can be sent until reclaim runs anyway. The outage would be
  // paid for twice.
  const verdict = evaluate(breaker, Date.now(), bcfg)
  breaker = verdict.breaker
  team.breaker = breaker.state
  if (!verdict.canDispatch) team.breakerBlocked += 1

  let tasks: TeamTaskView[] = ctx.agentTeams.listTasks(lead)
  let members: TeamMemberView[] = ctx.agentTeams.listMembers(lead)

  // Settle the wakes that can now be judged. A wake that nobody answers is
  // indistinguishable from a successful one at the moment it is sent 鈥?but
  // "old enough" is load-bearing. The board reads the same whether a member is
  // about to claim or never will, so a check that runs on the very next read
  // judges the member's *thinking time*, not its answer. On a real host that
  // read can be one second after the wake, which counted every wake as
  // ignored, blacklisted members that were about to claim, and handed their
  // task to a colleague who then duplicated the work.
  //
  // Two clocks can settle a wake, and the first one to arrive wins:
  //
  // - **a turn ended** (see {@link Liveness}). The member was seen entering
  //   `running` after this wake and then `idle`, so it was reached and has
  //   finished reacting: whatever the board says now is its answer. This is
  //   proof, not a wait, so it settles as soon as `livenessSettleGraceMs` has
  //   covered the lag between the turn ending and the claim being written.
  // - **the cooldown expired**. The fallback, used when no turn boundary was
  //   observed for this member 鈥?a member already mid-turn when the plugin
  //   loaded produces no `running` edge. It is the earliest moment the answer
  //   can change a decision: the task cannot be offered to anybody else before
  //   it expires, so judging earlier buys nothing and costs accuracy.
  //
  // Judged once per wake, not once per round: a task left in the pool is
  // re-observed every round, and counting each of those rounds would report
  // the team, not the wake.
  const settleAt = Date.now()
  for (const [taskId, wake] of [...team.pendingWakes]) {
    // A turn end only counts as this wake's answer if the turn began after the
    // wake went out: a boundary from before the wake describes a previous
    // conversation, not this one.
    const turnEnd = liveness?.lastTurnEndAt(wake.memberName)
    const answered = turnEnd !== undefined
      && turnEnd >= wake.at
      && settleAt - turnEnd >= config.livenessSettleGraceMs
    if (!answered && settleAt - wake.at < config.wakeCooldownMs) continue
    team.pendingWakes.delete(taskId)
    // Nothing was asked, so there is no answer to judge. Settling a simulated
    // wake as "unclaimed" would invent a refusal, and the declined set that
    // feeds is exactly what stops the next dispatch 鈥?a dry run would then be
    // demonstrating an artifact of its own bookkeeping rather than the policy.
    if (wake.simulated === true) continue
    const woken = tasks.find(entry => String(entry.id) === taskId)
    // Completed work is a success even if the owner has since been cleared.
    const owned = woken === undefined
      || woken.status === 'completed'
      || woken.ownerName != null
    if (team.lastDispatch?.taskId === taskId) team.lastDispatch.claimed = owned
    if (owned) {
      // The task moved on, so this member's turn on it is settled: any
      // earlier refusal no longer says anything about the current situation.
      team.declined.delete(taskId)
    } else {
      team.unclaimed += 1
      // The member answered: it read the wake and did not claim. The cooldown
      // exists so a teammate's *thinking time* is not mistaken for a refusal,
      // and that job is over the moment the turn ends without a claim. Leaving
      // the stamp would keep the task away from a colleague for the rest of the
      // window even though the answer is already known 鈥?with the default 60s,
      // one refusal costs the team the better part of a minute while it sits
      // looking idle. The refusing member is still excluded through `declined`,
      // so dropping the stamp cannot wake the same teammate again.
      lastWake.delete(taskId)
      // Remember the refusal so the next round offers the task to somebody
      // else. Without this the member keeps its roster position and takes
      // the dispatch channel round after round while a colleague idles.
      const declined = team.declined.get(taskId)
      if (declined === undefined) team.declined.set(taskId, new Set([wake.memberName]))
      else declined.add(wake.memberName)
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
    liveness,
    livenessGraceMs: config.livenessGraceMs,
  })
  stalled.clear()
  for (const [taskId, at] of reclaim.stalled) stalled.set(taskId, at)

  let released = 0
  // Which reclaims actually count towards a park. A `reassign` that failed on a
  // stale revision released nothing, so the task did not come back 鈥?counting
  // it would park a task for the autopilot's own write failures. `dryRun`
  // counts, though: there the decision is the whole point, and the host is
  // running dry-run by default, so excluding it would make the park invisible
  // exactly where it most needs to be seen.
  const releasedTargets: Array<{ taskId: string; previousOwner: string }> = []
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
        // A failed grace-expiry release must not reset the grace period. The
        // task was judged stalled after `reclaimAfterMs`; putting the stamp
        // back means the next round retries immediately instead of re-waiting
        // the whole window, which is the "retry next round" contract in
        // `docs/verify-reclaim.md`. `dryRun` never reaches this branch (it
        // skips the write), so no stamp is written back under dry-run.
        if (target.sinceAt !== undefined) stalled.set(String(target.taskId), target.sinceAt)
        continue
      }
    }
    released += 1
    const releasedId = String(target.taskId)
    releasedTargets.push({ taskId: releasedId, previousOwner: target.previousOwner })
    // The wake stamp guarded one attempt at the previous owner, and that attempt
    // is over: the task is back in the pool and somebody else may take it now.
    // Leaving the stamp in place keeps the task silent for the rest of the
    // window 鈥?the same shape of bug as a refusal that keeps its cooldown, one
    // layer down: there the answer arrived and the task still had to wait, here
    // the stand-off is over and the retry still has to wait. Under `dryRun` this
    // only changes the prediction, which is the one thing a dry run is for.
    lastWake.delete(releasedId)
    // A reclaim is proof the task *had* an owner: `planReclaim` only releases
    // in-flight tasks, and in-flight means someone claimed it. If that task's
    // wake is still owed a post-wake check, the reclaim settles it as a
    // success 鈥?otherwise a later settle that reads the now-cleared owner
    // (`ownerName == null`) would count "claimed then reclaimed" as "never
    // answered", climb `unclaimed`, and trip the false alarm in the report.
    if (team.pendingWakes.has(releasedId)) {
      team.pendingWakes.delete(releasedId)
      if (team.lastDispatch?.taskId === releasedId) team.lastDispatch.claimed = true
      // The member answered the wake (it claimed); a later refusal is a
      // different situation, so clear any stale record under the old one.
      team.declined.delete(releasedId)
    }
    // Recorded even under dryRun, where `applied` stays false: the point of
    // the record is to show what the autopilot decided and about which task.
    team.lastReclaim = {
      taskId: releasedId,
      reason: target.reason,
      previousOwner: target.previousOwner,
      at: Date.now(),
      applied,
    }
    // The round's release list, so a round that reclaimed several owners logs
    // all of them instead of only the last one.
    team.reclaimsThisRound.push(`${releasedId}<${target.previousOwner}`)
  }
  if (released > 0) {
    team.reclaimed += released
    tasks = ctx.agentTeams.listTasks(lead)
    members = ctx.agentTeams.listMembers(lead)
  }

  // Watch the opposite failure to reclaim: an owner that is *not* idle and can
  // still never finish. `planReclaim` refuses to touch a running turn 鈥?it has
  // no proof the turn is dead, and interrupting live work on a guess is how an
  // autopilot destroys a teammate's afternoon. So a wedged turn (a driver that
  // never returns, a cancellation that never wrote a terminal status) holds its
  // slot and its write scopes forever *while looking busy*: reclaim skips it,
  // the breaker stays closed because no operation failed, and the team quietly
  // stops instead of raising anything. This half can see that state.
  //
  // Nothing here changes the board by itself: it reports, and only with
  // `interruptStalled` does it end the turn, which is what puts the member back
  // in reach of the ordinary reclaim path.
  const stall = planStallWatch({
    tasks,
    members,
    now: Date.now(),
    stalledAfterMs: config.stalledRunningMs,
    seen: team.stallSeen,
    liveness,
  })
  team.stallSeen = new Map(stall.seen)
  team.stalled = stall.warnings.length
  team.stallsThisRound = stall.warnings.map(entry => `${entry.taskId}<${entry.ownerName}`)
  for (const warning of stall.warnings) {
    team.stallWarnings += 1
    team.lastStall = {
      taskId: warning.taskId,
      ownerName: warning.ownerName,
      forMs: warning.forMs,
      at: Date.now(),
    }
    // Never under `dryRun`: that mode promises the autopilot writes nothing to
    // the team, and cancelling a live turn is the most destructive write there
    // is. It also refuses a `provisioning` member 鈥?there is no turn to cancel
    // yet 鈥?and one already interrupted for this same stall.
    if (!config.interruptStalled || config.dryRun) continue
    if (!warning.interruptible || warning.interruptedAt !== undefined) continue
    try {
      ctx.agentTeams.interrupt(lead, warning.ownerName)
    } catch (error: unknown) {
      // The member may have gone idle between the board read and this call.
      // That is not a dispatch failure: the next round re-reads and either
      // reclaims it normally or finds it healthy.
      state.lastError = describe(error)
      continue
    }
    team.stallInterrupts += 1
    // Remember the interrupt on the observation itself, so the next round does
    // not cancel the same turn again while the member is still writing the
    // terminal status the first interrupt caused.
    team.stallSeen.set(warning.taskId, { since: warning.since, interruptedAt: Date.now() })
  }

  // Reclaim bookkeeping. Releasing a stalled owner is right; doing it forever
  // is not. The task goes back to the pool, the next member claims it and goes
  // just as quiet, and the lap repeats at one model turn each 鈥?on a real host
  // that was twelve reclaims in twenty minutes with nothing finished. Counting
  // is what tells the two apart: one reclaim is a stalled owner, the same task
  // back several times is work no member can finish, and no further wake will
  // change that. So past the limit the autopilot stops offering it and says so.
  for (const entry of releasedTargets) {
    const taskId = entry.taskId
    const count = (team.reclaimCounts.get(taskId) ?? 0) + 1
    team.reclaimCounts.set(taskId, count)
    if (config.reclaimRetryLimit === 0 || count < config.reclaimRetryLimit) continue
    if (team.parked.has(taskId)) continue
    const record: ParkRecord = {
      taskId,
      reclaims: count,
      previousOwner: entry.previousOwner,
      at: Date.now(),
    }
    team.parked.set(taskId, record)
    // Kept as the announcement, the same way `lastReclaim` is: the next
    // dispatch is the one that will not happen, and this is why.
    team.lastPark = record
    // The round's park list, so a round that parked several tasks logs all of
    // them instead of only the last one.
    team.parksThisRound.push(`${taskId}<${entry.previousOwner}`)
  }

  // A park describes one stand-off, so it is dropped the moment that stand-off
  // ends: the task finished, left the board, or somebody *other than the member
  // it was taken from* took it up again. The last clause is what keeps a
  // `dryRun` host honest 鈥?there the board never changes, so the task still
  // shows the same owner and the park must survive to be reported.
  //
  // A task re-opened back to unowned `pending` (owner cleared, no new owner)
  // is deliberately *not* treated as over: that is also exactly the state a
  // reclaim leaves the task in, and a park exists to hold the task there until
  // a human or the Lead takes it. The human can end the stand-off at any time
  // by claiming it 鈥?which *does* satisfy the owner-change clause and clears
  // the park. This is a known limit, not an oversight: the two situations
  // ("reclaim left it unowned" vs "someone re-opened it unowned") are
  // indistinguishable from the board alone.
  //
  // `reclaimCounts` follows the same rule, which is also how both maps stay
  // bounded by the tasks actually in play rather than by every id ever seen.
  const board = new Map(tasks.map(entry => [String(entry.id), entry]))
  const forget = (taskId: string): void => {
    team.parked.delete(taskId)
    team.reclaimCounts.delete(taskId)
  }
  const parked = new Map<string, number>()
  for (const [taskId, record] of [...team.parked]) {
    const current = board.get(taskId)
    const over = current === undefined
      || current.status === 'completed'
      || current.status === 'deleted'
      || (isInFlight(current) && String(current.ownerName) !== record.previousOwner)
    if (over) {
      // The stand-off ended: the task moved on. This is as newsworthy as the
      // park itself, and was previously invisible 鈥?the event line only fired
      // while the park was live, so the clearing round changed nothing and the
      // log never said "offered again".
      team.unparksThisRound.push(taskId)
      forget(taskId)
      continue
    }
    parked.set(taskId, record.reclaims)
  }
  for (const taskId of [...team.reclaimCounts.keys()]) {
    if (!board.has(taskId)) forget(taskId)
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
    // members were formed under different circumstances 鈥?clear that slate
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
  // Wake stamps are only read for tasks that are about to be sent, so expired
  // ones and ones for tasks that left the board are dead weight: without this
  // the map keeps one entry per task this process has ever dispatched. Pruning
  // here (before the planner reads it) also means a recreated task id does not
  // inherit the previous task's cooldown.
  pruneWakeMap(lastWake, tasks, Date.now(), config.wakeCooldownMs)

  // `planDispatch` and `boardSummary` share one in-flight rule, so the
  // reported numbers always describe the decision that was actually made.
  //
  // Slots promised to a wake that has not been answered yet are reserved as
  // well. A wake is a request, not a claim: until the member writes its own
  // `claim`, the board still shows the task unowned and its slot free, so two
  // rounds in a row would wake two members for one slot 鈥?one member runs over
  // the team budget and one wake is wasted on work somebody else is already
  // starting. Only wakes whose task is still genuinely up for grabs reserve
  // anything; a wake for a task that became blocked or was taken meanwhile is
  // settled by the loop above and must not hold capacity hostage.
  let reserved = 0
  const pendingTasks = new Set<string>()
  for (const taskId of team.pendingWakes.keys()) {
    const key = String(taskId)
    if (!upForGrabs.has(key)) continue
    reserved += 1
    pendingTasks.add(key)
  }
  // The hourly wake budget is measured over the last hour of *actual* wakes,
  // so age out the stamps first, publish the gauge, and hand the remaining
  // allowance to the planner. It caps `slots`, which is why a spent budget
  // shows up as `why=budget` instead of a board that mysteriously has room and
  // an autopilot that sends nothing.
  const rolledAt = Date.now()
  team.wakeStamps = pruneWakeStamps(team.wakeStamps, rolledAt)
  team.wakesThisHour = team.wakeStamps.length
  team.wakeBudget = config.wakeBudgetPerHour
  const allowance = wakeAllowance(config.wakeBudgetPerHour, team.wakeStamps, rolledAt)

  const { plans, blocked } = planDispatch({
    tasks,
    members,
    maxConcurrent: budget,
    avoid,
    parked,
    reserved,
    pending: pendingTasks,
    wakeAllowance: allowance,
  })
  const summary = boardSummary(tasks, members, budget, parked, reserved)

  // Diagnostics: capture what this round actually saw, so the status tool can
  // explain "why nothing dispatched" without guesswork.
  team.ticks += 1
  team.tasks = summary.tasks
  team.inFlight = summary.inFlight
  team.claimable = summary.claimable
  team.blocked = summary.blocked
  team.done = summary.done
  team.idle = summary.idle
  team.slots = summary.slots
  // Cumulative, like every other counter here: "how many skip decisions has
  // this team produced" is the number worth watching, and the split says
  // which fix applies 鈥?widen the scopes, add a member, ask the members why
  // they stopped taking work, or deal with a task that keeps coming back. One
  // task blocked for five rounds counts five times, on purpose.
  team.skipped += blocked.length
  for (const entry of blocked) {
    if (entry.kind === 'scope') team.skippedScope += 1
    else if (entry.kind === 'declined') team.skippedDeclined += 1
    else if (entry.kind === 'parked') team.skippedParked += 1
    else if (entry.kind === 'budget') team.skippedBudget += 1
    else team.skippedNoMember += 1
  }
  // The counters above are cumulative, so they are kept out of the status
  // signature on purpose. This is the round's own answer, and the only skip
  // fact allowed to make a round newsworthy: it changes when the reason
  // changes, not every time a task goes untaken.
  team.skipKinds = [...new Set(blocked.map(entry => entry.kind))].sort()
  team.lastTickAt = Date.now()
  state.rounds += 1

  if (!verdict.canDispatch) {
    // The board is now settled and summarized, so the log has something true to
    // say even on a round that sends nothing. A blocked round is exactly when
    // the file is worth reading, and going quiet here would hide the breaker at
    // the one moment an operator looks for it.
    await recordStatus(config, team, state.lastError)
    return breaker
  }

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
      // A dry-run wake spends no money, but it represents the same decision a
      // real one would, so it is charged to the budget. Otherwise turning on
      // `dryRun` would show a full hour of dispatch that the first real round
      // cannot reproduce.
      recordWakeStamp(team, now)
      recordDispatch(team, plan, now, false)
      breaker = recordSuccess(breaker)
      team.breaker = breaker.state
      continue
    }
    try {
      await sendWake(ctx, lead, plan, signal)
      team.dispatched += 1
      lastWake.set(plan.taskId, now)
      recordWakeStamp(team, now)
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

  // Last thing in the round, so the line records the state the round produced
  // rather than the one it started from 鈥?including the wakes just sent.
  await recordStatus(config, team, state.lastError)
  return breaker
}

/**
 * Drop the per-team bookkeeping of teams that no longer have a Lead.
 *
 * `loop` keeps four maps keyed by TeamId: wake stamps, reclaim stamps, one
 * circuit breaker, and one failure counter. Unlike the waiters beside them,
 * nothing used to remove entries for a team that went away, so a long-lived
 * host that keeps creating roots (one Team per session) kept one row per Team
 * it had ever seen 鈥?the same unbounded-growth shape as the state buckets, and
 * just as invisible until the process has been up for days.
 *
 * A team is only forgotten when no live Lead resolves to its key. A transient
 * empty `findLeads` must never reach this function: the round returns early on
 * that path precisely so a recomposition does not wipe suppression stamps,
 * breaker trips, and reclaim evidence that a surviving team still needs.
 * @param maps - per-team maps to prune; they may hold different value types.
 * @param live - TeamIds that still have a Lead.
 */
export function forgetMissing<K>(
  maps: ReadonlyArray<Map<K, unknown>>,
  live: ReadonlySet<K>,
): void {
  for (const map of maps) {
    for (const key of [...map.keys()]) {
      if (!live.has(key)) map.delete(key)
    }
  }
}

/**
 * Drop wake stamps that can no longer change a decision.
 *
 * A stamp means "this task was offered this recently". Two things end that
 * meaning, and neither is noticed while the entry sits there: the cooldown
 * expires (the dispatch loop compares `now - stamp < wakeCooldownMs`, so an
 * older stamp can never suppress anything again), or the task leaves the board.
 * Nothing but the dispatch loop ever reads the map, and it only looks up tasks
 * that are about to be sent, so entries for tasks that were claimed, completed,
 * deleted, or simply forgotten accumulated for the life of the process: one
 * number and one task id per task this autopilot had ever dispatched. Same
 * shape as the state buckets and the per-team maps, and just as invisible.
 *
 * Pruning both kinds keeps the map proportional to the tasks actually in play,
 * and removes a latent surprise: a deleted task whose id is later reused used
 * to inherit the old task's cooldown and look refused for no reason.
 * @param lastWake - per-task suppression timestamps, mutated in place.
 * @param tasks - the board as read this round.
 * @param now - current timestamp.
 * @param cooldownMs - the window the stamps are meant to cover.
 */
export function pruneWakeMap(
  lastWake: Map<string, number>,
  tasks: readonly TeamTaskView[],
  now: number,
  cooldownMs: number,
): void {
  const onBoard = new Set(tasks.map(task => String(task.id)))
  for (const [taskId, at] of lastWake) {
    if (!onBoard.has(taskId) || now - at >= cooldownMs) lastWake.delete(taskId)
  }
}

/**
 * Main loop: wait for one edge, then re-read and dispatch.
 *
 * Ordering matters. The waiter is registered *before* the board is read, so a
 * change landing during the round cannot be missed 鈥?`waitForChange` keeps no
 * history. Consecutive wait/tick failures back off exponentially (capped at
 * 30s) so a persistently broken host cannot spin the loop at full speed.
 *
 * The desktop host keeps several sessions (Teams) alive at once. Every round
 * serves the Leads whose own change-wait settled, so a autopilot can never bind
 * to the first-registered Team and ignore the rest. Per-team state (suppression
 * stamps and the circuit breaker) is keyed by the Team identity resolved from
 * each Lead, so one team's cooldown or breaker never bleeds into another's.
 *
 * Every team carries its own armed waiter, and the round wakes on the first one
 * to fire. Awaiting the teams one after another instead would make the dispatch
 * latency grow with the number of live teams. Ticking every team on every wake
 * would make the *work* grow quadratically, so the round serves only the teams
 * whose wait settled 鈥?see `dirty` below.
 * @param ctx - host context.
 * @param config - resolved configuration.
 * @param state - autopilot state to update.
 * @param signal - cancellation signal.
 * @param liveness - observed turn boundaries, when tracking is enabled.
 */
export async function loop(
  ctx: Context,
  config: Required<Config>,
  state: AutopilotState,
  signal: AbortSignal,
  liveness?: Liveness,
): Promise<void> {
  // Per-team runtime state, keyed by the TeamId resolved from each Lead.
  const teamWake = new Map<string, Map<string, number>>()
  const teamBreaker = new Map<string, Breaker>()
  const teamStalled = new Map<string, Map<string, number>>()
  const teamFailures = new Map<string, number>()
  // One armed change-wait per team. A team's waiter is re-armed the moment it
  // fires, so no team is ever left unobserved and no edge slips through.
  const waiters = new Map<string, TeamWaiter>()
  // Teams whose wait has settled since the last round. A round serves these and
  // only these.
  //
  // Each team's wait expires on its own schedule, so with N live teams the
  // pre-dirty loop woke N times per interval and then ticked every team on
  // every wake: N虏 board reads where N would do. On a real host with two teams
  // that already showed up as rounds 11.6s and 18.4s apart against a 30s
  // interval 鈥?every team ticked twice per 30s, and `ticks` in the status line
  // silently reading double its configured rate. Serving only the teams that
  // actually woke keeps one tick per team per interval however many teams are
  // live.
  const dirty = new Set<string>()
  let waitFailed = false
  let failures = 0
  let lastRoundAt: number | undefined
  const spacingMs = Math.min(MIN_ROUND_SPACING_MS, config.tickTimeoutMs)

  // One line per process start, so the log says which build and which settings
  // are running. Without it a stale profile and a current one look the same
  // until something misbehaves.
  if (config.statusFile !== '') {
    await appendStatusLine(config.statusFile, startupLine(Date.now(), config))
  }

  const teamKeyFor = (lead: Agent): string => {
    const membership = ctx.agentTeams.tryMembership(lead)
    return membership === undefined ? 'default' : String(membership.id)
  }

  /**
   * Arm a change-wait for one team and keep it armed.
   *
   * The waiter is re-armed as soon as it settles 鈥?before the round reads any
   * board 鈥?so a change that lands while the round is running is still
   * observed by the next round.
   * @param lead - the live Lead to wait on.
   * @param teamKey - stable identity of the team.
   */
  const arm = (lead: Agent, teamKey: string): void => {
    if (signal.aborted) return
    let failed = false
    const promise = ctx.agentTeams.waitForChange(lead, config.tickTimeoutMs, signal).then(
      () => { dirty.add(teamKey) },
      (error: unknown) => {
        failed = true
        waitFailed = true
        dirty.add(teamKey)
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
    const now = Date.now()
    const cutoff = now - config.wakeCooldownMs
    for (const wake of teamWake.values()) {
      for (const [taskId, at] of wake) if (at < cutoff) wake.delete(taskId)
    }
    // Turn observations outlive their usefulness as soon as no decision can
    // still use them, and a name that left the roster would otherwise keep its
    // slot for the life of the process. The window is the longest one that can
    // still be consulted: the reclaim grace, measured from a turn that has
    // already ended.
    if (liveness !== undefined) {
      liveness.prune(now - Math.max(config.reclaimAfterMs, config.livenessGraceMs) * 2)
    }
  }

  while (!signal.aborted) {
    // The whole round is fenced so one host exception cannot silently kill the
    // loop. `findLeads` (session recomposition), the change-wait race, and the
    // per-team `tick` each touch the live agent registry, and any of them can
    // reject while the host is recomposing sessions. Without this fence the
    // rejection propagates to the async boundary of `loop`, the `while` exits,
    // and dispatch, reclaim and park all die with no error recorded 鈥?the
    // worst failure shape, a silent one.
    try {
      await runRound()
    } catch (error: unknown) {
      if (signal.aborted) return
      state.lastError = describe(error)
      // A round-level failure (resolving Leads, racing the change-waits) is
      // usually transient 鈥?session recomposition settles in milliseconds 鈥?so
      // it gets a fixed short pause, not the exponential back-off reserved for
      // a host that keeps failing to send or to wait. Reusing `failures` here
      // would let one recomposition spike the back-off to 30s and stall a
      // recovered host for half a minute for no reason.
      await pause(2_000, signal)
      if (signal.aborted) return
    }
  }
  return

  /**
   * One round: resolve Leads, arm waiters, wait for one edge, serve the teams
   * that woke. Extracted so the whole thing sits under a single fence in the
   * loop above.
   */
  async function runRound(): Promise<void> {
    const leads = findLeads(ctx)
    if (leads.length === 0) {
      waiters.clear()
      dirty.clear()
      await pause(2_000, signal)
      return
    }

    // Arm a waiter for every live team that has none, and replace any waiter
    // bound to a Lead that has since been replaced. Every waiter is armed
    // before any board read, so no edge can be missed.
    const live = new Set(leads.map(lead => teamKeyFor(lead)))
    for (const lead of leads) {
      const teamKey = teamKeyFor(lead)
      const current = waiters.get(teamKey)
      if (current === undefined || current.lead !== lead) {
        waiters.delete(teamKey)
        arm(lead, teamKey)
      }
    }
    // Forget teams that no longer exist 鈥?their waiter, and the bookkeeping
    // behind it, which is keyed by the same TeamId.
    for (const teamKey of [...waiters.keys()]) {
      if (!live.has(teamKey)) waiters.delete(teamKey)
    }
    forgetMissing([teamWake, teamStalled, teamBreaker, teamFailures], live)

    // Wake on the first team to report a change (or to time out), instead of
    // waiting for every team's turn in turn. A change that landed while the
    // previous round was running is already queued in `dirty`, so it is served
    // straight away instead of waiting out another interval.
    if (dirty.size === 0) {
      await Promise.race([...waiters.values()].map(waiter => waiter.promise))
      if (signal.aborted) return
    }

    // A host whose change-wait fails must not spin the loop at full speed: the
    // failed wait has already queued its team, so back off before serving it.
    if (waitFailed) {
      waitFailed = false
      failures += 1
      await pause(backoffMs(failures), signal)
      if (signal.aborted) return
    }

    // A change-wait that settles for the wrong reason 鈥?instantly, on every
    // message rather than on a board change 鈥?would otherwise spin the loop at
    // full speed: each settle queues its team, and a queued team is served
    // without waiting. One round per second is orders of magnitude more than
    // the interval needs, and it bounds the damage of a misbehaving wait.
    if (lastRoundAt !== undefined) {
      const since = Date.now() - lastRoundAt
      if (since < spacingMs) await pause(spacingMs - since, signal)
      if (signal.aborted) return
    }
    lastRoundAt = Date.now()
    // `rounds` counts *dispatch* rounds, which are the `tick`s below 鈥?not
    // this loop iteration. One loop pass can serve several teams (several
    // ticks) or none at all (an empty edge), so counting here would inflate
    // the total with the number of live teams and with idle spins. It is
    // counted once per tick in `tick`.

    // Serve the teams that actually woke this round. The status line reports
    // one tick per team per interval; waking every team on every wake is what
    // made that count grow with the number of live teams.
    const woken = new Set(dirty)
    dirty.clear()
    const serving = woken.size === 0
      ? leads
      : leads.filter(lead => woken.has(teamKeyFor(lead)))

    for (const lead of serving) {
      if (signal.aborted) return
      const teamKey = teamKeyFor(lead)
      const wake = teamWake.get(teamKey) ?? new Map<string, number>()
      teamWake.set(teamKey, wake)
      const stalled = teamStalled.get(teamKey) ?? new Map<string, number>()
      teamStalled.set(teamKey, stalled)
      let breaker = teamBreaker.get(teamKey) ?? createBreaker()

      try {
        breaker = await tick(ctx, lead, config, state, teamKey, wake, stalled, breaker, signal, liveness)
        teamFailures.set(teamKey, 0)
        failures = 0
      } catch (error: unknown) {
        if (signal.aborted) return
        state.lastError = describe(error)
        // Back off per *team*, not globally. A team that keeps failing should
        // back off on its own schedule; using the shared `failures` here meant
        // one healthy team's success reset the back-off for a team that was
        // still failing, so the failing team never got past a 2s pause.
        const teamFail = (teamFailures.get(teamKey) ?? 0) + 1
        teamFailures.set(teamKey, teamFail)
        await pause(backoffMs(teamFail), signal)
        if (signal.aborted) return
        continue
      }
      teamBreaker.set(teamKey, breaker)
    }
    prune()
  }
}
