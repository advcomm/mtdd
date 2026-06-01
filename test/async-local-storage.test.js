const { describe, it, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const { createMockPg } = require('./helpers')
const { install } = require('../patch')
const { resetHostCounter } = require('../host-selector')
const { runWithMtddContext } = require('../context')
const hooks = require('../hooks')

describe('AsyncLocalStorage tid', () => {
  beforeEach(() => {
    resetHostCounter()
    process.env.DB_HOST = '["127.0.0.1"]'
    hooks.onQuery = async (req, next) => next()
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
