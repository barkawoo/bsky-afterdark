import { vi } from 'vitest'

// Shared fake collection captured by the mocked MongoClient. Use with:
//   vi.mock('mongodb', async () => (await import('./helpers/mockMongo')).mongodbMockFactory())
export const collection = {
  createIndex: vi.fn(),
  insertOne: vi.fn(),
  replaceOne: vi.fn(),
  findOneAndUpdate: vi.fn(),
  bulkWrite: vi.fn(),
  find: vi.fn(),
  deleteMany: vi.fn(),
}

export const resetCollection = () => {
  Object.values(collection).forEach((f) => f.mockReset())
  collection.createIndex.mockResolvedValue('idx')
  collection.insertOne.mockResolvedValue({})
  collection.replaceOne.mockResolvedValue({})
  collection.findOneAndUpdate.mockResolvedValue({})
  collection.bulkWrite.mockResolvedValue({})
  const cursor = { sort: vi.fn(), limit: vi.fn(), toArray: vi.fn().mockResolvedValue([]) }
  cursor.sort.mockReturnValue(cursor)
  cursor.limit.mockReturnValue(cursor)
  collection.find.mockReturnValue(cursor)
  return cursor
}

export const mongodbMockFactory = () => {
  class ObjectId {
    constructor(public id?: string) {}
  }
  class MongoClient {
    constructor(_s: string) {}
    connect = async () => {}
    db = () => ({ collection: () => collection })
  }
  return { MongoClient, ObjectId }
}
