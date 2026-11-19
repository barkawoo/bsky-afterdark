import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => {
  const calls: any = {}
  const cursor = {
    sort: vi.fn(),
    limit: vi.fn(),
    toArray: vi.fn().mockResolvedValue([]),
  }
  cursor.sort.mockReturnValue(cursor)
  cursor.limit.mockReturnValue(cursor)
  const collection = {
    createIndex: vi.fn().mockResolvedValue('ok'),
    dropIndex: vi.fn().mockResolvedValue({}),
    updateMany: vi.fn().mockResolvedValue({}),
    deleteMany: vi.fn().mockResolvedValue({}),
    find: vi.fn().mockReturnValue(cursor),
  }
  return { calls, cursor, collection }
})

vi.mock('mongodb', async (orig) => {
  const actual: any = await orig()
  class MongoClient {
    connect = vi.fn().mockResolvedValue(undefined)
    db() {
      return { collection: () => h.collection }
    }
  }
  return { ...actual, MongoClient }
})

import dbClient from '../src/db/dbClient'

const lastQuery = () => h.collection.find.mock.calls.at(-1)![0]
const lastSort = () => h.cursor.sort.mock.calls.at(-1)![0]

beforeEach(() => {
  // restoreMocks in vitest config resets implementations between tests
  h.cursor.sort.mockReturnValue(h.cursor)
  h.cursor.limit.mockReturnValue(h.cursor)
  h.cursor.toArray.mockResolvedValue([])
  h.collection.find.mockReturnValue(h.cursor)
  h.collection.createIndex.mockResolvedValue('ok')
  h.collection.dropIndex.mockResolvedValue({})
  h.collection.updateMany.mockResolvedValue({})
  h.collection.find.mockClear()
  h.cursor.sort.mockClear()
})

describe('getLatestPostsForTag query shape', () => {
  it('tag only', async () => {
    await dbClient.getLatestPostsForTag({ tag: 't' })
    expect(lastQuery()).toEqual({ algoTags: 't' })
    expect(lastSort()).toEqual({
      earliestCreatedIndexedAt: -1,
      createdAt: -1,
      indexedAt: -1,
      cid: -1,
    })
  })

  it('mediaOnly', async () => {
    await dbClient.getLatestPostsForTag({ tag: 't', mediaOnly: true })
    expect(lastQuery()).toEqual({
      algoTags: 't',
      $and: [
        {
          $or: [
            { 'embed.images': { $ne: null } },
            { 'embed.video': { $ne: null } },
            { 'embed.media': { $ne: null } },
          ],
        },
      ],
    })
  })

  it('nsfwOnly / excludeNSFW / authors', async () => {
    await dbClient.getLatestPostsForTag({ tag: 't', nsfwOnly: true })
    expect(lastQuery().$and).toEqual([
      { labels: { $in: ['porn', 'nudity', 'sexual', 'underwear'], $ne: null } },
    ])
    await dbClient.getLatestPostsForTag({ tag: 't', excludeNSFW: true })
    expect(lastQuery().$and).toEqual([
      { labels: { $nin: ['porn', 'nudity', 'sexual', 'underwear'] } },
    ])
    await dbClient.getLatestPostsForTag({ tag: 't', authors: ['a', 'b'] })
    expect(lastQuery()).toEqual({ algoTags: 't', author: { $in: ['a', 'b'] } })
  })

  it('cursor', async () => {
    await dbClient.getLatestPostsForTag({ tag: 't', cursor: '1700000000000::cidx' })
    expect(lastQuery()).toEqual({
      algoTags: 't',
      indexedAt: { $lte: 1700000000000 },
      cid: { $ne: 'cidx' },
    })
  })

  it('malformed cursor throws', async () => {
    await expect(
      dbClient.getLatestPostsForTag({ tag: 't', cursor: 'nope' }),
    ).rejects.toThrow('malformed cursor')
  })

  it('all flags combine', async () => {
    await dbClient.getLatestPostsForTag({
      tag: 't', mediaOnly: true, nsfwOnly: true, authors: ['a'], cursor: '1::c',
    })
    const q = lastQuery()
    expect(q.$and).toHaveLength(2)
    expect(q.author).toEqual({ $in: ['a'] })
    expect(q.indexedAt).toEqual({ $lte: 1 })
  })
})

describe('getUnlabelledPostsWithMedia query shape', () => {
  it('uses media filter, empty labels, lag', async () => {
    await dbClient.getUnlabelledPostsWithMedia(10, 1000)
    const q = lastQuery()
    expect(q.$or).toEqual([
      { 'embed.images': { $ne: null } },
      { 'embed.video': { $ne: null } },
      { 'embed.media': { $ne: null } },
    ])
    expect(q.labels).toEqual([])
    expect(q.indexedAt.$lt).toBeTypeOf('number')
    expect(lastSort()).toEqual({ indexedAt: -1, cid: -1 })
  })
})

describe('init index set', () => {
  it('creates the expected indexes', async () => {
    h.collection.createIndex.mockClear()
    await dbClient.init()
    const specs = h.collection.createIndex.mock.calls.map((c) => c[0])
    expect(specs).toEqual([
      { uri: 1 },
      { indexedAt: -1, cid: -1 },
      { algoTags: 1 },
      { author: 1 },
      { labels: 1 },
      { 'embed.images': 1 },
      { 'embed.video': 1 },
      { 'embed.media': 1 },
    ])
  })
})
