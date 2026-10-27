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
import type { SchedulerState } from '../src/dispatch.ts'
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
}

function makeHost(
  tasks: TeamTaskView[],
  members: TeamMemberView[],
): Host {
  return { tasks, members, sent: [], attempts: 0, failSend: false }
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
    },
  }
  return ctx as unknown as Context
}

function freshState(): SchedulerState {
  return {
    rounds: 0,
    dispatched: 0,
    suppressed: 0,
    lastBlocked: 0,
    lastTickAt: undefined,
    lastError: undefined,
    breaker: 'closed',
    breakerTrips: 0,
    breakerBlocked: 0,
    team: '',
    tasks: 0,
    inFlight: 0,
    claimable: 0,
    idle: 0,
    slots: 0,
  }
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
  await tick(makeCtx(host), lead, baseConfig, state, new Map(), createBreaker(), signal)
  assert.equal(host.sent.length, 1)
  assert.equal(host.sent[0], 'alice')
  assert.equal(state.rounds, 1)
  assert.equal(state.dispatched, 1)
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
  await tick(makeCtx(host), lead, baseConfig, state, new Map(), createBreaker(), signal)
  assert.equal(host.attempts, 0)
  assert.equal(state.lastBlocked, 1)
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

  breaker = await tick(ctx, lead, config, state, new Map(), breaker, signal)
  breaker = await tick(ctx, lead, config, state, new Map(), breaker, signal)
  assert.equal(breaker.state, 'open')
  assert.notEqual(state.breaker, 'closed')
  assert.ok(state.breakerTrips >= 1, `expected a trip, got ${state.breakerTrips}`)

  const before = host.attempts
  breaker = await tick(ctx, lead, config, state, new Map(), breaker, signal)
  assert.equal(host.attempts, before, 'no dispatch may happen while the breaker is open')
  assert.ok(state.breakerBlocked >= 1, 'the open breaker must have blocked a round')
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
    new Map(),
    createBreaker(),
    signal,
  )
  assert.equal(host.sent.length, 1)
})

if (failures.length > 0) {
  console.error(`FAILED ${failures.length}`)
  for (const line of failures) console.error(`  - ${line}`)
  process.exit(1)
}
console.log(`OK — ${passed} integration checks passed`)
