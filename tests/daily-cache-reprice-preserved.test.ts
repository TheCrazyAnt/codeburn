import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, rm } from 'fs/promises'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  DAILY_CACHE_VERSION,
  type DailyCache,
  type DailyEntry,
  type ProviderDaySlice,
  type ModelDayStats,
  currentTzKey,
  ensureCacheHydrated,
  loadDailyCache,
  repricePreservedDays,
  saveDailyCache,
  toDateString,
} from '../src/daily-cache.js'
import { setPriceOverrides } from '../src/models.js'

const TMP_CACHE_ROOT = join(tmpdir(), `codeburn-reprice-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)

beforeEach(async () => {
  process.env['CODEBURN_CACHE_DIR'] = TMP_CACHE_ROOT
  await mkdir(TMP_CACHE_ROOT, { recursive: true })
})

afterEach(async () => {
  if (existsSync(TMP_CACHE_ROOT)) {
    await rm(TMP_CACHE_ROOT, { recursive: true, force: true })
  }
  setPriceOverrides({})
})

function modelStats(cost: number, calls: number, tokens: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }): ModelDayStats {
  return {
    calls,
    cost,
    savingsUSD: 0,
    inputTokens: tokens.input ?? 0,
    outputTokens: tokens.output ?? 0,
    cacheReadTokens: tokens.cacheRead ?? 0,
    cacheWriteTokens: tokens.cacheWrite ?? 0,
  }
}

function sliceWithModels(cost: number, calls: number, models: Record<string, ModelDayStats>, extra: Partial<ProviderDaySlice> = {}): ProviderDaySlice {
  return {
    cost,
    calls,
    savingsUSD: 0,
    inputTokens: Object.values(models).reduce((s, m) => s + m.inputTokens, 0),
    outputTokens: Object.values(models).reduce((s, m) => s + m.outputTokens, 0),
    cacheReadTokens: Object.values(models).reduce((s, m) => s + m.cacheReadTokens, 0),
    cacheWriteTokens: Object.values(models).reduce((s, m) => s + m.cacheWriteTokens, 0),
    models,
    ...extra,
  }
}

function day(date: string, providers: Record<string, ProviderDaySlice>, overrides: Partial<DailyEntry> = {}): DailyEntry {
  const cost = Object.values(providers).reduce((s, p) => s + p.cost, 0)
  const calls = Object.values(providers).reduce((s, p) => s + p.calls, 0)
  const tokens = Object.values(providers).reduce(
    (s, p) => ({
      input: s.input + (p.inputTokens ?? 0),
      output: s.output + (p.outputTokens ?? 0),
      cacheRead: s.cacheRead + (p.cacheReadTokens ?? 0),
      cacheWrite: s.cacheWrite + (p.cacheWriteTokens ?? 0),
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  )
  const dayModels: Record<string, ModelDayStats> = {}
  for (const p of Object.values(providers)) {
    for (const [name, m] of Object.entries(p.models ?? {})) {
      const acc = dayModels[name] ?? { calls: 0, cost: 0, savingsUSD: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
      acc.calls += m.calls
      acc.cost += m.cost
      acc.savingsUSD += m.savingsUSD ?? 0
      acc.inputTokens += m.inputTokens
      acc.outputTokens += m.outputTokens
      acc.cacheReadTokens += m.cacheReadTokens
      acc.cacheWriteTokens += m.cacheWriteTokens
      dayModels[name] = acc
    }
  }
  return {
    date,
    cost,
    savingsUSD: 0,
    calls,
    sessions: 0,
    inputTokens: tokens.input,
    outputTokens: tokens.output,
    cacheReadTokens: tokens.cacheRead,
    cacheWriteTokens: tokens.cacheWrite,
    editTurns: 0,
    oneShotTurns: 0,
    models: dayModels,
    categories: {},
    providers,
    ...overrides,
  }
}

function daysAgo(n: number): string {
  const d = new Date(Date.now() - n * 24 * 60 * 60 * 1000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const noSessions = async (): Promise<never[]> => []

describe('repricePreservedDays', () => {
  it('moves a preserved slice with stored tokens to the current rate when the price changed', () => {
    setPriceOverrides({
      'claude-opus-4-6': { input: 15, output: 75 },
    })
    const settled = daysAgo(40)
    const preserved = day(settled, {
      claude: sliceWithModels(15.29, 283, {
        'claude-opus-4-6': modelStats(15.29, 283, { input: 1_000_000, output: 100_000 }),
      }),
    }, { carried: true })
    const [repriced] = repricePreservedDays([preserved])
    // $15/M input * 1M = $15, $75/M output * 0.1M = $7.5, total $22.5
    expect(repriced!.providers['claude']!.cost).toBeCloseTo(22.5, 6)
    expect(repriced!.providers['claude']!.calls).toBe(283)
    expect(repriced!.providers['claude']!.models!['claude-opus-4-6']!.cost).toBeCloseTo(22.5, 6)
    expect(repriced!.providers['claude']!.inputTokens).toBe(1_000_000)
    expect(repriced!.providers['claude']!.outputTokens).toBe(100_000)
    expect(repriced!.cost).toBeCloseTo(22.5, 6)
  })

  it('a model missing from current tables keeps its stored cost (never zero a priced slice)', () => {
    setPriceOverrides({
      'priced-and-current': { input: 5, output: 15 },
    })
    const settled = daysAgo(40)
    const preserved = day(settled, {
      claude: sliceWithModels(99, 10, {
        'priced-and-current': modelStats(11, 5, { input: 1_000_000, output: 100_000 }),
        'extinct-pricing-row-7777': modelStats(88, 5, { input: 2_000_000, output: 200_000 }),
      }),
    }, { carried: true })
    const [repriced] = repricePreservedDays([preserved])
    const slice = repriced!.providers['claude']!
    expect(slice.models!['priced-and-current']!.cost).toBeCloseTo(5 * 1 + 15 * 0.1, 6)
    expect(slice.models!['extinct-pricing-row-7777']!.cost).toBe(88)
    expect(slice.cost).toBeCloseTo(slice.models!['priced-and-current']!.cost + 88, 6)
  })

  it('a slice without per-model token detail keeps its stored cost untouched', () => {
    const settled = daysAgo(40)
    const skinnySlice: ProviderDaySlice = {
      cost: 12.34, calls: 50, savingsUSD: 0,
      inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0,
    }
    const skinny = day(settled, { claude: skinnySlice }, { carried: true })
    const [repriced] = repricePreservedDays([skinny])
    expect(repriced!.providers['claude']!.cost).toBe(12.34)
    expect(repriced!.cost).toBe(12.34)
  })

  it('a slice whose fresh data already covers the day is repriced to the same number (no harm done)', () => {
    setPriceOverrides({
      'gpt-5.4': { input: 2, output: 8 },
    })
    const settled = daysAgo(40)
    const freshSlice = sliceWithModels(0, 5, {
      'gpt-5.4': modelStats(0, 5, { input: 1_000_000, output: 100_000 }),
    })
    const [repriced] = repricePreservedDays([day(settled, { codex: freshSlice })])
    // 2 * 1 + 8 * 0.1 = 2.8
    expect(repriced!.providers['codex']!.cost).toBeCloseTo(2.8, 6)
  })

  it('preservedRepriced stamp blocks re-pricing on ordinary launches', async () => {
    setPriceOverrides({ 'claude-opus-4-6': { input: 15, output: 75 } })
    const yesterday = daysAgo(1)
    const settled = daysAgo(40)
    const baseline: DailyCache = {
      version: DAILY_CACHE_VERSION,
      savingsConfigHash: 'cfg-A',
      tzKey: currentTzKey(),
      lastComputedDate: yesterday,
      days: [day(settled, {
        claude: sliceWithModels(15.29, 283, {
          'claude-opus-4-6': modelStats(15.29, 283, { input: 1_000_000, output: 100_000 }),
        }),
      }, { carried: true })],
      complete: true,
      watermarkTrusted: true,
      preservedRepriced: DAILY_CACHE_VERSION,
    }
    await saveDailyCache(baseline)
    // No parse: complete cache, no gap, no tz change. The stamp is set so even
    // if the merge path were entered it would not reprice, but here the cache
    // is complete and the hydrate path does not enter the re-derive branch at
    // all - ordinary launches stay byte-identical.
    const out = await ensureCacheHydrated(noSessions, () => [], 'cfg-A')
    expect(out.days.find(d => d.date === settled)!.providers['claude']!.cost).toBe(15.29)
    expect(out.preservedRepriced).toBe(DAILY_CACHE_VERSION)
  })

  it('a settled baseline whose sources have all aged out re-prices through the first re-derive', async () => {
    setPriceOverrides({ 'claude-opus-4-6': { input: 15, output: 75 } })
    const yesterday = daysAgo(1)
    const settled = daysAgo(40)
    const baseline: DailyCache = {
      version: DAILY_CACHE_VERSION,
      savingsConfigHash: 'cfg-A',
      tzKey: currentTzKey(),
      lastComputedDate: yesterday,
      days: [day(settled, {
        claude: sliceWithModels(15.29, 283, {
          'claude-opus-4-6': modelStats(15.29, 283, { input: 1_000_000, output: 100_000 }),
        }),
      }, { carried: true })],
      complete: false,
    }
    await saveDailyCache(baseline)
    const out = await ensureCacheHydrated(noSessions, () => [], 'cfg-A')
    const settledDay = out.days.find(d => d.date === settled)!
    expect(settledDay.providers['claude']!.cost).toBeCloseTo(22.5, 6)
    expect(settledDay.providers['claude']!.calls).toBe(283)
    expect(out.preservedRepriced).toBe(DAILY_CACHE_VERSION)
  })

  it('a re-derive whose fresh parse already covered the day leaves its slice at the fresh cost', async () => {
    setPriceOverrides({ 'gpt-5.4': { input: 2, output: 8 } })
    const yesterday = daysAgo(1)
    const settled = daysAgo(40)
    const baseline: DailyCache = {
      version: DAILY_CACHE_VERSION,
      savingsConfigHash: 'cfg-A',
      tzKey: currentTzKey(),
      lastComputedDate: yesterday,
      days: [day(settled, {
        codex: sliceWithModels(99, 5, {
          'gpt-5.4': modelStats(99, 5, { input: 1_000_000, output: 100_000 }),
        }),
      }, { carried: true })],
      complete: false,
    }
    await saveDailyCache(baseline)
    const freshSlice = sliceWithModels(2.8, 5, {
      'gpt-5.4': modelStats(2.8, 5, { input: 1_000_000, output: 100_000 }),
    })
    const freshDay = day(settled, { codex: freshSlice })
    const out = await ensureCacheHydrated(noSessions, () => [freshDay], 'cfg-A')
    const settledDay = out.days.find(d => d.date === settled)!
    expect(settledDay.providers['codex']!.cost).toBeCloseTo(2.8, 6)
    expect(settledDay.providers['codex']!.calls).toBe(5)
  })

  it('a model whose current price is lower also reprices downward (honest both directions)', () => {
    setPriceOverrides({ 'claude-opus-4-6': { input: 1, output: 2 } })
    const settled = daysAgo(40)
    const preserved = day(settled, {
      claude: sliceWithModels(50, 10, {
        'claude-opus-4-6': modelStats(50, 10, { input: 1_000_000, output: 100_000 }),
      }),
    }, { carried: true })
    const [repriced] = repricePreservedDays([preserved])
    expect(repriced!.providers['claude']!.cost).toBeCloseTo(1 * 1 + 2 * 0.1, 6)
  })

  it('reprice keeps every call and token count byte-identical to the stored slice', () => {
    setPriceOverrides({ 'claude-opus-4-6': { input: 15, output: 75 } })
    const settled = daysAgo(40)
    const slice = sliceWithModels(15.29, 283, {
      'claude-opus-4-6': modelStats(15.29, 283, { input: 1_234_567, output: 98_765, cacheRead: 12_345, cacheWrite: 6789 }),
    })
    const before = day(settled, { claude: slice }, { carried: true })
    const [repriced] = repricePreservedDays([before])
    const beforeSlice = before.providers['claude']!
    const afterSlice = repriced!.providers['claude']!
    expect(afterSlice.calls).toBe(beforeSlice.calls)
    expect(afterSlice.inputTokens).toBe(beforeSlice.inputTokens)
    expect(afterSlice.outputTokens).toBe(beforeSlice.outputTokens)
    expect(afterSlice.cacheReadTokens).toBe(beforeSlice.cacheReadTokens)
    expect(afterSlice.cacheWriteTokens).toBe(beforeSlice.cacheWriteTokens)
    expect(afterSlice.sessions).toBe(beforeSlice.sessions)
    expect(afterSlice.savingsUSD).toBe(beforeSlice.savingsUSD)
  })

  it('cache_write tokens use the explicit rate when present, else the 1.25x input default', () => {
    setPriceOverrides({
      'claude-haiku-4-5': { input: 1, output: 5, cacheCreation: 1.25, cacheRead: 0.1 },
    })
    const settled = daysAgo(40)
    const slice = sliceWithModels(0, 1, {
      'claude-haiku-4-5': modelStats(0, 1, { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 1_000_000 }),
    })
    const [repriced] = repricePreservedDays([day(settled, { claude: slice }, { carried: true })])
    // $1/M input + $1.25/M cache_write = $2.25
    expect(repriced!.providers['claude']!.cost).toBeCloseTo(2.25, 6)
  })

  it('cache_write defaults to 1.25x the input rate when not explicit', () => {
    setPriceOverrides({
      'cache-default-probe': { input: 2, output: 4 },
    })
    const settled = daysAgo(40)
    const slice = sliceWithModels(0, 1, {
      'cache-default-probe': modelStats(0, 1, { input: 0, output: 0, cacheRead: 0, cacheWrite: 1_000_000 }),
    })
    const [repriced] = repricePreservedDays([day(settled, { claude: slice }, { carried: true })])
    // $2.5/M cache_write (1.25 * $2/M input)
    expect(repriced!.providers['claude']!.cost).toBeCloseTo(2.5, 6)
  })

  it('a provider whose stored cost is recorded (not token-derived) is skipped wholesale', () => {
    setPriceOverrides({ 'gpt-5.5': { input: 5, output: 15 } })
    const settled = daysAgo(40)
    // hermes records actualCost (0.10) regardless of token rates. Repricing
    // from tokens would clobber the recorded truth with a token estimate.
    const slice = sliceWithModels(0.10, 1, {
      'gpt-5.5': modelStats(0.10, 1, { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }),
    })
    const [repriced] = repricePreservedDays([day(settled, { hermes: slice }, { carried: true })])
    expect(repriced!.providers['hermes']!.cost).toBe(0.10)
    expect(repriced!.providers['hermes']!.models!['gpt-5.5']!.cost).toBe(0.10)
  })

  it('loadDailyCache returns the stamp as-is so a same-version launch does not re-reprice', async () => {
    setPriceOverrides({})
    const cache: DailyCache = {
      version: DAILY_CACHE_VERSION,
      savingsConfigHash: 'cfg',
      tzKey: currentTzKey(),
      lastComputedDate: toDateString(new Date()),
      days: [],
      complete: true,
      watermarkTrusted: true,
      preservedRepriced: DAILY_CACHE_VERSION,
    }
    await saveDailyCache(cache)
    const loaded = await loadDailyCache()
    expect(loaded.preservedRepriced).toBe(DAILY_CACHE_VERSION)
  })

  it('a fresh parse that covers a non-carried day leaves that day\'s per-model values untouched by the reprice pass', async () => {
    setPriceOverrides({ 'gpt-5.4': { input: 2, output: 8 } })
    const yesterday = daysAgo(1)
    const baseline: DailyCache = {
      version: DAILY_CACHE_VERSION,
      savingsConfigHash: 'cfg-A',
      tzKey: currentTzKey(),
      lastComputedDate: yesterday,
      days: [],
      complete: false,
    }
    await saveDailyCache(baseline)
    const freshSlice = sliceWithModels(2.8, 5, {
      'gpt-5.4': modelStats(2.8, 5, { input: 1_000_000, output: 100_000 }),
    })
    const freshDay = day(daysAgo(40), { codex: freshSlice })
    const out = await ensureCacheHydrated(noSessions, () => [freshDay], 'cfg-A')
    expect(out.preservedRepriced).toBe(DAILY_CACHE_VERSION)
    const settled = out.days.find(d => d.date === freshDay.date)!
    expect(settled.carried).toBeUndefined()
    expect(settled.providers['codex']!.cost).toBeCloseTo(2.8, 6)
    expect(settled.providers['codex']!.models!['gpt-5.4']!.cost).toBeCloseTo(2.8, 6)
    expect(settled.providers['codex']!.models!['gpt-5.4']!.inputTokens).toBe(1_000_000)
    expect(settled.providers['codex']!.models!['gpt-5.4']!.outputTokens).toBe(100_000)
  })

  it('a partial re-derive (parseWasComplete false) does not stamp preservedRepriced', async () => {
    setPriceOverrides({ 'claude-opus-4-6': { input: 15, output: 75 } })
    const yesterday = daysAgo(1)
    const settled = daysAgo(40)
    const baseline: DailyCache = {
      version: DAILY_CACHE_VERSION,
      savingsConfigHash: 'cfg-A',
      tzKey: currentTzKey(),
      lastComputedDate: yesterday,
      days: [day(settled, {
        claude: sliceWithModels(15.29, 283, {
          'claude-opus-4-6': modelStats(15.29, 283, { input: 1_000_000, output: 100_000 }),
        }),
      }, { carried: true })],
      complete: false,
    }
    await saveDailyCache(baseline)
    const out = await ensureCacheHydrated(noSessions, () => [], 'cfg-A', () => false)
    expect(out.preservedRepriced).toBeUndefined()
    expect(out.complete).toBe(false)
  })
})
