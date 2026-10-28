#!/usr/bin/env node
/**
 * Live smoke test for the `team_autopilot_status` tool.
 *
 * The unit suites cover the decision core and the dispatch round, but the
 * status tool is the one surface a human actually reads. This script mounts
 * the real plugin against a minimal Agent Teams stub and checks that:
 *
 *  - the declared output schema compiles under the real `dsh-tools` schema
 *    compiler (the same one the host uses),
 *  - the returned value validates against that schema,
 *  - the rendered text separates totals, the caller's live board, and the
 *    per-team snapshots with their ages,
 *  - the caller's board is read live rather than replayed from a snapshot.
 *
 * Run: node scripts/verify-status.mjs
 */

import assert from 'node:assert/strict'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { apply } from '../src/index.ts'

// --- A minimal Agent Teams host stub -------------------------------------
// It mirrors only the surface the status tool touches: `tryMembership`,
// `listTasks`, and `listMembers`.

const TEAM = 'session-team-a'
const OTHER_TEAM = 'session-team-b'

const board = {
  tasks: [
    {
      id: 'task-1',
      revision: 2,
      subject: 'ship it',
      description: '',
      status: 'in_progress',
      blockedBy: [],
      writeScopes: [],
      ownerName: 'worker-x',
      ready: false,
      writeScopeWarnings: [],
    },
  ],
  members: [
    { id: 'root-a', name: 'lead', role: 'lead', status: 'running', diagnostics: [] },
    { id: 'w1', name: 'worker-x', role: 'teammate', status: 'running', diagnostics: [] },
  ],
}

const agentTeams = {
  tryMembership: (agent) => {
    if (agent?.id === 'root-a') {
      return { root: agent, id: TEAM, role: 'lead', name: 'lead' }
    }
    if (agent?.id === 'root-b') {
      return { root: agent, id: OTHER_TEAM, role: 'lead', name: 'lead' }
    }
    return undefined
  },
  listTasks: (agent) => (agent?.id === 'root-a' ? board.tasks : []),
  listMembers: (agent) => (agent?.id === 'root-a' ? board.members : []),
}

// --- Mount the plugin and capture the tool definition --------------------

let definition
const ctx = {
  agents: { roots: () => [] },
  agentTeams,
  tools: {
    register(tool) {
      definition = tool
    },
  },
  effect(_fn) {
    return () => {}
  },
}

apply(ctx, { enabled: false, dryRun: false })
assert.ok(definition !== undefined, 'the status tool must be registered')
assert.equal(definition.name, 'team_autopilot_status')

// --- Call the tool the way the host does ---------------------------------

const exec = {
  callId: 'call-1',
  rootCallId: 'call-1',
  name: 'team_autopilot_status',
  arguments: {},
  agent: { id: 'root-a' },
  signal: new AbortController().signal,
  deferContext() {},
  concludeTurn() {},
}

const result = await definition.execute({}, exec)

// --- Check the canonical value against the declared schema ----------------

const problems = validateJsonSchemaValue(definition.output.schema, result, '')
assert.deepEqual(problems, [], `the tool output must match its schema: ${problems.join('; ')}`)

assert.equal(result.enabled, false, 'the plugin was mounted disabled in this test')
assert.equal(result.dryRun, false)
assert.equal(result.rounds, 0)
assert.deepEqual(result.teams, [])
assert.equal(result.caller.team, TEAM)
// The caller is the Lead of TEAM; the live board has one task that is
// in_progress and owned by a running teammate.
assert.equal(result.caller.tasks, 1)
assert.equal(result.caller.inFlight, 1)
assert.equal(result.caller.claimable, 0)
assert.equal(result.caller.idle, 0)
// One slot is taken by the in-flight task, one is left out of the default
// `maxConcurrent` of 2.
assert.equal(result.caller.slots, 1)

// --- Check the rendered text ----------------------------------------------

const rendered = definition.output.render({}, result)
const text = rendered.map(block => block.text ?? '').join('\n')
assert.match(text, /autopilot inactive/)
assert.match(text, /totals rounds=0 dispatched=0 suppressed=0 skipped=0/)
assert.match(text, /caller team=session-team-a .*\(live\)/)
assert.match(text, /teams=0/)

// A disabled plugin reports itself as inactive, while a dry-run plugin is
// enabled but not dispatching — the two states are no longer conflated.
const dryRun = { ...result, enabled: true, dryRun: true }
assert.match(
  definition.output.render({}, dryRun).map(b => b.text ?? '').join('\n'),
  /autopilot inactive/,
)
const live = { ...result, enabled: true, dryRun: false }
assert.match(
  definition.output.render({}, live).map(b => b.text ?? '').join('\n'),
  /autopilot active/,
)

// A caller outside any team gets no live board, and the report still works.
const outsider = await definition.execute({}, { ...exec, agent: { id: 'nobody' } })
assert.equal(outsider.caller, undefined)
const outsiderProblems = validateJsonSchemaValue(definition.output.schema, outsider, '')
assert.deepEqual(outsiderProblems, [], 'the report must stay valid without a caller team')
assert.match(definition.output.render({}, outsider).map(b => b.text ?? '').join('\n'), /teams=0/)

// --- The nested decision records must validate too -----------------------
//
// `lastReclaim` / `lastDispatch` are nested objects declared with
// `additionalProperties: false`. They only appear after the first reclaim or
// dispatch, so every check above — which runs against a cold state — never
// exercises them. A nested schema the host's compiler rejects would therefore
// surface only in production, long after the install that introduced it.
const warm = {
  ...result,
  teams: [{
    team: TEAM,
    ticks: 3,
    dispatched: 2,
    suppressed: 1,
    skipped: 0,
    skippedScope: 0,
    skippedNoMember: 0,
    skippedDeclined: 0,
    unclaimed: 1,
    pending: 1,
    breaker: 'closed',
    breakerTrips: 0,
    breakerBlocked: 0,
    reclaimed: 1,
    tasks: 1,
    inFlight: 1,
    claimable: 0,
    blocked: 0,
    done: 0,
    idle: 0,
    slots: 1,
    lastTickAt: 1_000,
    lastReclaim: {
      taskId: 'task-1',
      reason: 'owner "worker-x" inactive for 60012ms',
      previousOwner: 'worker-x',
      at: 2_000,
      applied: true,
    },
    lastDispatch: {
      taskId: 'task-1',
      memberName: 'worker-x',
      at: 2_500,
      repeats: 2,
      sent: true,
      claimed: false,
    },
  }],
}
const warmProblems = validateJsonSchemaValue(definition.output.schema, warm, '')
assert.deepEqual(warmProblems, [], `nested decision records must validate: ${warmProblems.join('; ')}`)
const warmText = definition.output.render({}, warm).map(b => b.text ?? '').join('\n')
assert.match(warmText, /lastReclaim task=task-1 from=worker-x reason='owner "worker-x" inactive for 60012ms' applied/)
assert.match(warmText, /lastDispatch task=task-1 to=worker-x wakes=2 sent outcome=unclaimed/)

console.log('PASS  status tool registers, validates, and renders')
console.log('--- rendered output ---')
console.log(text)
console.log('--- end ---')
