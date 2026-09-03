/**
 * codeburn sync — CLI commands.
 *
 * Registers: sync setup | push | status | logout | reset
 */

import type { Command } from 'commander'
import { randomBytes } from 'crypto'

import { fetchDiscoveryDoc, DiscoveryError } from './discovery.js'
import {
  AuthError,
  fetchOidcConfig,
  generatePkce,
  buildAuthUrl,
  resolveScopes,
  startCallbackServer,
  exchangeCode,
  refreshToken,
  revokeToken,
  CALLBACK_PORTS,
} from './auth.js'
import { createCredentialStore } from './credentials.js'
import { readSyncConfig, writeSyncConfig, deleteSyncConfig, updateLastSync, receiptsPath, readReceipts, appendReceipt } from './config.js'
import { collectUnsentCalls, collectUnsentAttribution, sendBatches, sendAttributionBatches, batchCalls, MAX_PER_PUSH, MAX_ATTRIBUTION_PER_PUSH, type PushResult } from './push.js'
import { batchAttributionItems, wireProjectName, CORE_SYNC_ATTRIBUTE_KEYS } from './otlp.js'
import { loadPlugins, declaredSyncAttributes, type PluginLoad } from '../plugins/loader.js'
import { collectPluginEnrichment } from '../plugins/exporter.js'
import {
  computeAcceptanceFingerprint,
  buildDisclosure,
  CORE_SYNC_FIELD_MEANINGS,
  detectFingerprintChanges,
  type FingerprintInput,
  type DisclosureInput,
  type Receipt,
  buildReceipt,
} from './consent.js'
import { installSchedule, removeSchedule } from './schedule-installer.js'
import { t } from '../i18n.js'

// Helper for executing the push after data collection
interface ExecutePushInput {
  config: NonNullable<Awaited<ReturnType<typeof readSyncConfig>>>
  unsent: Awaited<ReturnType<typeof collectUnsentCalls>>['unsent']
  attributionUnsent: Awaited<ReturnType<typeof collectUnsentAttribution>>['unsent']
  pluginAttributeKeys: ReadonlySet<string>
  coverageThrough?: string
  tokens: { access_token: string }
  silent?: boolean
}

async function executePush(input: ExecutePushInput): Promise<{ result: PushResult; attrResult: PushResult | null; attrFacts: number }> {
  const { config, unsent, attributionUnsent, pluginAttributeKeys, coverageThrough, tokens, silent } = input
  const log = silent ? () => {} : (msg: string) => process.stderr.write(`${msg}\n`)

  const discoveryDoc = await fetchDiscoveryDoc(config.baseUrl)
  const endpoint = `${config.baseUrl}${config.tracesPath}`

  let result: PushResult = { outcome: 'complete', totalSent: 0, totalRejected: 0, totalCostSent: 0 }
  if (unsent.length > 0) {
    const toPush = unsent.slice(0, MAX_PER_PUSH)
    const batches = batchCalls(toPush, discoveryDoc.max_batch_size)
    result = await sendBatches({
      endpoint,
      accessToken: tokens.access_token,
      batches,
      ...(coverageThrough ? { coverageThrough } : {}),
      pluginAttributes: { keys: pluginAttributeKeys, values: [] },
      log,
    })
  }

  let attrResult: PushResult | null = null
  let attrFacts = 0
  if (attributionUnsent.length > 0 && result.outcome === 'complete') {
    const attrToPush = attributionUnsent.slice(0, MAX_ATTRIBUTION_PER_PUSH)
    const attrBatches = batchAttributionItems(attrToPush, discoveryDoc.max_batch_size)
    attrResult = await sendAttributionBatches({
      endpoint,
      accessToken: tokens.access_token,
      batches: attrBatches,
      log,
    })
    attrFacts = attrResult.outcome === 'complete' ? attrResult.totalSent : 0
  }

  if (result.outcome === 'complete') {
    updateLastSync()
  }

  return { result, attrResult, attrFacts }
}

// Helper to build FingerprintInput for acceptance checking
function buildAcceptanceFingerprintInput(
  config: NonNullable<Awaited<ReturnType<typeof readSyncConfig>>>,
  allKeys: string[],
  workMatching: boolean,
  cadence: 'daily' | 'hourly',
): FingerprintInput {
  return {
    org: config.clientId,
    destination: config.baseUrl,
    outboundFields: allKeys,
    workMatching,
    scopeSinceDays: 7,
    cadence,
  }
}

export function registerSyncCommands(program: Command): void {
  const sync = program
    .command('sync')
    .description(t('Sync AI usage telemetry to a remote OTLP endpoint'))

  // --- setup ---
  sync
    .command('setup <url>')
    .description(t('Configure sync with a remote endpoint (one-time)'))
    .action(async (url: string) => {
      try {
        const baseUrl = url.replace(/\/$/, '')
        process.stderr.write(t('Fetching discovery doc from %s...', baseUrl) + '\n')

        // 1. Fetch codeburn discovery doc
        const discovery = await fetchDiscoveryDoc(baseUrl)
        process.stderr.write('  ' + t('Issuer: %s', discovery.issuer) + '\n')
        process.stderr.write('  ' + t('Client: %s', discovery.client_id) + '\n')

        // 2. Fetch OIDC configuration from the issuer
        const oidc = await fetchOidcConfig(discovery.issuer)
        process.stderr.write('  ' + t('Auth endpoint: %s', oidc.authorization_endpoint) + '\n')

        // 3. Resolve scopes
        const scopes = resolveScopes(discovery.scopes, oidc.scopes_supported)

        // 4. Generate PKCE
        const pkce = generatePkce()
        const state = randomBytes(16).toString('hex')

        // 5. Start callback server — await the actually-bound port (port
        // fallback means it may not be the first in CALLBACK_PORTS)
        const { promise: callbackPromise, ready } = startCallbackServer(state)
        // If all ports are in use, BOTH `ready` and `callbackPromise` reject.
        // Mark callbackPromise as handled so the second rejection can't crash
        // the process as an unhandled rejection while we're throwing from
        // `await ready`. The later `await callbackPromise` still throws.
        callbackPromise.catch(() => {})
        const port = await ready
        const redirectUri = `http://127.0.0.1:${port}/callback`

        // 6. Build auth URL and open browser
        const authUrl = buildAuthUrl({
          authorization_endpoint: oidc.authorization_endpoint,
          client_id: discovery.client_id,
          redirect_uri: redirectUri,
          scopes,
          state,
          pkce,
        })

        process.stderr.write('\n' + t('Opening browser for login...') + '\n')
        process.stderr.write(t('If the browser doesn\'t open, visit:') + `\n  ${authUrl}\n\n`)

        // Open browser (best-effort, platform-specific).
        // execFileSync with args array — authUrl comes from the remote discovery
        // doc so it must never be shell-interpolated. Scheme is also validated.
        try {
          if (!/^https:\/\//.test(authUrl)) {
            throw new Error('auth URL must be https')
          }
          const { execFileSync } = await import('child_process')
          if (process.platform === 'darwin') {
            execFileSync('open', [authUrl], { stdio: 'ignore' })
          } else if (process.platform === 'win32') {
            // Do NOT use `cmd /c start` here: cmd.exe treats `&` as a command
            // separator, so the auth URL's query string gets truncated at the
            // first parameter and the IdP sees a bare /authorize request.
            // rundll32's FileProtocolHandler receives the URL as a plain
            // process argument with no shell parsing, so `&` survives intact.
            execFileSync('rundll32', ['url.dll,FileProtocolHandler', authUrl], { stdio: 'ignore' })
          } else {
            execFileSync('xdg-open', [authUrl], { stdio: 'ignore' })
          }
        } catch {
          // Browser open failed — user sees the URL above
        }

        // 7. Wait for callback
        process.stderr.write(t('Waiting for login (5 min timeout)...') + '\n')
        const callback = await callbackPromise

        // 8. Exchange code for tokens
        const tokenRedirectUri = `http://127.0.0.1:${callback.port}/callback`
        const tokens = await exchangeCode(
          oidc.token_endpoint,
          callback.code,
          pkce.code_verifier,
          tokenRedirectUri,
          discovery.client_id,
        )

        if (!tokens.refresh_token) {
          process.stderr.write(t('Warning: IdP did not return a refresh token. You may need to re-authenticate frequently.') + '\n')
        }

        // 9. Store credentials
        const store = createCredentialStore()
        if (tokens.refresh_token) {
          store.store(tokens.refresh_token)
        }

        // 10. Write config
        writeSyncConfig({
          baseUrl,
          clientId: discovery.client_id,
          tracesPath: discovery.traces_path,
          issuer: discovery.issuer,
        })

        process.stderr.write('\n✓ ' + t('Sync configured successfully.') + '\n')
        process.stderr.write('  ' + t('Endpoint: %s', baseUrl) + '\n')
        process.stderr.write('  ' + t('Token stored in: %s', store.method()) + '\n')
        process.stderr.write('\n' + t('Run `codeburn sync push` to send telemetry data.') + '\n')
      } catch (err) {
        // Known errors (login timeout, port exhaustion, discovery failures)
        // get a clean one-line message instead of a raw Node crash dump.
        if (err instanceof AuthError || err instanceof DiscoveryError) {
          process.stderr.write('\n' + t('Error: %s', err.message) + '\n')
        } else {
          process.stderr.write('\n' + t('Error: %s', (err as Error).stack ?? (err as Error).message) + '\n')
        }
        process.exit(1)
      }
    })

  // --- status ---
  sync
    .command('status')
    .description(t('Show sync configuration and auth status'))
    .action(async () => {
      const config = readSyncConfig()
      if (!config) {
        process.stderr.write(t('Sync not configured. Run `codeburn sync setup <url>` first.') + '\n')
        process.exit(1)
      }

      const store = createCredentialStore()
      const token = store.retrieve()

      process.stdout.write(t('Endpoint: %s', config.baseUrl) + '\n')
      process.stdout.write(t('Traces path: %s', config.tracesPath) + '\n')
      process.stdout.write(t('Issuer: %s', config.issuer) + '\n')
      process.stdout.write(t('Auth: %s', token ? t('configured') : t('missing (run sync setup)')) + '\n')
      process.stdout.write(t('Token storage: %s', store.method()) + '\n')
      process.stdout.write(t('Last sync: %s', config.lastSync ?? t('never')) + '\n')
    })

  // --- logout ---
  sync
    .command('logout')
    .description(t('Remove stored credentials and revoke token'))
    .action(async () => {
      const config = readSyncConfig()
      const store = createCredentialStore()
      const token = store.retrieve()

      // Revoke if we have a token and know the revocation endpoint
      if (token && config) {
        try {
          const oidc = await fetchOidcConfig(config.issuer)
          if (oidc.revocation_endpoint) {
            await revokeToken(oidc.revocation_endpoint, token, config.clientId)
            process.stderr.write(t('Token revoked at IdP.') + '\n')
          }
        } catch {
          // Best-effort revocation
        }
      }

      store.delete()
      deleteSyncConfig()
      process.stderr.write(t('Sync credentials and config removed.') + '\n')
    })

  // --- reset ---
  sync
    .command('reset')
    .description(t('Clear the sent-ledger (next push re-sends all calls in window)'))
    .option('--confirm', t('Required to confirm reset'))
    .action(async (opts: { confirm?: boolean }) => {
      if (!opts.confirm) {
        process.stderr.write(t('This will clear the sent-ledger, causing the next push to re-send all data.') + '\n')
        process.stderr.write(t('Run with --confirm to proceed.') + '\n')
        process.exit(1)
      }

      const { clearLedger } = await import('./ledger.js')
      const removed = clearLedger()
      if (removed > 0) {
        process.stderr.write(t('Ledger cleared (%d entries). Next push will re-send all calls in window.', removed) + '\n')
      } else {
        process.stderr.write(t('No ledger entries found (nothing to reset).') + '\n')
      }
    })

  // --- push (placeholder for Step 2) ---
  sync
    .command('push')
    .description(t('Push unsent telemetry data to the configured endpoint'))
    .option('--since <period>', t('Time window: today, 7d, 30d, month, all (max 6 months)'), '7d')
    .option('--dry-run', t('Show what would be sent without sending'))
    .option('--attribution', t('Also push git attribution spans (session→commit correlation from `codeburn yield`, plus PR links). Sends normalized repo remotes and commit SHAs to the endpoint.'))
    .action(async (opts: { since: string; dryRun?: boolean; attribution?: boolean }) => {
      const config = readSyncConfig()
      if (!config) {
        process.stderr.write(t('Sync not configured. Run `codeburn sync setup <url>` first.') + '\n')
        process.exit(1)
      }

      const store = createCredentialStore()
      const rt = store.retrieve()
      if (!rt) {
        process.stderr.write(t('No auth token found. Run `codeburn sync setup` to authenticate.') + '\n')
        process.exit(1)
      }

      // Refresh token
      try {
        const oidc = await fetchOidcConfig(config.issuer)
        const tokens = await refreshToken(oidc.token_endpoint, rt, config.clientId)

        // Store rotated token if present
        if (tokens.refresh_token && tokens.refresh_token !== rt) {
          store.store(tokens.refresh_token)
        }

        if (opts.dryRun) {
          process.stderr.write('[dry-run] ' + t('Auth: valid (Bearer token obtained)') + '\n')
        }

        // Collect data
        const { parseAllSessions } = await import('../parser.js')
        const { getDateRange } = await import('../cli-date.js')

        // Map --since to a parser period. Strict: unknown values are an error.
        const sinceToPeriod: Record<string, string> = {
          'today': 'today',
          '7d': 'week', 'week': 'week',
          '30d': '30days', '30days': '30days',
          'month': 'month',
          'all': 'all', // up to 6 months (parser retention limit)
        }
        const period = sinceToPeriod[opts.since]
        if (!period) {
          process.stderr.write(t('Unknown --since value "%s". Valid: today, 7d, 30d, month, all.', opts.since) + '\n')
          process.exit(1)
        }
        const { range } = getDateRange(period)
        const projects = (await parseAllSessions(range))
          .map(p => ({ ...p, project: wireProjectName(p.projectPath, p.project) }))

        // Local-only inputs to the CB-3 fields: configured plans decide
        // ai.subscription_covered; the daily-cache watermark stamps
        // codeburn.coverage_through (only when a complete parse finalized it).
        const { readPlans } = await import('../config.js')
        const plans = await readPlans()
        const { loadDailyCache } = await import('../daily-cache.js')
        const dailyCache = await loadDailyCache()
        const coverageThrough = dailyCache.complete === true && dailyCache.watermarkTrusted === true && dailyCache.lastComputedDate
          ? dailyCache.lastComputedDate
          : undefined

        // Flatten + filter against sent-ledger
        const { allCalls, unsent, held, frozen } = collectUnsentCalls(projects, Date.now(), { plans })

        // Plugin socket: load declared sync attribute keys once for the dry-run
        // disclosure and the real-push wire guard. Loader is directory-stat only
        // when no plugins are installed, so the no-plugin case is byte-identical
        // to before the socket shipped.
        const pluginLoads: PluginLoad[] = await loadPlugins()
        const pluginKeys = declaredSyncAttributes(pluginLoads)
        const pluginAttributeKeys: ReadonlySet<string> = new Set(pluginKeys.keys())

        // Attribution records (opt-in): session→commit correlation computed
        // locally from the same parsed projects. Reuses the yield engine.
        let attributionUnsent: Awaited<ReturnType<typeof collectUnsentAttribution>>['unsent'] = []
        let attributionTotal = 0
        if (opts.attribution) {
          const { computeAttributionRecords } = await import('../yield.js')
          const records = computeAttributionRecords(projects, range, process.cwd())
          const collected = collectUnsentAttribution(records)
          attributionUnsent = collected.unsent
          attributionTotal = collected.allItems.length
        }

        if (opts.dryRun) {
          const toPushCount = Math.min(unsent.length, MAX_PER_PUSH)
          const cost = unsent.slice(0, MAX_PER_PUSH).reduce((s, c) => s + c.call.costUSD, 0)
          process.stderr.write('[dry-run] ' + t('Window: %s — %d calls total, %d already synced', opts.since, allCalls.length, allCalls.length - unsent.length - held.length - frozen.length) + '\n')
          if (held.length > 0) {
            process.stderr.write('[dry-run] ' + t('%d calls held: their session is still reconciling and its values can still change (#988). They push once it settles.', held.length) + '\n')
          }
          if (frozen.length > 0) {
            process.stderr.write('[dry-run] ' + t('%d Copilot calls frozen: their sessions were already synced in the other shape (rollup vs per-request), and a usage span cannot be retracted. See docs/sync/README.md.', frozen.length) + '\n')
          }
          process.stderr.write('[dry-run] ' + t('Would push %d calls ($%s) to %s', toPushCount, cost.toFixed(2), `${config.baseUrl}${config.tracesPath}`) + '\n')
          const toPushList = unsent.slice(0, MAX_PER_PUSH)
          const withLineage = toPushList.filter(c => c.session?.workUnitId !== undefined).length
          const withCacheTokens = toPushList.filter(c =>
            Math.max(c.call.usage.cacheReadInputTokens, c.call.usage.cachedInputTokens) > 0
            || c.call.usage.cacheCreationInputTokens > 0).length
          const covered = toPushList.filter(c => c.session?.subscriptionCovered === true).length
          const uncovered = toPushList.filter(c => c.session?.subscriptionCovered === false).length
          process.stderr.write('[dry-run] ' + t(
            'Fields: %d/%d spans carry lineage (ai.work_unit_id/session_role/lineage_evidence), %d carry cache tokens, ai.subscription_covered true on %d / false on %d / omitted on %d; codeburn.coverage_through: %s',
            withLineage,
            toPushCount,
            withCacheTokens,
            covered,
            uncovered,
            toPushCount - covered - uncovered,
            coverageThrough ?? t('unavailable'),
          ) + '\n')

          // Plugin socket disclosure (teams issue #3): a member sees every
          // loaded plugin and every declared sync attribute, so a plugin
          // cannot widen the wire silently. Empty socket => line is omitted.
          const loadedPlugins = pluginLoads.filter(l => l.status === 'loaded')
          const rejectedPlugins = pluginLoads.filter(l => l.status === 'rejected')
          if (loadedPlugins.length > 0 || rejectedPlugins.length > 0) {
            const loadedSummary = loadedPlugins.map(l => {
              const attrs = l.manifest.capabilities.syncAttributes
              return attrs.length > 0
                ? `${l.manifest.name}@${l.manifest.version} [${attrs.map(a => `${a.key} - ${a.disclosure}`).join('; ')}]`
                : `${l.manifest.name}@${l.manifest.version} ` + t('(no sync attributes declared)')
            }).join(' | ')
            process.stderr.write('[dry-run] ' + t('Plugins loaded: %d (%s)', loadedPlugins.length, loadedSummary) + '\n')
            if (rejectedPlugins.length > 0) {
              const rejectedSummary = rejectedPlugins.map(l => `${l.name} (${l.reason})`).join('; ')
              process.stderr.write('[dry-run] ' + t('Plugins rejected: %d (%s)', rejectedPlugins.length, rejectedSummary) + '\n')
            }
          }

          // Plugin exporter disclosure: show which loaded plugins have exporters
          // and what they would contribute
          const pluginEnrichmentDry = await collectPluginEnrichment(pluginLoads, toPushList)
          const { stat: statFn } = await import('fs/promises')
          const exporterPlugins: Array<PluginLoad & { status: 'loaded' }> = []
          for (const l of loadedPlugins) {
            try {
              await statFn(`${l.dir}/exporters/sync.mjs`)
              exporterPlugins.push(l as PluginLoad & { status: 'loaded' })
            } catch {
              // no exporter
            }
          }
          if (exporterPlugins.length > 0) {
            const exporterSummary = exporterPlugins.map(l => {
              const callCount = pluginEnrichmentDry.perCall.size
              const spanCount = pluginEnrichmentDry.extraSpans.length
              return t('%s would contribute attributes for %d calls and %d extra spans', l.manifest.name, callCount, spanCount)
            }).join('; ')
            process.stderr.write('[dry-run] ' + t('Plugin exporters: %s', exporterSummary) + '\n')
          }
          if (unsent.length > MAX_PER_PUSH) {
            process.stderr.write('[dry-run] ' + t('%d more calls exceed the %d safety limit — a second push would be needed', unsent.length - MAX_PER_PUSH, MAX_PER_PUSH) + '\n')
          }
          if (opts.attribution) {
            const toPushAttr = attributionUnsent.slice(0, MAX_ATTRIBUTION_PER_PUSH)
            const commits = toPushAttr.filter(i => i.kind === 'commit').length
            const sessions = toPushAttr.filter(i => i.kind === 'session').length
            process.stderr.write('[dry-run] ' + t('Attribution: %d facts total, would push %d (%d sessions, %d commits)', attributionTotal, toPushAttr.length, sessions, commits) + '\n')
            if (attributionUnsent.length > MAX_ATTRIBUTION_PER_PUSH) {
              process.stderr.write('[dry-run] ' + t('%d more attribution facts exceed the %d safety limit — a second push would be needed', attributionUnsent.length - MAX_ATTRIBUTION_PER_PUSH, MAX_ATTRIBUTION_PER_PUSH) + '\n')
            }
          }
          return
        }

        if (unsent.length === 0 && attributionUnsent.length === 0) {
          const pendingNote = [
            held.length > 0 ? t('%d held while their session is still reconciling', held.length) : '',
            frozen.length > 0 ? t('%d frozen behind an already-synced rollup', frozen.length) : '',
          ].filter(Boolean).join(', ')
          process.stderr.write((pendingNote
            ? t('Nothing to push yet (%d calls already synced, %s).', allCalls.length - held.length - frozen.length, pendingNote)
            : t('Nothing to push (%d calls already synced).', allCalls.length)) + '\n')
          updateLastSync()
          return
        }

        // Safety valve (not a routine cap — pushes run to completion)
        const toPush = unsent.slice(0, MAX_PER_PUSH)
        if (unsent.length > MAX_PER_PUSH) {
          process.stderr.write(t('%d unsent calls exceed the %d safety limit. Pushing first %d; run again to continue.', unsent.length, MAX_PER_PUSH, MAX_PER_PUSH) + '\n')
        }

        // Batch and send (loops until done; waits out 429 rate limits)
        const discoveryDoc = await fetchDiscoveryDoc(config.baseUrl)
        const endpoint = `${config.baseUrl}${config.tracesPath}`

        let result: PushResult = { outcome: 'complete', totalSent: 0, totalRejected: 0, totalCostSent: 0 }
        if (toPush.length > 0) {
          const batches = batchCalls(toPush, discoveryDoc.max_batch_size)

          // Collect per-call attributes and extra spans from plugin exporters
          const pluginEnrichment = await collectPluginEnrichment(pluginLoads, toPush)

          result = await sendBatches({
            endpoint,
            accessToken: tokens.access_token,
            batches,
            ...(coverageThrough ? { coverageThrough } : {}),
            // Empty values array is the no-plugin-runtime case: the wire guard
            // in otlp.ts drops everything when `values` is empty, so the wire
            // is byte-identical until a real plugin supplies attrs.
            pluginAttributes: { keys: pluginAttributeKeys, values: [] },
            ...(pluginEnrichment.perCall.size > 0 || pluginEnrichment.extraSpans.length > 0 ? { pluginEnrichment } : {}),
            log: msg => process.stderr.write(`${msg}\n`),
          })
        }

        if (result.outcome === 'auth-rejected') {
          process.stderr.write(t('Auth rejected by server. Run `codeburn sync setup` to re-authenticate.') + '\n')
          process.exit(1)
        }
        if (result.outcome === 'rate-limited') {
          process.stderr.write(t('Rate limited — gave up after repeated retries. Remaining calls will be sent on the next push.') + '\n')
        }
        if (result.outcome === 'server-error') {
          process.stderr.write(t('Server error (HTTP %s). Remaining calls will be sent on the next push.', result.httpStatus) + '\n')
        }

        // Attribution spans ride the same endpoint after the usage push
        // completes. Skipped when the usage push hit rate limits or server
        // errors — the endpoint is already unhappy; both retry on next push.
        let attrResult: PushResult | null = null
        if (opts.attribution && attributionUnsent.length > 0) {
          if (result.outcome === 'complete') {
            // Safety valve, mirroring the usage-call cap
            const attrToPush = attributionUnsent.slice(0, MAX_ATTRIBUTION_PER_PUSH)
            if (attributionUnsent.length > MAX_ATTRIBUTION_PER_PUSH) {
              process.stderr.write(t('%d attribution facts exceed the %d safety limit. Pushing first %d; run again to continue.', attributionUnsent.length, MAX_ATTRIBUTION_PER_PUSH, MAX_ATTRIBUTION_PER_PUSH) + '\n')
            }
            const attrBatches = batchAttributionItems(attrToPush, discoveryDoc.max_batch_size)
            attrResult = await sendAttributionBatches({
              endpoint,
              accessToken: tokens.access_token,
              batches: attrBatches,
              log: msg => process.stderr.write(`${msg}\n`),
            })
            if (attrResult.outcome === 'auth-rejected') {
              process.stderr.write(t('Auth rejected by server during attribution push. Run `codeburn sync setup` to re-authenticate.') + '\n')
              process.exit(1)
            }
            if (attrResult.outcome === 'rate-limited') {
              process.stderr.write(t('Rate limited during attribution push — gave up after repeated retries. Remaining facts will be sent on the next push.') + '\n')
            }
            if (attrResult.outcome === 'server-error') {
              process.stderr.write(t('Server error (HTTP %s) during attribution push. Remaining facts will be sent on the next push.', attrResult.httpStatus) + '\n')
            }
          } else {
            process.stderr.write(t('Skipping attribution push (%d facts) — will retry on next push.', attributionUnsent.length) + '\n')
          }
        }

        // Update lastSync
        updateLastSync()

        // Summary
        process.stderr.write('\n' + t('Synced %d calls ($%s) to %s', result.totalSent, result.totalCostSent.toFixed(2), config.baseUrl) + '\n')
        if (attrResult) {
          const attrSuffix = attrResult.outcome !== 'complete'
            ? ' ' + t('(push incomplete — remainder retries next push)')
            : attrResult.totalRejected > 0 ? ', ' + t('%d rejected (will retry)', attrResult.totalRejected) : ''
          process.stderr.write('  ' + t('Attribution: %d facts synced%s', attrResult.totalSent, attrSuffix) + '\n')
        }
        if (result.totalRejected > 0) {
          process.stderr.write('  ' + t('%d spans rejected (will retry on next push)', result.totalRejected) + '\n')
        }
        if (unsent.length > MAX_PER_PUSH) {
          process.stderr.write('  ' + t('%d calls remaining (safety limit). Run `codeburn sync push` again.', unsent.length - MAX_PER_PUSH) + '\n')
        }

        // Non-zero exit when the push did not complete, so cron/scripts can
        // detect it. Ledgered progress is kept; next push resumes.
        if (result.outcome !== 'complete' || (attrResult !== null && attrResult.outcome !== 'complete')) {
          process.exitCode = 1
        }
      } catch (err) {
        process.stderr.write(`${(err as Error).message}\n`)
        process.exit(1)
      }
    })

  // --- auto (parent) ---
  const auto = sync
    .command('auto')
    .description(t('Manage automatic scheduled pushes'))

  // --- auto enable ---
  auto
    .command('enable')
    .description(t('Enable automatic scheduled pushes (requires --accept to proceed)'))
    .option('--cadence <cadence>', t('Schedule frequency: daily or hourly'), 'daily')
    .option('--attribution', t('Also send work-matching data (session-to-commit links)'))
    .option('--accept', t('Accept the disclosure and enable automatic sync'))
    .action(async (opts: { cadence?: string; attribution?: boolean; accept?: boolean }) => {
      const config = readSyncConfig()
      if (!config) {
        process.stderr.write(t('Sync not configured. Run `codeburn sync setup <url>` first.') + '\n')
        process.exit(1)
      }

      const cadence = opts.cadence as 'daily' | 'hourly'
      if (cadence !== 'daily' && cadence !== 'hourly') {
        process.stderr.write(t('Invalid --cadence. Use: daily or hourly') + '\n')
        process.exit(1)
      }

      try {
        const pluginLoads: PluginLoad[] = await loadPlugins()
        const pluginKeys = declaredSyncAttributes(pluginLoads)
        const allKeys = Array.from(CORE_SYNC_ATTRIBUTE_KEYS)
          .concat(Array.from(pluginKeys.keys()))
          .sort()

        const fieldList = allKeys.map(key => {
          const plugin = pluginKeys.get(key)
          const disclosure = plugin?.disclosure ?? CORE_SYNC_FIELD_MEANINGS.get(key) ?? t('(no description)')
          return { key, disclosure }
        })

        const workMatching = opts.attribution ?? false
        const fingerprintInput = buildAcceptanceFingerprintInput(config, allKeys, workMatching, cadence)
        const fingerprint = computeAcceptanceFingerprint(fingerprintInput)

        const disclosureInput: DisclosureInput = {
          destination: config.clientId,
          destinationUrl: config.baseUrl,
          cadence,
          outboundFields: fieldList,
          workMatching,
          scopeSinceDays: 7,
        }

        const disclosure = buildDisclosure(disclosureInput)
        process.stdout.write(disclosure + '\n\n')

        if (!opts.accept) {
          process.stderr.write(t('Re-run with --accept to consent to exactly this.') + '\n')
          process.exit(1)
        }

        config.auto = {
          accepted: {
            fingerprint,
            acceptedAt: new Date().toISOString(),
            cadence,
            disclosure,
            attribution: workMatching,
            input: fingerprintInput,
          },
          killed: false,
        }
        delete config.auto.killed
        writeSyncConfig(config)

        try {
          await installSchedule(cadence, process.execPath, process.argv[1])
          process.stdout.write(t('Automatic sync enabled (%s). Fingerprint: %s', cadence, fingerprint) + '\n')
        } catch (schedErr) {
          process.stderr.write(t('Warning: %s', (schedErr as Error).message) + '\n')
          process.stderr.write(t('Acceptance was stored and will take effect, but the schedule could not be installed.') + '\n')
          process.stderr.write(t('Run: codeburn sync auto enable --cadence %s --attribution', cadence) + '\n')
          process.stderr.write(t('Or install manually: launchctl load ~/Library/LaunchAgents/com.codeburn.sync-auto.plist') + '\n')
          process.exit(1)
        }
      } catch (err) {
        process.stderr.write(`${(err as Error).message}\n`)
        process.exit(1)
      }
    })

  // --- auto disable ---
  auto
    .command('disable')
    .description(t('Disable automatic scheduled pushes (kill switch)'))
    .action(async () => {
      const config = readSyncConfig()
      if (!config) {
        process.stderr.write(t('Sync not configured.') + '\n')
        return
      }

      if (!config.auto?.accepted) {
        process.stdout.write(t('Automatic sync was not enabled.') + '\n')
        return
      }

      config.auto.killed = true
      writeSyncConfig(config)

      try {
        await removeSchedule()
      } catch {
        // Best effort
      }

      process.stdout.write(t('Automatic sync disabled.') + '\n')
    })

  // --- auto status ---
  auto
    .command('status')
    .description(t('Show automatic sync status and recent receipts'))
    .option('--json', t('Output as machine-readable JSON'))
    .action(async (opts: { json?: boolean }) => {
      const config = readSyncConfig()

      let currentMatches: boolean | undefined
      let changed: string[] = []
      const accepted = config?.auto?.accepted

      // Recompute fingerprint to check for changes
      if (accepted) {
        try {
          const pluginLoads: PluginLoad[] = await loadPlugins()
          const pluginKeys = declaredSyncAttributes(pluginLoads)
          const allKeys = Array.from(CORE_SYNC_ATTRIBUTE_KEYS)
            .concat(Array.from(pluginKeys.keys()))
            .sort()

          const fingerprintInput = buildAcceptanceFingerprintInput(config, allKeys, accepted.attribution, accepted.cadence)
          const currentFingerprint = computeAcceptanceFingerprint(fingerprintInput)
          currentMatches = currentFingerprint === accepted.fingerprint
          if (!currentMatches) {
            changed = detectFingerprintChanges(accepted.input, fingerprintInput)
          }
        } catch {
          currentMatches = undefined
        }
      }

      if (opts.json) {
        const result: Record<string, unknown> = {
          configured: !!accepted,
          killed: config?.auto?.killed ?? false,
        }

        if (accepted) {
          result.accepted = {
            fingerprint: accepted.fingerprint,
            acceptedAt: accepted.acceptedAt,
            cadence: accepted.cadence,
            attribution: accepted.attribution,
          }
          if (currentMatches !== undefined) {
            result.currentMatches = currentMatches
            if (!currentMatches) {
              result.changed = changed
            }
          }
        }

        const receipts = readReceipts(5)
        result.receipts = receipts

        process.stdout.write(JSON.stringify(result, null, 0) + '\n')
        return
      }

      if (!config?.auto?.accepted) {
        process.stdout.write(t('Automatic sync is not configured.') + '\n')
        return
      }

      const acceptedRecord = config.auto.accepted
      if (typeof acceptedRecord.fingerprint !== 'string' || typeof acceptedRecord.acceptedAt !== 'string') {
        process.stdout.write(t('Automatic sync acceptance record is damaged. Run: codeburn sync auto enable --cadence <daily|hourly> --accept') + '\n')
        process.exit(1)
        return
      }

      process.stdout.write(t('Accepted fingerprint: %s', acceptedRecord.fingerprint) + '\n')
      process.stdout.write(t('Accepted at: %s', acceptedRecord.acceptedAt) + '\n')
      process.stdout.write(t('Cadence: %s', acceptedRecord.cadence) + '\n')

      if (currentMatches === true) {
        process.stdout.write(t('Current fingerprint: MATCHES') + '\n')
      } else if (currentMatches === false) {
        process.stdout.write(t('Current fingerprint: DIFFERS (%s)', changed.join(', ')) + '\n')
      } else {
        process.stdout.write(t('Current fingerprint: unable to recompute') + '\n')
      }

      process.stdout.write(t('Killed: %s', config.auto.killed ? t('yes') : t('no')) + '\n')

      const receipts = readReceipts(5)
      if (receipts.length > 0) {
        process.stdout.write('\n' + t('Last 5 receipts:') + '\n')
        for (const r of receipts) {
          process.stdout.write(`  ${r.at} - ${r.result}\n`)
        }
      }
    })

  // --- auto run ---
  auto
    .command('run')
    .description(t('Run automatic push (invoked by scheduler)'))
    .action(async () => {
      const config = readSyncConfig()
      const at = new Date().toISOString()

      if (config?.auto?.killed) {
        appendReceipt(buildReceipt(at, undefined, { result: 'killed' }))
        return
      }

      if (!config?.auto?.accepted) {
        appendReceipt(buildReceipt(at, undefined, { result: 'not-accepted' }))
        return
      }

      const accepted = config.auto.accepted

      try {
        // Recompute fingerprint
        const pluginLoads: PluginLoad[] = await loadPlugins()
        const pluginKeys = declaredSyncAttributes(pluginLoads)
        const allKeys = Array.from(CORE_SYNC_ATTRIBUTE_KEYS)
          .concat(Array.from(pluginKeys.keys()))
          .sort()

        const fingerprintInput = buildAcceptanceFingerprintInput(config, allKeys, accepted.attribution, accepted.cadence)
        const currentFingerprint = computeAcceptanceFingerprint(fingerprintInput)

        if (currentFingerprint !== accepted.fingerprint) {
          const changed = detectFingerprintChanges(accepted.input, fingerprintInput)
          appendReceipt(buildReceipt(
            at,
            currentFingerprint,
            { result: 'acceptance-required', changed }
          ))
          return
        }

        // Collect data - 7 day window. Sent-ledger prevents duplicates across runs,
        // so daily/hourly rescans don't lose anything.
        const { parseAllSessions } = await import('../parser.js')
        const { getDateRange } = await import('../cli-date.js')

        const range = getDateRange('week').range
        const projects = (await parseAllSessions(range))
          .map(p => ({ ...p, project: wireProjectName(p.projectPath, p.project) }))

        const { readPlans } = await import('../config.js')
        const plans = await readPlans()

        const { loadDailyCache } = await import('../daily-cache.js')
        const dailyCache = await loadDailyCache()
        const coverageThrough = dailyCache.complete === true && dailyCache.watermarkTrusted === true && dailyCache.lastComputedDate
          ? dailyCache.lastComputedDate
          : undefined

        const { unsent } = collectUnsentCalls(projects, Date.now(), { plans })

        if (unsent.length === 0) {
          appendReceipt(buildReceipt(at, currentFingerprint, { result: 'pushed', spans: 0 }))
          return
        }

        const store = createCredentialStore()
        const rt = store.retrieve()
        if (!rt) {
          appendReceipt(buildReceipt(at, currentFingerprint, { result: 'error', reason: 'no auth token' }))
          return
        }

        const oidc = await fetchOidcConfig(config.issuer)
        const tokens = await refreshToken(oidc.token_endpoint, rt, config.clientId)

        if (tokens.refresh_token && tokens.refresh_token !== rt) {
          store.store(tokens.refresh_token)
        }

        // Collect attribution if enabled
        let attributionUnsent: Awaited<ReturnType<typeof collectUnsentAttribution>>['unsent'] = []
        if (accepted.attribution) {
          const { computeAttributionRecords } = await import('../yield.js')
          const records = computeAttributionRecords(projects, range, process.cwd())
          const collected = collectUnsentAttribution(records)
          attributionUnsent = collected.unsent
        }

        // Use shared push helper
        const pluginAttributeKeys: ReadonlySet<string> = new Set(pluginKeys.keys())
        const { result, attrFacts } = await executePush({
          config,
          unsent,
          attributionUnsent,
          pluginAttributeKeys,
          coverageThrough,
          tokens,
          silent: true,
        })

        if (result.outcome === 'complete') {
          const receipt: Record<string, unknown> = { result: 'pushed', spans: result.totalSent }
          if (attrFacts > 0) {
            receipt.attributionFacts = attrFacts
          }
          appendReceipt(buildReceipt(at, currentFingerprint, receipt as any))
        } else {
          appendReceipt(buildReceipt(at, currentFingerprint, { result: 'error', reason: result.outcome }))
        }
      } catch (err) {
        appendReceipt(buildReceipt(
          at,
          undefined,
          { result: 'error', reason: err instanceof Error ? err.message : String(err) }
        ))
      }
    })
}
