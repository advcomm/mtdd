/**
 * Control-plane metadata for QueryStream ResultChunk (FlexBuffers encoding).
 * Column data is carried in arrow_ipc bytes on the same chunk.
 */

const flexbuffers = require('flatbuffers/js/flexbuffers')

function toFlexBytes(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
}

function normalizeFieldInfo(field) {
  return {
    name: String(field.name ?? ''),
    table_oid: Number(field.table_oid ?? field.tableOid ?? 0) >>> 0,
    column_id: Number(field.column_id ?? field.columnId ?? 0),
    data_type_oid: Number(field.data_type_oid ?? field.dataTypeID ?? 0) >>> 0,
    format: Number(field.format ?? 0),
  }
}

function flexEncode(value) {
  const encoded = flexbuffers.encode(value)
  return Buffer.from(
    encoded.buffer,
    encoded.byteOffset,
    encoded.byteLength,
  )
}

function encodeResultSchema(schema) {
  const fields = (schema.fields ?? []).map(normalizeFieldInfo)
  return flexEncode({
    command: String(schema.command ?? 'SELECT'),
    fields,
  })
}

function decodeResultSchema(buffer) {
  const map = flexbuffers.toObject(toFlexBytes(buffer))
  const fields = Array.isArray(map.fields)
    ? map.fields.map((field) => normalizeFieldInfo(field))
    : []
  return {
    command: map.command ?? 'SELECT',
    fields,
  }
}

function encodeResultTrailer(trailer) {
  return flexEncode({
    command_tag: String(trailer.command_tag ?? trailer.commandTag ?? ''),
    row_count: Number(trailer.row_count ?? trailer.rowCount ?? 0),
    oid: Number(trailer.oid ?? 0) >>> 0,
  })
}

function decodeResultTrailer(buffer) {
  const map = flexbuffers.toObject(toFlexBytes(buffer))
  return {
    command_tag: map.command_tag ?? '',
    row_count: Number(map.row_count ?? 0),
    oid: Number(map.oid ?? 0) || null,
  }
}

function encodePgError(error) {
  return flexEncode({
    sqlstate: String(error.sqlstate ?? ''),
    severity: String(error.severity ?? 'ERROR'),
    message: String(error.message ?? 'unknown error'),
    detail: String(error.detail ?? ''),
    position: String(error.position ?? ''),
  })
}

function decodePgError(buffer) {
  const map = flexbuffers.toObject(toFlexBytes(buffer))
  return {
    sqlstate: map.sqlstate ?? '',
    severity: map.severity ?? 'ERROR',
    message: map.message ?? 'unknown error',
    detail: map.detail ?? '',
    position: map.position ?? '',
  }
}

module.exports = {
  encodeResultSchema,
  decodeResultSchema,
  encodeResultTrailer,
  decodeResultTrailer,
  encodePgError,
  decodePgError,
}
