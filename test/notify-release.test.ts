const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const {
  createMockPg,
  createMockLookupServer,
  withTestEnv,
  setupGrpcMock,
} = require('./helpers')
const { install } = require('../src/patch')
const hooks = require('../src/hooks')
const { resetNotifyTransport } = require('../src/mtdd-notify-transport')
const { clearNotificationRegistryForTests } = require('../src/notification-registry')
const {
  createGrpcMockNotifyTransport,
} = require('./grpc-mock-notify-transport')

describe('notify release lifecycle', () => {
  let restoreEnv
  let lookup
  let notifyMock

  beforeEach(async () => {
    restoreEnv = withTestEnv({ DB_HOST: '["127.0.0.1","127.0.0.2"]' })
    setupGrpcMock()
    lookup = await createMockLookupServer(() => ({ hostIndex: 0 }))
    process.env.MTDD_LOOKUP_URL = lookup.url
    hooks.onQuery = async (req, next) => next()
    clearNotificationRegistryForTests()
    resetNotifyTransport()
    notifyMock = createGrpcMockNotifyTransport()
  })

  afterEach(async () => {
    await lookup.close()
    resetNotifyTransport()
    restoreEnv()
  })

  it('UnsubscribeAll on client.release()', async () => {
    const { pg } = createMockPg()
    install(pg)
    const { useNotifyTransport } = require('../src/mtdd-notify-transport')
    useNotifyTransport(notifyMock)

    const pool = new pg.Pool({ host: ['127.0.0.1', '127.0.0.2'] })
    const client = await pool.connect()
    await client.query('LISTEN orders')
    await client.release()

    assert.equal(notifyMock.calls.unsubscribeAll.length, 1)
  })
})
