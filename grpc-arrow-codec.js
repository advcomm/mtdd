const resultMeta = require('./flatbuffers/result-meta-codec')

const CHUNK_KIND_SCHEMA = 'CHUNK_KIND_SCHEMA'
const CHUNK_KIND_BATCH = 'CHUNK_KIND_BATCH'
const CHUNK_KIND_TRAILER = 'CHUNK_KIND_TRAILER'
const CHUNK_KIND_ERROR = 'CHUNK_KIND_ERROR'

function loadArrow() {
  try {
    return require('apache-arrow')
  } catch (err) {
    throw new Error(
      '@advcomm/mtdd: apache-arrow is required for gRPC query results. ' +
        `Install it alongside @advcomm/mtdd. (${err.message})`,
    )
  }
}

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
    result_format: 0,
  }
}

function pgFieldsFromSchema(schema) {
  return (schema.fields ?? []).map((field) => ({
    name: field.name,
    dataTypeID: field.data_type_oid,
    tableID: field.table_oid,
    columnID: field.column_id,
    format: field.format,
  }))
}

function commandFromTag(commandTag, fallback) {
  if (!commandTag) {
    return fallback ?? 'SELECT'
  }
  const token = String(commandTag).trim().split(/\s+/)[0]
  return token ? token.toUpperCase() : fallback ?? 'SELECT'
}

function arrowValueToJs(value) {
  if (value === null || value === undefined) {
    return null
  }
  if (typeof value === 'bigint') {
    return value.toString()
  }
  if (value instanceof Date) {
    return value
  }
  if (typeof value === 'object' && value !== null && typeof value.toJSON === 'function') {
    return value.toJSON()
  }
  return value
}

function arrowTableToRows(table, fieldNames) {
  const names =
    fieldNames.length > 0 ? fieldNames : table.schema.fields.map((f) => f.name)
  const rows = []
  const rowCount = table.numRows ?? 0

  for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
    const row = {}
    for (const name of names) {
      const column = table.getChild(name)
      if (!column) {
        row[name] = null
        continue
      }
      row[name] = arrowValueToJs(column.get(rowIndex))
    }
    rows.push(row)
  }

  return rows
}

function decodeArrowStreamToPgResult(chunks) {
  let schema = null
  const ipcParts = []
  let trailer = null
  let error = null

  for (const chunk of chunks) {
    const kind = chunk.kind ?? chunk.Kind
    if (kind === CHUNK_KIND_ERROR || kind === 4 || kind === 'CHUNK_KIND_ERROR') {
      const meta = chunk.flatbuffer_meta ?? chunk.flatbufferMeta
      if (meta && meta.length > 0) {
        error = resultMeta.decodePgError(meta)
      }
      break
    }
    if (kind === CHUNK_KIND_SCHEMA || kind === 1 || kind === 'CHUNK_KIND_SCHEMA') {
      const meta = chunk.flatbuffer_meta ?? chunk.flatbufferMeta
      if (meta && meta.length > 0) {
        schema = resultMeta.decodeResultSchema(meta)
      }
      const ipc = chunk.arrow_ipc ?? chunk.arrowIpc
      if (ipc && ipc.length > 0) {
        ipcParts.push(Buffer.from(ipc))
      }
      continue
    }
    if (kind === CHUNK_KIND_BATCH || kind === 2 || kind === 'CHUNK_KIND_BATCH') {
      const ipc = chunk.arrow_ipc ?? chunk.arrowIpc
      if (ipc && ipc.length > 0) {
        ipcParts.push(Buffer.from(ipc))
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

  if (error) {
    const parts = [error.message]
    if (error.sqlstate) {
      parts.push(`(${error.sqlstate})`)
    }
    if (error.detail) {
      parts.push(error.detail)
    }
    throw new Error(parts.filter(Boolean).join(' '))
  }

  const fieldNames = (schema?.fields ?? []).map((f) => f.name)
  const fields = pgFieldsFromSchema(schema ?? { fields: [] })
  let rows = []

  if (ipcParts.length > 0) {
    const arrow = loadArrow()
    const buffer = Buffer.concat(ipcParts)
    const table = arrow.tableFromIPC(buffer)
    rows = arrowTableToRows(table, fieldNames)
  }

  const command = commandFromTag(trailer?.command_tag, schema?.command)
  const rowCount =
    trailer?.row_count != null ? Number(trailer.row_count) : rows.length

  return {
    command,
    rowCount,
    oid: trailer?.oid ?? null,
    fields,
    rows,
  }
}

function encodePgResultAsChunks(pgResult) {
  const rowKeys = columnNamesForRows(pgResult.fields, pgResult.rows)
  const fieldByName = new Map(
    (pgResult.fields ?? []).map((field) => [field.name, field]),
  )
  const fields = rowKeys.map((name) => {
    const field = fieldByName.get(name)
    return {
      name,
      table_oid: field?.tableID ?? 0,
      column_id: field?.columnID ?? 0,
      data_type_oid: field?.dataTypeID ?? 0,
      format: field?.format ?? 0,
    }
  })

  const schemaBuffer = resultMeta.encodeResultSchema({
    command: pgResult.command ?? 'SELECT',
    fields,
  })

  const chunks = [
    {
      kind: CHUNK_KIND_SCHEMA,
      flatbuffer_meta: schemaBuffer,
      arrow_ipc: encodeRowsAsArrowIpc(pgResult.fields ?? [], pgResult.rows ?? []),
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
    arrow_ipc: Buffer.alloc(0),
  })

  return chunks
}

function columnNamesForRows(fields, rows) {
  const names = new Set()
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

function encodeRowsAsArrowIpc(fields, rows) {
  const arrow = loadArrow()
  const fieldNames = columnNamesForRows(fields, rows)

  if (fieldNames.length === 0) {
    const table = arrow.tableFromArrays({})
    return Buffer.from(arrow.tableToIPC(table))
  }

  const columns = {}
  for (const name of fieldNames) {
    columns[name] = rows.map((row) => (row ? row[name] ?? null : null))
  }

  const table = arrow.tableFromArrays(columns)
  return Buffer.from(arrow.tableToIPC(table))
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
  decodeArrowStreamToPgResult,
  encodePgResultAsChunks,
  encodeRowsAsArrowIpc,
  collectStreamChunks,
  decodeQueryParamsForTest,
  loadArrow,
}
