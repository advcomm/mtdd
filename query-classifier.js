const RETURNING_PATTERN = /\bRETURNING\b/i

const DELETE_PATTERN =
  /^\s*(?:WITH\s+[\s\S]+?\s+)?DELETE\b/i

const UPDATE_PATTERN =
  /^\s*(?:WITH\s+[\s\S]+?\s+)?UPDATE\b/i

const INSERT_PATTERN =
  /^\s*(?:WITH\s+[\s\S]+?\s+)?INSERT\b/i

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

module.exports = {
  classifyQuery,
  attachQueryClassification,
  isInsertQuery,
}
