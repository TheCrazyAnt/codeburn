import { useEffect, useState } from 'react'
import { openExternal } from '../lib/openExternal'

import type { CurrencyState } from '../lib/currency'
import { t } from '../lib/i18n'
import {
  DEFAULT_BOARD, DEFAULT_METRIC, LEADERBOARD_BOARDS, LEADERBOARD_METRICS, boardKey, boardLabel,
  formatMetric, isParticipating, metricLabel, metricValue, rankText,
  type LeaderboardBoard, type LeaderboardEntry, type LeaderboardMetric,
} from '../lib/leaderboard'
import type { LeaderboardController } from '../lib/useLeaderboard'
import { readSetting, writeSetting } from '../lib/settings'
import { ChevronDown, RefreshIcon, TrophyIcon } from './Icons'
import { DropMenu } from './DropMenu'
import { LeaderboardAvatar } from './LeaderboardAvatar'

/// Popover "Leaderboard" tab, mirroring `LeaderboardSection.swift`: the top 20
/// for week / month / lifetime ranked by output tokens, spend or streak, with
/// the user's own row pinned at the bottom and a join card while they are not
/// taking part.
///
/// Reading a board is anonymous; nothing on this tab uploads until the user
/// presses Join, which is also what the sign-in card finishes into.

function isBoard(value: string | null): value is LeaderboardBoard {
  return value !== null && (LEADERBOARD_BOARDS as readonly string[]).includes(value)
}

function isMetric(value: string | null): value is LeaderboardMetric {
  return value !== null && (LEADERBOARD_METRICS as readonly string[]).includes(value)
}

type Props = {
  leaderboard: LeaderboardController
  currency: CurrencyState
}

export function LeaderboardInsight({ leaderboard, currency }: Props) {
  const [board, setBoard] = useState<LeaderboardBoard>(() => {
    const saved = readSetting('leaderboardBoard')
    return isBoard(saved) ? saved : DEFAULT_BOARD
  })
  const [metric, setMetric] = useState<LeaderboardMetric>(() => {
    const saved = readSetting('leaderboardMetric')
    return isMetric(saved) ? saved : DEFAULT_METRIC
  })

  const { account, boards, boardErrors, loadingBoards, loadBoard } = leaderboard
  const key = boardKey(board, metric)
  const page = boards[key]
  const error = boardErrors[key]
  const loading = loadingBoards[key] === true

  // One load per (board, metric) pair, re-run when the pair changes. Also
  // re-runs when the account changes, so signing in swaps the anonymous page
  // for one carrying `me`.
  useEffect(() => {
    void loadBoard(board, metric)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board, metric, account?.signedIn, account?.enabled])

  const chooseBoard = (next: LeaderboardBoard) => {
    setBoard(next)
    writeSetting('leaderboardBoard', next)
  }
  const chooseMetric = (next: LeaderboardMetric) => {
    setMetric(next)
    writeSetting('leaderboardMetric', next)
  }

  const participating = isParticipating(account)

  return (
    <div className="leaderboard-insight">
      <div className="lb-toolbar">
        <div className="segmented segmented-compact">
          {LEADERBOARD_BOARDS.map(id => (
            <button
              key={id}
              type="button"
              className={`segment ${board === id ? 'segment-active' : ''}`}
              aria-pressed={board === id}
              onClick={() => chooseBoard(id)}
            >
              {boardLabel(id)}
            </button>
          ))}
        </div>
        <span className="lb-toolbar-spacer" />
        {typeof page?.totalUsers === 'number' && (
          <span className="lb-players">{t('%d players', page.totalUsers)}</span>
        )}
        <DropMenu
          // The toolbar sits at the top of the popover, so this menu opens
          // downwards -- the footer's upward default would land off-screen.
          className="dropmenu-down"
          label={<><span>{metricLabel(metric)}</span><ChevronDown size={9} /></>}
          align="right"
          items={LEADERBOARD_METRICS.map(id => ({ id, label: metricLabel(id), checked: id === metric }))}
          onSelect={id => { if (isMetric(id)) chooseMetric(id) }}
        />
        <button
          type="button"
          className={`btn btn-icon ${loading ? 'btn-spinning' : ''}`}
          title={t('Refresh leaderboard')}
          aria-label={t('Refresh leaderboard')}
          disabled={loading}
          onClick={() => { void loadBoard(board, metric) }}
        >
          <RefreshIcon size={11} />
        </button>
      </div>

      {!participating && <JoinCard leaderboard={leaderboard} />}

      {page ? (
        <>
          {page.entries.length === 0 ? (
            <div className="lb-placeholder">{t('Nobody on the board yet. Be the first.')}</div>
          ) : (
            <div className="lb-rows">
              {page.entries.map(entry => (
                <Row
                  key={`${entry.rank}#${entry.login}`}
                  entry={entry}
                  metric={metric}
                  currency={currency}
                  isMe={entry.login === account?.login}
                />
              ))}
            </div>
          )}
          {error && <div className="lb-error">{error}</div>}
        </>
      ) : error ? (
        <div className="lb-retry">
          <div className="lb-retry-text">{error}</div>
          <button type="button" className="btn" onClick={() => { void loadBoard(board, metric) }}>
            {t('Retry')}
          </button>
        </div>
      ) : (
        <div className="lb-placeholder">{t('Loading leaderboard…')}</div>
      )}

      {participating && account && (
        <div className="lb-footer">
          <span className="lb-rank">{rankText(page?.me?.rank ?? leaderboard.ranks[board])}</span>
          <LeaderboardAvatar url={account.avatarUrl} size={18} />
          <span className="lb-login lb-login-me">{t('You (%s)', account.login ?? '?')}</span>
          <span className="lb-toolbar-spacer" />
          {(() => {
            const value = metricValue(page?.me, metric)
            if (value !== null) return <span className="lb-value">{formatMetric(value, metric, currency)}</span>
            if (!account.lastUploadAt) return <span className="lb-muted">{t('Not ranked yet')}</span>
            return null
          })()}
        </div>
      )}
    </div>
  )
}

function Row({ entry, metric, currency, isMe }: {
  entry: LeaderboardEntry
  metric: LeaderboardMetric
  currency: CurrencyState
  isMe: boolean
}) {
  const value = metricValue(entry, metric) ?? 0
  return (
    <div className={`lb-row ${isMe ? 'lb-row-me' : ''}`}>
      <span className={`lb-rank ${entry.rank <= 3 ? 'lb-rank-top' : ''}`}>{entry.rank}</span>
      <LeaderboardAvatar url={entry.avatarUrl} size={18} />
      <span className={`lb-login ${isMe ? 'lb-login-me' : ''}`}>{entry.login}</span>
      <span className="lb-toolbar-spacer" />
      <span className="lb-value">{formatMetric(value, metric, currency)}</span>
    </div>
  )
}

/// Shown until the user takes part. Sign-in runs right here -- device code plus
/// "Open GitHub" -- instead of sending them to Settings, and finishing it turns
/// sharing on and uploads once, the same one-click join macOS offers.
function JoinCard({ leaderboard }: { leaderboard: LeaderboardController }) {
  const { account, signIn, busy, beginSignIn, abortSignIn, setSharing } = leaderboard
  const [copied, setCopied] = useState(false)
  const [openError, setOpenError] = useState<string | null>(null)

  if (signIn.phase === 'starting') {
    return (
      <div className="lb-join">
        <div className="lb-join-pending">
          <span className="lb-join-title">{t('Requesting a sign-in code…')}</span>
          <span className="lb-toolbar-spacer" />
          <button type="button" className="btn" onClick={() => { void abortSignIn() }}>{t('Cancel')}</button>
        </div>
      </div>
    )
  }

  if (signIn.phase === 'waiting') {
    const uri = signIn.verificationUri ?? 'https://github.com/login/device'
    return (
      <div className="lb-join">
        <div className="lb-join-title">{t('Enter this code on GitHub:')}</div>
        <div className="lb-code-row">
          <span className="lb-code">{signIn.userCode}</span>
          <div className="lb-code-actions">
            <button
              type="button"
              className="btn btn-prominent"
              onClick={() => {
                setOpenError(null)
                void openExternal(uri).catch(err => setOpenError(t('Could not open the browser: %s', String(err))))
              }}
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
        <div className="lb-join-pending">
          <span className="lb-join-note">{t('Waiting for you to authorize in the browser…')}</span>
          <span className="lb-toolbar-spacer" />
          <button type="button" className="btn" onClick={() => { void abortSignIn() }}>{t('Cancel')}</button>
        </div>
        {openError && <div className="lb-join-error" role="alert">{openError}</div>}
        <div className="lb-join-url">{uri}</div>
      </div>
    )
  }

  return (
    <div className="lb-join">
      <div className="lb-join-idle">
        <TrophyIcon size={16} className="lb-join-icon" />
        <div className="lb-join-text">
          <div className="lb-join-title">{t('Join the leaderboard')}</div>
          {signIn.phase === 'failed' ? (
            <div className="lb-join-failed">{t('Sign-in failed: %s', signIn.message ?? '')}</div>
          ) : account?.signedIn ? (
            <div className="lb-join-note">{t('Signed in as %s. Sharing is off.', account.login ?? '?')}</div>
          ) : (
            <div className="lb-join-note">
              {t('Sign in with GitHub to appear here. Only your totals (spend, tokens, calls) are shared, never projects or prompts.')}
            </div>
          )}
        </div>
        {account?.signedIn ? (
          <button
            type="button"
            className="btn btn-prominent"
            disabled={busy !== null}
            onClick={() => { void setSharing(true) }}
          >
            {busy === 'join' ? t('Uploading…') : t('Join')}
          </button>
        ) : (
          <button type="button" className="btn btn-prominent" onClick={() => { void beginSignIn({ thenJoin: true }) }}>
            {signIn.phase === 'failed' ? t('Retry') : t('Sign in with GitHub')}
          </button>
        )}
      </div>
      {leaderboard.actionError && <div className="lb-error">{leaderboard.actionError}</div>}
    </div>
  )
}
