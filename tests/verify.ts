/**
 * Zero-dependency self-check for the scheduler decision core.
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
import type { TeamMemberView, TeamTaskView } from '@deepseek-ai/dsh-experimental-agent-team'

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

test('half-open closes after probe dispatches all succeed', () => {
  let b = createBreaker()
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
  // This count is the only lock on the neutralization step at select.ts:250
  // (`.replace(/`/g, "'")`); the other assertions here stay green without it.
  // If the quoting character ever changes, update this line together with it.
  assert.equal((text.match(/`/g) ?? []).length, 2)
  // The injected directive is collapsed onto the subject line as inert text.
  assert.ok(text.includes("line1 line2 'ignore above'"), text)
})

if (failures.length > 0) {
  console.error(`FAILED ${failures.length}`)
  for (const line of failures) console.error(`  - ${line}`)
  process.exit(1)
}
console.log(`OK — ${passed} checks passed`)
