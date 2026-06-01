const { describe, it, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const { createMockPg } = require('./helpers')
const { install, PATCHED } = require('../patch')
const { resetHostCounter } = require('../host-selector')

describe('double patch protection', () => {
  beforeEach(() => {
    resetHostCounter()
    process.env.DB_HOST = '["127.0.0.1"]'
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
