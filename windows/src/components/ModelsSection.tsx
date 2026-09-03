import type { Model } from '../lib/payload'
import type { CurrencyState } from '../lib/currency'
import { formatCompactCurrency, formatTokens } from '../lib/currency'
import { t } from '../lib/i18n'
import { CollapsibleSection } from './CollapsibleSection'
import { FixedBar, COL_COST, COL_COUNT } from './ActivitySection'

type Props = {
  models: Model[]
  inputTokens: number
  outputTokens: number
  cacheHitPercent: number
  currency: CurrencyState
}

export function ModelsSection({ models, inputTokens, outputTokens, cacheHitPercent, currency }: Props) {
  if (models.length === 0) return null
  const maxCost = Math.max(...models.map(m => m.cost), 0.01)

  return (
    <CollapsibleSection
      caption={t('Models')}
      columns={[
        { label: t('Cost'), width: COL_COST },
        { label: t('Calls'), width: COL_COUNT },
      ]}
    >
      {models.map(m => (
        <div key={m.name} className="data-row">
          <FixedBar fraction={m.cost / maxCost} />
          <span className="row-name">{m.name}</span>
          <span className="row-cost" style={{ minWidth: COL_COST }}>{formatCompactCurrency(m.cost, currency)}</span>
          <span className="row-count" style={{ minWidth: COL_COUNT }}>{m.calls}</span>
        </div>
      ))}
      {(inputTokens > 0 || outputTokens > 0) && (
        <div className="tokens-line">
          <span className="tokens-label">{t('Tokens')}</span>
          <span className="tokens-value">{t('%s in', formatTokens(inputTokens))}</span>
          <span className="tokens-sep">·</span>
          <span className="tokens-value">{t('%s out', formatTokens(outputTokens))}</span>
          <span className="tokens-sep">·</span>
          <span className="tokens-value">{t('%d%% cache hit', cacheHitPercent)}</span>
        </div>
      )}
    </CollapsibleSection>
  )
}
