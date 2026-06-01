const RETURNING_PATTERN = /\bRETURNING\b/i

const DELETE_PATTERN =
  /^\s*(?:WITH\s+[\s\S]+?\s+)?DELETE\b/i

const UPDATE_PATTERN =
  /^\s*(?:WITH\s+[\s\S]+?\s+)?UPDATE\b/i

const INSERT_PATTERN =
  /^\s*(?:WITH\s+[\s\S]+?\s+)?INSERT\b/i

const CALL_PATTERN =
  /^\s*(?:WITH\s+[\s\S]+?\s+)?CALL\b/i

const SELECT_PATTERN =
  /^\s*(?:WITH\s+[\s\S]+?\s+)?SELECT\b/i

// SET-returning / table functions: SELECT … FROM name(…)
const FROM_STORED_FUNCTION_PATTERN =
  /\bFROM\s+(?:ONLY\s+)?(?:(?:"[^"]+")|(?:'[^']+')|(?:`[^`]+`)|(?:(?:[a-zA-Z_][\w$]*\.)*[a-zA-Z_][\w$]*))\s*\(/i

// Scalar functions: SELECT name(…) with no FROM clause
const SELECT_SCALAR_FUNCTION_PATTERN =
  /^\s*(?:WITH\s+[\s\S]+?\s+)?SELECT\s+(?:DISTINCT(?:\s+ON\s*\([^)]*\))?\s+)?(?:(?:[a-zA-Z_][\w$]*\.)*[a-zA-Z_][\w$]*)\s*\(/i

function isStoredFunctionSelect(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    return false
  }

  const normalized = text.trim()
  if (!SELECT_PATTERN.test(normalized)) {
    return false
  }

  if (FROM_STORED_FUNCTION_PATTERN.test(normalized)) {
    return true
  }

  if (/\bFROM\b/i.test(normalized)) {
    return false
  }

  return SELECT_SCALAR_FUNCTION_PATTERN.test(normalized)
}

function classifyQuery(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    return {
      commandType: 'UNKNOWN',
      hasReturning: false,
    }
  }

  const normalized = text.trim()

  if (DELETE_PATTERN.test(normalized)) {
    return {
      commandType: 'DELETE',
      hasReturning: RETURNING_PATTERN.test(normalized),
    }
  }

  if (UPDATE_PATTERN.test(normalized)) {
    return {
      commandType: 'UPDATE',
      hasReturning: RETURNING_PATTERN.test(normalized),
    }
  }

  if (INSERT_PATTERN.test(normalized)) {
    return {
      commandType: 'INSERT',
      hasReturning: RETURNING_PATTERN.test(normalized),
    }
  }

  if (CALL_PATTERN.test(normalized)) {
    return {
      commandType: 'CALL',
      hasReturning: false,
    }
  }

  if (isStoredFunctionSelect(normalized)) {
    return {
      commandType: 'FUNCTION',
      hasReturning: false,
    }
  }

  return {
    commandType: 'UNKNOWN',
    hasReturning: false,
  }
}

function attachQueryClassification(req) {
  const classification = classifyQuery(req.text)
  req.commandType = classification.commandType
  req.hasReturning = classification.hasReturning
  return req
}

function isInsertQuery(req) {
  if (req?.commandType === 'INSERT') {
    return true
  }
  return classifyQuery(req?.text).commandType === 'INSERT'
}

function isCallQuery(req) {
  if (req?.commandType === 'CALL') {
    return true
  }
  return classifyQuery(req?.text).commandType === 'CALL'
}

function isCallAllShards(req) {
  return isCallQuery(req) && req.tid === null
}

function isFunctionQuery(req) {
  if (req?.commandType === 'FUNCTION') {
    return true
  }
  return classifyQuery(req?.text).commandType === 'FUNCTION'
}

module.exports = {
  classifyQuery,
  attachQueryClassification,
  isStoredFunctionSelect,
  isInsertQuery,
  isCallQuery,
  isCallAllShards,
  isFunctionQuery,
}
