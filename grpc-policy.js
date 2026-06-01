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

module.exports = {
  getGrpcPort,
  getGrpcConnectTimeoutMs,
}
