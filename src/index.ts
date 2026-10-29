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
import { callerBoard } from './select.ts'
import { resolveBudget } from './breaker.ts'
import { createLiveness, trackLiveness } from './liveness.ts'
import { renderReport, healthOf, toTeamReport } from './report.ts'
import type { LiveBoard, StatusReport, TeamReport } from './report.ts'
import { version } from './observe.ts'

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
  /**
   * Whether to watch `agent/status` for turn boundaries.
   *
   * Two decisions wait for a teammate to react: whether a wake was answered,
   * and whether an owner has stalled. With this on they are settled by an
   * observed `running` → `idle` transition; with it off they fall back to
   * `wakeCooldownMs` and `reclaimAfterMs` alone, which is how the autopilot
   * behaved before liveness existed. Turning it off never makes a decision
   * faster, only less certain.
   */
  readonly livenessEnabled?: boolean
  /**
   * How long an owner may stay quiet after its turn ended before the task is
   * reclaimed (ms).
   *
   * Much shorter than `reclaimAfterMs`, and safely so: that window is long
   * because `inactive` alone cannot tell "never started" from "between
   * turns". An observed turn end has already answered that, so what is left
   * to cover is only a follow-up turn, not a possible first one.
   */
  readonly livenessGraceMs?: number
  /**
   * Lag allowed between a turn ending and the claim becoming visible (ms).
   *
   * A turn end is proof the member has finished reacting, but the `claim` it
   * wrote during that turn is persisted on its own path and may land a moment
   * later. Judging at the same instant would read a member that did claim as
   * one that refused — the exact false alarm this feature exists to remove.
   */
  readonly livenessSettleGraceMs?: number
  /**
   * How long an owner may stay busy on one task before it is reported (ms).
   *
   * The counterpart to `reclaimAfterMs`. Reclaim only touches an owner that is
   * *not* working on its task: `inactive`, `failed`, or gone. A `running` owner
   * is never reclaimed, because there is no duration after which a turn is
   * provably dead — and that is exactly the state a wedged turn hides in. This
   * window is how long one may last before the autopilot says so.
   *
   * Purely an observation: the report and the status line grow a stall entry,
   * nothing is released. `0` disables the watch.
   */
  readonly stalledRunningMs?: number
  /**
   * Whether a stalled `running` turn is interrupted.
   *
   * Off by default, on purpose. Interrupting cancels live work, and a long turn
   * is usually a big task, not a bug — a wrong interrupt costs a teammate's
   * whole afternoon, while a missed one costs an idle slot until a human looks.
   * With it on, the autopilot cancels the member's turn once per stall; the
   * member then reads `inactive` and the ordinary reclaim path finishes the
   * job. Never acts under `dryRun`.
   */
  readonly interruptStalled?: boolean
  /**
   * Wakes (model turns) this plugin may start per team in one rolling hour.
   *
   * The only thing here that costs money is a wake, and until this existed the
   * only ceilings were per task: `wakeCooldownMs` bounds re-wakes of one task
   * and `reclaimRetryLimit` bounds one task's retry loop. Twenty ready tasks
   * against five idle members could still start twenty turns, and start twenty
   * more the next hour, with nothing to say so.
   *
   * `0` (the default) leaves the budget off. When set, a round that has spent
   * it dispatches nothing and reports `why=budget` — a deliberate stop, not a
   * fault, which is why it gets its own skip counter.
   */
  readonly wakeBudgetPerHour?: number
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
  livenessEnabled: z.boolean().default(true),
  livenessGraceMs: z.number().step(1).min(1_000).max(3_600_000).default(60_000),
  livenessSettleGraceMs: z.number().step(1).min(0).max(600_000).default(3_000),
  stalledRunningMs: z.number().step(1).min(0).max(3_600_000).default(900_000),
  interruptStalled: z.boolean().default(false),
  wakeBudgetPerHour: z.number().step(1).min(0).max(100_000).default(0),
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

/** One running-turn stall, as reported. */
export const STALL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    taskId: { type: 'string', required: true },
    ownerName: { type: 'string', required: true },
    forMs: { type: 'integer', required: true },
    at: { type: 'integer', required: true },
  },
} as const

/** One team's row in the status output. */
export const TEAM_SCHEMA = {
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
    skippedBudget: { type: 'integer', required: true },
    why: { type: 'array', items: { type: 'string' }, required: true },
    unclaimed: { type: 'integer', required: true },
    pending: { type: 'integer', required: true },
    breaker: { type: 'string', required: true },
    breakerTrips: { type: 'integer', required: true },
    breakerBlocked: { type: 'integer', required: true },
    reclaimed: { type: 'integer', required: true },
    parked: { type: 'array', items: PARK_SCHEMA, required: true },
    stalled: { type: 'integer', required: true },
    stallWarnings: { type: 'integer', required: true },
    stallInterrupts: { type: 'integer', required: true },
    statusWriteFailed: { type: 'boolean', required: true },
    tasks: { type: 'integer', required: true },
    inFlight: { type: 'integer', required: true },
    claimable: { type: 'integer', required: true },
    blocked: { type: 'integer', required: true },
    done: { type: 'integer', required: true },
    idle: { type: 'integer', required: true },
    slots: { type: 'integer', required: true },
    wakesThisHour: { type: 'integer', required: true },
    wakeBudget: { type: 'integer', required: true },
    lastTickAt: { type: 'integer' },
    lastReclaim: RECLAIM_SCHEMA,
    lastDispatch: DISPATCH_SCHEMA,
    lastStall: STALL_SCHEMA,
  },
} as const

/** The calling team's live board. */
export const CALLER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    team: { type: 'string', required: true },
    tasks: { type: 'integer', required: true },
    inFlight: { type: 'integer', required: true },
    claimable: { type: 'integer', required: true },
    parked: { type: 'integer', required: true },
    blocked: { type: 'integer', required: true },
    done: { type: 'integer', required: true },
    idle: { type: 'integer', required: true },
    slots: { type: 'integer', required: true },
  },
} as const

/** Report schema for the status tool. */
export const STATUS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    enabled: { type: 'boolean', required: true },
    dryRun: { type: 'boolean', required: true },
    version: { type: 'string', required: true },
    health: { type: 'string', required: true },
    uptimeMs: { type: 'integer', required: true },
    rounds: { type: 'integer', required: true },
    dispatched: { type: 'integer', required: true },
    suppressed: { type: 'integer', required: true },
    skipped: { type: 'integer', required: true },
    unclaimed: { type: 'integer', required: true },
    reclaimed: { type: 'integer', required: true },
    parked: { type: 'integer', required: true },
    stalled: { type: 'integer', required: true },
    stallInterrupts: { type: 'integer', required: true },
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
  state: AutopilotState,
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
  const tasks = ctx.agentTeams.listTasks(lead)
  // Fold in the two pieces of memory that change the answer: a parked task is
  // not offerable, and a slot promised to an unanswered wake is not free. Both
  // are numbers a Lead reads to decide "is there room for one more task", so
  // the caller's own board has to agree with the decision the loop would make.
  const summary = callerBoard(
    tasks,
    ctx.agentTeams.listMembers(lead),
    budget,
    state.teams.get(team),
  )
  return {
    team,
    tasks: summary.tasks,
    inFlight: summary.inFlight,
    claimable: summary.claimable,
    parked: summary.parked,
    blocked: summary.blocked,
    done: summary.done,
    idle: summary.idle,
    slots: summary.slots,
  }
}

/**
 * Resolve raw configuration into the values the loop runs on.
 *
 * Two things are deliberate here and must stay in step with the `Config`
 * schema above:
 *
 * - **bounds are re-applied.** The schema is what a well-formed loader hands
 *   over, but config can also arrive from a hand-edited patch or a store that
 *   never validated it, and a `tickTimeoutMs: 5` there would spin the loop. The
 *   clamp is the last line of defence, so it is intentionally not a feature.
 * - **defaults live in exactly one place.** Every `??` fallback must equal the
 *   schema default: two copies of the same number can disagree, and when they
 *   do, the silent one wins. `scripts/verify-status.mjs` asserts the pair
 *   matches so this cannot drift unnoticed.
 *
 * @param config - raw plugin configuration.
 * @returns every setting populated.
 */
/**
 * Clamp one numeric setting into its declared bounds.
 *
 * Every key the schema bounds gets clamped here too. Bounds live in two places
 * on purpose (the schema rejects bad operator input; this is the last line of
 * defence for values that reach `apply` without validation), but the two must
 * agree — `verify-status` asserts the defaults do. The keys that matter most are
 * not the exotic ones: `maxConcurrent` and `halfOpenProbe` at `0` do not fail
 * loudly, they zero the slots forever, and a team that never dispatches looks
 * exactly like a team with nothing to do.
 *
 * @param value - raw value (already defaulted).
 * @param min - inclusive lower bound.
 * @param max - inclusive upper bound.
 * @returns the clamped value.
 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/**
 * Resolve plugin configuration: apply schema defaults, then clamp every
 * bounded numeric into range.
 * @param config - raw plugin configuration.
 * @returns the fully resolved configuration.
 */
export function resolveConfig(config: Config = {}): Required<Config> {
  return {
    enabled: config.enabled ?? true,
    tickTimeoutMs: clamp(config.tickTimeoutMs ?? 30_000, 10_000, 3_600_000),
    maxConcurrent: clamp(config.maxConcurrent ?? 2, 1, 16),
    // Not bounded above on purpose: a long cooldown or heartbeat is a slow but
    // honest choice, and clamping it would silently override an operator's
    // intent. Only the values that zero out real work (`0` slots, `0` probes)
    // are forced into range.
    wakeCooldownMs: Math.max(config.wakeCooldownMs ?? 60_000, 0),
    dryRun: config.dryRun ?? false,
    teamBudgets: Object.fromEntries(
      Object.entries(config.teamBudgets ?? {}).map(([team, budget]) => [team, clamp(budget, 1, 16)]),
    ),
    errorThreshold: clamp(config.errorThreshold ?? 3, 1, 64),
    openCooldownMs: clamp(config.openCooldownMs ?? 60_000, 1_000, 3_600_000),
    halfOpenProbe: clamp(config.halfOpenProbe ?? 1, 1, 16),
    reclaimAfterMs: clamp(config.reclaimAfterMs ?? 300_000, 1_000, 3_600_000),
    reclaimOnFailed: config.reclaimOnFailed ?? true,
    reclaimRetryLimit: clamp(config.reclaimRetryLimit ?? 3, 0, 32),
    statusFile: config.statusFile ?? '',
    statusHeartbeatMs: Math.max(config.statusHeartbeatMs ?? 600_000, 0),
    livenessEnabled: config.livenessEnabled ?? true,
    livenessGraceMs: clamp(config.livenessGraceMs ?? 60_000, 1_000, 3_600_000),
    livenessSettleGraceMs: clamp(config.livenessSettleGraceMs ?? 3_000, 0, 600_000),
    stalledRunningMs: clamp(config.stalledRunningMs ?? 900_000, 0, 3_600_000),
    interruptStalled: config.interruptStalled ?? false,
    // `0` keeps meaning "off", so the clamp floor must not turn an unset budget
    // into a one-wake budget.
    wakeBudgetPerHour: clamp(config.wakeBudgetPerHour ?? 0, 0, 100_000),
  }
}

/**
 * Install the autopilot: one model-facing status tool plus the dispatch loop.
 * @param ctx - host context.
 * @param config - plugin configuration from the loader.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
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
    const stalled = teams.reduce((sum, team) => sum + team.stalled, 0)
    const stallInterrupts = teams.reduce((sum, team) => sum + team.stallInterrupts, 0)
    const caller = readCallerBoard(ctx, agent, resolved, state)
    return {
      enabled: resolved.enabled,
      dryRun: resolved.dryRun,
      version: version(),
      health: healthOf(resolved.enabled, teams),
      // Every counter below is in-memory, so a restart zeroes all of them and
      // leaves the task board untouched. Reporting how long this process has
      // been counting is what turns "dispatched=3" into something readable, and
      // explains a wake budget that looks untouched right after it was spent.
      uptimeMs: Math.max(0, Date.now() - state.startedAt),
      rounds: state.rounds,
      dispatched,
      suppressed,
      skipped,
      unclaimed,
      reclaimed,
      parked,
      stalled,
      stallInterrupts,
      teams,
      ...caller === undefined ? {} : { caller },
      ...state.lastError === undefined ? {} : { lastError: state.lastError },
    }
  }

  ctx.tools.register(defineTool({
    name: 'team_autopilot_status',
    description: 'Report the team-autopilot dispatch loop state: lifetime totals, a per-team breakdown, the calling team\'s live board, and the last reclaim/dispatch/stall with their outcome. Tasks parked after repeated reclaims are listed with the count that parked them.',
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

  // Subscribed on the plugin's own context, so the listener goes away with the
  // plugin. Created before the loop starts: a turn boundary that arrives while
  // the first round is still reading the board is still one the loop can use.
  const liveness = resolved.livenessEnabled ? createLiveness() : undefined
  if (liveness !== undefined) trackLiveness(ctx, liveness)

  ctx.effect(() => {
    const controller = new AbortController()
    if (resolved.enabled) {
      // The loop fences every round and never exits on its own, so this catch
      // is a last-resort net for anything that escapes the fence. It must not
      // be able to take the dispatcher down silently.
      void loop(ctx, resolved, state, controller.signal, liveness).catch((error: unknown) => {
        state.lastError = error instanceof Error ? error.message : String(error)
      })
    }
    return () => { controller.abort() }
  }, 'team-autopilot.loop()')
}
