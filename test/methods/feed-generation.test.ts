import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { makeMockDbClient } from '../helpers/mockDbClient'

vi.mock('../../src/db/dbClient', () => ({ default: makeMockDbClient() }))
vi.mock('../../src/auth', () => ({ validateAuth: vi.fn() }))

import { validateAuth } from '../../src/auth'
import algos from '../../src/algos'
import register from '../../src/methods/feed-generation'

const FEED = 'at://did:plc:pub/app.bsky.feed.generator/cats'
const mockAuth = validateAuth as any

describe('getFeedSkeleton method', () => {
  let handler: any
  let origHandler: any
  let algo: any
  const ctx: any = { cfg: { serviceDid: 'did:web:svc' }, didResolver: { r: 1 } }
  const agent: any = { a: 1 }
  const req: any = { headers: { authorization: 'Bearer t' } }

  beforeEach(() => {
    handler = undefined
    const server: any = {
      app: { bsky: { feed: { getFeedSkeleton: (h: any) => (handler = h) } } },
    }
    register(server, ctx, agent)
    origHandler = algos.cats.handler
    algo = vi.fn()
    algos.cats.handler = algo
    mockAuth.mockResolvedValue('did:plc:requester')
  })
  afterEach(() => {
    algos.cats.handler = origHandler
  })

  it('authenticates and passes ctx, params, agent and requester DID to the algo', async () => {
    const feed = [{ post: 'at://p/1' }]
    algo.mockResolvedValue({ feed, cursor: 'c' })
    const params = { feed: FEED, limit: 1 }
    const out = await handler({ params, req, res: {} })
    expect(mockAuth).toHaveBeenCalledWith(req, 'did:web:svc', ctx.didResolver)
    expect(algo).toHaveBeenCalledWith(ctx, params, agent, 'did:plc:requester')
    expect(out).toEqual({ encoding: 'application/json', body: { feed, cursor: 'c' } })
  })

  it('keeps the cursor when the feed fills the limit', async () => {
    algo.mockResolvedValue({ feed: [{ post: 'a' }, { post: 'b' }], cursor: 'next' })
    const out = await handler({ params: { feed: FEED, limit: 2 }, req, res: {} })
    expect(out.body.cursor).toBe('next')
  })

  it('clears the cursor when the feed is shorter than the limit', async () => {
    algo.mockResolvedValue({ feed: [{ post: 'a' }], cursor: 'next' })
    const out = await handler({ params: { feed: FEED, limit: 5 }, req, res: {} })
    expect(out.body.cursor).toBeUndefined()
    expect(out.body.feed).toHaveLength(1)
  })

  it('rejects a non-generator collection with UnsupportedAlgorithm', async () => {
    await expect(
      handler({ params: { feed: 'at://did:plc:pub/app.bsky.feed.post/cats', limit: 1 }, req, res: {} }),
    ).rejects.toMatchObject({ customErrorName: 'UnsupportedAlgorithm' })
    expect(algo).not.toHaveBeenCalled()
  })

  it('propagates auth failures without calling the algo', async () => {
    mockAuth.mockRejectedValue(new Error('nope'))
    await expect(handler({ params: { feed: FEED, limit: 1 }, req, res: {} })).rejects.toThrow('nope')
    expect(algo).not.toHaveBeenCalled()
  })
})
