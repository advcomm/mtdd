const { getWriteHost, getReadHosts } = require('../src/host-config')
const { classifyQuery } = require('../src/query-classifier')
const {
  encodePgResultAsChunks,
  decodeQueryStreamToPgResult,
} = require('../src/grpc-query-codec')

function normalizeHostEntryForConnect(entry) {
  if (typeof entry === 'string') {
    return { write: entry, read: [] }
  }
  return entry
}

function createRecordingMockTransport(state) {
  return {
    async connectAll(hosts, credentials) {
      state.connections = []
      const shards = []

      for (let hostIndex = 0; hostIndex < hosts.length; hostIndex++) {
        const entry = normalizeHostEntryForConnect(hosts[hostIndex])
        const writeHost = getWriteHost(entry)

        const write = {
          host: writeHost,
          hostIndex,
          role: 'write',
          credentials: { ...credentials },
          client: { mock: true },
        }
        state.connections.push(write)

        const reads = getReadHosts(entry).map((readHost) => {
          const readEndpoint = {
            host: readHost,
            hostIndex,
            role: 'read',
            credentials: { ...credentials },
            client: { mock: true },
          }
          state.connections.push(readEndpoint)
          return readEndpoint
        })

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
      state.queries.push({
        host: endpoint.host,
        hostIndex: endpoint.hostIndex,
        role: endpoint.role,
        ...request,
      })

      const pgResult = buildMockPgResult(endpoint, request, state)
      return decodeQueryStreamToPgResult(encodePgResultAsChunks(pgResult))
    },

    async disconnectAll(shards) {
      let count = 0
      for (const shard of shards) {
        count += 1 + shard.reads.length
      }
      state.disconnected = (state.disconnected ?? 0) + count
    },
  }
}

function buildMockPgResult(endpoint, request, state) {
      const classification = classifyQuery(request.text)
      if (classification.commandType === 'DELETE') {
        return buildDmlMockResult(endpoint, state, classification, 'DELETE')
      }
      if (classification.commandType === 'UPDATE') {
        return buildDmlMockResult(endpoint, state, classification, 'UPDATE')
      }
      if (classification.commandType === 'INSERT') {
        return buildInsertMockResult(endpoint, state, classification)
      }
      if (classification.commandType === 'CALL') {
        return buildCallMockResult(endpoint, state)
      }

      const fields = state.selectFields ?? []
      const rowsByShard = state.selectRowsByShard
      const rows = rowsByShard
        ? (rowsByShard[endpoint.hostIndex] ??
          rowsByShard[rowsByShard.length - 1] ??
          [])
        : [
            {
              host: endpoint.host,
              host_index: request.host_index,
              endpoint_role: endpoint.role,
              value: 1,
            },
          ]

      return {
        command: 'SELECT',
        rowCount: rows.length,
        oid: null,
        fields,
        rows,
      }
}

function buildDmlMockResult(endpoint, state, classification, command) {
  const rowCountsKey =
    command === 'DELETE' ? 'deleteRowCounts' : 'updateRowCounts'
  const returningRowsKey =
    command === 'DELETE' ? 'deleteReturningRows' : 'updateReturningRows'
  const returningFieldsKey =
    command === 'DELETE' ? 'deleteReturningFields' : 'updateReturningFields'
  const forceRowsKey =
    command === 'DELETE'
      ? 'forceDeleteRowsWithoutReturning'
      : 'forceUpdateRowsWithoutReturning'

  const defaultRowCounts = [3, 2]
  const defaultReturningRows = [
    [{ id: 1 }, { id: 2 }],
    [{ id: 3 }],
  ]

  const rowCounts = state[rowCountsKey] ?? defaultRowCounts
  const rowCount =
    rowCounts[endpoint.hostIndex] ??
    rowCounts[rowCounts.length - 1] ??
    0

  if (!classification.hasReturning) {
    return {
      command,
      rowCount,
      oid: null,
      fields: [],
      rows: state[forceRowsKey] ? [{ id: 'stray' }] : [],
    }
  }

  const returningRowsByShard = state[returningRowsKey] ?? defaultReturningRows
  const rows =
    returningRowsByShard[endpoint.hostIndex] ??
    returningRowsByShard[returningRowsByShard.length - 1] ??
    []

  return {
    command,
    rowCount,
    oid: null,
    fields: state[returningFieldsKey] ?? [{ name: 'id', dataTypeID: 23 }],
    rows,
  }
}

function buildCallMockResult(endpoint, state) {
  const rowCounts = state.callRowCounts ?? [1]
  const rowCount =
    rowCounts[endpoint.hostIndex] ?? rowCounts[rowCounts.length - 1] ?? 1
  const rowsByShard = state.callReturningRows ?? [
    [{ proc: 'ok', host: endpoint.hostIndex }],
  ]
  const rows =
    rowsByShard[endpoint.hostIndex] ??
    rowsByShard[rowsByShard.length - 1] ??
    []

  return {
    command: 'CALL',
    rowCount,
    oid: null,
    fields: state.callReturningFields ?? [{ name: 'proc', dataTypeID: 25 }],
    rows,
  }
}

function buildInsertMockResult(endpoint, state, classification) {
  const rowCounts = state.insertRowCounts ?? [1]
  const rowCount =
    rowCounts[endpoint.hostIndex] ?? rowCounts[rowCounts.length - 1] ?? 1

  if (!classification.hasReturning) {
    return {
      command: 'INSERT',
      rowCount,
      oid: null,
      fields: [],
      rows: [],
    }
  }

  const returningRowsByShard = state.insertReturningRows ?? [
    [{ id: 100, name: 'alpha' }],
  ]
  const rows =
    returningRowsByShard[endpoint.hostIndex] ??
    returningRowsByShard[returningRowsByShard.length - 1] ??
    []

  return {
    command: 'INSERT',
    rowCount,
    oid: null,
    fields: state.insertReturningFields ?? [
      { name: 'id', dataTypeID: 23 },
      { name: 'name', dataTypeID: 25 },
    ],
    rows,
  }
}

module.exports = {
  createRecordingMockTransport,
}
