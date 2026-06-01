const { parseEnvDbHost } = require('./host-config')

function validateEnvDbHost() {
  return parseEnvDbHost()
}

module.exports = {
  validateEnvDbHost,
}
