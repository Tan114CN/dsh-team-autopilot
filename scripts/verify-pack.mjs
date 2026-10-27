#!/usr/bin/env node
/**
 * Verify the npm tarball contents before publishing.
 *
 * Runs `npm pack --dry-run --json --ignore-scripts` and asserts the shipped
 * file set: required files present, dev-only paths excluded, entry targets
 * real, and README's relative links not dangling inside the package.
 *
 * `--ignore-scripts` avoids re-triggering `prepack` (the build is expected to
 * have run already via `npm run verify:pack`).
 *
 * Run: node scripts/verify-pack.mjs   (or npm run verify:pack)
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, normalize, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const results = []
const check = (label, ok, detail = '') => results.push({ label, ok: Boolean(ok), detail })

/** Run `npm pack --dry-run --json` in a way that works with or without `npm` on PATH. */
function packJson() {
  const args = ['pack', '--dry-run', '--json', '--ignore-scripts']
  const npmExec = process.env.npm_execpath
  if (npmExec !== undefined && npmExec !== '') {
    // Invoked from an `npm run` script: reuse the exact npm CLI.
    return execFileSync(process.execPath, [npmExec, ...args], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  }
  try {
    return execFileSync('npm', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: true })
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return execFileSync('npm.cmd', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: true })
    }
    throw error
  }
}

let report
try {
  const parsed = JSON.parse(packJson())
  report = Array.isArray(parsed) ? parsed[0] : parsed
} catch (error) {
  console.error(`FAIL  npm pack --dry-run failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

const shipped = new Set((report.files ?? []).map(file => file.path))
const shippedList = [...shipped].sort()

// 1. Required files.
const required = [
  'package.json',
  'README.md',
  'LICENSE',
  'cordis.patch.yml',
  'dist/index.mjs',
  'dist/index.d.mts',
  'docs/verify-host.md',
]
for (const file of required) {
  check(`shipped: ${file}`, shipped.has(file))
}

// 2. Forbidden (dev-only) paths.
const forbiddenPrefixes = ['src/', 'tests/', 'scripts/', 'node_modules/', '.workbuddy/']
const forbiddenExact = ['.npmrc', 'pnpm-lock.yaml']
for (const entry of shippedList) {
  const prefixHit = forbiddenPrefixes.find(prefix => entry.startsWith(prefix))
  check(`excluded: ${entry}`, prefixHit === undefined && !forbiddenExact.includes(entry), prefixHit ?? (forbiddenExact.includes(entry) ? 'exact' : ''))
}

// 3. Entry targets exist locally and are shipped.
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const entryTargets = new Set([
  pkg.main,
  pkg.types,
  pkg.exports?.['.']?.default,
  pkg.exports?.['.']?.types,
  pkg.dsh?.bundle?.patch,
].filter(value => typeof value === 'string').map(value => normalize(value).replace(/\\/g, '/').replace(/^\.\//, '')))
for (const target of entryTargets) {
  check(`entry exists locally: ${target}`, existsSync(join(root, target)))
  check(`entry is shipped: ${target}`, shipped.has(target))
}

// 4. dist bundle is real, not an empty shell.
const distPath = join(root, 'dist/index.mjs')
if (existsSync(distPath)) {
  const dist = readFileSync(distPath, 'utf8')
  const size = statSync(distPath).size
  check('dist/index.mjs > 1000 bytes', size > 1000, `${size} B`)
  check('dist/index.mjs imports dsh-tools', dist.includes('@deepseek-ai/dsh-tools'))
} else {
  check('dist/index.mjs > 1000 bytes', false, 'missing')
  check('dist/index.mjs imports dsh-tools', false, 'missing')
}

// 5. LICENSE is a real MIT text.
if (existsSync(join(root, 'LICENSE'))) {
  check('LICENSE contains "MIT License"', readFileSync(join(root, 'LICENSE'), 'utf8').includes('MIT License'))
} else {
  check('LICENSE contains "MIT License"', false, 'missing')
}

// 6. README relative links must resolve inside the tarball.
const readme = existsSync(join(root, 'README.md')) ? readFileSync(join(root, 'README.md'), 'utf8') : ''
const dangling = []
for (const match of readme.matchAll(/\]\(([^)]+)\)/g)) {
  const raw = match[1].trim()
  if (raw === '' || raw.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(raw)) continue
  const target = raw.split('#')[0].replace(/^\.\//, '')
  if (target === '') continue
  if (!shipped.has(target)) dangling.push(raw)
}
check('README relative links resolve in tarball', dangling.length === 0, dangling.join(', '))

// Report.
const pad = label => String(label).padEnd(Math.max(...results.map(r => r.label.length)) + 2)
let failed = 0
for (const r of results) {
  if (!r.ok) failed += 1
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${pad(r.label)}${r.detail ? `  (${r.detail})` : ''}`)
}
console.log('')
console.log(failed === 0
  ? `OK — ${required.length} required files present, 0 forbidden, ${dangling.length} dangling links (tarball ${(report.size / 1024).toFixed(1)} KB, ${shipped.size} files)`
  : `FAILED — ${failed}/${results.length} pack checks failed`)
process.exit(failed === 0 ? 0 : 1)
