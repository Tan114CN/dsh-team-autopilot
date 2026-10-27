/**
 * Locate the live Lead Agent that owns the current Team.
 *
 * `waitForChange`, `listTasks`, and `sendMessage` all require an exact live
 * Agent as their authority credential — a plugin has no identity of its own,
 * so the Lead must be resolved from the live agent registry on every round.
 * Caching it is unsafe: session recomposition replaces the Agent instance.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-experimental-agent-team'

/**
 * Find the live Team Lead.
 * @param ctx - host context with `agents` and `agentTeams` available.
 * @returns the live Lead Agent, or undefined when no Team exists yet.
 */
export function findLead(ctx: Context): Agent | undefined {
  for (const agent of ctx.agents.list()) {
    const membership = ctx.agentTeams.tryMembership(agent)
    if (membership !== undefined && membership.role === 'lead') return agent
  }
  return undefined
}
