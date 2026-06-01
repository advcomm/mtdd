const { getWriteHost, getReadHosts } = require('./host-config')

function pickReadEndpoint(shard) {
  if (!shard.reads || shard.reads.length === 0) {
    return shard.write
  }

  const index = shard.readCounter % shard.reads.length
  shard.readCounter += 1
  return shard.reads[index]
}

function resolveShardEndpoint(shard, role) {
  if (role === 'read') {
    return pickReadEndpoint(shard)
  }
  return shard.write
}

function pickReadHostFromEntry(entry, counters, hostIndex) {
  const reads = getReadHosts(entry)
  if (reads.length === 0) {
    return getWriteHost(entry)
  }

  if (!counters[hostIndex]) {
    counters[hostIndex] = 0
  }

  const index = counters[hostIndex] % reads.length
  counters[hostIndex] += 1
  return reads[index]
}

function resolveHostIp(entry, role, counters, hostIndex) {
  if (role === 'read') {
    return pickReadHostFromEntry(entry, counters, hostIndex)
  }
  return getWriteHost(entry)
}

module.exports = {
  pickReadEndpoint,
  resolveShardEndpoint,
  pickReadHostFromEntry,
  resolveHostIp,
}
