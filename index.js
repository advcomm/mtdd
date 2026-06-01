const patch = require('./patch')
const context = require('./context')
const hooks = require('./hooks')
const hostPolicy = require('./host-policy')
const hostConfig = require('./host-config')
const hostSelector = require('./host-selector')
const {
  defaultMergeResults,
  mergeDmlResults,
  mergeDeleteResults,
  mergeUpdateResults,
  mergeFanOutResults,
  discardedCallResult,
} = require('./merge-results')
const { classifyQuery } = require('./query-classifier')
const { MtddSqlParseError, parseQueryAst, classifyQueryAsync } = require('./sql-parse')
const astClassifyCache = require('./ast-classify-cache')
const sqlCachePolicy = require('./sql-cache-policy')
const postgresLocal = require('./postgres-local')
const { fanOutOnly } = require('./query-executor')
const lookupPolicy = require('./lookup-policy')
const grpcHub = require('./grpc-hub')

module.exports = {
  install: patch.install,
  ...context,
  ...hooks,
  validateEnvDbHost: hostPolicy.validateEnvDbHost,
  parseHostArray: hostConfig.parseHostArray,
  normalizeConfigHosts: hostConfig.normalizeConfigHosts,
  getWriteHost: hostConfig.getWriteHost,
  getReadHosts: hostConfig.getReadHosts,
  validateLookupUrl: lookupPolicy.validateLookupUrl,
  getGrpcCredentialsFromEnv: require('./grpc-credentials').getGrpcCredentialsFromEnv,
  selectHost: hostSelector.selectHost,
  resetHostCounter: hostSelector.resetHostCounter,
  defaultMergeResults,
  mergeDmlResults,
  mergeDeleteResults,
  mergeUpdateResults,
  mergeFanOutResults,
  discardedCallResult,
  classifyQuery,
  classifyQueryAsync,
  parseQueryAst,
  MtddSqlParseError,
  getSqlClassifyCacheTtlMs: sqlCachePolicy.getSqlClassifyCacheTtlMs,
  closeAstClassifyCache: astClassifyCache.closeAstClassifyCache,
  isAstClassifyRedisConfigured: astClassifyCache.isRedisConfigured,
  verifyLocalPostgres: postgresLocal.verifyLocalPostgres,
  shouldSkipLocalPostgresCheck: postgresLocal.shouldSkipLocalPostgresCheck,
  fanOutOnly,
  initGrpcHub: grpcHub.initGrpcHub,
  closeGrpcHub: grpcHub.closeGrpcHub,
  isGrpcHubReady: grpcHub.isGrpcHubReady,
  useMockTransport: grpcHub.useMockTransport,
  resetGrpcHub: grpcHub.resetGrpcHub,
}
