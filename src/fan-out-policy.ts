function getFanOutPolicy() {
  const raw = (process.env.MTDD_FANOUT_POLICY ?? 'all').trim().toLowerCase()
  if (raw === 'all' || raw === 'best_effort') {
    return raw
  }
  throw new Error(
    `MTDD_FANOUT_POLICY must be "all" or "best_effort". Received: ${raw}`,
  )
}

async function runFanOut(hostCount, runShard) {
  const policy = getFanOutPolicy()
  const tasks = Array.from({ length: hostCount }, (_, hostIndex) =>
    runShard(hostIndex),
  )

  if (policy === 'all') {
    return Promise.all(tasks)
  }

  const settled = await Promise.allSettled(tasks)
  const results = []
  const errors = []

  for (let hostIndex = 0; hostIndex < settled.length; hostIndex++) {
    const outcome = settled[hostIndex]
    if (outcome.status === 'fulfilled') {
      results[hostIndex] = outcome.value
    } else {
      errors.push({ hostIndex, error: outcome.reason })
    }
  }

  if (errors.length > 0) {
    const detail = errors
      .map((e) => `host_index ${e.hostIndex}: ${e.error?.message ?? e.error}`)
      .join('; ')
    const err = new Error(
      `@advcomm/mtdd: fan-out best_effort failed on ${errors.length}/${hostCount} shard(s): ${detail}`,
    ) as FanOutAggregateError
    err.shardErrors = errors
    err.partialResults = results
    throw err
  }

  return results
}

module.exports = {
  getFanOutPolicy,
  runFanOut,
}
