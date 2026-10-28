/**
 * Zero-token observation: the autopilot writes its own status line.
 *
 * Reading `team_autopilot_status` costs a whole model turn, and the report it
 * returns then stays in the conversation for the rest of the session. Polling a
 * loop whose entire purpose is to run unattended is the wrong shape, and an
 * operator watching a headless team had no cheap way in.
 *
 * A file the host appends to by itself is that way in: one line per *change*,
 * plus a heartbeat while nothing changes, readable with `tail`, costing
 * nothing — no model turn, no context, no tokens.
 *
 * It is also the *only* way in. The state lives in the host process's memory,
 * so no outside process can read it and no external tooling can observe a
 * running autopilot except through what the autopilot writes down.
 */

import { readFileSync } from 'node:fs'
import { appendFile, readFile, rename, stat, writeFile } from 'node:fs/promises'
import type { Config } from './index.ts'
import type { TeamState } from './state.ts'

/**
 * The version of the plugin that is running.
 *
 * Read from the package manifest beside the entry point rather than injected at
 * build time: the same file then works unbundled in tests and bundled in
 * `dist/`, with no build step to remember. Configuration is the other half of
 * "what is actually running" — after a restart a stale profile is
 * indistinguishable from a working one until something misbehaves, and a boot
 * marker ends that guesswork.
 * @returns the package version, or `unknown` if the manifest cannot be read.
 */
let cachedVersion: string | undefined
function version(): string {
  if (cachedVersion !== undefined) return cachedVersion
  try {
    const manifest = new URL('../package.json', import.meta.url)
    cachedVersion = String((JSON.parse(readFileSync(manifest, 'utf8')) as { version?: string }).version)
  } catch {
    cachedVersion = 'unknown'
  }
  return cachedVersion
}

/**
 * Format one process start as a single line.
 *
 * Written once per loop start, not per round: it answers "which build, with
 * which settings" for the whole run, and a restart is then visible in the log
 * as a marker rather than as a `ticks=1` the reader has to decode.
 * @param at - epoch milliseconds of the start.
 * @param config - resolved configuration the loop is about to run with.
 * @returns the line, without a trailing newline.
 */
export function startupLine(at: number, config: Required<Config>): string {
  return [
    new Date(at).toISOString(),
    'autopilot-start',
    `version=${version()}`,
    `tickMs=${config.tickTimeoutMs}`,
    `wakeMs=${config.wakeCooldownMs}`,
    `reclaimMs=${config.reclaimAfterMs}`,
    // How many times a task may come back before it is parked. Printed with
    // the rest of the settings because a `park=` in the log is unreadable
    // without the limit that produced it.
    `retryLimit=${config.reclaimRetryLimit}`,
    `heartbeatMs=${config.statusHeartbeatMs}`,
    `dryRun=${config.dryRun}`,
  ].join(' ')
}

/**
 * Bytes after which the log is trimmed back to its trailing half.
 *
 * One line is roughly 250 bytes. Only changes and heartbeats are written, so a
 * quiet team costs a few lines an hour and this ceiling holds weeks of history;
 * a busy team reaches it in a day, and halving keeps the recent rounds.
 */
const MAX_BYTES = 128 * 1024

/**
 * Format one tick as a single greppable line.
 *
 * Kept on one line on purpose: `tail -1` yields the current state, `tail -30`
 * yields the recent history, and `grep unclaimed=[1-9]` finds every round in
 * which a wake went unanswered. A pretty multi-line block would have to be
 * read in full to be useful, which for a log means never.
 * @param team - that team's bucket, already updated for this tick.
 * @param at - epoch milliseconds of the tick.
 * @returns the line, without a trailing newline.
 */
export function statusLine(team: TeamState, at: number): string {
  const parts = [
    new Date(at).toISOString(),
    `team=${team.team}`,
    `ticks=${team.ticks}`,
    `dispatched=${team.dispatched}`,
    `suppressed=${team.suppressed}`,
    `skip=${team.skipped}`,
    `scope=${team.skippedScope}`,
    `noMember=${team.skippedNoMember}`,
    `declined=${team.skippedDeclined}`,
    // Cumulative, like its siblings, and sitting next to them on purpose: the
    // four numbers together say which fix applies, and a task that keeps
    // coming back is the one cause a reader cannot diagnose from a single
    // round. The *current* parked tasks are announced as an event below.
    `parked=${team.skippedParked}`,
    // Why this round skipped anything, deduplicated. `-` rather than omitting
    // the field: "nothing was skipped" is a fact a reader needs, and an absent
    // key is indistinguishable from an older build.
    `why=${team.skipKinds.length === 0 ? '-' : team.skipKinds.join(',')}`,
    `unclaimed=${team.unclaimed}`,
    // Wakes already sent whose post-cooldown check is still owed. One number,
    // because `lastDispatch` can only remember the most recent hand-off —
    // two wakes in flight look exactly like one without it.
    `pending=${team.pendingWakes.size}`,
    `reclaimed=${team.reclaimed}`,
    `tasks=${team.tasks}`,
    `inFlight=${team.inFlight}`,
    `claimable=${team.claimable}`,
    `blocked=${team.blocked}`,
    `done=${team.done}`,
    `idle=${team.idle}`,
    `slots=${team.slots}`,
    `breaker=${team.breaker}`,
    `trips=${team.breakerTrips}`,
    `held=${team.breakerBlocked}`,
  ]
  const dispatch = team.lastDispatch
  if (dispatch !== undefined) {
    const outcome = dispatch.claimed === undefined
      ? 'unchecked'
      : dispatch.claimed ? 'claimed' : 'unclaimed'
    parts.push(`wake=${dispatch.taskId}>${dispatch.memberName}`)
    parts.push(`wakes=${dispatch.repeats}`)
    parts.push(`outcome=${outcome}`)
  }
  const reclaim = team.lastReclaim
  if (reclaim !== undefined) {
    parts.push(`reclaim=${reclaim.taskId}<${reclaim.previousOwner}`)
    parts.push(reclaim.applied ? 'reclaimed' : 'reclaim-dry-run')
  }
  const park = team.lastPark
  if (park !== undefined && team.parked.has(park.taskId)) {
    parts.push(`park=${park.taskId}<${park.previousOwner}`)
    parts.push(`after=${park.reclaims}`)
  }
  return parts.join(' ')
}

/**
 * Reduce a status line to what a reader would call "the same state".
 *
 * The timestamp and the tick count change on every round by construction, so
 * comparing whole lines would never find two rounds alike. Everything else —
 * the counters, the board shape, the last wake, the breaker — is what an
 * operator actually reads, and what decides whether the round is worth writing
 * down.
 * @param line - a line produced by {@link statusLine}.
 * @returns the line with its timestamp and tick count removed.
 */
export function statusSignature(line: string): string {
  return line
    .replace(/^\S+ /, '')
    .replace(/\sticks=\d+/, '')
    // The skip counters are cumulative, so a task that nobody can take bumps
    // them on every round all by itself. Counting them as a change would make
    // the signature differ forever on exactly the board that most needs a
    // quiet log — one whose work is stuck — and quietly turn the heartbeat
    // back into a per-tick write. The totals stay in the line for whoever
    // reads it; they just do not make a round newsworthy on their own.
    .replace(/\s(?:skip|scope|noMember|declined|parked)=\d+/g, '')
}

/**
 * Append one status line, trimming the log when it grows past its ceiling.
 *
 * Never throws: observation is a convenience, and a full disk or a read-only
 * profile must not be able to stop a team from being handed its work.
 * @param path - log file to append to; created if missing.
 * @param line - the line to append, without a trailing newline.
 */
export async function appendStatusLine(path: string, line: string): Promise<void> {
  try {
    await appendFile(path, `${line}\n`, 'utf8')
  } catch {
    return
  }
  try {
    const info = await stat(path)
    if (info.size <= MAX_BYTES) return
    const lines = (await readFile(path, 'utf8')).split('\n')
    // Keep the trailing half: the newest rounds are the ones worth reading,
    // and halving avoids re-trimming on the very next append.
    const kept = lines.slice(Math.floor(lines.length / 2)).join('\n')
    // Write aside and rename: a truncating write leaves a half-written log if
    // the host dies mid-trim, and the log is often the only thing left to read
    // after a crash. Rename replaces the file atomically within one volume.
    const staged = `${path}.tmp`
    await writeFile(staged, kept, 'utf8')
    await rename(staged, path)
  } catch {
    // A failed trim only means the file keeps growing until the next attempt.
  }
}
