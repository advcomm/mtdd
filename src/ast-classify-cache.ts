const { createHash } = require('node:crypto')
const { getSqlClassifyCacheTtlSeconds } = require('./sql-cache-policy')

const KEY_PREFIX = 'mtdd:sql:classify:'
const CACHE_MAX = 500

const memoryCache = new Map()
let redisClient = null
let redisConnectPromise = null
let injectedRedisClient = null

function hashQueryText(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function getCacheKey(text) {
  return `${KEY_PREFIX}${hashQueryText(text)}`
}

function getFromMemory(text) {
  if (!memoryCache.has(text)) {
    return undefined
  }
  const value = memoryCache.get(text)
  memoryCache.delete(text)
  memoryCache.set(text, value)
  return value
}

function setInMemory(text, classification) {
  if (memoryCache.size >= CACHE_MAX) {
    const oldest = memoryCache.keys().next().value
    memoryCache.delete(oldest)
  }
  memoryCache.set(text, classification)
}

function serializeClassification(classification) {
  return JSON.stringify(classification)
}

function deserializeClassification(raw) {
  const parsed = JSON.parse(raw)
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof parsed.commandType !== 'string' ||
    typeof parsed.hasReturning !== 'boolean'
  ) {
    throw new Error('Invalid classification payload in Redis cache')
  }
  return parsed
}

function isRedisConfigured() {
  return (
    injectedRedisClient !== null ||
    (typeof process.env.MTDD_REDIS_URL === 'string' &&
      process.env.MTDD_REDIS_URL.trim() !== '')
  )
}

async function getRedisClient() {
  if (injectedRedisClient) {
    return injectedRedisClient
  }

  if (!isRedisConfigured()) {
    return null
  }

  if (!redisClient) {
    const { createClient } = require('redis')
    redisClient = createClient({ url: process.env.MTDD_REDIS_URL.trim() })
    redisClient.on('error', () => {
      // Connection errors surface on command; avoid unhandled event noise.
    })
    redisConnectPromise = redisClient.connect()
  }

  await redisConnectPromise
  return redisClient
}

async function getFromRedis(text) {
  const client = await getRedisClient()
  if (!client) {
    return undefined
  }

  const key = getCacheKey(text)
  const ttlSeconds = getSqlClassifyCacheTtlSeconds()
  const raw = await client.get(key)
  if (raw === null) {
    return undefined
  }

  await client.expire(key, ttlSeconds)
  return deserializeClassification(raw)
}

async function setInRedis(text, classification) {
  const client = await getRedisClient()
  if (!client) {
    return
  }

  const key = getCacheKey(text)
  const ttlSeconds = getSqlClassifyCacheTtlSeconds()
  await client.set(key, serializeClassification(classification), {
    EX: ttlSeconds,
  })
}

function refreshRedisTtlFireAndForget(text) {
  if (!isRedisConfigured()) {
    return
  }

  const key = getCacheKey(text)
  const ttlSeconds = getSqlClassifyCacheTtlSeconds()
  void getRedisClient()
    .then((client) => {
      if (client) {
        return client.expire(key, ttlSeconds)
      }
      return undefined
    })
    .catch(() => {
      // Redis TTL refresh is best-effort on memory hits.
    })
}

function setRedisFireAndForget(text, classification) {
  if (!isRedisConfigured()) {
    return
  }

  void setInRedis(text, classification).catch(() => {
    // Redis populate is best-effort on sync path.
  })
}

function getCachedClassificationSync(text) {
  const cached = getFromMemory(text)
  if (cached) {
    refreshRedisTtlFireAndForget(text)
  }
  return cached
}

function setCachedClassificationSync(text, classification) {
  setInMemory(text, classification)
  setRedisFireAndForget(text, classification)
}

async function getCachedClassificationAsync(text) {
  const memoryHit = getFromMemory(text)
  if (memoryHit) {
    refreshRedisTtlFireAndForget(text)
    return memoryHit
  }

  try {
    const redisHit = await getFromRedis(text)
    if (redisHit) {
      setInMemory(text, redisHit)
      return redisHit
    }
  } catch {
    // Redis unavailable: fall through to parse without failing routing.
  }

  return undefined
}

async function setCachedClassificationAsync(text, classification) {
  setInMemory(text, classification)
  try {
    await setInRedis(text, classification)
  } catch {
    // Redis unavailable: in-memory cache still applies for this process.
  }
}

function clearClassificationCache() {
  memoryCache.clear()
}

async function closeAstClassifyCache() {
  if (injectedRedisClient) {
    if (typeof injectedRedisClient.quit === 'function') {
      await injectedRedisClient.quit()
    }
    memoryCache.clear()
    return
  }

  if (redisClient && redisClient.isOpen) {
    await redisClient.quit()
  }
  redisClient = null
  redisConnectPromise = null
  memoryCache.clear()
}

function useRedisClientForTests(client) {
  injectedRedisClient = client
  redisClient = null
  redisConnectPromise = null
}

module.exports = {
  KEY_PREFIX,
  hashQueryText,
  getCacheKey,
  getCachedClassificationSync,
  setCachedClassificationSync,
  getCachedClassificationAsync,
  setCachedClassificationAsync,
  clearClassificationCache,
  closeAstClassifyCache,
  useRedisClientForTests,
  isRedisConfigured,
}
