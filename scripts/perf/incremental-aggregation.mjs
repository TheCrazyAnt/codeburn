#!/usr/bin/env node
// Repeatable cold-vs-incremental measurement for the delta-aware aggregation
// work. One fresh `node` process per timed run (the real shape: a CLI/desktop
// launch never carries the in-memory parse memo across runs), 5 trials, median
// reported. Each trial is: wipe cache -> cold parseAllSessions (timed) ->
// append N lines to one session file -> parseAllSessions again (timed).
//
// Usage:
//   CODEBURN_PERF_CONFIG_DIR=<a CLAUDE_CONFIG_DIR with projects/*/**.jsonl> \
//   CODEBURN_PERF_APPEND_FILE=<one writable .jsonl inside that corpus> \
//   node scripts/perf/incremental-aggregation.mjs [trials] [linesPerAppend]
//
// The append file must be writable and inside the corpus; every other file is
// only ever read. Cache dirs are created under CODEBURN_PERF_WORK (default
// os.tmpdir()) and removed between trials.
import { spawnSync } from 'node:child_process'
import { rmSync, mkdtempSync, appendFileSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const configDir = process.env['CODEBURN_PERF_CONFIG_DIR']
const appendFile = process.env['CODEBURN_PERF_APPEND_FILE']
if (!configDir || !appendFile) {
  console.error('set CODEBURN_PERF_CONFIG_DIR and CODEBURN_PERF_APPEND_FILE (see header)')
  process.exit(2)
}
const trials = Number(process.argv[2] ?? 5)
const appendLines = Number(process.argv[3] ?? 100)
const workRoot = process.env['CODEBURN_PERF_WORK'] ?? mkdtempSync(join(tmpdir(), 'codeburn-perf-'))

const median = nums => {
  const s = [...nums].sort((a, b) => a - b)
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}
const p95 = nums => {
  const s = [...nums].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)]
}
const fmt = (nums, label) =>
  console.log(`  ${label}: n=${nums.length} values=[${nums.map(x => x.toFixed(1)).join(', ')}] median=${median(nums).toFixed(1)}ms p95=${p95(nums).toFixed(1)}ms`)

// One timed parseAllSessions in a fresh process; stage breakdown scraped from
// the CODEBURN_VERBOSE trace the parser already emits.
const RUNNER = `
import { performance } from 'node:perf_hooks'
import { parseAllSessions } from ${JSON.stringify(new URL('../../src/parser.ts', import.meta.url).href)}
const range = { start: new Date('2020-01-01'), end: new Date('2030-01-01') }
const t0 = performance.now()
const projects = await parseAllSessions(range, 'claude')
const t1 = performance.now()
console.log(JSON.stringify({
  durationMs: t1 - t0,
  projects: projects.length,
  totalCalls: projects.reduce((n, p) => n + (p.totalApiCalls ?? 0), 0),
  totalCostUSD: projects.reduce((n, p) => n + (p.totalCostUSD ?? 0), 0),
}))
`
const runnerFile = join(workRoot, 'run-one.mjs')

function runOnce(cacheDir) {
  const r = spawnSync('node', ['--import', 'tsx', runnerFile], {
    cwd: new URL('../..', import.meta.url).pathname,
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: configDir,
      CODEBURN_CACHE_DIR: cacheDir,
      CODEBURN_DESKTOP_SESSIONS_DIR: join(workRoot, 'no-such-desktop-dir'),
      CODEBURN_PRICING_SNAPSHOT_ONLY: '1',
      CODEBURN_VERBOSE: '1',
    },
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  })
  const out = (r.stdout ?? '').trim().split('\n').pop()
  if (!out) throw new Error(`run produced no output:\n${r.stderr}`)
  const stages = {}
  for (const line of (r.stderr ?? '').split('\n')) {
    const m = line.match(/startup timing (\S+)=([\d.]+)ms/)
    if (m) stages[m[1]] = Number(m[2])
  }
  return { result: JSON.parse(out), stages }
}

// Append `appendLines` synthetic JSONL turns, continuing the file's own session
// so the parser sees genuine append-only growth (same shape the fixture
// generator produces).
function appendTurns(file, count) {
  const lines = readFileSync(file, 'utf-8').split('\n').filter(Boolean)
  const last = JSON.parse(lines[lines.length - 1])
  const sessionId = last.sessionId
  let parentUuid = last.uuid ?? last.leafUuid
  let tMs = last.timestamp ? Date.parse(last.timestamp) : Date.now()
  let out = ''
  for (let i = 0; i < count; i++) {
    tMs += 1000
    const uuid = `${sessionId}-perf-${statSync(file).size}-${i}`
    const isUser = i % 3 === 0
    const rec = isUser
      ? { type: 'user', uuid, parentUuid, sessionId, timestamp: new Date(tMs).toISOString(), cwd: last.cwd, message: { role: 'user', content: 'perf append' } }
      : {
        type: 'assistant', uuid, parentUuid, sessionId, timestamp: new Date(tMs).toISOString(), cwd: last.cwd,
        message: {
          id: `msg_perf_${uuid}`, role: 'assistant', model: 'claude-sonnet-4-5-20250929',
          content: [{ type: 'text', text: 'perf append' }],
          usage: { input_tokens: 12, output_tokens: 34, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      }
    parentUuid = uuid
    out += JSON.stringify(rec) + '\n'
  }
  appendFileSync(file, out)
}

writeFileSync(runnerFile, RUNNER)

const coldTotals = [], incrTotals = []
const coldStages = [], incrStages = []
for (let i = 1; i <= trials; i++) {
  const cacheDir = join(workRoot, `cache-${i}`)
  rmSync(cacheDir, { recursive: true, force: true })
  const cold = runOnce(cacheDir)
  coldTotals.push(cold.result.durationMs)
  coldStages.push(cold.stages)
  appendTurns(appendFile, appendLines)
  const incr = runOnce(cacheDir)
  incrTotals.push(incr.result.durationMs)
  incrStages.push(incr.stages)
  const delta = incr.result.totalCalls - cold.result.totalCalls
  console.log(`  trial ${i}: cold=${cold.result.durationMs.toFixed(1)}ms (calls=${cold.result.totalCalls}) incremental=${incr.result.durationMs.toFixed(1)}ms (calls=${incr.result.totalCalls}, +${delta})`)
  console.log(`    cold stages: ${JSON.stringify(cold.stages)}`)
  console.log(`    incr stages: ${JSON.stringify(incr.stages)}`)
  if (delta <= 0) console.log('    WARNING: incremental run picked up no new calls — the append was not seen')
  rmSync(cacheDir, { recursive: true, force: true })
}

console.log('')
fmt(coldTotals, 'cold (full corpus)')
fmt(incrTotals, `incremental (+${appendLines} lines to 1 file)`)
for (const stage of ['cache-load', 'discovery', 'claude', 'aggregate']) {
  const vals = incrStages.map(s => s[stage]).filter(v => v !== undefined)
  if (vals.length) fmt(vals, `  incr stage:${stage}`)
}
