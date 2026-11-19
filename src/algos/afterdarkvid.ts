import { QueryParams } from '../lexicon/types/app/bsky/feed/getFeedSkeleton'
import { AppContext } from '../config'
import { AlgoManager } from '../addn/algoManager'
import dotenv from 'dotenv'
import { Post } from '../db/schema'
import dbClient from '../db/dbClient'
import { Database } from '../db'
import { BskyAgent } from '@atproto/api'
import { getAllFollows } from '../addn/followsCache'

dotenv.config()

// max 15 chars
export const shortname = 'mutuals-ad-vid'

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

  const builder = await dbClient.getLatestPostsForTag({
    tag: shortname,
    limit: params.limit,
    cursor: params.cursor,
    mediaOnly: true,
    nsfwOnly: true,
    excludeNSFW: false,
    authors: authors
  })

  let feed = builder.map((row) => ({
    post: row.uri,
  }))


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
      new Date().getTime() - 56 * 24 * 60 * 60 * 1000,
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

    if (post.embed?.video) {
      return true
    }

    return false
  }
}
