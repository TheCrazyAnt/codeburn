import { useEffect, useState, type ReactNode } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { openUrl } from '@tauri-apps/plugin-opener'
import type { CurrencyState } from '../lib/currency'
import { CURRENCY_CODES } from '../lib/currency'
import { homePath, TRAY_BADGE_SUPPORTED } from '../lib/platform'
import { t, type LanguageChoice } from '../lib/i18n'
import { LEADERBOARD_BOARDS, boardLabel, isParticipating, rankText } from '../lib/leaderboard'
import type { LeaderboardController } from '../lib/useLeaderboard'
import type { CliStatus } from './SetupState'
import { DropMenu } from './DropMenu'
import { LeaderboardAvatar } from './LeaderboardAvatar'
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
  leaderboard: LeaderboardController
  onQuit: () => void
}

export function SettingsPanel({
  onBack, version, currency, onCurrency, themeChoice, onThemeChoice, trayBadge, onTrayBadge,
  language, onLanguage, cliStatus, onCheckCli, cliChecking, leaderboard, onQuit,
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

      <LeaderboardSettings leaderboard={leaderboard} />

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

/// The opt-in leaderboard, mirroring `LeaderboardSettingsTab.swift`: the GitHub
/// account, the sharing toggle with a plain statement of what is and is not
/// uploaded, manual upload with last-result feedback, the spend ranks, and the
/// two privacy controls (sign out, delete my data).
///
/// Nothing here uploads implicitly. The toggle runs `codeburn leaderboard join`
/// / `leave`, and only `join` and "Upload now" ever transmit.
/// An unparseable value is shown as-is rather than as "Invalid Date".
function formatTimestamp(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString()
}

function LeaderboardSettings({ leaderboard }: { leaderboard: LeaderboardController }) {
  const { account, signIn, busy, actionError, ranks, loadRanks } = leaderboard
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [confirmSignOut, setConfirmSignOut] = useState(false)
  const [copied, setCopied] = useState(false)

  // The three ranks are three cheap board reads; only worth doing once the
  // panel is open and there is a session to be ranked under.
  useEffect(() => {
    if (account?.signedIn) void loadRanks()
  }, [account?.signedIn, loadRanks])

  const participating = isParticipating(account)

  const uploadTitle = () => {
    if (!account?.signedIn) return t('Not uploading')
    if (!account.enabled) return t('Sharing is off')
    if (busy === 'upload' || busy === 'join') return t('Uploading…')
    if (account.lastUploadError) return t('Last upload failed')
    return t('Uploading automatically')
  }

  const uploadDetail = () => {
    if (account?.lastUploadError) return account.lastUploadError
    // The CLI stores an ISO timestamp; show it the way the reader's locale
    // writes dates, as the macOS pane does.
    if (account?.lastUploadAt) return t('Last upload %s.', formatTimestamp(account.lastUploadAt))
    if (participating) return t('No upload yet. The first one runs after usage data loads.')
    return t('Sign in and turn on sharing to upload.')
  }

  return (
    <div className="settings-group">
      <div className="settings-group-label">{t('Leaderboard')}</div>

      {account?.signedIn ? (
        <Row label={account.login ?? '?'} hint={t('Signed in with GitHub')}>
          <div className="settings-account">
            <LeaderboardAvatar url={account.avatarUrl} size={22} />
            {confirmSignOut ? (
              <>
                <button
                  type="button"
                  className="btn btn-danger"
                  disabled={busy !== null}
                  onClick={() => { setConfirmSignOut(false); void leaderboard.signOut() }}
                >
                  {t('Sign out')}
                </button>
                <button type="button" className="btn" onClick={() => setConfirmSignOut(false)}>{t('Cancel')}</button>
              </>
            ) : (
              <button type="button" className="btn" disabled={busy !== null} onClick={() => setConfirmSignOut(true)}>
                {t('Sign out')}
              </button>
            )}
          </div>
        </Row>
      ) : signIn.phase === 'waiting' ? (
        <div className="settings-signin">
          <div className="settings-row-label">{t('Enter this code on GitHub to finish signing in:')}</div>
          <div className="lb-code-row">
            <span className="lb-code">{signIn.userCode}</span>
            <div className="lb-code-actions">
              <button
                type="button"
                className="btn btn-prominent"
                onClick={() => { void openUrl(signIn.verificationUri ?? 'https://github.com/login/device') }}
              >
                {t('Open GitHub')}
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  void navigator.clipboard.writeText(signIn.userCode ?? '').then(() => {
                    setCopied(true)
                    window.setTimeout(() => setCopied(false), 1200)
                  })
                }}
              >
                {copied ? t('Copied') : t('Copy code')}
              </button>
            </div>
          </div>
          <div className="settings-row-hint">{t('Waiting for you to authorize in the browser…')}</div>
          <div className="settings-signin-actions">
            <button type="button" className="btn" onClick={() => { void leaderboard.abortSignIn() }}>{t('Cancel')}</button>
          </div>
        </div>
      ) : (
        <Row
          label={signIn.phase === 'failed' ? t('Sign-in failed') : t('Not signed in')}
          hint={signIn.phase === 'failed'
            ? signIn.message ?? ''
            : t('Sign in with your GitHub account to appear on the leaderboard. Only your public login and avatar are used.')}
        >
          <button
            type="button"
            className="btn btn-prominent"
            disabled={signIn.phase === 'starting'}
            onClick={() => { void leaderboard.beginSignIn() }}
          >
            {signIn.phase === 'starting'
              ? t('Requesting a sign-in code…')
              : signIn.phase === 'failed' ? t('Retry') : t('Sign in with GitHub')}
          </button>
        </Row>
      )}

      <Row
        label={t('Share my spend on the public leaderboard')}
        hint={t('The leaderboard is opt-in and public. While sharing is on and you are signed in, CodeBurn uploads a small summary about once an hour.')}
      >
        <Toggle
          on={account?.enabled === true}
          disabled={account === null || busy !== null || !account.signedIn}
          onToggle={() => { void leaderboard.setSharing(!(account?.enabled === true)) }}
        />
      </Row>
      {account?.enabled && !account.signedIn && (
        <div className="settings-error">{t('Sign in with GitHub above to start uploading.')}</div>
      )}

      <div className="settings-privacy">
        <div className="settings-privacy-title">{t('What is uploaded')}</div>
        <ul>
          <li>{t('Total spend in USD for this month and lifetime')}</li>
          <li>{t('Total tokens and call counts for this month and lifetime')}</li>
          <li>{t('Spend split per provider (Claude, Codex, Cursor, …)')}</li>
          <li>{t('Your GitHub login and avatar, and the CodeBurn version')}</li>
        </ul>
        <div className="settings-privacy-title">{t('Never uploaded')}</div>
        <ul>
          <li>{t('Project names, file paths, or branch names')}</li>
          <li>{t('Prompts, transcripts, or session details')}</li>
          <li>{t('Model names, API keys, or any credentials')}</li>
        </ul>
      </div>

      <Row label={uploadTitle()} hint={uploadDetail()}>
        <button
          type="button"
          className="btn"
          disabled={!participating || busy !== null}
          onClick={() => { void leaderboard.upload() }}
        >
          {busy === 'upload' ? t('Uploading…') : t('Upload now')}
        </button>
      </Row>

      <div className="settings-ranks">
        {LEADERBOARD_BOARDS.map(board => (
          <span key={board} className="settings-rank">
            <span className="settings-rank-label">{boardLabel(board)}</span>
            <span className="settings-rank-value">{rankText(ranks[board])}</span>
          </span>
        ))}
      </div>

      <Row
        label={t('Delete my data')}
        hint={t('Removes your account, rank, and every report from the leaderboard server, then signs you out and turns sharing off.')}
      >
        {confirmDelete ? (
          <div className="settings-account">
            <button
              type="button"
              className="btn btn-danger"
              disabled={busy !== null}
              onClick={() => { setConfirmDelete(false); void leaderboard.deleteMyData() }}
            >
              {busy === 'delete' ? t('Deleting…') : t('Delete my data')}
            </button>
            <button type="button" className="btn" onClick={() => setConfirmDelete(false)}>{t('Cancel')}</button>
          </div>
        ) : (
          <button
            type="button"
            className="btn"
            disabled={account?.signedIn !== true || busy !== null}
            onClick={() => setConfirmDelete(true)}
          >
            {t('Delete…')}
          </button>
        )}
      </Row>
      {confirmDelete && (
        <div className="settings-row-hint settings-confirm">
          {t('This removes you from the public leaderboard immediately. Your local CodeBurn data is untouched.')}
        </div>
      )}
      {confirmSignOut && (
        <div className="settings-row-hint settings-confirm">
          {t('Uploads stop until you sign in again. Your entries stay on the board; use Delete my data to remove them.')}
        </div>
      )}

      {actionError && <div className="settings-error">{actionError}</div>}

      <Row
        label={t('Server')}
        hint={t('Override with the `CODEBURN_LEADERBOARD_SERVER` environment variable if you run your own instance.')}
      >
        <span className="settings-server">{account?.server ?? ''}</span>
      </Row>
    </div>
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
