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
const { resetNotifyTransport } = require('../src/mtdd-notify-transport')
const { clearNotificationRegistryForTests } = require('../src/notification-registry')

describe('NOTIFY', () => {
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

  it('classifies NOTIFY with optional payload', () => {
    assert.equal(classifyQuery('NOTIFY events').commandType, 'NOTIFY')
    assert.equal(
      classifyQuery("NOTIFY events, 'hello'").commandType,
      'NOTIFY',
    )
  })

  it('returns synthetic NOTIFY result without gRPC', async () => {
    const { pg } = createMockPg()
    install(pg)

    const pool = new pg.Pool({ host: ['127.0.0.1', '127.0.0.2'] })
    const result = await pool.query("NOTIFY tenant_events, 'ping'")

    assert.equal(result.command, 'NOTIFY')
    assert.equal(result.rowCount, 0)
    assert.equal(grpcState.queries.length, 0)
  })
})
