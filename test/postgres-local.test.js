const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { runRegister } = require('./helpers')
const {
  buildLocalPostgresConfig,
  verifyLocalPostgres,
  shouldSkipLocalPostgresCheck,
  resetLocalPostgresPool,
  LOCALHOST,
} = require('../postgres-local')

describe('postgres-local', () => {
  let previousSkip
  let previousMock

  beforeEach(() => {
    previousSkip = process.env.MTDD_SKIP_LOCAL_PG_CHECK
    previousMock = process.env.MTDD_GRPC_MOCK
  })

  afterEach(async () => {
    await resetLocalPostgresPool()
    if (previousSkip === undefined) {
      delete process.env.MTDD_SKIP_LOCAL_PG_CHECK
    } else {
      process.env.MTDD_SKIP_LOCAL_PG_CHECK = previousSkip
    }
    if (previousMock === undefined) {
      delete process.env.MTDD_GRPC_MOCK
    } else {
      process.env.MTDD_GRPC_MOCK = previousMock
    }
  })

  it('buildLocalPostgresConfig always uses localhost', () => {
    const config = buildLocalPostgresConfig({
      database: 'app',
      user: 'appuser',
      password: 'secret',
      port: 5433,
    })

    assert.equal(config.host, LOCALHOST)
    assert.equal(config.port, 5433)
    assert.equal(config.database, 'app')
    assert.equal(config.user, 'appuser')
    assert.equal(config.password, 'secret')
  })

  it('verifyLocalPostgres connects and runs SELECT 1', async () => {
    const calls = { connect: 0, query: 0, end: 0 }

    await verifyLocalPostgres(
      {
        database: 'testdb',
        user: 'testuser',
        password: 'testpass',
        port: 5432,
      },
      {
        pgModule: {
          Client: class MockClient {
            async connect() {
              calls.connect += 1
            }

            async query(sql) {
              calls.query += 1
              assert.equal(sql, 'SELECT 1')
            }

            async end() {
              calls.end += 1
            }
          },
        },
      },
    )

    assert.equal(calls.connect, 1)
    assert.equal(calls.query, 1)
    assert.equal(calls.end, 1)
  })

  it('verifyLocalPostgres throws when connection fails', async () => {
    await assert.rejects(
      () =>
        verifyLocalPostgres(
          {
            database: 'testdb',
            user: 'testuser',
            password: 'testpass',
            port: 5432,
          },
          {
            pgModule: {
              Client: class MockClient {
                async connect() {
                  throw new Error('ECONNREFUSED')
                }

                async end() {}
              },
            },
          },
        ),
      /PostgreSQL on localhost:5432 is not reachable/,
    )
  })

  it('skips local postgres check when MTDD_GRPC_MOCK is set', () => {
    process.env.MTDD_GRPC_MOCK = '1'
    assert.equal(shouldSkipLocalPostgresCheck(), true)
  })
})

describe('register local postgres check', () => {
  it('skips check under MTDD_GRPC_MOCK during register preload', () => {
    const result = runRegister({
      DB_HOST: '["10.0.1.10"]',
      MTDD_GRPC_MOCK: '1',
    })
    assert.equal(result.status, 0, result.stderr)
  })
})
