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

describe('lookup routing', () => {
  let restoreEnv
  let lookup
  let grpcState

  beforeEach(async () => {
    restoreEnv = withTestEnv({
      DB_HOST: '["10.0.1.10","10.0.1.11","10.0.1.12"]',
    })
    grpcState = setupGrpcMock()
    hooks.onQuery = async (req, next) => next()
    hooks.onLookup = async (req, next) => next()
  })

  afterEach(async () => {
    if (lookup) {
      await lookup.close()
    }
    restoreEnv()
  })

  it('routes queries with tid to the host index returned by lookup', async () => {
    lookup = await createMockLookupServer(() => ({ hostIndex: 1 }))
    process.env.MTDD_LOOKUP_URL = lookup.url

    const { pg } = createMockPg()
    install(pg)

    const pool = new pg.Pool({
      host: ['10.0.1.10', '10.0.1.11', '10.0.1.12'],
    })

    const result = await pool.query({
      text: 'SELECT 1',
      tid: 'tenant-z',
    })

    assert.equal(result.rows[0].host_index, 1)
    assert.equal(grpcState.queries.length, 1)
    assert.equal(grpcState.queries[0].host_index, 1)
    assert.equal(grpcState.queries[0].host, '10.0.1.11')
  })

  it('rejects lookup responses with out-of-range hostIndex', async () => {
    lookup = await createMockLookupServer(() => ({ hostIndex: 9 }))
    process.env.MTDD_LOOKUP_URL = lookup.url

    const { pg } = createMockPg()
    install(pg)

    const pool = new pg.Pool({
      host: ['10.0.1.10', '10.0.1.11'],
    })

    await assert.rejects(
      () => pool.query({ text: 'SELECT 1', tid: 'tenant-z' }),
      /out of range/i,
    )
  })

  it('rejects lookup server HTTP errors', async () => {
    lookup = await createMockLookupServer(() => {
      const err = new Error('not found') as LookupHttpError
      err.statusCode = 404
      throw err
    })
    process.env.MTDD_LOOKUP_URL = lookup.url

    const { pg } = createMockPg()
    install(pg)

    const pool = new pg.Pool({
      host: ['10.0.1.10', '10.0.1.11'],
    })

    await assert.rejects(
      () => pool.query({ text: 'SELECT 1', tid: 'tenant-z' }),
      /Lookup server returned 404/i,
    )
  })
})
