const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const {
  createMockPg,
  createMockLookupServer,
  withTestEnv,
  setupGrpcMock,
} = require('./helpers')
const { install } = require('../patch')
const hooks = require('../hooks')
const { resetNotifyTransport, useNotifyTransport } = require('../mtdd-notify-transport')
const { getLogicalClientId } = require('../notification-registry')
const { clearNotificationRegistryForTests } = require('../notification-registry')
const {
  createGrpcMockNotifyTransport,
} = require('./grpc-mock-notify-transport')

describe('grpc notify transport (MtddNotify semantics)', () => {
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

  it('LISTEN calls Subscribe with client_id and tid_scope', async () => {
    const { pg } = createMockPg()
    install(pg)
    useNotifyTransport(notifyMock)

    const pool = new pg.Pool({ host: ['127.0.0.1', '127.0.0.2'] })
    await pool.query('LISTEN orders')

    const clientId = getLogicalClientId(pool)
    assert.equal(notifyMock.calls.subscribe.length, 1)
    assert.equal(notifyMock.calls.subscribe[0].client_id, clientId)
    assert.equal(notifyMock.calls.subscribe[0].channel, 'orders')
    assert.equal(notifyMock.calls.subscribe[0].tid_scope, '__global__')
    assert.ok(notifyMock.calls.watch.some((w) => w.client_id === clientId))
  })

  it('NOTIFY calls Publish and delivers via Watch to listeners', async () => {
    const { pg } = createMockPg()
    install(pg)
    useNotifyTransport(notifyMock)

    const pool = new pg.Pool({ host: ['127.0.0.1', '127.0.0.2'] })
    const client = await pool.connect()
    const received = []

    client.on('notification', (msg) => received.push(msg))
    await client.query('LISTEN orders')
    await pool.query("NOTIFY orders, 'grpc-mock'")

    assert.equal(notifyMock.calls.publish.length, 1)
    assert.equal(notifyMock.calls.publish[0].channel, 'orders')
    assert.equal(notifyMock.calls.publish[0].payload, 'grpc-mock')
    assert.equal(received.length, 1)
    assert.equal(received[0].payload, 'grpc-mock')
  })

  it('UNLISTEN * calls UnsubscribeAll', async () => {
    const { pg } = createMockPg()
    install(pg)
    useNotifyTransport(notifyMock)

    const pool = new pg.Pool({ host: ['127.0.0.1', '127.0.0.2'] })
    await pool.query('LISTEN a')
    await pool.query('UNLISTEN *')

    assert.equal(notifyMock.calls.unsubscribeAll.length, 1)
  })
})
