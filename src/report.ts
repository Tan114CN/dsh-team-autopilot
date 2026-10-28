/**
 * Status report assembly and rendering.
 *
 * The autopilot observes many teams at once, and each team has its own board,
 * its own counters, and its own "last seen" moment. The previous status
 * output flattened all of that into one line, mixing lifetime totals across
 * every team with the board snapshot of whichever team happened to tick last
 * — with no timestamp, so a reader could not tell a stale snapshot from a
 * current one, nor which team a number belonged to.
 *
 * This module is pure: it takes already-collected facts and shapes them.
 * The tool collects the facts (see `src/index.ts`); this module decides how
 * they are presented, so the two can never drift apart.
 */

import type { BreakerState } from './breaker.ts'
import type { DispatchRecord, ReclaimRecord } from './state.ts'

/** One team's counters and the board as of its last observation. */
export interface TeamReport {
  /** Stable team identity (the `TeamId` of the team's root session). */
  team: string
  /** Times this team's board was read and dispatched for. */
  ticks: number
  /** Wake messages sent for this team. */
  dispatched: number
  /** Wake attempts suppressed by the cooldown for this team. */
  suppressed: number
  /** Ready tasks skipped, one count per skip decision. */
  skipped: number
  /** Skips caused by the write-scope soft lock. */
  skippedScope: number
  /** Skips caused by there being no idle teammate left. */
  skippedNoMember: number
  /** Skips caused by every idle teammate having already declined the task. */
  skippedDeclined: number
  /** Wakes still unowned at the next board read. */
  unclaimed: number
  /** Circuit-breaker state for this team. */
  breaker: BreakerState
  /** Times this team's breaker tripped. */
  breakerTrips: number
  /** Rounds this team's breaker blocked. */
  breakerBlocked: number
  /** Tasks handed back to the pool after their owner stalled. */
  reclaimed: number
  /** Board size at the team's last observation. */
  tasks: number
  /** Slots occupied at the team's last observation. */
  inFlight: number
  /** Ready, unowned tasks at the team's last observation. */
  claimable: number
  /** Unowned tasks waiting on their dependencies at the last observation. */
  blocked: number
  /** Finished tasks at the team's last observation. */
  done: number
  /** Idle teammates at the team's last observation. */
  idle: number
  /** Free concurrency slots at the team's last observation. */
  slots: number
  /** Epoch milliseconds of the team's last observation. */
  lastTickAt?: number
  /** This team's most recent reclaim. */
  lastReclaim?: ReclaimRecord
  /** This team's most recent dispatch. */
  lastDispatch?: DispatchRecord
}

/** The caller's own team, read live at the moment of the call. */
export interface LiveBoard {
  /** Stable team identity of the caller's team. */
  team: string
  /** Tasks on the board right now. */
  tasks: number
  /** Slots occupied right now. */
  inFlight: number
  /** Ready, unowned tasks right now. */
  claimable: number
  /** Unowned tasks waiting on their dependencies right now. */
  blocked: number
  /** Finished tasks right now. */
  done: number
  /** Teammates eligible to take new work right now. */
  idle: number
  /** Free concurrency slots right now. */
  slots: number
}

/**
 * The full status report.
 *
 * `rounds`, `dispatched`, `suppressed`, and `skipped` are lifetime totals
 * across every team the autopilot has served. The `teams` array breaks the
 * same numbers down per team, each with its own timestamp. `caller` is the
 * live board of the team that asked — the one number a caller can trust to
 * be current.
 */
export interface StatusReport {
  /** Whether the plugin is enabled. */
  enabled: boolean
  /** Whether the plugin only records decisions instead of sending messages. */
  dryRun: boolean
  /** Lifetime dispatch rounds across every team. */
  rounds: number
  /** Lifetime wake messages sent across every team. */
  dispatched: number
  /** Lifetime wake attempts suppressed across every team. */
  suppressed: number
  /** Lifetime tasks skipped across every team. */
  skipped: number
  /** Lifetime wakes still unowned at the next board read, across every team. */
  unclaimed: number
  /** Lifetime tasks handed back to the pool across every team. */
  reclaimed: number
  /** One entry per live team. */
  teams: TeamReport[]
  /** The caller's own team, read live. Absent when the caller is not in a team. */
  caller?: LiveBoard
  /** Most recent error seen by the dispatch loop. */
  lastError?: string
}

/**
 * Render a status report as human-readable lines.
 *
 * The caller's live board is printed first and labelled, so it is never
 * confused with the per-team snapshots, which carry an age.
 * @param report - the report to render.
 * @param now - current epoch milliseconds, used to compute snapshot ages.
 * @returns one line per fact.
 */
export function renderReport(report: StatusReport, now: number): string[] {
  const lines: string[] = []
  lines.push(`autopilot ${report.enabled && !report.dryRun ? 'active' : 'inactive'}`)
  lines.push(`totals rounds=${report.rounds} dispatched=${report.dispatched} suppressed=${report.suppressed} skipped=${report.skipped} unclaimed=${report.unclaimed} reclaimed=${report.reclaimed}`)
  if (report.caller !== undefined) {
    const live = report.caller
    lines.push(`caller team=${live.team} tasks=${live.tasks} inFlight=${live.inFlight} claimable=${live.claimable} blocked=${live.blocked} done=${live.done} idle=${live.idle} slots=${live.slots} (live)`)
  }
  lines.push(`teams=${report.teams.length}`)
  for (const team of report.teams) {
    const age = team.lastTickAt === undefined ? 'never' : `${Math.max(0, now - team.lastTickAt)}ms ago`
    lines.push(
      `  team=${team.team} ticks=${team.ticks} dispatched=${team.dispatched} suppressed=${team.suppressed}`
      + ` skipped=${team.skipped} (scope=${team.skippedScope} noMember=${team.skippedNoMember} declined=${team.skippedDeclined})`
      + ` breaker=${team.breaker} trips=${team.breakerTrips} held=${team.breakerBlocked}`
      + ` reclaimed=${team.reclaimed} unclaimed=${team.unclaimed}`
      + ` tasks=${team.tasks} inFlight=${team.inFlight} claimable=${team.claimable} blocked=${team.blocked} done=${team.done} idle=${team.idle} slots=${team.slots} (${age})`,
    )
    // The last two decisions, spelled out. A counter says "something happened
    // twice"; these say which task, from/to whom, and how long ago — the whole
    // difference between recognising a loop and guessing at one.
    //
    // "none" is printed rather than the line being skipped: an absent line and
    // a version that cannot report it at all look identical to a reader, which
    // is exactly the ambiguity an operator cannot afford.
    if (team.lastReclaim === undefined) {
      lines.push('    lastReclaim none')
    } else {
      const reclaim = team.lastReclaim
      lines.push(
        `    lastReclaim task=${reclaim.taskId} from=${reclaim.previousOwner}`
        // Single quotes outside, because the reason itself quotes the owner's
        // name with double quotes — nesting the same character makes the
        // boundary impossible to see.
        + ` reason='${reclaim.reason}' ${reclaim.applied ? 'applied' : 'dry-run'}`
        + ` (${Math.max(0, now - reclaim.at)}ms ago)`,
      )
    }
    if (team.lastDispatch === undefined) {
      lines.push('    lastDispatch none')
    } else {
      const dispatch = team.lastDispatch
      const outcome = dispatch.claimed === undefined
        ? 'not-checked-yet'
        : dispatch.claimed ? 'claimed' : 'unclaimed'
      lines.push(
        `    lastDispatch task=${dispatch.taskId} to=${dispatch.memberName}`
        + ` wakes=${dispatch.repeats} ${dispatch.sent ? 'sent' : 'dry-run'} outcome=${outcome}`
        + ` (${Math.max(0, now - dispatch.at)}ms ago)`,
      )
    }
    if (team.unclaimed >= 2) {
      lines.push(
        `    warning: ${team.unclaimed} wakes went unclaimed — a member that never claims`
        + ' holds the dispatch channel while its task stays in the pool',
      )
    }
    // Every idle member has already had this task and passed. Dispatch has
    // stopped on purpose: repeating the wake would burn tokens without ever
    // reaching a member that accepts, so the fix is human.
    if (team.skippedDeclined > 0) {
      lines.push(
        `    note: ${team.skippedDeclined} skips because every idle member already declined`
        + ' — dispatch is holding back rather than re-waking the same members',
      )
    }
  }
  if (report.lastError !== undefined) lines.push(`lastError=${report.lastError}`)
  return lines
}
