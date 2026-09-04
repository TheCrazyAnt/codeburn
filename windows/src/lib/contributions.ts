/// Contribution-heatmap maths, ported from `computeContributionStats` and
/// `buildContributionWeeks` in `mac/Sources/CodeBurnMenubar/Views/HeatmapSection.swift`.
/// The definitions are kept identical on purpose: both apps read the same
/// `history.daily` series, so both must report the same active-day count,
/// active-day average, peak day and streak for it.

import type { DailyEntry } from './payload'
import { addDays, formatDateKey, startOfDay } from './dates'

export const MAX_WEEKS = 52

export type ContributionDay = {
  date: string
  cost: number
  calls: number
  inputTokens: number
  outputTokens: number
  /// 0 (none) through 4, bucketed against the busiest visible day.
  level: number
  isToday: boolean
  isFuture: boolean
}

export type ContributionWeek = {
  startDate: string
  days: ContributionDay[]
}

export type ContributionStats = {
  total: number
  activeDays: number
  avgActive: number
  peak: ContributionDay | null
  currentStreak: number
}

/// Quartiles of the busiest visible day, matching `contributionLevel`.
export function contributionLevel(value: number, maxValue: number): number {
  if (!(value > 0) || !(maxValue > 0)) return 0
  const ratio = Math.min(Math.max(value / maxValue, 0), 1)
  if (ratio < 0.25) return 1
  if (ratio < 0.5) return 2
  if (ratio < 0.75) return 3
  return 4
}

/// Local Monday 00:00 of the week containing `date` (ISO weeks start Monday),
/// the same rule as `startOfContributionWeek`.
function startOfContributionWeek(date: Date): Date {
  const start = startOfDay(date)
  // getDay(): 0 = Sunday … 6 = Saturday. Shift so Monday is 0.
  return addDays(start, -((start.getDay() + 6) % 7))
}

/// `weekCount` columns of seven weekday rows, ending with the current week.
/// Days after today are marked `isFuture` and contribute nothing.
export function buildContributionWeeks(
  days: DailyEntry[],
  weekCount: number,
  now = new Date(),
): ContributionWeek[] {
  const today = startOfDay(now)
  const todayKey = formatDateKey(today)
  const visibleWeekCount = Math.min(Math.max(Math.round(weekCount), 1), MAX_WEEKS)
  const byDate = new Map(days.map(d => [d.date, d]))
  const firstWeekStart = addDays(startOfContributionWeek(today), -7 * (visibleWeekCount - 1))

  // The colour scale is set by the busiest day actually on screen, so a spike
  // outside the window cannot flatten everything visible.
  let maxCost = 0
  for (let offset = 0; offset < visibleWeekCount * 7; offset++) {
    const date = addDays(firstWeekStart, offset)
    if (date > today) continue
    const entry = byDate.get(formatDateKey(date))
    if (entry && entry.cost > maxCost) maxCost = entry.cost
  }

  const weeks: ContributionWeek[] = []
  for (let week = 0; week < visibleWeekCount; week++) {
    const weekStart = addDays(firstWeekStart, week * 7)
    const cells: ContributionDay[] = []
    for (let day = 0; day < 7; day++) {
      const date = addDays(weekStart, day)
      const key = formatDateKey(date)
      const entry = byDate.get(key)
      const isFuture = date > today
      const cost = isFuture ? 0 : (entry?.cost ?? 0)
      cells.push({
        date: key,
        cost,
        calls: isFuture ? 0 : (entry?.calls ?? 0),
        inputTokens: isFuture ? 0 : (entry?.inputTokens ?? 0),
        outputTokens: isFuture ? 0 : (entry?.outputTokens ?? 0),
        level: isFuture ? 0 : contributionLevel(cost, maxCost),
        isToday: key === todayKey,
        isFuture,
      })
    }
    weeks.push({ startDate: formatDateKey(weekStart), days: cells })
  }
  return weeks
}

/// Totals over the visible window. "Active" means spend > 0, the average is
/// over active days only (not calendar days), and the streak counts backwards
/// from the last non-future cell until the first day with no spend.
export function computeContributionStats(weeks: ContributionWeek[]): ContributionStats {
  const days = weeks.flatMap(w => w.days).filter(d => !d.isFuture)
  const active = days.filter(d => d.cost > 0)
  const total = active.reduce((sum, d) => sum + d.cost, 0)
  const avgActive = active.length === 0 ? 0 : total / active.length
  const peak = active.reduce<ContributionDay | null>(
    (best, d) => (!best || d.cost > best.cost ? d : best),
    null,
  )

  let currentStreak = 0
  for (let i = days.length - 1; i >= 0; i--) {
    if (days[i].cost > 0) currentStreak++
    else break
  }

  return { total, activeDays: active.length, avgActive, peak, currentStreak }
}
