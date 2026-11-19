import { vi } from 'vitest'

// src/db/dbClient.ts opens a Mongo connection at import time.
// Tests must vi.mock('../src/db/dbClient') with this factory before importing code under test.
export const makeMockDbClient = () => ({
  getLatestPostsForTag: vi.fn().mockResolvedValue([]),
  replaceOneURI: vi.fn().mockResolvedValue(undefined),
  replaceManyURI: vi.fn().mockResolvedValue(undefined),
  deleteManyURI: vi.fn().mockResolvedValue(undefined),
  updateLabelsForURIs: vi.fn().mockResolvedValue(undefined),
  getUnlabelledPostsWithMedia: vi.fn().mockResolvedValue([]),
  removeTagFromOldPosts: vi.fn().mockResolvedValue(undefined),
  getSubStateCursor: vi.fn().mockResolvedValue({ cursor: 0 }),
  updateSubStateCursor: vi.fn().mockResolvedValue(undefined),
})
