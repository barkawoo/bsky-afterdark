import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { makeMockDbClient } from './helpers/mockDbClient'

vi.mock('../src/db/dbClient', () => ({ default: makeMockDbClient() }))

const { algoHandler, validateAuth } = vi.hoisted(() => ({ algoHandler: vi.fn(), validateAuth: vi.fn() }))
vi.mock('../src/algos', () => ({ default: { 'mutuals-ad': { handler: algoHandler } } }))
vi.mock('../src/auth', () => ({ validateAuth }))

import registerFeedGeneration, { algoCache } from '../src/methods/feed-generation'

const feed = 'at://did:plc:pub/app.bsky.feed.generator/mutuals-ad'
const getHandler = () => {
  let h: any
  const server: any = { app: { bsky: { feed: { getFeedSkeleton: (fn: any) => { h = fn } } } } }
  registerFeedGeneration(server, { cfg: { serviceDid: 'did:web:x' }, didResolver: {} } as any, {} as any)
  return h
}
const call = (h: any, params: any) => h({ params, req: { headers: {} }, res: { setHeader: vi.fn() } })

describe('feed-generation (characterization)', () => {
  beforeEach(() => {
    algoCache.clear()
    algoHandler.mockReset()
    validateAuth.mockReset().mockResolvedValue('did:me')
  })

  it('clears cursor when feed shorter than limit', async () => {
    algoHandler.mockResolvedValue({ cursor: 'abc', feed: [{ post: 'a' }] })
    const out = await call(getHandler(), { feed, limit: 30 })
    expect(out.body.cursor).toBeUndefined()
    expect(out.encoding).toBe('application/json')
  })

  it('keeps cursor when feed is full', async () => {
    algoHandler.mockResolvedValue({ cursor: 'abc', feed: [{ post: 'a' }, { post: 'b' }] })
    const out = await call(getHandler(), { feed, limit: 2 })
    expect(out.body.cursor).toBe('abc')
  })

  it('passes requester DID to the algo', async () => {
    algoHandler.mockResolvedValue({ feed: [] })
    await call(getHandler(), { feed, limit: 30 })
    expect(algoHandler.mock.calls[0][3]).toBe('did:me')
  })

  describe('response cache', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('serves repeat request from cache, then expires after TTL', async () => {
      algoHandler.mockResolvedValue({ cursor: 'c', feed: [{ post: 'a' }] })
      const h = getHandler()
      await call(h, { feed, limit: 1 })
      await call(h, { feed, limit: 1 })
      expect(algoHandler).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(31_000)
      await call(h, { feed, limit: 1 })
      expect(algoHandler).toHaveBeenCalledTimes(2)
    })

    it('cache key includes requester, cursor and limit', async () => {
      algoHandler.mockResolvedValue({ feed: [] })
      const h = getHandler()
      await call(h, { feed, limit: 5 })
      validateAuth.mockResolvedValue('did:other')
      await call(h, { feed, limit: 5 })
      expect(algoHandler).toHaveBeenCalledTimes(2)
      await call(h, { feed, limit: 5, cursor: 'x' })
      await call(h, { feed, limit: 6 })
      expect(algoHandler).toHaveBeenCalledTimes(4)
    })

    it('does not cache algo errors', async () => {
      algoHandler.mockRejectedValueOnce(new Error('x')).mockResolvedValue({ feed: [] })
      const h = getHandler()
      await expect(call(h, { feed, limit: 5 })).rejects.toThrow('x')
      await call(h, { feed, limit: 5 })
      expect(algoHandler).toHaveBeenCalledTimes(2)
    })
  })
})
