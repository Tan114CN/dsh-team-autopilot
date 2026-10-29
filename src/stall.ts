/**
 * Running-turn stall watch — pure functions only, no host access.
 *
 * {@link planReclaim} answers "this owner is not working on it any more". It
 * deliberately never touches a `running` owner: a turn in progress is the
 * normal case, and there is no duration after which "still thinking" becomes
 * provably wrong. That caution has a matching blind spot, though. A turn can
 * wedge — a driver that never returns, a model stream that was never cleaned
 * up, a member cancelled in a way that never wrote a terminal status — and then
 * the task stays `in_progress` with its slot held *while the member reports
 * itself busy*. Nothing else in the autopilot can see that:
 *
 * - reclaim skips it, because `running` is not evidence of a stall;
 * - the breaker never trips, because no operation failed;
 * - the board looks exactly like healthy work, so every idle member waits and
 *   `slots` stays at zero until a human notices.
 *
 * This module is the missing half: it watches the opposite state and says when
 * "busy for a long time" has become "busy for too long". It never releases
 * anything itself — a wedged turn can only be ended by interrupting its member,
 * which is the caller's decision (see `interruptStalled`).
 *
 * Everything here is inferred from elapsed time, so the rule is deliberately
 * the timid one: the observation window starts at the *later* of the moment the
 * task was first seen in this state and the moment its current turn started,
 * and a task seen for the first time is never judged at all. An observation
 * this module does not have can only make it wait longer, never cut a turn
 * short.
 */

import type { TeamMemberView, TeamTaskView } from '@deepseek-ai/dsh-experimental-agent-team'
import type { Liveness } from './liveness.ts'
import { isInFlight } from './select.ts'

/** One in-flight task whose owner has been busy for too long. */
export interface StallWarning {
  /** Task the owner is holding. */
  readonly taskId: string
  /** Member that appears to be stuck. */
  readonly ownerName: string
  /** Status the owner was in when the stall was observed. */
  readonly status: 'running' | 'provisioning'
  /**
   * Epoch milliseconds the observation window opened.
   *
   * The later of the task's first sighting in this state and the start of the
   * owner's current turn, so it is the earliest moment the task can honestly
   * be said to have gone quiet.
   */
  readonly since: number
  /** How long the owner has been busy on this task, in milliseconds. */
  readonly forMs: number
  /**
   * Whether the caller can end this stall on its own.
   *
   * A `running` teammate can be interrupted; a `provisioning` one has no turn
   * to cancel yet, and a Lead is never the autopilot's to cancel.
   */
  readonly interruptible: boolean
  /**
   * Epoch milliseconds this owner was last interrupted for this same stall.
   *
   * Carried through the observation table so a repeated warning is not a
   * repeated interrupt: an interrupted member may need a moment to write its
   * terminal status, and interrupting the same turn twice would be both
   * pointless and confusing.
   */
  readonly interruptedAt?: number
  /** Human-readable cause, surfaced in diagnostics. */
  readonly reason: string
}

/** One task's stall observation, carried across rounds. */
export interface StallRecord {
  /** Epoch milliseconds the current observation window opened. */
  readonly since: number
  /** Epoch milliseconds this owner was last interrupted for this stall. */
  readonly interruptedAt?: number
}

/** Inputs for one stall-watch pass. */
export interface StallInput {
  /** Current board. */
  readonly tasks: readonly TeamTaskView[]
  /** Current roster. */
  readonly members: readonly TeamMemberView[]
  /** Current epoch milliseconds. */
  readonly now: number
  /**
   * How long an owner may stay busy on one task before it is reported.
   *
   * Zero disables the watch entirely.
   */
  readonly stalledAfterMs: number
  /** Task id to its current stall observation. */
  readonly seen: ReadonlyMap<string, StallRecord>
  /** Observed turn starts, when available. */
  readonly liveness?: Liveness | undefined
}

/** What to report, plus the updated observation table. */
export interface StallResult {
  /** Tasks whose owner has been busy past the limit. */
  readonly warnings: readonly StallWarning[]
  /**
   * Updated observation table.
   *
   * Rebuilt from the current board on every pass, so an entry exists exactly
   * while its task is in flight under a busy owner — the table cannot grow
   * with ids that are no longer in play.
   */
  readonly seen: ReadonlyMap<string, StallRecord>
}

/**
 * Find in-flight tasks whose owner has been busy for longer than the limit.
 *
 * Only a `running` or `provisioning` teammate qualifies. An `inactive` owner is
 * {@link planReclaim}'s problem, a `failed` one is already released, and a Lead
 * is never judged. What remains is the one case nothing else covers: work that
 * looks alive and can never finish.
 *
 * @param input - board, roster, clock, limit, and the observation table.
 * @returns the warnings and the updated observation table.
 */
export function planStallWatch(input: StallInput): StallResult {
  const seen = new Map<string, StallRecord>()
  if (input.stalledAfterMs <= 0) return { warnings: [], seen }

  const roster = new Map<string, TeamMemberView>()
  for (const member of input.members) roster.set(member.name, member)

  const warnings: StallWarning[] = []
  for (const task of input.tasks) {
    // An unowned or finished task holds nothing, so there is no turn to judge.
    if (!isInFlight(task) || task.ownerName == null) continue
    const owner = roster.get(task.ownerName)
    if (owner === undefined) continue
    if (owner.role !== 'teammate') continue
    if (owner.status !== 'running' && owner.status !== 'provisioning') continue

    const taskId = String(task.id)
    const previous = input.seen.get(taskId)
    const turnStart = input.liveness?.runningSince(owner.name)

    // The window opens at the first sighting and is only ever pushed *later*,
    // by a turn that started after it. A first sighting is never judged: the
    // turn may have begun long before this task was claimed, and charging that
    // earlier time to this task would interrupt a member that has only just
    // picked the work up.
    let since: number
    let restarted = false
    if (previous === undefined) {
      since = input.now
    } else {
      since = previous.since
      if (turnStart !== undefined && turnStart > since) {
        since = turnStart
        // A turn that started after the last interrupt is a *new* stall. Keeping
        // the old `interruptedAt` here would silently grant the member one free
        // stall per process: interrupted once, it starts another turn, runs too
        // long again, and this time the "only interrupt once" guard swallows it.
        restarted = true
      }
    }

    const record: StallRecord = restarted || previous?.interruptedAt === undefined
      ? { since }
      : { since, interruptedAt: previous.interruptedAt }
    seen.set(taskId, record)

    const forMs = input.now - since
    if (forMs < input.stalledAfterMs) continue
    warnings.push({
      taskId,
      ownerName: owner.name,
      status: owner.status,
      since,
      forMs,
      // Only a running turn has something to cancel.
      interruptible: owner.status === 'running',
      ...(record.interruptedAt === undefined ? {} : { interruptedAt: record.interruptedAt }),
      reason: owner.status === 'running'
        ? `owner "${owner.name}" has been running ${forMs}ms without finishing`
        : `owner "${owner.name}" has been provisioning ${forMs}ms without starting`,
    })
  }

  return { warnings, seen }
}
