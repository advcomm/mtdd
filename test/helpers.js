const path = require('node:path')
const { spawnSync } = require('node:child_process')

const registerPath = path.join(__dirname, '..', 'register.js')
const packageRoot = path.join(__dirname, '..')

function runRegister(env = {}) {
  const childEnv = { ...process.env, ...env }
  if (Object.prototype.hasOwnProperty.call(env, 'DB_HOST') && env.DB_HOST === undefined) {
    delete childEnv.DB_HOST
  }

  return spawnSync(
    process.execPath,
    ['--require', registerPath, '-e', 'process.exit(0)'],
    {
      env: childEnv,
      cwd: packageRoot,
      encoding: 'utf8',
    },
  )
}

function createMockPg() {
  const state = {
    pools: [],
    clients: [],
    queries: [],
  }

  function MockClient(config) {
    this.config = config
    state.clients.push(this)
  }

  MockClient.prototype.query = function query(...args) {
    state.queries.push({ source: 'client', args: [...args] })
    return resolveQuery(args)
  }

  function MockPool(config) {
    this.config = config
    state.pools.push(this)
  }

  MockPool.prototype.query = function query(...args) {
    state.queries.push({ source: 'pool', args: [...args] })
    return resolveQuery(args)
  }

  MockPool.prototype.connect = function connect() {
    const client = new MockClient(this.config)
    client.release = () => {}
    return Promise.resolve(client)
  }

  function resolveQuery(args) {
    const last = args[args.length - 1]
    const result = {
      command: 'SELECT',
      rowCount: 0,
      oid: null,
      fields: [],
      rows: [],
    }

    if (typeof last === 'function') {
      process.nextTick(() => last(null, result))
      return undefined
    }

    return Promise.resolve(result)
  }

  return {
    pg: { Pool: MockPool, Client: MockClient },
    state,
  }
}

module.exports = {
  runRegister,
  createMockPg,
  registerPath,
  packageRoot,
}
