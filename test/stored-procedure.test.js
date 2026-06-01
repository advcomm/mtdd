const { describe, it, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const { createMockPg } = require('./helpers')
const { install } = require('../patch')
const { resetHostCounter } = require('../host-selector')

describe('stored procedures', () => {
  beforeEach(() => {
    resetHostCounter()
    process.env.DB_HOST = '["127.0.0.1"]'
  })

  it('passes CALL statements through unchanged', async () => {
    const { pg, state } = createMockPg()
    install(pg)

    const pool = new pg.Pool({ host: '127.0.0.1' })
    await pool.query('CALL create_invoice($1,$2)', [1, 99.5])

    assert.equal(state.queries[0].args[0], 'CALL create_invoice($1,$2)')
    assert.deepEqual(state.queries[0].args[1], [1, 99.5])
  })

  it('passes function SELECT statements through unchanged', async () => {
    const { pg, state } = createMockPg()
    install(pg)

    const pool = new pg.Pool({ host: '127.0.0.1' })
    await pool.query(
      'SELECT * FROM calculate_commission($1,$2)',
      ['order-1', 'PROMO'],
    )

    assert.match(state.queries[0].args[0], /calculate_commission/)
  })
})
