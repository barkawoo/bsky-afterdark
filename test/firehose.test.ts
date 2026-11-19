import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
vi.mock('../src/db/dbClient', async () => {
  const { makeMockDbClient } = await import('./helpers/mockDbClient')
  return { default: makeMockDbClient() }
})

const instances = vi.hoisted(() => [] as any[])
vi.mock('@skyware/jetstream', async (orig) => {
  const actual: any = await orig()
  const { EventEmitter } = await import('events')
  class FakeJetstream extends EventEmitter {
    ws: any = undefined
    cursor: any
    opts: any
    startCalls = 0
    closeCalls = 0
    constructor(opts: any) {
      super()
      this.opts = opts
      this.cursor = opts?.cursor
      instances.push(this)
    }
    start() {
      this.startCalls++
      this.ws = { readyState: 1 } // OPEN
    }
    close() {
      this.closeCalls++
      if (this.ws) this.ws.readyState = 3 // CLOSED
    }
  }
  return { ...actual, Jetstream: FakeJetstream }
})

const { FirehoseSubscriptionBase } = await import('../src/util/subscription')

class TestSub extends FirehoseSubscriptionBase {
  handled: any[] = []
  handleEvent = vi.fn(async (e: any) => {
    this.handled.push(e)
  })
}

const commit = (i: number, op = 'create') => ({
  did: `did:plc:u${i}`,
  time_us: 1000 + i,
  kind: 'commit',
  commit: {
    operation: op,
    collection: 'app.bsky.feed.post',
    rkey: `k${i}`,
    cid: `cid${i}`,
    rev: 'r',
    record: { text: `t${i}` },
  },
})

let db: any
let sub: TestSub
let js: any

const start = async (cursor = 500) => {
  db = {
    getSubStateCursor: vi.fn().mockResolvedValue({ cursor }),
    updateSubStateCursor: vi.fn().mockResolvedValue(undefined),
  }
  sub = new TestSub(db, 'svc')
  void sub.run(3000)
  await vi.advanceTimersByTimeAsync(10_001)
  js = instances[instances.length - 1]
}

beforeEach(() => {
  instances.length = 0
  vi.useFakeTimers()
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('firehose consumer characterization', () => {
  it('creates jetstream with stored cursor and starts it when ws absent', async () => {
    await start(500)
    expect(js.opts.cursor).toBe(500)
    expect(js.opts.wantedCollections).toEqual(['app.bsky.feed.post'])
    expect(js.startCalls).toBe(1)
  })

  it('maps create commits to uri/cid/author/record', async () => {
    await start()
    js.emit('commit', commit(1))
    await vi.advanceTimersByTimeAsync(50)
    expect(sub.handled).toEqual([
      {
        cursor: 1001,
        creates: [
          {
            uri: 'at://did:plc:u1/app.bsky.feed.post/k1',
            cid: 'cid1',
            author: 'did:plc:u1',
            record: { text: 't1' },
          },
        ],
        deletes: [],
      },
    ])
  })

  it('maps delete commits to uri only', async () => {
    await start()
    js.emit('commit', commit(2, 'delete'))
    await vi.advanceTimersByTimeAsync(50)
    expect(sub.handled[0].creates).toEqual([])
    expect(sub.handled[0].deletes).toEqual([
      { uri: 'at://did:plc:u2/app.bsky.feed.post/k2' },
    ])
  })

  it('handles events in FIFO order', async () => {
    await start()
    for (let i = 0; i < 5; i++) js.emit('commit', commit(i))
    await vi.advanceTimersByTimeAsync(50)
    expect(sub.handled.map((p) => p.cursor)).toEqual([1000, 1001, 1002, 1003, 1004])
  })

  it('persists cursor after more than 1000 handled events', async () => {
    await start()
    for (let i = 0; i < 1005; i++) js.emit('commit', commit(i))
    await vi.advanceTimersByTimeAsync(500)
    expect(sub.handled.length).toBe(1005)
    expect(db.updateSubStateCursor).toHaveBeenCalled()
    const [svc, cur] = db.updateSubStateCursor.mock.calls[0]
    expect(svc).toBe('svc')
    expect(cur).toBeGreaterThanOrEqual(1000)
    expect(db.updateSubStateCursor.mock.calls.length).toBe(1)
  })

  it('does not persist cursor before 1000 events', async () => {
    await start()
    for (let i = 0; i < 10; i++) js.emit('commit', commit(i))
    await vi.advanceTimersByTimeAsync(50)
    expect(db.updateSubStateCursor).not.toHaveBeenCalled()
  })

  it('restarts jetstream from last handled cursor when ws closed and queue empty', async () => {
    await start()
    js.emit('commit', commit(7))
    await vi.advanceTimersByTimeAsync(50)
    js.ws.readyState = 3
    js.cursor = 999999 // library cursor ran ahead
    await vi.advanceTimersByTimeAsync(50)
    expect(js.startCalls).toBeGreaterThanOrEqual(2)
    expect(js.cursor).toBe(1007)
  })

  it('does not restart while ws is connecting', async () => {
    await start()
    js.ws.readyState = 0
    await vi.advanceTimersByTimeAsync(50)
    expect(js.startCalls).toBe(1)
  })

  it('closes jetstream when queue exceeds 1,000,000 events', async () => {
    await start()
    const evt = commit(1)
    for (let i = 0; i < 1_000_000; i++) js.emit('commit', evt)
    expect(js.closeCalls).toBe(0)
    js.emit('commit', evt)
    expect(js.closeCalls).toBe(1)
  })
})
