/**
 * Stalled-task reclaim — pure functions only, no host access.
 *
 * Native Agent Teams never releases a task owner by itself. Its own docs are
 * explicit: the owner is **not** released automatically for inactivity,
 * interruption, process exit, or failed work. So the moment a member stops,
 * its task stays `in_progress` forever — holding its write scopes and its
 * concurrency slot — and no other member may claim it. A team loses
 * throughput one stalled owner at a time, silently.
 *
 * This module decides when such a task should go back to the pool. It never
 * touches host state: it reports what to release and why, and the caller
 * performs the `reassign`.
 *
 * Reclaimed tasks return **to the pool**, not to a named replacement: the
 * next dispatch round picks them up through the same path as any other ready
 * task, so they are re-checked against the write-scope soft lock and the
 * concurrency budget instead of bypassing them.
 */

import type { TeamMemberView, TeamTaskView } from '@deepseek-ai/dsh-experimental-agent-team'
import { isInFlight } from './select.ts'

/** One task that should be handed back to the pool. */
export interface ReclaimTarget {
  /**
   * Id of the task to release.
   *
   * Typed as the task view's own id — a branded `TeamTaskId`, not a bare
   * `string` — so the caller can pass it straight into `updateTask`.
   */
  readonly taskId: TeamTaskView['id']
  /** Revision the decision was based on, for the compare-and-set. */
  readonly revision: number
  /**
   * The member the task was taken from.
   *
   * Dispatch uses this to avoid handing the task straight back to the same
   * member in the round that reclaimed it.
   */
  readonly previousOwner: string
  /**
   * The epoch ms the task was first seen stalled, when the release was a
   * grace-period expiry.
   *
   * Absent for the immediate causes (owner gone, owner failed): those have no
   * observation window to resume. Present for an inactive owner that outlived
   * `reclaimAfterMs`. The caller uses it to put the stall stamp back if the
   * `reassign` write fails — otherwise a failed release resets the grace
   * period and the task gets a whole fresh `reclaimAfterMs` before the next
   * attempt, defeating the "retry next round" contract.
   */
  readonly sinceAt?: number
  /** Human-readable cause, surfaced in diagnostics. */
  readonly reason: string
}

/** Inputs for one reclaim decision. */
export interface ReclaimInput {
  /** Current board. */
  readonly tasks: readonly TeamTaskView[]
  /** Current roster. */
  readonly members: readonly TeamMemberView[]
  /** Current epoch milliseconds. */
  readonly now: number
  /** How long an inactive owner may hold a task before it is reclaimed. */
  readonly reclaimAfterMs: number
  /** Whether a `failed` owner hands its task back at once. */
  readonly reclaimOnFailed: boolean
  /** Task id to the epoch ms it was first seen stalled. */
  readonly stalled: ReadonlyMap<string, number>
}

/** What to release, plus the updated stall observation table. */
export interface ReclaimResult {
  /** Tasks to hand back to the pool, with the reason for each. */
  readonly releases: readonly ReclaimTarget[]
  /**
   * Updated observation table.
   *
   * An entry appears the first time a task is seen stalled and is dropped as
   * soon as the task is released or becomes healthy again, so the map stays
   * bounded by the tasks that are actually stalled right now.
   */
  readonly stalled: ReadonlyMap<string, number>
}

/**
 * Decide which in-flight tasks have stalled and should return to the pool.
 *
 * Only work that occupies a slot can stall a team. Three owners count as
 * stalled, in descending certainty:
 *
 * 1. **owner gone** — the owner name is no longer on the roster, so the
 *    member was removed or its process exited. Nothing can ever finish the
 *    task, so it is released immediately.
 * 2. **owner failed** — the member reached a terminal `failed` state. Also
 *    released immediately, unless `reclaimOnFailed` is off.
 * 3. **owner inactive** — the member has no turn running. This is also true
 *    of a member that was just woken and is still starting, so it only counts
 *    once it has held the task for `reclaimAfterMs`.
 *
 * A `running` or `provisioning` owner is never evidence of a stall, and work
 * held by the Lead is never reclaimed: releasing it would discard work the
 * human-facing driver is doing.
 *
 * @param input - board, roster, clock, limits, and the stall table.
 * @returns what to release and the updated stall table.
 */
export function planReclaim(input: ReclaimInput): ReclaimResult {
  const roster = new Map<string, TeamMemberView>()
  for (const member of input.members) roster.set(member.name, member)

  const releases: ReclaimTarget[] = []
  const stalled = new Map<string, number>(input.stalled)

  for (const task of input.tasks) {
    // Only claimed or in-progress work holds a slot. An unclaimed pending task
    // is already available to everyone, so there is nothing to reclaim.
    if (!isInFlight(task) || task.ownerName == null) {
      stalled.delete(task.id)
      continue
    }
    const owner = roster.get(task.ownerName)

    if (owner === undefined) {
      // The owner left the roster entirely. Native Teams never notices this.
      stalled.delete(task.id)
      releases.push({
        taskId: task.id,
        revision: task.revision,
        reason: `owner "${task.ownerName}" is no longer on the roster`,
        previousOwner: task.ownerName,
      })
      continue
    }
    if (owner.role !== 'teammate') {
      // The Lead holds this one; leave it alone.
      stalled.delete(task.id)
      continue
    }
    if (owner.status === 'failed') {
      stalled.delete(task.id)
      if (input.reclaimOnFailed) {
        releases.push({
          taskId: task.id,
          revision: task.revision,
          reason: `owner "${owner.name}" failed`,
          previousOwner: owner.name,
        })
      }
      continue
    }
    if (owner.status !== 'inactive') {
      // `running` is mid-turn, `provisioning` has not started yet.
      stalled.delete(task.id)
      continue
    }

    const since = stalled.get(task.id)
    if (since === undefined) {
      // First observation. Give the member its grace period before judging.
      stalled.set(task.id, input.now)
      continue
    }
    const held = input.now - since
    if (held >= input.reclaimAfterMs) {
      stalled.delete(task.id)
      releases.push({
        taskId: task.id,
        revision: task.revision,
        reason: `owner "${owner.name}" inactive for ${held}ms`,
        previousOwner: owner.name,
        sinceAt: since,
      })
    }
  }
  return { releases, stalled }
}
