/**
 * Locate the live Lead Agents that own every active Team.
 *
 * `waitForChange`, `listTasks`, and `sendMessage` all require an exact live
 * Agent as their authority credential — a plugin has no identity of its own,
 * so each Lead must be resolved from the live agent registry on every round.
 * Caching is unsafe: session recomposition replaces the Agent instance.
 *
 * The desktop host keeps several sessions alive at once, and every session is
 * its own Team. Resolving only the first Lead (the previous behaviour) would
 * bind the autopilot to whichever Team happened to register first and silently
 * ignore the others — so this module resolves *all* live Leads instead.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-experimental-agent-team'

/**
 * Find every live Team Lead.
 *
 * `ctx.agents.roots()` yields top-level agents (one per session) in
 * registration order, which is exactly the set of candidate Team roots;
 * `tryMembership` confirms each is a Lead and filters out non-Team roots.
 *
 * @param ctx - host context with `agents` and `agentTeams` available.
 * @returns every live Lead Agent, in registration order.
 */
export function findLeads(ctx: Context): Agent[] {
  const leads: Agent[] = []
  for (const agent of ctx.agents.roots()) {
    const membership = ctx.agentTeams.tryMembership(agent)
    if (membership !== undefined && membership.role === 'lead') leads.push(agent)
  }
  return leads
}
