let api = null
let apiChecked = false

function getOtelApi() {
  if (apiChecked) {
    return api
  }
  apiChecked = true
  try {
    api = require('@opentelemetry/api')
  } catch {
    api = null
  }
  return api
}

function startQuerySpan(name, attributes = {}) {
  const otel = getOtelApi()
  if (!otel) {
    return null
  }

  const tracer = otel.trace.getTracer('@advcomm/mtdd', '1.0.0')
  return tracer.startSpan(name, { attributes })
}

async function withQuerySpan(name, attributes, fn) {
  const span = startQuerySpan(name, attributes)
  if (!span) {
    return fn()
  }

  const otel = getOtelApi()
  try {
    const result = await fn()
    return result
  } catch (err) {
    span.recordException(err)
    const statusCode = otel.SpanStatusCode?.ERROR ?? 2
    span.setStatus({
      code: statusCode,
      message: err?.message ?? String(err),
    })
    throw err
  } finally {
    span.end()
  }
}

function spanAttributesFromReq(req) {
  return {
    'mtdd.command_type': req.commandType ?? 'unknown',
    'mtdd.routing': req.routing ?? 'unknown',
    'mtdd.has_tid': req.tid !== undefined && req.tid !== null,
    'mtdd.host_index': req.hostIndex ?? -1,
    'mtdd.source': req.source ?? 'unknown',
  }
}

module.exports = {
  withQuerySpan,
  startQuerySpan,
  spanAttributesFromReq,
}
