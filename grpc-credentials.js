function getGrpcCredentialsFromEnv() {
  const database = process.env.DB_NAME
  const user = process.env.DB_USER
  const password = process.env.DB_PASSWORD
  const port = process.env.DB_PORT

  if (!database) {
    throw new Error(
      'DB_NAME is required when @advcomm/mtdd is loaded (used for gRPC shard Connect).',
    )
  }
  if (!user) {
    throw new Error(
      'DB_USER is required when @advcomm/mtdd is loaded (used for gRPC shard Connect).',
    )
  }
  if (password === undefined) {
    throw new Error(
      'DB_PASSWORD is required when @advcomm/mtdd is loaded (used for gRPC shard Connect).',
    )
  }

  let pgPort = 5432
  if (port !== undefined && port !== '') {
    pgPort = Number(port)
    if (!Number.isInteger(pgPort) || pgPort < 1) {
      throw new Error(`DB_PORT must be a valid port number. Received: ${port}`)
    }
  }

  return {
    database,
    user,
    password,
    port: pgPort,
  }
}

module.exports = {
  getGrpcCredentialsFromEnv,
}
