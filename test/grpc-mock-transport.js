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

module.exports = {
  createRecordingMockTransport,
}
