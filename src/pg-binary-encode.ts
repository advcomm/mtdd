import {
  RAW_PG_BATCH_MAGIC,
  RAW_PG_BATCH_VERSION,
  type PgSchemaField,
} from './pg-binary-decode'

const OID_BOOL = 16
const OID_BYTEA = 17
const OID_INT8 = 20
const OID_INT2 = 21
const OID_INT4 = 23
const OID_FLOAT4 = 700
const OID_FLOAT8 = 701

function fieldOid(field: PgSchemaField): number {
  return field.data_type_oid ?? field.dataTypeID ?? 0
}

/** Mock/replay: prefer libpq binary cells for types the server sends in binary mode. */
export function mockWireFormat(dataTypeOid: number, pgFormat?: number): number {
  if (pgFormat != null && pgFormat !== 0) {
    return pgFormat
  }
  switch (dataTypeOid) {
    case OID_BOOL:
    case OID_INT2:
    case OID_INT4:
    case OID_INT8:
    case OID_FLOAT4:
    case OID_FLOAT8:
      return 1
    default:
      return 0
  }
}

/** Encode one cell as libpq would return it (text or binary per field.format). */
export function encodePgCellBytes(
  field: PgSchemaField,
  value: unknown,
): Buffer {
  const oid = fieldOid(field)
  const format = field.format ?? 0

  if (format === 1) {
    if (Buffer.isBuffer(value)) {
      return value
    }
    if (value instanceof Uint8Array) {
      return Buffer.from(value)
    }
    if (typeof value === 'boolean' || oid === OID_BOOL) {
      const bool =
        typeof value === 'boolean'
          ? value
          : value === 't' || value === 'T' || value === '1' || value === 1
      return Buffer.from([bool ? 1 : 0])
    }
    if (oid === OID_INT2 && typeof value === 'number') {
      const buf = Buffer.alloc(2)
      buf.writeInt16BE(value, 0)
      return buf
    }
    if (oid === OID_INT4 && typeof value === 'number') {
      const buf = Buffer.alloc(4)
      buf.writeInt32BE(value, 0)
      return buf
    }
    if (oid === OID_INT8) {
      const buf = Buffer.alloc(8)
      const n = typeof value === 'bigint' ? value : BigInt(String(value))
      buf.writeBigInt64BE(n, 0)
      return buf
    }
    if (oid === OID_FLOAT4 && typeof value === 'number') {
      const buf = Buffer.alloc(4)
      buf.writeFloatLE(value, 0)
      return buf
    }
    if (oid === OID_FLOAT8 && typeof value === 'number') {
      const buf = Buffer.alloc(8)
      buf.writeDoubleLE(value, 0)
      return buf
    }
    return Buffer.from(String(value), 'utf8')
  }

  if (typeof value === 'boolean') {
    return Buffer.from(value ? 't' : 'f')
  }
  if (Buffer.isBuffer(value)) {
    return value
  }
  if (value instanceof Date) {
    return Buffer.from(value.toISOString(), 'utf8')
  }
  if (oid === OID_BOOL && typeof value === 'string') {
    return Buffer.from(value === 't' || value === 'T' || value === '1' ? 't' : 'f')
  }
  if (oid === OID_BYTEA && value instanceof Uint8Array) {
    return Buffer.from(value)
  }
  return Buffer.from(String(value), 'utf8')
}

/** Column-major RPGB v1 batch (matches mtdd_server raw_batch_encoder). */
export function encodeRawPgBatch(
  fields: PgSchemaField[],
  rows: Record<string, unknown>[],
): Buffer {
  const numRows = rows.length
  const numCols = fields.length
  const parts: Buffer[] = []

  const header = Buffer.alloc(16)
  header.writeUInt32LE(RAW_PG_BATCH_MAGIC, 0)
  header.writeUInt32LE(RAW_PG_BATCH_VERSION, 4)
  header.writeUInt32LE(numRows, 8)
  header.writeUInt32LE(numCols, 12)
  parts.push(header)

  for (let col = 0; col < numCols; col++) {
    const field = fields[col]
    const name = field.name
    for (let row = 0; row < numRows; row++) {
      const value = rows[row]?.[name]
      if (value === null || value === undefined) {
        parts.push(Buffer.from([1]))
        continue
      }
      const bytes = encodePgCellBytes(field, value)
      const lenBuf = Buffer.alloc(5)
      lenBuf[0] = 0
      lenBuf.writeUInt32LE(bytes.length, 1)
      parts.push(lenBuf, bytes)
    }
  }

  return Buffer.concat(parts)
}

export function schemaFieldsFromPgResult(
  fields: Array<{
    name: string
    dataTypeID?: number
    tableID?: number
    columnID?: number
    format?: number
  }>,
): PgSchemaField[] {
  return (fields ?? []).map((field) => ({
    name: field.name,
    data_type_oid: field.dataTypeID ?? 0,
    table_oid: field.tableID ?? 0,
    column_id: field.columnID ?? 0,
    format: field.format ?? 0,
  }))
}
