import chalk from 'chalk'
import type { ProjectSummary } from './types.js'
import { behavioralCallCount } from './behavioral-weight.js'
import { t } from './i18n.js'

// Re-exported from currency.ts so existing imports from './format.js' keep working.
// The currency-aware version applies exchange rate and symbol automatically.
// Imported locally too since renderStatusBar below uses it directly.
import { formatCost } from './currency.js'
export { formatCost }

/// Terminal cells one code point occupies. East Asian Wide and Fullwidth code
/// points take two, so counting characters would misalign every column to the
/// right of a translated header or label. ASCII, Latin and the box-drawing
/// characters these tables use all stay at 1, so English output is unchanged.
function charCells(cp: number): number {
  const wide =
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK radicals, Kangxi, CJK symbols/punctuation
    (cp >= 0x3041 && cp <= 0x33ff) || // Kana, Hangul Compatibility Jamo, CJK compatibility
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Unified Ideographs Extension A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified Ideographs
    (cp >= 0xa000 && cp <= 0xa4cf) || // Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compatibility Ideographs
    (cp >= 0xfe30 && cp <= 0xfe6f) || // CJK Compatibility Forms, small form variants
    (cp >= 0xff00 && cp <= 0xff60) || // Fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) || // Fullwidth signs
    (cp >= 0x20000 && cp <= 0x3fffd)  // CJK Unified Ideographs Extension B and beyond
  return wide ? 2 : 1
}

/// Width of `value` in terminal cells. Equal to `value.length` for ASCII.
export function displayWidth(value: string): number {
  let width = 0
  for (const char of value) width += charCells(char.codePointAt(0)!)
  return width
}

/// `String.padEnd` measured in terminal cells.
export function padCells(value: string, width: number, fill = ' '): string {
  return value + fill.repeat(Math.max(0, width - displayWidth(value)))
}

/// Cuts `value` down to `width` terminal cells without splitting a wide
/// character. When `ellipsis` is set, an over-long value ends with it and the
/// result still fits inside `width`.
export function truncateToWidth(value: string, width: number, ellipsis = ''): string {
  if (displayWidth(value) <= width) return value
  const budget = Math.max(0, width - displayWidth(ellipsis))
  let out = ''
  let used = 0
  for (const char of value) {
    const cells = charCells(char.codePointAt(0)!)
    if (used + cells > budget) break
    out += char
    used += cells
  }
  return out + ellipsis
}

/// Translates a period label built by cli-date's `getDateRange`. Those labels
/// stay English at the source because they travel in the app payload, where the
/// macOS side runs its own lookup; only what the terminal prints is translated,
/// and only here, so every report header agrees. An unrecognized label (a
/// `--from`/`--to` range, a localized month name) passes through untouched.
export function periodLabelForDisplay(label: string): string {
  const dated = /^(Today|Yesterday) \((\d{4}-\d{2}-\d{2})\)$/.exec(label)
  if (dated) return t(`${dated[1]} (%s)`, dated[2])
  return t(label)
}

/// Prefix a formatted cost with the estimated marker (`~`) when the figure is
/// priced from estimated tokens rather than metered. Keeps the marker identical
/// across the report, overview, and MCP surfaces so a legend line can explain it
/// once. `isEstimated` is typically `entry.estimatedCostUSD > 0`.
export function markEstimated(costStr: string, isEstimated: boolean): string {
  return isEstimated ? `~${costStr}` : costStr
}

/// Shared wording for the durable-cache carry-forward footnote: some of a
/// period's total came from days whose session logs have since expired, but
/// the figure is real (preserved in the durable daily cache). overview.ts and
/// dashboard.tsx both show this so a headline that includes carried days
/// doesn't read as inconsistent with detail views that can only see
/// surviving session files.
export function carriedCostNote(carriedCostUSD: number): string | null {
  return carriedCostUSD > 0 ? t('includes %s preserved from expired session logs', formatCost(carriedCostUSD)) : null
}

export function formatTokens(n: number): string {
  // Guard against Infinity / NaN / negatives that would otherwise leak into
  // the UI as "Infinity" or "NaN" strings when an upstream calculation glitches.
  if (!Number.isFinite(n)) return '?'
  if (n < 0) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return Math.round(n).toString()
}

/// Returns YYYY-MM-DD for the given date in the process-local timezone. Cheaper than shelling
/// out to Intl.DateTimeFormat for every turn in a loop and avoids the UTC drift that bites
/// `Date.toISOString().slice(0,10)` whenever the user runs this between local midnight and
/// UTC midnight.
function localDateString(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/// Precomputed today/month totals from the durable daily cache. When supplied,
/// the status bar renders these instead of bucketing the live parse, so the
/// figures match the menubar exactly (carried, expired-source days included).
export type StatusBarTotals = {
  today: { cost: number; calls: number }
  month: { cost: number; calls: number }
}

export function renderStatusBar(projects: ProjectSummary[], totals?: StatusBarTotals): string {
  const now = new Date()
  const today = localDateString(now)
  const monthStart = `${today.slice(0, 7)}-01`

  let todayCost = 0, todayCalls = 0, monthCost = 0, monthCalls = 0
  if (totals) {
    todayCost = totals.today.cost; todayCalls = totals.today.calls
    monthCost = totals.month.cost; monthCalls = totals.month.calls
    const lines: string[] = ['']
    lines.push(`  ${chalk.bold(t('Today'))}  ${chalk.yellowBright(formatCost(todayCost))}  ${chalk.dim(t('%d calls', todayCalls))}    ${chalk.bold(t('Month'))}  ${chalk.yellowBright(formatCost(monthCost))}  ${chalk.dim(t('%d calls', monthCalls))}`)
    lines.push('')
    return lines.join('\n')
  }

  for (const project of projects) {
    for (const session of project.sessions) {
      for (const turn of session.turns) {
        if (turn.assistantCalls.length === 0) continue
        // Bucket by the first assistant call's local date -- the moment the cost was
        // incurred. Bucketing by `turn.timestamp` (the user message time) drops turns
        // that straddle midnight (user asked at 23:58, response arrived at 00:30) and
        // disagrees with parseAllSessions' dateRange filter which is also on assistant
        // time.
        const bucketTs = turn.assistantCalls[0]!.timestamp
        if (!bucketTs) continue
        const day = localDateString(new Date(bucketTs))
        const turnCost = turn.assistantCalls.reduce((s, c) => s + c.costUSD, 0)
        // Cost keeps every call; the calls figure counts only behavioral ones,
        // so a supplementary-only turn still spends but adds no requests.
        const turnCalls = behavioralCallCount(turn.assistantCalls)
        if (day === today) { todayCost += turnCost; todayCalls += turnCalls }
        if (day >= monthStart) { monthCost += turnCost; monthCalls += turnCalls }
      }
    }
  }

  const lines: string[] = ['']
  lines.push(`  ${chalk.bold(t('Today'))}  ${chalk.yellowBright(formatCost(todayCost))}  ${chalk.dim(t('%d calls', todayCalls))}    ${chalk.bold(t('Month'))}  ${chalk.yellowBright(formatCost(monthCost))}  ${chalk.dim(t('%d calls', monthCalls))}`)
  lines.push('')

  return lines.join('\n')
}
