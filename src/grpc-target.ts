const { getGrpcPort } = require('./grpc-policy')

/**
 * Production: client -> nginx (DB_HOST:MTDD_GRPC_PORT, optional TLS) -> mtdd_server unix socket.
 * Local dev (single shard): optional MTDD_GRPC_UNIX_SOCKET to skip nginx.
 */
function normalizeUnixGrpcTarget(raw) {
  let value = String(raw).trim()
  if (!value.startsWith('unix:')) {
    value = `unix:${value}`
  }
  if (value.startsWith('unix:/') && !value.startsWith('unix://')) {
    value = `unix://${value.slice('unix:'.length)}`
  }
  return value
}

function isUnixGrpcTarget(address) {
  return typeof address === 'string' && address.startsWith('unix:')
}

function resolveShardGrpcTarget(hostIp) {
  const unixSocket = process.env.MTDD_GRPC_UNIX_SOCKET
  if (unixSocket !== undefined && unixSocket !== '') {
    if (
      process.env.MTDD_GRPC_TLS === '1' ||
      process.env.MTDD_GRPC_TLS_CA_FILE
    ) {
      throw new Error(
        '@advcomm/mtdd: MTDD_GRPC_UNIX_SOCKET uses plain gRPC (no TLS). Use nginx TCP + MTDD_GRPC_TLS_* in production, or unset TLS vars for local unix socket dev.',
      )
    }
    return normalizeUnixGrpcTarget(unixSocket)
  }

  return `${hostIp}:${getGrpcPort()}`
}

function assertUnixSocketDevConstraints(hostCount) {
  const unixSocket = process.env.MTDD_GRPC_UNIX_SOCKET
  if (!unixSocket) {
    return
  }
  if (hostCount > 1) {
    throw new Error(
      '@advcomm/mtdd: MTDD_GRPC_UNIX_SOCKET is for single-shard local dev only. Production multi-shard must use DB_HOST + nginx (TCP).',
    )
  }
}

module.exports = {
  resolveShardGrpcTarget,
  isUnixGrpcTarget,
  normalizeUnixGrpcTarget,
  assertUnixSocketDevConstraints,
}
