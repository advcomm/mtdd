const { describe, it, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const { createMockPg } = require('./helpers')
const { install } = require('../patch')
const { resetHostCounter } = require('../host-selector')

describe('query passthrough', () => {
  beforeEach(() => {
    resetHostCounter()
    process.env.DB_HOST = '["127.0.0.1"]'
  })

  it('passes text queries through to pg', async () => {
    const { pg, state } = createMockPg()
    install(pg)

    const pool = new pg.Pool({ host: '127.0.0.1' })
    const result = await pool.query('SELECT 1')

    assert.equal(state.queries.length, 1)
    assert.equal(state.queries[0].args[0], 'SELECT 1')
    assert.equal(result.command, 'SELECT')
  })

  it('passes text and values through to pg', async () => {
    const { pg, state } = createMockPg()
    install(pg)

    const pool = new pg.Pool({ host: '127.0.0.1' })
    await pool.query('SELECT $1', [42])

    assert.deepEqual(state.queries[0].args, ['SELECT $1', [42]])
  })

  it('passes query config objects through without tid', async () => {
    const { pg, state } = createMockPg()
    install(pg)

    const pool = new pg.Pool({ host: '127.0.0.1' })
    await pool.query({ text: 'SELECT $1', values: [1], name: 'q1' })

    assert.deepEqual(state.queries[0].args[0], {
      text: 'SELECT $1',
      values: [1],
      name: 'q1',
    })
  })
})
