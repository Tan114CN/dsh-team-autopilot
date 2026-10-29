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
export function version(): string {
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
    // Whether waits are settled by an observed turn boundary or by the clocks
    // alone. A restart is when this flips, and it changes what every `unclaim=`
    // and every reclaim in the log means: the same number arrived by proof or
    // by a timeout, and those are not the same claim.
    ...(config.livenessEnabled
      ? [
        'liveness=on',
        `livenessMs=${config.livenessGraceMs}`,
        `livenessSettleMs=${config.livenessSettleGraceMs}`,
      ]
      : ['liveness=off']),
    // Long-turn watch, with the same reasoning as the liveness group: a restart
    // is when this flips, and it changes what every `stalled=` in the log means
    // — a count of owners that outlived this window, published about to be
    // cancelled or only reported.
    `stalledMs=${config.stalledRunningMs}`,
    `interrupt=${config.interruptStalled ? 'on' : 'off'}`,
    // The spend cap, printed even when it is off: "this build had no budget"
    // and "this build had a budget of zero" would otherwise look the same in a
    // log where every `budget=` line reads `off`.
    `wakeBudget=${config.wakeBudgetPerHour === 0 ? 'off' : config.wakeBudgetPerHour}`,
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
 * Match the boot marker anywhere it can appear in a line.
 *
 * The startup line is `<iso> autopilot-start …`, so the marker never sits at
 * the start of the line. Matching it with `startsWith('autopilot-start ')`
 * looked right and silently never matched: the first trim then dropped the
 * only line that names the build, and the log started claiming the plugin had
 * never booted — or was running whichever older build the reader assumed.
 */
const BOOT_LINE = /^\S+ autopilot-start /

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
    // Cumulative like its siblings. Non-zero means the hourly wake budget is
    // the reason tasks are waiting — the one cause that is a deliberate
    // operator choice rather than a board problem, which is why it gets its
    // own counter instead of hiding inside `skip`.
    `budgetSkips=${team.skippedBudget}`,
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
    // Wakes started inside the rolling hour against the cap (`off` when no
    // budget is configured). Placed right after `slots` because it explains
    // the number a reader would otherwise trust on its own: with the budget
    // spent, `slots=2` still means nothing will be sent this round.
    `budget=${team.wakesThisHour}/${team.wakeBudget === 0 ? 'off' : team.wakeBudget}`,
    // The gauge: how many in-flight tasks are held by an owner that has been
    // busy past the stall window. Sits beside `slots` because that is the pair
    // a reader needs — `slots=0` alone is normal under load, and only
    // `slots=0 stalled=2` says the team is wedged rather than busy.
    `stalled=${team.stalled}`,
    // Cumulative, like `reclaimed`: how often a stalled turn was cancelled.
    // Only climbs with `interruptStalled`, which is off by default, so a
    // non-zero value here also says the operator turned it on.
    `interrupts=${team.stallInterrupts}`,
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
  // This round's stalls, same shape as `reclaims`/`parks`. Reported as events
  // rather than only through the `stalled` gauge because a round that sees two
  // wedged turns should log both, and because the pair `task<owner` is what
  // lets a reader go look at that member instead of guessing which one.
  if (team.stallsThisRound.length > 0) {
    parts.push(`stalls=${team.stallsThisRound.join(',')}`)
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
    .replace(/\s(?:skip|scope|noMember|declined|parkedSkips|budgetSkips|suppressed|held)=\d+/g, '')
}

/**
 * Append one status line, trimming the log when it grows past its ceiling.
 *
 * Never throws: observation is a convenience, and a full disk or a read-only
 * profile must not be able to stop a team from being handed its work.
 * @param path - log file to append to; created if missing.
 * @param line - the line to append, without a trailing newline.
 */
export async function appendStatusLine(path: string, line: string): Promise<boolean> {
  return appendStatusLineWith(path, line, fsOps)
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
 *
 * @param path - log file to append to; created if missing.
 * @param line - the line to append, without a trailing newline.
 * @param fs - file operations (real filesystem in production).
 * @param clock - injectable time source, so the trim back-off is testable.
 * @returns whether the line reached the file. Never throws: observation must
 *   not be able to stall a dispatch round. The caller is told the outcome so a
 *   broken `statusFile` cannot fail in silence — that is the one channel a
 *   headless user reads, and a wrong path or a missing directory would
 *   otherwise look exactly like "nothing happened all day".
 */
export async function appendStatusLineWith(
  path: string,
  line: string,
  fs: StatusFs,
  clock: () => number = Date.now,
): Promise<boolean> {
  try {
    await fs.append(path, `${line}\n`)
  } catch {
    return false
  }
  // A trim that keeps failing must stop being retried every round. On Windows
  // a `rename` over a file another process holds open (a `tail` that only
  // shares read) fails, and retrying it every append turns the log into an
  // unbounded, quadratically re-read file: each round stats, reads the whole
  // over-limit file, writes a staged half, fails the rename, and swallows the
  // error. Spacing the attempts out keeps the append cheap while the file is
  // held. It has to be a delay, not a one-way switch: the hold is transient,
  // and a switch that never flips back gives up the ceiling for the whole run.
  const now = clock()
  if (trimFailures >= TRIM_FAILURE_LIMIT && now < trimBlockedUntil) return true
  try {
    const info = await fs.stat(path)
    if (info.size <= MAX_BYTES) {
      trimFailures = 0
      trimBlockedUntil = 0
      return true
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
    const boot = [...lines]
      .reverse()
      .find(entry => BOOT_LINE.test(entry))
      // A marker left by an earlier trim must not collect a second suffix.
      ?.replace(/ \(trimmed\)$/, '')
    // When a restart happened recently the kept tail already holds the marker;
    // prepending another copy would put two `autopilot-start` lines in the file
    // and make "which build is running" ambiguous — which is the one question
    // this line exists to answer.
    const tailHasBoot = tail.some(entry => BOOT_LINE.test(entry))
    const kept = (boot === undefined || tailHasBoot ? [] : [`${boot} (trimmed)`])
      .concat(tail)
      .join('\n')
    // Write aside and rename: a truncating write leaves a half-written log if
    // the host dies mid-trim, and the log is often the only thing left to read
    // after a crash. Rename replaces the file atomically within one volume.
    const staged = `${path}.tmp`
    await fs.write(staged, kept)
    await fs.rename(staged, path)
    trimFailures = 0
    trimBlockedUntil = 0
  } catch {
    trimFailures += 1
    trimBlockedUntil = now + trimBackoffMs(trimFailures)
    if (trimFailures === TRIM_FAILURE_LIMIT) {
      try {
        await fs.append(path, 'trim=failed\n')
      } catch {
        // The log is already unwritable in this state; nothing more to do.
      }
    }
  }
  // The line itself made it; only the trim failed, and that has its own
  // back-off and its own marker. Reporting it as a write failure would blame
  // the wrong thing on every round the file happens to be held open.
  return true
}

/**
 * Consecutive trim failures, used to space out retries and to decide when the
 * `trim=failed` marker has been written.
 */
let trimFailures = 0

/**
 * Epoch ms before which the trim path is skipped.
 *
 * A trim is attempted after every append once the file is over its ceiling, so
 * a failing trim would otherwise be re-attempted (stat + whole-file read +
 * staged write) on every round forever. Backing off by time instead of latching
 * is the point: a `tail` holding the file open is transient, and a latch would
 * stop this process from ever trimming again — losing the ceiling for the rest
 * of the run, which is exactly the unbounded growth the trim exists to prevent.
 */
let trimBlockedUntil = 0

/**
 * Failures before the trim path starts backing off, and the delay it backs off
 * by. The delay doubles per consecutive failure up to a ceiling: a long hold
 * costs one attempt every 30s instead of a re-read on every round.
 */
const TRIM_FAILURE_LIMIT = 3
const TRIM_BACKOFF_MS = 1_000
const TRIM_BACKOFF_MAX_MS = 30_000

/** Delay to wait after the given number of consecutive trim failures. */
function trimBackoffMs(failures: number): number {
  return Math.min(TRIM_BACKOFF_MS * 2 ** Math.max(0, failures - 1), TRIM_BACKOFF_MAX_MS)
}

/**
 * Reset the trim back-off state.
 *
 * Exported for tests only: the state is process-global (the autopilot runs
 * once per host), so a test that drives the failure path must be able to start
 * from a clean slate without leaking into the next test.
 */
export function resetTrimFailures(): void {
  trimFailures = 0
  trimBlockedUntil = 0
}
