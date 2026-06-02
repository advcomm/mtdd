const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')

const {
  resolveShardGrpcTarget,
  normalizeUnixGrpcTarget,
  isUnixGrpcTarget,
} = require('../grpc-target')

function saveEnv(key, value) {
  const prev = process.env[key]
  if (value === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = value
  }
  return prev
}

describe('grpc-target', () => {
  const saved = {}

  beforeEach(() => {
    saved.MTDD_GRPC_PORT = saveEnv('MTDD_GRPC_PORT', undefined)
    saved.MTDD_GRPC_UNIX_SOCKET = saveEnv('MTDD_GRPC_UNIX_SOCKET', undefined)
    saved.MTDD_GRPC_TLS = saveEnv('MTDD_GRPC_TLS', undefined)
    saved.MTDD_GRPC_TLS_CA_FILE = saveEnv('MTDD_GRPC_TLS_CA_FILE', undefined)
  })

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      saveEnv(key, value)
    }
  })

  it('uses host:port when unix socket env is unset', () => {
    process.env.MTDD_GRPC_PORT = '50052'
    assert.equal(resolveShardGrpcTarget('10.0.0.1'), '10.0.0.1:50052')
  })

  it('normalizes unix:/path to grpc-js unix:///path', () => {
    assert.equal(
      normalizeUnixGrpcTarget('unix:/run/mtdd/grpc.sock'),
      'unix:///run/mtdd/grpc.sock',
    )
  })

  it('uses unix socket when MTDD_GRPC_UNIX_SOCKET is set', () => {
    process.env.MTDD_GRPC_UNIX_SOCKET = '/run/mtdd/grpc.sock'
    const target = resolveShardGrpcTarget('ignored')
    assert.equal(target, 'unix:///run/mtdd/grpc.sock')
    assert.equal(isUnixGrpcTarget(target), true)
  })

  it('rejects unix socket combined with TLS env', () => {
    process.env.MTDD_GRPC_UNIX_SOCKET = '/run/mtdd/grpc.sock'
    process.env.MTDD_GRPC_TLS = '1'
    assert.throws(() => resolveShardGrpcTarget('10.0.0.1'), /plain gRPC/)
  })
})
