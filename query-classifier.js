const RETURNING_PATTERN = /\bRETURNING\b/i

const DELETE_PATTERN =
  /^\s*(?:WITH\s+[\s\S]+?\s+)?DELETE\b/i

const UPDATE_PATTERN =
  /^\s*(?:WITH\s+[\s\S]+?\s+)?UPDATE\b/i

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

module.exports = {
  classifyQuery,
  attachQueryClassification,
}
