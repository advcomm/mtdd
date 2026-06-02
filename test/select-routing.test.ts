const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { classifyQuery } = require('../src/query-classifier')
const {
  createMockPg,
  createMockLookupServer,
  withTestEnv,
  setupGrpcMock,
} = require('./helpers')
const { install } = require('../src/patch')
const hooks = require('../src/hooks')

describe('query classifier SELECT', () => {
  it('classifies table SELECT and distinguishes FUNCTION', () => {
    assert.deepEqual(classifyQuery('SELECT * FROM users WHERE id = $1'), {
      commandType: 'SELECT',
      hasReturning: false,
    })

    assert.deepEqual(classifyQuery('SELECT 1'), {
      commandType: 'SELECT',
      hasReturning: false,
    })

    assert.deepEqual(
      classifyQuery('SELECT * FROM calculate_commission($1)'),
      {
        commandType: 'FUNCTION',
        hasReturning: false,
      },
    )
  })
})

describe('SELECT routing integration', () => {
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

  it('routes SELECT with tid to one shard and returns rows as-is', async () => {
    const { pg } = createMockPg()
    install(pg)

    const pool = new pg.Pool({
      host: ['10.0.1.10', '10.0.1.11'],
    })

    const result = await pool.query({
      text: 'SELECT * FROM orders WHERE tenant_id = $1',
      values: ['tenant-b'],
      tid: 'tenant-b',
    })

    assert.equal(grpcState.queries.length, 1)
    assert.equal(grpcState.queries[0].hostIndex, 1)
    assert.equal(result.command, 'SELECT')
    assert.equal(result.rows[0].host, '10.0.1.11')
    assert.equal(result.rows[0].host_index, 1)
  })

  it('fans out SELECT without tid and merges rows', async () => {
    const { pg } = createMockPg()
    install(pg)

    const pool = new pg.Pool({
      host: ['10.0.1.10', '10.0.1.11'],
    })

    const result = await pool.query(
      'SELECT * FROM reference_codes WHERE active = true',
    )

    assert.equal(grpcState.queries.length, 2)
    assert.equal(result.command, 'SELECT')
    assert.equal(result.rowCount, 2)
    assert.equal(result.rows.length, 2)
  })
})
