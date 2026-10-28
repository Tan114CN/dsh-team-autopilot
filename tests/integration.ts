/**
 * In-process integration harness for the dispatch round.
 *
 * Drives the real `tick()` from `src/dispatch.ts` against a faithful,
 * controllable Agent Teams host stub. Unlike `verify.ts` (pure decision
 * functions), this exercises the actual round: circuit-breaker gating,
 * TeamId-scoped budget resolution, and the real `sendMessage` wiring. The
 * stub mirrors only the public surface `tick` touches:
 * `ctx.agentTeams.{tryMembership,listTasks,listMembers,sendMessage}`.
 *
 * `dispatch.ts` imports types only from `index.ts`, so this file needs no
 * `dsh-tools` / Cordis runtime — `node tests/integration.ts` runs with zero
 * node_modules, just like `verify.ts`.
 *
 * The genuine end-to-end host (`dsh web` + LLM) is still a manual step; see
 * the "真实宿主联调" section in README.md for commands and what to observe.
 */

import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { TeamMemberView, TeamTaskView } from '@deepseek-ai/dsh-experimental-agent-team'
import { createBreaker } from '../src/breaker.ts'
import { tick } from '../src/dispatch.ts'
import { createAutopilotState } from '../src/state.ts'
import type { AutopilotState } from '../src/state.ts'
import type { Config } from '../src/index.ts'

/** Minimal task view with sane defaults. */
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
    // Mirror the real runtime: unowned tasks carry `ownerName: null`.
    ownerName: null as unknown as string,
    ...over,
  } as unknown as TeamTaskView
}

/** Minimal member view. */
function member(
  name: string,
  status: TeamMemberView['status'],
  role: 'lead' | 'teammate' = 'teammate',
): TeamMemberView {
  return { id: name, name, role, status, diagnostics: [] } as unknown as TeamMemberView
}

interface Host {
  tasks: TeamTaskView[]
  members: TeamMemberView[]
  /** Names woken by sendMessage, in order. */
  sent: string[]
  /** Every sendMessage call, succeeded or not. */
  attempts: number
  failSend: boolean
  /** Every updateTask call, in order. */
  updates: Array<{ taskId: string; action: string }>
}

function makeHost(
  tasks: TeamTaskView[],
  members: TeamMemberView[],
): Host {
  return { tasks, members, sent: [], attempts: 0, failSend: false, updates: [] }
}

function makeCtx(host: Host): Context {
  const ctx = {
    agentTeams: {
      tryMembership: () => ({ id: 'team-1', role: 'lead' }),
      listTasks: (): TeamTaskView[] => host.tasks,
      listMembers: (): TeamMemberView[] => host.members,
      sendMessage: async (
        _caller: object,
        request: { target: string },
      ): Promise<{ messageId: string }> => {
        host.attempts += 1
        if (host.failSend) throw new Error('simulated send failure')
        host.sent.push(request.target)
        return { messageId: 'm1' }
      },
      updateTask: async (
        _caller: object,
        request: { taskId: string; action: string },
      ): Promise<void> => {
        host.updates.push({ taskId: request.taskId, action: request.action })
        if (request.action !== 'reassign') return
        const target = host.tasks.find(entry => entry.id === request.taskId)
        if (target === undefined) return
        // Mirror the native transition: `reassign` without an owner
        // clears the owner and puts the task back to `pending`.
        Object.assign(target, {
          status: 'pending',
          ownerName: null,
          revision: target.revision + 1,
        })
      },
    },
  }
  return ctx as unknown as Context
}

function freshState(): AutopilotState {
  return createAutopilotState()
}

/** One team's bucket from the autopilot state. */
function teamOf(state: AutopilotState, team = 'team-1') {
  const bucket = state.teams.get(team)
  assert.ok(bucket !== undefined, `expected a bucket for ${team}`)
  return bucket
}

const lead = { id: 'lead', name: 'lead' } as unknown as Agent
const signal = new AbortController().signal

const baseConfig: Required<Config> = {
  enabled: true,
  tickTimeoutMs: 10_000,
  maxConcurrent: 2,
  wakeCooldownMs: 0,
  dryRun: false,
  teamBudgets: {},
  errorThreshold: 3,
  openCooldownMs: 60_000,
  halfOpenProbe: 1,
  reclaimAfterMs: 300_000,
  reclaimOnFailed: true,
}

let passed = 0
const failures: string[] = []

async function test(label: string, body: () => Promise<void>): Promise<void> {
  try {
    await body()
    passed += 1
  } catch (error: unknown) {
    failures.push(`${label} → ${error instanceof Error ? error.message : String(error)}`)
  }
}

await test('wakes an idle teammate when a task is ready', async () => {
  const host = makeHost(
    [task({ id: 't1', status: 'pending', ready: true })],
    [member('lead', 'running', 'lead'), member('alice', 'inactive')],
  )
  const state = freshState()
  await tick(makeCtx(host), lead, baseConfig, state, 'team-1', new Map(), new Map(), createBreaker(), signal)
  assert.equal(host.sent.length, 1)
  assert.equal(host.sent[0], 'alice')
  assert.equal(state.rounds, 1)
  assert.equal(teamOf(state).dispatched, 1)
})

await test('blocks dispatch when a write scope collides with in-flight work', async () => {
  const host = makeHost(
    [
      task({ id: 't0', status: 'in_progress', ownerName: 'alice', writeScopes: ['src/auth'] }),
      task({ id: 't1', status: 'pending', ready: true, writeScopes: ['src/auth/login'] }),
    ],
    [member('lead', 'running', 'lead'), member('alice', 'running'), member('bob', 'inactive')],
  )
  const state = freshState()
  await tick(makeCtx(host), lead, baseConfig, state, 'team-1', new Map(), new Map(), createBreaker(), signal)
  assert.equal(host.attempts, 0)
  assert.equal(teamOf(state).skipped, 1)
})

await test('trips the circuit breaker after consecutive send failures', async () => {
  const host = makeHost(
    [task({ id: 't1', status: 'pending', ready: true })],
    [member('lead', 'running', 'lead'), member('alice', 'inactive')],
  )
  host.failSend = true
  const state = freshState()
  const ctx = makeCtx(host)
  const config = { ...baseConfig, errorThreshold: 2 }
  let breaker = createBreaker()

  breaker = await tick(ctx, lead, config, state, 'team-1', new Map(), new Map(), breaker, signal)
  breaker = await tick(ctx, lead, config, state, 'team-1', new Map(), new Map(), breaker, signal)
  assert.equal(breaker.state, 'open')
  assert.notEqual(teamOf(state).breaker, 'closed')
  assert.ok(teamOf(state).breakerTrips >= 1, `expected a trip, got ${teamOf(state).breakerTrips}`)

  const before = host.attempts
  breaker = await tick(ctx, lead, config, state, 'team-1', new Map(), new Map(), breaker, signal)
  assert.equal(host.attempts, before, 'no dispatch may happen while the breaker is open')
  assert.ok(teamOf(state).breakerBlocked >= 1, 'the open breaker must have blocked a round')
})

await test('honours the per-team budget keyed by TeamId', async () => {
  const host = makeHost(
    [
      task({ id: 't1', status: 'pending', ready: true }),
      task({ id: 't2', status: 'pending', ready: true }),
    ],
    [member('lead', 'running', 'lead'), member('alice', 'inactive'), member('bob', 'inactive')],
  )
  const state = freshState()
  // maxConcurrent says 5, but the TeamId-scoped budget caps it at 1.
  await tick(
    makeCtx(host),
    lead,
    { ...baseConfig, maxConcurrent: 5, teamBudgets: { 'team-1': 1 } },
    state,
    'team-1',
    new Map(),
    new Map(),
    createBreaker(),
    signal,
  )
  assert.equal(host.sent.length, 1)
})

await test('keeps each team\'s counters in its own bucket', async () => {
  const host = makeHost(
    [task({ id: 't1', status: 'pending', ready: true })],
    [member('lead', 'running', 'lead'), member('alice', 'inactive')],
  )
  const state = freshState()
  await tick(makeCtx(host), lead, baseConfig, state, 'team-a', new Map(), new Map(), createBreaker(), signal)
  await tick(makeCtx(host), lead, baseConfig, state, 'team-b', new Map(), new Map(), createBreaker(), signal)

  // Two teams, two buckets: neither overwrites the other's numbers.
  assert.equal(state.teams.size, 2)
  assert.equal(teamOf(state, 'team-a').dispatched, 1)
  assert.equal(teamOf(state, 'team-b').dispatched, 1)
  assert.equal(teamOf(state, 'team-a').ticks, 1)
  assert.equal(teamOf(state, 'team-b').ticks, 1)
  assert.equal(state.rounds, 2)
})

await test('reports the board snapshot of the team it just ticked', async () => {
  const host = makeHost(
    [task({ id: 't1', status: 'in_progress', ownerName: 'alice' })],
    [member('lead', 'running', 'lead'), member('alice', 'running')],
  )
  const state = freshState()
  await tick(makeCtx(host), lead, baseConfig, state, 'team-1', new Map(), new Map(), createBreaker(), signal)

  // The snapshot describes the board as of this tick: one task, occupying a
  // slot, with no idle teammate and no free slot beyond the budget.
  const team = teamOf(state)
  assert.equal(team.tasks, 1)
  assert.equal(team.inFlight, 1)
  assert.equal(team.idle, 0)
  assert.equal(team.slots, 1)
  assert.equal(team.claimable, 0)
  assert.ok(team.lastTickAt !== undefined, 'the snapshot must be timestamped')
})

await test('reclaims a stalled task and reuses its slot in the same round', async () => {
  // One slot, held by t1: t2 cannot move until t1 goes back to the pool.
  const host = makeHost(
    [
      task({ id: 't1', status: 'in_progress', ownerName: 'alice' }),
      task({ id: 't2', status: 'pending', ready: true }),
    ],
    [member('lead', 'running', 'lead'), member('alice', 'inactive'), member('bob', 'inactive')],
  )
  const state = freshState()
  const config: Required<Config> = { ...baseConfig, maxConcurrent: 1 }
  // Alice has been sitting on t1 for longer than the grace period.
  const stalled = new Map<string, number>([['t1', Date.now() - 600_000]])
  await tick(makeCtx(host), lead, config, state, 'team-1', new Map(), stalled, createBreaker(), signal)

  // The task goes back to the pool through a Lead-only reassign.
  assert.deepEqual(host.updates, [{ taskId: 't1', action: 'reassign' }])
  assert.equal(teamOf(state).reclaimed, 1)
  // The freed slot is handed out in this very round — and not to the
  // member the task was just taken from.
  assert.deepEqual(host.sent, ['bob'])
})

await test('records the last reclaim with its task, owner and reason', async () => {
  const host = makeHost(
    [
      task({ id: 't1', status: 'in_progress', ownerName: 'alice' }),
      task({ id: 't2', status: 'pending', ready: true }),
    ],
    [member('lead', 'running', 'lead'), member('alice', 'inactive'), member('bob', 'inactive')],
  )
  const state = freshState()
  const config: Required<Config> = { ...baseConfig, maxConcurrent: 1 }
  const stalled = new Map<string, number>([['t1', Date.now() - 600_000]])
  await tick(makeCtx(host), lead, config, state, 'team-1', new Map(), stalled, createBreaker(), signal)

  // A bare `reclaimed=1` never says *what* came back; this does.
  const record = teamOf(state).lastReclaim
  assert.ok(record !== undefined, 'the reclaim must be recorded')
  assert.equal(record.taskId, 't1')
  assert.equal(record.previousOwner, 'alice')
  assert.equal(record.applied, true)
  assert.match(record.reason, /alice/)
})

await test('records the last reclaim as dry-run when it was not applied', async () => {
  const host = makeHost(
    [task({ id: 't1', status: 'in_progress', ownerName: 'alice' })],
    [member('lead', 'running', 'lead'), member('alice', 'inactive')],
  )
  const state = freshState()
  const config: Required<Config> = { ...baseConfig, dryRun: true }
  const stalled = new Map<string, number>([['t1', Date.now() - 600_000]])
  await tick(makeCtx(host), lead, config, state, 'team-1', new Map(), stalled, createBreaker(), signal)

  assert.deepEqual(host.updates, [], 'dryRun must not touch the board')
  assert.equal(teamOf(state).reclaimed, 1, 'the decision is still counted')
  assert.equal(teamOf(state).lastReclaim?.applied, false, 'but it is marked as not applied')
})

await test('counts a wake that nobody claimed', async () => {
  const host = makeHost(
    [task({ id: 't1', status: 'pending', ready: true })],
    [member('lead', 'running', 'lead'), member('alice', 'inactive')],
  )
  const state = freshState()
  const ctx = makeCtx(host)
  await tick(ctx, lead, baseConfig, state, 'team-1', new Map(), new Map(), createBreaker(), signal)
  assert.deepEqual(host.sent, ['alice'])
  assert.equal(teamOf(state).lastDispatch?.claimed, undefined, 'too early to judge round one')

  // Alice never picked it up: the task is still unowned at the next read.
  await tick(ctx, lead, baseConfig, state, 'team-1', new Map(), new Map(), createBreaker(), signal)
  const team = teamOf(state)
  assert.equal(team.unclaimed, 1)
  assert.equal(team.lastDispatch?.claimed, false)
  // The repeat is counted on the same record rather than replacing it, so the
  // outcome survives instead of reading "unchecked" forever.
  assert.equal(team.lastDispatch?.repeats, 2)

  // She claims it before the third read: that wake is judged answered.
  const woken = host.tasks[0]
  assert.ok(woken !== undefined)
  Object.assign(woken, { status: 'in_progress', ownerName: 'alice' })
  await tick(ctx, lead, baseConfig, state, 'team-1', new Map(), new Map(), createBreaker(), signal)
  assert.equal(teamOf(state).unclaimed, 1, 'an answered wake adds nothing')
  assert.equal(teamOf(state).lastDispatch?.claimed, true)

  // A round that wakes nobody judges nothing: unclaimed counts wakes, not rounds.
  await tick(ctx, lead, baseConfig, state, 'team-1', new Map(), new Map(), createBreaker(), signal)
  assert.equal(teamOf(state).unclaimed, 1)
})

await test('does not count a wake that was answered', async () => {
  const host = makeHost(
    [task({ id: 't1', status: 'pending', ready: true })],
    [member('lead', 'running', 'lead'), member('alice', 'inactive')],
  )
  const state = freshState()
  const ctx = makeCtx(host)
  await tick(ctx, lead, baseConfig, state, 'team-1', new Map(), new Map(), createBreaker(), signal)
  // Alice claims it between the rounds.
  const claimed = host.tasks[0]
  assert.ok(claimed !== undefined)
  Object.assign(claimed, { status: 'in_progress', ownerName: 'alice' })
  await tick(ctx, lead, baseConfig, state, 'team-1', new Map(), new Map(), createBreaker(), signal)
  const team = teamOf(state)
  assert.equal(team.lastDispatch?.claimed, true)
  assert.equal(team.unclaimed, 0)
})

await test('splits skipped tasks into scope conflicts and missing members', async () => {
  const scopeHost = makeHost(
    [
      task({ id: 't0', status: 'in_progress', ownerName: 'alice', writeScopes: ['src/auth'] }),
      task({ id: 't1', status: 'pending', ready: true, writeScopes: ['src/auth/login'] }),
    ],
    [member('lead', 'running', 'lead'), member('alice', 'running'), member('bob', 'inactive')],
  )
  const scopeState = freshState()
  await tick(makeCtx(scopeHost), lead, baseConfig, scopeState, 'team-1', new Map(), new Map(), createBreaker(), signal)
  assert.equal(teamOf(scopeState).skippedScope, 1)
  assert.equal(teamOf(scopeState).skippedNoMember, 0)

  // Same shape, but the only teammate is busy: nothing to do with scopes.
  const busyHost = makeHost(
    [task({ id: 't1', status: 'pending', ready: true })],
    [member('lead', 'running', 'lead'), member('alice', 'running')],
  )
  const busyState = freshState()
  await tick(makeCtx(busyHost), lead, baseConfig, busyState, 'team-1', new Map(), new Map(), createBreaker(), signal)
  assert.equal(teamOf(busyState).skippedScope, 0)
  assert.equal(teamOf(busyState).skippedNoMember, 1)
})

await test('waits out the grace period before reclaiming an inactive owner', async () => {
  const host = makeHost(
    [task({ id: 't1', status: 'in_progress', ownerName: 'alice' })],
    [member('lead', 'running', 'lead'), member('alice', 'inactive')],
  )
  const state = freshState()
  // First sighting: alice may simply be starting up, so nothing is taken.
  await tick(makeCtx(host), lead, baseConfig, state, 'team-1', new Map(), new Map(), createBreaker(), signal)
  assert.deepEqual(host.updates, [])
  assert.equal(teamOf(state).reclaimed, 0)
})

if (failures.length > 0) {
  console.error(`FAILED ${failures.length}`)
  for (const line of failures) console.error(`  - ${line}`)
  process.exit(1)
}
console.log(`OK — ${passed} integration checks passed`)
