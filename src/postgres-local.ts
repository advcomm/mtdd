const { settlePromiseSync } = require('./install-sync')
const preloadLog = require('./preload-logger')

const LOCALHOST = 'localhost'
const DEFAULT_CONNECT_TIMEOUT_MS = 5000
const DEFAULT_POOL_MAX = 4

function getConnectTimeoutMs() {
  const raw = process.env.MTDD_LOCAL_PG_CONNECT_TIMEOUT_MS
  if (raw === undefined || raw === '') {
    return DEFAULT_CONNECT_TIMEOUT_MS
  }

  const timeoutMs = Number(raw)
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(
      `MTDD_LOCAL_PG_CONNECT_TIMEOUT_MS must be a positive number. Received: ${raw}`,
    )
  }

  return timeoutMs
}

function getPoolMax() {
  const raw = process.env.MTDD_LOCAL_PG_POOL_MAX
  if (raw === undefined || raw === '') {
    return DEFAULT_POOL_MAX
  }
  const max = Number(raw)
  if (!Number.isFinite(max) || max <= 0) {
    throw new Error(
      `MTDD_LOCAL_PG_POOL_MAX must be a positive number. Received: ${raw}`,
    )
  }
  return max
}

function shouldSkipLocalPostgresCheck() {
  return (
    process.env.MTDD_SKIP_LOCAL_PG_CHECK === '1' ||
    process.env.MTDD_GRPC_MOCK === '1'
  )
}

function buildLocalPostgresConfig(credentials) {
  return {
    host: LOCALHOST,
    port: credentials.port,
    database: credentials.database,
    user: credentials.user,
    password: credentials.password,
    connectionTimeoutMillis: getConnectTimeoutMs(),
  }
}

function poolCacheKey(credentials) {
  return `${LOCALHOST}:${credentials.port}:${credentials.database}:${credentials.user}`
}

let localPostgresPool = null
let localPostgresPoolKey = null

function getLocalPostgresPool(credentials) {
  const key = poolCacheKey(credentials)
  if (localPostgresPool && localPostgresPoolKey === key) {
    return localPostgresPool
  }

  if (localPostgresPool) {
    localPostgresPool.end().catch(() => {})
    localPostgresPool = null
    localPostgresPoolKey = null
  }

  const pg = require('pg')
  localPostgresPool = new pg.Pool({
    ...buildLocalPostgresConfig(credentials),
    max: getPoolMax(),
  })
  localPostgresPoolKey = key
  return localPostgresPool
}

async function resetLocalPostgresPool() {
  if (!localPostgresPool) {
    return
  }
  const pool = localPostgresPool
  localPostgresPool = null
  localPostgresPoolKey = null
  await pool.end().catch(() => {})
}

async function verifyLocalPostgres(credentials, options: { pgModule?: typeof import('pg') } = {}) {
  const pg = options.pgModule ?? require('pg')
  const Client = pg.Client
  const client = new Client(buildLocalPostgresConfig(credentials))
  const started = performance.now()

  try {
    await client.connect()
    await client.query('SELECT 1')
    preloadLog.logLocalPostgresCheckComplete(
      Math.round(performance.now() - started),
    )
  } catch (err) {
    const { database, user, port } = credentials
    throw new Error(
      `@advcomm/mtdd: PostgreSQL on ${LOCALHOST}:${port} is not reachable (database=${database}, user=${user}). DB_HOST is not used for this check. ${err.message}`,
    )
  } finally {
    try {
      await client.end()
    } catch {
      // ignore shutdown errors
    }
  }
}

function verifyLocalPostgresAtStartup(credentials) {
  const skipped = shouldSkipLocalPostgresCheck()
  preloadLog.logLocalPostgresCheck(skipped, credentials)
  if (skipped) {
    return
  }

  settlePromiseSync(verifyLocalPostgres(credentials))
}

let localPostgresClientFactory = null

function setLocalPostgresClientFactory(factory) {
  localPostgresClientFactory = factory
}

function resetLocalPostgresClientFactory() {
  localPostgresClientFactory = null
}

async function withLocalPostgresClient(credentials, fn) {
  if (localPostgresClientFactory) {
    const client = await localPostgresClientFactory(credentials)
    return fn(client)
  }

  const pool = getLocalPostgresPool(credentials)
  const client = await pool.connect()

  try {
    return await fn(client)
  } finally {
    client.release()
  }
}

module.exports = {
  LOCALHOST,
  buildLocalPostgresConfig,
  getLocalPostgresPool,
  resetLocalPostgresPool,
  verifyLocalPostgres,
  verifyLocalPostgresAtStartup,
  shouldSkipLocalPostgresCheck,
  getConnectTimeoutMs,
  getPoolMax,
  setLocalPostgresClientFactory,
  resetLocalPostgresClientFactory,
  withLocalPostgresClient,
}
