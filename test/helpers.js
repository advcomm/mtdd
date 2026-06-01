const path = require('node:path')
const http = require('node:http')
const { spawnSync } = require('node:child_process')

const registerPath = path.join(__dirname, '..', 'register.js')
const packageRoot = path.join(__dirname, '..')

const DEFAULT_LOOKUP_URL = 'http://127.0.0.1:0/lookup'

function runRegister(env = {}) {
  const childEnv = {
    ...process.env,
    MTDD_LOOKUP_URL: DEFAULT_LOOKUP_URL,
    ...env,
  }
  if (Object.prototype.hasOwnProperty.call(env, 'DB_HOST') && env.DB_HOST === undefined) {
    delete childEnv.DB_HOST
  }
  if (
    Object.prototype.hasOwnProperty.call(env, 'MTDD_LOOKUP_URL') &&
    env.MTDD_LOOKUP_URL === undefined
  ) {
    delete childEnv.MTDD_LOOKUP_URL
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

function withTestEnv(overrides = {}) {
  const previous = {
    DB_HOST: process.env.DB_HOST,
    MTDD_LOOKUP_URL: process.env.MTDD_LOOKUP_URL,
    MTDD_LOOKUP_TIMEOUT_MS: process.env.MTDD_LOOKUP_TIMEOUT_MS,
  }

  process.env.DB_HOST =
    overrides.DB_HOST ?? '["127.0.0.1","127.0.0.2"]'
  process.env.MTDD_LOOKUP_URL =
    overrides.MTDD_LOOKUP_URL ?? DEFAULT_LOOKUP_URL
  if (overrides.MTDD_LOOKUP_TIMEOUT_MS !== undefined) {
    process.env.MTDD_LOOKUP_TIMEOUT_MS = overrides.MTDD_LOOKUP_TIMEOUT_MS
  }

  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  }
}

function createMockLookupServer(handler) {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST') {
      res.statusCode = 405
      res.end()
      return
    }

    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      let body = {}
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        res.statusCode = 400
        res.end('invalid json')
        return
      }

      Promise.resolve()
        .then(() => handler(body, req))
        .then((payload) => {
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify(payload))
        })
        .catch((err) => {
          res.statusCode = err.statusCode ?? 500
          res.end(err.message ?? 'error')
        })
    })
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        server,
        url: `http://127.0.0.1:${port}/lookup`,
        close: () =>
          new Promise((closeResolve, closeReject) => {
            server.close((err) => (err ? closeReject(err) : closeResolve()))
          }),
      })
    })
  })
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
    state.queries.push({
      source: 'client',
      host: this.config.host,
      args: [...args],
    })
    return resolveQuery(args, this.config.host)
  }

  MockClient.prototype.end = function end() {
    return Promise.resolve()
  }

  function MockPool(config) {
    this.config = config
    state.pools.push(this)
  }

  MockPool.prototype.query = function query(...args) {
    state.queries.push({
      source: 'pool',
      host: this.config.host,
      args: [...args],
    })
    return resolveQuery(args, this.config.host)
  }

  MockPool.prototype.connect = function connect() {
    const client = new MockClient(this.config)
    client.release = () => {}
    return Promise.resolve(client)
  }

  MockPool.prototype.end = function end() {
    return Promise.resolve()
  }

  function resolveQuery(args, host) {
    const last = args[args.length - 1]
    const result = {
      command: 'SELECT',
      rowCount: 1,
      oid: null,
      fields: [],
      rows: [{ host, value: 1 }],
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
  createMockLookupServer,
  withTestEnv,
  registerPath,
  packageRoot,
}
