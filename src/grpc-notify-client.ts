const path = require('node:path')
const registry = require('./notification-registry')
const { getGrpcConnectTimeoutMs } = require('./grpc-policy')
const { createNotifyChannelCredentials } = require('./grpc-tls')
const preloadLog = require('./preload-logger')

function loadGrpcNotifyClient() {
  const grpc = require('@grpc/grpc-js')
  const protoLoader = require('@grpc/proto-loader')
  const protoPath = require('./proto-path').getProtoPath()

  const packageDefinition = protoLoader.loadSync(protoPath, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  })

  const proto = grpc.loadPackageDefinition(packageDefinition).mtdd
  return { grpc, MtddNotify: proto.MtddNotify }
}

function formatNotifyGrpcError(method, err) {
  const detail = err?.details || err?.message || String(err)
  return new Error(`MtddNotify.${method} failed: ${detail}`)
}

function promisifyUnary(client, method, request, deadlineMs) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + deadlineMs
    client[method](request, { deadline }, (err, response) => {
      if (err) {
        reject(formatNotifyGrpcError(method, err))
        return
      }
      resolve(response)
    })
  })
}

function assertNotifyAck(method, response) {
  if (!response?.ok) {
    throw new Error(
      `MtddNotify.${method} failed: ${response?.message || 'unknown error'}`,
    )
  }
  return response
}

function getWatchReconnectDelayMs(attempt) {
  const base = Number(process.env.MTDD_NOTIFY_WATCH_RECONNECT_MS ?? 1000)
  return Math.min(base * 2 ** attempt, 30_000)
}

function createGrpcNotifyTransport(
  serverAddress,
  options: {
    deadlineMs?: number
    onWatchError?: (clientId: string, err: Error) => void
  } = {},
) {
  const { grpc, MtddNotify } = loadGrpcNotifyClient()
  const deadlineMs = options.deadlineMs ?? getGrpcConnectTimeoutMs()
  const channelCredentials = createNotifyChannelCredentials(grpc)
  const client = new MtddNotify(serverAddress, channelCredentials)
  const watchCalls = new Map()
  const watchReconnectAttempts = new Map()
  let closed = false

  async function resubscribeAll(clientId) {
    const subscriptions = registry.getChannelSubscriptionsForClientId(clientId)
    for (const { channel, tidScope } of subscriptions) {
      await unary('Subscribe', {
        client_id: clientId,
        channel,
        tid_scope: tidScope,
      })
    }
  }

  function scheduleWatchReconnect(clientId) {
    if (closed || watchCalls.has(clientId)) {
      return
    }

    const attempt = watchReconnectAttempts.get(clientId) ?? 0
    watchReconnectAttempts.set(clientId, attempt + 1)
    const delayMs = getWatchReconnectDelayMs(attempt)

    preloadLog.logWarn('notify watch reconnect scheduled', {
      clientId,
      attempt: attempt + 1,
      delayMs,
      serverAddress,
    })

    setTimeout(() => {
      if (closed) {
        return
      }
      startWatch(clientId, true).catch((err) => {
        preloadLog.logWarn('notify watch reconnect failed', {
          clientId,
          err: err?.message ?? String(err),
        })
        scheduleWatchReconnect(clientId)
      })
    }, delayMs)
  }

  async function startWatch(clientId, isReconnect = false) {
    if (closed || watchCalls.has(clientId)) {
      return
    }

    const call = client.Watch({ client_id: clientId })
    watchCalls.set(clientId, call)

    call.on('data', (message) => {
      watchReconnectAttempts.set(clientId, 0)
      registry.dispatchToLogicalClient(clientId, {
        processId: message.process_id ?? 0,
        channel: message.channel,
        payload: message.payload ?? '',
      })
    })

    call.on('error', (err) => {
      watchCalls.delete(clientId)
      if (closed) {
        return
      }
      preloadLog.logWarn('notify watch stream error', {
        clientId,
        err: err?.message ?? String(err),
      })
      if (options.onWatchError) {
        options.onWatchError(clientId, err)
      }
      scheduleWatchReconnect(clientId)
    })

    call.on('end', () => {
      watchCalls.delete(clientId)
      if (!closed) {
        scheduleWatchReconnect(clientId)
      }
    })

    if (isReconnect) {
      await resubscribeAll(clientId)
    }
  }

  function ensureWatch(clientId) {
    if (!watchCalls.has(clientId)) {
      startWatch(clientId, false).catch((err) => {
        preloadLog.logWarn('notify watch start failed', {
          clientId,
          err: err?.message ?? String(err),
        })
        scheduleWatchReconnect(clientId)
      })
    }
  }

  async function unary(method, request) {
    const response = await promisifyUnary(client, method, request, deadlineMs)
    return assertNotifyAck(method, response)
  }

  return {
    kind: 'grpc',
    serverAddress,
    watchCalls,

    async subscribe(logicalClientId, channel, tidScope) {
      ensureWatch(logicalClientId)
      await unary('Subscribe', {
        client_id: logicalClientId,
        channel,
        tid_scope: tidScope,
      })
    },

    async unsubscribe(logicalClientId, channel, tidScope) {
      await unary('Unsubscribe', {
        client_id: logicalClientId,
        channel,
        tid_scope: tidScope,
      })
    },

    async unsubscribeAll(logicalClientId) {
      await unary('UnsubscribeAll', {
        client_id: logicalClientId,
      })
      const call = watchCalls.get(logicalClientId)
      if (call) {
        call.cancel()
        watchCalls.delete(logicalClientId)
      }
      watchReconnectAttempts.delete(logicalClientId)
    },

    async publish(channel, payload, tidScope) {
      await unary('Publish', {
        channel,
        payload: payload ?? '',
        tid_scope: tidScope,
      })
    },

    close() {
      closed = true
      for (const call of watchCalls.values()) {
        call.cancel()
      }
      watchCalls.clear()
      watchReconnectAttempts.clear()
      client.close()
    },
  }
}

module.exports = {
  loadGrpcNotifyClient,
  createGrpcNotifyTransport,
}
