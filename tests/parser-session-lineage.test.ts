import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

import { parseAllSessions, clearSessionCache } from '../src/parser.js'
import { clearLoadCacheMemo } from '../src/session-cache.js'
import { loadPricing } from '../src/models.js'
import type { ProjectSummary, SessionSummary } from '../src/types.js'

// CB-1 first slice: provider-recorded parent/child lineage on SessionSummary.
// Strictly provider-recorded evidence only - no inference, no time-adjacency.
// A session the provider does not name a role for carries NO lineage field
// (absent, not 'unknown'). Lineage is additive metadata only: it must not
// move any cost, token, or call total in any report.

let tmpDir: string

beforeEach(async () => {
  clearSessionCache()
  tmpDir = await mkdtemp(join(tmpdir(), 'lineage-'))
  process.env['CODEBURN_CACHE_DIR'] = join(tmpDir, 'cache')
  await loadPricing()
})

afterEach(async () => {
  clearSessionCache()
  clearLoadCacheMemo()
  delete process.env['CODEBURN_CACHE_DIR']
  delete process.env['CLAUDE_CONFIG_DIR']
  delete process.env['KIMI_CODE_HOME']
  await rm(tmpDir, { recursive: true, force: true })
})

function claude(): { configDir: string; project: string; cwd: string } {
  const configDir = join(tmpDir, 'claude')
  const project = 'lineage-proj'
  const cwd = '/tmp/lineage-proj'
  return { configDir, project, cwd }
}

function findSession(projects: ProjectSummary[], predicate: (s: SessionSummary) => boolean): SessionSummary {
  for (const project of projects) {
    const hit = project.sessions.find(predicate)
    if (hit) return hit
  }
  throw new Error('session not found in any project')
}

describe('Claude two-sided subagent linkage (lineage)', () => {
  it('marks the child as role: child with the parent session id; marks the parent as role: root', async () => {
    const { configDir, project, cwd } = claude()
    const PARENT = '11111111-1111-4111-8111-aaaaaaaaaaaa'
    const AGENT = 'two-sided-agent-01'
    const SPAWN = 'toolu_two_sided'

    process.env['CLAUDE_CONFIG_DIR'] = configDir
    const projDir = join(configDir, 'projects', project)
    const subDir = join(projDir, PARENT, 'subagents')
    await mkdir(subDir, { recursive: true })

    // Parent transcript: spawns AGENT, gets the spawn result with agentId
    await writeFile(join(projDir, `${PARENT}.jsonl`),
      JSON.stringify({ type: 'user', sessionId: PARENT, timestamp: '2026-07-20T10:00:00.000Z', cwd, message: { role: 'user', content: 'launch reviewer' } }) + '\n' +
      JSON.stringify({ type: 'assistant', sessionId: PARENT, timestamp: '2026-07-20T10:00:01.000Z', cwd, message: { id: 'm1', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [{ type: 'tool_use', id: SPAWN, name: 'Agent', input: {} }], usage: { input_tokens: 10, output_tokens: 5 } } }) + '\n' +
      JSON.stringify({ type: 'user', sessionId: PARENT, timestamp: '2026-07-20T10:00:02.000Z', cwd, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: SPAWN, content: 'ok' }] }, toolUseResult: { status: 'completed', agentId: AGENT, content: 'ok' } }) + '\n' +
      JSON.stringify({ type: 'assistant', sessionId: PARENT, timestamp: '2026-07-20T10:00:03.000Z', cwd, message: { id: 'm2', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [], usage: { input_tokens: 20, output_tokens: 10 } } }) + '\n')

    // Child transcript: sidechain names PARENT in its sessionId field
    await writeFile(join(subDir, `agent-${AGENT}.jsonl`),
      JSON.stringify({ type: 'user', isSidechain: true, sessionId: PARENT, agentId: AGENT, timestamp: '2026-07-20T10:00:10.000Z', cwd, message: { role: 'user', content: 'review' } }) + '\n' +
      JSON.stringify({ type: 'assistant', isSidechain: true, sessionId: PARENT, agentId: AGENT, timestamp: '2026-07-20T10:00:11.000Z', cwd, message: { id: 'c1', type: 'message', role: 'assistant', model: 'claude-opus-4-8', content: [], usage: { input_tokens: 1000, output_tokens: 500 } } }) + '\n')

    const projects = await parseAllSessions(undefined, 'claude')

    const child = findSession(projects, s => s.sessionId === `agent-${AGENT}`)
    expect(child.lineage).toEqual({
      parentSessionId: PARENT,
      role: 'child',
      evidence: 'provider-recorded',
    })

    const parent = findSession(projects, s => s.sessionId === PARENT)
    expect(parent.lineage).toEqual({ role: 'root', evidence: 'provider-recorded' })
    expect(parent.lineage!.parentSessionId).toBeUndefined()
  })
})

describe('Claude one-sided subagent linkage (lineage)', () => {
  it('still tags the child role: child from its own parent reference, even when the parent has no agentId record', async () => {
    const { configDir, project, cwd } = claude()
    const PARENT = '22222222-2222-4222-8222-bbbbbbbbbbbb'
    const AGENT = 'one-sided-agent-01'

    process.env['CLAUDE_CONFIG_DIR'] = configDir
    const projDir = join(configDir, 'projects', project)
    const subDir = join(projDir, PARENT, 'subagents')
    await mkdir(subDir, { recursive: true })

    // Parent transcript: a turn, NO Agent/Task spawn, NO spawn result with agentId
    await writeFile(join(projDir, `${PARENT}.jsonl`),
      JSON.stringify({ type: 'user', sessionId: PARENT, timestamp: '2026-07-20T11:00:00.000Z', cwd, message: { role: 'user', content: 'regular work' } }) + '\n' +
      JSON.stringify({ type: 'assistant', sessionId: PARENT, timestamp: '2026-07-20T11:00:01.000Z', cwd, message: { id: 'm1', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [], usage: { input_tokens: 10, output_tokens: 5 } } }) + '\n')

    // Child transcript: sidechain names PARENT but parent has no agentSpawnLinks
    await writeFile(join(subDir, `agent-${AGENT}.jsonl`),
      JSON.stringify({ type: 'user', isSidechain: true, sessionId: PARENT, agentId: AGENT, timestamp: '2026-07-20T11:00:10.000Z', cwd, message: { role: 'user', content: 'review' } }) + '\n' +
      JSON.stringify({ type: 'assistant', isSidechain: true, sessionId: PARENT, agentId: AGENT, timestamp: '2026-07-20T11:00:11.000Z', cwd, message: { id: 'c1', type: 'message', role: 'assistant', model: 'claude-opus-4-8', content: [], usage: { input_tokens: 100, output_tokens: 50 } } }) + '\n')

    const projects = await parseAllSessions(undefined, 'claude')

    const child = findSession(projects, s => s.sessionId === `agent-${AGENT}`)
    // Provider-recorded: the child file's own `sessionId` names its parent.
    // The parent's lack of agentSpawnLinks does not weaken that evidence.
    expect(child.lineage).toEqual({
      parentSessionId: PARENT,
      role: 'child',
      evidence: 'provider-recorded',
    })

    const parent = findSession(projects, s => s.sessionId === PARENT)
    // No provider-recorded child evidence on the parent -> NO lineage field.
    expect(parent.lineage).toBeUndefined()
  })
})

describe('Claude no-evidence session (lineage)', () => {
  it('omits the lineage field entirely for an ordinary session that neither spawns nor is a subagent', async () => {
    const { configDir, project, cwd } = claude()
    const SESSION = '33333333-3333-4333-8333-cccccccccccc'

    process.env['CLAUDE_CONFIG_DIR'] = configDir
    const projDir = join(configDir, 'projects', project)
    await mkdir(projDir, { recursive: true })

    await writeFile(join(projDir, `${SESSION}.jsonl`),
      JSON.stringify({ type: 'user', sessionId: SESSION, timestamp: '2026-07-20T12:00:00.000Z', cwd, message: { role: 'user', content: 'plain work' } }) + '\n' +
      JSON.stringify({ type: 'assistant', sessionId: SESSION, timestamp: '2026-07-20T12:00:01.000Z', cwd, message: { id: 'm1', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [], usage: { input_tokens: 10, output_tokens: 5 } } }) + '\n')

    const projects = await parseAllSessions(undefined, 'claude')
    const session = findSession(projects, s => s.sessionId === SESSION)
    expect(session.lineage).toBeUndefined()
  })
})

describe('Kimi Code nested subagent (lineage)', () => {
  it('marks the helper agent as role: child and the main agent as role: root from state.json.agents', async () => {
    const kimiHome = join(tmpDir, 'kimi-home')
    process.env['KIMI_CODE_HOME'] = kimiHome
    const sessionId = 'kimilineage1'
    const sessionDir = join(kimiHome, 'sessions', 'wd_lineage-proj_0123456789ab', `session_${sessionId}`)
    const mainDir = join(sessionDir, 'agents', 'main')
    const helperDir = join(sessionDir, 'agents', 'agent-helper')
    await mkdir(mainDir, { recursive: true })
    await mkdir(helperDir, { recursive: true })

    // state.json records the parent/child role explicitly. parentAgentId === null
    // marks the root; parentAgentId === 'main' marks a child of main.
    await writeFile(join(sessionDir, 'state.json'), JSON.stringify({
      createdAt: '2026-07-20T10:00:00.000Z',
      updatedAt: '2026-07-20T10:00:30.000Z',
      workDir: '/tmp/lineage-proj',
      agents: {
        main: { parentAgentId: null, type: 'main' },
        'agent-helper': { parentAgentId: 'main', type: 'worker' },
      },
    }))

    // Both wires get real usage so the session carries non-zero tokens/cost.
    const baseUsage = (input: number, output: number): string =>
      JSON.stringify({ type: 'usage.record', model: 'friendly-alias', usage: { inputOther: input, output, inputCacheRead: 0, inputCacheCreation: 0 }, usageScope: 'turn', time: 1782900100000 })
    const req = (turnStep: string, model: string): string =>
      JSON.stringify({ type: 'llm.request', kind: 'loop', provider: 'fixture', model, modelAlias: 'friendly-alias', maxTokens: 4096, messageCount: 2, turnStep, time: 1782900100000 })
    const prompt = (text: string): string =>
      JSON.stringify({ type: 'turn.prompt', input: [{ type: 'text', text }], origin: { kind: 'user' }, time: 1782900099000 })
    const meta = (): string => JSON.stringify({ type: 'metadata', protocol_version: '1.4', created_at: 1782900099000 })

    await writeFile(join(mainDir, 'wire.jsonl'),
      [meta(), prompt('Coordinate the work.'), req('0.1', 'kimi-k3'), baseUsage(100, 40), ''].join('\n'))
    await writeFile(join(helperDir, 'wire.jsonl'),
      [meta(), req('0.1', 'kimi-k3'), baseUsage(60, 20), ''].join('\n'))

    const projects = await parseAllSessions(undefined, 'kimicode')
    const session = findSession(projects, s => s.sessionId === sessionId)
    // The aggregate session is read here at the (session, project) granularity
    // the existing parser already aggregates. The root agent (main) supplies
    // the lineage vote, so the session reads as root.
    expect(session.lineage).toEqual({ role: 'root', evidence: 'provider-recorded' })
    expect(session.lineage!.parentSessionId).toBeUndefined()
  })

  it('omits the lineage field when state.json has no agents block at all', async () => {
    const kimiHome = join(tmpDir, 'kimi-home-noagents')
    process.env['KIMI_CODE_HOME'] = kimiHome
    const sessionId = 'kimilineage2'
    const sessionDir = join(kimiHome, 'sessions', 'wd_lineage-proj_0123456789ab', `session_${sessionId}`)
    const mainDir = join(sessionDir, 'agents', 'main')
    await mkdir(mainDir, { recursive: true })
    await writeFile(join(sessionDir, 'state.json'), JSON.stringify({
      createdAt: '2026-07-20T10:00:00.000Z',
      updatedAt: '2026-07-20T10:00:30.000Z',
      workDir: '/tmp/lineage-proj',
    }))

    const meta = (): string => JSON.stringify({ type: 'metadata', protocol_version: '1.4', created_at: 1782900099000 })
    const prompt = (text: string): string =>
      JSON.stringify({ type: 'turn.prompt', input: [{ type: 'text', text }], origin: { kind: 'user' }, time: 1782900099000 })
    const req = (turnStep: string, model: string): string =>
      JSON.stringify({ type: 'llm.request', kind: 'loop', provider: 'fixture', model, modelAlias: 'friendly-alias', maxTokens: 4096, messageCount: 2, turnStep, time: 1782900100000 })
    const baseUsage = (input: number, output: number): string =>
      JSON.stringify({ type: 'usage.record', model: 'friendly-alias', usage: { inputOther: input, output, inputCacheRead: 0, inputCacheCreation: 0 }, usageScope: 'turn', time: 1782900100000 })

    await writeFile(join(mainDir, 'wire.jsonl'),
      [meta(), prompt('No agent metadata here.'), req('0.1', 'kimi-k3'), baseUsage(40, 10), ''].join('\n'))

    const projects = await parseAllSessions(undefined, 'kimicode')
    const session = findSession(projects, s => s.sessionId === sessionId)
    expect(session.lineage).toBeUndefined()
  })
})

describe('Session cache round-trip (lineage)', () => {
  it('preserves lineage on a warm-disk reload (Kimi cache write -> read)', async () => {
    const kimiHome = join(tmpDir, 'kimi-home-roundtrip')
    process.env['KIMI_CODE_HOME'] = kimiHome
    const sessionId = 'kimilineage3'
    const sessionDir = join(kimiHome, 'sessions', 'wd_lineage-proj_0123456789ab', `session_${sessionId}`)
    const mainDir = join(sessionDir, 'agents', 'main')
    await mkdir(mainDir, { recursive: true })

    await writeFile(join(sessionDir, 'state.json'), JSON.stringify({
      createdAt: '2026-07-20T10:00:00.000Z',
      updatedAt: '2026-07-20T10:00:30.000Z',
      workDir: '/tmp/lineage-proj',
      agents: { main: { parentAgentId: null, type: 'main' } },
    }))

    const meta = (): string => JSON.stringify({ type: 'metadata', protocol_version: '1.4', created_at: 1782900099000 })
    const prompt = (text: string): string =>
      JSON.stringify({ type: 'turn.prompt', input: [{ type: 'text', text }], origin: { kind: 'user' }, time: 1782900099000 })
    const req = (turnStep: string, model: string): string =>
      JSON.stringify({ type: 'llm.request', kind: 'loop', provider: 'fixture', model, modelAlias: 'friendly-alias', maxTokens: 4096, messageCount: 2, turnStep, time: 1782900100000 })
    const baseUsage = (input: number, output: number): string =>
      JSON.stringify({ type: 'usage.record', model: 'friendly-alias', usage: { inputOther: input, output, inputCacheRead: 0, inputCacheCreation: 0 }, usageScope: 'turn', time: 1782900100000 })

    await writeFile(join(mainDir, 'wire.jsonl'),
      [meta(), prompt('Round-trip the lineage.'), req('0.1', 'kimi-k3'), baseUsage(40, 10), ''].join('\n'))

    // Cold parse: lineage should be on the SessionSummary.
    const cold = await parseAllSessions(undefined, 'kimicode')
    const coldSession = findSession(cold, s => s.sessionId === sessionId)
    expect(coldSession.lineage).toEqual({ role: 'root', evidence: 'provider-recorded' })

    // Drop in-process memo + service-side cache, then read again from the
    // persisted session cache. The lineage must survive the warm-disk path
    // because it lives on the CachedFile (kimicode parse-version bump
    // landed the field on first save).
    clearSessionCache()
    clearLoadCacheMemo()
    const warm = await parseAllSessions(undefined, 'kimicode')
    const warmSession = findSession(warm, s => s.sessionId === sessionId)
    expect(warmSession.lineage).toEqual({ role: 'root', evidence: 'provider-recorded' })
  })
})

describe('Totals invariant (lineage is additive metadata only)', () => {
  // A corpus with one Claude parent + one child, and one Kimi root + one
  // helper. The project's headline totals must be byte-identical regardless
  // of whether `lineage` is captured. This is the spec rule: money must not
  // move.
  async function setup(): Promise<{ configDir: string; kimiHome: string; project: string; cwd: string; parent: string; agent: string; kimiSession: string }> {
    const configDir = join(tmpDir, 'claude-invariant')
    const kimiHome = join(tmpDir, 'kimi-home-invariant')
    const project = 'invariant-proj'
    const cwd = '/tmp/invariant-proj'
    const parent = '44444444-4444-4444-8444-dddddddddddd'
    const agent = 'invariant-agent-01'
    const kimiSession = 'kimiinvariant'
    return { configDir, kimiHome, project, cwd, parent, agent, kimiSession }
  }

  async function writeFixture(p: Awaited<ReturnType<typeof setup>>): Promise<void> {
    process.env['CLAUDE_CONFIG_DIR'] = p.configDir
    process.env['KIMI_CODE_HOME'] = p.kimiHome

    const projDir = join(p.configDir, 'projects', p.project)
    const subDir = join(projDir, p.parent, 'subagents')
    await mkdir(subDir, { recursive: true })
    await writeFile(join(projDir, `${p.parent}.jsonl`),
      JSON.stringify({ type: 'user', sessionId: p.parent, timestamp: '2026-07-20T13:00:00.000Z', cwd: p.cwd, message: { role: 'user', content: 'launch' } }) + '\n' +
      JSON.stringify({ type: 'assistant', sessionId: p.parent, timestamp: '2026-07-20T13:00:01.000Z', cwd: p.cwd, message: { id: 'm1', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [{ type: 'tool_use', id: 'toolu_inv_spawn', name: 'Agent', input: {} }], usage: { input_tokens: 10, output_tokens: 5 } } }) + '\n' +
      JSON.stringify({ type: 'user', sessionId: p.parent, timestamp: '2026-07-20T13:00:02.000Z', cwd: p.cwd, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_inv_spawn', content: 'done' }] }, toolUseResult: { status: 'completed', agentId: p.agent, content: 'done' } }) + '\n' +
      JSON.stringify({ type: 'assistant', sessionId: p.parent, timestamp: '2026-07-20T13:00:03.000Z', cwd: p.cwd, message: { id: 'm2', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [], usage: { input_tokens: 20, output_tokens: 10 } } }) + '\n')
    await writeFile(join(subDir, `agent-${p.agent}.jsonl`),
      JSON.stringify({ type: 'user', isSidechain: true, sessionId: p.parent, agentId: p.agent, timestamp: '2026-07-20T13:00:10.000Z', cwd: p.cwd, message: { role: 'user', content: 'child work' } }) + '\n' +
      JSON.stringify({ type: 'assistant', isSidechain: true, sessionId: p.parent, agentId: p.agent, timestamp: '2026-07-20T13:00:11.000Z', cwd: p.cwd, message: { id: 'c1', type: 'message', role: 'assistant', model: 'claude-opus-4-8', content: [], usage: { input_tokens: 1000, output_tokens: 500 } } }) + '\n')

    const kimiSessionDir = join(p.kimiHome, 'sessions', 'wd_invariant-proj_0123456789ab', `session_${p.kimiSession}`)
    const mainDir = join(kimiSessionDir, 'agents', 'main')
    const helperDir = join(kimiSessionDir, 'agents', 'agent-helper')
    await mkdir(mainDir, { recursive: true })
    await mkdir(helperDir, { recursive: true })
    await writeFile(join(kimiSessionDir, 'state.json'), JSON.stringify({
      createdAt: '2026-07-20T13:00:00.000Z',
      updatedAt: '2026-07-20T13:00:30.000Z',
      workDir: '/tmp/invariant-proj',
      agents: {
        main: { parentAgentId: null, type: 'main' },
        'agent-helper': { parentAgentId: 'main', type: 'worker' },
      },
    }))

    const meta = (): string => JSON.stringify({ type: 'metadata', protocol_version: '1.4', created_at: 1782900099000 })
    const prompt = (text: string): string =>
      JSON.stringify({ type: 'turn.prompt', input: [{ type: 'text', text }], origin: { kind: 'user' }, time: 1782900099000 })
    const req = (turnStep: string, model: string): string =>
      JSON.stringify({ type: 'llm.request', kind: 'loop', provider: 'fixture', model, modelAlias: 'friendly-alias', maxTokens: 4096, messageCount: 2, turnStep, time: 1782900100000 })
    const baseUsage = (input: number, output: number): string =>
      JSON.stringify({ type: 'usage.record', model: 'friendly-alias', usage: { inputOther: input, output, inputCacheRead: 0, inputCacheCreation: 0 }, usageScope: 'turn', time: 1782900100000 })
    await writeFile(join(mainDir, 'wire.jsonl'),
      [meta(), prompt('Coordinate.'), req('0.1', 'kimi-k3'), baseUsage(100, 40), ''].join('\n'))
    await writeFile(join(helperDir, 'wire.jsonl'),
      [meta(), req('0.1', 'kimi-k3'), baseUsage(60, 20), ''].join('\n'))
  }

  function totals(projects: ProjectSummary[]): { cost: number; input: number; output: number; calls: number; sessions: number } {
    let cost = 0, input = 0, output = 0, calls = 0, sessions = 0
    for (const project of projects) {
      cost += project.totalCostUSD
      input += project.sessions.reduce((n, s) => n + s.totalInputTokens, 0)
      output += project.sessions.reduce((n, s) => n + s.totalOutputTokens, 0)
      calls += project.sessions.reduce((n, s) => n + s.apiCalls, 0)
      sessions += project.sessions.length
    }
    return { cost, input, output, calls, sessions }
  }

  it('lineage is additive metadata: a build that strips the field produces identical totals', async () => {
    const p = await setup()
    await writeFixture(p)

    // First parse: lineage present (current build). Capture the totals.
    const withLineage = await parseAllSessions(undefined)
    const expected = totals(withLineage)

    // Sanity: lineage was actually populated somewhere.
    const hasLineage = withLineage.some(proj =>
      proj.sessions.some(s => s.lineage !== undefined)
    )
    expect(hasLineage).toBe(true)

    // Strip the field from the captured projects and recompute the totals.
    // The numbers MUST be byte-identical: lineage is metadata only.
    const stripped: ProjectSummary[] = withLineage.map(proj => ({
      ...proj,
      sessions: proj.sessions.map(s => {
        const { lineage: _lineage, ...rest } = s
        return rest as SessionSummary
      }),
    }))
    const actual = totals(stripped)
    expect(actual).toEqual(expected)
    expect(actual.calls).toBeGreaterThan(0)
    expect(actual.cost).toBeGreaterThan(0)
  })
})
