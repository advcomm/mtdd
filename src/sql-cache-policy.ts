const DEFAULT_TTL_MS = 60 * 60 * 1000

function getSqlClassifyCacheTtlMs() {
  const raw = process.env.MTDD_SQL_CLASSIFY_CACHE_TTL_MS
  if (raw === undefined || raw === '') {
    return DEFAULT_TTL_MS
  }

  const ttlMs = Number(raw)
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error(
      `MTDD_SQL_CLASSIFY_CACHE_TTL_MS must be a positive number. Received: ${raw}`,
    )
  }

  return ttlMs
}

function getSqlClassifyCacheTtlSeconds() {
  return Math.ceil(getSqlClassifyCacheTtlMs() / 1000)
}

module.exports = {
  DEFAULT_TTL_MS,
  getSqlClassifyCacheTtlMs,
  getSqlClassifyCacheTtlSeconds,
}
