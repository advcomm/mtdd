/** Fan-out policy attaches shard metadata to thrown errors. */
interface FanOutAggregateError extends Error {
  shardErrors?: Array<{ hostIndex: number; error: Error }>
  partialResults?: unknown[]
}

/** Lookup HTTP errors from lookup-client. */
interface LookupHttpError extends Error {
  statusCode?: number
}
