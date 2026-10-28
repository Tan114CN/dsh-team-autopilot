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
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { TeamMemberView, TeamTaskView } from '@deepseek-ai/dsh-experimental-agent-team'
import { createBreaker } from '../src/breaker.ts'
import { tick, loop } from '../src/dispatch.ts'
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
  /** Make every `updateTask` throw, to stand in for a stale revision. */
  failUpdate: boolean
}

function makeHost(
  tasks: TeamTaskView[],
  members: TeamMemberView[],
): Host {
  return { tasks, members, sent: [], attempts: 0, failSend: false, updates: [], failUpdate: false }
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
        if (host.failUpdate) throw new Error('simulated revision conflict')
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
  reclaimRetryLimit: 3,
  statusFile: '',
  statusHeartbeatMs: 600_000,
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

await test('logs a blocked round instead of going quiet when the breaker is open', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'autopilot-breaker-'))
  const file = join(dir, 'status.log')
  const host = makeHost(
    [task({ id: 't1', status: 'pending', ready: true })],
    [member('lead', 'running', 'lead'), member('alice', 'inactive')],
  )
  host.failSend = true
  const state = freshState()
  const config: Required<Config> = { ...baseConfig, errorThreshold: 1, statusFile: file }
  const ctx = makeCtx(host)
  let breaker = createBreaker()
  breaker = await tick(ctx, lead, config, state, 'team-1', new Map(), new Map(), breaker, signal)
  assert.equal(breaker.state, 'open')

  // The round that the breaker blocks returns early — it must still log, or
  // the file falls silent at the exact moment the team is stuck.
  breaker = await tick(ctx, lead, config, state, 'team-1', new Map(), new Map(), breaker, signal)
  const lines = (await readFile(file, 'utf8')).trimEnd().split('\n')
  assert.equal(lines.length, 2)
  assert.match(lines[1] ?? '', /breaker=open/)
  assert.match(lines[1] ?? '', /held=1/)
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

await test('parks a task that keeps coming back instead of waking forever', async () => {
  // The real-host loop this is about: the task is claimed, the owner goes
  // quiet, the autopilot reclaims it, the next member claims it and goes quiet
  // the same way. Every lap is a legitimate-looking reclaim and a model turn.
  const host = makeHost(
    [task({ id: 't1', status: 'in_progress', ownerName: 'alice' })],
    [member('lead', 'running', 'lead'), member('alice', 'inactive'), member('bob', 'inactive')],
  )
  const state = freshState()
  const config: Required<Config> = { ...baseConfig, maxConcurrent: 1, reclaimRetryLimit: 3 }
  const ctx = makeCtx(host)
  const wake = new Map<string, number>()
  const stale = (): Map<string, number> => new Map([['t1', Date.now() - 600_000]])

  // Round 1: alice's task is reclaimed and handed to bob.
  await tick(ctx, lead, config, state, 'team-1', wake, stale(), createBreaker(), signal)
  assert.deepEqual(host.sent, ['bob'], 'the freed task goes to the other member')
  // Bob claims it, then stalls exactly like alice did.
  host.tasks[0] = task({ id: 't1', status: 'in_progress', ownerName: 'bob' })

  // Round 2: bob's task is reclaimed and handed back to alice.
  await tick(ctx, lead, config, state, 'team-1', wake, stale(), createBreaker(), signal)
  assert.deepEqual(host.sent, ['bob', 'alice'])
  host.tasks[0] = task({ id: 't1', status: 'in_progress', ownerName: 'alice' })

  // Round 3: the limit is reached — reclaimed once more, but nobody is woken.
  await tick(ctx, lead, config, state, 'team-1', wake, stale(), createBreaker(), signal)
  const team = teamOf(state)
  assert.equal(team.reclaimed, 3, 'the owner is still released: someone else may still finish it')
  assert.deepEqual(host.sent, ['bob', 'alice'], 'past the limit no wake is sent')
  assert.equal(team.parked.get('t1')?.reclaims, 3)
  assert.equal(team.lastPark?.previousOwner, 'alice')
  assert.equal(team.skippedParked, 1)
  assert.deepEqual(team.skipKinds, ['parked'])
  // Parking is an autopilot decision, never a board edit: the task stays
  // claimable so the Lead or a human can still pick it up.
  assert.equal(team.claimable, 1)

  // Round 4: still parked, still silent.
  await tick(ctx, lead, config, state, 'team-1', wake, new Map(), createBreaker(), signal)
  assert.deepEqual(host.sent, ['bob', 'alice'])
  assert.equal(team.skippedParked, 2)

  // Somebody else takes it up — the stand-off this park describes is over.
  host.tasks[0] = task({ id: 't1', status: 'in_progress', ownerName: 'bob' })
  await tick(ctx, lead, config, state, 'team-1', wake, new Map(), createBreaker(), signal)
  assert.equal(teamOf(state).parked.size, 0, 'a task that moved on is offered again')
  assert.equal(teamOf(state).reclaimCounts.has('t1'), false)
})

await test('a reclaim that failed to write does not count towards parking', async () => {
  // The park is about the task coming back, and a `reassign` rejected on a
  // stale revision never brought it back — that failure belongs to the
  // autopilot's own write path, not to the work. Counting it would stop
  // offering a perfectly viable task because we could not reach the board.
  const host = makeHost(
    [task({ id: 't1', status: 'in_progress', ownerName: 'alice' })],
    [member('lead', 'running', 'lead'), member('alice', 'inactive'), member('bob', 'inactive')],
  )
  host.failUpdate = true
  const state = freshState()
  const config: Required<Config> = { ...baseConfig, maxConcurrent: 1, reclaimRetryLimit: 1 }
  const stale = (): Map<string, number> => new Map([['t1', Date.now() - 600_000]])

  for (let round = 0; round < 3; round += 1) {
    await tick(makeCtx(host), lead, config, state, 'team-1', new Map(), stale(), createBreaker(), signal)
  }

  const team = teamOf(state)
  assert.equal(team.reclaimed, 0, 'a failed release is not a release')
  assert.equal(team.parked.size, 0, 'and it must not park the task')
  assert.equal(team.reclaimCounts.get('t1'), undefined, 'nothing was handed back, so nothing is owed')
  assert.match(state.lastError ?? '', /revision conflict/, 'the failure is still visible')
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
  // The refused hand-off is *not* repeated. Alice is the only member, so this
  // round finds nobody left to offer it to and holds the wake back rather than
  // burning another message on the same refusing member — `repeats` stays 1,
  // describing the one wake that actually happened.
  assert.equal(team.lastDispatch?.repeats, 1)
  assert.deepEqual(host.sent, ['alice'], 'a refusing member is not woken twice')
  assert.equal(team.skippedDeclined, 1, 'the skip is attributed to refusals, not to a missing member')

  // She claims it before the third read: that wake is judged answered.
  const woken = host.tasks[0]
  assert.ok(woken !== undefined)
  Object.assign(woken, { status: 'in_progress', ownerName: 'alice' })
  await tick(ctx, lead, baseConfig, state, 'team-1', new Map(), new Map(), createBreaker(), signal)
  assert.equal(teamOf(state).unclaimed, 1, 'an answered wake adds nothing')
  // The record still describes that one wake, which genuinely went unclaimed;
  // a later claim by the same member does not rewrite the outcome.
  assert.equal(teamOf(state).lastDispatch?.claimed, false)
  assert.equal(teamOf(state).declined.size, 0, 'an owned task clears its refusal slate')

  // A round that wakes nobody judges nothing: unclaimed counts wakes, not rounds.
  await tick(ctx, lead, baseConfig, state, 'team-1', new Map(), new Map(), createBreaker(), signal)
  assert.equal(teamOf(state).unclaimed, 1)
})

await test('hands a refused task to the next idle member', async () => {
  const host = makeHost(
    [task({ id: 't1', status: 'pending', ready: true })],
    [member('lead', 'running', 'lead'), member('alice', 'inactive'), member('bob', 'inactive')],
  )
  const state = freshState()
  const ctx = makeCtx(host)
  await tick(ctx, lead, baseConfig, state, 'team-1', new Map(), new Map(), createBreaker(), signal)
  assert.deepEqual(host.sent, ['alice'], 'roster order picks alice first')

  // Alice ignores the wake while bob sits idle. Without the refusal record
  // this round would wake alice again and bob would never get a turn.
  await tick(ctx, lead, baseConfig, state, 'team-1', new Map(), new Map(), createBreaker(), signal)
  assert.deepEqual(host.sent, ['alice', 'bob'], 'the refusal hands the task to the next member')
  assert.equal(teamOf(state).unclaimed, 1)
  assert.equal(teamOf(state).lastDispatch?.memberName, 'bob')
  assert.equal(teamOf(state).skippedDeclined, 0, 'someone was still available, so nothing was skipped')

  // Bob claims it: the task changed hands, so the refusal slate is cleared.
  const woken = host.tasks[0]
  assert.ok(woken !== undefined)
  Object.assign(woken, { status: 'in_progress', ownerName: 'bob' })
  await tick(ctx, lead, baseConfig, state, 'team-1', new Map(), new Map(), createBreaker(), signal)
  assert.equal(teamOf(state).lastDispatch?.claimed, true)
  assert.equal(teamOf(state).declined.size, 0)
})

await test('does not judge a wake before the member had time to answer', async () => {
  const host = makeHost(
    [task({ id: 't1', status: 'pending', ready: true })],
    [member('lead', 'running', 'lead'), member('alice', 'inactive'), member('bob', 'inactive')],
  )
  const state = freshState()
  const ctx = makeCtx(host)
  const config: Required<Config> = { ...baseConfig, wakeCooldownMs: 30_000 }
  const lastWake = new Map<string, number>()
  await tick(ctx, lead, config, state, 'team-1', lastWake, new Map(), createBreaker(), signal)
  assert.deepEqual(host.sent, ['alice'])

  // The next read arrives on a change edge, one second later. Alice has not
  // had time to answer, so this round must judge nothing: on a real host this
  // is the read that used to count every wake as ignored.
  await tick(ctx, lead, config, state, 'team-1', lastWake, new Map(), createBreaker(), signal)
  const team = teamOf(state)
  assert.equal(team.unclaimed, 0, 'a member still thinking is not a refusal')
  assert.equal(team.declined.size, 0, 'so nothing is held against her')
  assert.equal(team.pendingWakes.size, 1, 'the wake is still owed its check')
  assert.deepEqual(host.sent, ['alice'], 'and the task is not offered to bob meanwhile')

  // Age the wake past the cooldown, which is when the answer can first change
  // a decision. Now the round judges it, and only now.
  const pending = team.pendingWakes.get('t1')
  assert.ok(pending !== undefined)
  pending.at = Date.now() - 31_000
  lastWake.set('t1', Date.now() - 31_000)
  await tick(ctx, lead, config, state, 'team-1', lastWake, new Map(), createBreaker(), signal)
  assert.equal(teamOf(state).unclaimed, 1)
  assert.equal(teamOf(state).declined.get('t1')?.has('alice'), true)
  assert.deepEqual(host.sent, ['alice', 'bob'], 'the refusal hands the task to the next member')
})

await test('judges every wake a round sent, not just the last one', async () => {
  const host = makeHost(
    [
      task({ id: 't1', status: 'pending', ready: true }),
      task({ id: 't2', status: 'pending', ready: true }),
    ],
    [member('lead', 'running', 'lead'), member('alice', 'inactive'), member('bob', 'inactive')],
  )
  const state = freshState()
  const ctx = makeCtx(host)
  const config: Required<Config> = { ...baseConfig, wakeCooldownMs: 30_000 }
  const lastWake = new Map<string, number>()
  await tick(ctx, lead, config, state, 'team-1', lastWake, new Map(), createBreaker(), signal)
  assert.deepEqual(host.sent, ['alice', 'bob'], 'both tasks go out in the same round')

  const team = teamOf(state)
  assert.equal(team.pendingWakes.size, 2, 'both hand-offs are owed a check')

  // Neither is claimed. Once the cooldown passes, each wake is judged on its
  // own account — with a single pending flag only the last one survived.
  for (const wake of team.pendingWakes.values()) wake.at = Date.now() - 31_000
  for (const taskId of lastWake.keys()) lastWake.set(taskId, Date.now() - 31_000)
  await tick(ctx, lead, config, state, 'team-1', lastWake, new Map(), createBreaker(), signal)
  assert.equal(teamOf(state).unclaimed, 2, 'one ignored wake per task, not per round')
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

await test('appends one status line per tick to the configured file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'autopilot-observe-'))
  const file = join(dir, 'status.log')
  const host = makeHost(
    [task({ id: 't1' })],
    [member('lead', 'running', 'lead'), member('alice', 'inactive')],
  )
  const state = freshState()
  const config: Required<Config> = { ...baseConfig, statusFile: file }
  await tick(makeCtx(host), lead, config, state, 'team-1', new Map(), new Map(), createBreaker(), signal)
  await tick(makeCtx(host), lead, config, state, 'team-1', new Map(), new Map(), createBreaker(), signal)

  const lines = (await readFile(file, 'utf8')).trimEnd().split('\n')
  // One line per round, in order: `tail -1` is the current state.
  assert.equal(lines.length, 2)
  assert.match(lines[0] ?? '', /team=team-1 ticks=1/)
  assert.match(lines[1] ?? '', /team=team-1 ticks=2/)
  // The wake sent in the first round is still on record in the second line.
  assert.match(lines[1] ?? '', /wake=t1>alice wakes=1 outcome=(claimed|unchecked|unclaimed)/)
  // A round with no file configured writes nothing at all.
  const silent = freshState()
  await tick(makeCtx(host), lead, baseConfig, silent, 'team-1', new Map(), new Map(), createBreaker(), signal)
  assert.equal((await readFile(file, 'utf8')).trimEnd().split('\n').length, 2)
})

await test('writes nothing when a round changed nothing, and rewrites on the heartbeat', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'autopilot-quiet-'))
  const file = join(dir, 'status.log')
  const host = makeHost([], [member('lead', 'running', 'lead')])
  const state = freshState()
  const config: Required<Config> = { ...baseConfig, statusFile: file }
  await tick(makeCtx(host), lead, config, state, 'team-1', new Map(), new Map(), createBreaker(), signal)
  await tick(makeCtx(host), lead, config, state, 'team-1', new Map(), new Map(), createBreaker(), signal)
  await tick(makeCtx(host), lead, config, state, 'team-1', new Map(), new Map(), createBreaker(), signal)

  // Three identical rounds, one line: the other two said nothing new.
  const quiet = (await readFile(file, 'utf8')).trimEnd().split('\n')
  assert.equal(quiet.length, 1)
  assert.match(quiet[0] ?? '', /ticks=1/)

  // A heartbeat that has elapsed is worth a line even when nothing changed.
  const heartbeat: Required<Config> = { ...baseConfig, statusFile: file, statusHeartbeatMs: 0 }
  await tick(makeCtx(host), lead, heartbeat, state, 'team-1', new Map(), new Map(), createBreaker(), signal)
  const beaten = (await readFile(file, 'utf8')).trimEnd().split('\n')
  assert.equal(beaten.length, 2)
  assert.match(beaten[1] ?? '', /ticks=4/)
})

await test('a round whose only change was a skip counter writes no line', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'autopilot-skipquiet-'))
  const file = join(dir, 'status.log')
  // One ready task and nobody to take it: every round skips it for the same
  // reason, so the cumulative `skip`/`noMember` totals climb while the board
  // itself stands still. That is a stuck team, and it is precisely the team
  // whose log a reader wants to scan rather than watch scroll.
  const host = makeHost([task({ id: 'task-1' })], [member('lead', 'running', 'lead')])
  const state = freshState()
  const config: Required<Config> = { ...baseConfig, statusFile: file }
  await tick(makeCtx(host), lead, config, state, 'team-1', new Map(), new Map(), createBreaker(), signal)
  await tick(makeCtx(host), lead, config, state, 'team-1', new Map(), new Map(), createBreaker(), signal)
  await tick(makeCtx(host), lead, config, state, 'team-1', new Map(), new Map(), createBreaker(), signal)

  const quiet = (await readFile(file, 'utf8')).trimEnd().split('\n')
  // The totals really did move — they are still in the line — but a growing
  // total is not news, so only the first round was worth writing down.
  assert.match(quiet[0] ?? '', /skip=1 scope=0 noMember=1/)
  assert.equal(quiet.length, 1)
})

await test('a team blocked for a new reason writes a line, and then goes quiet again', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'autopilot-why-'))
  const file = join(dir, 'status.log')
  const host = makeHost([task({ id: 'task-1' })], [member('alice', 'inactive')])
  const state = freshState()
  const config: Required<Config> = { ...baseConfig, statusFile: file }
  const round = async (): Promise<void> => {
    await tick(makeCtx(host), lead, config, state, 'team-1', new Map(), new Map(), createBreaker(), signal)
  }

  // Round one: one ready task, one idle member — dispatched, nothing skipped.
  await round()
  assert.match((await readFile(file, 'utf8')).trimEnd(), /why=- /)

  // The member takes it and a second task arrives with nobody left to take it.
  // The *reason* for skipping appears, which is news an operator wants now
  // rather than at the next heartbeat.
  host.tasks[0] = task({ id: 'task-1', status: 'in_progress', ownerName: 'alice' })
  host.tasks.push(task({ id: 'task-2' }))
  await round()
  assert.match((await readFile(file, 'utf8')).trimEnd(), /why=noMember /)

  // Round three skips for the same reason again: the totals move, the line
  // would say what the previous one already said.
  await round()
  const lines = (await readFile(file, 'utf8')).trimEnd().split('\n')
  assert.equal(lines.length, 2)
  assert.match(lines[1] ?? '', /why=noMember /)
})

/** One fake Lead per team, plus a host whose change-wait the test controls. */
function makeLoopCtx(
  teams: number,
  options: { manual: boolean; intervalMs: number; failRoots?: () => boolean },
) {
  const leads = Array.from({ length: teams }, (_, index) => ({ id: `lead-${index}` }))
  const pending: Array<() => void> = []
  const ctx = {
    agents: {
      roots: () => {
        if (options.failRoots?.() === true) throw new Error('session recomposition')
        return leads
      },
    },
    agentTeams: {
      tryMembership: (candidate: unknown) => ({
        id: `team-${leads.indexOf(candidate as { id: string })}`,
        role: 'lead',
      }),
      listTasks: () => [],
      listMembers: () => [member('lead', 'running', 'lead')],
      sendMessage: async () => ({ messageId: 'm1' }),
      updateTask: async () => undefined,
      waitForChange: (_lead: unknown, timeoutMs: number, waitSignal: AbortSignal) =>
        new Promise<void>(resolve => {
          if (!options.manual) {
            const timer = setTimeout(resolve, timeoutMs)
            waitSignal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
            return
          }
          pending.push(resolve)
        }),
    },
  }
  return { ctx: ctx as unknown as Context, pending }
}

await test('ticks each team once per interval, not once per team per round', async () => {
  const intervalMs = 30
  const { ctx } = makeLoopCtx(3, { manual: false, intervalMs })
  const state = freshState()
  const controller = new AbortController()
  const config: Required<Config> = { ...baseConfig, tickTimeoutMs: intervalMs }
  void loop(ctx, config, state, controller.signal).catch(() => undefined)
  await new Promise<void>(resolve => setTimeout(resolve, intervalMs * 10))
  controller.abort()

  const expected = Math.floor((intervalMs * 10) / intervalMs)
  // The bug this replaced woke N rounds per interval and ticked every team on
  // each one, so every team's count ran N times the number of intervals.
  for (const team of state.teams.values()) {
    assert.ok(team.ticks > 0, 'the loop never ticked')
    assert.ok(
      team.ticks <= expected + 2,
      `${team.team} ticked ${team.ticks}x in ${expected} intervals`,
    )
  }
})

await test('serves only the team whose change-wait fired', async () => {
  const { ctx, pending } = makeLoopCtx(2, { manual: true, intervalMs: 60_000 })
  const state = freshState()
  const controller = new AbortController()
  const config: Required<Config> = { ...baseConfig, tickTimeoutMs: 60_000 }
  void loop(ctx, config, state, controller.signal).catch(() => undefined)
  // Both teams are armed in registration order, so index 1 is team-1.
  await new Promise<void>(resolve => setTimeout(resolve, 20))
  pending[1]?.()
  await new Promise<void>(resolve => setTimeout(resolve, 20))
  controller.abort()

  assert.equal(state.teams.get('team-1')?.ticks, 1)
  assert.equal(state.teams.get('team-0'), undefined)
})

await test('writes a boot marker before the first round', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'autopilot-boot-'))
  const file = join(dir, 'status.log')
  const { ctx } = makeLoopCtx(1, { manual: true, intervalMs: 60_000 })
  const state = freshState()
  const controller = new AbortController()
  const config: Required<Config> = { ...baseConfig, statusFile: file, tickTimeoutMs: 60_000 }
  void loop(ctx, config, state, controller.signal).catch(() => undefined)
  await new Promise<void>(resolve => setTimeout(resolve, 30))
  controller.abort()

  const lines = (await readFile(file, 'utf8')).trimEnd().split('\n')
  // A restart is otherwise only visible as `ticks=1`, which says nothing about
  // which build came back or which settings it is running with.
  assert.match(lines[0] ?? '', /autopilot-start version=\d+\.\d+\.\d+ /)
  assert.match(lines[0] ?? '', /tickMs=60000 wakeMs=0 reclaimMs=300000 retryLimit=3 heartbeatMs=600000 dryRun=false$/)
})

await test('survives a host exception mid-round instead of exiting the loop', async () => {
  // A `findLeads` that rejects (session recomposition) used to propagate to the
  // async boundary of `loop` and exit the `while` for good: dispatch, reclaim
  // and park all died with no error recorded. The loop must record the error,
  // back off, and keep running rather than resolve.
  let fail = true
  const { ctx } = makeLoopCtx(1, { manual: false, intervalMs: 20, failRoots: () => fail })
  const state = freshState()
  const controller = new AbortController()
  const config: Required<Config> = { ...baseConfig, tickTimeoutMs: 20 }
  let exited = false
  const done = loop(ctx, config, state, controller.signal).then(() => { exited = true })
  void done.catch(() => undefined)

  // Let several rounds run while `roots()` keeps throwing.
  await new Promise<void>(resolve => setTimeout(resolve, 60))
  assert.ok(state.lastError !== undefined, 'the host exception was not recorded')
  assert.equal(exited, false, 'the loop exited on a host exception')

  // Recover the host; the loop must resume ticking once the back-off elapses.
  fail = false
  await new Promise<void>(resolve => setTimeout(resolve, 2_600))
  const ticks = [...state.teams.values()].reduce((sum, team) => sum + team.ticks, 0)
  assert.ok(ticks > 0, 'the loop did not resume after the host recovered')
  controller.abort()
  await done
  assert.equal(exited, true, 'the loop did not exit on abort')
})

await test('bounded status write timeout cannot stall the round', async () => {
  // `recordStatus` races the append against a timeout; a status file that hangs
  // (network volume, stuck antivirus) must drop the line, not the dispatch
  // round. Here the append itself resolves, so the round completes normally —
  // the assertion is that the guard is present and the round still runs.
  const dir = await mkdtemp(join(tmpdir(), 'autopilot-status-timeout-'))
  const file = join(dir, 'status.log')
  const { ctx } = makeLoopCtx(1, { manual: true, intervalMs: 60_000 })
  const state = freshState()
  const controller = new AbortController()
  const config: Required<Config> = { ...baseConfig, statusFile: file, tickTimeoutMs: 60_000 }
  void loop(ctx, config, state, controller.signal).catch(() => undefined)
  await new Promise<void>(resolve => setTimeout(resolve, 30))
  controller.abort()

  // The boot marker landed, proving the status path ran end to end without the
  // timeout firing spuriously on a healthy write.
  const lines = (await readFile(file, 'utf8')).trimEnd().split('\n')
  assert.match(lines[0] ?? '', /autopilot-start /)
})

await test('trim failure backs off instead of re-reading every round', async () => {
  // A permanently failing trim used to be retried on every append, turning the
  // log into an unbounded, quadratically re-read file. The backoff must stop
  // the trim path after a few consecutive failures and write a visible marker.
  const { appendStatusLineWith, resetTrimFailures } = await import('../src/observe.ts')
  resetTrimFailures()
  // A fake host whose `rename` always fails, standing in for Windows where a
  // file held open by a `tail` (read share only) cannot be replaced.
  let appends: string[] = []
  let renames = 0
  const fs = {
    append: async (_p: string, data: string) => { appends.push(data) },
    stat: async () => ({ size: 200 * 1024 }),
    read: async () => 'a\nb\nc\nd\n',
    write: async () => undefined,
    rename: async () => { renames += 1; throw new Error('file held open') },
  }
  // Each append exceeds the ceiling, so each attempts (and fails) a trim.
  for (let i = 0; i < 6; i += 1) {
    await appendStatusLineWith('/x/status.log', 'round', fs)
  }
  // The first three appends each tried to trim; once the failure limit is hit,
  // the trim path is skipped, so the rename count stops growing.
  assert.ok(renames <= 3, `rename retried ${renames}x after backoff should have stopped`)
  // The marker was appended exactly once, when the limit was reached.
  assert.equal(appends.filter(line => line === 'trim=failed\n').length, 1)
  resetTrimFailures()
})

if (failures.length > 0) {
  console.error(`FAILED ${failures.length}`)
  for (const line of failures) console.error(`  - ${line}`)
  process.exit(1)
}
console.log(`OK — ${passed} integration checks passed`)