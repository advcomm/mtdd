# Result metadata (FlexBuffers)

`QueryStream` `ResultChunk.flatbuffer_meta` uses [FlexBuffers](https://google.github.io/flatbuffers/flatbuffers_guide.html#flexbuffers) maps:

- **SCHEMA**: `{ command, fields: [{ name, table_oid, column_id, data_type_oid, format }] }`
- **TRAILER**: `{ command_tag, row_count, oid }`
- **ERROR**: `{ sqlstate, severity, message, detail, position }`

Column values are **not** encoded here; they are sent in `ResultChunk.payload` as RPGB v1 batches (see [`src/pg-binary-decode.ts`](../src/pg-binary-decode.ts) and [`src/grpc-arrow-codec.ts`](../src/grpc-arrow-codec.ts)).

Codec: [`src/flatbuffers/result-meta-codec.ts`](../src/flatbuffers/result-meta-codec.ts).
