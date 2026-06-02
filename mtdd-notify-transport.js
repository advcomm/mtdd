const registry = require('./notification-registry')
const { resolveNotifyGrpcAddress } = require('./notify-policy')
const { createGrpcNotifyTransport } = require('./grpc-notify-client')

const SYNTHETIC_PROCESS_ID = 0

let activeTransport = null
let notificationHandler = null

function channelKey(channel, tidScope) {
  return `${tidScope}:${channel}`
}

function createMemoryNotifyTransport() {
  const subscriptions = new Map()

  function getBucket(key) {
    if (!subscriptions.has(key)) {
      subscriptions.set(key, new Set())
    }
    return subscriptions.get(key)
  }

  return {
    kind: 'memory',
    subscriptions,

    async subscribe(logicalClientId, channel, tidScope) {
      const key = channelKey(channel, tidScope)
      getBucket(key).add(logicalClientId)
    },

    async unsubscribe(logicalClientId, channel, tidScope) {
      const key = channelKey(channel, tidScope)
      const bucket = subscriptions.get(key)
      if (bucket) {
        bucket.delete(logicalClientId)
        if (bucket.size === 0) {
          subscriptions.delete(key)
        }
      }
    },

    async unsubscribeAll(logicalClientId) {
      for (const [, bucket] of subscriptions.entries()) {
        bucket.delete(logicalClientId)
      }
    },

    async publish(channel, payload, tidScope) {
      const key = channelKey(channel, tidScope)
      const bucket = subscriptions.get(key)
      if (!bucket || bucket.size === 0) {
        return
      }

      const notification = {
        processId: SYNTHETIC_PROCESS_ID,
        channel,
        payload: payload ?? '',
      }

      for (const logicalClientId of bucket) {
        if (typeof notificationHandler === 'function') {
          notificationHandler(logicalClientId, notification)
        } else {
          registry.dispatchToLogicalClient(logicalClientId, notification)
        }
      }
    },
  }
}

function resolveTidScope(tid) {
  if (tid === undefined || tid === null) {
    return '__global__'
  }
  return String(tid)
}

function setNotificationHandler(handler) {
  notificationHandler = handler
}

function shouldUseMemoryNotifyTransport(options) {
  return (
    options.forceMock === true ||
    process.env.MTDD_NOTIFY_MOCK === '1' ||
    process.env.MTDD_GRPC_MOCK === '1'
  )
}

function initNotifyTransport(options = {}) {
  if (options.transport) {
    activeTransport = options.transport
    return activeTransport
  }

  if (shouldUseMemoryNotifyTransport(options)) {
    activeTransport = createMemoryNotifyTransport()
    return activeTransport
  }

  const address = resolveNotifyGrpcAddress(options.hosts)
  if (address) {
    activeTransport = createGrpcNotifyTransport(address, options.grpcOptions)
    return activeTransport
  }

  activeTransport = createMemoryNotifyTransport()
  return activeTransport
}

function getNotifyTransport() {
  if (!activeTransport) {
    initNotifyTransport()
  }
  return activeTransport
}

function useNotifyTransport(transport) {
  if (activeTransport?.close) {
    activeTransport.close()
  }
  activeTransport = transport
}

function resetNotifyTransport() {
  if (activeTransport?.close) {
    activeTransport.close()
  }
  activeTransport = null
  notificationHandler = null
}

module.exports = {
  SYNTHETIC_PROCESS_ID,
  channelKey,
  resolveTidScope,
  createMemoryNotifyTransport,
  initNotifyTransport,
  getNotifyTransport,
  useNotifyTransport,
  resetNotifyTransport,
  setNotificationHandler,
}
