/// Frontend half of the opt-in public leaderboard. The wire shapes mirror
/// `src/leaderboard.ts` (CLI) and `mac/Sources/CodeBurnMenubar/Data/LeaderboardService.swift`;
/// every call is a Tauri command that shells out to `codeburn leaderboard`, so
/// there is no second HTTP client and no second copy of the session.
///
/// Nothing here uploads on its own. `join` and `upload` are the only actions
/// that transmit, and both are wired to an explicit button.

import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

import { formatCompactCurrency, formatTokens, type CurrencyState } from './currency'
import { t, tn } from './i18n'

/// Period boards, in the order the switcher shows them.
export const LEADERBOARD_BOARDS = ['week', 'month', 'lifetime'] as const
export type LeaderboardBoard = (typeof LEADERBOARD_BOARDS)[number]
/// The app opens on the month board, like the macOS popover.
export const DEFAULT_BOARD: LeaderboardBoard = 'month'

/// Stable API ids. Declaration order matches `LeaderboardMetric.allCases`.
export const LEADERBOARD_METRICS = ['output', 'usd', 'streak'] as const
export type LeaderboardMetric = (typeof LEADERBOARD_METRICS)[number]
/// The server defaults to `output`; both clients default to spend so the two
/// apps open on the same board.
export const DEFAULT_METRIC: LeaderboardMetric = 'usd'

/// Rows a board page shows, matching `LeaderboardService.boardLimit`.
export const BOARD_LIMIT = 20

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
  metric?: string
  /// `week` is set on the week board, `month` on the others; never both.
  week?: string
  month?: string
  updatedAt?: string
  totalUsers?: number
  entries: LeaderboardEntry[]
  me?: LeaderboardMe | null
}

/// What the popover is allowed to know about the stored session. The bearer
/// token stays in the CLI's config.json and never reaches the webview.
export type LeaderboardAccount = {
  signedIn: boolean
  login?: string | null
  avatarUrl?: string | null
  /// The opt-in flag. False (the default) means nothing is ever uploaded.
  enabled: boolean
  lastUploadAt?: string | null
  lastUploadError?: string | null
  server: string
}

export type LeaderboardAction = 'join' | 'leave' | 'upload' | 'logout' | 'delete'

/// Progress of the CLI-driven GitHub device flow. `code` can arrive once;
/// exactly one of the terminal phases follows it.
export type LoginEvent = {
  phase: 'code' | 'done' | 'failed' | 'cancelled'
  userCode?: string | null
  verificationUri?: string | null
  message?: string | null
}

export function isParticipating(account: LeaderboardAccount | null): boolean {
  return account !== null && account.signedIn && account.enabled
}

export function boardLabel(board: LeaderboardBoard): string {
  if (board === 'week') return t('This week')
  if (board === 'month') return t('This month')
  return t('Lifetime')
}

export function metricLabel(metric: LeaderboardMetric): string {
  if (metric === 'output') return t('Output')
  if (metric === 'streak') return t('Streak')
  return t('Spend')
}

/// The row's number for `metric`, read from the row's own fields. The server's
/// `value` is only meaningful for the metric the page was fetched with, so it
/// is the fallback rather than the source.
export function metricValue(
  row: LeaderboardEntry | LeaderboardMe | null | undefined,
  metric: LeaderboardMetric,
): number | null {
  if (!row) return null
  const raw = metric === 'usd' ? row.usd : metric === 'output' ? row.outputTokens : row.streakDays
  const value = raw ?? row.value
  return typeof value === 'number' ? value : null
}

/// Formats a ranked value the way the board shows it: tokens compact
/// (1.2M / 340K), spend in the display currency, streak as days.
export function formatMetric(value: number, metric: LeaderboardMetric, currency: CurrencyState): string {
  if (metric === 'output') return formatTokens(value)
  if (metric === 'streak') return tn('%d day', '%d days', Math.round(value))
  return formatCompactCurrency(value, currency)
}

export function rankText(rank: number | null | undefined): string {
  return typeof rank === 'number' ? `#${rank}` : '—'
}

/// Cache key for one (board, metric) page, matching the service's `BoardKey`.
export function boardKey(board: LeaderboardBoard, metric: LeaderboardMetric): string {
  return `${board}:${metric}`
}

export function readAccount(): Promise<LeaderboardAccount> {
  return invoke<LeaderboardAccount>('leaderboard_state')
}

export function fetchBoard(
  board: LeaderboardBoard,
  metric: LeaderboardMetric,
  limit = BOARD_LIMIT,
): Promise<LeaderboardPage> {
  return invoke<LeaderboardPage>('leaderboard_board', { board, metric, limit })
}

export function runAction(action: LeaderboardAction): Promise<LeaderboardAccount> {
  return invoke<LeaderboardAccount>('leaderboard_action', { action })
}

export function startLogin(): Promise<void> {
  return invoke('leaderboard_login')
}

export function cancelLogin(): Promise<void> {
  return invoke('leaderboard_login_cancel')
}

export function listenLogin(handler: (event: LoginEvent) => void): Promise<() => void> {
  return listen<LoginEvent>('codeburn://leaderboard-login', e => handler(e.payload))
}
