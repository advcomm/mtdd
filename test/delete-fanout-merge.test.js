const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { classifyQuery } = require('../query-classifier')
const { mergeDeleteResults } = require('../merge-results')
const {
  createMockPg,
  createMockLookupServer,
  withTestEnv,
  setupGrpcMock,
} = require('./helpers')
const { install } = require('../patch')
const hooks = require('../hooks')

describe('query classifier', () => {
  it('classifies DELETE with and without RETURNING', () => {
    assert.deepEqual(classifyQuery('DELETE FROM users WHERE active = false'), {
      commandType: 'DELETE',
      hasReturning: false,
    })

    assert.deepEqual(
      classifyQuery('DELETE FROM users WHERE id = $1 RETURNING id, name'),
      {
        commandType: 'DELETE',
        hasReturning: true,
      },
    )

    assert.deepEqual(
      classifyQuery(
        'WITH inactive AS (SELECT id FROM users) DELETE FROM users u USING inactive i WHERE u.id = i.id RETURNING u.id',
      ),
      {
        commandType: 'DELETE',
        hasReturning: true,
      },
    )
  })

  it('returns UNKNOWN for non-DELETE statements', () => {
    assert.deepEqual(classifyQuery('SELECT * FROM users'), {
      commandType: 'UNKNOWN',
      hasReturning: false,
    })
  })
})

describe('mergeDeleteResults', () => {
  it('sums rowCount and clears rows when RETURNING is absent', () => {
    const merged = mergeDeleteResults(
      [
        {
          command: 'DELETE',
          rowCount: 3,
          oid: null,
          fields: [],
          rows: [{ id: 'stray' }],
        },
        { command: 'DELETE', rowCount: 2, oid: null, fields: [], rows: [] },
      ],
      { hasReturning: false },
    )

    assert.equal(merged.command, 'DELETE')
    assert.equal(merged.rowCount, 5)
    assert.deepEqual(merged.rows, [])
    assert.deepEqual(merged.fields, [])
  })

  it('concatenates RETURNING rows in shard order', () => {
    const merged = mergeDeleteResults(
      [
        {
          command: 'DELETE',
          rowCount: 3,
          oid: null,
          fields: [{ name: 'id' }],
          rows: [{ id: 1 }, { id: 2 }],
        },
        {
          command: 'DELETE',
          rowCount: 2,
          oid: null,
          fields: [{ name: 'id' }],
          rows: [{ id: 3 }],
        },
      ],
      { hasReturning: true },
    )

    assert.equal(merged.command, 'DELETE')
    assert.equal(merged.rowCount, 5)
    assert.deepEqual(merged.rows, [{ id: 1 }, { id: 2 }, { id: 3 }])
    assert.equal(merged.fields.length, 1)
  })
})

describe('DELETE fan-out integration', () => {
  let restoreEnv
  let lookup
  let grpcState

  beforeEach(async () => {
    restoreEnv = withTestEnv({
      DB_HOST: '["10.0.1.10","10.0.1.11"]',
    })
    grpcState = setupGrpcMock()
    grpcState.deleteRowCounts = [3, 2]
    grpcState.deleteReturningRows = [[{ id: 1 }, { id: 2 }], [{ id: 3 }]]
    lookup = await createMockLookupServer(() => ({ hostIndex: 0 }))
    process.env.MTDD_LOOKUP_URL = lookup.url
    hooks.onQuery = async (req, next) => next()
  })

  afterEach(async () => {
    await lookup.close()
    restoreEnv()
  })

  it('fans out DELETE to every host and sums rowCount without RETURNING', async () => {
    const { pg } = createMockPg()
    install(pg)

    const pool = new pg.Pool({
      host: ['10.0.1.10', '10.0.1.11'],
    })

    const result = await pool.query(
      'DELETE FROM archive WHERE created_at < $1',
      ['2020-01-01'],
    )

    assert.equal(grpcState.queries.length, 2)
    assert.equal(result.command, 'DELETE')
    assert.equal(result.rowCount, 5)
    assert.deepEqual(result.rows, [])
    assert.deepEqual(result.fields, [])
  })

  it('fans out DELETE RETURNING and merges rows transparently', async () => {
    const { pg } = createMockPg()
    install(pg)

    const pool = new pg.Pool({
      host: ['10.0.1.10', '10.0.1.11'],
    })

    let captured
    hooks.onQuery = async (req, next) => {
      captured = req
      return next()
    }

    const result = await pool.query(
      'DELETE FROM users WHERE active = false RETURNING id',
    )

    assert.equal(captured.commandType, 'DELETE')
    assert.equal(captured.hasReturning, true)
    assert.equal(result.command, 'DELETE')
    assert.equal(result.rowCount, 5)
    assert.deepEqual(result.rows, [{ id: 1 }, { id: 2 }, { id: 3 }])
    assert.equal(result.fields.length, 1)
  })
})
