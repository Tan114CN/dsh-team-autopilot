/**
 * Turn-boundary observation, from `agent/status` instead of from a clock.
 *
 * Everything that waits for a teammate to react used to be judged by elapsed
 * time alone. Two decisions depend on it, and both are guesses:
 *
 * - **did the wake land?** — after `sendMessage`, the board reads the same
 *   whether a member is about to claim or never will, so the autopilot waits
 *   out `wakeCooldownMs` and then looks. Waiting too long means a member that
 *   refused holds the dispatch channel for a whole cooldown; too short and the
 *   check reads the member's *thinking time* and files a refusal that never
 *   happened.
 * - **has the owner stalled?** — an `inactive` owner is evidence, but a weak
 *   one: it also describes a member that was never woken, or one that is
 *   between turns. So it only counts after `reclaimAfterMs`, which is set long
 *   enough to cover the case that is not a stall at all.
 *
 * Both are the same unresolved question — *is a turn still running?* — and the
 * kernel already answers it out loud: `agent/status` fires on every `idle` ⇄
 * `running` transition. A `running` → `idle` edge is a turn ending, which is
 * the exact moment both questions become answerable.
 *
 * So this module watches those edges and turns them into one number per
 * member: the moment its most recent turn ended. That is proof the member was
 * reached and finished reacting, which no duration can establish.
 *
 * It is deliberately not a replacement for the clocks. A tracker has only what
 * it has seen: a member already mid-turn when the plugin loaded produces no
 * `running` edge, and a host that never emits leaves the table empty. Every
 * caller therefore treats a missing observation as "unknown" and falls back to
 * the duration it used before — the worst case of this module is the current
 * behaviour, never something more aggressive.
 *
 * The tracker itself holds no host reference, so it can be driven directly in
 * headless tests; only {@link trackLiveness} touches `ctx`.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'

/**
 * How many members may be tracked before the oldest are dropped.
 *
 * Bounded because the roster is not the only source of names: a name that
 * leaves the team would otherwise keep its slot forever, and the table lives
 * for as long as the host process does.
 */
const MAX_TRACKED = 512

/** One member's observed turn activity. */
interface MemberLiveness {
  /** Most recent status seen. */
  status: AgentStatus
  /** Epoch milliseconds of the most recent transition. */
  since: number
  /** Epoch milliseconds the member most recently entered `running`. */
  lastRunningAt: number | undefined
  /** Epoch milliseconds the member most recently entered `idle`. */
  lastIdleAt: number | undefined
}

/**
 * Observed turn boundaries, keyed by the member's model-facing name.
 *
 * Keyed by name rather than by the `Agent` object because every other
 * cross-round map in the autopilot (`declined`, `pendingWakes`) is keyed the
 * same way, and a strong reference to a live `Agent` would outlive the member
 * it describes.
 */
export interface Liveness {
  /**
   * Record one status transition for one member.
   * @param name - the member's model-facing name.
   * @param status - the status just entered.
   * @param at - epoch milliseconds of the transition.
   */
  mark(name: string, status: AgentStatus, at: number): void
  /**
   * Epoch milliseconds the member's most recent turn ended.
   *
   * Defined only for a **complete** `running` → `idle` edge: the member must
   * have been seen entering `running`, and must not have entered `running`
   * again since. A bare `idle` is not enough — that is also the state of a
   * member that has not been woken yet, and reporting it would let every
   * caller conclude a turn had finished when none had started.
   *
   * @param name - the member's model-facing name.
   * @returns the moment that turn ended, or undefined when no complete edge
   *   has been observed for this member.
   */
  lastTurnEndAt(name: string): number | undefined
  /**
   * Epoch milliseconds the member's current turn started.
   *
   * Defined only while the member was last seen `running` *and* its entry into
   * that turn was observed. This is the one honest clock for "how long has this
   * turn been going": the status `running` alone says nothing about when it
   * began, and a member that was already mid-turn when the plugin loaded
   * produces no edge, so it reports undefined and the caller must fall back to
   * its own first-sighting stamp.
   * @param name - the member's model-facing name.
   * @returns the moment the current turn started, or undefined when the start
   *   was never observed.
   */
  runningSince(name: string): number | undefined
  /** Whether the member was last seen with a driver active. */
  isRunning(name: string): boolean
  /**
   * Drop members whose most recent transition is older than a cutoff.
   *
   * The table is read on every round and never shrinks on its own, so without
   * this a host that rotates members would carry one entry per name ever seen.
   * @param cutoff - epoch milliseconds; entries last touched before it go.
   */
  prune(cutoff: number): void
}

/**
 * Build an empty tracker.
 * @returns a tracker with no observations.
 */
export function createLiveness(): Liveness {
  const table = new Map<string, MemberLiveness>()

  const mark = (name: string, status: AgentStatus, at: number): void => {
    const existing = table.get(name)
    if (existing === undefined) {
      table.set(name, {
        status,
        since: at,
        lastRunningAt: status === 'running' ? at : undefined,
        lastIdleAt: status === 'idle' ? at : undefined,
      })
      return
    }
    // Only a change of status is a transition; the kernel emits the status
    // that was entered, and a repeat of the same status carries no edge.
    if (existing.status !== status) {
      if (status === 'running') existing.lastRunningAt = at
      else existing.lastIdleAt = at
      existing.status = status
    }
    existing.since = at
    // Insertion order doubles as a recency order, so the oldest entries are at
    // the front and can be dropped without scanning for them.
    table.delete(name)
    table.set(name, existing)
    if (table.size > MAX_TRACKED) {
      const oldest = table.keys().next()
      if (oldest.done !== true) table.delete(oldest.value)
    }
  }

  const lastTurnEndAt = (name: string): number | undefined => {
    const entry = table.get(name)
    if (entry === undefined) return undefined
    if (entry.lastIdleAt === undefined || entry.lastRunningAt === undefined) return undefined
    // A `running` edge newer than the `idle` one means the member started
    // another turn, so the previous end no longer describes its state.
    if (entry.lastIdleAt < entry.lastRunningAt) return undefined
    return entry.lastIdleAt
  }

  const runningSince = (name: string): number | undefined => {
    const entry = table.get(name)
    if (entry === undefined || entry.status !== 'running') return undefined
    return entry.lastRunningAt
  }

  const isRunning = (name: string): boolean => table.get(name)?.status === 'running'

  const prune = (cutoff: number): void => {
    for (const [name, entry] of table) {
      if (entry.since < cutoff) table.delete(name)
    }
  }

  return { mark, lastTurnEndAt, runningSince, isRunning, prune }
}

/**
 * Feed `agent/status` transitions into a tracker.
 *
 * Subscribed on the plugin's own context, so the listener is unregistered when
 * the plugin is disposed — no manual teardown.
 *
 * Agents outside a team are skipped: the autopilot only ever judges members,
 * and resolving a name for every agent in the process would put subagents and
 * standalone sessions in the table for nothing.
 *
 * @param ctx - host context, used for the subscription and for resolving the
 *   member name behind an agent.
 * @param liveness - tracker to update.
 */
export function trackLiveness(ctx: Context, liveness: Liveness): void {
  ctx.on('agent/status', ({ agent, status }: { agent: Agent; status: AgentStatus }) => {
    const membership = ctx.agentTeams.tryMembership(agent)
    if (membership === undefined) return
    liveness.mark(membership.name, status, Date.now())
  })
}
