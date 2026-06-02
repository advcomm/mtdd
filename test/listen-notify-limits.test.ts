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
const { DEFAULT_MAX_NOTIFY_CHANNEL_BYTES } = require('../src/notify-policy')

describe('listen-notify limits', () => {
  let restoreEnv
  let lookup

  beforeEach(async () => {
    restoreEnv = withTestEnv({ DB_HOST: '["127.0.0.1"]' })
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

  it('rejects LISTEN when channel exceeds MTDD_MAX_NOTIFY_CHANNEL_BYTES', async () => {
    const { pg } = createMockPg()
    install(pg)

    const pool = new pg.Pool({ host: '127.0.0.1' })
    const channel = 'c'.repeat(DEFAULT_MAX_NOTIFY_CHANNEL_BYTES + 1)

    await assert.rejects(
      () => pool.query(`LISTEN ${channel}`),
      /MTDD_MAX_NOTIFY_CHANNEL_BYTES/,
    )
  })
})
