const { validateEnvDbHost } = require('./host-policy')
const { validateLookupUrl } = require('./lookup-policy')
const { getGrpcCredentialsFromEnv } = require('./grpc-credentials')
const { verifyLocalPostgresAtStartup } = require('./postgres-local')
const { initGrpcHub, isGrpcHubReady } = require('./grpc-hub')
const { initNotifyTransport } = require('./mtdd-notify-transport')
const { settlePromiseSync } = require('./install-sync')
const { getMtddContext } = require('./context')
const hooks = require('./hooks')
const { normalizeQueryRequest, assertPlainSqlQuery } = require('./normalize')
const { executeRoutedQuery } = require('./query-executor')
const { withQuerySpan, spanAttributesFromReq } = require('./query-telemetry')
const { registerAutoShutdown } = require('./shutdown')
const {
  createFacade,
  isMtddFacade,
  getMtddMeta,
} = require('./pool-facade')
const preloadLog = require('./preload-logger')
const {
  validateGrpcTlsConfig,
  validateNotifyTlsConfig,
} = require('./grpc-tls')

const PATCHED = Symbol.for('@advcomm/mtdd.patched')

function runPreload() {
  const hosts = validateEnvDbHost()
  preloadLog.logHostsValidated(hosts)

  const lookupUrl = validateLookupUrl()
  preloadLog.logLookupValidated(lookupUrl)

  const grpcCredentials = getGrpcCredentialsFromEnv()
  preloadLog.logGrpcCredentials(grpcCredentials)

  if (process.env.MTDD_GRPC_MOCK !== '1') {
    const shardTls = validateGrpcTlsConfig()
    const notifyTls = validateNotifyTlsConfig()
    preloadLog.logInfo('grpc tls validated', {
      shard: shardTls.mode,
      shardMTLS: shardTls.mTLS,
      notify: notifyTls.mode,
      notifyMTLS: notifyTls.mTLS,
    })
  }

  verifyLocalPostgresAtStartup(grpcCredentials)

  if (!isGrpcHubReady()) {
    const hubStart = performance.now()
    preloadLog.logGrpcHubInitStarting(hosts, grpcCredentials)
    const state = settlePromiseSync(initGrpcHub(hosts, grpcCredentials))
    preloadLog.logGrpcHubInitComplete(state?.shards, Math.round(performance.now() - hubStart))
  }

  const notifyTransport = initNotifyTransport({ hosts })
  preloadLog.logNotifyTransportInit(notifyTransport._mtddNotifyMeta)

  return hosts
}

function install(pgModule) {
  const pg = pgModule || require('pg')

  if (pg[PATCHED]) {
    preloadLog.logAlreadyPatched()
    return pg
  }

  preloadLog.logPreloadBegin()
  const preloadStarted = performance.now()

  try {
    preloadLog.step('preload', () => {
      runPreload()
    })
    preloadLog.logPatchApplied()
    preloadLog.logPreloadComplete({
      durationMs: Math.round(performance.now() - preloadStarted),
    })
    registerAutoShutdown()
  } catch (err) {
    preloadLog.logPreloadFailed(err, {
      durationMs: Math.round(performance.now() - preloadStarted),
    })
    throw err
  }

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
    if (!('tid' in req)) {
      if (asyncContext && 'tid' in asyncContext) {
        req.tid = asyncContext.tid
      } else {
        req.tid = undefined
      }
    }

    if (meta) {
      req.hosts = meta.hosts
    }

    assertPlainSqlQuery(req)

    const runRouted = () =>
      withQuerySpan('mtdd.query', spanAttributesFromReq(req), () =>
        executeRoutedQuery(target, req),
      )

    const next = () => runRouted()

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
