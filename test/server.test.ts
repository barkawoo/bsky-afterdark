import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import type http from 'http'
import type { AddressInfo } from 'net'
import { makeMockDbClient } from './helpers/mockDbClient'

// src/db/dbClient connects to Mongo at import time, so it must always be mocked.
vi.mock('../src/db/dbClient', () => ({ default: makeMockDbClient() }))
// The real firehose starts managers, intervals and a websocket in its constructor.
vi.mock('../src/subscription', () => ({
  FirehoseSubscription: class {
    run = vi.fn()
  },
}))

import FeedGenerator from '../src/server'
import algos from '../src/algos'

const cfg = {
  port: 0,
  listenhost: '127.0.0.1',
  hostname: 'example.com',
  mongoDbConnectionString: '',
  subscriptionEndpoint: 'wss://example.invalid',
  serviceDid: 'did:web:example.com',
  publisherDid: 'did:plc:publisher',
  subscriptionReconnectDelay: 3000,
}

describe('FeedGenerator server', () => {
  let srv: http.Server
  let base: string

  beforeAll(async () => {
    const gen = await FeedGenerator.create(cfg)
    srv = gen.app.listen(0, '127.0.0.1')
    await new Promise((r) => srv.once('listening', r))
    base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await new Promise((r) => srv.close(r))
  })

  it('serves /.well-known/did.json for a matching service DID', async () => {
    const res = await fetch(`${base}/.well-known/did.json`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      '@context': ['https://www.w3.org/ns/did/v1'],
      id: 'did:web:example.com',
      service: [
        { id: '#bsky_fg', type: 'BskyFeedGenerator', serviceEndpoint: 'https://example.com' },
      ],
    })
  })

  it('describeFeedGenerator lists one feed URI per registered algo', async () => {
    const res = await fetch(`${base}/xrpc/app.bsky.feed.describeFeedGenerator`)
    expect(res.status).toBe(200)
    const body: any = await res.json()
    expect(body.did).toBe(cfg.serviceDid)
    expect(body.feeds.map((f: any) => f.uri).sort()).toEqual(
      Object.keys(algos)
        .map((s) => `at://${cfg.publisherDid}/app.bsky.feed.generator/${s}`)
        .sort(),
    )
  })

  // SUSPECTED SOURCE BUG: feed-generation.ts does `algos[feedUri.rkey].handler` before
  // the `!algo` check, so an unknown rkey throws a TypeError (HTTP 500) instead of the
  // intended InvalidRequestError 'UnsupportedAlgorithm' (HTTP 400). src/ is not changed
  // here; it.fails flips to a real failure once the source is fixed.
  it.fails('getFeedSkeleton rejects an unknown feed with 400 UnsupportedAlgorithm', async () => {
    const feed = encodeURIComponent(`at://${cfg.publisherDid}/app.bsky.feed.generator/nope`)
    const res = await fetch(`${base}/xrpc/app.bsky.feed.getFeedSkeleton?feed=${feed}`)
    expect(res.status).toBe(400)
  })
})

describe('getFeedSkeleton auth', () => {
  it('requires authorization for a known feed', async () => {
    const gen = await FeedGenerator.create(cfg)
    const s = gen.app.listen(0, '127.0.0.1')
    await new Promise((r) => s.once('listening', r))
    try {
      const feed = encodeURIComponent(`at://${cfg.publisherDid}/app.bsky.feed.generator/cats`)
      const res = await fetch(
        `http://127.0.0.1:${(s.address() as AddressInfo).port}/xrpc/app.bsky.feed.getFeedSkeleton?feed=${feed}`,
      )
      expect(res.status).toBe(401)
    } finally {
      await new Promise((r) => s.close(r))
    }
  })
})

describe('FeedGenerator well-known with mismatched hostname', () => {
  it('returns 404 when serviceDid does not end with hostname', async () => {
    const gen = await FeedGenerator.create({ ...cfg, serviceDid: 'did:web:other.org' })
    const s = gen.app.listen(0, '127.0.0.1')
    await new Promise((r) => s.once('listening', r))
    try {
      const res = await fetch(`http://127.0.0.1:${(s.address() as AddressInfo).port}/.well-known/did.json`)
      expect(res.status).toBe(404)
    } finally {
      await new Promise((r) => s.close(r))
    }
  })
})

describe('algo registry', () => {
  it('registers cats, afterdark and afterdarkvid with handler and manager', () => {
    for (const name of ['cats', 'mutuals-ad', 'mutuals-ad-vid']) {
      expect(algos[name]).toBeDefined()
      expect(typeof algos[name].handler).toBe('function')
      expect(typeof algos[name].manager).toBe('function')
    }
  })
})
