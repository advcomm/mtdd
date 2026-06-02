const grpcHub = require('./grpc-hub')
const { resetNotifyTransport } = require('./mtdd-notify-transport')
const { closeAstClassifyCache } = require('./ast-classify-cache')
const { resetLocalPostgresPool } = require('./postgres-local')

let shutdownHooksRegistered = false
let shuttingDown = false

async function shutdownMtdd() {
  if (shuttingDown) {
    return
  }
  shuttingDown = true

  try {
    resetNotifyTransport()
  } catch {
    // ignore
  }

  try {
    await grpcHub.closeGrpcHub()
  } catch {
    // ignore
  }

  try {
    await closeAstClassifyCache()
  } catch {
    // ignore
  }

  try {
    await resetLocalPostgresPool()
  } catch {
    // ignore
  }
}

function registerAutoShutdown() {
  if (shutdownHooksRegistered) {
    return
  }
  if (process.env.MTDD_AUTO_SHUTDOWN !== '1') {
    return
  }

  shutdownHooksRegistered = true

  const onSignal = () => {
    shutdownMtdd().finally(() => {
      process.exit(0)
    })
  }

  process.once('SIGTERM', onSignal)
  process.once('SIGINT', onSignal)
}

module.exports = {
  shutdownMtdd,
  registerAutoShutdown,
}
