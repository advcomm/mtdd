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

function mergeDeleteResults(results, options = {}) {
  const { hasReturning = false } = options

  if (!Array.isArray(results) || results.length === 0) {
    return {
      command: 'DELETE',
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
      command: 'DELETE',
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
    command: 'DELETE',
    rowCount,
    oid: first.oid ?? null,
    fields: pickFieldsFromShards(results),
    rows,
  }
}

function mergeFanOutResults(req, results) {
  const classification = classifyQuery(req?.text)
  const hasReturning =
    req?.hasReturning ?? classification.hasReturning

  if (classification.commandType === 'DELETE') {
    return mergeDeleteResults(results, { hasReturning })
  }

  return defaultMergeResults(results)
}

module.exports = {
  defaultMergeResults,
  mergeDeleteResults,
  mergeFanOutResults,
}
