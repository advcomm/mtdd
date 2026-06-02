const fs = require('node:fs')

function isTruthyEnv(value) {
  return value === '1' || value === 'true' || value === 'yes'
}

function readTlsFile(filePath, label) {
  if (!filePath || String(filePath).trim() === '') {
    return null
  }
  try {
    return fs.readFileSync(filePath)
  } catch (err) {
    throw new Error(
      `@advcomm/mtdd: failed to read ${label} at ${filePath}: ${err.message}`,
    )
  }
}

function resolveTlsEnv(prefix) {
  const enabled =
    isTruthyEnv(process.env[`${prefix}`]) ||
    isTruthyEnv(process.env.MTDD_GRPC_TLS)

  const caFile =
    process.env[`${prefix}_CA_FILE`] ?? process.env.MTDD_GRPC_TLS_CA_FILE
  const certFile =
    process.env[`${prefix}_CERT_FILE`] ?? process.env.MTDD_GRPC_TLS_CERT_FILE
  const keyFile =
    process.env[`${prefix}_KEY_FILE`] ?? process.env.MTDD_GRPC_TLS_KEY_FILE
  const serverName =
    process.env[`${prefix}_SERVER_NAME`] ??
    process.env.MTDD_GRPC_TLS_SERVER_NAME

  return {
    enabled: enabled || Boolean(caFile),
    caFile,
    certFile,
    keyFile,
    serverName,
  }
}

function createGrpcChannelCredentials(grpc, options = {}) {
  const prefix = options.envPrefix ?? 'MTDD_GRPC_TLS'
  const tls = resolveTlsEnv(prefix)

  if (!tls.enabled && !tls.caFile) {
    return grpc.credentials.createInsecure()
  }

  const rootCerts = readTlsFile(tls.caFile, `${prefix}_CA_FILE`)
  if (!rootCerts) {
    throw new Error(
      `@advcomm/mtdd: ${prefix}=1 or ${prefix}_CA_FILE is required for gRPC TLS`,
    )
  }

  const privateKey = readTlsFile(tls.keyFile, `${prefix}_KEY_FILE`)
  const certChain = readTlsFile(tls.certFile, `${prefix}_CERT_FILE`)

  const sslOptions = {}
  if (tls.serverName) {
    sslOptions['grpc.ssl_target_name_override'] = tls.serverName
  }

  return grpc.credentials.createSsl(rootCerts, privateKey, certChain, sslOptions)
}

function createNotifyChannelCredentials(grpc) {
  const notifyTls = resolveTlsEnv('MTDD_NOTIFY_TLS')
  if (notifyTls.enabled || notifyTls.caFile) {
    return createGrpcChannelCredentials(grpc, { envPrefix: 'MTDD_NOTIFY_TLS' })
  }
  return createGrpcChannelCredentials(grpc, { envPrefix: 'MTDD_GRPC_TLS' })
}

module.exports = {
  createGrpcChannelCredentials,
  createNotifyChannelCredentials,
  resolveTlsEnv,
}
