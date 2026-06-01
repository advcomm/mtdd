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
const { fanOutOnly } = require('../query-executor')
const { defaultMergeResults } = require('../merge-results')

describe('custom onQuery merge', () => {
  let restoreEnv
  let lookup

  beforeEach(async () => {
    restoreEnv = withTestEnv()
    setupGrpcMock()
    lookup = await createMockLookupServer(() => ({ hostIndex: 0 }))
    process.env.MTDD_LOOKUP_URL = lookup.url
    hooks.onQuery = async (req, next) => next()
  })

  afterEach(async () => {
    await lookup.close()
    restoreEnv()
  })

  it('allows onQuery to fan out and apply custom merge logic', async () => {
    const { pg } = createMockPg()
    install(pg)

    const pool = new pg.Pool({
      host: ['10.0.1.10', '10.0.1.11'],
    })

    hooks.onQuery = async (req, next) => {
      if (req.tid) {
        return next()
      }

      const shardResults = await fanOutOnly(pool, req)
      return {
        command: 'SELECT',
        rowCount: shardResults.length,
        oid: null,
        fields: [],
        rows: shardResults.map((result, index) => ({
          shard: index,
          count: result.rows.length,
        })),
      }
    }

    const result = await pool.query('SELECT * FROM metrics')

    assert.deepEqual(result.rows, [
      { shard: 0, count: 1 },
      { shard: 1, count: 1 },
    ])
    assert.equal(result.rowCount, 2)
  })

  it('exports defaultMergeResults for hook authors', () => {
    const merged = defaultMergeResults([
      { command: 'SELECT', rowCount: 1, oid: null, fields: [], rows: [{ a: 1 }] },
      { command: 'SELECT', rowCount: 2, oid: null, fields: [], rows: [{ a: 2 }, { a: 3 }] },
    ])

    assert.equal(merged.rows.length, 3)
    assert.equal(merged.rowCount, 3)
  })
})
