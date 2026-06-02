const resultMeta = require('./flatbuffers/result-meta-codec')
const { decodeRawPgBatch } = require('./pg-binary-decode')
const { encodeRawPgBatch, mockWireFormat } = require('./pg-binary-encode')

const CHUNK_KIND_SCHEMA = 'CHUNK_KIND_SCHEMA'
const CHUNK_KIND_BATCH = 'CHUNK_KIND_BATCH'
const CHUNK_KIND_TRAILER = 'CHUNK_KIND_TRAILER'
const CHUNK_KIND_ERROR = 'CHUNK_KIND_ERROR'

function encodeQueryParam(value, oid, index) {
  if (value === null || value === undefined) {
    return { oid: oid ?? 0, format: 0, value: Buffer.alloc(0) }
  }

  if (Buffer.isBuffer(value)) {
    return { oid: oid ?? 0, format: 1, value }
  }

  if (value instanceof Uint8Array) {
    return { oid: oid ?? 0, format: 1, value: Buffer.from(value) }
  }

  if (typeof value === 'bigint') {
    return { oid: oid ?? 0, format: 0, value: Buffer.from(value.toString(), 'utf8') }
  }

  if (value instanceof Date) {
    return { oid: oid ?? 0, format: 0, value: Buffer.from(value.toISOString(), 'utf8') }
  }

  if (typeof value === 'object') {
    return {
      oid: oid ?? 0,
      format: 0,
      value: Buffer.from(JSON.stringify(value), 'utf8'),
    }
  }

  return { oid: oid ?? 0, format: 0, value: Buffer.from(String(value), 'utf8') }
}

function buildLibpqQueryParams(req) {
  const values = Array.isArray(req.values) ? req.values : []
  const types = Array.isArray(req.types) ? req.types : []
  return values.map((value, index) =>
    encodeQueryParam(value, types[index], index),
  )
}

function buildQueryRequestPayload(hostIndex, req, sessionId) {
  return {
    host_index: hostIndex,
    text: req.text ?? '',
    name: '',
    row_mode: req.row_mode ?? req.rowMode ?? '',
    session_id: sessionId ?? '',
    params: buildLibpqQueryParams(req),
    result_format: 1,
  }
}

/** pg Result.fields from server schema; uses wire format from FlexBuffers (not mockWireFormat). */
function pgFieldsFromSchema(schema) {
  return (schema?.fields ?? []).map((field) => ({
    name: field.name,
    dataTypeID: field.data_type_oid,
    tableID: field.table_oid,
    columnID: field.column_id,
    format: field.format ?? 0,
  }))
}

function commandFromTag(commandTag, fallback) {
  if (!commandTag) {
    return fallback ?? 'SELECT'
  }
  const token = String(commandTag).trim().split(/\s+/)[0]
  return token ? token.toUpperCase() : fallback ?? 'SELECT'
}

function chunkPayload(chunk) {
  return chunk.payload ?? chunk.Payload
}

function decodeQueryStreamToPgResult(chunks) {
  let schema = null
  let trailer = null
  const rows = []

  for (const chunk of chunks) {
    const kind = chunk.kind ?? chunk.Kind
    if (kind === CHUNK_KIND_ERROR || kind === 4 || kind === 'CHUNK_KIND_ERROR') {
      const meta = chunk.flatbuffer_meta ?? chunk.flatbufferMeta
      if (meta && meta.length > 0) {
        const error = resultMeta.decodePgError(meta)
        const parts = [error.message]
        if (error.sqlstate) {
          parts.push(`(${error.sqlstate})`)
        }
        if (error.detail) {
          parts.push(error.detail)
        }
        throw new Error(parts.filter(Boolean).join(' '))
      }
      break
    }
    if (kind === CHUNK_KIND_SCHEMA || kind === 1 || kind === 'CHUNK_KIND_SCHEMA') {
      const meta = chunk.flatbuffer_meta ?? chunk.flatbufferMeta
      if (meta && meta.length > 0) {
        schema = resultMeta.decodeResultSchema(meta)
      }
      const payload = chunkPayload(chunk)
      if (schema && payload && payload.length > 0) {
        rows.push(...decodeRawPgBatch(Buffer.from(payload), schema.fields))
      }
      continue
    }
    if (kind === CHUNK_KIND_BATCH || kind === 2 || kind === 'CHUNK_KIND_BATCH') {
      const payload = chunkPayload(chunk)
      if (!schema) {
        throw new Error('BATCH chunk before SCHEMA')
      }
      if (payload && payload.length > 0) {
        rows.push(...decodeRawPgBatch(Buffer.from(payload), schema.fields))
      }
      continue
    }
    if (kind === CHUNK_KIND_TRAILER || kind === 3 || kind === 'CHUNK_KIND_TRAILER') {
      const meta = chunk.flatbuffer_meta ?? chunk.flatbufferMeta
      if (meta && meta.length > 0) {
        trailer = resultMeta.decodeResultTrailer(meta)
      }
    }
  }

  const fields = pgFieldsFromSchema(schema ?? { fields: [] })

  return {
    command: commandFromTag(trailer?.command_tag, schema?.command),
    rowCount: trailer?.row_count != null ? Number(trailer.row_count) : rows.length,
    oid: trailer?.oid ?? null,
    fields,
    rows,
  }
}

/** @deprecated Use decodeQueryStreamToPgResult */
const decodeArrowStreamToPgResult = decodeQueryStreamToPgResult

function inferPgFields(fields, rows) {
  const explicit = fields ?? []
  const first = rows?.[0]
  if (!first || typeof first !== 'object') {
    return explicit
  }
  const known = new Set(explicit.map((field) => field.name))
  const extra = Object.keys(first)
    .filter((name) => !known.has(name))
    .map((name) => ({
      name,
      dataTypeID: typeof first[name] === 'number' ? 23 : 25,
    }))
  if (explicit.length === 0 && extra.length === 0) {
    return []
  }
  return [...explicit, ...extra]
}

function encodePgResultAsChunks(pgResult) {
  const pgFields = inferPgFields(pgResult.fields, pgResult.rows)
  const rowKeys = columnNamesForRows(pgFields, pgResult.rows)
  const fieldByName = new Map(
    pgFields.map((field) => [field.name, field]),
  )
  const flexFields = rowKeys.map((name) => {
    const field = fieldByName.get(name) as
      | { tableID?: number; columnID?: number; dataTypeID?: number; format?: number }
      | undefined
    return {
      name: String(name),
      table_oid: field?.tableID ?? 0,
      column_id: field?.columnID ?? 0,
      data_type_oid: field?.dataTypeID ?? 0,
      format: mockWireFormat(field?.dataTypeID ?? 0, field?.format),
    }
  })

  const orderedRows = (pgResult.rows ?? []).map((row) => {
    const out: Record<string, unknown> = {}
    for (const name of rowKeys) {
      out[String(name)] = row ? row[name] ?? null : null
    }
    return out
  })

  const payload = encodeRawPgBatch(flexFields, orderedRows)

  const schemaBuffer = resultMeta.encodeResultSchema({
    command: pgResult.command ?? 'SELECT',
    fields: flexFields,
  })

  const chunks = [
    {
      kind: CHUNK_KIND_SCHEMA,
      flatbuffer_meta: schemaBuffer,
      payload,
    },
  ]

  const trailerBuffer = resultMeta.encodeResultTrailer({
    command_tag: `${pgResult.command ?? 'SELECT'} ${pgResult.rowCount ?? 0}`,
    row_count: pgResult.rowCount ?? pgResult.rows?.length ?? 0,
    oid: pgResult.oid ?? 0,
  })

  chunks.push({
    kind: CHUNK_KIND_TRAILER,
    flatbuffer_meta: trailerBuffer,
    payload: Buffer.alloc(0),
  })

  return chunks
}

function columnNamesForRows(fields, rows) {
  const names = new Set<string>()
  for (const field of fields ?? []) {
    if (field?.name) {
      names.add(field.name)
    }
  }
  for (const row of rows ?? []) {
    if (row && typeof row === 'object') {
      for (const key of Object.keys(row)) {
        names.add(key)
      }
    }
  }
  return [...names]
}

async function collectStreamChunks(stream) {
  const chunks = []
  for await (const chunk of stream) {
    chunks.push(chunk)
  }
  return chunks
}

/** Decode mock-recorded query params back to JS values (tests). */
function decodeQueryParamsForTest(params) {
  if (!Array.isArray(params)) {
    return []
  }
  return params.map((param) => {
    if (!param || param.format === 1) {
      return Buffer.isBuffer(param?.value)
        ? param.value
        : Buffer.from(param?.value ?? [])
    }
    const raw = param.value ?? Buffer.alloc(0)
    const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw)
    if (text === '') {
      return null
    }
    const asNumber = Number(text)
    if (text !== '' && !Number.isNaN(asNumber) && String(asNumber) === text) {
      return asNumber
    }
    return text
  })
}

module.exports = {
  CHUNK_KIND_SCHEMA,
  CHUNK_KIND_BATCH,
  CHUNK_KIND_TRAILER,
  CHUNK_KIND_ERROR,
  buildQueryRequestPayload,
  buildLibpqQueryParams,
  encodeQueryParam,
  decodeQueryStreamToPgResult,
  decodeArrowStreamToPgResult,
  encodePgResultAsChunks,
  collectStreamChunks,
  decodeQueryParamsForTest,
}
