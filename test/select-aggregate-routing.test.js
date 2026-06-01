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

describe('SELECT aggregate fan-out routing', () => {
  let restoreEnv
  let lookup
  let grpcState
  let localQueries

  beforeEach(async () => {
    restoreEnv = withTestEnv({
      DB_HOST: '["10.0.1.10","10.0.1.11"]',
    })
    grpcState = setupGrpcMock()
    grpcState.selectFields = [{ name: 'amount', dataTypeID: 1700 }]
    grpcState.selectRowsByShard = [
      [{ amount: 10 }, { amount: 20 }],
      [{ amount: 5 }],
    ]

    lookup = await createMockLookupServer(() => ({ hostIndex: 0 }))
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

        if (/SUM\s*\(\s*amount\s*\)/i.test(sql)) {
          return {
            command: 'SELECT',
            rowCount: 1,
            oid: null,
            fields: [{ name: 'sum', dataTypeID: 1700 }],
            rows: [{ sum: 35 }],
          }
        }

        return {
          command: 'SELECT',
          rowCount: 0,
          oid: null,
          fields: [],
          rows: [],
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

  it('fans out row-level SQL without SUM then aggregates on localhost', async () => {
    const { pg } = createMockPg()
    install(pg)

    const pool = new pg.Pool({
      host: ['10.0.1.10', '10.0.1.11'],
    })

    const result = await pool.query('SELECT SUM(amount) FROM orders')

    assert.equal(grpcState.queries.length, 2)
    for (const q of grpcState.queries) {
      assert.doesNotMatch(q.text, /\bSUM\b/i)
      assert.match(q.text, /amount/i)
    }

    const aggregateQuery = localQueries.find((q) =>
      /SUM\s*\(\s*amount\s*\)/i.test(q.sql),
    )
    assert.ok(aggregateQuery, 'expected localhost aggregate re-query')
    assert.match(aggregateQuery.sql, /orders_mtdd_/i)

    assert.equal(result.rows[0].sum, 35)
  })

  it('fans out grouped aggregate inputs and re-queries with GROUP BY on localhost', async () => {
    grpcState.selectFields = [
      { name: 'region', dataTypeID: 25 },
      { name: 'amount', dataTypeID: 1700 },
    ]
    grpcState.selectRowsByShard = [
      [
        { region: 'east', amount: 10 },
        { region: 'west', amount: 5 },
      ],
      [{ region: 'east', amount: 7 }],
    ]

    localQueries.length = 0
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
        if (/GROUP BY region/i.test(sql) && /SUM\s*\(\s*amount\s*\)/i.test(sql)) {
          return {
            command: 'SELECT',
            rowCount: 2,
            oid: null,
            fields: [
              { name: 'region', dataTypeID: 25 },
              { name: 'sum', dataTypeID: 1700 },
            ],
            rows: [
              { region: 'east', sum: 17 },
              { region: 'west', sum: 5 },
            ],
          }
        }
        return { command: 'SELECT', rowCount: 0, rows: [], fields: [] }
      },
    }))

    const { pg } = createMockPg()
    install(pg)

    const pool = new pg.Pool({
      host: ['10.0.1.10', '10.0.1.11'],
    })

    const result = await pool.query(
      'SELECT region, SUM(amount) FROM orders GROUP BY region ORDER BY region',
    )

    assert.equal(grpcState.queries.length, 2)
    for (const q of grpcState.queries) {
      assert.doesNotMatch(q.text, /\bSUM\b/i)
      assert.doesNotMatch(q.text, /GROUP BY/i)
    }

    const localAgg = localQueries.find(
      (q) => /GROUP BY region/i.test(q.sql) && /SUM/i.test(q.sql),
    )
    assert.ok(localAgg)
    assert.equal(result.rows.length, 2)
    assert.equal(result.rows[0].region, 'east')
  })
})
