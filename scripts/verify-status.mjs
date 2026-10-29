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
import { readFileSync } from 'node:fs'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import {
  apply,
  resolveConfig,
  Config,
  CALLER_SCHEMA,
  STATUS_SCHEMA,
  TEAM_SCHEMA,
} from '../src/index.ts'
import { createAutopilotState, teamState } from '../src/state.ts'
import { toTeamReport } from '../src/report.ts'

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
  // `trackLiveness` subscribes with `ctx.on('agent/status', …)`. The stub has to
  // accept that call even though nothing is ever emitted: when liveness shipped
  // without it, this whole check died at `apply` with "ctx.on is not a function"
  // and stopped verifying the tool output at all.
  on(_event, _handler) {
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
// The verdict is about what the plugin is doing, so a mounted-but-disabled
// plugin says `off` even though there is no team to point at.
assert.equal(result.health, 'off', 'a disabled plugin reports itself as off')
assert.equal(typeof result.version, 'string', 'the report says which build answered')
assert.ok(result.version.length > 0)
assert.equal(result.rounds, 0)
assert.deepEqual(result.teams, [])
assert.equal(result.caller.team, TEAM)
// The caller is the Lead of TEAM; the live board has one task that is
// in_progress and owned by a running teammate.
assert.equal(result.caller.tasks, 1)
assert.equal(result.caller.inFlight, 1)
assert.equal(result.caller.claimable, 0)
// Nothing is parked in this fixture, but the field must exist and be zero:
// the caller's line names the parked bucket so its numbers keep partitioning
// `tasks` when something *is* parked.
assert.equal(result.caller.parked, 0)
assert.equal(result.caller.idle, 0)
// One slot is taken by the in-flight task, one is left out of the default
// `maxConcurrent` of 2.
assert.equal(result.caller.slots, 1)

// --- Drift guards --------------------------------------------------------
//
// The schema is the contract the host compiles; the report is what the plugin
// actually returns. Every schema here sets `additionalProperties: false`, which
// means a field added to the report but forgotten in the schema is dropped
// *silently* — the tool keeps working and quietly stops reporting it. A field
// required by the schema but never produced fails only at call time, in
// production. Nothing else in this repo catches either: the unit suites never
// import `index.ts` (it needs the host packages), so these two walk the object
// graphs instead.

const keysOf = value => Object.keys(value).sort()

/**
 * Assert a hand-built schema and a real report describe exactly the same fields.
 * @param label - what is being compared, for the failure message.
 * @param schema - declared JSON schema with a `properties` map.
 * @param value - a fully populated report object.
 */
function assertSchemaCovers(label, schema, value) {
  assert.deepEqual(
    keysOf(value),
    keysOf(schema.properties),
    `${label}: schema and report disagree on fields (a report field missing from the`
    + ' schema is silently dropped by validation; a declared field never produced fails at call time)',
  )
  const required = Object.entries(schema.properties)
    .filter(([, property]) => property.required === true)
    .map(([key]) => key)
    .sort()
  const missing = required.filter(key => !(key in value))
  assert.deepEqual(missing, [], `${label}: declared required but absent from the report`)
}

// The status report, with its two optional fields filled so the comparison sees
// the whole shape rather than whatever a cold state happens to omit.
assertSchemaCovers('status report', STATUS_SCHEMA, { ...result, lastError: 'probe' })
assertSchemaCovers('caller board', CALLER_SCHEMA, result.caller)

// A fully populated team bucket, so optional records (`lastReclaim`,
// `lastDispatch`, `lastStall`) are part of the comparison too.
const probeState = createAutopilotState()
const probeBucket = teamState(probeState, 'probe-team')
probeBucket.lastReclaim = {
  taskId: 'task-1',
  reason: 'probe',
  previousOwner: 'probe',
  at: 1,
  applied: true,
}
probeBucket.lastDispatch = { taskId: 'task-1', memberName: 'probe', at: 2, repeats: 1, sent: true }
probeBucket.lastStall = { taskId: 'task-1', ownerName: 'probe', forMs: 3, at: 4 }
probeBucket.lastTickAt = 5
assertSchemaCovers('team report', TEAM_SCHEMA, toTeamReport(probeBucket))

// Defaults exist twice by necessity: once in the schema (what the loader
// documents and fills) and once as `??` fallbacks in `resolveConfig` (what runs
// when validation was bypassed). Two copies of the same number disagree sooner
// or later, and the silent one wins — so compare them every run.
const schemaDefaults = Config({})
const resolvedDefaults = resolveConfig()
assert.deepEqual(
  Object.keys(resolvedDefaults).sort(),
  Object.keys(schemaDefaults).sort(),
  'resolveConfig must cover exactly the keys the schema declares',
)
for (const key of Object.keys(schemaDefaults)) {
  assert.deepEqual(
    resolvedDefaults[key],
    schemaDefaults[key],
    `default for "${key}" drifted between the schema and resolveConfig`,
  )
}

// The clamp is the last line of defence for values that bypass validation, so
// it has to cover the keys that fail *silently*. `maxConcurrent: 0` and
// `halfOpenProbe: 0` raise nothing at all: the first zeroes the slots forever,
// the second latches the breaker half-open so nothing is ever dispatched again.
// Both look exactly like a team with nothing to do.
const clamped = resolveConfig({
  maxConcurrent: 0,
  halfOpenProbe: 0,
  errorThreshold: 0,
  reclaimRetryLimit: 99,
  teamBudgets: { tight: 0, wide: 99 },
})
assert.equal(clamped.maxConcurrent, 1, 'a zero budget must not survive as zero slots')
assert.equal(clamped.halfOpenProbe, 1, 'a zero probe count must not survive as a latched breaker')
assert.equal(clamped.errorThreshold, 1, 'a zero error threshold would trip before any error')
assert.equal(clamped.reclaimRetryLimit, 32, 'the parking retry limit must stay in range')
assert.deepEqual(
  clamped.teamBudgets,
  { tight: 1, wide: 16 },
  'per-team budgets must be clamped like the global one',
)
const generous = resolveConfig({ wakeCooldownMs: 0, statusHeartbeatMs: 0 })
assert.equal(generous.wakeCooldownMs, 0, 'an explicit zero cooldown is a valid choice, not a bug')
assert.equal(generous.statusHeartbeatMs, 0, 'a zero heartbeat means "write every round"')

// The README config table is a fourth copy of the same facts, and it has drifted
// before: `liveness*` shipped in code but not in the table, and the table still
// promised defaults the schema had moved past. Nobody notices, because a wrong
// documented default fails in the direction of "operator sets the old value and
// wonders why nothing changed". Walk the table the same way the other guards
// walk the schema.
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
const documented = new Map()
for (const line of readme.split('\n')) {
  const row = /^\| `([A-Za-z][A-Za-z0-9]*)`\s*\|\s*`([^`]*)`\s*\|/.exec(line)
  if (row !== null) documented.set(row[1], row[2])
}
const showDefault = (value) => {
  if (typeof value === 'string') return value === '' ? "''" : value
  return JSON.stringify(value)
}
for (const [key, value] of Object.entries(resolvedDefaults)) {
  assert.ok(documented.has(key), `README's config table must document "${key}"`)
  assert.equal(
    documented.get(key),
    showDefault(value),
    `README documents a different default for "${key}"`,
  )
}
for (const key of documented.keys()) {
  assert.ok(key in resolvedDefaults, `README documents "${key}", which the config no longer has`)
}

// --- Check the rendered text ----------------------------------------------

const rendered = definition.output.render({}, result)
const text = rendered.map(block => block.text ?? '').join('\n')
assert.match(text, /autopilot inactive health=off version=\S+ up=\d+[smhd]$/m)
assert.ok(result.uptimeMs >= 0, 'a lifetime must never be reported as negative')
assert.match(text, /totals rounds=0 dispatched=0 suppressed=0 skipped=0/)
assert.match(text, /caller team=session-team-a .*\(live\)/)
assert.match(text, /teams=0/)

// A disabled plugin reports itself as inactive, a dry-run plugin is enabled
// but not sending (its own `dry-run` state), and a live plugin is `active` —
// three distinct states, so a dry-run deployment can never read as "not loaded".
const dryRun = { ...result, enabled: true, dryRun: true }
assert.match(
  definition.output.render({}, dryRun).map(b => b.text ?? '').join('\n'),
  /autopilot dry-run/,
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
  // The canonical fixture was mounted disabled; this one describes a running
  // plugin, so it has to say so or the verdict line reads `inactive` while
  // every number below it is from a live deployment.
  enabled: true,
  dryRun: false,
  // Overridden with the verdict the row below would actually produce: a team
  // holding a stalled task is `stuck`, and the rendered verdict line has to
  // agree with the per-team warning that follows it.
  health: 'stuck',
  teams: [{
    team: TEAM,
    ticks: 3,
    dispatched: 2,
    suppressed: 1,
    skipped: 0,
    skippedScope: 0,
    skippedNoMember: 0,
    skippedDeclined: 0,
    skippedParked: 0,
    skippedBudget: 0,
    why: ['scope'],
    unclaimed: 1,
    pending: 1,
    breaker: 'closed',
    breakerTrips: 0,
    breakerBlocked: 0,
    reclaimed: 1,
    parked: [
      { taskId: 'task-4', reclaims: 3, previousOwner: 'worker-x', at: 2_700 },
    ],
    stalled: 1,
    stallWarnings: 2,
    stallInterrupts: 1,
    statusWriteFailed: false,
    tasks: 1,
    inFlight: 1,
    claimable: 0,
    blocked: 0,
    done: 0,
    idle: 0,
    slots: 1,
    wakesThisHour: 2,
    wakeBudget: 10,
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
    lastStall: {
      taskId: 'task-1',
      ownerName: 'worker-x',
      forMs: 900_400,
      at: 2_600,
    },
  }],
}
const warmProblems = validateJsonSchemaValue(definition.output.schema, warm, '')
assert.deepEqual(warmProblems, [], `nested decision records must validate: ${warmProblems.join('; ')}`)
const warmText = definition.output.render({}, warm).map(b => b.text ?? '').join('\n')
assert.match(warmText, /autopilot active health=stuck version=\S+ up=\d+[smhd]$/m)
assert.match(warmText, /lastReclaim task=task-1 from=worker-x reason='owner "worker-x" inactive for 60012ms' applied/)
assert.match(warmText, /lastDispatch task=task-1 to=worker-x wakes=2 sent outcome=unclaimed/)
// The stall record is the newest nested object, and the one whose whole point
// is that the surrounding numbers look healthy — so it is rendered with the
// owner's name rather than folded into a count.
assert.match(warmText, /lastStall task=task-1 owner=worker-x for=900400ms \(\d+ms ago\)/)
// `why` is the one status field declared as an array. Assert it is enforced as
// one: a string would pass a check that only looked at presence.
assert.match(warmText, /why=scope /)
// Parked tasks are an array of nested objects — the shape most likely to be
// declared, never exercised, and then rejected by the host's compiler.
assert.match(warmText, /parked task=task-4 after=3 reclaims lastOwner=worker-x \(\d+ms ago\)/)
const stringWhy = {
  ...warm,
  teams: [{ ...warm.teams[0], why: 'scope' }],
}
assert.notDeepEqual(
  validateJsonSchemaValue(definition.output.schema, stringWhy, ''),
  [],
  'why is a set of reasons, not a comma-joined string',
)

console.log('PASS  status tool registers, validates, and renders')
console.log('--- rendered output ---')
console.log(text)
console.log('--- end ---')
