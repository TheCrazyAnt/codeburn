/// CodeBurn leaderboard client for the CLI (logic + HTTP only, no rendering).
///
/// This is the Windows/Linux counterpart of the macOS menubar's
/// `LeaderboardService.swift`. The wire shapes and every derived number below
/// mirror that file exactly so both clients report comparable figures; the
/// shared contract lives in scratchpad/leaderboard/API.md.
///
/// Privacy posture (identical to the Swift client): only aggregate numbers
/// leave the machine — USD, tokens, calls, an optional per-provider USD split,
/// streak/active days and the app version. No project names, session ids,
/// prompts, file paths or model transcripts. Identity is a GitHub account via
/// the device flow; the GitHub access token is exchanged once for a server
/// session token and discarded. Neither token is ever printed or logged.

import { readConfig, saveConfig, type CodeburnConfig } from './config.js'
import { fetchWithTimeout } from './fetch-utils.js'
import { t } from './i18n.js'
import type { DailyHistoryEntry, MenubarPayload } from './menubar-json.js'

/// Same default as the Swift client's `defaultServerURL`.
export const DEFAULT_LEADERBOARD_SERVER = 'https://codeburn-leaderboard.tangyishun9846.workers.dev'
export const LEADERBOARD_SERVER_ENV = 'CODEBURN_LEADERBOARD_SERVER'

/// Swift uses a 30 s URLRequest timeout; match it rather than the 8 s pricing
/// default, because a report POST can wait on a D1 write.
export const LEADERBOARD_TIMEOUT_MS = 30_000

export const LEADERBOARD_BOARDS = ['week', 'month', 'lifetime'] as const
export type LeaderboardBoard = (typeof LEADERBOARD_BOARDS)[number]
export const DEFAULT_LEADERBOARD_BOARD: LeaderboardBoard = 'month'

export const LEADERBOARD_METRICS = ['output', 'usd', 'streak'] as const
export type LeaderboardMetric = (typeof LEADERBOARD_METRICS)[number]
/// The server defaults to `output`; the app (and therefore this CLI) defaults
/// to `usd` so both clients open on the same board.
export const DEFAULT_LEADERBOARD_METRIC: LeaderboardMetric = 'usd'

export const DEFAULT_LEADERBOARD_LIMIT = 20
export const MAX_LEADERBOARD_LIMIT = 100

export function isLeaderboardBoard(value: unknown): value is LeaderboardBoard {
  return typeof value === 'string' && (LEADERBOARD_BOARDS as readonly string[]).includes(value)
}

export function isLeaderboardMetric(value: unknown): value is LeaderboardMetric {
  return typeof value === 'string' && (LEADERBOARD_METRICS as readonly string[]).includes(value)
}

// ---------------------------------------------------------------------------
// Wire types (mirror LeaderboardService.swift's Codable structs)
// ---------------------------------------------------------------------------

export type LeaderboardServerConfig = {
  githubClientId: string
  uploadIntervalMinutes?: number
  minAppVersion?: string
  board?: { week?: string; month?: string }
}

export type LeaderboardUser = {
  id: number
  login: string
  avatarUrl?: string
}

export type LeaderboardSession = {
  sessionToken: string
  user: LeaderboardUser
}

export type LeaderboardEntry = {
  rank: number
  login: string
  avatarUrl?: string
  usd?: number
  tokens?: number
  outputTokens?: number
  streakDays?: number
  calls?: number
  topProvider?: string
  /// The number this page is ranked by (per the page's `metric`).
  value?: number
}

export type LeaderboardMe = {
  rank?: number
  usd?: number
  tokens?: number
  outputTokens?: number
  streakDays?: number
  calls?: number
  value?: number
  flagged?: boolean
}

export type LeaderboardPage = {
  board: string
  /// Ranking metric id; absent on pre-metric servers (= spend).
  metric?: string
  /// `week` is set on the week board, `month` on the others; never both.
  week?: string
  month?: string
  updatedAt?: string
  totalUsers?: number
  entries: LeaderboardEntry[]
  me?: LeaderboardMe | null
}

export type LeaderboardProviderSplit = {
  id: string
  monthUSD: number
  lifetimeUSD: number
}

export type LeaderboardReport = {
  month: string
  monthUSD: number
  monthTokens: number
  monthCalls: number
  /// Calendar-week slice (local Monday 00:00 → now), keyed as ISO week
  /// `YYYY-Www`. The five week fields travel together: all set, or all omitted
  /// when the week could not be sourced. Not bounded by the month (a week can
  /// straddle two months), only by lifetime.
  week?: string
  weekUSD?: number
  weekTokens?: number
  weekCalls?: number
  weekOutputTokens?: number
  lifetimeUSD: number
  lifetimeTokens: number
  lifetimeCalls: number
  monthOutputTokens: number
  lifetimeOutputTokens: number
  streakDays: number
  activeDays: number
  /// Omitted (not `[]`) when the payload carries no provider split.
  byProvider?: LeaderboardProviderSplit[]
  appVersion: string
  reportedAt: string
}

export type LeaderboardPeriodRanks = {
  week?: number | null
  month?: number | null
  lifetime?: number | null
}

/// The flat `week/month/lifetime` are the spend ranks (what a pre-metric
/// server sends); `usd/output/streak` carry one set per metric.
export type LeaderboardRanks = LeaderboardPeriodRanks & {
  usd?: LeaderboardPeriodRanks
  output?: LeaderboardPeriodRanks
  streak?: LeaderboardPeriodRanks
}

export type LeaderboardReportResponse = {
  ok: boolean
  flagged?: boolean
  rank?: LeaderboardRanks
}

/// Per-metric ranks, flattened the way the Swift client's `MyRank` does it:
/// nested per-metric ranks win, the flat fields are the spend ranks an older
/// server sends.
export function ranksByMetric(ranks: LeaderboardRanks | undefined): Record<LeaderboardMetric, LeaderboardPeriodRanks> {
  const flat: LeaderboardPeriodRanks = { week: ranks?.week ?? null, month: ranks?.month ?? null, lifetime: ranks?.lifetime ?? null }
  const pick = (nested: LeaderboardPeriodRanks | undefined, fallback: LeaderboardPeriodRanks): LeaderboardPeriodRanks =>
    nested ? { week: nested.week ?? null, month: nested.month ?? null, lifetime: nested.lifetime ?? null } : fallback
  return {
    usd: pick(ranks?.usd, flat),
    output: pick(ranks?.output, { week: null, month: null, lifetime: null }),
    streak: pick(ranks?.streak, { week: null, month: null, lifetime: null }),
  }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type LeaderboardErrorKind =
  | 'not-signed-in'
  | 'not-enabled'
  | 'usage-unavailable'
  | 'app-too-old'
  | 'unauthorized'
  | 'rate-limited'
  | 'implausible'
  | 'http'
  | 'decode'
  | 'network'
  | 'device-flow'
  | 'invalid-report'

export class LeaderboardError extends Error {
  readonly kind: LeaderboardErrorKind
  readonly status?: number
  readonly code?: string
  readonly retryAfterSeconds?: number

  constructor(kind: LeaderboardErrorKind, message: string, extra: { status?: number; code?: string; retryAfterSeconds?: number } = {}) {
    super(message)
    this.name = 'LeaderboardError'
    this.kind = kind
    this.status = extra.status
    this.code = extra.code
    this.retryAfterSeconds = extra.retryAfterSeconds
  }
}

export function leaderboardErrorMessage(error: unknown): string {
  if (error instanceof LeaderboardError) return error.message
  if (error instanceof Error) return error.message
  return String(error)
}

// ---------------------------------------------------------------------------
// Stored state (config.json)
// ---------------------------------------------------------------------------

export type LeaderboardState = NonNullable<CodeburnConfig['leaderboard']>

export async function readLeaderboardState(): Promise<LeaderboardState> {
  return (await readConfig()).leaderboard ?? {}
}

/// Read-modify-write of `config.leaderboard`. `undefined` values in the patch
/// delete the key, so a caller can drop the session without rewriting the rest.
export async function updateLeaderboardState(patch: Partial<LeaderboardState>): Promise<LeaderboardState> {
  const config = await readConfig()
  const next: LeaderboardState = { ...(config.leaderboard ?? {}) }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete (next as Record<string, unknown>)[key]
    else (next as Record<string, unknown>)[key] = value
  }
  if (Object.keys(next).length === 0) delete config.leaderboard
  else config.leaderboard = next
  await saveConfig(config)
  return next
}

/// Drops the session token and identity but keeps the opt-in flag and server
/// override, matching the Swift client's `clearSession`. Used on sign-out and
/// whenever the server answers 401.
export async function clearLeaderboardSession(): Promise<void> {
  await updateLeaderboardState({ sessionToken: undefined, login: undefined, avatarUrl: undefined })
}

export function resolveLeaderboardServer(state: Pick<LeaderboardState, 'server'> = {}, env: NodeJS.ProcessEnv = process.env): string {
  const candidates = [env[LEADERBOARD_SERVER_ENV], state.server]
  for (const candidate of candidates) {
    const trimmed = candidate?.trim()
    if (trimmed) return trimmed.replace(/\/+$/, '')
  }
  return DEFAULT_LEADERBOARD_SERVER
}

// ---------------------------------------------------------------------------
// Version gate (pure) — mirrors LeaderboardVersionGate
// ---------------------------------------------------------------------------

function numericCore(version: string): number[] | null {
  const core = version.trim().replace(/^v/i, '').split(/[-+]/)[0] ?? ''
  const parts = core.split('.')
  if (parts.length === 0 || parts[0] === '') return null
  const numbers = parts.map(part => (/^\d+$/.test(part) ? Number(part) : null))
  if (numbers.some(n => n === null)) return null
  return numbers as number[]
}

/// True when `version` satisfies `minimum`. Compares dotted numeric cores only
/// (`0.9.23-zh1` → 0.9.23); a non-numeric build ("dev") is never blocked, so a
/// local checkout can still talk to the server.
export function versionSatisfies(version: string, minimum: string): boolean {
  const required = numericCore(minimum)
  if (!required) return true
  const actual = numericCore(version)
  if (!actual) return true
  const count = Math.max(required.length, actual.length)
  for (let i = 0; i < count; i++) {
    const lhs = actual[i] ?? 0
    const rhs = required[i] ?? 0
    if (lhs !== rhs) return lhs > rhs
  }
  return true
}

// ---------------------------------------------------------------------------
// Date keys (pure) — local time, matching the CLI's own day buckets
// ---------------------------------------------------------------------------

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0')
}

/// `yyyy-MM-dd` in local time, the key format `history.daily` already uses.
export function dayKey(date: Date): string {
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/// Client's current calendar month in local time, `YYYY-MM`.
export function monthKey(date: Date): string {
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}`
}

/// Local Monday 00:00 of the week containing `date` (ISO weeks start Monday).
export function weekStart(date: Date): Date {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  // getDay(): 0 = Sunday … 6 = Saturday. Shift so Monday is 0.
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7))
  return start
}

const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000

/// Client's current ISO week in local time, `YYYY-Www`. Week 1 is the one
/// holding January 4, so the week-year can differ from the calendar year
/// around New Year (2025-12-29 → `2026-W01`). The server keys the board by the
/// UTC ISO week and tolerates ±1, which covers the hours where the two differ.
export function isoWeekKey(date: Date): string {
  const monday = weekStart(date)
  const thursday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 3)
  const year = thursday.getFullYear()
  const firstMonday = weekStart(new Date(year, 0, 4))
  // Both operands are local midnights, so a DST shift moves the difference by
  // at most an hour — rounding absorbs it.
  const week = Math.round((thursday.getTime() - firstMonday.getTime()) / MS_PER_WEEK) + 1
  return `${pad(year, 4)}-W${pad(week)}`
}

/// ISO-8601 UTC without fractional seconds, matching the Swift client's
/// `.withInternetDateTime` output.
export function isoTimestamp(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

// ---------------------------------------------------------------------------
// Report building (pure) — mirrors LeaderboardReportBuilder
// ---------------------------------------------------------------------------

/// Period totals as they leave the machine: raw USD before any FX conversion,
/// tokens = input + output + cache read + cache write, and the provider split
/// by stable provider id (lowercased).
export type LeaderboardTotals = {
  usd: number
  tokens: number
  calls: number
  /// Model output tokens, a subset of `tokens`.
  outputTokens: number
  providers: Record<string, number>
}

export type LeaderboardActivity = {
  streakDays: number
  activeDays: number
}

export const NO_ACTIVITY: LeaderboardActivity = { streakDays: 0, activeDays: 0 }

export function normalizeProviderId(raw: string): string {
  return raw.trim().toLowerCase().replace(/ /g, '-')
}

/// `providerDetails` (stable ids) wins when the CLI emits it; the legacy
/// `providers` label map is the fallback. Zero-cost rows are dropped so an
/// installed-but-idle provider never appears in the split.
export function providerSplit(current: MenubarPayload['current']): Record<string, number> {
  const split: Record<string, number> = {}
  const add = (id: string, cost: number): void => {
    if (!Number.isFinite(cost) || cost <= 0) return
    const key = normalizeProviderId(id)
    split[key] = (split[key] ?? 0) + cost
  }
  if (current.providerDetails && current.providerDetails.length > 0) {
    for (const detail of current.providerDetails) add(detail.id, detail.cost)
  } else {
    for (const [key, cost] of Object.entries(current.providers ?? {})) add(key, cost)
  }
  return split
}

export function totalsFromPayload(payload: MenubarPayload): LeaderboardTotals {
  const current = payload.current
  return {
    usd: current.cost,
    tokens: current.inputTokens + current.outputTokens + current.cacheReadTokens + current.cacheWriteTokens,
    calls: current.calls,
    outputTokens: current.outputTokens,
    providers: providerSplit(current),
  }
}

/// Week totals for the leaderboard: the per-day series summed from local
/// Monday through today inclusive. Each day carries cost, calls and all four
/// token counts, so the sum has the same shape as a period's `current` block.
/// The daily series has no provider split, so `providers` stays empty and the
/// report's `byProvider` keeps coming from the month and lifetime slices.
export function weekTotalsFromDaily(daily: readonly DailyHistoryEntry[], now: Date): LeaderboardTotals {
  const first = dayKey(weekStart(now))
  const last = dayKey(now)
  const totals: LeaderboardTotals = { usd: 0, tokens: 0, calls: 0, outputTokens: 0, providers: {} }
  for (const day of daily) {
    if (day.date < first || day.date > last) continue
    totals.usd += day.cost
    totals.tokens += day.inputTokens + day.outputTokens + day.cacheReadTokens + day.cacheWriteTokens
    totals.outputTokens += day.outputTokens
    totals.calls += day.calls
  }
  return totals
}

/// Streak of consecutive active days (≥ 1 call) ending today, or ending
/// yesterday when today has no calls yet, plus the distinct active days in the
/// series. Derived from a per-day series, so a series shorter than the true
/// streak caps it at the series length.
export function activityFromDaily(daily: readonly DailyHistoryEntry[], now: Date): LeaderboardActivity {
  const active = new Set<string>()
  for (const day of daily) {
    if (day.calls > 0) active.add(day.date)
  }
  const cursor = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  if (!active.has(dayKey(cursor))) cursor.setDate(cursor.getDate() - 1)
  let streakDays = 0
  while (active.has(dayKey(cursor))) {
    streakDays += 1
    cursor.setDate(cursor.getDate() - 1)
  }
  return { streakDays, activeDays: active.size }
}

function validateNumber(value: number, field: string): void {
  if (!Number.isFinite(value)) {
    throw new LeaderboardError('invalid-report', t('Report field %s is not a finite number.', field))
  }
  if (value < 0) {
    throw new LeaderboardError('invalid-report', t('Report field %s is negative.', field))
  }
}

export type BuildReportInput = {
  month: LeaderboardTotals
  lifetime: LeaderboardTotals
  monthKey: string
  week?: LeaderboardTotals | null
  weekKey?: string | null
  activity?: LeaderboardActivity
  appVersion: string
  reportedAt: Date
}

/// `week` and `weekKey` are optional together: the week slice ships only when
/// both are known, otherwise the report is a month + lifetime one.
export function buildLeaderboardReport(input: BuildReportInput): LeaderboardReport {
  const { month, lifetime, activity = NO_ACTIVITY } = input
  validateNumber(month.usd, 'monthUSD')
  validateNumber(lifetime.usd, 'lifetimeUSD')
  validateNumber(month.tokens, 'monthTokens')
  validateNumber(lifetime.tokens, 'lifetimeTokens')
  validateNumber(month.calls, 'monthCalls')
  validateNumber(lifetime.calls, 'lifetimeCalls')
  validateNumber(month.outputTokens, 'monthOutputTokens')
  validateNumber(lifetime.outputTokens, 'lifetimeOutputTokens')
  validateNumber(activity.streakDays, 'streakDays')
  validateNumber(activity.activeDays, 'activeDays')

  const week = input.week && input.weekKey ? { key: input.weekKey, totals: input.week } : null
  if (week) {
    validateNumber(week.totals.usd, 'weekUSD')
    validateNumber(week.totals.tokens, 'weekTokens')
    validateNumber(week.totals.calls, 'weekCalls')
    validateNumber(week.totals.outputTokens, 'weekOutputTokens')
  }

  // Month, week and lifetime are separate aggregations; a call that landed
  // between them can make a slice edge past lifetime. Lifetime is by
  // definition the largest, so lift it rather than ship a report the server
  // would reject as implausible.
  const lifetimeUSD = Math.max(lifetime.usd, month.usd, week?.totals.usd ?? 0)
  const lifetimeTokens = Math.max(lifetime.tokens, month.tokens, week?.totals.tokens ?? 0)
  const lifetimeCalls = Math.max(lifetime.calls, month.calls, week?.totals.calls ?? 0)
  const lifetimeOutputTokens = Math.max(lifetime.outputTokens, month.outputTokens, week?.totals.outputTokens ?? 0)
  // A streak is a run of active days, so it can never exceed them.
  const activeDays = Math.max(activity.activeDays, activity.streakDays)

  const ids = new Set([...Object.keys(month.providers), ...Object.keys(lifetime.providers)])
  const byProvider: LeaderboardProviderSplit[] | undefined = ids.size === 0
    ? undefined
    : [...ids]
        .map(id => {
          const monthUSD = month.providers[id] ?? 0
          return { id, monthUSD, lifetimeUSD: Math.max(lifetime.providers[id] ?? 0, monthUSD) }
        })
        .sort((a, b) => (a.lifetimeUSD !== b.lifetimeUSD ? b.lifetimeUSD - a.lifetimeUSD : a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  return {
    month: input.monthKey,
    monthUSD: month.usd,
    monthTokens: month.tokens,
    monthCalls: month.calls,
    ...(week
      ? {
          week: week.key,
          weekUSD: week.totals.usd,
          weekTokens: week.totals.tokens,
          weekCalls: week.totals.calls,
          weekOutputTokens: week.totals.outputTokens,
        }
      : {}),
    lifetimeUSD,
    lifetimeTokens,
    lifetimeCalls,
    monthOutputTokens: month.outputTokens,
    lifetimeOutputTokens,
    streakDays: activity.streakDays,
    activeDays,
    ...(byProvider ? { byProvider } : {}),
    appVersion: input.appVersion,
    reportedAt: isoTimestamp(input.reportedAt),
  }
}

/// Assembles a report from the three payloads the CLI already knows how to
/// build. Month and lifetime are required; the week slice is summed from the
/// 30-day payload's per-day series and simply left out when that payload is
/// missing, so a missing week never blocks the upload.
export function reportFromPayloads(input: {
  month: MenubarPayload
  lifetime: MenubarPayload
  thirtyDays?: MenubarPayload | null
  appVersion: string
  now: Date
}): LeaderboardReport {
  const { month, lifetime, thirtyDays, appVersion, now } = input
  const week = thirtyDays ? weekTotalsFromDaily(thirtyDays.history.daily, now) : null
  // The streak wants the longest per-day series on hand: lifetime (the payload
  // caps it at 365 days) normally, the 30-day one as a fallback.
  const lifetimeDaily = lifetime.history.daily ?? []
  const thirtyDaily = thirtyDays?.history.daily ?? []
  const activity = activityFromDaily(lifetimeDaily.length >= thirtyDaily.length ? lifetimeDaily : thirtyDaily, now)
  return buildLeaderboardReport({
    month: totalsFromPayload(month),
    lifetime: totalsFromPayload(lifetime),
    monthKey: monthKey(now),
    week,
    weekKey: week ? isoWeekKey(now) : null,
    activity,
    appVersion,
    reportedAt: now,
  })
}

/// Builds the three all-provider payloads a report needs, through the CLI's
/// own aggregation path (no duplicated parsing). Imported lazily so the pure
/// helpers above stay cheap to load — tests and `leaderboard status` never pay
/// for the parser.
export async function loadReportPayloads(): Promise<{ month: MenubarPayload; lifetime: MenubarPayload; thirtyDays: MenubarPayload | null }> {
  const [{ buildMenubarPayloadForRange }, { getDateRange }, { loadPricing }] = await Promise.all([
    import('./usage-aggregator.js'),
    import('./cli-date.js'),
    import('./models.js'),
  ])
  await loadPricing()
  const opts = { provider: 'all', optimize: false, timeline: false } as const
  const [month, lifetime, thirtyDays] = await Promise.all([
    buildMenubarPayloadForRange(getDateRange('month'), { ...opts }),
    buildMenubarPayloadForRange(getDateRange('lifetime'), { ...opts }),
    buildMenubarPayloadForRange(getDateRange('30days'), { ...opts }).catch(() => null),
  ])
  return { month, lifetime, thirtyDays }
}

// ---------------------------------------------------------------------------
// GitHub device flow
// ---------------------------------------------------------------------------

export const GITHUB_DEVICE_CODE_URL = 'https://github.com/login/device/code'
export const GITHUB_ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token'
export const GITHUB_DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code'
export const GITHUB_DEVICE_VERIFICATION_URL = 'https://github.com/login/device'

export type DeviceCode = {
  deviceCode: string
  userCode: string
  verificationUri: string
  expiresIn: number
  interval: number
}

export type DevicePollOutcome =
  | { kind: 'token'; accessToken: string }
  | { kind: 'pending' }
  | { kind: 'slow-down' }
  | { kind: 'expired' }
  | { kind: 'denied' }
  | { kind: 'failure'; message: string }

function deviceFlowMessage(code: string, description?: unknown): string {
  if (typeof description === 'string' && description.length > 0) return description
  return t('GitHub sign-in failed (%s).', code)
}

export function parseDeviceCode(body: unknown): DeviceCode {
  if (!body || typeof body !== 'object') throw new LeaderboardError('decode', t('GitHub sent a malformed response.'))
  const root = body as Record<string, unknown>
  if (typeof root.error === 'string') {
    throw new LeaderboardError('device-flow', deviceFlowMessage(root.error, root.error_description))
  }
  const deviceCode = typeof root.device_code === 'string' ? root.device_code : ''
  const userCode = typeof root.user_code === 'string' ? root.user_code : ''
  if (!deviceCode || !userCode) throw new LeaderboardError('decode', t('GitHub sent a malformed response.'))
  const verification = typeof root.verification_uri === 'string' && root.verification_uri.length > 0
    ? root.verification_uri
    : GITHUB_DEVICE_VERIFICATION_URL
  return {
    deviceCode,
    userCode,
    verificationUri: verification,
    expiresIn: typeof root.expires_in === 'number' ? root.expires_in : 900,
    interval: typeof root.interval === 'number' ? root.interval : 5,
  }
}

export function parseDevicePollOutcome(body: unknown): DevicePollOutcome {
  if (!body || typeof body !== 'object') return { kind: 'failure', message: t('GitHub sent a malformed response.') }
  const root = body as Record<string, unknown>
  if (typeof root.access_token === 'string' && root.access_token.length > 0) {
    return { kind: 'token', accessToken: root.access_token }
  }
  switch (root.error) {
    case 'authorization_pending': return { kind: 'pending' }
    case 'slow_down': return { kind: 'slow-down' }
    case 'expired_token': return { kind: 'expired' }
    case 'access_denied': return { kind: 'denied' }
    default:
      if (typeof root.error === 'string') return { kind: 'failure', message: deviceFlowMessage(root.error, root.error_description) }
      return { kind: 'failure', message: t('GitHub sent a malformed response.') }
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

function defaultFetch(input: string, init: RequestInit = {}): Promise<Response> {
  return fetchWithTimeout(input, init, LEADERBOARD_TIMEOUT_MS)
}

function formBody(fields: Array<[string, string]>): string {
  return fields.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&')
}

async function readJsonBody(response: Response, context: 'github' | 'server'): Promise<unknown> {
  let text: string
  try {
    text = await response.text()
  } catch (error) {
    throw new LeaderboardError('network', t('Network error: %s', leaderboardErrorMessage(error)))
  }
  if (text.trim().length === 0) return {}
  try {
    return JSON.parse(text) as unknown
  } catch {
    // Never echo the body: a session response would carry the token.
    throw new LeaderboardError(
      'decode',
      context === 'github' ? t('GitHub sent a malformed response.') : t('The leaderboard server sent a malformed response.'),
    )
  }
}

export type DeviceFlowDeps = {
  fetchImpl?: FetchLike
  userAgent: string
  /// Injectable so tests never actually wait.
  sleep?: (ms: number) => Promise<void>
  now?: () => Date
}

async function githubForm(url: string, fields: Array<[string, string]>, deps: DeviceFlowDeps): Promise<{ response: Response; body: unknown }> {
  const fetchImpl = deps.fetchImpl ?? defaultFetch
  let response: Response
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': deps.userAgent,
      },
      body: formBody(fields),
    })
  } catch (error) {
    throw new LeaderboardError('network', t('Network error: %s', leaderboardErrorMessage(error)))
  }
  return { response, body: await readJsonBody(response, 'github') }
}

export async function requestDeviceCode(clientId: string, deps: DeviceFlowDeps): Promise<DeviceCode> {
  const { response, body } = await githubForm(GITHUB_DEVICE_CODE_URL, [['client_id', clientId], ['scope', '']], deps)
  if (!response.ok) {
    // Parse first: GitHub returns its own error envelope with a 4xx.
    if (body && typeof body === 'object' && typeof (body as Record<string, unknown>).error === 'string') return parseDeviceCode(body)
    throw new LeaderboardError('device-flow', t('GitHub refused the device code request (HTTP %d).', response.status))
  }
  return parseDeviceCode(body)
}

export async function pollDeviceToken(clientId: string, deviceCode: string, deps: DeviceFlowDeps): Promise<DevicePollOutcome> {
  const { body } = await githubForm(
    GITHUB_ACCESS_TOKEN_URL,
    [['client_id', clientId], ['device_code', deviceCode], ['grant_type', GITHUB_DEVICE_GRANT_TYPE]],
    deps,
  )
  return parseDevicePollOutcome(body)
}

const sleepMs = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/// Polls GitHub until the user authorizes, honouring `interval`, `slow_down`
/// (+5 s), `authorization_pending`, `expired_token` and `access_denied`.
/// Returns the GitHub access token, which the caller must exchange for a
/// server session and then discard. Never logs it.
export async function awaitDeviceAuthorization(clientId: string, code: DeviceCode, deps: DeviceFlowDeps): Promise<string> {
  const sleep = deps.sleep ?? sleepMs
  const now = deps.now ?? (() => new Date())
  const expiresAt = now().getTime() + code.expiresIn * 1000
  let interval = Math.max(code.interval, 5)
  for (;;) {
    await sleep(interval * 1000)
    if (now().getTime() >= expiresAt) {
      throw new LeaderboardError('device-flow', t('The code expired before it was entered. Try again.'))
    }
    const outcome = await pollDeviceToken(clientId, code.deviceCode, deps)
    switch (outcome.kind) {
      case 'token': return outcome.accessToken
      case 'pending': continue
      case 'slow-down': interval += 5; continue
      case 'expired':
        throw new LeaderboardError('device-flow', t('The code expired before it was entered. Try again.'))
      case 'denied':
        throw new LeaderboardError('device-flow', t('GitHub reported that you declined the authorization.'))
      case 'failure':
        throw new LeaderboardError('device-flow', outcome.message)
    }
  }
}

// ---------------------------------------------------------------------------
// Server client
// ---------------------------------------------------------------------------

type ErrorEnvelope = { error?: string; message?: string; retryAfterSeconds?: number }

function errorEnvelope(body: unknown): ErrorEnvelope {
  if (!body || typeof body !== 'object') return {}
  const root = body as Record<string, unknown>
  return {
    error: typeof root.error === 'string' ? root.error : undefined,
    message: typeof root.message === 'string' ? root.message : undefined,
    retryAfterSeconds: typeof root.retryAfterSeconds === 'number' ? root.retryAfterSeconds : undefined,
  }
}

/// Maps the contract's error envelope onto typed errors. 2xx passes through.
export function checkLeaderboardStatus(response: Response, body: unknown): void {
  if (response.status >= 200 && response.status < 300) return
  const envelope = errorEnvelope(body)
  if (response.status === 401) {
    throw new LeaderboardError('unauthorized', t('Your leaderboard session expired. Sign in again.'), { status: 401, code: envelope.error })
  }
  if (response.status === 422) {
    throw new LeaderboardError(
      'implausible',
      envelope.message
        ? t('The server rejected the report: %s', envelope.message)
        : t('The server rejected the report as implausible.'),
      { status: 422, code: envelope.error },
    )
  }
  if (response.status === 429) {
    const header = Number(response.headers?.get?.('Retry-After')?.trim() ?? '')
    const retryAfterSeconds = envelope.retryAfterSeconds ?? (Number.isFinite(header) && header > 0 ? header : undefined)
    throw new LeaderboardError(
      'rate-limited',
      retryAfterSeconds && retryAfterSeconds > 0
        ? t('The server accepted a report recently. Try again in %d min.', Math.max(1, Math.round(retryAfterSeconds / 60)))
        : t('The server accepted a report recently. Try again later.'),
      { status: 429, code: envelope.error, retryAfterSeconds },
    )
  }
  throw new LeaderboardError(
    'http',
    envelope.message
      ? t('Leaderboard server error (HTTP %1$d): %2$s', response.status, envelope.message)
      : t('Leaderboard server error (HTTP %d).', response.status),
    { status: response.status, code: envelope.error },
  )
}

export type LeaderboardClientOptions = {
  serverUrl: string
  sessionToken?: string
  appVersion: string
  fetchImpl?: FetchLike
  /// Called before an `unauthorized` error is thrown, so the caller can drop
  /// the stored session. Failures here are swallowed; the error still throws.
  onUnauthorized?: () => Promise<void> | void
}

export class LeaderboardClient {
  private readonly serverUrl: string
  private sessionToken?: string
  private readonly appVersion: string
  private readonly fetchImpl: FetchLike
  private readonly onUnauthorized?: () => Promise<void> | void

  constructor(options: LeaderboardClientOptions) {
    this.serverUrl = options.serverUrl.replace(/\/+$/, '')
    this.sessionToken = options.sessionToken
    this.appVersion = options.appVersion
    this.fetchImpl = options.fetchImpl ?? defaultFetch
    this.onUnauthorized = options.onUnauthorized
  }

  get isSignedIn(): boolean {
    return Boolean(this.sessionToken)
  }

  get userAgent(): string {
    return `codeburn/${this.appVersion}`
  }

  private async send(path: string, method: string, options: { body?: unknown; auth: boolean; handleUnauthorized?: boolean } = { auth: false }): Promise<unknown> {
    const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': this.userAgent }
    let payload: string | undefined
    if (options.body !== undefined) {
      payload = JSON.stringify(options.body)
      headers['Content-Type'] = 'application/json'
    }
    if (options.auth) {
      if (!this.sessionToken) {
        throw new LeaderboardError('not-signed-in', t('Sign in with GitHub to join the leaderboard: codeburn leaderboard login'))
      }
      headers.Authorization = `Bearer ${this.sessionToken}`
    }
    let response: Response
    try {
      response = await this.fetchImpl(`${this.serverUrl}${path}`, { method, headers, ...(payload === undefined ? {} : { body: payload }) })
    } catch (error) {
      throw new LeaderboardError('network', t('Network error: %s', leaderboardErrorMessage(error)))
    }
    const body = await readJsonBody(response, 'server')
    if (options.auth && options.handleUnauthorized !== false && response.status === 401) {
      this.sessionToken = undefined
      try {
        await this.onUnauthorized?.()
      } catch {
        // Dropping the local session is best-effort; the 401 still surfaces.
      }
    }
    checkLeaderboardStatus(response, body)
    return body
  }

  async getConfig(): Promise<LeaderboardServerConfig> {
    const body = await this.send('/v1/config', 'GET', { auth: false })
    const root = (body ?? {}) as Record<string, unknown>
    if (typeof root.githubClientId !== 'string') {
      throw new LeaderboardError('decode', t('The leaderboard server sent a malformed response.'))
    }
    return body as LeaderboardServerConfig
  }

  async createSession(githubAccessToken: string): Promise<LeaderboardSession> {
    const body = await this.send('/v1/session', 'POST', {
      auth: false,
      body: { githubAccessToken, appVersion: this.appVersion },
    })
    const root = (body ?? {}) as Record<string, unknown>
    const user = root.user as Record<string, unknown> | undefined
    if (typeof root.sessionToken !== 'string' || !root.sessionToken || !user || typeof user.login !== 'string') {
      throw new LeaderboardError('decode', t('The leaderboard server sent a malformed response.'))
    }
    this.sessionToken = root.sessionToken
    return body as LeaderboardSession
  }

  async fetchBoard(params: { board: LeaderboardBoard; metric: LeaderboardMetric; limit: number; now?: Date; authenticated?: boolean }): Promise<LeaderboardPage> {
    const now = params.now ?? new Date()
    const limit = Math.min(Math.max(Math.round(params.limit), 1), MAX_LEADERBOARD_LIMIT)
    const query = new URLSearchParams({ board: params.board, metric: params.metric, limit: String(limit) })
    if (params.board === 'week') query.set('week', isoWeekKey(now))
    if (params.board === 'month') query.set('month', monthKey(now))
    const authenticated = params.authenticated ?? this.isSignedIn
    const body = await this.send(`/v1/leaderboard?${query.toString()}`, 'GET', { auth: authenticated && this.isSignedIn })
    const root = (body ?? {}) as Record<string, unknown>
    if (typeof root.board !== 'string' || !Array.isArray(root.entries)) {
      throw new LeaderboardError('decode', t('The leaderboard server sent a malformed response.'))
    }
    return body as LeaderboardPage
  }

  async postReport(report: LeaderboardReport): Promise<LeaderboardReportResponse> {
    const body = await this.send('/v1/report', 'POST', { auth: true, body: report })
    const root = (body ?? {}) as Record<string, unknown>
    if (typeof root.ok !== 'boolean') {
      throw new LeaderboardError('decode', t('The leaderboard server sent a malformed response.'))
    }
    return body as LeaderboardReportResponse
  }

  /// Revokes this session token server-side. Best effort: the local session is
  /// dropped by the caller either way.
  async logout(): Promise<void> {
    await this.send('/v1/logout', 'POST', { auth: true, handleUnauthorized: false })
  }

  /// Deletes the user, sessions, weekly/monthly rows and the report log.
  async deleteMe(): Promise<void> {
    await this.send('/v1/me', 'DELETE', { auth: true })
  }
}

/// Builds a client from the stored state, wiring the 401 handler to drop the
/// saved session so the next command tells the user to sign in again.
export function leaderboardClient(state: LeaderboardState, appVersion: string, fetchImpl?: FetchLike): LeaderboardClient {
  return new LeaderboardClient({
    serverUrl: resolveLeaderboardServer(state),
    ...(state.sessionToken ? { sessionToken: state.sessionToken } : {}),
    appVersion,
    ...(fetchImpl ? { fetchImpl } : {}),
    onUnauthorized: clearLeaderboardSession,
  })
}
