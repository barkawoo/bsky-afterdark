import { BskyAgent } from '@atproto/api'
import { TtlCache, envInt } from './ttlCache'

// post URI -> set of DIDs that liked it
export const likesCache = new TtlCache<Set<string>>(
  envInt('LIKES_CACHE_TTL_SECONDS', 60) * 1000,
  envInt('LIKES_CACHE_MAX_ENTRIES', 100),
)

// Pages through all likes of `uri`; cached per URI. Rejects on API failure (not cached).
export const getAllLikers = (agent: BskyAgent, uri: string): Promise<Set<string>> =>
  likesCache.getOrFetch(uri, async () => {
    const likers = new Set<string>()
    let cursor: string | null = null
    while (true) {
      const res: any = await agent.api.app.bsky.feed.getLikes({
        uri,
        limit: 100, // default 50, max 100
        ...(cursor !== null ? { cursor } : {}),
      })
      for (const l of res.data.likes) likers.add(l.actor.did)
      if (res.data.cursor) cursor = res.data.cursor
      else break
    }
    return likers
  })
