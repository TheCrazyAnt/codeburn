// Default ceiling for outbound HTTP. Every CLI command awaits loadPricing(),
// and the macOS menubar shells out to the CLI and blocks on its exit — so an
// unbounded fetch() on a half-open network (e.g. Wi-Fi/DNS not yet up after
// wake-from-sleep) wedges the menubar on its loading spinner indefinitely.
// 8s is generous for these small JSON endpoints while still failing fast.
export const DEFAULT_FETCH_TIMEOUT_MS = 8000

/// fetch() with a hard timeout. On timeout the returned promise rejects with a
/// TimeoutError (an AbortError subtype), which callers already handle via their
/// existing try/catch + bundled-snapshot fallback. A caller-supplied signal is
/// combined with the timeout so either can abort the request.
export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const signal = init.signal
    ? AbortSignal.any([init.signal, timeoutSignal])
    : timeoutSignal
  const dispatcher = await proxyDispatcherFor(url)
  // `dispatcher` is an undici option that Node's global fetch accepts but
  // TypeScript's DOM RequestInit does not declare, hence the cast.
  return fetch(url, { ...init, signal, ...(dispatcher ? { dispatcher } : {}) } as RequestInit)
}

type ProxyEnv = Partial<Record<'HTTPS_PROXY' | 'https_proxy' | 'HTTP_PROXY' | 'http_proxy' | 'NO_PROXY' | 'no_proxy', string>>

/// The proxy URL that applies to `url`, honouring NO_PROXY. Upper case wins over
/// lower case for the same variable, matching curl and the wider CLI convention.
export function resolveProxyUrlForUrl(url: string, env: ProxyEnv = process.env): string | undefined {
  let target: URL
  try {
    target = new URL(url)
  } catch {
    return undefined
  }
  if (matchesNoProxy(target.hostname, env.NO_PROXY ?? env.no_proxy)) return undefined
  if (target.protocol === 'https:') return env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy
  if (target.protocol === 'http:') return env.HTTP_PROXY ?? env.http_proxy
  return undefined
}

export function matchesNoProxy(hostname: string, noProxy?: string): boolean {
  if (!noProxy) return false
  const host = hostname.toLowerCase()
  return noProxy.split(',').some(entry => {
    const rule = entry.trim().toLowerCase().split(':')[0]
    if (!rule) return false
    if (rule === '*') return true
    if (rule.startsWith('.')) return host === rule.slice(1) || host.endsWith(rule)
    return host === rule || host.endsWith(`.${rule}`)
  })
}

/// One ProxyAgent per proxy URL. Node's global fetch ignores http_proxy /
/// https_proxy entirely — unlike curl, npm and git — so without this every
/// outbound request fails with a bare "fetch failed" on a machine that only
/// reaches the internet through a proxy. Agents are cached because each one
/// owns a connection pool.
const proxyAgents = new Map<string, unknown>()

/// Loaded on first proxied request only: a machine with no proxy configured
/// never pays undici's import cost, and this module is on the startup path of
/// every command.
let proxyAgentCtor: Promise<(new (uri: string) => unknown) | undefined> | undefined

async function proxyDispatcherFor(url: string): Promise<unknown> {
  const proxyUrl = resolveProxyUrlForUrl(url)
  if (!proxyUrl) return undefined
  const cached = proxyAgents.get(proxyUrl)
  if (cached) return cached
  proxyAgentCtor ??= import('undici').then(
    m => m.ProxyAgent as unknown as new (uri: string) => unknown,
    // A missing or broken undici degrades to a direct connection rather than
    // taking down an unrelated command.
    () => undefined,
  )
  const ProxyAgent = await proxyAgentCtor
  if (!ProxyAgent) return undefined
  let agent: unknown
  try {
    agent = new ProxyAgent(proxyUrl)
  } catch {
    return undefined
  }
  proxyAgents.set(proxyUrl, agent)
  return agent
}
