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
import type { AutopilotState, TeamState } from './state.ts'
import { boardSummary } from './select.ts'
import { resolveBudget } from './breaker.ts'
import { renderReport } from './report.ts'
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
    unclaimed: { type: 'integer', required: true },
    breaker: { type: 'string', required: true },
    breakerTrips: { type: 'integer', required: true },
    breakerBlocked: { type: 'integer', required: true },
    reclaimed: { type: 'integer', required: true },
    tasks: { type: 'integer', required: true },
    inFlight: { type: 'integer', required: true },
    claimable: { type: 'integer', required: true },
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
    teams: { type: 'array', items: TEAM_SCHEMA, required: true },
    caller: CALLER_SCHEMA,
    lastError: { type: 'string' },
  },
} as const

/**
 * Convert one team's state bucket into its report row.
 * @param team - the team's state bucket.
 * @returns the row describing it.
 */
function teamReport(team: TeamState): TeamReport {
  return {
    team: team.team,
    ticks: team.ticks,
    dispatched: team.dispatched,
    suppressed: team.suppressed,
    skipped: team.skipped,
    skippedScope: team.skippedScope,
    skippedNoMember: team.skippedNoMember,
    unclaimed: team.unclaimed,
    breaker: team.breaker,
    breakerTrips: team.breakerTrips,
    breakerBlocked: team.breakerBlocked,
    reclaimed: team.reclaimed,
    tasks: team.tasks,
    inFlight: team.inFlight,
    claimable: team.claimable,
    idle: team.idle,
    slots: team.slots,
    ...team.lastTickAt === undefined ? {} : { lastTickAt: team.lastTickAt },
    ...team.lastReclaim === undefined ? {} : { lastReclaim: team.lastReclaim },
    ...team.lastDispatch === undefined ? {} : { lastDispatch: team.lastDispatch },
  }
}

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
  }
  const state: AutopilotState = createAutopilotState()

  /**
   * Assemble the status report from the autopilot state and the live board.
   * @param agent - the agent the tool was called for.
   * @returns the report.
   */
  const buildReport = (agent: unknown): StatusReport => {
    const teams = [...state.teams.values()].map(teamReport)
    const dispatched = teams.reduce((sum, team) => sum + team.dispatched, 0)
    const suppressed = teams.reduce((sum, team) => sum + team.suppressed, 0)
    const skipped = teams.reduce((sum, team) => sum + team.skipped, 0)
    const unclaimed = teams.reduce((sum, team) => sum + team.unclaimed, 0)
    const reclaimed = teams.reduce((sum, team) => sum + team.reclaimed, 0)
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
      teams,
      ...caller === undefined ? {} : { caller },
      ...state.lastError === undefined ? {} : { lastError: state.lastError },
    }
  }

  ctx.tools.register(defineTool({
    name: 'team_autopilot_status',
    description: 'Report the team-autopilot dispatch loop state: lifetime totals, a per-team breakdown, the calling team\'s live board, and the last reclaim/dispatch with their outcome.',
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
      void loop(ctx, resolved, state, controller.signal)
    }
    return () => { controller.abort() }
  }, 'team-autopilot.loop()')
}
