import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeMockDbClient } from '../helpers/mockDbClient'
import { makeMockAgent } from '../helpers/mockAgent'

process.env.FEEDGEN_PUBLISHER_DID = 'did:plc:publisher'

// src/db/dbClient connects to Mongo at import time, so it must always be mocked.
vi.mock('../../src/db/dbClient', () => ({ default: makeMockDbClient() }))

import dbClient from '../../src/db/dbClient'
import * as afterdark from '../../src/algos/afterdark'

const db = dbClient as any
const BLOCKED = 'did:plc:mcb6n67plnrlx4lg35natk2b'

const makePost = (over: any = {}): any => ({
  _id: null,
  uri: 'at://did:plc:valid/app.bsky.feed.post/1',
  cid: 'cid1',
  author: 'did:plc:valid',
  text: 'Test post',
  indexedAt: Date.now(),
  replyRoot: null,
  replyParent: null,
  algoTags: null,
  ...over,
})

const mockPosts = [
  { uri: 'at://did:plc:123/app.bsky.feed.post/1', cid: 'cid1', indexedAt: Date.now() },
  { uri: 'at://did:plc:456/app.bsky.feed.post/2', cid: 'cid2', indexedAt: Date.now() },
]

const params = { feed: afterdark.shortname, limit: 50, cursor: undefined }
const dbArgs = (authors: string[]) => ({
  tag: afterdark.shortname,
  limit: 50,
  cursor: undefined,
  mediaOnly: true,
  nsfwOnly: true,
  excludeNSFW: false,
  authors,
})

describe('afterdark algorithm', () => {
  let agent: any
  let mockDb: any
  let ctx: any

  beforeEach(() => {
    agent = makeMockAgent()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    mockDb = { removeTagFromOldPosts: vi.fn() }
    ctx = { db: mockDb }
    // clearMocks keeps implementations, so reset per-test overrides on the shared db mock
    db.getLatestPostsForTag.mockResolvedValue([])
  })

  describe('handler', () => {
    it('returns feed items and a cursor without requesterDID', async () => {
      db.getLatestPostsForTag.mockResolvedValue(mockPosts)
      const result = await afterdark.handler(ctx, params, agent)
      expect(db.getLatestPostsForTag).toHaveBeenCalledWith(dbArgs([]))
      expect(agent.api.app.bsky.graph.getFollows).not.toHaveBeenCalled()
      expect(result.feed.map((f: any) => f.post)).toEqual(mockPosts.map((p) => p.uri))
      expect(result.cursor).toBe(`${mockPosts[1].indexedAt}::cid2`)
    })

    it('returns no cursor for an empty page', async () => {
      const result = await afterdark.handler(ctx, params, agent)
      expect(result.feed).toEqual([])
      expect(result.cursor).toBeUndefined()
    })

    it('fetches follows when requesterDID is provided', async () => {
      const requesterDID = 'did:plc:requester'
      agent.api.app.bsky.graph.getFollows.mockResolvedValue({
        data: { follows: [{ did: 'did:plc:follow1' }, { did: 'did:plc:follow2' }], cursor: undefined },
      })
      db.getLatestPostsForTag.mockResolvedValue([mockPosts[0]])
      const result = await afterdark.handler(ctx, params, agent, requesterDID)
      expect(agent.api.app.bsky.graph.getFollows).toHaveBeenCalledWith({ actor: requesterDID, limit: 100 })
      expect(db.getLatestPostsForTag).toHaveBeenCalledWith(
        dbArgs([requesterDID, 'did:plc:follow1', 'did:plc:follow2']),
      )
      // pinned post is prepended for a requester who has not liked it
      expect(result.feed[0].post).toBe(`at://${process.env.FEEDGEN_PUBLISHER_DID}/app.bsky.feed.post/3lhyfj7p7hk2r`)
      expect(result.feed.map((f: any) => f.post)).toContain(mockPosts[0].uri)
      expect(result.feed).toHaveLength(2)
    })

    it('paginates follows', async () => {
      const requesterDID = 'did:plc:requester'
      agent.api.app.bsky.graph.getFollows
        .mockResolvedValueOnce({
          data: { follows: [{ did: 'did:plc:follow1' }, { did: 'did:plc:follow2' }], cursor: 'next-page' },
        })
        .mockResolvedValueOnce({
          data: { follows: [{ did: 'did:plc:follow3' }, { did: 'did:plc:follow4' }], cursor: undefined },
        })
      await afterdark.handler(ctx, params, agent, requesterDID)
      const getFollows = agent.api.app.bsky.graph.getFollows
      expect(getFollows).toHaveBeenCalledTimes(2)
      expect(getFollows).toHaveBeenNthCalledWith(1, { actor: requesterDID, limit: 100 })
      expect(getFollows).toHaveBeenNthCalledWith(2, { actor: requesterDID, limit: 100, cursor: 'next-page' })
      expect(db.getLatestPostsForTag).toHaveBeenCalledWith(
        dbArgs([requesterDID, 'did:plc:follow1', 'did:plc:follow2', 'did:plc:follow3', 'did:plc:follow4']),
      )
    })

    it('falls back to requester-only authors when the follows API errors', async () => {
      const requesterDID = 'did:plc:requester'
      agent.api.app.bsky.graph.getFollows.mockRejectedValue(new Error('API error'))
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})
      const result = await afterdark.handler(ctx, params, agent, requesterDID)
      log.mockRestore()
      expect(db.getLatestPostsForTag).toHaveBeenCalledWith(dbArgs([requesterDID]))
      // pinned post still shown: likes lookup is independent of follows
      expect(result.feed[0].post).toContain('app.bsky.feed.post/3lhyfj7p7hk2r')
    })

    it('hides the pinned post if the requester already liked it', async () => {
      const requesterDID = 'did:plc:requester'
      db.getLatestPostsForTag.mockResolvedValue([mockPosts[0]])
      agent.api.app.bsky.feed.getLikes.mockResolvedValue({
        data: { likes: [{ actor: { did: requesterDID } }], cursor: undefined },
      })
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})
      const result = await afterdark.handler(ctx, params, agent, requesterDID)
      log.mockRestore()
      expect(result.feed.map((f: any) => f.post)).toEqual([mockPosts[0].uri])
    })

    it('shows the pinned post if only other users liked it', async () => {
      agent.api.app.bsky.feed.getLikes.mockResolvedValue({
        data: { likes: [{ actor: { did: 'did:plc:other' } }], cursor: undefined },
      })
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})
      const result = await afterdark.handler(ctx, params, agent, 'did:plc:requester')
      log.mockRestore()
      expect(result.feed).toHaveLength(1)
      expect(result.feed[0].post).toContain('3lhyfj7p7hk2r')
    })

    it('queries pinned-post likes even for anonymous requesters (no pinned item added)', async () => {
      await afterdark.handler(ctx, params, agent)
      expect(agent.api.app.bsky.feed.getLikes).toHaveBeenCalledTimes(1)
    })
  })

  describe('manager', () => {
    let m: any

    beforeEach(() => {
      m = new afterdark.manager(mockDb, agent)
      m.start = vi.fn().mockResolvedValue(undefined)
    })

    it('has the expected name', () => {
      expect(m.name).toBe(afterdark.shortname)
    })

    it('periodicTask removes tags from posts older than 7 days', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2025-01-01T00:00:00Z'))
      try {
        await m.periodicTask()
        expect(mockDb.removeTagFromOldPosts).toHaveBeenCalledWith(
          afterdark.shortname,
          Date.now() - 7 * 24 * 60 * 60 * 1000,
        )
      } finally {
        vi.useRealTimers()
      }
    })

    it('filter_post rejects blocked DIDs even with media', async () => {
      const post = makePost({ author: BLOCKED, embed: { video: { alt: 'v' } } })
      expect(await m.filter_post(post)).toBe(false)
    })

    it.each([
      ['images', { images: [{ alt: 'x' }] }],
      ['video', { video: { alt: 'x' } }],
      ['media', { media: { alt: 'x' } }],
    ])('filter_post accepts posts with %s embeds', async (_n, embed) => {
      expect(await m.filter_post(makePost({ embed }))).toBe(true)
    })

    it('filter_post rejects posts without embeds', async () => {
      expect(await m.filter_post(makePost())).toBe(false)
    })

    it('filter_post calls start() when agent is null', async () => {
      m.agent = null
      await m.filter_post(makePost({ embed: { video: { alt: 'v' } } }))
      expect(m.start).toHaveBeenCalled()
    })

    it('filter_post rejects when agent is still null after start()', async () => {
      m.agent = null
      expect(await m.filter_post(makePost({ embed: { video: { alt: 'v' } } }))).toBe(false)
    })
  })
})
