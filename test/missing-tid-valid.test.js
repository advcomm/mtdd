const { describe, it, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const { createMockPg } = require('./helpers')
const { install } = require('../patch')
const { resetHostCounter } = require('../host-selector')
const hooks = require('../hooks')

describe('missing tid is valid', () => {
  beforeEach(() => {
    resetHostCounter()
    process.env.DB_HOST = '["127.0.0.1"]'
    hooks.onQuery = async (req, next) => next()
  })

  it('allows queries without tid and does not throw', async () => {
    const { pg } = createMockPg()
    install(pg)

    let captured
    hooks.onQuery = async (req, next) => {
      captured = req
      return next()
    }

    const pool = new pg.Pool({ host: '127.0.0.1' })
    const result = await pool.query('SELECT * FROM countries')

    assert.equal(captured.tid, undefined)
    assert.equal(result.command, 'SELECT')
  })
})
