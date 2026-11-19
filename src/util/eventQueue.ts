/**
 * FIFO queue with O(1) amortised push/shift (index-based, periodically
 * compacted) and a promise-based wait so consumers do not need to poll.
 */
export class EventQueue<T = any> {
  private items: (T | undefined)[] = []
  private head = 0
  private waiter: (() => void) | null = null

  get length(): number {
    return this.items.length - this.head
  }

  push(item: T): void {
    this.items.push(item)
    this.wake()
  }

  shift(): T | undefined {
    if (this.head >= this.items.length) return undefined
    const item = this.items[this.head]
    this.items[this.head] = undefined
    this.head++
    if (this.head === this.items.length) {
      this.items = []
      this.head = 0
    } else if (this.head >= 4096 && this.head * 2 >= this.items.length) {
      this.items = this.items.slice(this.head)
      this.head = 0
    }
    return item
  }

  /** Resolves when an item is pushed or wake() is called. */
  wait(): Promise<void> {
    return new Promise((resolve) => {
      this.waiter = resolve
    })
  }

  /** Release a pending wait() (also used for non-item events such as ws close). */
  wake(): void {
    const w = this.waiter
    this.waiter = null
    if (w) w()
  }
}
