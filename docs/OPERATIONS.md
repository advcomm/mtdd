# MTDD client operations

Companion to [mtdd_server docs/OPERATIONS.md](https://github.com/advcomm/mtdd_server/blob/main/docs/OPERATIONS.md). Server deploy (nginx, systemd, shard layout) lives there — not duplicated here.

Planning review (control plane vs data plane vs Patroni HA): [MULTI-TENANT-PLATFORM-REVIEW.md](MULTI-TENANT-PLATFORM-REVIEW.md).

| Topic | Server reference |
|-------|------------------|
| nginx → Unix socket, TLS at nginx | [mtdd_server@c4a05f6](https://github.com/advcomm/mtdd_server/commit/c4a05f63294c2251e2bb19ec5de92ceba70cf8de)+ |
| QueryStream RPGB wire format (`result_format = 1`, `ResultChunk.payload`) | [mtdd_server@765da45](https://github.com/advcomm/mtdd_server/commit/765da450c4ae09fefd0dcf57f98e560033870803)+ |
| Proto sync / integration pairing | [mtdd_server@eac5748](https://github.com/advcomm/mtdd_server/commit/eac5748d024a65ce9bc5d26bf5df5e1c58636cb6)+ |

**Deploy pairing:** mtdd_server ≥ **765da45**; recommended **@advcomm/mtdd@07c20bc** (minimum RPGB client **@bced8d7+**). Proto bytes are unchanged across 765da45 / a0bfb7e / eac5748 (server) and bced8d7 / 07c20bc (client).

## Plain SQL only

`@advcomm/mtdd` supports **plain SQL text** only. Do not set `name` on query configs — `mtdd_server` rejects non-empty `QueryRequest.name`. ORMs are not supported.

## Multi-shard LISTEN / NOTIFY

Subscriptions live in **one coordinator process**. Set on every app instance:

```env
MTDD_NOTIFY_URL=10.0.0.100:50051
```

Run `MtddNotify` on that host (`MTDD_NOTIFY_ENABLED=1` on the server). Set `MTDD_NOTIFY_ENABLED=0` on shard-only nodes.

After a `Watch` stream drops, the client reconnects and re-issues `Subscribe` for known channels (server keeps subscriptions until `Unsubscribe` / `UnsubscribeAll`).

## Shutdown

Before `pool.end()`:

```js
const { shutdownMtdd } = require('@advcomm/mtdd')
await shutdownMtdd()
await pool.end()
```

Or set `MTDD_AUTO_SHUTDOWN=1` to hook `SIGTERM` / `SIGINT` on preload.

## TLS (client → nginx)

Terminate TLS at nginx; verify **nginx’s** certificate from the client (`mtdd_server` has no native gRPC TLS):

| Variable | Purpose |
|----------|---------|
| `MTDD_GRPC_TLS=1` | Enable TLS on the client channel to nginx |
| `MTDD_GRPC_TLS_CA_FILE` | CA bundle to verify nginx (required when TLS enabled) |
| `MTDD_GRPC_TLS_CERT_FILE` / `MTDD_GRPC_TLS_KEY_FILE` | Optional mTLS client cert (both required together) |
| `MTDD_GRPC_TLS_SERVER_NAME` | SNI / certificate hostname override |
| `MTDD_NOTIFY_TLS_*` | Notify coordinator TLS (falls back to `MTDD_GRPC_TLS_*`) |

TLS file paths are validated at preload (skipped when `MTDD_GRPC_MOCK=1`).

## Local dev (optional unix socket)

Single-shard co-located dev only (no nginx):

| Variable | Purpose |
|----------|---------|
| `MTDD_GRPC_UNIX_SOCKET` | e.g. `/run/mtdd/grpc.sock` — plain gRPC to the server socket |
| `DB_HOST` | Still required for metadata; host IP is not used for the gRPC dial |

Do not combine `MTDD_GRPC_UNIX_SOCKET` with `MTDD_GRPC_TLS_*`. Multi-shard production must use nginx TCP per shard.

## Fan-out failures

Default `MTDD_FANOUT_POLICY=all`: one shard error fails the query. `best_effort` fails if any shard errors.

## Proto sync

`mtdd_server` is the source of truth. Pull into this repo (should diff clean against current `proto/mtdd.proto`):

```bash
MTDD_PROTO_REF=eac5748d024a65ce9bc5d26bf5df5e1c58636cb6 ./scripts/sync-proto.sh
```

On **mtdd_server@eac5748+**, `./scripts/sync-proto.sh` defaults to client **@07c20bc** for the reverse check.

## Integration tests (optional)

Requires a running shard with `MtddNotify` (see [mtdd_server integration docs](https://github.com/advcomm/mtdd_server/tree/main/integration)):

```bash
npm run build
export MTDD_INTEGRATION=1
export MTDD_SERVER_ADDR=127.0.0.1:50051
node dist/scripts/integration-smoke.js
node dist/scripts/integration-notify-reconnect-smoke.js
```

Or via npm scripts: `npm run test:integration`, `npm run test:integration:notify-reconnect`.
