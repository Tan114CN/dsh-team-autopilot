#!/usr/bin/env node
/**
 * Verify the dsh-team-autopilot mount inside a dsh desktop profile.
 *
 * This checks the *mount prerequisites* (files, entry points, lockfile, bundle
 * registration, first-run dryRun). It cannot prove the app actually loaded the
 * plugin — that requires restarting the app and observing it (see
 * docs/verify-host.md). Run it before AND after a restart; the "runtime" part
 * is what the app logs and the `team_autopilot_status` tool tell you.
 *
 * Usage:
 *   node scripts/verify-mount.mjs
 *   DSH_PROFILE="C:/Users/me/.dsh/profiles/desktop" node scripts/verify-mount.mjs
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'

const profile = resolve(
  process.env.DSH_PROFILE ?? join(homedir(), '.dsh', 'profiles', 'desktop'),
)
const pluginDir = join(profile, 'node_modules', 'dsh-team-autopilot')

const results = []
const check = (label, ok, detail = '') => results.push({ label, ok: Boolean(ok), detail, warn: false })
const warn = (label, ok, detail = '') => results.push({ label, ok: Boolean(ok), detail, warn: true })
const readText = path => { try { return readFileSync(path, 'utf8') } catch { return undefined } }

// 1. Profile presence.
check('profile directory exists', existsSync(profile), profile)

// 2. Profile registration.
const profilePkgText = readText(join(profile, 'package.json'))
let profilePkg
if (profilePkgText === undefined) {
  check('profile package.json readable', false, join(profile, 'package.json'))
} else {
  try { profilePkg = JSON.parse(profilePkgText) } catch (error) {
    check('profile package.json valid JSON', false, String(error))
  }
}
if (profilePkg !== undefined) {
  const bundles = profilePkg.dsh?.profile?.bundles ?? []
  check('bundle "dsh-team-autopilot" registered', bundles.includes('dsh-team-autopilot'))
  const dep = profilePkg.dependencies?.['dsh-team-autopilot']
  check('dependency declared', dep !== undefined, dep ?? 'missing')
}

// 3. Installed package shape.
const mountedPkgText = readText(join(pluginDir, 'package.json'))
let mountedPkg
if (mountedPkgText === undefined) {
  check('installed package present', false, pluginDir)
} else {
  try { mountedPkg = JSON.parse(mountedPkgText) } catch (error) {
    check('installed package.json valid JSON', false, String(error))
  }
}
if (mountedPkg !== undefined) {
  check('entry "main" is dist/index.mjs', mountedPkg.main === 'dist/index.mjs', mountedPkg.main)
  check('bundle patch declared', mountedPkg.dsh?.bundle?.patch === './cordis.patch.yml', mountedPkg.dsh?.bundle?.patch)
  check('dist/index.mjs built', existsSync(join(pluginDir, 'dist', 'index.mjs')))
  check('cordis.patch.yml shipped', existsSync(join(pluginDir, 'cordis.patch.yml')))
}

// 4. Lockfile records a file: install (durable across re-installs).
const lock = readText(join(profile, 'pnpm-lock.yaml'))
if (lock === undefined) {
  check('pnpm-lock.yaml readable', false)
} else {
  check('lockfile records dsh-team-autopilot', /dsh-team-autopilot:[\s\S]{0,160}?specifier:\s*(file:|[\^~]?\d)/.test(lock))
}

// 5. First-run safety: profile patch must force dryRun for team-autopilot.
const patch = readText(join(profile, 'cordis.patch.yml'))
if (patch === undefined) {
  check('profile cordis.patch.yml readable', false)
} else {
  check('profile patch targets team-autopilot', /-\s*id:\s*team-autopilot\b/.test(patch))
  const dry = /id:\s*team-autopilot[\s\S]*?dryRun:\s*(true|false)/.exec(patch)
  check('first-run dryRun === true', dry?.[1] === 'true', dry ? `dryRun: ${dry[1]}` : 'not set (plugin default false)')
}

// 6. Best-effort: scan recent plugin-manager logs for load signals.
const logsDir = join(profile, '.plugin-manager', 'logs')
if (existsSync(logsDir)) {
  let hits = 0
  const walk = (dir, depth) => {
    if (depth > 3) return
    let entries
    try { entries = readdirSync(dir) } catch { return }
    for (const entry of entries) {
      const full = join(dir, entry)
      let st
      try { st = statSync(full) } catch { continue }
      if (st.isDirectory()) { walk(full, depth + 1); continue }
      if (!/\.(log|ndjson|jsonl|json|txt)$/i.test(entry)) continue
      const text = readText(full)
      if (text !== undefined && /team-autopilot|team_autopilot_status/.test(text)) hits += 1
    }
  }
  walk(logsDir, 0)
  warn(
    'runtime load trace (best-effort, inconclusive)',
    hits > 0,
    hits > 0
      ? `${hits} file(s) mention the plugin`
      : 'no startup log on disk; confirm by calling team_autopilot_status in a dsh session',
  )
}

// Report.
const pad = width => s => String(s).padEnd(width)
const label = pad(Math.max(...results.map(r => r.label.length)) + 2)
let failed = 0
for (const r of results) {
  if (!r.ok && !r.warn) failed += 1
  const tag = r.ok ? 'PASS' : (r.warn ? 'WARN' : 'FAIL')
  console.log(`${tag}  ${label(r.label)}${r.detail ? `  (${r.detail})` : ''}`)
}
console.log('')
const hardFails = results.filter(r => !r.ok && !r.warn).length
const warns = results.filter(r => r.warn && !r.ok).length
console.log(hardFails === 0
  ? `OK — ${results.length - warns} mount checks passed${warns > 0 ? `, ${warns} warning(s)` : ''} for ${profile}`
  : `FAILED — ${hardFails}/${results.length} checks failed for ${profile}`)
process.exit(hardFails === 0 ? 0 : 1)
