const patch = require('./patch')
const context = require('./context')
const hooks = require('./hooks')
const hostPolicy = require('./host-policy')
const hostSelector = require('./host-selector')

module.exports = {
  install: patch.install,
  ...context,
  ...hooks,
  validateEnvDbHost: hostPolicy.validateEnvDbHost,
  selectHost: hostSelector.selectHost,
  resetHostCounter: hostSelector.resetHostCounter,
}
