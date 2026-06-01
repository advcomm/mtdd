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
const { decodeQueryParamsForTest } = require('../grpc-arrow-codec')

describe('stored procedures', () => {
  let restoreEnv
  let lookup
  let grpcState

  beforeEach(async () => {
    restoreEnv = withTestEnv({ DB_HOST: '["127.0.0.1","127.0.0.2"]' })
    grpcState = setupGrpcMock()
    lookup = await createMockLookupServer(() => ({ hostIndex: 0 }))
    process.env.MTDD_LOOKUP_URL = lookup.url
    hooks.onQuery = async (req, next) => next()
  })

  afterEach(async () => {
    await lookup.close()
    restoreEnv()
  })

  it('passes CALL statements through unchanged', async () => {
    const { pg } = createMockPg()
    install(pg)

    const pool = new pg.Pool({ host: ['127.0.0.1', '127.0.0.2'] })
    await pool.query({
      text: 'CALL create_invoice($1,$2)',
      values: [1, 99.5],
      tid: 'tenant-1',
    })

    assert.equal(grpcState.queries.length, 1)
    assert.equal(grpcState.queries[0].text, 'CALL create_invoice($1,$2)')
    assert.deepEqual(decodeQueryParamsForTest(grpcState.queries[0].params), [
      1, 99.5,
    ])
  })

  it('passes function SELECT statements through unchanged to one shard', async () => {
    const { pg } = createMockPg()
    install(pg)

    const pool = new pg.Pool({ host: ['127.0.0.1', '127.0.0.2'] })
    const result = await pool.query({
      text: 'SELECT * FROM calculate_commission($1,$2)',
      values: ['order-1', 'PROMO'],
      tid: 'tenant-1',
    })

    assert.equal(grpcState.queries.length, 1)
    assert.match(grpcState.queries[0].text, /calculate_commission/)
    assert.equal(result.command, 'SELECT')
  })
})
