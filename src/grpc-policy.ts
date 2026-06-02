function getGrpcPort() {
  const raw = process.env.MTDD_GRPC_PORT
  if (raw === undefined || raw === '') {
    return 50051
  }

  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `MTDD_GRPC_PORT must be an integer between 1 and 65535. Received: ${raw}`,
    )
  }

  return port
}

function getGrpcConnectTimeoutMs() {
  const raw = process.env.MTDD_GRPC_CONNECT_TIMEOUT_MS
  if (raw === undefined || raw === '') {
    return 10000
  }

  const ms = Number(raw)
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new Error(
      `MTDD_GRPC_CONNECT_TIMEOUT_MS must be a positive number. Received: ${raw}`,
    )
  }

  return ms
}

function getGrpcQueryTimeoutMs() {
  const raw = process.env.MTDD_GRPC_QUERY_TIMEOUT_MS
  if (raw === undefined || raw === '') {
    return getGrpcConnectTimeoutMs()
  }

  const ms = Number(raw)
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new Error(
      `MTDD_GRPC_QUERY_TIMEOUT_MS must be a positive number. Received: ${raw}`,
    )
  }

  return ms
}

function getGrpcMaxRetries() {
  const raw = process.env.MTDD_GRPC_MAX_RETRIES
  if (raw === undefined || raw === '') {
    return 2
  }

  const count = Number(raw)
  if (!Number.isInteger(count) || count < 0 || count > 10) {
    throw new Error(
      `MTDD_GRPC_MAX_RETRIES must be an integer from 0 to 10. Received: ${raw}`,
    )
  }

  return count
}

function getLookupRetryCount() {
  const raw = process.env.MTDD_LOOKUP_RETRY_COUNT
  if (raw === undefined || raw === '') {
    return 2
  }

  const count = Number(raw)
  if (!Number.isInteger(count) || count < 0 || count > 10) {
    throw new Error(
      `MTDD_LOOKUP_RETRY_COUNT must be an integer from 0 to 10. Received: ${raw}`,
    )
  }

  return count
}

function isRetryableGrpcError(err) {
  const code = err?.code
  return (
    code === 14 || // UNAVAILABLE
    code === 4 || // DEADLINE_EXCEEDED
    code === 13 // INTERNAL (transient)
  )
}

module.exports = {
  getGrpcPort,
  getGrpcConnectTimeoutMs,
  getGrpcQueryTimeoutMs,
  getGrpcMaxRetries,
  getLookupRetryCount,
  isRetryableGrpcError,
}
