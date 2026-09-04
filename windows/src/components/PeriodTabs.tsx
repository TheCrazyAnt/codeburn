import { useState } from 'react'

import { t } from '../lib/i18n'
import { CalendarIcon } from './Icons'
import { CalendarPopover } from './CalendarPopover'

/// The CLI's six periods. `all` is bounded to the last six months (cli-date.ts);
/// only `lifetime` is everything, which is why the tab is labelled 6M and not
/// All -- for a while it was, and read as the whole history when it was not.
export type Period = 'today' | 'week' | '30days' | 'month' | 'all' | 'lifetime'

const PERIODS: Period[] = ['today', 'week', '30days', 'month', 'all', 'lifetime']

/// Tab title. Compact like the mac strip (Today / 7D / 30D / Month / 6M / Life):
/// six segments plus the calendar button share one narrow row. A function rather
/// than a constant map so the label is translated at render time.
export function periodLabel(p: Period): string {
  switch (p) {
    case 'today': return t('Today')
    case 'week': return t('7D')
    case '30days': return t('30D')
    case 'month': return t('Month')
    case 'all': return t('6M')
    case 'lifetime': return t('Life')
  }
}

/// Short phrase used in sentences ("No Claude data for this month").
export function periodPhrase(p: Period): string {
  switch (p) {
    case 'today': return t('today')
    case 'week': return t('the last 7 days')
    case '30days': return t('the last 30 days')
    case 'month': return t('this month')
    case 'all': return t('the last 6 months')
    case 'lifetime': return t('all time')
  }
}

type Props = {
  selected: Period
  onSelect: (p: Period) => void
  /// A non-empty day selection overrides the period; the calendar button lights
  /// up and no period tab reads as active, the same as `isDayMode` on the mac.
  selectedDays: string[]
  onSelectDays: (days: string[]) => void
}

export function PeriodTabs({ selected, onSelect, selectedDays, onSelectDays }: Props) {
  const [open, setOpen] = useState(false)
  const dayMode = selectedDays.length > 0
  return (
    <div className="period-wrap">
      <nav className="period-tabs" aria-label={t('Period')}>
        {PERIODS.map(p => {
          const active = !dayMode && selected === p
          return (
            <button
              key={p}
              type="button"
              className={`period ${active ? 'period-active' : ''}`}
              aria-pressed={active}
              onClick={() => onSelect(p)}
            >
              {periodLabel(p)}
            </button>
          )
        })}
        <button
          type="button"
          className={`period period-cal ${dayMode ? 'period-active period-cal-on' : ''}`}
          aria-pressed={dayMode}
          aria-label={t('Select days')}
          title={t('Select days')}
          onClick={() => setOpen(o => !o)}
        >
          <CalendarIcon size={12} />
        </button>
      </nav>
      {open && (
        <CalendarPopover
          selected={selectedDays}
          onApply={days => {
            if (days.length > 0) onSelectDays(days)
            else onSelect(selected)
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  )
}
