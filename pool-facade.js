const MTDD_META = Symbol.for('@advcomm/mtdd.meta')
const PINNED_HOST_INDEX = Symbol.for('@advcomm/mtdd.pinnedHostIndex')
const PINNED_SUB_TARGET = Symbol.for('@advcomm/mtdd.pinnedSubTarget')

function getMtddMeta(target) {
  if (!target || typeof target !== 'object') {
    return null
  }
  return target[MTDD_META] ?? null
}

function isMtddFacade(target) {
  return getMtddMeta(target) !== null
}

function normalizeHosts(config) {
  if (!config || config.host === undefined) {
    return []
  }
  if (Array.isArray(config.host)) {
    return config.host
  }
  return [config.host]
}

function buildBaseConfig(config) {
  const base = { ...config }
  delete base.host
  return base
}

function getSubPool(meta, hostIndex) {
  if (!meta.subPools[hostIndex]) {
    meta.subPools[hostIndex] = new meta.OriginalPool({
      ...meta.baseConfig,
      host: meta.hosts[hostIndex],
    })
  }
  return meta.subPools[hostIndex]
}

function getSubClient(meta, hostIndex) {
  if (!meta.subClients[hostIndex]) {
    meta.subClients[hostIndex] = new meta.OriginalClient({
      ...meta.baseConfig,
      host: meta.hosts[hostIndex],
    })
  }
  return meta.subClients[hostIndex]
}

function getPinnedHostIndex(target) {
  return target[PINNED_HOST_INDEX]
}

function setPinnedHostIndex(target, hostIndex, subTarget) {
  target[PINNED_HOST_INDEX] = hostIndex
  target[PINNED_SUB_TARGET] = subTarget
}

function getPinnedSubTarget(target) {
  return target[PINNED_SUB_TARGET]
}

function createPoolFacade(config, OriginalPool, OriginalClient) {
  const hosts = normalizeHosts(config)
  const meta = {
    kind: 'pool',
    hosts,
    baseConfig: buildBaseConfig(config),
    subPools: {},
    subClients: {},
    OriginalPool,
    OriginalClient,
  }

  const facade = {
    query() {
      throw new Error(
        '@advcomm/mtdd: pool facade query must be invoked via patched entry',
      )
    },
    connect() {
      return Promise.resolve(createCheckedOutClientFacade(meta, null))
    },
    async end() {
      // gRPC shard connections are process-scoped (opened at preload).
    },
  }

  facade[MTDD_META] = meta
  return facade
}

function createStandaloneClientFacade(config, OriginalPool, OriginalClient) {
  const hosts = normalizeHosts(config)
  const meta = {
    kind: 'client',
    hosts,
    baseConfig: buildBaseConfig(config),
    subPools: {},
    subClients: {},
    OriginalPool,
    OriginalClient,
  }

  const facade = {
    query() {
      throw new Error(
        '@advcomm/mtdd: client facade query must be invoked via patched entry',
      )
    },
    async end() {
      // gRPC shard connections are process-scoped (opened at preload).
    },
  }

  facade[MTDD_META] = meta
  return facade
}

function createCheckedOutClientFacade(poolMeta, pinnedHostIndex) {
  const clientFacade = {
    release() {},
    query() {
      throw new Error(
        '@advcomm/mtdd: checked-out client query must be invoked via patched entry',
      )
    },
  }

  const meta = {
    kind: 'checkout',
    hosts: poolMeta.hosts,
    baseConfig: poolMeta.baseConfig,
    subPools: poolMeta.subPools,
    subClients: poolMeta.subClients,
    OriginalPool: poolMeta.OriginalPool,
    OriginalClient: poolMeta.OriginalClient,
    poolMeta,
  }

  clientFacade[MTDD_META] = meta

  if (pinnedHostIndex !== null && pinnedHostIndex !== undefined) {
    setPinnedHostIndex(
      clientFacade,
      pinnedHostIndex,
      getSubPool(poolMeta, pinnedHostIndex),
    )
  }

  return clientFacade
}

function createFacade(config, kind, OriginalPool, OriginalClient) {
  const hosts = normalizeHosts(config)

  if (hosts.length === 0) {
    if (kind === 'pool') {
      return new OriginalPool(config)
    }
    return new OriginalClient(config)
  }

  if (kind === 'pool') {
    return createPoolFacade(config, OriginalPool, OriginalClient)
  }

  return createStandaloneClientFacade(config, OriginalPool, OriginalClient)
}

function isSharded(target) {
  const meta = getMtddMeta(target)
  return meta !== null && meta.hosts.length > 1
}

module.exports = {
  MTDD_META,
  PINNED_HOST_INDEX,
  PINNED_SUB_TARGET,
  getMtddMeta,
  isMtddFacade,
  isSharded,
  createFacade,
  createCheckedOutClientFacade,
  getSubPool,
  getSubClient,
  getPinnedHostIndex,
  setPinnedHostIndex,
  getPinnedSubTarget,
  normalizeHosts,
}
