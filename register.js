const preloadLog = require('./preload-logger')

preloadLog.logDebug('register module loading', {
  nodeEnv: process.env.NODE_ENV,
})

const { install } = require('./patch')
const { registerAutoShutdown } = require('./shutdown')

install()
registerAutoShutdown()
