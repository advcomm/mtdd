const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const {
  decodeRawPgBatch,
  decodePgCell,
  RAW_PG_BATCH_MAGIC,
  RAW_PG_BATCH_VERSION,
} = require('../src/pg-binary-decode')
const { encodeRawPgBatch, encodePgCellBytes } = require('../src/pg-binary-encode')

const OID_INT2 = 21
const OID_INT4 = 23
const OID_INT8 = 20
const OID_FLOAT4 = 700
const OID_FLOAT8 = 701
const OID_DATE = 1082
const OID_TIMESTAMP = 1114

function rpgbHeader(numRows: number, numCols: number): Buffer {
  const header = Buffer.alloc(16)
  header.writeUInt32LE(RAW_PG_BATCH_MAGIC, 0)
  header.writeUInt32LE(RAW_PG_BATCH_VERSION, 4)
  header.writeUInt32LE(numRows, 8)
  header.writeUInt32LE(numCols, 12)
  return header
}

function rpgbCell(valueBytes: Buffer): Buffer {
  const cell = Buffer.alloc(5 + valueBytes.length)
  cell[0] = 0
  cell.writeUInt32LE(valueBytes.length, 1)
  valueBytes.copy(cell, 5)
  return cell
}

describe('RPGB wire endianness', () => {
  it('uses little-endian uint32 in batch header', () => {
    const batch = rpgbHeader(3, 2)
    assert.equal(batch.readUInt32LE(0), RAW_PG_BATCH_MAGIC)
    assert.equal(batch.readUInt32LE(4), RAW_PG_BATCH_VERSION)
    assert.equal(batch.readUInt32LE(8), 3)
    assert.equal(batch.readUInt32LE(12), 2)
    assert.notEqual(batch.readUInt32BE(0), RAW_PG_BATCH_MAGIC)
  })

  it('uses little-endian uint32 for non-null cell length prefix', () => {
    const fields = [{ name: 'n', data_type_oid: OID_INT4, format: 1 }]
    const value = Buffer.from([0x00, 0x00, 0x00, 0x2a])
    const batch = Buffer.concat([rpgbHeader(1, 1), rpgbCell(value)])
    assert.equal(batch.readUInt32LE(17), 4)
    assert.deepEqual(decodeRawPgBatch(batch, fields), [{ n: 42 }])
  })
})

describe('PostgreSQL binary cell endianness', () => {
  it('decodes int2/int4/int8 as big-endian', () => {
    const int2 = Buffer.alloc(2)
    int2.writeInt16BE(-123, 0)
    assert.equal(decodePgCell({ name: 'a', data_type_oid: OID_INT2, format: 1 }, int2), -123)

    const int4 = Buffer.alloc(4)
    int4.writeInt32BE(0x01020304, 0)
    assert.equal(decodePgCell({ name: 'b', data_type_oid: OID_INT4, format: 1 }, int4), 0x01020304)

    const int8 = Buffer.alloc(8)
    int8.writeBigInt64BE(9007199254740991n, 0)
    assert.equal(
      decodePgCell({ name: 'c', data_type_oid: OID_INT8, format: 1 }, int8),
      '9007199254740991',
    )
  })

  it('decodes float4/float8 as little-endian IEEE 754', () => {
    const f4 = Buffer.alloc(4)
    f4.writeFloatLE(1.25, 0)
    assert.equal(decodePgCell({ name: 'f', data_type_oid: OID_FLOAT4, format: 1 }, f4), 1.25)
    assert.deepEqual([...f4], [0x00, 0x00, 0xa0, 0x3f])

    const f8 = Buffer.alloc(8)
    f8.writeDoubleLE(1.25, 0)
    assert.equal(decodePgCell({ name: 'd', data_type_oid: OID_FLOAT8, format: 1 }, f8), 1.25)
    assert.deepEqual([...f8], [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf4, 0x3f])
  })

  it('decodes date and timestamp as big-endian', () => {
    const date = Buffer.alloc(4)
    date.writeInt32BE(0, 0)
    const jsDate = decodePgCell({ name: 'dt', data_type_oid: OID_DATE, format: 1 }, date)
    assert.ok(jsDate instanceof Date)
    assert.equal(jsDate.toISOString().slice(0, 10), '2000-01-01')

    const ts = Buffer.alloc(8)
    ts.writeBigInt64BE(1_000_000n, 0)
    const jsTs = decodePgCell({ name: 'ts', data_type_oid: OID_TIMESTAMP, format: 1 }, ts)
    assert.ok(jsTs instanceof Date)
    assert.equal(jsTs.getTime(), 946684801000)
  })

  it('encodePgCellBytes mirrors decode endianness for mock round-trip', () => {
    const cases = [
      { oid: OID_INT2, value: -42, format: 1 },
      { oid: OID_INT4, value: 0x01020304, format: 1 },
      { oid: OID_INT8, value: '9223372036854775807', format: 1 },
      { oid: OID_FLOAT4, value: 3.5, format: 1 },
      { oid: OID_FLOAT8, value: 3.5, format: 1 },
    ]
    for (const { oid, value, format } of cases) {
      const field = { name: 'v', data_type_oid: oid, format }
      const bytes = encodePgCellBytes(field, value)
      const decoded = decodePgCell(field, bytes)
      if (oid === OID_INT8) {
        assert.equal(decoded, String(value))
      } else {
        assert.equal(decoded, value)
      }
    }
  })

  it('encodeRawPgBatch round-trips mixed binary columns', () => {
    const fields = [
      { name: 'id', data_type_oid: OID_INT4, format: 1 },
      { name: 'ratio', data_type_oid: OID_FLOAT8, format: 1 },
      { name: 'label', data_type_oid: 25, format: 0 },
    ]
    const rows = [
      { id: 7, ratio: 0.5, label: 'half' },
      { id: null, ratio: null, label: 'nil' },
    ]
    const batch = encodeRawPgBatch(fields, rows)
    assert.equal(batch.readUInt32LE(0), RAW_PG_BATCH_MAGIC)
    assert.deepEqual(decodeRawPgBatch(batch, fields), rows)
  })
})
