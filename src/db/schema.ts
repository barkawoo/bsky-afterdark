export type DatabaseSchema = {
  post: Post
  sub_state: SubState
  list_members: ListMember
}

export type Post = {
  _id: string | null
  uri: string
  cid: string
  author: string
  text: string
  replyParent: string | null
  replyRoot: string | null
  indexedAt: number
  algoTags: string[] | null
  embed?: any | null
  tags?: string[] | null
  labels?: string[]
  // ms epoch when batchUpdate last fetched labels for this post (absent = never)
  labelsCheckedAt?: number
  // number of successful label fetches (drives the re-check backoff)
  labelsCheckCount?: number
  // times the post was absent from a successful getPosts response (capped)
  labelsMissCount?: number
}

export type SubState = {
  _id: string | null
  service: string
  cursor: number
}

export type ListMember = {
  _id: string | null
  did: string
}
