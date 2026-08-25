import { PassThrough } from 'node:stream'

import React from 'react'
import { render } from 'ink'
import { afterEach, describe, expect, it, onTestFinished } from 'vitest'

import { InteractiveDashboard } from '../src/dashboard.js'

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

async function mountDashboard(stdin: PassThrough & NodeJS.ReadStream, stdout: PassThrough & NodeJS.WriteStream) {
  const app = render(React.createElement(InteractiveDashboard, {
    initialProjects: [makeProject('proj', [makeSession('s1')])],
    initialPeriod: 'today',
    initialProvider: 'all',
    refreshSeconds: 0,
    windowColumns: 120,
  }), { stdin, stdout, debug: true, interactive: true, patchConsole: false })
  await app.waitUntilRenderFlush()
  return app
}

describe('InteractiveDashboard exit keystrokes (#1141)', () => {
  afterEach(() => {
    // The unmount in onTestFinished handles cleanup; nothing to do here.
  })

  it('exits on a bare q keystroke', async () => {
    const { stdin, stdout } = makeTui()
    const app = await mountDashboard(stdin, stdout)
    onTestFinished(() => app.unmount())

    const exited = app.waitUntilExit()
    stdin.write('q')
    await expect(exited).resolves.toBeUndefined()
  })

  it('exits on a raw Ctrl+C keystroke at any moment after paint', async () => {
    const { stdin, stdout } = makeTui()
    const app = await mountDashboard(stdin, stdout)
    onTestFinished(() => app.unmount())

    const exited = app.waitUntilExit()
    // A raw 0x03 from the terminal: the same byte the kernel hands the TTY
    // when the user holds Control and presses 'c' (#1141). Ink's input
    // parser surfaces it as { input: 'c', key: { ctrl: true } }.
    stdin.write('\x03')
    await expect(exited).resolves.toBeUndefined()
  })
})
