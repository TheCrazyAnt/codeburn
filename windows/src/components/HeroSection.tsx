import type { CombinedUsage, MenubarPayload } from '../lib/payload'
import type { CurrencyState } from '../lib/currency'
import { formatCurrency, formatTokens } from '../lib/currency'
import { prettyDate, todayKey } from '../lib/dates'
import { t, tn } from '../lib/i18n'
import type { Scope } from './ScopeTabs'
import { SectionCaption } from './CollapsibleSection'
import { WarningIcon } from './Icons'

type Props = {
  payload: MenubarPayload | null
  currency: CurrencyState
  periodLabel: string
  isToday: boolean
  scope: Scope
  selectedDays: string[]
  /// The combined fetch failed and what is showing is this machine alone.
  combinedUnavailable: boolean
}

type Totals = {
  cost: number
  calls: number
  sessions: number
  inputTokens: number
  outputTokens: number
  cacheRead: number
  cacheWrite: number
}

/// Every token the period moved, cache included -- the CLI's `totalTokens`
/// (`usage-aggregator.ts`) and what the leaderboard reports.
function throughput(x: Totals): number {
  return x.inputTokens + x.outputTokens + x.cacheRead + x.cacheWrite
}

/// Reads as "new 212.5M (in 108.9M / out 104.2M) · cache 32.1B (read 31.3B / write 835.1M)".
function tokenBreakdown(x: Totals): string {
  const fresh = t('new %s', formatTokens(x.inputTokens + x.outputTokens))
  const split = t('in %1$s · out %2$s', formatTokens(x.inputTokens), formatTokens(x.outputTokens))
  const cache = t('cache %s', formatTokens(x.cacheRead + x.cacheWrite))
  const cacheSplit = t('read %1$s · write %2$s', formatTokens(x.cacheRead), formatTokens(x.cacheWrite))
  return `${fresh} (${split}) · ${cache} (${cacheSplit})`
}

/// Under combined scope the headline is every paired device; otherwise it is
/// this machine. Same choice `HeroTotals` makes on the mac.
function totalsFor(payload: MenubarPayload, combined: CombinedUsage | null): Totals {
  if (combined) {
    const c = combined.combined
    return {
      cost: c.cost, calls: c.calls, sessions: c.sessions,
      inputTokens: c.inputTokens, outputTokens: c.outputTokens,
      cacheRead: c.cacheReadTokens, cacheWrite: c.cacheCreateTokens,
    }
  }
  const c = payload.current
  return {
    cost: c.cost, calls: c.calls, sessions: c.sessions,
    inputTokens: c.inputTokens, outputTokens: c.outputTokens,
    cacheRead: c.cacheReadTokens ?? 0, cacheWrite: c.cacheWriteTokens ?? 0,
  }
}

export function HeroSection({ payload, currency, periodLabel, isToday, scope, selectedDays, combinedUnavailable }: Props) {
  const combined = scope === 'combined' ? (payload?.combined ?? null) : null
  const totals = payload ? totalsFor(payload, combined) : null

  const caption = (() => {
    const label = payload?.current.label || periodLabel
    if (combined) return t('Combined · %s', label)
    if (selectedDays.length === 1) return t('Day (%s)', selectedDays[0])
    if (selectedDays.length > 1) {
      const sorted = [...selectedDays].sort()
      return t('%1$d days (%2$s .. %3$s)', sorted.length, sorted[0], sorted[sorted.length - 1])
    }
    if (isToday) return t('Today · %s', prettyDate(todayKey()))
    return label
  })()

  return (
    <section className="hero">
      <SectionCaption text={caption} />
      <div className="hero-row">
        {totals ? (
          <div className="hero-amount">{formatCurrency(totals.cost, currency)}</div>
        ) : (
          <div className="hero-amount hero-skeleton" aria-label={t('Loading')} />
        )}
        <div className="hero-meta">
          {totals ? (
            <>
              <span className="hero-calls">
                {tn('%s call', '%s calls', totals.calls, totals.calls.toLocaleString())}
              </span>
              <span className="hero-sessions">{tn('%d session', '%d sessions', totals.sessions)}</span>
              {/* Token usage is the other half of the headline question
                  ("what did I spend, and on how much?"), so it stays beside
                  the amount rather than living only inside the models list.
                  Cache reads are counted because that is what the CLI's own
                  `Tokens` figure counts; leaving them out understates a real
                  corpus by ~100x. The split lives in the tooltip so the
                  headline stays one figure. */}
              <span className="hero-tokens" title={tokenBreakdown(totals)}>
                {t('%s tokens', formatTokens(throughput(totals)))}
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

      {combined && <CombinedDeviceBreakdown usage={combined} currency={currency} />}
      {scope === 'combined' && !combined && combinedUnavailable && (
        <div className="hero-note">
          <WarningIcon size={10} />
          <span>{t('Combined unavailable · showing local')}</span>
        </div>
      )}
    </section>
  )
}

/// The per-device split under a combined headline: one row per paired device,
/// with its cost and token volume, and an unreachable device labelled as such
/// rather than silently reported at zero.
function CombinedDeviceBreakdown({ usage, currency }: { usage: CombinedUsage; currency: CurrencyState }) {
  return (
    <div className="hero-devices">
      <div className="hero-devices-head">
        {t('%1$d of %2$d devices', usage.combined.reachableCount, usage.combined.deviceCount)}
      </div>
      <ul className="hero-devices-list">
        {usage.perDevice.map(d => (
          <li key={d.id} className={`hero-device ${d.error ? 'hero-device-error' : ''}`}>
            <span className="hero-device-dot" aria-hidden="true">{d.error ? <WarningIcon size={9} /> : '•'}</span>
            <span className="hero-device-name">{d.local ? t('%s · local', d.name) : d.name}</span>
            <span className="hero-device-cost">{d.error ? t('Unavailable') : formatCurrency(d.cost, currency)}</span>
            <span className="hero-device-tokens">{formatTokens(d.totalTokens)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
