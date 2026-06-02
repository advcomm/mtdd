const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const {
  parseNotifyGrpcAddress,
  resolveNotifyGrpcAddress,
} = require('../notify-policy')

describe('notify-policy', () => {
  it('parses host:port and grpc:// URLs', () => {
    assert.equal(parseNotifyGrpcAddress('10.0.0.1:50051'), '10.0.0.1:50051')
    assert.equal(
      parseNotifyGrpcAddress('grpc://10.0.0.2:50052'),
      '10.0.0.2:50052',
    )
  })

  it('defaults to first DB_HOST write host and MTDD_GRPC_PORT', () => {
    const prevUrl = process.env.MTDD_NOTIFY_URL
    const prevPort = process.env.MTDD_GRPC_PORT
    delete process.env.MTDD_NOTIFY_URL
    process.env.MTDD_GRPC_PORT = '50099'

    try {
      assert.equal(
        resolveNotifyGrpcAddress(['10.0.1.10', '10.0.1.11']),
        '10.0.1.10:50099',
      )
      assert.equal(
        resolveNotifyGrpcAddress([{ write: '10.0.2.1', read: [] }]),
        '10.0.2.1:50099',
      )
    } finally {
      if (prevUrl === undefined) {
        delete process.env.MTDD_NOTIFY_URL
      } else {
        process.env.MTDD_NOTIFY_URL = prevUrl
      }
      if (prevPort === undefined) {
        delete process.env.MTDD_GRPC_PORT
      } else {
        process.env.MTDD_GRPC_PORT = prevPort
      }
    }
  })
})
