async function onConnect(req, next) {
  return next()
}

async function onQuery(req, next) {
  return next()
}

async function onSelectHost(req, next) {
  return next()
}

module.exports = {
  onConnect,
  onQuery,
  onSelectHost,
}
