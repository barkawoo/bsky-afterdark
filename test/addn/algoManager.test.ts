import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('dotenv', () => ({ default: { config: vi.fn() } }))

import { AlgoManager } from '../../src/addn/algoManager'

const MIN = 60 * 1000

class TestManager extends AlgoManager {
  name = 'test'
  periodic = vi.fn().mockResolvedValue(undefined)
  started = vi.fn().mockResolvedValue(undefined)
  async periodicTask() {
    return this.periodic()
  }
  async start() {
    return this.started()
  }
}

describe('AlgoManager', () => {
  let m: TestManager
  const saved = process.env.FEEDGEN_TASK_INTEVAL_MINS

  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    delete process.env.FEEDGEN_TASK_INTEVAL_MINS
    m = new TestManager({} as any, {} as any)
  })
  afterEach(() => {
    clearInterval(m.periodicIntervalId as any)
    vi.useRealTimers()
    if (saved === undefined) delete process.env.FEEDGEN_TASK_INTEVAL_MINS
    else process.env.FEEDGEN_TASK_INTEVAL_MINS = saved
  })

  it('starts not ready', () => {
    expect(m._isReady).toBe(false)
    expect(m._isStarting).toBe(false)
  })

  it('base class hooks are inert defaults', async () => {
    const b = new AlgoManager({} as any, {} as any)
    expect(await b.periodicTask()).toBeUndefined()
    expect(await b.start()).toBeUndefined()
    expect(await b.filter_post({} as any)).toBe(false)
  })

  it('cacheAge is 600 with a cursor and 30 without', () => {
    expect(AlgoManager.cacheAge({ cursor: 'x' })).toBe(600)
    expect(AlgoManager.cacheAge({})).toBe(30)
  })

  it('ready() runs periodicTask then start once and resolves true', async () => {
    expect(await m.ready()).toBe(true)
    expect(m.periodic).toHaveBeenCalledTimes(1)
    expect(m.started).toHaveBeenCalledTimes(1)
    expect(m._isReady).toBe(true)
    expect(await m.ready()).toBe(true)
    expect(m.periodic).toHaveBeenCalledTimes(1)
    expect(m.started).toHaveBeenCalledTimes(1)
  })

  it('_start is idempotent while starting: a concurrent call returns false', async () => {
    const p = m._start()
    expect(await m._start()).toBe(false)
    expect(await p).toBe(true)
    expect(m.periodic).toHaveBeenCalledTimes(1)
  })

  it('_start after completion also returns false and does not re-run', async () => {
    await m._start()
    expect(await m._start()).toBe(false)
    expect(m.started).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['unset', undefined, 15],
    ['valid 5', '5', 5],
    ['zero', '0', 15],
    ['negative', '-3', 15],
    ['non-numeric', 'abc', 15],
    ['empty', '', 15],
  ])('interval env %s -> %i minutes', async (_n, val, mins) => {
    if (val !== undefined) process.env.FEEDGEN_TASK_INTEVAL_MINS = val
    await m._start()
    m.periodic.mockClear()
    await vi.advanceTimersByTimeAsync(mins * MIN - 1)
    expect(m.periodic).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(m.periodic).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(mins * MIN)
    expect(m.periodic).toHaveBeenCalledTimes(2)
  })

  it('does not create a second interval if one already exists', async () => {
    const existing = setInterval(() => {}, 1e9)
    m.periodicIntervalId = existing as any
    await m._start()
    expect(m.periodicIntervalId).toBe(existing)
    clearInterval(existing)
    await vi.advanceTimersByTimeAsync(60 * MIN)
    expect(m.periodic).toHaveBeenCalledTimes(1) // only the initial run
  })

  it('a failing periodicTask does not stop the interval', async () => {
    await m._start()
    m.periodic.mockRejectedValue(new Error('boom'))
    const swallow = () => {}
    process.on('unhandledRejection', swallow)
    await vi.advanceTimersByTimeAsync(30 * MIN)
    process.off('unhandledRejection', swallow)
    expect(m.periodic).toHaveBeenCalledTimes(3)
  })

  // SUSPECTED SOURCE BUG: algoManager.ts:55-59 wraps `this.periodicTask()` in try/catch
  // without await, so an async rejection escapes the catch and becomes an unhandled
  // rejection (can crash Node >=15). Flips to a real failure once fixed.
  it.fails('handles a rejected periodicTask without an unhandled rejection', async () => {
    await m._start()
    m.periodic.mockRejectedValue(new Error('boom'))
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    await vi.advanceTimersByTimeAsync(15 * MIN)
    await vi.advanceTimersByTimeAsync(0)
    vi.useRealTimers()
    await new Promise<void>((r) => setImmediate(r))
    process.off('unhandledRejection', unhandled)
    expect(unhandled).not.toHaveBeenCalled()
  })
})
