const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const {
  createMockPg,
  createMockLookupServer,
  withTestEnv,
  setupGrpcMock,
} = require('./helpers')
const { install } = require('../src/patch')
const { classifyQuery } = require('../src/query-classifier')
const hooks = require('../src/hooks')
const {
  resetNotifyTransport,
  getNotifyTransport,
} = require('../src/mtdd-notify-transport')
const { clearNotificationRegistryForTests } = require('../src/notification-registry')

describe('UNLISTEN', () => {
  let restoreEnv
  let lookup
  let grpcState

  beforeEach(async () => {
    restoreEnv = withTestEnv({ DB_HOST: '["127.0.0.1","127.0.0.2"]' })
    grpcState = setupGrpcMock()
    lookup = await createMockLookupServer(() => ({ hostIndex: 0 }))
    process.env.MTDD_LOOKUP_URL = lookup.url
    hooks.onQuery = async (req, next) => next()
    clearNotificationRegistryForTests()
    resetNotifyTransport()
  })

  afterEach(async () => {
    await lookup.close()
    resetNotifyTransport()
    restoreEnv()
  })

  it('classifies UNLISTEN and UNLISTEN *', () => {
    assert.equal(classifyQuery('UNLISTEN tenant_events').commandType, 'UNLISTEN')
    assert.equal(classifyQuery('UNLISTEN *').commandType, 'UNLISTEN')
  })

  it('returns synthetic UNLISTEN result without gRPC', async () => {
    const { pg } = createMockPg()
    install(pg)

    const pool = new pg.Pool({ host: ['127.0.0.1', '127.0.0.2'] })
    await pool.query('LISTEN ch')
    const result = await pool.query('UNLISTEN ch')

    assert.equal(result.command, 'UNLISTEN')
    assert.equal(grpcState.queries.length, 0)

    const transport = getNotifyTransport()
    const key = '__global__:ch'
    assert.ok(
      !transport.subscriptions.has(key) ||
        transport.subscriptions.get(key).size === 0,
    )
  })

  it('UNLISTEN * clears all subscriptions for the client', async () => {
    const { pg } = createMockPg()
    install(pg)

    const pool = new pg.Pool({ host: ['127.0.0.1', '127.0.0.2'] })
    await pool.query('LISTEN a')
    await pool.query('LISTEN b')
    const result = await pool.query('UNLISTEN *')

    assert.equal(result.command, 'UNLISTEN')
    const transport = getNotifyTransport()
    for (const bucket of transport.subscriptions.values()) {
      assert.equal(bucket.size, 0)
    }
  })
})
