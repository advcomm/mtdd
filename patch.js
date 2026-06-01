const { validateEnvDbHost } = require('./host-policy')
const { validateLookupUrl } = require('./lookup-policy')
const { getMtddContext } = require('./context')
const hooks = require('./hooks')
const { normalizeQueryRequest } = require('./normalize')
const { executeRoutedQuery } = require('./query-executor')
const {
  createFacade,
  isMtddFacade,
  getMtddMeta,
} = require('./pool-facade')

const PATCHED = Symbol.for('@advcomm/mtdd.patched')

function install(pgModule) {
  const pg = pgModule || require('pg')

  if (pg[PATCHED]) {
    return pg
  }

  validateEnvDbHost()
  validateLookupUrl()

  const OriginalPool = pg.Pool
  const OriginalClient = pg.Client

  async function runQueryHook(target, source, rawArgs) {
    const isPool = source === 'pool.query'
    const meta = getMtddMeta(target)
    const req = normalizeQueryRequest(
      source,
      rawArgs,
      isPool ? undefined : target,
      isPool ? target : undefined,
    )

    const asyncContext = getMtddContext()
    req.context = asyncContext ? { ...asyncContext } : undefined
    req.tid = req.tid ?? asyncContext?.tid ?? undefined

    if (meta) {
      req.hosts = meta.hosts
    }

    const next = () => executeRoutedQuery(target, req)

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

  function attachQuery(target, source) {
    const bound = function query(...rawArgs) {
      const last = rawArgs[rawArgs.length - 1]
      if (typeof last === 'function') {
        runQueryHook(target, source, rawArgs)
        return undefined
      }
      return runQueryHook(target, source, rawArgs)
    }
    target.query = bound
    return target
  }

  function PatchedPool(config) {
    if (!(this instanceof PatchedPool)) {
      return new PatchedPool(config)
    }

    const instance = createFacade(config, 'pool', OriginalPool, OriginalClient)

    if (isMtddFacade(instance)) {
      attachQuery(instance, 'pool.query')
      const baseConnect = instance.connect.bind(instance)
      instance.connect = async function connect() {
        const client = await baseConnect()
        return attachQuery(client, 'client.query')
      }
    }

    return instance
  }

  function PatchedClient(config) {
    if (!(this instanceof PatchedClient)) {
      return new PatchedClient(config)
    }

    const instance = createFacade(config, 'client', OriginalPool, OriginalClient)

    if (isMtddFacade(instance)) {
      attachQuery(instance, 'client.query')
    }

    return instance
  }

  Object.setPrototypeOf(PatchedPool, OriginalPool)
  Object.setPrototypeOf(PatchedClient, OriginalClient)
  PatchedPool.prototype = OriginalPool.prototype
  PatchedClient.prototype = OriginalClient.prototype

  const previousPoolQuery = OriginalPool.prototype.query
  const previousClientQuery = OriginalClient.prototype.query

  OriginalPool.prototype.query = function query(...rawArgs) {
    if (isMtddFacade(this)) {
      return this.query(...rawArgs)
    }
    return previousPoolQuery.apply(this, rawArgs)
  }

  OriginalClient.prototype.query = function query(...rawArgs) {
    if (isMtddFacade(this)) {
      return this.query(...rawArgs)
    }
    return previousClientQuery.apply(this, rawArgs)
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
