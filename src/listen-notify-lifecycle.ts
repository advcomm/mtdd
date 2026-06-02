const {
  getLogicalClientId,
  getChannelSubscriptions,
  removeClient,
} = require('./notification-registry')
const { getNotifyTransport } = require('./mtdd-notify-transport')

const MTDD_META = Symbol.for('@advcomm/mtdd.meta')

async function teardownNotifySubscriptions(target) {
  if (!target || typeof target !== 'object' || !target[MTDD_META]) {
    return
  }

  const meta = target[MTDD_META]
  if (meta.kind !== 'checkout') {
    return
  }

  const subscriptions = getChannelSubscriptions(target)
  if (subscriptions.length === 0) {
    removeClient(target)
    return
  }

  const transport = getNotifyTransport()
  const logicalClientId = getLogicalClientId(target)

  if (typeof transport.unsubscribeAll === 'function') {
    await transport.unsubscribeAll(logicalClientId)
  }

  removeClient(target)
}

module.exports = {
  teardownNotifySubscriptions,
}
