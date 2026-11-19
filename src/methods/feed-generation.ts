import { InvalidRequestError } from '@atproto/xrpc-server'
import { Server } from '../lexicon'
import { AppContext } from '../config'
import algos from '../algos'
import { validateAuth } from '../auth'
import { AtUri } from '@atproto/syntax'
import { OutputSchema as AlgoOutput } from '../lexicon/types/app/bsky/feed/getFeedSkeleton'
// import { request } from 'http'
import { BskyAgent, ComAtprotoServerResetPassword } from '@atproto/api'
import { TtlCache, envInt } from '../addn/ttlCache'

// Short response cache. Feeds are personalized per requester, so the key
// includes requesterDid (plus feed, cursor and limit).
export const algoCache = new TtlCache<AlgoOutput>(
  envInt('FEED_CACHE_TTL_SECONDS', 30) * 1000,
  envInt('FEED_CACHE_MAX_ENTRIES', 2000),
)

export default function (server: Server, ctx: AppContext, agent: BskyAgent) {
  server.app.bsky.feed.getFeedSkeleton(async ({ params, req, res }) => {
    

    const feedUri = new AtUri(params.feed)
    const algo = algos[feedUri.rkey].handler
    if (
      //feedUri.hostname !== ctx.cfg.publisherDid ||
      feedUri.collection !== 'app.bsky.feed.generator' ||
      !algo
    ) {
      throw new InvalidRequestError(
        'Unsupported algorithm',
        'UnsupportedAlgorithm',
      )
    }

    // const cacheAge = algos[feedUri.rkey].manager.cacheAge(params)
    // if (cacheAge.valueOf() > 0) {
    //   res.setHeader('Cache-Control', `public, max-age=${cacheAge}`)
    // } else {
    //   res.setHeader('Cache-Control', `no-cache`)
    // }

    /**
     * Example of how to check auth if giving user-specific results:
     *
     * const requesterDid = await validateAuth(
     *   req,
     *   ctx.cfg.serviceDid,
     *   ctx.didResolver,
     * )
     */
    
    const { authorization = '' } = req.headers

    const requesterDid = await validateAuth(
      req,
      ctx.cfg.serviceDid,
      ctx.didResolver,
    )
    
    // console.log("Request from: ", requesterDid, " with authorization: ", authorization)
    // console.log(requesterDid, " requested a feed")

    const cacheKey = JSON.stringify([params.feed, requesterDid, params.cursor ?? null, params.limit])

    const body = await algoCache.getOrFetch(cacheKey, async () => {
      const out = await algo(ctx, params, agent, requesterDid)
      if (out.feed.length < params.limit) out.cursor = undefined
      return out
    })

    return {
      encoding: 'application/json',
      body: body,
    }
  })
}
