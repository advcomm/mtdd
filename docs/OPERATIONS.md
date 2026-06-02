# MTDD client operations

Companion to [mtdd_server docs/OPERATIONS.md](https://github.com/advcomm/mtdd_server/blob/main/docs/OPERATIONS.md) (server commit [04d16b5](https://github.com/advcomm/mtdd_server/commit/04d16b5ecdee89dc98184b4c276f9a9b5ef7d8e5)).

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

## TLS

### nginx termination (default)

Keep `mtdd_server` on loopback with plain gRPC; terminate TLS at nginx on the shard IP. The client connects with TLS to nginx using the same env vars below (`MTDD_GRPC_TLS_CA_FILE` verifies the nginx certificate).

See [mtdd_server deploy/nginx/mtdd-grpc.conf](https://github.com/advcomm/mtdd_server/blob/main/deploy/nginx/mtdd-grpc.conf) and [mtdd-grpc-tls.conf](https://github.com/advcomm/mtdd_server/blob/main/deploy/nginx/mtdd-grpc-tls.conf).

### Native gRPC TLS (end-to-end)

When `mtdd_server` has `MTDD_GRPC_TLS=1` with server cert/key, configure the client:

| Variable | Purpose |
|----------|---------|
| `MTDD_GRPC_TLS=1` | Enable TLS for shard gRPC client |
| `MTDD_GRPC_TLS_CA_FILE` | CA bundle to verify server (required when TLS enabled) |
| `MTDD_GRPC_TLS_CERT_FILE` / `MTDD_GRPC_TLS_KEY_FILE` | Optional mTLS client cert (both required together) |
| `MTDD_GRPC_TLS_SERVER_NAME` | SNI / certificate hostname override |
| `MTDD_NOTIFY_TLS_*` | Notify coordinator TLS (falls back to `MTDD_GRPC_TLS_*`) |

TLS file paths are validated at preload (skipped when `MTDD_GRPC_MOCK=1`).

Server-side listener TLS (pair with client):

| Server variable | Purpose |
|-----------------|---------|
| `MTDD_GRPC_TLS=1` | TLS on gRPC listener |
| `MTDD_GRPC_TLS_CERT_FILE` / `MTDD_GRPC_TLS_KEY_FILE` | Server PEM cert/key |
| `MTDD_GRPC_TLS_CLIENT_CA_FILE` | Optional client CA for mTLS |

## Fan-out failures

Default `MTDD_FANOUT_POLICY=all`: one shard error fails the query. `best_effort` fails if any shard errors.

## Proto sync

`mtdd_server` is the source of truth. Pull into this repo:

```bash
MTDD_PROTO_REF=04d16b5ecdee89dc98184b4c276f9a9b5ef7d8e5 ./scripts/sync-proto.sh
```

## Integration tests (optional)

```bash
export MTDD_INTEGRATION=1
export MTDD_SERVER_ADDR=127.0.0.1:50051
node scripts/integration-smoke.js
node scripts/integration-notify-reconnect-smoke.js
```
