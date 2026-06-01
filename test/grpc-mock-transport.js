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
        return buildDeleteMockResult(shard, request, state, classification)
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

function buildDeleteMockResult(shard, request, state, classification) {
  const rowCounts = state.deleteRowCounts ?? [3, 2]
  const rowCount =
    rowCounts[shard.hostIndex] ??
    rowCounts[rowCounts.length - 1] ??
    0

  if (!classification.hasReturning) {
    return {
      command: 'DELETE',
      rowCount,
      oid: null,
      fields: [],
      rows: state.forceDeleteRowsWithoutReturning
        ? [{ id: 'stray' }]
        : [],
    }
  }

  const returningRowsByShard = state.deleteReturningRows ?? [
    [{ id: 1 }, { id: 2 }],
    [{ id: 3 }],
  ]
  const rows =
    returningRowsByShard[shard.hostIndex] ??
    returningRowsByShard[returningRowsByShard.length - 1] ??
    []

  return {
    command: 'DELETE',
    rowCount,
    oid: null,
    fields: state.deleteReturningFields ?? [
      { name: 'id', dataTypeID: 23 },
    ],
    rows,
  }
}

module.exports = {
  createRecordingMockTransport,
}
