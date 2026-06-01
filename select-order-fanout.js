const { parse, toSql } = require('pgsql-ast-parser')
const { MtddSqlParseError } = require('./sql-parse')

function previewSql(sql) {
  if (typeof sql !== 'string') {
    return ''
  }
  const oneLine = sql.replace(/\s+/g, ' ').trim()
  return oneLine.length > 120 ? `${oneLine.slice(0, 117)}...` : oneLine
}

function parseSelectStatement(text) {
  let statements
  try {
    statements = parse(text, { locationTracking: false })
  } catch (err) {
    throw new MtddSqlParseError(
      `@advcomm/mtdd: unable to parse SQL for ordered fan-out (${err.message}). SQL: ${previewSql(text)}`,
      text,
    )
  }

  if (!Array.isArray(statements) || statements.length !== 1) {
    throw new MtddSqlParseError(
      `@advcomm/mtdd: multi-statement SQL is not supported for ordered fan-out. SQL: ${previewSql(text)}`,
      text,
    )
  }

  const stmt = statements[0]
  const select = resolveSelectNode(stmt)
  if (!select) {
    throw new MtddSqlParseError(
      `@advcomm/mtdd: ordered fan-out requires a SELECT statement. SQL: ${previewSql(text)}`,
      text,
    )
  }

  return { stmt, select }
}

function resolveSelectNode(stmt) {
  if (!stmt || typeof stmt !== 'object') {
    return null
  }
  if (stmt.type === 'with' && stmt.in) {
    return resolveSelectNode(stmt.in)
  }
  if (stmt.type === 'select') {
    return stmt
  }
  return null
}

function selectHasOrderBy(select) {
  return Array.isArray(select?.orderBy) && select.orderBy.length > 0
}

function selectHasOffset(select) {
  return select?.limit?.offset != null
}

function isSimpleSingleTableFrom(select) {
  if (!Array.isArray(select.from) || select.from.length !== 1) {
    return false
  }
  return select.from[0].type === 'table'
}

function tableRefName(tableRef) {
  if (!tableRef?.name) {
    return null
  }
  if (typeof tableRef.name === 'string') {
    return tableRef.name
  }
  if (typeof tableRef.name.name === 'string') {
    return tableRef.name.name
  }
  return null
}

function getPrimaryFromTable(select) {
  if (!isSimpleSingleTableFrom(select)) {
    return null
  }
  const tableRef = select.from[0]
  const name = tableRefName(tableRef)
  if (!name) {
    return null
  }
  return { name, alias: tableRef.alias ?? null }
}

function cloneStatement(stmt) {
  return JSON.parse(JSON.stringify(stmt))
}

function stripGlobalSortFromSelect(select) {
  delete select.orderBy
  delete select.limit
}

/**
 * For fan-out SELECT with ORDER BY: shard SQL omits ORDER BY and LIMIT;
 * full SQL (with LIMIT, without OFFSET) is re-run on localhost after merge.
 */
function splitSelectForOrderedFanOut(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    return { needsLocalReorder: false }
  }

  const { stmt, select } = parseSelectStatement(text)
  if (!selectHasOrderBy(select)) {
    return { needsLocalReorder: false }
  }

  const primaryTable = getPrimaryFromTable(select)
  if (!primaryTable) {
    throw new MtddSqlParseError(
      `@advcomm/mtdd: ORDER BY fan-out requires a single-table FROM clause (no joins). SQL: ${previewSql(text)}`,
      text,
    )
  }

  if (selectHasOffset(select)) {
    throw new MtddSqlParseError(
      `@advcomm/mtdd: OFFSET is not supported for ORDER BY fan-out across shards (results are not reliable when aggregating). SQL: ${previewSql(text)}`,
      text,
    )
  }

  const fanOutStmt = cloneStatement(stmt)
  const fanOutSelect = resolveSelectNode(fanOutStmt)
  stripGlobalSortFromSelect(fanOutSelect)

  return {
    needsLocalReorder: true,
    fanOutText: toSql.statement(fanOutStmt),
    fullText: text,
    tempTableName: primaryTable.name,
  }
}

module.exports = {
  splitSelectForOrderedFanOut,
  parseSelectStatement,
  resolveSelectNode,
  selectHasOrderBy,
  selectHasOffset,
  getPrimaryFromTable,
  isSimpleSingleTableFrom,
}
