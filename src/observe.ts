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
    // the rest of the settings because a `parks=` in the log is unreadable
    // without the limit that produced it.
    `retryLimit=${config.reclaimRetryLimit}`,
    `reclaimOnFailed=${config.reclaimOnFailed}`,
    `heartbeatMs=${config.statusHeartbeatMs}`,
    `dryRun=${config.dryRun}`,
    // The concurrency ceiling and the breaker trip threshold round out "which
    // settings": without them a `slots=` or a `breaker=open` in the log is a
    // number with no origin, and a restart is exactly when those change.
    `maxConcurrent=${config.maxConcurrent}`,
    `errorThreshold=${config.errorThreshold}`,
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
 * @param lastError - the loop's most recent error, if any. Surfaced so a
 *   failing round is not indistinguishable from an idle one: "nothing was
 *   dispatched" and "every attempt threw" produce the same board numbers, and
 *   only the error tells them apart.
 * @returns the line, without a trailing newline.
 */
export function statusLine(team: TeamState, at: number, lastError?: string): string {
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
    // Named `parkedSkips` (not `parked`) to keep it distinct from the two
    // other meanings of "parked" in the wider report: the `park=` event line
    // and the totals `parked=` (currently-parked task count).
    `parkedSkips=${team.skippedParked}`,
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
    // `sent` distinguishes a real wake from a dry-run decision. Under dryRun
    // `dispatched` still climbs and `sent` stays 0, and without this field the
    // two rounds are byte-for-byte identical — a reader cannot tell "message
    // left the process" from "the decision was logged only".
    parts.push(`sent=${dispatch.sent ? 1 : 0}`)
    parts.push(`outcome=${outcome}`)
  }
  // Reclaims and parks are this round's *events*, not a single "last one".
  // The arrays say everything that happened this round: a round that reclaimed
  // three owners or parked two tasks logs all of them, in order, instead of
  // silently dropping all but the last. The `applied`/dry-run split still
  // comes from `lastReclaim` — it is the one piece the array cannot carry.
  if (team.reclaimsThisRound.length > 0) {
    parts.push(`reclaims=${team.reclaimsThisRound.join(',')}`)
    const last = team.lastReclaim
    if (last !== undefined) parts.push(last.applied ? 'reclaimed' : 'reclaim-dry-run')
  }
  if (team.parksThisRound.length > 0) {
    parts.push(`parks=${team.parksThisRound.join(',')}`)
    const last = team.lastPark
    if (last !== undefined) parts.push(`after=${last.reclaims}`)
  }
  if (team.unparksThisRound.length > 0) {
    parts.push(`unparks=${team.unparksThisRound.join(',')}`)
  }
  // The error goes last and only when present: its presence *is* the signal,
  // and a constant `err=-` would both bloat every line and read as "all good"
  // when it means nothing. Collapse whitespace and cap at 120 chars so one
  // host error cannot smear across the line or grow the log without bound.
  if (lastError !== undefined && lastError !== '') {
    parts.push(`err=${lastError.replace(/\s+/g, ' ').slice(0, 120)}`)
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
    .replace(/\s(?:skip|scope|noMember|declined|parkedSkips|suppressed|held)=\d+/g, '')
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
  await appendStatusLineWith(path, line, fsOps)
}

/**
 * File operations behind {@link appendStatusLine}, split out so the trim
 * back-off can be tested against a host whose `rename` fails without touching
 * the real filesystem.
 */
interface StatusFs {
  append(path: string, data: string): Promise<void>
  stat(path: string): Promise<{ size: number }>
  read(path: string): Promise<string>
  write(path: string, data: string): Promise<void>
  rename(from: string, to: string): Promise<void>
}

/** The real filesystem, used in production. */
const fsOps: StatusFs = {
  append: (path, data) => appendFile(path, data, 'utf8'),
  stat: async path => ({ size: (await stat(path)).size }),
  read: path => readFile(path, 'utf8'),
  write: (path, data) => writeFile(path, data, 'utf8'),
  rename: (from, to) => rename(from, to),
}

/**
 * Append one status line and trim the log when it grows past its ceiling.
 *
 * Split from {@link appendStatusLine} so tests can inject a failing host; the
 * public entry point binds the real filesystem.
 */
export async function appendStatusLineWith(
  path: string,
  line: string,
  fs: StatusFs,
): Promise<void> {
  try {
    await fs.append(path, `${line}\n`)
  } catch {
    return
  }
  // A trim that keeps failing must stop being retried every round. On Windows
  // a `rename` over a file another process holds open (a `tail` that only
  // shares read) fails, and retrying it every append turns the log into an
  // unbounded, quadratically re-read file: each round stats, reads the whole
  // over-limit file, writes a staged half, fails the rename, and swallows the
  // error. Backing off after a few consecutive failures keeps the append cheap
  // while the file is held, and a `trim=failed` line makes the condition
  // visible instead of silent.
  if (trimFailures >= TRIM_FAILURE_LIMIT) return
  try {
    const info = await fs.stat(path)
    if (info.size <= MAX_BYTES) {
      trimFailures = 0
      return
    }
    const lines = (await fs.read(path)).split('\n')
    // Keep the trailing half: the newest rounds are the ones worth reading,
    // and halving avoids re-trimming on the very next append.
    const tail = lines.slice(Math.floor(lines.length / 2))
    // The boot marker is the one line that must survive every trim: it names
    // the build and settings, and ops tooling (`docs/verify-host.md`) greps it
    // to tell "restarted" from "stale" and "old build" from "current". Halving
    // alone drops it forever the first time the log passes its ceiling, which
    // then reads as "never booted / old version". Prepend the most recent
    // startup line so it stays discoverable without pinning it to the front.
    const boot = [...lines].reverse().find(line => line.startsWith('autopilot-start '))
    const kept = (boot === undefined ? [] : [`${boot} (trimmed)`])
      .concat(tail)
      .join('\n')
    // Write aside and rename: a truncating write leaves a half-written log if
    // the host dies mid-trim, and the log is often the only thing left to read
    // after a crash. Rename replaces the file atomically within one volume.
    const staged = `${path}.tmp`
    await fs.write(staged, kept)
    await fs.rename(staged, path)
    trimFailures = 0
  } catch {
    trimFailures += 1
    if (trimFailures === TRIM_FAILURE_LIMIT) {
      try {
        await fs.append(path, 'trim=failed\n')
      } catch {
        // The log is already unwritable in this state; nothing more to do.
      }
    }
  }
}

/**
 * Consecutive trim failures before the autopilot stops retrying the trim.
 *
 * A trim is attempted after every append once the file exceeds its ceiling,
 * so a permanently failing trim would otherwise be retried on every round
 * forever. This counter backs off after a handful of consecutive failures and
 * is reset the moment a trim (or a sub-ceiling stat) succeeds.
 */
let trimFailures = 0

/**
 * How many consecutive trim failures back the autopilot off the trim path.
 *
 * Small on purpose: the point is to stop the quadratic re-read, not to wait
 * out a transient hold for long.
 */
const TRIM_FAILURE_LIMIT = 3

/**
 * Reset the trim back-off counter.
 *
 * Exported for tests only: the counter is process-global (the autopilot runs
 * once per host), so a test that drives the failure path must be able to start
 * from a clean slate without leaking into the next test.
 */
export function resetTrimFailures(): void {
  trimFailures = 0
}
