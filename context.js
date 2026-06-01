const { AsyncLocalStorage } = require('node:async_hooks')

const mtddStorage = new AsyncLocalStorage()

function runWithMtddContext(context, fn) {
  return mtddStorage.run(context, fn)
}

function getMtddContext() {
  return mtddStorage.getStore()
}

module.exports = {
  runWithMtddContext,
  getMtddContext,
}
