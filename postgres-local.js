const { settlePromiseSync } = require('./install-sync')

const LOCALHOST = 'localhost'
const DEFAULT_CONNECT_TIMEOUT_MS = 5000

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

async function verifyLocalPostgres(credentials, options = {}) {
  const pg = options.pgModule ?? require('pg')
  const Client = pg.Client

  const client = new Client(buildLocalPostgresConfig(credentials))

  try {
    await client.connect()
    await client.query('SELECT 1')
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
  if (shouldSkipLocalPostgresCheck()) {
    return
  }

  settlePromiseSync(verifyLocalPostgres(credentials))
}

module.exports = {
  LOCALHOST,
  buildLocalPostgresConfig,
  verifyLocalPostgres,
  verifyLocalPostgresAtStartup,
  shouldSkipLocalPostgresCheck,
  getConnectTimeoutMs,
}
