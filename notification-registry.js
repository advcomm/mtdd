const { EventEmitter } = require('node:events')

const NOTIFY_EMITTER = Symbol.for('@advcomm/mtdd.notifyEmitter')

const clientToLogicalId = new WeakMap()
const logicalIdToEntry = new Map()

let nextLogicalId = 1

function getNotifyEmitter(target) {
  if (!target || typeof target !== 'object') {
    throw new Error('@advcomm/mtdd: notification target must be an object')
  }

  if (!target[NOTIFY_EMITTER]) {
    const emitter = new EventEmitter()
    target[NOTIFY_EMITTER] = emitter
    target.on = (...args) => emitter.on(...args)
    target.once = (...args) => emitter.once(...args)
    target.off = (...args) => emitter.off(...args)
    target.removeListener = (...args) => emitter.removeListener(...args)
    target.emit = (...args) => emitter.emit(...args)
  }

  return target[NOTIFY_EMITTER]
}

function getLogicalClientId(target) {
  let id = clientToLogicalId.get(target)
  if (!id) {
    id = `mtdd-notify-${nextLogicalId++}`
    clientToLogicalId.set(target, id)
    logicalIdToEntry.set(id, {
      target,
      channels: new Set(),
    })
  }
  return id
}

function getEntry(logicalClientId) {
  return logicalIdToEntry.get(logicalClientId) ?? null
}

function addChannelSubscription(target, channel) {
  const logicalClientId = getLogicalClientId(target)
  const entry = logicalIdToEntry.get(logicalClientId)
  if (entry) {
    entry.channels.add(channel)
  }
  return logicalClientId
}

function removeChannelSubscription(target, channel) {
  const logicalClientId = clientToLogicalId.get(target)
  if (!logicalClientId) {
    return logicalClientId
  }
  const entry = logicalIdToEntry.get(logicalClientId)
  if (entry) {
    entry.channels.delete(channel)
  }
  return logicalClientId
}

function clearChannelSubscriptions(target) {
  const logicalClientId = clientToLogicalId.get(target)
  if (!logicalClientId) {
    return logicalClientId
  }
  const entry = logicalIdToEntry.get(logicalClientId)
  if (entry) {
    entry.channels.clear()
  }
  return logicalClientId
}

function emitNotification(target, notification) {
  getNotifyEmitter(target).emit('notification', notification)
}

function dispatchToLogicalClient(logicalClientId, notification) {
  const entry = logicalIdToEntry.get(logicalClientId)
  if (!entry) {
    return false
  }
  emitNotification(entry.target, notification)
  return true
}

function clearNotificationRegistryForTests() {
  for (const id of logicalIdToEntry.keys()) {
    logicalIdToEntry.delete(id)
  }
  nextLogicalId = 1
}

module.exports = {
  NOTIFY_EMITTER,
  getNotifyEmitter,
  getLogicalClientId,
  getEntry,
  addChannelSubscription,
  removeChannelSubscription,
  clearChannelSubscriptions,
  emitNotification,
  dispatchToLogicalClient,
  clearNotificationRegistryForTests,
}
