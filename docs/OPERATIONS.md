# MTDD client operations

Companion to [mtdd_server docs/OPERATIONS.md](https://github.com/advcomm/mtdd_server/blob/main/docs/OPERATIONS.md).

| Topic | Server reference |
|-------|------------------|
| nginx → Unix socket, TLS at nginx | [mtdd_server@c4a05f6](https://github.com/advcomm/mtdd_server/commit/c4a05f63294c2251e2bb19ec5de92ceba70cf8de)+ |
| QueryStream RPGB wire format (`result_format = 1`, `ResultChunk.payload`) | [mtdd_server@765da45](https://github.com/advcomm/mtdd_server/commit/765da450c4ae09fefd0dcf57f98e560033870803)+ |
| Proto sync / client pairing docs | [mtdd_server@a0bfb7e](https://github.com/advcomm/mtdd_server/commit/a0bfb7e7c3d3da538f177121046b73ce79332e39)+ |

Pair **@advcomm/mtdd@bced8d7** (or newer) with **mtdd_server ≥ 765da45** for `QueryStream`.

## Plain SQL only
