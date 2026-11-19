import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { makeMockAgent } from './helpers/mockAgent'

const db = vi.hoisted(() => ({ getLatestPostsForTag: undefined as any }))
vi.mock('../src/db/dbClient', async () => {
  const m = (await import('./helpers/mockDbClient')).makeMockDbClient()
  Object.assign(db, m)
  return { default: db }
})

import { handler, shortname } from '../src/algos/afterdark'
import { followsCache } from '../src/addn/followsCache'
import { likesCache } from '../src/addn/likesCache'

const ctx: any = {}
const page = (dids: string[], cursor?: string) => ({
  data: { follows: dids.map((did) => ({ did })), cursor },
})
const likesPage = (dids: string[], cursor?: string) => ({
  data: { likes: dids.map((did) => ({ actor: { did } })), cursor },
})

describe('afterdark handler (characterization)', () => {
  beforeEach(() => {
    followsCache.clear()
    likesCache.clear()
    db.getLatestPostsForTag.mockReset().mockResolvedValue([])
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  it('pages through all follows and passes requester + follows as authors', async () => {
    const agent: any = makeMockAgent()
    agent.api.app.bsky.graph.getFollows
      .mockResolvedValueOnce(page(['did:a', 'did:b'], 'c1'))
      .mockResolvedValueOnce(page(['did:c'], 'c2'))
      .mockResolvedValueOnce(page(['did:d']))
    await handler(ctx, { feed: 'f', limit: 30 } as any, agent, 'did:me')
    const calls = agent.api.app.bsky.graph.getFollows.mock.calls
    expect(calls).toHaveLength(3)
    expect(calls[0][0]).toEqual({ actor: 'did:me', limit: 100 })
    expect(calls[1][0]).toEqual({ actor: 'did:me', limit: 100, cursor: 'c1' })
    expect(calls[2][0]).toEqual({ actor: 'did:me', limit: 100, cursor: 'c2' })
    const arg = db.getLatestPostsForTag.mock.calls[0][0]
    expect(arg.authors).toEqual(['did:me', 'did:a', 'did:b', 'did:c', 'did:d'])
    expect(arg).toMatchObject({ tag: shortname, limit: 30, mediaOnly: true, nsfwOnly: true, excludeNSFW: false })
  })

  it('passes params.cursor through to the db', async () => {
    const agent: any = makeMockAgent()
    await handler(ctx, { feed: 'f', limit: 5, cursor: '123::abc' } as any, agent, 'did:me')
    expect(db.getLatestPostsForTag.mock.calls[0][0].cursor).toBe('123::abc')
  })

  it('no requester: no follows fetched, empty authors', async () => {
    const agent: any = makeMockAgent()
    await handler(ctx, { feed: 'f', limit: 30 } as any, agent, null)
    expect(agent.api.app.bsky.graph.getFollows).not.toHaveBeenCalled()
    expect(db.getLatestPostsForTag.mock.calls[0][0].authors).toEqual([])
  })

  it('follows failure is caught and requester-only authors remain', async () => {
    const agent: any = makeMockAgent()
    agent.api.app.bsky.graph.getFollows
      .mockResolvedValueOnce(page(['did:a'], 'c1'))
      .mockRejectedValueOnce(new Error('boom'))
    await handler(ctx, { feed: 'f', limit: 30 } as any, agent, 'did:me')
    expect(db.getLatestPostsForTag.mock.calls[0][0].authors).toEqual(['did:me', 'did:a'])
  })

  it('inserts pinned post first when requester has not liked it', async () => {
    const agent: any = makeMockAgent()
    db.getLatestPostsForTag.mockResolvedValue([{ uri: 'at://p/1', cid: 'x', indexedAt: '2024-01-01T00:00:00.000Z' }])
    agent.api.app.bsky.feed.getLikes
      .mockResolvedValueOnce(likesPage(['did:z'], 'l1'))
      .mockResolvedValueOnce(likesPage(['did:y']))
    const out = await handler(ctx, { feed: 'f', limit: 30 } as any, agent, 'did:me')
    expect(out.feed).toHaveLength(2)
    expect(out.feed[0].post).toMatch(/app\.bsky\.feed\.post\/3lhyfj7p7hk2r$/)
    expect(out.feed[1]).toEqual({ post: 'at://p/1' })
    const lc = agent.api.app.bsky.feed.getLikes.mock.calls
    expect(lc).toHaveLength(2)
    expect(lc[1][0].cursor).toBe('l1')
  })

  it('omits pinned post when requester already liked it', async () => {
    const agent: any = makeMockAgent()
    db.getLatestPostsForTag.mockResolvedValue([{ uri: 'at://p/1', cid: 'x', indexedAt: '2024-01-01T00:00:00.000Z' }])
    agent.api.app.bsky.feed.getLikes.mockResolvedValueOnce(likesPage(['did:me']))
    const out = await handler(ctx, { feed: 'f', limit: 30 } as any, agent, 'did:me')
    expect(out.feed).toEqual([{ post: 'at://p/1' }])
  })

  it('no requester: pinned post is not inserted', async () => {
    const agent: any = makeMockAgent()
    const out = await handler(ctx, { feed: 'f', limit: 30 } as any, agent, null)
    expect(out.feed).toEqual([])
  })

  it('cursor is "<ms>::<cid>" of last row, undefined when no rows', async () => {
    const agent: any = makeMockAgent()
    db.getLatestPostsForTag.mockResolvedValue([
      { uri: 'at://p/1', cid: 'c1', indexedAt: '2024-01-01T00:00:00.000Z' },
      { uri: 'at://p/2', cid: 'c2', indexedAt: '2024-01-02T00:00:00.000Z' },
    ])
    const out = await handler(ctx, { feed: 'f', limit: 30 } as any, agent, 'did:me')
    expect(out.cursor).toBe(`${Date.parse('2024-01-02T00:00:00.000Z')}::c2`)
    db.getLatestPostsForTag.mockResolvedValue([])
    const empty = await handler(ctx, { feed: 'f', limit: 30 } as any, agent, 'did:me')
    expect(empty.cursor).toBeUndefined()
  })

  describe('caching', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())
    const p: any = { feed: 'f', limit: 30 }

    it('follows cache hit avoids API calls and keeps authors identical', async () => {
      const agent: any = makeMockAgent()
      agent.api.app.bsky.graph.getFollows.mockResolvedValue(page(['did:a']))
      await handler(ctx, p, agent, 'did:me')
      await handler(ctx, p, agent, 'did:me')
      expect(agent.api.app.bsky.graph.getFollows).toHaveBeenCalledTimes(1)
      expect(db.getLatestPostsForTag.mock.calls[1][0].authors).toEqual(['did:me', 'did:a'])
    })

    it('follows cache is per DID and expires after TTL', async () => {
      const agent: any = makeMockAgent()
      await handler(ctx, p, agent, 'did:me')
      await handler(ctx, p, agent, 'did:you')
      expect(agent.api.app.bsky.graph.getFollows).toHaveBeenCalledTimes(2)
      vi.advanceTimersByTime(10 * 60 * 1000 + 1)
      await handler(ctx, p, agent, 'did:me')
      expect(agent.api.app.bsky.graph.getFollows).toHaveBeenCalledTimes(3)
    })

    it('failed follows fetch is not cached', async () => {
      const agent: any = makeMockAgent()
      agent.api.app.bsky.graph.getFollows.mockRejectedValueOnce(new Error('boom'))
      await handler(ctx, p, agent, 'did:me')
      await handler(ctx, p, agent, 'did:me')
      expect(agent.api.app.bsky.graph.getFollows).toHaveBeenCalledTimes(2)
    })

    it('concurrent requests share one in-flight follows fetch', async () => {
      const agent: any = makeMockAgent()
      let release!: (v: any) => void
      agent.api.app.bsky.graph.getFollows.mockReturnValue(new Promise((r) => (release = r)))
      const a = handler(ctx, p, agent, 'did:me')
      const b = handler(ctx, p, agent, 'did:me')
      await Promise.resolve()
      release(page(['did:a']))
      await Promise.all([a, b])
      expect(agent.api.app.bsky.graph.getFollows).toHaveBeenCalledTimes(1)
    })

    it('likes cache hit avoids API calls, expires after TTL, dedupes in flight', async () => {
      const agent: any = makeMockAgent()
      await handler(ctx, p, agent, 'did:me')
      await handler(ctx, p, agent, 'did:me')
      expect(agent.api.app.bsky.feed.getLikes).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(61_000)
      await handler(ctx, p, agent, 'did:me')
      expect(agent.api.app.bsky.feed.getLikes).toHaveBeenCalledTimes(2)

      likesCache.clear()
      let release!: (v: any) => void
      agent.api.app.bsky.feed.getLikes.mockReset().mockReturnValue(new Promise((r) => (release = r)))
      const a = handler(ctx, p, agent, 'did:me')
      const b = handler(ctx, p, agent, 'did:you')
      await Promise.resolve()
      await Promise.resolve()
      release(likesPage([]))
      await Promise.all([a, b])
      expect(agent.api.app.bsky.feed.getLikes).toHaveBeenCalledTimes(1)
    })

    it('likes pagination cursor is per post (not carried between pinned posts)', async () => {
      const { getAllLikers } = await import('../src/addn/likesCache')
      const agent: any = makeMockAgent()
      agent.api.app.bsky.feed.getLikes
        .mockResolvedValueOnce(likesPage(['did:1'], 'cur1'))
        .mockResolvedValueOnce(likesPage(['did:2']))
        .mockResolvedValueOnce(likesPage(['did:3']))
      await getAllLikers(agent, 'at://post/1')
      const second = await getAllLikers(agent, 'at://post/2')
      const calls = agent.api.app.bsky.feed.getLikes.mock.calls
      expect(calls[2][0]).toEqual({ uri: 'at://post/2', limit: 100 })
      expect([...second]).toEqual(['did:3'])
    })
  })
})
