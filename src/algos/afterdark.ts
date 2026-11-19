import { QueryParams } from '../lexicon/types/app/bsky/feed/getFeedSkeleton'
import { AppContext } from '../config'
import { AlgoManager } from '../addn/algoManager'
import dotenv from 'dotenv'
import { Post } from '../db/schema'
import dbClient from '../db/dbClient'
import { Database } from '../db'
import { BskyAgent } from '@atproto/api'
import { getAllFollows } from '../addn/followsCache'
import { getAllLikers } from '../addn/likesCache'

import * as fs from 'fs'
import { request } from 'http'

dotenv.config()

// max 15 chars
export const shortname = 'mutuals-ad'

export const handler = async (ctx: AppContext, params: QueryParams, agent: BskyAgent, requesterDID?: string | null) => {

  // console.log(requesterDID, " is requesting the after dark feed")

  let authors: any[] = [];

  if (requesterDID) {

    try {

      authors.push(requesterDID)

      // cached per-DID (TTL), paginates through all follows on a miss
      authors.push(...(await getAllFollows(agent, requesterDID)))

    } catch (error: any) {
      // partial follows (if any) are used but not cached
      if (Array.isArray(error?.partialFollows)) authors.push(...error.partialFollows)
      console.log("ERROR:::", error)
    }

  }

  // console.log("Got ", authors.length, " authors for ", requesterDID)


  const builder = await dbClient.getLatestPostsForTag({
    tag: shortname,
    limit: params.limit,
    cursor: params.cursor,
    mediaOnly: true,
    nsfwOnly: true,
    excludeNSFW: false,
    authors: authors
  })


  // let feed: any[] = []

  // if (requesterDID == process.env.FEEDGEN_PUBLISHER_DID) {
  //   feed = builder.map((row) => ({
  //     post: row.uri,
  //   }))
  // } 


  // if (requesterDID === process.env.FEEDGEN_PUBLISHER_DID) {
  //   console.log("Saving to authors.json")
  //   fs.writeFileSync('authors.json', JSON.stringify(authors, null, 4))
  //   fs.writeFileSync('posts.json', JSON.stringify(feed, null, 4))
  // }


  let feed = builder.map((row) => ({
    post: row.uri,
  }))

  let pinned: any[] = [
    // i.e. {post: `at://${process.env.FEEDGEN_PUBLISHER_DID}/app.bsky.feed.post/somepostrecordid`},
    { post: `at://${process.env.FEEDGEN_PUBLISHER_DID}/app.bsky.feed.post/3lhyfj7p7hk2r` },

  ]

  for (const post of pinned) {
    const likes = await getAllLikers(agent, post.post)
    if (requesterDID && !likes.has(requesterDID)) {
      console.log(requesterDID, " has NOT liked a pinned post")
      feed.unshift(post)
    } else {
      console.log(requesterDID, " has liked a pinned post")
    }
  }

  let cursor: string | undefined
  const last = builder.at(-1)
  if (last) {
    cursor = `${new Date(last.indexedAt).getTime()}::${last.cid}`
  }

  return {
    cursor,
    feed,
  }
}

export class manager extends AlgoManager {
  public name: string = shortname
  // public re: RegExp

  constructor(db: Database, agent: BskyAgent) {
    super(db, agent)

    // this.re = new RegExp(
    //   /^(?!.*((\b(cat( |-)girl|cat( |-)ears|cat( |-)suit|fursona|nsfw|cat-like|furryart|doja|dojacat|anthro|anthropomorphic)\b)|#furry|#furryart|fursuit)).*\b(cat|cats|catsofbluesky|kitty|kitten|kitties)\b.*$/ims,
    // )
  }

  public async periodicTask() {
    await this.db.removeTagFromOldPosts(
      this.name,
      new Date().getTime() - 7 * 24 * 60 * 60 * 1000,
    )
  }

  public async filter_post(post: Post): Promise<Boolean> {
    if (
      [
        'did:plc:mcb6n67plnrlx4lg35natk2b',
        'did:plc:2rhj4c7tzussdmfcrtlerr7b',
        'did:plc:hw7t2navoastix67wjzrmvof',
      ].includes(post.author)
    )
      return false


    if (this.agent === null) {
      await this.start()
    }

    if (this.agent === null) return false

    if (post.embed?.images || post.embed?.video || post.embed?.media) {
      return true
    }

    return false
  }
}
