const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const {
  createMockPg,
  createMockLookupServer,
  withTestEnv,
  setupGrpcMock,
} = require('./helpers')
const { install } = require('../src/patch')
const hooks = require('../src/hooks')
const { resetGrpcHub } = require('../src/grpc-hub')

const shardHost = {
  write: '10.0.1.10',
  read: ['10.0.1.11', '10.0.1.12'],
}

async function setupRoutingTest(dbHostJson) {
  const restoreEnv = withTestEnv({
    DB_HOST: dbHostJson,
  })
  const grpcState = setupGrpcMock()
  const lookup = await createMockLookupServer(() => ({ hostIndex: 0 }))
  process.env.MTDD_LOOKUP_URL = lookup.url
  hooks.onQuery = async (req, next) => next()
  return { restoreEnv, grpcState, lookup }
}

describe('read/write host routing', () => {
  let restoreEnv
  let lookup
  let grpcState
  let warnMessages
  let originalWarn

  beforeEach(async () => {
    warnMessages = []
    originalWarn = console.warn
    console.warn = (...args) => {
      warnMessages.push(args.join(' '))
      originalWarn(...args)
    }

    const setup = await setupRoutingTest(JSON.stringify([shardHost]))
    restoreEnv = setup.restoreEnv
    grpcState = setup.grpcState
    lookup = setup.lookup
  })

  afterEach(async () => {
    console.warn = originalWarn
    await lookup.close()
    restoreEnv()
    await require('../src/postgres-local').resetLocalPostgresPool()
  })

  it('connects write and all read endpoints at startup', () => {
    const { pg } = createMockPg()
    install(pg)

    const writeConnections = grpcState.connections.filter((c) => c.role === 'write')
    const readConnections = grpcState.connections.filter((c) => c.role === 'read')

    assert.equal(writeConnections.length, 1)
    assert.equal(writeConnections[0].host, shardHost.write)
    assert.equal(readConnections.length, 2)
    assert.deepEqual(
      readConnections.map((c) => c.host).sort(),
      [...shardHost.read].sort(),
    )
  })

  it('routes SELECT through read endpoints in round-robin', async () => {
    const { pg } = createMockPg()
    install(pg)

    const pool = new pg.Pool({
      host: [shardHost],
    })

    await pool.query('SELECT 1')
    await pool.query('SELECT 2')
    await pool.query('SELECT 3')

    const selectQueries = grpcState.queries.filter((q) =>
      q.text.startsWith('SELECT'),
    )
    assert.equal(selectQueries.length, 3)
    assert.ok(selectQueries.every((q) => q.role === 'read'))
    assert.deepEqual(
      selectQueries.map((q) => q.host),
      ['10.0.1.11', '10.0.1.12', '10.0.1.11'],
    )
  })

  it('routes INSERT through the write endpoint', async () => {
    const { pg } = createMockPg()
    install(pg)

    const pool = new pg.Pool({
      host: [shardHost],
    })

    await pool.query({
      text: 'INSERT INTO users (id) VALUES ($1)',
      values: [1],
      tid: 'tenant-a',
    })

    assert.equal(grpcState.queries.length, 1)
    assert.equal(grpcState.queries[0].role, 'write')
    assert.equal(grpcState.queries[0].host, shardHost.write)
  })
})

describe('read/write host routing string shard entry', () => {
  let restoreEnv
  let lookup
  let grpcState

  beforeEach(async () => {
    const setup = await setupRoutingTest('["10.0.1.10"]')
    restoreEnv = setup.restoreEnv
    grpcState = setup.grpcState
    lookup = setup.lookup
  })

  afterEach(async () => {
    await lookup.close()
    restoreEnv()
    await require('../src/postgres-local').resetLocalPostgresPool()
  })

  it('uses the same IP for write and SELECT when host entry is a string', async () => {
    const { pg } = createMockPg()
    install(pg)

    const pool = new pg.Pool({ host: ['10.0.1.10'] })

    grpcState.queries.length = 0
    await pool.query('SELECT 1')
    await pool.query({
      text: 'INSERT INTO users (id) VALUES ($1)',
      values: [1],
      tid: 'tenant-a',
    })

    assert.equal(grpcState.connections.length, 1)
    assert.equal(grpcState.connections[0].host, '10.0.1.10')
    assert.equal(grpcState.connections[0].role, 'write')

    assert.equal(grpcState.queries.length, 2)
    assert.equal(grpcState.queries[0].host, '10.0.1.10')
    assert.equal(grpcState.queries[1].host, '10.0.1.10')
  })
})

describe('read/write host routing alternate shard layouts', () => {
  let restoreEnv
  let lookup
  let grpcState

  afterEach(async () => {
    await lookup.close()
    restoreEnv()
    await require('../src/postgres-local').resetLocalPostgresPool()
  })

  it('routes UPDATE through write endpoints on fan-out', async () => {
    const setup = await setupRoutingTest(
      JSON.stringify([shardHost, { write: '10.0.2.10', read: ['10.0.2.11'] }]),
    )
    restoreEnv = setup.restoreEnv
    grpcState = setup.grpcState
    lookup = setup.lookup

    const { pg } = createMockPg()
    install(pg)

    const pool = new pg.Pool({
      host: [shardHost, { write: '10.0.2.10', read: ['10.0.2.11'] }],
    })

    await pool.query('UPDATE users SET active = false WHERE id > 0')
    const updateQueries = grpcState.queries.filter((q) =>
      q.text.startsWith('UPDATE'),
    )
    assert.equal(updateQueries.length, 2)
    assert.ok(updateQueries.every((q) => q.role === 'write'))
    assert.deepEqual(
      updateQueries.map((q) => q.host).sort(),
      ['10.0.1.10', '10.0.2.10'].sort(),
    )
  })

  it('uses write for SELECT when no read endpoints connected', async () => {
    const setup = await setupRoutingTest(
      JSON.stringify([{ write: '10.0.1.10', read: [] }]),
    )
    restoreEnv = setup.restoreEnv
    grpcState = setup.grpcState
    lookup = setup.lookup

    const { pg } = createMockPg()
    install(pg)

    const pool = new pg.Pool({
      host: [{ write: '10.0.1.10', read: [] }],
    })

    await pool.query('SELECT 1')

    assert.equal(grpcState.queries.length, 1)
    assert.equal(grpcState.queries[0].host, '10.0.1.10')
  })

  it('warns when a read endpoint fails to connect but still starts', async () => {
    const warnMessages = []
    const originalStdoutWrite = process.stdout.write
    process.stdout.write = function write(chunk, ...args) {
      warnMessages.push(String(chunk))
      return originalStdoutWrite.call(this, chunk, ...args)
    }

    try {
      const setup = await setupRoutingTest(
        JSON.stringify([
          { write: '10.0.1.10', read: ['10.0.1.11', '10.0.1.12'] },
        ]),
      )
      restoreEnv = setup.restoreEnv
      lookup = setup.lookup

      const { getWriteHost, getReadHosts } = require('../src/host-config')
      const { warnReadConnectFailure, useMockTransport, initGrpcHub } =
        require('../src/grpc-hub')
      const { validateEnvDbHost } = require('../src/host-policy')
      const { getGrpcCredentialsFromEnv } = require('../src/grpc-credentials')
      const { settlePromiseSync } = require('../src/install-sync')
      const { createRecordingMockTransport } = require('./grpc-mock-transport')

      const state = { connections: [], queries: [] }
      resetGrpcHub()
      useMockTransport({
        ...createRecordingMockTransport(state),
        async connectAll(hosts, credentials) {
          state.connections = []
          const shards = []

          for (let hostIndex = 0; hostIndex < hosts.length; hostIndex++) {
            const entry =
              typeof hosts[hostIndex] === 'string'
                ? { write: hosts[hostIndex], read: [] }
                : hosts[hostIndex]
            const writeHost = getWriteHost(entry)
            const write = {
              host: writeHost,
              hostIndex,
              role: 'write',
              credentials: { ...credentials },
              client: { mock: true },
            }
            state.connections.push(write)

            const reads = []
            for (const readHost of getReadHosts(entry)) {
              if (readHost === '10.0.1.12') {
                warnReadConnectFailure(
                  writeHost,
                  hostIndex,
                  readHost,
                  new Error('connection refused'),
                )
                continue
              }
              const readEndpoint = {
                host: readHost,
                hostIndex,
                role: 'read',
                credentials: { ...credentials },
                client: { mock: true },
              }
              reads.push(readEndpoint)
              state.connections.push(readEndpoint)
            }

            shards.push({
              hostIndex,
              write,
              reads,
              readCounter: 0,
              host: writeHost,
            })
          }

          return shards
        },
      })

      settlePromiseSync(initGrpcHub(validateEnvDbHost(), getGrpcCredentialsFromEnv()))

      assert.ok(
        warnMessages.some(
          (m) =>
            /read endpoint connect failed/i.test(m) &&
            /10\.0\.1\.12/.test(m),
        ),
        'expected warning about failed read host',
      )

      const { pg } = createMockPg()
      install(pg)

      const pool = new pg.Pool({
        host: [{ write: '10.0.1.10', read: ['10.0.1.11', '10.0.1.12'] }],
      })

      await pool.query('SELECT 1')
      await pool.query('SELECT 2')

      const selectHosts = state.queries.map((q) => q.host)
      assert.deepEqual(selectHosts, ['10.0.1.11', '10.0.1.11'])
      assert.ok(!selectHosts.includes('10.0.1.12'))
    } finally {
      process.stdout.write = originalStdoutWrite
    }
  })
})
