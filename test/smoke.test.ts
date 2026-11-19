import { describe, it, expect, vi } from 'vitest'
import { makeMockDbClient } from './helpers/mockDbClient'

vi.mock('../src/db/dbClient', () => ({ default: makeMockDbClient() }))

describe('harness', () => {
  it('imports an algo without connecting to Mongo', async () => {
    const mod = await import('../src/algos/afterdark')
    expect(mod.shortname).toBe('mutuals-ad')
  })
})
