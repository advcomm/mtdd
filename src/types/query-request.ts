/** Normalized pg query request built in normalize.ts */
export interface MtddNormalizedQueryRequest {
  source: string
  rawArgs: unknown[]
  client: unknown
  pool: unknown
  text?: string
  values?: unknown[]
  name?: string
  row_mode?: string
  rowMode?: string
  types?: unknown
  tid?: string | null
  callback?: (...args: unknown[]) => void
  commandType?: string
  routing?: string
  hostIndex?: number
  [key: string]: unknown
}
