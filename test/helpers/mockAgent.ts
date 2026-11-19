import { vi } from 'vitest'

// Minimal BskyAgent stand-in covering the calls this repo makes.
export const makeMockAgent = () => ({
  api: {
    app: {
      bsky: {
        graph: { getFollows: vi.fn().mockResolvedValue({ data: { follows: [], cursor: undefined } }) },
        feed: { getLikes: vi.fn().mockResolvedValue({ data: { likes: [], cursor: undefined } }) },
      },
    },
  },
  app: { bsky: { feed: { getPosts: vi.fn().mockResolvedValue({ data: { posts: [] } }) } } },
})
