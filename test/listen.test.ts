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

describe('LISTEN', () => {
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

  it('classifies LISTEN via pre-parse', () => {
    assert.equal(classifyQuery('LISTEN tenant_events').commandType, 'LISTEN')
    assert.equal(classifyQuery('listen "my-channel"').commandType, 'LISTEN')
  })

  it('returns synthetic LISTEN result and does not use gRPC', async () => {
    const { pg } = createMockPg()
    install(pg)

    const pool = new pg.Pool({ host: ['127.0.0.1', '127.0.0.2'] })
    const result = await pool.query('LISTEN tenant_events')

    assert.equal(result.command, 'LISTEN')
    assert.equal(result.rowCount, 0)
    assert.deepEqual(result.rows, [])
    assert.equal(grpcState.queries.length, 0)
  })

  it('registers transport subscription for the pool facade', async () => {
    const { pg } = createMockPg()
    install(pg)

    const pool = new pg.Pool({ host: ['127.0.0.1', '127.0.0.2'] })
    await pool.query('LISTEN shard_signal')

    const transport = getNotifyTransport()
    assert.equal(transport.kind, 'memory')
    const key = '__global__:shard_signal'
    assert.ok(transport.subscriptions.has(key))
    assert.equal(transport.subscriptions.get(key).size, 1)
  })
})
