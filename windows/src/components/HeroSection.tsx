import type { MenubarPayload } from '../lib/payload'
import type { CurrencyState } from '../lib/currency'
import { formatCurrency, formatTokens } from '../lib/currency'
import { prettyDate, todayKey } from '../lib/dates'
import { t, tn } from '../lib/i18n'
import { SectionCaption } from './CollapsibleSection'

type Props = {
  payload: MenubarPayload | null
  currency: CurrencyState
  periodLabel: string
  isToday: boolean
}

/// Every token the period moved, cache included -- the CLI's `totalTokens`
/// (`usage-aggregator.ts`) and what the leaderboard reports.
function throughputTokens(payload: MenubarPayload): number {
  const c = payload.current
  return c.inputTokens + c.outputTokens + (c.cacheReadTokens ?? 0) + (c.cacheWriteTokens ?? 0)
}

/// Reads as "new 212.5M (in 108.9M / out 104.2M) · cache 32.1B (read 31.3B / write 835.1M)".
function tokenBreakdown(payload: MenubarPayload): string {
  const c = payload.current
  const cacheRead = c.cacheReadTokens ?? 0
  const cacheWrite = c.cacheWriteTokens ?? 0
  const fresh = t('new %s', formatTokens(c.inputTokens + c.outputTokens))
  const split = t('in %1$s · out %2$s', formatTokens(c.inputTokens), formatTokens(c.outputTokens))
  const cache = t('cache %s', formatTokens(cacheRead + cacheWrite))
  const cacheSplit = t('read %1$s · write %2$s', formatTokens(cacheRead), formatTokens(cacheWrite))
  return `${fresh} (${split}) · ${cache} (${cacheSplit})`
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
              {/* Token usage is the other half of the headline question
                  ("what did I spend, and on how much?"), so it stays beside
                  the amount rather than living only inside the models list.
                  Cache reads are counted because that is what the CLI's own
                  `Tokens` figure counts; leaving them out understates a real
                  corpus by ~100x. The split lives in the tooltip so the
                  headline stays one figure. */}
              <span className="hero-tokens" title={tokenBreakdown(payload)}>
                {t('%s tokens', formatTokens(throughputTokens(payload)))}
              </span>
            </>
          ) : (
            <>
              <span className="hero-skeleton-line" />
              <span className="hero-skeleton-line short" />
              <span className="hero-skeleton-line short" />
            </>
          )}
        </div>
      </div>
    </section>
  )
}
