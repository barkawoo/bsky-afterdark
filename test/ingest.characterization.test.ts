import { describe, it, expect, vi, beforeEach } from 'vitest'
import crypto from 'crypto'
import { collection, resetCollection } from './helpers/mockMongo'

vi.mock('mongodb', async () => (await import('./helpers/mockMongo')).mongodbMockFactory())

const mockDb = vi.hoisted(() => ({
  getUnlabelledPostsWithMedia: vi.fn(),
  updateLabelsForURIs: vi.fn(),
}))
vi.mock('../src/addn/rateLimit', () => ({ default: (fn: any) => fn() }))

describe('dbClient write characterization', () => {
  let dbClient: any
  let cursor: any
  beforeEach(async () => {
    cursor = resetCollection()
    dbClient = (await import('../src/db/dbClient')).default
    // init() ran at import; clear its createIndex calls
    collection.createIndex.mockClear()
  })

  it('replaceOneURI inserts with ObjectId-wrapped _id and does not replace on success', async () => {
    const data = { _id: 'abc123', uri: 'at://x/1' }
    await dbClient.replaceOneURI('post', 'at://x/1', data)
    expect(collection.insertOne).toHaveBeenCalledTimes(1)
    expect(collection.insertOne.mock.calls[0][0].uri).toBe('at://x/1')
    expect(collection.insertOne.mock.calls[0][0]._id.constructor.name).toBe('ObjectId')
    expect(collection.insertOne.mock.calls[0][0]._id.id).toBe('abc123')
    expect(collection.replaceOne).not.toHaveBeenCalled()
  })

  it('replaceOneURI falls back to replaceOne({uri}) when insert throws (duplicate)', async () => {
    collection.insertOne.mockRejectedValue(new Error('E11000'))
    const data = { _id: 'abc123', uri: 'at://x/1' }
    await dbClient.replaceOneURI('post', 'at://x/1', data)
    expect(collection.replaceOne).toHaveBeenCalledTimes(1)
    expect(collection.replaceOne.mock.calls[0][0]).toEqual({ uri: 'at://x/1' })
    expect(collection.replaceOne.mock.calls[0][1]).toBe(data)
  })

  it('replaceOneURI assigns a fresh ObjectId when _id is not a string', async () => {
    const data: any = { _id: null, uri: 'u' }
    await dbClient.replaceOneURI('post', 'u', data)
    expect(data._id.constructor.name).toBe('ObjectId')
    expect(data._id.id).toBeUndefined()
  })

  it('updateLabelsForURIs issues one awaited bulkWrite of updateOne ops, ordered:false', async () => {
    await dbClient.updateLabelsForURIs([
      { uri: 'a', labels: ['porn'] },
      { uri: 'b', labels: [] },
    ])
    expect(collection.findOneAndUpdate).not.toHaveBeenCalled()
    expect(collection.bulkWrite).toHaveBeenCalledTimes(1)
    const [ops, opts] = collection.bulkWrite.mock.calls[0]
    expect(opts).toEqual({ ordered: false })
    expect(ops).toHaveLength(2)
    expect(ops[0].updateOne.filter).toEqual({ uri: { $eq: 'a' } })
    expect(ops[0].updateOne.update.$set.labels).toEqual(['porn'])
    expect(ops[1].updateOne.update.$set.labels).toEqual([])
    // empty-label results are still marked checked
    expect(typeof ops[1].updateOne.update.$set.labelsCheckedAt).toBe('number')
  })

  it('updateLabelsForURIs skips bulkWrite for empty input', async () => {
    await dbClient.updateLabelsForURIs([])
    expect(collection.bulkWrite).not.toHaveBeenCalled()
  })

  it('updateLabelsForURIs logs instead of throwing when bulkWrite fails', async () => {
    collection.bulkWrite.mockRejectedValue(new Error('boom'))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(dbClient.updateLabelsForURIs([{ uri: 'a', labels: [] }])).resolves.toBeUndefined()
    expect(spy).toHaveBeenCalled()
  })

  it('replaceManyURI sends one ordered:false bulkWrite of _id-filtered upserts', async () => {
    await dbClient.replaceManyURI('post', [
      { _id: 'abc', uri: 'u1' },
      { _id: 'def', uri: 'u2' },
      { _id: null, uri: 'u3' },
    ])
    expect(collection.insertOne).not.toHaveBeenCalled()
    expect(collection.bulkWrite).toHaveBeenCalledTimes(1)
    const [ops, opts] = collection.bulkWrite.mock.calls[0]
    expect(opts).toEqual({ ordered: false })
    expect(ops[0].replaceOne.upsert).toBe(true)
    expect(ops[0].replaceOne.filter._id.id).toBe('abc')
    expect(ops[0].replaceOne.replacement._id.id).toBe('abc')
    expect(ops[0].replaceOne.replacement.uri).toBe('u1')
    expect(ops[2].insertOne.document._id.constructor.name).toBe('ObjectId')
  })

  it('replaceManyURI is a no-op for empty input and propagates errors', async () => {
    await dbClient.replaceManyURI('post', [])
    expect(collection.bulkWrite).not.toHaveBeenCalled()
    collection.bulkWrite.mockRejectedValue(new Error('bulk'))
    await expect(dbClient.replaceManyURI('post', [{ _id: 'a', uri: 'u' }])).rejects.toThrow('bulk')
  })

  it('getUnlabelledPostsWithMedia queries media posts with labels: [] older than lag, unchecked or due a recheck', async () => {
    cursor.toArray.mockResolvedValue([{ uri: 'a' }])
    const res = await dbClient.getUnlabelledPostsWithMedia(300, 1000, 5000)
    const q = collection.find.mock.calls[0][0]
    expect(q.labels).toEqual([])
    expect(q.$or).toHaveLength(3)
    expect(q.indexedAt.$lt).toBeLessThanOrEqual(Date.now() - 1000 + 5)
    const alts = q.$and[0].$or
    expect(alts).toContainEqual({ labelsCheckedAt: { $exists: false } })
    expect(alts).toContainEqual({ labelsCheckedAt: null })
    expect(alts).toContainEqual({
      $expr: { $lt: ['$labelsCheckedAt', { $add: ['$indexedAt', 5000] }] },
    })
    expect(cursor.limit).toHaveBeenCalledWith(300)
    expect(res).toEqual([{ uri: 'a' }])
  })
})

describe('FirehoseSubscription.handleEvent characterization', () => {
  it('builds docs with shake256 _id and dispatches delete + one batched replace', async () => {
    vi.resetModules()
    vi.doMock('../src/db/dbClient', () => ({ default: mockDb }))
    const { FirehoseSubscription } = await import('../src/subscription')
    const db: any = {
      deleteManyURI: vi.fn().mockResolvedValue(undefined),
      replaceManyURI: vi.fn().mockResolvedValue(undefined),
    }
    const sub: any = Object.create(FirehoseSubscription.prototype)
    sub.db = db
    sub.algoManagers = [{ name: 'tagA', filter_post: async (p: any) => p.uri !== 'at://skip' }]

    await sub.handleEvent({
      creates: [
        { uri: 'at://one', cid: 'c1', author: 'did:a', record: { text: 'hi', createdAt: '2024-01-01T00:00:00Z' } },
        { uri: 'at://skip', cid: 'c2', author: 'did:b', record: { text: 'no', createdAt: '2024-01-01T00:00:00Z' } },
        { uri: 'at://two', cid: 'c3', author: 'did:c', record: { text: 'yo', createdAt: '2024-01-01T00:00:00Z', labels: { values: [{ val: 'porn' }] } } },
      ],
      deletes: [{ uri: 'at://del' }],
    })

    expect(db.deleteManyURI).toHaveBeenCalledWith('post', ['at://del'])
    expect(db.replaceManyURI).toHaveBeenCalledTimes(1)
    const [coll, docs] = db.replaceManyURI.mock.calls[0]
    expect(coll).toBe('post')
    expect(docs).toHaveLength(2)
    const doc = docs[0]
    expect(doc._id).toBe(crypto.createHash('shake256', { outputLength: 12 }).update('at://one').digest('hex'))
    expect(doc).toMatchObject({ uri: 'at://one', cid: 'c1', author: 'did:a', text: 'hi', algoTags: ['tagA'], labels: [], tags: [], replyParent: null })
    expect(doc.earliestCreatedIndexedAt).toBe(Math.min(doc.createdAt, doc.indexedAt))
    expect(docs[1].labels).toEqual(['porn'])
  })

  it('does nothing for an empty event', async () => {
    const { FirehoseSubscription } = await import('../src/subscription')
    const db: any = { deleteManyURI: vi.fn(), replaceManyURI: vi.fn() }
    const sub: any = Object.create(FirehoseSubscription.prototype)
    sub.db = db
    sub.algoManagers = []
    await sub.handleEvent({ creates: [], deletes: [] })
    expect(db.deleteManyURI).not.toHaveBeenCalled()
    expect(db.replaceManyURI).not.toHaveBeenCalled()
  })
})

describe('batchUpdate characterization', () => {
  const run = async (uris: string[], getPosts: any) => {
    vi.resetModules()
    vi.doMock('../src/db/dbClient', () => ({ default: mockDb }))
    vi.doMock('../src/addn/rateLimit', () => ({ default: (fn: any) => fn() }))
    mockDb.getUnlabelledPostsWithMedia.mockResolvedValue(uris.map((uri) => ({ uri })))
    // stop the infinite loop after the first iteration's update call
    const stop = new Error('stop')
    mockDb.updateLabelsForURIs.mockImplementation(() => { throw stop })
    const batchUpdate = (await import('../src/addn/batchUpdate')).default
    const agent = { app: { bsky: { feed: { getPosts } } } }
    await expect(batchUpdate(agent, 1)).rejects.toBe(stop)
  }

  it('chunks uris by 25 and records labels, including empty results', async () => {
    const uris = Array.from({ length: 60 }, (_, i) => `at://p${i}`)
    const getPosts = vi.fn(async ({ uris }: any) => {
      // first chunk: only return first post (with labels), second: empty, third: all unlabeled
      const n = getPosts.mock.calls.length
      if (n === 1) return { data: { posts: [{ uri: uris[0], labels: [{ val: 'porn' }] }] } }
      if (n === 2) return { data: { posts: [] } }
      return { data: { posts: uris.map((u: string) => ({ uri: u, labels: [] })) } }
    })
    await run(uris, getPosts)
    expect(getPosts.mock.calls.map((c) => c[0].uris.length)).toEqual([25, 25, 10])
    const entries = mockDb.updateLabelsForURIs.mock.calls[0][0]
    expect(entries[0]).toEqual({ uri: 'at://p0', labels: ['porn'] })
    expect(entries.slice(1, 26).every((e: any) => e.labels.length === 0)).toBe(true)
    expect(entries).toHaveLength(1 + 25 + 10)
  })

  it('awaits updateLabelsForURIs', async () => {
    vi.resetModules()
    vi.doMock('../src/db/dbClient', () => ({ default: mockDb }))
    vi.doMock('../src/addn/rateLimit', () => ({ default: (fn: any) => fn() }))
    mockDb.getUnlabelledPostsWithMedia.mockResolvedValue([{ uri: 'a' }])
    let finished = false
    let calls = 0
    mockDb.updateLabelsForURIs.mockImplementation(async () => {
      if (++calls > 1) throw new Error('stop')
      await new Promise((r) => setTimeout(r, 20))
      finished = true
    })
    const getPosts = async () => ({ data: { posts: [] } })
    const batchUpdate = (await import('../src/addn/batchUpdate')).default
    const p = batchUpdate({ app: { bsky: { feed: { getPosts } } } }, 1).catch(() => {})
    await new Promise((r) => setTimeout(r, 5))
    expect(calls).toBe(1) // next loop iteration has not started before the update resolved
    await p
    expect(finished).toBe(true)
  })

  it('skips a chunk whose fetch fails', async () => {
    const uris = Array.from({ length: 30 }, (_, i) => `at://p${i}`)
    const getPosts = vi.fn()
      .mockRejectedValueOnce(new Error('net'))
      .mockResolvedValueOnce({ data: { posts: [{ uri: 'at://p25', labels: [] }] } })
    await run(uris, getPosts)
    expect(mockDb.updateLabelsForURIs.mock.calls[0][0]).toEqual([{ uri: 'at://p25', labels: [] }])
  })
})
