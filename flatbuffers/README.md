# Result metadata (FlexBuffers)

`QueryStream` `ResultChunk.flatbuffer_meta` uses [FlexBuffers](https://google.github.io/flatbuffers/flatbuffers_guide.html#flexbuffers) maps:

- **SCHEMA**: `{ command, fields: [{ name, table_oid, column_id, data_type_oid, format }] }`
- **TRAILER**: `{ command_tag, row_count, oid }`
- **ERROR**: `{ sqlstate, severity, message, detail, position }`

Column values are **not** encoded here; they are sent in `arrow_ipc` on the same chunk (see `grpc-arrow-codec.js`).

Codec: [`result-meta-codec.js`](result-meta-codec.js).
