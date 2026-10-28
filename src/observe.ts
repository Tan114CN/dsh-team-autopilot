/**
 * Zero-token observation: the autopilot writes its own status line.
 *
 * Reading `team_autopilot_status` costs a whole model turn, and the report it
 * returns then stays in the conversation for the rest of the session. Polling a
 * loop whose entire purpose is to run unattended is the wrong shape, and an
 * operator watching a headless team had no cheap way in.
 *
 * A file the host appends to by itself is that way in: one line per tick,
 * readable with `tail`, costing nothing — no model turn, no context, no tokens.
 *
 * It is also the *only* way in. The state lives in the host process's memory,
 * so no outside process can read it and no external tooling can observe a
 * running autopilot except through what the autopilot writes down.
 */

import { appendFile, readFile, stat, writeFile } from 'node:fs/promises'
import type { TeamState } from './state.ts'

/**
 * Bytes after which the log is trimmed back to its trailing half.
 *
 * One line is roughly 250 bytes, so this holds a few thousand state changes —
 * far more than anyone reads — while keeping the file small enough that
 * `tail -30` stays instant.
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
    `unclaimed=${team.unclaimed}`,
    `reclaimed=${team.reclaimed}`,
    `tasks=${team.tasks}`,
    `inFlight=${team.inFlight}`,
    `claimable=${team.claimable}`,
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
  return parts.join(' ')
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
    await writeFile(path, kept, 'utf8')
  } catch {
    // A failed trim only means the file keeps growing until the next attempt.
  }
}
