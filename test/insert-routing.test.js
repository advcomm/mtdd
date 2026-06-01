const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { classifyQuery } = require('../query-classifier')
const { mergeFanOutResults } = require('../merge-results')
const {
  createMockPg,
  createMockLookupServer,
  withTestEnv,
  setupGrpcMock,
} = require('./helpers')
const { install } = require('../patch')
const hooks = require('../hooks')

describe('query classifier INSERT', () => {
  it('classifies INSERT with and without RETURNING', () => {
    assert.deepEqual(
      classifyQuery('INSERT INTO users (name) VALUES ($1)'),
      {
        commandType: 'INSERT',
        hasReturning: false,
      },
    )

    assert.deepEqual(
      classifyQuery(
        'INSERT INTO users (name) VALUES ($1) RETURNING id, name',
      ),
      {
        commandType: 'INSERT',
        hasReturning: true,
      },
    )

    assert.deepEqual(
      classifyQuery(
        'WITH data AS (SELECT $1::text AS name) INSERT INTO users (name) SELECT name FROM data RETURNING id',
      ),
      {
        commandType: 'INSERT',
        hasReturning: true,
      },
    )
  })
})

describe('mergeFanOutResults INSERT guard', () => {
  it('refuses to merge INSERT shard results', () => {
    assert.throws(
      () =>
        mergeFanOutResults(
          { text: 'INSERT INTO users (id) VALUES (1)' },
          [{ command: 'INSERT', rowCount: 1, oid: null, fields: [], rows: [] }],
        ),
      /INSERT results must not be merged/,
    )
  })
})

describe('INSERT routing integration', () => {
  let restoreEnv
  let lookup
  let grpcState

  beforeEach(async () => {
    restoreEnv = withTestEnv({
      DB_HOST: '["10.0.1.10","10.0.1.11"]',
    })
    grpcState = setupGrpcMock()
    grpcState.insertReturningRows = [
      [{ id: 10, name: 'shard0' }],
      [{ id: 20, name: 'shard1' }],
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

  it('rejects INSERT without tid on a multi-host pool', async () => {
    const { pg } = createMockPg()
    install(pg)

    const pool = new pg.Pool({
      host: ['10.0.1.10', '10.0.1.11'],
    })

    await assert.rejects(
      () => pool.query('INSERT INTO users (name) VALUES ($1)', ['alice']),
      /INSERT requires tid/,
    )
    assert.equal(grpcState.queries.length, 0)
  })

  it('routes INSERT with tid to exactly one shard and passes RETURNING through', async () => {
    const { pg } = createMockPg()
    install(pg)

    const pool = new pg.Pool({
      host: ['10.0.1.10', '10.0.1.11'],
    })

    const result = await pool.query(
      {
        text: 'INSERT INTO users (name) VALUES ($1) RETURNING id, name',
        values: ['bob'],
        tid: 'tenant-b',
      },
    )

    assert.equal(grpcState.queries.length, 1)
    assert.equal(grpcState.queries[0].hostIndex, 1)
    assert.equal(result.command, 'INSERT')
    assert.equal(result.rowCount, 1)
    assert.deepEqual(result.rows, [{ id: 20, name: 'shard1' }])
    assert.equal(result.fields.length, 2)
    assert.equal(result.fields[0].name, 'id')
  })

  it('returns INSERT without RETURNING as-is from the target shard', async () => {
    const { pg } = createMockPg()
    install(pg)

    const pool = new pg.Pool({
      host: ['10.0.1.10', '10.0.1.11'],
    })

    const result = await pool.query({
      text: 'INSERT INTO users (name) VALUES ($1)',
      values: ['carol'],
      tid: 'tenant-a',
    })

    assert.equal(grpcState.queries.length, 1)
    assert.equal(grpcState.queries[0].hostIndex, 0)
    assert.equal(result.command, 'INSERT')
    assert.equal(result.rowCount, 1)
    assert.deepEqual(result.rows, [])
    assert.deepEqual(result.fields, [])
  })
})
