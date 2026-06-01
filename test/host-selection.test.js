const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const {
  createMockPg,
  createMockLookupServer,
  withTestEnv,
} = require('./helpers')
const { install, PATCHED } = require('../patch')
const { isMtddFacade } = require('../pool-facade')

describe('host facade', () => {
  let restoreEnv
  let lookup

  beforeEach(async () => {
    restoreEnv = withTestEnv()
    lookup = await createMockLookupServer(() => ({ hostIndex: 0 }))
    process.env.MTDD_LOOKUP_URL = lookup.url
  })

  afterEach(async () => {
    await lookup.close()
    restoreEnv()
  })

  it('retains host array on facade without creating sub-pools at construction', () => {
    const { pg, state } = createMockPg()
    install(pg)

    const pool = new pg.Pool({
      host: ['10.0.1.10', '10.0.1.11'],
      port: 5432,
    })

    assert.equal(isMtddFacade(pool), true)
    assert.equal(state.pools.length, 0)
  })

  it('creates sub-pools lazily per host when queries run', async () => {
    const { pg, state } = createMockPg()
    install(pg)

    const pool = new pg.Pool({
      host: ['10.0.1.10', '10.0.1.11'],
    })

    await pool.query({ text: 'SELECT 1', tid: 'tenant-a' })

    assert.equal(state.pools.length, 1)
    assert.equal(state.pools[0].config.host, '10.0.1.10')
  })

  it('does not double-patch pg', () => {
    const { pg } = createMockPg()
    install(pg)
    install(pg)
    assert.equal(pg[PATCHED], true)
  })
})
