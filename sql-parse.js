const { parse } = require('pgsql-ast-parser')
const {
  getCachedClassificationSync,
  setCachedClassificationSync,
  getCachedClassificationAsync,
  setCachedClassificationAsync,
} = require('./ast-classify-cache')

/**
 * pgsql-ast-parser does not parse PostgreSQL CALL statements.
 * Detect CALL-only text before parse (parser gap, not a regex fallback path).
 */
const CALL_STATEMENT_PATTERN =
  /^\s*(?:WITH\s+[\s\S]+?\s+)?CALL\b/i

class MtddSqlParseError extends Error {
  constructor(message, sql) {
    super(message)
    this.name = 'MtddSqlParseError'
    this.sql = sql
  }
}

function previewSql(sql) {
  if (typeof sql !== 'string') {
    return ''
  }
  const oneLine = sql.replace(/\s+/g, ' ').trim()
  return oneLine.length > 120 ? `${oneLine.slice(0, 117)}...` : oneLine
}

function isCallStatementText(text) {
  return typeof text === 'string' && CALL_STATEMENT_PATTERN.test(text.trim())
}

function parseStatements(text) {
  try {
    return parse(text, { locationTracking: false })
  } catch (err) {
    throw new MtddSqlParseError(
      `@advcomm/mtdd: unable to parse SQL for routing (${err.message}). SQL: ${previewSql(text)}`,
      text,
    )
  }
}

function isTopLevelCallColumn(column) {
  return column?.expr?.type === 'call'
}

function selectFromHasFunctionCall(fromList) {
  if (!Array.isArray(fromList)) {
    return false
  }
  return fromList.some((entry) => entry?.type === 'call')
}

function selectIsScalarFunction(stmt) {
  if (stmt.type !== 'select') {
    return false
  }
  if (Array.isArray(stmt.from) && stmt.from.length > 0) {
    return false
  }
  if (!Array.isArray(stmt.columns) || stmt.columns.length === 0) {
    return false
  }
  return stmt.columns.every(isTopLevelCallColumn)
}

function classifySelectStatement(stmt) {
  if (selectFromHasFunctionCall(stmt.from) || selectIsScalarFunction(stmt)) {
    return {
      commandType: 'FUNCTION',
      hasReturning: false,
    }
  }
  return {
    commandType: 'SELECT',
    hasReturning: false,
  }
}

function classifyFromStatement(stmt) {
  if (!stmt || typeof stmt !== 'object') {
    return {
      commandType: 'UNKNOWN',
      hasReturning: false,
    }
  }

  if (stmt.type === 'with' && stmt.in) {
    return classifyFromStatement(stmt.in)
  }

  switch (stmt.type) {
    case 'delete':
      return {
        commandType: 'DELETE',
        hasReturning: Array.isArray(stmt.returning) && stmt.returning.length > 0,
      }
    case 'update':
      return {
        commandType: 'UPDATE',
        hasReturning: Array.isArray(stmt.returning) && stmt.returning.length > 0,
      }
    case 'insert':
      return {
        commandType: 'INSERT',
        hasReturning: Array.isArray(stmt.returning) && stmt.returning.length > 0,
      }
    case 'select':
      return classifySelectStatement(stmt)
    default:
      return {
        commandType: 'UNKNOWN',
        hasReturning: false,
      }
  }
}

function classifyFromAst(statements, sql) {
  if (!Array.isArray(statements) || statements.length === 0) {
    return {
      commandType: 'UNKNOWN',
      hasReturning: false,
    }
  }

  if (statements.length > 1) {
    throw new MtddSqlParseError(
      `@advcomm/mtdd: multi-statement SQL is not supported for routing. SQL: ${previewSql(sql)}`,
      sql,
    )
  }

  return classifyFromStatement(statements[0])
}

function computeClassification(text) {
  if (isCallStatementText(text)) {
    return {
      commandType: 'CALL',
      hasReturning: false,
    }
  }

  const statements = parseStatements(text)
  return classifyFromAst(statements, text)
}

function classifyQuery(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    return {
      commandType: 'UNKNOWN',
      hasReturning: false,
    }
  }

  const cached = getCachedClassificationSync(text)
  if (cached) {
    return cached
  }

  const classification = computeClassification(text)
  setCachedClassificationSync(text, classification)
  return classification
}

async function classifyQueryAsync(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    return {
      commandType: 'UNKNOWN',
      hasReturning: false,
    }
  }

  const cached = await getCachedClassificationAsync(text)
  if (cached) {
    return cached
  }

  const classification = computeClassification(text)
  await setCachedClassificationAsync(text, classification)
  return classification
}

function parseQueryAst(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    return []
  }
  if (isCallStatementText(text)) {
    throw new MtddSqlParseError(
      `@advcomm/mtdd: CALL statements are not represented in the SQL AST (parser limitation). SQL: ${previewSql(text)}`,
      text,
    )
  }
  return parseStatements(text)
}

function clearClassificationCache() {
  const { clearClassificationCache: clearAstCache } = require('./ast-classify-cache')
  clearAstCache()
}

module.exports = {
  MtddSqlParseError,
  classifyQuery,
  classifyQueryAsync,
  parseQueryAst,
  classifyFromAst,
  classifyFromStatement,
  isCallStatementText,
  clearClassificationCache,
}
