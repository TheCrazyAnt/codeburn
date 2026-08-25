import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, readFile, rm, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import type { ProjectSummary } from '../src/types.js'
import { getModelCosts } from '../src/models.js'

import {
  currentTzKey,
  DAILY_CACHE_VERSION,
  type DailyCache,
  type DailyEntry,
  type ModelDayStats,
  type ProviderDaySlice,
  ensureCacheHydrated,
  loadDailyCache,
} from '../src/daily-cache.js'

// All five acceptance tests ride the same harness: an older-versioned daily
// cache file whose carried days are the only durable record of source-dead
// spend. The version bump (#1132) is what fires the re-derive that runs the
// reprice. The PRICING_SNAPSHOT_ONLY env (set by tests/setup/env-isolation.ts)
// pins every test to the bundled LiteLLM snapshot, so the expected prices
// here are the ones the binary will actually see.

const TMP_CACHE_ROOT = join(tmpdir(), `codeburn-1132-${process.pid}-${Date.now()}`)

const KNOWN_MODEL = 'claude-opus-4-1' as const
// 0.000015 = $15/M input, 0.000075 = $75/M output, 0.00001875 = $18.75/M cache
// write, 0.0000015 = $1.50/M cache read. Picked from src/data/litellm-snapshot.
const KNOWN_MODEL_RATES = {
  input: 0.000015,
  output: 0.000075,
  cacheWrite: 0.00001875,
  cacheRead: 0.0000015,
}

function modelStats(cost: number, calls: number, input: number, output: number, cacheRead = 0, cacheWrite = 0): ModelDayStats {
  return { calls, cost, savingsUSD: 0, inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite }
}

function sliceWithModel(cost: number, calls: number, input: number, output: number, cacheRead = 0, cacheWrite = 0): ProviderDaySlice {
  return {
    calls, cost, savingsUSD: 0, sessions: 1,
    inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite,
    models: { [KNOWN_MODEL]: modelStats(cost, calls, input, output, cacheRead, cacheWrite) },
  }
}

function day(date: string, providers: Record<string, ProviderDaySlice>, overrides: Partial<DailyEntry> = {}): DailyEntry {
  const cost = Object.values(providers).reduce((s, p) => s + p.cost, 0)
  const calls = Object.values(providers).reduce((s, p) => s + p.calls, 0)
  const inputTokens = Object.values(providers).reduce((s, p) => s + (p.inputTokens ?? 0), 0)
  const outputTokens = Object.values(providers).reduce((s, p) => s + (p.outputTokens ?? 0), 0)
  const cacheReadTokens = Object.values(providers).reduce((s, p) => s + (p.cacheReadTokens ?? 0), 0)
  const cacheWriteTokens = Object.values(providers).reduce((s, p) => s + (p.cacheWriteTokens ?? 0), 0)
  const sessions = Object.values(providers).reduce((s, p) => s + (p.sessions ?? 0), 0)
  const models: Record<string, ModelDayStats> = {}
  for (const slice of Object.values(providers)) {
    for (const [name, m] of Object.entries(slice.models ?? {})) {
      const acc = Object.hasOwn(models, name) ? models[name]! : { calls: 0, cost: 0, savingsUSD: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
      acc.calls += m.calls
      acc.cost += m.cost
      acc.savingsUSD += m.savingsUSD ?? 0
      acc.inputTokens += m.inputTokens
      acc.outputTokens += m.outputTokens
      acc.cacheReadTokens += m.cacheReadTokens
      acc.cacheWriteTokens += m.cacheWriteTokens
      Object.assign(models, { [name]: acc })
    }
  }
  return {
    date,
    cost, savingsUSD: 0, calls, sessions,
    inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
    editTurns: 0, oneShotTurns: 0,
    models, categories: {},
    providers,
    ...overrides,
  }
}

function daysAgoStr(n: number): string {
  const d = new Date(Date.now() - n * 24 * 60 * 60 * 1000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const noSessions = async (): Promise<ProjectSummary[]> => []

// One below DAILY_CACHE_VERSION: the v29 cache this writes is in the migratable
// range (MIN_SUPPORTED_VERSION is 29), so loadDailyCache migrates it in-place
// to v30 and stamps the result complete: false / pendingReprice: true. The
// re-derive that fires on that stamp is the path the #1132 reprice rides.
const PRE_BUMP_DAILY_VERSION = DAILY_CACHE_VERSION - 1

beforeEach(async () => {
  process.env['CODEBURN_CACHE_DIR'] = TMP_CACHE_ROOT
  await rm(TMP_CACHE_ROOT, { recursive: true, force: true })
  await mkdir(TMP_CACHE_ROOT, { recursive: true })
})

afterEach(async () => {
  if (existsSync(TMP_CACHE_ROOT)) {
    await rm(TMP_CACHE_ROOT, { recursive: true, force: true })
  }
})

/// Sanity guard: every other test in this file relies on the snapshot
/// actually containing the model under test, and on its rates matching
/// the constants above. Without this, a bundled-snapshot regeneration
/// (scripts/bundle-litellm.mjs) can silently change the test's notion
/// of "current rate" and make the assertions false-fail.
describe('test harness sanity', () => {
  it('bundled snapshot contains the model the #1132 tests rely on', () => {
    const costs = getModelCosts(KNOWN_MODEL)
    expect(costs).not.toBeNull()
    expect(costs!.inputCostPerToken).toBeCloseTo(KNOWN_MODEL_RATES.input, 12)
    expect(costs!.outputCostPerToken).toBeCloseTo(KNOWN_MODEL_RATES.output, 12)
    expect(costs!.cacheReadCostPerToken).toBeCloseTo(KNOWN_MODEL_RATES.cacheRead, 12)
  })
})

describe('#1132: reprice preserved source-dead slices on a DAILY_CACHE_VERSION bump', () => {
  // The seed cost is intentionally WRONG (10x the current rate) so the
  // assertion proves the value moved, not just that it survived.
  const SEEDED_INPUT = 1_000_000
  const SEEDED_OUTPUT = 200_000
  const SEEDED_CACHE_READ = 100_000
  const SEEDED_WRONG_COST = 1234.56
  const EXPECTED_COST = SEEDED_INPUT * KNOWN_MODEL_RATES.input
    + SEEDED_OUTPUT * KNOWN_MODEL_RATES.output
    + SEEDED_CACHE_READ * KNOWN_MODEL_RATES.cacheRead

  async function seedV29Cache(d: DailyEntry): Promise<void> {
    const path = join(TMP_CACHE_ROOT, `daily-cache.v${PRE_BUMP_DAILY_VERSION}.json`)
    const cache: DailyCache = {
      version: PRE_BUMP_DAILY_VERSION,
      savingsConfigHash: 'cfg',
      tzKey: currentTzKey(),
      lastComputedDate: daysAgoStr(1),
      days: [d],
      complete: true,
      watermarkTrusted: true,
    }
    await writeFile(path, JSON.stringify(cache))
  }

  it('moves a carried slice whose model is in the current tables to the new rate; calls unchanged', async () => {
    // The day is well past the 7-day settle window, so the re-derive
    // partial-survival guard will keep the baseline. The fresh parse
    // finds nothing — session files are gone.
    const settled = daysAgoStr(33)
    const wrongSlice = sliceWithModel(SEEDED_WRONG_COST, 400, SEEDED_INPUT, SEEDED_OUTPUT, SEEDED_CACHE_READ)
    const wrongDay = day(settled, { claude: wrongSlice }, { carried: true })
    await seedV29Cache(wrongDay)

    const out = await ensureCacheHydrated(noSessions, () => [], 'cfg')

    const got = out.days.find(d => d.date === settled)
    expect(got).toBeDefined()
    const gotSlice = got!.providers['claude']!
    // Stored calls/sessions/tokens are preserved — only the cost moves.
    expect(gotSlice.calls).toBe(400)
    expect(gotSlice.sessions).toBe(1)
    expect(gotSlice.inputTokens).toBe(SEEDED_INPUT)
    expect(gotSlice.outputTokens).toBe(SEEDED_OUTPUT)
    expect(gotSlice.cacheReadTokens).toBe(SEEDED_CACHE_READ)
    // The slice's cost is now tokens x current rate.
    expect(gotSlice.cost).toBeCloseTo(EXPECTED_COST, 6)
    // The day-level cost rolls up from the per-provider slice.
    expect(got!.cost).toBeCloseTo(EXPECTED_COST, 6)
    // Per-model cost inside the slice carries the same recomputed value.
    expect(gotSlice.models![KNOWN_MODEL]!.cost).toBeCloseTo(EXPECTED_COST, 6)
    // The day-level per-model rollup reconciles.
    expect(got!.models[KNOWN_MODEL]!.cost).toBeCloseTo(EXPECTED_COST, 6)
    // The day stays carried (sourceless; partial-survival kept the baseline).
    expect(got!.carried).toBe(true)
    // The v29 file is never rewritten (old binaries still own it).
    const v29Raw = JSON.parse(await readFile(join(TMP_CACHE_ROOT, `daily-cache.v${PRE_BUMP_DAILY_VERSION}.json`), 'utf-8'))
    expect(v29Raw.version).toBe(PRE_BUMP_DAILY_VERSION)
    // The entitlement is spent — subsequent ordinary launches are unaffected.
    expect(out.pendingReprice).toBeUndefined()
  })

  it('honest both-directions: a price drop LOWERS the carried slice (a price cut lowers it)', async () => {
    // Construct a day whose stored cost is HIGHER than the current rate
    // would yield. The reprice should lower it; never-lose is about data
    // PRESENCE (models missing from tables, slices without detail), never
    // about direction.
    const settled = daysAgoStr(40)
    const oldHighCost = EXPECTED_COST * 3
    const wrongSlice = sliceWithModel(oldHighCost, 400, SEEDED_INPUT, SEEDED_OUTPUT, SEEDED_CACHE_READ)
    const wrongDay = day(settled, { claude: wrongSlice }, { carried: true })
    await seedV29Cache(wrongDay)

    const out = await ensureCacheHydrated(noSessions, () => [], 'cfg')

    const got = out.days.find(d => d.date === settled)!
    expect(got.providers['claude']!.cost).toBeCloseTo(EXPECTED_COST, 6)
    expect(got.cost).toBeCloseTo(EXPECTED_COST, 6)
  })

  it('a model missing from the current tables keeps its stored cost (never zero a priced slice)', async () => {
    const settled = daysAgoStr(45)
    const missingModel = 'imaginary-model-only-ever-existed-on-day-X'
    const storedCost = 42.42
    const slice: ProviderDaySlice = {
      calls: 7, cost: storedCost, savingsUSD: 0, sessions: 1,
      models: { [missingModel]: { calls: 7, cost: storedCost, savingsUSD: 0, inputTokens: 999, outputTokens: 111, cacheReadTokens: 0, cacheWriteTokens: 0 } },
    }
    await seedV29Cache(day(settled, { claude: slice }, { carried: true }))

    const out = await ensureCacheHydrated(noSessions, () => [], 'cfg')

    const got = out.days.find(d => d.date === settled)!
    expect(got.providers['claude']!.cost).toBe(storedCost)
    expect(got.cost).toBe(storedCost)
    // The per-model stats carry the stored cost verbatim.
    expect(got.providers['claude']!.models![missingModel]!.cost).toBe(storedCost)
  })

  it('a slice without per-model token detail (pre-v15 or no splits) keeps its stored cost untouched', async () => {
    const settled = daysAgoStr(50)
    // The slice has no `models` map at all — exactly the pre-v15 shape (and
    // the shape of any modern provider whose parser never emitted per-model
    // splits). Stored cost must round-trip.
    const storedCost = 17.89
    const skinny: ProviderDaySlice = {
      calls: 3, cost: storedCost, savingsUSD: 0, sessions: 1,
      inputTokens: 500, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0,
    }
    await seedV29Cache(day(settled, { claude: skinny }, { carried: true }))

    const out = await ensureCacheHydrated(noSessions, () => [], 'cfg')

    const got = out.days.find(d => d.date === settled)!
    expect(got.providers['claude']!.cost).toBe(storedCost)
    expect(got.cost).toBe(storedCost)
  })

  it('a slice with per-model detail whose model is missing falls back to stored cost, not zero', async () => {
    // Mixed: one model is in the tables, another is not. The known one
    // moves to the current rate; the unknown one keeps its stored share.
    const settled = daysAgoStr(55)
    const knownCost = EXPECTED_COST
    const missingCost = 9.99
    const mixedSlice: ProviderDaySlice = {
      calls: 400, cost: knownCost + missingCost, savingsUSD: 0, sessions: 1,
      inputTokens: SEEDED_INPUT, outputTokens: SEEDED_OUTPUT, cacheReadTokens: SEEDED_CACHE_READ,
      models: {
        [KNOWN_MODEL]: modelStats(knownCost, 380, SEEDED_INPUT, SEEDED_OUTPUT, SEEDED_CACHE_READ),
        'long-deleted-experimental-model': modelStats(missingCost, 20, 100, 50, 0, 0),
      },
    }
    await seedV29Cache(day(settled, { claude: mixedSlice }, { carried: true }))

    const out = await ensureCacheHydrated(noSessions, () => [], 'cfg')

    const got = out.days.find(d => d.date === settled)!
    // Known model: cost moved to current rate.
    expect(got.providers['claude']!.models![KNOWN_MODEL]!.cost).toBeCloseTo(EXPECTED_COST, 6)
    // Unknown model: stored cost kept.
    expect(got.providers['claude']!.models!['long-deleted-experimental-model']!.cost).toBe(missingCost)
    // Slice cost = known new + unknown stored.
    expect(got.providers['claude']!.cost).toBeCloseTo(EXPECTED_COST + missingCost, 6)
  })

  it('surviving-source slices are unaffected by this path (re-parsed, not carried)', async () => {
    // Within the 7-day settle window, a shrink is honored as a real change
    // (the user deleted a transcript), not aged-out sources. The fresh
    // parse provides the canonical slice; the reprice pass leaves it alone
    // because only carried days are touched.
    const recent = daysAgoStr(2)
    const wrongSlice = sliceWithModel(SEEDED_WRONG_COST, 400, SEEDED_INPUT, SEEDED_OUTPUT, SEEDED_CACHE_READ)
    const wrongDay = day(recent, { claude: wrongSlice })
    await seedV29Cache(wrongDay)

    // The fresh parse sees a SMALLER call count on the same day — the
    // partial-survival guard does NOT apply (recent). The fresh slice
    // wins. The day is NOT carried after the merge.
    const freshSlice: ProviderDaySlice = {
      calls: 100, cost: 0.5, savingsUSD: 0, sessions: 1,
      models: { [KNOWN_MODEL]: modelStats(0.5, 100, 50_000, 10_000, 0, 0) },
    }
    const out = await ensureCacheHydrated(
      noSessions,
      () => [day(recent, { claude: freshSlice })],
      'cfg',
    )

    const got = out.days.find(d => d.date === recent)!
    // Fresh parse wins on the recent day.
    expect(got.providers['claude']!.cost).toBe(0.5)
    expect(got.providers['claude']!.calls).toBe(100)
    // The day is NOT carried (it was re-derived).
    expect(got.carried).toBeUndefined()
    // The reprice only touches carried days — the day-level models here
    // are the fresh ones, untouched by the reprice pass.
    expect(got.models[KNOWN_MODEL]!.cost).toBe(0.5)
  })

  it('does not reprice on an ordinary launch (no version bump)', async () => {
    // Seed a v30 cache DIRECTLY (the post-bump state) with a carried day
    // whose stored cost is stale. An ordinary launch must not reprice.
    const settled = daysAgoStr(33)
    const stale = sliceWithModel(SEEDED_WRONG_COST, 400, SEEDED_INPUT, SEEDED_OUTPUT, SEEDED_CACHE_READ)
    const staleDay = day(settled, { claude: stale }, { carried: true })
    const cache: DailyCache = {
      version: DAILY_CACHE_VERSION,
      savingsConfigHash: 'cfg',
      tzKey: currentTzKey(),
      lastComputedDate: daysAgoStr(1),
      days: [staleDay],
      complete: true,
      watermarkTrusted: true,
    }
    const path = join(TMP_CACHE_ROOT, `daily-cache.v${DAILY_CACHE_VERSION}.json`)
    await writeFile(path, JSON.stringify(cache))

    const out = await ensureCacheHydrated(noSessions, () => [], 'cfg')

    const got = out.days.find(d => d.date === settled)!
    // No reprice: stored cost preserved byte-for-byte.
    expect(got.providers['claude']!.cost).toBe(SEEDED_WRONG_COST)
    expect(got.cost).toBe(SEEDED_WRONG_COST)
  })

  it('clears pendingReprice after a complete re-derive (one-shot)', async () => {
    const settled = daysAgoStr(33)
    const stale = sliceWithModel(SEEDED_WRONG_COST, 400, SEEDED_INPUT, SEEDED_OUTPUT, SEEDED_CACHE_READ)
    const staleDay = day(settled, { claude: stale }, { carried: true })
    await seedV29Cache(staleDay)

    const out = await ensureCacheHydrated(noSessions, () => [], 'cfg')
    expect(out.pendingReprice).toBeUndefined()
    // And a subsequent ordinary launch stays quiet.
    const again = await ensureCacheHydrated(noSessions, () => [], 'cfg')
    expect(again.pendingReprice).toBeUndefined()
    const got = again.days.find(d => d.date === settled)!
    expect(got.providers['claude']!.cost).toBeCloseTo(EXPECTED_COST, 6)
  })

  it('a PARTIAL re-derive does not spend pendingReprice', async () => {
    const settled = daysAgoStr(33)
    const stale = sliceWithModel(SEEDED_WRONG_COST, 400, SEEDED_INPUT, SEEDED_OUTPUT, SEEDED_CACHE_READ)
    const staleDay = day(settled, { claude: stale }, { carried: true })
    await seedV29Cache(staleDay)

    // sessionComplete: false → partial re-derive. The merge still runs,
    // but `parseWasComplete` is false so the entitlement is held for the
    // next complete re-derive (carried days can't be repriced on a
    // partial parse — the merge results may be stale).
    const partial = await ensureCacheHydrated(noSessions, () => [], 'cfg', () => false)
    expect(partial.pendingReprice).toBe(true)
    // The carried day keeps its stale cost on this pass.
    const got = partial.days.find(d => d.date === settled)!
    expect(got.providers['claude']!.cost).toBe(SEEDED_WRONG_COST)
    // The next COMPLETE run spends the entitlement.
    const complete = await ensureCacheHydrated(noSessions, () => [], 'cfg', () => true)
    expect(complete.pendingReprice).toBeUndefined()
    const got2 = complete.days.find(d => d.date === settled)!
    expect(got2.providers['claude']!.cost).toBeCloseTo(EXPECTED_COST, 6)
  })

  it('loadDailyCache round-trips pendingReprice on a v29 -> v30 migration', async () => {
    // The v30 file is written with complete: false / pendingReprice: true
    // BEFORE ensureCacheHydrated runs. loadDailyCache alone should
    // surface the entitlement intact (the re-derive in the next call
    // spends it).
    const settled = daysAgoStr(33)
    const stale = sliceWithModel(SEEDED_WRONG_COST, 400, SEEDED_INPUT, SEEDED_OUTPUT, SEEDED_CACHE_READ)
    const staleDay = day(settled, { claude: stale }, { carried: true })
    await seedV29Cache(staleDay)

    const loaded = await loadDailyCache()
    expect(loaded.version).toBe(DAILY_CACHE_VERSION)
    expect(loaded.pendingReprice).toBe(true)
    expect(loaded.complete).toBe(false)
  })
})
