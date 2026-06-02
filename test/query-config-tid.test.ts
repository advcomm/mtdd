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
const { decodeQueryParamsForTest } = require('../src/grpc-query-codec')

describe('query config tid', () => {
  let restoreEnv
  let lookup
  let grpcState

  beforeEach(async () => {
    restoreEnv = withTestEnv({ DB_HOST: '["127.0.0.1"]' })
    grpcState = setupGrpcMock()
    lookup = await createMockLookupServer(() => ({ hostIndex: 0 }))
    process.env.MTDD_LOOKUP_URL = lookup.url
    hooks.onQuery = async (req, next) => next()
  })

  afterEach(async () => {
    await lookup.close()
    restoreEnv()
  })

  it('exposes tid from query config to onQuery and sends query without tid over gRPC', async () => {
    const { pg } = createMockPg()
    install(pg)

    let captured
    hooks.onQuery = async (req, next) => {
      captured = req
      return next()
    }

    const pool = new pg.Pool({ host: '127.0.0.1' })
    await pool.query({
      text: 'SELECT * FROM users',
      values: [],
      tid: 'tenant-abc',
    })

    assert.equal(captured.tid, 'tenant-abc')
    assert.equal(captured.source, 'pool.query')
    assert.equal(captured.routing, 'single')
    assert.equal(grpcState.queries[0].text, 'SELECT * FROM users')
    assert.deepEqual(decodeQueryParamsForTest(grpcState.queries[0].params), [])
  })
})
