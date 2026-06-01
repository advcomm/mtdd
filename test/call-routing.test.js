const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { classifyQuery } = require('../query-classifier')
const { mergeFanOutResults, discardedCallResult } = require('../merge-results')
const {
  createMockPg,
  createMockLookupServer,
  withTestEnv,
  setupGrpcMock,
} = require('./helpers')
const { install } = require('../patch')
const hooks = require('../hooks')

describe('query classifier CALL', () => {
  it('classifies CALL statements', () => {
    assert.deepEqual(classifyQuery('CALL create_invoice($1, $2)'), {
      commandType: 'CALL',
      hasReturning: false,
    })

    assert.deepEqual(
      classifyQuery(
        'WITH params AS (SELECT $1::int AS id) CALL refresh_summary($1)',
      ),
      {
        commandType: 'CALL',
        hasReturning: false,
      },
    )
  })

  it('does not classify function SELECT as CALL', () => {
    assert.deepEqual(
      classifyQuery('SELECT * FROM calculate_commission($1, $2)'),
      {
        commandType: 'FUNCTION',
        hasReturning: false,
      },
    )
  })
})

describe('discardedCallResult', () => {
  it('returns an empty CALL-shaped result', () => {
    assert.deepEqual(discardedCallResult(), {
      command: 'CALL',
      rowCount: 0,
      oid: null,
      fields: [],
      rows: [],
    })
  })
})

describe('mergeFanOutResults CALL guard', () => {
  it('refuses to merge CALL shard results', () => {
    assert.throws(
      () =>
        mergeFanOutResults(
          { text: 'CALL run_job()' },
          [{ command: 'CALL', rowCount: 1, oid: null, fields: [], rows: [] }],
        ),
      /CALL results must not be merged/,
    )
  })
})

describe('CALL routing integration', () => {
  let restoreEnv
  let lookup
  let grpcState

  beforeEach(async () => {
    restoreEnv = withTestEnv({
      DB_HOST: '["10.0.1.10","10.0.1.11"]',
    })
    grpcState = setupGrpcMock()
    grpcState.callReturningRows = [
      [{ proc: 'a', host: 0 }],
      [{ proc: 'b', host: 1 }],
    ]
    lookup = await createMockLookupServer((body) => ({
      hostIndex: body.tid === 'tenant-b' ? 1 : 0,
    }))
    process.env.MTDD_LOOKUP_URL = lookup.url
    hooks.onQuery = async (req, next) => next()
  })

  afterEach(async () => {
    await lookup.close()
    restoreEnv()
  })

  it('rejects CALL without tid on a multi-host pool', async () => {
    const { pg } = createMockPg()
    install(pg)

    const pool = new pg.Pool({
      host: ['10.0.1.10', '10.0.1.11'],
    })

    await assert.rejects(
      () => pool.query('CALL create_invoice($1, $2)', [1, 99.5]),
      /CALL requires a tenant tid/,
    )
    assert.equal(grpcState.queries.length, 0)
  })

  it('routes CALL with tid to one shard and returns the shard result', async () => {
    const { pg } = createMockPg()
    install(pg)

    const pool = new pg.Pool({
      host: ['10.0.1.10', '10.0.1.11'],
    })

    const result = await pool.query({
      text: 'CALL create_invoice($1, $2)',
      values: [1, 99.5],
      tid: 'tenant-b',
    })

    assert.equal(grpcState.queries.length, 1)
    assert.equal(grpcState.queries[0].hostIndex, 1)
    assert.equal(result.command, 'CALL')
    assert.deepEqual(result.rows, [{ proc: 'b', host: 1 }])
  })

  it('runs CALL on every shard and discards results when tid is null', async () => {
    const { pg } = createMockPg()
    install(pg)

    const pool = new pg.Pool({
      host: ['10.0.1.10', '10.0.1.11'],
    })

    const result = await pool.query({
      text: 'CALL purge_stale_cache()',
      tid: null,
    })

    assert.equal(grpcState.queries.length, 2)
    assert.deepEqual(
      grpcState.queries.map((q) => q.hostIndex).sort(),
      [0, 1],
    )
    assert.deepEqual(result, discardedCallResult())
  })

  it('rejects CALL when tid is omitted', async () => {
    const { pg } = createMockPg()
    install(pg)

    const pool = new pg.Pool({
      host: ['10.0.1.10', '10.0.1.11'],
    })

    await assert.rejects(
      () => pool.query({ text: 'CALL purge_stale_cache()' }),
      /CALL requires a tenant tid/,
    )
  })
})
