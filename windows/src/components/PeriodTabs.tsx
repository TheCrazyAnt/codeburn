import { t } from '../lib/i18n'

export type Period = 'today' | 'week' | '30days' | 'month' | 'all'

const PERIODS: Period[] = ['today', 'week', '30days', 'month', 'all']

/// Tab title. A function rather than a constant map so the label is translated at
/// render time -- the language can arrive after this module was evaluated.
export function periodLabel(p: Period): string {
  switch (p) {
    case 'today': return t('Today')
    case 'week': return t('7 Days')
    case '30days': return t('30 Days')
    case 'month': return t('Month')
    case 'all': return t('All')
  }
}

/// Short phrase used in sentences ("No Claude data for this month").
export function periodPhrase(p: Period): string {
  switch (p) {
    case 'today': return t('today')
    case 'week': return t('the last 7 days')
    case '30days': return t('the last 30 days')
    case 'month': return t('this month')
    case 'all': return t('all time')
  }
}

type Props = {
  selected: Period
  onSelect: (p: Period) => void
}

export function PeriodTabs({ selected, onSelect }: Props) {
  return (
    <div className="period-wrap">
      <nav className="period-tabs" aria-label={t('Period')}>
        {PERIODS.map(p => (
          <button
            key={p}
            type="button"
            className={`period ${selected === p ? 'period-active' : ''}`}
            aria-pressed={selected === p}
            onClick={() => onSelect(p)}
          >
            {periodLabel(p)}
          </button>
        ))}
      </nav>
    </div>
  )
}
