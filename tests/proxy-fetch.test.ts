import { describe, expect, it } from 'vitest'
import { matchesNoProxy, resolveProxyUrlForUrl } from '../src/fetch-utils.js'

// Node's global fetch ignores http_proxy/https_proxy, unlike curl and npm, so
// every outbound request fails with a bare "fetch failed" on a machine that
// only reaches the internet through a proxy. These cover the selection rules
// the dispatcher is built from.
describe('resolveProxyUrlForUrl', () => {
  it('routes https through HTTPS_PROXY', () => {
    expect(resolveProxyUrlForUrl('https://github.com/x', { HTTPS_PROXY: 'http://127.0.0.1:7890' }))
      .toBe('http://127.0.0.1:7890')
  })

  it('falls back to HTTP_PROXY for https when no https proxy is set', () => {
    expect(resolveProxyUrlForUrl('https://github.com/x', { HTTP_PROXY: 'http://p:1' })).toBe('http://p:1')
  })

  it('never routes http through an https-only proxy variable', () => {
    expect(resolveProxyUrlForUrl('http://example.com/x', { HTTPS_PROXY: 'http://p:1' })).toBeUndefined()
  })

  it('prefers the upper-case variable, matching curl', () => {
    expect(resolveProxyUrlForUrl('https://github.com/x', {
      HTTPS_PROXY: 'http://upper:1',
      https_proxy: 'http://lower:2',
    })).toBe('http://upper:1')
  })

  it('accepts the lower-case variable on its own', () => {
    expect(resolveProxyUrlForUrl('https://github.com/x', { https_proxy: 'http://lower:2' })).toBe('http://lower:2')
  })

  it('returns nothing when no proxy is configured', () => {
    expect(resolveProxyUrlForUrl('https://github.com/x', {})).toBeUndefined()
  })

  it('honours NO_PROXY so a local dashboard is not tunnelled', () => {
    const env = { HTTPS_PROXY: 'http://p:1', HTTP_PROXY: 'http://p:1', NO_PROXY: 'localhost,127.0.0.1' }
    expect(resolveProxyUrlForUrl('http://127.0.0.1:4747/api/usage', env)).toBeUndefined()
    expect(resolveProxyUrlForUrl('http://localhost:4747/api/usage', env)).toBeUndefined()
    expect(resolveProxyUrlForUrl('https://github.com/x', env)).toBe('http://p:1')
  })

  it('ignores a malformed url instead of throwing', () => {
    expect(resolveProxyUrlForUrl('not a url', { HTTPS_PROXY: 'http://p:1' })).toBeUndefined()
  })

  it('leaves non-http schemes alone', () => {
    expect(resolveProxyUrlForUrl('ftp://example.com/x', { HTTP_PROXY: 'http://p:1' })).toBeUndefined()
  })
})

describe('matchesNoProxy', () => {
  it('matches a bare host and its subdomains', () => {
    expect(matchesNoProxy('example.com', 'example.com')).toBe(true)
    expect(matchesNoProxy('api.example.com', 'example.com')).toBe(true)
    expect(matchesNoProxy('notexample.com', 'example.com')).toBe(false)
  })

  it('matches a leading-dot rule against the domain itself too', () => {
    expect(matchesNoProxy('example.com', '.example.com')).toBe(true)
    expect(matchesNoProxy('api.example.com', '.example.com')).toBe(true)
  })

  it('treats * as bypass everything', () => {
    expect(matchesNoProxy('anything.test', '*')).toBe(true)
  })

  it('ignores the port in a rule', () => {
    expect(matchesNoProxy('localhost', 'localhost:3000')).toBe(true)
  })

  it('is empty-safe', () => {
    expect(matchesNoProxy('example.com', undefined)).toBe(false)
    expect(matchesNoProxy('example.com', '')).toBe(false)
    expect(matchesNoProxy('example.com', ' , ')).toBe(false)
  })
})
