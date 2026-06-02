const { toSql } = require('pgsql-ast-parser')
const {
  parseSelectStatement,
  resolveSelectNode,
  tableRefName,
  isSimpleSingleTableFrom,
} = require('./select-order-fanout')
function replacePrimaryTableName(stmt, fromName, toName) {
  const select = resolveSelectNode(stmt)
  if (!select || !isSimpleSingleTableFrom(select)) {
    return null
  }

  const tableRef = select.from[0]
  const currentName = tableRefName(tableRef)
  if (currentName !== fromName) {
    return null
  }

  if (typeof tableRef.name === 'string') {
    tableRef.name = toName
  } else if (tableRef.name && typeof tableRef.name === 'object') {
    tableRef.name.name = toName
  } else {
    tableRef.name = { name: toName }
  }

  return stmt
}

function rewriteQueryTableNameAst(sql, fromName, toName) {
  const { stmt } = parseSelectStatement(sql)
  const clone = JSON.parse(JSON.stringify(stmt))
  const updated = replacePrimaryTableName(clone, fromName, toName)
  if (!updated) {
    throw new Error(
      `@advcomm/mtdd: unable to rewrite table ${fromName} in SELECT for local merge`,
    )
  }
  return toSql.statement(updated)
}

function refToColumnName(ref) {
  if (!ref || ref.type !== 'ref') {
    return null
  }
  if (typeof ref.name === 'string') {
    return ref.name
  }
  return null
}

function orderByColumnNames(orderBy) {
  if (!Array.isArray(orderBy)) {
    return []
  }
  const names = []
  for (const entry of orderBy) {
    const column = refToColumnName(entry?.by)
    if (column) {
      names.push(column)
    }
  }
  return names
}

module.exports = {
  rewriteQueryTableNameAst,
  replacePrimaryTableName,
  orderByColumnNames,
  refToColumnName,
}
