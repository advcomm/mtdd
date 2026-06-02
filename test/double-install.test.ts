const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const {
  createMockPg,
  createMockLookupServer,
  withTestEnv,
  setupGrpcMock,
} = require('./helpers')
const { install, PATCHED } = require('../src/patch')

describe('double patch protection', () => {
  let restoreEnv
  let lookup

  beforeEach(async () => {
    restoreEnv = withTestEnv({ DB_HOST: '["127.0.0.1"]' })
    setupGrpcMock()
    lookup = await createMockLookupServer(() => ({ hostIndex: 0 }))
    process.env.MTDD_LOOKUP_URL = lookup.url
  })

  afterEach(async () => {
    await lookup.close()
    restoreEnv()
  })

  it('install is idempotent and does not re-wrap constructors', () => {
    const { pg } = createMockPg()
    const first = install(pg)
    const PoolAfterFirst = pg.Pool

    const second = install(pg)

    assert.equal(first, second)
    assert.equal(pg[PATCHED], true)
    assert.equal(pg.Pool, PoolAfterFirst)
  })
})
