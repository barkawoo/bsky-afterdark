/** Minimal FIFO queue used by the firehose consumer. */
export class EventQueue<T = any> {
  private items: T[] = []

  get length(): number {
    return this.items.length
  }

  push(item: T): void {
    this.items.push(item)
  }

  shift(): T | undefined {
    return this.items.shift()
  }
}
