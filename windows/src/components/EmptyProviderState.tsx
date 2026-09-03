import { t } from '../lib/i18n'
import type { Provider } from './AgentTabStrip'
import { providerLabel } from './AgentTabStrip'
import type { Period } from './PeriodTabs'
import { periodPhrase } from './PeriodTabs'
import { TrayIcon } from './Icons'

type Props = {
  provider: Provider
  period: Period
}

export function EmptyProviderState({ provider, period }: Props) {
  return (
    <div className="empty-provider">
      <TrayIcon size={26} className="empty-provider-icon" />
      <div className="empty-provider-text">
        {t('No %1$s data for %2$s', providerLabel(provider), periodPhrase(period))}
      </div>
    </div>
  )
}
