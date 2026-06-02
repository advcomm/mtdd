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

describe('query passthrough', () => {
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

  it('passes text queries through gRPC', async () => {
    const { pg } = createMockPg()
    install(pg)

    const pool = new pg.Pool({ host: '127.0.0.1' })
    const result = await pool.query('SELECT 1')

    assert.equal(grpcState.queries.length, 1)
    assert.equal(grpcState.queries[0].text, 'SELECT 1')
    assert.equal(result.command, 'SELECT')
  })

  it('passes text and values through gRPC', async () => {
    const { pg } = createMockPg()
    install(pg)

    const pool = new pg.Pool({ host: '127.0.0.1' })
    await pool.query('SELECT $1', [42])

    assert.equal(grpcState.queries[0].text, 'SELECT $1')
    assert.deepEqual(decodeQueryParamsForTest(grpcState.queries[0].params), [42])
  })

  it('passes query config objects through without tid', async () => {
    const { pg } = createMockPg()
    install(pg)

    const pool = new pg.Pool({ host: '127.0.0.1' })
    await pool.query({ text: 'SELECT $1', values: [1] })

    assert.equal(grpcState.queries[0].text, 'SELECT $1')
    assert.deepEqual(decodeQueryParamsForTest(grpcState.queries[0].params), [1])
    assert.equal(grpcState.queries[0].name, '')
  })
})
