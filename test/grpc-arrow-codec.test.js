const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const resultMeta = require('../flatbuffers/result-meta-codec')
const {
  buildLibpqQueryParams,
  decodeArrowStreamToPgResult,
  encodePgResultAsChunks,
  CHUNK_KIND_SCHEMA,
  CHUNK_KIND_TRAILER,
} = require('../grpc-arrow-codec')
const { buildQueryRequestPayload } = require('../grpc-arrow-codec')
const { resetPreloadLogConfigForTests } = require('../preload-logger')

describe('grpc-arrow-codec', () => {
  let restoreEnv

  beforeEach(() => {
    restoreEnv = snapshotEnv(['MTDD_GRPC_RESULT_FORMAT', 'MTDD_GRPC_MOCK'])
    resetPreloadLogConfigForTests()
  })

  afterEach(() => {
    restoreEnv()
    resetPreloadLogConfigForTests()
  })

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

  it('encodes libpq-style query parameters', () => {
    const params = buildLibpqQueryParams({
      values: ['alice', 42, Buffer.from([1, 2, 3])],
      types: [25, 23, 0],
    })
    assert.equal(params.length, 3)
    assert.equal(params[0].format, 0)
    assert.equal(params[0].value.toString('utf8'), 'alice')
    assert.equal(params[0].oid, 25)
    assert.equal(params[1].format, 0)
    assert.equal(params[2].format, 1)
    assert.deepEqual(params[2].value, Buffer.from([1, 2, 3]))
  })

  it('builds arrow query request payload when MTDD_GRPC_RESULT_FORMAT=arrow', () => {
    process.env.MTDD_GRPC_RESULT_FORMAT = 'arrow'
    resetPreloadLogConfigForTests()
    const payload = buildQueryRequestPayload(
      0,
      { text: 'SELECT $1', values: ['x'], types: [25] },
      'sess-1',
    )
    assert.equal(payload.response_format, 'RESPONSE_FORMAT_ARROW')
    assert.equal(payload.params.length, 1)
    assert.equal(payload.values_json, '')
    assert.equal(payload.session_id, 'sess-1')
  })

  it('round-trips pg results through arrow IPC chunks', () => {
    const pgResult = {
      command: 'SELECT',
      rowCount: 2,
      oid: null,
      fields: [
        { name: 'id', dataTypeID: 23 },
        { name: 'name', dataTypeID: 25 },
      ],
      rows: [
        { id: 1, name: 'a' },
        { id: 2, name: 'b' },
      ],
    }
    const chunks = encodePgResultAsChunks(pgResult)
    assert.equal(chunks[0].kind, CHUNK_KIND_SCHEMA)
    assert.equal(chunks[chunks.length - 1].kind, CHUNK_KIND_TRAILER)

    const decoded = decodeArrowStreamToPgResult(chunks)
    assert.equal(decoded.command, 'SELECT')
    assert.equal(decoded.rowCount, 2)
    assert.equal(decoded.fields.length, 2)
    assert.equal(decoded.rows.length, 2)
    assert.equal(decoded.rows[0].name, 'a')
  })

  it('decodes pg errors from ERROR chunks', () => {
    assert.throws(
      () =>
        decodeArrowStreamToPgResult([
          {
            kind: 'CHUNK_KIND_ERROR',
            flatbuffer_meta: resultMeta.encodePgError({
              sqlstate: '23505',
              message: 'duplicate key',
            }),
            arrow_ipc: Buffer.alloc(0),
          },
        ]),
      /duplicate key/,
    )
  })
})

function snapshotEnv(keys) {
  const previous = {}
  for (const key of keys) {
    previous[key] = process.env[key]
  }
  return () => {
    for (const key of keys) {
      if (previous[key] === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = previous[key]
      }
    }
  }
}
