import { PassThrough } from 'node:stream'

import React from 'react'
import { render } from 'ink'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import stripAnsi from 'strip-ansi'

import { InteractiveDashboard } from '../src/dashboard.js'

// The #1143 first-q semantics live entirely inside the dashboard's useInput
// and the QuitStatusLine it renders; the fill itself is owned by the parser,
// which we mock so the test owns the fill's lifetime. A never-resolving
// promise keeps `indexing` true for the duration of the test, so the same
// state machine the user sees on a 21k-file cold start is observable here
// without a real corpus or a real cache.
vi.mock('../src/parser.js', () => ({
  parseAllSessions: vi.fn(() => new Promise(() => {})),
  filterProjectsByName: (projects: unknown[]) => projects,
  filterProjectsByDateRange: (projects: unknown[]) => projects,
  setInteractiveScanUI: () => {},
  withSinglePassParse: async <T>(_range: unknown, fn: () => Promise<T>) => fn(),
  withColdFirstPaintFloor: async <T>(_rangeStart: unknown, fn: () => Promise<T>) => ({ result: await fn(), deferredFiles: 0 }),
  filesParsedFromSourceCount: () => 0,
}))

vi.mock('../src/usage-aggregator.js', () => ({
  buildDurablePeriod: async () => ({ data: { cost: 0, savingsUSD: 0, calls: 0, sessions: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, carriedCostUSD: 0 }),
}))

vi.mock('../src/plan-usage.js', () => ({
  getPlanUsages: async () => [],
}))

vi.mock('../src/providers/index.js', () => ({
  getAllProviders: async () => [],
}))

vi.mock('../src/context-budget.js', () => ({
  estimateContextBudget: async () => ({ total: 0, parts: {} }),
}))

const EMPTY_CATEGORY_BREAKDOWN = {
  coding: { turns: 0, costUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 },
  debugging: { turns: 0, costUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 },
  feature: { turns: 0, costUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 },
  refactoring: { turns: 0, costUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 },
  testing: { turns: 0, costUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 },
  exploration: { turns: 0, costUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 },
  planning: { turns: 0, costUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 },
  delegation: { turns: 0, costUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 },
  git: { turns: 0, costUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 },
  'build/deploy': { turns: 0, costUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 },
  conversation: { turns: 0, costUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 },
  brainstorming: { turns: 0, costUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 },
  general: { turns: 0, costUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 },
} as const

function makeSession(id: string) {
  return {
    sessionId: id,
    project: 'p',
    firstTimestamp: '2026-04-14T10:00:00Z',
    lastTimestamp: '2026-04-14T10:00:00Z',
    totalCostUSD: 1,
    totalSavingsUSD: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    apiCalls: 1,
    turns: [],
    modelBreakdown: {},
    toolBreakdown: {},
    mcpBreakdown: {},
    bashBreakdown: {},
    categoryBreakdown: { ...EMPTY_CATEGORY_BREAKDOWN },
    skillBreakdown: {},
    subagentBreakdown: {},
  }
}

function makeProject(name: string, sessions: ReturnType<typeof makeSession>[]) {
  return {
    project: name,
    projectPath: name,
    sessions,
    totalCostUSD: sessions.reduce((s, x) => s + x.totalCostUSD, 0),
    totalApiCalls: sessions.reduce((s, x) => s + x.apiCalls, 0),
  }
}

function makeTui() {
  const stdin = new PassThrough() as PassThrough & NodeJS.ReadStream
  const stdout = new PassThrough() as PassThrough & NodeJS.WriteStream
  stdin.isTTY = true
  stdin.setRawMode = () => stdin
  stdin.ref = () => stdin
  stdin.unref = () => stdin
  stdout.isTTY = true
  stdout.columns = 120
  stdout.rows = 50
  return { stdin, stdout }
}

type MountOptions = { initialIndexPendingFiles?: number }

async function mountDashboard(
  stdin: PassThrough & NodeJS.ReadStream,
  stdout: PassThrough & NodeJS.WriteStream,
  options: MountOptions = {},
) {
  const app = render(React.createElement(InteractiveDashboard, {
    initialProjects: [makeProject('proj', [makeSession('s1')])],
    initialPeriod: 'today',
    initialProvider: 'all',
    refreshSeconds: 0,
    windowColumns: 120,
    initialIndexPendingFiles: options.initialIndexPendingFiles,
  }), { stdin, stdout, debug: true, interactive: true, patchConsole: false })
  await app.waitUntilRenderFlush()
  return app
}

const QUIT_STATUS_TEXT = 'Finishing background index so the next launch starts warm - press q or Ctrl+C again to quit now'

describe('InteractiveDashboard quit during background fill (#1143)', () => {
  it('first q during an active fill does not exit and renders the status line', async () => {
    const { stdin, stdout } = makeTui()
    // Capture every byte Ink writes so we can assert the status line was
    // actually rendered (not just that the process is still mounted).
    const captured: Buffer[] = []
    stdout.on('data', chunk => { captured.push(Buffer.from(chunk)) })
    const app = await mountDashboard(stdin, stdout, { initialIndexPendingFiles: 100 })
    onTestFinished(() => app.unmount())

    // Race a "still mounted after a tick" check against a real exit: if the
    // first q is misrouted to exit, waitUntilExit resolves and we fail.
    let exited = false
    void app.waitUntilExit().then(() => { exited = true })
    stdin.write('q')
    await app.waitUntilRenderFlush()
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(exited).toBe(false)

    const frame = stripAnsi(Buffer.concat(captured).toString('utf8'))
    expect(frame).toContain(QUIT_STATUS_TEXT)
  })

  it('second q during the drain exits through the same abrupt path', async () => {
    const { stdin, stdout } = makeTui()
    const app = await mountDashboard(stdin, stdout, { initialIndexPendingFiles: 100 })
    onTestFinished(() => app.unmount())

    const exited = app.waitUntilExit()
    stdin.write('q')
    await app.waitUntilRenderFlush()
    // The first press armed quit; the second takes the exit.
    stdin.write('q')
    await expect(exited).resolves.toBeUndefined()
  })

  it('Ctrl+C during the drain exits immediately, even after a first q armed quit', async () => {
    const { stdin, stdout } = makeTui()
    const app = await mountDashboard(stdin, stdout, { initialIndexPendingFiles: 100 })
    onTestFinished(() => app.unmount())

    const exited = app.waitUntilExit()
    stdin.write('q')
    await app.waitUntilRenderFlush()
    // A raw 0x03 from the terminal: Ink surfaces it as { input: 'c', key: { ctrl: true } }.
    stdin.write('\x03')
    await expect(exited).resolves.toBeUndefined()
  })

  it('q with no active fill exits immediately and never shows the status line', async () => {
    const { stdin, stdout } = makeTui()
    const captured: Buffer[] = []
    stdout.on('data', chunk => { captured.push(Buffer.from(chunk)) })
    const app = await mountDashboard(stdin, stdout)
    onTestFinished(() => app.unmount())

    const exited = app.waitUntilExit()
    stdin.write('q')
    await expect(exited).resolves.toBeUndefined()
    // Flush the unmount's last frame so the captured buffer covers everything
    // the dashboard ever wrote.
    await new Promise(resolve => setTimeout(resolve, 50))
    const frame = stripAnsi(Buffer.concat(captured).toString('utf8'))
    expect(frame).not.toContain(QUIT_STATUS_TEXT)
  })
})
