const { lookupHostIndex } = require('./lookup-client')
const { mergeFanOutResults, discardedCallResult } = require('./merge-results')
const {
  attachQueryClassification,
  isInsertQuery,
  isCallQuery,
  isCallAllShards,
  isFunctionQuery,
  isSelectQuery,
  hasTenantTid,
} = require('./query-classifier')
const { getWriteHost } = require('./host-config')
const { buildPgQueryArgs } = require('./normalize')
const { queryShard, isGrpcHubReady } = require('./grpc-hub')
const { getGrpcCredentialsFromEnv } = require('./grpc-credentials')
const { splitSelectForOrderedFanOut } = require('./select-order-fanout')
const { mergeSelectResultsOnLocalPostgres } = require('./postgres-select-merge')
const hooks = require('./hooks')
const {
  getMtddMeta,
  getPinnedHostIndex,
  setPinnedHostIndex,
  getPinnedSubTarget,
} = require('./pool-facade')

function isBeginQuery(req) {
  const text =
    typeof req.text === 'string'
      ? req.text
      : typeof req.rawArgs?.[0] === 'string'
        ? req.rawArgs[0]
        : ''

  return text.trim().toUpperCase() === 'BEGIN'
}

function assertInsertRequiresTid(req) {
  if (isInsertQuery(req) && !req.tid) {
    throw new Error(
      '@advcomm/mtdd: INSERT requires tid so the lookup server can route to a single shard.',
    )
  }
}

function assertCallTid(req) {
  if (isCallQuery(req) && req.tid === undefined) {
    throw new Error(
      '@advcomm/mtdd: CALL requires a tenant tid for shard routing, or tid: null to run on all shards.',
    )
  }
}

function assertFunctionRequiresTid(req) {
  if (isFunctionQuery(req) && (req.tid === undefined || req.tid === null)) {
    throw new Error(
      '@advcomm/mtdd: stored function queries require a tenant tid so the lookup server can route to a single shard.',
    )
  }
}

function assertTransactionRouting(target, req) {
  const meta = getMtddMeta(target)
  if (!meta || meta.hosts.length <= 1) {
    return
  }

  const pinned = getPinnedHostIndex(target)

  if (req.tid === undefined && pinned === undefined) {
    if (isInsertQuery(req)) {
      throw new Error(
        '@advcomm/mtdd: INSERT requires tid so the lookup server can route to a single shard.',
      )
    }
    if (isCallQuery(req)) {
      throw new Error(
        '@advcomm/mtdd: CALL requires a tenant tid for shard routing, or tid: null to run on all shards.',
      )
    }
    if (isFunctionQuery(req)) {
      throw new Error(
        '@advcomm/mtdd: stored function queries require a tenant tid so the lookup server can route to a single shard.',
      )
    }
    if (isBeginQuery(req)) {
      throw new Error(
        '@advcomm/mtdd: BEGIN on a multi-host pool requires tid (or an earlier pinned query with tid) so the transaction uses a single shard.',
      )
    }
    if (meta.kind === 'checkout') {
      throw new Error(
        '@advcomm/mtdd: fan-out queries are not supported on pool.connect() clients. Provide tid on each query or only use single-shard operations.',
      )
    }
  }

  if (req.tid === undefined && pinned !== undefined) {
    throw new Error(
      '@advcomm/mtdd: fan-out queries are not supported on a pinned transaction client. Provide tid for shard routing.',
    )
  }
}

function runNativeQuery(target, req) {
  const pgArgs = buildPgQueryArgs(req)
  const queryFn = target.query.bind(target)

  return new Promise((resolve, reject) => {
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
      ret = queryFn(...pgArgs)
    } catch (err) {
      reject(err)
      return
    }

    if (ret && typeof ret.then === 'function') {
      ret.then(resolve, reject)
    }
  })
}

function shouldUseGrpc(meta) {
  return meta !== null && isGrpcHubReady()
}

function getSessionId(target) {
  if (!target) {
    return undefined
  }
  const pin = getPinnedSubTarget(target)
  if (pin && pin.grpc) {
    return pin.sessionId
  }
  return undefined
}

function ensureCheckoutPin(target, hostIndex) {
  if (getPinnedHostIndex(target) !== undefined) {
    return
  }

  const sessionId = `mtdd-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`
  setPinnedHostIndex(target, hostIndex, {
    grpc: true,
    sessionId,
  })
}

function resolveEndpointRole(req) {
  return isSelectQuery(req) ? 'read' : 'write'
}

async function executeQueryOnShard(hostIndex, req, target, meta, role) {
  const endpointRole = role ?? resolveEndpointRole(req)

  if (shouldUseGrpc(meta)) {
    if (target && meta.kind === 'checkout') {
      ensureCheckoutPin(target, hostIndex)
    }
    return queryShard(hostIndex, req, getSessionId(target), endpointRole)
  }

  const { getSubPool, getSubClient } = require('./pool-facade')
  let subTarget

  if (meta.kind === 'pool') {
    subTarget = getSubPool(meta, hostIndex, endpointRole)
  } else if (meta.kind === 'client') {
    subTarget = getSubClient(meta, hostIndex, endpointRole)
  } else if (meta.kind === 'checkout') {
    const pool = getSubPool(meta, hostIndex, 'write')
    const client = await pool.connect()
    setPinnedHostIndex(target, hostIndex, client)
    const pgRelease = client.release.bind(client)
    target.release = () => pgRelease()
    subTarget = client
  }

  return runNativeQuery(subTarget, req)
}

async function queryOnHostIndex(meta, hostIndex, req, target) {
  return executeQueryOnShard(hostIndex, req, target, meta)
}

async function fanOutQuery(meta, req, target) {
  await attachQueryClassification(req)

  if (req.commandType === 'INSERT') {
    throw new Error(
      '@advcomm/mtdd: INSERT cannot fan out; provide tid for lookup-based routing to one shard.',
    )
  }

  if (req.commandType === 'CALL') {
    throw new Error(
      '@advcomm/mtdd: CALL cannot fan out; provide a tenant tid or tid: null for all shards.',
    )
  }

  if (req.commandType === 'FUNCTION') {
    throw new Error(
      '@advcomm/mtdd: stored function queries cannot fan out; provide a tenant tid for lookup routing.',
    )
  }

  if (req.commandType === 'SELECT' && hasTenantTid(req)) {
    throw new Error(
      '@advcomm/mtdd: SELECT with tid cannot fan out; tid routes to a single shard.',
    )
  }

  if (req.commandType === 'SELECT') {
    const split = splitSelectForOrderedFanOut(req.text)
    if (split.needsLocalReorder) {
      return fanOutSelectWithOrderBy(meta, req, split)
    }
  }

  const results = await Promise.all(
    meta.hosts.map((_, hostIndex) =>
      queryOnHostIndex(meta, hostIndex, req, null),
    ),
  )
  req.shardResults = results
  return mergeFanOutResults(req, results)
}

async function fanOutSelectWithOrderBy(meta, req, split) {
  const shardReq = {
    ...req,
    text: split.fanOutText,
  }

  const results = await Promise.all(
    meta.hosts.map((_, hostIndex) =>
      queryOnHostIndex(meta, hostIndex, shardReq, null),
    ),
  )

  req.shardResults = results
  req.localReorder = true
  req.fanOutSql = split.fanOutText

  const credentials = getGrpcCredentialsFromEnv()
  return mergeSelectResultsOnLocalPostgres({
    credentials,
    tempTableName: split.tempTableName,
    fullText: split.fullText,
    shardResults: results,
    values: req.values,
  })
}

async function routeWithLookupTid(meta, req, target) {
  req.routing = 'single'
  const hostIndex = await lookupHostIndex(req.tid, meta.hosts.length)
  req.hostIndex = hostIndex

  const selectRequest = {
    hosts: meta.hosts,
    strategy: 'lookup',
    hostIndex,
    selectedHost: getWriteHost(meta.hosts[hostIndex]),
    tid: req.tid,
    source: meta.kind === 'checkout' ? 'client' : meta.kind,
    originalConfig: { ...meta.baseConfig, host: meta.hosts },
  }

  await hooks.onSelectHost(selectRequest, async () => hostIndex)

  return queryOnHostIndex(meta, hostIndex, req, target)
}

async function broadcastCallQuery(meta, req, target) {
  const pinned = getPinnedHostIndex(target)
  if (pinned !== undefined) {
    throw new Error(
      '@advcomm/mtdd: broadcast CALL is not supported on a pinned transaction client.',
    )
  }

  req.routing = 'broadcast'
  await Promise.all(
    meta.hosts.map((_, hostIndex) =>
      queryOnHostIndex(meta, hostIndex, req, null),
    ),
  )
  return discardedCallResult()
}

async function executeRoutedQuery(target, req) {
  const meta = getMtddMeta(target)

  if (!meta) {
    return runNativeQuery(target, req)
  }

  req.hosts = meta.hosts
  await attachQueryClassification(req)
  assertInsertRequiresTid(req)
  assertCallTid(req)
  assertFunctionRequiresTid(req)
  assertTransactionRouting(target, req)

  if (isCallAllShards(req)) {
    return broadcastCallQuery(meta, req, target)
  }

  const pinned = getPinnedHostIndex(target)
  if (pinned !== undefined) {
    req.routing = 'single'
    req.hostIndex = pinned

    if (shouldUseGrpc(meta)) {
      return queryShard(pinned, req, getSessionId(target), 'write')
    }

    const subTarget = getPinnedSubTarget(target)
    if (!subTarget) {
      throw new Error(
        '@advcomm/mtdd: pinned checkout client is missing an underlying connection',
      )
    }
    return runNativeQuery(subTarget, req)
  }

  if (req.commandType === 'INSERT') {
    return routeWithLookupTid(meta, req, target)
  }

  if (req.commandType === 'CALL') {
    return routeWithLookupTid(meta, req, target)
  }

  if (req.commandType === 'FUNCTION') {
    return routeWithLookupTid(meta, req, target)
  }

  if (req.commandType === 'SELECT' && hasTenantTid(req)) {
    return routeWithLookupTid(meta, req, target)
  }

  if (hasTenantTid(req)) {
    return routeWithLookupTid(meta, req, target)
  }

  if (meta.hosts.length === 1) {
    if (isInsertQuery(req)) {
      throw new Error(
        '@advcomm/mtdd: INSERT requires tid so the lookup server can route to a single shard.',
      )
    }
    if (isCallQuery(req)) {
      throw new Error(
        '@advcomm/mtdd: CALL requires a tenant tid for shard routing, or tid: null to run on all shards.',
      )
    }
    if (isFunctionQuery(req)) {
      throw new Error(
        '@advcomm/mtdd: stored function queries require a tenant tid so the lookup server can route to a single shard.',
      )
    }
    req.routing = 'single'
    req.hostIndex = 0
    return queryOnHostIndex(meta, 0, req, target)
  }

  req.routing = 'fanout'
  return fanOutQuery(meta, req, target)
}

async function fanOutOnly(target, req) {
  const meta = getMtddMeta(target)
  if (!meta) {
    throw new Error('@advcomm/mtdd: fanOutOnly requires a sharded pool or client facade')
  }

  req.hosts = meta.hosts
  req.routing = 'fanout'

  const results = await Promise.all(
    meta.hosts.map((_, hostIndex) =>
      queryOnHostIndex(meta, hostIndex, req, null),
    ),
  )

  req.shardResults = results
  return results
}

function isSharded(target) {
  const meta = getMtddMeta(target)
  return meta !== null && meta.hosts.length > 1
}

module.exports = {
  executeRoutedQuery,
  fanOutOnly,
  isSharded,
}
