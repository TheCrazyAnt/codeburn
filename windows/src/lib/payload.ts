/// Shape of the JSON returned by `codeburn status --format menubar-json`. Kept in sync with
/// `src/menubar-json.ts` (CLI) and `mac/Sources/CodeBurnMenubar/Data/MenubarPayload.swift`
/// (macOS app). Any field change there must land here too or the frontend silently drops it.
export type MenubarPayload = {
  generated: string
  /// UI language the CLI resolved (`codeburn lang`). Absent on older CLIs, in
  /// which case the popover falls back to the webview locale.
  lang?: string
  current: {
    label: string
    cost: number
    calls: number
    sessions: number
    oneShotRate: number | null
    inputTokens: number
    outputTokens: number
    cacheHitPercent: number
    topActivities: Activity[]
    topModels: Model[]
    providers: Record<string, number>
    providerDetails?: Array<{
      id: string
      label: string
      cost: number
      calls?: number
      hasUsage?: boolean
    }>
    /// Spend on turns that had to be retried. Absent on payloads from a CLI
    /// that predates the block, so the Optimize tab treats absence as zero.
    retryTax?: RetryTax
    /// What the same edits would have cost on the cheapest model that was
    /// already doing them. Absent on older payloads, as above.
    routingWaste?: RoutingWaste
  }
  optimize: {
    findingCount: number
    savingsUSD: number
    topFindings: Array<{ title: string; impact: 'high' | 'medium' | 'low'; savingsUSD: number }>
  }
  history: { daily: DailyEntry[] }
}

export type RetryTax = {
  totalUSD: number
  retries: number
  editTurns: number
  byModel: Array<{ name: string; taxUSD: number; retries: number; retriesPerEdit: number | null }>
}

export type RoutingWaste = {
  totalSavingsUSD: number
  baselineModel: string
  baselineCostPerEdit: number
  byModel: Array<{
    name: string
    costPerEdit: number
    editTurns: number
    actualUSD: number
    counterfactualUSD: number
    savingsUSD: number
  }>
}

export type Activity = {
  name: string
  cost: number
  turns: number
  oneShotRate: number | null
}

export type Model = {
  name: string
  cost: number
  calls: number
}

export type DailyModel = {
  name: string
  cost: number
  calls: number
  inputTokens: number
  outputTokens: number
}

export type DailyEntry = {
  date: string
  cost: number
  calls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  topModels?: DailyModel[]
}
