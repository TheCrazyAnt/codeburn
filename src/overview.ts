import { Chalk, type ChalkInstance } from 'chalk'

import { homedir } from 'os'

import { CATEGORY_LABELS, type ProjectSummary, type TaskCategory } from './types.js'
import { t, tn } from './i18n.js'
import { formatCost as baseCost, getCurrency } from './currency.js'
import { findUnpricedModels, getShortModelName, unpricedModelHint } from './models.js'
import { callBillableOutputTokens, sessionBillableOutputTokens, sessionModelBillableOutputTokens } from './session-output.js'
import { displayWidth, markEstimated, padCells, periodLabelForDisplay } from './format.js'
import { dateKey } from './day-aggregator.js'
import type { DailyEntry } from './daily-cache.js'
import type { BudgetStatus, BudgetTier } from './budget.js'

// Display-only helpers. The shared formatters omit thousands separators and
// abbreviate; here we show full, comma-grouped numbers so the tables read like
// a precise statement. Aggregation uses raw numbers; these only affect render.
function formatCost(usd: number): string {
  return baseCost(usd).replace(/(\d)(?=(\d{3})+(\.|$))/g, '$1,')
}
function formatDisplayCost(amount: number): string {
  const { rate } = getCurrency()
  return formatCost(rate > 0 ? amount / rate : amount)
}
function formatTokens(n: number): string {
  // Pin the locale so grouping is deterministic regardless of the host's
  // locale (e.g. en-IN groups as 2,00,20,00,000 instead of 2,002,000,000).
  return Math.round(n).toLocaleString('en-US')
}
// Integer counts (calls, sessions, turns, tool uses) — same locale pin so the
// overview output is byte-identical across machines.
function formatCount(n: number): string {
  return n.toLocaleString('en-US')
}
function isAbsoluteProjectPath(path: string): boolean {
  return path.startsWith('/') || path.startsWith('\\') || /^[a-zA-Z]:[/\\]/.test(path)
}
function projectName(p: ProjectSummary): string {
  const path = p.projectPath
  if (path) {
    if (path === homedir()) return t('Home')
    if (!isAbsoluteProjectPath(path)) return p.project || path
    const base = path.replace(/[/\\]+$/, '').split(/[/\\]/).filter(Boolean).pop()
    if (base) return base
  }
  return p.project.split('-').filter(Boolean).pop() || p.project
}

type Col = { header: string; right?: boolean }
type OverviewBudget = {
  tier: BudgetTier
  status: BudgetStatus
  inProgress: boolean
}

// Visible width, ignoring ANSI color codes, so padding stays aligned. Counted
// in terminal cells rather than characters so a translated (CJK) header keeps
// its column square; identical to the character count for ASCII.
function vlen(s: string): number {
  // eslint-disable-next-line no-control-regex
  return displayWidth(s.replace(/\[[0-9;]*m/g, ''))
}

function renderTable(c: ChalkInstance, cols: Col[], rows: string[][]): string {
  const widths = cols.map((col, i) =>
    Math.max(vlen(col.header), ...rows.map((r) => vlen(r[i] ?? ''))),
  )
  const pad = (s: string, w: number, right?: boolean): string => {
    const fill = ' '.repeat(Math.max(0, w - vlen(s)))
    return right ? fill + s : s + fill
  }
  const gap = '  ' // 2-space cell padding so columns breathe
  const sep = gap + c.dim('│') + gap
  const edge = c.dim('│')
  const bar = (l: string, mid: string, r: string): string =>
    c.dim(l + widths.map((w) => '─'.repeat(w + 4)).join(mid) + r)
  const line = (cells: string[], header = false): string =>
    edge + gap + cells.map((cell, i) => {
      const padded = pad(cell, widths[i]!, cols[i]!.right)
      return header ? c.bold(padded) : padded
    }).join(sep) + gap + edge
  return [
    bar('┌', '┬', '┐'),
    line(cols.map((col) => col.header), true),
    bar('├', '┼', '┤'),
    ...rows.map((r) => line(r)),
    bar('└', '┴', '┘'),
  ].join('\n')
}

/// The durable slice renderOverview needs: headline totals + the day set behind
/// them + how much of the total came from carried (expired-source) days.
export type OverviewDurable = {
  cost: number
  savingsUSD: number
  calls: number
  sessions: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  days: DailyEntry[]
  carriedCostUSD: number
  /// Cost a --project/--exclude filter could not attribute (cached days with no
  /// per-project split). Optional so callers that never filter can omit it.
  unattributedCostUSD?: number
}

export function renderOverview(
  projects: ProjectSummary[],
  opts: { label: string; color: boolean; budget?: OverviewBudget; durable?: OverviewDurable },
): string {
  const c = new Chalk(opts.color ? {} : { level: 0 })
  const heading = (text: string): string => c.cyan.bold(text)
  const out: string[] = []
  const durable = opts.durable
  // `opts.label` stays English on the way in (it also feeds the app payload);
  // the terminal header, empty state and bottom line all read the display copy.
  const label = periodLabelForDisplay(opts.label)

  out.push(c.bold('CodeBurn') + c.dim('  ' + label))
  out.push('')

  if (projects.length === 0 && !(durable && durable.cost > 0)) {
    out.push(c.dim(t('No usage found for %s.', label)))
    return out.join('\n') + '\n'
  }

  let cost = 0, savings = 0, calls = 0, sessions = 0
  let inTok = 0, outTok = 0, cacheR = 0, cacheW = 0
  const byProvider = new Map<string, { cost: number; tokens: number }>()
  const byModel = new Map<string, { cost: number; calls: number; tokens: number; estimatedCost: number }>()
  const byCat = new Map<string, { cost: number; turns: number }>()
  const byTool = new Map<string, number>()
  const byDay = new Map<string, { cost: number; tokens: number; providers: Set<string> }>()
  const byProject = new Map<string, { cost: number; sessions: number }>()

  for (const p of projects) {
    cost += p.totalCostUSD
    savings += p.totalSavingsUSD
    calls += p.totalApiCalls
    sessions += p.sessions.length
    const pname = projectName(p)
    const pe = byProject.get(pname) ?? { cost: 0, sessions: 0 }
    pe.cost += p.totalCostUSD
    pe.sessions += p.sessions.length
    byProject.set(pname, pe)
    for (const s of p.sessions) {
      inTok += s.totalInputTokens
      outTok += sessionBillableOutputTokens(s)
      cacheR += s.totalCacheReadTokens
      cacheW += s.totalCacheWriteTokens
      for (const [m, d] of Object.entries(s.modelBreakdown)) {
        const e = byModel.get(m) ?? { cost: 0, calls: 0, tokens: 0, estimatedCost: 0 }
        e.cost += d.costUSD
        e.calls += d.calls
        e.estimatedCost += d.estimatedCostUSD ?? 0
        e.tokens += d.tokens.inputTokens + d.tokens.cacheReadInputTokens + d.tokens.cacheCreationInputTokens
        byModel.set(m, e)
      }
      // Output must be billed per call while provider identity is still known.
      // Join on the same key as parser modelBreakdown (getShortModelName), not raw call.model.
      for (const [m, output] of Object.entries(sessionModelBillableOutputTokens(s))) {
        const e = byModel.get(m) ?? { cost: 0, calls: 0, tokens: 0, estimatedCost: 0 }
        e.tokens += output
        byModel.set(m, e)
      }
      for (const [cat, d] of Object.entries(s.categoryBreakdown)) {
        const e = byCat.get(cat) ?? { cost: 0, turns: 0 }
        e.cost += d.costUSD
        e.turns += d.turns
        byCat.set(cat, e)
      }
      for (const [tool, d] of Object.entries(s.toolBreakdown)) {
        byTool.set(tool, (byTool.get(tool) ?? 0) + d.calls)
      }
      for (const t of s.turns) {
        const day = dateKey(t.timestamp || t.assistantCalls[0]?.timestamp || '')
        for (const call of t.assistantCalls) {
          const usage = call.usage
          const billableOut = callBillableOutputTokens(call)
          const tk = (usage?.inputTokens ?? 0) + billableOut + (usage?.cacheReadInputTokens ?? 0) + (usage?.cacheCreationInputTokens ?? 0)
          const pv = byProvider.get(call.provider) ?? { cost: 0, tokens: 0 }
          pv.cost += call.costUSD
          pv.tokens += tk
          byProvider.set(call.provider, pv)
          if (day) {
            const dd = byDay.get(day) ?? { cost: 0, tokens: 0, providers: new Set<string>() }
            dd.cost += call.costUSD
            dd.tokens += tk
            dd.providers.add(call.provider)
            byDay.set(day, dd)
          }
        }
      }
    }
  }

  // Headline totals and the day-resolved views (Daily, Highest-value days) come
  // from the durable daily cache so they match the menubar exactly, carried
  // (expired-source) days included. The per-tool / per-model / per-project
  // breakdowns above stay live: they need surviving session detail.
  if (durable) {
    cost = durable.cost
    savings = durable.savingsUSD
    calls = durable.calls
    sessions = durable.sessions
    inTok = durable.inputTokens
    outTok = durable.outputTokens
    cacheR = durable.cacheReadTokens
    cacheW = durable.cacheWriteTokens
    byDay.clear()
    for (const d of durable.days) {
      byDay.set(d.date, {
        cost: d.cost,
        tokens: d.inputTokens + d.outputTokens + d.cacheReadTokens + d.cacheWriteTokens,
        providers: new Set(Object.keys(d.providers)),
      })
    }
  }

  const totalTokens = inTok + outTok + cacheR + cacheW
  const cacheHitDenom = inTok + cacheR
  const cacheHit = cacheHitDenom > 0 ? (cacheR / cacheHitDenom) * 100 : 0

  // Totals
  out.push(heading(t('Totals')))
  const kv = (k: string, v: string): string => '  ' + c.dim(padCells(k, 11)) + v
  out.push(kv(t('Cost'), c.bold(formatCost(cost))))
  out.push(kv(t('Tokens'), formatTokens(totalTokens) + c.dim('   ' + t('(breakdown below)'))))
  out.push(kv(t('Calls'), formatCount(calls) + c.dim('   ' + t('sessions') + ' ') + formatCount(sessions)))
  out.push(kv(t('Cache hit'), `${cacheHit.toFixed(1)}%`))
  if (savings > 0) out.push(kv(t('Savings'), formatCost(savings) + c.dim(' ' + t('(local models)'))))
  const unpriced = findUnpricedModels(
    [...byModel.entries()].map(([model, d]) => ({ model, calls: d.calls, cost: d.cost, tokens: d.tokens })),
  )
  if (unpriced.length > 0) {
    const shown = unpriced.slice(0, 3)
      .map((u) => t('%s (%s tok)', u.model, formatTokens(u.tokens)))
      .join(', ')
    const more = unpriced.length > 3 ? ' ' + t('+%d more', unpriced.length - 3) : ''
    out.push(kv(t('Unpriced'), c.yellow(tn('%d model at $0:', '%d models at $0:', unpriced.length) + ' ') + shown + more))
    out.push(kv('', c.dim(unpricedModelHint())))
  }
  if (opts.budget) {
    // One whole key per tier: the tier word is an inseparable part of the
    // sentence, so it must not be spliced in as a translated fragment.
    const budgetKey = opts.budget.tier === 'daily'
      ? 'Daily budget: %1$s of %2$s (%3$s)'
      : opts.budget.tier === 'weekly'
        ? 'Weekly budget: %1$s of %2$s (%3$s)'
        : 'Monthly budget: %1$s of %2$s (%3$s)'
    const projectedKey = opts.budget.tier === 'monthly'
      ? 'projected %s by month end'
      : opts.budget.tier === 'weekly'
        ? 'projected %s by week end'
        : 'projected %s by day end'
    const status = opts.budget.status
    const pct = `${Math.floor(status.pct)}%`
    const statusColor = status.state === 'over' ? c.red : status.state === 'warn' ? c.yellow : c.green
    const projected = opts.budget.inProgress
      ? c.dim('  ' + t(projectedKey, formatDisplayCost(status.projected)))
      : ''
    out.push('  ' + statusColor(t(budgetKey, formatDisplayCost(status.spent), formatDisplayCost(status.budget), pct)) + projected)
  }
  out.push('')

  // Tokens breakdown: input / output / cache in (written) / cache out (read)
  if (totalTokens > 0) {
    const share = (n: number): string => `${Math.round((n / totalTokens) * 100)}%`
    out.push(heading(t('Tokens')))
    out.push(renderTable(c,
      [{ header: t('Type') }, { header: t('Tokens'), right: true }, { header: t('Share'), right: true }],
      [
        [t('Input'), formatTokens(inTok), share(inTok)],
        [t('Output'), formatTokens(outTok), share(outTok)],
        [t('Cache in'), formatTokens(cacheW), share(cacheW)],
        [t('Cache out'), formatTokens(cacheR), share(cacheR)],
        [t('Total'), formatTokens(totalTokens), '100%'],
      ],
    ))
    out.push('')
  }

  // By tool (provider)
  const providerRows = [...byProvider.entries()]
    .filter(([, v]) => v.cost > 0 || v.tokens > 0)
    .sort((a, b) => b[1].cost - a[1].cost)
  if (providerRows.length) {
    out.push(heading(t('By tool')))
    out.push(renderTable(c,
      [{ header: t('Tool') }, { header: t('Cost'), right: true }, { header: t('Tokens'), right: true }, { header: t('Share'), right: true }],
      providerRows.map(([name, v]) => [name, formatCost(v.cost), formatTokens(v.tokens), cost > 0 ? `${Math.round((v.cost / cost) * 100)}%` : '0%']),
    ))
    out.push('')
  }

  // Top models
  const modelRows = [...byModel.entries()].filter(([, v]) => v.cost > 0 || v.tokens > 0).sort((a, b) => b[1].cost - a[1].cost).slice(0, 10)
  if (modelRows.length) {
    out.push(heading(t('Top models')))
    out.push(renderTable(c,
      [{ header: t('Model') }, { header: t('Cost'), right: true }, { header: t('Calls'), right: true }, { header: t('Tokens'), right: true }],
      modelRows.map(([m, v]) => [getShortModelName(m), markEstimated(formatCost(v.cost), v.estimatedCost > 0), formatCount(v.calls), formatTokens(v.tokens)]),
    ))
    if (modelRows.some(([, v]) => v.estimatedCost > 0)) {
      out.push('  ' + c.dim(t('~ estimated cost (priced from estimated tokens)')))
    }
    out.push('')
  }

  // Highest-value days
  const topDays = [...byDay.entries()].sort((a, b) => b[1].cost - a[1].cost).slice(0, 5)
  if (topDays.length) {
    out.push(heading(t('Highest-value days')))
    out.push(renderTable(c,
      [{ header: '#' }, { header: t('Date') }, { header: t('Cost'), right: true }, { header: t('Tokens'), right: true }],
      topDays.map(([d, v], i) => [String(i + 1), d, formatCost(v.cost), formatTokens(v.tokens)]),
    ))
    out.push('')
  }

  // Top projects
  const projRows = [...byProject.entries()].sort((a, b) => b[1].cost - a[1].cost).slice(0, 10)
  if (projRows.length) {
    out.push(heading(t('Top projects')))
    out.push(renderTable(c,
      [{ header: t('Project') }, { header: t('Cost'), right: true }, { header: t('Sessions'), right: true }],
      projRows.map(([name, v]) => [name, formatCost(v.cost), formatCount(v.sessions)]),
    ))
    out.push('')
  }

  // Daily
  const dailyRows = [...byDay.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  if (dailyRows.length) {
    out.push(heading(t('Daily')))
    out.push(renderTable(c,
      [{ header: t('Date') }, { header: t('Cost'), right: true }, { header: t('Tokens'), right: true }, { header: t('Providers') }],
      dailyRows.map(([d, v]) => [d, formatCost(v.cost), formatTokens(v.tokens), [...v.providers].sort().join(', ')]),
    ))
    out.push('')
  }

  // By activity
  const catRows = [...byCat.entries()].filter(([, v]) => v.cost > 0 || v.turns > 0).sort((a, b) => b[1].cost - a[1].cost)
  if (catRows.length) {
    out.push(heading(t('By activity')))
    out.push(renderTable(c,
      [{ header: t('Activity') }, { header: t('Cost'), right: true }, { header: t('Turns'), right: true }],
      catRows.map(([cat, v]) => [t(CATEGORY_LABELS[cat as TaskCategory] ?? cat), formatCost(v.cost), formatCount(v.turns)]),
    ))
    out.push('')
  }

  // Tools
  const toolRows = [...byTool.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
  if (toolRows.length) {
    out.push(heading(t('Tools')))
    out.push(renderTable(c,
      [{ header: t('Tool') }, { header: t('Calls'), right: true }],
      toolRows.map(([t, n]) => [t, formatCount(n)]),
    ))
    out.push('')
  }

  const topTool = providerRows[0]?.[0]
  const topModel = modelRows[0] ? getShortModelName(modelRows[0][0]) : ''
  const mostly = topTool ? (topModel ? `${topTool} / ${topModel}` : topTool) : ''
  const summary = mostly
    ? t('%1$s totals %2$s across %3$s tokens, mostly %4$s.', label, formatCost(cost), formatTokens(totalTokens), mostly)
    : t('%1$s totals %2$s across %3$s tokens.', label, formatCost(cost), formatTokens(totalTokens))
  out.push(c.dim(t('Bottom line:') + ' ') + summary)

  // When some of the period's total came from days whose session logs have since
  // expired, say so once. The figure is real (preserved in the durable daily
  // cache); it just can't be re-derived from surviving files anymore.
  if (durable && durable.carriedCostUSD > 0) {
    out.push(c.dim('  ' + t('includes %s preserved from expired session logs', formatCost(durable.carriedCostUSD))))
  }

  // A project filter cannot claim days the cache holds without a project split
  // (recorded before that split existed), so they sit outside this total. Say how
  // much rather than let the filtered figure look inexplicably short.
  if (durable && (durable.unattributedCostUSD ?? 0) > 0) {
    out.push(c.dim('  ' + t('excludes %s from days with no per-project history', formatCost(durable.unattributedCostUSD!))))
  }

  return out.join('\n') + '\n'
}
