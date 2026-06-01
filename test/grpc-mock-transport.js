const { classifyQuery } = require('../query-classifier')

function createRecordingMockTransport(state) {
  return {
    async connectAll(hosts, credentials) {
      state.connections = []
      const shards = []

      for (let hostIndex = 0; hostIndex < hosts.length; hostIndex++) {
        state.connections.push({
          host: hosts[hostIndex],
          hostIndex,
          credentials: { ...credentials },
        })
        shards.push({
          host: hosts[hostIndex],
          hostIndex,
          client: { mock: true },
        })
      }

      return shards
    },

    async query(shard, request) {
      state.queries.push({
        host: shard.host,
        hostIndex: shard.hostIndex,
        ...request,
      })

      const classification = classifyQuery(request.text)
      if (classification.commandType === 'DELETE') {
        return buildDmlMockResult(shard, state, classification, 'DELETE')
      }
      if (classification.commandType === 'UPDATE') {
        return buildDmlMockResult(shard, state, classification, 'UPDATE')
      }
      if (classification.commandType === 'INSERT') {
        return buildInsertMockResult(shard, state, classification)
      }
      if (classification.commandType === 'CALL') {
        return buildCallMockResult(shard, state)
      }

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

    async disconnectAll(shards) {
      state.disconnected = (state.disconnected ?? 0) + shards.length
    },
  }
}

function buildDmlMockResult(shard, state, classification, command) {
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
    rowCounts[shard.hostIndex] ??
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
    returningRowsByShard[shard.hostIndex] ??
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

function buildCallMockResult(shard, state) {
  const rowCounts = state.callRowCounts ?? [1]
  const rowCount =
    rowCounts[shard.hostIndex] ?? rowCounts[rowCounts.length - 1] ?? 1
  const rowsByShard = state.callReturningRows ?? [
    [{ proc: 'ok', host: shard.hostIndex }],
  ]
  const rows =
    rowsByShard[shard.hostIndex] ??
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

function buildInsertMockResult(shard, state, classification) {
  const rowCounts = state.insertRowCounts ?? [1]
  const rowCount =
    rowCounts[shard.hostIndex] ?? rowCounts[rowCounts.length - 1] ?? 1

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
    returningRowsByShard[shard.hostIndex] ??
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
