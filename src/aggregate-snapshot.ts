import { getCurrency } from './currency.js'
import {
  getFlatRateModelsConfigHash,
  getLocalModelSavingsConfigHash,
  getModelAliasesConfigHash,
  getPriceOverridesConfigHash,
  getPricingGenerationKey,
  getProxyPathsConfigHash,
} from './models.js'
import { computeCorpusFingerprint } from './parser.js'
import { loadStatusSnapshotEntry, saveStatusSnapshot } from './session-cache.js'

/**
 * The shared aggregate-snapshot door.
 *
 * Every `codeburn <query>` invocation is its own process: nothing in-memory
 * survives between them, so each one re-parses the whole corpus and rebuilds
 * the same rollups even when not one byte on disk moved. The menubar already
 * avoided that with the per-query snapshot store in `session-cache.ts`
 * (`status --format menubar-json` only). This is that same store, behind one
 * entry point every query command can use, so the menubar, the desktop app and
 * the CLI serve their aggregates off one core instead of three.
 *
 * The stored payload is whatever the command itself computed. That is the
 * point: there is no second implementation of any rollup to drift out of sync
 * with the first, so a served snapshot is exact by construction rather than by
 * a parity argument.
 *
 * Never silently wrong, never fatal:
 *  - a hit requires an EXACT corpus fingerprint match, so a hit means the
 *    corpus has not moved — not that we decided the difference was small
 *    enough. The menubar's settle-window debounce is deliberately not used
 *    here (see the `settle: false` note below);
 *  - the query key below carries every input that changes the ANSWER without
 *    touching a session file (period, filters, flags, pricing config, display
 *    currency, pricing data/code generation);
 *  - the semantic key carries the binary version, so an upgrade cannot serve a
 *    payload shaped for an older build;
 *  - a missing, corrupt, truncated, version-skewed or unreadable snapshot is a
 *    miss, and a miss just computes. Every failure path here degrades to the
 *    pre-snapshot behaviour instead of throwing.
 */

export type SnapshotServe<T> = {
  value: T
  /// Wall-clock ms the served payload was computed, or null when this call
  /// computed it fresh.
  completedAt: number | null
  servedFromSnapshot: boolean
}

export type ServeOptions<T> = {
  /// Command name — namespaces the query key so `models` and `sessions` with
  /// otherwise identical scopes never collide.
  command: string
  /// Everything that defines this query's answer. JSON-stringified into the
  /// key, so it must be a plain, deterministically-ordered value.
  scope: unknown
  /// Passed to `computeCorpusFingerprint` so a provider-filtered query only
  /// fingerprints the sources it reads.
  providerFilter?: string
  /// Binary + render semantics. Supplied by the caller (main.ts owns the
  /// package version and its own render-version constants).
  semanticKey: string
  /// `--refresh`: skip the read, compute, and publish the fresh result.
  refresh?: boolean
  compute: () => Promise<T>
  /// Optional veto on persisting a computed value — for results a command
  /// knows are degraded (a partial parse) and must not be republished as
  /// authoritative. Defaults to "persist".
  cacheable?: (value: T) => boolean
}

/// Inputs that change a rendered aggregate without moving any session file.
/// Mirrors the menubar's own query key (main.ts) — an edited alias, price
/// override, savings baseline, proxy path, flat-rate model, display currency,
/// or a repricing fetch must all miss, or the snapshot serves numbers priced
/// under a config the user has already changed.
function renderInputsKey(): Record<string, string> {
  return {
    proxyPathsConfigHash: getProxyPathsConfigHash(),
    modelAliasesConfigHash: getModelAliasesConfigHash(),
    priceOverridesConfigHash: getPriceOverridesConfigHash(),
    localModelSavingsConfigHash: getLocalModelSavingsConfigHash(),
    flatRateModelsConfigHash: getFlatRateModelsConfigHash(),
    // Whole object, not just the code: an FX refresh moves `rate` alone and
    // every rendered cost with it.
    currency: JSON.stringify(getCurrency()),
    pricingGenerationKey: getPricingGenerationKey(),
  }
}

export async function serveFromAggregateSnapshot<T>(opts: ServeOptions<T>): Promise<SnapshotServe<T>> {
  const queryKey = JSON.stringify({ command: opts.command, scope: opts.scope, ...renderInputsKey() })

  // Fingerprint failures (an unreadable source dir, a provider probe throwing)
  // must not take down a command that worked before this snapshot existed.
  let corpus: Awaited<ReturnType<typeof computeCorpusFingerprint>> | null = null
  try {
    corpus = await computeCorpusFingerprint(opts.providerFilter)
  } catch {
    return { value: await opts.compute(), completedAt: null, servedFromSnapshot: false }
  }

  if (!opts.refresh) {
    try {
      // `settle: false`: no grace period. The menubar's debounce exists for a
      // process polling several times a second; a command the user ran once
      // must never serve a payload whose corpus fingerprint no longer matches
      // — a newly configured provider root is exactly that case, and it is
      // what the resident-serve regression test pins.
      const entry = await loadStatusSnapshotEntry(corpus.hash, queryKey, opts.semanticKey, { settle: false })
      if (entry) return { value: entry.payload as T, completedAt: entry.completedAt, servedFromSnapshot: true }
    } catch {
      // fall through to compute
    }
  }

  const value = await opts.compute()
  if (opts.cacheable?.(value) !== false) {
    const completedAt = Date.now()
    // Best-effort: a read-only cache dir, a full disk or a lost write race just
    // means the next invocation computes again.
    await saveStatusSnapshot(corpus.hash, corpus.newestMtimeMs, corpus.observedAtMs, queryKey, opts.semanticKey, value, completedAt)
      .catch(() => false)
  }
  return { value, completedAt: null, servedFromSnapshot: false }
}

/// One-line provenance for human-readable output. Absent for a fresh compute —
/// there is nothing to disclose when the numbers were just derived. Values are
/// never shown without this line once they came off disk.
export function cacheAgeLabel(serve: { completedAt: number | null; servedFromSnapshot: boolean }, now: number = Date.now()): string | undefined {
  if (!serve.servedFromSnapshot || serve.completedAt === null) return undefined
  const at = new Date(serve.completedAt)
  const hh = String(at.getHours()).padStart(2, '0')
  const mm = String(at.getMinutes()).padStart(2, '0')
  return `cached as of ${hh}:${mm} (${humanAge(now - serve.completedAt)} ago); nothing in the corpus has changed since. Pass --refresh to recompute.`
}

function humanAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 48) return `${h}h`
  return `${Math.round(h / 24)}d`
}
