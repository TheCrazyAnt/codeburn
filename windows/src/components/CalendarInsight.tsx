import { useMemo, useState } from 'react'

import type { DailyEntry } from '../lib/payload'
import type { CurrencyState } from '../lib/currency'
import { formatCompactCurrency, formatCurrency, formatTokens } from '../lib/currency'
import { buildContributionWeeks, computeContributionStats, type ContributionDay } from '../lib/contributions'
import { monthDay, prettyDate } from '../lib/dates'
import { t } from '../lib/i18n'

/// Popover "Calendar" tab, mirroring the contribution heatmap in
/// `HeatmapSection.swift`: weekday rows by week columns, coloured by spend,
/// with the active-day count in the header and peak / average / streak tiles
/// underneath. The numbers come from `lib/contributions.ts`, a straight port of
/// the macOS maths, so both apps describe the same history identically.

/// macOS sizes the grid from the live width: `floor((width - 26 - 10 + 3) / (8 + 3))`,
/// capped at 52. The tray popover's content column is a fixed 332px (360 minus
/// two 14px gutters), which lands on 27 columns -- a bit over six months.
const WEEK_COLUMNS = 27

/// Only every other weekday is labelled, the same four macOS prints.
const WEEKDAY_LABELS = ['Mon', '', 'Wed', '', 'Fri', '', 'Sun']

type Props = {
  days: DailyEntry[]
  currency: CurrencyState
}

export function CalendarInsight({ days, currency }: Props) {
  const [hoveredDate, setHoveredDate] = useState<string | null>(null)
  const weeks = useMemo(() => buildContributionWeeks(days, WEEK_COLUMNS), [days])
  const stats = useMemo(() => computeContributionStats(weeks), [weeks])
  const hovered = hoveredDate === null
    ? null
    : weeks.flatMap(w => w.days).find(d => d.date === hoveredDate) ?? null

  return (
    <div className="calendar-insight">
      <div className="insight-header">
        <div>
          <div className="insight-sublabel">{t('Daily activity')}</div>
          <div className="insight-hero">{formatCurrency(stats.total, currency)}</div>
        </div>
        <div className="cal-active-days">{t('%d active days', stats.activeDays)}</div>
      </div>

      <div className="cal-grid" onMouseLeave={() => setHoveredDate(null)}>
        <div className="cal-weekdays">
          {WEEKDAY_LABELS.map((label, i) => (
            <span key={i} className="cal-weekday">{label ? t(label) : ''}</span>
          ))}
        </div>
        <div className="cal-weeks">
          {weeks.map(week => (
            <div key={week.startDate} className="cal-week">
              {week.days.map(day => (
                <div
                  key={day.date}
                  className={cellClass(day, hoveredDate === day.date)}
                  title={cellTitle(day, currency)}
                  onMouseEnter={() => setHoveredDate(day.date)}
                />
              ))}
            </div>
          ))}
        </div>
      </div>

      <div className="cal-detail">
        <div className="cal-detail-main">
          <div className="cal-detail-label">{hovered ? prettyDate(hovered.date) : t('Daily detail')}</div>
          <div className="cal-detail-value">{detailValue(hovered, currency)}</div>
        </div>
        <div className="cal-detail-metric">
          <div className="cal-detail-label">{t('Calls')}</div>
          <div className="cal-detail-value">
            {hovered && !hovered.isFuture ? hovered.calls.toLocaleString() : '—'}
          </div>
        </div>
        <div className="cal-detail-metric">
          <div className="cal-detail-label">{t('Tokens')}</div>
          <div className="cal-detail-value">
            {hovered && !hovered.isFuture ? formatTokens(hovered.inputTokens + hovered.outputTokens) : '—'}
          </div>
        </div>
      </div>

      <div className="mini-stats">
        <div className="mini-stat">
          <div className="mini-stat-label">{t('Peak day')}</div>
          <div className="mini-stat-value">
            {stats.peak
              ? t('%1$s on %2$s', formatCompactCurrency(stats.peak.cost, currency), monthDay(stats.peak.date))
              : '—'}
          </div>
        </div>
        <div className="mini-stat">
          <div className="mini-stat-label">{t('Avg active')}</div>
          <div className="mini-stat-value">{formatCompactCurrency(stats.avgActive, currency)}</div>
        </div>
        <div className="mini-stat">
          <div className="mini-stat-label">{t('Streak')}</div>
          <div className="mini-stat-value">{t('%dd', stats.currentStreak)}</div>
        </div>
      </div>
    </div>
  )
}

function cellClass(day: ContributionDay, isHovered: boolean): string {
  return [
    'cal-cell',
    day.isFuture ? 'cal-cell-future' : `cal-cell-l${day.level}`,
    day.isToday ? 'cal-cell-today' : '',
    isHovered ? 'cal-cell-hovered' : '',
  ].filter(Boolean).join(' ')
}

/// Native tooltip text, matching the macOS cell `helpText`.
function cellTitle(day: ContributionDay, currency: CurrencyState): string {
  const date = prettyDate(day.date)
  if (day.isFuture) return t('%s: future day', date)
  if (day.cost <= 0 && day.calls === 0) return t('%s: no tracked usage', date)
  return t(
    '%1$s: %2$s, %3$d calls, %4$s tokens',
    date,
    formatCompactCurrency(day.cost, currency),
    day.calls,
    formatTokens(day.inputTokens + day.outputTokens),
  )
}

function detailValue(day: ContributionDay | null, currency: CurrencyState): string {
  if (!day) return t('Hover a day')
  if (day.isFuture) return t('Future day')
  if (day.cost <= 0 && day.calls === 0) return t('No tracked usage')
  return formatCompactCurrency(day.cost, currency)
}
