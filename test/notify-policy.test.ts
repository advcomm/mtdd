const { describe, it, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const {
  parseNotifyGrpcAddress,
  resolveNotifyGrpcAddress,
  validateNotifyCoordinatorConfig,
  validateNotifyChannel,
  validateNotifyPayload,
  DEFAULT_MAX_NOTIFY_CHANNEL_BYTES,
  DEFAULT_MAX_NOTIFY_PAYLOAD_BYTES,
} = require('../src/notify-policy')

describe('notify-policy', () => {
  afterEach(() => {
    delete process.env.MTDD_NOTIFY_URL
    delete process.env.MTDD_GRPC_MOCK
    delete process.env.MTDD_NOTIFY_MOCK
    delete process.env.MTDD_GRPC_PORT
    delete process.env.MTDD_MAX_NOTIFY_CHANNEL_BYTES
    delete process.env.MTDD_MAX_NOTIFY_PAYLOAD_BYTES
  })

  it('parses host:port and grpc:// URLs', () => {
    assert.equal(parseNotifyGrpcAddress('10.0.0.1:50051'), '10.0.0.1:50051')
    assert.equal(
      parseNotifyGrpcAddress('grpc://10.0.0.2:50052'),
      '10.0.0.2:50052',
    )
  })

  it('defaults resolveNotifyGrpcAddress to first DB_HOST write host and MTDD_GRPC_PORT', () => {
    process.env.MTDD_GRPC_PORT = '50099'
    assert.equal(
      resolveNotifyGrpcAddress(['10.0.1.10', '10.0.1.11']),
      '10.0.1.10:50099',
    )
    assert.equal(
      resolveNotifyGrpcAddress([{ write: '10.0.2.1', read: [] }]),
      '10.0.2.1:50099',
    )
  })

  it('requires MTDD_NOTIFY_URL for multi-shard when not mocking', () => {
    assert.throws(
      () => validateNotifyCoordinatorConfig(['10.0.1.10', '10.0.1.11']),
      /multi-shard DB_HOST requires MTDD_NOTIFY_URL/,
    )
  })

  it('allows multi-shard with explicit MTDD_NOTIFY_URL', () => {
    process.env.MTDD_NOTIFY_URL = '10.0.0.100:50051'
    assert.equal(
      validateNotifyCoordinatorConfig(['10.0.1.10', '10.0.1.11']),
      '10.0.0.100:50051',
    )
  })

  it('allows multi-shard without MTDD_NOTIFY_URL when mocking', () => {
    process.env.MTDD_GRPC_MOCK = '1'
    assert.equal(
      validateNotifyCoordinatorConfig(['10.0.1.10', '10.0.1.11']),
      '10.0.1.10:50051',
    )
  })

  it('validates channel and payload byte limits (server defaults)', () => {
    const longChannel = 'a'.repeat(DEFAULT_MAX_NOTIFY_CHANNEL_BYTES + 1)
    assert.throws(
      () => validateNotifyChannel(longChannel),
      /MTDD_MAX_NOTIFY_CHANNEL_BYTES/,
    )

    const longPayload = 'x'.repeat(DEFAULT_MAX_NOTIFY_PAYLOAD_BYTES + 1)
    assert.throws(
      () => validateNotifyPayload(longPayload),
      /MTDD_MAX_NOTIFY_PAYLOAD_BYTES/,
    )

    assert.equal(validateNotifyChannel('orders'), 'orders')
    assert.equal(validateNotifyPayload('hi'), 'hi')
  })
})
