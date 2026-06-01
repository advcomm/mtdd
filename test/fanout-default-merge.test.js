const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const {
  createMockPg,
  createMockLookupServer,
  withTestEnv,
} = require('./helpers')
const { install } = require('../patch')
const hooks = require('../hooks')

describe('fan-out default merge', () => {
  let restoreEnv
  let lookup

  beforeEach(async () => {
    restoreEnv = withTestEnv()
    lookup = await createMockLookupServer(() => ({ hostIndex: 0 }))
    process.env.MTDD_LOOKUP_URL = lookup.url
    hooks.onQuery = async (req, next) => next()
  })

  afterEach(async () => {
    await lookup.close()
    restoreEnv()
  })

  it('queries every host and merges rows when tid is absent', async () => {
    const { pg, state } = createMockPg()
    install(pg)

    const pool = new pg.Pool({
      host: ['10.0.1.10', '10.0.1.11'],
    })

    const result = await pool.query('SELECT * FROM countries')

    const poolQueries = state.queries.filter((q) => q.source === 'pool')
    assert.equal(poolQueries.length, 2)
    assert.deepEqual(
      poolQueries.map((q) => q.host).sort(),
      ['10.0.1.10', '10.0.1.11'],
    )
    assert.equal(result.rows.length, 2)
    assert.equal(result.rowCount, 2)
  })
})
