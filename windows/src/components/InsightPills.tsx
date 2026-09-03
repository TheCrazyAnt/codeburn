import { t } from '../lib/i18n'

export type InsightMode = 'plan' | 'trend' | 'forecast' | 'pulse' | 'stats'

/// Same order as the macOS InsightMode enum: Plan first when it is visible.
export const INSIGHT_ORDER: InsightMode[] = ['plan', 'trend', 'forecast', 'pulse', 'stats']

export function insightLabel(m: InsightMode): string {
  switch (m) {
    case 'plan': return t('Plan')
    case 'trend': return t('Trend')
    case 'forecast': return t('Forecast')
    case 'pulse': return t('Pulse')
    case 'stats': return t('Stats')
  }
}

export function isInsightMode(value: string | null): value is InsightMode {
  return value !== null && (INSIGHT_ORDER as string[]).includes(value)
}

type Props = {
  selected: InsightMode
  onSelect: (m: InsightMode) => void
  modes: InsightMode[]
}

export function InsightPills({ selected, onSelect, modes }: Props) {
  return (
    <div className="insight-pills" role="tablist">
      {modes.map(m => (
        <button
          key={m}
          type="button"
          role="tab"
          aria-selected={selected === m}
          className={`insight-pill ${selected === m ? 'insight-pill-active' : ''}`}
          onClick={() => onSelect(m)}
        >
          {insightLabel(m)}
        </button>
      ))}
    </div>
  )
}
