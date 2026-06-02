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
  const caFile = process.env[`${prefix}_CA_FILE`] ?? null
  const enabled = isTruthyEnv(process.env[prefix]) || Boolean(caFile)

  return {
    prefix,
    enabled,
    caFile,
    certFile: process.env[`${prefix}_CERT_FILE`] ?? null,
    keyFile: process.env[`${prefix}_KEY_FILE`] ?? null,
    serverName: process.env[`${prefix}_SERVER_NAME`] ?? null,
  }
}

function validateTlsEnvConfig(tls) {
  if (!tls.enabled && !tls.caFile) {
    return {
      mode: 'insecure',
      mTLS: false,
      prefix: tls.prefix,
    }
  }

  if (tls.enabled && !tls.caFile) {
    throw new Error(
      `@advcomm/mtdd: ${tls.prefix}=1 requires ${tls.prefix}_CA_FILE (CA bundle to verify the server or nginx front-end).`,
    )
  }

  readTlsFile(tls.caFile, `${tls.prefix}_CA_FILE`)

  const hasCert = Boolean(tls.certFile)
  const hasKey = Boolean(tls.keyFile)
  if (hasCert !== hasKey) {
    throw new Error(
      `@advcomm/mtdd: ${tls.prefix}_CERT_FILE and ${tls.prefix}_KEY_FILE must both be set for mTLS.`,
    )
  }

  if (hasCert) {
    readTlsFile(tls.certFile, `${tls.prefix}_CERT_FILE`)
    readTlsFile(tls.keyFile, `${tls.prefix}_KEY_FILE`)
  }

  return {
    mode: 'tls',
    mTLS: hasCert && hasKey,
    prefix: tls.prefix,
    caFile: tls.caFile,
    serverName: tls.serverName,
  }
}

function validateGrpcTlsConfig() {
  const unixSocket = process.env.MTDD_GRPC_UNIX_SOCKET
  if (unixSocket !== undefined && String(unixSocket).trim() !== '') {
    return { mode: 'unix', mTLS: false, prefix: 'MTDD_GRPC_TLS' }
  }
  return validateTlsEnvConfig(resolveTlsEnv('MTDD_GRPC_TLS'))
}

function validateNotifyTlsConfig() {
  const notifyTls = resolveTlsEnv('MTDD_NOTIFY_TLS')
  if (notifyTls.enabled || notifyTls.caFile) {
    return validateTlsEnvConfig(notifyTls)
  }
  return validateGrpcTlsConfig()
}

function createGrpcChannelCredentials(grpc, options = {}) {
  const prefix = options.envPrefix ?? 'MTDD_GRPC_TLS'
  const tls = resolveTlsEnv(prefix)

  if (!tls.enabled && !tls.caFile) {
    return grpc.credentials.createInsecure()
  }

  validateTlsEnvConfig(tls)

  const rootCerts = readTlsFile(tls.caFile, `${prefix}_CA_FILE`)
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
  validateGrpcTlsConfig,
  validateNotifyTlsConfig,
  validateTlsEnvConfig,
}
