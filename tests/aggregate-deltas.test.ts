import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, appendFile, readFile, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

// The whole point of delta-tracked aggregation is that an unchanged turn is not
// re-classified, so the count of turns a run HAD to classify is the assertion.
import { parseAllSessions, clearSessionCache, derivedTurnsClassified } from '../src/parser.js'
import { derivationOf, applyDerivation, withCalls, digestOfCachedFile, auditDerivedParity } from '../src/aggregate-deltas.js'
import type { CachedFile, CachedTurn } from '../src/session-cache.js'
import type { ClassifiedTurn, ProjectSummary } from '../src/types.js'
import { readCacheOnDisk, writeCacheOnDisk } from './fixtures/session-cache-io.js'

let tmpDir: string
let sessionPath: string
let warmCache: string
const CWD = '/tmp/delta-proj'

beforeEach(async () => {
  clearSessionCache()
  tmpDir = await mkdtemp(join(tmpdir(), 'agg-delta-'))
  const projectDir = join(tmpDir, 'projects', 'delta-proj')
  await mkdir(projectDir, { recursive: true })
  sessionPath = join(projectDir, 'sess-1.jsonl')
  warmCache = join(tmpDir, 'cache')
  process.env['CLAUDE_CONFIG_DIR'] = tmpDir
  process.env['CODEBURN_DESKTOP_SESSIONS_DIR'] = join(tmpDir, 'desktop-sessions')
})

afterEach(async () => {
  clearSessionCache()
  delete process.env['CODEBURN_CACHE_DIR']
  await rm(tmpDir, { recursive: true, force: true })
})

// ── fixture builders ───────────────────────────────────────────────────

function userLine(ts: string, text: string): string {
  return JSON.stringify({
    type: 'user', sessionId: 'sess-1', timestamp: ts, cwd: CWD,
    message: { role: 'user', content: text },
  })
}

function asstLine(id: string, ts: string, blocks: Array<Record<string, unknown>> = []): string {
  return JSON.stringify({
    type: 'assistant', sessionId: 'sess-1', timestamp: ts, cwd: CWD,
    message: {
      id, type: 'message', role: 'assistant', model: 'claude-sonnet-4-5',
      content: blocks, usage: { input_tokens: 100, output_tokens: 20 },
    },
  })
}

const readBlock = (file: string) => ({ type: 'tool_use', name: 'Read', input: { file_path: file } })
const editBlock = (file: string) => ({ type: 'tool_use', name: 'Edit', input: { file_path: file } })
const bashBlock = (cmd: string) => ({ type: 'tool_use', name: 'Bash', input: { command: cmd } })

// Turns that classify differently from one another, so a mixed-up or stale
// derivation shows up as a wrong category rather than a coincidence.
function baseLines(): string[] {
  return [
    userLine('2026-05-01T10:00:01.000Z', 'fix the crash in the parser'),
    asstLine('msg-a', '2026-05-01T10:00:02.000Z', [editBlock('/a.ts')]),
    userLine('2026-05-01T10:05:00.000Z', 'what does this module do'),
    asstLine('msg-b', '2026-05-01T10:05:02.000Z', [readBlock('/b.ts')]),
    userLine('2026-05-01T10:10:00.000Z', 'run the tests'),
    asstLine('msg-c', '2026-05-01T10:10:02.000Z', [bashBlock('npm test')]),
  ]
}

async function parseWith(cacheDir: string): Promise<ProjectSummary[]> {
  clearSessionCache()
  process.env['CODEBURN_CACHE_DIR'] = cacheDir
  return parseAllSessions()
}

/** The oracle: a cold parse of the file's CURRENT contents into a pristine
 *  cache, so nothing is reused and every derivation is decided from scratch. */
async function coldFullReparse(): Promise<ProjectSummary[]> {
  const freshCache = await mkdtemp(join(tmpdir(), 'agg-cold-'))
  try {
    return await parseWith(freshCache)
  } finally {
    await rm(freshCache, { recursive: true, force: true })
    process.env['CODEBURN_CACHE_DIR'] = warmCache   // leave the warm cache readable
  }
}

async function cachedFile(): Promise<CachedFile> {
  return (await readCacheOnDisk()).providers['claude']!.files[sessionPath]!
}

/** Sessions keyed by id: two sessions of equal cost have no defined order
 *  between them, and this comparison is about content, not that order. */
const bySessionId = (projects: ProjectSummary[]): Record<string, unknown> =>
  Object.fromEntries(projects.flatMap(p => p.sessions).map(s => [s.sessionId, s]))

const categories = (projects: ProjectSummary[]): string[] =>
  projects.flatMap(p => p.sessions.flatMap(s => s.turns.map(t => t.category)))

// ── delta application ──────────────────────────────────────────────────

describe('delta-tracked aggregation', () => {
  it('CORE: a warm run reuses every cached derivation and matches a cold re-parse exactly', async () => {
    await writeFile(sessionPath, baseLines().join('\n') + '\n')
    const cold = await parseWith(warmCache)
    expect(derivedTurnsClassified()).toBe(3)

    // The cold run left its derivations behind, with the digest the parity gate
    // checks them against.
    const entry = await cachedFile()
    expect(entry.turns.every(t => t.derived !== undefined)).toBe(true)
    expect(entry.derivedDigest).toBe(digestOfCachedFile(entry))

    const warm = await parseWith(warmCache)
    // Nothing changed on disk, so nothing was re-decided…
    expect(derivedTurnsClassified()).toBe(0)
    // …and the report is the same one the cold run produced.
    expect(warm).toEqual(cold)
    expect(await coldFullReparse()).toEqual(warm)
  })

  it('an appended file re-derives only the new turns, keeping the cached prefix', async () => {
    await writeFile(sessionPath, baseLines().join('\n') + '\n')
    await parseWith(warmCache)

    await appendFile(sessionPath,
      userLine('2026-05-01T11:00:00.000Z', 'add a new export to the api') + '\n' +
      asstLine('msg-d', '2026-05-01T11:00:02.000Z', [editBlock('/d.ts')]) + '\n')

    const warm = await parseWith(warmCache)
    // Exactly the appended turn, not the three that were already cached.
    expect(derivedTurnsClassified()).toBe(1)
    expect(warm[0]!.sessions[0]!.turns.at(-1)!.userMessage).toBe('add a new export to the api')
    expect(warm).toEqual(await coldFullReparse())
  })

  it('an append that merges into the cached boundary turn re-derives that turn', async () => {
    await writeFile(sessionPath, baseLines().join('\n') + '\n')
    await parseWith(warmCache)

    // No user message: a continuation of the LAST cached turn, whose calls (and
    // so whose category / hasEdits) change as a result.
    await appendFile(sessionPath, asstLine('msg-c2', '2026-05-01T10:10:30.000Z', [editBlock('/c.ts')]) + '\n')

    const warm = await parseWith(warmCache)
    expect(derivedTurnsClassified()).toBe(1)   // the boundary turn, re-decided
    expect(warm).toEqual(await coldFullReparse())
    expect(warm[0]!.sessions[0]!.turns.at(-1)!.hasEdits).toBe(true)
  })

  it('a modified file re-derives whole and leaves the other files alone', async () => {
    const otherPath = join(tmpDir, 'projects', 'delta-proj', 'sess-2.jsonl')
    await writeFile(sessionPath, baseLines().join('\n') + '\n')
    await writeFile(otherPath, [
      userLine('2026-05-02T10:00:01.000Z', 'refactor the loader').replace(/sess-1/g, 'sess-2'),
      asstLine('msg-x', '2026-05-02T10:00:02.000Z', [editBlock('/x.ts')]).replace(/sess-1/g, 'sess-2'),
    ].join('\n') + '\n')
    await parseWith(warmCache)

    // Rewrite (not append) the first file.
    await writeFile(sessionPath, [
      userLine('2026-05-01T10:00:01.000Z', 'fix the crash in the parser'),
      asstLine('msg-a', '2026-05-01T10:00:02.000Z', [editBlock('/a.ts')]),
    ].join('\n') + '\n')

    const warm = await parseWith(warmCache)
    expect(derivedTurnsClassified()).toBe(1)  // the rewritten file only; sess-2 is reused
    // By session id: two same-cost sessions have no defined order between them.
    expect(bySessionId(warm)).toEqual(bySessionId(await coldFullReparse()))
  })
})

// ── parity gate ────────────────────────────────────────────────────────

describe('cached-aggregate parity', () => {
  it('a tampered derivation is caught, logged loudly, and the file is re-parsed', async () => {
    await writeFile(sessionPath, baseLines().join('\n') + '\n')
    const cold = await parseWith(warmCache)

    // Poison one cached verdict without touching the digest written with it —
    // the shape of a half-written shard or a hand-edited cache.
    const cache = await readCacheOnDisk()
    cache.providers['claude']!.files[sessionPath]!.turns[0]!.derived = { c: 'git' }
    await writeCacheOnDisk(cache)

    const logged: string[] = []
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
      logged.push(String(chunk)); return true
    }) as typeof process.stderr.write)
    let warm: ProjectSummary[]
    try {
      warm = await parseWith(warmCache)
    } finally {
      spy.mockRestore()
    }

    expect(logged.join('')).toContain('CACHED AGGREGATE PARITY FAILURE')
    // Fail-safe, not best-effort: the report is the correct one, and the
    // corrected derivations are what the cache now holds.
    expect(categories(warm)).toEqual(categories(cold))
    expect(warm).toEqual(await coldFullReparse())
    const entry = await cachedFile()
    expect(entry.derivedDigest).toBe(digestOfCachedFile(entry))
    expect(entry.turns[0]!.derived).not.toEqual({ c: 'git' })
  })

  it('auditDerivedParity reports a classifier that no longer agrees with the cache', () => {
    const turn = { timestamp: '2026-05-01T10:00:00.000Z', sessionId: 's', userMessage: 'hello', calls: [], derived: { c: 'conversation' as const } }
    const file = { fingerprint: { dev: 1, ino: 1, mtimeMs: 1, sizeBytes: 1 }, mcpInventory: [], turns: [turn] } as CachedFile
    file.derivedDigest = digestOfCachedFile(file)!

    expect(auditDerivedParity([{ path: 'p', file }], () => ({ c: 'conversation' }), () => 0)).toBeNull()
    // The same turns, a different verdict: exactly what a changed classifier
    // over an uninvalidated cache looks like.
    const failure = auditDerivedParity([{ path: 'p', file }], () => ({ c: 'testing' }), () => 0)
    expect(failure?.path).toBe('p')
    expect(failure?.stored).not.toBe(failure?.rederived)
  })

  it('a file whose derivations are partial carries no digest to check', () => {
    const derivedTurn = { timestamp: 't', sessionId: 's', userMessage: 'a', calls: [], derived: { c: 'coding' as const } }
    const bareTurn = { timestamp: 't', sessionId: 's', userMessage: 'b', calls: [] }
    const file = { fingerprint: { dev: 1, ino: 1, mtimeMs: 1, sizeBytes: 1 }, mcpInventory: [], turns: [derivedTurn, bareTurn] } as CachedFile
    expect(digestOfCachedFile(file)).toBeNull()
  })
})

// ── appended-but-actually-modified ─────────────────────────────────────

describe('append prefix verification', () => {
  it('a file that GREW but whose parsed region changed is re-parsed whole', async () => {
    await writeFile(sessionPath, baseLines().join('\n') + '\n')
    await parseWith(warmCache)
    const before = await cachedFile()
    expect(before.prefixTailSha).toBeDefined()

    // Same inode, larger file, but the already-parsed bytes are not the ones
    // that were parsed: an in-place rewrite plus new content, which the
    // (dev, ino, mtime, size) fingerprint alone reads as a plain append.
    const rewritten = baseLines()
    rewritten[4] = userLine('2026-05-01T10:10:00.000Z', 'deploy the release build')
    await writeFile(sessionPath, rewritten.join('\n') + '\n'
      + userLine('2026-05-01T11:00:00.000Z', 'and now write the tests') + '\n'
      + asstLine('msg-e', '2026-05-01T11:00:02.000Z', [editBlock('/e.ts')]) + '\n')

    const logged: string[] = []
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
      logged.push(String(chunk)); return true
    }) as typeof process.stderr.write)
    let warm: ProjectSummary[]
    try {
      warm = await parseWith(warmCache)
    } finally {
      spy.mockRestore()
    }

    expect(logged.join('')).toContain('grew but its already-parsed region changed')
    // The rewritten turn is reported as it now reads, not as it was cached.
    expect(warm).toEqual(await coldFullReparse())
  })

  it('an ordinary append keeps the shortcut (the recorded prefix still matches)', async () => {
    await writeFile(sessionPath, baseLines().join('\n') + '\n')
    await parseWith(warmCache)

    await appendFile(sessionPath,
      userLine('2026-05-01T11:00:00.000Z', 'and now write the tests') + '\n' +
      asstLine('msg-e', '2026-05-01T11:00:02.000Z', [editBlock('/e.ts')]) + '\n')

    const logged: string[] = []
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
      logged.push(String(chunk)); return true
    }) as typeof process.stderr.write)
    try {
      expect(await parseWith(warmCache)).toEqual(await coldFullReparse())
    } finally {
      spy.mockRestore()
    }
    expect(logged.join('')).not.toContain('grew but its already-parsed region changed')
    // The hash moves with the resume offset, so the NEXT append is checkable too.
    const entry = await cachedFile()
    expect(entry.prefixTailSha).toBeDefined()
    expect(entry.prefixTailSha).not.toBe((await readFile(sessionPath, 'utf-8')).slice(0, 0))
  })
})

// ── the invariant the reuse rests on ───────────────────────────────────

describe('withCalls', () => {
  it('drops the derivation whenever the call set is rebuilt', () => {
    const call = { provider: 'claude', model: 'm', usage: { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0, webSearchRequests: 0, cacheCreationOneHourTokens: 0 }, speed: 'standard' as const, timestamp: 't', tools: [], bashCommands: [], skills: [], subagentTypes: [], deduplicationKey: 'k' }
    const turn: CachedTurn = { timestamp: 't', sessionId: 's', userMessage: 'u', calls: [call], derived: { c: 'coding' }, prRefs: ['https://github.com/o/r/pull/1'] }

    const rebuilt = withCalls(turn, [])
    expect(rebuilt.derived).toBeUndefined()
    expect(rebuilt.calls).toEqual([])
    // Everything else about the turn survives; only the verdict is dropped.
    expect(rebuilt.prRefs).toEqual(turn.prRefs)
    expect(turn.derived).toEqual({ c: 'coding' })   // the original is untouched
  })

  it('derivationOf/applyDerivation round-trip the classified fields', () => {
    const classifiedTurn: ClassifiedTurn = {
      userMessage: 'u', assistantCalls: [], timestamp: 't', sessionId: 's',
      category: 'refactoring', subCategory: 'some-skill', retries: 3, hasEdits: true,
    }
    const parsed = { userMessage: 'u', assistantCalls: [], timestamp: 't', sessionId: 's' }
    expect(applyDerivation(parsed, derivationOf(classifiedTurn))).toEqual(classifiedTurn)

    const plain: ClassifiedTurn = { ...classifiedTurn, category: 'general', retries: 0, hasEdits: false, subCategory: undefined }
    expect(derivationOf(plain)).toEqual({ c: 'general' })   // absent at zero/false
    expect(applyDerivation(parsed, derivationOf(plain))).toEqual({ ...plain, subCategory: undefined })
  })
})
