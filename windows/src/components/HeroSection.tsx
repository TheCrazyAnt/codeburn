import type { MenubarPayload } from '../lib/payload'
import type { CurrencyState } from '../lib/currency'
import { formatCurrency } from '../lib/currency'
import { prettyDate, todayKey } from '../lib/dates'
import { t, tn } from '../lib/i18n'
import { SectionCaption } from './CollapsibleSection'

type Props = {
  payload: MenubarPayload | null
  currency: CurrencyState
  periodLabel: string
  isToday: boolean
}

export function HeroSection({ payload, currency, periodLabel, isToday }: Props) {
  const todayLabel = prettyDate(todayKey())
  const caption = isToday ? t('Today · %s', todayLabel) : (payload?.current.label || periodLabel)

  return (
    <section className="hero">
      <SectionCaption text={caption} />
      <div className="hero-row">
        {payload ? (
          <div className="hero-amount">{formatCurrency(payload.current.cost, currency)}</div>
        ) : (
          <div className="hero-amount hero-skeleton" aria-label={t('Loading')} />
        )}
        <div className="hero-meta">
          {payload ? (
            <>
              <span className="hero-calls">
                {tn('%s call', '%s calls', payload.current.calls, payload.current.calls.toLocaleString())}
              </span>
              <span className="hero-sessions">{tn('%d session', '%d sessions', payload.current.sessions)}</span>
            </>
          ) : (
            <>
              <span className="hero-skeleton-line" />
              <span className="hero-skeleton-line short" />
            </>
          )}
        </div>
      </div>
    </section>
  )
}
