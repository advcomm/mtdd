const patch = require('./patch')
const context = require('./context')
const hooks = require('./hooks')
const hostPolicy = require('./host-policy')
const hostSelector = require('./host-selector')
const { defaultMergeResults } = require('./merge-results')
const { fanOutOnly } = require('./query-executor')
const lookupPolicy = require('./lookup-policy')
const grpcHub = require('./grpc-hub')

module.exports = {
  install: patch.install,
  ...context,
  ...hooks,
  validateEnvDbHost: hostPolicy.validateEnvDbHost,
  validateLookupUrl: lookupPolicy.validateLookupUrl,
  getGrpcCredentialsFromEnv: require('./grpc-credentials').getGrpcCredentialsFromEnv,
  selectHost: hostSelector.selectHost,
  resetHostCounter: hostSelector.resetHostCounter,
  defaultMergeResults,
  fanOutOnly,
  initGrpcHub: grpcHub.initGrpcHub,
  closeGrpcHub: grpcHub.closeGrpcHub,
  isGrpcHubReady: grpcHub.isGrpcHubReady,
  useMockTransport: grpcHub.useMockTransport,
  resetGrpcHub: grpcHub.resetGrpcHub,
}
