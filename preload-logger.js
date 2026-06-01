/**
 * Preload (--require @advcomm/mtdd/register) logging by NODE_ENV.
 *
 * | NODE_ENV   | Default level | Detail |
 * |------------|---------------|--------|
 * | development, dev | debug   | Human-readable steps, timings, shard list |
 * | test       | warn          | Failures only (keeps test output quiet) |
 * | staging    | info          | Structured JSON, full startup fields |
 * | production, prod | info    | Structured JSON; use OTEL when enabled |
 *
 * Overrides:
 *   MTDD_PRELOAD_LOG_LEVEL=debug|info|warn|error
 *   MTDD_LOG_BACKEND=console|otel  (otel honored in production only)
 *   MTDD_LOG_OTEL=1                (alias for MTDD_LOG_BACKEND=otel in production)
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }

const DEFAULT_LEVEL_BY_ENV = {
  dev: 'debug',
  test: 'warn',
  staging: 'info',
  prod: 'info',
}

function normalizeNodeEnv(raw) {
  const value = String(raw ?? '')
    .trim()
    .toLowerCase()
  if (value === 'development' || value === 'dev') {
    return 'dev'
  }
  if (value === 'test') {
    return 'test'
  }
  if (value === 'staging' || value === 'stage') {
    return 'staging'
  }
  if (value === 'production' || value === 'prod') {
    return 'prod'
  }
  return value
}

function resolvePreloadEnv() {
  const raw = process.env.NODE_ENV
  if (raw === undefined || raw === '') {
    if (process.env.MTDD_GRPC_MOCK === '1') {
      return 'test'
    }
    return 'dev'
  }

  const fromNode = normalizeNodeEnv(raw)
  if (fromNode === 'dev' || fromNode === 'test' || fromNode === 'staging' || fromNode === 'prod') {
    return fromNode
  }
  if (process.env.MTDD_GRPC_MOCK === '1') {
    return 'test'
  }
  return 'prod'
}

function resolveLogLevel(env) {
  const override = process.env.MTDD_PRELOAD_LOG_LEVEL
  if (override !== undefined && override !== '') {
    const key = String(override).trim().toLowerCase()
    if (!(key in LEVELS)) {
      throw new Error(
        `MTDD_PRELOAD_LOG_LEVEL must be one of: debug, info, warn, error. Received: ${override}`,
      )
    }
    return key
  }
  return DEFAULT_LEVEL_BY_ENV[env] ?? 'info'
}

function resolveLogBackend(env) {
  const raw =
    process.env.MTDD_LOG_BACKEND ??
    (process.env.MTDD_LOG_OTEL === '1' ? 'otel' : 'console')
  const backend = String(raw).trim().toLowerCase()
  if (backend !== 'console' && backend !== 'otel') {
    throw new Error(
      `MTDD_LOG_BACKEND must be "console" or "otel". Received: ${raw}`,
    )
  }
  if (backend === 'otel' && env !== 'prod') {
    return 'console'
  }
  return backend
}

function shouldLog(level, minLevel) {
  return LEVELS[level] >= LEVELS[minLevel]
}

function redactCredentials(credentials) {
  if (!credentials || typeof credentials !== 'object') {
    return credentials
  }
  return {
    database: credentials.database,
    user: credentials.user,
    port: credentials.port,
    password: credentials.password === undefined ? undefined : '[REDACTED]',
  }
}

function summarizeHosts(hosts) {
  if (!Array.isArray(hosts)) {
    return []
  }
  return hosts.map((entry, hostIndex) => {
    if (typeof entry === 'string') {
      return { hostIndex, write: entry, read: [] }
    }
    return {
      hostIndex,
      write: entry?.write,
      read: Array.isArray(entry?.read) ? [...entry.read] : [],
    }
  })
}

let cachedConfig = null

function getPreloadLogConfig() {
  if (cachedConfig) {
    return cachedConfig
  }
  const env = resolvePreloadEnv()
  cachedConfig = {
    env,
    level: resolveLogLevel(env),
    backend: resolveLogBackend(env),
    structured: env === 'staging' || env === 'prod',
    human: env === 'dev',
  }
  return cachedConfig
}

function resetPreloadLogConfigForTests() {
  cachedConfig = null
}

function loadOtelApi() {
  try {
    return require('@opentelemetry/api')
  } catch {
    return null
  }
}

function emitOtel(level, message, fields) {
  const api = loadOtelApi()
  if (!api) {
    emitConsole(level, message, fields, getPreloadLogConfig())
    return
  }

  const attributes = {}
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (value === undefined) {
      continue
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      attributes[key] = value
    } else {
      attributes[key] = JSON.stringify(value)
    }
  }

  attributes['log.severity'] = level
  attributes['mtdd.preload.env'] = getPreloadLogConfig().env

  const tracer = api.trace.getTracer('@advcomm/mtdd', '1.0.0')
  const span = tracer.startSpan('mtdd.preload.log', { attributes })
  try {
    span.addEvent(message, attributes)
    if (level === 'error') {
      const err =
        fields?.err instanceof Error ? fields.err : new Error(message)
      span.recordException(err)
      const statusCode = api.SpanStatusCode?.ERROR ?? 2
      span.setStatus({ code: statusCode, message })
    }
    if (typeof api.diag?.[level] === 'function') {
      api.diag[level](`@advcomm/mtdd preload: ${message}`, fields)
    }
  } finally {
    span.end()
  }

  if (level === 'error' || level === 'warn') {
    emitConsole(level, message, fields, getPreloadLogConfig())
  }
}

function emitConsole(level, message, fields, config) {
  const payload = {
    ts: new Date().toISOString(),
    level,
    component: 'mtdd.preload',
    env: config.env,
    msg: message,
    ...fields,
  }

  if (config.human && level === 'debug') {
    const extra = fields ? ` ${JSON.stringify(fields)}` : ''
    process.stderr.write(`[mtdd:preload:${level}] ${message}${extra}\n`)
    return
  }

  if (config.structured) {
    const line = JSON.stringify(payload)
    if (level === 'error') {
      process.stderr.write(`${line}\n`)
    } else {
      process.stdout.write(`${line}\n`)
    }
    return
  }

  const prefix = `[mtdd:preload:${level}]`
  const line = config.human
    ? `${prefix} ${message}${fields ? ` ${JSON.stringify(fields)}` : ''}`
    : JSON.stringify(payload)
  if (level === 'error') {
    process.stderr.write(`${line}\n`)
  } else {
    process.stdout.write(`${line}\n`)
  }
}

function emit(level, message, fields = {}) {
  const config = getPreloadLogConfig()
  if (!shouldLog(level, config.level)) {
    return
  }

  if (config.backend === 'otel') {
    emitOtel(level, message, fields)
    return
  }

  emitConsole(level, message, fields, config)
}

function logDebug(message, fields) {
  emit('debug', message, fields)
}

function logInfo(message, fields) {
  emit('info', message, fields)
}

function logWarn(message, fields) {
  emit('warn', message, fields)
}

function logError(message, fields) {
  emit('error', message, fields)
}

function step(name, fn) {
  const config = getPreloadLogConfig()
  const start = config.level === 'debug' ? performance.now() : 0
  logDebug('preload step start', { step: name })
  try {
    const result = fn()
    if (result && typeof result.then === 'function') {
      return result.then(
        (value) => {
          logDebug('preload step complete', {
            step: name,
            durationMs:
              config.level === 'debug'
                ? Math.round((performance.now() - start) * 100) / 100
                : undefined,
          })
          return value
        },
        (err) => {
          logError('preload step failed', {
            step: name,
            err: err?.message ?? String(err),
            durationMs:
              config.level === 'debug'
                ? Math.round((performance.now() - start) * 100) / 100
                : undefined,
          })
          throw err
        },
      )
    }
    logDebug('preload step complete', {
      step: name,
      durationMs:
        config.level === 'debug'
          ? Math.round((performance.now() - start) * 100) / 100
          : undefined,
    })
    return result
  } catch (err) {
    logError('preload step failed', {
      step: name,
      err: err?.message ?? String(err),
      durationMs:
        config.level === 'debug'
          ? Math.round((performance.now() - start) * 100) / 100
          : undefined,
    })
    throw err
  }
}

function logPreloadBegin(meta = {}) {
  const config = getPreloadLogConfig()
  logInfo('mtdd preload starting', {
    nodeEnv: process.env.NODE_ENV,
    mtddEnv: config.env,
    logLevel: config.level,
    logBackend: config.backend,
    pid: process.pid,
    ...meta,
  })
}

function logPreloadComplete(meta = {}) {
  logInfo('mtdd preload complete', meta)
}

function logPreloadFailed(err, meta = {}) {
  logError('mtdd preload failed', {
    err: err?.message ?? String(err),
    ...meta,
  })
}

function logHostsValidated(hosts) {
  const summary = summarizeHosts(hosts)
  logInfo('db_host validated', {
    shardCount: summary.length,
    shards: getPreloadLogConfig().env === 'dev' ? summary : undefined,
    hosts: getPreloadLogConfig().env !== 'dev' ? summary : undefined,
  })
  if (getPreloadLogConfig().env === 'dev') {
    logDebug('db_host detail', { hosts: summary })
  }
}

function logLookupValidated(url) {
  const config = getPreloadLogConfig()
  const hideUrl = config.env === 'prod'
  logInfo('lookup url validated', {
    lookupUrl: hideUrl ? '[configured]' : url,
  })
  if (config.env === 'dev') {
    logDebug('lookup url', { lookupUrl: url })
  }
}

function logGrpcCredentials(credentials) {
  logInfo('grpc credentials loaded', {
    credentials: redactCredentials(credentials),
  })
}

function logLocalPostgresCheck(skipped, credentials) {
  if (skipped) {
    logWarn('localhost postgres check skipped', {
      reason:
        process.env.MTDD_SKIP_LOCAL_PG_CHECK === '1'
          ? 'MTDD_SKIP_LOCAL_PG_CHECK'
          : 'MTDD_GRPC_MOCK',
    })
    return
  }
  logInfo('localhost postgres check starting', {
    host: 'localhost',
    port: credentials.port,
    database: credentials.database,
    user: credentials.user,
  })
}

function logLocalPostgresCheckComplete(durationMs) {
  logInfo('localhost postgres check succeeded', { durationMs })
}

function logGrpcHubInitStarting(hosts, credentials) {
  logInfo('grpc hub init starting', {
    shardCount: hosts.length,
    grpcPort: process.env.MTDD_GRPC_PORT || '50051',
    mock: process.env.MTDD_GRPC_MOCK === '1',
    credentials: redactCredentials(credentials),
    shards:
      getPreloadLogConfig().env === 'dev' ||
      getPreloadLogConfig().env === 'staging'
        ? summarizeHosts(hosts)
        : undefined,
  })
}

function logGrpcHubInitComplete(shards, durationMs) {
  const endpoints = (shards ?? []).map((shard) => ({
    hostIndex: shard.hostIndex,
    write: shard.write?.host ?? shard.host,
    readCount: shard.reads?.length ?? 0,
    readHosts: shard.reads?.map((r) => r.host),
  }))
  logInfo('grpc hub init complete', {
    shardCount: endpoints.length,
    durationMs,
    endpoints:
      getPreloadLogConfig().env === 'dev' ||
      getPreloadLogConfig().env === 'staging'
        ? endpoints
        : undefined,
    connectedShards: getPreloadLogConfig().env === 'prod' ? endpoints.length : undefined,
  })
}

function logGrpcReadConnectWarning(writeHost, hostIndex, readHost, err) {
  logWarn('grpc read endpoint connect failed', {
    writeHost,
    hostIndex,
    readHost,
    err: err?.message ?? String(err),
  })
}

function logPatchApplied() {
  logInfo('pg patch applied', { patched: true })
}

function logAlreadyPatched() {
  logDebug('pg already patched, skipping preload', {})
}

module.exports = {
  resolvePreloadEnv,
  resolveLogLevel,
  resolveLogBackend,
  getPreloadLogConfig,
  resetPreloadLogConfigForTests,
  redactCredentials,
  summarizeHosts,
  logDebug,
  logInfo,
  logWarn,
  logError,
  step,
  logPreloadBegin,
  logPreloadComplete,
  logPreloadFailed,
  logHostsValidated,
  logLookupValidated,
  logGrpcCredentials,
  logLocalPostgresCheck,
  logLocalPostgresCheckComplete,
  logGrpcHubInitStarting,
  logGrpcHubInitComplete,
  logGrpcReadConnectWarning,
  logPatchApplied,
  logAlreadyPatched,
}
