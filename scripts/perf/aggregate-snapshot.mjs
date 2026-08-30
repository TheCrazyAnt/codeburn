#!/usr/bin/env node
// A3 harness for the aggregate snapshot store.
//
// Measures the two numbers the acceptance criteria are about, in-process,
// against a REAL snapshot written by a real query command:
//   * load + query: readFile + JSON.parse + key match + hand back the payload
//   * event-loop stall: max delay observed by monitorEventLoopDelay while that
//     runs, i.e. how long a UI thread doing this would be blocked
// and reports the on-disk size of every snapshot file in the cache dir.
//
// Prerequisite: run the query commands you want measured at least once against
// the same CODEBURN_CACHE_DIR so their snapshots exist.
//
//   CODEBURN_CACHE_DIR=... node scripts/perf/aggregate-snapshot.mjs [--runs 20]
//
// `--synthetic-mb <n>` additionally measures a synthetic snapshot of that size,
// which is how the "<5MB / <50ms / <16ms" envelope is checked at the cap rather
// than only at whatever size this machine's corpus happens to produce.
import { readdir, readFile, stat, writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? fallback : args[i + 1]
}
const runs = Number(flag('runs', '20'))
const syntheticMb = flag('synthetic-mb', null)
const dir = process.env['CODEBURN_CACHE_DIR']
if (!dir) {
  console.error('set CODEBURN_CACHE_DIR to the cache dir holding the snapshots')
  process.exit(1)
}

/** One load: exactly what a query command pays before it can render. */
async function loadOnce(path) {
  const raw = await readFile(path, 'utf-8')
  const record = JSON.parse(raw)
  // Touch the payload the way a caller does, so a lazy parser cannot skip it.
  return Array.isArray(record.payload) ? record.payload.length : Object.keys(record.payload ?? {}).length
}

async function measure(path, label) {
  const h = monitorEventLoopDelay({ resolution: 1 })
  const times = []
  // One untimed pass so the page cache, not first-touch I/O, is what we compare.
  await loadOnce(path)
  h.enable()
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now()
    await loadOnce(path)
    times.push(performance.now() - t0)
    // Yield so the histogram has a tick boundary to attribute the block to.
    await new Promise(r => setImmediate(r))
  }
  h.disable()
  const sorted = [...times].sort((a, b) => a - b)
  return {
    snapshot: label,
    bytes: (await stat(path)).size,
    loadMedianMs: +sorted[Math.floor(sorted.length / 2)].toFixed(2),
    loadMaxMs: +sorted[sorted.length - 1].toFixed(2),
    eventLoopMaxMs: +(h.max / 1e6).toFixed(2),
    eventLoopP99Ms: +(h.percentile(99) / 1e6).toFixed(2),
  }
}

const results = []
for (const name of (await readdir(dir)).sort()) {
  if (!name.startsWith('status-snapshot.') || !name.endsWith('.json')) continue
  results.push(await measure(join(dir, name), name))
}

if (syntheticMb) {
  // A payload of the target size in the shape the store actually holds (an
  // array of report rows), not one giant string: JSON.parse cost tracks object
  // count, so a string of the same size would flatter the result.
  const row = { provider: 'claude', model: 'claude-sonnet-4-5-20250929', costUSD: 1.2345, calls: 42, inputTokens: 123456, outputTokens: 7890, cacheReadTokens: 1, cacheWriteTokens: 2, savingsUSD: 0, savingsBaselineModel: '' }
  const per = JSON.stringify(row).length + 1
  const payload = Array.from({ length: Math.ceil((Number(syntheticMb) * 1024 * 1024) / per) }, () => row)
  const path = join(dir, 'status-snapshot.synthetic-perf.json')
  await writeFile(path, JSON.stringify({ version: 4, semanticKey: 'x', corpusFingerprint: 'x', newestMtimeMs: 0, observedAtMs: 0, completedAt: Date.now(), queryKey: 'x', payload }))
  results.push(await measure(path, `synthetic ${syntheticMb}MB`))
  await unlink(path)
}

console.log(JSON.stringify({ runs, results }, null, 2))
