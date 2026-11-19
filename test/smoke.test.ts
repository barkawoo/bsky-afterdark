import { describe, it, expect, vi } from 'vitest'
import { makeMockDbClient } from './helpers/mockDbClient'
import { makeMockAgent } from './helpers/mockAgent'

vi.mock('../src/db/dbClient', () => ({ default: makeMockDbClient() }))

describe('harness', () => {
  it('imports an algo without connecting to Mongo', async () => {
    const mod = await import('../src/algos/afterdark')
    expect(mod.shortname).toBe('mutuals-ad')
  })

  // Guards against restoreMocks/mockReset in vitest.config.ts wiping the
  // default implementations set in the helpers.
  it('keeps mock defaults across tests (1/2)', async () => {
    const { default: db } = await import('../src/db/dbClient')
    expect(await (db as any).getSubStateCursor()).toEqual({ cursor: 0 })
    expect(await makeMockAgent().api.app.bsky.graph.getFollows()).toEqual({
      data: { follows: [], cursor: undefined },
    })
  })

  it('keeps mock defaults across tests (2/2)', async () => {
    const { default: db } = await import('../src/db/dbClient')
    expect(await (db as any).getSubStateCursor()).toEqual({ cursor: 0 })
  })
})
