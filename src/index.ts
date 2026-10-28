/**
 * dsh-team-autopilot — auto-dispatch for DeepSeek Harness Agent Teams.
 *
 * Native Agent Teams deliberately never wakes a task owner: its own model
 * policy states "Task readiness never starts an owner". This plugin closes
 * that gap by observing Team change edges and nudging an idle teammate when
 * work becomes ready. It also turns the advisory `writeScopes` overlap
 * warning into an effective soft lock at dispatch time.
 *
 * It only uses the public `ctx.agentTeams` surface, never internal symbols.
 *
 * This module is the Cordis wiring (tool + config + loop start). The dispatch
 * logic itself lives in `./dispatch.ts`, which stays free of host wiring so it
 * can be driven by headless integration tests.
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { loop } from './dispatch.ts'
import { createAutopilotState } from './state.ts'
import type { AutopilotState } from './state.ts'
import { boardSummary } from './select.ts'
import { resolveBudget } from './breaker.ts'
import { renderReport, toTeamReport } from './report.ts'
import type { LiveBoard, StatusReport, TeamReport } from './report.ts'

/** Cordis plugin name. */
export const name = 'team-autopilot'

/** Services required by the autopilot. */
export const inject = ['agents', 'agentTeams', 'tools']

/** Autopilot configuration. */
export interface Config {
  /** Run the dispatch loop. Set false to install only the status tool. */
  readonly enabled?: boolean
  /** Wait window per edge, from 10s through 1h (native bounds). */
  readonly tickTimeoutMs?: number
  /** Ceiling of concurrently in-flight tasks. */
  readonly maxConcurrent?: number
  /** Suppress re-waking the same task within this window. */
  readonly wakeCooldownMs?: number
  /** Log decisions without sending any message. */
  readonly dryRun?: boolean
  /** Per-team concurrency overrides, keyed by the team's TeamId. */
  readonly teamBudgets?: Record<string, number>
  /** Consecutive sendMessage failures that trip the circuit breaker. */
  readonly errorThreshold?: number
  /** How long the circuit stays open before a half-open probe (ms). */
  readonly openCooldownMs?: number
  /** Dispatches allowed during one half-open trial. */
  readonly halfOpenProbe?: number
  /** How long an inactive owner may hold a task before it is reclaimed (ms). */
  readonly reclaimAfterMs?: number
  /** Whether a `failed` owner hands its task back to the pool at once. */
  readonly reclaimOnFailed?: boolean
  /**
   * How many times one task may be reclaimed before the autopilot parks it.
   *
   * `0` restores the old behaviour of reclaiming forever. The limit exists
   * because reclaiming a stalled owner is right but repeating it is not: each
   * lap costs a model turn, and a task that comes back this often is evidence
   * that no member can finish it — a decision, not another wake.
   */
  readonly reclaimRetryLimit?: number
  /**
   * File to append one status line to per change. Empty disables it.
   *
   * Use an absolute path: the host decides the working directory, and a
   * relative path would land wherever the app happens to be launched from.
   */
  readonly statusFile?: string
  /**
   * Rewrite an unchanged status line at least this often (ms). 0 disables the
   * suppression and writes every tick.
   *
   * Only a change is worth a line; the heartbeat is what keeps "nothing is
   * happening" distinguishable from "the autopilot died".
   */
  readonly statusHeartbeatMs?: number
}

/** Loader schema. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  tickTimeoutMs: z.number().step(1).min(10_000).max(3_600_000).default(30_000),
  maxConcurrent: z.number().step(1).min(1).max(16).default(2),
  wakeCooldownMs: z.number().step(1).min(0).default(60_000),
  dryRun: z.boolean().default(false),
  teamBudgets: z.dict(z.number().min(1).max(16)).default({}),
  errorThreshold: z.number().step(1).min(1).max(64).default(3),
  openCooldownMs: z.number().step(1).min(1_000).max(3_600_000).default(60_000),
  halfOpenProbe: z.number().step(1).min(1).max(16).default(1),
  reclaimAfterMs: z.number().step(1).min(1_000).max(3_600_000).default(300_000),
  reclaimOnFailed: z.boolean().default(true),
  reclaimRetryLimit: z.number().step(1).min(0).max(32).default(3),
  statusFile: z.string().default(''),
  statusHeartbeatMs: z.number().step(1).min(0).default(600_000),
})

/** One reclaim the autopilot performed, as reported. */
const RECLAIM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    taskId: { type: 'string', required: true },
    reason: { type: 'string', required: true },
    previousOwner: { type: 'string', required: true },
    at: { type: 'integer', required: true },
    applied: { type: 'boolean', required: true },
  },
} as const

/** One dispatch the autopilot performed, as reported. */
const DISPATCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    taskId: { type: 'string', required: true },
    memberName: { type: 'string', required: true },
    at: { type: 'integer', required: true },
    repeats: { type: 'integer', required: true },
    sent: { type: 'boolean', required: true },
    claimed: { type: 'boolean' },
  },
} as const

/** One parked task, as reported. */
const PARK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    taskId: { type: 'string', required: true },
    reclaims: { type: 'integer', required: true },
    previousOwner: { type: 'string', required: true },
    at: { type: 'integer', required: true },
  },
} as const

/** One team's row in the status output. */
const TEAM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    team: { type: 'string', required: true },
    ticks: { type: 'integer', required: true },
    dispatched: { type: 'integer', required: true },
    suppressed: { type: 'integer', required: true },
    skipped: { type: 'integer', required: true },
    skippedScope: { type: 'integer', required: true },
    skippedNoMember: { type: 'integer', required: true },
    skippedDeclined: { type: 'integer', required: true },
    skippedParked: { type: 'integer', required: true },
    why: { type: 'array', items: { type: 'string' }, required: true },
    unclaimed: { type: 'integer', required: true },
    pending: { type: 'integer', required: true },
    breaker: { type: 'string', required: true },
    breakerTrips: { type: 'integer', required: true },
    breakerBlocked: { type: 'integer', required: true },
    reclaimed: { type: 'integer', required: true },
    parked: { type: 'array', items: PARK_SCHEMA, required: true },
    tasks: { type: 'integer', required: true },
    inFlight: { type: 'integer', required: true },
    claimable: { type: 'integer', required: true },
    blocked: { type: 'integer', required: true },
    done: { type: 'integer', required: true },
    idle: { type: 'integer', required: true },
    slots: { type: 'integer', required: true },
    lastTickAt: { type: 'integer' },
    lastReclaim: RECLAIM_SCHEMA,
    lastDispatch: DISPATCH_SCHEMA,
  },
} as const

/** The calling team's live board. */
const CALLER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    team: { type: 'string', required: true },
    tasks: { type: 'integer', required: true },
    inFlight: { type: 'integer', required: true },
    claimable: { type: 'integer', required: true },
    blocked: { type: 'integer', required: true },
    done: { type: 'integer', required: true },
    idle: { type: 'integer', required: true },
    slots: { type: 'integer', required: true },
  },
} as const

/** Report schema for the status tool. */
const STATUS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    enabled: { type: 'boolean', required: true },
    dryRun: { type: 'boolean', required: true },
    rounds: { type: 'integer', required: true },
    dispatched: { type: 'integer', required: true },
    suppressed: { type: 'integer', required: true },
    skipped: { type: 'integer', required: true },
    unclaimed: { type: 'integer', required: true },
    reclaimed: { type: 'integer', required: true },
    parked: { type: 'integer', required: true },
    teams: { type: 'array', items: TEAM_SCHEMA, required: true },
    caller: CALLER_SCHEMA,
    lastError: { type: 'string' },
  },
} as const

/**
 * Read the calling agent's own team board live.
 *
 * The status tool is usually called by one agent inside one team. Reporting
 * that team's board as it is *right now* — rather than a snapshot of whichever
 * team the autopilot happened to tick last — is what makes the numbers
 * answer the question the caller actually asked.
 * @param ctx - host context.
 * @param agent - the agent the tool was called for.
 * @param config - resolved plugin configuration.
 * @returns the live board, or undefined when the caller is not in a team.
 */
function readCallerBoard(
  ctx: Context,
  agent: unknown,
  config: Required<Config>,
): LiveBoard | undefined {
  if (agent === undefined || agent === null) return undefined
  const membership = ctx.agentTeams.tryMembership(agent as never)
  if (membership === undefined) return undefined
  const team = String(membership.id)
  // The Lead is the only role that can read the board; a teammate's
  // membership resolves to the same Team, but its own roster view differs.
  const lead = membership.role === 'lead' ? (agent as never) : membership.root
  // The team's own budget override applies, so the live board reports the
  // same slot count the autopilot would actually use for this team.
  const budget = resolveBudget(team, config.teamBudgets, config.maxConcurrent)
  const summary = boardSummary(
    ctx.agentTeams.listTasks(lead),
    ctx.agentTeams.listMembers(lead),
    budget,
  )
  return {
    team,
    tasks: summary.tasks,
    inFlight: summary.inFlight,
    claimable: summary.claimable,
    blocked: summary.blocked,
    done: summary.done,
    idle: summary.idle,
    slots: summary.slots,
  }
}

/**
 * Install the autopilot: one model-facing status tool plus the dispatch loop.
 * @param ctx - host context.
 * @param config - plugin configuration from the loader.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved: Required<Config> = {
    enabled: config.enabled ?? true,
    tickTimeoutMs: Math.min(Math.max(config.tickTimeoutMs ?? 30_000, 10_000), 3_600_000),
    maxConcurrent: config.maxConcurrent ?? 2,
    wakeCooldownMs: config.wakeCooldownMs ?? 60_000,
    dryRun: config.dryRun ?? false,
    teamBudgets: config.teamBudgets ?? {},
    errorThreshold: config.errorThreshold ?? 3,
    openCooldownMs: config.openCooldownMs ?? 60_000,
    halfOpenProbe: config.halfOpenProbe ?? 1,
    reclaimAfterMs: Math.min(Math.max(config.reclaimAfterMs ?? 300_000, 1_000), 3_600_000),
    reclaimOnFailed: config.reclaimOnFailed ?? true,
    reclaimRetryLimit: Math.min(Math.max(config.reclaimRetryLimit ?? 3, 0), 32),
    statusFile: config.statusFile ?? '',
    statusHeartbeatMs: config.statusHeartbeatMs ?? 600_000,
  }
  const state: AutopilotState = createAutopilotState()

  /**
   * Assemble the status report from the autopilot state and the live board.
   * @param agent - the agent the tool was called for.
   * @returns the report.
   */
  const buildReport = (agent: unknown): StatusReport => {
    const teams = [...state.teams.values()].map(toTeamReport)
    const dispatched = teams.reduce((sum, team) => sum + team.dispatched, 0)
    const suppressed = teams.reduce((sum, team) => sum + team.suppressed, 0)
    const skipped = teams.reduce((sum, team) => sum + team.skipped, 0)
    const unclaimed = teams.reduce((sum, team) => sum + team.unclaimed, 0)
    const reclaimed = teams.reduce((sum, team) => sum + team.reclaimed, 0)
    const parked = teams.reduce((sum, team) => sum + team.parked.length, 0)
    const caller = readCallerBoard(ctx, agent, resolved)
    return {
      enabled: resolved.enabled,
      dryRun: resolved.dryRun,
      rounds: state.rounds,
      dispatched,
      suppressed,
      skipped,
      unclaimed,
      reclaimed,
      parked,
      teams,
      ...caller === undefined ? {} : { caller },
      ...state.lastError === undefined ? {} : { lastError: state.lastError },
    }
  }

  ctx.tools.register(defineTool({
    name: 'team_autopilot_status',
    description: 'Report the team-autopilot dispatch loop state: lifetime totals, a per-team breakdown, the calling team\'s live board, and the last reclaim/dispatch with their outcome. Tasks parked after repeated reclaims are listed with the count that parked them.',
    parameters: {},
    output: {
      schema: STATUS_SCHEMA,
      render: (_args, value) => [{
        type: 'text' as const,
        text: renderReport(value as StatusReport, Date.now()).join('\n'),
      }],
    },
    async execute(_args, exec) {
      return buildReport(exec.agent)
    },
  }))

  ctx.effect(() => {
    const controller = new AbortController()
    if (resolved.enabled) {
      // The loop fences every round and never exits on its own, so this catch
      // is a last-resort net for anything that escapes the fence. It must not
      // be able to take the dispatcher down silently.
      void loop(ctx, resolved, state, controller.signal).catch((error: unknown) => {
        state.lastError = error instanceof Error ? error.message : String(error)
      })
    }
    return () => { controller.abort() }
  }, 'team-autopilot.loop()')
}
