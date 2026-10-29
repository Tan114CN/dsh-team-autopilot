/**
 * Zero-dependency self-check for the autopilot decision core.
 *
 * `select.ts` imports types only, so Node's type stripping runs this directly
 * with no node_modules at all:  node tests/verify.ts
 */

import assert from 'node:assert/strict'
import {
  availableMembers,
  claimableTasks,
  findScopeConflict,
  heldScopes,
  normalizeScope,
  planDispatch,
  scopesOverlap,
  wakeMessage,
} from '../src/select.ts'
import type { DispatchPlan } from '../src/select.ts'
import {
  createBreaker,
  evaluate,
  recordError,
  recordSuccess,
  resolveBudget,
} from '../src/breaker.ts'
import type { BreakerConfig } from '../src/breaker.ts'
import { findLeads } from '../src/lead.ts'
import { boardSummary, callerBoard } from '../src/select.ts'
import { formatUptime, healthOf, renderReport } from '../src/report.ts'
import { toTeamReport } from '../src/report.ts'
import type { StatusReport, TeamReport } from '../src/report.ts'
import type { TeamMemberView, TeamTaskView } from '@deepseek-ai/dsh-experimental-agent-team'
import { planReclaim } from '../src/reclaim.ts'
import { planStallWatch } from '../src/stall.ts'
import { createLiveness } from '../src/liveness.ts'
import { appendStatusLineWith, startupLine, statusLine, statusSignature } from '../src/observe.ts'
import { teamState } from '../src/state.ts'
import { createAutopilotState } from '../src/state.ts'
import { forgetMissing, pruneWakeMap } from '../src/dispatch.ts'
import { WAKE_WINDOW_MS, pruneWakeStamps, wakeAllowance } from '../src/budget.ts'

/** Build one task view with sane defaults. `id` stays a plain string here. */
function task(over: Omit<Partial<TeamTaskView>, 'id'> & { id: string }): TeamTaskView {
  return {
    revision: 1,
    subject: 'example task',
    description: '',
    status: 'pending',
    blockedBy: [],
    writeScopes: [],
    ready: true,
    writeScopeWarnings: [],
    // Real runtime serializes an unowned task as `ownerName: null`, not
    // undefined. Default to that so every test exercises the real shape.
    ownerName: null as unknown as string,
    ...over,
  } as unknown as TeamTaskView
}

/** Build one member view. */
function member(
  name: string,
  status: TeamMemberView['status'],
  role: 'lead' | 'teammate' = 'teammate',
): TeamMemberView {
  return { id: name, name, role, status, diagnostics: [] } as unknown as TeamMemberView
}

let passed = 0
const failures: string[] = []

function test(label: string, body: () => void): void {
  try {
    body()
    passed += 1
  } catch (error: unknown) {
    failures.push(`${label} → ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Async twin of {@link test}. The log trim is filesystem work, so the one test
 * that covers it cannot be driven inline like the pure functions.
 */
async function testAsync(label: string, body: () => Promise<void>): Promise<void> {
  try {
    await body()
    passed += 1
  } catch (error: unknown) {
    failures.push(`${label} → ${error instanceof Error ? error.message : String(error)}`)
  }
}

test('normalizeScope strips ./ and trailing slashes', () => {
  assert.equal(normalizeScope('./src/a/'), 'src/a')
  assert.equal(normalizeScope('src\\a'), 'src/a')
  assert.equal(normalizeScope('/abs/path'), 'abs/path')
})

test('scopesOverlap is path-segmented, not raw string prefix', () => {
  assert.equal(scopesOverlap('src/a', 'src/a'), true)
  assert.equal(scopesOverlap('src/a', 'src/a/b'), true)
  assert.equal(scopesOverlap('src/a', 'src/ab'), false)
})

test('empty scope never conflicts', () => {
  assert.equal(scopesOverlap('', 'src/a'), false)
  assert.equal(scopesOverlap('   ', 'src/a'), false)
})

test('claimableTasks requires derived ready AND no owner', () => {
  const board = [
    task({ id: 't1' }),
    task({ id: 't2', ready: false }),
    task({ id: 't3', ownerName: 'alice' }),
    task({ id: 't4', status: 'completed' }),
  ]
  const ids = claimableTasks(board).map(t => t.id)
  assert.deepEqual(ids, ['t1'])
})

test('heldScopes covers in_progress and owner-claimed pending', () => {
  const board = [
    task({ id: 't1', status: 'in_progress', writeScopes: ['src/auth'] }),
    task({ id: 't2', ownerName: 'bob', writeScopes: ['src/ui'] }),
    task({ id: 't3', status: 'completed', writeScopes: ['docs'] }),
    task({ id: 't4', writeScopes: ['never-claimed'] }),
  ]
  const scopes = heldScopes(board).map(h => h.scope).sort()
  assert.deepEqual(scopes, ['src/auth', 'src/ui'])
})

test('findScopeConflict reports the colliding task', () => {
  const board = [
    task({ id: 't1', status: 'in_progress', writeScopes: ['src/auth'] }),
    task({ id: 't2', writeScopes: ['src/auth/token'] }),
  ]
  const conflict = findScopeConflict(board[1] as TeamTaskView, board)
  assert.ok(conflict?.includes('t1'), `expected mention of t1, got ${conflict}`)
})

test('findScopeConflict ignores the task itself', () => {
  const board = [task({ id: 't1', status: 'in_progress', writeScopes: ['src/a'] })]
  assert.equal(findScopeConflict(board[0] as TeamTaskView, board), undefined)
})

test('availableMembers only takes idle teammates holding no work', () => {
  const members = [
    member('lead', 'running', 'lead'),
    member('alice', 'inactive'),
    member('bob', 'running'),
    member('carol', 'provisioning'),
    member('dave', 'failed'),
    member('erin', 'inactive'),
  ]
  const board = [task({ id: 't1', ownerName: 'erin', status: 'in_progress' })]
  assert.deepEqual(availableMembers(members, board).map(m => m.name), ['alice'])
})

test('null ownerName counts as unowned, not busy', () => {
  const board = [task({ id: 't1', ready: true, ownerName: null as unknown as string })]
  assert.deepEqual(claimableTasks(board).map(t => t.id), ['t1'])
  assert.equal(heldScopes(board).length, 0)
  assert.equal(availableMembers([member('alice', 'inactive')], board).length, 1)
})

test('planDispatch fills slots up to maxConcurrent', () => {
  const board = [task({ id: 't1' }), task({ id: 't2' }), task({ id: 't3' })]
  const members = [member('alice', 'inactive'), member('bob', 'inactive'), member('carol', 'inactive')]
  const width2 = planDispatch({ tasks: board, members, maxConcurrent: 2 })
  assert.equal(width2.plans.length, 2)
  const width1 = planDispatch({ tasks: board, members, maxConcurrent: 1 })
  assert.equal(width1.plans.length, 1)
})

test('planDispatch treats an unclaimed wake as a committed slot', () => {
  // Slots used to count only in-flight work, so a round that had just woken two
  // members still saw both slots free until they claimed. On a board with more
  // ready tasks than members that re-woke the same pool every tick.
  const board = [task({ id: 't1' }), task({ id: 't2' }), task({ id: 't3' })]
  const members = [
    member('alice', 'inactive'),
    member('bob', 'inactive'),
    member('carol', 'inactive'),
  ]
  const free = planDispatch({ tasks: board, members, maxConcurrent: 2 })
  assert.equal(free.plans.length, 2)
  const reserved = planDispatch({ tasks: board, members, maxConcurrent: 2, reserved: 2 })
  assert.equal(reserved.plans.length, 0)
  // One wake outstanding still leaves exactly one real slot.
  const half = planDispatch({ tasks: board, members, maxConcurrent: 2, reserved: 1 })
  assert.equal(half.plans.length, 1)
})

test('boardSummary subtracts reserved wakes from slots', () => {
  const board = [task({ id: 't1' })]
  const members = [member('alice', 'inactive')]
  assert.equal(boardSummary(board, members, 2).slots, 2)
  assert.equal(boardSummary(board, members, 2, undefined, 1).slots, 1)
  // Clamped at zero: an outstanding wake can outnumber the budget briefly when
  // the budget was lowered, and a negative slot count would read as free room.
  assert.equal(boardSummary(board, members, 2, undefined, 5).slots, 0)
})

test('planStallWatch never judges a task the first time it sees it', () => {
  const board = [task({ id: 't1', status: 'in_progress', ownerName: 'alice' })]
  const members = [member('alice', 'running')]
  const first = planStallWatch({
    tasks: board,
    members,
    now: 1_000,
    stalledAfterMs: 900_000,
    seen: new Map(),
  })
  // No history yet: the turn may have started long before the task was claimed,
  // and charging that earlier time to this task would cancel honest work.
  assert.equal(first.warnings.length, 0)
  assert.equal(first.seen.get('t1')?.since, 1_000)
  const later = planStallWatch({
    tasks: board,
    members,
    now: 800_000,
    stalledAfterMs: 900_000,
    seen: first.seen,
  })
  assert.equal(later.warnings.length, 0)
  const over = planStallWatch({
    tasks: board,
    members,
    now: 901_000,
    stalledAfterMs: 900_000,
    seen: later.seen,
  })
  assert.equal(over.warnings.length, 1)
  assert.equal(over.warnings[0]?.taskId, 't1')
  assert.equal(over.warnings[0]?.ownerName, 'alice')
  assert.equal(over.warnings[0]?.forMs, 900_000)
  assert.equal(over.warnings[0]?.interruptible, true)
  assert.match(over.warnings[0]?.reason ?? '', /has been running 900000ms without finishing/)
})

test('planStallWatch reports a provisioning owner but will not interrupt it', () => {
  // A member whose turn has not started yet has nothing to cancel; reporting it
  // is still the point, because it holds its slot while looking alive.
  const board = [task({ id: 't1', status: 'in_progress', ownerName: 'alice' })]
  const members = [member('alice', 'provisioning')]
  const first = planStallWatch({
    tasks: board,
    members,
    now: 0,
    stalledAfterMs: 1_000,
    seen: new Map(),
  })
  const second = planStallWatch({
    tasks: board,
    members,
    now: 2_000,
    stalledAfterMs: 1_000,
    seen: first.seen,
  })
  assert.equal(second.warnings.length, 1)
  assert.equal(second.warnings[0]?.status, 'provisioning')
  assert.equal(second.warnings[0]?.interruptible, false)
  assert.match(second.warnings[0]?.reason ?? '', /has been provisioning/)
})

test('planStallWatch restarts its window when the turn restarts', () => {
  // The owner was busy on something else, went idle, then picked this task up.
  // The new turn is the only honest start for *this* task's window.
  const board = [task({ id: 't1', status: 'in_progress', ownerName: 'alice' })]
  const members = [member('alice', 'running')]
  const liveness = createLiveness()
  liveness.mark('alice', 'running', 500_000)
  const first = planStallWatch({
    tasks: board,
    members,
    now: 600_000,
    stalledAfterMs: 300_000,
    seen: new Map(),
    liveness,
  })
  assert.equal(first.seen.get('t1')?.since, 600_000)
  // Same turn, still running: the window stays put and eventually fires.
  const carried = planStallWatch({
    tasks: board,
    members,
    now: 700_000,
    stalledAfterMs: 300_000,
    seen: first.seen,
    liveness,
  })
  assert.equal(carried.seen.get('t1')?.since, 600_000)
  assert.equal(carried.warnings.length, 0)
  const fired = planStallWatch({
    tasks: board,
    members,
    now: 900_000,
    stalledAfterMs: 300_000,
    seen: carried.seen,
    liveness,
  })
  assert.equal(fired.warnings.length, 1)
  // A new turn after an idle gap pushes the window forward instead.
  liveness.mark('alice', 'idle', 950_000)
  liveness.mark('alice', 'running', 1_000_000)
  const restarted = planStallWatch({
    tasks: board,
    members,
    now: 1_050_000,
    stalledAfterMs: 300_000,
    seen: fired.seen,
    liveness,
  })
  assert.equal(restarted.seen.get('t1')?.since, 1_000_000)
  assert.equal(restarted.warnings.length, 0)
})

test('planStallWatch carries an interrupt forward instead of re-reporting it', () => {
  const board = [task({ id: 't1', status: 'in_progress', ownerName: 'alice' })]
  const members = [member('alice', 'running')]
  const seen = new Map([['t1', { since: 0, interruptedAt: 5_000 }]])
  const result = planStallWatch({
    tasks: board,
    members,
    now: 10_000,
    stalledAfterMs: 1_000,
    seen,
  })
  // Still reported — it is still wedged — but the interrupt is a fact the caller
  // can see, so it does not cancel the same turn twice while the member writes
  // the terminal status the first interrupt caused.
  assert.equal(result.warnings.length, 1)
  assert.equal(result.warnings[0]?.interruptedAt, 5_000)
  assert.equal(result.seen.get('t1')?.interruptedAt, 5_000)
})

test('planStallWatch grants a fresh interrupt after the member starts a new turn', () => {
  // Interrupted once. The member then starts another turn on the same task and
  // stalls again: carrying the old `interruptedAt` forward would make "only
  // interrupt once" mean "only interrupt once per process", and the second
  // stall would be reported forever without ever being cleared.
  const board = [task({ id: 't1', status: 'in_progress', ownerName: 'alice' })]
  const members = [member('alice', 'running')]
  const liveness = createLiveness()
  liveness.mark('alice', 'running', 20_000)
  const result = planStallWatch({
    tasks: board,
    members,
    now: 30_000,
    stalledAfterMs: 1_000,
    seen: new Map([['t1', { since: 0, interruptedAt: 5_000 }]]),
    liveness,
  })
  assert.equal(result.warnings.length, 1)
  assert.equal(result.warnings[0]?.since, 20_000, 'the new turn is the new window')
  assert.equal(result.warnings[0]?.interruptedAt, undefined, 'so it may be interrupted again')
  assert.equal(result.seen.get('t1')?.interruptedAt, undefined)
})

test('planStallWatch ignores idle owners, the Lead, and a zero window', () => {
  const board = [
    task({ id: 't1', status: 'in_progress', ownerName: 'alice' }),
    task({ id: 't2', status: 'in_progress', ownerName: 'boss' }),
  ]
  const members = [member('alice', 'inactive'), member('boss', 'running', 'lead')]
  const idle = planStallWatch({
    tasks: board,
    members,
    now: 10_000,
    stalledAfterMs: 1_000,
    seen: new Map([['t1', { since: 0 }], ['t2', { since: 0 }]]),
  })
  // An inactive owner is reclaim's business, a Lead is nobody's to cancel.
  assert.equal(idle.warnings.length, 0)
  assert.equal(idle.seen.size, 0)
  // Zero disables the watch and drops the table, so turning it off costs nothing.
  const off = planStallWatch({
    tasks: board,
    members: [member('alice', 'running')],
    now: 10_000,
    stalledAfterMs: 0,
    seen: new Map([['t1', { since: 0 }]]),
  })
  assert.equal(off.warnings.length, 0)
  assert.equal(off.seen.size, 0)
})

test('planDispatch subtracts in-flight work from the budget', () => {
  const board = [
    task({ id: 't0', status: 'in_progress', ownerName: 'alice' }),
    task({ id: 't1' }),
    task({ id: 't2' }),
  ]
  const members = [member('alice', 'running'), member('bob', 'inactive')]
  const result = planDispatch({ tasks: board, members, maxConcurrent: 2 })
  assert.equal(result.inFlight, 1)
  assert.equal(result.plans.length, 1)
})

test('planDispatch blocks a task whose scope is already in flight', () => {
  const board = [
    task({ id: 't0', status: 'in_progress', ownerName: 'alice', writeScopes: ['src/auth'] }),
    task({ id: 't1', writeScopes: ['src/auth/login'] }),
  ]
  const members = [member('alice', 'running'), member('bob', 'inactive')]
  const result = planDispatch({ tasks: board, members, maxConcurrent: 4 })
  assert.equal(result.plans.length, 0)
  assert.ok(result.blocked.some(b => b.taskId === 't1'))
})

test('planDispatch blocks colliding tasks inside the same round', () => {
  const board = [
    task({ id: 't1', writeScopes: ['src/a'] }),
    task({ id: 't2', writeScopes: ['src/a/deep'] }),
  ]
  const members = [member('alice', 'inactive'), member('bob', 'inactive')]
  const result = planDispatch({ tasks: board, members, maxConcurrent: 4 })
  assert.equal(result.plans.length, 1)
  assert.equal(result.blocked.length, 1)
})

test('planDispatch reports when no idle teammate is left', () => {
  const board = [task({ id: 't1' })]
  const result = planDispatch({ tasks: board, members: [], maxConcurrent: 4 })
  assert.equal(result.plans.length, 0)
  assert.match(result.blocked[0]?.reason ?? '', /no idle teammate/)
})

test('blocked tasks carry a machine-readable kind', () => {
  // Two ways to skip a task, with opposite remedies: widen the scopes, or
  // add a member. A free-text reason alone cannot be counted on.
  const scope = planDispatch({
    tasks: [
      task({ id: 't0', status: 'in_progress', ownerName: 'alice', writeScopes: ['src/auth'] }),
      task({ id: 't1', writeScopes: ['src/auth/login'] }),
    ],
    members: [member('alice', 'running'), member('bob', 'inactive')],
    maxConcurrent: 4,
  })
  assert.equal(scope.blocked[0]?.kind, 'scope')

  const noMember = planDispatch({
    tasks: [task({ id: 't1' })],
    members: [],
    maxConcurrent: 4,
  })
  assert.equal(noMember.blocked[0]?.kind, 'noMember')
})

test('planDispatch skips members that already declined a task', () => {
  const board = [task({ id: 't1' })]
  const roster = [member('alice', 'inactive'), member('bob', 'inactive')]
  // Alice keeps her roster position, so only the refusal record stops her
  // from taking the task a second time.
  const result = planDispatch({
    tasks: board,
    members: roster,
    maxConcurrent: 4,
    avoid: new Map([['t1', new Set(['alice'])]]),
  })
  assert.equal(result.plans.length, 1)
  assert.equal(result.plans[0]?.memberName, 'bob', 'the next idle member gets the turn')
})

test('planDispatch reports a task nobody is left to take as declined', () => {
  // The difference from `noMember` matters: adding a member fixes one, while
  // the other means everyone present already had a turn and passed.
  const result = planDispatch({
    tasks: [task({ id: 't1' })],
    members: [member('alice', 'inactive')],
    maxConcurrent: 4,
    avoid: new Map([['t1', new Set(['alice'])]]),
  })
  assert.equal(result.plans.length, 0)
  assert.equal(result.blocked[0]?.kind, 'declined')
  assert.match(result.blocked[0]?.reason ?? '', /alice/)
})

test('planDispatch reports backpressure as nothing, not as a member shortage', () => {
  // Two tasks, one member. The member takes the first task; the second has no
  // cause but "the only idle member is already assigned this round". That is
  // normal queue backpressure, not a shortage — it must NOT produce a blocked
  // entry (which would climb `skippedNoMember` and read as "add a member").
  const result = planDispatch({
    tasks: [task({ id: 't1' }), task({ id: 't2' })],
    members: [member('alice', 'inactive')],
    maxConcurrent: 4,
  })
  assert.deepEqual(result.plans.map(plan => plan.taskId), ['t1'])
  assert.equal(result.blocked.length, 0, 'backpressure must not be reported as noMember')
})

test('planDispatch refuses a parked task however much room there is', () => {
  // Parking is not a shortage: the member, the slot and the scopes are all
  // available, and the task is still withheld. Reporting this as `noMember`
  // would send the reader to add a member that changes nothing.
  const result = planDispatch({
    tasks: [task({ id: 't1' }), task({ id: 't2' })],
    members: [member('alice', 'inactive'), member('bob', 'inactive')],
    maxConcurrent: 4,
    parked: new Map([['t1', 3]]),
  })
  assert.deepEqual(result.plans.map(plan => plan.taskId), ['t2'])
  const blocked = result.blocked.find(entry => entry.taskId === 't1')
  assert.equal(blocked?.kind, 'parked')
  assert.match(blocked?.reason ?? '', /3 reclaims/)
})

test('wakeMessage tells the member to claim with the revision', () => {
  const plan: DispatchPlan = {
    taskId: 't1',
    taskRevision: 7,
    taskSubject: 'do the thing',
    memberName: 'alice',
  }
  const text = wakeMessage(plan)
  assert.match(text, /t1/)
  assert.match(text, /revision 7/)
  // The real claim tool is team_task_update with action "claim"; a made-up
  // `team_task_claim` tool does not exist in the host.
  assert.match(text, /team_task_update/)
  assert.doesNotMatch(text, /team_task_claim/)
})

const bcfg: BreakerConfig = { errorThreshold: 3, openCooldownMs: 1000, halfOpenProbe: 2 }

test('createBreaker starts closed', () => {
  const b = createBreaker()
  assert.equal(b.state, 'closed')
  assert.equal(b.consecutiveErrors, 0)
})

test('breaker stays closed until errorThreshold consecutive errors', () => {
  let b = createBreaker()
  b = recordError(b, 1000, bcfg)
  b = recordError(b, 1000, bcfg)
  assert.equal(b.state, 'closed')
  assert.equal(b.consecutiveErrors, 2)
  b = recordError(b, 1000, bcfg)
  assert.equal(b.state, 'open')
  assert.equal(b.openedAt, 1000)
})

test('a success resets consecutive errors', () => {
  let b = createBreaker()
  b = recordError(b, 1, bcfg)
  b = recordSuccess(b)
  assert.equal(b.consecutiveErrors, 0)
  assert.equal(b.state, 'closed')
})

test('breaker blocks dispatch while open, half-opens after cooldown', () => {
  let b = createBreaker()
  b = recordError(b, 0, bcfg)
  b = recordError(b, 0, bcfg)
  b = recordError(b, 0, bcfg)
  assert.equal(b.state, 'open')
  assert.equal(evaluate(b, 500, bcfg).canDispatch, false)
  const cooled = evaluate(b, 1500, bcfg)
  assert.equal(cooled.breaker.state, 'halfOpen')
  assert.equal(cooled.canDispatch, true)
})

test('half-open closes after probe dispatches all succeed', () => {  let b = createBreaker()
  b = recordError(b, 0, bcfg)
  b = recordError(b, 0, bcfg)
  b = recordError(b, 0, bcfg)
  b = evaluate(b, 2000, bcfg).breaker
  assert.equal(b.state, 'halfOpen')
  assert.equal(b.halfOpenRemaining, 2)
  b = recordSuccess(b)
  assert.equal(b.state, 'halfOpen')
  b = recordSuccess(b)
  assert.equal(b.state, 'closed')
})

test('a half-open breaker with no probe left closes instead of latching forever', () => {
  // Reached by `halfOpenProbe: 0` — the schema rejects it, but a config that
  // bypassed validation can still deliver it, and the result is unrecoverable:
  // nothing dispatches, so no success is ever recorded, so `halfOpenRemaining`
  // can never move. The team would sit there forever while the breaker claimed
  // to be probing.
  const latched = {
    state: 'halfOpen' as const,
    consecutiveErrors: 0,
    openedAt: undefined,
    halfOpenRemaining: 0,
  }
  const next = evaluate(latched, 0, bcfg)
  assert.equal(next.breaker.state, 'closed')
  assert.equal(next.canDispatch, true)
  // And a breaker that still has a probe left keeps the old behaviour.
  const probing = evaluate({ ...latched, halfOpenRemaining: 1 }, 0, bcfg)
  assert.equal(probing.breaker.state, 'halfOpen')
  assert.equal(probing.canDispatch, true)
})

test('any error during half-open re-opens immediately', () => {
  let b = createBreaker()
  b = recordError(b, 0, bcfg)
  b = recordError(b, 0, bcfg)
  b = recordError(b, 0, bcfg)
  b = evaluate(b, 2000, bcfg).breaker
  b = recordError(b, 3000, bcfg)
  assert.equal(b.state, 'open')
  assert.equal(b.openedAt, 3000)
})

test('resolveBudget prefers per-team override, falls back to default', () => {
  const budgets = { red: 5 }
  assert.equal(resolveBudget('red', budgets, 2), 5)
  assert.equal(resolveBudget('blue', budgets, 2), 2)
  assert.equal(resolveBudget('blue', undefined, 2), 2)
})

test('normalizeScope folds dot segments but keeps a leading ..', () => {
  assert.equal(normalizeScope('src/./a/../b'), 'src/b')
  assert.equal(normalizeScope('../x'), '../x')
  assert.equal(normalizeScope('src//a/'), 'src/a')
  // A `..` cannot climb above the workspace root.
  assert.equal(normalizeScope('../src/../a'), '../a')
})

test('normalizeScope keeps dotfiles and never clamps relative ascent', () => {
  // '.hidden' is a filename segment, not the '.' self-reference.
  assert.equal(normalizeScope('src/.hidden/a'), 'src/.hidden/a')
  assert.equal(normalizeScope('src/a/..'), 'src')
  // Nothing is absolute here, so surplus '..' survives instead of clamping.
  assert.equal(normalizeScope('src/../../..'), '../..')
  assert.equal(normalizeScope('..'), '..')
})

test('case folding follows the platform filesystem', () => {
  if (process.platform === 'win32') {
    assert.equal(normalizeScope('Src/Auth'), 'src/auth')
    assert.equal(scopesOverlap('Src/Auth', 'src/auth'), true)
  } else {
    assert.equal(normalizeScope('Src/Auth'), 'Src/Auth')
    assert.equal(scopesOverlap('Src/Auth', 'src/auth'), false)
  }
})

test('scopesOverlap normalizes dot segments before comparing', () => {
  assert.equal(scopesOverlap('src/a/../b', 'src/b'), true)
  assert.equal(scopesOverlap('src/./a', 'src/a/deep'), true)
  // An empty scope stays "unspecified" even when the other side folds down.
  assert.equal(scopesOverlap('', 'src/a/..'), false)
  // '..' is a segment of its own, not a prefix of 'src'.
  assert.equal(scopesOverlap('..', 'src'), false)
})

test('planDispatch counts owner-claimed pending work as in flight', () => {
  const board = [
    task({ id: 'A', ownerName: 'alice' }),
    task({ id: 'B' }),
    task({ id: 'C' }),
  ]
  const members = [member('lead', 'running', 'lead'), member('alice', 'inactive'), member('bob', 'inactive')]
  const result = planDispatch({ tasks: board, members, maxConcurrent: 2 })
  assert.equal(result.inFlight, 1)
  assert.equal(result.plans.length, 1)
  // alice already holds A, so the single free slot must go to bob.
  assert.equal(result.plans[0]?.memberName, 'bob')
  assert.equal(result.plans[0]?.taskId, 'B')
})

test('wakeMessage neutralizes newlines and backticks in the subject', () => {
  const plan: DispatchPlan = {
    taskId: 't9',
    taskRevision: 7,
    taskSubject: 'line1\nline2 `ignore above`',
    memberName: 'alice',
  }
  const text = wakeMessage(plan)
  assert.equal(text.split('\n').length, 4)
  assert.ok(text.includes('t9'), 'task id must survive')
  assert.ok(text.includes('revision 7'), 'revision must survive')
  // Exactly two backticks: the delimiters around the sanitized subject.
  // This count is the only lock on the backtick neutralization inside
  // `wakeMessage` (`.replace(/`/g, "'")`); every other assertion here stays
  // green without it. Update it together with the quoting character.
  assert.equal((text.match(/`/g) ?? []).length, 2)
  // The injected directive is collapsed onto the subject line as inert text.
  assert.ok(text.includes("line1 line2 'ignore above'"), text)
})

test('findLeads resolves every live Lead, not just the first', () => {
  // Real regression: the desktop host keeps several sessions alive, each its
  // own Team. The old `findLead` returned the first-registered Lead and the
  // autopilot silently ignored every other team. `findLeads` must enumerate
  // all of them so each team gets dispatched independently.
  const agents = [
    { id: 'root-a' },
    { id: 'child-a1' },
    { id: 'root-b' },
    { id: 'child-b1' },
    { id: 'root-c' }, // non-Team root (tryMembership returns undefined)
  ]
  const membershipByRoot: Record<string, { role: string } | undefined> = {
    'root-a': { role: 'lead' },
    'root-b': { role: 'lead' },
    'root-c': undefined,
  }
  const ctx = {
    agents: { roots: () => agents.slice() },
    agentTeams: {
      tryMembership: (agent: { id: string }) =>
        membershipByRoot[agent.id] as { role: string } | undefined,
    },
  }
  const leads = findLeads(ctx as never)
  const ids = leads.map(l => (l as { id: string }).id)
  assert.deepEqual(ids, ['root-a', 'root-b'])
})

test('findLeads returns empty when no Team exists', () => {
  const ctx = {
    agents: { roots: () => [] },
    agentTeams: { tryMembership: () => undefined },
  }
  assert.deepEqual(findLeads(ctx as never), [])
})

test('boardSummary agrees with planDispatch on the in-flight count', () => {
  // The reported `inFlight`/`slots` must describe the same decision the
  // autopilot made, so a reader can trust the numbers.
  const board = [
    task({ id: 't1', status: 'in_progress', ownerName: 'alice' }),
    task({ id: 't2', status: 'pending', ownerName: 'bob' }),
    task({ id: 't3', status: 'pending', ready: true }),
    task({ id: 't4', status: 'completed', ownerName: 'carol' }),
  ]
  const members = [
    member('lead', 'running', 'lead'),
    member('alice', 'running'),
    member('bob', 'running'),
    member('dave', 'inactive'),
  ]
  const decision = planDispatch({ tasks: board, members, maxConcurrent: 2 })
  const summary = boardSummary(board, members, 2)
  assert.equal(summary.inFlight, decision.inFlight)
  assert.equal(summary.slots, Math.max(0, 2 - decision.inFlight))
  // t1 and t2 hold slots; t3 is claimable; t4 is completed and holds nothing.
  assert.equal(summary.inFlight, 2)
  assert.equal(summary.tasks, 4)
  assert.equal(summary.claimable, 1)
  // dave is idle and holds no work, so exactly one teammate is available.
  assert.equal(summary.idle, 1)
})

test('boardSummary counts a completed task as holding no slot', () => {
  const board = [task({ id: 't1', status: 'completed', ownerName: 'alice' })]
  const summary = boardSummary(board, [member('alice', 'inactive')], 2)
  assert.equal(summary.inFlight, 0)
  assert.equal(summary.slots, 2)
  assert.equal(summary.idle, 1)
})

test('boardSummary partitions the board into flight, ready, blocked and done', () => {
  const board = [
    task({ id: 't1', status: 'in_progress', ownerName: 'alice' }),
    // Owner-claimed but not started: holds a slot, cannot be handed out again.
    task({ id: 't2', status: 'pending', ownerName: 'bob' }),
    task({ id: 't3', status: 'pending', ready: true }),
    // Waiting on t1, so not ready and not dispatcheable. The blocker id is
    // branded at the type level; the runtime only ever reads it as a string.
    task({ id: 't4', status: 'pending', ready: false, blockedBy: ['t1' as never] }),
    task({ id: 't5', status: 'completed', ownerName: 'alice' }),
    task({ id: 't6', status: 'deleted' }),
  ]
  const summary = boardSummary(board, [member('alice', 'running'), member('bob', 'running')], 4)
  assert.equal(summary.tasks, 6)
  assert.equal(summary.inFlight, 2)
  assert.equal(summary.claimable, 1)
  assert.equal(summary.blocked, 1)
  assert.equal(summary.done, 2)
  // The four buckets are a partition, not a loose set of counters: this is what
  // makes "4 tasks, 0 claimable" readable as "2 blocked, 2 finished".
  assert.equal(summary.inFlight + summary.claimable + summary.blocked + summary.done, summary.tasks)
})

test('boardSummary splits a parked task out of claimable', () => {
  // M1: a parked task is still ready and unowned on the board, but it is not
  // dispatchable. Reporting it as claimable makes a reader watching
  // `claimable>0 / idle>0 / slots>0` with `dispatched=0` suspect the members
  // and slots before the park. It must be split into its own bucket.
  const board = [
    task({ id: 't1', status: 'pending', ready: true }),
    task({ id: 't2', status: 'pending', ready: true }),
  ]
  const members = [member('lead', 'running', 'lead'), member('alice', 'inactive')]
  const parked = new Map([['t1', 3]])
  const summary = boardSummary(board, members, 2, parked)
  assert.equal(summary.claimable, 1, 'the parked task is not dispatchable')
  assert.equal(summary.parked, 1, 'the park is its own bucket')
  assert.equal(summary.tasks, 2)
  // The five buckets still partition the board exactly.
  assert.equal(
    summary.inFlight + summary.claimable + summary.parked + summary.blocked + summary.done,
    summary.tasks,
  )
})

test('callerBoard folds parking and promised slots into the live view', () => {
  // The status tool's top line is a live board. It used to be computed without
  // the parked map, so a task parked after repeated reclaims still counted as
  // `claimable` there while the team line in the same report said `parked=1`
  // for that very task — one report contradicting itself.
  const board = [
    task({ id: 't1', status: 'pending', ready: true }),
    task({ id: 't2', status: 'pending', ready: true }),
  ]
  const members = [member('lead', 'running', 'lead'), member('alice', 'inactive')]
  const bucket = {
    // ParkRecord-shaped on purpose: this is the state's real value type.
    parked: new Map([['t1', { taskId: 't1', reclaims: 3, previousOwner: 'alice', at: 1 }]]),
    pendingWakes: new Map([['t2', { memberName: 'alice', at: 2 }]]),
  }
  const summary = callerBoard(board, members, 2, bucket)
  assert.equal(summary.parked, 1, 'the parked task is its own bucket, not claimable')
  assert.equal(summary.claimable, 1, 'only t2 is still up for grabs')
  assert.equal(summary.slots, 1, 't2 is promised to a wake nobody answered yet')
  // A team the loop has never ticked has no memory to fold in, and must not
  // pretend otherwise.
  const cold = callerBoard(board, members, 2, undefined)
  assert.equal(cold.claimable, 2)
  assert.equal(cold.parked, 0)
  assert.equal(cold.slots, 2)
})

test('planDispatch still reports why tasks after the last slot were skipped', () => {  // M2: a `break` at capacity used to swallow the skip reasons of every task
  // that sat after the one filling the last slot, so `why=` read "nothing
  // skipped" while parked/colliding work stood just out of view. Filling the
  // last slot must stop dispatch, not the walk.
  const board = [
    // The only slot goes to this one.
    task({ id: 't-free', status: 'pending', ready: true }),
    // This one is parked, but sits after the slot was filled.
    task({ id: 't-parked', status: 'pending', ready: true }),
  ]
  const members = [member('lead', 'running', 'lead'), member('alice', 'inactive'), member('bob', 'inactive')]
  const result = planDispatch({
    tasks: board,
    members,
    maxConcurrent: 1,
    parked: new Map([['t-parked', 3]]),
  })
  assert.equal(result.plans.length, 1, 'only the free task is dispatched')
  assert.equal(result.plans[0]?.taskId, 't-free')
  const parkedSkip = result.blocked.find(entry => entry.taskId === 't-parked')
  assert.ok(parkedSkip !== undefined, 'the parked task after the last slot still records its reason')
  assert.equal(parkedSkip.kind, 'parked')
})

test('a bare dot scope is the workspace root and conflicts with every scope', () => {
  // M3: `.`, `/`, and `./` used to normalize to the empty "unspecified" string,
  // so a global-write task (`writeScopes: ['.']`) ran in parallel with anything.
  // The root must stay distinct from "unspecified" and collide with all scopes.
  assert.equal(normalizeScope('.'), '.')
  assert.equal(normalizeScope('/'), '.')
  assert.equal(normalizeScope('./'), '.')
  assert.equal(normalizeScope('   '), '', 'blank is still "unspecified"')
  assert.equal(normalizeScope(''), '')
  // The root contains everything; a concrete scope contains nothing of the root.
  assert.equal(scopesOverlap('.', 'src/auth'), true)
  assert.equal(scopesOverlap('src/auth', '.'), true)
  assert.equal(scopesOverlap('.', '.'), true)
  // "unspecified" still never conflicts.
  assert.equal(scopesOverlap('', 'src/auth'), false)
})

test('a grace-expiry reclaim carries its observation start', () => {
  // M7: a failed `reassign` used to reset the grace period, so the task got a
  // whole fresh `reclaimAfterMs` before the next retry. The release must carry
  // the stamp so the caller can put it back on a failed write.
  const board = [task({ id: 't1', status: 'in_progress', ownerName: 'alice' })]
  const result = planReclaim({
    tasks: board,
    members: [member('lead', 'running', 'lead'), member('alice', 'inactive')],
    now: 400_000,
    reclaimAfterMs: 300_000,
    reclaimOnFailed: true,
    stalled: new Map([['t1', 10_000]]),
  })
  const release = result.releases[0]
  assert.ok(release !== undefined)
  assert.equal(release.sinceAt, 10_000, 'the grace-expiry release keeps its observation start')
})

test('startupLine names the build and the settings it is running with', () => {
  const config = {
    enabled: true,
    tickTimeoutMs: 30_000,
    maxConcurrent: 2,
    wakeCooldownMs: 60_000,
    dryRun: false,
    teamBudgets: {},
    errorThreshold: 3,
    openCooldownMs: 60_000,
    halfOpenProbe: 1,
    reclaimAfterMs: 300_000,
    reclaimOnFailed: true,
    reclaimRetryLimit: 3,
    statusFile: 'C:/tmp/status.log',
    statusHeartbeatMs: 600_000,
    livenessEnabled: true,
    livenessGraceMs: 60_000,
    livenessSettleGraceMs: 3_000,
    stalledRunningMs: 900_000,
    interruptStalled: false,
    wakeBudgetPerHour: 0,
  }
  const line = startupLine(0, config)
  assert.match(line, /^1970-01-01T00:00:00\.000Z autopilot-start /)
  // The reclaim limit belongs here: a `parks=` in the log cannot be read
  // without the limit that produced it, and a restart is when it changes. The
  // stall window belongs here for the same reason, and `interrupt=` because it
  // decides whether a `stalls=` line means "reported" or "cancelled". The
  // budget is here because every `budget=` in the body reads `off` when it is
  // unset, which is also what a build without the field would look like.
  assert.match(line, /reclaimMs=300000 retryLimit=3 reclaimOnFailed=true heartbeatMs=600000 dryRun=false maxConcurrent=2 errorThreshold=3 liveness=on livenessMs=60000 livenessSettleMs=3000 stalledMs=900000 interrupt=off wakeBudget=off$/)
  // A restart is only diagnosable if the line says which build came back.
  assert.match(line, /version=\d+\.\d+\.\d+ /)
})

test('renderReport separates the caller\'s live board from per-team snapshots', () => {
  const report: StatusReport = {
    enabled: true,
    dryRun: false,
    version: 'test-build',
    uptimeMs: 120_000,
    health: 'ok',
    rounds: 3,
    dispatched: 2,
    suppressed: 1,
    skipped: 0,
    unclaimed: 0,
    reclaimed: 0,
    parked: 0,
    stalled: 0,
    stallInterrupts: 0,
    teams: [
      {
        team: 'team-a',
        ticks: 3,
        dispatched: 2,
        suppressed: 1,
        skipped: 0,
        skippedScope: 0,
        skippedNoMember: 0,
        skippedDeclined: 0,
        skippedParked: 0,
        skippedBudget: 0,
        why: [],
        unclaimed: 0,
        pending: 0,
        breaker: 'closed',
        breakerTrips: 0,
        breakerBlocked: 0,
        reclaimed: 0,
        parked: [],
        stalled: 0,
        stallWarnings: 0,
        stallInterrupts: 0,
        statusWriteFailed: false,
        tasks: 1,
        inFlight: 1,
        claimable: 0,
        blocked: 0,
        done: 0,
        idle: 0,
        slots: 1,
        wakesThisHour: 0,
        wakeBudget: 0,
        lastTickAt: 1_000,
      },
    ],
    caller: {
      team: 'team-a',
      tasks: 2,
      inFlight: 1,
      claimable: 0,
      parked: 1,
      blocked: 0,
      done: 0,
      idle: 0,
      slots: 1,
    },
  }
  const text = renderReport(report, 3_000).join('\n')
  assert.match(text, /^autopilot active health=ok version=test-build up=2m$/m)
  // Totals and the per-team breakdown are labelled separately.
  assert.match(text, /totals rounds=3 dispatched=2 suppressed=1/)
  assert.match(text, /teams=1/)
  // The caller's board is marked live, the per-team row carries its age.
  assert.match(text, /caller team=team-a .*\(live\)/)
  // The parked bucket is named on the caller's line too. A parked task is
  // ready and unowned on the board, so without this count the live numbers
  // stop partitioning `tasks` and give no hint where the difference went.
  assert.match(
    text,
    /caller team=team-a tasks=2 inFlight=1 claimable=0 parked=1 blocked=0 done=0 idle=0 slots=1 \(live\)/,
  )
  assert.match(text, /team=team-a ticks=3 .*\(2000ms ago\)/)
  // "none" rather than silence: an absent line is indistinguishable from a
  // build that never learned to report the field at all.
  assert.match(text, /lastReclaim none/)
  assert.match(text, /lastDispatch none/)
  // Same convention for stalls: "nothing wedged" is a fact worth printing,
  // because its absence is otherwise indistinguishable from an old build.
  assert.match(text, /lastStall none/)
  // The same `why=` the log line carries, and the same `-` for "no skip":
  // status used to report only the lifetime counters here, which cannot say
  // why nothing moved in the round they were just read after.
  assert.match(text, /why=- /)
})

test('renderReport names the last reclaim and dispatch instead of only counting them', () => {
  const report: StatusReport = {
    enabled: true,
    dryRun: false,
    version: 'test-build',
    uptimeMs: 120_000,
    // Both a stalled slot and a parked task are present below; `stuck` is the
    // verdict because it outranks `parked` in the triage order.
    health: 'stuck',
    rounds: 9,
    dispatched: 4,
    suppressed: 5,
    skipped: 1,
    unclaimed: 2,
    reclaimed: 2,
    parked: 1,
    stalled: 1,
    stallInterrupts: 0,
    teams: [
      {
        team: 'team-a',
        ticks: 9,
        dispatched: 4,
        suppressed: 5,
        skipped: 1,
        skippedScope: 1,
        skippedNoMember: 0,
        skippedDeclined: 0,
        skippedParked: 0,
        skippedBudget: 0,
        why: ['scope'],
        unclaimed: 2,
        pending: 1,
        breaker: 'closed',
        breakerTrips: 0,
        breakerBlocked: 0,
        reclaimed: 2,
        parked: [
          { taskId: 'task-4', reclaims: 3, previousOwner: 'worker-b', at: 2_900 },
        ],
        stalled: 1,
        stallWarnings: 2,
        stallInterrupts: 0,
        statusWriteFailed: false,
        tasks: 3,
        inFlight: 0,
        claimable: 1,
        blocked: 0,
        done: 1,
        idle: 2,
        slots: 2,
        wakesThisHour: 3,
        wakeBudget: 10,
        lastTickAt: 2_000,
        lastReclaim: {
          taskId: 'task-3',
          reason: 'owner "worker-a" inactive for 60012ms',
          previousOwner: 'worker-a',
          at: 2_500,
          applied: true,
        },
        lastDispatch: {
          taskId: 'task-3',
          memberName: 'worker-a',
          at: 2_800,
          repeats: 3,
          sent: true,
          claimed: false,
        },
        lastStall: {
          taskId: 'task-5',
          ownerName: 'worker-c',
          forMs: 950_000,
          at: 2_950,
        },
      },
    ],
  }
  const text = renderReport(report, 3_000).join('\n')
  // The skip total is broken down, so the four fixes are told apart.
  assert.match(text, /skipped=1 \(scope=1 noMember=0 declined=0 parkedSkips=0 budgetSkips=0\)/)
  // The breakdown says where the total came from; `why` says what the last
  // round ran into. Both, because they answer different questions.
  assert.match(text, /why=scope /)
  // Which task came back, from whom, and why — not just "reclaimed=2".
  assert.match(text, /lastReclaim task=task-3 from=worker-a reason='owner "worker-a" inactive for 60012ms' applied \(500ms ago\)/)
  // Which task went to whom, how many times, and whether it was picked up.
  assert.match(text, /lastDispatch task=task-3 to=worker-a wakes=3 sent outcome=unclaimed \(200ms ago\)/)
  // A wedged turn is named the same way, because the numbers beside it look
  // healthy: printing only `stalled=1` would leave the reader with no member to
  // go and look at.
  assert.match(text, /lastStall task=task-5 owner=worker-c for=950000ms \(50ms ago\)/)
  // A stalled task gets its own warning: `slots=` alone cannot separate "fully
  // loaded but working" from "fully loaded and never going to move again".
  assert.match(text, /warning: 1 task\(s\) held by a member that has not moved/)
  // The loop signature is called out instead of left for the reader to infer.
  assert.match(text, /warning: 2 wakes went unclaimed/)
  // A parked task is spelled out rather than counted: the reader has to be
  // able to find the task and decide, and "1 parked" would not even name it.
  assert.match(text, /parked task=task-4 after=3 reclaims lastOwner=worker-b \(100ms ago\)/)
})

test('reclaims a task whose owner left the roster', () => {
  const board = [task({ id: 't1', status: 'in_progress', ownerName: 'ghost' })]
  const result = planReclaim({
    tasks: board,
    members: [member('lead', 'running', 'lead')],
    now: 1_000,
    reclaimAfterMs: 300_000,
    reclaimOnFailed: true,
    stalled: new Map(),
  })
  assert.equal(result.releases.length, 1)
  const release = result.releases[0]
  assert.ok(release !== undefined)
  assert.equal(release.taskId, 't1')
  assert.equal(release.previousOwner, 'ghost')
  assert.match(release.reason, /no longer on the roster/)
})

test('reclaims from a failed owner only when that is enabled', () => {
  const board = [task({ id: 't1', status: 'in_progress', ownerName: 'alice' })]
  const base = {
    tasks: board,
    members: [member('lead', 'running', 'lead'), member('alice', 'failed')],
    now: 1_000,
    reclaimAfterMs: 300_000,
  }
  const on = planReclaim({ ...base, reclaimOnFailed: true, stalled: new Map() })
  assert.equal(on.releases.length, 1)
  const off = planReclaim({ ...base, reclaimOnFailed: false, stalled: new Map() })
  assert.equal(off.releases.length, 0)
})

test('reclaims an inactive owner only after the grace period', () => {
  const board = [task({ id: 't1', status: 'in_progress', ownerName: 'alice' })]
  const base = {
    tasks: board,
    members: [member('lead', 'running', 'lead'), member('alice', 'inactive')],
    reclaimAfterMs: 300_000,
    reclaimOnFailed: true,
  }
  // First sighting: the stall is recorded, nothing is taken yet.
  const first = planReclaim({ ...base, now: 10_000, stalled: new Map() })
  assert.equal(first.releases.length, 0)
  assert.equal(first.stalled.get('t1'), 10_000)
  // Still inside the grace period.
  const waiting = planReclaim({ ...base, now: 20_000, stalled: first.stalled })
  assert.equal(waiting.releases.length, 0)
  // Past it: the task goes back to the pool and the entry is dropped.
  const done = planReclaim({ ...base, now: 400_000, stalled: first.stalled })
  assert.equal(done.releases.length, 1)
  const released = done.releases[0]
  assert.ok(released !== undefined)
  assert.match(released.reason, /inactive for 390000ms/)
  assert.equal(done.stalled.has('t1'), false)
})

test('never reclaims from a running owner or from the Lead', () => {
  const board = [
    task({ id: 't1', status: 'in_progress', ownerName: 'alice' }),
    task({ id: 't2', status: 'in_progress', ownerName: 'lead' }),
    task({ id: 't3', status: 'pending', ready: true }),
  ]
  const result = planReclaim({
    tasks: board,
    members: [member('lead', 'running', 'lead'), member('alice', 'running')],
    now: 999_999,
    reclaimAfterMs: 1_000,
    reclaimOnFailed: true,
    // Stale entries from an earlier stall are cleared, not acted on.
    stalled: new Map([['t1', 0], ['t2', 0]]),
  })
  assert.equal(result.releases.length, 0)
  assert.equal(result.stalled.size, 0)
})

test('the status row reads why and pending from the round, not from the counters', () => {
  const team = teamState(createAutopilotState(), 'team-a')
  // A team that has been skipping for a long time: the counters are high, but
  // they say nothing about what the *last* round ran into.
  team.skipped = 40
  team.skippedDeclined = 40
  team.skipKinds = ['declined']
  team.pendingWakes.set('t1', { memberName: 'alice', at: 0 })
  team.pendingWakes.set('t2', { memberName: 'alice', at: 0 })

  const row = toTeamReport(team)
  assert.deepEqual(row.why, ['declined'], 'why is the last round, not the lifetime total')
  assert.equal(row.pending, 2, 'pending is the number of wakes awaiting judgement')

  // A copy: the tool returns this object to the host, and the next round
  // mutates the state's own array in place.
  team.skipKinds.push('scope')
  assert.deepEqual(row.why, ['declined'], 'the reported row must not alias live state')
})

test('the status row copies the record fields it hands out', () => {
  const team = teamState(createAutopilotState(), 'team-a')
  team.parked.set('t1', { taskId: 't1', reclaims: 3, previousOwner: 'alice', at: 0 })
  team.lastReclaim = { taskId: 't2', reason: 'owner inactive', previousOwner: 'bob', at: 0, applied: true }
  team.lastDispatch = { taskId: 't3', memberName: 'carol', at: 0, repeats: 1, sent: true }

  const row = toTeamReport(team)

  // The row hands out copies: mutating the live record (as the next round does
  // when it fills in `claimed`, bumps `repeats`, or re-parks the task) must not
  // rewrite the object the caller already holds.
  team.lastDispatch.claimed = true
  team.lastDispatch.repeats = 5
  team.lastReclaim.applied = false
  const parkedRecord = team.parked.get('t1')
  if (parkedRecord !== undefined) parkedRecord.reclaims = 9

  assert.equal(row.lastDispatch?.claimed, undefined, 'lastDispatch must not alias live state')
  assert.equal(row.lastDispatch?.repeats, 1)
  assert.equal(row.lastReclaim?.applied, true)
  assert.equal(row.parked[0]?.reclaims, 3, 'parked records must not alias live state')
})

test('statusLine stays one greppable line and grows as decisions happen', () => {
  const team = teamState(createAutopilotState(), 'team-a')
  team.ticks = 3
  team.dispatched = 1
  team.skipped = 2
  team.skippedScope = 1
  team.skippedDeclined = 1
  team.unclaimed = 1
  team.tasks = 2
  team.claimable = 1
  // 2 tasks = 0 in flight + 1 ready + 1 waiting on a dependency + 0 done.
  team.blocked = 1
  team.done = 0
  team.idle = 2
  team.slots = 2

  const idle = statusLine(team, 0)
  // A log line has to stay on one line: `tail -1` is the whole point.
  assert.equal(idle.includes('\n'), false)
  assert.match(idle, /^1970-01-01T00:00:00\.000Z team=team-a /)
  assert.match(idle, /ticks=3 dispatched=1 suppressed=0 /)
  assert.match(idle, /skip=2 scope=1 noMember=0 declined=1 /)
  assert.match(idle, /unclaimed=1 pending=0 reclaimed=0 tasks=2 inFlight=0 claimable=1 blocked=1 done=0 idle=2 slots=2 /)
  // "Nothing was skipped" is printed as `-` rather than omitted: an absent key
  // reads as an older build, not as good news. The four skip counters sit in
  // one block so the cause is readable without the status tool.
  assert.match(idle, /declined=1 parkedSkips=0 budgetSkips=0 why=- unclaimed=1 /)
  assert.match(idle, /breaker=closed trips=0 held=0$/)
  assert.equal(idle.includes('wake='), false, 'no wake yet, no wake field')

  // An unjudged wake reads "unchecked", never "unclaimed": the instant a wake
  // is sent, an answered and an ignored one are indistinguishable.
  team.lastDispatch = { taskId: 't1', memberName: 'alice', at: 0, repeats: 1, sent: true }
  assert.match(statusLine(team, 0), /wake=t1>alice wakes=1 sent=1 outcome=unchecked/)
  if (team.lastDispatch !== undefined) team.lastDispatch.claimed = false
  assert.match(statusLine(team, 0), /outcome=unclaimed/)

  // A dry-run reclaim is logged too: what matters is the decision, not the
  // side effect that followed from it. Reclaims are the round's events, held
  // in an array so a round that released several owners logs all of them.
  team.lastReclaim = {
    taskId: 't1',
    reason: 'owner inactive',
    previousOwner: 'bob',
    at: 0,
    applied: false,
  }
  team.reclaimsThisRound = ['t1<bob']
  assert.match(statusLine(team, 0), /reclaims=t1<bob reclaim-dry-run$/)

  // The cumulative skip counters sit outside the signature on purpose — a task
  // nobody takes bumps them every round. The *reason* stays inside it: a team
  // that starts being blocked by write scopes, or stops being dispatchable
  // because the last member just refused, is news an operator needs at once
  // rather than at the next heartbeat.
  team.skipKinds = ['scope']
  const blockedByScope = statusLine(team, 0)
  assert.match(blockedByScope, /why=scope /)
  team.skippedScope = 99
  assert.equal(
    statusSignature(statusLine(team, 0)),
    statusSignature(blockedByScope),
    'a climbing skip counter is not a change',
  )
  team.skipKinds = ['declined', 'scope']
  assert.match(statusLine(team, 0), /why=declined,scope /)
  assert.notEqual(
    statusSignature(statusLine(team, 0)),
    statusSignature(blockedByScope),
    'a new reason is a change',
  )

  // Parking is an event, so it belongs in the signature: a task the autopilot
  // just gave up on is exactly the news an operator must not have to wait for
  // the heartbeat to read. The cumulative count is still just a counter.
  const beforePark = statusLine(team, 0)
  team.skippedParked = 4
  assert.equal(
    statusSignature(statusLine(team, 0)),
    statusSignature(beforePark),
    'a climbing park counter is not a change',
  )
  const park = { taskId: 't2', reclaims: 3, previousOwner: 'bob', at: 0 }
  team.parked.set('t2', park)
  team.lastPark = park
  team.parksThisRound = ['t2<bob']
  const parkedLine = statusLine(team, 0)
  assert.match(parkedLine, /parkedSkips=4 /, 'the cumulative park skips sit with their siblings')
  assert.match(parkedLine, /parks=t2<bob after=3$/)
  assert.notEqual(
    statusSignature(parkedLine),
    statusSignature(beforePark),
    'a new park is a change',
  )
  // Unparking is now an event of its own, not just the `parks=` line going
  // away: the round that clears a park logs the task id, so "offered again"
  // is as visible as "stopped being offered".
  team.parksThisRound = []
  team.parked.clear()
  team.unparksThisRound = ['t2']
  assert.match(statusLine(team, 0), /unparks=t2$/, 'an unparked task is announced')
  team.unparksThisRound = []
  assert.equal(statusLine(team, 0).includes('parks='), false, 'a cleared park is not re-announced')

  // `suppressed` (cooldown) and `held` (breaker-open) climb every round while
  // their condition holds, so like the skip counters they sit outside the
  // signature — otherwise a breaker that stays open would turn the heartbeat
  // back into a per-tick write. The `breaker=open` field is already inside it.
  const beforeClimb = statusLine(team, 0)
  team.suppressed = 7
  team.breakerBlocked = 5
  assert.equal(
    statusSignature(statusLine(team, 0)),
    statusSignature(beforeClimb),
    'a climbing suppressed/held counter is not a change',
  )
})

test('does not offer a task it is still waiting on, and holds its scope', () => {
  const members = [member('alice', 'inactive'), member('bob', 'inactive')]
  const alone = planDispatch({
    tasks: [task({ id: 'a', status: 'pending', ready: true })],
    members,
    maxConcurrent: 2,
    reserved: 1,
    pending: new Set(['a']),
  })
  assert.deepEqual(alone.plans, [], 'the task it already woke somebody for is not woken again')

  // The unclaimed task's write scope is held for the same reason in-flight work
  // holds it: the member may be about to claim it and start writing, and the
  // board would still show the task as unowned.
  const overlapping = planDispatch({
    tasks: [
      task({ id: 'a', status: 'pending', ready: true, writeScopes: ['src/shared'] }),
      task({ id: 'b', status: 'pending', ready: true, writeScopes: ['src/shared'] }),
    ],
    members,
    maxConcurrent: 2,
    reserved: 1,
    pending: new Set(['a']),
  })
  assert.deepEqual(overlapping.plans, [], 'nothing overlapping may start while the claim is in the air')
  assert.equal(overlapping.blocked.length, 1)
  assert.equal(overlapping.blocked[0]?.kind, 'scope')
  assert.match(overlapping.blocked[0]?.reason ?? '', /already planned for task a/)
})

test('forgets per-team bookkeeping once a team is gone', () => {
  // `loop` keeps four maps keyed by TeamId. A team that disappears must not
  // leave its rows behind for the life of the process.
  const wakes = new Map([
    ['a', new Map<string, number>([['t1', 1]])],
    ['b', new Map<string, number>()],
  ])
  const breakers = new Map([['a', createBreaker()], ['b', createBreaker()]])
  const failures = new Map([['b', 3]])
  forgetMissing([wakes, breakers, failures], new Set(['a']))
  assert.deepEqual([...wakes.keys()], ['a'])
  assert.deepEqual([...breakers.keys()], ['a'])
  assert.deepEqual([...failures.keys()], [], 'a team with only a failure counter is forgotten too')

  // A live team keeps everything, including its suppression stamps.
  forgetMissing([wakes, breakers, failures], new Set(['a', 'b']))
  assert.equal(wakes.get('a')?.get('t1'), 1)
})

test('forgets wake stamps that can no longer suppress anything', () => {
  // A stamp is a promise of "not before this moment". It stops meaning
  // anything the moment the cooldown has passed (the comparison is
  // `now - stamp < cooldownMs`) or the task leaves the board. Neither is
  // noticed while the entry sits there, because the map is only ever looked up
  // for tasks that are about to be dispatched.
  const now = 1_000_000
  const lastWake = new Map<string, number>([
    ['live', now - 1_000],
    ['expired', now - 60_000],
    ['gone', now - 1_000],
  ])
  pruneWakeMap(lastWake, [task({ id: 'live' }), task({ id: 'expired' })], now, 60_000)
  assert.deepEqual([...lastWake.keys()], ['live'], 'an expired stamp and a vanished task both go')

  // Cooldown zero means "no suppression at all", so no stamp can survive it —
  // which is exactly what the dispatch loop would conclude anyway.
  const noCooldown = new Map([['live', now]])
  pruneWakeMap(noCooldown, [task({ id: 'live' })], now, 0)
  assert.equal(noCooldown.size, 0, 'a zero cooldown keeps no stamps')
})

test('bounds how many team buckets it remembers', () => {
  // A bucket carries the counters a human reads to decide what to do next, so
  // it is kept while the team lives. What it must not do is accumulate one
  // bucket per team a long-lived host ever created: a test harness or a
  // session-per-team workflow would grow the status report without bound.
  const state = createAutopilotState()
  for (let index = 0; index < 40; index += 1) teamState(state, `team-${index}`)
  assert.equal(state.teams.size, 32, 'the bucket map is capped')
  assert.equal(state.teams.has('team-0'), false, 'the least recently ticked buckets go first')
  assert.equal(state.teams.has('team-39'), true, 'the newest bucket is kept')

  // A live team ticks every round, so it can never be the victim — even while
  // the map stays full and buckets keep being minted around it.
  const live = teamState(state, 'live-team')
  live.lastTickAt = 1_000
  for (let index = 40; index < 120; index += 1) teamState(state, `team-${index}`)
  assert.equal(state.teams.size, 32)
  assert.equal(state.teams.has('live-team'), true, 'a ticking team is never evicted')
})

/**
 * The trim keeps the newest half of a log that outgrew its ceiling. The boot
 * marker is the one line that must survive: it names the build and the
 * settings. Carrying it forward is easy to get wrong in two ways — duplicating
 * it when it already sits in the kept half, and appending a second
 * ` (trimmed)` note on every later trim. Both leave a file where
 * `grep autopilot-start` answers "which build is running" with two rows.
 */
await testAsync('a trim carries one boot marker, never a growing pile of them', async () => {
  const boot = '2026-10-29T00:00:00.000Z autopilot-start version=0.5.1 tickMs=30000'
  const padding = Array.from(
    { length: 1_300 },
    (_, index) => `${String(index).padStart(4, '0')} ${'x'.repeat(110)}`,
  )
  const bootLines = (text: string): string[] =>
    text.split('\n').filter(entry => /^\S+ autopilot-start /.test(entry))

  const makeFs = (initial: string) => {
    const files = new Map<string, string>([['/status.log', initial]])
    return {
      files,
      ops: {
        append: async (path: string, data: string) => {
          files.set(path, (files.get(path) ?? '') + data)
        },
        stat: async (path: string) => ({ size: (files.get(path) ?? '').length }),
        read: async (path: string) => files.get(path) ?? '',
        write: async (path: string, data: string) => {
          files.set(path, data)
        },
        rename: async (from: string, to: string) => {
          files.set(to, files.get(from) ?? '')
          files.delete(from)
        },
      },
    }
  }

  // The marker sits in the half a trim drops, so it is carried forward.
  const stale = makeFs([boot, ...padding, ''].join('\n'))
  await appendStatusLineWith('/status.log', '2026-10-29T01:00:00.000Z team=t ticks=9', stale.ops)
  const carried = bootLines(stale.files.get('/status.log') ?? '')
  assert.equal(carried.length, 1, 'the trim leaves exactly one boot marker')
  assert.equal(carried[0]?.endsWith(' (trimmed)'), true, 'the carried marker says it was trimmed')
  assert.ok((stale.files.get('/status.log') ?? '').length < 140_000, 'the log was actually trimmed')

  // Trimming again must not turn that note into ` (trimmed) (trimmed)`.
  await appendStatusLineWith('/status.log', 'y'.repeat(70_000), stale.ops)
  const again = bootLines(stale.files.get('/status.log') ?? '')
  assert.equal(again.length, 1, 'a second trim still leaves one boot marker')
  assert.equal(again[0]?.includes('(trimmed) (trimmed)'), false, 'the note never stacks')

  // A restart near the tail leaves the marker inside the kept half; adding a
  // second copy there would make "which build is running" ambiguous.
  const fresh = makeFs(
    [...padding, boot, '2026-10-29T02:00:00.000Z team=t ticks=1', ''].join('\n'),
  )
  await appendStatusLineWith('/status.log', '2026-10-29T02:01:00.000Z team=t ticks=2', fresh.ops)
  const untouched = bootLines(fresh.files.get('/status.log') ?? '')
  assert.equal(untouched.length, 1, 'a marker already in the kept half is not duplicated')
  assert.equal(untouched[0]?.endsWith(' (trimmed)'), false, 'and it is left as it was')
})

test('the report says so when the status file cannot be written', () => {
  // A broken `statusFile` fails the same way every round and produced no trace
  // anywhere: the log stayed empty, which reads exactly like a team that did
  // nothing all day. The tool has to say it out loud, and it has to clear.
  const bucket = teamState(createAutopilotState(), 'team-w')
  assert.equal(toTeamReport(bucket).statusWriteFailed, false, 'a fresh team has not failed yet')

  bucket.statusWriteFailed = true
  const report: StatusReport = {
    enabled: true,
    dryRun: false,
    version: 'test-build',
    uptimeMs: 120_000,
    health: 'blind',
    rounds: 1,
    dispatched: 0,
    suppressed: 0,
    skipped: 0,
    unclaimed: 0,
    reclaimed: 0,
    parked: 0,
    stalled: 0,
    stallInterrupts: 0,
    teams: [toTeamReport(bucket)],
  }
  const text = renderReport(report, 1_000).join('\n')
  assert.equal(toTeamReport(bucket).statusWriteFailed, true, 'the flag survives the mapping')
  assert.match(text, /warning: statusFile writes are failing/)
  assert.match(text, /the log will be empty or stale/)
  assert.match(text, /health=blind/, 'the verdict line agrees with the warning below it')
})
test('healthOf names the worst condition, in its stated triage order', () => {
  // A row built from a fresh bucket, then bent into the one condition under
  // test. Using the real mapper keeps this test honest about field names: a
  // rename in `TeamReport` breaks compilation here rather than silently
  // weakening the assertions.
  const row = (over: Partial<TeamReport> = {}): TeamReport => ({
    ...toTeamReport(teamState(createAutopilotState(), 'team-h')),
    ...over,
  })

  assert.equal(healthOf(true, []), 'ok', 'nothing to report is not a problem')
  assert.equal(healthOf(false, [row({ breaker: 'open' })]), 'off', 'a disabled plugin makes every other verdict moot')
  assert.equal(healthOf(true, [row({ breaker: 'open' })]), 'broken')
  assert.equal(healthOf(true, [row({ breaker: 'halfOpen' })]), 'ok', 'half-open is still dispatching — probe traffic is not breakage')
  assert.equal(healthOf(true, [row({ stalled: 1, statusWriteFailed: true })]), 'stuck', 'a wedged slot outranks a dead log')
  assert.equal(healthOf(true, [row({ statusWriteFailed: true })]), 'blind')
  assert.equal(healthOf(true, [row({ parked: [{ taskId: 't1', reclaims: 3, previousOwner: 'alice', at: 1 }] })]), 'parked')
  assert.equal(healthOf(true, [row(), row()]), 'ok', 'healthy teams do not make each other worse')
})
test('formatUptime keeps a lifetime readable at a glance', () => {
  // One unit, no decimals: the only question a lifetime answers is "minutes or
  // days?", and a reader scanning one line does not want to divide.
  assert.equal(formatUptime(0), '0s')
  assert.equal(formatUptime(59_999), '59s')
  assert.equal(formatUptime(60_000), '1m')
  assert.equal(formatUptime(17 * 60_000), '17m')
  assert.equal(formatUptime(60 * 60_000), '1h')
  assert.equal(formatUptime(6 * 3_600_000 + 59 * 60_000), '6h', 'the smaller unit is dropped, not rounded up')
  assert.equal(formatUptime(24 * 3_600_000), '1d')
  assert.equal(formatUptime(3 * 86_400_000 + 3_600_000), '3d')
  assert.equal(formatUptime(-5), '0s', 'a clock that went backwards must not print a negative age')
})

test('the wake budget measures the last hour rather than the calendar hour', () => {
  const now = 10 * WAKE_WINDOW_MS
  // A stamp exactly one window old is out: the window is half-open, so a busy
  // hour cannot hold the next hour hostage by one millisecond.
  assert.deepEqual(pruneWakeStamps([now - WAKE_WINDOW_MS, now - 1], now), [now - 1])
  // `0` keeps its old meaning: no budget at all, not a budget of zero.
  assert.equal(wakeAllowance(0, [now - 1, now - 2], now), Number.POSITIVE_INFINITY)
  assert.equal(wakeAllowance(3, [now - 1, now - 2], now), 1)
  assert.equal(wakeAllowance(2, [now - 1, now - 2], now), 0, 'a spent budget never goes negative')
  assert.equal(wakeAllowance(2, [now - 1, now - WAKE_WINDOW_MS - 1], now), 1, 'aged-out wakes stop counting')
})

test('planDispatch spends the round on the wakes it is allowed, and says why it stopped', () => {
  const tasks = [
    task({ id: 'a', writeScopes: ['src/a'] }),
    task({ id: 'b', writeScopes: ['src/b'] }),
    task({ id: 'c', writeScopes: ['src/c'] }),
  ]
  const members = [member('alice', 'inactive'), member('bob', 'inactive'), member('carol', 'inactive')]

  // An allowance below both the member count and the slot count is binding…
  const capped = planDispatch({ tasks, members, maxConcurrent: 3, wakeAllowance: 2 })
  assert.deepEqual(capped.plans.map(plan => plan.taskId), ['a', 'b'])
  // …and the task it could not reach is reported as the budget's doing, not
  // as backpressure: a full round would have left it unreported.
  assert.deepEqual(capped.blocked.map(entry => entry.kind), ['budget'])
  assert.match(capped.blocked[0]?.reason ?? '', /wakeBudgetPerHour/)

  // A spent budget dispatches nothing but still explains itself.
  const spent = planDispatch({ tasks, members, maxConcurrent: 3, wakeAllowance: 0 })
  assert.equal(spent.plans.length, 0)
  assert.deepEqual(spent.blocked.map(entry => entry.kind), ['budget', 'budget', 'budget'])

  // A budget wide enough not to bind changes nothing, and a full round stays
  // quiet — the two ways of sending nothing must not be confused.
  const free = planDispatch({ tasks, members, maxConcurrent: 1, wakeAllowance: 100 })
  assert.deepEqual(free.plans.map(plan => plan.taskId), ['a'])
  assert.equal(free.blocked.length, 0, 'a full round is not a reason to report a task')
})
if (failures.length > 0) {
  console.error(`FAILED ${failures.length}`)
  for (const line of failures) console.error(`  - ${line}`)
  process.exit(1)
}
console.log(`OK — ${passed} checks passed`)
