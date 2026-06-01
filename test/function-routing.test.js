const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { classifyQuery, isStoredFunctionSelect } = require('../query-classifier')
const { mergeFanOutResults } = require('../merge-results')
const {
  createMockPg,
  createMockLookupServer,
  withTestEnv,
  setupGrpcMock,
} = require('./helpers')
const { install } = require('../patch')
const hooks = require('../hooks')

describe('query classifier FUNCTION', () => {
  it('classifies table and scalar function SELECT forms', () => {
    assert.deepEqual(
      classifyQuery('SELECT * FROM calculate_commission($1, $2)'),
      {
        commandType: 'FUNCTION',
        hasReturning: false,
      },
    )

    assert.deepEqual(
      classifyQuery('SELECT app.calculate_commission($1, $2)'),
      {
        commandType: 'FUNCTION',
        hasReturning: false,
      },
    )

    assert.deepEqual(
      classifyQuery(
        'WITH params AS (SELECT $1::text AS code) SELECT * FROM lookup_rate($1) AS r(rate)',
      ),
      {
        commandType: 'FUNCTION',
        hasReturning: false,
      },
    )
  })

  it('does not classify table SELECT as FUNCTION', () => {
    assert.deepEqual(classifyQuery('SELECT * FROM users WHERE id = $1'), {
      commandType: 'SELECT',
      hasReturning: false,
    })

    assert.deepEqual(classifyQuery('SELECT id, name FROM orders'), {
      commandType: 'SELECT',
      hasReturning: false,
    })

    assert.equal(
      isStoredFunctionSelect('SELECT * FROM (SELECT 1 AS n) sub'),
      false,
    )
  })

  it('does not classify CALL as FUNCTION', () => {
    assert.deepEqual(classifyQuery('CALL refresh_cache()'), {
      commandType: 'CALL',
      hasReturning: false,
    })
  })
})

describe('mergeFanOutResults FUNCTION guard', () => {
  it('refuses to merge stored function shard results', () => {
    assert.throws(
      () =>
        mergeFanOutResults(
          { text: 'SELECT * FROM calculate_commission($1)' },
          [
            {
              command: 'SELECT',
              rowCount: 1,
              oid: null,
              fields: [],
              rows: [{ n: 1 }],
            },
          ],
        ),
      /stored function results must not be merged/,
    )
  })
})

describe('FUNCTION routing integration', () => {
  let restoreEnv
  let lookup
  let grpcState

  beforeEach(async () => {
    restoreEnv = withTestEnv({
      DB_HOST: '["10.0.1.10","10.0.1.11"]',
    })
    grpcState = setupGrpcMock()
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

  it('rejects stored function SELECT without tid on a multi-host pool', async () => {
    const { pg } = createMockPg()
    install(pg)

    const pool = new pg.Pool({
      host: ['10.0.1.10', '10.0.1.11'],
    })

    await assert.rejects(
      () =>
        pool.query('SELECT * FROM calculate_commission($1, $2)', [
          'order-1',
          'PROMO',
        ]),
      /stored function queries require a tenant tid/,
    )
    assert.equal(grpcState.queries.length, 0)
  })

  it('routes stored function with tid to one shard and returns rows as-is', async () => {
    const { pg } = createMockPg()
    install(pg)

    const pool = new pg.Pool({
      host: ['10.0.1.10', '10.0.1.11'],
    })

    const result = await pool.query({
      text: 'SELECT * FROM calculate_commission($1, $2)',
      values: ['order-1', 'PROMO'],
      tid: 'tenant-b',
    })

    assert.equal(grpcState.queries.length, 1)
    assert.equal(grpcState.queries[0].hostIndex, 1)
    assert.equal(result.command, 'SELECT')
    assert.equal(result.rows[0].host, '10.0.1.11')
  })

  it('does not fan out stored function when tid is omitted', async () => {
    const { pg } = createMockPg()
    install(pg)

    const pool = new pg.Pool({
      host: ['10.0.1.10', '10.0.1.11'],
    })

    await assert.rejects(
      () => pool.query('SELECT app.get_balance($1)', ['acct-1']),
      /stored function queries require a tenant tid/,
    )
    assert.equal(grpcState.queries.length, 0)
  })
})
