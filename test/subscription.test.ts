import { describe, it, expect, vi } from 'vitest'
import { makeMockDbClient } from './helpers/mockDbClient'

vi.mock('../src/db/dbClient', () => ({ default: makeMockDbClient() }))

import { FirehoseSubscription } from '../src/subscription'

const make = () => {
  const sub: any = Object.create(FirehoseSubscription.prototype)
  sub.db = makeMockDbClient()
  sub.algoManagers = [{ name: 'a', filter_post: async () => true }]
  return sub
}

const create = (embed: any) => ({
  uri: 'at://x/app.bsky.feed.post/1',
  cid: 'c1',
  author: 'did:plc:x',
  record: { text: 'hello', createdAt: '2024-01-01T00:00:00Z', embed },
})

const stored = async (embed: any) => {
  const sub = make()
  await sub.handleEvent({ creates: [create(embed)], deletes: [] })
  return sub.db.replaceOneURI.mock.calls[0][2]
}

describe('handleEvent post document', () => {
  it('media post', async () => {
    const doc = await stored({ images: [{ alt: 'x' }] })
    expect(doc).toMatchObject({
      uri: 'at://x/app.bsky.feed.post/1',
      cid: 'c1',
      text: 'hello',
      algoTags: ['a'],
      embed: { images: [{ alt: 'x' }] },
      labels: [],
      tags: [],
    })
    expect(doc._id).toHaveLength(24)
    expect(doc.earliestCreatedIndexedAt).toBeTypeOf('number')
  })

  it('non-media post', async () => {
    const doc = await stored(undefined)
    expect(doc.embed).toBeUndefined()
    expect(doc.algoTags).toEqual(['a'])
  })
})
