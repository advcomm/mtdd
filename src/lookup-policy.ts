function validateLookupUrl() {
  const url = process.env.MTDD_LOOKUP_URL

  if (url === undefined || url === '') {
    throw new Error(
      'MTDD_LOOKUP_URL is required when @advcomm/mtdd is loaded. Set MTDD_LOOKUP_URL to the HTTP lookup endpoint, e.g. http://lookup:8080/lookup',
    )
  }

  try {
    new URL(url)
  } catch {
    throw new Error(
      `MTDD_LOOKUP_URL must be a valid URL. Received: ${url}`,
    )
  }

  return url
}

function getLookupTimeoutMs() {
  const raw = process.env.MTDD_LOOKUP_TIMEOUT_MS
  if (raw === undefined || raw === '') {
    return 2000
  }

  const ms = Number(raw)
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new Error(
      `MTDD_LOOKUP_TIMEOUT_MS must be a positive number. Received: ${raw}`,
    )
  }

  return ms
}

module.exports = {
  validateLookupUrl,
  getLookupTimeoutMs,
}
