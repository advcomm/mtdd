const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const {
  getCacheKey,
  hashQueryText,
  getCachedClassificationAsync,
  setCachedClassificationAsync,
  clearClassificationCache,
  closeAstClassifyCache,
  useRedisClientForTests,
  KEY_PREFIX,
} = require('../ast-classify-cache')
const { classifyQueryAsync } = require('../sql-parse')

function createMockRedis() {
  const store = new Map()
  const expirations = new Map()

  return {
    store,
    expirations,
    async get(key) {
      return store.get(key) ?? null
    },
    async set(key, value, options) {
      store.set(key, value)
    if (options?.EX !== undefined) {
      expirations.set(key, options.EX)
    }
    },
    async expire(key, ttlSeconds) {
      expirations.set(key, ttlSeconds)
      return 1
    },
    async quit() {
      store.clear()
      expirations.clear()
    },
    isOpen: true,
  }
}

describe('ast-classify-cache', () => {
  let mockRedis
  let previousRedisUrl
  let previousTtlMs

  beforeEach(() => {
    clearClassificationCache()
    previousRedisUrl = process.env.MTDD_REDIS_URL
    previousTtlMs = process.env.MTDD_SQL_CLASSIFY_CACHE_TTL_MS
    process.env.MTDD_REDIS_URL = 'redis://127.0.0.1:6379'
    process.env.MTDD_SQL_CLASSIFY_CACHE_TTL_MS = '60000'
    mockRedis = createMockRedis()
    useRedisClientForTests(mockRedis)
  })

  afterEach(async () => {
    await closeAstClassifyCache()
    useRedisClientForTests(null)
    if (previousRedisUrl === undefined) {
      delete process.env.MTDD_REDIS_URL
    } else {
      process.env.MTDD_REDIS_URL = previousRedisUrl
    }
    if (previousTtlMs === undefined) {
      delete process.env.MTDD_SQL_CLASSIFY_CACHE_TTL_MS
    } else {
      process.env.MTDD_SQL_CLASSIFY_CACHE_TTL_MS = previousTtlMs
    }
  })

  it('uses SHA256 of query text as Redis key', () => {
    const sql = 'SELECT * FROM users WHERE id = $1'
    const expected = `${KEY_PREFIX}${createHash('sha256').update(sql, 'utf8').digest('hex')}`
    assert.equal(getCacheKey(sql), expected)
    assert.equal(hashQueryText(sql), createHash('sha256').update(sql, 'utf8').digest('hex'))
  })

  it('stores and retrieves classification JSON in Redis', async () => {
    const sql = 'SELECT 1'
    const classification = { commandType: 'SELECT', hasReturning: false }

    await setCachedClassificationAsync(sql, classification)

    const key = getCacheKey(sql)
    assert.equal(
      mockRedis.store.get(key),
      JSON.stringify(classification),
    )
    assert.equal(mockRedis.expirations.get(key), 60)

    clearClassificationCache()
    const hit = await getCachedClassificationAsync(sql)
    assert.deepEqual(hit, classification)
    assert.equal(mockRedis.expirations.get(key), 60)
  })

  it('refreshes TTL on cache hit (sliding expiration)', async () => {
    const sql = 'SELECT 2'
    const classification = { commandType: 'SELECT', hasReturning: false }
    await setCachedClassificationAsync(sql, classification)

    const key = getCacheKey(sql)
    mockRedis.expirations.set(key, 1)

    clearClassificationCache()
    await getCachedClassificationAsync(sql)

    assert.equal(mockRedis.expirations.get(key), 60)
  })

  it('classifyQueryAsync skips AST parse on Redis hit', async () => {
    const sql = 'SELECT * FROM orders WHERE id = $1'
    const classification = { commandType: 'SELECT', hasReturning: false }
    await setCachedClassificationAsync(sql, classification)

    clearClassificationCache()
    const result = await classifyQueryAsync(sql)
    assert.deepEqual(result, classification)
  })
})
