const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const {
  createMockPg,
  createMockLookupServer,
  withTestEnv,
  setupGrpcMock,
} = require('./helpers')
const { install } = require('../src/patch')
const { runWithMtddContext } = require('../src/context')
const hooks = require('../src/hooks')

describe('AsyncLocalStorage tid', () => {
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

  it('picks up tid from async context when query has no tid', async () => {
    const { pg } = createMockPg()
    install(pg)

    let captured
    hooks.onQuery = async (req, next) => {
      captured = req
      return next()
    }

    const pool = new pg.Pool({ host: '127.0.0.1' })

    await runWithMtddContext(
      { tid: 'ctx-tenant', userId: 'u1', requestId: 'r1' },
      async () => {
        await pool.query('SELECT * FROM users')
      },
    )

    assert.equal(captured.tid, 'ctx-tenant')
    assert.equal(captured.routing, 'single')
    assert.equal(captured.context.userId, 'u1')
    assert.equal(captured.context.requestId, 'r1')
  })

  it('query config tid overrides context tid', async () => {
    const { pg } = createMockPg()
    install(pg)

    let captured
    hooks.onQuery = async (req, next) => {
      captured = req
      return next()
    }

    const pool = new pg.Pool({ host: '127.0.0.1' })

    await runWithMtddContext({ tid: 'ctx-tenant' }, async () => {
      await pool.query({
        text: 'SELECT 1',
        tid: 'query-tenant',
      })
    })

    assert.equal(captured.tid, 'query-tenant')
  })
})
