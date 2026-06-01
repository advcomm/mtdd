const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const {
  createMockPg,
  createMockLookupServer,
  withTestEnv,
} = require('./helpers')
const { install } = require('../patch')

describe('transactions', () => {
  let restoreEnv
  let lookup

  beforeEach(async () => {
    restoreEnv = withTestEnv()
    lookup = await createMockLookupServer(() => ({ hostIndex: 1 }))
    process.env.MTDD_LOOKUP_URL = lookup.url
  })

  afterEach(async () => {
    await lookup.close()
    restoreEnv()
  })

  it('preserves BEGIN / COMMIT ordering on a pinned shard client', async () => {
    const { pg, state } = createMockPg()
    install(pg)

    const pool = new pg.Pool({
      host: ['10.0.1.10', '10.0.1.11'],
    })
    const client = await pool.connect()

    try {
      await client.query({ text: 'BEGIN', tid: 'tenant-1' })
      await client.query({
        text: 'INSERT INTO items VALUES ($1)',
        values: [1],
        tid: 'tenant-1',
      })
      await client.query({ text: 'COMMIT', tid: 'tenant-1' })
    } finally {
      client.release()
    }

    const clientQueries = state.queries
      .filter((q) => q.source === 'client')
      .map((q) => ({ host: q.host, sql: q.args[0]?.text ?? q.args[0] }))

    assert.ok(clientQueries.every((q) => q.host === '10.0.1.11'))
    assert.deepEqual(
      clientQueries.map((q) => q.sql),
      ['BEGIN', 'INSERT INTO items VALUES ($1)', 'COMMIT'],
    )
  })

  it('preserves ROLLBACK on error on the same shard', async () => {
    const { pg, state } = createMockPg()
    install(pg)

    const pool = new pg.Pool({
      host: ['10.0.1.10', '10.0.1.11'],
    })
    const client = await pool.connect()

    try {
      await client.query({ text: 'BEGIN', tid: 'tenant-1' })
      throw new Error('simulated failure')
    } catch {
      await client.query({ text: 'ROLLBACK', tid: 'tenant-1' })
    } finally {
      client.release()
    }

    const clientQueries = state.queries
      .filter((q) => q.source === 'client')
      .map((q) => q.args[0]?.text ?? q.args[0])

    assert.deepEqual(clientQueries, ['BEGIN', 'ROLLBACK'])
    assert.ok(
      state.queries
        .filter((q) => q.source === 'client')
        .every((q) => q.host === '10.0.1.11'),
    )
  })

  it('rejects BEGIN without tid on a multi-host pool', async () => {
    const { pg } = createMockPg()
    install(pg)

    const pool = new pg.Pool({
      host: ['10.0.1.10', '10.0.1.11'],
    })
    const client = await pool.connect()

    await assert.rejects(
      () => client.query('BEGIN'),
      /BEGIN on a multi-host pool requires tid/i,
    )

    client.release()
  })
})
