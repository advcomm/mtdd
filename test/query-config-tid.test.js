const { describe, it, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const { createMockPg } = require('./helpers')
const { install } = require('../patch')
const { resetHostCounter } = require('../host-selector')
const hooks = require('../hooks')

describe('query config tid', () => {
  beforeEach(() => {
    resetHostCounter()
    process.env.DB_HOST = '["127.0.0.1"]'
    hooks.onQuery = async (req, next) => next()
  })

  it('exposes tid from query config to onQuery and strips it from pg args', async () => {
    const { pg, state } = createMockPg()
    install(pg)

    let captured
    hooks.onQuery = async (req, next) => {
      captured = req
      return next()
    }

    const pool = new pg.Pool({ host: '127.0.0.1' })
    await pool.query({
      text: 'SELECT * FROM users',
      values: [],
      tid: 'tenant-abc',
    })

    assert.equal(captured.tid, 'tenant-abc')
    assert.equal(captured.source, 'pool.query')
    assert.equal('tid' in state.queries[0].args[0], false)
    assert.equal(state.queries[0].args[0].text, 'SELECT * FROM users')
  })
})
