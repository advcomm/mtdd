const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const {
  createMockPg,
  withTestEnv,
  setupGrpcMock,
} = require('./helpers')
const { install } = require('../patch')

describe('gRPC startup connections', () => {
  let restoreEnv

  beforeEach(() => {
    restoreEnv = withTestEnv({
      DB_HOST: '["10.0.1.10","10.0.1.11"]',
    })
  })

  afterEach(() => {
    restoreEnv()
  })

  it('connects to every host in DB_HOST with host_index and credentials', () => {
    const grpcState = setupGrpcMock()
    const { pg } = createMockPg()
    install(pg)

    assert.equal(grpcState.connections.length, 2)
    assert.deepEqual(
      grpcState.connections.map((c) => ({
        host: c.host,
        host_index: c.hostIndex,
        database: c.credentials.database,
      })),
      [
        { host: '10.0.1.10', host_index: 0, database: 'testdb' },
        { host: '10.0.1.11', host_index: 1, database: 'testdb' },
      ],
    )
  })

  it('fails startup when any shard Connect fails', async () => {
    const { validateEnvDbHost } = require('../host-policy')
    const { getGrpcCredentialsFromEnv } = require('../grpc-credentials')
    const { initGrpcHub, resetGrpcHub, useMockTransport } = require('../grpc-hub')

    resetGrpcHub()
    process.env.MTDD_GRPC_MOCK = '1'
    useMockTransport({
      async connectAll(hosts) {
        for (let hostIndex = 0; hostIndex < hosts.length; hostIndex++) {
          if (hostIndex === 1) {
            throw new Error('connection refused')
          }
        }
        return []
      },
      async query() {
        return { command: 'SELECT', rowCount: 0, oid: null, fields: [], rows: [] }
      },
      async disconnectAll() {},
    })

    await assert.rejects(
      () => initGrpcHub(validateEnvDbHost(), getGrpcCredentialsFromEnv()),
      /connection refused/i,
    )
  })
})
