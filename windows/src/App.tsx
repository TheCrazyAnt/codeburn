import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

import type { MenubarPayload } from './lib/payload'
import type { CurrencyState } from './lib/currency'
import { USD, formatCurrency, trayBadgeText } from './lib/currency'
import { PayloadCache } from './lib/cache'
import { relativePast } from './lib/dates'
import { applyTheme, currentTheme, readSetting, writeSetting } from './lib/settings'
import { TRAY_BADGE_SUPPORTED } from './lib/platform'
import {
  isLanguageChoice, resolveLanguage, setLanguage, t, useLanguage, type LanguageChoice,
} from './lib/i18n'
import { AgentTabStrip, detectedProviders } from './components/AgentTabStrip'
import type { Provider } from './components/AgentTabStrip'
import { ModelsSection } from './components/ModelsSection'
import { InsightPills, INSIGHT_ORDER, isInsightMode, type InsightMode } from './components/InsightPills'
import { TrendInsight } from './components/TrendInsight'
import { ForecastInsight } from './components/ForecastInsight'
import { PulseInsight } from './components/PulseInsight'
import { StatsInsight } from './components/StatsInsight'
import { PlanInsight } from './components/PlanInsight'
import { CalendarInsight } from './components/CalendarInsight'
import { OptimizeInsight } from './components/OptimizeInsight'
import { LeaderboardInsight } from './components/LeaderboardInsight'
import { useLeaderboard } from './lib/useLeaderboard'
import { FindingsSection } from './components/FindingsSection'
import { ActivitySection } from './components/ActivitySection'
import { LoadingOverlay } from './components/LoadingOverlay'
import { EmptyProviderState } from './components/EmptyProviderState'
import { NoDataState } from './components/NoDataState'
import { SetupState, type CliStatus } from './components/SetupState'
import { StarBanner } from './components/StarBanner'
import { HeroSection } from './components/HeroSection'
import { PeriodTabs, periodLabel } from './components/PeriodTabs'
import type { Period } from './components/PeriodTabs'
import { ScopeTabs, isScope, type Scope } from './components/ScopeTabs'
import { FooterBar } from './components/FooterBar'
import { ErrorToast } from './components/ErrorToast'
import { SettingsPanel, type ThemeChoice } from './components/SettingsPanel'

const payloadCache = new PayloadCache<MenubarPayload>()

/// Everything that decides which CLI query backs the popover.
type Selection = { period: Period; provider: Provider; scope: Scope; days: string[] }

/// Cache key for one selection. A day pick takes the period's slot because the
/// CLI treats `--days` as overriding `--period` -- the period is not sent at all.
function selectionKey(s: Selection): string {
  const when = s.days.length > 0 ? `days:${s.days.join(',')}` : s.period
  return `${when}:${s.provider}:${s.scope}`
}

/// Today across every provider on this machine: what the tray badge, the
/// tooltip and the provider strip read, refreshed even while the popover is
/// hidden.
const TODAY_ALL: Selection = { period: 'today', provider: 'all', scope: 'local', days: [] }
const TODAY_ALL_KEY = selectionKey(TODAY_ALL)

/// Background cadence, mirroring mac/Sources/CodeBurnMenubar/RefreshCadence.swift: every
/// fetch is a full Node process, so the popover being closed has to cost less than it being
/// open. Visible, a tick refreshes today/all plus the selected period/provider with optimize
/// findings; hidden, a slower tick refreshes only today/all and skips optimize, since the
/// tray badge and tooltip are the only things anyone can see. Entries younger than STALE_MS
/// are left alone when the popover is re-opened.
const REFRESH_ACTIVE_MS = 60_000
const REFRESH_IDLE_MS = 120_000
const STALE_MS = 60_000

type FetchOptions = {
  includeOptimize: boolean
  showOverlay: boolean
}

export function App() {
  const [period, setPeriod] = useState<Period>('today')
  const [provider, setProvider] = useState<Provider>('all')
  const [scope, setScope] = useState<Scope>(() => {
    const saved = readSetting('scope')
    return isScope(saved) ? saved : 'local'
  })
  const [selectedDays, setSelectedDays] = useState<string[]>([])
  const [combinedUnavailable, setCombinedUnavailable] = useState(false)
  const [payload, setPayload] = useState<MenubarPayload | null>(null)
  const [todayPayload, setTodayPayload] = useState<MenubarPayload | null>(null)
  const [currency, setCurrency] = useState<CurrencyState>(USD)
  const [overlay, setOverlay] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [insight, setInsight] = useState<InsightMode>(() => {
    const saved = readSetting('insight')
    return isInsightMode(saved) ? saved : 'trend'
  })
  const [cliStatus, setCliStatus] = useState<CliStatus | null>(null)
  const [cliChecking, setCliChecking] = useState(false)
  const [version, setVersion] = useState('')
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [theme, setTheme] = useState(() => currentTheme())
  const [trayBadge, setTrayBadge] = useState(() => TRAY_BADGE_SUPPORTED && readSetting('trayBadge') !== 'off')
  const [showSettings, setShowSettings] = useState(false)
  // The window starts hidden and is shown by a tray click, which emits `codeburn://shown`.
  const [popoverVisible, setPopoverVisible] = useState(false)
  const [themeChoice, setThemeChoice] = useState<ThemeChoice>(() => {
    const saved = readSetting('theme')
    return saved === 'dark' || saved === 'light' ? saved : 'system'
  })
  const [languageChoice, setLanguageChoice] = useState<LanguageChoice>(() => {
    const saved = readSetting('language')
    return isLanguageChoice(saved) ? saved : 'system'
  })

  // Repaints the popover when the language changes under it -- the CLI payload
  // carries `lang`, so the right language usually only arrives after first paint.
  const language = useLanguage()

  /// One leaderboard controller for both the tab and the Settings group, so the
  /// board and the account can never disagree about who is signed in.
  const leaderboard = useLeaderboard()

  // The scope the query actually runs under. Combined reports every provider
  // unfiltered and cannot be narrowed to days -- the CLI refuses both -- so a
  // provider tab or a day pick views this machine, while the user's preference
  // survives for when they return to All. Same call the mac makes in
  // `effectiveSelectedScope`.
  const effectiveScope: Scope = selectedDays.length > 0 || provider !== 'all' ? 'local' : scope
  const current: Selection = { period, provider, scope: effectiveScope, days: selectedDays }
  const currentKey = selectionKey(current)
  const selection = useRef(current)
  selection.current = current

  const fetchKey = useCallback(async (sel: Selection, opts: FetchOptions) => {
    const key = selectionKey(sel)
    if (payloadCache.isInFlight(key)) return
    payloadCache.markInFlight(key)
    const isSelected = () => selectionKey(selection.current) === key
    if (opts.showOverlay && isSelected()) setOverlay(true)
    try {
      const query = (scope: Scope, days: string[]) => invoke<MenubarPayload>('fetch_payload', {
        period: sel.period,
        provider: sel.provider,
        scope,
        days: days.length > 0 ? days.join(',') : null,
        includeOptimize: opts.includeOptimize,
      })
      let json: MenubarPayload
      try {
        json = await query(sel.scope, sel.days)
        if (sel.scope === 'combined' && isSelected()) setCombinedUnavailable(false)
      } catch (err) {
        // Combined needs every paired device to answer. When it cannot, show
        // this machine under the same period and say so -- what the mac does --
        // rather than an error where the number was.
        if (sel.scope !== 'combined') throw err
        json = await query('local', [])
        if (isSelected()) setCombinedUnavailable(true)
      }
      // A quiet (no-optimize) refresh must not wipe findings a previous full fetch had.
      if (!opts.includeOptimize) {
        const previous = payloadCache.get(key)
        if (previous) json.optimize = previous.optimize
      }
      payloadCache.set(key, json)
      if (isSelected()) {
        setPayload(json)
        // "updated Xs ago" describes what the user is looking at, so only a fetch of the
        // visible key may stamp it - a background today/all tick must not.
        setLastUpdated(new Date())
      }
      if (key === TODAY_ALL_KEY) setTodayPayload(json)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes('CLI not found')) {
        const status = await invoke<CliStatus>('cli_status').catch(() => null)
        if (status) setCliStatus(status)
      } else if (isSelected()) {
        setError(message)
      }
    } finally {
      payloadCache.clearInFlight(key)
      if (isSelected()) setOverlay(false)
    }
  }, [])

  const refreshAll = useCallback(async (opts: FetchOptions) => {
    const sel = selection.current
    if (selectionKey(sel) !== TODAY_ALL_KEY) {
      fetchKey(TODAY_ALL, { includeOptimize: false, showOverlay: false })
    }
    await fetchKey(sel, opts)
  }, [fetchKey])

  /// The single source of truth for the CLI gate. Nothing else writes a "compatible"
  /// verdict: a payload that happens to parse does not prove the CLI is new enough, and a
  /// probe from the settings panel must not be able to invent one either.
  const checkCli = useCallback(async () => {
    setCliChecking(true)
    try {
      const status = await invoke<CliStatus>('cli_status')
      setCliStatus(status)
      if (status.found && status.compatible) {
        refreshAll({ includeOptimize: true, showOverlay: true })
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setCliChecking(false)
    }
  }, [refreshAll])

  const cliReady = cliStatus !== null && cliStatus.found && cliStatus.compatible

  // Probe the gate before the first fetch: an old CLI emits a payload missing fields the
  // popover reads, which used to blank the whole window instead of showing the setup screen.
  useEffect(() => {
    invoke<string>('app_version').then(setVersion).catch(() => {})
    checkCli()
    // Startup only; checkCli is re-run from the setup screen and settings on demand.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!cliReady) return
    const tick = popoverVisible
      ? () => refreshAll({ includeOptimize: true, showOverlay: false })
      : () => fetchKey(TODAY_ALL, { includeOptimize: false, showOverlay: false })
    const id = setInterval(tick, popoverVisible ? REFRESH_ACTIVE_MS : REFRESH_IDLE_MS)
    return () => clearInterval(id)
  }, [cliReady, popoverVisible, refreshAll, fetchKey])

  useEffect(() => {
    const cached = payloadCache.get(currentKey)
    setPayload(cached)
    if (!cliReady) return
    const sel = selection.current
    if (!cached) {
      fetchKey(sel, { includeOptimize: true, showOverlay: true })
    } else if (payloadCache.age(currentKey) > STALE_MS) {
      fetchKey(sel, { includeOptimize: true, showOverlay: false })
    }
  }, [currentKey, cliReady, fetchKey])

  useEffect(() => {
    const unlistenRefresh = listen('codeburn://refresh', () => refreshAll({ includeOptimize: true, showOverlay: true }))
    const unlistenShown = listen('codeburn://shown', () => {
      setPopoverVisible(true)
      if (payloadCache.age(selectionKey(selection.current)) > STALE_MS) refreshAll({ includeOptimize: true, showOverlay: false })
    })
    const unlistenHidden = listen('codeburn://hidden', () => setPopoverVisible(false))
    const unlistenTheme = listen('codeburn://toggle-theme', () => toggleTheme())
    return () => {
      unlistenRefresh.then(fn => fn())
      unlistenShown.then(fn => fn())
      unlistenHidden.then(fn => fn())
      unlistenTheme.then(fn => fn())
    }
  }, [refreshAll])

  useEffect(() => {
    const saved = readSetting('theme')
    if (saved === 'dark' || saved === 'light') applyTheme(saved)
    setTheme(currentTheme())
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => setTheme(currentTheme())
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') invoke('hide_popover').catch(() => {})
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // `system` follows the CLI (`codeburn lang`), then the webview locale; an explicit
  // choice in Settings wins over both.
  const payloadLang = todayPayload?.lang ?? payload?.lang ?? null
  useEffect(() => {
    const resolved = resolveLanguage({ chosen: languageChoice, payload: payloadLang })
    setLanguage(resolved)
    // The tray context menu is rendered by Rust, which resolves its own language
    // at startup and would otherwise stay in the old one after a switch here.
    // Sending the already-resolved tag (not the raw choice) is what keeps the two
    // sides from ever disagreeing about what `system` means.
    invoke('set_language', { tag: resolved }).catch(() => {})
  }, [languageChoice, payloadLang])

  const todayCost = todayPayload?.current?.cost ?? null

  useEffect(() => {
    if (todayCost === null) return
    const text = t('CodeBurn · %s today', formatCurrency(todayCost, currency))
    invoke('set_tray_tooltip', { text }).catch(() => {})
    // `language` is a dependency because the tooltip text is translated.
  }, [todayCost, currency, language])

  useEffect(() => {
    if (!TRAY_BADGE_SUPPORTED) return
    const text = trayBadge && todayCost !== null ? trayBadgeText(todayCost, currency) : null
    invoke('set_tray_badge', { text }).catch(err => setError(t('Tray badge: %s', String(err))))
  }, [todayCost, currency, trayBadge])


  const chooseTheme = (choice: ThemeChoice) => {
    applyTheme(choice === 'system' ? null : choice)
    setThemeChoice(choice)
    setTheme(currentTheme())
  }

  const toggleTheme = () => {
    chooseTheme(currentTheme() === 'dark' ? 'light' : 'dark')
  }

  const chooseLanguage = (choice: LanguageChoice) => {
    setLanguageChoice(choice)
    writeSetting('language', choice === 'system' ? null : choice)
  }

  const setTrayBadgePref = (on: boolean) => {
    setTrayBadge(on)
    writeSetting('trayBadge', on ? 'on' : 'off')
  }

  const applyCurrency = async (code: string) => {
    try {
      setCurrency(await invoke<CurrencyState>('set_currency', { code }))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const openTerminal = (args: string[]) => {
    invoke('open_terminal_command', { args }).catch(err => setError(String(err)))
  }
  const connectClaude = () => {
    invoke('open_claude_login').catch(err => setError(String(err)))
  }

  const selectInsight = (mode: InsightMode) => {
    setInsight(mode)
    writeSetting('insight', mode)
  }

  /// Picking a period leaves day mode, as `switchTo(period:)` does on the mac.
  const switchPeriod = (p: Period) => {
    setPeriod(p)
    setSelectedDays([])
  }

  const switchScope = (s: Scope) => {
    setScope(s)
    writeSetting('scope', s === 'local' ? null : s)
    // Combined is every provider, every day of the period: the tab and the day
    // pick that would contradict it are cleared, as the mac does on the same switch.
    if (s === 'combined') {
      setProvider('all')
      setSelectedDays([])
    }
  }

  const providers = detectedProviders(todayPayload)
  // Same gate as `showAgentTabs` on the mac: no strip until some tool has
  // written a session, rather than a row of muted tabs for tools never used.
  const showAgentTabs = providers.length > 0 || detectedProviders(payload).length > 0
  const planVisible = provider === 'claude' || (provider === 'all' && providers.length === 1 && providers[0] === 'claude')
  const visibleModes = useMemo(
    () => INSIGHT_ORDER.filter(m => m !== 'plan' || planVisible),
    [planVisible],
  )
  const activeInsight = visibleModes.includes(insight) ? insight : 'trend'

  const cliBlocked = cliStatus !== null && (!cliStatus.found || !cliStatus.compatible)
  // The version gate above is what keeps these fields present; the optional reads are the
  // backstop that turns a surprising payload into an empty state rather than a blank window.
  const isFilteredEmpty = payload !== null && provider !== 'all'
    && (payload.current?.cost ?? 0) <= 0 && (payload.current?.calls ?? 0) === 0
  const neverAnyData = payload !== null && provider === 'all'
    && (payload.current?.calls ?? 0) === 0 && (payload.current?.sessions ?? 0) === 0
    && (payload.history?.daily?.length ?? 0) === 0

  const footnote = [version ? `CodeBurn v${version}` : 'CodeBurn', lastUpdated ? t('updated %s', relativePast(lastUpdated)) : null]
    .filter(Boolean)
    .join(' · ')

  return (
    <div className="popover">
      <header className="header">
        <div className="brand">
          <span className="brand-primary">Code</span>
          <span className="brand-accent">Burn</span>
        </div>
        <div className="subhead">{t('AI Coding Cost Tracker')}</div>
      </header>

      {!cliBlocked && !showSettings && showAgentTabs && (
        <AgentTabStrip selected={provider} onSelect={setProvider} payload={todayPayload} currency={currency} />
      )}

      <div className="main-content">
        {showSettings ? (
          <SettingsPanel
            onBack={() => setShowSettings(false)}
            version={version}
            currency={currency}
            onCurrency={applyCurrency}
            themeChoice={themeChoice}
            onThemeChoice={chooseTheme}
            trayBadge={trayBadge}
            onTrayBadge={setTrayBadgePref}
            language={languageChoice}
            onLanguage={chooseLanguage}
            cliStatus={cliStatus}
            onCheckCli={checkCli}
            cliChecking={cliChecking}
            leaderboard={leaderboard}
            onQuit={() => invoke('quit_app').catch(() => {})}
          />
        ) : cliBlocked && cliStatus ? (
          <SetupState status={cliStatus} checking={cliChecking} onCheckAgain={checkCli} />
        ) : (
          <>
            <HeroSection
              payload={payload}
              currency={currency}
              periodLabel={periodLabel(period)}
              isToday={period === 'today' && selectedDays.length === 0}
              scope={effectiveScope}
              selectedDays={selectedDays}
              combinedUnavailable={combinedUnavailable}
            />
            <PeriodTabs selected={period} onSelect={switchPeriod} selectedDays={selectedDays} onSelectDays={setSelectedDays} />
            <ScopeTabs selected={effectiveScope} onSelect={switchScope} />

            {isFilteredEmpty ? (
              <EmptyProviderState provider={provider} period={period} />
            ) : (
              <>
                <div className="insight-area">
                  <InsightPills selected={activeInsight} onSelect={selectInsight} modes={visibleModes} />
                  {activeInsight === 'plan' && (
                    <PlanInsight payload={payload} currency={currency} onOpenTerminal={openTerminal} onConnectClaude={connectClaude} />
                  )}
                  {activeInsight === 'trend' && <TrendInsight days={payload?.history?.daily ?? []} currency={currency} />}
                  {activeInsight === 'forecast' && <ForecastInsight days={payload?.history?.daily ?? []} currency={currency} />}
                  {activeInsight === 'calendar' && <CalendarInsight days={payload?.history?.daily ?? []} currency={currency} />}
                  {activeInsight === 'pulse' && payload && <PulseInsight payload={payload} currency={currency} />}
                  {activeInsight === 'stats' && payload && <StatsInsight payload={payload} currency={currency} period={period} />}
                  {activeInsight === 'optimize' && payload && (
                    <OptimizeInsight payload={payload} currency={currency} onOpenTerminal={openTerminal} />
                  )}
                  {activeInsight === 'leaderboard' && <LeaderboardInsight leaderboard={leaderboard} currency={currency} />}
                </div>
                {neverAnyData ? (
                  <NoDataState onRefresh={() => refreshAll({ includeOptimize: true, showOverlay: true })} />
                ) : payload?.current && (
                  <>
                    <ActivitySection payload={payload} currency={currency} />
                    <ModelsSection
                      models={payload.current.topModels}
                      inputTokens={payload.current.inputTokens}
                      outputTokens={payload.current.outputTokens}
                      cacheHitPercent={payload.current.cacheHitPercent}
                      currency={currency}
                    />
                    <FindingsSection payload={payload} currency={currency} onOpenTerminal={openTerminal} />
                  </>
                )}
              </>
            )}
            {overlay && <LoadingOverlay periodLabel={periodLabel(period)} />}
          </>
        )}
      </div>

      <FooterBar
        currency={currency}
        onCurrency={applyCurrency}
        loading={overlay}
        onRefresh={() => refreshAll({ includeOptimize: true, showOverlay: true })}
        onExport={format => openTerminal(['export', '-f', format])}
        onOpenReport={() => openTerminal(['report'])}
        onToggleTheme={toggleTheme}
        onQuit={() => invoke('quit_app').catch(() => {})}
        themeLabel={theme === 'dark' ? t('Switch to light theme') : t('Switch to dark theme')}
        trayBadge={trayBadge}
        onToggleTrayBadge={() => setTrayBadgePref(!trayBadge)}
        onOpenSettings={() => setShowSettings(s => !s)}
        settingsOpen={showSettings}
        footnote={footnote}
      />

      <StarBanner />

      {error && <ErrorToast message={error} onDismiss={() => setError(null)} />}
    </div>
  )
}
