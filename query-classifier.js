const {
  classifyQuery,
  classifyQueryAsync,
} = require('./sql-parse')

async function attachQueryClassification(req) {
  const classification = await classifyQueryAsync(req.text)
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

function isSelectQuery(req) {
  if (req?.commandType === 'SELECT') {
    return true
  }
  return classifyQuery(req?.text).commandType === 'SELECT'
}

function hasTenantTid(req) {
  return req.tid !== undefined && req.tid !== null
}

/** @deprecated Use classifyQuery; true when commandType is FUNCTION */
function isStoredFunctionSelect(text) {
  return classifyQuery(text).commandType === 'FUNCTION'
}

module.exports = {
  classifyQuery,
  classifyQueryAsync,
  attachQueryClassification,
  isStoredFunctionSelect,
  isInsertQuery,
  isCallQuery,
  isCallAllShards,
  isFunctionQuery,
  isSelectQuery,
  hasTenantTid,
}
