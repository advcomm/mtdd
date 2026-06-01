const { describe, it, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const { createMockPg } = require('./helpers')
const { install } = require('../patch')
const { resetHostCounter } = require('../host-selector')

describe('transactions', () => {
  beforeEach(() => {
    resetHostCounter()
    process.env.DB_HOST = '["127.0.0.1"]'
  })

  it('preserves BEGIN / COMMIT ordering on a pooled client', async () => {
    const { pg, state } = createMockPg()
    install(pg)

    const pool = new pg.Pool({ host: '127.0.0.1' })
    const client = await pool.connect()

    try {
      await client.query('BEGIN')
      await client.query('INSERT INTO items VALUES ($1)', [1])
      await client.query('COMMIT')
    } finally {
      client.release()
    }

    const clientQueries = state.queries
      .filter((q) => q.source === 'client')
      .map((q) => q.args[0])

    assert.deepEqual(clientQueries, [
      'BEGIN',
      'INSERT INTO items VALUES ($1)',
      'COMMIT',
    ])
  })

  it('preserves ROLLBACK on error', async () => {
    const { pg, state } = createMockPg()
    install(pg)

    const pool = new pg.Pool({ host: '127.0.0.1' })
    const client = await pool.connect()

    try {
      await client.query('BEGIN')
      throw new Error('simulated failure')
    } catch {
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }

    const clientQueries = state.queries
      .filter((q) => q.source === 'client')
      .map((q) => q.args[0])

    assert.deepEqual(clientQueries, ['BEGIN', 'ROLLBACK'])
  })
})
