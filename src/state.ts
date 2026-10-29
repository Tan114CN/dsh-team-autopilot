/**
 * Autopilot state, split into per-team buckets plus global totals.
 *
 * The previous design kept one flat `AutopilotState` whose per-team fields
 * (`team`, `tasks`, `inFlight`, `claimable`, `idle`, `slots`) were overwritten
 * by whichever team ticked last, while the counters (`rounds`, `dispatched`,
 * `suppressed`) accumulated across every team. Mixing both scopes in one
 * object made the status output unreadable: a reader could not tell which
 * team a board snapshot belonged to, nor whether it was still current — and
 * `breakerTrips` was a global count sitting next to a per-team breaker state.
 *
 * The split below makes the scope of every number explicit:
 * - `teams` holds one bucket per TeamId, each with its own counters and its
 *   own "last seen" board, timestamped so staleness is visible.
 * - the top-level counters are totals across every team.
 */

import type { BreakerState } from './breaker.ts'
import type { StallRecord } from './stall.ts'

/**
 * One running-turn stall the autopilot observed.
 *
 * `planReclaim` releases an owner that is *not* working on its task any more;
 * this reports the opposite and worse state — an owner that looks busy and can
 * never finish. Kept as a record rather than a counter because the useful fact
 * is which task and how long, not just how many.
 */
export interface StallRecordView {
  /** Id of the task the stuck owner is holding. */
  taskId: string
  /** Member that appears to be stuck. */
  ownerName: string
  /** How long the owner had been busy when the stall was seen, in ms. */
  forMs: number
  /** Epoch milliseconds of the observation. */
  at: number
}

/**
 * One reclaim the autopilot performed.
 *
 * A bare `reclaimed` counter answers "how many", never "which one and why" —
 * which is exactly the question that matters when a task keeps coming back:
 * without the task id and the previous owner, a reclaim loop is invisible and
 * has to be inferred from a revision number creeping upwards.
 */
export interface ReclaimRecord {
  /** Id of the task that was handed back to the pool. */
  taskId: string
  /** Human-readable cause, as produced by `planReclaim`. */
  reason: string
  /** Member the task was taken from. */
  previousOwner: string
  /** Epoch milliseconds of the release. */
  at: number
  /** Whether the `reassign` was actually sent; false under `dryRun`. */
  applied: boolean
}

/**
 * A wake that has been sent and is still owed its post-wake check.
 *
 * `at` is what makes the check honest. The board looks the same whether a
 * member is about to claim or never will, so the answer only exists after the
 * member has had a fair chance to react — the check waits for the wake's
 * cooldown instead of running on the very next read.
 */
export interface PendingWake {
  /** Member that was woken for this task. */
  memberName: string
  /** Epoch milliseconds the wake was sent. */
  at: number
  /**
   * True when nothing was actually sent (`dryRun`), so the wake is a forecast.
   *
   * It must still reserve its slot for the cooldown — otherwise a dry run would
   * re-plan the same wakes every round and predict a busier stream than the
   * real mode ever produces. But it must never be *judged*: nobody was asked,
   * so settling it as "unclaimed" would invent a refusal and push that member
   * into the declined set, which then blocks the very dispatch the dry run is
   * supposed to be demonstrating.
   */
  simulated?: boolean
}

/**
 * One dispatch the autopilot performed.
 *
 * `claimed` is filled in on a later board read — once the wake's cooldown has
 * expired: a wake that is never answered looks identical to a successful one
 * at the moment it is sent, and only time tells them apart.
 */
export interface DispatchRecord {
  /** Id of the task that was handed out. */
  taskId: string
  /** Member that was woken for it. */
  memberName: string
  /** Epoch milliseconds of the most recent wake for this hand-off. */
  at: number
  /**
   * How many times this task has been woken for this member.
   *
   * A repeated wake is the loop signature worth seeing: the autopilot hands
   * the same task to the same member over and over because nothing else in
   * the report distinguishes "woken once" from "woken eight times".
   */
  repeats: number
  /** Whether a wake message was actually sent; false under `dryRun`. */
  sent: boolean
  /**
   * Whether the task had an owner the next time the board was read.
   * Undefined until that check has run.
   */
  claimed?: boolean
}

/**
 * A task the autopilot stopped handing out.
 *
 * Reclaiming a stalled owner is right, but doing it forever is not: the task
 * goes back to the pool, the next member claims it and stalls just as quietly,
 * and the cycle repeats at one model turn per lap. A task that has come back
 * this many times is not waiting for a slot — it is evidence that no member can
 * finish it, and the fix is a human decision, not another wake.
 */
export interface ParkRecord {
  /** Id of the parked task. */
  taskId: string
  /** How many times the task was reclaimed before it was parked. */
  reclaims: number
  /** Member the task was last taken from. */
  previousOwner: string
  /** Epoch milliseconds the task was parked. */
  at: number
}

/**
 * Why a ready task went untaken in one round.
 *
 * Five causes, five different fixes: widen the write scopes, add a member, ask
 * the member why it is not taking work, look at a task that keeps coming back,
 * or raise the hourly wake budget. A closed union on purpose — a typo must not
 * be able to invent a sixth cause that nobody knows how to act on.
 */
export type SkipKind = 'scope' | 'noMember' | 'declined' | 'parked' | 'budget'

/** One team's observable counters and the board as of its last tick. */
export interface TeamState {
  /** Stable team identity: the `TeamId` of the team's root session. */
  team: string
  /** Times this team's board was read and dispatched for. */
  ticks: number
  /** Wake messages sent for this team. */
  dispatched: number
  /** Wake attempts suppressed by the cooldown for this team. */
  suppressed: number
  /** Ready tasks skipped, one count per skip decision (see the split below). */
  skipped: number
  /** Skips caused by the write-scope soft lock. */
  skippedScope: number
  /** Skips caused by there being no idle teammate left. */
  skippedNoMember: number
  /** Skips caused by every idle teammate having already declined the task. */
  skippedDeclined: number
  /** Skips caused by the task being parked after repeated reclaims. */
  skippedParked: number
  /**
   * Skips caused by the hourly wake budget being spent.
   *
   * Separate from the other four because it is the only cause that is working
   * as configured rather than going wrong: a non-zero value says "this team
   * wanted to start more work than you allowed it to pay for this hour", which
   * is an answer, not a fault.
   */
  skippedBudget: number
  /**
   * Why the **last** round skipped ready tasks, deduplicated and sorted.
   *
   * The four counters above are cumulative, so they climb on every round a
   * task goes untaken and say nothing about the round in hand — which is why
   * they are excluded from the status signature. This set is the round's own
   * answer, and it changes only when the reason changes. That makes it the one
   * piece of skip information that is both quiet and worth reporting: "this
   * team started being blocked by write scopes" and "the last member just
   * refused, so dispatch has stopped" both land on an operator immediately,
   * instead of waiting for the heartbeat.
   */
  skipKinds: SkipKind[]
  /**
   * Members per task that were woken and did not claim, carried across rounds.
   *
   * A member keeps its roster position when it ignores a wake, so without this
   * record the same task is handed to the same member round after round while
   * an idle colleague never gets a turn. Cleared as soon as the task changes
   * hands (claimed, completed, or reclaimed) — a member that was merely
   * starting up deserves another chance once the situation has moved.
   *
   * Internal bookkeeping: it never reaches the report, which shows the
   * outcome of the decision rather than the machinery behind it.
   */
  declined: Map<string, Set<string>>
  /**
   * Wakes that were still unowned at the next board read.
   *
   * One or two are normal — a member may be starting up. A count that keeps
   * climbing means the member being woken never claims, and it holds the
   * dispatch channel while the task sits in the pool.
   */
  unclaimed: number
  /** Circuit-breaker state for this team. */
  breaker: BreakerState
  /** Times this team's breaker tripped. */
  breakerTrips: number
  /** Rounds this team's breaker blocked. */
  breakerBlocked: number
  /** Tasks handed back to the pool after their owner stalled. */
  reclaimed: number
  /**
   * Reclaims per task id, carried across rounds.
   *
   * This is the number that tells a genuine one-off stall apart from a task no
   * member can finish: the first is released once and completes, the second
   * comes back every cooldown. Cleared when the task finishes, leaves the
   * board, or is taken up again by somebody — a task that moved on no longer
   * needs its history held against it.
   */
  reclaimCounts: Map<string, number>
  /**
   * Tasks the autopilot no longer hands out, keyed by task id.
   *
   * A parked task stays visible on the board and stays claimable by a human or
   * the Lead — the autopilot only stops waking members for it. Nothing else
   * would end the loop: every lap looks like a fresh, legitimate stall.
   */
  parked: Map<string, ParkRecord>
  /** This team's most recent park, if any. */
  lastPark?: ParkRecord
  /** Board size at the team's last tick. */
  tasks: number
  /** Slots occupied at the team's last tick. */
  inFlight: number
  /** Ready, unowned tasks at the team's last tick. */
  claimable: number
  /** Unowned tasks waiting on their dependencies at the team's last tick. */
  blocked: number
  /** Finished tasks at the team's last tick. */
  done: number
  /** Idle teammates at the team's last tick. */
  idle: number
  /** Free concurrency slots at the team's last tick. */
  slots: number
  /** Epoch milliseconds of the team's last tick, or undefined if never. */
  lastTickAt: number | undefined
  /** This team's most recent reclaim, if any. */
  lastReclaim?: ReclaimRecord
  /** This team's most recent dispatch, if any. */
  lastDispatch?: DispatchRecord
  /**
   * Wakes that are still owed a post-wake check, keyed by task id.
   *
   * Per task rather than a single flag: one round can wake several members at
   * once, and each of those hand-offs owes its own answer. With a single flag
   * every wake but the last one in a round was silently never judged, so a
   * member that ignored its task was never recorded as having refused it.
   *
   * Bookkeeping plus one number: the report shows *how many* wakes are still
   * owed an answer, never which member or task they belong to. The count is
   * the part an operator can act on — "two wakes are in flight right now" is
   * invisible from a `lastDispatch` that can only remember one of them.
   */
  pendingWakes: Map<string, PendingWake>
  /**
   * Everything the last written status line said except its timestamp and tick
   * count, so an unchanged round can be recognised without writing it.
   */
  lastStatusSignature: string | undefined
  /** Epoch milliseconds of the last written status line, if any. */
  lastStatusAt: number | undefined
  /**
   * Reclaims performed this round, as `taskId<previousOwner`, in order.
   *
   * A single `lastReclaim` can only remember one release, so a round that
   * reclaimed three stalled owners used to log only the last. This array keeps
   * every release of the round so the log says *which* tasks came back, not
   * just that some did. Cleared at the start of each round.
   */
  reclaimsThisRound: string[]
  /**
   * Parks performed this round, as `taskId<previousOwner`, in order.
   *
   * The same single-record problem as {@link reclaimsThisRound}: a round that
   * parked two tasks logged only the last. Kept as an array for the log.
   * Cleared at the start of each round.
   */
  parksThisRound: string[]
  /**
   * Unparks performed this round, as bare task ids, in order.
   *
   * Unparking was previously invisible: the event line only fired while the
   * park was live, so the round that cleared it changed nothing and the log
   * never said "this task is offered again". This array makes the stand-off
   * ending as newsworthy as the one beginning. Cleared at the start of each
   * round.
   */
  unparksThisRound: string[]
  /**
   * Running-turn stall observations, keyed by task id, carried across rounds.
   *
   * Same shape and same lifecycle as the reclaim table: an entry appears the
   * first time a task is seen held by a busy owner and disappears as soon as
   * that stops being true. Rebuilt from the board every round, so it is bounded
   * by the tasks actually in this state.
   */
  stallSeen: Map<string, StallRecord>
  /** In-flight tasks with a busy owner past the stall limit at the last tick. */
  stalled: number
  /**
   * Stall warnings reported, one per task per round it stayed stalled.
   *
   * Cumulative, and the number worth watching: while the same task is stalled
   * it climbs once per tick, so a large value next to a small `stallWarnings`
   * on other teams means one team is quietly wedged, not that the board is
   * hopping.
   */
  stallWarnings: number
  /** Stalled turns the autopilot interrupted (only with `interruptStalled`). */
  stallInterrupts: number
  /** This team's most recent stall, if any. */
  lastStall?: StallRecordView
  /**
   * Tasks stalled this round, as `taskId<ownerName`, in order.
   *
   * The event line needs the round's own answer, the same way
   * {@link reclaimsThisRound} does: a single `lastStall` remembers only one of
   * possibly several wedged turns. Cleared at the start of each round.
   */
  stallsThisRound: string[]
  /**
   * Whether the last attempt to append to `statusFile` failed.
   *
   * A `false` here is only ever set when a write was attempted. It exists
   * because the status file is the single channel a headless user reads, and
   * every way it can break (relative path, directory that does not exist, a
   * permission the sandbox took away) fails identically on every round and used
   * to leave no trace at all. The flag clears on the first write that lands, so
   * it reports a live problem rather than a remembered one.
   */
  statusWriteFailed: boolean
  /**
   * When this team's most recent wakes were started, oldest first.
   *
   * The wake budget is measured against this list rather than a counter, so a
   * burst just before the window edge still counts against the next burst. It
   * is pruned every round and can never outgrow the configured budget, since
   * no stamp is added once the allowance is spent.
   */
  wakeStamps: number[]
  /** Wakes inside the current window, as of the last tick (report gauge). */
  wakesThisHour: number
  /**
   * The budget in force at the last tick, for rendering.
   *
   * Kept on the bucket so the status line can print `wakes=used/limit` without
   * reaching for the config; `0` renders as `off`.
   */
  wakeBudget: number
}

/** Autopilot-wide observable state. */
export interface AutopilotState {
  /**
   * One bucket per team, keyed by `TeamId`.
   *
   * Buckets outlive the team that produced them so the lifetime counters and
   * the totals stay derivable from one source of truth, but the map is capped
   * (see {@link MAX_TEAM_BUCKETS}): a long-lived host that keeps meeting new
   * teams would otherwise grow this map forever. Eviction always picks the
   * least recently ticked bucket, so a live team is never a victim.
   */
  teams: Map<string, TeamState>
  /**
   * When this process started counting.
   *
   * Every counter in this file is in-memory, so all of them restart at zero
   * when the host restarts: dispatch totals, reclaim counts, declined members,
   * the breaker, the hourly wake budget. That is deliberate (the plugin owns no
   * durable state, see the README), but it makes a bare `dispatched=3`
   * unreadable — three in the last five minutes and three in the last three
   * days call for opposite reactions. The age of this number is the missing
   * denominator, and it is the one fact that explains why a budget can look
   * untouched moments after it was spent.
   */
  startedAt: number
  /** Dispatch rounds across every team. */
  rounds: number
  /** Most recent error seen by the loop, if any. */
  lastError: string | undefined
}

/**
 * Build a fresh state with no teams seen yet.
 * @returns an empty autopilot state.
 */
export function createAutopilotState(): AutopilotState {
  return {
    teams: new Map(),
    startedAt: Date.now(),
    rounds: 0,
    lastError: undefined,
  }
}

/**
 * Upper bound on remembered team buckets.
 *
 * A bucket is created the first time a team is seen and is deliberately kept
 * while the team lives: it carries the counters a human reads to decide what
 * to do next, and dropping it after a quiet spell would erase exactly the
 * history that explains why the team went quiet.
 *
 * What it must not do is grow without bound. A long-lived host that creates and
 * tears down teams (one per session, or a test harness that mints fresh TeamIds)
 * would otherwise leak a bucket per team forever, and the status report grows
 * with it. The real working set is one or two teams, so the cap is generous and
 * eviction only ever takes the least recently ticked bucket — a live team ticks
 * every round, so it can never be the victim.
 */
const MAX_TEAM_BUCKETS = 32

/**
 * Drop the bucket that has gone the longest without a tick.
 * @param state - autopilot state to mutate.
 */
function evictLeastRecentlyTicked(state: AutopilotState): void {
  let victim: string | undefined
  let oldest = Number.POSITIVE_INFINITY
  // Insertion order breaks ties, so an equal-age map still evicts deterministically
  // (the team seen first goes first).
  for (const [key, bucket] of state.teams) {
    const seen = bucket.lastTickAt ?? 0
    if (seen < oldest) {
      oldest = seen
      victim = key
    }
  }
  if (victim !== undefined) state.teams.delete(victim)
}

/**
 * Get or create the bucket for one team.
 * @param state - autopilot state to mutate.
 * @param team - stable team identity.
 * @returns that team's bucket.
 */
export function teamState(state: AutopilotState, team: string): TeamState {
  const existing = state.teams.get(team)
  if (existing !== undefined) return existing
  if (state.teams.size >= MAX_TEAM_BUCKETS) evictLeastRecentlyTicked(state)
  const created: TeamState = {
    team,
    ticks: 0,
    dispatched: 0,
    suppressed: 0,
    skipped: 0,
    skippedScope: 0,
    skippedNoMember: 0,
    skippedDeclined: 0,
    skippedParked: 0,
    skippedBudget: 0,
    skipKinds: [],
    declined: new Map(),
    unclaimed: 0,
    breaker: 'closed',
    breakerTrips: 0,
    breakerBlocked: 0,
    reclaimed: 0,
    reclaimCounts: new Map(),
    parked: new Map(),
    tasks: 0,
    inFlight: 0,
    claimable: 0,
    blocked: 0,
    done: 0,
    idle: 0,
    slots: 0,
    lastTickAt: undefined,
    pendingWakes: new Map(),
    lastStatusSignature: undefined,
    lastStatusAt: undefined,
    reclaimsThisRound: [],
    parksThisRound: [],
    unparksThisRound: [],
    stallSeen: new Map(),
    stalled: 0,
    stallWarnings: 0,
    stallInterrupts: 0,
    stallsThisRound: [],
    statusWriteFailed: false,
    wakeStamps: [],
    wakesThisHour: 0,
    wakeBudget: 0,
  }
  state.teams.set(team, created)
  return created
}
