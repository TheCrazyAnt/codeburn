import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { dirname, join } from 'path'

import { Chalk } from 'chalk'

import { getClaudeConfigDirs } from './providers/claude.js'
import { getAllProviders } from './providers/index.js'
import type { Provider } from './providers/types.js'
import { dailyCachePath, isTurnResidueOnly, type DailyEntry } from './daily-cache.js'
import {
  PROVIDER_ENV_VARS,
  PROVIDER_PARSE_VERSIONS,
  loadCache,
  type SessionCache,
} from './session-cache.js'
import { renderTable } from './text-table.js'
import { collectLauncherNotes, type LauncherNote } from './launcher-homes.js'
import { t, tn } from './i18n.js'

// ── Types ──────────────────────────────────────────────────────────────

export type DoctorProbePath = {
  path: string
  label: string
  exists: boolean
}

export type DoctorEnvOverride = {
  name: string
  value: string
}

export type DoctorStatus = 'ok' | 'empty' | 'errors' | 'error' | 'network'

export type DoctorProviderReport = {
  provider: string
  displayName: string
  status: DoctorStatus
  /** Directories/dbs the provider scans, with existence checked (may be empty
   *  for providers that do not expose probeRoots). */
  probePaths: DoctorProbePath[]
  /** Env overrides that are actually set for this provider. */
  envOverrides: DoctorEnvOverride[]
  parseVersion?: string
  /** Session sources discovered (candidate files/dbs). */
  candidatesFound: number
  /** How many discovered sources we attempted to parse (bounded sample). */
  sampled: number
  parsedOk: number
  parseFailed: number
  /** True when we sampled fewer sources than were discovered. */
  bounded: boolean
  /** Files cached for this provider in session-cache.json. */
  cachedFiles: number
  /** Cached entries flagged as parse failures. */
  cachedFailed: number
  /** One-line human verdict. */
  verdict: string
  /** Message when the provider itself threw (status 'error'). */
  error?: string
}

export type ClaudeRetentionNote = {
  /// Effective transcript retention in days. Claude Code deletes session
  /// files older than cleanupPeriodDays at startup; 30 is its default when
  /// the setting is absent.
  effectiveDays: number
  /// True when cleanupPeriodDays is explicitly set in settings.json.
  configured: boolean
  settingsPath: string
}

export type DoctorSessionCacheIssue = {
  provider: string
  /// Session-cache file key (the source path, including any virtual suffix).
  path: string
  reason: 'failed' | 'no-turns'
}

export type DoctorCacheHealth = {
  /// Daily-cache dates whose only content is turn-anchored residue — a day the
  /// parse under-read (isTurnResidueOnly, issue #1127). ensureCacheHydrated
  /// re-derives them on the next launch; they are listed here so the state is
  /// visible without an archaeology dig.
  residueOnlyDays: string[]
  /// Session-cache entries flagged as parse failures or cached with zero
  /// turns — the under-read entries residue days come from.
  sessionCacheIssues: DoctorSessionCacheIssue[]
}

export type DoctorReport = {
  generatedAt: string
  providers: DoctorProviderReport[]
  /** Nests that drive another billed store. Never given a session count. */
  launchers?: LauncherNote[]
  /// Present when the Claude provider is in the report and a config dir was
  /// found. Surfaced because deleted transcripts are unrecoverable: daily
  /// totals survive in CodeBurn's cache, but per-session detail does not.
  claudeRetention?: ClaudeRetentionNote
  /// Present only when there is something to list.
  cacheHealth?: DoctorCacheHealth
}

export type CollectDoctorOptions = {
  /** Injectable provider list (defaults to the real registry). */
  providers?: Provider[]
  /** Injectable cache snapshot (defaults to reading session-cache.json). */
  cache?: SessionCache
  /** Injectable daily-cache days (defaults to reading the daily cache file). */
  dailyCacheDays?: DailyEntry[]
  /** Max discovered sources to parse-sample per provider. */
  sampleLimit?: number
  /** Injectable launcher notes (defaults to scanning the real home). */
  launchers?: LauncherNote[]
}

// Bound the parse sample: at most this many discovered sources per provider,
// truncating each source's yields at PARSE_CALL_CAP. Note the cap bounds the
// yield loop only; eager parsers (codex, cursor) do their full per-file work
// before the first yield, so a very large single source is still parsed whole.
const DEFAULT_SAMPLE_LIMIT = 8
const PARSE_CALL_CAP = 500

// Providers whose parse() has side effects beyond reading: antigravity probes
// for a live language server (spawns ps/lsof and RPCs it when found). A
// diagnostic that promises to be inert must not sample-parse those; discovery
// (readdir/stat only) still runs, so session counts stay meaningful.
const PARSE_SPAWNS = new Set(['antigravity'])

// Vars listed in PROVIDER_ENV_VARS for cache fingerprinting that are NOT
// discovery paths: a change to them can never explain "nothing was
// discovered", so they must never be blamed in a NOTHING FOUND hint.
//   - CODEBURN_CACHE_DIR: CodeBurn's own cache location — where the cache
//     file lives, not where sessions are discovered.
//   - CODEBURN_CURSOR_MAX_BUBBLES: caps how many bubbles Cursor parses
//     (src/providers/cursor.ts:692) — a parse budget, not a discovery root.
//   - KIMI_MODEL_NAME: renames the model attributed to Kimi sessions
//     (src/providers/kimi.ts:155) — attribution, not discovery.
// All three still appear in the Details block; only the verdict's blame line
// is cleared of them.
const NON_DISCOVERY_ENV_VARS = new Set(['CODEBURN_CACHE_DIR', 'CODEBURN_CURSOR_MAX_BUBBLES', 'KIMI_MODEL_NAME'])

// Ambient platform paths (set by the OS or desktop session for everyone), not
// deliberate user overrides: Windows sets APPDATA and LOCALAPPDATA for every
// process, so they carry no user intent and doctor must not name them as an
// override. The XDG_* vars are the opposite — they are opt-in on Linux, so a
// set value IS a deliberate user override and stays visible: with XDG_DATA_HOME
// pointed at a missing dir, blaming the install instead of the override
// (the pre-#920 behavior) told the user the tool was missing when they had
// deliberately relocated it. All of them are still fingerprinted — a change
// to any of them does move the discovery root, so the cache must invalidate —
// and the probed paths doctor already prints show exactly where CodeBurn
// looked.
const AMBIENT_ENV_VARS = new Set(['APPDATA', 'LOCALAPPDATA'])

// Credential names whose VALUE must never be printed: knowing whether the
// credential is set is a useful diagnostic, but the value is a live secret.
// Redact at collect time so BOTH the text render and the JSON report are
// covered, and doctor can never leak a key into a bug report or a paste.
const SECRET_ENV_VARS = new Set(['AI_GATEWAY_API_KEY', 'VERCEL_OIDC_TOKEN'])

// ── Collect (pure, testable) ─────────────────────────────────────────────

function collectEnvOverrides(providerName: string): DoctorEnvOverride[] {
  const vars = PROVIDER_ENV_VARS[providerName] ?? []
  const out: DoctorEnvOverride[] = []
  for (const name of vars) {
    if (AMBIENT_ENV_VARS.has(name)) continue
    const value = process.env[name]
    if (value !== undefined && value !== '') {
      out.push(SECRET_ENV_VARS.has(name) ? { name, value: '<set>' } : { name, value })
    }
  }
  return out
}

async function collectProbePaths(provider: Provider): Promise<DoctorProbePath[]> {
  if (!provider.probeRoots) return []
  const roots = await provider.probeRoots()
  return roots.map(r => ({ path: r.path, label: r.label, exists: existsSync(r.path) }))
}

// A discovered source path can carry a virtual suffix (`<db>#cursor-ws=...`,
// `<db>:<sessionId>`); strip it to the real on-disk path, then to its parent
// dir so many per-session sources collapse to a handful of probed directories.
function realPathOf(sourcePath: string): string {
  const hashIdx = sourcePath.indexOf('#')
  let p = hashIdx > 0 ? sourcePath.slice(0, hashIdx) : sourcePath
  const colonIdx = p.lastIndexOf(':')
  // Keep Windows drive letters (`C:\...`): only strip a colon that is not the
  // drive separator (index > 1).
  if (colonIdx > 1) p = p.slice(0, colonIdx)
  return p
}

function derivePathsFromSources(sourcePaths: string[]): DoctorProbePath[] {
  const dirs = new Set<string>()
  for (const sp of sourcePaths) {
    const real = realPathOf(sp)
    dirs.add(existsSync(real) ? dirname(real) : real)
  }
  return [...dirs].sort().map(path => ({ path, label: 'discovered', exists: existsSync(path) }))
}

function emptyVerdict(
  probePaths: DoctorProbePath[],
  envOverrides: DoctorEnvOverride[],
): string {
  const discoveryOverrides = envOverrides.filter(o => !NON_DISCOVERY_ENV_VARS.has(o.name))
  const overrideNames = discoveryOverrides.map(o => o.name).join(', ')
  const hasOverride = discoveryOverrides.length > 0
  const known = probePaths.filter(p => p.label !== 'discovered')
  const missing = known.filter(p => !p.exists)
  const present = known.filter(p => p.exists)

  // No known probe roots to check: honest, override-aware fallback.
  if (known.length === 0) {
    return hasOverride
      ? t('NOTHING FOUND (override %s set, but nothing was discovered)', overrideNames)
      : t('NOTHING FOUND (tool likely not installed or no history yet)')
  }
  // With an override set, a missing probed path is the likely culprit; name it
  // so the row itself points at the misconfiguration (Details lists them all).
  if (hasOverride) {
    return missing.length > 0
      ? t('NOTHING FOUND (override %s set; %s does not exist)', overrideNames, missing[0]!.path)
      : t('NOTHING FOUND (override %s set; %s holds no sessions)', overrideNames, present[0]!.path)
  }
  // No override. If every probed path is missing, the tool is likely not
  // installed; if some exist, the data dir is there but empty (no history).
  return present.length === 0
    ? t('NOTHING FOUND (%s does not exist; tool likely not installed)', missing[0]!.path)
    : t('NOTHING FOUND (%s exists but holds no sessions; no history yet)', present[0]!.path)
}

async function collectOneProvider(
  provider: Provider,
  cache: SessionCache,
  sampleLimit: number,
): Promise<DoctorProviderReport> {
  const base: DoctorProviderReport = {
    provider: provider.name,
    displayName: provider.displayName,
    status: 'ok',
    probePaths: [],
    envOverrides: collectEnvOverrides(provider.name),
    parseVersion: PROVIDER_PARSE_VERSIONS[provider.name],
    candidatesFound: 0,
    sampled: 0,
    parsedOk: 0,
    parseFailed: 0,
    bounded: false,
    cachedFiles: 0,
    cachedFailed: 0,
    verdict: '',
  }

  const section = cache.providers[provider.name]
  if (section) {
    const files = Object.values(section.files)
    base.cachedFiles = files.length
    base.cachedFailed = files.filter(f => f.failed).length
  }

  // Any single provider throwing (probe, discovery, or a parser) must never
  // crash doctor or blank the other rows: catch and report it as an ERROR row.
  try {
    base.probePaths = await collectProbePaths(provider)

    const sources = await provider.discoverSessions()
    base.candidatesFound = sources.length
    if (base.probePaths.length === 0) {
      base.probePaths = derivePathsFromSources(sources.map(s => s.path))
    }

    // Network providers fetch on parse; doctor runs offline, so we never parse
    // them. Discovery for the one network provider is offline (it only checks
    // for a configured API key), so the count above still means something.
    if (provider.network) {
      base.status = 'network'
      base.verdict = base.candidatesFound > 0
        ? t('NETWORK (%d source configured; parse skipped offline)', base.candidatesFound)
        : t('NETWORK (not configured; no API key)')
      return base
    }

    if (sources.length > 0 && PARSE_SPAWNS.has(provider.name)) {
      base.status = 'ok'
      base.verdict = tn(
        'OK (%d session; parse sample skipped, provider probes live processes)',
        'OK (%d sessions; parse sample skipped, provider probes live processes)',
        sources.length,
      )
      return base
    }

    if (sources.length > 0) {
      const sample = sources.slice(0, sampleLimit)
      base.bounded = sample.length < sources.length
      const seenKeys = new Set<string>()
      for (const source of sample) {
        base.sampled++
        try {
          const parser = provider.createSessionParser(source, seenKeys)
          let n = 0
          for await (const _call of parser.parse()) {
            if (++n >= PARSE_CALL_CAP) break
          }
          base.parsedOk++
        } catch {
          base.parseFailed++
        }
      }
    }

    if (base.parseFailed > 0) {
      base.status = 'errors'
      base.verdict = tn(
        'ERRORS (%d/%d sampled file failed to parse)',
        'ERRORS (%d/%d sampled files failed to parse)',
        base.sampled,
        base.parseFailed,
        base.sampled,
      )
    } else if (base.candidatesFound === 0) {
      base.status = 'empty'
      base.verdict = emptyVerdict(base.probePaths, base.envOverrides)
    } else {
      base.status = 'ok'
      base.verdict = tn('OK (%d session)', 'OK (%d sessions)', base.candidatesFound)
    }
  } catch (err) {
    base.status = 'error'
    base.error = err instanceof Error ? err.message : String(err)
    base.verdict = t('ERROR (%s)', base.error)
  }

  return base
}

export async function collectDoctorReport(
  providerFilter?: string,
  opts: CollectDoctorOptions = {},
): Promise<DoctorReport> {
  const all = opts.providers ?? await getAllProviders()
  const filtered = providerFilter && providerFilter !== 'all'
    ? all.filter(p => p.name === providerFilter)
    : all
  const cache = opts.cache ?? await loadCache()
  const sampleLimit = opts.sampleLimit ?? DEFAULT_SAMPLE_LIMIT

  // Doctor promises to be strictly read-only, but sample-parsing drives real
  // provider parsers, and cursor's writes its results cache to disk before its
  // first yield. The flag tells cache writers to stand down for this process
  // while doctor collects; restored afterwards so long-lived embedders (tests,
  // MCP) keep normal behavior.
  const prevSuppress = process.env['CODEBURN_SUPPRESS_CACHE_WRITES']
  process.env['CODEBURN_SUPPRESS_CACHE_WRITES'] = '1'
  try {
    const providers: DoctorProviderReport[] = []
    for (const provider of filtered) {
      providers.push(await collectOneProvider(provider, cache, sampleLimit))
    }
    providers.sort((a, b) => (a.displayName < b.displayName ? -1 : a.displayName > b.displayName ? 1 : 0))

    const report: DoctorReport = { generatedAt: new Date().toISOString(), providers }
    const launchers = opts.launchers ?? collectLauncherNotes()
    if (launchers.length > 0) report.launchers = launchers
    if (providers.some(p => p.provider === 'claude')) {
      const retention = await collectClaudeRetention()
      if (retention) report.claudeRetention = retention
    }
    const residueOnlyDays = collectResidueOnlyDays(opts.dailyCacheDays ?? await readDailyCacheDays())
    const sessionCacheIssues = collectSessionCacheIssues(cache)
    if (residueOnlyDays.length > 0 || sessionCacheIssues.length > 0) {
      report.cacheHealth = { residueOnlyDays, sessionCacheIssues }
    }
    return report
  } finally {
    if (prevSuppress === undefined) delete process.env['CODEBURN_SUPPRESS_CACHE_WRITES']
    else process.env['CODEBURN_SUPPRESS_CACHE_WRITES'] = prevSuppress
  }
}

// Claude Code's documented default when cleanupPeriodDays is absent.
const CLAUDE_DEFAULT_CLEANUP_DAYS = 30
// Below this, long-horizon views depend entirely on CodeBurn's daily cache;
// the doctor line turns into a warning.
const CLAUDE_RETENTION_WARN_DAYS = 365

/// Read-only peek at the daily cache's days: loadDailyCache can WRITE
/// (adoption / migration), which doctor's read-only promise forbids, so the
/// file is read and parsed directly. Anything unreadable or foreign simply
/// yields no days — doctor must never crash on a corrupt cache.
async function readDailyCacheDays(): Promise<DailyEntry[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(dailyCachePath(), 'utf-8'))
    const days = (parsed as { days?: unknown } | null)?.days
    if (!Array.isArray(days)) return []
    return days.filter((d): d is DailyEntry => !!d && typeof d === 'object' && typeof (d as DailyEntry).date === 'string')
  } catch {
    return []
  }
}

function collectResidueOnlyDays(days: DailyEntry[]): string[] {
  const out: string[] = []
  for (const d of days) {
    try {
      if (isTurnResidueOnly(d)) out.push(d.date)
    } catch {
      // Foreign junk in a hand-edited cache: skip the day, keep diagnosing.
    }
  }
  return out.sort()
}

function collectSessionCacheIssues(cache: SessionCache): DoctorSessionCacheIssue[] {
  const out: DoctorSessionCacheIssue[] = []
  for (const [provider, section] of Object.entries(cache.providers)) {
    for (const [path, f] of Object.entries(section.files)) {
      // A failed entry carries no turns by construction; report it once, as failed.
      if (f.failed) out.push({ provider, path, reason: 'failed' })
      else if (Array.isArray(f.turns) && f.turns.length === 0) out.push({ provider, path, reason: 'no-turns' })
    }
  }
  return out
}

async function collectClaudeRetention(): Promise<ClaudeRetentionNote | undefined> {
  for (const dir of await getClaudeConfigDirs()) {
    const settingsPath = join(dir, 'settings.json')
    let raw: string
    try {
      raw = await readFile(settingsPath, 'utf-8')
    } catch {
      continue
    }
    try {
      const parsed: unknown = JSON.parse(raw)
      const days = (parsed as Record<string, unknown> | null)?.['cleanupPeriodDays']
      if (typeof days === 'number' && Number.isFinite(days)) {
        return { effectiveDays: days, configured: true, settingsPath }
      }
      return { effectiveDays: CLAUDE_DEFAULT_CLEANUP_DAYS, configured: false, settingsPath }
    } catch {
      // Unparseable settings: report the default; Claude Code would apply it too.
      return { effectiveDays: CLAUDE_DEFAULT_CLEANUP_DAYS, configured: false, settingsPath }
    }
  }
  return undefined
}

// ── Render ────────────────────────────────────────────────────────────────

export function renderDoctorJson(report: DoctorReport): string {
  return JSON.stringify(report, null, 2)
}

export function renderDoctorTable(
  report: DoctorReport,
  opts: { color?: boolean } = {},
): string {
  const c = new Chalk(opts.color === false ? { level: 0 } : {})
  const out: string[] = []

  const n = report.providers.length
  out.push(c.bold(t('CodeBurn doctor')) + c.dim(`   ${tn('%d provider', '%d providers', n)}   ${report.generatedAt.slice(0, 19).replace('T', ' ')} UTC`))
  out.push('')

  const colorVerdict = (r: DoctorProviderReport): string => {
    if (r.status === 'ok') return c.green(r.verdict)
    if (r.status === 'network') return c.cyan(r.verdict)
    if (r.status === 'empty') return c.yellow(r.verdict)
    return c.red(r.verdict)
  }

  const rows = report.providers.map(r => [
    r.displayName,
    r.status === 'network' ? '-' : String(r.candidatesFound),
    r.status === 'network' || r.sampled === 0 ? '-' : `${r.parsedOk}/${r.sampled}${r.bounded ? '+' : ''}`,
    String(r.cachedFiles),
    colorVerdict(r),
  ])

  out.push(renderTable(
    [
      { header: t('Provider') },
      { header: t('Sessions'), right: true },
      { header: t('Parsed'), right: true },
      { header: t('Cached'), right: true },
      { header: t('Verdict') },
    ],
    rows,
    { color: opts.color },
  ))

  // Detail: show the exact probed paths + overrides only where there is
  // something diagnostic to show (known probe roots, an override, a hard
  // error, or cached parse failures), so a wrong path is spotted at a glance
  // without a wall of empty blocks for tools that are simply not installed.
  const detail = report.providers.filter(
    r =>
      r.status === 'error' ||
      r.status === 'errors' ||
      r.envOverrides.length > 0 ||
      r.cachedFailed > 0 ||
      r.probePaths.some(p => p.label !== 'discovered'),
  )
  if (detail.length > 0) {
    out.push('')
    out.push(c.bold(t('Details')))
    for (const r of detail) {
      out.push('  ' + c.bold(r.displayName))
      for (const o of r.envOverrides) {
        out.push('    ' + c.dim(t('override') + ' ') + `${o.name}=${o.value}`)
      }
      for (const p of r.probePaths) {
        const mark = p.exists ? c.green(t('exists')) : c.red(t('missing'))
        out.push('    ' + c.dim(`${p.label}: `) + p.path + ' ' + c.dim('(') + mark + c.dim(')'))
      }
      if (r.parseVersion) out.push('    ' + c.dim(t('parser:') + ' ') + r.parseVersion)
      if (r.cachedFailed > 0) out.push('    ' + c.dim(t('cached parse failures:') + ' ') + String(r.cachedFailed))
      if (r.error) out.push('    ' + c.red(t('error:') + ' ') + r.error)
    }
  }

  if (report.launchers && report.launchers.length > 0) {
    out.push('')
    out.push(c.bold(t('Launchers')))
    for (const launcher of report.launchers) {
      out.push(`  ${launcher.name}  ${c.dim(launcher.path)}  ${launcher.verdict}`)
    }
  }

  if (report.cacheHealth) {
    out.push('')
    out.push(c.bold(t('Cache health')) + c.dim('  ' + t('(issue #1127 diagnostics — under-read cache entries)')))
    for (const date of report.cacheHealth.residueOnlyDays) {
      out.push('  ' + c.yellow(date) + c.dim('  ' + t('residue-only day (turn counts but no calls/cost); re-derived on next launch')))
    }
    for (const issue of report.cacheHealth.sessionCacheIssues) {
      out.push(
        '  ' + c.dim(`${issue.provider}  `) + issue.path +
        c.dim('  ' + (issue.reason === 'failed' ? t('(cached parse failure)') : t('(cached with 0 turns)'))),
      )
    }
  }

  if (report.claudeRetention) {
    const r = report.claudeRetention
    const source = r.configured ? 'cleanupPeriodDays' : t('cleanupPeriodDays not set; Claude Code default')
    const line = tn(
      'Claude Code deletes transcripts after %s day (%s).',
      'Claude Code deletes transcripts after %s days (%s).',
      r.effectiveDays,
      r.effectiveDays,
      source,
    )
    out.push('')
    if (r.effectiveDays < CLAUDE_RETENTION_WARN_DAYS) {
      out.push(
        c.yellow(line) + ' ' +
        t('Daily totals survive in CodeBurn\'s cache, but per-session detail older than that is gone for good. To keep it, set "cleanupPeriodDays": 3650 in %s.', r.settingsPath),
      )
    } else {
      out.push(c.dim(line + ' ' + t('Long transcript retention: per-session detail is preserved.')))
    }
  }

  out.push('')
  const broken = report.providers.filter(r => r.status === 'error' || r.status === 'errors')
  const empty = report.providers.filter(r => r.status === 'empty')
  const ok = report.providers.filter(r => r.status === 'ok')
  out.push(
    c.dim(t('Bottom line:') + ' ') +
    t('%d OK, %d with nothing found, %d with errors.', ok.length, empty.length, broken.length),
  )

  return out.join('\n') + '\n'
}
