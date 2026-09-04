import { useRef, useState, type WheelEvent } from 'react'
import type { MenubarPayload } from '../lib/payload'
import type { CurrencyState } from '../lib/currency'
import { formatCompactCurrency, formatCurrency } from '../lib/currency'
import { homePath } from '../lib/platform'
import { t, tn } from '../lib/i18n'

export type Provider = 'all' | 'claude' | 'codex' | 'cursor' | 'copilot' | 'opencode' | 'pi'

/// Same order as the macOS ProviderFilter.allCases. Only `all` has a translatable
/// label; the rest are product names.
export const ALL_PROVIDERS: Array<{ id: Provider; label: string }> = [
  { id: 'all',      label: 'All' },
  { id: 'claude',   label: 'Claude' },
  { id: 'codex',    label: 'Codex' },
  { id: 'cursor',   label: 'Cursor' },
  { id: 'copilot',  label: 'Copilot' },
  { id: 'opencode', label: 'OpenCode' },
  { id: 'pi',       label: 'Pi' },
]

export function providerLabel(id: Provider): string {
  return id === 'all' ? t('All') : (ALL_PROVIDERS.find(p => p.id === id)?.label ?? id)
}

/// Where CodeBurn reads that tool's data from, as a noun phrase.
export function providerSource(id: Provider): string {
  switch (id) {
    case 'all': return t('every detected tool')
    case 'claude': return t('Claude Code sessions in %s', homePath('.claude', 'projects'))
    case 'codex': return t('Codex CLI sessions in %s', homePath('.codex', 'sessions'))
    case 'cursor': return t('the Cursor IDE local database')
    case 'copilot': return t('GitHub Copilot session events')
    case 'opencode': return t('OpenCode session storage')
    case 'pi': return t('Pi session logs')
  }
}

/// Providers the CLI detected on this machine (installed, even with zero spend today).
export function detectedProviders(payload: MenubarPayload | null): Provider[] {
  if (!payload) return []
  const detected = payload.current.providers
  return ALL_PROVIDERS.map(p => p.id).filter(id => id !== 'all' && id in detected)
}

type Props = {
  selected: Provider
  onSelect: (p: Provider) => void
  payload: MenubarPayload | null
  currency: CurrencyState
}

/// Every supported tool is listed so the reader can see at a glance which ones CodeBurn
/// is watching. Tools that are not installed are dimmed and explain themselves on hover;
/// detected tools show today's spend and a hover preview with their share.
export function AgentTabStrip({ selected, onSelect, payload, currency }: Props) {
  const [hovered, setHovered] = useState<Provider | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const providers = detectedProviders(payload)
  const costs = payload?.current.providers ?? {}
  const total = providers.reduce((s, id) => s + (costs[id] ?? 0), 0)

  const onWheel = (e: WheelEvent<HTMLDivElement>) => {
    if (scroller.current && e.deltaY !== 0 && e.deltaX === 0) {
      scroller.current.scrollLeft += e.deltaY
    }
  }

  const preview = hovered ? previewFor(hovered, providers, costs, total, currency) : null

  return (
    <div className="agent-tabs-wrap" onMouseLeave={() => setHovered(null)}>
      <nav className="agent-tabs" aria-label={t('Provider')} ref={scroller} onWheel={onWheel}>
        {/* Only tools that have written a session get a tab, as on the mac; the
            strip itself is hidden by the caller when there are none. */}
        {ALL_PROVIDERS.filter(p => p.id === 'all' || providers.includes(p.id)).map(p => {
          const detected = p.id === 'all' ? providers.length > 0 : providers.includes(p.id)
          const cost = p.id === 'all' ? total : (costs[p.id] ?? 0)
          const active = selected === p.id
          return (
            <button
              key={p.id}
              type="button"
              className={`tab ${active ? 'tab-active' : ''} ${detected ? '' : 'tab-muted'}`}
              aria-pressed={active}
              aria-disabled={!detected}
              onMouseEnter={() => setHovered(p.id)}
              onFocus={() => setHovered(p.id)}
              onClick={() => { if (detected) onSelect(p.id) }}
            >
              <span className="tab-label">{providerLabel(p.id)}</span>
              {detected && cost > 0 && (
                <span className="tab-cost">{formatCompactCurrency(cost, currency)}</span>
              )}
            </button>
          )
        })}
      </nav>
      {preview && (
        <div className="tab-preview" role="tooltip">
          <div className="tab-preview-title">{preview.title}</div>
          <div className="tab-preview-body">{preview.body}</div>
        </div>
      )}
    </div>
  )
}

function previewFor(
  id: Provider,
  providers: Provider[],
  costs: Record<string, number>,
  total: number,
  currency: CurrencyState,
): { title: string; body: string } {
  if (id === 'all') {
    if (providers.length === 0) return { title: t('No tools detected yet'), body: t('Run one of the supported tools once, then refresh.') }
    return {
      title: tn(
        '%1$s today across %2$d tool',
        '%1$s today across %2$d tools',
        providers.length,
        formatCurrency(total, currency),
        providers.length,
      ),
      body: providers.map(p => `${providerLabel(p)} ${formatCompactCurrency(costs[p] ?? 0, currency)}`).join(' · '),
    }
  }
  if (!providers.includes(id)) {
    return {
      title: t('%s not detected on this machine', providerLabel(id)),
      body: t('CodeBurn watches %s.', providerSource(id)),
    }
  }
  const cost = costs[id] ?? 0
  const share = total > 0 ? Math.round((cost / total) * 100) : 0
  return {
    title: t('%1$s · %2$s today', providerLabel(id), formatCurrency(cost, currency)),
    body: cost > 0
      ? t("%d%% of today's spend · click to filter every view", share)
      : t('No spend yet today · click to filter every view'),
  }
}
