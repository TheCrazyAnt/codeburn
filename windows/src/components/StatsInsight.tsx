import type { MenubarPayload } from '../lib/payload'
import type { CurrencyState } from '../lib/currency'
import { formatCurrency, formatCompactCurrency } from '../lib/currency'
import { daysInMonth, monthDay } from '../lib/dates'
import { computeHistoryStats } from '../lib/history'
import { t, tn } from '../lib/i18n'
import type { Period } from './PeriodTabs'

type Props = {
  payload: MenubarPayload
  currency: CurrencyState
  period: Period
}

/// Trailing qualifier on the Sessions / Calls rows.
function periodSuffix(period: Period): string {
  switch (period) {
    case 'today': return t('today')
    case 'week': return t('(7 days)')
    case '30days': return t('(30 days)')
    case 'month': return t('(month)')
    case 'all': return t('(all time)')
  }
}

export function StatsInsight({ payload, currency, period }: Props) {
  const s = computeHistoryStats(payload.history.daily)
  const suffix = periodSuffix(period)

  return (
    <div className="stats-insight">
      <div className="stats-grid">
        <div className="stats-col">
          <StatRow label={t('Favorite model')} value={payload.current.topModels[0]?.name ?? '-'} />
          <StatRow label={t('Active days (month)')} value={`${s.activeDaysThisMonth}/${daysInMonth(new Date())}`} />
          <StatRow label={t('Most active day')} value={s.peak ? monthDay(s.peak.date) : '-'} />
          <StatRow label={t('Peak day spend')} value={s.peak ? formatCompactCurrency(s.peak.cost, currency) : '-'} />
        </div>
        <div className="stats-col">
          <StatRow label={t('Sessions %s', suffix)} value={payload.current.sessions.toLocaleString()} />
          <StatRow label={t('Calls %s', suffix)} value={payload.current.calls.toLocaleString()} />
          <StatRow label={t('Current streak')} value={s.currentStreak > 0 ? tn('%d day', '%d days', s.currentStreak) : '-'} />
          <StatRow label={t('Longest streak')} value={s.longestStreak > 0 ? tn('%d day', '%d days', s.longestStreak) : '-'} />
        </div>
      </div>
      {s.trackedDays > 0 && (
        <div className="stats-lifetime">
          <span className="stats-lifetime-label">
            {tn('Tracked spend (last %d day)', 'Tracked spend (last %d days)', s.trackedDays)}
          </span>
          <span className="stats-lifetime-value">
            {formatCurrency(s.trackedTotal, currency)}
          </span>
        </div>
      )}
    </div>
  )
}

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat-row">
      <div className="stat-row-label">{label}</div>
      <div className="stat-row-value">{value}</div>
    </div>
  )
}
