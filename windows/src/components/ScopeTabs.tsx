import { t } from '../lib/i18n'

/// Local is this machine's logs; Combined asks the CLI to merge every device
/// paired with `codeburn devices`. Mirrors `MenubarScope` on macOS.
export type Scope = 'local' | 'combined'

export function isScope(value: unknown): value is Scope {
  return value === 'local' || value === 'combined'
}

const SCOPES: Scope[] = ['local', 'combined']

export function scopeLabel(s: Scope): string {
  return s === 'local' ? t('Local') : t('Combined')
}

type Props = {
  selected: Scope
  onSelect: (s: Scope) => void
}

export function ScopeTabs({ selected, onSelect }: Props) {
  return (
    <div className="scope-wrap">
      <nav className="period-tabs" aria-label={t('Scope')}>
        {SCOPES.map(s => (
          <button
            key={s}
            type="button"
            className={`period ${selected === s ? 'period-active' : ''}`}
            aria-pressed={selected === s}
            onClick={() => onSelect(s)}
          >
            {scopeLabel(s)}
          </button>
        ))}
      </nav>
    </div>
  )
}
