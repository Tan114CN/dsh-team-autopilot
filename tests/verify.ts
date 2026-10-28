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
import { boardSummary } from '../src/select.ts'
import { renderReport } from '../src/report.ts'
import type { StatusReport } from '../src/report.ts'
import type { TeamMemberView, TeamTaskView } from '@deepseek-ai/dsh-experimental-agent-team'
import { planReclaim } from '../src/reclaim.ts'
import { startupLine, statusLine } from '../src/observe.ts'
import { teamState } from '../src/state.ts'
import { createAutopilotState } from '../src/state.ts'

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
    statusFile: 'C:/tmp/status.log',
    statusHeartbeatMs: 600_000,
  }
  const line = startupLine(0, config)
  assert.match(line, /^1970-01-01T00:00:00\.000Z autopilot-start /)
  assert.match(line, /tickMs=30000 wakeMs=60000 reclaimMs=300000 heartbeatMs=600000 dryRun=false$/)
  // A restart is only diagnosable if the line says which build came back.
  assert.match(line, /version=\d+\.\d+\.\d+ /)
})

test('renderReport separates the caller\'s live board from per-team snapshots', () => {
  const report: StatusReport = {
    enabled: true,
    dryRun: false,
    rounds: 3,
    dispatched: 2,
    suppressed: 1,
    skipped: 0,
    unclaimed: 0,
    reclaimed: 0,
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
        unclaimed: 0,
        breaker: 'closed',
        breakerTrips: 0,
        breakerBlocked: 0,
        reclaimed: 0,
        tasks: 1,
        inFlight: 1,
        claimable: 0,
        blocked: 0,
        done: 0,
        idle: 0,
        slots: 1,
        lastTickAt: 1_000,
      },
    ],
    caller: {
      team: 'team-a',
      tasks: 1,
      inFlight: 1,
      claimable: 0,
      blocked: 0,
      done: 0,
      idle: 0,
      slots: 1,
    },
  }
  const text = renderReport(report, 3_000).join('\n')
  assert.match(text, /autopilot active/)
  // Totals and the per-team breakdown are labelled separately.
  assert.match(text, /totals rounds=3 dispatched=2 suppressed=1/)
  assert.match(text, /teams=1/)
  // The caller's board is marked live, the per-team row carries its age.
  assert.match(text, /caller team=team-a .*\(live\)/)
  assert.match(text, /team=team-a ticks=3 .*\(2000ms ago\)/)
  // "none" rather than silence: an absent line is indistinguishable from a
  // build that never learned to report the field at all.
  assert.match(text, /lastReclaim none/)
  assert.match(text, /lastDispatch none/)
})

test('renderReport names the last reclaim and dispatch instead of only counting them', () => {
  const report: StatusReport = {
    enabled: true,
    dryRun: false,
    rounds: 9,
    dispatched: 4,
    suppressed: 5,
    skipped: 1,
    unclaimed: 2,
    reclaimed: 2,
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
        unclaimed: 2,
        breaker: 'closed',
        breakerTrips: 0,
        breakerBlocked: 0,
        reclaimed: 2,
        tasks: 3,
        inFlight: 0,
        claimable: 1,
        blocked: 0,
        done: 1,
        idle: 2,
        slots: 2,
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
      },
    ],
  }
  const text = renderReport(report, 3_000).join('\n')
  // The skip total is broken down, so the two opposite fixes are told apart.
  assert.match(text, /skipped=1 \(scope=1 noMember=0 declined=0\)/)
  // Which task came back, from whom, and why — not just "reclaimed=2".
  assert.match(text, /lastReclaim task=task-3 from=worker-a reason='owner "worker-a" inactive for 60012ms' applied \(500ms ago\)/)
  // Which task went to whom, how many times, and whether it was picked up.
  assert.match(text, /lastDispatch task=task-3 to=worker-a wakes=3 sent outcome=unclaimed \(200ms ago\)/)
  // The loop signature is called out instead of left for the reader to infer.
  assert.match(text, /warning: 2 wakes went unclaimed/)
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
  assert.match(idle, /unclaimed=1 reclaimed=0 tasks=2 inFlight=0 claimable=1 blocked=1 done=0 idle=2 slots=2 /)
  assert.match(idle, /breaker=closed trips=0 held=0$/)
  assert.equal(idle.includes('wake='), false, 'no wake yet, no wake field')

  // An unjudged wake reads "unchecked", never "unclaimed": the instant a wake
  // is sent, an answered and an ignored one are indistinguishable.
  team.lastDispatch = { taskId: 't1', memberName: 'alice', at: 0, repeats: 1, sent: true }
  assert.match(statusLine(team, 0), /wake=t1>alice wakes=1 outcome=unchecked/)
  if (team.lastDispatch !== undefined) team.lastDispatch.claimed = false
  assert.match(statusLine(team, 0), /outcome=unclaimed/)

  // A dry-run reclaim is logged too: what matters is the decision, not the
  // side effect that followed from it.
  team.lastReclaim = {
    taskId: 't1',
    reason: 'owner inactive',
    previousOwner: 'bob',
    at: 0,
    applied: false,
  }
  assert.match(statusLine(team, 0), /reclaim=t1<bob reclaim-dry-run$/)
})

if (failures.length > 0) {
  console.error(`FAILED ${failures.length}`)
  for (const line of failures) console.error(`  - ${line}`)
  process.exit(1)
}
console.log(`OK — ${passed} checks passed`)
