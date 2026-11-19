// Small bounded in-memory TTL cache with LRU-ish eviction and in-flight
// fetch de-duplication. Failed fetches are never cached.

export const envInt = (name: string, fallback: number): number => {
  const n = Number.parseInt(process.env[name] ?? '', 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export class TtlCache<V> {
  private entries = new Map<string, { expires: number; value: V }>()
  private inflight = new Map<string, Promise<V>>()

  constructor(
    private ttlMs: number,
    private maxEntries: number,
  ) {}

  get size() {
    return this.entries.size
  }

  get(key: string): V | undefined {
    const e = this.entries.get(key)
    if (!e) return undefined
    if (e.expires <= Date.now()) {
      this.entries.delete(key)
      return undefined
    }
    // refresh recency
    this.entries.delete(key)
    this.entries.set(key, e)
    return e.value
  }

  set(key: string, value: V) {
    this.entries.delete(key)
    this.entries.set(key, { expires: Date.now() + this.ttlMs, value })
    if (this.entries.size > this.maxEntries) {
      const now = Date.now()
      // drop expired first, then oldest
      for (const [k, v] of this.entries) {
        if (v.expires <= now) this.entries.delete(k)
      }
      while (this.entries.size > this.maxEntries) {
        const oldest = this.entries.keys().next().value as string
        this.entries.delete(oldest)
      }
    }
  }

  async getOrFetch(key: string, fetcher: () => Promise<V>): Promise<V> {
    const hit = this.get(key)
    if (hit !== undefined) return hit
    const pending = this.inflight.get(key)
    if (pending) return pending
    const p = (async () => {
      try {
        const value = await fetcher()
        this.set(key, value)
        return value
      } finally {
        this.inflight.delete(key)
      }
    })()
    this.inflight.set(key, p)
    return p
  }

  clear() {
    this.entries.clear()
    this.inflight.clear()
  }
}
