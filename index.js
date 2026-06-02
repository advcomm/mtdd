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
const localMergePolicy = require('./local-merge-policy')
const { fanOutOnly } = require('./query-executor')
const lookupPolicy = require('./lookup-policy')
const grpcHub = require('./grpc-hub')
const preloadLogger = require('./preload-logger')
const grpcArrowCodec = require('./grpc-arrow-codec')
const notifyTransport = require('./mtdd-notify-transport')
const notificationRegistry = require('./notification-registry')
const listenNotifyParse = require('./listen-notify-parse')
const syntheticResults = require('./synthetic-results')

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
  getLocalPostgresPool: postgresLocal.getLocalPostgresPool,
  resetLocalPostgresPool: postgresLocal.resetLocalPostgresPool,
  shouldSkipLocalPostgresCheck: postgresLocal.shouldSkipLocalPostgresCheck,
  getUnnestMergeThreshold: localMergePolicy.getUnnestMergeThreshold,
  getCopyMergeThreshold: localMergePolicy.getCopyMergeThreshold,
  getIndexMergeThreshold: localMergePolicy.getIndexMergeThreshold,
  rewriteQueryTableNameAst: require('./select-order-rewrite').rewriteQueryTableNameAst,
  splitSelectForLocalFanOut: require('./select-local-fanout').splitSelectForLocalFanOut,
  splitSelectForOrderedFanOut: require('./select-local-fanout').splitSelectForOrderedFanOut,
  fanOutOnly,
  initGrpcHub: grpcHub.initGrpcHub,
  closeGrpcHub: grpcHub.closeGrpcHub,
  isGrpcHubReady: grpcHub.isGrpcHubReady,
  useMockTransport: grpcHub.useMockTransport,
  resetGrpcHub: grpcHub.resetGrpcHub,
  getPreloadLogConfig: preloadLogger.getPreloadLogConfig,
  resolvePreloadEnv: preloadLogger.resolvePreloadEnv,
  buildQueryRequestPayload: grpcArrowCodec.buildQueryRequestPayload,
  decodeArrowStreamToPgResult: grpcArrowCodec.decodeArrowStreamToPgResult,
  decodeQueryParamsForTest: grpcArrowCodec.decodeQueryParamsForTest,
  parseListenNotifyStatement: listenNotifyParse.parseListenNotifyStatement,
  isListenNotifyCommandType: listenNotifyParse.isListenNotifyCommandType,
  initNotifyTransport: notifyTransport.initNotifyTransport,
  getNotifyTransport: notifyTransport.getNotifyTransport,
  useNotifyTransport: notifyTransport.useNotifyTransport,
  resetNotifyTransport: notifyTransport.resetNotifyTransport,
  createMemoryNotifyTransport: notifyTransport.createMemoryNotifyTransport,
  getLogicalClientId: notificationRegistry.getLogicalClientId,
  clearNotificationRegistryForTests:
    notificationRegistry.clearNotificationRegistryForTests,
  syntheticListenResult: syntheticResults.syntheticListenResult,
  syntheticUnlistenResult: syntheticResults.syntheticUnlistenResult,
  syntheticNotifyResult: syntheticResults.syntheticNotifyResult,
}
