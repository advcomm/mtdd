const preloadLog = require('./preload-logger')

preloadLog.logDebug('register module loading', {
  nodeEnv: process.env.NODE_ENV,
})

require('./patch').install()
