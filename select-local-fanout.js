const { toSql } = require('pgsql-ast-parser')
const { MtddSqlParseError } = require('./sql-parse')

const SUPPORTED_AGGREGATE_FUNCTIONS = new Set([
  'sum',
  'min',
  'max',
  'count',
  'avg',
  'stddev',
  'stddev_pop',
  'stddev_samp',
  'var',
  'var_pop',
  'var_samp',
])

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
    const { parse } = require('pgsql-ast-parser')
    statements = parse(text, { locationTracking: false })
  } catch (err) {
    throw new MtddSqlParseError(
      `@advcomm/mtdd: unable to parse SQL for local fan-out (${err.message}). SQL: ${previewSql(text)}`,
      text,
    )
  }

  if (!Array.isArray(statements) || statements.length !== 1) {
    throw new MtddSqlParseError(
      `@advcomm/mtdd: multi-statement SQL is not supported for local fan-out. SQL: ${previewSql(text)}`,
      text,
    )
  }

  const stmt = statements[0]
  const select = resolveSelectNode(stmt)
  if (!select) {
    throw new MtddSqlParseError(
      `@advcomm/mtdd: local fan-out requires a SELECT statement. SQL: ${previewSql(text)}`,
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

function aggregateFunctionName(callNode) {
  if (callNode?.type !== 'call' || !callNode.function?.name) {
    return null
  }
  return String(callNode.function.name).toLowerCase()
}

function isSupportedAggregateCall(node) {
  const name = aggregateFunctionName(node)
  return name !== null && SUPPORTED_AGGREGATE_FUNCTIONS.has(name)
}

function collectRefsFromExpr(expr, refs) {
  if (!expr || typeof expr !== 'object') {
    return
  }

  if (expr.type === 'ref') {
    if (typeof expr.name === 'string' && expr.name !== '*') {
      refs.add(expr.name)
    }
    return
  }

  if (expr.type === 'call') {
    for (const arg of expr.args ?? []) {
      collectRefsFromExpr(arg, refs)
    }
    return
  }

  if (expr.type === 'binary') {
    collectRefsFromExpr(expr.left, refs)
    collectRefsFromExpr(expr.right, refs)
    return
  }

  if (expr.type === 'unary') {
    collectRefsFromExpr(expr.argument, refs)
  }
}

function walkExprForAggregates(expr, found) {
  if (!expr || typeof expr !== 'object') {
    return
  }

  if (expr.type === 'call') {
    if (isSupportedAggregateCall(expr)) {
      found.push(expr)
    }
    for (const arg of expr.args ?? []) {
      walkExprForAggregates(arg, found)
    }
    return
  }

  if (expr.type === 'binary') {
    walkExprForAggregates(expr.left, found)
    walkExprForAggregates(expr.right, found)
    return
  }

  if (expr.type === 'unary') {
    walkExprForAggregates(expr.argument, found)
  }
}

function selectHasSupportedAggregates(select) {
  const aggregates = []
  for (const column of select.columns ?? []) {
    walkExprForAggregates(column?.expr, aggregates)
  }
  if (select.having) {
    walkExprForAggregates(select.having, aggregates)
  }
  return aggregates.length > 0
}

function columnKey(column) {
  return JSON.stringify(column?.expr ?? column)
}

function refColumn(name) {
  return { expr: { type: 'ref', name } }
}

function rowMarkerColumn() {
  return {
    expr: { type: 'integer', value: 1 },
    alias: { name: '_mtdd_row' },
  }
}

function buildRowLevelColumns(select) {
  const refNames = new Set()
  const projection = []
  const seen = new Set()

  function addColumn(column) {
    const key = columnKey(column)
    if (seen.has(key)) {
      return
    }
    seen.add(key)
    projection.push(column)
  }

  for (const groupExpr of select.groupBy ?? []) {
    addColumn({ expr: JSON.parse(JSON.stringify(groupExpr)) })
    collectRefsFromExpr(groupExpr, refNames)
  }

  for (const column of select.columns ?? []) {
    const expr = column?.expr
    const aggregates = []
    walkExprForAggregates(expr, aggregates)

    if (aggregates.length > 0) {
      for (const aggregate of aggregates) {
        for (const arg of aggregate.args ?? []) {
          collectRefsFromExpr(arg, refNames)
        }
      }
      continue
    }

    addColumn({
      expr: JSON.parse(JSON.stringify(expr)),
      ...(column.alias ? { alias: JSON.parse(JSON.stringify(column.alias)) } : {}),
    })
    collectRefsFromExpr(expr, refNames)
  }

  if (select.having) {
    const havingAggregates = []
    walkExprForAggregates(select.having, havingAggregates)
    for (const aggregate of havingAggregates) {
      for (const arg of aggregate.args ?? []) {
        collectRefsFromExpr(arg, refNames)
      }
    }
  }

  const columns = []
  const usedRefs = new Set()

  for (const column of projection) {
    if (column.expr?.type === 'ref' && typeof column.expr.name === 'string') {
      usedRefs.add(column.expr.name)
    }
    columns.push(column)
  }

  for (const refName of refNames) {
    if (!usedRefs.has(refName)) {
      columns.push(refColumn(refName))
      usedRefs.add(refName)
    }
  }

  if (columns.length === 0) {
    columns.push(rowMarkerColumn())
  }

  return columns
}

function applyAggregateFanOutRewrite(fanOutSelect, sourceSelect) {
  fanOutSelect.columns = buildRowLevelColumns(sourceSelect)
  delete fanOutSelect.groupBy
  delete fanOutSelect.having
}

/**
 * Fan-out SELECT that needs global ORDER BY and/or aggregates: shards run row-level SQL;
 * full SQL is re-run on localhost after rows are merged into a temp table.
 */
function splitSelectForLocalFanOut(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    return { needsLocalMerge: false, needsLocalReorder: false }
  }

  const { stmt, select } = parseSelectStatement(text)
  const hasOrderBy = selectHasOrderBy(select)
  const hasAggregates = selectHasSupportedAggregates(select)

  if (!hasOrderBy && !hasAggregates) {
    return { needsLocalMerge: false, needsLocalReorder: false }
  }

  const primaryTable = getPrimaryFromTable(select)
  if (!primaryTable) {
    throw new MtddSqlParseError(
      `@advcomm/mtdd: local fan-out requires a single-table FROM clause (no joins). SQL: ${previewSql(text)}`,
      text,
    )
  }

  if (selectHasOffset(select)) {
    throw new MtddSqlParseError(
      `@advcomm/mtdd: OFFSET is not supported for local fan-out across shards (results are not reliable when aggregating). SQL: ${previewSql(text)}`,
      text,
    )
  }

  const fanOutStmt = cloneStatement(stmt)
  const fanOutSelect = resolveSelectNode(fanOutStmt)

  if (hasAggregates) {
    applyAggregateFanOutRewrite(fanOutSelect, select)
  }

  stripGlobalSortFromSelect(fanOutSelect)

  return {
    needsLocalMerge: true,
    needsLocalReorder: true,
    fanOutText: toSql.statement(fanOutStmt),
    fullText: text,
    tempTableName: primaryTable.name,
    orderBy: select.orderBy
      ? JSON.parse(JSON.stringify(select.orderBy))
      : null,
    limit: select.limit ? JSON.parse(JSON.stringify(select.limit)) : null,
    hasAggregates,
  }
}

function splitSelectForOrderedFanOut(text) {
  return splitSelectForLocalFanOut(text)
}

module.exports = {
  splitSelectForLocalFanOut,
  splitSelectForOrderedFanOut,
  parseSelectStatement,
  resolveSelectNode,
  selectHasOrderBy,
  selectHasOffset,
  selectHasSupportedAggregates,
  getPrimaryFromTable,
  isSimpleSingleTableFrom,
  tableRefName,
  buildRowLevelColumns,
  SUPPORTED_AGGREGATE_FUNCTIONS,
}
