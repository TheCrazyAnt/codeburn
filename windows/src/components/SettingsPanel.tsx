import { useEffect, useState, type ReactNode } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { openUrl } from '@tauri-apps/plugin-opener'
import type { CurrencyState } from '../lib/currency'
import { CURRENCY_CODES } from '../lib/currency'
import { homePath, TRAY_BADGE_SUPPORTED } from '../lib/platform'
import { t, type LanguageChoice } from '../lib/i18n'
import type { CliStatus } from './SetupState'
import { DropMenu } from './DropMenu'
import { ChevronDown, ChevronRight } from './Icons'

/// Preferences that have no home in the popover proper. Deliberately small: the mac app has
/// no settings window at all, so everything here is a Windows/Linux need (login item, tray
/// text) or a convenience the footer already offers in a smaller form.

export type ThemeChoice = 'system' | 'light' | 'dark'

const GITHUB_URL = 'https://github.com/TheCrazyAnt/codeburn'
// MIT 要求保留原作者信息，关于页里给出上游仓库入口。
const UPSTREAM_URL = 'https://github.com/getagentseal/codeburn'

type Props = {
  onBack: () => void
  version: string
  currency: CurrencyState
  onCurrency: (code: string) => void
  themeChoice: ThemeChoice
  onThemeChoice: (t: ThemeChoice) => void
  trayBadge: boolean
  onTrayBadge: (on: boolean) => void
  language: LanguageChoice
  onLanguage: (l: LanguageChoice) => void
  cliStatus: CliStatus | null
  onCheckCli: () => void
  cliChecking: boolean
  onQuit: () => void
}

export function SettingsPanel({
  onBack, version, currency, onCurrency, themeChoice, onThemeChoice, trayBadge, onTrayBadge,
  language, onLanguage, cliStatus, onCheckCli, cliChecking, onQuit,
}: Props) {
  const [loginItem, setLoginItem] = useState<boolean | null>(null)
  const [loginError, setLoginError] = useState<string | null>(null)

  // No CLI probe here: App owns the gate and probes it on mount, so the panel only ever
  // displays what that probe found. Its own probe could otherwise fail transiently and drop
  // a working app onto the setup screen.
  useEffect(() => {
    invoke<boolean>('launch_at_login').then(setLoginItem).catch(() => setLoginItem(false))
  }, [])

  const toggleLogin = async () => {
    if (loginItem === null) return
    setLoginError(null)
    try {
      setLoginItem(await invoke<boolean>('set_launch_at_login', { enabled: !loginItem }))
    } catch (err) {
      setLoginError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <section className="settings">
      <div className="settings-head">
        <button type="button" className="btn btn-icon" onClick={onBack} aria-label={t('Back')}>
          <ChevronRight size={11} style={{ transform: 'rotate(180deg)' }} />
        </button>
        <span className="settings-title">{t('Settings')}</span>
      </div>

      <div className="settings-group">
        <div className="settings-group-label">{t('General')}</div>
        <Row label={t('Launch at login')} hint={t('Start CodeBurn in the tray when you sign in.')}>
          <Toggle on={loginItem === true} disabled={loginItem === null} onToggle={toggleLogin} />
        </Row>
        {loginError && <div className="settings-error">{loginError}</div>}
        {TRAY_BADGE_SUPPORTED && (
          <Row label={t("Show today's cost in the tray")} hint={t('A second tray icon carrying the number, next to the logo.')}>
            <Toggle on={trayBadge} onToggle={() => onTrayBadge(!trayBadge)} />
          </Row>
        )}
      </div>

      <div className="settings-group">
        <div className="settings-group-label">{t('Appearance')}</div>
        <Row label={t('Theme')}>
          <div className="segmented">
            {(['system', 'light', 'dark'] as ThemeChoice[]).map(choice => (
              <button
                key={choice}
                type="button"
                className={`segment ${themeChoice === choice ? 'segment-active' : ''}`}
                aria-pressed={themeChoice === choice}
                onClick={() => onThemeChoice(choice)}
              >
                {choice === 'system' ? t('System') : choice === 'light' ? t('Light') : t('Dark')}
              </button>
            ))}
          </div>
        </Row>
        <Row
          label={t('Language')}
          hint={t('Overrides the language `codeburn lang` resolved for the CLI. Applies right away.')}
        >
          <div className="segmented">
            {(['system', 'en', 'zh-CN'] as LanguageChoice[]).map(choice => (
              <button
                key={choice}
                type="button"
                className={`segment ${language === choice ? 'segment-active' : ''}`}
                aria-pressed={language === choice}
                onClick={() => onLanguage(choice)}
              >
                {choice === 'system' ? t('System') : choice === 'en' ? 'English' : '简体中文'}
              </button>
            ))}
          </div>
        </Row>
        <Row label={t('Currency')} hint={t('Shared with the CLI via %s.', homePath('.config', 'codeburn', 'config.json'))}>
          <DropMenu
            label={<><span>{currency.code}</span><ChevronDown size={10} /></>}
            items={CURRENCY_CODES.map(c => ({ id: c, label: c, checked: c === currency.code }))}
            columns={3}
            align="right"
            onSelect={onCurrency}
          />
        </Row>
      </div>

      <div className="settings-group">
        <div className="settings-group-label">{t('Data source')}</div>
        <Row
          label="CodeBurn CLI"
          hint={cliStatus?.found
            ? t('Version %1$s · %2$s', cliStatus.version ?? '?', cliStatus.program)
            : t('Not found on this machine.')}
        >
          <button type="button" className="btn" onClick={onCheckCli} disabled={cliChecking}>
            {cliChecking ? t('Checking…') : t('Check again')}
          </button>
        </Row>
      </div>

      <div className="settings-group">
        <div className="settings-group-label">{t('About')}</div>
        <Row label={`CodeBurn Desktop ${version ? `v${version}` : ''}`} hint={t('Tracks AI coding spend from local session logs. Nothing leaves this machine except the Claude usage check.')}>
          <button type="button" className="btn" onClick={() => openUrl(GITHUB_URL)}>GitHub</button>
        </Row>
        <Row label={t('Simplified Chinese build')} hint={t('Based on getagentseal/codeburn by Resham Joshi (iamtoruk) · AgentSeal. MIT License.')}>
          <button type="button" className="btn" onClick={() => openUrl(UPSTREAM_URL)}>{t('Upstream')}</button>
        </Row>
        <Row label={t('Quit CodeBurn')} hint={t('Removes the tray icon until you launch it again.')}>
          <button type="button" className="btn" onClick={onQuit}>{t('Quit')}</button>
        </Row>
      </div>
    </section>
  )
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="settings-row">
      <div className="settings-row-text">
        <div className="settings-row-label">{label}</div>
        {hint && <div className="settings-row-hint">{hint}</div>}
      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  )
}

function Toggle({ on, disabled = false, onToggle }: { on: boolean; disabled?: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      className={`toggle ${on ? 'toggle-on' : ''}`}
      disabled={disabled}
      onClick={onToggle}
    >
      <span className="toggle-knob" />
    </button>
  )
}
