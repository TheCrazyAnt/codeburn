import { useEffect, useMemo, useRef, useState } from 'react'

import { formatDateKey, todayKey } from '../lib/dates'
import { t, useLanguage } from '../lib/i18n'
import { ChevronRight } from './Icons'

/// Multi-day picker under the period strip, a port of the macOS `CalendarPopover`:
/// pick any set of past days, Done sends them as one `--days` selection, Done with
/// nothing picked returns to the period tabs. Weeks start on Monday like the mac.

const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']

type Cell = { id: string; day: number; key: string; currentMonth: boolean }

type Props = {
  selected: string[]
  onApply: (days: string[]) => void
  onClose: () => void
}

export function CalendarPopover({ selected, onApply, onClose }: Props) {
  const language = useLanguage()
  const rootRef = useRef<HTMLDivElement>(null)
  const [pending, setPending] = useState<Set<string>>(() => new Set(selected))
  const [month, setMonth] = useState<Date>(() => {
    const first = [...selected].sort()[0]
    if (first) {
      const [y, m] = first.split('-').map(Number)
      return new Date(y, m - 1, 1)
    }
    const now = new Date()
    return new Date(now.getFullYear(), now.getMonth(), 1)
  })
  const today = todayKey()

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [onClose])

  const monthLabel = useMemo(
    () => new Intl.DateTimeFormat(language === 'zh-CN' ? 'zh-CN' : 'en', { year: 'numeric', month: 'long' }).format(month),
    [month, language],
  )

  const canGoForward = useMemo(() => {
    const next = new Date(month.getFullYear(), month.getMonth() + 1, 1)
    const now = new Date()
    return next <= new Date(now.getFullYear(), now.getMonth(), now.getDate())
  }, [month])

  const cells = useMemo(() => buildCells(month), [month])

  const toggle = (key: string) => {
    if (key > today) return
    setPending(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const summary = pending.size === 0
    ? t('Pick dates')
    : pending.size === 1 ? t('1 day') : t('%d days', pending.size)

  return (
    <div className="calpop" ref={rootRef} role="dialog" aria-label={t('Select days')}>
      <div className="calpop-head">
        <button type="button" className="calpop-nav" onClick={() => setMonth(shift(month, -1))} aria-label={t('Previous month')}>
          <ChevronRight size={10} style={{ transform: 'rotate(180deg)' }} />
        </button>
        <span className="calpop-month">{monthLabel}</span>
        <button type="button" className="calpop-nav" disabled={!canGoForward} onClick={() => setMonth(shift(month, 1))} aria-label={t('Next month')}>
          <ChevronRight size={10} />
        </button>
      </div>
      <div className="calpop-weekdays">
        {WEEKDAYS.map(d => <span key={d}>{t(d)}</span>)}
      </div>
      <div className="calpop-grid">
        {cells.map(c => {
          const isSelected = pending.has(c.key)
          const isToday = c.key === today
          const isFuture = c.key > today
          const cls = [
            'calpop-day',
            isSelected ? 'calpop-day-selected' : '',
            isToday ? 'calpop-day-today' : '',
            isFuture ? 'calpop-day-future' : '',
            c.currentMonth ? '' : 'calpop-day-other',
          ].filter(Boolean).join(' ')
          return (
            <button key={c.id} type="button" className={cls} disabled={isFuture} onClick={() => toggle(c.key)}>
              {c.day}
            </button>
          )
        })}
      </div>
      <div className="calpop-foot">
        {pending.size > 0
          ? <button type="button" className="calpop-clear" onClick={() => setPending(new Set())}>{t('Clear')}</button>
          : <span />}
        <span className="calpop-summary">{summary}</span>
        <button
          type="button"
          className={`btn btn-prominent calpop-done ${pending.size === 0 ? 'calpop-done-muted' : ''}`}
          onClick={() => { onApply([...pending].sort()); onClose() }}
        >
          {t('Done')}
        </button>
      </div>
    </div>
  )
}

function shift(d: Date, months: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + months, 1)
}

/// Six-or-fewer Monday-first rows padded with the neighbouring months' days, the
/// way the mac grid lays them out.
function buildCells(month: Date): Cell[] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1)
  const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()
  let lead = first.getDay() - 1
  if (lead < 0) lead += 7

  const cells: Cell[] = []
  for (let offset = -lead; offset < 0; offset++) {
    const d = new Date(first.getFullYear(), first.getMonth(), 1 + offset)
    cells.push({ id: `prev-${offset}`, day: d.getDate(), key: formatDateKey(d), currentMonth: false })
  }
  for (let day = 1; day <= daysInMonth; day++) {
    const d = new Date(first.getFullYear(), first.getMonth(), day)
    cells.push({ id: `cur-${day}`, day, key: formatDateKey(d), currentMonth: true })
  }
  const remainder = (7 - (cells.length % 7)) % 7
  for (let i = 1; i <= remainder; i++) {
    const d = new Date(first.getFullYear(), first.getMonth(), daysInMonth + i)
    cells.push({ id: `next-${i}`, day: d.getDate(), key: formatDateKey(d), currentMonth: false })
  }
  return cells
}
