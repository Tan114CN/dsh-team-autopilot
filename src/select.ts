/**
 * Scheduler decision core — pure functions only, no host access.
 *
 * Every rule here mirrors the native task board so the scheduler can never
 * disagree with the state it reads:
 *  - readiness comes from the derived `ready` flag, never from `status`
 *  - write-scope overlap uses the same `/`-segmented prefix rule
 *  - `inactive` is the only teammate status that can be woken
 */

import type { TeamMemberView, TeamTaskView } from '@deepseek-ai/dsh-experimental-agent-team'

/** One planned hand-off from a ready task to an idle teammate. */
export interface DispatchPlan {
  readonly taskId: string
  readonly taskRevision: number
  readonly taskSubject: string
  readonly memberName: string
}

/** Why one ready task was skipped this round. */
export interface BlockedTask {
  readonly taskId: string
  readonly reason: string
}

/** Scheduler limits, all validated by the caller. */
export interface PlanInput {
  readonly tasks: readonly TeamTaskView[]
  readonly members: readonly TeamMemberView[]
  /** Upper bound of concurrently in-flight tasks. */
  readonly maxConcurrent: number
}

/** One scheduler decision round. */
export interface PlanResult {
  readonly plans: readonly DispatchPlan[]
  readonly blocked: readonly BlockedTask[]
  /** Tasks already `in_progress` when the round started. */
  readonly inFlight: number
}

/**
 * Normalize one workspace-relative write scope.
 * Backslashes become slashes; leading `./` and surrounding slashes drop.
 * @param scope - raw scope declared on a task.
 * @returns comparable scope, possibly empty.
 */
export function normalizeScope(scope: string): string {
  let value = scope.trim().replace(/\\/g, '/')
  while (value.startsWith('./')) value = value.slice(2)
  value = value.replace(/^\/+/, '').replace(/\/+$/, '')
  return value
}

/**
 * Whether two write scopes overlap on path components.
 * Identical to the native `scopesOverlap` in `task-view.ts`, with one
 * deliberate difference: an empty scope means "unspecified" and never
 * conflicts, so undeclared tasks are not silently blocked.
 * @param left - one scope.
 * @param right - the other scope.
 * @returns whether either scope contains the other.
 */
export function scopesOverlap(left: string, right: string): boolean {
  const a = normalizeScope(left)
  const b = normalizeScope(right)
  if (a === '' || b === '') return false
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
}

/**
 * Tasks that may be handed out right now.
 * Uses the derived `ready` flag: `pending` with every blocker completed.
 * @param tasks - current board.
 * @returns ready tasks with no owner, in board order.
 */
export function claimableTasks(tasks: readonly TeamTaskView[]): TeamTaskView[] {
  return tasks.filter(task =>
    task.status === 'pending'
    && task.ready
    // Real runtime serializes an unowned task as `ownerName: null`, not
    // undefined, so the loose comparison is deliberate.
    && task.ownerName == null)
}

/** One scope held by work that is already in flight or claimed. */
interface HeldScope {
  readonly scope: string
  readonly taskId: string
}

/**
 * Collect scopes that new work must not take.
 * Both `in_progress` tasks and owner-claimed `pending` tasks hold their
 * scopes, so a scheduler cannot hand out a colliding task before the
 * previous owner starts it.
 * @param tasks - current board.
 * @param excludeTaskId - task being evaluated, excluded from its own check.
 * @returns held scopes with their task ids.
 */
export function heldScopes(tasks: readonly TeamTaskView[], excludeTaskId?: string): HeldScope[] {
  const held: HeldScope[] = []
  for (const task of tasks) {
    if (task.id === excludeTaskId) continue
    const active = task.status === 'in_progress'
      || (task.status === 'pending' && task.ownerName != null)
    if (!active) continue
    for (const raw of task.writeScopes) {
      const scope = normalizeScope(raw)
      if (scope !== '') held.push({ scope, taskId: task.id })
    }
  }
  return held
}

/**
 * Find the first write-scope collision for one task.
 * @param task - task being evaluated.
 * @param tasks - current board.
 * @returns a human-readable conflict, or undefined when clear.
 */
export function findScopeConflict(
  task: TeamTaskView,
  tasks: readonly TeamTaskView[],
): string | undefined {
  const held = heldScopes(tasks, task.id)
  if (held.length === 0) return undefined
  for (const raw of task.writeScopes) {
    for (const entry of held) {
      if (scopesOverlap(raw, entry.scope)) {
        return `write scope "${raw}" collides with "${entry.scope}" held by task ${entry.taskId}`
      }
    }
  }
  return undefined
}

/**
 * Members that can actually take new work.
 * Only `inactive` teammates qualify: a running member is mid-turn, a
 * provisioning one does not exist yet, and a failed one is gone. A member
 * already holding an unfinished task is excluded.
 * @param members - current roster.
 * @param tasks - current board.
 * @returns eligible teammates in roster order.
 */
export function availableMembers(
  members: readonly TeamMemberView[],
  tasks: readonly TeamTaskView[],
): TeamMemberView[] {
  const busy = new Set<string>()
  for (const task of tasks) {
    // `ownerName` is `null` on the wire for an unowned task; skip it.
    if (task.ownerName == null) continue
    if (task.status === 'completed' || task.status === 'deleted') continue
    busy.add(task.ownerName)
  }
  return members.filter(member =>
    member.role === 'teammate'
    && member.status === 'inactive'
    && !busy.has(member.name))
}

/**
 * Decide one round of dispatch.
 * Pairs ready unowned tasks with idle teammates, skipping any task whose
 * write scopes collide with work already in flight or already planned in
 * this same round.
 * @param input - board, roster, and the concurrency ceiling.
 * @returns plans, skipped tasks with reasons, and the in-flight count.
 */
export function planDispatch(input: PlanInput): PlanResult {
  const { tasks, members, maxConcurrent } = input
  const inFlight = tasks.filter(task => task.status === 'in_progress').length
  const slots = Math.max(0, maxConcurrent - inFlight)
  const free = availableMembers(members, tasks)

  const plans: DispatchPlan[] = []
  const blocked: BlockedTask[] = []
  const plannedScopes: Array<{ scope: string; taskId: string }> = []

  for (const task of claimableTasks(tasks)) {
    if (plans.length >= slots) break

    const conflict = findScopeConflict(task, tasks)
      ?? plannedScopes.find(entry =>
        task.writeScopes.some(raw => scopesOverlap(raw, entry.scope)))
    if (conflict !== undefined) {
      const reason = typeof conflict === 'string'
        ? conflict
        : `write scope "${conflict.scope}" already planned for task ${conflict.taskId}`
      blocked.push({ taskId: task.id, reason })
      continue
    }

    const member = free[plans.length]
    if (member === undefined) {
      blocked.push({ taskId: task.id, reason: 'no idle teammate available' })
      continue
    }

    plans.push({
      taskId: task.id,
      taskRevision: task.revision,
      taskSubject: task.subject,
      memberName: member.name,
    })
    for (const raw of task.writeScopes) {
      const scope = normalizeScope(raw)
      if (scope !== '') plannedScopes.push({ scope, taskId: task.id })
    }
  }

  return { plans, blocked, inFlight }
}

/**
 * Build the peer message that wakes one teammate for one task.
 * Deliberately does not claim the task: the teammate owns the native
 * `list → get → claim` flow, so the scheduler cannot steal ownership.
 * @param plan - planned hand-off.
 * @returns plain text instruction.
 */
export function wakeMessage(plan: DispatchPlan): string {
  return [
    `[team-scheduler] Task ${plan.taskId} is ready and unowned: ${plan.taskSubject}`,
    '',
    `Claim it with team_task_update (action "claim", expected_revision ${plan.taskRevision}), then do the work.`,
    'If another member already claimed it, pick the next ready task instead.',
  ].join('\n')
}
