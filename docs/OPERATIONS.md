# MTDD client operations

Companion to [mtdd_server docs/OPERATIONS.md](https://github.com/advcomm/mtdd_server/blob/main/docs/OPERATIONS.md) (server commit [c4a05f6](https://github.com/advcomm/mtdd_server/commit/c4a05f63294c2251e2bb19ec5de92ceba70cf8de)).

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

## gRPC path (production)

From [mtdd_server@c4a05f6](https://github.com/advcomm/mtdd_server/commit/c4a05f63294c2251e2bb19ec5de92ceba70cf8de) onward, `mtdd_server` listens on a **Unix domain socket** (default `unix:/run/mtdd/grpc.sock`). **nginx** on each shard IP accepts client TCP (plain or TLS) and proxies to that socket.

This client always dials **`DB_HOST` + `MTDD_GRPC_PORT`** (nginx), not the server socket directly.

```text
app (@advcomm/mtdd) --TCP[/TLS]--> nginx (shard IP:port) --unix--> mtdd_server
```

See [deploy/nginx/mtdd-grpc.conf](https://github.com/advcomm/mtdd_server/blob/main/deploy/nginx/mtdd-grpc.conf) and [mtdd-grpc-tls.conf](https://github.com/advcomm/mtdd_server/blob/main/deploy/nginx/mtdd-grpc-tls.conf).

## TLS (client → nginx)

`mtdd_server` no longer exposes native gRPC TLS (`MTDD_GRPC_TLS_*` was removed on the server). Terminate TLS at nginx and verify **nginx’s** certificate from the client:

| Variable | Purpose |
|----------|---------|
| `MTDD_GRPC_TLS=1` | Enable TLS on the client channel to nginx |
| `MTDD_GRPC_TLS_CA_FILE` | CA bundle to verify nginx (required when TLS enabled) |
| `MTDD_GRPC_TLS_CERT_FILE` / `MTDD_GRPC_TLS_KEY_FILE` | Optional mTLS client cert (both required together) |
| `MTDD_GRPC_TLS_SERVER_NAME` | SNI / certificate hostname override |
| `MTDD_NOTIFY_TLS_*` | Notify coordinator TLS (falls back to `MTDD_GRPC_TLS_*`) |

TLS file paths are validated at preload (skipped when `MTDD_GRPC_MOCK=1`).

## Local dev (optional unix socket)

When the app runs on the **same host** as a single-shard `mtdd_server` (no nginx), set:

| Variable | Purpose |
|----------|---------|
| `MTDD_GRPC_UNIX_SOCKET` | e.g. `/run/mtdd/grpc.sock` — plain gRPC to the server socket |
| `DB_HOST` | Still required for metadata; host IP is not used for the gRPC dial |

Do not combine `MTDD_GRPC_UNIX_SOCKET` with `MTDD_GRPC_TLS_*`. Multi-shard deployments must use nginx TCP per shard, not this shortcut.

## Fan-out failures

Default `MTDD_FANOUT_POLICY=all`: one shard error fails the query. `best_effort` fails if any shard errors.

## Proto sync

`mtdd_server` is the source of truth ([765da45](https://github.com/advcomm/mtdd_server/commit/765da450c4ae09fefd0dcf57f98e560033870803): RPGB streaming, `ResultChunk.payload`, `result_format = 1`). Pull into this repo:

```bash
MTDD_PROTO_REF=765da450c4ae09fefd0dcf57f98e560033870803 ./scripts/sync-proto.sh
```

## Integration tests (optional)

```bash
export MTDD_INTEGRATION=1
export MTDD_SERVER_ADDR=127.0.0.1:50051
node scripts/integration-smoke.js
node scripts/integration-notify-reconnect-smoke.js
```
