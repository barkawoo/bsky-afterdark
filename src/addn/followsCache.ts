import { BskyAgent } from '@atproto/api'
import { TtlCache, envInt } from './ttlCache'

// DID -> list of followed DIDs (requester NOT included)
export const followsCache = new TtlCache<string[]>(
  envInt('FOLLOWS_CACHE_TTL_SECONDS', 600) * 1000,
  envInt('FOLLOWS_CACHE_MAX_ENTRIES', 5000),
)

// Pages through all follows of `did`; cached per DID. Rejects on API failure (not cached).
export const getAllFollows = (agent: BskyAgent, did: string): Promise<string[]> =>
  followsCache.getOrFetch(did, async () => {
    const follows: string[] = []
    let cursor: string | null = null
    try {
      while (true) {
        const res: any = await agent.api.app.bsky.graph.getFollows({
          actor: did,
          limit: 100, // default 50, max 100
          ...(cursor !== null ? { cursor } : {}),
        })
        follows.push(...res.data.follows.map((p: any) => p.did))
        if (res.data.cursor) cursor = res.data.cursor
        else break
      }
    } catch (err: any) {
      // keep pre-cache behaviour: callers may still use the follows fetched so far
      if (err && typeof err === 'object') err.partialFollows = follows
      throw err
    }
    return follows
  })
