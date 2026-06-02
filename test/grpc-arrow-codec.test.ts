const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const resultMeta = require('../src/flatbuffers/result-meta-codec')
const {
  buildLibpqQueryParams,
  decodeQueryStreamToPgResult,
  decodeArrowStreamToPgResult,
  encodePgResultAsChunks,
  buildQueryRequestPayload,
  CHUNK_KIND_SCHEMA,
  CHUNK_KIND_TRAILER,
  CHUNK_KIND_BATCH,
  decodeQueryParamsForTest,
} = require('../src/grpc-arrow-codec')
const { encodeRawPgBatch } = require('../src/pg-binary-encode')
const {
  decodeRawPgBatch,
  RAW_PG_BATCH_MAGIC,
  RAW_PG_BATCH_VERSION,
} = require('../src/pg-binary-decode')

describe('grpc-query-codec (RPGB)', () => {
  it('round-trips result schema and trailer flexbuffers metadata', () => {
    const schema = {
      command: 'SELECT',
      fields: [
        {
          name: 'id',
          table_oid: 1,
          column_id: 1,
          data_type_oid: 23,
          format: 0,
        },
      ],
    }
    const decodedSchema = resultMeta.decodeResultSchema(
      resultMeta.encodeResultSchema(schema),
    )
    assert.equal(decodedSchema.command, 'SELECT')
    assert.equal(decodedSchema.fields[0].name, 'id')
    assert.equal(decodedSchema.fields[0].data_type_oid, 23)

    const trailer = { command_tag: 'SELECT 2', row_count: 2, oid: 0 }
    const decodedTrailer = resultMeta.decodeResultTrailer(
      resultMeta.encodeResultTrailer(trailer),
    )
    assert.equal(decodedTrailer.command_tag, 'SELECT 2')
    assert.equal(decodedTrailer.row_count, 2)
  })

  it('sends result_format 1 (libpq binary) on QueryRequest', () => {
    const payload = buildQueryRequestPayload(
      0,
      { text: 'SELECT $1', values: ['x'], types: [25] },
      'sess-1',
    )
    assert.equal(payload.result_format, 1)
    assert.equal(payload.params.length, 1)
    assert.equal(payload.params[0].oid, 25)
    assert.equal(payload.session_id, 'sess-1')
    assert.deepEqual(decodeQueryParamsForTest(payload.params), ['x'])
  })

  it('encodes libpq-style query parameters', () => {
    const params = buildLibpqQueryParams({
      values: ['alice', 42, Buffer.from([1, 2, 3])],
      types: [25, 23, 0],
    })
    assert.equal(params.length, 3)
    assert.equal(params[0].format, 0)
    assert.equal(params[0].value.toString('utf8'), 'alice')
    assert.equal(params[2].format, 1)
  })

  it('round-trips pg results through RPGB payload chunks', () => {
    const pgResult = {
      command: 'SELECT',
      rowCount: 2,
      oid: null,
      fields: [
        { name: 'id', dataTypeID: 23, format: 0 },
        { name: 'name', dataTypeID: 25, format: 0 },
      ],
      rows: [
        { id: 1, name: 'a' },
        { id: 2, name: 'b' },
      ],
    }
    const chunks = encodePgResultAsChunks(pgResult)
    assert.equal(chunks[0].kind, CHUNK_KIND_SCHEMA)
    assert.ok(chunks[0].payload?.length > 16)
    assert.equal(chunks[chunks.length - 1].kind, CHUNK_KIND_TRAILER)

    const decoded = decodeQueryStreamToPgResult(chunks)
    assert.equal(decoded.command, 'SELECT')
    assert.equal(decoded.rowCount, 2)
    assert.equal(decoded.fields.length, 2)
    assert.equal(decoded.rows.length, 2)
    assert.equal(decoded.rows[0].name, 'a')
  })

  it('accumulates SCHEMA + BATCH chunks', () => {
    const fields = [
      { name: 'n', data_type_oid: 23, format: 1 },
    ]
    const schemaBuf = resultMeta.encodeResultSchema({ command: 'SELECT', fields })
    const batch1 = encodeRawPgBatch(fields, [{ n: 1 }])
    const batch2 = encodeRawPgBatch(fields, [{ n: 2 }])

    const decoded = decodeQueryStreamToPgResult([
      { kind: CHUNK_KIND_SCHEMA, flatbuffer_meta: schemaBuf, payload: batch1 },
      { kind: CHUNK_KIND_BATCH, payload: batch2 },
      {
        kind: CHUNK_KIND_TRAILER,
        flatbuffer_meta: resultMeta.encodeResultTrailer({
          command_tag: 'SELECT 2',
          row_count: 2,
          oid: 0,
        }),
        payload: Buffer.alloc(0),
      },
    ])
    assert.equal(decoded.rowCount, 2)
    assert.deepEqual(decoded.rows.map((r) => r.n), [1, 2])
  })

  it('decodeArrowStreamToPgResult is an alias for decodeQueryStreamToPgResult', () => {
    assert.equal(decodeArrowStreamToPgResult, decodeQueryStreamToPgResult)
  })

  it('decodes pg errors from ERROR chunks', () => {
    assert.throws(
      () =>
        decodeQueryStreamToPgResult([
          {
            kind: 'CHUNK_KIND_ERROR',
            flatbuffer_meta: resultMeta.encodePgError({
              sqlstate: '23505',
              message: 'duplicate key',
            }),
            payload: Buffer.alloc(0),
          },
        ]),
      /duplicate key/,
    )
  })
})

describe('pg-binary-decode', () => {
  it('decodes RPGB header magic and version', () => {
    const fields = [{ name: 'x', data_type_oid: 23, format: 0 }]
    const batch = encodeRawPgBatch(fields, [{ x: '7' }])
    assert.equal(batch.readUInt32LE(0), RAW_PG_BATCH_MAGIC)
    assert.equal(batch.readUInt32LE(4), RAW_PG_BATCH_VERSION)
    assert.deepEqual(decodeRawPgBatch(batch, fields), [{ x: '7' }])
  })

  it('decodes binary int4 cells', () => {
    const fields = [{ name: 'id', data_type_oid: 23, format: 1 }]
    const value = Buffer.alloc(4)
    value.writeInt32BE(42, 0)
    const batch = Buffer.concat([
      Buffer.from([
        0x52, 0x47, 0x50, 0x42, 0x01, 0x00, 0x00, 0x00,
        0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00,
        0x00, 0x04, 0x00, 0x00, 0x00,
      ]),
      value,
    ])
    assert.deepEqual(decodeRawPgBatch(batch, fields), [{ id: 42 }])
  })
})
