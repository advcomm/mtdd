const { getWriteHost } = require('./host-config')
const { getGrpcPort } = require('./grpc-policy')

const DEFAULT_MAX_NOTIFY_PAYLOAD_BYTES = 65535
const DEFAULT_MAX_NOTIFY_CHANNEL_BYTES = 63

/**
 * Coordinator address for MtddNotify (host:port).
 * MTDD_NOTIFY_URL may be "host:port" or "grpc://host:port".
 */
function parseNotifyGrpcAddress(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return null
  }

  let value = String(raw).trim()
  if (value.startsWith('grpc://')) {
    value = value.slice('grpc://'.length)
  }

  const colon = value.lastIndexOf(':')
  if (colon <= 0 || colon === value.length - 1) {
    throw new Error(
      `MTDD_NOTIFY_URL must be host:port (optional grpc:// prefix). Received: ${raw}`,
    )
  }

  const host = value.slice(0, colon)
  const portRaw = value.slice(colon + 1)
  const port = Number(portRaw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `MTDD_NOTIFY_URL port must be an integer between 1 and 65535. Received: ${raw}`,
    )
  }

  return `${host}:${port}`
}

function isNotifyMockMode() {
  return process.env.MTDD_NOTIFY_MOCK === '1' || process.env.MTDD_GRPC_MOCK === '1'
}

function getMaxNotifyPayloadBytes() {
  const raw = process.env.MTDD_MAX_NOTIFY_PAYLOAD_BYTES
  if (raw === undefined || raw === '') {
    return DEFAULT_MAX_NOTIFY_PAYLOAD_BYTES
  }
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(
      `MTDD_MAX_NOTIFY_PAYLOAD_BYTES must be a non-negative integer. Received: ${raw}`,
    )
  }
  return value
}

function getMaxNotifyChannelBytes() {
  const raw = process.env.MTDD_MAX_NOTIFY_CHANNEL_BYTES
  if (raw === undefined || raw === '') {
    return DEFAULT_MAX_NOTIFY_CHANNEL_BYTES
  }
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(
      `MTDD_MAX_NOTIFY_CHANNEL_BYTES must be a positive integer. Received: ${raw}`,
    )
  }
  return value
}

function validateNotifyChannel(channel) {
  if (channel === undefined || channel === null || String(channel) === '') {
    throw new Error('@advcomm/mtdd: NOTIFY/LISTEN channel is required')
  }
  const name = String(channel)
  const byteLength = Buffer.byteLength(name, 'utf8')
  const maxBytes = getMaxNotifyChannelBytes()
  if (byteLength > maxBytes) {
    throw new Error(
      `@advcomm/mtdd: channel exceeds MTDD_MAX_NOTIFY_CHANNEL_BYTES (${maxBytes})`,
    )
  }
  return name
}

function validateNotifyPayload(payload) {
  const text = payload === undefined || payload === null ? '' : String(payload)
  const byteLength = Buffer.byteLength(text, 'utf8')
  const maxBytes = getMaxNotifyPayloadBytes()
  if (byteLength > maxBytes) {
    throw new Error(
      `@advcomm/mtdd: NOTIFY payload exceeds MTDD_MAX_NOTIFY_PAYLOAD_BYTES (${maxBytes})`,
    )
  }
  return text
}

function resolveNotifyGrpcAddress(hosts) {
  const fromEnv = parseNotifyGrpcAddress(process.env.MTDD_NOTIFY_URL)
  if (fromEnv) {
    return fromEnv
  }

  if (!Array.isArray(hosts) || hosts.length === 0) {
    return null
  }

  const host = getWriteHost(hosts[0])
  return `${host}:${getGrpcPort()}`
}

/**
 * Multi-shard apps must share one in-memory notify coordinator (mtdd_server d175c15+).
 */
function validateNotifyCoordinatorConfig(hosts) {
  if (isNotifyMockMode()) {
    return resolveNotifyGrpcAddress(hosts)
  }

  const shardCount = Array.isArray(hosts) ? hosts.length : 0
  const explicitUrl = parseNotifyGrpcAddress(process.env.MTDD_NOTIFY_URL)

  if (shardCount > 1 && !explicitUrl) {
    throw new Error(
      '@advcomm/mtdd: multi-shard DB_HOST requires MTDD_NOTIFY_URL pointing at a single MtddNotify coordinator (subscriptions are in-memory per server process).',
    )
  }

  return resolveNotifyGrpcAddress(hosts)
}

function describeNotifyTransport(hosts, address, transportKind) {
  const shardCount = Array.isArray(hosts) ? hosts.length : 0
  const explicit = Boolean(parseNotifyGrpcAddress(process.env.MTDD_NOTIFY_URL))
  return {
    transportKind,
    address: address ?? null,
    shardCount,
    explicitCoordinator: explicit,
    singleShardDefault: shardCount === 1 && !explicit && address !== null,
  }
}

module.exports = {
  DEFAULT_MAX_NOTIFY_PAYLOAD_BYTES,
  DEFAULT_MAX_NOTIFY_CHANNEL_BYTES,
  parseNotifyGrpcAddress,
  resolveNotifyGrpcAddress,
  validateNotifyCoordinatorConfig,
  validateNotifyChannel,
  validateNotifyPayload,
  getMaxNotifyPayloadBytes,
  getMaxNotifyChannelBytes,
  isNotifyMockMode,
  describeNotifyTransport,
}
