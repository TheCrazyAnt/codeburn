/// Per-selection payload cache. Entries are served instantly on tab switches and
/// refreshed in the background (stale-while-revalidate); `age` lets the caller decide
/// whether a background refresh is due.
///
/// Keys are opaque strings built by the caller (see `selectionKey` in App.tsx), so a
/// selection can grow new dimensions -- scope, a day pick -- without this class
/// learning what they mean.

interface CacheEntry<T> {
  data: T
  ts: number
}

export class PayloadCache<T> {
  private store = new Map<string, CacheEntry<T>>()
  private flights = new Set<string>()

  get(key: string): T | null {
    return this.store.get(key)?.data ?? null
  }

  /// Milliseconds since the entry was stored, or Infinity when absent.
  age(key: string): number {
    const entry = this.store.get(key)
    return entry ? Date.now() - entry.ts : Number.POSITIVE_INFINITY
  }

  set(key: string, data: T): void {
    this.store.set(key, { data, ts: Date.now() })
  }

  isInFlight(key: string): boolean {
    return this.flights.has(key)
  }

  markInFlight(key: string): void {
    this.flights.add(key)
  }

  clearInFlight(key: string): void {
    this.flights.delete(key)
  }
}
