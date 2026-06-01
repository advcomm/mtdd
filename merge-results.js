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

module.exports = {
  defaultMergeResults,
}
