import type { Pool, PoolClient, QueryResult } from 'pg'

export interface MtddQueryConfig {
  text: string
  values?: unknown[]
  rowMode?: string
  types?: unknown
  tid?: string | null
}

export interface MtddQueryRequest {
  text: string
  tid?: string | null
  commandType?: string
  routing?: string
  hostIndex?: number
}

export function install(pg?: typeof import('pg')): typeof import('pg')

export function shutdownMtdd(): Promise<void>
export function registerAutoShutdown(): void

export function runWithMtddContext<T>(
  context: Record<string, unknown>,
  fn: () => T,
): T

export function classifyQuery(text: string): {
  commandType: string
  hasReturning: boolean
}

export function mergeFanOutResults(
  req: MtddQueryRequest,
  results: QueryResult[],
): QueryResult

export function fanOutOnly(
  target: Pool | PoolClient,
  req: MtddQueryConfig,
): Promise<QueryResult[]>

export const hooks: {
  onQuery: (
    req: MtddQueryRequest,
    next: () => Promise<QueryResult>,
  ) => Promise<QueryResult>
  onLookup: (
    req: { tid: string; hostCount: number },
    next: () => Promise<number>,
  ) => Promise<number>
  onSelectHost: (
    req: Record<string, unknown>,
    next: () => Promise<number>,
  ) => Promise<number>
  onConnect: (req: unknown, next: () => Promise<unknown>) => Promise<unknown>
}
