const { describe, it, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const {
  initNotifyTransport,
  resetNotifyTransport,
  getNotifyTransport,
} = require('../src/mtdd-notify-transport')

describe('notify transport init', () => {
  afterEach(() => {
    resetNotifyTransport()
    delete process.env.MTDD_NOTIFY_URL
    delete process.env.MTDD_GRPC_MOCK
    delete process.env.MTDD_NOTIFY_MOCK
  })

  it('uses memory transport when MTDD_GRPC_MOCK=1', () => {
    process.env.MTDD_GRPC_MOCK = '1'
    process.env.MTDD_NOTIFY_URL = '10.0.0.9:50051'
    initNotifyTransport({ hosts: ['10.0.0.1'] })
    assert.equal(getNotifyTransport().kind, 'memory')
  })

  it('uses grpc transport when coordinator URL is set and mock is off', () => {
    process.env.MTDD_NOTIFY_URL = '10.0.0.9:50051'
    initNotifyTransport({ hosts: ['10.0.0.1'] })
    assert.equal(getNotifyTransport().kind, 'grpc')
    assert.equal(getNotifyTransport().serverAddress, '10.0.0.9:50051')
    getNotifyTransport().close()
  })

  it('defaults grpc address to first host for single-shard', () => {
    process.env.MTDD_GRPC_PORT = '50077'
    initNotifyTransport({ hosts: ['10.0.1.20'] })
    assert.equal(getNotifyTransport().kind, 'grpc')
    assert.equal(getNotifyTransport().serverAddress, '10.0.1.20:50077')
    getNotifyTransport().close()
  })

  it('throws for multi-shard without MTDD_NOTIFY_URL when not mocking', () => {
    assert.throws(
      () => initNotifyTransport({ hosts: ['10.0.1.20', '10.0.1.21'] }),
      /multi-shard DB_HOST requires MTDD_NOTIFY_URL/,
    )
  })
})
