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
const {
  setLocalPostgresClientFactory,
  resetLocalPostgresClientFactory,
} = require('../postgres-local')

describe('SELECT ORDER BY fan-out routing', () => {
  let restoreEnv
  let lookup
  let grpcState
  let localQueries

  beforeEach(async () => {
    restoreEnv = withTestEnv({
      DB_HOST: '["10.0.1.10","10.0.1.11"]',
    })
    grpcState = setupGrpcMock()
    grpcState.selectFields = [
      { name: 'id', dataTypeID: 23 },
      { name: 'name', dataTypeID: 25 },
    ]
    grpcState.selectRowsByShard = [
      [
        { id: 1, name: 'zeta' },
        { id: 2, name: 'alpha' },
      ],
      [{ id: 3, name: 'beta' }],
    ]

    lookup = await createMockLookupServer((body) => ({
      hostIndex: body.tid === 'tenant-b' ? 1 : 0,
    }))
    process.env.MTDD_LOOKUP_URL = lookup.url
    hooks.onQuery = async (req, next) => next()

    localQueries = []
    setLocalPostgresClientFactory(async () => ({
      query: async (sql, values) => {
        localQueries.push({ sql, values: values ?? [] })

        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
          return { command: sql, rowCount: 0, rows: [], fields: [] }
        }

        if (sql.startsWith('CREATE TEMP TABLE')) {
          return { command: 'CREATE', rowCount: 0, rows: [], fields: [] }
        }

        if (sql.startsWith('INSERT INTO') || sql.includes('unnest')) {
          return { command: 'INSERT', rowCount: 3, rows: [], fields: [] }
        }

        if (sql.startsWith('CREATE INDEX')) {
          return { command: 'CREATE', rowCount: 0, rows: [], fields: [] }
        }

        return {
          command: 'SELECT',
          rowCount: 2,
          oid: null,
          fields: grpcState.selectFields,
          rows: [
            { id: 2, name: 'alpha' },
            { id: 3, name: 'beta' },
          ],
        }
      },
    }))
  })

  afterEach(async () => {
    resetLocalPostgresClientFactory()
    const { resetLocalPostgresPool } = require('../postgres-local')
    await resetLocalPostgresPool()
    await lookup.close()
    restoreEnv()
  })

  it('fans out without ORDER BY then re-queries localhost with ORDER BY', async () => {
    const { pg } = createMockPg()
    install(pg)

    const pool = new pg.Pool({
      host: ['10.0.1.10', '10.0.1.11'],
    })

    const sql =
      'SELECT id, name FROM users WHERE active = true ORDER BY name ASC LIMIT 10'
    const result = await pool.query(sql)

    assert.equal(grpcState.queries.length, 2)
    for (const q of grpcState.queries) {
      assert.doesNotMatch(q.text, /ORDER BY/i)
      assert.doesNotMatch(q.text, /LIMIT/i)
    }

    const finalQuery = localQueries.find((q) => /ORDER BY name ASC/i.test(q.sql))
    assert.ok(finalQuery, 'expected localhost reorder query')
    assert.match(finalQuery.sql, /LIMIT\s*\(?\s*10\s*\)?/i)
    assert.match(finalQuery.sql, /users_mtdd_/i)

    assert.equal(result.rows.length, 2)
    assert.equal(result.rows[0].name, 'alpha')
  })
})
