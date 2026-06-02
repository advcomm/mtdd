const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const {
  createMockPg,
  createMockLookupServer,
  withTestEnv,
  setupGrpcMock,
} = require('./helpers')
const { install, PATCHED } = require('../src/patch')
const { isMtddFacade } = require('../src/pool-facade')

describe('host facade', () => {
  let restoreEnv
  let lookup
  let grpcState

  beforeEach(async () => {
    restoreEnv = withTestEnv({
      DB_HOST: '["10.0.1.10","10.0.1.11","10.0.1.12"]',
    })
    grpcState = setupGrpcMock()
    lookup = await createMockLookupServer(() => ({ hostIndex: 0 }))
    process.env.MTDD_LOOKUP_URL = lookup.url
  })

  afterEach(async () => {
    await lookup.close()
    restoreEnv()
  })

  it('opens gRPC connections to every DB_HOST address at preload', () => {
    assert.equal(grpcState.connections.length, 3)
    assert.deepEqual(
      grpcState.connections.map((c) => c.hostIndex),
      [0, 1, 2],
    )
    assert.equal(grpcState.connections[0].credentials.database, 'testdb')
  })

  it('retains host array on facade without creating pg sub-pools at construction', () => {
    const { pg, state } = createMockPg()
    if (!pg[PATCHED]) {
      install(pg)
    }

    const pool = new pg.Pool({
      host: ['10.0.1.10', '10.0.1.11'],
      port: 5432,
    })

    assert.equal(isMtddFacade(pool), true)
    assert.equal(state.pools.length, 0)
  })

  it('routes queries through gRPC for the selected shard', async () => {
    const { pg } = createMockPg()
    if (!pg[PATCHED]) {
      install(pg)
    }

    const pool = new pg.Pool({
      host: ['10.0.1.10', '10.0.1.11'],
    })

    await pool.query({ text: 'SELECT 1', tid: 'tenant-a' })

    assert.equal(grpcState.queries.length, 1)
    assert.equal(grpcState.queries[0].host_index, 0)
    assert.equal(grpcState.queries[0].host, '10.0.1.10')
  })

  it('does not double-patch pg', () => {
    const { pg } = createMockPg()
    if (!pg[PATCHED]) {
      install(pg)
    }
    install(pg)
    assert.equal(pg[PATCHED], true)
  })
})
