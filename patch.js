const { MessageChannel, receiveMessageOnPort } = require('node:worker_threads')
const { validateEnvDbHost } = require('./host-policy')
const { selectHost } = require('./host-selector')
const { getMtddContext } = require('./context')
const hooks = require('./hooks')
const {
  normalizeQueryRequest,
  buildPgQueryArgs,
} = require('./normalize')

const PATCHED = Symbol.for('@advcomm/mtdd.patched')

function settlePromiseSync(promise, fallback) {
  if (!promise || typeof promise.then !== 'function') {
    return typeof promise === 'string' ? promise : fallback
  }

  const { port1, port2 } = new MessageChannel()
  let result = fallback
  let error

  promise.then(
    (value) => {
      result = typeof value === 'string' ? value : fallback
      port1.postMessage(null)
    },
    (err) => {
      error = err
      port1.postMessage(null)
    },
  )

  receiveMessageOnPort(port2)

  if (error) {
    throw error
  }

  return result
}

function resolveHostArray(config, source) {
  const originalHost = config.host
  const hosts = originalHost
  let selectedHost = selectHost(hosts)

  const selectRequest = {
    hosts,
    strategy: 'round-robin',
    selectedHost,
    source,
    originalConfig: { ...config },
  }

  const hookResult = hooks.onSelectHost(
    selectRequest,
    async () => selectedHost,
  )

  selectedHost = settlePromiseSync(hookResult, selectedHost)

  const effectiveConfig = { ...config, host: selectedHost }

  const connectRequest = {
    source,
    originalConfig: { ...config },
    effectiveConfig: { ...effectiveConfig },
    originalHost,
    selectedHost,
  }

  const connectResult = hooks.onConnect(
    connectRequest,
    async () => effectiveConfig,
  )

  const finalConfig = settlePromiseSync(connectResult, effectiveConfig)

  if (finalConfig && typeof finalConfig === 'object') {
    return { ...finalConfig }
  }

  return effectiveConfig
}

function wrapConfig(config, source) {
  if (!config || !Array.isArray(config.host)) {
    return config ? { ...config } : config
  }
  return resolveHostArray(config, source)
}

function install(pgModule) {
  const pg = pgModule || require('pg')

  if (pg[PATCHED]) {
    return pg
  }

  validateEnvDbHost()

  const OriginalPool = pg.Pool
  const OriginalClient = pg.Client
  const originalPoolQuery = OriginalPool.prototype.query
  const originalClientQuery = OriginalClient.prototype.query

  function PatchedPool(config) {
    if (!(this instanceof PatchedPool)) {
      return new PatchedPool(config)
    }

    const effectiveConfig = wrapConfig(config, 'pool')
    return new OriginalPool(effectiveConfig)
  }

  function PatchedClient(config) {
    if (!(this instanceof PatchedClient)) {
      return new PatchedClient(config)
    }

    const effectiveConfig = wrapConfig(config, 'client')
    return new OriginalClient(effectiveConfig)
  }

  Object.setPrototypeOf(PatchedPool, OriginalPool)
  Object.setPrototypeOf(PatchedClient, OriginalClient)
  PatchedPool.prototype = OriginalPool.prototype
  PatchedClient.prototype = OriginalClient.prototype

  function createNext(instance, originalQuery, req) {
    return () =>
      new Promise((resolve, reject) => {
        const pgArgs = buildPgQueryArgs(req)
        const lastIndex = pgArgs.length - 1

        if (typeof pgArgs[lastIndex] === 'function') {
          pgArgs[lastIndex] = (err, result) => {
            if (err) {
              reject(err)
            } else {
              resolve(result)
            }
          }
        }

        let ret
        try {
          ret = originalQuery.apply(instance, pgArgs)
        } catch (err) {
          reject(err)
          return
        }

        if (ret && typeof ret.then === 'function') {
          ret.then(resolve, reject)
        }
      })
  }

  async function runQueryHook(instance, source, rawArgs) {
    const isPool = source === 'pool.query'
    const req = normalizeQueryRequest(
      source,
      rawArgs,
      isPool ? undefined : instance,
      isPool ? instance : undefined,
    )

    const asyncContext = getMtddContext()
    req.context = asyncContext ? { ...asyncContext } : undefined
    req.tid = req.tid ?? asyncContext?.tid ?? undefined

    const originalQuery = isPool ? originalPoolQuery : originalClientQuery
    const next = createNext(instance, originalQuery, req)

    if (req.callback) {
      const callback = req.callback
      hooks
        .onQuery(req, next)
        .then((result) => callback(null, result))
        .catch((err) => callback(err))
      return undefined
    }

    return hooks.onQuery(req, next)
  }

  OriginalPool.prototype.query = function query(...rawArgs) {
    const last = rawArgs[rawArgs.length - 1]
    if (typeof last === 'function') {
      runQueryHook(this, 'pool.query', rawArgs)
      return undefined
    }
    return runQueryHook(this, 'pool.query', rawArgs)
  }

  OriginalClient.prototype.query = function query(...rawArgs) {
    const last = rawArgs[rawArgs.length - 1]
    if (typeof last === 'function') {
      runQueryHook(this, 'client.query', rawArgs)
      return undefined
    }
    return runQueryHook(this, 'client.query', rawArgs)
  }

  pg.Pool = PatchedPool
  pg.Client = PatchedClient
  pg[PATCHED] = true

  return pg
}

module.exports = {
  install,
  PATCHED,
}
