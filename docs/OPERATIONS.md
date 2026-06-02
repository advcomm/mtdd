# MTDD operations guide

## Plain SQL only

`@advcomm/mtdd` supports **plain SQL text** routed per query. Prepared statements (`pool.query({ name: '...', text: '...' })`) are rejected. ORMs that rely on extended query protocol are not supported.

## Multi-shard LISTEN / NOTIFY

Subscriptions live in **one coordinator process**. Set on every app instance:

```env
MTDD_NOTIFY_URL=10.0.0.100:50051
```

Run `MtddNotify` on that host; set `MTDD_NOTIFY_ENABLED=0` on shard-only `mtdd_server` nodes.

## Shutdown

Before `pool.end()`:

```js
const { shutdownMtdd } = require('@advcomm/mtdd')
await shutdownMtdd()
await pool.end()
```

Or set `MTDD_AUTO_SHUTDOWN=1` to hook `SIGTERM` / `SIGINT` on preload.

## TLS

| Variable | Purpose |
|----------|---------|
| `MTDD_GRPC_TLS=1` | Enable TLS for shard gRPC |
| `MTDD_GRPC_TLS_CA_FILE` | CA bundle path |
| `MTDD_GRPC_TLS_CERT_FILE` / `MTDD_GRPC_TLS_KEY_FILE` | mTLS client cert |
| `MTDD_GRPC_TLS_SERVER_NAME` | SNI override |
| `MTDD_NOTIFY_TLS_*` | Notify coordinator TLS (falls back to `MTDD_GRPC_TLS_*`) |

## Fan-out failures

Default `MTDD_FANOUT_POLICY=all`: one shard error fails the query. `best_effort` requires all shards to succeed but uses `allSettled` for clearer aggregate errors.

## Proto sync

```bash
MTDD_PROTO_REF=main ./scripts/sync-proto.sh
```

Keep [proto/mtdd.proto](../proto/mtdd.proto) aligned with [mtdd_server](https://github.com/advcomm/mtdd_server).

## Integration tests (optional)

Against a running `mtdd_server`:

```bash
export MTDD_INTEGRATION=1
export MTDD_SERVER_ADDR=127.0.0.1:50051
node scripts/integration-smoke.js
```
