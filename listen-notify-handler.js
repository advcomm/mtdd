const { parseListenNotifyStatement } = require('./listen-notify-parse')
const {
  getNotifyTransport,
  resolveTidScope,
} = require('./mtdd-notify-transport')
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
      await transport.subscribe(logicalClientId, parsed.channel, tidScope)
      addChannelSubscription(target, parsed.channel)
      req.routing = 'notify'
      req.notifyChannel = parsed.channel
      return syntheticListenResult()
    }
    case 'UNLISTEN': {
      if (parsed.unlistenAll) {
        await transport.unsubscribeAll(logicalClientId)
        clearChannelSubscriptions(target)
      } else {
        await transport.unsubscribe(logicalClientId, parsed.channel, tidScope)
        removeChannelSubscription(target, parsed.channel)
      }
      req.routing = 'notify'
      return syntheticUnlistenResult()
    }
    case 'NOTIFY': {
      await transport.publish(parsed.channel, parsed.payload, tidScope)
      req.routing = 'notify'
      req.notifyChannel = parsed.channel
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
