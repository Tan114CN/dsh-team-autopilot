/**
 * dsh-team-scheduler — auto-dispatch for DeepSeek Harness Agent Teams.
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
import type { SchedulerState } from './dispatch.ts'

/** Cordis plugin name. */
export const name = 'team-scheduler'

/** Services required by the scheduler. */
export const inject = ['agents', 'agentTeams', 'tools']

/** Scheduler configuration. */
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
})

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
    lastBlocked: { type: 'integer', required: true },
    breaker: { type: 'string', required: true },
    breakerTrips: { type: 'integer', required: true },
    breakerBlocked: { type: 'integer', required: true },
    team: { type: 'string', required: true },
    tasks: { type: 'integer', required: true },
    inFlight: { type: 'integer', required: true },
    claimable: { type: 'integer', required: true },
    idle: { type: 'integer', required: true },
    slots: { type: 'integer', required: true },
    lastError: { type: 'string' },
  },
} as const

/**
 * Install the scheduler: one model-facing status tool plus the dispatch loop.
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
  }
  const state: SchedulerState = {
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

  ctx.tools.register(defineTool({
    name: 'team_scheduler_status',
    description: 'Report the team-scheduler dispatch loop state and counters.',
    parameters: {},
    output: {
      schema: STATUS_SCHEMA,
      render: () => [{
        type: 'text' as const,
        text: [
          `scheduler ${resolved.enabled && !resolved.dryRun ? 'active' : 'inactive'}`,
          `rounds=${state.rounds} dispatched=${state.dispatched} suppressed=${state.suppressed}`,
          `lastBlocked=${state.lastBlocked}`,
          `breaker=${state.breaker} trips=${state.breakerTrips} blocked=${state.breakerBlocked}`,
          `team=${state.team} tasks=${state.tasks} inFlight=${state.inFlight} claimable=${state.claimable} idle=${state.idle} slots=${state.slots}`,
          state.lastError === undefined ? '' : `lastError=${state.lastError}`,
        ].filter(line => line !== '').join('\n'),
      }],
    },
    async execute() {
      return {
        enabled: resolved.enabled && !resolved.dryRun,
        dryRun: resolved.dryRun,
        rounds: state.rounds,
        dispatched: state.dispatched,
        suppressed: state.suppressed,
        lastBlocked: state.lastBlocked,
        breaker: state.breaker,
        breakerTrips: state.breakerTrips,
        breakerBlocked: state.breakerBlocked,
        team: state.team,
        tasks: state.tasks,
        inFlight: state.inFlight,
        claimable: state.claimable,
        idle: state.idle,
        slots: state.slots,
        ...state.lastError === undefined ? {} : { lastError: state.lastError },
      }
    },
  }))

  ctx.effect(() => {
    const controller = new AbortController()
    if (resolved.enabled) {
      void loop(ctx, resolved, state, controller.signal)
    }
    return () => { controller.abort() }
  }, 'team-scheduler.loop()')
}
