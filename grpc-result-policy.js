const RESPONSE_FORMAT_JSON = 'json'
const RESPONSE_FORMAT_ARROW = 'arrow'

function getGrpcResultFormat() {
  const raw = String(process.env.MTDD_GRPC_RESULT_FORMAT ?? '')
    .trim()
    .toLowerCase()
  if (raw === '' || raw === RESPONSE_FORMAT_JSON) {
    return RESPONSE_FORMAT_JSON
  }
  if (raw === RESPONSE_FORMAT_ARROW) {
    return RESPONSE_FORMAT_ARROW
  }
  throw new Error(
    `MTDD_GRPC_RESULT_FORMAT must be "json" or "arrow". Received: ${process.env.MTDD_GRPC_RESULT_FORMAT}`,
  )
}

function usesArrowResultFormat() {
  return getGrpcResultFormat() === RESPONSE_FORMAT_ARROW
}

function protoResponseFormatEnum() {
  return usesArrowResultFormat()
    ? 'RESPONSE_FORMAT_ARROW'
    : 'RESPONSE_FORMAT_JSON'
}

module.exports = {
  RESPONSE_FORMAT_JSON,
  RESPONSE_FORMAT_ARROW,
  getGrpcResultFormat,
  usesArrowResultFormat,
  protoResponseFormatEnum,
}
