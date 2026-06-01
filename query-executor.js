const { lookupHostIndex } = require('./lookup-client')
const { defaultMergeResults } = require('./merge-results')
const { buildPgQueryArgs } = require('./normalize')
const hooks = require('./hooks')
const {
  getMtddMeta,
  getSubPool,
  getSubClient,
  getPinnedHostIndex,
  setPinnedHostIndex,
  getPinnedSubTarget,
  isSharded,
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

function assertTransactionRouting(target, req) {
  const meta = getMtddMeta(target)
  if (!meta || meta.hosts.length <= 1) {
    return
  }

  const pinned = getPinnedHostIndex(target)

  if (!req.tid && pinned === undefined) {
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

  if (!req.tid && pinned !== undefined) {
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

async function ensureCheckoutClient(target, hostIndex, meta) {
  const existing = getPinnedSubTarget(target)
  if (existing) {
    return existing
  }

  const pool = getSubPool(meta, hostIndex)
  const client = await pool.connect()
  setPinnedHostIndex(target, hostIndex, client)

  const pgRelease = client.release.bind(client)
  target.release = () => pgRelease()

  return client
}

async function queryOnHostIndex(meta, hostIndex, req, target) {
  let subTarget

  if (meta.kind === 'pool') {
    subTarget = getSubPool(meta, hostIndex)
  } else if (meta.kind === 'client') {
    subTarget = getSubClient(meta, hostIndex)
  } else if (meta.kind === 'checkout') {
    if (target) {
      subTarget = await ensureCheckoutClient(target, hostIndex, meta)
    } else {
      subTarget = getSubPool(meta, hostIndex)
    }
  } else {
    throw new Error('@advcomm/mtdd: unknown facade kind')
  }

  return runNativeQuery(subTarget, req)
}

async function fanOutQuery(meta, req, target) {
  const results = await Promise.all(
    meta.hosts.map((_, hostIndex) => queryOnHostIndex(meta, hostIndex, req, null)),
  )
  req.shardResults = results
  return defaultMergeResults(results)
}

async function executeRoutedQuery(target, req) {
  const meta = getMtddMeta(target)

  if (!meta) {
    return runNativeQuery(target, req)
  }

  req.hosts = meta.hosts
  assertTransactionRouting(target, req)

  const pinned = getPinnedHostIndex(target)
  if (pinned !== undefined) {
    req.routing = 'single'
    req.hostIndex = pinned
    const subTarget = getPinnedSubTarget(target)
    if (!subTarget) {
      throw new Error(
        '@advcomm/mtdd: pinned checkout client is missing an underlying connection',
      )
    }
    return runNativeQuery(subTarget, req)
  }

  if (req.tid) {
    req.routing = 'single'
    const hostIndex = await lookupHostIndex(req.tid, meta.hosts.length)
    req.hostIndex = hostIndex

    const selectRequest = {
      hosts: meta.hosts,
      strategy: 'lookup',
      hostIndex,
      selectedHost: meta.hosts[hostIndex],
      tid: req.tid,
      source: meta.kind === 'checkout' ? 'client' : meta.kind,
      originalConfig: { ...meta.baseConfig, host: meta.hosts },
    }

    await hooks.onSelectHost(selectRequest, async () => hostIndex)

    return queryOnHostIndex(meta, hostIndex, req, target)
  }

  if (meta.hosts.length === 1) {
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
    meta.hosts.map((_, hostIndex) => queryOnHostIndex(meta, hostIndex, req, null)),
  )

  req.shardResults = results
  return results
}

module.exports = {
  executeRoutedQuery,
  fanOutOnly,
  isSharded,
}
