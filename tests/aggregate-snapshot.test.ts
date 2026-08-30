// The aggregate-snapshot door (`src/aggregate-snapshot.ts`) is what lets a
// query command serve its rollups off the shared snapshot store instead of
// re-parsing the corpus in every fresh CLI process. Its whole contract is
// "never silently wrong, never fatal", so these cases are about the failure
// paths rather than the happy one: a corrupt file, a snapshot written by
// another binary, a query whose scope moved, a writer killed mid-write. Every
// one of them must degrade to exactly the pre-snapshot behaviour — recompute —
// and a served value must always be able to say how old it is.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { mkdir, readdir, readFile, rm, writeFile } from 'fs/promises'
import { createHash } from 'crypto'
import { tmpdir } from 'os'
import { join } from 'path'

import { cacheAgeLabel, serveFromAggregateSnapshot } from '../src/aggregate-snapshot.js'
import { saveStatusSnapshot } from '../src/session-cache.js'

let TMP: string
let HOME_DIR: string
const SEMANTIC = 'test-agg-v1'
const savedEnv: Record<string, string | undefined> = {}

beforeEach(async () => {
  TMP = join(tmpdir(), `codeburn-agg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  HOME_DIR = join(TMP, 'home')
  await mkdir(join(TMP, 'cache'), { recursive: true })
  await mkdir(HOME_DIR, { recursive: true })
  for (const k of ['CODEBURN_CACHE_DIR', 'HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR']) savedEnv[k] = process.env[k]
  process.env['CODEBURN_CACHE_DIR'] = join(TMP, 'cache')
  // An empty home means discovery finds no sources, so the corpus fingerprint
  // is stable and cheap — these cases are about the store, not about parsing.
  process.env['HOME'] = HOME_DIR
  process.env['USERPROFILE'] = HOME_DIR
  process.env['CLAUDE_CONFIG_DIR'] = join(HOME_DIR, '.claude')
})

afterEach(async () => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  if (existsSync(TMP)) await rm(TMP, { recursive: true, force: true })
})

type Row = { model: string; costUSD: number }
const ROWS: Row[] = [{ model: 'sonnet', costUSD: 1.5 }, { model: 'haiku', costUSD: 0.25 }]

function serve(overrides: Partial<Parameters<typeof serveFromAggregateSnapshot<Row[]>>[0]> = {}, counter?: { n: number }) {
  return serveFromAggregateSnapshot<Row[]>({
    command: 'models',
    scope: { period: 'lifetime', provider: 'all' },
    semanticKey: SEMANTIC,
    compute: async () => { if (counter) counter.n++; return ROWS },
    ...overrides,
  })
}

async function snapshotFiles(): Promise<string[]> {
  return (await readdir(join(TMP, 'cache'))).filter(f => /^status-snapshot\.[0-9a-f]+\.json$/.test(f))
}

async function onlySnapshotPath(): Promise<string> {
  const files = await snapshotFiles()
  expect(files).toHaveLength(1)
  return join(TMP, 'cache', files[0]!)
}

describe('serving a query from the aggregate snapshot', () => {
  it('computes once, then serves the identical value off disk with a completedAt', async () => {
    const calls = { n: 0 }

    const first = await serve({}, calls)
    expect(first.servedFromSnapshot).toBe(false)
    expect(first.completedAt).toBeNull()
    expect(first.value).toEqual(ROWS)

    const second = await serve({}, calls)
    expect(second.servedFromSnapshot).toBe(true)
    expect(typeof second.completedAt).toBe('number')
    expect(second.value).toEqual(ROWS)
    expect(calls.n).toBe(1)
  })

  it('--refresh ignores a valid snapshot and republishes', async () => {
    const calls = { n: 0 }
    await serve({}, calls)
    await serve({}, calls)
    expect(calls.n).toBe(1)

    const refreshed = await serve({ refresh: true }, calls)
    expect(refreshed.servedFromSnapshot).toBe(false)
    expect(calls.n).toBe(2)

    // The refresh published a new record, so the next ordinary call still hits.
    const after = await serve({}, calls)
    expect(after.servedFromSnapshot).toBe(true)
    expect(calls.n).toBe(2)
  })

  it('a truncated snapshot is a miss, not a crash', async () => {
    const calls = { n: 0 }
    await serve({}, calls)
    const path = await onlySnapshotPath()

    // Exactly what a torn write or a full disk would leave behind.
    const raw = await readFile(path, 'utf-8')
    await writeFile(path, raw.slice(0, Math.floor(raw.length / 2)))

    const after = await serve({}, calls)
    expect(after.servedFromSnapshot).toBe(false)
    expect(after.value).toEqual(ROWS)
    expect(calls.n).toBe(2)
    // And it healed: the miss republished a whole record.
    expect(JSON.parse(await readFile(path, 'utf-8'))).toMatchObject({ payload: ROWS })
  })

  it('a snapshot whose envelope version is not ours is skipped', async () => {
    const calls = { n: 0 }
    await serve({}, calls)
    const path = await onlySnapshotPath()

    const record = JSON.parse(await readFile(path, 'utf-8')) as Record<string, unknown>
    await writeFile(path, JSON.stringify({ ...record, version: 3, payload: [{ model: 'from-an-older-build', costUSD: 999 }] }))

    const after = await serve({}, calls)
    expect(after.servedFromSnapshot).toBe(false)
    expect(after.value).toEqual(ROWS)
  })

  it('a snapshot written under different render semantics is skipped', async () => {
    await serve()
    const other = await serve({ semanticKey: 'test-agg-v2' })
    expect(other.servedFromSnapshot).toBe(false)
  })

  it('a snapshot from a different query scope never answers this one', async () => {
    await serve()
    expect((await serve({ scope: { period: 'month', provider: 'all' } })).servedFromSnapshot).toBe(false)
    expect((await serve({ command: 'sessions' })).servedFromSnapshot).toBe(false)
    // …while the original query still hits.
    expect((await serve()).servedFromSnapshot).toBe(true)
  })

  it('a value the caller vetoes is never published', async () => {
    const calls = { n: 0 }
    await serve({ cacheable: () => false }, calls)
    expect(await snapshotFiles()).toEqual([])

    const after = await serve({ cacheable: () => false }, calls)
    expect(after.servedFromSnapshot).toBe(false)
    expect(calls.n).toBe(2)
  })

  it('a corpus that moved is a miss immediately, with no settle grace period', async () => {
    const calls = { n: 0 }
    await serve({}, calls)
    expect((await serve({}, calls)).servedFromSnapshot).toBe(true)

    // A newly configured provider root — the case the resident-serve
    // regression test pins end to end. The menubar's debounce would keep
    // serving the old answer for a couple of seconds; a one-shot command the
    // user ran deliberately must not.
    const projectDir = join(HOME_DIR, '.claude', 'projects', '-tmp-p')
    await mkdir(projectDir, { recursive: true })
    await writeFile(join(projectDir, 's.jsonl'), JSON.stringify({
      type: 'user', uuid: 'u1', sessionId: 's', cwd: '/tmp/p',
      timestamp: '2026-08-12T10:00:01.000Z', message: { role: 'user', content: 'hi' },
    }) + '\n')

    const after = await serve({}, calls)
    expect(after.servedFromSnapshot).toBe(false)
    expect(calls.n).toBe(2)
  })

  it('an unwritable cache dir degrades to plain recompute', async () => {
    process.env['CODEBURN_CACHE_DIR'] = join(TMP, 'nope', 'still-nope', 'file-not-a-dir')
    await writeFile(join(TMP, 'nope-file'), 'x').catch(() => {})
    const calls = { n: 0 }
    const first = await serve({}, calls)
    const second = await serve({}, calls)
    expect(first.value).toEqual(ROWS)
    expect(second.value).toEqual(ROWS)
  })
})

describe('staleness labelling', () => {
  it('says nothing for a value that was just computed', () => {
    expect(cacheAgeLabel({ completedAt: null, servedFromSnapshot: false })).toBeUndefined()
    // A completedAt without a snapshot serve is still a fresh compute.
    expect(cacheAgeLabel({ completedAt: Date.now(), servedFromSnapshot: false })).toBeUndefined()
  })

  it('states the wall-clock time and the age of anything served off disk', () => {
    const at = new Date(2026, 7, 30, 23, 45, 0).getTime()
    const label = cacheAgeLabel({ completedAt: at, servedFromSnapshot: true }, at + 125_000)!
    expect(label).toContain('cached as of 23:45')
    expect(label).toContain('(2m ago)')
    expect(label).toContain('--refresh')
  })

  it('scales the age unit with the age', () => {
    const at = new Date(2026, 7, 30, 9, 5, 0).getTime()
    const age = (ms: number) => cacheAgeLabel({ completedAt: at, servedFromSnapshot: true }, at + ms)!
    expect(age(3_000)).toContain('(3s ago)')
    expect(age(90 * 60_000)).toContain('(2h ago)')
    expect(age(72 * 3_600_000)).toContain('(3d ago)')
    expect(age(9 * 60_000)).toContain('as of 09:05')
  })

  it('labels a real snapshot serve and nothing else', async () => {
    expect(cacheAgeLabel(await serve())).toBeUndefined()
    expect(cacheAgeLabel(await serve())).toMatch(/^cached as of \d\d:\d\d \(\d+s ago\)/)
  })
})

// A menubar poll, a desktop refresh and a terminal command are three separate
// processes that can be writing the same snapshot at the same moment, and any
// of them can be killed (laptop sleep, ^C, an OOM) at an arbitrary instant. The
// publication is tmp-write + fsync + rename under the shared cross-process
// refresh lock, so a reader must only ever observe a whole record — the one
// that was there before, or the one that fully landed.
describe('atomicity under a killed writer', () => {
  it('never leaves a torn record behind, whenever the writer dies', async () => {
    const queryKey = 'kill-me'
    const path = join(TMP, 'cache', `status-snapshot.${createHash('sha256').update(queryKey).digest('hex').slice(0, 16)}.json`)
    // Baseline: a complete record every read is allowed to return.
    await saveStatusSnapshot('corpus-0', 1, 1, queryKey, SEMANTIC, { generation: 0 })

    // .mts, not .ts: the file lives outside any package.json, where a bare .ts
    // is transformed as CJS and its top-level await fails to compile.
    const child = join(TMP, 'writer.mts')
    // ~8MB of payload, so the write occupies a window a kill can actually land
    // inside rather than completing between two ticks. The child announces
    // itself once everything is loaded and the payload is built, so the kill
    // delay below is measured from the start of the WRITE, not from spawn —
    // otherwise every kill lands during tsx startup and proves nothing.
    await writeFile(child, [
      `import { saveStatusSnapshot } from ${JSON.stringify(join(process.cwd(), 'src', 'session-cache.ts'))}`,
      `const generation = Number(process.argv[2])`,
      `const payload = { generation, filler: Array.from({ length: 90_000 }, (_, i) => ({ i, s: 'x'.repeat(48) })) }`,
      `process.stdout.write('GO\\n')`,
      `await saveStatusSnapshot('corpus-' + generation, generation + 1, generation + 1, ${JSON.stringify(queryKey)}, ${JSON.stringify(SEMANTIC)}, payload)`,
    ].join('\n'))

    // Round 1 runs to completion — the control that proves a full 8MB record
    // really does get published, so the kill rounds are not just re-reading a
    // baseline. Rounds 2..13 are killed at a random point in the write.
    for (let round = 1; round <= 13; round++) {
      const kill = round > 1
      const proc = spawn(process.execPath, ['--import', 'tsx', child, String(round)], {
        env: { ...process.env }, stdio: ['ignore', 'pipe', 'ignore'],
      })
      // Registered before anything is awaited: a child that finishes on its own
      // emits `exit` once, and a listener attached later would never see it.
      const exited = new Promise(resolve => proc.on('exit', resolve))
      const ready = await new Promise<boolean>(resolve => {
        const timer = setTimeout(() => resolve(false), 20_000)
        proc.stdout.on('data', () => { clearTimeout(timer); resolve(true) })
      })
      expect(ready).toBe(true)
      // Randomised so kills land across the whole write: mid-stringify,
      // mid-write, mid-fsync, mid-rename, and (deliberately) after it, since a
      // writer that finished is the control the torn cases are compared to.
      if (kill) {
        await new Promise(resolve => { setTimeout(resolve, Math.floor(Math.random() * 40)) })
        proc.kill('SIGKILL')
      }
      await exited

      // The invariant: whatever is at the published path parses, and is a whole
      // record — never half a JSON document, never a payload missing its tail.
      const raw = await readFile(path, 'utf-8')
      const record = JSON.parse(raw) as { version: number; completedAt: number; payload: { generation: number; filler?: unknown[] } }
      expect(record.payload).toBeTruthy()
      expect(typeof record.completedAt).toBe('number')
      // Lengths compared as numbers, never as arrays: a failure here would
      // otherwise ask the runner to diff 90k objects.
      const fillerLength = Array.isArray(record.payload.filler) ? record.payload.filler.length : null
      // From the control onward the published record is always one of the big
      // ones: a killed writer either published its whole 8MB payload or left
      // the previous whole record in place. A partial tail is the failure.
      expect(fillerLength).toBe(90_000)
      expect(record.payload.generation).toBeGreaterThanOrEqual(1)
      if (!kill) expect(record.payload.generation).toBe(round)
    }
  }, 120_000)
})
