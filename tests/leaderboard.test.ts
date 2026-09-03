import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_LEADERBOARD_SERVER,
  LeaderboardClient,
  LeaderboardError,
  activityFromDaily,
  awaitDeviceAuthorization,
  buildLeaderboardReport,
  checkLeaderboardStatus,
  clearLeaderboardSession,
  dayKey,
  isoTimestamp,
  isoWeekKey,
  monthKey,
  normalizeProviderId,
  parseDeviceCode,
  parseDevicePollOutcome,
  providerSplit,
  ranksByMetric,
  readLeaderboardState,
  reportFromPayloads,
  resolveLeaderboardServer,
  totalsFromPayload,
  updateLeaderboardState,
  versionSatisfies,
  weekStart,
  weekTotalsFromDaily,
  type LeaderboardTotals,
} from '../src/leaderboard.js'
import { getConfigFilePath, readConfig, saveConfig } from '../src/config.js'
import type { DailyHistoryEntry, MenubarPayload } from '../src/menubar-json.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function day(date: string, over: Partial<DailyHistoryEntry> = {}): DailyHistoryEntry {
  return {
    date,
    cost: 0,
    savingsUSD: 0,
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    topModels: [],
    ...over,
  }
}

function payload(
  current: Partial<MenubarPayload['current']> = {},
  daily: DailyHistoryEntry[] = [],
): MenubarPayload {
  return {
    generated: '2026-09-03T00:00:00.000Z',
    current: {
      label: 'x',
      cost: 0,
      calls: 0,
      sessions: 0,
      oneShotRate: null,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cacheHitPercent: 0,
      codexCredits: 0,
      topActivities: [],
      topModels: [],
      localModelSavings: { totalUSD: 0, calls: 0, byModel: [], byProvider: [] },
      providers: {},
      providerDetails: [],
      topProjects: [],
      modelEfficiency: [],
      topSessions: [],
      workflow: { corrections: 0, correctionRate: null, medianTimeToFirstEditMs: null },
      topReworkedFiles: [],
      pricingCoverage: null,
      retryTax: { totalUSD: 0, retries: 0, editTurns: 0, byModel: [] },
      routingWaste: { totalSavingsUSD: 0, baselineModel: '', baselineCostPerEdit: 0, byModel: [] },
      tools: [],
      skills: [],
      subagents: [],
      mcpServers: [],
      ...current,
    },
    optimize: { findingCount: 0, savingsUSD: 0, topFindings: [] },
    history: { daily },
    currency: { code: 'USD', symbol: '$', rate: 1 },
  }
}

function totals(over: Partial<LeaderboardTotals> = {}): LeaderboardTotals {
  return { usd: 0, tokens: 0, calls: 0, outputTokens: 0, providers: {}, ...over }
}

/// A local-midnight Date; tests run under TZ=UTC (see tests/setup).
function at(date: string, hour = 12): Date {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(y!, m! - 1, d!, hour)
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, ...init })
}

// ---------------------------------------------------------------------------
// Date keys
// ---------------------------------------------------------------------------

describe('leaderboard date keys', () => {
  it('formats local day and month keys', () => {
    expect(dayKey(at('2026-09-03'))).toBe('2026-09-03')
    expect(dayKey(at('2026-01-05', 23))).toBe('2026-01-05')
    expect(monthKey(at('2026-09-03'))).toBe('2026-09')
    expect(monthKey(at('2026-12-31', 23))).toBe('2026-12')
  })

  it('starts the week on the local Monday', () => {
    // 2026-09-03 is a Thursday.
    expect(dayKey(weekStart(at('2026-09-03')))).toBe('2026-08-31')
    // A Monday is its own week start, a Sunday belongs to the week before.
    expect(dayKey(weekStart(at('2026-08-31')))).toBe('2026-08-31')
    expect(dayKey(weekStart(at('2026-09-06')))).toBe('2026-08-31')
  })

  it('matches the server ISO week for the current board', () => {
    expect(isoWeekKey(at('2026-09-03'))).toBe('2026-W36')
  })

  it('keeps ISO week-years straight across a year boundary', () => {
    // ISO 2025 has 52 weeks; 2025-12-29 (Monday) already belongs to 2026-W01
    // because that week's Thursday, 2026-01-01, falls in 2026.
    expect(isoWeekKey(at('2025-12-28'))).toBe('2025-W52')
    expect(isoWeekKey(at('2025-12-29'))).toBe('2026-W01')
    expect(isoWeekKey(at('2026-01-01'))).toBe('2026-W01')
    expect(isoWeekKey(at('2026-01-04'))).toBe('2026-W01')
    expect(isoWeekKey(at('2026-01-05'))).toBe('2026-W02')
    // 2027-01-01 is a Friday, so it is still 2026-W53.
    expect(isoWeekKey(at('2027-01-01'))).toBe('2026-W53')
    expect(isoWeekKey(at('2027-01-04'))).toBe('2027-W01')
  })

  it('emits ISO-8601 UTC without fractional seconds, like the Swift client', () => {
    expect(isoTimestamp(new Date('2026-09-03T04:00:00.123Z'))).toBe('2026-09-03T04:00:00Z')
  })
})

// ---------------------------------------------------------------------------
// Totals / week / streak
// ---------------------------------------------------------------------------

describe('leaderboard totals', () => {
  it('sums all four token buckets and keeps raw USD', () => {
    const result = totalsFromPayload(payload({
      cost: 12.5,
      calls: 7,
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 4,
      cacheWriteTokens: 8,
    }))
    expect(result).toEqual({ usd: 12.5, tokens: 15, calls: 7, outputTokens: 2, providers: {} })
  })

  it('prefers providerDetails ids and drops zero-cost rows', () => {
    const split = providerSplit(payload({
      providers: { claude: 99 },
      providerDetails: [
        { id: 'Claude', label: 'Claude', cost: 10, calls: 1, hasUsage: true },
        { id: 'cursor agent', label: 'Cursor', cost: 2.5, calls: 1, hasUsage: true },
        { id: 'gemini', label: 'Gemini', cost: 0, calls: 0, hasUsage: false },
      ],
    }).current)
    expect(split).toEqual({ claude: 10, 'cursor-agent': 2.5 })
  })

  it('falls back to the legacy providers map when no details are present', () => {
    const split = providerSplit(payload({ providers: { Claude: 3, Gemini: 0 } }).current)
    expect(split).toEqual({ claude: 3 })
  })

  it('normalizes provider ids the way the Swift client does', () => {
    expect(normalizeProviderId('  Cursor Agent ')).toBe('cursor-agent')
  })
})

describe('week totals', () => {
  const series = [
    day('2026-08-30', { cost: 100, calls: 100, outputTokens: 100 }), // Sunday, previous week
    day('2026-08-31', { cost: 1, calls: 2, inputTokens: 3, outputTokens: 4, cacheReadTokens: 5, cacheWriteTokens: 6 }),
    day('2026-09-01', { cost: 2, calls: 3, outputTokens: 10 }),
    day('2026-09-03', { cost: 4, calls: 1, outputTokens: 1 }),
    day('2026-09-05', { cost: 50, calls: 50, outputTokens: 50 }), // still ahead of "now"
  ]

  it('sums local Monday through today inclusive', () => {
    expect(weekTotalsFromDaily(series, at('2026-09-03'))).toEqual({
      usd: 7,
      tokens: 3 + 4 + 5 + 6 + 10 + 1,
      calls: 6,
      outputTokens: 15,
      providers: {},
    })
  })

  it('is empty when the week has no days yet', () => {
    expect(weekTotalsFromDaily([day('2026-08-30', { cost: 5, calls: 5 })], at('2026-08-31'))).toEqual({
      usd: 0, tokens: 0, calls: 0, outputTokens: 0, providers: {},
    })
  })
})

describe('activity (streak / active days)', () => {
  it('counts a run of days ending today', () => {
    const series = [
      day('2026-09-01', { calls: 1 }),
      day('2026-09-02', { calls: 4 }),
      day('2026-09-03', { calls: 2 }),
    ]
    expect(activityFromDaily(series, at('2026-09-03'))).toEqual({ streakDays: 3, activeDays: 3 })
  })

  it('ends the streak on yesterday when today is still idle', () => {
    const series = [
      day('2026-09-01', { calls: 1 }),
      day('2026-09-02', { calls: 1 }),
      day('2026-09-03', { calls: 0 }),
    ]
    expect(activityFromDaily(series, at('2026-09-03'))).toEqual({ streakDays: 2, activeDays: 2 })
  })

  it('is zero when neither today nor yesterday had a call', () => {
    const series = [day('2026-08-30', { calls: 5 }), day('2026-09-03', { calls: 0 })]
    expect(activityFromDaily(series, at('2026-09-03'))).toEqual({ streakDays: 0, activeDays: 1 })
  })

  it('breaks the streak at a gap but still counts every active day', () => {
    const series = [
      day('2026-08-20', { calls: 3 }),
      day('2026-08-21', { calls: 3 }),
      // 2026-08-22 .. 2026-09-01 idle
      day('2026-09-02', { calls: 1 }),
      day('2026-09-03', { calls: 1 }),
    ]
    expect(activityFromDaily(series, at('2026-09-03'))).toEqual({ streakDays: 2, activeDays: 4 })
  })

  it('caps the streak at the length of the series it was given', () => {
    const series = [day('2026-09-02', { calls: 1 }), day('2026-09-03', { calls: 1 })]
    expect(activityFromDaily(series, at('2026-09-03')).streakDays).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Report building
// ---------------------------------------------------------------------------

describe('buildLeaderboardReport', () => {
  const base = {
    monthKey: '2026-09',
    appVersion: '0.9.23-zh1',
    reportedAt: new Date('2026-09-03T04:00:00.000Z'),
  }

  it('lifts lifetime above a month or week slice that raced ahead of it', () => {
    const report = buildLeaderboardReport({
      ...base,
      month: totals({ usd: 100, tokens: 50, calls: 9, outputTokens: 20 }),
      lifetime: totals({ usd: 90, tokens: 40, calls: 8, outputTokens: 10 }),
      week: totals({ usd: 120, tokens: 60, calls: 11, outputTokens: 30 }),
      weekKey: '2026-W36',
    })
    expect(report.lifetimeUSD).toBe(120)
    expect(report.lifetimeTokens).toBe(60)
    expect(report.lifetimeCalls).toBe(11)
    expect(report.lifetimeOutputTokens).toBe(30)
    // The month slice is never lifted; only lifetime is by-definition largest.
    expect(report.monthUSD).toBe(100)
  })

  it('never reports fewer active days than streak days', () => {
    const report = buildLeaderboardReport({
      ...base,
      month: totals(),
      lifetime: totals(),
      activity: { streakDays: 12, activeDays: 3 },
    })
    expect(report.streakDays).toBe(12)
    expect(report.activeDays).toBe(12)
  })

  it('ships the five week fields together or not at all', () => {
    const withWeek = buildLeaderboardReport({
      ...base,
      month: totals({ usd: 5 }),
      lifetime: totals({ usd: 5 }),
      week: totals({ usd: 2, tokens: 3, calls: 4, outputTokens: 1 }),
      weekKey: '2026-W36',
    })
    expect(withWeek).toMatchObject({ week: '2026-W36', weekUSD: 2, weekTokens: 3, weekCalls: 4, weekOutputTokens: 1 })

    const withoutWeek = buildLeaderboardReport({
      ...base,
      month: totals({ usd: 5 }),
      lifetime: totals({ usd: 5 }),
      week: totals({ usd: 2 }),
      weekKey: null,
    })
    for (const key of ['week', 'weekUSD', 'weekTokens', 'weekCalls', 'weekOutputTokens']) {
      expect(Object.hasOwn(withoutWeek, key)).toBe(false)
    }
  })

  it('merges the provider split, lifting each lifetime above its month', () => {
    const report = buildLeaderboardReport({
      ...base,
      month: totals({ providers: { claude: 10, cursor: 4 } }),
      lifetime: totals({ providers: { claude: 100, gemini: 7 } }),
    })
    expect(report.byProvider).toEqual([
      { id: 'claude', monthUSD: 10, lifetimeUSD: 100 },
      { id: 'gemini', monthUSD: 0, lifetimeUSD: 7 },
      { id: 'cursor', monthUSD: 4, lifetimeUSD: 4 },
    ])
  })

  it('omits byProvider entirely when there is no split', () => {
    const report = buildLeaderboardReport({ ...base, month: totals(), lifetime: totals() })
    expect(Object.hasOwn(report, 'byProvider')).toBe(false)
  })

  it('rejects non-finite and negative figures', () => {
    expect(() => buildLeaderboardReport({ ...base, month: totals({ usd: Number.NaN }), lifetime: totals() }))
      .toThrow(LeaderboardError)
    expect(() => buildLeaderboardReport({ ...base, month: totals(), lifetime: totals({ usd: -1 }) }))
      .toThrow(/negative/i)
  })

  it('stamps reportedAt without milliseconds', () => {
    const report = buildLeaderboardReport({ ...base, month: totals(), lifetime: totals() })
    expect(report.reportedAt).toBe('2026-09-03T04:00:00Z')
    expect(report.appVersion).toBe('0.9.23-zh1')
    expect(report.month).toBe('2026-09')
  })
})

describe('reportFromPayloads', () => {
  const now = at('2026-09-03')

  it('sources month, lifetime, the week slice and the streak from the CLI payloads', () => {
    const month = payload({ cost: 30, calls: 12, inputTokens: 5, outputTokens: 6, cacheReadTokens: 1, cacheWriteTokens: 2 })
    const lifetime = payload(
      { cost: 300, calls: 120, inputTokens: 50, outputTokens: 60, cacheReadTokens: 10, cacheWriteTokens: 20 },
      [day('2026-09-01', { calls: 1 }), day('2026-09-02', { calls: 1 }), day('2026-09-03', { calls: 1 })],
    )
    const thirtyDays = payload({}, [
      day('2026-08-31', { cost: 1, calls: 1, outputTokens: 2 }),
      day('2026-09-03', { cost: 3, calls: 2, outputTokens: 4 }),
    ])

    const report = reportFromPayloads({ month, lifetime, thirtyDays, appVersion: '1.0.0', now })
    expect(report.monthUSD).toBe(30)
    expect(report.monthTokens).toBe(14)
    expect(report.monthOutputTokens).toBe(6)
    expect(report.lifetimeUSD).toBe(300)
    expect(report.week).toBe('2026-W36')
    expect(report.weekUSD).toBe(4)
    expect(report.weekCalls).toBe(3)
    expect(report.weekOutputTokens).toBe(6)
    // The lifetime series is the longer one, so the streak comes from it.
    expect(report.streakDays).toBe(3)
    expect(report.activeDays).toBe(3)
  })

  it('omits the week slice when the 30-day payload is unavailable', () => {
    const report = reportFromPayloads({
      month: payload({ cost: 1 }),
      lifetime: payload({ cost: 1 }, [day('2026-09-03', { calls: 1 })]),
      thirtyDays: null,
      appVersion: '1.0.0',
      now,
    })
    expect(Object.hasOwn(report, 'week')).toBe(false)
    expect(report.streakDays).toBe(1)
  })

  it('falls back to the 30-day series for the streak when it is the longer one', () => {
    const report = reportFromPayloads({
      month: payload({ cost: 1 }),
      lifetime: payload({ cost: 1 }, []),
      thirtyDays: payload({}, [day('2026-09-02', { calls: 1 }), day('2026-09-03', { calls: 1 })]),
      appVersion: '1.0.0',
      now,
    })
    expect(report.streakDays).toBe(2)
  })
})

describe('versionSatisfies', () => {
  it('compares dotted numeric cores and ignores pre-release suffixes', () => {
    expect(versionSatisfies('0.9.23-zh1', '0.9.23')).toBe(true)
    expect(versionSatisfies('0.9.24', '0.9.23')).toBe(true)
    expect(versionSatisfies('0.9.22', '0.9.23')).toBe(false)
    expect(versionSatisfies('0.10.0', '0.9.99')).toBe(true)
    expect(versionSatisfies('1.0', '1.0.0')).toBe(true)
  })

  it('never blocks a non-numeric build', () => {
    expect(versionSatisfies('dev', '9.9.9')).toBe(true)
    expect(versionSatisfies('1.0.0', 'nonsense')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Response decoding
// ---------------------------------------------------------------------------

describe('response decoding', () => {
  it('prefers per-metric ranks and falls back to the flat spend ranks', () => {
    expect(ranksByMetric({ week: 3, month: 12, lifetime: 8 })).toEqual({
      usd: { week: 3, month: 12, lifetime: 8 },
      output: { week: null, month: null, lifetime: null },
      streak: { week: null, month: null, lifetime: null },
    })
    expect(ranksByMetric({
      week: 3, month: 12, lifetime: 8,
      usd: { week: 1, month: 2, lifetime: 3 },
      output: { week: 4, month: 5, lifetime: 6 },
      streak: { week: null, month: 7, lifetime: 7 },
    })).toEqual({
      usd: { week: 1, month: 2, lifetime: 3 },
      output: { week: 4, month: 5, lifetime: 6 },
      streak: { week: null, month: 7, lifetime: 7 },
    })
    expect(ranksByMetric(undefined).usd).toEqual({ week: null, month: null, lifetime: null })
  })

  it('maps the contract error envelope onto typed errors', () => {
    expect(() => checkLeaderboardStatus(json({}, { status: 200 }), {})).not.toThrow()

    try {
      checkLeaderboardStatus(new Response('', { status: 401 }), { error: 'unauthorized' })
      throw new Error('expected a throw')
    } catch (error) {
      expect(error).toBeInstanceOf(LeaderboardError)
      expect((error as LeaderboardError).kind).toBe('unauthorized')
    }

    try {
      checkLeaderboardStatus(new Response('', { status: 422 }), { error: 'implausible', message: 'lifetime dropped' })
      throw new Error('expected a throw')
    } catch (error) {
      const err = error as LeaderboardError
      expect(err.kind).toBe('implausible')
      expect(err.message).toContain('lifetime dropped')
    }

    try {
      checkLeaderboardStatus(new Response('', { status: 429 }), { error: 'rate_limited', retryAfterSeconds: 300 })
      throw new Error('expected a throw')
    } catch (error) {
      const err = error as LeaderboardError
      expect(err.kind).toBe('rate-limited')
      expect(err.retryAfterSeconds).toBe(300)
      expect(err.message).toContain('5')
    }

    try {
      checkLeaderboardStatus(new Response('', { status: 429, headers: { 'Retry-After': '120' } }), {})
      throw new Error('expected a throw')
    } catch (error) {
      expect((error as LeaderboardError).retryAfterSeconds).toBe(120)
    }

    try {
      checkLeaderboardStatus(new Response('', { status: 503 }), { error: 'oops', message: 'down' })
      throw new Error('expected a throw')
    } catch (error) {
      const err = error as LeaderboardError
      expect(err.kind).toBe('http')
      expect(err.status).toBe(503)
    }
  })
})

// ---------------------------------------------------------------------------
// HTTP client (stubbed fetch — never hits the network)
// ---------------------------------------------------------------------------

describe('LeaderboardClient', () => {
  it('reads a board anonymously and pins the period key', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const client = new LeaderboardClient({
      serverUrl: 'https://board.example/',
      appVersion: '1.2.3',
      fetchImpl: async (url, init) => {
        calls.push({ url, init })
        return json({ board: 'week', metric: 'output', week: '2026-W36', entries: [], me: null })
      },
    })
    const page = await client.fetchBoard({ board: 'week', metric: 'output', limit: 20, now: at('2026-09-03') })
    expect(page.week).toBe('2026-W36')
    expect(calls[0]!.url).toBe('https://board.example/v1/leaderboard?board=week&metric=output&limit=20&week=2026-W36')
    const headers = calls[0]!.init!.headers as Record<string, string>
    expect(headers.Authorization).toBeUndefined()
    expect(headers['User-Agent']).toBe('codeburn/1.2.3')
  })

  it('clamps the limit to the server range', async () => {
    let url = ''
    const client = new LeaderboardClient({
      serverUrl: 'https://board.example',
      appVersion: '1.0.0',
      fetchImpl: async (requested) => {
        url = requested
        return json({ board: 'lifetime', entries: [] })
      },
    })
    await client.fetchBoard({ board: 'lifetime', metric: 'usd', limit: 5000 })
    expect(url).toContain('limit=100')
    expect(url).not.toContain('month=')
  })

  it('sends the bearer token on authenticated calls and never in the URL', async () => {
    let seen: { url: string; headers: Record<string, string> } | null = null
    const client = new LeaderboardClient({
      serverUrl: 'https://board.example',
      sessionToken: 'secret-token',
      appVersion: '1.0.0',
      fetchImpl: async (url, init) => {
        seen = { url, headers: init!.headers as Record<string, string> }
        return json({ ok: true, flagged: false, rank: { week: 1, month: 2, lifetime: 3 } })
      },
    })
    const response = await client.postReport({
      month: '2026-09', monthUSD: 1, monthTokens: 1, monthCalls: 1,
      lifetimeUSD: 1, lifetimeTokens: 1, lifetimeCalls: 1,
      monthOutputTokens: 0, lifetimeOutputTokens: 0, streakDays: 0, activeDays: 0,
      appVersion: '1.0.0', reportedAt: '2026-09-03T04:00:00Z',
    })
    expect(response.ok).toBe(true)
    expect(seen!.headers.Authorization).toBe('Bearer secret-token')
    expect(seen!.url).not.toContain('secret-token')
  })

  it('drops the stored session on 401 before rethrowing', async () => {
    const onUnauthorized = vi.fn()
    const client = new LeaderboardClient({
      serverUrl: 'https://board.example',
      sessionToken: 'dead',
      appVersion: '1.0.0',
      onUnauthorized,
      fetchImpl: async () => json({ error: 'unauthorized' }, { status: 401 }),
    })
    await expect(client.deleteMe()).rejects.toMatchObject({ kind: 'unauthorized' })
    expect(onUnauthorized).toHaveBeenCalledTimes(1)
    expect(client.isSignedIn).toBe(false)
  })

  it('refuses an authenticated call with no session', async () => {
    const client = new LeaderboardClient({ serverUrl: 'https://board.example', appVersion: '1.0.0', fetchImpl: async () => json({}) })
    await expect(client.postReport({
      month: '2026-09', monthUSD: 0, monthTokens: 0, monthCalls: 0,
      lifetimeUSD: 0, lifetimeTokens: 0, lifetimeCalls: 0,
      monthOutputTokens: 0, lifetimeOutputTokens: 0, streakDays: 0, activeDays: 0,
      appVersion: '1.0.0', reportedAt: '2026-09-03T04:00:00Z',
    })).rejects.toMatchObject({ kind: 'not-signed-in' })
  })

  it('exchanges a GitHub token for a session and never echoes a bad body', async () => {
    const client = new LeaderboardClient({
      serverUrl: 'https://board.example',
      appVersion: '1.0.0',
      fetchImpl: async () => json({ sessionToken: 'sess-abc', user: { id: 1, login: 'octocat', avatarUrl: 'https://a' } }),
    })
    const session = await client.createSession('gho_secret')
    expect(session.user.login).toBe('octocat')
    expect(client.isSignedIn).toBe(true)

    const broken = new LeaderboardClient({
      serverUrl: 'https://board.example',
      appVersion: '1.0.0',
      fetchImpl: async () => new Response('{"sessionToken": "gho_leaky"', { status: 200 }),
    })
    await expect(broken.createSession('gho_secret')).rejects.toSatisfy((error: LeaderboardError) =>
      error.kind === 'decode' && !error.message.includes('gho_leaky'))
  })

  it('reports a transport failure as a network error', async () => {
    const client = new LeaderboardClient({
      serverUrl: 'https://board.example',
      appVersion: '1.0.0',
      fetchImpl: async () => { throw new Error('ECONNREFUSED') },
    })
    await expect(client.getConfig()).rejects.toMatchObject({ kind: 'network' })
  })

  it('rejects a config response with no client id', async () => {
    const client = new LeaderboardClient({
      serverUrl: 'https://board.example',
      appVersion: '1.0.0',
      fetchImpl: async () => json({ uploadIntervalMinutes: 60 }),
    })
    await expect(client.getConfig()).rejects.toMatchObject({ kind: 'decode' })
  })
})

// ---------------------------------------------------------------------------
// GitHub device flow
// ---------------------------------------------------------------------------

describe('GitHub device flow', () => {
  it('parses a device code and defaults the verification URL and interval', () => {
    expect(parseDeviceCode({ device_code: 'dev', user_code: 'ABCD-1234' })).toEqual({
      deviceCode: 'dev',
      userCode: 'ABCD-1234',
      verificationUri: 'https://github.com/login/device',
      expiresIn: 900,
      interval: 5,
    })
  })

  it('surfaces GitHub error envelopes from the code request', () => {
    expect(() => parseDeviceCode({ error: 'unauthorized_client', error_description: 'device flow disabled' }))
      .toThrow(/device flow disabled/)
  })

  it('classifies every poll outcome the contract names', () => {
    expect(parseDevicePollOutcome({ access_token: 'gho_x' })).toEqual({ kind: 'token', accessToken: 'gho_x' })
    expect(parseDevicePollOutcome({ error: 'authorization_pending' })).toEqual({ kind: 'pending' })
    expect(parseDevicePollOutcome({ error: 'slow_down' })).toEqual({ kind: 'slow-down' })
    expect(parseDevicePollOutcome({ error: 'expired_token' })).toEqual({ kind: 'expired' })
    expect(parseDevicePollOutcome({ error: 'access_denied' })).toEqual({ kind: 'denied' })
    expect(parseDevicePollOutcome({ error: 'boom', error_description: 'kaboom' })).toEqual({ kind: 'failure', message: 'kaboom' })
    expect(parseDevicePollOutcome('nope').kind).toBe('failure')
  })

  it('honours interval and slow_down while polling', async () => {
    const waits: number[] = []
    const bodies = [
      { error: 'authorization_pending' },
      { error: 'slow_down' },
      { access_token: 'gho_final' },
    ]
    const token = await awaitDeviceAuthorization('client', {
      deviceCode: 'dev', userCode: 'AB-12', verificationUri: 'https://github.com/login/device', expiresIn: 900, interval: 7,
    }, {
      userAgent: 'codeburn/test',
      now: () => new Date('2026-09-03T00:00:00Z'),
      sleep: async (ms) => { waits.push(ms) },
      fetchImpl: async () => json(bodies.shift() ?? {}),
    })
    expect(token).toBe('gho_final')
    // Interval floor is 5 s; slow_down adds 5 s for the next poll.
    expect(waits).toEqual([7000, 7000, 12000])
  })

  it('stops on access_denied and on expiry', async () => {
    const deps = {
      userAgent: 'codeburn/test',
      now: () => new Date('2026-09-03T00:00:00Z'),
      sleep: async () => {},
    }
    const code = { deviceCode: 'dev', userCode: 'AB-12', verificationUri: 'https://github.com/login/device', expiresIn: 900, interval: 5 }

    await expect(awaitDeviceAuthorization('client', code, {
      ...deps,
      fetchImpl: async () => json({ error: 'access_denied' }),
    })).rejects.toMatchObject({ kind: 'device-flow' })

    await expect(awaitDeviceAuthorization('client', code, {
      ...deps,
      fetchImpl: async () => json({ error: 'expired_token' }),
    })).rejects.toThrow(/expired/i)

    // A wall clock that runs past expires_in ends the loop even if GitHub keeps
    // answering "pending".
    let tick = 0
    await expect(awaitDeviceAuthorization('client', code, {
      ...deps,
      now: () => new Date(Date.UTC(2026, 8, 3, 0, 0, tick++ * 600)),
      fetchImpl: async () => json({ error: 'authorization_pending' }),
    })).rejects.toThrow(/expired/i)
  })
})

// ---------------------------------------------------------------------------
// Stored state
// ---------------------------------------------------------------------------

describe('leaderboard config state', () => {
  let home: string

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'codeburn-leaderboard-'))
    process.env.HOME = home
    delete process.env.CODEBURN_LEADERBOARD_SERVER
  })

  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
  })

  it('round-trips through config.json without touching the rest of the config', async () => {
    await saveConfig({ currency: { code: 'EUR' }, lang: 'zh-CN' })
    await updateLeaderboardState({ sessionToken: 'sess-1', login: 'octocat', enabled: true })

    expect(await readLeaderboardState()).toEqual({ sessionToken: 'sess-1', login: 'octocat', enabled: true })
    const config = await readConfig()
    expect(config.currency).toEqual({ code: 'EUR' })
    expect(config.lang).toBe('zh-CN')

    await updateLeaderboardState({ lastUploadAt: '2026-09-03T04:00:00Z', lastUploadError: undefined })
    expect(await readLeaderboardState()).toEqual({
      sessionToken: 'sess-1', login: 'octocat', enabled: true, lastUploadAt: '2026-09-03T04:00:00Z',
    })
  })

  it('keeps config.json owner-only while it holds a session token', async () => {
    await updateLeaderboardState({ sessionToken: 'sess-1', login: 'octocat' })
    const mode = (await stat(getConfigFilePath())).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('clears the session but keeps the opt-in flag and server override', async () => {
    await updateLeaderboardState({ sessionToken: 'sess-1', login: 'octocat', avatarUrl: 'https://a', enabled: true, server: 'https://alt.example' })
    await clearLeaderboardSession()
    expect(await readLeaderboardState()).toEqual({ enabled: true, server: 'https://alt.example' })
  })

  it('drops the leaderboard block entirely once nothing is left', async () => {
    await updateLeaderboardState({ sessionToken: 'sess-1' })
    await updateLeaderboardState({ sessionToken: undefined })
    expect((await readConfig()).leaderboard).toBeUndefined()
    expect(await readLeaderboardState()).toEqual({})
  })

  it('resolves the server as env > config > default', () => {
    expect(resolveLeaderboardServer({})).toBe(DEFAULT_LEADERBOARD_SERVER)
    expect(resolveLeaderboardServer({ server: 'https://alt.example/' })).toBe('https://alt.example')
    process.env.CODEBURN_LEADERBOARD_SERVER = 'https://env.example/'
    expect(resolveLeaderboardServer({ server: 'https://alt.example' })).toBe('https://env.example')
    expect(resolveLeaderboardServer({ server: 'https://alt.example' }, { CODEBURN_LEADERBOARD_SERVER: '  ' })).toBe('https://alt.example')
  })
})
