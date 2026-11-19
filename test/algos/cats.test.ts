import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeMockDbClient } from '../helpers/mockDbClient'

// src/db/dbClient connects to Mongo at import time, so it must always be mocked.
vi.mock('../../src/db/dbClient', () => ({ default: makeMockDbClient() }))

import dbClient from '../../src/db/dbClient'
import * as cats from '../../src/algos/cats'

const db = dbClient as any
const BLOCKED = 'did:plc:mcb6n67plnrlx4lg35natk2b'

const makePost = (over: any = {}): any => ({
  _id: null,
  uri: 'at://did:plc:valid/app.bsky.feed.post/1',
  cid: 'cid1',
  author: 'did:plc:valid',
  text: 'Just a regular post about my day',
  indexedAt: Date.now(),
  replyRoot: null,
  replyParent: null,
  algoTags: null,
  ...over,
})

describe('cats algorithm', () => {
  let mockDb: any
  let ctx: any

  beforeEach(() => {
    mockDb = { removeTagFromOldPosts: vi.fn() }
    ctx = { db: mockDb }
    // clearMocks keeps implementations, so reset per-test overrides on the shared db mock
    db.getLatestPostsForTag.mockResolvedValue([])
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  describe('handler', () => {
    const params = { feed: cats.shortname, limit: 50, cursor: undefined }
    const mockPosts = [
      { uri: 'at://did:plc:123/app.bsky.feed.post/1', cid: 'cid1', indexedAt: Date.now() },
      { uri: 'at://did:plc:456/app.bsky.feed.post/2', cid: 'cid2', indexedAt: Date.now() },
    ]

    it('returns feed items and a cursor from the last post', async () => {
      db.getLatestPostsForTag.mockResolvedValue(mockPosts)
      const result = await cats.handler(ctx, params)
      expect(db.getLatestPostsForTag).toHaveBeenCalledWith({
        tag: cats.shortname,
        limit: 50,
        cursor: undefined,
        mediaOnly: false,
        nsfwOnly: false,
        excludeNSFW: true,
      })
      expect(result.feed.map((f) => f.post)).toEqual(mockPosts.map((p) => p.uri))
      expect(result.cursor).toBe(`${mockPosts[1].indexedAt}::cid2`)
    })

    it('returns no cursor for an empty page', async () => {
      const result = await cats.handler(ctx, params)
      expect(result.feed).toEqual([])
      expect(result.cursor).toBeUndefined()
    })

    it('passes the request cursor through to the db', async () => {
      await cats.handler(ctx, { ...params, cursor: '123::abc' })
      expect(db.getLatestPostsForTag).toHaveBeenCalledWith(expect.objectContaining({ cursor: '123::abc' }))
    })
  })

  describe('manager', () => {
    let m: any

    beforeEach(() => {
      m = new cats.manager(mockDb, {} as any)
      m.start = vi.fn().mockResolvedValue(undefined)
    })

    it('has the expected name', () => {
      expect(m.name).toBe(cats.shortname)
    })

    it('periodicTask removes tags from posts older than 7 days', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2025-01-01T00:00:00Z'))
      try {
        await m.periodicTask()
        expect(mockDb.removeTagFromOldPosts).toHaveBeenCalledWith(
          cats.shortname,
          Date.now() - 7 * 24 * 60 * 60 * 1000,
        )
      } finally {
        vi.useRealTimers()
      }
    })

    it('filter_post rejects blocked DIDs', async () => {
      expect(await m.filter_post(makePost({ author: BLOCKED, text: 'my cat' }))).toBe(false)
    })

    it('filter_post rejects replies', async () => {
      const post = makePost({ text: 'my cat', replyRoot: 'at://did:plc:other/app.bsky.feed.post/1' })
      expect(await m.filter_post(post)).toBe(false)
    })

    it('filter_post accepts cat text with image alt', async () => {
      const post = makePost({
        text: 'Look at my cute cat! #cats',
        embed: { images: [{ alt: 'A cute cat playing with a toy' }] },
      })
      expect(await m.filter_post(post)).toBe(true)
    })

    it('filter_post accepts when only the image alt mentions a cat', async () => {
      const post = makePost({
        text: 'Look at this!',
        embed: { images: [{ alt: 'My cat sleeping on the couch' }] },
      })
      expect(await m.filter_post(post)).toBe(true)
    })

    it('filter_post accepts when only the media alt mentions a cat', async () => {
      const post = makePost({ text: 'hi', embed: { media: { alt: 'a kitten' } } })
      expect(await m.filter_post(post)).toBe(true)
    })

    it('filter_post accepts when only tags mention a cat', async () => {
      expect(await m.filter_post(makePost({ text: 'hi', tags: ['kitty'] }))).toBe(true)
    })

    it('filter_post rejects excluded terms (#furry)', async () => {
      const post = makePost({ text: 'Check out my furry cat art! #furry #cats' })
      expect(await m.filter_post(post)).toBe(false)
    })

    it('filter_post rejects excluded terms in alt text', async () => {
      const post = makePost({ text: 'my cat', embed: { images: [{ alt: 'cat girl cosplay' }] } })
      expect(await m.filter_post(post)).toBe(false)
    })

    it('filter_post rejects posts without cat-related content', async () => {
      expect(await m.filter_post(makePost())).toBe(false)
    })

    it('filter_post does not match substrings like "category"', async () => {
      expect(await m.filter_post(makePost({ text: 'a category of things' }))).toBe(false)
    })

    it('filter_post calls start() when agent is null, then rejects', async () => {
      m.agent = null
      expect(await m.filter_post(makePost({ text: 'my cat' }))).toBe(false)
      expect(m.start).toHaveBeenCalled()
    })
  })
})
