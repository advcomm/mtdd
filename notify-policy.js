const { getWriteHost } = require('./host-config')
const { getGrpcPort } = require('./grpc-policy')

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

module.exports = {
  parseNotifyGrpcAddress,
  resolveNotifyGrpcAddress,
}
