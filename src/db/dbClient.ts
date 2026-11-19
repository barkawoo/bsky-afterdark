import {
  Document,
  Filter,
  MongoClient,
  ObjectId,
  WithoutId,
  SortDirection,
} from 'mongodb'
import dotenv from 'dotenv'
import { InvalidRequestError } from '@atproto/xrpc-server'
import {Post} from '../db/schema'


dotenv.config()

class dbSingleton {
  private static instance: dbSingleton | null = null
  client: MongoClient | null = null

  constructor(connection_string: string) {
    this.client = new MongoClient(connection_string)
    this.init()
  }

  static getInstance(): dbSingleton {
    if (dbSingleton.instance === null) {
      dbSingleton.instance = new dbSingleton(
        `${process.env.FEEDGEN_MONGODB_CONNECTION_STRING}`,
      )
    }
    return dbSingleton.instance
  }

  async init() {
    if (this.client === null) throw new Error('DB Cannot be null')
    await this.client.connect()

    const postCollection = this.client.db().collection('post')

    await postCollection.createIndex({ uri: 1 });
    await postCollection.createIndex({ indexedAt: -1, cid: -1 });
    await postCollection.createIndex({ algoTags: 1 });
    await postCollection.createIndex({ author: 1 });
    await postCollection.createIndex({ labels: 1 });
    await postCollection.createIndex({ "embed.images": 1 });
    await postCollection.createIndex({ "embed.video": 1 });
    await postCollection.createIndex({ "embed.media": 1 });
  }

  async deleteManyURI(collection: string, uris: string[]) {
    await this.client
      ?.db()
      .collection(collection)
      .deleteMany({ uri: { $in: uris } })
  }

  async deleteManyDID(collection: string, dids: string[]) {
    await this.client
      ?.db()
      .collection(collection)
      .deleteMany({ did: { $in: dids } })
  }

  async replaceOneURI(collection: string, uri: string, data: any) {
    if (!(typeof data._id === typeof '')) data._id = new ObjectId()
    else {
      data._id = new ObjectId(data._id)
    }

    try {
      await this.client?.db().collection(collection).insertOne(data)
    } catch (err) {
      await this.client
        ?.db()
        .collection(collection)
        .replaceOne({ uri: uri }, data)
    }
  }

  /**
   * Batched upsert of posts: one bulkWrite round trip instead of an
   * insertOne (+ replaceOne on duplicate) per post.
   *
   * The filter is {_id}, NOT {uri}: _id is a deterministic hash of the uri
   * (see subscription.ts), so the same post always maps to the same _id.
   * Filtering on _id means an upsert can never try to insert an _id that
   * already exists (which a {uri} filter could, if a legacy doc with that
   * _id had a different uri/no uri). Behavior matches replaceOneURI: a
   * post with a given _id is replaced in place; docs without a string _id
   * get a fresh ObjectId and are plain inserts (as before).
   * ordered:false so one bad doc doesn't block the rest; errors propagate.
   */
  async replaceManyURI(collection: string, docs: any[]) {
    if (!docs || docs.length === 0) return
    const ops = docs.map((data) => {
      if (typeof data._id === typeof '') {
        const _id = new ObjectId(data._id)
        return {
          replaceOne: {
            filter: { _id },
            replacement: { ...data, _id },
            upsert: true,
          },
        }
      }
      return { insertOne: { document: { ...data, _id: new ObjectId() } } }
    })
    await this.client
      ?.db()
      .collection(collection)
      .bulkWrite(ops as any, { ordered: false })
  }

  async replaceOneDID(collection: string, did: string, data: any) {
    if (!(typeof data._id === typeof '')) data._id = new ObjectId()
    else {
      data._id = new ObjectId(data._id)
    }

    try {
      await this.client?.db().collection(collection).insertOne(data)
    } catch (err) {
      await this.client
        ?.db()
        .collection(collection)
        .replaceOne({ did: did }, data)
    }
  }

  async getPostBySortWeight(
    collection: string,
    limit = 50,
    cursor: string | undefined = undefined,
  ) {
    let start = 0

    if (cursor !== undefined) {
      start = Number.parseInt(cursor)
    }

    const posts = await this.client
      ?.db()
      .collection(collection)
      .find({})
      .sort({ sort_weight: -1 })
      .skip(start)
      .limit(limit)
      .toArray()

    if (posts?.length !== undefined && posts.length > 0) return posts
    else return []
  }

  async aggregatePostsByRepliesToCollection(
    collection: string,
    tag: string,
    threshold: number,
    out: string,
    limit: number = 10000,
  ) {
    const indexedAt = new Date().getTime()

    await this.client
      ?.db()
      .collection(collection)
      .aggregate([
        { $match: { algoTags: tag, replyRoot: { $ne: null } } },
        {
          $group: {
            _id: '$replyRoot',
            count: { $sum: 1 },
          },
        },
        { $match: { count: { $gt: threshold } } },
        { $sort: { count: -1 } },
        { $limit: limit },
        { $addFields: { indexedAt: indexedAt } },
        { $merge: { into: out, on: '_id' } },
      ])
      .toArray()

    await this.client
      ?.db()
      .collection(out)
      .deleteMany({ indexedAt: { $ne: indexedAt } })
  }

  async getCollection(collection: string) {
    const ret = await this.client
      ?.db()
      .collection(collection)
      .find({})
      .toArray()
    if (ret) return ret
    else return []
  }

  async insertOrReplaceRecord(
    query: Filter<Document>,
    data: WithoutId<Document>,
    collection: string,
  ) {
    try {
      await this.client?.db().collection(collection).insertOne(data)
    } catch (err) {
      await this.client?.db().collection(collection).replaceOne(query, data)
    }
  }

  async updateSubStateCursor(service: string, cursor: number) {
    await this.client
      ?.db()
      .collection('sub_state')
      .findOneAndReplace(
        { service: service },
        { service: service, cursor: cursor },
        { upsert: true },
      )
  }

  async getSubStateCursor(service: string) {
    const res = await this.client
      ?.db()
      .collection('sub_state')
      .findOne({ service: service })
    if (res === null) {
      console.log( `SubState cursor not found for ${service}`)
      return { service: service, cursor: 0 }
    }
    return res
  }

  async getLatestPostsForTag({
    tag,
    limit = 50,
    cursor = undefined,
    mediaOnly = false,
    nsfwOnly = false,
    excludeNSFW = false,
    authors = [],
    sortOrder = -1,
  }: {
    tag: string
    limit?: number
    cursor?: string | undefined
    mediaOnly?: boolean
    nsfwOnly?: boolean
    excludeNSFW?: boolean
    authors?: string[]
    sortOrder?: SortDirection
  }) {
    let query: { indexedAt?: any; cid?: any; algoTags: string; author?: any; $and?: any[] } =
      {
        algoTags: tag,
      }

    const conditions: any[] = []

    if (mediaOnly) {
      conditions.push({
        $or: [
          { 'embed.images': { $ne: null } },
          { 'embed.video': { $ne: null } },
          { 'embed.media': { $ne: null } },
        ],
      })
    }
    if (nsfwOnly) {
      conditions.push({
        labels: {
          $in: ['porn', 'nudity', 'sexual', 'underwear'],
          $ne: null,
        },
      })
    }
    if (excludeNSFW) {
      conditions.push({
        labels: {
          $nin: ['porn', 'nudity', 'sexual', 'underwear'],
          // $ne: null,
        },
      })
    }
    if (authors.length > 0) {
      query['author'] = {
        $in: authors
      }
    }

    if (cursor !== undefined) {
      const [indexedAt, cid] = cursor.split('::')
      if (!indexedAt || !cid) {
        throw new InvalidRequestError('malformed cursor')
      }
      const timeStr = new Date(parseInt(indexedAt, 10)).getTime()

      query['indexedAt'] = { $lte: timeStr }
      query['cid'] = { $ne: cid }
    }

    if (conditions.length > 0) {
      query.$and = conditions
    }

    const results = this.client
      ?.db()
      .collection('post')
      .find(query)
      .sort({
        earliestCreatedIndexedAt: sortOrder,
        createdAt: sortOrder,
        indexedAt: sortOrder,
        cid: -1,
      })
      .limit(limit)
      .toArray()

    if (results === undefined) return []
    else return results
  }

  async getTaggedPostsBetween(tag: string, start: number, end: number) {
    const larger = start > end ? start : end
    const smaller = start > end ? end : start

    const results = this.client
      ?.db()
      .collection('post')
      .find({ indexedAt: { $lt: larger, $gt: smaller }, algoTags: tag })
      .sort({ indexedAt: -1, cid: -1 })
      .toArray()

    if (results === undefined) return []
    else return results
  }

  // Two classes of candidate, both media posts with labels: [] inside the
  // [now - retention, now - lagTime] window (retention 56 days = longest feed,
  // mutuals-ad-vid; env LABEL_RECHECK_RETENTION_DAYS):
  //  - fresh: never attempted (labelsCheckedAt absent; includes legacy docs).
  //  - scheduled: attempted before and due again by backoff.
  //      * found posts: after the Nth successful fetch (labelsCheckCount=N)
  //        due when labelsCheckedAt < now - RECHECK_DELAYS[N-1] (last repeats).
  //        Labels can land arbitrarily late and feed filters (excludeNSFW /
  //        nsfwOnly) depend on them, so this continues until retention.
  //      * missed posts (absent from a successful getPosts response: deleted,
  //        takedown): labels untouched; labelsMissCount=K, due on the same
  //        delay schedule, and dropped for good at K >= LABEL_MAX_MISSES (5).
  //        Found posts also stop once misses reach the cap.
  // Starvation guard: of `limit`, ~2/3 is reserved for fresh posts and the
  // rest for scheduled ones; whichever class is short spills its unused quota
  // to the other. Index use: indexedAt index serves the range/sort; the
  // count/checkedAt/miss predicates are residual filters.
  static readonly RECHECK_DELAYS = [
    60 * 60 * 1000,
    6 * 60 * 60 * 1000,
    24 * 60 * 60 * 1000,
  ]
  static readonly FRESH_QUOTA = 2 / 3

  async getUnlabelledPostsWithMedia(
    limit = 100,
    lagTime = 5 * 60 * 1000,
    retentionMs = (Number(process.env.LABEL_RECHECK_RETENTION_DAYS) || 56) *
      24 * 60 * 60 * 1000,
    maxMisses = Number(process.env.LABEL_MAX_MISSES) || 5,
  ) {
    const now = new Date().getTime()
    const delays = dbSingleton.RECHECK_DELAYS
    const delayFor = (n: number) => delays[Math.min(n, delays.length) - 1]
    const base = {
      $or: [
        { 'embed.images': { $ne: null } },
        { 'embed.video': { $ne: null } },
        { 'embed.media': { $ne: null } },
      ],
      labels: [],
      indexedAt: { $lt: now - lagTime, $gt: now - retentionMs },
    }
    const fresh: Filter<Document> = { labelsCheckedAt: { $exists: false } }
    const foundDue: Filter<Document>[] = [
      ...delays.map((d, i) => ({
        labelsCheckCount: i + 1,
        labelsCheckedAt: { $lt: now - d },
      })),
      {
        labelsCheckCount: { $gt: delays.length },
        labelsCheckedAt: { $lt: now - delays[delays.length - 1] },
      },
    ]
    const missDue: Filter<Document>[] = []
    for (let k = 1; k < maxMisses; k++) {
      missDue.push({
        labelsCheckCount: { $exists: false },
        labelsMissCount: k,
        labelsCheckedAt: { $lt: now - delayFor(k) },
      })
    }
    const scheduled: Filter<Document> = {
      labelsMissCount: { $not: { $gte: maxMisses } },
      $or: [...foundDue, ...missDue],
    }

    const coll = this.client?.db().collection('post')
    const run = async (extra: Filter<Document>, n: number, skip = 0) => {
      if (n <= 0 || !coll) return []
      let c = coll
        .find({ ...base, ...extra })
        .sort({ indexedAt: -1, cid: -1 })
      if (skip > 0) c = c.skip(skip)
      return (await c.limit(n).toArray()) || []
    }

    const freshQ = Math.ceil(limit * dbSingleton.FRESH_QUOTA)
    const schedQ = limit - freshQ
    const sched = await run(scheduled, schedQ)
    const freshRes = await run(fresh, limit - sched.length)
    const out = [...sched, ...freshRes]
    // scheduled had more than its quota and fresh left room: spill the other way
    if (out.length < limit && sched.length === schedQ) {
      out.push(...(await run(scheduled, limit - out.length, schedQ)))
    }
    return out
  }

  async updateLabelsForURIs(
    postEntries: { uri: string; labels?: string[]; missing?: boolean }[],
  ) {
    // bulkWrite throws on an empty ops array
    if (!postEntries || postEntries.length === 0) return
    const checkedAt = new Date().getTime()
    try {
      await this.client
        ?.db()
        .collection('post')
        .bulkWrite(
          postEntries.map((e) => ({
            updateOne: {
              filter: { uri: { $eq: e.uri } },
              // missing: absent from a successful response; labels untouched
              update: e.missing
                ? {
                    $set: { labelsCheckedAt: checkedAt },
                    $inc: { labelsMissCount: 1 },
                  }
                : {
                    $set: {
                      labels: e.labels,
                      labelsCheckedAt: checkedAt,
                      labelsMissCount: 0,
                    },
                    $inc: { labelsCheckCount: 1 },
                  },
            },
          })),
          { ordered: false },
        )
    } catch (err) {
      console.error('core: updateLabelsForURIs bulkWrite failed', err)
    }
  }

  async getRecentAuthorsForTag(tag: string, lastMs: number = 600000) {
    const results = await this.client
      ?.db()
      .collection('post')
      .distinct('author', {
        indexedAt: { $gt: new Date().getTime() - lastMs },
        algoTags: tag,
      })

    if (results === undefined) return []
    else return results
  }

  async getDistinctFromCollection(collection: string, field: string) {
    const results = await this.client
      ?.db()
      .collection(collection)
      .distinct(field)
    if (results === undefined) return []
    else return results
  }

  async removeTagFromPostsForAuthor(tag: string, authors: string[]) {
    const pullQuery: Record<string, any> = { algoTags: { $in: [tag] } }
    await this.client
      ?.db()
      .collection('post')
      .updateMany({ author: { $in: authors } }, { $pull: pullQuery })

    await this.deleteUntaggedPosts()
  }

  async removeTagFromOldPosts(tag: string, indexedAt: number) {
    const pullQuery: Record<string, any> = { algoTags: { $in: [tag] } }
    await this.client
      ?.db()
      .collection('post')
      .updateMany({ indexedAt: { $lt: indexedAt } }, { $pull: pullQuery })

    await this.deleteUntaggedPosts()
  }

  async deleteUntaggedPosts() {
    await this.client
      ?.db()
      .collection('post')
      .deleteMany({ algoTags: { $size: 0 } })
  }

  async getPostForURI(uri: string) {
    const results = await this.client
      ?.db()
      .collection('post')
      .findOne({ uri: uri })
    if (results === undefined) return null
    return results
  }
}

const dbClient = dbSingleton.getInstance()

export default dbClient
