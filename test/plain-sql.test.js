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

describe('plain SQL only', () => {
  let restoreEnv
  let lookup

  beforeEach(async () => {
    restoreEnv = withTestEnv({ DB_HOST: '["127.0.0.1"]' })
    setupGrpcMock()
    lookup = await createMockLookupServer(() => ({ hostIndex: 0 }))
    process.env.MTDD_LOOKUP_URL = lookup.url
    hooks.onQuery = async (req, next) => next()
  })

  afterEach(async () => {
    await lookup.close()
    restoreEnv()
  })

  it('rejects name-only prepared statement queries', async () => {
    const { pg } = createMockPg()
    install(pg)

    const pool = new pg.Pool({ host: '127.0.0.1' })
    await assert.rejects(
      () =>
        pool.query({
          name: 'find_user',
          values: [],
        }),
      /plain SQL/i,
    )
  })

  it('rejects query config with name even when text is present', async () => {
    const { pg } = createMockPg()
    install(pg)

    const pool = new pg.Pool({ host: '127.0.0.1' })
    await assert.rejects(
      () =>
        pool.query({
          name: 'q1',
          text: 'SELECT 1',
        }),
      /query config "name" is not supported/i,
    )
  })
})
