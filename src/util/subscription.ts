import { Database } from '../db'

import { Jetstream, CommitType } from '@skyware/jetstream'
import WebSocket from 'ws'

import { Semaphore } from 'async-mutex'
import { EventQueue } from './eventQueue'

const semaphore = new Semaphore(128)

const includedRecords = new Set(['app.bsky.feed.post'])

const DEFAULT_JETSTREAM_ENDPOINT =
  'wss://jetstream2.us-west.bsky.network/subscribe'
const DEFAULT_MAX_QUEUE = 50_000

const positiveInt = (val: string | undefined, fallback: number) => {
  const n = val ? parseInt(val, 10) : NaN
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export abstract class FirehoseSubscriptionBase {
  public jetstream: Jetstream
  /** Max queued events before the jetstream socket is closed (resumed from cursor once drained). */
  public maxQueue = positiveInt(process.env.FEEDGEN_MAX_QUEUE, DEFAULT_MAX_QUEUE)
  /** Jetstream endpoint. Note FEEDGEN_SUBSCRIPTION_ENDPOINT is a legacy relay URL and is not used here. */
  public jetstreamEndpoint =
    process.env.FEEDGEN_JETSTREAM_ENDPOINT || DEFAULT_JETSTREAM_ENDPOINT

  constructor(public db: Database, public service: string) {}

  abstract handleEvent(evt: any): Promise<void>

  async run(subscriptionReconnectDelay: number) {
    let lastSuccessfulCursor = (await this.getCursor()).cursor
    console.log("Fetching jetstream with cursor:", lastSuccessfulCursor)
    const eventQueue = new EventQueue()

    this.jetstream = new Jetstream({
      wantedCollections: Array.from(includedRecords.values()),
      ws: WebSocket,
      cursor: lastSuccessfulCursor,
      endpoint: this.jetstreamEndpoint,
    })

    this.jetstream.on('commit', (event) => {
      eventQueue.push(event)
      if (
        eventQueue.length > this.maxQueue &&
        this.jetstream.ws?.readyState === WebSocket.OPEN
      ) {
        console.log('core: queue too large, closing jetstream...')
        this.jetstream.close()
      }
    })

    // Wake the consumer if the socket drops while we are idle so it can resume.
    this.jetstream.on('close', () => eventQueue.wake())

    const processEvent = async (event: any) => {
      const posts = {
        cursor: event.time_us,
        creates: [] as {
          uri: string
          cid: string
          author: string
          record: any
        }[],
        deletes: [] as { uri: string }[],
      }

      if (event.commit.operation === CommitType.Create) {
        posts.creates.push({
          uri: `at://${event.did}/${event.commit.collection}/${event.commit.rkey}`,
          cid: event.commit.cid,
          author: event.did,
          record: event.commit.record,
        })
      }
      if (event.commit.operation === CommitType.Delete) {
        posts.deletes.push({
          uri: `at://${event.did}/${event.commit.collection}/${event.commit.rkey}`,
        })
      }

      return posts
    }

    const processQueue = async () => {
      let handledEvents = 0
      let lastSuccessfulCursor = (await this.getCursor()).cursor

      while (true) {
        if (eventQueue.length === 0) {
          if (
            this.jetstream.ws?.readyState !== WebSocket.OPEN &&
            this.jetstream.ws?.readyState !== WebSocket.CONNECTING
          ) {
            console.log('core: jetstream closed, starting...')
            // Resume from the last handled event. If nothing has been handled
            // yet (no saved cursor) keep the library's own cursor instead of
            // clearing it, which would skip to live and lose events.
            if (lastSuccessfulCursor) this.jetstream.cursor = lastSuccessfulCursor
            this.jetstream.start()
          } else {
            await eventQueue.wait()
          }
        }

        while (eventQueue.length > 0) {
          const event = eventQueue.shift()
          if (!event) continue

          const posts = await processEvent(event)
          if (handledEvents >= 1000) {
            if (lastSuccessfulCursor) this.updateCursor(lastSuccessfulCursor)
            handledEvents = 0
          }

          await semaphore.acquire().then(async ([value, release]) => {
            this.handleEvent(posts)
              .then(() => {
                lastSuccessfulCursor = posts.cursor
                handledEvents++
              })
              .finally(() => {
                release()
              })
          })
        }
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 10 * 1000))
    await processQueue()
  }

  async updateCursor(cursor: number) {
    await this.db.updateSubStateCursor(this.service, cursor)
  }

  async getCursor(): Promise<{ cursor?: number }> {
    const res = await this.db.getSubStateCursor(this.service)
    return res ? { cursor: res.cursor } : {}
  }
}
