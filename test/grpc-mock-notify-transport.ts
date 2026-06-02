const registry = require('../src/notification-registry')
const { channelKey } = require('../src/mtdd-notify-transport')

/**
 * In-process MtddNotify coordinator (Subscribe / Publish / Watch semantics).
 */
function createGrpcMockNotifyTransport() {
  const subscriptions = new Map()
  const watchEmitters = new Map()

  function getBucket(key) {
    if (!subscriptions.has(key)) {
      subscriptions.set(key, new Set())
    }
    return subscriptions.get(key)
  }

  function getWatchEmitter(clientId) {
    if (!watchEmitters.has(clientId)) {
      watchEmitters.set(clientId, { listeners: new Set() })
    }
    return watchEmitters.get(clientId)
  }

  function pushToWatch(clientId, message) {
    const emitter = watchEmitters.get(clientId)
    if (!emitter) {
      return
    }
    for (const listener of emitter.listeners) {
      listener(message)
    }
    registry.dispatchToLogicalClient(clientId, {
      processId: message.process_id ?? 0,
      channel: message.channel,
      payload: message.payload ?? '',
    })
  }

  const calls = {
    subscribe: [],
    unsubscribe: [],
    unsubscribeAll: [],
    publish: [],
    watch: [],
  }

  return {
    kind: 'grpc-mock',
    subscriptions,
    calls,

    ensureWatch(clientId) {
      calls.watch.push({ client_id: clientId })
      getWatchEmitter(clientId)
    },

    async subscribe(clientId, channel, tidScope) {
      calls.subscribe.push({ client_id: clientId, channel, tid_scope: tidScope })
      this.ensureWatch(clientId)
      const key = channelKey(channel, tidScope)
      getBucket(key).add(clientId)
    },

    async unsubscribe(clientId, channel, tidScope) {
      calls.unsubscribe.push({ client_id: clientId, channel, tid_scope: tidScope })
      const key = channelKey(channel, tidScope)
      const bucket = subscriptions.get(key)
      if (bucket) {
        bucket.delete(clientId)
        if (bucket.size === 0) {
          subscriptions.delete(key)
        }
      }
    },

    async unsubscribeAll(clientId) {
      calls.unsubscribeAll.push({ client_id: clientId })
      for (const bucket of subscriptions.values()) {
        bucket.delete(clientId)
      }
      watchEmitters.delete(clientId)
    },

    async publish(channel, payload, tidScope) {
      calls.publish.push({ channel, payload, tid_scope: tidScope })
      const key = channelKey(channel, tidScope)
      const bucket = subscriptions.get(key)
      if (!bucket || bucket.size === 0) {
        return { ok: true, delivered_count: 0 }
      }

      const message = {
        channel,
        payload: payload ?? '',
        process_id: 0,
      }

      let delivered = 0
      for (const clientId of bucket) {
        pushToWatch(clientId, message)
        delivered += 1
      }
      return { ok: true, delivered_count: delivered }
    },
  }
}

module.exports = {
  createGrpcMockNotifyTransport,
}
