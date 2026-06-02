const DEFAULT_TTL_MS = 30_000

let cache = new Map()

function getLookupCacheTtlMs() {
  const raw = process.env.MTDD_LOOKUP_CACHE_TTL_MS
  if (raw === undefined || raw === '') {
    return DEFAULT_TTL_MS
  }
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(
      `MTDD_LOOKUP_CACHE_TTL_MS must be a non-negative number. Received: ${raw}`,
    )
  }
  return value
}

function isLookupCacheEnabled() {
  return getLookupCacheTtlMs() > 0
}

function getCachedHostIndex(tid) {
  if (!isLookupCacheEnabled()) {
    return undefined
  }

  const entry = cache.get(String(tid))
  if (!entry) {
    return undefined
  }

  if (Date.now() > entry.expiresAt) {
    cache.delete(String(tid))
    return undefined
  }

  return entry.hostIndex
}

function setCachedHostIndex(tid, hostIndex) {
  if (!isLookupCacheEnabled()) {
    return
  }

  cache.set(String(tid), {
    hostIndex,
    expiresAt: Date.now() + getLookupCacheTtlMs(),
  })
}

function clearLookupCache() {
  cache = new Map()
}

module.exports = {
  getLookupCacheTtlMs,
  isLookupCacheEnabled,
  getCachedHostIndex,
  setCachedHostIndex,
  clearLookupCache,
}
