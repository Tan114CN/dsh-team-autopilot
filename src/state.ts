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
 * One dispatch the autopilot performed.
 *
 * `claimed` is filled in on the *next* board read: a wake that is never
 * answered looks identical to a successful one at the moment it is sent, and
 * only the next round can tell them apart.
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
   * Whether `lastDispatch` still owes its post-wake check.
   *
   * A wake can only be judged once — counting "still unowned" on every
   * subsequent round would inflate the number with rounds in which no wake
   * was even sent. This flag is internal bookkeeping and never leaves the
   * state bucket: the report shows the outcome, not the machinery.
   */
  lastDispatchPending: boolean
  /**
   * Everything the last written status line said except its timestamp and tick
   * count, so an unchanged round can be recognised without writing it.
   */
  lastStatusSignature: string | undefined
  /** Epoch milliseconds of the last written status line, if any. */
  lastStatusAt: number | undefined
}

/** Autopilot-wide observable state. */
export interface AutopilotState {
  /**
   * One bucket per team, keyed by `TeamId`.
   *
   * Buckets are never removed, so lifetime per-team counters survive the team
   * that produced them and the totals can be derived from these buckets
   * without a second source of truth drifting out of sync.
   */
  teams: Map<string, TeamState>
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
    rounds: 0,
    lastError: undefined,
  }
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
  const created: TeamState = {
    team,
    ticks: 0,
    dispatched: 0,
    suppressed: 0,
    skipped: 0,
    skippedScope: 0,
    skippedNoMember: 0,
    skippedDeclined: 0,
    declined: new Map(),
    unclaimed: 0,
    breaker: 'closed',
    breakerTrips: 0,
    breakerBlocked: 0,
    reclaimed: 0,
    tasks: 0,
    inFlight: 0,
    claimable: 0,
    blocked: 0,
    done: 0,
    idle: 0,
    slots: 0,
    lastTickAt: undefined,
    lastDispatchPending: false,
    lastStatusSignature: undefined,
    lastStatusAt: undefined,
  }
  state.teams.set(team, created)
  return created
}
