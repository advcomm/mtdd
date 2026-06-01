const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const {
  rewriteQueryTableName,
  insertRowsViaUnnest,
  insertRowsViaCopy,
  collectMergedRows,
} = require('../postgres-select-merge')
const { rewriteQueryTableNameAst } = require('../select-order-rewrite')
const {
  resetLocalPostgresClientFactory,
  setLocalPostgresClientFactory,
} = require('../postgres-local')

describe('select-order AST rewrite', () => {
  it('rewrites the primary FROM table and preserves alias', () => {
    const sql = 'SELECT id FROM users u WHERE active = true ORDER BY id DESC LIMIT 5'
    const rewritten = rewriteQueryTableNameAst(sql, 'users', 'users_mtdd_abcd')
    assert.match(rewritten, /FROM users_mtdd_abcd/i)
    assert.match(rewritten, /\bu\b/i)
    assert.doesNotMatch(rewritten, /\bFROM users\b/i)
    assert.equal(rewriteQueryTableName(sql, 'users', 'users_mtdd_abcd'), rewritten)
  })
})

describe('localhost load strategies', () => {
  let queries

  beforeEach(() => {
    queries = []
    setLocalPostgresClientFactory(async () => ({
      query: async (sql, values) => {
        queries.push({ sql, values })
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
          return { command: sql, rowCount: 0, rows: [], fields: [] }
        }
        if (sql.startsWith('CREATE TEMP TABLE')) {
          return { command: 'CREATE', rowCount: 0, rows: [], fields: [] }
        }
        if (sql.startsWith('CREATE INDEX')) {
          return { command: 'CREATE', rowCount: 0, rows: [], fields: [] }
        }
        if (sql.startsWith('INSERT INTO') || sql.includes('unnest')) {
          return { command: 'INSERT', rowCount: 0, rows: [], fields: [] }
        }
        if (sql.startsWith('SELECT')) {
          return {
            command: 'SELECT',
            rowCount: 1,
            fields: [{ name: 'id', dataTypeID: 23 }],
            rows: [{ id: 1 }],
          }
        }
        return { command: 'UNKNOWN', rowCount: 0, rows: [], fields: [] }
      },
    }))
  })

  afterEach(() => {
    resetLocalPostgresClientFactory()
    delete process.env.MTDD_LOCAL_MERGE_UNNEST_THRESHOLD
    delete process.env.MTDD_LOCAL_MERGE_COPY_THRESHOLD
    delete process.env.MTDD_LOCAL_MERGE_INDEX_THRESHOLD
  })

  it('uses unnest insert for medium row counts', async () => {
    process.env.MTDD_LOCAL_MERGE_UNNEST_THRESHOLD = '2'
    process.env.MTDD_LOCAL_MERGE_COPY_THRESHOLD = '100'

    const { mergeSelectResultsOnLocalPostgres } = require('../postgres-select-merge')
    const fields = [{ name: 'id', dataTypeID: 23 }]
    const rows = [{ id: 1 }, { id: 2 }, { id: 3 }]

    await mergeSelectResultsOnLocalPostgres({
      credentials: {
        port: 5432,
        database: 'testdb',
        user: 'u',
        password: 'p',
      },
      tempTableName: 'users',
      fullText: 'SELECT id FROM users ORDER BY id',
      shardResults: [{ fields, rows }],
      orderBy: [{ by: { type: 'ref', name: 'id' } }],
    })

    const insert = queries.find((q) => q.sql.includes('unnest'))
    assert.ok(insert, 'expected unnest insert')
    assert.equal(insert.values.length, 1)
    assert.ok(queries.some((q) => q.sql.startsWith('CREATE TEMP TABLE')))
    assert.ok(queries.some((q) => q.sql.startsWith('SELECT')))
  })

  it('creates an index on ORDER BY columns for large merges', async () => {
    process.env.MTDD_LOCAL_MERGE_UNNEST_THRESHOLD = '10000'
    process.env.MTDD_LOCAL_MERGE_COPY_THRESHOLD = '10000'
    process.env.MTDD_LOCAL_MERGE_INDEX_THRESHOLD = '2'

    const { mergeSelectResultsOnLocalPostgres } = require('../postgres-select-merge')
    const fields = [
      { name: 'id', dataTypeID: 23 },
      { name: 'name', dataTypeID: 25 },
    ]
    const rows = [
      { id: 1, name: 'a' },
      { id: 2, name: 'b' },
      { id: 3, name: 'c' },
    ]

    await mergeSelectResultsOnLocalPostgres({
      credentials: {
        port: 5432,
        database: 'testdb',
        user: 'u',
        password: 'p',
      },
      tempTableName: 'users',
      fullText: 'SELECT id, name FROM users ORDER BY name',
      shardResults: [{ fields, rows }],
      orderBy: [{ by: { type: 'ref', name: 'name' } }],
    })

    const indexQuery = queries.find((q) => q.sql.startsWith('CREATE INDEX'))
    assert.ok(indexQuery)
    assert.match(indexQuery.sql, /"name"/)
  })
})

describe('copy and unnest helpers', () => {
  it('collectMergedRows concatenates shard rows', () => {
    const rows = collectMergedRows([
      { rows: [{ id: 1 }] },
      { rows: [{ id: 2 }, { id: 3 }] },
    ])
    assert.equal(rows.length, 3)
  })

  it('insertRowsViaUnnest builds parallel unnest parameters', async () => {
    const queries = []
    const client = {
      query: async (sql, values) => {
        queries.push({ sql, values })
      },
    }
    const fields = [
      { name: 'id', dataTypeID: 23 },
      { name: 'name', dataTypeID: 25 },
    ]
    await insertRowsViaUnnest(client, 'users_mtdd_test', fields, [
      { id: 1, name: 'a' },
      { id: 2, name: 'b' },
    ])
    assert.equal(queries.length, 1)
    assert.match(queries[0].sql, /unnest\(\$1::integer\[\]\)/)
    assert.match(queries[0].sql, /unnest\(\$2::text\[\]\)/)
    assert.deepEqual(queries[0].values[0], [1, 2])
  })

  it('insertRowsViaCopy streams CSV into COPY FROM STDIN', async () => {
    const { PassThrough } = require('node:stream')
    const chunks = []
    const fakeStream = new PassThrough()
    fakeStream.on('data', (chunk) => chunks.push(chunk.toString()))

    const client = {
      query() {
        return fakeStream
      },
    }

    await insertRowsViaCopy(
      client,
      'users_mtdd_test',
      [{ name: 'id', dataTypeID: 23 }],
      [{ id: 1 }, { id: 2 }],
    )

    assert.match(chunks.join(''), /^1\n2\n/)
  })
})
