const patch = require('./patch')
const context = require('./context')
const hooks = require('./hooks')
const hostPolicy = require('./host-policy')
const hostSelector = require('./host-selector')
const { defaultMergeResults } = require('./merge-results')
const { fanOutOnly } = require('./query-executor')
const lookupPolicy = require('./lookup-policy')

module.exports = {
  install: patch.install,
  ...context,
  ...hooks,
  validateEnvDbHost: hostPolicy.validateEnvDbHost,
  validateLookupUrl: lookupPolicy.validateLookupUrl,
  selectHost: hostSelector.selectHost,
  resetHostCounter: hostSelector.resetHostCounter,
  defaultMergeResults,
  fanOutOnly,
}
