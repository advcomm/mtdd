const path = require('node:path')
const { getGrpcPort, getGrpcConnectTimeoutMs } = require('./grpc-policy')

let transport = null
let shardState = null

function useMockTransport(mock) {
  transport = mock
  shardState = null
}

function resetGrpcHub() {
  transport = null
  shardState = null
}

function getShardState() {
  return shardState
}

function loadGrpcClient() {
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
  return { grpc, MtddShard: proto.MtddShard }
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

function createRealTransport() {
  const { grpc, MtddShard } = loadGrpcClient()
  const grpcPort = getGrpcPort()
  const deadlineMs = getGrpcConnectTimeoutMs()

  return {
    async connectAll(hosts, credentials) {
      const shards = []

      for (let hostIndex = 0; hostIndex < hosts.length; hostIndex++) {
        const host = hosts[hostIndex]
        const address = `${host}:${grpcPort}`
        const client = new MtddShard(
          address,
          grpc.credentials.createInsecure(),
        )

        const request = {
          host_index: hostIndex,
          database: credentials.database,
          user: credentials.user,
          password: credentials.password,
          port: credentials.port,
        }

        let response
        try {
          response = await promisifyUnary(
            client,
            'Connect',
            request,
            deadlineMs,
          )
        } catch (err) {
          throw new Error(
            `gRPC Connect failed for host ${host} (host_index ${hostIndex}): ${err.message}`,
          )
        }

        if (!response.ok) {
          throw new Error(
            `gRPC Connect rejected for host ${host} (host_index ${hostIndex}): ${response.message || 'unknown error'}`,
          )
        }

        shards.push({ host, hostIndex, client })
      }

      return shards
    },

    async query(shard, request, deadlineMs) {
      const response = await promisifyUnary(
        shard.client,
        'Query',
        request,
        deadlineMs,
      )

      if (!response.ok) {
        throw new Error(
          `gRPC Query failed on host_index ${request.host_index}: ${response.error || 'unknown error'}`,
        )
      }

      return JSON.parse(response.result_json)
    },

    async disconnectAll(shards) {
      const closes = shards.map(async (shard) => {
        try {
          await promisifyUnary(
            shard.client,
            'Disconnect',
            { host_index: shard.hostIndex },
            deadlineMs,
          )
        } catch {
          // ignore disconnect errors during shutdown
        }
        shard.client.close()
      })
      await Promise.all(closes)
    },
  }
}

function createDefaultMockTransport() {
  return {
    async connectAll(hosts, credentials) {
      const shards = []
      for (let hostIndex = 0; hostIndex < hosts.length; hostIndex++) {
        shards.push({
          host: hosts[hostIndex],
          hostIndex,
          client: { mock: true },
          credentials,
        })
      }
      return shards
    },

    async query(shard, request) {
      return {
        command: 'SELECT',
        rowCount: 1,
        oid: null,
        fields: [],
        rows: [
          {
            host: shard.host,
            host_index: request.host_index,
            value: 1,
          },
        ],
      }
    },

    async disconnectAll() {},
  }
}

function getTransport() {
  if (process.env.MTDD_GRPC_MOCK === '1') {
    if (!transport) {
      transport = createDefaultMockTransport()
    }
    return transport
  }

  if (!transport) {
    transport = createRealTransport()
  }
  return transport
}

async function initGrpcHub(hosts, credentials) {
  if (shardState) {
    return shardState
  }

  const activeTransport = getTransport()
  let shards
  try {
    shards = await activeTransport.connectAll(hosts, credentials)
  } catch (err) {
    shardState = null
    throw err
  }

  if (shards.length !== hosts.length) {
    throw new Error(
      `@advcomm/mtdd: expected ${hosts.length} gRPC shard connections, got ${shards.length}`,
    )
  }

  shardState = {
    hosts: [...hosts],
    credentials: { ...credentials },
    shards,
  }

  return shardState
}

function requireShardState() {
  if (!shardState) {
    throw new Error(
      '@advcomm/mtdd: gRPC hub is not initialized. Ensure @advcomm/mtdd/register loaded successfully.',
    )
  }
  return shardState
}

function buildQueryRequest(hostIndex, req, sessionId) {
  const query = {
    host_index: hostIndex,
    text: req.text ?? '',
    values_json: JSON.stringify(req.values ?? []),
    name: req.name ?? '',
    row_mode: req.row_mode ?? '',
    session_id: sessionId ?? '',
  }
  return query
}

async function queryShard(hostIndex, req, sessionId) {
  const state = requireShardState()
  const shard = state.shards[hostIndex]

  if (!shard) {
    throw new Error(
      `@advcomm/mtdd: no gRPC connection for host_index ${hostIndex}`,
    )
  }

  const activeTransport = getTransport()
  const request = buildQueryRequest(hostIndex, req, sessionId)
  const deadlineMs = getGrpcConnectTimeoutMs()
  return activeTransport.query(shard, request, deadlineMs)
}

async function closeGrpcHub() {
  if (!shardState) {
    return
  }

  const activeTransport = getTransport()
  await activeTransport.disconnectAll(shardState.shards)
  shardState = null
}

function isGrpcHubReady() {
  return shardState !== null
}

module.exports = {
  initGrpcHub,
  queryShard,
  closeGrpcHub,
  isGrpcHubReady,
  getShardState,
  useMockTransport,
  resetGrpcHub,
  buildQueryRequest,
}
