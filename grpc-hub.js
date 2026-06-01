const path = require('node:path')
const { getWriteHost, getReadHosts } = require('./host-config')
const { pickReadEndpoint } = require('./shard-endpoints')
const { getGrpcPort, getGrpcConnectTimeoutMs } = require('./grpc-policy')
const preloadLog = require('./preload-logger')
const { usesArrowResultFormat } = require('./grpc-result-policy')
const grpcArrowCodec = require('./grpc-arrow-codec')

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

function warnReadConnectFailure(writeHost, hostIndex, readHost, err) {
  preloadLog.logGrpcReadConnectWarning(writeHost, hostIndex, readHost, err)
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

function promisifyQueryStream(client, request, deadlineMs) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + deadlineMs
    const chunks = []
    const call = client.QueryStream(request, { deadline })
    call.on('data', (chunk) => chunks.push(chunk))
    call.on('error', reject)
    call.on('end', () => {
      try {
        resolve(grpcArrowCodec.decodeArrowStreamToPgResult(chunks))
      } catch (err) {
        reject(err)
      }
    })
  })
}

function normalizeHostEntryForConnect(entry) {
  if (typeof entry === 'string') {
    return { write: entry, read: [] }
  }
  return entry
}

function buildConnectRequest(hostIndex, credentials, roleHost) {
  return {
    host_index: hostIndex,
    dbname: credentials.database,
    database: credentials.database,
    user: credentials.user,
    password: credentials.password,
    port: credentials.port,
    host: roleHost,
  }
}

function createRealTransport() {
  const { grpc, MtddShard } = loadGrpcClient()
  const grpcPort = getGrpcPort()
  const deadlineMs = getGrpcConnectTimeoutMs()

  async function connectEndpoint(host, hostIndex, credentials, role) {
    const address = `${host}:${grpcPort}`
    const client = new MtddShard(
      address,
      grpc.credentials.createInsecure(),
    )

    const request = buildConnectRequest(hostIndex, credentials, host)

    let response
    try {
      response = await promisifyUnary(client, 'Connect', request, deadlineMs)
    } catch (err) {
      throw new Error(
        `gRPC Connect failed for ${role} host ${host} (host_index ${hostIndex}): ${err.message}`,
      )
    }

    if (!response.ok) {
      throw new Error(
        `gRPC Connect rejected for ${role} host ${host} (host_index ${hostIndex}): ${response.message || 'unknown error'}`,
      )
    }

    return { host, hostIndex, role, client }
  }

  async function queryUnaryJson(endpoint, request, deadlineMs) {
    const response = await promisifyUnary(
      endpoint.client,
      'Query',
      request,
      deadlineMs,
    )

    if (!response.ok) {
      throw new Error(
        `gRPC Query failed on host_index ${request.host_index} (${endpoint.role} ${endpoint.host}): ${response.error || 'unknown error'}`,
      )
    }

    return JSON.parse(response.result_json)
  }

  async function queryStreamArrow(endpoint, request, deadlineMs) {
    return promisifyQueryStream(endpoint.client, request, deadlineMs)
  }

  return {
    async connectAll(hosts, credentials) {
      const shards = []

      for (let hostIndex = 0; hostIndex < hosts.length; hostIndex++) {
        const entry = normalizeHostEntryForConnect(hosts[hostIndex])
        const writeHost = getWriteHost(entry)
        const write = await connectEndpoint(
          writeHost,
          hostIndex,
          credentials,
          'write',
        )

        const reads = []
        for (const readHost of getReadHosts(entry)) {
          try {
            const readEndpoint = await connectEndpoint(
              readHost,
              hostIndex,
              credentials,
              'read',
            )
            reads.push(readEndpoint)
          } catch (err) {
            warnReadConnectFailure(writeHost, hostIndex, readHost, err)
          }
        }

        shards.push({
          hostIndex,
          write,
          reads,
          readCounter: 0,
          host: writeHost,
        })
      }

      return shards
    },

    async query(endpoint, request, deadlineMs) {
      if (usesArrowResultFormat()) {
        return queryStreamArrow(endpoint, request, deadlineMs)
      }
      return queryUnaryJson(endpoint, request, deadlineMs)
    },

    async disconnectAll(shards) {
      const endpoints = []
      for (const shard of shards) {
        endpoints.push(shard.write, ...shard.reads)
      }

      const closes = endpoints.map(async (endpoint) => {
        try {
          await promisifyUnary(
            endpoint.client,
            'Disconnect',
            { host_index: endpoint.hostIndex },
            deadlineMs,
          )
        } catch {
          // ignore disconnect errors during shutdown
        }
        endpoint.client.close()
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
        const entry = normalizeHostEntryForConnect(hosts[hostIndex])
        const writeHost = getWriteHost(entry)
        const write = {
          host: writeHost,
          hostIndex,
          role: 'write',
          client: { mock: true },
          credentials,
        }

        const reads = getReadHosts(entry).map((readHost) => ({
          host: readHost,
          hostIndex,
          role: 'read',
          client: { mock: true },
          credentials,
        }))

        shards.push({
          hostIndex,
          write,
          reads,
          readCounter: 0,
          host: writeHost,
        })
      }
      return shards
    },

    async query(endpoint, request) {
      return {
        command: 'SELECT',
        rowCount: 1,
        oid: null,
        fields: [],
        rows: [
          {
            host: endpoint.host,
            host_index: request.host_index,
            endpoint_role: endpoint.role,
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
    hosts: hosts.map((entry) => normalizeHostEntryForConnect(entry)),
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
  return grpcArrowCodec.buildQueryRequestPayload(hostIndex, req, sessionId)
}

async function queryShard(hostIndex, req, sessionId, role = 'write') {
  const state = requireShardState()
  const shard = state.shards[hostIndex]

  if (!shard) {
    throw new Error(
      `@advcomm/mtdd: no gRPC connection for host_index ${hostIndex}`,
    )
  }

  const endpoint =
    role === 'read' ? pickReadEndpoint(shard) : shard.write

  const activeTransport = getTransport()
  const request = buildQueryRequest(hostIndex, req, sessionId)
  const deadlineMs = getGrpcConnectTimeoutMs()
  return activeTransport.query(endpoint, request, deadlineMs)
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
  buildConnectRequest,
  warnReadConnectFailure,
}
