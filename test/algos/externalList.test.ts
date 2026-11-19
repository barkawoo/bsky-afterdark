import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { makeMockDbClient } from '../helpers/mockDbClient'

vi.mock('../../src/db/dbClient', () => ({ default: makeMockDbClient() }))
vi.mock('dotenv', () => ({ default: { config: vi.fn() } }))

import dbClient from '../../src/db/dbClient'
import * as ext from '../../src/algos/externalList'

const db = dbClient as any
const post = (over: any = {}): any => ({
  uri: 'at://did:plc:a/app.bsky.feed.post/1',
  cid: 'cid1',
  author: 'did:plc:a',
  text: 'hi',
  indexedAt: 1700000000000,
  replyRoot: null,
  replyParent: null,
  algoTags: null,
  ...over,
})

describe('externalList handler', () => {
  beforeEach(() => {
    db.getLatestPostsForTag.mockResolvedValue([])
  })

  it('defaults the shortname to "external" when SECRET_NAME is unset', () => {
    expect(ext.shortname).toBe('external')
  })

  it('queries the tag with limit and cursor and maps rows to skeleton posts', async () => {
    db.getLatestPostsForTag.mockResolvedValue([
      post({ uri: 'at://u/1', cid: 'c1', indexedAt: 2000 }),
      post({ uri: 'at://u/2', cid: 'c2', indexedAt: 1000 }),
    ])
    const out = await ext.handler({} as any, { feed: 'f', limit: 10, cursor: 'cur' })
    expect(db.getLatestPostsForTag).toHaveBeenCalledWith({ tag: 'external', limit: 10, cursor: 'cur' })
    expect(out.feed).toEqual([{ post: 'at://u/1' }, { post: 'at://u/2' }])
    expect(out.cursor).toBe('1000::c2')
  })

  it('returns an empty feed and undefined cursor when there are no posts', async () => {
    const out = await ext.handler({} as any, { feed: 'f', limit: 10 })
    expect(out).toEqual({ cursor: undefined, feed: [] })
  })

  it('builds the cursor from a Date-parsable indexedAt value', async () => {
    db.getLatestPostsForTag.mockResolvedValue([post({ indexedAt: '2024-01-01T00:00:00.000Z', cid: 'z' })])
    const out = await ext.handler({} as any, { feed: 'f', limit: 1 })
    expect(out.cursor).toBe(`${Date.UTC(2024, 0, 1)}::z`)
  })
})

describe('externalList manager', () => {
  let m: ext.manager
  let mockDb: any
  const saved = process.env.SECRET_LIST

  beforeEach(() => {
    mockDb = { removeTagFromOldPosts: vi.fn().mockResolvedValue(undefined) }
    m = new ext.manager(mockDb, {} as any)
    delete process.env.SECRET_LIST
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    if (saved === undefined) delete process.env.SECRET_LIST
    else process.env.SECRET_LIST = saved
  })

  const stubFetch = (text: string) => {
    const f = vi.fn().mockResolvedValue({ text: async () => text })
    vi.stubGlobal('fetch', f)
    return f
  }

  it('is named after the shortname with an empty follow list', () => {
    expect(m.name).toBe('external')
    expect(m.follows).toEqual([])
  })

  describe('updateList', () => {
    it('does nothing without SECRET_LIST', async () => {
      const f = stubFetch('did:plc:x')
      await m.updateList()
      expect(f).not.toHaveBeenCalled()
      expect(m.follows).toEqual([])
    })

    it('fetches SECRET_LIST and keeps only did:plc: lines', async () => {
      process.env.SECRET_LIST = 'https://example.invalid/list'
      const f = stubFetch('did:plc:one\n# comment\ndid:web:no\n\ndid:plc:two')
      await m.updateList()
      expect(f).toHaveBeenCalledWith('https://example.invalid/list')
      expect(m.follows).toEqual(['did:plc:one', 'did:plc:two'])
    })

    it('swallows fetch errors and keeps the previous list', async () => {
      process.env.SECRET_LIST = 'https://example.invalid/list'
      m.follows = ['did:plc:old']
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('net')))
      await expect(m.updateList()).resolves.toBeUndefined()
      expect(m.follows).toEqual(['did:plc:old'])
    })
  })

  describe('periodicTask', () => {
    it('prunes the tag from posts older than 7 days', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2025-01-10T00:00:00Z'))
      await m.periodicTask()
      expect(mockDb.removeTagFromOldPosts).toHaveBeenCalledWith(
        'external',
        new Date('2025-01-03T00:00:00Z').getTime(),
      )
    })

    it('refreshes the follow list', async () => {
      process.env.SECRET_LIST = 'https://example.invalid/list'
      const f = stubFetch('did:plc:one')
      await m.periodicTask()
      expect(f).toHaveBeenCalledTimes(1)
    })
  })

  describe('filter_post', () => {
    beforeEach(() => {
      m.follows = ['did:plc:a']
    })

    it('accepts top-level posts by listed authors', async () => {
      expect(await m.filter_post(post())).toBe(true)
    })

    it('rejects posts by unlisted authors', async () => {
      expect(await m.filter_post(post({ author: 'did:plc:other' }))).toBe(false)
    })

    it('rejects replies even from listed authors', async () => {
      expect(await m.filter_post(post({ replyRoot: 'at://root' }))).toBe(false)
    })

    it('triggers a list refresh when the list is empty', async () => {
      process.env.SECRET_LIST = 'https://example.invalid/list'
      m.follows = []
      const f = stubFetch('did:plc:a')
      expect(await m.filter_post(post())).toBe(false) // refresh is not awaited
      expect(f).toHaveBeenCalledTimes(1)
    })

    it('rejects when the agent is null (after attempting start)', async () => {
      m.agent = null as any
      const start = vi.spyOn(m, 'start')
      expect(await m.filter_post(post())).toBe(false)
      expect(start).toHaveBeenCalledTimes(1)
    })
  })
})
