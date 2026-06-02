const path = require('node:path')
const registry = require('./notification-registry')
const { getGrpcConnectTimeoutMs } = require('./grpc-policy')

function loadGrpcNotifyClient() {
  const grpc = require('@grpc/grpc-js')
  const protoLoader = require('@grpc/proto-loader')
  const protoPath = path.join(__dirname, 'proto', 'mtdd.proto')

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

function promisifyUnary(client, method, request, deadlineMs) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + deadlineMs
    client[method](request, { deadline }, (err, response) => {
      if (err) {
        reject(err)
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

function createGrpcNotifyTransport(serverAddress, options = {}) {
  const { grpc, MtddNotify } = loadGrpcNotifyClient()
  const deadlineMs = options.deadlineMs ?? getGrpcConnectTimeoutMs()
  const client = new MtddNotify(
    serverAddress,
    grpc.credentials.createInsecure(),
  )
  const watchCalls = new Map()

  function ensureWatch(clientId) {
    if (watchCalls.has(clientId)) {
      return
    }

    const call = client.Watch({ client_id: clientId })
    watchCalls.set(clientId, call)

    call.on('data', (message) => {
      registry.dispatchToLogicalClient(clientId, {
        processId: message.process_id ?? 0,
        channel: message.channel,
        payload: message.payload ?? '',
      })
    })

    call.on('error', () => {
      watchCalls.delete(clientId)
    })

    call.on('end', () => {
      watchCalls.delete(clientId)
    })
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
    },

    async publish(channel, payload, tidScope) {
      await unary('Publish', {
        channel,
        payload: payload ?? '',
        tid_scope: tidScope,
      })
    },

    close() {
      for (const call of watchCalls.values()) {
        call.cancel()
      }
      watchCalls.clear()
      client.close()
    },
  }
}

module.exports = {
  loadGrpcNotifyClient,
  createGrpcNotifyTransport,
}
