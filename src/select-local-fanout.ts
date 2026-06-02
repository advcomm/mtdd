const { toSql } = require('pgsql-ast-parser')
const { MtddSqlParseError } = require('./sql-parse')
const {
  POSTGRES_SCATTER_GATHER_AGGREGATES,
  aggregateFunctionName,
  isWindowCall,
  isRejectedFanOutAggregate,
  isScatterGatherAggregate,
  validateScatterGatherAggregateCall,
} = require('./postgres-aggregate-functions')

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

function exprContainsSubquery(expr) {
  if (!expr || typeof expr !== 'object') {
    return false
  }
  if (expr.type === 'select') {
    return true
  }
  if (expr.type === 'call') {
    if (exprContainsSubquery(expr.filter)) {
      return true
    }
    if (expr.withinGroup && exprContainsSubquery(expr.withinGroup.by)) {
      return true
    }
    for (const entry of expr.orderBy ?? []) {
      if (exprContainsSubquery(entry?.by)) {
        return true
      }
    }
    for (const arg of expr.args ?? []) {
      if (exprContainsSubquery(arg)) {
        return true
      }
    }
    return false
  }
  if (expr.type === 'binary') {
    return (
      exprContainsSubquery(expr.left) || exprContainsSubquery(expr.right)
    )
  }
  if (expr.type === 'unary') {
    return exprContainsSubquery(expr.argument)
  }
  return false
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
    collectRefsFromExpr(expr.filter, refs)
    for (const entry of expr.orderBy ?? []) {
      collectRefsFromExpr(entry?.by, refs)
    }
    if (expr.withinGroup) {
      collectRefsFromExpr(expr.withinGroup.by, refs)
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

function collectRefsFromAggregateCall(callNode, refs) {
  collectRefsFromExpr(callNode, refs)
}

function walkAllCalls(expr, calls) {
  if (!expr || typeof expr !== 'object') {
    return
  }

  if (expr.type === 'call') {
    calls.push(expr)
    for (const arg of expr.args ?? []) {
      walkAllCalls(arg, calls)
    }
    walkAllCalls(expr.filter, calls)
    for (const entry of expr.orderBy ?? []) {
      walkAllCalls(entry?.by, calls)
    }
    if (expr.withinGroup) {
      walkAllCalls(expr.withinGroup.by, calls)
    }
    return
  }

  if (expr.type === 'binary') {
    walkAllCalls(expr.left, calls)
    walkAllCalls(expr.right, calls)
    return
  }

  if (expr.type === 'unary') {
    walkAllCalls(expr.argument, calls)
  }
}

function collectAllCallsFromSelect(select) {
  const calls = []
  for (const column of select.columns ?? []) {
    walkAllCalls(column?.expr, calls)
  }
  if (select.having) {
    walkAllCalls(select.having, calls)
  }
  for (const entry of select.orderBy ?? []) {
    walkAllCalls(entry?.by, calls)
  }
  return calls
}

function groupByContainsExpr(groupBy, expr) {
  const key = JSON.stringify(expr)
  return (groupBy ?? []).some((entry) => JSON.stringify(entry) === key)
}

function assertFanOutAggregateSupport(select, text) {
  const calls = collectAllCallsFromSelect(select)

  for (const call of calls) {
    if (isWindowCall(call)) {
      throw new MtddSqlParseError(
        `@advcomm/mtdd: window functions are not supported for fan-out across shards. SQL: ${previewSql(text)}`,
        text,
      )
    }
    if (isRejectedFanOutAggregate(call)) {
      const name = aggregateFunctionName(call)
      throw new MtddSqlParseError(
        `@advcomm/mtdd: aggregate function "${name}" is not supported for fan-out across shards. SQL: ${previewSql(text)}`,
        text,
      )
    }
  }

  for (const call of calls) {
    if (!isScatterGatherAggregate(call)) {
      continue
    }
    try {
      validateScatterGatherAggregateCall(call)
    } catch (err) {
      throw new MtddSqlParseError(
        `@advcomm/mtdd: ${err.message}. SQL: ${previewSql(text)}`,
        text,
      )
    }
    if (exprContainsSubquery(call)) {
      throw new MtddSqlParseError(
        `@advcomm/mtdd: aggregate expressions with subqueries are not supported for fan-out across shards. SQL: ${previewSql(text)}`,
        text,
      )
    }
  }

  const groupBy = select.groupBy ?? []
  if (groupBy.length === 0) {
    return
  }

  function walkUnknownAggregateCalls(expr, insideSupportedAggregate) {
    if (!expr || typeof expr !== 'object') {
      return
    }
    if (expr.type === 'call') {
      const name = aggregateFunctionName(expr)
      const supported = isScatterGatherAggregate(expr)
      if (
        !insideSupportedAggregate &&
        name !== null &&
        !POSTGRES_SCATTER_GATHER_AGGREGATES.has(name) &&
        expr.withinGroup == null
      ) {
        throw new MtddSqlParseError(
          `@advcomm/mtdd: aggregate function "${name}" is not supported for fan-out across shards. SQL: ${previewSql(text)}`,
          text,
        )
      }
      const nestedInside = insideSupportedAggregate || supported
      for (const arg of expr.args ?? []) {
        walkUnknownAggregateCalls(arg, nestedInside)
      }
      walkUnknownAggregateCalls(expr.filter, nestedInside)
      for (const entry of expr.orderBy ?? []) {
        walkUnknownAggregateCalls(entry?.by, nestedInside)
      }
      if (expr.withinGroup) {
        walkUnknownAggregateCalls(expr.withinGroup.by, nestedInside)
      }
      return
    }
    if (expr.type === 'binary') {
      walkUnknownAggregateCalls(expr.left, insideSupportedAggregate)
      walkUnknownAggregateCalls(expr.right, insideSupportedAggregate)
      return
    }
    if (expr.type === 'unary') {
      walkUnknownAggregateCalls(expr.argument, insideSupportedAggregate)
    }
  }

  for (const column of select.columns ?? []) {
    const expr = column?.expr
    if (groupByContainsExpr(groupBy, expr)) {
      continue
    }
    walkUnknownAggregateCalls(expr, false)
  }

  if (select.having) {
    walkUnknownAggregateCalls(select.having, false)
  }
}

function walkExprForAggregates(expr, found) {
  if (!expr || typeof expr !== 'object') {
    return
  }

  if (expr.type === 'call') {
    if (isScatterGatherAggregate(expr)) {
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

function selectHasGroupByWithColumnCalls(select) {
  if (!Array.isArray(select.groupBy) || select.groupBy.length === 0) {
    return false
  }
  return (select.columns ?? []).some((column) => column?.expr?.type === 'call')
}

function selectRequiresFanOutValidation(select) {
  if (selectHasOrderBy(select) || selectHasSupportedAggregates(select)) {
    return true
  }
  if (selectHasGroupByWithColumnCalls(select)) {
    return true
  }
  return collectAllCallsFromSelect(select).some(
    (call) =>
      isWindowCall(call) ||
      isRejectedFanOutAggregate(call) ||
      isScatterGatherAggregate(call),
  )
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
        collectRefsFromAggregateCall(aggregate, refNames)
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
      collectRefsFromAggregateCall(aggregate, refNames)
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

  if (selectRequiresFanOutValidation(select)) {
    assertFanOutAggregateSupport(select, text)
  }

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
  assertFanOutAggregateSupport,
  POSTGRES_SCATTER_GATHER_AGGREGATES,
  SUPPORTED_AGGREGATE_FUNCTIONS: POSTGRES_SCATTER_GATHER_AGGREGATES,
}
