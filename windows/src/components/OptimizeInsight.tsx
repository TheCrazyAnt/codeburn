import { useState } from 'react'

import type { MenubarPayload, RetryTax, RoutingWaste } from '../lib/payload'
import type { CurrencyState } from '../lib/currency'
import { formatCompactCurrency, formatSmallCurrency } from '../lib/currency'
import { t, tn } from '../lib/i18n'
import { ArrowForward, ChevronRight, RetryIcon, SwapIcon } from './Icons'

/// Popover "Optimize" tab, mirroring `OptimizeInsight` in `HeatmapSection.swift`:
/// the headline "potential savings" (retry tax plus routing waste) with its
/// share of period spend, then the two summaries expanded per model.
///
/// The findings list above them is this app's own addition: `optimize.topFindings`
/// is already in the payload (title, impact, savings -- the CLI emits no detail
/// text for a finding) and the tray app has no other surface for it.

const EMPTY_RETRY_TAX: RetryTax = { totalUSD: 0, retries: 0, editTurns: 0, byModel: [] }
const EMPTY_ROUTING_WASTE: RoutingWaste = {
  totalSavingsUSD: 0,
  baselineModel: '',
  baselineCostPerEdit: 0,
  byModel: [],
}

type Props = {
  payload: MenubarPayload
  currency: CurrencyState
  onOpenTerminal: (args: string[]) => void
}

export function OptimizeInsight({ payload, currency, onOpenTerminal }: Props) {
  const retryTax = payload.current.retryTax ?? EMPTY_RETRY_TAX
  const routingWaste = payload.current.routingWaste ?? EMPTY_ROUTING_WASTE
  const totalWaste = retryTax.totalUSD + routingWaste.totalSavingsUSD
  const cost = payload.current.cost
  const findings = payload.optimize.topFindings ?? []
  const hasAnything = totalWaste > 0 || findings.length > 0

  return (
    <div className="optimize-insight">
      {totalWaste > 0 && cost > 0 && (
        <div className="insight-header">
          <div>
            <div className="insight-sublabel">{t('Potential savings')}</div>
            <div className="insight-hero opt-hero">{formatCompactCurrency(totalWaste, currency)}</div>
          </div>
          <div className="opt-share">
            <div className="opt-share-value">{t('%d%% of spend', Math.round((totalWaste / cost) * 100))}</div>
            <div className="opt-share-note">{t('could be optimized')}</div>
          </div>
        </div>
      )}

      {findings.length > 0 && (
        <div className="opt-findings">
          <div className="opt-section-head">
            <span className="opt-section-title">{t('Top findings')}</span>
            <span className="opt-section-count">
              {tn('%d finding', '%d findings', payload.optimize.findingCount)}
            </span>
          </div>
          {findings.map((finding, i) => (
            <div key={`${i}:${finding.title}`} className="opt-finding">
              <span className={`opt-impact opt-impact-${finding.impact}`} />
              <span className="opt-finding-title">{finding.title}</span>
              {finding.savingsUSD > 0 && (
                <span className="opt-finding-savings">{formatSmallCurrency(finding.savingsUSD, currency)}</span>
              )}
            </div>
          ))}
        </div>
      )}

      {retryTax.totalUSD > 0 && (
        <WasteSection
          tone="retry"
          icon={<RetryIcon size={9} />}
          title={t('Retry tax')}
          total={retryTax.totalUSD}
          totalCost={cost}
          currency={currency}
          note={t('%1$d retries across %2$d edits', retryTax.retries, retryTax.editTurns)}
          rows={retryTax.byModel.map(model => ({
            name: model.name,
            hint: model.retriesPerEdit === null ? null : t('%s ret/edit', model.retriesPerEdit.toFixed(1)),
            value: model.taxUSD,
          }))}
        />
      )}

      {routingWaste.totalSavingsUSD > 0 && (
        <WasteSection
          tone="routing"
          icon={<SwapIcon size={9} />}
          title={t('Routing waste')}
          total={routingWaste.totalSavingsUSD}
          totalCost={cost}
          currency={currency}
          note={routingWaste.baselineModel
            ? t('vs %1$s @ %2$s/edit', routingWaste.baselineModel, formatCompactCurrency(routingWaste.baselineCostPerEdit, currency))
            : null}
          rows={routingWaste.byModel.map(model => ({
            name: model.name,
            hint: t('%s/edit', formatCompactCurrency(model.costPerEdit, currency)),
            value: model.savingsUSD,
          }))}
        />
      )}

      {!hasAnything && (
        <div className="opt-empty">{t('Nothing to optimize in this period.')}</div>
      )}

      <button type="button" className="findings-open-optimize" onClick={() => onOpenTerminal(['optimize'])}>
        <span>{t('Open Full Optimize')}</span>
        <ArrowForward size={9} />
      </button>
    </div>
  )
}

type WasteRow = { name: string; hint: string | null; value: number }

/// The retry-tax and routing-waste blocks are the same shape: a tappable header
/// carrying the total and its share of spend, a one-line explanation, and a
/// per-model breakdown that opens on click.
function WasteSection({ tone, icon, title, total, totalCost, currency, note, rows }: {
  tone: 'retry' | 'routing'
  icon: React.ReactNode
  title: string
  total: number
  totalCost: number
  currency: CurrencyState
  note: string | null
  rows: WasteRow[]
}) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className={`opt-waste opt-waste-${tone}`}>
      <button
        type="button"
        className="opt-waste-head"
        aria-expanded={expanded}
        onClick={() => setExpanded(e => !e)}
      >
        <span className="opt-waste-icon">{icon}</span>
        <span className="opt-waste-title">{title}</span>
        <span className="lb-toolbar-spacer" />
        <span className="opt-waste-total">{formatCompactCurrency(total, currency)}</span>
        {totalCost > 0 && (
          <span className="opt-waste-share">({Math.round((total / totalCost) * 100)}%)</span>
        )}
        <ChevronRight size={9} className={`chevron ${expanded ? 'chevron-open' : ''}`} />
      </button>
      {note && <div className="opt-waste-note">{note}</div>}
      {expanded && (
        <div className="opt-waste-rows">
          {rows.map((row, i) => (
            <div key={`${i}:${row.name}`} className="opt-waste-row">
              <span className="opt-waste-model">{row.name}</span>
              <span className="lb-toolbar-spacer" />
              {row.hint && <span className="opt-waste-hint">{row.hint}</span>}
              <span className="opt-waste-value">{formatCompactCurrency(row.value, currency)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
