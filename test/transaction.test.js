const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const {
  createMockPg,
  createMockLookupServer,
  withTestEnv,
  setupGrpcMock,
} = require('./helpers')
const { install } = require('../patch')

describe('transactions', () => {
  let restoreEnv
  let lookup
  let grpcState

  beforeEach(async () => {
    restoreEnv = withTestEnv({
      DB_HOST: '["10.0.1.10","10.0.1.11"]',
    })
    grpcState = setupGrpcMock()
    lookup = await createMockLookupServer(() => ({ hostIndex: 1 }))
    process.env.MTDD_LOOKUP_URL = lookup.url
  })

  afterEach(async () => {
    await lookup.close()
    restoreEnv()
  })

  it('preserves BEGIN / COMMIT ordering on a pinned shard via gRPC', async () => {
    const { pg } = createMockPg()
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

    const queries = grpcState.queries.map((q) => ({
      host_index: q.host_index,
      sql: q.text,
    }))

    assert.ok(queries.every((q) => q.host_index === 1))
    assert.equal(queries[0].sql, 'BEGIN')
    assert.match(queries[1].sql, /INSERT/)
    assert.equal(queries[2].sql, 'COMMIT')
    assert.ok(
      grpcState.queries.every((q) => q.session_id && q.session_id.length > 0),
    )
  })

  it('preserves ROLLBACK on error on the same shard', async () => {
    const { pg } = createMockPg()
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

    assert.deepEqual(
      grpcState.queries.map((q) => q.text),
      ['BEGIN', 'ROLLBACK'],
    )
    assert.ok(grpcState.queries.every((q) => q.host_index === 1))
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
