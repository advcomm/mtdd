const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { classifyQuery } = require('../query-classifier')
const { mergeUpdateResults } = require('../merge-results')
const {
  createMockPg,
  createMockLookupServer,
  withTestEnv,
  setupGrpcMock,
} = require('./helpers')
const { install } = require('../patch')
const hooks = require('../hooks')

describe('query classifier UPDATE', () => {
  it('classifies UPDATE with and without RETURNING', () => {
    assert.deepEqual(
      classifyQuery('UPDATE users SET active = false WHERE last_seen < $1'),
      {
        commandType: 'UPDATE',
        hasReturning: false,
      },
    )

    assert.deepEqual(
      classifyQuery(
        'UPDATE users SET active = false WHERE id = $1 RETURNING id, name',
      ),
      {
        commandType: 'UPDATE',
        hasReturning: true,
      },
    )

    assert.deepEqual(
      classifyQuery(
        'WITH stale AS (SELECT id FROM users) UPDATE users u SET active = false FROM stale s WHERE u.id = s.id RETURNING u.id',
      ),
      {
        commandType: 'UPDATE',
        hasReturning: true,
      },
    )
  })

  it('prefers DELETE when both DELETE and UPDATE patterns could match', () => {
    assert.deepEqual(classifyQuery('DELETE FROM users'), {
      commandType: 'DELETE',
      hasReturning: false,
    })
  })
})

describe('mergeUpdateResults', () => {
  it('sums rowCount and clears rows when RETURNING is absent', () => {
    const merged = mergeUpdateResults(
      [
        {
          command: 'UPDATE',
          rowCount: 4,
          oid: null,
          fields: [],
          rows: [{ id: 'stray' }],
        },
        { command: 'UPDATE', rowCount: 1, oid: null, fields: [], rows: [] },
      ],
      { hasReturning: false },
    )

    assert.equal(merged.command, 'UPDATE')
    assert.equal(merged.rowCount, 5)
    assert.deepEqual(merged.rows, [])
    assert.deepEqual(merged.fields, [])
  })

  it('concatenates RETURNING rows in shard order', () => {
    const merged = mergeUpdateResults(
      [
        {
          command: 'UPDATE',
          rowCount: 4,
          oid: null,
          fields: [{ name: 'id' }],
          rows: [{ id: 10 }, { id: 11 }],
        },
        {
          command: 'UPDATE',
          rowCount: 1,
          oid: null,
          fields: [{ name: 'id' }],
          rows: [{ id: 12 }],
        },
      ],
      { hasReturning: true },
    )

    assert.equal(merged.command, 'UPDATE')
    assert.equal(merged.rowCount, 5)
    assert.deepEqual(merged.rows, [{ id: 10 }, { id: 11 }, { id: 12 }])
    assert.equal(merged.fields.length, 1)
  })
})

describe('UPDATE fan-out integration', () => {
  let restoreEnv
  let lookup
  let grpcState

  beforeEach(async () => {
    restoreEnv = withTestEnv({
      DB_HOST: '["10.0.1.10","10.0.1.11"]',
    })
    grpcState = setupGrpcMock()
    grpcState.updateRowCounts = [4, 1]
    grpcState.updateReturningRows = [
      [{ id: 10 }, { id: 11 }],
      [{ id: 12 }],
    ]
    lookup = await createMockLookupServer(() => ({ hostIndex: 0 }))
    process.env.MTDD_LOOKUP_URL = lookup.url
    hooks.onQuery = async (req, next) => next()
  })

  afterEach(async () => {
    await lookup.close()
    restoreEnv()
  })

  it('fans out UPDATE to every host and sums rowCount without RETURNING', async () => {
    const { pg } = createMockPg()
    install(pg)

    const pool = new pg.Pool({
      host: ['10.0.1.10', '10.0.1.11'],
    })

    const result = await pool.query(
      'UPDATE archive SET status = $1 WHERE created_at < $2',
      ['archived', '2020-01-01'],
    )

    assert.equal(grpcState.queries.length, 2)
    assert.equal(result.command, 'UPDATE')
    assert.equal(result.rowCount, 5)
    assert.deepEqual(result.rows, [])
    assert.deepEqual(result.fields, [])
  })

  it('fans out UPDATE RETURNING and merges rows transparently', async () => {
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
      'UPDATE users SET active = false WHERE region = $1 RETURNING id',
      ['eu'],
    )

    assert.equal(captured.commandType, 'UPDATE')
    assert.equal(captured.hasReturning, true)
    assert.equal(result.command, 'UPDATE')
    assert.equal(result.rowCount, 5)
    assert.deepEqual(result.rows, [{ id: 10 }, { id: 11 }, { id: 12 }])
    assert.equal(result.fields.length, 1)
  })
})
