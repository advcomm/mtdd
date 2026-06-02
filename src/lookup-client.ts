const hooks = require('./hooks')
const { getLookupTimeoutMs } = require('./lookup-policy')
const { getLookupRetryCount } = require('./grpc-policy')
const {
  getCachedHostIndex,
  setCachedHostIndex,
} = require('./lookup-cache')

async function httpLookup(tid) {
  const url = process.env.MTDD_LOOKUP_URL
  const timeoutMs = getLookupTimeoutMs()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({ tid }),
      signal: controller.signal,
    })
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(
        `Lookup request timed out after ${timeoutMs}ms for tid: ${tid}`,
      )
    }
    throw new Error(
      `Lookup request failed for tid ${tid}: ${err.message}`,
    )
  } finally {
    clearTimeout(timer)
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(
      `Lookup server returned ${response.status} for tid ${tid}${body ? `: ${body}` : ''}`,
    )
  }

  let payload
  try {
    payload = await response.json()
  } catch {
    throw new Error(
      `Lookup server returned invalid JSON for tid: ${tid}`,
    )
  }

  if (
    !payload ||
    typeof payload !== 'object' ||
    typeof payload.hostIndex !== 'number' ||
    !Number.isInteger(payload.hostIndex)
  ) {
    throw new Error(
      `Lookup server response must include integer hostIndex for tid: ${tid}`,
    )
  }

  return payload.hostIndex
}

function assertHostIndex(hostIndex, hostCount, tid) {
  if (hostIndex < 0 || hostIndex >= hostCount) {
    throw new Error(
      `Lookup returned hostIndex ${hostIndex} out of range [0, ${hostCount - 1}] for tid: ${tid}`,
    )
  }
}

async function lookupWithRetries(tid) {
  const maxAttempts = getLookupRetryCount() + 1
  let lastError

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await httpLookup(tid)
    } catch (err) {
      lastError = err
      if (attempt >= maxAttempts - 1) {
        break
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(100 * 2 ** attempt, 1000)),
      )
    }
  }

  throw lastError
}

async function lookupHostIndex(tid, hostCount) {
  const cached = getCachedHostIndex(tid)
  if (cached !== undefined) {
    assertHostIndex(cached, hostCount, tid)
    return cached
  }

  const lookupRequest: { tid: string; hostCount: number; hostIndex?: number } = {
    tid,
    hostCount,
  }

  const hookResult = await hooks.onLookup(lookupRequest, async () =>
    lookupWithRetries(tid),
  )

  const hostIndex =
    typeof hookResult === 'number' ? hookResult : lookupRequest.hostIndex

  if (typeof hostIndex !== 'number' || !Number.isInteger(hostIndex)) {
    throw new Error(
      `Lookup did not resolve to an integer hostIndex for tid: ${tid}`,
    )
  }

  assertHostIndex(hostIndex, hostCount, tid)
  setCachedHostIndex(tid, hostIndex)
  return hostIndex
}

module.exports = {
  lookupHostIndex,
  httpLookup,
  assertHostIndex,
}
