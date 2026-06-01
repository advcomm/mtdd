const { classifyQuery } = require('./query-classifier')

function sumRowCount(results) {
  let rowCount = 0
  for (const result of results) {
    if (typeof result.rowCount === 'number') {
      rowCount += result.rowCount
    }
  }
  return rowCount
}

function pickFieldsFromShards(results) {
  for (const result of results) {
    if (result.fields && result.fields.length > 0) {
      return [...result.fields]
    }
  }
  const first = results[0]
  return first?.fields ? [...first.fields] : []
}

function defaultMergeResults(results) {
  if (!Array.isArray(results) || results.length === 0) {
    return {
      command: 'SELECT',
      rowCount: 0,
      oid: null,
      fields: [],
      rows: [],
    }
  }

  const first = results[0]
  const rows = []
  let rowCount = 0

  for (const result of results) {
    if (result.rows && result.rows.length > 0) {
      rows.push(...result.rows)
    }
    if (typeof result.rowCount === 'number') {
      rowCount += result.rowCount
    }
  }

  return {
    command: first.command ?? 'SELECT',
    rowCount,
    oid: first.oid ?? null,
    fields: first.fields ? [...first.fields] : [],
    rows,
  }
}

function mergeDmlResults(results, options = {}) {
  const { command = 'UPDATE', hasReturning = false } = options

  if (!Array.isArray(results) || results.length === 0) {
    return {
      command,
      rowCount: 0,
      oid: null,
      fields: [],
      rows: [],
    }
  }

  const first = results[0]
  const rowCount = sumRowCount(results)

  if (!hasReturning) {
    return {
      command,
      rowCount,
      oid: first.oid ?? null,
      fields: [],
      rows: [],
    }
  }

  const rows = []
  for (const result of results) {
    if (result.rows && result.rows.length > 0) {
      rows.push(...result.rows)
    }
  }

  return {
    command,
    rowCount,
    oid: first.oid ?? null,
    fields: pickFieldsFromShards(results),
    rows,
  }
}

function mergeDeleteResults(results, options = {}) {
  return mergeDmlResults(results, { ...options, command: 'DELETE' })
}

function mergeUpdateResults(results, options = {}) {
  return mergeDmlResults(results, { ...options, command: 'UPDATE' })
}

function mergeFanOutResults(req, results) {
  const classification = classifyQuery(req?.text)
  const hasReturning =
    req?.hasReturning ?? classification.hasReturning

  if (classification.commandType === 'DELETE') {
    return mergeDeleteResults(results, { hasReturning })
  }

  if (classification.commandType === 'UPDATE') {
    return mergeUpdateResults(results, { hasReturning })
  }

  if (classification.commandType === 'INSERT') {
    throw new Error(
      '@advcomm/mtdd: INSERT results must not be merged; route INSERT with tid to a single shard.',
    )
  }

  if (classification.commandType === 'CALL') {
    throw new Error(
      '@advcomm/mtdd: CALL results must not be merged; route CALL with a tenant tid or tid: null for all shards.',
    )
  }

  return defaultMergeResults(results)
}

function discardedCallResult() {
  return {
    command: 'CALL',
    rowCount: 0,
    oid: null,
    fields: [],
    rows: [],
  }
}

module.exports = {
  defaultMergeResults,
  mergeDmlResults,
  mergeDeleteResults,
  mergeUpdateResults,
  mergeFanOutResults,
  discardedCallResult,
}
