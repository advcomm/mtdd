const net = require('node:net')

/**
 * @typedef {{ write: string, read: string[] }} NormalizedHostEntry
 */

function assertIpAddress(value, label) {
  if (typeof value !== 'string' || net.isIP(value) === 0) {
    throw new Error(
      `${label} must be an IPv4 or IPv6 address; hostnames are not allowed. Received: ${JSON.stringify(value)}`,
    )
  }
}

function normalizeHostEntry(item, index, context) {
  const label = `${context}[${index}]`

  if (typeof item === 'string') {
    assertIpAddress(item, label)
    // No separate read replicas: the same IP serves write and SELECT traffic.
    return { write: item, read: [] }
  }

  if (typeof item !== 'object' || item === null || Array.isArray(item)) {
    throw new Error(
      `${label} must be a string IP address or an object with "write" and optional "read". Received: ${JSON.stringify(item)}`,
    )
  }

  if (!('write' in item)) {
    throw new Error(
      `${label} must include a "write" IP address. Received: ${JSON.stringify(item)}`,
    )
  }

  assertIpAddress(item.write, `${label}.write`)

  const readList = item.read ?? item.reads
  if (readList === undefined) {
    return { write: item.write, read: [] }
  }

  if (!Array.isArray(readList)) {
    throw new Error(
      `${label}.read must be an array of IP addresses. Received: ${JSON.stringify(readList)}`,
    )
  }

  const read = []
  for (let r = 0; r < readList.length; r++) {
    assertIpAddress(readList[r], `${label}.read[${r}]`)
    read.push(readList[r])
  }

  return { write: item.write, read }
}

function parseHostArray(parsed, context) {
  if (!Array.isArray(parsed)) {
    throw new Error(
      `${context} must be a JSON array of IP addresses or host objects, not a single value. Received: ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed)}`,
    )
  }

  if (parsed.length === 0) {
    throw new Error(`${context} array must not be empty.`)
  }

  return parsed.map((item, index) => normalizeHostEntry(item, index, context))
}

function parseEnvDbHost() {
  const raw = process.env.DB_HOST

  if (raw === undefined || raw === '') {
    throw new Error(
      'DB_HOST is required when @advcomm/mtdd is loaded. Set DB_HOST to a JSON array of IP addresses or host objects, e.g. ["10.0.1.10"] or [{"write":"10.0.1.10","read":["10.0.1.11"]}].',
    )
  }

  let parsed
  try {
    parsed = JSON.parse(raw.trim())
  } catch {
    throw new Error(
      `DB_HOST must be valid JSON parsing to a non-empty array. Received: ${raw}`,
    )
  }

  return parseHostArray(parsed, 'DB_HOST')
}

function normalizeConfigHosts(host) {
  if (host === undefined) {
    return []
  }
  const raw = Array.isArray(host) ? host : [host]
  return parseHostArray(raw, 'config.host')
}

function getWriteHost(entry) {
  if (typeof entry === 'string') {
    return entry
  }
  return entry.write
}

function getReadHosts(entry) {
  if (typeof entry === 'string') {
    return []
  }
  return entry.read ?? []
}

module.exports = {
  assertIpAddress,
  normalizeHostEntry,
  parseHostArray,
  parseEnvDbHost,
  normalizeConfigHosts,
  getWriteHost,
  getReadHosts,
}
