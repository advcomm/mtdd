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
const {
  resetNotifyTransport,
  SYNTHETIC_PROCESS_ID,
} = require('../src/mtdd-notify-transport')
const { clearNotificationRegistryForTests } = require('../src/notification-registry')

describe('notification emit', () => {
  let restoreEnv
  let lookup

  beforeEach(async () => {
    restoreEnv = withTestEnv({ DB_HOST: '["127.0.0.1","127.0.0.2"]' })
    setupGrpcMock()
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

  it('emits pg notification on a checked-out client', async () => {
    const { pg } = createMockPg()
    install(pg)

    const pool = new pg.Pool({ host: ['127.0.0.1', '127.0.0.2'] })
    const client = await pool.connect()
    const received = []

    client.on('notification', (msg) => received.push(msg))
    await client.query('LISTEN orders')
    await pool.query("NOTIFY orders, 'ready'")

    assert.equal(received.length, 1)
    assert.equal(received[0].channel, 'orders')
    assert.equal(received[0].payload, 'ready')
    assert.equal(received[0].processId, SYNTHETIC_PROCESS_ID)
  })

  it('scopes channels by tid when provided', async () => {
    const { pg } = createMockPg()
    install(pg)

    const pool = new pg.Pool({ host: ['127.0.0.1', '127.0.0.2'] })
    const client = await pool.connect()
    const received = []

    client.on('notification', (msg) => received.push(msg))
    await client.query({ text: 'LISTEN scoped', tid: 7 })
    await pool.query({ text: "NOTIFY scoped, 'a'", tid: 7 })
    await pool.query({ text: "NOTIFY scoped, 'b'", tid: 8 })

    assert.equal(received.length, 1)
    assert.equal(received[0].payload, 'a')
  })
})
