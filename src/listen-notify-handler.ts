const { parseListenNotifyStatement } = require('./listen-notify-parse')
const {
  getNotifyTransport,
  resolveTidScope,
} = require('./mtdd-notify-transport')
const {
  validateNotifyChannel,
  validateNotifyPayload,
} = require('./notify-policy')
const {
  addChannelSubscription,
  removeChannelSubscription,
  clearChannelSubscriptions,
  getLogicalClientId,
} = require('./notification-registry')
const {
  syntheticListenResult,
  syntheticUnlistenResult,
  syntheticNotifyResult,
} = require('./synthetic-results')
async function executeListenNotifyCommand(target, req) {
  const parsed = parseListenNotifyStatement(req.text)
  if (!parsed) {
    throw new Error(
      `@advcomm/mtdd: invalid LISTEN/UNLISTEN/NOTIFY statement: ${req.text}`,
    )
  }

  const transport = getNotifyTransport()
  const tidScope = resolveTidScope(req.tid)
  const logicalClientId = getLogicalClientId(target)

  switch (parsed.commandType) {
    case 'LISTEN': {
      const channel = validateNotifyChannel(parsed.channel)
      await transport.subscribe(logicalClientId, channel, tidScope)
      addChannelSubscription(target, channel, tidScope)
      req.routing = 'notify'
      req.notifyChannel = channel
      return syntheticListenResult()
    }
    case 'UNLISTEN': {
      if (parsed.unlistenAll) {
        await transport.unsubscribeAll(logicalClientId)
        clearChannelSubscriptions(target)
      } else {
        const channel = validateNotifyChannel(parsed.channel)
        await transport.unsubscribe(logicalClientId, channel, tidScope)
        removeChannelSubscription(target, channel, tidScope)
      }
      req.routing = 'notify'
      return syntheticUnlistenResult()
    }
    case 'NOTIFY': {
      const channel = validateNotifyChannel(parsed.channel)
      const payload = validateNotifyPayload(parsed.payload)
      await transport.publish(channel, payload, tidScope)
      req.routing = 'notify'
      req.notifyChannel = channel
      return syntheticNotifyResult()
    }
    default:
      throw new Error(
        `@advcomm/mtdd: unsupported notify command: ${parsed.commandType}`,
      )
  }
}

module.exports = {
  executeListenNotifyCommand,
}
