const PG_CONFIG_KEYS = [
  'text',
  'values',
  'name',
  'rowMode',
  'types',
]

function isQueryConfig(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    ('text' in value || 'name' in value)
  )
}

function pickPgConfigFields(config) {
  const picked = {}
  for (const key of PG_CONFIG_KEYS) {
    if (key in config) {
      picked[key] = config[key]
    }
  }
  return picked
}

function normalizeQueryRequest(source, rawArgs, client, pool) {
  const req = {
    source,
    rawArgs: [...rawArgs],
    client,
    pool,
  }

  if (rawArgs.length === 0) {
    throw new TypeError('query requires at least one argument')
  }

  const first = rawArgs[0]

  if (typeof first === 'string') {
    req.text = first
    if (rawArgs.length === 1) {
      return req
    }
    const second = rawArgs[1]
    if (typeof second === 'function') {
      req.callback = second
      return req
    }
    req.values = second
    if (rawArgs.length === 2) {
      return req
    }
    if (typeof rawArgs[2] === 'function') {
      req.callback = rawArgs[2]
    }
    return req
  }

  if (isQueryConfig(first)) {
    Object.assign(req, pickPgConfigFields(first))
    if ('tid' in first) {
      req.tid = first.tid
    }
    if (rawArgs.length > 1 && typeof rawArgs[1] === 'function') {
      req.callback = rawArgs[1]
    }
    return req
  }

  throw new TypeError(
    'query first argument must be a string or query config object',
  )
}

function buildPgQueryArgs(req) {
  const { rawArgs } = req
  const first = rawArgs[0]

  if (typeof first === 'string') {
    if (rawArgs.length === 1) {
      return [first]
    }
    const second = rawArgs[1]
    if (typeof second === 'function') {
      return [first, second]
    }
    if (rawArgs.length === 2) {
      return [first, second]
    }
    return [first, second, rawArgs[2]]
  }

  if (isQueryConfig(first)) {
    const config = pickPgConfigFields(first)
    if (rawArgs.length > 1 && typeof rawArgs[1] === 'function') {
      return [config, rawArgs[1]]
    }
    return [config]
  }

  return rawArgs
}

module.exports = {
  normalizeQueryRequest,
  buildPgQueryArgs,
  isQueryConfig,
}
